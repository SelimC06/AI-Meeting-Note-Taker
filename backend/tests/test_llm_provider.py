import httpx
import pytest

from app.llm_provider import OpenAICompatClient, resolve_active_client


def _client(monkeypatch_post=None, monkeypatch_stream=None, monkeypatch_get=None):
    c = OpenAICompatClient(
        "https://api.example.com/v1", "sk-test", httpx.Timeout(connect=5.0, read=30.0, write=30.0, pool=30.0)
    )
    if monkeypatch_post is not None:
        c._client.post = monkeypatch_post
    if monkeypatch_stream is not None:
        c._client.stream = monkeypatch_stream
    if monkeypatch_get is not None:
        c._client.get = monkeypatch_get
    return c


class _FakeResponse:
    def __init__(self, json_body, status_code=200):
        self._json_body = json_body
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("error", request=None, response=self)

    def json(self):
        return self._json_body


def test_chat_non_streaming_returns_ollama_shaped_message():
    def fake_post(url, headers=None, json=None):
        assert url == "https://api.example.com/v1/chat/completions"
        assert json["model"] == "gpt-4o-mini"
        assert json["stream"] is False
        return _FakeResponse({"choices": [{"message": {"content": "hello there"}}]})

    client = _client(monkeypatch_post=fake_post)
    result = client.chat(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "hi"}],
        options={"temperature": 0.3},
        stream=False,
    )
    assert result == {"message": {"content": "hello there"}}


def test_chat_sends_bearer_auth_header():
    captured = {}

    def fake_post(url, headers=None, json=None):
        captured["headers"] = headers
        return _FakeResponse({"choices": [{"message": {"content": "ok"}}]})

    client = _client(monkeypatch_post=fake_post)
    client.chat(model="m", messages=[], stream=False)
    assert captured["headers"]["Authorization"] == "Bearer sk-test"


def test_chat_streaming_yields_ollama_shaped_chunks():
    sse_lines = [
        'data: {"choices":[{"delta":{"content":"The "}}]}',
        'data: {"choices":[{"delta":{"content":"answer."}}]}',
        "data: [DONE]",
    ]

    class _FakeStreamCtx:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *a):
            return False

        def raise_for_status(self_inner):
            pass

        def iter_lines(self_inner):
            return iter(sse_lines)

    def fake_stream(method, url, headers=None, json=None):
        assert method == "POST"
        assert json["stream"] is True
        return _FakeStreamCtx()

    client = _client(monkeypatch_stream=fake_stream)
    chunks = list(
        client.chat(model="m", messages=[{"role": "user", "content": "hi"}], stream=True)
    )
    assert chunks == [{"message": {"content": "The "}}, {"message": {"content": "answer."}}]


def test_chat_streaming_skips_chunks_with_no_content():
    sse_lines = [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        'data: {"choices":[{"delta":{"content":"x"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
    ]

    class _FakeStreamCtx:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *a):
            return False

        def raise_for_status(self_inner):
            pass

        def iter_lines(self_inner):
            return iter(sse_lines)

    client = _client(monkeypatch_stream=lambda method, url, headers=None, json=None: _FakeStreamCtx())
    chunks = list(client.chat(model="m", messages=[], stream=True))
    assert chunks == [{"message": {"content": "x"}}]


def test_chat_translates_json_string_format_to_json_object_response_format():
    captured = {}

    def fake_post(url, headers=None, json=None):
        captured["payload"] = json
        return _FakeResponse({"choices": [{"message": {"content": "{}"}}]})

    client = _client(monkeypatch_post=fake_post)
    client.chat(model="m", messages=[], format="json", stream=False)
    assert captured["payload"]["response_format"] == {"type": "json_object"}


def test_chat_translates_schema_dict_format_to_json_schema_response_format():
    captured = {}

    def fake_post(url, headers=None, json=None):
        captured["payload"] = json
        return _FakeResponse({"choices": [{"message": {"content": "{}"}}]})

    client = _client(monkeypatch_post=fake_post)
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    client.chat(model="m", messages=[], format=schema, stream=False)
    assert captured["payload"]["response_format"]["type"] == "json_schema"
    assert captured["payload"]["response_format"]["json_schema"]["schema"] == schema


def test_chat_retries_once_without_response_format_on_400():
    calls = []

    def fake_post(url, headers=None, json=None):
        calls.append(json)
        if "response_format" in json:
            return _FakeResponse({"error": "unsupported"}, status_code=400)
        return _FakeResponse({"choices": [{"message": {"content": "ok"}}]})

    client = _client(monkeypatch_post=fake_post)
    result = client.chat(model="m", messages=[], format="json", stream=False)
    assert result == {"message": {"content": "ok"}}
    assert len(calls) == 2
    assert "response_format" in calls[0]
    assert "response_format" not in calls[1]


def test_chat_without_format_sends_no_response_format_key():
    captured = {}

    def fake_post(url, headers=None, json=None):
        captured["payload"] = json
        return _FakeResponse({"choices": [{"message": {"content": "ok"}}]})

    client = _client(monkeypatch_post=fake_post)
    client.chat(model="m", messages=[], stream=False)
    assert "response_format" not in captured["payload"]


def test_list_raises_on_http_error():
    def fake_get(url, headers=None):
        return _FakeResponse({}, status_code=500)

    client = _client(monkeypatch_get=fake_get)
    with pytest.raises(httpx.HTTPStatusError):
        client.list()


def test_list_returns_parsed_json_on_success():
    def fake_get(url, headers=None):
        assert url == "https://api.example.com/v1/models"
        return _FakeResponse({"data": [{"id": "gpt-4o-mini"}]})

    client = _client(monkeypatch_get=fake_get)
    assert client.list() == {"data": [{"id": "gpt-4o-mini"}]}


def test_resolve_active_client_returns_none_for_ollama_provider():
    settings = {
        "ai_provider": "ollama",
        "ollama_chat_model": "gemma3:4b",
        "custom_api_base_url": "",
        "custom_api_key": "",
        "custom_model_name": "",
    }
    client, model = resolve_active_client(settings)
    assert client is None
    assert model == "gemma3:4b"


def test_resolve_active_client_returns_openai_compat_client_for_custom_provider():
    settings = {
        "ai_provider": "custom",
        "ollama_chat_model": "gemma3:4b",
        "custom_api_base_url": "https://api.openai.com/v1",
        "custom_api_key": "sk-test",
        "custom_model_name": "gpt-4o-mini",
    }
    client, model = resolve_active_client(settings)
    assert isinstance(client, OpenAICompatClient)
    assert model == "gpt-4o-mini"
    assert client._base_url == "https://api.openai.com/v1"
