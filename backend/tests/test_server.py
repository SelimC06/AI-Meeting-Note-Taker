import asyncio
import io
import json
import os
import tempfile
import threading
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import httpx
import pytest
from fastapi.testclient import TestClient

import app.server as server_module
from app.server import app

TEST_API_TOKEN = "test-token-" + "0" * 53
AUTH_HEADERS = {server_module.API_TOKEN_HEADER: TEST_API_TOKEN}


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
    # Default action-items extraction to "unavailable" (None) so tests that
    # only care about llava_complete/notes never make a real network call to
    # a local Ollama server. Tests exercising the action-items feature
    # itself monkeypatch llava_extract_action_items again after this fixture
    # runs.
    monkeypatch.setattr(server_module, "llava_extract_action_items", lambda **kwargs: None)
    # Pin the per-launch API token so every request below can send it --
    # ApiAuthMiddleware 401s anything without it, /health included.
    monkeypatch.setattr(server_module, "API_TOKEN", TEST_API_TOKEN)
    # Pin the provider to the Ollama path these tests were written against:
    # the import-time value depends on whatever settings.json exists (or
    # doesn't) in the checkout, and the new-install default is "builtin",
    # whose not-ready preflight would otherwise 503 every chat test on a
    # machine without a dev settings file. Tests exercising the builtin or
    # custom providers set ai_provider themselves.
    monkeypatch.setattr(server_module, "AI_PROVIDER", "ollama")
    # base_url must be an allowed TrustedHostMiddleware host -- the default
    # "http://testserver" would otherwise get rejected with 400 before
    # reaching any route, since only localhost/127.0.0.1 are allowed.
    return TestClient(app, base_url="http://127.0.0.1", headers=AUTH_HEADERS)


@pytest.fixture()
def allow_origin(monkeypatch):
    """Allow-lists an origin the way ALLOWED_ORIGINS would at startup.

    Patches both server_module.ORIGINS (read per request by
    ApiAuthMiddleware) and, in place, the list CORSMiddleware was handed
    when `app` was built -- a module reload elsewhere in this file rebinds
    ORIGINS to a new list the already-built middleware never sees.
    """
    from fastapi.middleware.cors import CORSMiddleware

    cors = next(m for m in app.user_middleware if m.cls is CORSMiddleware)
    cors_origins = cors.kwargs["allow_origins"]
    saved = list(cors_origins)

    def _allow(origin: str) -> None:
        monkeypatch.setattr(server_module, "ORIGINS", [origin])
        cors_origins[:] = [origin]

    yield _allow
    cors_origins[:] = saved


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


