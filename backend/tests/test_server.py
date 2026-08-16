import asyncio
import io
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import httpx
import pytest
from fastapi.testclient import TestClient

import app.server as server_module
from app.server import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # Redirect uploads to a temp dir so tests don't pollute backend/app/uploads
    monkeypatch.setattr(server_module, "STORE", tmp_path)
    tmp_path.mkdir(exist_ok=True)
    # Redirect settings.json to a temp file so tests don't pollute/read the
    # real backend/app/settings.json in this checkout.
    monkeypatch.setattr(server_module, "SETTINGS_PATH", tmp_path / "settings.json")
    # _ollama_health_cached() refreshes on a background daemon thread, which
    # can still be in flight from the previous test when this fixture runs.
    # Block on the lock first -- it's only held while a _refresh thread is
    # running, and released right after that thread's writes -- so by the
    # time this returns, no stale thread is left that could clobber the
    # fresh dict installed below.
    with server_module._ollama_health_lock:
        pass
    # Reset the /health Ollama status cache so each test starts with a cold
    # cache -- otherwise a cached value from a previous test (module-level
    # state, TTL 10s) would leak into this test's assertions.
    monkeypatch.setattr(server_module, "_ollama_health", {"ok": False, "checked_at": 0.0})
    # Default to a fast, always-succeeding probe so tests that don't care
    # about the ollama field never wait on (or race with) a real network
    # call. Tests that care about a specific outcome monkeypatch
    # assert_ollama_up again themselves, after this fixture runs.
    monkeypatch.setattr(server_module, "assert_ollama_up", lambda: None)
    # base_url must be an allowed TrustedHostMiddleware host -- the default
    # "http://testserver" would otherwise get rejected with 400 before
    # reaching any route, since only localhost/127.0.0.1 are allowed.
    return TestClient(app, base_url="http://127.0.0.1")


import time


def wait_for_ollama_refresh(timeout: float = 2.0) -> None:
    # _ollama_health_cached() now always kicks the real probe onto a
    # background daemon thread and returns the cached value instantly --
    # tests that need to see the probe's *result* have to wait for that
    # thread to land it in _ollama_health rather than reading the response
    # of the triggering /health call.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server_module._ollama_health["checked_at"] > 0.0:
            return
        time.sleep(0.01)
    raise AssertionError("ollama health refresh did not complete in time")


def wait_for_job(client: TestClient, job_id: str, timeout: float = 2.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        resp = client.get(f"/jobs/{job_id}")
        assert resp.status_code == 200
        job = resp.json()
        if job["status"] in ("done", "failed"):
            return job
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} did not finish within {timeout}s")


def test_root_respects_app_data_dir_env_var(tmp_path, monkeypatch):
    import importlib
    import app.server as server_module

    custom_dir = tmp_path / "custom-app-data"
    custom_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("APP_DATA_DIR", str(custom_dir))
    try:
        importlib.reload(server_module)
        assert server_module.ROOT == custom_dir
        assert server_module.SETTINGS_PATH == custom_dir / "settings.json"
    finally:
        monkeypatch.delenv("APP_DATA_DIR", raising=False)
        importlib.reload(server_module)


def test_max_upload_mb_falls_back_to_default_on_non_numeric_env(tmp_path, monkeypatch):
    """
    Regression test for brief 13 #5: MAX_UPLOAD_MB='garbage' used to crash
    the whole backend at import time (int('garbage') raises uncaught)
    instead of just falling back to the default.
    """
    import importlib
    import app.server as server_module

    custom_dir = tmp_path / "app-data"
    custom_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("APP_DATA_DIR", str(custom_dir))
    monkeypatch.setenv("MAX_UPLOAD_MB", "not-a-number")
    try:
        reloaded = importlib.reload(server_module)
        assert reloaded.MAX_UPLOAD_MB == 2048
    finally:
        monkeypatch.delenv("APP_DATA_DIR", raising=False)
        monkeypatch.delenv("MAX_UPLOAD_MB", raising=False)
        importlib.reload(server_module)


def test_max_upload_mb_is_configurable_via_env(tmp_path, monkeypatch):
    import importlib
    import app.server as server_module

    custom_dir = tmp_path / "app-data"
    custom_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("APP_DATA_DIR", str(custom_dir))
    monkeypatch.setenv("MAX_UPLOAD_MB", "10")
    try:
        reloaded = importlib.reload(server_module)
        assert reloaded.MAX_UPLOAD_MB == 10
    finally:
        monkeypatch.delenv("APP_DATA_DIR", raising=False)
        monkeypatch.delenv("MAX_UPLOAD_MB", raising=False)
        importlib.reload(server_module)


def test_health_survives_a_purge_expired_trash_failure_at_import_time(tmp_path, monkeypatch):
    """Regression test for Fix 3D: purge_expired_trash(STORE) used to run
    bare at module import -- one unexpected failure (e.g. a legacy naive
    trashed_at slipping past the guard) crashed the whole backend on every
    startup until the index was repaired by hand. It must be caught and
    logged instead of preventing boot.
    """
    import importlib
    import app.server as server_module
    import app.sessions_store as sessions_store_module

    custom_dir = tmp_path / "app-data"
    custom_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("APP_DATA_DIR", str(custom_dir))

    def failing_purge(*args, **kwargs):
        raise TypeError("simulated naive/aware datetime comparison failure")

    monkeypatch.setattr(sessions_store_module, "purge_expired_trash", failing_purge)

    try:
        reloaded = importlib.reload(server_module)
        client = TestClient(reloaded.app, base_url="http://127.0.0.1")
        resp = client.get("/health")
        assert resp.status_code == 200
    finally:
        # Undo the env var AND the purge_expired_trash patch before
        # reloading -- otherwise this reload's `from .sessions_store import
        # purge_expired_trash` would re-bind server_module.purge_expired_trash
        # to the still-active failing_purge closure, leaking the failure
        # into every later test.
        monkeypatch.undo()
        importlib.reload(server_module)


def test_main_binds_to_localhost_only(monkeypatch):
    captured = {}

    def fake_run(app_arg, **kwargs):
        captured["app"] = app_arg
        captured["kwargs"] = kwargs

    monkeypatch.setattr(server_module.uvicorn, "run", fake_run)
    server_module.main()

    assert captured["app"] is server_module.app
    assert captured["kwargs"]["host"] == "127.0.0.1"


def test_run_decodes_subprocess_output_as_utf8(monkeypatch):
    """Regression test for brief 10: text=True alone decodes with the ANSI
    locale codepage on Windows, which raises UnicodeDecodeError on ffmpeg's
    UTF-8 output (e.g. a non-ASCII storage path) and 500s every upload.
    """
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["kwargs"] = kwargs
        return mock.Mock(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(server_module.subprocess, "run", fake_run)
    server_module.run(["ffmpeg", "-version"])

    assert captured["kwargs"]["encoding"] == "utf-8"
    assert captured["kwargs"]["errors"] == "replace"
    assert captured["kwargs"]["text"] is True


def test_trusted_host_middleware_rejects_dns_rebinding_host_header(client: TestClient):
    """A malicious page resolving attacker.com to 127.0.0.1 makes the
    browser send a request with Host: attacker.com -- CORS never applies to
    this (the browser treats it as same-origin), so TrustedHostMiddleware's
    Host-header check is the only thing that can still block it.
    """
    resp = client.get("/health", headers={"Host": "evil.com"})
    assert resp.status_code == 400


def test_trusted_host_middleware_allows_localhost_and_127_0_0_1(client: TestClient):
    for host in ("localhost", "127.0.0.1", "localhost:5173", "127.0.0.1:8000"):
        resp = client.get("/health", headers={"Host": host})
        assert resp.status_code == 200, f"Host: {host} was unexpectedly rejected"


def test_lifespan_starts_and_cleanly_cancels_the_daily_purge_task():
    """The daily-purge background task must not prevent clean startup/
    shutdown, and must not leak as a still-running task after shutdown.
    """
    with TestClient(app, base_url="http://127.0.0.1") as c:
        resp = c.get("/health")
        assert resp.status_code == 200


def test_daily_trash_purge_loop_calls_purge_expired_trash_off_the_event_loop(monkeypatch):
    """Regression test for brief 10: purge_expired_trash used to run once at
    import only, so a long-running app never purged trash again. The loop
    must sleep, then call purge_expired_trash (via to_thread, since it does
    blocking file I/O) against the CURRENT global STORE.
    """
    slept_for = []

    async def fake_sleep(seconds):
        slept_for.append(seconds)
        if len(slept_for) > 1:
            raise asyncio.CancelledError()

    purge_calls = []
    monkeypatch.setattr(server_module.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(
        server_module, "purge_expired_trash", lambda store: purge_calls.append(store)
    )

    async def run_until_cancelled():
        with pytest.raises(asyncio.CancelledError):
            await server_module._daily_trash_purge_loop()

    asyncio.run(run_until_cancelled())

    assert slept_for[0] == server_module._DAILY_PURGE_INTERVAL_SECONDS
    assert purge_calls == [server_module.STORE]


def test_google_auth_routes_removed(client: TestClient):
    resp = client.get("/auth/google/login")
    assert resp.status_code == 404

    resp = client.get("/auth/me")
    assert resp.status_code == 404


def _tiny_webm_bytes() -> bytes:
    # Not a real playable video; ffprobe_ok will reject it, which is fine —
    # this test exercises the "no valid screen video" 400 path plus confirms
    # the app imports and boots without the txt_path NameError blowing up
    # module-level state.
    return b"not-a-real-webm"


def test_process_rejects_invalid_screen_upload(client: TestClient):
    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(_tiny_webm_bytes()), "video/webm")},
    )
    assert resp.status_code == 400


def test_process_leaves_no_orphan_session_dir_on_rejected_upload(client: TestClient):
    """Regression test for brief 08: the session directory used to be
    mkdir'd BEFORE the screen upload was validated, so a rejected upload
    (invalid video here; missing entirely is the same code path) left an
    empty, unindexed, permanently undeletable orphan folder behind.
    Validation must now happen in a scratch temp dir before the session
    folder is ever created.
    """
    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(_tiny_webm_bytes()), "video/webm")},
    )
    assert resp.status_code == 400
    leftover_dirs = [p for p in server_module.STORE.iterdir() if p.is_dir()]
    assert leftover_dirs == []


def test_process_leaves_no_orphan_session_dir_when_screen_is_missing(client: TestClient):
    resp = client.post("/process")
    assert resp.status_code == 400
    leftover_dirs = [p for p in server_module.STORE.iterdir() if p.is_dir()]
    assert leftover_dirs == []


def test_process_is_not_a_coroutine_function():
    """FastAPI runs plain-def endpoints in its threadpool automatically; an
    async def endpoint instead runs directly on the event loop. /process does
    multi-GB synchronous file copies and blocking ffprobe subprocess calls
    with no `await`, so it must stay a plain def or every other request
    (/health, /sessions, job polling) stalls for the duration of an upload.
    """
    import inspect

    assert not inspect.iscoroutinefunction(server_module.process)


