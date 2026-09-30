import app.graph_chat as graph_chat
import app.graph_chat as graph_chat_module


def test_stream_graph_chat_reply_yields_full_response(monkeypatch):
    def fake_chat(model, messages, options, stream):
        assert stream is True
        yield {"message": {"content": "Across "}}
        yield {"message": {"content": "two meetings."}}

    # graph_chat streams through chat.py's shared client.
    monkeypatch.setattr(graph_chat_module._client, "chat", fake_chat)
    chunks = list(graph_chat.stream_graph_chat_reply("CTX", "what happened?", []))
    assert "".join(chunks) == "Across two meetings."


def test_prompt_includes_context_history_and_message(monkeypatch):
    captured = {}

    def fake_chat(model, messages, options, stream):
        captured["messages"] = messages
        yield {"message": {"content": "ok"}}

    monkeypatch.setattr(graph_chat_module._client, "chat", fake_chat)
    history = [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
    ]
    list(graph_chat.stream_graph_chat_reply("=== Meeting: Kickoff (2026-07-01) ===\nnotes here", "q2", history))
    messages = captured["messages"]
    assert messages[0]["role"] == "system"
    assert "MULTIPLE recorded meetings" in messages[0]["content"]
    assert "notes here" in messages[0]["content"]
    assert messages[1] == {"role": "user", "content": "q1"}
    assert messages[2] == {"role": "assistant", "content": "a1"}
    assert messages[-1] == {"role": "user", "content": "q2"}


def test_title_style_preamble_is_stripped_from_response(monkeypatch):
    def fake_chat(model, messages, options, stream):
        yield {"message": {"content": "Title: Meetings Summary\n"}}
        yield {"message": {"content": "----------------------\n\n"}}
        yield {"message": {"content": "The launch moved to September 1st."}}

    monkeypatch.setattr(graph_chat_module._client, "chat", fake_chat)
    result = "".join(graph_chat.stream_graph_chat_reply("CTX", "q", []))
    assert result == "The launch moved to September 1st."


def test_empty_chunks_are_skipped(monkeypatch):
    def fake_chat(model, messages, options, stream):
        yield {"message": {"content": ""}}
        yield {"message": {}}
        yield {"message": {"content": "x"}}

    monkeypatch.setattr(graph_chat_module._client, "chat", fake_chat)
    assert "".join(graph_chat.stream_graph_chat_reply("CTX", "q", [])) == "x"


def test_stream_graph_chat_reply_uses_passed_in_client_instead_of_module_default(monkeypatch):
    class _FakeClient:
        def chat(self, model, messages, options, stream):
            assert model == "gpt-4o-mini"
            yield {"message": {"content": "custom provider reply"}}

    def fail_if_called(*a, **k):
        raise AssertionError("module-level _client should not have been used")

    monkeypatch.setattr(graph_chat_module._client, "chat", fail_if_called)

    result = "".join(
        graph_chat.stream_graph_chat_reply(
            "context", "q", [], model="gpt-4o-mini", client=_FakeClient()
        )
    )
    assert result == "custom provider reply"