def test_health_survives_a_purge_expired_trash_failure_at_startup(tmp_path, monkeypatch):
    """Regression test for Fix 3D: purge_expired_trash(STORE) used to run
    bare at startup -- one unexpected failure (e.g. a legacy naive
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
        reloaded.run_startup_maintenance()  # must not raise
        client = TestClient(
            reloaded.app,
            base_url="http://127.0.0.1",
            headers={reloaded.API_TOKEN_HEADER: reloaded.API_TOKEN},
        )
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
    # main() runs the startup maintenance first -- not against this dev
    # machine's real store.
    monkeypatch.setattr(server_module, "run_startup_maintenance", lambda: None)
    server_module.main()

    assert captured["app"] is server_module.app
    assert captured["kwargs"]["host"] == "127.0.0.1"


def test_main_runs_startup_maintenance_once_before_serving(monkeypatch):
    order = []
    monkeypatch.setattr(server_module, "run_startup_maintenance", lambda: order.append("maintenance"))
    monkeypatch.setattr(server_module.uvicorn, "run", lambda *a, **k: order.append("serve"))

    server_module.main()

    assert order == ["maintenance", "serve"]


def test_importing_the_server_runs_no_startup_maintenance(tmp_path, monkeypatch):
    """Every Python helper process of the frozen backend can end up importing
    app.server; importing it must never sweep, purge or delete anything."""
    import importlib
    import app.sessions_store as sessions_store_module

    app_data = tmp_path / "app-data"
    app_data.mkdir()
    monkeypatch.setenv("APP_DATA_DIR", str(app_data))
    calls = []
    for name in ("purge_expired_trash", "sweep_orphaned_sessions", "sweep_stale_staging_dirs", "sweep_stale_partial_mux_files"):
        monkeypatch.setattr(sessions_store_module, name, lambda store, _n=name: calls.append(_n))
    try:
        reloaded = importlib.reload(server_module)
        assert calls == []
        reloaded.run_startup_maintenance()
        assert calls == ["purge_expired_trash", "sweep_orphaned_sessions", "sweep_stale_staging_dirs", "sweep_stale_partial_mux_files"]
    finally:
        monkeypatch.undo()
        importlib.reload(server_module)


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


def test_requests_without_the_api_token_are_rejected(client: TestClient):
    """Any web page the user visits can reach 127.0.0.1 -- the per-launch
    token is what proves a request came from this app's own renderers.
    /health is covered too (Electron's own probes send the token).
    """
    for path in ("/health", "/sessions", "/settings", "/jobs"):
        resp = client.get(path, headers={server_module.API_TOKEN_HEADER: ""})
        assert resp.status_code == 401, path
    resp = client.get("/settings", headers={server_module.API_TOKEN_HEADER: "wrong"})
    assert resp.status_code == 401
    # A header-less TestClient, i.e. nothing sent at all.
    bare = TestClient(app, base_url="http://127.0.0.1")
    assert bare.get("/health").status_code == 401


def test_cross_site_multipart_upload_is_rejected_before_the_handler_runs(client: TestClient, monkeypatch):
    """The CSRF this guards against: a malicious page POSTs multipart/form-data
    to /process. Browsers send that cross-origin with no preflight, so it
    must be refused on the server side -- by the Origin check and, even
    without an Origin, by the missing token.
    """
    def upload():
        return {"screen": ("screen.webm", io.BytesIO(b"x" * 100), "video/webm")}

    # Token-less, the way a malicious page's request actually arrives.
    resp = client.post(
        "/process",
        files=upload(),
        headers={"Origin": "https://evil.example", server_module.API_TOKEN_HEADER: ""},
    )
    assert resp.status_code == 403
    # Even a valid token doesn't help a foreign origin.
    resp = client.post("/process", files=upload(), headers={"Origin": "https://evil.example"})
    assert resp.status_code == 403
    # No Origin at all (e.g. a non-browser client) still needs the token.
    resp = client.post("/process", files=upload(), headers={server_module.API_TOKEN_HEADER: ""})
    assert resp.status_code == 401

    assert client.get("/sessions").json() == []
    assert client.get("/jobs").json() == []


def test_disallowed_origin_is_rejected_even_with_a_valid_token(client: TestClient):
    for origin in ("https://evil.example", "http://localhost:5173", "http://localhost:3000", "null"):
        resp = client.get("/settings", headers={"Origin": origin})
        assert resp.status_code == 403, origin


def test_allow_listed_origin_passes_and_gets_cors_headers(client: TestClient, allow_origin):
    allow_origin("http://localhost:5173")
    resp = client.get("/settings", headers={"Origin": "http://localhost:5173"})
    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_default_allowed_origins_are_empty_and_never_include_null(monkeypatch):
    import importlib

    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    try:
        reloaded = importlib.reload(server_module)
        assert reloaded.ORIGINS == []
        monkeypatch.setenv("ALLOWED_ORIGINS", "null, http://localhost:5173")
        reloaded = importlib.reload(server_module)
        assert reloaded.ORIGINS == ["http://localhost:5173"]
    finally:
        monkeypatch.undo()
        importlib.reload(server_module)


def test_api_token_comes_from_env_or_is_generated(monkeypatch, capsys):
    import importlib

    try:
        monkeypatch.setenv("DESKRECAP_API_TOKEN", "from-electron")
        assert importlib.reload(server_module).API_TOKEN == "from-electron"

        monkeypatch.delenv("DESKRECAP_API_TOKEN")
        capsys.readouterr()
        generated = importlib.reload(server_module).API_TOKEN
        assert len(generated) == 64
        assert "WARNING: DESKRECAP_API_TOKEN is not set" in capsys.readouterr().out
    finally:
        monkeypatch.undo()
        importlib.reload(server_module)


def test_lifespan_starts_and_cleanly_cancels_the_daily_purge_task(monkeypatch):
    """The daily-purge background task must not prevent clean startup/
    shutdown, and must not leak as a still-running task after shutdown.
    """
    monkeypatch.setattr(server_module, "API_TOKEN", TEST_API_TOKEN)
    with TestClient(app, base_url="http://127.0.0.1", headers=AUTH_HEADERS) as c:
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


def test_chat_uses_custom_provider_when_configured(client: TestClient, monkeypatch):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc123",
        "created_at": "2026-08-03T00:00:00+00:00",
        "title": "Test Meeting",
        "notes": "notes",
        "video_path": "x",
    })

    captured = {}

    class _FakeClient:
        def list(self):
            return {}

    def fake_stream_chat_reply(notes, message, history, **kwargs):
        captured["model"] = kwargs.get("model")
        captured["client"] = kwargs.get("client")
        yield "custom reply"

    monkeypatch.setattr(server_module, "stream_chat_reply", fake_stream_chat_reply)
    monkeypatch.setattr(
        server_module.llm_provider, "resolve_active_client", lambda settings: (_FakeClient(), "gpt-4o-mini")
    )

    resp = client.post("/chat/abc123", json={"message": "hi", "history": []})
    assert resp.status_code == 200
    assert captured["model"] == "gpt-4o-mini"
    assert isinstance(captured["client"], _FakeClient)


def test_chat_still_uses_ollama_health_check_when_provider_is_ollama(client: TestClient, monkeypatch):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc123",
        "created_at": "2026-08-03T00:00:00+00:00",
        "title": "Test Meeting",
        "notes": "notes",
        "video_path": "x",
    })

    calls = []
    monkeypatch.setattr(server_module, "assert_ollama_up", lambda: calls.append("assert_ollama_up"))

    def fake_stream_chat_reply(notes, message, history, **kwargs):
        assert kwargs.get("client") is None
        yield "ok"

    monkeypatch.setattr(server_module, "stream_chat_reply", fake_stream_chat_reply)

    resp = client.post("/chat/abc123", json={"message": "hi", "history": []})
    assert resp.status_code == 200
    assert calls == ["assert_ollama_up"]


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


def test_process_413_response_includes_cors_header(client, monkeypatch, allow_origin):
    """
    Regression test: the 413 short-circuit from MaxUploadSizeMiddleware must
    still carry CORS headers, otherwise the browser blocks the response
    entirely and the frontend only sees a generic network error instead of
    the 413 status.
    """
    monkeypatch.setattr(server_module, "MAX_UPLOAD_BYTES", 10)  # tiny cap for the test
    # localhost:5173 is no longer allowed by default -- opt in the way a
    # `npm run dev:react` setup does via ALLOWED_ORIGINS.
    allow_origin("http://localhost:5173")
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
    assert values == {"tiny", "base", "small", "medium"}
    assert {c["value"] for c in body["transcription_language_choices"]} >= {"auto", "en"}


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
    resp = client.patch("/settings", json={"whisper_model": "small"})
    assert resp.status_code == 200
    assert resp.json()["whisper_model"] == "small"

    import app.server as server_module
    assert server_module.WHISPER_MODEL == "small"

    # Reflected on a subsequent GET too.
    resp2 = client.get("/settings")
    assert resp2.json()["whisper_model"] == "small"


def test_patch_settings_rejects_invalid_whisper_model(client: TestClient):
    resp = client.patch("/settings", json={"whisper_model": "not-a-real-model"})
    assert resp.status_code == 400


def test_get_settings_includes_advanced_diarization_fields(client: TestClient):
    resp = client.get("/settings")
    body = resp.json()
    assert body["advanced_diarization_enabled"] is False
    assert "huggingface_token" not in body
    assert body["huggingface_token_set"] is False


def test_patch_settings_updates_advanced_diarization_enabled(client: TestClient):
    resp = client.patch("/settings", json={"advanced_diarization_enabled": True})
    assert resp.status_code == 200
    assert resp.json()["advanced_diarization_enabled"] is True

    import app.server as server_module
    assert server_module.ADVANCED_DIARIZATION_ENABLED is True

    resp2 = client.get("/settings")
    assert resp2.json()["advanced_diarization_enabled"] is True


def test_patch_settings_updates_huggingface_token(client: TestClient):
    resp = client.patch("/settings", json={"huggingface_token": "hf_abc123"})
    assert resp.status_code == 200
    # Saved, but never echoed back -- only its "is set" flag is.
    assert "hf_abc123" not in resp.text
    assert resp.json()["huggingface_token_set"] is True

    import app.server as server_module
    assert server_module.HUGGINGFACE_TOKEN == "hf_abc123"

    resp2 = client.get("/settings")
    assert "hf_abc123" not in resp2.text
    assert resp2.json()["huggingface_token_set"] is True

    # An empty string clears it.
    resp3 = client.patch("/settings", json={"huggingface_token": ""})
    assert resp3.json()["huggingface_token_set"] is False
    assert server_module.HUGGINGFACE_TOKEN == ""


def test_patch_settings_updates_ollama_chat_model(client: TestClient):
    resp = client.patch("/settings", json={"ollama_chat_model": "llama3.1:8b"})
    assert resp.status_code == 200
    assert resp.json()["ollama_chat_model"] == "llama3.1:8b"

    import app.server as server_module
    assert server_module.OLLAMA_CHAT_MODEL == "llama3.1:8b"


def test_get_settings_includes_custom_provider_fields(client: TestClient):
    resp = client.get("/settings")
    body = resp.json()
    assert body["ai_provider"] == "ollama"
    assert body["custom_api_base_url"] == ""
    assert "custom_api_key" not in body
    assert body["custom_api_key_set"] is False
    assert body["custom_model_name"] == ""


def test_patch_settings_updates_custom_provider_fields(client: TestClient):
    resp = client.patch(
        "/settings",
        json={
            "ai_provider": "custom",
            "custom_api_base_url": "https://api.openai.com/v1",
            "custom_api_key": "sk-test",
            "custom_model_name": "gpt-4o-mini",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ai_provider"] == "custom"
    assert body["custom_api_base_url"] == "https://api.openai.com/v1"
    assert "sk-test" not in resp.text
    assert body["custom_api_key_set"] is True
    assert body["custom_model_name"] == "gpt-4o-mini"

    import app.server as server_module
    assert server_module.AI_PROVIDER == "custom"
    assert server_module.CUSTOM_API_BASE_URL == "https://api.openai.com/v1"
    assert server_module.CUSTOM_API_KEY == "sk-test"
    assert server_module.CUSTOM_MODEL_NAME == "gpt-4o-mini"

    resp2 = client.get("/settings")
    assert resp2.json()["ai_provider"] == "custom"

    # ai_provider (unlike the other settings globals this file already
    # mutates in place, e.g. OLLAMA_CHAT_MODEL) changes real request
    # routing -- leaving it at "custom" would make every later test's
    # /chat and /graph/chat calls try a real network request against
    # "https://api.openai.com/v1". Reset it so this test doesn't leak
    # state into the rest of the session.
    client.patch("/settings", json={"ai_provider": "ollama"})


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

    # The worker's own "store in use" state -- what try_block_store checks.
    monkeypatch.setattr(graph_jobs, "_indexing", True)

    new_dir = tmp_path.parent / f"{tmp_path.name}-new-storage"
    original_store = server_module.STORE

    resp = client.patch("/settings", json={"storage_dir": str(new_dir)})

    assert resp.status_code == 409
    assert server_module.STORE == original_store
    assert not new_dir.exists()
    assert graph_jobs._store_blocked is False


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
    client.patch("/settings", json={"whisper_model": "small"})
    assert server_module.SETTINGS_PATH.exists()

    # Push the live globals to non-default values, then delete settings.json
    # out from under the running server -- simulating it being deleted or
    # corrupted while the server is up.
    server_module.WHISPER_MODEL = "small"
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
    assert body["whisper_model"] == "small"
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

    server_module.WHISPER_MODEL = "small"

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
    assert captured["model_name"] == "small"


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

    server_module.WHISPER_MODEL = "medium"

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
    assert captured["model_name"] == "medium"


def test_process_fallback_whisper_uses_shared_transcribe_helper_defaults(client, monkeypatch):
    """
    Regression test for the beam_size=1 vs beam_size=5 drift between this
    fallback path and the primary path documented in
    docs/Core pipeline quality fix/03-transcription-accuracy.md -- both now
    go through whisper_cache.transcribe_audio() so they can't diverge again.
    """
    import sys
    import types
    import app.server as server_module

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

        def transcribe(self, path, **kwargs):
            captured.update(kwargs)
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

    assert captured["beam_size"] == 1
    assert captured["vad_filter"] is False
    assert captured["word_timestamps"] is True


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
    # "medium" (used with a mocked faster_whisper module there), and if
    # that leaked here it would make the real fallback whisper path (which
    # this test can hit, since the primary path returns no txt_path) try to
    # actually download an uncached model instead of using a cached one.
    server_module.WHISPER_MODEL = "small"

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


def test_process_summarizes_with_the_configured_chat_model(client, monkeypatch):
    """The summarize step must run on the configured chat model, not on
    LLaVA_summarize's vision-model default.

    Summarization is called with no frame_paths (text-only), so the vision
    default was a second model users were never told to pull -- and when it was
    absent, Ollama's 404 made every recording fall back to the raw transcript.
    """
    import app.server as server_module

    server_module.OLLAMA_CHAT_MODEL = "gemma3:4b"

    captured = {}

    def fake_stop_recording_and_transcribe(**kwargs):
        txt = Path(kwargs["transcript_prefix"] + "raw.txt")
        txt.write_text("some transcript", encoding="utf-8")
        return str(txt), []

    def fake_llava_complete(**kwargs):
        captured["model"] = kwargs.get("model")
        return "# Notes\n- summarized"

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe)
    monkeypatch.setattr(server_module, "llava_complete", fake_llava_complete)
    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    wait_for_job(client, resp.json()["job_id"])
    assert captured["model"] == "gemma3:4b"


def test_process_chat_model_falls_back_when_job_predates_the_input(client, monkeypatch):
    """A job queued by an older build has no "ollama_chat_model" key in its inputs;
    the worker must fall back to the configured model rather than KeyError."""
    import uuid
    import app.server as server_module
    from app import jobs

    server_module.OLLAMA_CHAT_MODEL = "gemma3:4b"

    captured = {}

    def fake_stop_recording_and_transcribe(**kwargs):
        txt = Path(kwargs["transcript_prefix"] + "raw.txt")
        txt.write_text("some transcript", encoding="utf-8")
        return str(txt), []

    def fake_llava_complete(**kwargs):
        captured["model"] = kwargs.get("model")
        return "# Notes\n- summarized"

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe)
    monkeypatch.setattr(server_module, "llava_complete", fake_llava_complete)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    session = server_module.STORE / uuid.uuid4().hex
    session.mkdir(parents=True, exist_ok=True)
    screen_webm = session / "screen.webm"
    screen_webm.write_bytes(b"fake video bytes")

    job_id = jobs.create_job(
        session_id=session.name,
        inputs={
            "store": str(server_module.STORE),
            "screen_webm": str(screen_webm),
            "system_webm": None,
            "mic_webm": None,
            "whisper_model": "tiny.en",
            # no "ollama_chat_model" -- exactly what an older build enqueued
        },
    )
    jobs.enqueue(job_id)
    wait_for_job(client, job_id)
    assert captured["model"] == "gemma3:4b"


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
    from datetime import datetime, timedelta
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

    # min_age_seconds=0: the folder was created a moment ago, which the real
    # sweep deliberately leaves alone (a recording could be in progress).
    result = server_module.sweep_orphaned_sessions(server_module.STORE, min_age_seconds=0)

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

    def fake_stream(context, message, history, model=None, client=None):
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

    def broken_stream(context, message, history, model=None, client=None):
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

    def fake_transcribe_wav(wav_path, model_name=None, initial_prompt=None, language=None):
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
        {"start": 0.0, "end": 1.0, "speaker": "You", "text": "yes exactly", "words": [], "raw_speaker": "You"},
        {"start": 2.0, "end": 3.0, "speaker": "Others", "text": "hello everyone", "words": [], "raw_speaker": "Others"},
    ]

    raw_txt = Path(captured["raw_txt_path"]).read_text(encoding="utf-8")
    assert raw_txt == "You: yes exactly\nOthers: hello everyone"


# ---- Track B: pyannote n-party diarization refinement ----------------------

def _fake_save_upload(dst_dir, uf, name):
    out = dst_dir / name
    out.write_bytes(b"fake bytes")
    return out


def _fake_mux(video, audio, out_path):
    out_path.write_bytes(b"fake final video")
    return out_path


def _post_dual_track(client, monkeypatch, fake_transcribe_wav):
    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", _fake_mux)
    monkeypatch.setattr(server_module, "to_wav", _fake_to_wav_writer())
    monkeypatch.setattr(server_module, "transcribe_wav", fake_transcribe_wav)
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n")

    resp = client.post(
        "/process",
        files={
            "screen": ("screen.webm", io.BytesIO(b"x"), "video/webm"),
            "system": ("system.webm", io.BytesIO(b"y"), "audio/webm"),
            "mic": ("mic.webm", io.BytesIO(b"z"), "audio/webm"),
        },
    )
    assert resp.status_code == 202
    return wait_for_job(client, resp.json()["job_id"])


def test_process_passes_transcription_language_and_resolved_model(client, monkeypatch):
    """The language setting flows from PATCH /settings through the job's
    inputs snapshot into every transcribe_wav call -- and the stored model
    SIZE resolves to the concrete model: multilingual for a pinned
    non-English language, the ".en" variant for English."""
    captured = []

    def capturing_transcribe_wav(wav_path, model_name=None, initial_prompt=None, language=None):
        captured.append({"model": model_name, "language": language})
        return [{"start": 0.0, "end": 1.0, "text": "merhaba"}]

    client.patch("/settings", json={"whisper_model": "base", "transcription_language": "tr"})
    job = _post_dual_track(client, monkeypatch, capturing_transcribe_wav)
    assert job["status"] == "done"
    assert captured and all(c == {"model": "base", "language": "tr"} for c in captured)

    captured.clear()
    client.patch("/settings", json={"transcription_language": "en"})
    job = _post_dual_track(client, monkeypatch, capturing_transcribe_wav)
    assert job["status"] == "done"
    assert captured and all(c == {"model": "base.en", "language": "en"} for c in captured)

    captured.clear()
    client.patch("/settings", json={"transcription_language": "auto"})
    job = _post_dual_track(client, monkeypatch, capturing_transcribe_wav)
    assert job["status"] == "done"
    # auto -> language=None lets Whisper detect, on the multilingual model.
    assert captured and all(c == {"model": "base", "language": None} for c in captured)


def test_patch_settings_rejects_unknown_transcription_language(client):
    resp = client.patch("/settings", json={"transcription_language": "klingon"})
    assert resp.status_code == 400
    assert "transcription_language" in resp.json()["detail"]


def _two_speaker_system_transcribe_wav(wav_path, model_name=None, initial_prompt=None, language=None):
    name = Path(wav_path).name
    if name == "mic.wav":
        return [{"start": 0.0, "end": 1.0, "text": "yes exactly"}]
    return [
        {"start": 2.0, "end": 3.0, "text": "hello everyone"},
        {"start": 4.0, "end": 5.0, "text": "hi there"},
    ]


def test_process_refines_others_with_pyannote_when_diarization_enabled(client, monkeypatch):
    client.patch("/settings", json={"advanced_diarization_enabled": True, "huggingface_token": "tok"})

    calls = []

    def fake_diarize(wav_path, token):
        calls.append((wav_path, token))
        return [("SPEAKER_00", 2.0, 3.0), ("SPEAKER_01", 4.0, 5.0)]

    monkeypatch.setattr(server_module, "pyannote_diarize", fake_diarize)

    job = _post_dual_track(client, monkeypatch, _two_speaker_system_transcribe_wav)
    assert job["status"] == "done"

    assert len(calls) == 1
    assert Path(calls[0][0]).name == "system.wav"
    assert calls[0][1] == "tok"

    segments = client.get(f"/sessions/{job['session_id']}/transcript").json()["segments"]
    speakers = {s["speaker"] for s in segments}
    assert speakers == {"You", "SPEAKER_00", "SPEAKER_01"}


def test_process_skips_pyannote_diarization_when_disabled_by_default(client, monkeypatch):
    def exploding_diarize(wav_path, token):
        raise AssertionError("pyannote_diarize should not run when the setting is off")

    monkeypatch.setattr(server_module, "pyannote_diarize", exploding_diarize)

    job = _post_dual_track(client, monkeypatch, _two_speaker_system_transcribe_wav)
    assert job["status"] == "done"

    segments = client.get(f"/sessions/{job['session_id']}/transcript").json()["segments"]
    assert {s["speaker"] for s in segments} == {"You", "Others"}


def test_process_falls_back_to_track_a_output_when_pyannote_diarization_raises(client, monkeypatch):
    client.patch("/settings", json={"advanced_diarization_enabled": True, "huggingface_token": "tok"})

    def failing_diarize(wav_path, token):
        raise RuntimeError("pyannote exploded")

    monkeypatch.setattr(server_module, "pyannote_diarize", failing_diarize)

    job = _post_dual_track(client, monkeypatch, _two_speaker_system_transcribe_wav)
    assert job["status"] == "done"

    segments = client.get(f"/sessions/{job['session_id']}/transcript").json()["segments"]
    assert {s["speaker"] for s in segments} == {"You", "Others"}


def test_process_does_not_call_pyannote_without_a_configured_token(client, monkeypatch):
    client.patch("/settings", json={"advanced_diarization_enabled": True})

    def exploding_diarize(wav_path, token):
        raise AssertionError("pyannote_diarize should not run without a token configured")

    monkeypatch.setattr(server_module, "pyannote_diarize", exploding_diarize)

    job = _post_dual_track(client, monkeypatch, _two_speaker_system_transcribe_wav)
    assert job["status"] == "done"

    segments = client.get(f"/sessions/{job['session_id']}/transcript").json()["segments"]
    assert {s["speaker"] for s in segments} == {"You", "Others"}


def test_process_diarizes_single_track_fallback_when_enabled(client, monkeypatch):
    """Only one of mic/system was captured -- Track A's dual-track split
    can't run, but Track B can still diarize the single available track
    directly when the setting is on."""
    client.patch("/settings", json={"advanced_diarization_enabled": True, "huggingface_token": "tok"})

    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", _fake_mux)
    monkeypatch.setattr(server_module, "to_wav", _fake_to_wav_writer())

    def fake_llava_complete(**kwargs):
        return Path(kwargs["raw_txt_path"]).read_text(encoding="utf-8")

    monkeypatch.setattr(server_module, "llava_complete", fake_llava_complete)

    def fake_stop_recording_and_transcribe(**kwargs):
        out_txt = Path(kwargs["transcript_prefix"]).with_suffix(".txt")
        out_txt.write_text("solo track transcript", encoding="utf-8")
        return str(out_txt), None

    monkeypatch.setattr(
        server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe
    )

    def fake_transcribe_wav(wav_path, model_name=None, initial_prompt=None, language=None):
        return [
            {"start": 0.0, "end": 1.0, "text": "hello"},
            {"start": 2.0, "end": 3.0, "text": "hi back"},
        ]

    monkeypatch.setattr(server_module, "transcribe_wav", fake_transcribe_wav)

    def fake_diarize(wav_path, token):
        return [("SPEAKER_00", 0.0, 1.0), ("SPEAKER_01", 2.0, 3.0)]

    monkeypatch.setattr(server_module, "pyannote_diarize", fake_diarize)

    resp = client.post(
        "/process",
        files={
            "screen": ("screen.webm", io.BytesIO(b"x"), "video/webm"),
            "mic": ("mic.webm", io.BytesIO(b"z"), "audio/webm"),
        },
    )
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"
    assert "solo track transcript" in job["notes"]

    segments = client.get(f"/sessions/{job['session_id']}/transcript").json()["segments"]
    assert {s["speaker"] for s in segments} == {"SPEAKER_00", "SPEAKER_01"}


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

    def failing_transcribe_wav(wav_path, model_name=None, initial_prompt=None, language=None):
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


def test_get_session_transcript_resolves_speaker_names(client, monkeypatch):
    _fake_save_and_mux(monkeypatch)
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n")

    def fake_transcribe_wav(wav_path, model_name=None, initial_prompt=None, language=None):
        name = Path(wav_path).name
        if name == "mic.wav":
            return [{"start": 0.0, "end": 1.0, "text": "hi"}]
        return [{"start": 2.0, "end": 3.0, "text": "hello"}]

    monkeypatch.setattr(server_module, "transcribe_wav", fake_transcribe_wav)

    resp = client.post(
        "/process",
        files={
            "screen": ("screen.webm", io.BytesIO(b"x"), "video/webm"),
            "system": ("system.webm", io.BytesIO(b"y"), "audio/webm"),
            "mic": ("mic.webm", io.BytesIO(b"z"), "audio/webm"),
        },
    )
    job = wait_for_job(client, resp.json()["job_id"])
    session_id = job["session_id"]

    # "Others" here stands in for a raw pyannote label in the Track B case --
    # the resolution logic itself doesn't care what the raw label looks like.
    rename_resp = client.patch(
        f"/sessions/{session_id}/speaker-names", json={"names": {"Others": "Alice"}}
    )
    assert rename_resp.status_code == 200

    transcript_resp = client.get(f"/sessions/{session_id}/transcript")
    segments = transcript_resp.json()["segments"]
    speakers = {s["speaker"] for s in segments}
    assert speakers == {"You", "Alice"}

    # raw_speaker must stay the original, stable label even after a rename --
    # the frontend needs it to target a SECOND rename (e.g. "Alice" -> a
    # corrected spelling) at the right key, since it can't reconstruct the
    # raw label from an already-resolved display name.
    others_segment = next(s for s in segments if s["speaker"] == "Alice")
    assert others_segment["raw_speaker"] == "Others"
    you_segment = next(s for s in segments if s["speaker"] == "You")
    assert you_segment["raw_speaker"] == "You"


def test_patch_speaker_names_404_for_unknown_session(client: TestClient):
    resp = client.patch("/sessions/does-not-exist/speaker-names", json={"names": {"SPEAKER_00": "Alice"}})
    assert resp.status_code == 404


def test_patch_speaker_names_merges_across_calls(client, monkeypatch):
    _fake_save_and_mux(monkeypatch)
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n")
    monkeypatch.setattr(server_module, "transcribe_wav", lambda *a, **k: [])

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    job = wait_for_job(client, resp.json()["job_id"])
    session_id = job["session_id"]

    client.patch(f"/sessions/{session_id}/speaker-names", json={"names": {"SPEAKER_00": "Alice"}})
    resp2 = client.patch(f"/sessions/{session_id}/speaker-names", json={"names": {"SPEAKER_01": "Bob"}})

    assert resp2.json()["speaker_names"] == {"SPEAKER_00": "Alice", "SPEAKER_01": "Bob"}


def _fake_save_and_mux(monkeypatch):
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

    def fake_stop_recording_and_transcribe(**kwargs):
        transcript_path = Path(kwargs["transcript_prefix"]).with_suffix(".txt")
        transcript_path.write_text("someone should follow up", encoding="utf-8")
        return str(transcript_path), None

    monkeypatch.setattr(
        server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe
    )


def test_get_session_action_items_404_for_unknown_session(client: TestClient):
    resp = client.get("/sessions/does-not-exist/action-items")
    assert resp.status_code == 404


def test_process_lands_action_items_in_session_and_survives_reload(client, monkeypatch):
    """The happy path end-to-end: structured extraction succeeds, and the
    result is retrievable via GET /sessions/{id}/action-items -- including
    after the index is reloaded from disk (append_session/load_sessions),
    not just from in-memory state right after the job finishes."""
    _fake_save_and_mux(monkeypatch)
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n\nfollow up")

    def fake_extract_action_items(**kwargs):
        return [{"text": "Send the follow-up doc", "owner": "Sam", "due": None}]

    monkeypatch.setattr(server_module, "llava_extract_action_items", fake_extract_action_items)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"
    session_id = job["session_id"]

    # Force a reload from disk, rather than serving a cached in-process copy.
    from app import sessions_store as sessions_store_module

    sessions_store_module._index_cache.clear()

    action_items_resp = client.get(f"/sessions/{session_id}/action-items")
    assert action_items_resp.status_code == 200
    assert action_items_resp.json() == {
        "action_items": [{"text": "Send the follow-up doc", "owner": "Sam", "due": None}]
    }

    # notes (the prose fallback content) must be completely unaffected by
    # the structured extraction succeeding alongside it.
    sessions_resp = client.get("/sessions")
    record = next(r for r in sessions_resp.json() if r["id"] == session_id)
    assert record["notes"] == "# Notes\n\nfollow up"


def test_process_falls_back_to_prose_when_action_items_extraction_returns_none(client, monkeypatch):
    """extract_action_items returning None (both its internal parse
    attempts failed) must not fail the job or the notes -- the frontend is
    expected to fall back to the prose notes rendering, signaled here by
    GET /action-items simply returning null."""
    _fake_save_and_mux(monkeypatch)
    monkeypatch.setattr(
        server_module, "llava_complete", lambda **kwargs: "# Notes\n\n## Action Items\n- someone should follow up"
    )
    monkeypatch.setattr(server_module, "llava_extract_action_items", lambda **kwargs: None)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"
    assert "Action Items" in job["notes"]

    action_items_resp = client.get(f"/sessions/{job['session_id']}/action-items")
    assert action_items_resp.status_code == 200
    assert action_items_resp.json() == {"action_items": None}


def test_process_falls_back_to_prose_when_action_items_extraction_raises(client, monkeypatch):
    """Any exception out of extract_action_items (e.g. Ollama unreachable,
    a timeout) must be swallowed the same way -- the job still succeeds
    with its prose notes, and structured data is simply unavailable rather
    than the whole recording being marked failed."""
    _fake_save_and_mux(monkeypatch)
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n\nfollow up")

    def exploding_extract_action_items(**kwargs):
        raise httpx.ReadTimeout("timed out waiting for Ollama")

    monkeypatch.setattr(server_module, "llava_extract_action_items", exploding_extract_action_items)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"
    assert job["notes"] == "# Notes\n\nfollow up"

    action_items_resp = client.get(f"/sessions/{job['session_id']}/action-items")
    assert action_items_resp.status_code == 200
    assert action_items_resp.json() == {"action_items": None}


def test_process_stores_empty_action_items_list_when_model_finds_none(client, monkeypatch):
    """An empty list is a legitimate, successfully-parsed result (the model
    genuinely found no action items) and must be distinguished from
    None/unavailable -- both by what's written to disk and what the
    endpoint returns."""
    _fake_save_and_mux(monkeypatch)
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n\nnothing to do")
    monkeypatch.setattr(server_module, "llava_extract_action_items", lambda **kwargs: [])

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"

    action_items_resp = client.get(f"/sessions/{job['session_id']}/action-items")
    assert action_items_resp.status_code == 200
    assert action_items_resp.json() == {"action_items": []}


def test_process_skips_action_items_extraction_when_summarization_itself_fails(client, monkeypatch):
    """When llava_complete itself fails, the job already falls back to
    showing the raw transcript as notes -- action items extraction must not
    even be attempted against that same (evidently broken) summarization
    path, and must not be able to turn a "summarization failed" session
    into one that looks like it has valid structured data."""
    _fake_save_and_mux(monkeypatch)

    def failing_llava_complete(**kwargs):
        raise RuntimeError("ollama exploded")

    monkeypatch.setattr(server_module, "llava_complete", failing_llava_complete)

    calls = {"count": 0}

    def counting_extract_action_items(**kwargs):
        calls["count"] += 1
        return [{"text": "should never appear", "owner": None, "due": None}]

    monkeypatch.setattr(server_module, "llava_extract_action_items", counting_extract_action_items)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"
    assert calls["count"] == 0

    action_items_resp = client.get(f"/sessions/{job['session_id']}/action-items")
    assert action_items_resp.status_code == 200
    assert action_items_resp.json() == {"action_items": None}


# ---- Structured transcript for every recording with audio ------------------

def _post_tracks(client, monkeypatch, fake_transcribe_wav, *, mic, system):
    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", _fake_mux)
    monkeypatch.setattr(server_module, "to_wav", _fake_to_wav_writer())
    monkeypatch.setattr(server_module, "transcribe_wav", fake_transcribe_wav)

    def exploding_stop_recording_and_transcribe(**kwargs):
        raise AssertionError(
            "stop_recording_and_transcribe should not run when a separate audio "
            "track was captured -- that track should be transcribed directly"
        )

    monkeypatch.setattr(
        server_module, "stop_recording_and_transcribe", exploding_stop_recording_and_transcribe
    )
    captured = {}

    def fake_llava_complete(**kwargs):
        captured.update(kwargs)
        return "# Notes\n"

    monkeypatch.setattr(server_module, "llava_complete", fake_llava_complete)

    files = {"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")}
    if system:
        files["system"] = ("system.webm", io.BytesIO(b"y"), "audio/webm")
    if mic:
        files["mic"] = ("mic.webm", io.BytesIO(b"z"), "audio/webm")
    resp = client.post("/process", files=files)
    assert resp.status_code == 202
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"
    segments = client.get(f"/sessions/{job['session_id']}/transcript").json()["segments"]
    return segments, captured


def test_process_writes_transcript_for_mic_only_recording(client, monkeypatch):
    def fake_transcribe_wav(wav_path, model_name=None, initial_prompt=None, language=None):
        return [{"start": 0.0, "end": 1.0, "text": "just me talking"}]

    segments, captured = _post_tracks(client, monkeypatch, fake_transcribe_wav, mic=True, system=False)

    assert [(s["speaker"], s["text"]) for s in segments] == [("You", "just me talking")]
    # The same transcription pass feeds the summary.
    assert Path(captured["raw_txt_path"]).read_text(encoding="utf-8") == "just me talking"


def test_process_writes_transcript_for_system_only_recording(client, monkeypatch):
    def fake_transcribe_wav(wav_path, model_name=None, initial_prompt=None, language=None):
        return [{"start": 0.0, "end": 1.0, "text": "the other side"}]

    segments, _ = _post_tracks(client, monkeypatch, fake_transcribe_wav, mic=False, system=True)

    assert [(s["speaker"], s["text"]) for s in segments] == [("Others", "the other side")]


def test_process_falls_back_to_unlabeled_mixed_transcript_when_dual_track_fails(client, monkeypatch):
    def fake_mix(system_wav, mic_wav, out_wav):
        out_wav.write_bytes(b"fake mixed wav")
        return out_wav, True

    monkeypatch.setattr(server_module, "mix_audios_wav", fake_mix)

    def fake_transcribe_wav(wav_path, model_name=None, initial_prompt=None, language=None):
        if Path(wav_path).name != "mixed.wav":
            raise RuntimeError("per-track transcription blew up")
        return [{"start": 0.0, "end": 1.0, "text": "everyone at once"}]

    segments, _ = _post_tracks(client, monkeypatch, fake_transcribe_wav, mic=True, system=True)

    assert [(s["speaker"], s["text"]) for s in segments] == [(None, "everyone at once")]


def test_transcript_endpoint_falls_back_to_plain_transcript_txt(client, monkeypatch):
    """A session with no transcript.json (recorded before every recording got
    one, or with no separate audio track) still shows its plain transcript."""
    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", _fake_mux)

    def fake_stop_recording_and_transcribe(**kwargs):
        out = Path(kwargs["transcript_prefix"]).with_suffix(".txt")
        out.write_text("first run\n---\nsecond run", encoding="utf-8")
        return str(out), None

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", fake_stop_recording_and_transcribe)
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n")

    resp = client.post(
        "/process", files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")}
    )
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"

    segments = client.get(f"/sessions/{job['session_id']}/transcript").json()["segments"]
    assert [(s["speaker"], s["text"]) for s in segments] == [(None, "first run"), (None, "second run")]


def _process_with_transcript(client, monkeypatch, tmp_path, transcript_text, fake_llava_complete):
    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    transcript_path = tmp_path / "transcript_.txt"
    transcript_path.write_text(transcript_text, encoding="utf-8")

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)
    monkeypatch.setattr(
        server_module, "stop_recording_and_transcribe", lambda **kwargs: (str(transcript_path), [])
    )
    monkeypatch.setattr(server_module, "llava_complete", fake_llava_complete)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 202
    return wait_for_job(client, resp.json()["job_id"])


def test_process_does_not_cap_the_transcript_and_reports_chunk_progress(client, monkeypatch, tmp_path):
    """Regression test: the summary call used to pass max_chars=12000, which
    cut every meeting to its first ~13 minutes. Long transcripts are now
    chunked inside llava_complete, which reports per-chunk progress onto the
    job so a long meeting doesn't look stuck on "summarizing"."""
    captured = {}
    seen_progress = []

    def fake_llava_complete(**kwargs):
        captured.update(kwargs)
        for done in (1, 2, 3):
            kwargs["on_progress"](done, 3)
            seen_progress.append(server_module.jobs.get_job(job_ids[0])["progress"])
        return "# Notes\n- summarized"

    job_ids = []
    real_create_job = server_module.jobs.create_job

    def recording_create_job(*args, **kwargs):
        job_id = real_create_job(*args, **kwargs)
        job_ids.append(job_id)
        return job_id

    monkeypatch.setattr(server_module.jobs, "create_job", recording_create_job)

    job = _process_with_transcript(client, monkeypatch, tmp_path, "hello", fake_llava_complete)

    assert job["status"] == "done"
    assert captured.get("max_chars") is None
    assert seen_progress == [
        {"done": 1, "total": 3}, {"done": 2, "total": 3}, {"done": 3, "total": 3}
    ]
    assert job["progress"] is None  # cleared once summarizing is over


def test_raw_transcript_fallback_marks_a_truncated_transcript_visibly(client, monkeypatch, tmp_path):
    """The failed-summary fallback stores the raw transcript as the notes,
    capped at 12000 chars -- that cap used to cut silently, so the notes
    (and per-meeting chat, which only sees notes) looked like the whole
    meeting."""
    def failing_llava_complete(**kwargs):
        raise RuntimeError("llava down")

    long_transcript = "\n".join(f"Alice: line {i:05d} " + "x" * 80 for i in range(600))
    job = _process_with_transcript(client, monkeypatch, tmp_path, long_transcript, failing_llava_complete)

    assert job["status"] == "done"
    assert "line 00000" in job["notes"]
    assert "line 00599" not in job["notes"]
    assert "Transcript truncated" in job["notes"]


def test_raw_transcript_fallback_does_not_mark_a_short_transcript(client, monkeypatch, tmp_path):
    def failing_llava_complete(**kwargs):
        raise RuntimeError("llava down")

    job = _process_with_transcript(client, monkeypatch, tmp_path, "Alice: short", failing_llava_complete)

    assert "Alice: short" in job["notes"]
    assert "Transcript truncated" not in job["notes"]


# ---------- corrupt data files ----------

def _write_index(store: Path, records) -> None:
    from app.sessions_store import append_session
    for r in records:
        append_session(store, r)


def _index_record(sid, **fields):
    return {"id": sid, "created_at": "2026-08-01T10:00:00+00:00", "title": f"Title {sid}",
            "notes": "", "video_path": "", "trashed_at": None, **fields}


def test_get_sessions_with_corrupt_index_returns_503_with_code(client: TestClient, tmp_path):
    (tmp_path / "sessions_index.json").write_text("[{trunc", encoding="utf-8")

    for _ in range(3):
        resp = client.get("/sessions")
        assert resp.status_code == 503
        detail = resp.json()["detail"]
        assert detail["code"] == "sessions_index_corrupt"
        assert "Recover library" in detail["message"]

    # One preserved copy, not one per poll.
    assert len(list(tmp_path.glob("sessions_index.corrupt-*.json"))) == 1


def test_writes_with_corrupt_index_return_503_and_leave_it_untouched(client: TestClient, tmp_path):
    (tmp_path / "sessions_index.json").write_text("[{trunc", encoding="utf-8")

    assert client.patch("/sessions/abc", json={"title": "New"}).status_code == 503
    assert client.post("/sessions/abc/restore").status_code == 503
    assert client.delete("/sessions/abc").status_code == 503

    assert (tmp_path / "sessions_index.json").read_text(encoding="utf-8") == "[{trunc"


def test_recover_index_endpoint_restores_the_library(client: TestClient, tmp_path):
    sid = "d" * 32
    (tmp_path / sid).mkdir()
    (tmp_path / sid / "final.webm").write_bytes(b"video")
    _write_index(tmp_path, [_index_record(sid, title="Quarterly review")])
    (tmp_path / "sessions_index.json").write_text("[{trunc", encoding="utf-8")

    resp = client.post("/sessions/recover-index")

    assert resp.status_code == 200
    assert resp.json()["source"] == "backup"
    sessions = client.get("/sessions").json()
    assert [s["title"] for s in sessions] == ["Quarterly review"]


def test_recover_index_endpoint_refuses_while_a_job_is_running(client: TestClient, tmp_path, monkeypatch):
    (tmp_path / "sessions_index.json").write_text("[{trunc", encoding="utf-8")
    monkeypatch.setattr(server_module.jobs, "is_busy", lambda: True)

    assert client.post("/sessions/recover-index").status_code == 409
    assert (tmp_path / "sessions_index.json").read_text(encoding="utf-8") == "[{trunc"


def test_health_reports_settings_error_until_settings_are_saved(client: TestClient, monkeypatch):
    monkeypatch.setattr(server_module, "SETTINGS_ERROR", "Your settings file (settings.json) is damaged")
    monkeypatch.setattr(server_module, "STORE_UNTRUSTED", True)

    assert client.get("/health").json()["settings_error"] == "Your settings file (settings.json) is damaged"

    assert client.patch("/settings", json={}).status_code == 200

    assert client.get("/health").json()["settings_error"] is None
    assert server_module.STORE_UNTRUSTED is False


def test_health_settings_error_is_null_normally(client: TestClient, monkeypatch):
    monkeypatch.setattr(server_module, "SETTINGS_ERROR", None)
    assert client.get("/health").json()["settings_error"] is None


def test_delete_session_removes_it_from_the_knowledge_graph(client: TestClient, tmp_path):
    from app import knowledge_graph

    _write_index(tmp_path, [_index_record("s1")])
    knowledge_graph.merge_extraction(tmp_path, "s1", {
        "entities": [{"id": 1, "type": "person", "name": "Sarah Klein", "aliases": []}],
        "relations": [],
    })

    assert client.delete("/sessions/s1").status_code == 200

    assert knowledge_graph.load_graph(tmp_path) == knowledge_graph.empty_graph()


@pytest.mark.parametrize("salvageable", [False, True])
def test_startup_with_corrupt_settings_reports_it_and_guards_the_sweeps(tmp_path, monkeypatch, salvageable):
    """A damaged settings.json used to be silently replaced with defaults,
    so a custom-folder user got an empty library and the startup purge and
    orphan sweep ran against the default folder instead.
    """
    import importlib
    import app.sessions_store as sessions_store_module

    app_data = tmp_path / "app-data"
    app_data.mkdir()
    custom = tmp_path / "custom-store"
    custom.mkdir()
    damaged = '{"whisper_model": "base.en", "storage_dir": ' + (json.dumps(str(custom)) if salvageable else '"/nope')
    (app_data / "settings.json").write_text(damaged, encoding="utf-8")
    monkeypatch.setenv("APP_DATA_DIR", str(app_data))

    swept = []
    monkeypatch.setattr(sessions_store_module, "purge_expired_trash", lambda store: swept.append(("purge", store)))
    monkeypatch.setattr(sessions_store_module, "sweep_orphaned_sessions", lambda store: swept.append(("sweep", store)))

    try:
        reloaded = importlib.reload(server_module)
        client = TestClient(
            reloaded.app,
            base_url="http://127.0.0.1",
            headers={reloaded.API_TOKEN_HEADER: reloaded.API_TOKEN},
        )
        assert "damaged" in client.get("/health").json()["settings_error"]
        # Damaged file kept in place (and copied aside), not overwritten.
        assert (app_data / "settings.json").read_text(encoding="utf-8") == damaged
        assert len(list(app_data.glob("settings.corrupt-*.json"))) == 1
        assert swept == []  # nothing runs at import
        reloaded.run_startup_maintenance()
        if salvageable:
            assert reloaded.STORE == custom
            assert swept == [("purge", custom), ("sweep", custom)]
        else:
            assert reloaded.STORE == app_data / "uploads"
            assert swept == []
    finally:
        monkeypatch.delenv("APP_DATA_DIR", raising=False)
        monkeypatch.undo()
        importlib.reload(server_module)


# ---------- intermediate file cleanup ----------

_INTERMEDIATES = {"system.wav", "mic.wav", "mixed.wav", "screen.webm", "system.webm", "mic.webm"}


def _successful_amix(monkeypatch):
    # The fake wavs aren't real audio, so a real amix would fail and fall
    # back to one track -- exactly the case that must KEEP the raw webms.
    # This stands in for an amix that worked.
    def fake_run_ffmpeg(args):
        Path(args[-1]).write_bytes(b"mixed wav")

    monkeypatch.setattr(server_module, "run_ffmpeg", fake_run_ffmpeg)


def test_successful_job_deletes_intermediates_and_keeps_what_features_read(client, monkeypatch):
    _successful_amix(monkeypatch)
    job = _post_dual_track(client, monkeypatch, _two_speaker_system_transcribe_wav)
    assert job["status"] == "done"

    session_dir = server_module.STORE / job["session_id"]
    remaining = {p.name for p in session_dir.iterdir()}
    assert remaining.isdisjoint(_INTERMEDIATES), remaining
    # Playback/export, the transcript view, and the summary input stay.
    # (notes.md isn't here only because the faked llava_complete doesn't
    # write it; it isn't in the delete list.)
    assert {"final.webm", "transcript_.txt", "transcript.json"} <= remaining

    # Export still has everything it ships.
    zf = zipfile.ZipFile(io.BytesIO(client.get(f"/sessions/{job['session_id']}/export/zip").content))
    assert {"final.webm", "notes.md", "transcript_.txt"} <= set(zf.namelist())


def test_job_keeps_both_raw_tracks_when_one_track_failed_to_convert(client, monkeypatch):
    """A truncated mic upload: to_wav fails for it, transcription still
    succeeds from the system track alone, and final.* has no mic audio --
    mic.webm is then the only copy of it and must not be deleted."""
    _successful_amix(monkeypatch)
    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", _fake_mux)
    monkeypatch.setattr(server_module, "transcribe_wav", _two_speaker_system_transcribe_wav)
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n")
    real_writer = _fake_to_wav_writer()

    def to_wav_mic_fails(src, dst, ar=16000, ac=1):
        if src is not None and src.name == "mic.webm":
            return None
        return real_writer(src, dst, ar, ac)

    monkeypatch.setattr(server_module, "to_wav", to_wav_mic_fails)
    resp = client.post(
        "/process",
        files={
            "screen": ("screen.webm", io.BytesIO(b"x"), "video/webm"),
            "system": ("system.webm", io.BytesIO(b"y"), "audio/webm"),
            "mic": ("mic.webm", io.BytesIO(b"z"), "audio/webm"),
        },
    )
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"

    remaining = {p.name for p in (server_module.STORE / job["session_id"]).iterdir()}
    assert {"system.webm", "mic.webm", "final.webm"} <= remaining
    # Derived and duplicate files still go.
    assert remaining.isdisjoint({"system.wav", "mixed.wav", "screen.webm"}), remaining


def test_job_keeps_both_raw_tracks_when_amix_falls_back_to_one_track(client, monkeypatch):
    def failing_run_ffmpeg(args):
        raise RuntimeError("amix: invalid data")

    monkeypatch.setattr(server_module, "run_ffmpeg", failing_run_ffmpeg)
    job = _post_dual_track(client, monkeypatch, _two_speaker_system_transcribe_wav)
    assert job["status"] == "done"

    remaining = {p.name for p in (server_module.STORE / job["session_id"]).iterdir()}
    assert {"system.webm", "mic.webm", "final.webm"} <= remaining
    assert remaining.isdisjoint({"system.wav", "mic.wav", "mixed.wav", "screen.webm"}), remaining


def test_single_track_fallback_job_deletes_transcript_wav(client, monkeypatch):
    """stop_recording_and_transcribe's own transcript_.wav extract goes too."""
    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", _fake_mux)
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n")

    def fake_stop_and_transcribe(video_path, transcript_prefix, **kwargs):
        Path(transcript_prefix).with_suffix(".wav").write_bytes(b"pcm")
        txt = Path(transcript_prefix).with_suffix(".txt")
        txt.write_text("hello", encoding="utf-8")
        return str(txt), None

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", fake_stop_and_transcribe)

    resp = client.post("/process", files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")})
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"

    remaining = {p.name for p in (server_module.STORE / job["session_id"]).iterdir()}
    assert "transcript_.wav" not in remaining and "screen.webm" not in remaining
    assert {"final.webm", "transcript_.txt"} <= remaining


def test_failed_mux_keeps_every_intermediate(client, monkeypatch):
    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "to_wav", _fake_to_wav_writer())

    def failing_mux(video, audio, out_path):
        raise RuntimeError("mux exploded")

    monkeypatch.setattr(server_module, "mux_video_audio", failing_mux)

    resp = client.post(
        "/process",
        files={
            "screen": ("screen.webm", io.BytesIO(b"x"), "video/webm"),
            "system": ("system.webm", io.BytesIO(b"y"), "audio/webm"),
            "mic": ("mic.webm", io.BytesIO(b"z"), "audio/webm"),
        },
    )
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "failed"

    remaining = {p.name for p in (server_module.STORE / job["session_id"]).iterdir()}
    assert _INTERMEDIATES <= remaining


def test_job_without_any_transcript_keeps_intermediates(client, monkeypatch):
    """Muxed fine, but every transcription pass failed: nothing to retry
    from except the intermediates, so they stay."""
    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", _fake_mux)
    monkeypatch.setattr(server_module, "to_wav", _fake_to_wav_writer())

    def failing_transcribe(*args, **kwargs):
        raise RuntimeError("whisper unavailable")

    monkeypatch.setattr(server_module, "transcribe_wav", failing_transcribe)
    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", failing_transcribe)
    monkeypatch.setattr(server_module, "transcribe_audio", failing_transcribe)

    resp = client.post(
        "/process",
        files={
            "screen": ("screen.webm", io.BytesIO(b"x"), "video/webm"),
            "system": ("system.webm", io.BytesIO(b"y"), "audio/webm"),
            "mic": ("mic.webm", io.BytesIO(b"z"), "audio/webm"),
        },
    )
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"

    remaining = {p.name for p in (server_module.STORE / job["session_id"]).iterdir()}
    assert _INTERMEDIATES <= remaining


def test_delete_job_intermediates_refuses_without_a_usable_final_file(tmp_path):
    session = tmp_path / "s"
    session.mkdir()
    wav = session / "mixed.wav"
    wav.write_bytes(b"pcm")
    final = session / "final.webm"

    assert server_module._delete_job_intermediates(session, final, [wav]) == []  # missing
    final.write_bytes(b"")
    assert server_module._delete_job_intermediates(session, final, [wav]) == []  # empty
    assert wav.exists()


def test_delete_job_intermediates_only_touches_the_session_folder(tmp_path):
    session = tmp_path / "s"
    session.mkdir()
    final = session / "final.webm"
    final.write_bytes(b"video")
    outside = tmp_path / "mixed.wav"
    outside.write_bytes(b"pcm")

    deleted = server_module._delete_job_intermediates(session, final, [outside, final, None])

    assert deleted == []
    assert outside.exists() and final.exists()


# ---------- export zip ----------

def _export_session(client, video_bytes=b"fake video bytes"):
    from app.sessions_store import append_session

    session_dir = server_module.STORE / "abc"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(video_bytes)
    (session_dir / "transcript_.txt").write_text("You: hello " * 200, encoding="utf-8")
    (session_dir / "frames").mkdir()
    (session_dir / "frames" / "frame_00001.png").write_bytes(b"png bytes")
    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00",
        "title": "My Meeting", "notes": "notes",
        "video_path": str(session_dir / "final.webm"), "trashed_at": None,
    })