def test_health_stays_responsive_while_process_upload_is_slow(client, monkeypatch):
    """Regression test for brief 06: with /process as `async def`, a slow
    synchronous upload ran directly on the event loop and starved every other
    request. Simulates a slow upload by blocking inside save_upload, and
    asserts a concurrent /health request still gets served promptly instead
    of queuing up behind it.
    """
    import threading

    upload_entered = threading.Event()
    release_upload = threading.Event()

    def slow_save_upload(dst_dir, uf, name):
        upload_entered.set()
        assert release_upload.wait(timeout=10), "test itself stalled waiting to release the upload"
        return None  # treated as an invalid screen upload -> /process eventually 400s

    monkeypatch.setattr(server_module, "save_upload", slow_save_upload)

    results = {}

    def do_upload():
        results["response"] = client.post(
            "/process",
            files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
        )

    upload_thread = threading.Thread(target=do_upload)
    upload_thread.start()
    try:
        assert upload_entered.wait(timeout=5), "/process never reached save_upload"

        start = time.monotonic()
        health_resp = client.get("/health")
        elapsed = time.monotonic() - start

        assert health_resp.status_code == 200
        # Generous but decisive: if /process's blocking work still ran on the
        # event loop, /health couldn't even be scheduled until slow_save_upload
        # gave up at its own 10s wait, so this cleanly separates "responded
        # promptly while /process was blocked" from "queued up behind it"
        # without being sensitive to ordinary test-harness scheduling noise.
        assert elapsed < 8.0, (
            f"/health took {elapsed:.2f}s while /process was mid-upload -- "
            "looks like it's stuck behind /process on the event loop again"
        )
    finally:
        release_upload.set()
        upload_thread.join(timeout=10)

    assert results["response"].status_code == 400


def test_process_job_fails_with_friendly_message_when_mux_fails(client, monkeypatch):
    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        raise RuntimeError("ffmpeg: no suitable audio encoder found")

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    job = wait_for_job(client, job_id)
    assert job["status"] == "failed"
    assert job["error"] == (
        "Couldn't combine your audio and video — the recording file may be "
        "corrupted. Try recording again."
    )

    # Regression test for brief 08: a mux failure used to just mark the job
    # failed and return, leaving the session's already-saved files (screen
    # webm etc.) on disk with no index entry -- invisible to the UI,
    # excluded from trash purge, and undeletable via DELETE /sessions/{id}.
    sessions = client.get("/sessions").json()
    matching = [s for s in sessions if s["id"] == resp.json()["session_id"]]
    assert len(matching) == 1
    assert matching[0]["status"] == "failed"
    assert "Couldn't combine your audio and video" in matching[0]["notes"]

    del_resp = client.delete(f"/sessions/{resp.json()['session_id']}")
    assert del_resp.status_code == 200


def test_process_job_records_a_failed_session_on_an_unexpected_worker_exception(client, monkeypatch):
    """Regression test for brief 08: any exception the worker didn't already
    handle inline (here, to_wav raising before the mux try/except is even
    reached) used to propagate straight past _run_process_job to jobs.py's
    generic catch, which marks the job failed but has no idea a session
    directory exists -- leaving an unindexed orphan dir on disk forever.
    """
    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def broken_to_wav(*args, **kwargs):
        raise RuntimeError("simulated unexpected crash")

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "to_wav", broken_to_wav)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    job = wait_for_job(client, job_id)
    assert job["status"] == "failed"
    assert "simulated unexpected crash" in job["error"]

    sessions = client.get("/sessions").json()
    matching = [s for s in sessions if s["id"] == resp.json()["session_id"]]
    assert len(matching) == 1
    assert matching[0]["status"] == "failed"


def test_process_falls_back_to_stub_notes_without_transcription(client, monkeypatch):
    # Force the "transcription helper unavailable" path that previously
    # caused a NameError on txt_path.
    import sys
    import types

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", None)
    monkeypatch.setattr(server_module, "llava_complete", None)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    # This scenario falls all the way through to the real (unmocked)
    # faster_whisper fallback path, which would otherwise load a real
    # WhisperModel from disk/cache -- far slower than wait_for_job's
    # default timeout. Mock faster_whisper the same way
    # test_process_fallback_whisper_uses_configured_model does, so the
    # fallback code path is still exercised without the real ML model load.
    # transcribe() raises so this test exercises the stub-notes ("Key
    # Points") except branch, not the transcript-success branch.
    class FakeWhisperModel:
        def __init__(self, model_name, device=None, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1, **kwargs):
            raise RuntimeError("simulated whisper failure")

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    job = wait_for_job(client, job_id)
    assert job["status"] == "done"
    assert job["notes"]
    assert "Key Points" in job["notes"]
    assert job["session_id"] == resp.json()["session_id"]


def test_process_skips_summarization_when_no_transcript(client, monkeypatch, capsys):
    """
    Regression test for the txt_path NameError/UnboundLocalError bug.

    NOTE: with `llava_complete` also monkeypatched to None (as the sibling
    test above does), the pre-fix and post-fix code paths are indistinguishable
    at the HTTP level: pre-fix, `if llava_complete is None: raise RuntimeError(...)`
    fires and is swallowed by `except Exception` *before* `txt_path` is ever
    evaluated as a call argument; post-fix, the `if txt_path is not None:` guard
    skips the block entirely. Both produce a 200 with stub notes, so that test
    provides no coverage of the actual bug.

    To exercise the real bug, `llava_complete` here is a genuine (non-None)
    callable, so pre-fix code gets past the `is None` check and evaluates
    `raw_txt_path=txt_path` as a call argument. Since txt_path is only ever
    assigned inside the (skipped) `if stop_recording_and_transcribe is not None:`
    branch in the pre-fix code, this raises UnboundLocalError -- which is
    *also* swallowed by the same `except Exception` and logged as
    "summarization failed, falling back to raw transcript: ...". So even this scenario's
    HTTP response (200, stub notes) is identical pre-fix and post-fix.

    The only observable difference between the two code paths is therefore
    the log output: pre-fix logs a "summarization failed" message (from the caught
    UnboundLocalError); post-fix never enters the try block at all, so no
    such message is logged, and the llava_complete stub is never invoked
    either way (the crash in pre-fix happens while evaluating the argument,
    before the call is made). We assert on captured stdout to distinguish
    the two behaviors, since the response body alone cannot.
    """
    import sys
    import types

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", None)

    llava_calls = []

    def fake_llava_complete(**kwargs):
        llava_calls.append(kwargs)
        return "# Stub notes from llava\n"

    monkeypatch.setattr(server_module, "llava_complete", fake_llava_complete)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    # As explained above, llava_complete is never actually invoked on either
    # code path here, so this scenario also falls through to the real
    # (unmocked) faster_whisper fallback, which would otherwise load a real
    # WhisperModel from disk/cache. Mock it out the same way
    # test_process_fallback_whisper_uses_configured_model does.
    class FakeSegment:
        text = "hi"

    class FakeWhisperModel:
        def __init__(self, model_name, device=None, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1, **kwargs):
            return [FakeSegment()], object()

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    job = wait_for_job(client, job_id)
    assert job["status"] == "done"
    assert job["notes"]

    # The summarization block must never run when there is no transcript:
    # llava_complete should not be invoked...
    assert llava_calls == []

    # ...and no "summarization failed" log line (which the pre-fix
    # UnboundLocalError-on-txt_path would have produced via the
    # `except Exception` handler) should have been emitted.
    captured = capsys.readouterr()
    assert "summarization failed" not in captured.out
    assert "txt_path" not in captured.out


def test_process_reuses_existing_transcript_when_summarization_fails(client, monkeypatch, tmp_path):
    import sys
    import types

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    transcript_path = tmp_path / "transcript_.txt"
    transcript_path.write_text("hello from existing transcript", encoding="utf-8")

    def fake_stop_recording_and_transcribe(**kwargs):
        return str(transcript_path), []

    def failing_llava_complete(**kwargs):
        raise RuntimeError("llava down")

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe)
    monkeypatch.setattr(server_module, "llava_complete", failing_llava_complete)

    # If the code regresses to re-running Whisper on the full video instead
    # of reusing the transcript already on disk, fail loudly here rather
    # than silently falling back to stub notes (which the HTTP response
    # alone wouldn't distinguish from the fixed behavior).
    fake_module = types.ModuleType("faster_whisper")

    class ExplodingWhisperModel:
        def __init__(self, *a, **kw):
            raise AssertionError(
                "faster_whisper.WhisperModel should not be constructed when "
                "an existing transcript is already available"
            )

    fake_module.WhisperModel = ExplodingWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    job = wait_for_job(client, job_id)
    assert job["status"] == "done"
    assert "hello from existing transcript" in job["notes"]
    # Without this, transcript-only notes are indistinguishable from a real
    # AI summary that happened to just be the transcript -- the user has no
    # way to tell the model never actually ran.
    assert "AI summarization failed" in job["notes"]


def test_process_summarization_uses_configured_ollama_chat_model(client, monkeypatch, tmp_path):
    """Regression test: summarization used to always call llava_complete with
    no model= argument, so it silently fell back to LLaVA_summarize's own
    hardcoded DEFAULT_MODEL (a vision model configurable only via the
    OLLAMA_VISION_MODEL env var) -- completely ignoring whatever model the
    user picked in Settings for chat. The configured OLLAMA_CHAT_MODEL must
    now be threaded through as the model= argument.
    """
    import app.server as server_module

    server_module.OLLAMA_CHAT_MODEL = "llama3.1:8b"

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    transcript_path = tmp_path / "transcript_.txt"
    transcript_path.write_text("hello from existing transcript", encoding="utf-8")

    def fake_stop_recording_and_transcribe(**kwargs):
        return str(transcript_path), []

    captured = {}

    def fake_llava_complete(**kwargs):
        captured.update(kwargs)
        return "# Stub notes\n"

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe)
    monkeypatch.setattr(server_module, "llava_complete", fake_llava_complete)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    wait_for_job(client, resp.json()["job_id"])

    assert captured["model"] == "llama3.1:8b"


def test_process_survives_ollama_read_timeout_during_summarization(client, monkeypatch, tmp_path):
    """Regression test for brief 05: a wedged Ollama used to hang the
    summarize step forever (no client timeout), stalling the serial job
    worker and every recording queued behind it. With a timeout in place,
    llava_complete raises httpx.ReadTimeout instead -- the job must still
    finish (falling back to the raw transcript) rather than the session
    being lost or the worker getting stuck.
    """
    import sys
    import types

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    transcript_path = tmp_path / "transcript_.txt"
    transcript_path.write_text("hello from a transcript recorded before ollama wedged", encoding="utf-8")

    def fake_stop_recording_and_transcribe(**kwargs):
        return str(transcript_path), []

    def timing_out_llava_complete(**kwargs):
        raise httpx.ReadTimeout("timed out waiting for Ollama")

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe)
    monkeypatch.setattr(server_module, "llava_complete", timing_out_llava_complete)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    job = wait_for_job(client, job_id)
    assert job["status"] == "done"
    assert "hello from a transcript recorded before ollama wedged" in job["notes"]
    # A timeout must say so explicitly (not just the generic failure wording)
    # so the user understands why they're looking at a raw transcript instead
    # of an actual summary.
    assert "AI summarization timed out" in job["notes"]

    # The session itself must also be recorded, not just the in-memory job --
    # a timeout must not silently lose the recording.
    sessions = client.get("/sessions").json()
    assert any("hello from a transcript recorded before ollama wedged" in s["notes"] for s in sessions)


