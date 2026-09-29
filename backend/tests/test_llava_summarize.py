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


# --- Long-transcript chunking (map-reduce) --------------------------------
#
# Regression tests for the transcript being cut at a fixed 12000 chars
# (~13 minutes of speech) before summarizing, with only a
# "[transcript truncated]" marker inside the prompt -- the notes and action
# items for a 1-hour meeting silently ignored ~75% of it.


class _FakeLLM:
    """Records every call and answers by prompt type, so a test can check
    which transcript lines reached the model and in how many calls."""

    def __init__(self, action_items_for=None):
        self.calls = []
        self.action_items_for = action_items_for or (lambda chunk: [])

    def list(self):
        return {"models": []}

    def chat(self, model, messages, options, stream, format=None):
        system = messages[0]["content"]
        user = messages[1]["content"]
        self.calls.append({"system": system, "user": user, "options": options, "format": format})
        if format == "json":
            import json
            return {"message": {"content": json.dumps({"action_items": self.action_items_for(user)})}}
        if "ONE PART" in system:
            return {"message": {"content": f"- partial notes #{len(self.calls)}"}}
        if "partial notes taken from consecutive parts" in system:
            return {"message": {"content": f"- merged notes #{len(self.calls)}"}}
        return {"message": {"content": "# Weekly Sync\n- final summary"}}


def _transcript(n_lines, width=100):
    # "Speaker: text" lines with a timestamp, like the speaker-labelled
    # transcript paths write -- each line is unique so a test can tell
    # exactly which lines were sent.
    lines = []
    for i in range(n_lines):
        prefix = f"[{i // 60:02d}:{i % 60:02d}] {'Alice' if i % 2 else 'Bob'}: line {i:05d} "
        lines.append(prefix + "x" * max(0, width - len(prefix)))
    return "\n".join(lines)


def _sent_transcript_lines(calls, system_marker):
    sent = []
    for call in calls:
        if system_marker in call["system"]:
            body = call["user"].split('"""')[1]
            sent.extend(body.split("\n"))
    return sent


def test_short_transcript_is_summarized_in_a_single_call_as_before(tmp_path):
    fake = _FakeLLM()
    progress = []
    txt = tmp_path / "t.txt"
    transcript = _transcript(50)  # ~5k chars
    txt.write_text(transcript, encoding="utf-8")

    md = llava_module.complete(raw_txt_path=str(txt), client=fake, on_progress=lambda d, t: progress.append((d, t)))

    assert md == "# Weekly Sync\n- final summary"
    assert len(fake.calls) == 1
    user = fake.calls[0]["user"]
    assert transcript in user
    assert user.startswith("Summarize the transcript into the template below.")
    assert "## Key Points" in user
    assert "truncated" not in user
    assert progress == []  # single call: nothing to count


def test_long_transcript_is_chunked_on_line_boundaries_and_every_line_is_summarized(tmp_path):
    fake = _FakeLLM()
    progress = []
    txt = tmp_path / "t.txt"
    transcript = _transcript(600)  # ~60k chars, ~1 hour of speech
    txt.write_text(transcript, encoding="utf-8")

    md = llava_module.complete(raw_txt_path=str(txt), client=fake, on_progress=lambda d, t: progress.append((d, t)))

    map_calls = [c for c in fake.calls if "ONE PART" in c["system"]]
    assert len(map_calls) >= 3
    # Every line reaches the model exactly once, whole, in order.
    assert _sent_transcript_lines(fake.calls, "ONE PART") == transcript.split("\n")
    # Each call's prompt fits the configured context (conservative 3 chars/token).
    for call in fake.calls:
        assert (len(call["system"]) + len(call["user"])) / 3 + call["options"]["num_predict"] <= call["options"]["num_ctx"]

    final = fake.calls[-1]
    assert "## Key Points" in final["user"]
    for i in range(len(map_calls)):
        assert f"Part {i + 1} of {len(map_calls)}" in final["user"]
    assert md == "# Weekly Sync\n- final summary"
    assert "covers only" not in md

    total = len(map_calls) + 1
    assert progress == [(i, total) for i in range(1, total + 1)]