def test_export_zip_stores_media_and_deflates_text(client: TestClient):
    _export_session(client)

    resp = client.get("/sessions/abc/export/zip")

    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    types = {info.filename: info.compress_type for info in zf.infolist()}
    assert types["final.webm"] == zipfile.ZIP_STORED
    assert types["frames/frame_00001.png"] == zipfile.ZIP_STORED
    assert types["notes.md"] == zipfile.ZIP_DEFLATED
    assert types["transcript_.txt"] == zipfile.ZIP_DEFLATED
    assert zf.read("final.webm") == b"fake video bytes"


def test_export_zip_is_built_under_the_storage_folder(client: TestClient):
    _export_session(client)

    tmp_paths_used = []
    real_named_temp_file = tempfile.NamedTemporaryFile

    def spying_named_temp_file(*args, **kwargs):
        f = real_named_temp_file(*args, **kwargs)
        tmp_paths_used.append(f.name)
        return f

    with mock.patch("app.server.tempfile.NamedTemporaryFile", side_effect=spying_named_temp_file):
        assert client.get("/sessions/abc/export/zip").status_code == 200

    assert Path(tmp_paths_used[0]).parent == server_module.STORE / server_module.EXPORT_DIR_NAME
    assert not Path(tmp_paths_used[0]).exists()  # still cleaned up after sending