def test_process_survives_stop_recording_and_transcribe_failure(client, monkeypatch, capsys):
    """
    Regression test: if stop_recording_and_transcribe() raises (ffmpeg/Whisper
    failure on a corrupted or unusual upload), /process must not 500 -- it
    should log the failure and fall back to the existing raw-Whisper path,
    same as the llava_complete failure handling right below it.
    """
    import sys
    import types

    monkeypatch.setattr(server_module, "llava_complete", None)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    def failing_stop_recording_and_transcribe(**kwargs):
        raise RuntimeError("ffmpeg exploded")

    monkeypatch.setattr(
        server_module, "stop_recording_and_transcribe", failing_stop_recording_and_transcribe
    )

    class FakeWhisperModel:
        def __init__(self, model_name, device=None, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1, **kwargs):
            return [], object()

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    job = wait_for_job(client, job_id)
    assert job["status"] == "done"
    assert job["notes"]

    # The session must still be recorded in the index -- this is the actual
    # bug: pre-fix, the uncaught exception meant append_session() never ran.
    sessions = client.get("/sessions").json()
    assert any(s["id"] == job["session_id"] for s in sessions)

    captured = capsys.readouterr()
    assert "stop_recording_and_transcribe failed" in captured.out


def test_sessions_empty_when_no_index(client: TestClient):
    resp = client.get("/sessions")
    assert resp.status_code == 200
    assert resp.json() == []


def test_process_appends_to_sessions_and_get_sessions_returns_it(client, monkeypatch):
    import sys
    import types

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", None)
    monkeypatch.setattr(server_module, "llava_complete", None)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    # This falls through to the real (unmocked) faster_whisper fallback
    # path; mock it out to avoid loading a real WhisperModel (see
    # test_process_fallback_whisper_uses_configured_model for the pattern).
    class FakeSegment:
        text = "hi"

    class FakeWhisperModel:
        def __init__(self, model_name, device=None, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1, **kwargs):
            return [FakeSegment()], object()

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    job = wait_for_job(client, job_id)
    assert job["status"] == "done"
    session_id = job["session_id"]

    sessions_resp = client.get("/sessions")
    assert sessions_resp.status_code == 200
    sessions = sessions_resp.json()
    assert len(sessions) == 1
    entry = sessions[0]
    assert entry["id"] == session_id
    assert entry["notes"] == job["notes"]
    assert "created_at" in entry
    datetime.fromisoformat(entry["created_at"])
    assert entry["title"]  # non-empty, extracted or fallback


def test_sessions_returns_newest_first(client, monkeypatch):
    import sys
    import types

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", None)
    monkeypatch.setattr(server_module, "llava_complete", None)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    # This falls through to the real (unmocked) faster_whisper fallback
    # path; mock it out to avoid loading a real WhisperModel (see
    # test_process_fallback_whisper_uses_configured_model for the pattern).
    class FakeSegment:
        text = "hi"

    class FakeWhisperModel:
        def __init__(self, model_name, device=None, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1, **kwargs):
            return [FakeSegment()], object()

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    ids = []
    for _ in range(2):
        resp = client.post(
            "/process",
            files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
        )
        job = wait_for_job(client, resp.json()["job_id"])
        ids.append(job["session_id"])

    sessions = client.get("/sessions").json()
    assert [s["id"] for s in sessions] == list(reversed(ids))


def test_chat_returns_404_for_unknown_session(client: TestClient):
    resp = client.post("/chat/does-not-exist", json={"message": "hi", "history": []})
    assert resp.status_code == 404


def test_chat_streams_reply_for_known_session(client: TestClient, monkeypatch):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc123",
        "created_at": "2026-08-03T00:00:00+00:00",
        "title": "Test Meeting",
        "notes": "# Test Meeting\n- discussed things",
        "video_path": "x/final.webm",
    })

    def fake_stream_chat_reply(notes, message, history, **kwargs):
        assert "discussed things" in notes
        assert message == "what did we discuss?"
        assert history == []
        yield "We "
        yield "discussed things."

    monkeypatch.setattr(server_module, "assert_ollama_up", lambda: None)
    monkeypatch.setattr(server_module, "stream_chat_reply", fake_stream_chat_reply)

    resp = client.post("/chat/abc123", json={"message": "what did we discuss?", "history": []})
    assert resp.status_code == 200
    lines = [line for line in resp.text.splitlines() if line]
    assert [json.loads(line) for line in lines] == [{"token": "We "}, {"token": "discussed things."}]


def test_chat_stream_error_mid_generation_yields_typed_error_line(client: TestClient, monkeypatch):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc123",
        "created_at": "2026-08-03T00:00:00+00:00",
        "title": "Test Meeting",
        "notes": "notes",
        "video_path": "x",
    })

    def fake_stream_chat_reply(notes, message, history, **kwargs):
        yield "chunk one"
        yield "chunk two"
        raise RuntimeError("ollama died")

    monkeypatch.setattr(server_module, "assert_ollama_up", lambda: None)
    monkeypatch.setattr(server_module, "stream_chat_reply", fake_stream_chat_reply)

    resp = client.post("/chat/abc123", json={"message": "hi", "history": []})
    assert resp.status_code == 200
    lines = [json.loads(line) for line in resp.text.splitlines() if line]
    assert lines == [
        {"token": "chunk one"},
        {"token": "chunk two"},
        {"error": "ollama died"},
    ]


def test_chat_passes_history_through(client: TestClient, monkeypatch):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc123",
        "created_at": "2026-08-03T00:00:00+00:00",
        "title": "Test Meeting",
        "notes": "notes",
        "video_path": "x",
    })

    captured = {}

    def fake_stream_chat_reply(notes, message, history, **kwargs):
        captured["history"] = history
        yield "ok"

    monkeypatch.setattr(server_module, "assert_ollama_up", lambda: None)
    monkeypatch.setattr(server_module, "stream_chat_reply", fake_stream_chat_reply)

    resp = client.post(
        "/chat/abc123",
        json={
            "message": "follow-up question",
            "history": [
                {"role": "user", "content": "q1"},
                {"role": "assistant", "content": "a1"},
            ],
        },
    )
    assert resp.status_code == 200
    assert captured["history"] == [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
    ]


def test_chat_returns_503_when_ollama_unreachable(client: TestClient, monkeypatch):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc123",
        "created_at": "2026-08-03T00:00:00+00:00",
        "title": "Test Meeting",
        "notes": "notes",
        "video_path": "x",
    })

    def raise_unreachable():
        raise RuntimeError("connection refused")

    monkeypatch.setattr(server_module, "assert_ollama_up", raise_unreachable)

    resp = client.post("/chat/abc123", json={"message": "hi", "history": []})
    assert resp.status_code == 503


def test_debug_ollama_route_removed(client: TestClient):
    resp = client.get("/debug/ollama")
    assert resp.status_code == 404


def test_process_rejects_oversized_upload_by_content_length(client, monkeypatch):
    monkeypatch.setattr(server_module, "MAX_UPLOAD_BYTES", 10)  # tiny cap for the test
    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x" * 1000), "video/webm")},
    )
    assert resp.status_code == 413


def test_max_upload_middleware_rejects_malformed_content_length():
    """
    Regression test: a non-numeric Content-Length header must be rejected
    cleanly (400), not crash the middleware with an unhandled ValueError (500).
    """
    import asyncio

    async def unreachable_app(scope, receive, send):
        raise AssertionError("downstream app should not be reached for a malformed header")

    middleware = server_module.MaxUploadSizeMiddleware(unreachable_app)
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/process",
        "headers": [(b"content-length", b"not-a-number")],
    }

    async def receive():
        raise AssertionError("receive should not be called before the header is validated")

    sent = []

    async def send(message):
        sent.append(message)

    asyncio.run(middleware(scope, receive, send))

    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    assert status == 400


def test_max_upload_middleware_raises_http_exception_without_content_length(monkeypatch):
    """
    Regression test: uploads with no Content-Length header (e.g. chunked
    transfer-encoding) must still be capped at MAX_UPLOAD_BYTES by counting
    bytes as the body streams in.

    _UploadTooLarge is an HTTPException subclass so that, in the real app,
    FastAPI's routing.py re-raises it untouched (it only converts non-
    HTTPException errors) and Starlette's ExceptionMiddleware renders it as
    a proper 413 response. This hand-built ASGI stub has no
    ExceptionMiddleware layer above it, so the exception simply propagates
    out of the middleware call -- see
    test_process_rejects_oversized_upload_without_content_length below for
    the end-to-end proof against the real app.
    """
    import asyncio

    monkeypatch.setattr(server_module, "MAX_UPLOAD_BYTES", 10)

    async def consume_all_app(scope, receive, send):
        more = True
        while more:
            message = await receive()
            more = message.get("more_body", False)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    middleware = server_module.MaxUploadSizeMiddleware(consume_all_app)
    scope = {"type": "http", "method": "POST", "path": "/process", "headers": []}
    chunks = [
        {"type": "http.request", "body": b"x" * 6, "more_body": True},
        {"type": "http.request", "body": b"y" * 6, "more_body": False},
    ]

    async def receive():
        return chunks.pop(0)

    async def send(message):
        pass

    with pytest.raises(server_module.HTTPException) as excinfo:
        asyncio.run(middleware(scope, receive, send))

    assert excinfo.value.status_code == 413


def test_process_rejects_oversized_upload_without_content_length(client, monkeypatch):
    """
    End-to-end regression test against the REAL FastAPI app (not a hand-built
    ASGI stub): a chunked/streamed multipart POST with no declared
    Content-Length that exceeds MAX_UPLOAD_BYTES must still be rejected with
    413, not 400.

    This guards against the class of bug where _UploadTooLarge, if it were a
    bare Exception, gets caught and converted to a generic 400 by FastAPI's
    routing.py while it's inside `await request.form()` -- routing.py only
    re-raises HTTPException as-is and converts everything else. Because
    _UploadTooLarge is now an HTTPException subclass, it survives that layer
    untouched and Starlette's ExceptionMiddleware renders the real 413.
    """
    monkeypatch.setattr(server_module, "MAX_UPLOAD_BYTES", 10)

    boundary = "testboundary"
    field_header = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="screen"; filename="screen.webm"\r\n'
        f"Content-Type: video/webm\r\n\r\n"
    ).encode()
    field_footer = f"\r\n--{boundary}--\r\n".encode()

    def body_stream():
        yield field_header
        # Well over the tiny MAX_UPLOAD_BYTES cap, streamed in chunks so no
        # Content-Length is ever declared.
        for _ in range(5):
            yield b"x" * 1000
        yield field_footer

    resp = client.post(
        "/process",
        content=body_stream(),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )

    assert resp.status_code == 413


