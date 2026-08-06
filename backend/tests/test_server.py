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
    # Redirect settings.json to a temp file so tests don't pollute/read the
    # real backend/app/settings.json in this checkout.
    monkeypatch.setattr(server_module, "SETTINGS_PATH", tmp_path / "settings.json")
    return TestClient(app)


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


def test_process_returns_friendly_500_when_mux_fails(client, monkeypatch):
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
    assert resp.status_code == 500
    assert resp.json()["detail"] == (
        "Couldn't combine your audio and video — the recording file may be "
        "corrupted. Try recording again."
    )


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


def test_process_dedupes_frame_indices_for_small_frame_count(client, monkeypatch):
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
    assert resp.status_code == 200

    frames_dir = None
    for p in server_module.STORE.iterdir():
        candidate = p / "frames"
        if candidate.is_dir():
            frames_dir = candidate
            break
    assert frames_dir is not None
    saved = sorted(frames_dir.glob("frame_*.png"))
    assert len(saved) == 1


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
    assert resp.status_code == 200
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
    assert resp.status_code == 200
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