def test_sweep_stale_export_zips_covers_the_storage_export_folder(tmp_path, monkeypatch):
    os_tmp = tmp_path / "os-tmp"
    os_tmp.mkdir()
    monkeypatch.setattr("app.server.tempfile.gettempdir", lambda: str(os_tmp))
    store = tmp_path / "store"
    export_dir = store / server_module.EXPORT_DIR_NAME
    export_dir.mkdir(parents=True)

    old = time.time() - 7200
    stale_new_location = export_dir / f"{server_module.EXPORT_TEMP_PREFIX}a.zip"
    stale_legacy = os_tmp / f"{server_module.EXPORT_TEMP_PREFIX}b.zip"
    fresh = export_dir / f"{server_module.EXPORT_TEMP_PREFIX}c.zip"
    unrelated = export_dir / "keep-me.zip"
    for p in (stale_new_location, stale_legacy, fresh, unrelated):
        p.write_bytes(b"zip")
    for p in (stale_new_location, stale_legacy, unrelated):
        os.utime(p, (old, old))

    server_module._sweep_stale_export_zips(max_age_seconds=3600, store_dir=store)

    assert not stale_new_location.exists()
    assert not stale_legacy.exists()
    assert fresh.exists() and unrelated.exists()


def test_export_folder_is_not_mistaken_for_a_session(client: TestClient):
    from app.sessions_store import sweep_orphaned_sessions

    _export_session(client)
    client.get("/sessions/abc/export/zip")

    assert sweep_orphaned_sessions(server_module.STORE) == {"adopted": [], "deleted": []}
    assert (server_module.STORE / server_module.EXPORT_DIR_NAME).is_dir()