def test_process_413_response_includes_cors_header(client, monkeypatch):
    """
    Regression test: the 413 short-circuit from MaxUploadSizeMiddleware must
    still carry CORS headers, otherwise the browser blocks the response
    entirely and the frontend only sees a generic network error instead of
    the 413 status.
    """
    monkeypatch.setattr(server_module, "MAX_UPLOAD_BYTES", 10)  # tiny cap for the test
    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x" * 1000), "video/webm")},
        headers={"Origin": "http://localhost:5173"},
    )
    assert resp.status_code == 413
    assert resp.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_healthz_alias_matches_health(client: TestClient):
    healthz_resp = client.get("/healthz")
    health_resp = client.get("/health")
    assert healthz_resp.status_code == 200
    assert health_resp.status_code == 200
    assert healthz_resp.json() == health_resp.json()

    body = health_resp.json()
    assert body["ok"] is True
    assert body["backend"] is True
    assert isinstance(body["ollama"], bool)


def test_health_reports_ollama_down_on_read_timeout_instead_of_hanging(client, monkeypatch):
    """Regression test for a wedged Ollama (model-load hang, OOM): with no
    client timeout, assert_ollama_up() used to block the calling thread
    forever, and since /health is polled repeatedly, that eventually
    exhausts the whole threadpool. With a timeout in place it raises
    httpx.ReadTimeout instead -- /health must turn that into ollama: False,
    not let it propagate as a 500 or hang the request.
    """

    def raise_timeout():
        raise httpx.ReadTimeout("timed out waiting for Ollama")

    monkeypatch.setattr(server_module, "assert_ollama_up", raise_timeout)

    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["backend"] is True
    # First call on a cold cache always reports the stale cached value (False)
    # instantly -- the probe itself now runs on a background thread and can
    # no longer block this request even when it hangs.
    assert body["ollama"] is False

    wait_for_ollama_refresh()
    assert server_module._ollama_health["ok"] is False


def test_health_caches_ollama_status_across_immediate_requests(client, monkeypatch):
    """Regression test for the watchdog kill-loop: /health is polled with a
    3s abort by the Electron watchdog, so it must answer instantly even when
    the real Ollama probe is slow. The probe always runs on a background
    daemon thread now, never on the request thread, so two immediate /health
    calls both return the cached value instantly and only the first starts a
    refresh thread -- the second's lock.acquire fails while that thread is
    still in flight.
    """
    calls = []

    def slow_ok():
        calls.append(1)
        time.sleep(0.2)

    monkeypatch.setattr(server_module, "assert_ollama_up", slow_ok)

    first = client.get("/health")
    assert first.status_code == 200
    assert first.json()["ollama"] is False

    second = client.get("/health")
    assert second.status_code == 200
    assert second.json()["ollama"] is False
    assert len(calls) == 1, "second immediate call should not start a second refresh thread"

    wait_for_ollama_refresh()
    assert server_module._ollama_health["ok"] is True


def test_health_reports_ollama_false_when_assert_ollama_up_raises(client, monkeypatch):
    def raise_unreachable():
        raise RuntimeError("ollama unreachable")

    monkeypatch.setattr(server_module, "assert_ollama_up", raise_unreachable)

    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["backend"] is True
    assert body["ollama"] is False

    wait_for_ollama_refresh()
    assert server_module._ollama_health["ok"] is False


def test_health_releases_ollama_lock_when_thread_start_fails(client, monkeypatch):
    """Regression: if threading.Thread.start() raises (e.g. resource
    exhaustion) inside _ollama_health_cached, the lock guarding "a refresh is
    already running" must still be released in the except branch -- otherwise
    every later call's lock.acquire(blocking=False) fails forever and the
    cached Ollama status is frozen stale until restart.
    """
    import threading

    # TestClient itself spins up threads for the ASGI portal -- only the
    # health-refresh thread (target=_refresh) should be made to fail.
    original_start = threading.Thread.start
    calls = {"n": 0}

    def flaky_start(self):
        if getattr(self._target, "__name__", None) == "_refresh":
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("thread creation failed")
        return original_start(self)

    monkeypatch.setattr(threading.Thread, "start", flaky_start)

    first = client.get("/health")
    assert first.status_code == 200
    assert first.json()["ollama"] is False

    # The failed start must have released the lock -- otherwise this would
    # block (or, with blocking=False, fail to acquire) forever.
    assert server_module._ollama_health_lock.acquire(blocking=False)
    server_module._ollama_health_lock.release()

    # checked_at was never updated by the crashed refresh, so the TTL is
    # still expired and this call retries the refresh -- this time the
    # (unpatched-after-first-call) thread start succeeds.
    second = client.get("/health")
    assert second.status_code == 200

    wait_for_ollama_refresh()
    assert server_module._ollama_health["ok"] is True
    assert calls["n"] == 2


def test_process_does_not_extract_frames_via_stop_recording_and_transcribe(client, monkeypatch):
    """
    Regression test for brief 13 #4: stop_recording_and_transcribe used to
    be called with extract_frames_after=True, but its returned frame_paths
    was discarded (summarization is text-only, no frames are ever used) --
    the ffmpeg pass ran, and its frame_%05d.png outputs polluted the session
    dir, for nothing.
    """
    import sys
    import types

    monkeypatch.setattr(server_module, "llava_complete", None)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    captured_kwargs = {}

    def fake_stop_recording_and_transcribe(**kwargs):
        captured_kwargs.update(kwargs)
        return None, None

    monkeypatch.setattr(
        server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe
    )

    # txt_path is None above, so the job falls through to the faster_whisper
    # fallback path -- mock it out (same pattern as the frame-selection
    # tests above) to avoid loading a real WhisperModel.
    class FakeSegment:
        text = "hi"

    class FakeWhisperModel:
        def __init__(self, model_name, device=None, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1, **kwargs):
            return [FakeSegment()], object()

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    wait_for_job(client, job_id)

    assert captured_kwargs["extract_frames_after"] is False
    assert "frames_out_dir" not in captured_kwargs


def test_job_status_404_for_unknown_job_id(client: TestClient):
    resp = client.get("/jobs/some-unknown-id")
    assert resp.status_code == 404


def test_jobs_list_contains_created_job_with_expected_keys(client, monkeypatch):
    import sys
    import types

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", None)
    monkeypatch.setattr(server_module, "llava_complete", None)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    # This falls through to the real (unmocked) faster_whisper fallback
    # path; mock it out to avoid loading a real WhisperModel (see
    # test_process_fallback_whisper_uses_configured_model for the pattern).
    class FakeSegment:
        text = "hi"

    class FakeWhisperModel:
        def __init__(self, model_name, device=None, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1, **kwargs):
            return [FakeSegment()], object()

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    wait_for_job(client, job_id)

    list_resp = client.get("/jobs")
    assert list_resp.status_code == 200
    body = list_resp.json()
    assert isinstance(body, list)
    matching = [j for j in body if j["id"] == job_id]
    assert len(matching) == 1
    entry = matching[0]
    for key in (
        "id", "session_id", "status", "stage", "error", "notes", "video_path", "created_at",
    ):
        assert key in entry


def test_jobs_list_strips_notes_and_video_path_but_job_detail_keeps_them(client, monkeypatch):
    import sys
    import types

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", None)
    monkeypatch.setattr(server_module, "llava_complete", None)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    # This falls through to the real (unmocked) faster_whisper fallback
    # path; mock it out to avoid loading a real WhisperModel (see
    # test_process_fallback_whisper_uses_configured_model for the pattern).
    class FakeSegment:
        text = "hi"

    class FakeWhisperModel:
        def __init__(self, model_name, device=None, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1, **kwargs):
            return [FakeSegment()], object()

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    job = wait_for_job(client, job_id)
    assert job["status"] == "done"
    assert job["notes"]
    assert job["video_path"]

    list_resp = client.get("/jobs")
    assert list_resp.status_code == 200
    entry = next(j for j in list_resp.json() if j["id"] == job_id)
    assert entry["notes"] is None
    assert entry["video_path"] is None

    detail_resp = client.get(f"/jobs/{job_id}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["notes"] == job["notes"]
    assert detail["video_path"] == job["video_path"]


def test_process_jobs_run_serially_not_concurrently(client, monkeypatch):
    import threading
    import time as time_module

    monkeypatch.setattr(server_module, "llava_complete", None)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    active = {"count": 0}
    max_concurrent = {"value": 0}
    lock = threading.Lock()

    def slow_stop_recording_and_transcribe(**kwargs):
        with lock:
            active["count"] += 1
            max_concurrent["value"] = max(max_concurrent["value"], active["count"])
        time_module.sleep(0.1)
        with lock:
            active["count"] -= 1
        return None, []

    monkeypatch.setattr(
        server_module, "stop_recording_and_transcribe", slow_stop_recording_and_transcribe
    )

    job_ids = []
    for _ in range(3):
        resp = client.post(
            "/process",
            files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
        )
        assert resp.status_code == 202
        job_ids.append(resp.json()["job_id"])

    # Generous on purpose: this test measures concurrency, not speed, and
    # under a fully parallel test-suite run (many other tests' threads/
    # processes contending for CPU) the background worker thread processing
    # these jobs has been observed needing close to the old 5s budget on
    # its own -- flaking under load despite the serial pipeline itself only
    # taking ~0.3s of deliberate sleep(0.1) time.
    for job_id in job_ids:
        wait_for_job(client, job_id, timeout=15.0)

    assert max_concurrent["value"] == 1


def test_get_settings_returns_current_values_and_choices(client: TestClient):
    resp = client.get("/settings")
    assert resp.status_code == 200
    body = resp.json()
    assert "whisper_model" in body
    assert "storage_dir" in body
    assert "ollama_chat_model" in body
    assert "custom_vocabulary" in body
    values = {c["value"] for c in body["whisper_model_choices"]}
    assert values == {"tiny.en", "base.en", "small.en", "medium.en"}


def test_patch_settings_updates_custom_vocabulary(client: TestClient):
    resp = client.patch("/settings", json={"custom_vocabulary": "Kestrel, SSOT"})
    assert resp.status_code == 200
    assert resp.json()["custom_vocabulary"] == "Kestrel, SSOT"

    import app.server as server_module
    assert server_module.CUSTOM_VOCABULARY == "Kestrel, SSOT"

    # Reflected on a subsequent GET too.
    resp2 = client.get("/settings")
    assert resp2.json()["custom_vocabulary"] == "Kestrel, SSOT"


def test_patch_settings_updates_whisper_model(client: TestClient):
    resp = client.patch("/settings", json={"whisper_model": "small.en"})
    assert resp.status_code == 200
    assert resp.json()["whisper_model"] == "small.en"

    import app.server as server_module
    assert server_module.WHISPER_MODEL == "small.en"

    # Reflected on a subsequent GET too.
    resp2 = client.get("/settings")
    assert resp2.json()["whisper_model"] == "small.en"


def test_patch_settings_rejects_invalid_whisper_model(client: TestClient):
    resp = client.patch("/settings", json={"whisper_model": "not-a-real-model"})
    assert resp.status_code == 400


def test_patch_settings_updates_ollama_chat_model(client: TestClient):
    resp = client.patch("/settings", json={"ollama_chat_model": "llama3.1:8b"})
    assert resp.status_code == 200
    assert resp.json()["ollama_chat_model"] == "llama3.1:8b"

    import app.server as server_module
    assert server_module.OLLAMA_CHAT_MODEL == "llama3.1:8b"


def test_patch_settings_moves_storage_dir(client: TestClient, tmp_path):
    import app.server as server_module
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc123",
        "created_at": "2026-08-03T00:00:00+00:00",
        "title": "Test Meeting",
        "notes": "notes",
        "video_path": "x",
    })

    # Use a sibling directory, not one nested inside STORE (== tmp_path here):
    # move_storage_dir now refuses destinations nested inside the current
    # storage dir, so this must be a genuine sibling to exercise a real move.
    new_dir = tmp_path.parent / f"{tmp_path.name}-new-storage"
    resp = client.patch("/settings", json={"storage_dir": str(new_dir)})
    assert resp.status_code == 200
    assert resp.json()["storage_dir"] == str(new_dir)

    assert server_module.STORE == new_dir
    assert (new_dir / "sessions_index.json").exists()

    # Subsequent /sessions reads from the new location.
    sessions = client.get("/sessions").json()
    assert len(sessions) == 1
    assert sessions[0]["id"] == "abc123"


