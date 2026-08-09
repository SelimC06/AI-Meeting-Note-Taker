import importlib

import httpx
import pytest
from PIL import Image

import app.LLaVA_summarize as llava_module


def test_complete_returns_markdown_and_writes_out_path(tmp_path, monkeypatch):
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    captured = {}

    def fake_chat(model, messages, options, stream):
        captured["messages"] = messages
        return {"message": {"content": "# Meeting\n- point one"}}

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("hello world", encoding="utf-8")
    out_path = tmp_path / "notes.md"

    result = llava_module.complete(
        raw_txt_path=str(transcript_path),
        out_path=str(out_path),
        frame_paths=[],
        stream=False,
    )

    assert result == "# Meeting\n- point one"
    assert out_path.read_text(encoding="utf-8") == "# Meeting\n- point one"

    user_content = captured["messages"][1]["content"]
    assert "hello world" in user_content
    assert "## Key Points" in user_content


def test_complete_propagates_error_when_ollama_unreachable(tmp_path, monkeypatch):
    def fake_list():
        raise ConnectionError("connection refused")

    monkeypatch.setattr(llava_module._health_client, "list", fake_list)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("hello", encoding="utf-8")

    with pytest.raises(ConnectionError):
        llava_module.complete(raw_txt_path=str(transcript_path), frame_paths=[])


def test_complete_max_chars_does_not_currently_truncate_transcript(tmp_path, monkeypatch):
    """
    Documents current behavior: `max_chars` is accepted but never applied in
    complete() -- the full transcript is always sent. Pre-existing bug,
    flagged not fixed (out of scope for this test-coverage task). If
    complete() is later changed to actually truncate, update this test to
    assert the truncation instead of the absence of it.
    """
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    captured = {}

    def fake_chat(model, messages, options, stream):
        captured["messages"] = messages
        return {"message": {"content": "ok"}}

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    long_transcript = "word " * 5000  # 30000 chars, far past max_chars=100
    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text(long_transcript, encoding="utf-8")

    llava_module.complete(raw_txt_path=str(transcript_path), frame_paths=[], max_chars=100)

    user_content = captured["messages"][1]["content"]
    assert long_transcript in user_content


def test_complete_skips_unreadable_frame_and_keeps_valid_ones(tmp_path, monkeypatch):
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    captured = {}

    def fake_chat(model, messages, options, stream):
        captured["messages"] = messages
        return {"message": {"content": "ok"}}

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("hello", encoding="utf-8")

    good_frame = tmp_path / "good.png"
    Image.new("RGB", (10, 10), color=(255, 0, 0)).save(good_frame)
    bad_frame = tmp_path / "missing.png"  # never created

    llava_module.complete(
        raw_txt_path=str(transcript_path),
        frame_paths=[str(bad_frame), str(good_frame)],
        max_images=4,
    )

    sent_images = captured["messages"][1].get("images", [])
    assert len(sent_images) == 1


def test_complete_caps_images_at_max_images(tmp_path, monkeypatch):
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    captured = {}

    def fake_chat(model, messages, options, stream):
        captured["messages"] = messages
        return {"message": {"content": "ok"}}

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("hello", encoding="utf-8")

    frame_paths = []
    for i in range(5):
        p = tmp_path / f"frame{i}.png"
        Image.new("RGB", (10, 10), color=(i * 10, 0, 0)).save(p)
        frame_paths.append(str(p))

    llava_module.complete(raw_txt_path=str(transcript_path), frame_paths=frame_paths, max_images=2)

    sent_images = captured["messages"][1].get("images", [])
    assert len(sent_images) == 2


def test_health_client_uses_a_short_fixed_timeout_distinct_from_generation_client():
    health_timeout = llava_module._health_client._client.timeout
    assert health_timeout.connect == 5.0
    assert health_timeout.read == 5.0
    assert llava_module._client._client.timeout is not health_timeout


def test_generation_client_read_timeout_defaults_to_300_seconds():
    assert llava_module._client._client.timeout.read == 300.0
    assert llava_module._client._client.timeout.connect == 5.0


def test_generation_client_read_timeout_is_configurable_via_env(monkeypatch):
    monkeypatch.setenv("OLLAMA_TIMEOUT_SECONDS", "45")
    reloaded = importlib.reload(llava_module)
    try:
        assert reloaded._client._client.timeout.read == 45.0
    finally:
        monkeypatch.delenv("OLLAMA_TIMEOUT_SECONDS", raising=False)
        importlib.reload(llava_module)


def test_generation_client_falls_back_to_default_timeout_on_non_numeric_env(monkeypatch):
    """Regression test: OLLAMA_TIMEOUT_SECONDS='garbage' used to crash the
    whole backend at import time (float('garbage') raises uncaught) instead
    of just falling back to the default.
    """
    monkeypatch.setenv("OLLAMA_TIMEOUT_SECONDS", "not-a-number")
    try:
        reloaded = importlib.reload(llava_module)
        assert reloaded._client._client.timeout.read == 300.0
    finally:
        monkeypatch.delenv("OLLAMA_TIMEOUT_SECONDS", raising=False)
        importlib.reload(llava_module)


def test_complete_propagates_read_timeout_from_generation_call(tmp_path, monkeypatch):
    """A wedged Ollama must surface as a prompt httpx.ReadTimeout from the
    generation call (rather than hanging indefinitely) so the caller
    (server.py's job worker) can fall back to the raw transcript.
    """
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    def timing_out_chat(model, messages, options, stream):
        raise httpx.ReadTimeout("timed out waiting for Ollama")

    monkeypatch.setattr(llava_module._client, "chat", timing_out_chat)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("hello", encoding="utf-8")

    with pytest.raises(httpx.ReadTimeout):
        llava_module.complete(raw_txt_path=str(transcript_path), frame_paths=[])