# ---------- custom provider: no /models pre-flight, settings validation ----------

class _NoModelsClient:
    """A provider without GET /models: list() 404s, chat works."""

    def list(self):
        raise AssertionError("custom provider must not be pre-flighted with /models")

    def chat(self, model, messages, options=None, format=None, stream=False):
        if stream:
            return iter([{"message": {"content": "hi from provider"}}])
        return {"message": {"content": "# Title: Provider notes\n"}}


def test_chat_with_custom_provider_skips_models_preflight(client, monkeypatch):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "abc", "created_at": "2026-08-01T00:00:00+00:00", "title": "T",
        "notes": "notes", "video_path": "", "trashed_at": None,
    })
    monkeypatch.setattr(
        server_module.llm_provider, "resolve_active_client", lambda settings: (_NoModelsClient(), "m")
    )

    def ollama_down():
        raise RuntimeError("ollama is not running")

    monkeypatch.setattr(server_module, "assert_ollama_up", ollama_down)
    monkeypatch.setattr(
        server_module, "stream_chat_reply",
        lambda notes, message, history, model=None, client=None: iter(["hi from provider"]),
    )

    resp = client.post("/chat/abc", json={"message": "hello", "history": []})

    assert resp.status_code == 200
    assert "hi from provider" in resp.text


