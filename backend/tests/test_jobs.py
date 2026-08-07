import queue
import threading
import time

import pytest

from app import jobs


@pytest.fixture(autouse=True)
def _isolated_job_state(monkeypatch):
    """Each test gets a fresh, empty job store and its own queue so tests
    don't see jobs left over from other tests. Worker threads started in a
    prior test are never actually stopped (Python threads can't be killed),
    but start_worker captures its queue in a closure at call time, so an
    old thread just blocks forever on its now-abandoned queue instead of
    competing for jobs enqueued by later tests.
    """
    monkeypatch.setattr(jobs, "_JOBS", {})
    monkeypatch.setattr(jobs, "_JOB_INPUTS", {})
    monkeypatch.setattr(jobs, "_QUEUE", queue.Queue())
    monkeypatch.setattr(jobs, "_worker_started", False)


def test_create_job_returns_id_with_queued_status():
    job_id = jobs.create_job(session_id="abc", inputs={"x": 1})
    job = jobs.get_job(job_id)
    assert job["id"] == job_id
    assert job["session_id"] == "abc"
    assert job["status"] == "queued"
    assert job["stage"] is None
    assert job["error"] is None
    assert job["notes"] is None
    assert job["video_path"] is None
    assert "created_at" in job


def test_get_job_returns_none_for_unknown_id():
    assert jobs.get_job("does-not-exist") is None


def test_get_job_inputs_round_trips():
    job_id = jobs.create_job(session_id="abc", inputs={"foo": "bar"})
    assert jobs.get_job_inputs(job_id) == {"foo": "bar"}


def test_get_job_inputs_returns_none_for_unknown_id():
    assert jobs.get_job_inputs("does-not-exist") is None


def test_update_job_merges_fields():
    job_id = jobs.create_job(session_id="abc", inputs={})
    jobs.update_job(job_id, status="running", stage="muxing")
    job = jobs.get_job(job_id)
    assert job["status"] == "running"
    assert job["stage"] == "muxing"


def test_update_job_is_noop_for_unknown_id():
    jobs.update_job("does-not-exist", status="running")  # must not raise


def test_get_job_returns_a_copy_not_the_live_record():
    job_id = jobs.create_job(session_id="abc", inputs={})
    job = jobs.get_job(job_id)
    job["status"] = "mutated"
    assert jobs.get_job(job_id)["status"] == "queued"


def test_create_job_copies_inputs_defensively():
    inputs = {"x": 1, "y": 2}
    job_id = jobs.create_job(session_id="abc", inputs=inputs)
    inputs["x"] = 999  # Mutate the original dict passed to create_job
    inputs["z"] = 3
    # The stored inputs should still have the original values
    stored_inputs = jobs.get_job_inputs(job_id)
    assert stored_inputs == {"x": 1, "y": 2}
    assert "z" not in stored_inputs


def test_list_jobs_sorted_newest_first():
    id1 = jobs.create_job(session_id="one", inputs={})
    id2 = jobs.create_job(session_id="two", inputs={})
    listed = jobs.list_jobs()
    ids_in_order = [j["id"] for j in listed]
    assert ids_in_order.index(id2) < ids_in_order.index(id1)


def test_prune_keeps_only_recent_terminal_jobs_and_drops_their_inputs():
    ids = [jobs.create_job(session_id=str(i), inputs={"i": i}) for i in range(55)]
    for job_id in ids:
        jobs.update_job(job_id, status="done")

    listed = jobs.list_jobs()
    assert len(listed) == 50
    for job_id in ids[:5]:
        assert jobs.get_job(job_id) is None
        assert jobs.get_job_inputs(job_id) is None
    for job_id in ids[5:]:
        assert jobs.get_job(job_id) is not None


def test_prune_never_drops_active_jobs():
    active_id = jobs.create_job(session_id="active", inputs={})
    for i in range(55):
        done_id = jobs.create_job(session_id=str(i), inputs={})
        jobs.update_job(done_id, status="done")

    assert jobs.get_job(active_id) is not None


def test_start_worker_processes_enqueued_job():
    processed = []
    jobs.start_worker(lambda job_id: processed.append(job_id))

    job_id = jobs.create_job(session_id="abc", inputs={})
    jobs.enqueue(job_id)

    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and job_id not in processed:
        time.sleep(0.01)

    assert processed == [job_id]


def test_start_worker_marks_job_failed_if_process_fn_raises():
    def boom(job_id):
        raise RuntimeError("kaboom")

    jobs.start_worker(boom)

    job_id = jobs.create_job(session_id="abc", inputs={})
    jobs.enqueue(job_id)

    deadline = time.monotonic() + 2.0
    job = jobs.get_job(job_id)
    while time.monotonic() < deadline and job["status"] == "queued":
        time.sleep(0.01)
        job = jobs.get_job(job_id)

    assert job["status"] == "failed"
    assert "kaboom" in job["error"]


def test_start_worker_is_idempotent():
    calls = []
    jobs.start_worker(lambda job_id: calls.append(job_id))
    jobs.start_worker(lambda job_id: calls.append(("second-worker", job_id)))

    job_id = jobs.create_job(session_id="abc", inputs={})
    jobs.enqueue(job_id)

    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and not calls:
        time.sleep(0.01)

    # Only the process_fn from the first start_worker call is ever wired
    # to the worker thread -- the second call is a no-op.
    assert calls == [job_id]


def test_jobs_run_serially_not_concurrently():
    active = {"count": 0}
    max_concurrent = {"value": 0}
    lock = threading.Lock()
    done_event = threading.Event()
    remaining = {"count": 3}

    def slow_process_fn(job_id):
        with lock:
            active["count"] += 1
            max_concurrent["value"] = max(max_concurrent["value"], active["count"])
        time.sleep(0.1)
        with lock:
            active["count"] -= 1
            remaining["count"] -= 1
            if remaining["count"] == 0:
                done_event.set()

    jobs.start_worker(slow_process_fn)

    for i in range(3):
        job_id = jobs.create_job(session_id=str(i), inputs={})
        jobs.enqueue(job_id)

    assert done_event.wait(timeout=5.0)
    assert max_concurrent["value"] == 1
