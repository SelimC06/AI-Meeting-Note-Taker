import queue
import threading
import time

import pytest

from app import graph_jobs, knowledge_graph
from app.graph_extract import Extraction
from app.sessions_store import append_session


@pytest.fixture(autouse=True)
def _isolated_worker_state(monkeypatch):
    """Fresh queue + un-started worker per test, same convention as
    test_jobs.py's fixture: old worker threads block forever on their
    captured, now-abandoned queues.
    """
    monkeypatch.setattr(graph_jobs, "_QUEUE", queue.Queue())
    monkeypatch.setattr(graph_jobs, "_worker_started", False)
    monkeypatch.setattr(graph_jobs, "IDLE_POLL_SECONDS", 0.01)


def _record(sid, notes="# Title: Test\n\n- Alice presented the roadmap.", trashed_at=None):
    return {
        "id": sid, "created_at": "2026-08-13T10:00:00+00:00", "title": "Test",
        "notes": notes, "video_path": "", "trashed_at": trashed_at, "status": "done",
    }


SAMPLE_EXTRACTION = Extraction.model_validate({
    "entities": [{"id": 0, "type": "person", "name": "Alice", "aliases": []}],
    "relations": [],
})


def wait_until(cond, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.01)
    return False


def test_index_session_passes_client_through_to_extract_from_notes(tmp_path, monkeypatch):
    append_session(tmp_path, _record("s1"))

    captured = {}

    def fake_extract_from_notes(notes, model, client=None):
        captured["client"] = client
        captured["model"] = model
        return Extraction(entities=[], relations=[])

    monkeypatch.setattr(graph_jobs.graph_extract, "extract_from_notes", fake_extract_from_notes)

    sentinel_client = object()
    graph_jobs.index_session(tmp_path, "s1", "gpt-4o-mini", client=sentinel_client)
    assert captured["client"] is sentinel_client
    assert captured["model"] == "gpt-4o-mini"


def test_index_session_extracts_and_merges(tmp_path, monkeypatch):
    append_session(tmp_path, _record("s1"))
    monkeypatch.setattr(graph_jobs.graph_extract, "extract_from_notes", lambda notes, model, client=None: SAMPLE_EXTRACTION)
    graph_jobs.index_session(tmp_path, "s1", model="test-model")
    graph = knowledge_graph.load_graph(tmp_path)
    assert graph["indexed_sessions"] == ["s1"]
    assert "person:alice" in graph["nodes"]


def test_index_session_skips_unknown_trashed_and_already_indexed(tmp_path, monkeypatch):
    calls = []

    def fake_extract(notes, model, client=None):
        calls.append(notes)
        return SAMPLE_EXTRACTION

    monkeypatch.setattr(graph_jobs.graph_extract, "extract_from_notes", fake_extract)

    graph_jobs.index_session(tmp_path, "missing", model="m")     # unknown id
    append_session(tmp_path, _record("s2", trashed_at="2026-08-13T11:00:00+00:00"))
    graph_jobs.index_session(tmp_path, "s2", model="m")          # trashed
    assert calls == []

    append_session(tmp_path, _record("s3"))
    graph_jobs.index_session(tmp_path, "s3", model="m")
    graph_jobs.index_session(tmp_path, "s3", model="m")          # already indexed
    assert len(calls) == 1


def test_index_session_leaves_session_unindexed_on_empty_extraction(tmp_path, monkeypatch):
    append_session(tmp_path, _record("s1"))
    monkeypatch.setattr(graph_jobs.graph_extract, "extract_from_notes", lambda notes, model, client=None: Extraction())
    graph_jobs.index_session(tmp_path, "s1", model="m")
    assert knowledge_graph.load_graph(tmp_path)["indexed_sessions"] == []


def test_worker_processes_enqueued_sessions(tmp_path, monkeypatch):
    append_session(tmp_path, _record("s1"))
    monkeypatch.setattr(graph_jobs.graph_extract, "extract_from_notes", lambda notes, model, client=None: SAMPLE_EXTRACTION)
    monkeypatch.setattr(graph_jobs.jobs, "is_busy", lambda: False)

    graph_jobs.start_worker(lambda: tmp_path, lambda: "test-model")
    graph_jobs.enqueue_session("s1")

    assert wait_until(lambda: knowledge_graph.load_graph(tmp_path)["indexed_sessions"] == ["s1"])


