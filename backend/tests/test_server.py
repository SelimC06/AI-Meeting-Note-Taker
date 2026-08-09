import io
from datetime import datetime, timezone
from pathlib import Path

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
    return TestClient(app)


import time


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


def test_main_binds_to_localhost_only(monkeypatch):
    captured = {}

    def fake_run(app_arg, **kwargs):
        captured["app"] = app_arg
        captured["kwargs"] = kwargs

    monkeypatch.setattr(server_module.uvicorn, "run", fake_run)
    server_module.main()

    assert captured["app"] is server_module.app
    assert captured["kwargs"]["host"] == "127.0.0.1"


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
        def __init__(self, model_name, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1):
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
        def __init__(self, model_name, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1):
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
        def __init__(self, model_name, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1):
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
        def __init__(self, model_name, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1):
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
        def __init__(self, model_name, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1):
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
    assert resp.text == "We discussed things."


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
    assert body["ollama"] is False


def test_process_dedupes_frame_indices_for_small_frame_count(client, monkeypatch):
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
        def __init__(self, model_name, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1):
            return [FakeSegment()], object()

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    # n=2 frames: pre-fix idxs would be [round(1/3*1), round(2/3*1)] = [0, 1] here,
    # which already doesn't collide -- use n where both picks land on the same
    # index (n=1: (n-1)=0 for every i) to exercise the dedup path.
    resp = client.post(
        "/process",
        files=[
            ("screen", ("screen.webm", io.BytesIO(b"x"), "video/webm")),
            ("frames", ("frame0.png", io.BytesIO(b"f0"), "image/png")),
        ],
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    wait_for_job(client, job_id)

    frames_dir = None
    for p in server_module.STORE.iterdir():
        candidate = p / "frames"
        if candidate.is_dir():
            frames_dir = candidate
            break
    assert frames_dir is not None
    saved = sorted(frames_dir.glob("frame_*.png"))
    assert len(saved) == 1


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
        def __init__(self, model_name, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1):
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
        def __init__(self, model_name, compute_type=None):
            pass

        def transcribe(self, path, beam_size=1):
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

    for job_id in job_ids:
        wait_for_job(client, job_id, timeout=5.0)

    assert max_concurrent["value"] == 1


def test_get_settings_returns_current_values_and_choices(client: TestClient):
    resp = client.get("/settings")
    assert resp.status_code == 200
    body = resp.json()
    assert "whisper_model" in body
    assert "storage_dir" in body
    assert "ollama_chat_model" in body
    values = {c["value"] for c in body["whisper_model_choices"]}
    assert values == {"tiny.en", "base.en", "small.en", "medium.en"}


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


def test_ollama_models_returns_installed_models(client: TestClient, monkeypatch):
    import app.server as server_module

    class FakeOllamaClient:
        def __init__(self, host):
            self.host = host

        def list(self):
            return {"models": [{"model": "llama3.1:8b"}, {"model": "llava:7b-v1.5-q4_K_M"}]}

    class FakeOllamaModule:
        Client = FakeOllamaClient

    monkeypatch.setitem(__import__("sys").modules, "ollama", FakeOllamaModule())

    resp = client.get("/ollama/models")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["models"] == ["llama3.1:8b", "llava:7b-v1.5-q4_K_M"]


def test_ollama_models_reports_unreachable(client: TestClient, monkeypatch):
    class FailingOllamaClient:
        def __init__(self, host):
            pass

        def list(self):
            raise ConnectionError("connection refused")

    class FailingOllamaModule:
        Client = FailingOllamaClient

    monkeypatch.setitem(__import__("sys").modules, "ollama", FailingOllamaModule())

    resp = client.get("/ollama/models")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert body["models"] == []
    assert "connection refused" in body["error"]


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
        def __init__(self, model_name, compute_type=None):
            captured["model_name"] = model_name

        def transcribe(self, path, beam_size=1):
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
