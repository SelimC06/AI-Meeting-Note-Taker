"""Background knowledge-graph indexing.

A single daemon worker thread pulls session ids off an in-memory queue,
extracts entities/relations from that session's notes, and merges them
into the knowledge graph. Deliberately separate from jobs.py's queue:
that one is coupled to UI-polled job records, and graph indexing has no
status to poll -- it's invisible background work.

The worker YIELDS to the recording pipeline: while jobs.is_busy() reports
a queued/running processing job, no extraction starts. This matters most
for the startup backfill sweep (dozens of unindexed meetings after an
upgrade must not compete with a live transcription for CPU).

Queue state is in-memory only -- a restart loses queued ids, and the next
startup's backfill_unindexed() re-derives them from the diff between the
sessions index and the graph's indexed_sessions. Same crash model as
jobs.py.
"""
from __future__ import annotations

import queue
import threading
import time
from pathlib import Path
from typing import Callable

from . import graph_extract, jobs, knowledge_graph
from .sessions_store import load_sessions

_QUEUE: "queue.Queue[str]" = queue.Queue()
_worker_started = False
_worker_lock = threading.Lock()

# How often the worker re-checks jobs.is_busy() while yielding.
IDLE_POLL_SECONDS = 5.0

# True while the worker is between picking up a session and finishing
# index_session() for it (extraction + merge). Same convention as
# jobs.is_busy(): used to lock out storage-dir moves, since a move mid-
# extraction can write knowledge_graph.json into a dir that's mid-move or
# already abandoned by the move.
_INDEXING_LOCK = threading.Lock()
_indexing = False


def is_busy() -> bool:
    """True while a session is actively being extracted/merged (not while
    merely waiting in the queue or yielding to jobs.is_busy()).
    """
    with _INDEXING_LOCK:
        return _indexing


def enqueue_session(session_id: str) -> None:
    _QUEUE.put(session_id)


def backfill_unindexed(store_dir: Path) -> int:
    """Enqueue every active (non-trashed) session missing from the graph's
    indexed_sessions. Covers pre-feature sessions and any session whose
    extraction previously failed. Returns how many were enqueued.
    """
    indexed = set(knowledge_graph.load_graph(store_dir)["indexed_sessions"])
    count = 0
    for record in load_sessions(store_dir):
        sid = record.get("id")
        if not sid or record.get("trashed_at") or sid in indexed:
            continue
        enqueue_session(sid)
        count += 1
    return count


def index_session(store_dir: Path, session_id: str, model: str, client=None) -> None:
    """Extract + merge one session. Skips (no-op) unknown, trashed, or
    already-indexed sessions. An empty extraction (extract pass failed or
    found nothing) leaves the session unindexed so the next backfill sweep
    retries it.
    """
    record = next((r for r in load_sessions(store_dir) if r.get("id") == session_id), None)
    if record is None or record.get("trashed_at"):
        return
    if session_id in knowledge_graph.load_graph(store_dir)["indexed_sessions"]:
        return
    extraction = graph_extract.extract_from_notes(record.get("notes") or "", model=model, client=client)
    if not extraction.entities:
        return
    # Extraction can take minutes; the session may have been permanently
    # deleted meanwhile. Re-check under _GRAPH_LOCK (the lock
    # knowledge_graph.remove_session takes) so a delete either lands before
    # this check -- and we skip -- or waits and then removes what we merge.
    with knowledge_graph._GRAPH_LOCK:
        if not any(r.get("id") == session_id for r in load_sessions(store_dir)):
            return
        knowledge_graph.merge_extraction(store_dir, session_id, extraction.model_dump())


def start_worker(
    get_store: Callable[[], Path],
    get_model: Callable[[], str],
    get_client: Callable[[], object] = lambda: None,
) -> None:
    """Start the single daemon worker thread. Idempotent, same as
    jobs.start_worker. get_store/get_model/get_client are callables (not
    values) so the worker always sees the CURRENT storage dir, chat model,
    and LLM client even after a settings change mid-session.
    """
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        _worker_started = True

    # Capture by value so a test reassigning the module-level _QUEUE
    # strands the old thread on the old queue (same as jobs.start_worker).
    work_queue = _QUEUE

    def _loop() -> None:
        global _indexing
        while True:
            session_id = work_queue.get()
            try:
                while jobs.is_busy():
                    time.sleep(IDLE_POLL_SECONDS)
                with _INDEXING_LOCK:
                    _indexing = True
                try:
                    index_session(get_store(), session_id, get_model(), client=get_client())
                finally:
                    with _INDEXING_LOCK:
                        _indexing = False
            except Exception as e:  # noqa: BLE001 - backstop: one bad session
                # (or a transient Ollama failure) must never kill the loop;
                # the session stays unindexed and backfill retries later.
                print(f"[graph_jobs] indexing session {session_id} failed: {e}", flush=True)

    thread = threading.Thread(target=_loop, name="graph-index-worker", daemon=True)
    thread.start()