def test_process_rejects_with_503_while_a_storage_move_is_in_progress(
    client: TestClient, tmp_path, monkeypatch
):
    """Regression test for G6.3 (storage-move TOCTOU): jobs.is_busy() only
    blocks a move while a job already exists -- it says nothing about a
    fresh POST /process arriving DURING the move itself, before any job has
    been created. Without move_in_progress, that request would write into
    the storage dir mid-move (a partial move, or a session indexed with
    paths that no longer exist once the move finishes).
    """
    import app.server as server_module

    new_dir = tmp_path.parent / f"{tmp_path.name}-new-storage"
    captured = {}

    def fake_move_storage_dir(old_dir, new_dir_arg):
        assert server_module.move_in_progress is True
        # A /process request arriving mid-move, from the exact same server
        # process -- proves the flag is actually checked and enforced.
        resp = client.post("/process")
        captured["status"] = resp.status_code
        new_dir_arg.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(server_module, "move_storage_dir", fake_move_storage_dir)

    resp = client.patch("/settings", json={"storage_dir": str(new_dir)})

    assert resp.status_code == 200
    assert captured["status"] == 503
    assert server_module.move_in_progress is False  # cleared once the move finishes


def test_process_succeeds_once_a_storage_move_has_finished(client: TestClient):
    import app.server as server_module

    assert server_module.move_in_progress is False
    resp = client.post("/process")  # no screen upload -> 400, not 503
    assert resp.status_code == 400


def test_patch_settings_rejects_storage_move_while_a_job_is_busy(client: TestClient, tmp_path):
    """Regression test for brief 10: moving the storage dir mid-job can
    PermissionError on Windows (open file handles) or split the session
    index across old/new dirs. jobs.is_busy() must lock this out with 409
    instead of letting move_storage_dir race the worker.
    """
    import app.server as server_module
    from app import jobs

    job_id = jobs.create_job(session_id="busy-job", inputs={})
    try:
        new_dir = tmp_path.parent / f"{tmp_path.name}-new-storage"
        original_store = server_module.STORE

        resp = client.patch("/settings", json={"storage_dir": str(new_dir)})

        assert resp.status_code == 409
        assert server_module.STORE == original_store
        assert not new_dir.exists()
    finally:
        jobs.update_job(job_id, status="done")


def test_patch_settings_rejects_storage_move_while_graph_indexing_is_busy(client: TestClient, tmp_path, monkeypatch):
    """The graph indexing worker (graph_jobs._loop) writes knowledge_graph.json
    into the store dir over a 30-90s Ollama call, the same way jobs.py's
    worker writes session files -- a storage move mid-extraction can write
    into a dir that's mid-move or already abandoned by the move. Regression
    test mirroring test_patch_settings_rejects_storage_move_while_a_job_is_busy.
    """
    import app.server as server_module
    from app import graph_jobs

    if server_module.graph_jobs is None:
        pytest.skip("graph_jobs feature not available in this build")

    monkeypatch.setattr(graph_jobs, "is_busy", lambda: True)

    new_dir = tmp_path.parent / f"{tmp_path.name}-new-storage"
    original_store = server_module.STORE

    resp = client.patch("/settings", json={"storage_dir": str(new_dir)})

    assert resp.status_code == 409
    assert server_module.STORE == original_store
    assert not new_dir.exists()


def test_patch_settings_allows_storage_move_once_jobs_are_terminal(client: TestClient, tmp_path):
    import app.server as server_module
    from app import jobs

    job_id = jobs.create_job(session_id="finished-job", inputs={})
    jobs.update_job(job_id, status="done")

    new_dir = tmp_path.parent / f"{tmp_path.name}-new-storage-2"
    resp = client.patch("/settings", json={"storage_dir": str(new_dir)})

    assert resp.status_code == 200
    assert server_module.STORE == new_dir


def test_get_settings_reads_live_globals_not_disk_after_settings_file_deleted(client: TestClient):
    import app.server as server_module

    # Cause settings.json to be created via a request. GET /settings itself
    # no longer touches disk (that's the fix under test), so use a PATCH,
    # which still writes through save_settings.
    client.patch("/settings", json={"whisper_model": "base.en"})
    assert server_module.SETTINGS_PATH.exists()

    # Push the live globals to non-default values, then delete settings.json
    # out from under the running server -- simulating it being deleted or
    # corrupted while the server is up.
    server_module.WHISPER_MODEL = "small.en"
    server_module.OLLAMA_CHAT_MODEL = "llama3.1:8b"
    live_store = server_module.STORE
    server_module.SETTINGS_PATH.unlink()

    resp = client.get("/settings")
    assert resp.status_code == 200
    body = resp.json()

    # Must reflect the live in-memory globals, not re-seeded defaults from a
    # fresh load_or_init() disk read (which would reset storage_dir back to
    # ROOT/"uploads" and whisper_model/ollama_chat_model to their env-var
    # defaults).
    assert body["whisper_model"] == "small.en"
    assert body["ollama_chat_model"] == "llama3.1:8b"
    assert body["storage_dir"] == str(live_store)


def test_patch_settings_rejects_relative_storage_dir(client: TestClient):
    import app.server as server_module

    original_store = server_module.STORE
    resp = client.patch("/settings", json={"storage_dir": "relative/path"})
    assert resp.status_code == 400
    assert server_module.STORE == original_store


def test_patch_settings_storage_dir_refuses_non_empty_destination(client: TestClient, tmp_path):
    import app.server as server_module

    new_dir = tmp_path / "occupied"
    new_dir.mkdir()
    (new_dir / "leftover.txt").write_text("x", encoding="utf-8")

    original_store = server_module.STORE
    resp = client.patch("/settings", json={"storage_dir": str(new_dir)})
    assert resp.status_code == 400
    assert server_module.STORE == original_store


def test_patch_settings_holds_save_lock_during_storage_move(client, tmp_path, monkeypatch):
    """
    Regression test for the storage-move race: while a PATCH /settings
    request that changes storage_dir is inside move_storage_dir, SAVE_LOCK
    must still be held so a second concurrent PATCH can't start its own
    move against the same source directory.
    """
    import threading
    from app import settings_store

    new_dir = tmp_path / "moved"
    original_move = server_module.move_storage_dir
    entered = threading.Event()
    proceed = threading.Event()

    def slow_move(old, new):
        entered.set()
        proceed.wait(timeout=2)
        return original_move(old, new)

    monkeypatch.setattr(server_module, "move_storage_dir", slow_move)

    def do_patch():
        client.patch("/settings", json={"storage_dir": str(new_dir)})

    t = threading.Thread(target=do_patch)
    t.start()
    assert entered.wait(timeout=2), "move_storage_dir was not entered"

    # While the request thread is inside move_storage_dir, a non-blocking
    # acquire of SAVE_LOCK from this thread must fail -- proving the lock
    # is held for the whole move, not just the later save() call.
    lock_free = settings_store.SAVE_LOCK.acquire(blocking=False)
    if lock_free:
        settings_store.SAVE_LOCK.release()

    proceed.set()
    t.join(timeout=2)

    assert lock_free is False


