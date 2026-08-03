import app.chat as chat_module


def test_stream_chat_reply_yields_the_full_response(monkeypatch):
    def fake_chat(model, messages, options, stream):
        assert stream is True
        yield {"message": {"content": "The "}}
        yield {"message": {"content": "answer."}}

    monkeypatch.setattr(chat_module._client, "chat", fake_chat)

    chunks = list(chat_module.stream_chat_reply("hello notes", "what happened?", []))
    assert "".join(chunks) == "The answer."


def test_stream_chat_reply_prompt_includes_notes_and_message(monkeypatch):
    captured = {}

    def fake_chat(model, messages, options, stream):
        captured["messages"] = messages
        yield {"message": {"content": "ok"}}

    monkeypatch.setattr(chat_module._client, "chat", fake_chat)

    list(chat_module.stream_chat_reply("the meeting notes text", "what happened?", []))

    messages = captured["messages"]
    assert messages[0]["role"] == "system"
    assert "the meeting notes text" in messages[0]["content"]
    assert messages[-1] == {"role": "user", "content": "what happened?"}


def test_stream_chat_reply_includes_history_between_system_and_new_message(monkeypatch):
    captured = {}

    def fake_chat(model, messages, options, stream):
        captured["messages"] = messages
        yield {"message": {"content": "ok"}}

    monkeypatch.setattr(chat_module._client, "chat", fake_chat)

    history = [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
    ]
    list(chat_module.stream_chat_reply("notes", "q2", history))

    messages = captured["messages"]
    assert messages[1] == {"role": "user", "content": "q1"}
    assert messages[2] == {"role": "assistant", "content": "a1"}
    assert messages[-1] == {"role": "user", "content": "q2"}


def test_stream_chat_reply_skips_empty_chunks(monkeypatch):
    def fake_chat(model, messages, options, stream):
        yield {"message": {"content": ""}}
        yield {"message": {}}
        yield {"message": {"content": "x"}}

    monkeypatch.setattr(chat_module._client, "chat", fake_chat)
    assert "".join(chat_module.stream_chat_reply("n", "m", [])) == "x"


def test_stream_chat_reply_strips_leading_title_heading_from_notes(monkeypatch):
    captured = {}

    def fake_chat(model, messages, options, stream):
        captured["messages"] = messages
        yield {"message": {"content": "ok"}}

    monkeypatch.setattr(chat_module._client, "chat", fake_chat)

    notes = "# Title: Control HQ - Improving Meeting Efficiency\n\n## Key Points\n- discussed control issues"
    list(chat_module.stream_chat_reply(notes, "what did we say?", []))

    system_content = captured["messages"][0]["content"]
    assert "Control HQ" not in system_content
    assert "discussed control issues" in system_content


def test_strip_heading_no_op_when_no_leading_title():
    assert chat_module._strip_heading("no heading here\nmore text") == "no heading here\nmore text"


def test_stream_chat_reply_strips_title_style_preamble_from_response(monkeypatch):
    """Regression test: some local models open with a 'Title: ... ----'
    style preamble out of habit, even when told not to. This must be
    stripped from the model's actual output, not just prevented via prompt
    wording (prompting alone was tried and observed not to reliably work).
    """

    def fake_chat(model, messages, options, stream):
        yield {"message": {"content": "🔥 Title: Control HQ - Improving Meeting Efficiency\n"}}
        yield {"message": {"content": "----------------------\n\n"}}
        yield {"message": {"content": "The action items were to identify "}}
        yield {"message": {"content": "areas needing control."}}

    monkeypatch.setattr(chat_module._client, "chat", fake_chat)

    result = "".join(chat_module.stream_chat_reply("notes", "what were the action items?", []))
    assert "Title" not in result
    assert "Control HQ" not in result
    assert result == "The action items were to identify areas needing control."


def test_stream_chat_reply_passes_through_response_without_preamble(monkeypatch):
    def fake_chat(model, messages, options, stream):
        yield {"message": {"content": "There isn't a clear answer "}}
        yield {"message": {"content": "in the notes for that.\n\nWant me to check something else?"}}

    monkeypatch.setattr(chat_module._client, "chat", fake_chat)

    result = "".join(chat_module.stream_chat_reply("notes", "q", []))
    assert result == "There isn't a clear answer in the notes for that.\n\nWant me to check something else?"


def test_strip_title_preamble_no_op_on_plain_text():
    text = "This is just a normal answer with no heading."
    assert chat_module._strip_title_preamble(text) == text


def test_assert_ollama_up_calls_client_list(monkeypatch):
    calls = []
    monkeypatch.setattr(chat_module._client, "list", lambda: calls.append(True))
    chat_module.assert_ollama_up()
    assert calls == [True]