def test_chunk_size_is_derived_from_num_ctx(tmp_path):
    txt = tmp_path / "t.txt"
    txt.write_text(_transcript(600), encoding="utf-8")

    small, big = _FakeLLM(), _FakeLLM()
    llava_module.complete(raw_txt_path=str(txt), client=small, num_ctx=8192)
    llava_module.complete(raw_txt_path=str(txt), client=big, num_ctx=32768)

    n_small = sum("ONE PART" in c["system"] for c in small.calls)
    n_big = sum("ONE PART" in c["system"] for c in big.calls)
    assert n_small >= 3
    # A 4x context fits this whole ~1-hour transcript in one call.
    assert n_big == 0 and len(big.calls) == 1


def test_very_long_transcript_reduces_partials_hierarchically(tmp_path, monkeypatch):
    # Partial notes big enough that they can't all fit the final call
    # together, forcing at least one intermediate merge round.
    class _VerboseFake(_FakeLLM):
        def chat(self, model, messages, options, stream, format=None):
            resp = super().chat(model, messages, options, stream, format)
            if "ONE PART" in messages[0]["content"]:
                resp = {"message": {"content": "- partial " + "y" * 6000}}
            return resp

    fake = _VerboseFake()
    txt = tmp_path / "t.txt"
    transcript = _transcript(3000)  # ~300k chars, ~5 hours
    txt.write_text(transcript, encoding="utf-8")

    md = llava_module.complete(raw_txt_path=str(txt), client=fake)

    assert _sent_transcript_lines(fake.calls, "ONE PART") == transcript.split("\n")
    assert any("partial notes taken from consecutive parts" in c["system"] for c in fake.calls)
    for call in fake.calls:
        assert (len(call["system"]) + len(call["user"])) / 3 + call["options"]["num_predict"] <= call["options"]["num_ctx"]
    assert md.startswith("# Weekly Sync")
    assert "covers only" not in md


def test_transcript_past_the_chunk_cap_says_so_visibly_in_the_notes(tmp_path, monkeypatch):
    monkeypatch.setattr(llava_module, "_MAX_CHUNKS", 2)
    fake = _FakeLLM()
    txt = tmp_path / "t.txt"
    out = tmp_path / "notes.md"
    txt.write_text(_transcript(600), encoding="utf-8")

    md = llava_module.complete(raw_txt_path=str(txt), out_path=str(out), client=fake, duration_seconds=3600)

    assert sum("ONE PART" in c["system"] for c in fake.calls) == 2
    # Title stays first (server.extract_title reads it), notice right under it.
    lines = md.split("\n")
    assert lines[0] == "# Weekly Sync"
    assert "covers only the first ~" in md and "minutes" in md
    assert out.read_text(encoding="utf-8") == md


def test_coverage_notice_without_duration_uses_percentage(tmp_path, monkeypatch):
    monkeypatch.setattr(llava_module, "_MAX_CHUNKS", 2)
    txt = tmp_path / "t.txt"
    txt.write_text(_transcript(600), encoding="utf-8")

    md = llava_module.complete(raw_txt_path=str(txt), client=_FakeLLM())

    assert "% of the transcript" in md


def test_single_giant_line_is_split_at_sentence_boundaries(tmp_path):
    # The legacy transcription path joins every Whisper segment into ONE line.
    sentences = [f"Sentence number {i} is about topic {i}." for i in range(3000)]
    transcript = " ".join(sentences)
    fake = _FakeLLM()
    txt = tmp_path / "t.txt"
    txt.write_text(transcript, encoding="utf-8")

    llava_module.complete(raw_txt_path=str(txt), client=fake)

    sent = _sent_transcript_lines(fake.calls, "ONE PART")
    assert len(sent) > 1
    assert " ".join(sent) == transcript
    for piece in sent:
        assert piece.endswith(".")  # never cut mid-sentence