def test_patch_settings_survives_a_failed_settings_save_after_a_real_move(
    client: TestClient, tmp_path, monkeypatch
):
    """Regression test for Fix 3A: if save_settings() raises after a real
    move_storage_dir has already relocated the files, the server must keep
    reading the NEW directory (not split-brain back to the old, now-emptied
    one) and report a loud 500 rather than silently losing track of the move.
    """
    import app.server as server_module
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc123",
        "created_at": "2026-08-03T00:00:00+00:00",
        "title": "Test Meeting",
        "notes": "notes",
        "video_path": "x",
    })

    new_dir = tmp_path.parent / f"{tmp_path.name}-new-storage"

    def failing_save_settings(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(server_module, "save_settings", failing_save_settings)

    resp = client.patch("/settings", json={"storage_dir": str(new_dir)})

    assert resp.status_code == 500
    assert str(new_dir) in resp.json()["detail"]

    # The live STORE must already point at new_dir -- the move itself
    # succeeded, only the settings.json write failed.
    assert server_module.STORE == new_dir

    # GET /sessions must read the moved data, not report the old dir as
    # empty.
    sessions = client.get("/sessions").json()
    assert len(sessions) == 1
    assert sessions[0]["id"] == "abc123"


def test_patch_settings_rewrites_video_path_after_a_storage_move(
    client: TestClient, tmp_path
):
    """Regression test for Fix 3E: absolute video_path values recorded
    before a storage move must be rewritten to point under the new root,
    or job-detail/session lookups resolve to a file that no longer exists
    there.
    """
    import app.server as server_module
    from app.sessions_store import append_session

    old_store = server_module.STORE
    video_path = str(old_store / "abc123" / "final.webm")
    append_session(old_store, {
        "id": "abc123",
        "created_at": "2026-08-03T00:00:00+00:00",
        "title": "Test Meeting",
        "notes": "notes",
        "video_path": video_path,
    })

    new_dir = tmp_path.parent / f"{tmp_path.name}-new-storage"
    resp = client.patch("/settings", json={"storage_dir": str(new_dir)})
    assert resp.status_code == 200

    sessions = client.get("/sessions").json()
    assert len(sessions) == 1
    assert sessions[0]["video_path"] == str(new_dir / "abc123" / "final.webm")


def test_process_upload_blocks_a_concurrent_storage_move_until_it_finishes(
    client: TestClient, tmp_path, monkeypatch
):
    """Regression test for Fix 3C: jobs.is_busy() only blocks a move once a
    job has been created, which happens only AFTER the (potentially
    minutes-long) upload finishes writing. A PATCH /settings arriving while
    an upload is still mid-write must be rejected with 409, and the
    in-flight upload must complete into the ORIGINAL directory rather than
    racing a move.
    """
    import threading
    import app.server as server_module

    upload_entered = threading.Event()
    release_upload = threading.Event()
    original_store = server_module.STORE

    def blocking_save_upload(dst_dir, uf, name):
        upload_entered.set()
        assert release_upload.wait(timeout=10), "test stalled waiting to release the upload"
        return None  # invalid screen upload -> /process eventually 400s

    monkeypatch.setattr(server_module, "save_upload", blocking_save_upload)

    results = {}

    def do_upload():
        results["response"] = client.post(
            "/process",
            files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
        )

    upload_thread = threading.Thread(target=do_upload)
    upload_thread.start()
    try:
        assert upload_entered.wait(timeout=5), "/process never reached save_upload"

        new_dir = tmp_path.parent / f"{tmp_path.name}-new-storage"
        move_resp = client.patch("/settings", json={"storage_dir": str(new_dir)})
        assert move_resp.status_code == 409
        assert server_module.STORE == original_store
        assert not new_dir.exists()
    finally:
        release_upload.set()
        upload_thread.join(timeout=10)

    assert results["response"].status_code == 400

    # Now that the upload has finished, the move must succeed.
    new_dir2 = tmp_path.parent / f"{tmp_path.name}-new-storage-2"
    resp = client.patch("/settings", json={"storage_dir": str(new_dir2)})
    assert resp.status_code == 200
    assert server_module.STORE == new_dir2


def test_ollama_models_returns_installed_models(client: TestClient, monkeypatch):
    monkeypatch.setattr(
        server_module.ollama_health_client,
        "list",
        lambda: {"models": [{"model": "llama3.1:8b"}, {"model": "llava:7b-v1.5-q4_K_M"}]},
    )

    resp = client.get("/ollama/models")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["models"] == ["llama3.1:8b", "llava:7b-v1.5-q4_K_M"]


def test_ollama_models_reports_unreachable(client: TestClient, monkeypatch):
    def raise_connection_error():
        raise ConnectionError("connection refused")

    monkeypatch.setattr(server_module.ollama_health_client, "list", raise_connection_error)

    resp = client.get("/ollama/models")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert body["models"] == []
    assert "connection refused" in body["error"]


def test_ollama_models_uses_the_shared_timeout_protected_health_client():
    """Regression test: /ollama/models used to build a brand-new
    ollama.Client(host=...) per request with no timeout at all, so a wedged
    Ollama could hang this endpoint (and slowly drain the threadpool) exactly
    like the /health and chat bugs this whole timeout effort fixed. It must
    reuse chat.py's health client (which has a short, fixed timeout) instead
    of constructing its own.
    """
    import app.chat as chat_module

    assert server_module.ollama_health_client is chat_module._health_client


def test_ollama_models_reports_read_timeout_without_hanging(client: TestClient, monkeypatch):
    def raise_timeout():
        raise httpx.ReadTimeout("timed out waiting for Ollama")

    monkeypatch.setattr(server_module.ollama_health_client, "list", raise_timeout)

    resp = client.get("/ollama/models")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert body["models"] == []
    assert "timed out" in body["error"]


def test_process_uses_configured_whisper_model_via_transcribe_helper(client, monkeypatch):
    import app.server as server_module

    server_module.WHISPER_MODEL = "small.en"

    captured = {}

    def fake_stop_recording_and_transcribe(**kwargs):
        captured["model_name"] = kwargs.get("model_name")
        return None, []

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe)
    monkeypatch.setattr(server_module, "llava_complete", None)
    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    # This test exercises the real (unmocked) faster_whisper fallback path
    # (stop_recording_and_transcribe returns no txt_path and llava_complete
    # is None), so the job has to actually construct a real WhisperModel --
    # on this machine that cold load consistently takes >2s, well past
    # wait_for_job's default timeout. Give it more headroom rather than
    # flaking; the point of this test is the model name plumbing, not timing.
    wait_for_job(client, resp.json()["job_id"], timeout=30.0)
    assert captured["model_name"] == "small.en"


def test_process_passes_custom_vocabulary_as_initial_prompt(client, monkeypatch):
    import app.server as server_module

    server_module.CUSTOM_VOCABULARY = "Kestrel, SSOT, Xiomara"

    captured = {}

    def fake_stop_recording_and_transcribe(**kwargs):
        captured["initial_prompt"] = kwargs.get("initial_prompt")
        return None, []

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe)
    monkeypatch.setattr(server_module, "llava_complete", None)
    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    wait_for_job(client, resp.json()["job_id"], timeout=30.0)
    assert captured["initial_prompt"] == "Kestrel, SSOT, Xiomara"


def test_process_empty_custom_vocabulary_passes_none_as_initial_prompt(client, monkeypatch):
    import app.server as server_module

    server_module.CUSTOM_VOCABULARY = ""

    captured = {}

    def fake_stop_recording_and_transcribe(**kwargs):
        captured["initial_prompt"] = kwargs.get("initial_prompt")
        return None, []

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe)
    monkeypatch.setattr(server_module, "llava_complete", None)
    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    wait_for_job(client, resp.json()["job_id"], timeout=30.0)
    assert captured["initial_prompt"] is None


def test_process_fallback_whisper_uses_configured_model(client, monkeypatch):
    import sys
    import types
    import app.server as server_module

    server_module.WHISPER_MODEL = "medium.en"

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", None)
    monkeypatch.setattr(server_module, "llava_complete", None)
    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    captured = {}

    class FakeSegment:
        text = "hi"

    class FakeWhisperModel:
        def __init__(self, model_name, device=None, compute_type=None):
            captured["model_name"] = model_name

        def transcribe(self, path, beam_size=1, **kwargs):
            return [FakeSegment()], object()

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    wait_for_job(client, resp.json()["job_id"])
    assert captured["model_name"] == "medium.en"


def test_process_fallback_whisper_passes_custom_vocabulary_as_initial_prompt(client, monkeypatch):
    import sys
    import types
    import app.server as server_module

    server_module.CUSTOM_VOCABULARY = "Kestrel, SSOT, Xiomara"

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", None)
    monkeypatch.setattr(server_module, "llava_complete", None)
    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    captured = {}

    class FakeSegment:
        text = "hi"

    class FakeWhisperModel:
        def __init__(self, model_name, device=None, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1, **kwargs):
            captured["initial_prompt"] = kwargs.get("initial_prompt")
            return [FakeSegment()], object()

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    wait_for_job(client, resp.json()["job_id"])
    assert captured["initial_prompt"] == "Kestrel, SSOT, Xiomara"


def test_process_whitespace_only_custom_vocabulary_passes_none_as_initial_prompt(client, monkeypatch):
    import app.server as server_module

    server_module.CUSTOM_VOCABULARY = "   \n"
    # Reset WHISPER_MODEL -- a preceding test may have left it set to
    # "medium.en" (used with a mocked faster_whisper module there), and if
    # that leaked here it would make the real fallback whisper path (which
    # this test can hit, since the primary path returns no txt_path) try to
    # actually download an uncached model instead of using a cached one.
    server_module.WHISPER_MODEL = "small.en"

    captured = {}

    def fake_stop_recording_and_transcribe(**kwargs):
        captured["initial_prompt"] = kwargs.get("initial_prompt")
        return None, []

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe)
    monkeypatch.setattr(server_module, "llava_complete", None)
    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    wait_for_job(client, resp.json()["job_id"], timeout=30.0)
    assert captured["initial_prompt"] is None


def test_sessions_excludes_trashed_by_default(client: TestClient):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "active1", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "Active", "notes": "", "video_path": "", "trashed_at": None,
    })
    append_session(server_module.STORE, {
        "id": "trashed1", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "Trashed", "notes": "", "video_path": "", "trashed_at": "2026-08-02T00:00:00+00:00",
    })

    resp = client.get("/sessions")
    assert resp.status_code == 200
    ids = {s["id"] for s in resp.json()}
    assert ids == {"active1"}


def test_sessions_include_trashed_query_param_returns_all(client: TestClient):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "active1", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "Active", "notes": "", "video_path": "", "trashed_at": None,
    })
    append_session(server_module.STORE, {
        "id": "trashed1", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "Trashed", "notes": "", "video_path": "", "trashed_at": "2026-08-02T00:00:00+00:00",
    })

    resp = client.get("/sessions?include_trashed=true")
    assert resp.status_code == 200
    ids = {s["id"] for s in resp.json()}
    assert ids == {"active1", "trashed1"}


def test_rename_session_updates_title(client: TestClient):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "Old", "notes": "", "video_path": "", "trashed_at": None,
    })

    resp = client.patch("/sessions/abc", json={"title": "New Title"})
    assert resp.status_code == 200
    assert resp.json()["title"] == "New Title"

    sessions = client.get("/sessions").json()
    assert sessions[0]["title"] == "New Title"


def test_rename_session_rejects_empty_title(client: TestClient):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "Old", "notes": "", "video_path": "", "trashed_at": None,
    })

    resp = client.patch("/sessions/abc", json={"title": "   "})
    assert resp.status_code == 400


def test_rename_session_404_for_unknown_id(client: TestClient):
    resp = client.patch("/sessions/does-not-exist", json={"title": "New"})
    assert resp.status_code == 404


def test_rename_session_returns_404_instead_of_500_when_a_concurrent_delete_races_the_update(
    client: TestClient, monkeypatch
):
    """
    Regression test for brief 13 #8: a concurrent DELETE landing between
    update_session_fields() succeeding and the endpoint's own re-read used
    to IndexError on matching[0] -> 500, instead of the 404 a request that
    arrived slightly later would get.
    """
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "Old", "notes": "", "video_path": "", "trashed_at": None,
    })

    # update_session_fields() itself still reads/writes the real store (it
    # calls sessions_store.load_sessions directly, not through this
    # binding) -- only the endpoint's OWN post-update re-read is patched to
    # simulate a session that's just been deleted out from under it.
    monkeypatch.setattr(server_module, "load_sessions", lambda store: [])

    resp = client.patch("/sessions/abc", json={"title": "New Title"})
    assert resp.status_code == 404


def test_trash_session_sets_trashed_at(client: TestClient):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "T", "notes": "", "video_path": "", "trashed_at": None,
    })

    resp = client.post("/sessions/abc/trash")
    assert resp.status_code == 200
    assert resp.json()["trashed_at"] is not None

    active = client.get("/sessions").json()
    assert active == []


def test_trash_session_is_idempotent_and_does_not_reset_timestamp(client: TestClient):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "T", "notes": "", "video_path": "", "trashed_at": None,
    })

    first = client.post("/sessions/abc/trash").json()
    second = client.post("/sessions/abc/trash").json()

    assert first["trashed_at"] == second["trashed_at"]


def test_trash_session_404_for_unknown_id(client: TestClient):
    resp = client.post("/sessions/does-not-exist/trash")
    assert resp.status_code == 404


def test_trash_session_returns_404_instead_of_500_when_a_concurrent_delete_races_the_update(
    client: TestClient, monkeypatch
):
    """Regression test for brief 13 #8 (see the analogous rename test)."""
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "T", "notes": "", "video_path": "", "trashed_at": None,
    })

    real_load_sessions = server_module.load_sessions
    call_count = {"n": 0}

    def racy_load_sessions(store):
        call_count["n"] += 1
        # First call is the endpoint's own pre-update existence check --
        # must still find the real session. Every call after that
        # simulates a concurrent DELETE having already landed.
        if call_count["n"] == 1:
            return real_load_sessions(store)
        return []

    monkeypatch.setattr(server_module, "load_sessions", racy_load_sessions)

    resp = client.post("/sessions/abc/trash")
    assert resp.status_code == 404