def test_summary_failure_with_custom_provider_quotes_the_real_error(client, monkeypatch):
    monkeypatch.setattr(
        server_module.llm_provider, "resolve_active_client", lambda settings: (_NoModelsClient(), "m")
    )

    def failing_complete(**kwargs):
        raise RuntimeError("Custom AI provider returned HTTP 401: Invalid API key")

    monkeypatch.setattr(server_module, "llava_complete", failing_complete)
    client.patch("/settings", json={"ai_provider": "custom", "custom_api_base_url": "https://p.example/v1"})

    job = _post_dual_track_with(client, monkeypatch)

    assert job["status"] == "done"
    assert "Invalid API key" in job["notes"]
    assert "not found" not in job["notes"]


def _post_dual_track_with(client, monkeypatch):
    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", _fake_mux)
    monkeypatch.setattr(server_module, "to_wav", _fake_to_wav_writer())
    monkeypatch.setattr(server_module, "transcribe_wav", _two_speaker_system_transcribe_wav)
    resp = client.post(
        "/process",
        files={
            "screen": ("screen.webm", io.BytesIO(b"x"), "video/webm"),
            "system": ("system.webm", io.BytesIO(b"y"), "audio/webm"),
            "mic": ("mic.webm", io.BytesIO(b"z"), "audio/webm"),
        },
    )
    return wait_for_job(client, resp.json()["job_id"])


@pytest.fixture()
def ollama_provider(monkeypatch):
    # These tests assert on AI_PROVIDER, a module global a successful PATCH
    # rewrites -- restore it (and the URL) so later tests aren't affected.
    monkeypatch.setattr(server_module, "AI_PROVIDER", "ollama")
    monkeypatch.setattr(server_module, "CUSTOM_API_BASE_URL", "")


def test_patch_settings_rejects_unknown_ai_provider(client, ollama_provider):
    resp = client.patch("/settings", json={"ai_provider": "openai"})
    assert resp.status_code == 400
    assert server_module.AI_PROVIDER == "ollama"