def test_worker_yields_while_recording_pipeline_is_busy(tmp_path, monkeypatch):
    append_session(tmp_path, _record("s1"))
    monkeypatch.setattr(graph_jobs.graph_extract, "extract_from_notes", lambda notes, model, client=None: SAMPLE_EXTRACTION)

    busy = {"value": True}
    monkeypatch.setattr(graph_jobs.jobs, "is_busy", lambda: busy["value"])

    graph_jobs.start_worker(lambda: tmp_path, lambda: "test-model")
    graph_jobs.enqueue_session("s1")

    time.sleep(0.2)
    assert knowledge_graph.load_graph(tmp_path)["indexed_sessions"] == []  # still yielding

    busy["value"] = False
    assert wait_until(lambda: knowledge_graph.load_graph(tmp_path)["indexed_sessions"] == ["s1"])


def test_worker_survives_an_exception_and_continues(tmp_path, monkeypatch):
    append_session(tmp_path, _record("bad"))
    append_session(tmp_path, _record("good"))

    def flaky_extract(notes, model, client=None):
        if "bad" in flaky_extract.current:
            raise RuntimeError("simulated extraction crash")
        return SAMPLE_EXTRACTION

    real_index = graph_jobs.index_session

    def tracking_index(store_dir, session_id, model, client=None):
        flaky_extract.current = session_id
        real_index(store_dir, session_id, model, client=client)

    monkeypatch.setattr(graph_jobs.graph_extract, "extract_from_notes", flaky_extract)
    monkeypatch.setattr(graph_jobs, "index_session", tracking_index)
    monkeypatch.setattr(graph_jobs.jobs, "is_busy", lambda: False)

    graph_jobs.start_worker(lambda: tmp_path, lambda: "test-model")
    graph_jobs.enqueue_session("bad")
    graph_jobs.enqueue_session("good")

    assert wait_until(lambda: knowledge_graph.load_graph(tmp_path)["indexed_sessions"] == ["good"])


def test_is_busy_true_only_while_index_session_is_running(tmp_path, monkeypatch):
    """Regression test for the storage-move race: is_busy() must report
    True for the whole 30-90s extraction+merge window (not just while the
    session is queued), so server.py can reject a concurrent storage move.
    """
    append_session(tmp_path, _record("s1"))
    monkeypatch.setattr(graph_jobs.jobs, "is_busy", lambda: False)

    release = threading.Event()
    started = threading.Event()

    def blocking_extract(notes, model, client=None):
        started.set()
        release.wait(timeout=2)
        return SAMPLE_EXTRACTION

    monkeypatch.setattr(graph_jobs.graph_extract, "extract_from_notes", blocking_extract)

    assert graph_jobs.is_busy() is False

    graph_jobs.start_worker(lambda: tmp_path, lambda: "test-model")
    graph_jobs.enqueue_session("s1")

    assert wait_until(started.is_set)
    assert wait_until(lambda: graph_jobs.is_busy() is True)

    release.set()
    assert wait_until(lambda: graph_jobs.is_busy() is False)
    assert knowledge_graph.load_graph(tmp_path)["indexed_sessions"] == ["s1"]


def test_backfill_enqueues_only_unindexed_active_sessions(tmp_path, monkeypatch):
    append_session(tmp_path, _record("s1"))
    append_session(tmp_path, _record("s2"))
    append_session(tmp_path, _record("s3", trashed_at="2026-08-13T11:00:00+00:00"))
    knowledge_graph.merge_extraction(tmp_path, "s1", SAMPLE_EXTRACTION.model_dump())

    count = graph_jobs.backfill_unindexed(tmp_path)
    assert count == 1
    assert graph_jobs._QUEUE.get_nowait() == "s2"
    with pytest.raises(queue.Empty):
        graph_jobs._QUEUE.get_nowait()
