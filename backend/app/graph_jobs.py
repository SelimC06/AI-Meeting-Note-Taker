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

# _indexing: True while the worker is using a store dir (reading it,
# extracting, merging into its knowledge_graph.json). _store_blocked: True
# while a storage-dir move owns the store. The two are mutually exclusive
# and both flip only under _INDEXING_LOCK: the worker claims the store
# (_try_claim_store) only while no move has it blocked, and a move blocks it
# (try_block_store) only while the worker isn't using it. A plain
# check-then-act on is_busy() left a gap -- the move could check "not
# indexing", then the worker set _indexing, read the OLD store, and spent
# minutes extracting into a folder the move was emptying.
_INDEXING_LOCK = threading.Lock()
_indexing = False
_store_blocked = False


def is_busy() -> bool:
    """True while a session is actively being extracted/merged (not while
    merely waiting in the queue or yielding to jobs.is_busy()).
    """
    with _INDEXING_LOCK:
        return _indexing


def try_block_store() -> bool:
    """For a storage-dir move: stop the worker from claiming the store.
    Returns False (nothing changed) if the worker is using it right now.
    Every True must be paired with unblock_store(). The worker never waits
    on anything while holding _INDEXING_LOCK, so callers may hold their own
    locks around this (server.py calls it under _store_state_lock).
    """
    global _store_blocked
    with _INDEXING_LOCK:
        if _indexing:
            return False
        _store_blocked = True
        return True


def unblock_store() -> None:
    global _store_blocked
    with _INDEXING_LOCK:
        _store_blocked = False


def _try_claim_store() -> bool:
    global _indexing
    with _INDEXING_LOCK:
        if _store_blocked:
            return False
        _indexing = True
        return True


def enqueue_session(session_id: str) -> None:
    _QUEUE.put(session_id)


def backfill_unindexed(store_dir: Path) -> int:
    """Enqueue every active (non-trashed) session missing from the graph's
    indexed_sessions. Covers pre-feature sessions and any session whose
    extraction previously failed. Returns how many were enqueued.
    """
    graph = knowledge_graph.load_graph(store_dir)
    indexed = set(graph["indexed_sessions"])
    count = 0
    for record in load_sessions(store_dir):
        sid = record.get("id")
        if not sid or record.get("trashed_at") or sid in indexed:
            continue
        # Its extraction kept coming back unusable -- stop paying to retry.
        if knowledge_graph.extraction_gave_up(graph, sid):
            continue
        enqueue_session(sid)
        count += 1
    return count


def index_session(store_dir: Path, session_id: str, model: str, client=None) -> None:
    """Extract + merge one session. Skips (no-op) unknown, trashed, or
    already-indexed sessions.

    A valid extraction is merged even when it's EMPTY -- the notes simply
    have nothing to extract (a two-line meeting), and leaving it unindexed
    re-extracted it on every launch forever. An unusable one
    (ExtractionFailed) leaves the session unindexed and counts an attempt;
    backfill_unindexed stops retrying after MAX_EXTRACTION_ATTEMPTS.
    Transport errors (model unreachable) propagate as before and count
    nothing -- those are worth retrying next launch.
    """
    record = next((r for r in load_sessions(store_dir) if r.get("id") == session_id), None)
    if record is None or record.get("trashed_at"):
        return
    if session_id in knowledge_graph.load_graph(store_dir)["indexed_sessions"]:
        return
    try:
        extraction = graph_extract.extract_from_notes(record.get("notes") or "", model=model, client=client)
    except graph_extract.ExtractionFailed as e:
        attempts = knowledge_graph.record_extraction_failure(store_dir, session_id)
        print(f"[graph_jobs] extraction for {session_id} was unusable (attempt {attempts}): {e}", flush=True)
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
                # Yield to the recording pipeline, and to a storage move in
                # progress. get_store() is read only AFTER the claim
                # succeeds, so a move that finished while this waited is
                # seen -- the session is indexed in the new folder.
                while jobs.is_busy() or not _try_claim_store():
                    time.sleep(IDLE_POLL_SECONDS)
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
