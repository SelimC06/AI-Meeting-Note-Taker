import pytest
from PIL import Image

import app.LLaVA_summarize as llava_module


def test_complete_returns_markdown_and_writes_out_path(tmp_path, monkeypatch):
    monkeypatch.setattr(llava_module._client, "list", lambda: {"models": []})

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

    monkeypatch.setattr(llava_module._client, "list", fake_list)

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
    monkeypatch.setattr(llava_module._client, "list", lambda: {"models": []})

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
    monkeypatch.setattr(llava_module._client, "list", lambda: {"models": []})

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
    monkeypatch.setattr(llava_module._client, "list", lambda: {"models": []})

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
