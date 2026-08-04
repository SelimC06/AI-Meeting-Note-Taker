import io
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.server as server_module
from app.server import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # Redirect uploads to a temp dir so tests don't pollute backend/app/uploads
    monkeypatch.setattr(server_module, "STORE", tmp_path)
    tmp_path.mkdir(exist_ok=True)
    return TestClient(app)


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


def test_process_falls_back_to_stub_notes_without_transcription(client, monkeypatch):
    # Force the "transcription helper unavailable" path that previously
    # caused a NameError on txt_path.
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

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "notes" in body
    assert "session" in body


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

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "notes" in body
    assert "session" in body

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
    assert resp.status_code == 200
    body = resp.json()
    assert "hello from existing transcript" in body["notes"]


def test_sessions_empty_when_no_index(client: TestClient):
    resp = client.get("/sessions")
    assert resp.status_code == 200
    assert resp.json() == []


def test_process_appends_to_sessions_and_get_sessions_returns_it(client, monkeypatch):
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

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 200
    session_id = resp.json()["session"]

    sessions_resp = client.get("/sessions")
    assert sessions_resp.status_code == 200
    sessions = sessions_resp.json()
    assert len(sessions) == 1
    entry = sessions[0]
    assert entry["id"] == session_id
    assert entry["notes"] == resp.json()["notes"]
    assert "created_at" in entry
    # created_at must be parseable ISO 8601
    datetime.fromisoformat(entry["created_at"])
    assert entry["title"]  # non-empty, extracted or fallback


def test_sessions_returns_newest_first(client, monkeypatch):
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

    ids = []
    for _ in range(2):
        resp = client.post(
            "/process",
            files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
        )
        ids.append(resp.json()["session"])

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