@pytest.mark.parametrize("url", ["api.openai.com/v1", "ftp://x.example", "https://", "not a url"])
def test_patch_settings_rejects_malformed_base_url(client, ollama_provider, url):
    assert client.patch("/settings", json={"custom_api_base_url": url}).status_code == 400
    assert server_module.CUSTOM_API_BASE_URL == ""


def test_patch_settings_rejects_clearing_the_url_while_on_custom(client, ollama_provider):
    assert client.patch(
        "/settings", json={"ai_provider": "custom", "custom_api_base_url": " https://p.example/v1 "}
    ).status_code == 200
    assert server_module.CUSTOM_API_BASE_URL == "https://p.example/v1"  # trimmed

    assert client.patch("/settings", json={"custom_api_base_url": "  "}).status_code == 400
    assert client.patch(
        "/settings", json={"ai_provider": "custom", "custom_api_base_url": ""}
    ).status_code == 400
    assert server_module.CUSTOM_API_BASE_URL == "https://p.example/v1"


def test_patch_settings_allows_switching_to_custom_before_a_url_is_entered(client, ollama_provider):
    """The Settings page saves the provider choice first, then shows the
    URL field -- that first save must not be rejected."""
    assert client.patch("/settings", json={"ai_provider": "custom"}).status_code == 200
    # ...and clearing the URL is fine once back on Ollama.
    assert client.patch("/settings", json={"ai_provider": "ollama"}).status_code == 200
    assert client.patch("/settings", json={"custom_api_base_url": ""}).status_code == 200


# ---------- storage move vs. background work races ----------

@pytest.fixture()
def graph_worker(monkeypatch):
    """A real graph_jobs worker on a fresh queue, reading the live STORE."""
    from app import graph_jobs

    if server_module.graph_jobs is None:
        pytest.skip("graph_jobs feature not available in this build")
    import queue as queue_module

    monkeypatch.setattr(graph_jobs, "_QUEUE", queue_module.Queue())
    monkeypatch.setattr(graph_jobs, "_worker_started", False)
    monkeypatch.setattr(graph_jobs, "IDLE_POLL_SECONDS", 0.01)
    monkeypatch.setattr(graph_jobs, "_indexing", False)
    monkeypatch.setattr(graph_jobs, "_store_blocked", False, raising=False)
    return graph_jobs


def test_graph_worker_cannot_claim_the_old_store_during_a_move(client, tmp_path, monkeypatch, graph_worker):
    """Reproduces the race deterministically: the worker has picked up a
    session but not yet marked itself busy when the move's checks run.
    Before the fix the move passed its is_busy() check, the worker then
    marked itself busy and read the OLD STORE, and went on to write into
    the folder the move was abandoning.
    """
    graph_jobs = graph_worker
    worker_picked_up = threading.Event()
    release_worker = threading.Event()
    stores_indexed = []
    indexed = threading.Event()

    real_is_busy = graph_jobs.jobs.is_busy

    def is_busy_pausing_the_worker():
        # Freeze the worker right after it dequeued a session, before it
        # claims the store; everyone else sees the real answer.
        if threading.current_thread().name == "graph-index-worker" and not release_worker.is_set():
            worker_picked_up.set()
            release_worker.wait(5)
        return real_is_busy()

    monkeypatch.setattr(graph_jobs.jobs, "is_busy", is_busy_pausing_the_worker)

    def fake_index_session(store_dir, session_id, model, client=None):
        stores_indexed.append(Path(store_dir))
        indexed.set()

    monkeypatch.setattr(graph_jobs, "index_session", fake_index_session)

    def move_that_lets_the_worker_run(old_dir, new_dir):
        # The move has passed its checks. Let the worker continue now, and
        # give it the chance to grab the store before the files move.
        release_worker.set()
        indexed.wait(0.5)
        new_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(server_module, "move_storage_dir", move_that_lets_the_worker_run)

    graph_jobs.start_worker(lambda: server_module.STORE, lambda: "m")
    graph_jobs.enqueue_session("s1")
    assert worker_picked_up.wait(5)

    new_dir = tmp_path.parent / f"{tmp_path.name}-moved"
    resp = client.patch("/settings", json={"storage_dir": str(new_dir)})
    assert resp.status_code == 200

    assert indexed.wait(5)
    assert stores_indexed == [new_dir]


def test_storage_move_refuses_an_upload_that_finishes_during_its_checks(client, tmp_path, monkeypatch):
    """The smaller window: an in-flight /process finishes (creating its
    queued job) between the move's jobs.is_busy() check and its
    _active_uploads check. Before the fix is_busy() ran outside
    _store_state_lock, so both checks passed and the queued job's files
    were moved out from under it.
    """
    new_dir = tmp_path.parent / f"{tmp_path.name}-moved-2"
    real_is_busy = server_module.jobs.is_busy
    finished = []

    def upload_finishes_right_after(*args, **kwargs):
        busy = real_is_busy()
        if not finished:
            finished.append(True)
            # What /process's tail does: create the job, then count itself
            # out under the lock. Run on another thread with a timeout so a
            # caller holding _store_state_lock can't deadlock the test.
            def finish_upload():
                server_module.jobs.create_job("sess", {"store": str(server_module.STORE)})
                with server_module._store_state_lock:
                    server_module._active_uploads -= 1
            t = threading.Thread(target=finish_upload)
            t.start()
            t.join(0.5)
        return busy

    monkeypatch.setattr(server_module, "_active_uploads", 1)
    monkeypatch.setattr(server_module.jobs, "is_busy", upload_finishes_right_after)
    moved = []
    monkeypatch.setattr(server_module, "move_storage_dir", lambda old, new: moved.append(new))

    resp = client.patch("/settings", json={"storage_dir": str(new_dir)})

    assert resp.status_code == 409
    assert moved == []
    assert server_module.move_in_progress is False


def test_graph_worker_waits_for_a_move_and_then_uses_the_new_store(client, tmp_path, monkeypatch, graph_worker):
    graph_jobs = graph_worker
    stores_indexed = []
    indexed = threading.Event()
    in_move = threading.Event()
    finish_move = threading.Event()

    def fake_index_session(store_dir, session_id, model, client=None):
        stores_indexed.append(Path(store_dir))
        indexed.set()

    monkeypatch.setattr(graph_jobs, "index_session", fake_index_session)

    def slow_move(old_dir, new_dir):
        in_move.set()
        finish_move.wait(5)
        new_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(server_module, "move_storage_dir", slow_move)
    graph_jobs.start_worker(lambda: server_module.STORE, lambda: "m")

    new_dir = tmp_path.parent / f"{tmp_path.name}-moved-3"
    result = {}
    mover = threading.Thread(
        target=lambda: result.update(resp=client.patch("/settings", json={"storage_dir": str(new_dir)}))
    )
    mover.start()
    assert in_move.wait(5)

    graph_jobs.enqueue_session("s1")
    assert not indexed.wait(0.2)  # blocked while the move owns the store

    finish_move.set()
    mover.join(5)
    assert result["resp"].status_code == 200
    assert indexed.wait(5)
    assert stores_indexed == [new_dir]
    assert graph_jobs._store_blocked is False


def test_failed_move_unblocks_the_graph_worker(client, tmp_path, monkeypatch, graph_worker):
    graph_jobs = graph_worker

    def exploding_move(old_dir, new_dir):
        raise OSError("disk yanked")

    monkeypatch.setattr(server_module, "move_storage_dir", exploding_move)
    new_dir = tmp_path.parent / f"{tmp_path.name}-moved-4"

    with pytest.raises(OSError):
        client.patch("/settings", json={"storage_dir": str(new_dir)})

    assert graph_jobs._store_blocked is False
    assert server_module.move_in_progress is False


# ---------- storage move / recovery vs. a damaged index ----------

def test_storage_move_is_refused_while_the_index_is_corrupt(client, tmp_path):
    (server_module.STORE / "sessions_index.json").write_text("[{trunc", encoding="utf-8")
    new_dir = tmp_path.parent / f"{tmp_path.name}-moved-corrupt"
    original = server_module.STORE

    resp = client.patch("/settings", json={"storage_dir": str(new_dir)})

    assert resp.status_code == 409
    assert "Recover library" in resp.json()["detail"]
    assert server_module.STORE == original
    assert not new_dir.exists()
    assert server_module.move_in_progress is False
    if server_module.graph_jobs is not None:
        assert server_module.graph_jobs._store_blocked is False


def test_settings_are_still_saved_if_the_index_breaks_during_the_move(client, tmp_path, monkeypatch):
    new_dir = tmp_path.parent / f"{tmp_path.name}-moved-midbreak"

    def move_then_index_breaks(old_dir, new):
        new.mkdir(parents=True, exist_ok=True)
        (new / "sessions_index.json").write_text("[{trunc", encoding="utf-8")

    monkeypatch.setattr(server_module, "move_storage_dir", move_then_index_breaks)

    resp = client.patch("/settings", json={"storage_dir": str(new_dir)})

    assert resp.status_code == 200
    saved = json.loads(server_module.SETTINGS_PATH.read_text(encoding="utf-8"))
    assert saved["storage_dir"] == str(new_dir)
    assert server_module.STORE == new_dir


@pytest.mark.parametrize("state", ["move", "upload"])
def test_recover_index_refuses_during_a_move_or_an_upload(client, monkeypatch, state):
    (server_module.STORE / "sessions_index.json").write_text("[{trunc", encoding="utf-8")
    if state == "move":
        monkeypatch.setattr(server_module, "move_in_progress", True)
    else:
        monkeypatch.setattr(server_module, "_active_uploads", 1)

    resp = client.post("/sessions/recover-index")

    assert resp.status_code == 409
    assert (server_module.STORE / "sessions_index.json").read_text(encoding="utf-8") == "[{trunc"


def test_recover_index_holds_the_store_lock_so_an_upload_cannot_register_meanwhile(client, monkeypatch):
    (server_module.STORE / "sessions_index.json").write_text("[{trunc", encoding="utf-8")
    lock_held_during_recovery = []
    real_recover = server_module.recover_sessions_index

    def spying_recover(store):
        lock_held_during_recovery.append(server_module._store_state_lock.locked())
        return real_recover(store)

    monkeypatch.setattr(server_module, "recover_sessions_index", spying_recover)

    assert client.post("/sessions/recover-index").status_code == 200
    assert lock_held_during_recovery == [True]


# ---------- library changes during a storage move ----------

