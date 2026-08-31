import importlib

import httpx
import pytest
from PIL import Image

import app.LLaVA_summarize as llava_module


def test_complete_uses_passed_in_client_instead_of_module_default(tmp_path, monkeypatch):
    class _FakeClient:
        def list(self):
            return {"models": []}

        def chat(self, model, messages, options, stream):
            assert model == "gpt-4o-mini"
            return {"message": {"content": "custom summary"}}

    def fail_if_called():
        raise AssertionError("module _health_client should not have been used")

    monkeypatch.setattr(llava_module, "_assert_ollama_up", fail_if_called)

    txt_path = tmp_path / "raw.txt"
    txt_path.write_text("transcript text", encoding="utf-8")

    result = llava_module.complete(
        raw_txt_path=str(txt_path),
        model="gpt-4o-mini",
        client=_FakeClient(),
        stream=False,
    )
    assert result == "custom summary"


def test_extract_action_items_uses_passed_in_client_instead_of_module_default(tmp_path, monkeypatch):
    class _FakeClient:
        def list(self):
            return {"models": []}

        def chat(self, model, messages, options, stream, format):
            assert model == "gpt-4o-mini"
            return {"message": {"content": '{"action_items": []}'}}

    def fail_if_called():
        raise AssertionError("module _health_client should not have been used")

    monkeypatch.setattr(llava_module, "_assert_ollama_up", fail_if_called)

    txt_path = tmp_path / "raw.txt"
    txt_path.write_text("transcript text", encoding="utf-8")

    result = llava_module.extract_action_items(
        raw_txt_path=str(txt_path), model="gpt-4o-mini", client=_FakeClient()
    )
    assert result == []


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


def test_complete_truncates_transcript_to_max_chars(tmp_path, monkeypatch):
    """
    Regression test for brief 13 #2: `max_chars` was accepted but never
    applied -- a long transcript always went in whole, could blow past
    num_ctx, and Ollama silently truncated the WHOLE prompt (including the
    instructions/template that come after it). Now truncated up front.
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
    assert long_transcript not in user_content
    assert long_transcript[:100] in user_content
    assert "[transcript truncated]" in user_content
    # The instructions/template after the transcript must still be intact.
    assert "## Key Points" in user_content


def test_complete_does_not_truncate_a_transcript_under_max_chars(tmp_path, monkeypatch):
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    captured = {}

    def fake_chat(model, messages, options, stream):
        captured["messages"] = messages
        return {"message": {"content": "ok"}}

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    short_transcript = "hello world"
    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text(short_transcript, encoding="utf-8")

    llava_module.complete(raw_txt_path=str(transcript_path), frame_paths=[], max_chars=12000)

    user_content = captured["messages"][1]["content"]
    assert short_transcript in user_content
    assert "[transcript truncated]" not in user_content


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


def test_complete_does_not_force_cpu_only_inference(tmp_path, monkeypatch):
    """Regression test: options used to hardcode num_gpu=0, forcing CPU-only
    inference regardless of whether the user's hardware could run the model
    on GPU. Ollama should be left to use its own default GPU behavior.
    """
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    captured = {}

    def fake_chat(model, messages, options, stream):
        captured["options"] = options
        return {"message": {"content": "ok"}}

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("hello", encoding="utf-8")

    llava_module.complete(raw_txt_path=str(transcript_path), frame_paths=[])

    assert "num_gpu" not in captured["options"]


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


def test_extract_action_items_happy_path_returns_parsed_list(tmp_path, monkeypatch):
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    def fake_chat(model, messages, options, stream, format):
        assert format == "json"
        content = (
            '{"action_items": [{"text": "Send follow-up email", '
            '"owner": "Alice", "due": "Friday"}]}'
        )
        return {"message": {"content": content}}

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("Alice will send a follow-up email by Friday.", encoding="utf-8")

    result = llava_module.extract_action_items(raw_txt_path=str(transcript_path))

    assert result == [{"text": "Send follow-up email", "owner": "Alice", "due": "Friday"}]


def test_extract_action_items_returns_empty_list_when_model_finds_none(tmp_path, monkeypatch):
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    def fake_chat(model, messages, options, stream, format):
        return {"message": {"content": '{"action_items": []}'}}

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("Just a casual chat, nothing to do.", encoding="utf-8")

    result = llava_module.extract_action_items(raw_txt_path=str(transcript_path))

    assert result == []


def test_extract_action_items_parses_json_wrapped_in_prose_and_code_fence(tmp_path, monkeypatch):
    """A small local model asked for "only JSON" often doesn't comply
    literally -- the parser must pull the JSON object out of surrounding
    prose/markdown on the FIRST attempt, without needing the retry."""
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    calls = {"count": 0}

    def fake_chat(model, messages, options, stream, format):
        calls["count"] += 1
        content = (
            "Sure! Here is the JSON you asked for:\n"
            "```json\n"
            '{"action_items": [{"text": "Review the PR", "owner": null, "due": null}]}\n'
            "```\n"
            "Let me know if you need anything else."
        )
        return {"message": {"content": content}}

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("Someone should review the PR.", encoding="utf-8")

    result = llava_module.extract_action_items(raw_txt_path=str(transcript_path))

    assert result == [{"text": "Review the PR", "owner": None, "due": None}]
    assert calls["count"] == 1  # parsed on the first attempt -- no retry needed


def test_extract_action_items_retries_once_with_stricter_prompt_on_malformed_json(tmp_path, monkeypatch):
    """First attempt returns unparseable garbage; the retry uses a stricter
    prompt and succeeds. This is the core of the malformed-JSON fallback
    chain: retry once, don't give up after a single bad response."""
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    responses = [
        {"message": {"content": "Sorry, I can't help with that. Here's some notes instead..."}},
        {"message": {"content": '{"action_items": [{"text": "Ship the fix", "owner": null, "due": null}]}'}},
    ]
    captured_system_prompts = []

    def fake_chat(model, messages, options, stream, format):
        captured_system_prompts.append(messages[0]["content"])
        return responses.pop(0)

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("We need to ship the fix.", encoding="utf-8")

    result = llava_module.extract_action_items(raw_txt_path=str(transcript_path))

    assert result == [{"text": "Ship the fix", "owner": None, "due": None}]
    assert len(captured_system_prompts) == 2
    assert "STRICT MODE" not in captured_system_prompts[0]
    assert "STRICT MODE" in captured_system_prompts[1]


