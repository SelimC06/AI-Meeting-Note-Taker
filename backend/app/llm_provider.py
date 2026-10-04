"""Adapter for a generic OpenAI-compatible LLM endpoint (OpenAI,
OpenRouter, Groq, etc. -- anything exposing the standard
/chat/completions shape), used as an alternative to the local Ollama
server.

OpenAICompatClient deliberately mimics the subset of ollama.Client's
interface that chat.py, graph_chat.py, LLaVA_summarize.py, and
graph_extract.py already call (.chat(...), .list()) -- both the request
shape (model, messages, options, format, stream) and the response shape
({"message": {"content": ...}} for chat) match exactly, so none of those
modules need structural changes, only an optional client to use instead
of their own module-level Ollama client.
"""
from __future__ import annotations

import json
import threading
from typing import Any, Dict, Iterator, List, Optional, Tuple

import httpx

from . import ollama_client


class MissingBaseURLError(RuntimeError):
    pass


def _raise_for_status(resp, label: str = "Custom AI provider") -> None:
    """raise_for_status(), but with the provider's own error text in the
    message. httpx's default ("Client error '404 Not Found' for url ...")
    hides the useful part -- OpenAI-style APIs put the real reason ("The
    model `x` does not exist", "Invalid API key") in the JSON body, and that
    message is what ends up in the chat error line and the job log.
    `label` names the backend in that message: "Custom AI provider" for the
    user-configured endpoint, "Built-in AI model" when the same client
    drives the local llama-server (builtin_llm) -- telling a user their
    bundled model hit a "custom provider" error would send them hunting
    through settings they never touched.
    """
    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        detail = ""
        try:
            # A streamed response's body isn't loaded yet (.json()/.text
            # would raise ResponseNotRead); a no-op for a normal one.
            resp.read()
        except Exception:
            pass
        try:
            body = resp.json()
            err = body.get("error") if isinstance(body, dict) else None
            detail = err.get("message", "") if isinstance(err, dict) else (err or "")
        except Exception:
            try:
                detail = (resp.text or "")[:300]
            except Exception:
                detail = ""
        message = f"{label} returned HTTP {resp.status_code}"
        if detail:
            message += f": {detail}"
        try:
            request = e.request
        except RuntimeError:  # .request raises when it was never set
            request = None
        raise httpx.HTTPStatusError(message, request=request, response=e.response) from e


class OpenAICompatClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: httpx.Timeout,
        label: str = "Custom AI provider",
    ):
        self._base_url = (base_url or "").rstrip("/")
        self._label = label
        self._headers = {"Content-Type": "application/json"}
        # Only send Authorization when there's actually a key: the built-in
        # llama-server needs none, and an empty "Bearer " value is an
        # illegal header httpx refuses to send at all (LocalProtocolError).
        if api_key:
            self._headers["Authorization"] = f"Bearer {api_key}"
        self._client = httpx.Client(timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def _url(self, path: str) -> str:
        # Settings allow provider=custom with no URL yet (the UI saves the
        # provider choice before showing the URL field), so say what's
        # missing rather than letting httpx fail on a relative "/chat/...".
        if not self._base_url:
            raise MissingBaseURLError(
                "The custom AI provider has no base URL -- add one in Settings > AI provider."
            )
        return f"{self._base_url}{path}"

    def list(self) -> dict:
        """GET {base_url}/models, the same contract as ollama.Client.list().

        Kept for interface parity only -- nothing calls it as a pre-flight
        check any more: plenty of OpenAI-compatible providers and proxies
        don't implement /models, and a 404 there used to fail every chat
        (503) and every summary ("model not found") on a provider whose
        /chat/completions works fine.
        """
        resp = self._client.get(self._url("/models"), headers=self._headers)
        _raise_for_status(resp, self._label)
        return resp.json()

    def chat(
        self,
        model: str,
        messages: List[Dict[str, str]],
        options: Optional[Dict[str, Any]] = None,
        format: Any = None,
        stream: bool = False,
    ):
        payload: Dict[str, Any] = {"model": model, "messages": messages, "stream": stream}
        options = options or {}
        if "temperature" in options:
            payload["temperature"] = options["temperature"]
        if "num_predict" in options:
            payload["max_tokens"] = options["num_predict"]

        response_format = _translate_format(format)
        if response_format is not None:
            payload["response_format"] = response_format

        if stream:
            return self._stream_chat(payload)
        return self._chat_once(payload)

    def _chat_once(self, payload: Dict[str, Any]) -> dict:
        resp = self._client.post(
            self._url("/chat/completions"), headers=self._headers, json=payload
        )
        if resp.status_code == 400 and "response_format" in payload:
            # Not every OpenAI-compatible endpoint honors response_format
            # (especially json_schema mode) -- retry once without it
            # rather than failing outright. Callers already handle
            # malformed/unconstrained JSON downstream (schema-validation
            # fallbacks in graph_extract.py, the retry-with-stricter-prompt
            # in LLaVA_summarize.extract_action_items).
            retry_payload = {k: v for k, v in payload.items() if k != "response_format"}
            resp = self._client.post(
                self._url("/chat/completions"), headers=self._headers, json=retry_payload
            )
        _raise_for_status(resp, self._label)
        data = resp.json()
        content = data["choices"][0]["message"]["content"] or ""
        return {"message": {"content": content}}

    def _stream_chat(self, payload: Dict[str, Any]) -> Iterator[dict]:
        with self._client.stream(
            "POST", self._url("/chat/completions"), headers=self._headers, json=payload
        ) as resp:
            _raise_for_status(resp, self._label)
            for line in resp.iter_lines():
                if not line or not line.startswith("data: "):
                    continue
                data_str = line[len("data: "):].strip()
                if data_str == "[DONE]":
                    break
                chunk = json.loads(data_str)
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                content = delta.get("content") or ""
                if content:
                    yield {"message": {"content": content}}


def _translate_format(format: Any) -> Optional[Dict[str, Any]]:
    """Map Ollama's `format=` (either the literal "json" or a JSON schema
    dict) onto OpenAI's `response_format`. Returns None when no format
    was requested."""
    if format is None:
        return None
    if format == "json":
        return {"type": "json_object"}
    if isinstance(format, dict):
        # strict=False: the schemas passed here are Pydantic's
        # model_json_schema(), with optional/defaulted fields and no
        # "additionalProperties": false -- OpenAI's strict mode rejects
        # those outright (400), and the retry without response_format then
        # got prose. Non-strict still steers the model to the shape; the
        # callers validate the result themselves.
        return {
            "type": "json_schema",
            "json_schema": {"name": "response", "schema": format, "strict": False},
        }
    return None


# One OpenAICompatClient per distinct (base_url, api_key, read timeout),
# reused across calls. resolve_active_client used to build a new
# httpx.Client (its own connection pool) on every chat request, every
# summary job, and twice per knowledge-graph session, and nothing ever
# closed them. Entries for superseded settings stay until shutdown rather
# than being closed on a settings change: a job that snapshotted the old
# settings may still be mid-call on that client. That's bounded by how many
# times the user edits the connection settings in one run.
_clients: Dict[Tuple[str, str, float], OpenAICompatClient] = {}
_clients_lock = threading.Lock()


def _get_client(
    base: str, key: str, read_seconds: float, label: str = "Custom AI provider"
) -> OpenAICompatClient:
    # label isn't part of the cache key: it's derived from the provider, and
    # the builtin provider's base URL (its own loopback port) never collides
    # with a user-entered custom base URL.
    cache_key = (base, key, read_seconds)
    with _clients_lock:
        client = _clients.get(cache_key)
        if client is None:
            client = OpenAICompatClient(
                base, key, ollama_client.generation_timeout(read_seconds), label=label
            )
            _clients[cache_key] = client
        return client


def close_all_clients() -> None:
    """Close every cached client's connection pool (server.py's lifespan
    shutdown)."""
    with _clients_lock:
        clients = list(_clients.values())
        _clients.clear()
    for client in clients:
        try:
            client.close()
        except Exception:
            pass


def resolve_active_client(settings: Dict[str, Any]):
    """Pick which LLM backend a request/job should use, from a
    settings-shaped dict (the live settings globals in server.py, or a
    job's snapshotted `inputs` dict -- both carry the same keys).

    Returns (client, model). `client` is None for the Ollama path -- a
    deliberate sentinel meaning "the caller should use its own module-level
    Ollama client", preserving today's connection reuse and the separate
    short-timeout health client, rather than constructing a fresh one here.

    For ai_provider == "builtin" (the default), raises
    builtin_llm.NotReadyError when the bundled model server isn't serving
    yet (model not downloaded / downloading / starting / failed) -- callers
    turn that into a 503 (chat endpoints) or the raw-transcript fallback
    note (the processing job).
    """
    if settings.get("ai_provider") == "builtin":
        # Imported here, not at module top: builtin_llm imports bin_paths
        # and httpx-streams downloads; keeping it lazy means importing
        # llm_provider alone (tests, helper processes) never touches it.
        from . import builtin_llm

        base = builtin_llm.require_base_url()  # raises NotReadyError when not up
        read_seconds = ollama_client.resolve_timeout_seconds("llm_provider")
        return (
            _get_client(base, "", read_seconds, label="Built-in AI model"),
            builtin_llm.MODEL_ALIAS,
        )

    if settings.get("ai_provider") == "custom":
        base = settings.get("custom_api_base_url") or ""
        key = settings.get("custom_api_key") or ""
        model = settings.get("custom_model_name") or ""
        read_seconds = ollama_client.resolve_timeout_seconds("llm_provider")
        return _get_client(base, key, read_seconds), model

    return None, settings.get("ollama_chat_model", "")