def test_restore_session_clears_trashed_at(client: TestClient):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "T", "notes": "", "video_path": "", "trashed_at": "2026-08-02T00:00:00+00:00",
    })

    resp = client.post("/sessions/abc/restore")
    assert resp.status_code == 200
    assert resp.json()["trashed_at"] is None

    active = client.get("/sessions").json()
    assert len(active) == 1
    assert active[0]["id"] == "abc"


def test_restore_session_404_for_unknown_id(client: TestClient):
    resp = client.post("/sessions/does-not-exist/restore")
    assert resp.status_code == 404


def test_restore_session_returns_404_instead_of_500_when_a_concurrent_delete_races_the_update(
    client: TestClient, monkeypatch
):
    """Regression test for brief 13 #8 (see the analogous rename test)."""
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "T", "notes": "", "video_path": "", "trashed_at": "2026-08-02T00:00:00+00:00",
    })

    monkeypatch.setattr(server_module, "load_sessions", lambda store: [])

    resp = client.post("/sessions/abc/restore")
    assert resp.status_code == 404


def test_delete_session_removes_record_and_folder(client: TestClient):
    from app.sessions_store import append_session

    session_dir = server_module.STORE / "abc"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"video")

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "T", "notes": "", "video_path": str(session_dir / "final.webm"), "trashed_at": None,
    })

    resp = client.delete("/sessions/abc")
    assert resp.status_code == 200

    assert client.get("/sessions?include_trashed=true").json() == []
    assert not session_dir.exists()


def test_delete_session_404_for_unknown_id(client: TestClient):
    resp = client.delete("/sessions/does-not-exist")
    assert resp.status_code == 404


def test_delete_session_works_on_a_trashed_session(client: TestClient):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "T", "notes": "", "video_path": "", "trashed_at": "2026-08-02T00:00:00+00:00",
    })

    resp = client.delete("/sessions/abc")
    assert resp.status_code == 200
    assert client.get("/sessions?include_trashed=true").json() == []


def test_purge_expired_trash_wired_to_live_store(client: TestClient):
    from datetime import datetime, timedelta, timezone
    from app.sessions_store import append_session

    old_ts = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
    append_session(server_module.STORE, {
        "id": "old", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "Old", "notes": "", "video_path": "", "trashed_at": old_ts,
    })

    purged = server_module.purge_expired_trash(server_module.STORE)

    assert purged == 1
    assert server_module.load_sessions(server_module.STORE) == []


def test_sweep_orphaned_sessions_wired_to_live_store(client: TestClient):
    orphan_id = "c" * 32
    orphan_dir = server_module.STORE / orphan_id
    orphan_dir.mkdir()
    (orphan_dir / "final.webm").write_bytes(b"video bytes")

    result = server_module.sweep_orphaned_sessions(server_module.STORE)

    assert result == {"adopted": [orphan_id], "deleted": []}
    matching = [s for s in server_module.load_sessions(server_module.STORE) if s["id"] == orphan_id]
    assert len(matching) == 1
    assert matching[0]["status"] == "recovered"


def test_chat_uses_configured_ollama_model(client: TestClient, monkeypatch):
    from app.sessions_store import append_session
    import app.server as server_module

    server_module.OLLAMA_CHAT_MODEL = "llama3.1:8b"

    append_session(server_module.STORE, {
        "id": "abc123",
        "created_at": "2026-08-03T00:00:00+00:00",
        "title": "Test Meeting",
        "notes": "notes",
        "video_path": "x",
    })

    captured = {}

    def fake_stream_chat_reply(notes, message, history, **kwargs):
        captured["model"] = kwargs.get("model")
        yield "ok"

    monkeypatch.setattr(server_module, "assert_ollama_up", lambda: None)
    monkeypatch.setattr(server_module, "stream_chat_reply", fake_stream_chat_reply)

    resp = client.post("/chat/abc123", json={"message": "hi", "history": []})
    assert resp.status_code == 200
    assert captured["model"] == "llama3.1:8b"


def test_export_notes_returns_markdown_attachment(client: TestClient):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "Sprint Planning", "notes": "# Sprint Planning\n- point one",
        "video_path": "", "trashed_at": None,
    })

    resp = client.get("/sessions/abc/export/notes")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/markdown")
    assert "attachment" in resp.headers["content-disposition"]
    assert "sprint-planning" in resp.headers["content-disposition"].lower()
    assert resp.text == "# Sprint Planning\n- point one"


def test_export_notes_404_for_unknown_id(client: TestClient):
    resp = client.get("/sessions/does-not-exist/export/notes")
    assert resp.status_code == 404


def test_export_zip_contains_final_webm_and_notes(client: TestClient):
    import zipfile
    import io as io_module
    from app.sessions_store import append_session

    session_dir = server_module.STORE / "abc"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"fake video bytes")
    (session_dir / "transcript_1.txt").write_text("hello", encoding="utf-8")

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "My Meeting", "notes": "# notes here",
        "video_path": str(session_dir / "final.webm"), "trashed_at": None,
    })

    resp = client.get("/sessions/abc/export/zip")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    assert "attachment" in resp.headers["content-disposition"]
    assert "my-meeting" in resp.headers["content-disposition"].lower()

    zf = zipfile.ZipFile(io_module.BytesIO(resp.content))
    names = set(zf.namelist())
    assert "final.webm" in names
    assert "notes.md" in names
    assert "transcript_1.txt" in names
    assert zf.read("notes.md").decode("utf-8") == "# notes here"


def test_export_zip_contains_final_mp4_when_muxed_with_aac_fallback(client: TestClient):
    """Regression test for batch 04, fix 4B: mux_video_audio names its output
    final.mp4 on an aac-only ffmpeg. The export endpoint used to look only for
    the literal final.webm, silently producing a recording-less zip."""
    import zipfile
    import io as io_module
    from app.sessions_store import append_session

    session_dir = server_module.STORE / "abc"
    session_dir.mkdir()
    (session_dir / "final.mp4").write_bytes(b"fake mp4 bytes")

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "My Meeting", "notes": "# notes here",
        "video_path": str(session_dir / "final.mp4"), "trashed_at": None,
    })

    resp = client.get("/sessions/abc/export/zip")
    assert resp.status_code == 200

    zf = zipfile.ZipFile(io_module.BytesIO(resp.content))
    names = set(zf.namelist())
    assert "final.mp4" in names
    assert zf.read("final.mp4") == b"fake mp4 bytes"


def test_export_zip_streams_a_large_file_from_disk_without_buffering_it_whole(client: TestClient):
    """Regression test for brief 07: the export endpoint used to build the
    whole archive in an io.BytesIO and then copy it again via getvalue(),
    peaking at ~2x archive size in memory. It must now build the zip on disk
    (tempfile) and return it via FileResponse, and clean up the temp file
    once the response has been sent.
    """
    import zipfile
    import io as io_module
    from app.sessions_store import append_session

    session_dir = server_module.STORE / "abc"
    session_dir.mkdir()
    # 50 MB of zeros -- large enough that the old buffer.getvalue() double-copy
    # would be a meaningfully wasteful allocation, small enough to keep the
    # test fast.
    large_video = b"\x00" * (50 * 1024 * 1024)
    (session_dir / "final.webm").write_bytes(large_video)
    (session_dir / "transcript_1.txt").write_text("hello", encoding="utf-8")

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "Big Meeting", "notes": "# notes here",
        "video_path": str(session_dir / "final.webm"), "trashed_at": None,
    })

    tmp_paths_used = []
    real_named_temp_file = tempfile.NamedTemporaryFile

    def spying_named_temp_file(*args, **kwargs):
        f = real_named_temp_file(*args, **kwargs)
        tmp_paths_used.append(f.name)
        return f

    with mock.patch("app.server.tempfile.NamedTemporaryFile", side_effect=spying_named_temp_file):
        resp = client.get("/sessions/abc/export/zip")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    assert "big-meeting" in resp.headers["content-disposition"].lower()

    zf = zipfile.ZipFile(io_module.BytesIO(resp.content))
    names = set(zf.namelist())
    assert "final.webm" in names
    assert "notes.md" in names
    assert "transcript_1.txt" in names
    assert zf.read("final.webm") == large_video

    # The temp file used to build the archive must be cleaned up by the
    # BackgroundTask after the response was sent, not left behind.
    assert len(tmp_paths_used) == 1
    assert not Path(tmp_paths_used[0]).exists()


def test_export_zip_cleans_up_temp_file_when_build_fails(client: TestClient, monkeypatch):
    """Regression test for G6.4: the temp zip used to only get cleaned up
    by the BackgroundTask attached to a successfully-returned response --
    a failure while BUILDING the zip left it behind in the OS temp dir
    forever, since the response (and its BackgroundTask) never gets
    returned in that case.
    """
    from app.sessions_store import append_session

    session_dir = server_module.STORE / "abc"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"fake video bytes")
    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "My Meeting", "notes": "notes",
        "video_path": str(session_dir / "final.webm"), "trashed_at": None,
    })

    tmp_paths_used = []
    real_named_temp_file = tempfile.NamedTemporaryFile

    def spying_named_temp_file(*args, **kwargs):
        f = real_named_temp_file(*args, **kwargs)
        tmp_paths_used.append(f.name)
        return f

    monkeypatch.setattr("app.server.tempfile.NamedTemporaryFile", spying_named_temp_file)
    monkeypatch.setattr(
        "app.server.zipfile.ZipFile",
        mock.Mock(side_effect=RuntimeError("simulated failure building the zip")),
    )

    with pytest.raises(RuntimeError, match="simulated failure"):
        client.get("/sessions/abc/export/zip")

    assert len(tmp_paths_used) == 1
    assert not Path(tmp_paths_used[0]).exists()


def test_export_zip_uses_the_distinguishing_temp_prefix(client: TestClient):
    """_sweep_stale_export_zips only ever targets files with this prefix --
    if export_session_zip stopped using it, that sweep would silently stop
    covering real leaks.
    """
    from app.sessions_store import append_session

    session_dir = server_module.STORE / "abc"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"fake video bytes")
    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "My Meeting", "notes": "notes",
        "video_path": str(session_dir / "final.webm"), "trashed_at": None,
    })

    tmp_paths_used = []
    real_named_temp_file = tempfile.NamedTemporaryFile

    def spying_named_temp_file(*args, **kwargs):
        f = real_named_temp_file(*args, **kwargs)
        tmp_paths_used.append(f.name)
        return f

    with mock.patch("app.server.tempfile.NamedTemporaryFile", side_effect=spying_named_temp_file):
        resp = client.get("/sessions/abc/export/zip")

    assert resp.status_code == 200
    assert len(tmp_paths_used) == 1
    assert Path(tmp_paths_used[0]).name.startswith(server_module.EXPORT_TEMP_PREFIX)


