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


# ---------- client reuse / shutdown ----------

from app import llm_provider


@pytest.fixture()
def fresh_client_cache(monkeypatch):
    monkeypatch.setattr(llm_provider, "_clients", {})
    yield
    llm_provider.close_all_clients()


def _custom(base="https://api.example.com/v1", key="sk-1"):
    return {
        "ai_provider": "custom", "ollama_chat_model": "", "custom_api_base_url": base,
        "custom_api_key": key, "custom_model_name": "m",
    }


def test_resolve_active_client_reuses_one_client_per_connection_settings(fresh_client_cache):
    a1, _ = resolve_active_client(_custom())
    a2, _ = resolve_active_client(_custom())
    b, _ = resolve_active_client(_custom(key="sk-2"))
    c, _ = resolve_active_client(_custom(base="https://other.example/v1"))

    assert a1 is a2
    assert len({id(a1), id(b), id(c)}) == 3


def test_resolve_active_client_keys_on_the_timeout_too(fresh_client_cache, monkeypatch):
    first, _ = resolve_active_client(_custom())
    monkeypatch.setenv("OLLAMA_TIMEOUT_SECONDS", "999")
    second, _ = resolve_active_client(_custom())
    assert first is not second


def test_close_all_clients_closes_and_forgets_them(fresh_client_cache):
    client, _ = resolve_active_client(_custom())

    llm_provider.close_all_clients()

    assert client._client.is_closed
    fresh, _ = resolve_active_client(_custom())
    assert fresh is not client and not fresh._client.is_closed


def test_server_shutdown_closes_cached_clients(fresh_client_cache):
    from fastapi.testclient import TestClient
    import app.server as server_module

    client, _ = resolve_active_client(_custom())
    with TestClient(server_module.app, base_url="http://127.0.0.1"):
        pass  # lifespan startup + shutdown

    assert client._client.is_closed


# ---------- errors ----------

def test_missing_base_url_fails_with_a_clear_message():
    c = OpenAICompatClient("", "sk", httpx.Timeout(5.0))
    with pytest.raises(llm_provider.MissingBaseURLError, match="no base URL"):
        c.chat(model="m", messages=[])
    with pytest.raises(llm_provider.MissingBaseURLError):
        list(c.chat(model="m", messages=[], stream=True))


def _mock_transport_client(handler):
    c = OpenAICompatClient("https://api.example.com/v1", "sk", httpx.Timeout(5.0))
    c._client = httpx.Client(transport=httpx.MockTransport(handler))
    return c


def test_http_error_carries_the_providers_own_message():
    c = _mock_transport_client(
        lambda request: httpx.Response(404, json={"error": {"message": "The model `gpt-9` does not exist"}})
    )
    with pytest.raises(httpx.HTTPStatusError, match="HTTP 404: The model `gpt-9` does not exist"):
        c.chat(model="gpt-9", messages=[])


def test_streaming_http_error_carries_the_providers_own_message():
    c = _mock_transport_client(lambda request: httpx.Response(401, text="Invalid API key"))
    with pytest.raises(httpx.HTTPStatusError, match="HTTP 401: Invalid API key"):
        list(c.chat(model="m", messages=[], stream=True))