@pytest.mark.parametrize("method,path,body", [
    ("patch", "/sessions/s1", {"title": "New"}),
    ("post", "/sessions/s1/trash", None),
    ("post", "/sessions/s1/restore", None),
    ("delete", "/sessions/s1", None),
    ("patch", "/sessions/s1/speaker-names", {"names": {"SPEAKER_00": "Alice"}}),
])
def test_library_changes_are_refused_while_the_storage_folder_moves(client, monkeypatch, method, path, body):
    from app.sessions_store import append_session, load_sessions

    append_session(server_module.STORE, {
        "id": "s1", "created_at": "2026-08-01T00:00:00+00:00", "title": "Old",
        "notes": "", "video_path": "", "trashed_at": None,
    })
    before = load_sessions(server_module.STORE)
    monkeypatch.setattr(server_module, "move_in_progress", True)

    kwargs = {"json": body} if body is not None else {}
    resp = getattr(client, method)(path, **kwargs)

    assert resp.status_code == 409
    assert "being moved" in resp.json()["detail"]
    assert load_sessions(server_module.STORE) == before
    assert not (server_module.STORE / "s1").exists()  # no stray folder recreated


def test_library_changes_hold_the_store_lock_so_a_move_cannot_start_midway(client, monkeypatch):
    from app.sessions_store import append_session

    append_session(server_module.STORE, {
        "id": "s1", "created_at": "2026-08-01T00:00:00+00:00", "title": "Old",
        "notes": "", "video_path": "", "trashed_at": None,
    })
    held = []
    real_update = server_module.update_session_fields

    def spying_update(*args, **kwargs):
        held.append(server_module._store_state_lock.locked())
        return real_update(*args, **kwargs)

    monkeypatch.setattr(server_module, "update_session_fields", spying_update)
    assert client.patch("/sessions/s1", json={"title": "New"}).status_code == 200
    assert held == [True]


def test_daily_trash_purge_skips_during_a_move(monkeypatch):
    calls = []
    monkeypatch.setattr(server_module, "purge_expired_trash", lambda store: calls.append(store))
    monkeypatch.setattr(server_module, "move_in_progress", True)
    server_module._purge_trash_unless_moving()
    assert calls == []
    monkeypatch.setattr(server_module, "move_in_progress", False)
    server_module._purge_trash_unless_moving()
    assert calls == [server_module.STORE]


# ---------- silent recordings ----------

@pytest.mark.parametrize("text,empty", [
    ("", True),
    ("   \n\n", True),
    ("You: \nOthers:   \n", True),
    ("You: hello", False),
    ("Others: at 3:00 we ship", False),
    ("plain transcript without labels", False),
])
def test_transcript_is_empty(tmp_path, text, empty):
    txt = tmp_path / "transcript_.txt"
    txt.write_text(text, encoding="utf-8")
    assert server_module._transcript_is_empty(str(txt)) is empty


def test_silent_recording_gets_a_plain_note_and_no_model_calls(client, monkeypatch):
    def must_not_run(**kwargs):
        raise AssertionError("no LLM call for a silent recording")

    monkeypatch.setattr(server_module, "llava_extract_action_items", must_not_run)
    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", _fake_mux)
    monkeypatch.setattr(server_module, "to_wav", _fake_to_wav_writer())
    monkeypatch.setattr(server_module, "transcribe_wav", lambda *a, **k: [])
    monkeypatch.setattr(server_module, "llava_complete", must_not_run)

    def silent_stop_and_transcribe(video_path, transcript_prefix, **kwargs):
        txt = Path(transcript_prefix).with_suffix(".txt")
        txt.write_text("", encoding="utf-8")
        return str(txt), None

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", silent_stop_and_transcribe)

    resp = client.post("/process", files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")})
    job = wait_for_job(client, resp.json()["job_id"])

    assert job["status"] == "done"
    assert job["notes"] == server_module.SILENT_RECORDING_NOTES
    assert not (server_module.STORE / job["session_id"] / "summary.json").exists()
    session = client.get("/sessions").json()[0]
    assert session["title"] == "Silent recording"


# ---------- a failure after indexing doesn't duplicate the record ----------

def _post_screen_only_job(client, monkeypatch):
    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", _fake_mux)
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n- x")

    def fake_stop_and_transcribe(video_path, transcript_prefix, **kwargs):
        txt = Path(transcript_prefix).with_suffix(".txt")
        txt.write_text("hello there", encoding="utf-8")
        return str(txt), None

    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", fake_stop_and_transcribe)
    resp = client.post("/process", files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")})
    return wait_for_job(client, resp.json()["job_id"])


def test_failing_summary_json_write_records_the_session_once(client, monkeypatch):
    monkeypatch.setattr(server_module, "llava_extract_action_items", lambda **kwargs: [{"text": "ship", "owner": None, "due": None}])

    def failing_write(session_dir, items):
        raise OSError("disk full")

    monkeypatch.setattr(server_module, "write_action_items", failing_write)

    job = _post_screen_only_job(client, monkeypatch)

    assert job["status"] == "failed"
    from app.sessions_store import load_sessions
    records = [r for r in load_sessions(server_module.STORE) if r["id"] == job["session_id"]]
    assert len(records) == 1
    assert records[0]["status"] == "failed"


def test_failure_after_indexing_marks_the_existing_record(client, monkeypatch):
    def failing_cleanup(*args, **kwargs):
        raise RuntimeError("cleanup exploded")

    monkeypatch.setattr(server_module, "_delete_job_intermediates", failing_cleanup)

    job = _post_screen_only_job(client, monkeypatch)

    assert job["status"] == "failed"
    from app.sessions_store import load_sessions
    records = [r for r in load_sessions(server_module.STORE) if r["id"] == job["session_id"]]
    assert len(records) == 1
    # The real notes are kept; only the status/error changed.
    assert records[0]["notes"] == "# Notes\n- x"
    assert records[0]["status"] == "failed"
    assert "cleanup exploded" in records[0]["error"]


# ---- Tier 1.3: audio-only recording + file import ---------------------------

def _fake_encode_audio_final(mixed_wav, out_base):
    out = out_base.with_suffix(".m4a")
    out.write_bytes(b"fake audio final")
    return out


def _fake_single_segment_transcribe_wav(wav_path, model_name=None, initial_prompt=None, language=None):
    return [{"start": 0.0, "end": 1.0, "text": "audio only works"}]


def test_process_accepts_audio_only_upload(client, monkeypatch):
    """No screen track at all: the session still processes end to end, with
    final.* produced from the mixed audio instead of a mux."""
    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "to_wav", _fake_to_wav_writer())
    monkeypatch.setattr(server_module, "encode_audio_final", _fake_encode_audio_final)
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n")
    monkeypatch.setattr(server_module, "transcribe_wav", _two_speaker_system_transcribe_wav)

    resp = client.post(
        "/process",
        files={
            "system": ("system.webm", io.BytesIO(b"y"), "audio/webm"),
            "mic": ("mic.webm", io.BytesIO(b"z"), "audio/webm"),
        },
    )
    assert resp.status_code == 202
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"
    assert job["video_path"].endswith("final.m4a")

    # Dual-track You/Others transcription works exactly as with video.
    segments = client.get(f"/sessions/{job['session_id']}/transcript").json()["segments"]
    assert {s["speaker"] for s in segments} == {"You", "Others"}


def test_process_rejects_upload_with_no_valid_tracks(client):
    resp = client.post("/process")
    assert resp.status_code == 400
    assert "No valid recording" in resp.json()["detail"]


def test_process_keeps_the_meeting_when_only_the_screen_track_is_corrupt(client, monkeypatch):
    """A corrupt screen upload used to 400 the whole request and lose the
    meeting even when the audio tracks survived; now it degrades to an
    audio-only session."""

    def selective_save_upload(dst_dir, uf, name):
        if name == "screen.webm":
            return None  # what save_upload returns for an ffprobe-invalid file
        out = dst_dir / name
        out.write_bytes(b"fake bytes")
        return out

    monkeypatch.setattr(server_module, "save_upload", selective_save_upload)
    monkeypatch.setattr(server_module, "to_wav", _fake_to_wav_writer())
    monkeypatch.setattr(server_module, "encode_audio_final", _fake_encode_audio_final)
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n")
    monkeypatch.setattr(server_module, "transcribe_wav", _fake_single_segment_transcribe_wav)

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
    assert job["video_path"].endswith("final.m4a")


def test_import_runs_the_full_pipeline_with_unattributed_speakers(client, monkeypatch):
    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "probe_stream_types", lambda p: ["audio"])
    monkeypatch.setattr(server_module, "to_wav", _fake_to_wav_writer())
    monkeypatch.setattr(server_module, "llava_complete", lambda **kwargs: "# Notes\n")

    def fake_transcribe_wav(wav_path, model_name=None, initial_prompt=None, language=None):
        return [{"start": 0.0, "end": 1.5, "text": "imported speech"}]

    monkeypatch.setattr(server_module, "transcribe_wav", fake_transcribe_wav)

    resp = client.post(
        "/import",
        files={"file": ("standup.m4a", io.BytesIO(b"audio bytes"), "audio/mp4")},
    )
    assert resp.status_code == 202
    job = wait_for_job(client, resp.json()["job_id"])
    assert job["status"] == "done"
    # The imported file itself became the final recording, keeping its
    # container/extension.
    assert job["video_path"].endswith("final.m4a")
    assert Path(job["video_path"]).read_bytes() == b"fake bytes"

    # An import has no mic/system provenance: segments must NOT be labeled
    # "You" the way a mic-only recording is.
    segments = client.get(f"/sessions/{job['session_id']}/transcript").json()["segments"]
    assert [s["speaker"] for s in segments] == [None]
    assert [s["text"] for s in segments] == ["imported speech"]


def test_import_rejects_unsupported_extension(client):
    resp = client.post("/import", files={"file": ("notes.txt", io.BytesIO(b"hi"), "text/plain")})
    assert resp.status_code == 400
    assert "Unsupported file type" in resp.json()["detail"]


def test_import_rejects_a_file_without_an_audio_stream(client, monkeypatch):
    monkeypatch.setattr(server_module, "save_upload", _fake_save_upload)
    monkeypatch.setattr(server_module, "probe_stream_types", lambda p: ["video"])
    resp = client.post("/import", files={"file": ("clip.mp4", io.BytesIO(b"v"), "video/mp4")})
    assert resp.status_code == 400
    assert "no audio track" in resp.json()["detail"]


def test_import_rejects_a_corrupt_file(client, monkeypatch):
    monkeypatch.setattr(server_module, "save_upload", lambda dst_dir, uf, name: None)
    resp = client.post("/import", files={"file": ("broken.mp3", io.BytesIO(b""), "audio/mpeg")})
    assert resp.status_code == 400
    assert "couldn't be read" in resp.json()["detail"]