def test_split_transcript_never_cuts_a_line():
    transcript = _transcript(200)
    chunks = llava_module._split_transcript(transcript, 1000)
    assert all(len(c) <= 1000 for c in chunks)
    assert "\n".join(chunks) == transcript


def test_progress_callback_errors_do_not_fail_the_summary(tmp_path):
    txt = tmp_path / "t.txt"
    txt.write_text(_transcript(600), encoding="utf-8")

    def boom(done, total):
        raise RuntimeError("ui went away")

    md = llava_module.complete(raw_txt_path=str(txt), client=_FakeLLM(), on_progress=boom)
    assert md.startswith("# Weekly Sync")


def test_extract_action_items_short_transcript_is_a_single_call(tmp_path):
    fake = _FakeLLM(action_items_for=lambda user: [{"text": "Ship it", "owner": "Bob", "due": None}])
    txt = tmp_path / "t.txt"
    transcript = _transcript(50)
    txt.write_text(transcript, encoding="utf-8")

    result = llava_module.extract_action_items(raw_txt_path=str(txt), client=fake)

    assert result == [{"text": "Ship it", "owner": "Bob", "due": None}]
    assert len(fake.calls) == 1
    assert fake.calls[0]["user"].startswith("Extract action items from this transcript as JSON.")
    assert transcript in fake.calls[0]["user"]


def test_extract_action_items_long_transcript_covers_every_chunk_and_dedupes(tmp_path):
    def items_for(user):
        # One item unique to each chunk (keyed by its first line number),
        # plus a recap item every chunk repeats with varying case/punctuation
        # -- only the last mention carries the due date.
        first_line = user.split('"""')[1].split("\n")[0]
        n = first_line.split("line ")[1].split(" ")[0]
        return [
            {"text": f"Follow up on line {n}", "owner": None, "due": None},
            {"text": "Send the recap email!" if n != "00000" else "send the recap email", "owner": "Alice",
             "due": "Friday" if n != "00000" else None},
        ]

    fake = _FakeLLM(action_items_for=items_for)
    progress = []
    txt = tmp_path / "t.txt"
    transcript = _transcript(600)
    txt.write_text(transcript, encoding="utf-8")

    result = llava_module.extract_action_items(
        raw_txt_path=str(txt), client=fake, on_progress=lambda d, t: progress.append((d, t))
    )

    n_chunks = len(fake.calls)
    assert n_chunks >= 3
    assert _sent_transcript_lines(fake.calls, "extracting action items") == transcript.split("\n")
    follow_ups = [i for i in result if i["text"].startswith("Follow up")]
    assert len(follow_ups) == n_chunks
    recaps = [i for i in result if "recap" in i["text"].lower()]
    assert recaps == [{"text": "send the recap email", "owner": "Alice", "due": "Friday"}]
    assert result[0]["text"] == "Follow up on line 00000"  # meeting order kept
    assert progress == [(i, n_chunks) for i in range(1, n_chunks + 1)]


def test_extract_action_items_returns_none_if_any_chunk_fails_twice(tmp_path):
    class _OneBadChunk(_FakeLLM):
        def chat(self, model, messages, options, stream, format=None):
            if "part 2 of" in messages[1]["content"]:
                self.calls.append({"system": messages[0]["content"], "user": messages[1]["content"]})
                return {"message": {"content": "not json"}}
            return super().chat(model, messages, options, stream, format)

    txt = tmp_path / "t.txt"
    txt.write_text(_transcript(600), encoding="utf-8")

    assert llava_module.extract_action_items(raw_txt_path=str(txt), client=_OneBadChunk()) is None


def test_extract_action_items_falls_back_to_none_past_the_chunk_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(llava_module, "_MAX_CHUNKS", 2)
    fake = _FakeLLM()
    txt = tmp_path / "t.txt"
    txt.write_text(_transcript(600), encoding="utf-8")

    assert llava_module.extract_action_items(raw_txt_path=str(txt), client=fake) is None
    assert fake.calls == []