def test_extract_action_items_falls_back_to_none_when_both_attempts_malformed(tmp_path, monkeypatch):
    """Both the initial attempt AND the stricter retry return unparseable
    output -- extract_action_items must return None (not raise, not return
    a broken/partial result) so the caller can fall back to the prose
    notes rendering instead of showing a broken or empty checklist."""
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    calls = {"count": 0}

    def fake_chat(model, messages, options, stream, format):
        calls["count"] += 1
        return {"message": {"content": "not json at all, just rambling prose with no braces"}}

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("hello", encoding="utf-8")

    result = llava_module.extract_action_items(raw_txt_path=str(transcript_path))

    assert result is None
    assert calls["count"] == 2  # both the initial attempt and the retry ran


def test_extract_action_items_treats_missing_action_items_key_as_failure(tmp_path, monkeypatch):
    """Valid JSON, but the wrong shape (missing the action_items key
    entirely) -- must be treated the same as malformed JSON, not crash on a
    KeyError/TypeError trying to read it."""
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    def fake_chat(model, messages, options, stream, format):
        return {"message": {"content": '{"title": "Meeting", "notes": "some notes"}'}}

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("hello", encoding="utf-8")

    result = llava_module.extract_action_items(raw_txt_path=str(transcript_path))

    assert result is None


def test_extract_action_items_skips_entries_with_no_usable_text(tmp_path, monkeypatch):
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    def fake_chat(model, messages, options, stream, format):
        content = (
            '{"action_items": ['
            '{"text": "Real item", "owner": null, "due": null}, '
            '{"owner": "Bob", "due": null}, '
            '{"text": "   ", "owner": null, "due": null}, '
            '"Plain string item"'
            "]}"
        )
        return {"message": {"content": content}}

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("hello", encoding="utf-8")

    result = llava_module.extract_action_items(raw_txt_path=str(transcript_path))

    assert result == [
        {"text": "Real item", "owner": None, "due": None},
        {"text": "Plain string item", "owner": None, "due": None},
    ]


def test_extract_action_items_truncates_transcript_to_max_chars(tmp_path, monkeypatch):
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    captured = {}

    def fake_chat(model, messages, options, stream, format):
        captured["user_content"] = messages[1]["content"]
        return {"message": {"content": '{"action_items": []}'}}

    monkeypatch.setattr(llava_module._client, "chat", fake_chat)

    long_transcript = "word " * 5000
    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text(long_transcript, encoding="utf-8")

    llava_module.extract_action_items(raw_txt_path=str(transcript_path), max_chars=100)

    assert long_transcript not in captured["user_content"]
    assert "[transcript truncated]" in captured["user_content"]


def test_extract_action_items_does_not_retry_on_transport_failure(tmp_path, monkeypatch):
    """A network-level failure (Ollama down/timeout) is a different failure
    mode than malformed JSON -- it must propagate immediately (so the
    caller's existing summarization-failure handling deals with it), not
    burn a second attempt retrying a dead connection."""
    monkeypatch.setattr(llava_module._health_client, "list", lambda: {"models": []})

    calls = {"count": 0}

    def timing_out_chat(model, messages, options, stream, format):
        calls["count"] += 1
        raise httpx.ReadTimeout("timed out waiting for Ollama")

    monkeypatch.setattr(llava_module._client, "chat", timing_out_chat)

    transcript_path = tmp_path / "transcript.txt"
    transcript_path.write_text("hello", encoding="utf-8")

    with pytest.raises(httpx.ReadTimeout):
        llava_module.extract_action_items(raw_txt_path=str(transcript_path))

    assert calls["count"] == 1


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