def test_sweep_stale_export_zips_removes_old_but_not_recent_files(tmp_path, monkeypatch):
    monkeypatch.setattr("app.server.tempfile.gettempdir", lambda: str(tmp_path))

    old_time = time.time() - 7200

    stale = tmp_path / f"{server_module.EXPORT_TEMP_PREFIX}abc123.zip"
    stale.write_bytes(b"leaked zip")
    os.utime(stale, (old_time, old_time))

    fresh = tmp_path / f"{server_module.EXPORT_TEMP_PREFIX}def456.zip"
    fresh.write_bytes(b"download in progress")

    unrelated = tmp_path / "some-other-apps-file.zip"
    unrelated.write_bytes(b"not ours")
    os.utime(unrelated, (old_time, old_time))

    server_module._sweep_stale_export_zips(max_age_seconds=3600)

    assert not stale.exists()
    assert fresh.exists()  # not old enough -- could still be downloading
    assert unrelated.exists()  # never touch files outside our own prefix


def test_export_zip_404_for_unknown_id(client: TestClient):
    resp = client.get("/sessions/does-not-exist/export/zip")
    assert resp.status_code == 404


def test_export_zip_rejects_path_traversal_session_id(client: TestClient):
    """
    Regression test: session_id must be validated as a plain hex id before
    it's used to build a filesystem path, as defense-in-depth even though
    the sessions_index.json lookup already gates unknown ids today.
    """
    resp = client.get("/sessions/%2e%2e/export/zip")
    assert resp.status_code == 400


def test_export_zip_404_when_session_folder_missing(client: TestClient):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "T", "notes": "notes", "video_path": "", "trashed_at": None,
    })
    # No folder created on disk for "abc".

    resp = client.get("/sessions/abc/export/zip")
    assert resp.status_code == 404


def test_storage_usage_returns_counts_and_bytes(client: TestClient):
    from app.sessions_store import append_session

    session_dir = server_module.STORE / "abc"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"x" * 100)

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "T", "notes": "", "video_path": "", "trashed_at": None,
    })

    resp = client.get("/storage/usage")
    assert resp.status_code == 200
    body = resp.json()
    assert body["session_count"] == 1
    assert body["trashed_count"] == 0
    assert body["used_bytes"] >= 100
    assert body["free_bytes"] > 0
    assert body["total_bytes"] > 0


# ---------- graph chat ----------

def _seed_session(sid, title, notes="notes", created_at="2026-08-01T10:00:00+00:00"):
    from app.sessions_store import append_session
    append_session(server_module.STORE, {
        "id": sid, "created_at": created_at, "title": title, "notes": notes,
        "video_path": "", "trashed_at": None, "status": "done",
    })


def test_graph_chat_streams_sources_line_then_tokens(client, monkeypatch):
    _seed_session("m1", "Kickoff")
    monkeypatch.setattr(server_module, "find_relevant_sessions", lambda store, q, max_sessions=5: ["m1"])
    monkeypatch.setattr(server_module, "build_context", lambda store, sids: "CTX")

    captured = {}

    def fake_stream(context, message, history, model=None):
        captured["context"] = context
        captured["message"] = message
        captured["history"] = history
        yield "Hello "
        yield "there."

    monkeypatch.setattr(server_module, "stream_graph_chat_reply", fake_stream)

    resp = client.post("/graph/chat", json={
        "message": "what happened?",
        "history": [{"role": "user", "content": "q1"}, {"role": "assistant", "content": "a1"}],
    })
    assert resp.status_code == 200
    lines = [json.loads(line) for line in resp.text.strip().splitlines()]
    assert lines[0] == {"sources": [{"id": "m1", "title": "Kickoff", "created_at": "2026-08-01T10:00:00+00:00"}]}
    assert "".join(line.get("token", "") for line in lines[1:]) == "Hello there."
    assert captured["context"] == "CTX"
    assert captured["message"] == "what happened?"
    assert captured["history"] == [{"role": "user", "content": "q1"}, {"role": "assistant", "content": "a1"}]


def test_graph_chat_returns_503_when_ollama_down(client, monkeypatch):
    def raise_down():
        raise RuntimeError("connection refused")

    monkeypatch.setattr(server_module, "assert_ollama_up", raise_down)
    resp = client.post("/graph/chat", json={"message": "hi", "history": []})
    assert resp.status_code == 503
    assert "Local model unavailable" in resp.json()["detail"]


def test_graph_chat_emits_error_line_on_midstream_failure(client, monkeypatch):
    monkeypatch.setattr(server_module, "find_relevant_sessions", lambda store, q, max_sessions=5: [])
    monkeypatch.setattr(server_module, "build_context", lambda store, sids: "")

    def broken_stream(context, message, history, model=None):
        yield "partial "
        raise RuntimeError("ollama died mid-stream")

    monkeypatch.setattr(server_module, "stream_graph_chat_reply", broken_stream)

    resp = client.post("/graph/chat", json={"message": "hi", "history": []})
    assert resp.status_code == 200
    lines = [json.loads(line) for line in resp.text.strip().splitlines()]
    assert lines[0] == {"sources": []}
    assert lines[1] == {"token": "partial "}
    assert "ollama died mid-stream" in lines[2]["error"]


def test_process_job_enqueues_graph_indexing_after_save(client, monkeypatch):
    # Same mock set as test_process_falls_back_to_stub_notes_without_transcription,
    # plus a recorder on the graph enqueue hook.
    import sys
    import types

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", None)
    monkeypatch.setattr(server_module, "llava_complete", None)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    class FakeWhisperModel:
        def __init__(self, model_name, device=None, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1, **kwargs):
            raise RuntimeError("simulated whisper failure")

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    enqueued = []
    monkeypatch.setattr(server_module.graph_jobs, "enqueue_session", lambda sid: enqueued.append(sid))

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"
    assert enqueued == [resp.json()["session_id"]]


# ---- Track A: mic/system dual-track diarization ("You" vs "Others") --------

def _fake_to_wav_writer():
    def fake_to_wav(src, dst, ar=16000, ac=1):
        if src is None:
            return None
        dst.write_bytes(b"fake wav")
        return dst
    return fake_to_wav


def test_process_transcribes_mic_and_system_tracks_independently_when_both_present(client, monkeypatch):
    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)
    monkeypatch.setattr(server_module, "to_wav", _fake_to_wav_writer())

    def fake_transcribe_wav(wav_path, model_name=None, initial_prompt=None):
        name = Path(wav_path).name
        if name == "mic.wav":
            return [{"start": 0.0, "end": 1.0, "text": "yes exactly"}]
        assert name == "system.wav"
        return [{"start": 2.0, "end": 3.0, "text": "hello everyone"}]

    monkeypatch.setattr(server_module, "transcribe_wav", fake_transcribe_wav)

    def exploding_stop_recording_and_transcribe(**kwargs):
        raise AssertionError(
            "stop_recording_and_transcribe should not run when both mic and "
            "system tracks are present -- the dual-track path should be used"
        )

    monkeypatch.setattr(
        server_module, "stop_recording_and_transcribe", exploding_stop_recording_and_transcribe
    )

    captured = {}

    def fake_llava_complete(**kwargs):
        captured.update(kwargs)
        return "# Notes\n"

    monkeypatch.setattr(server_module, "llava_complete", fake_llava_complete)

    resp = client.post(
        "/process",
        files={
            "screen": ("screen.webm", io.BytesIO(b"x"), "video/webm"),
            "system": ("system.webm", io.BytesIO(b"y"), "audio/webm"),
            "mic": ("mic.webm", io.BytesIO(b"z"), "audio/webm"),
        },
    )
    assert resp.status_code == 202
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"
    session_id = job["session_id"]

    transcript_resp = client.get(f"/sessions/{session_id}/transcript")
    assert transcript_resp.status_code == 200
    assert transcript_resp.json()["segments"] == [
        {"start": 0.0, "end": 1.0, "speaker": "You", "text": "yes exactly"},
        {"start": 2.0, "end": 3.0, "speaker": "Others", "text": "hello everyone"},
    ]

    raw_txt = Path(captured["raw_txt_path"]).read_text(encoding="utf-8")
    assert raw_txt == "You: yes exactly\nOthers: hello everyone"


def test_process_falls_back_to_single_track_transcript_when_only_mic_present(client, monkeypatch):
    """Only one of mic/system was captured (e.g. system capture failed) --
    Track A's 2-way split can't run, so this must fall back to today's
    single-track, unlabeled transcript instead of erroring."""
    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)
    monkeypatch.setattr(server_module, "to_wav", _fake_to_wav_writer())

    def exploding_transcribe_wav(wav_path, model_name=None, initial_prompt=None):
        raise AssertionError("transcribe_wav should not run without both tracks present")

    monkeypatch.setattr(server_module, "transcribe_wav", exploding_transcribe_wav)

    def fake_stop_recording_and_transcribe(**kwargs):
        transcript_path = Path(kwargs["transcript_prefix"]).with_suffix(".txt")
        transcript_path.write_text("single track transcript", encoding="utf-8")
        return str(transcript_path), None

    monkeypatch.setattr(
        server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe
    )

    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n\nsingle track transcript")

    resp = client.post(
        "/process",
        files={
            "screen": ("screen.webm", io.BytesIO(b"x"), "video/webm"),
            "mic": ("mic.webm", io.BytesIO(b"z"), "audio/webm"),
        },
    )
    assert resp.status_code == 202
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"
    assert "single track transcript" in job["notes"]

    transcript_resp = client.get(f"/sessions/{job['session_id']}/transcript")
    assert transcript_resp.status_code == 200
    assert transcript_resp.json()["segments"] == []


def test_process_falls_back_when_dual_track_transcription_raises(client, monkeypatch):
    """A transcribe_wav failure on either track must fall back to the
    existing single-track path rather than failing the whole job."""
    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)
    monkeypatch.setattr(server_module, "to_wav", _fake_to_wav_writer())

    def failing_transcribe_wav(wav_path, model_name=None, initial_prompt=None):
        raise RuntimeError("whisper exploded")

    monkeypatch.setattr(server_module, "transcribe_wav", failing_transcribe_wav)

    def fake_stop_recording_and_transcribe(**kwargs):
        out_txt = Path(kwargs["transcript_prefix"]).with_suffix(".txt")
        out_txt.write_text("fallback transcript", encoding="utf-8")
        return str(out_txt), None

    monkeypatch.setattr(
        server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe
    )
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n\nfallback transcript")

    resp = client.post(
        "/process",
        files={
            "screen": ("screen.webm", io.BytesIO(b"x"), "video/webm"),
            "system": ("system.webm", io.BytesIO(b"y"), "audio/webm"),
            "mic": ("mic.webm", io.BytesIO(b"z"), "audio/webm"),
        },
    )
    assert resp.status_code == 202
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"
    assert "fallback transcript" in job["notes"]


def test_get_session_transcript_404_for_unknown_session(client: TestClient):
    resp = client.get("/sessions/does-not-exist/transcript")
    assert resp.status_code == 404


def test_get_session_transcript_returns_empty_list_when_no_transcript_json(client, monkeypatch):
    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", None)
    monkeypatch.setattr(server_module, "llava_complete", None)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    import sys
    import types

    class FakeSegment:
        text = "hi"

    class FakeWhisperModel:
        def __init__(self, model_name, device=None, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1, **kwargs):
            return [FakeSegment()], object()

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    job = wait_for_job(client, resp.json()["job_id"])

    transcript_resp = client.get(f"/sessions/{job['session_id']}/transcript")
    assert transcript_resp.status_code == 200
    assert transcript_resp.json() == {"segments": []}
