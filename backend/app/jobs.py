"""In-memory job queue for the /process pipeline.

A single background worker thread processes jobs one at a time (serial),
so two recordings stopped in quick succession don't run Whisper/LLaVA
concurrently and fight over CPU/GPU. Job state lives only in this
process's memory -- a backend restart loses in-flight job status the same
way a crash mid-request would today.
"""
from __future__ import annotations

import queue
import threading
import uuid
from datetime import datetime, timezone
from typing import Callable, Optional

_JOBS_LOCK = threading.Lock()
_JOBS: dict[str, dict] = {}
_JOB_INPUTS: dict[str, dict] = {}
_QUEUE: "queue.Queue[str]" = queue.Queue()
_MAX_TERMINAL_JOBS = 50

_worker_started = False
_worker_lock = threading.Lock()


def create_job(session_id: str, inputs: dict) -> str:
    job_id = uuid.uuid4().hex
    with _JOBS_LOCK:
        _JOBS[job_id] = {
            "id": job_id,
            "session_id": session_id,
            "status": "queued",
            "stage": None,
            # {"done": int, "total": int} while a stage has countable
            # sub-steps (summarizing a long transcript in chunks), else None.
            "progress": None,
            "error": None,
            "notes": None,
            "video_path": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        _JOB_INPUTS[job_id] = dict(inputs)
        _prune_terminal_jobs_locked()
    return job_id


def _prune_terminal_jobs_locked() -> None:
    """Keep only the most recent _MAX_TERMINAL_JOBS terminal jobs; caller
    must hold _JOBS_LOCK. Active (queued/running) jobs are never pruned.
    """
    terminal = [j for j in _JOBS.values() if j["status"] in ("done", "failed")]
    if len(terminal) <= _MAX_TERMINAL_JOBS:
        return
    terminal.sort(key=lambda j: j["created_at"])
    to_drop = terminal[: len(terminal) - _MAX_TERMINAL_JOBS]
    for job in to_drop:
        del _JOBS[job["id"]]
        _JOB_INPUTS.pop(job["id"], None)


def enqueue(job_id: str) -> None:
    _QUEUE.put(job_id)


def get_job(job_id: str) -> Optional[dict]:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        return dict(job) if job is not None else None


def get_job_inputs(job_id: str) -> Optional[dict]:
    with _JOBS_LOCK:
        inputs = _JOB_INPUTS.get(job_id)
        return dict(inputs) if inputs is not None else None


def is_busy() -> bool:
    """True while any job is queued or running.

    Used to lock out storage-dir moves: moving mid-job can PermissionError
    on Windows (open file handles) or split the session index across the
    old and new dirs if the worker appends to a re-created index in the
    old location after the move.
    """
    with _JOBS_LOCK:
        return any(job["status"] in ("queued", "running") for job in _JOBS.values())


def list_jobs() -> list[dict]:
    with _JOBS_LOCK:
        jobs_copy = [dict(j) for j in _JOBS.values()]
    jobs_copy.sort(key=lambda j: j["created_at"], reverse=True)
    return jobs_copy


def update_job(job_id: str, **fields) -> None:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return
        job.update(fields)
        if fields.get("status") in ("done", "failed"):
            _prune_terminal_jobs_locked()


def start_worker(process_fn: Callable[[str], None]) -> None:
    """Start the single background worker thread. Idempotent -- safe to
    call more than once (e.g. if the importing module is reloaded); only
    the first call actually starts a thread.
    """
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        _worker_started = True

    # Capture the queue object by value now, so if a caller (tests) later
    # reassigns the module-level _QUEUE, this thread keeps listening on
    # the queue that existed when it started rather than silently
    # switching to a new one.
    job_queue = _QUEUE

    def _loop() -> None:
        while True:
            job_id = job_queue.get()
            update_job(job_id, status="running")
            try:
                process_fn(job_id)
            except Exception as e:  # noqa: BLE001 - backstop for a bug in
                # process_fn; must not kill the worker thread or every
                # subsequent job would silently hang in "queued" forever.
                update_job(job_id, status="failed", error=f"Internal error: {e}")

    thread = threading.Thread(target=_loop, name="process-job-worker", daemon=True)
    thread.start()
