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
from typing import Any, Dict, Iterator, List, Optional

import httpx

from . import ollama_client


class OpenAICompatClient:
    def __init__(self, base_url: str, api_key: str, timeout: httpx.Timeout):
        self._base_url = (base_url or "").rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        self._client = httpx.Client(timeout=timeout)

    def list(self) -> dict:
        """Health check: GET {base_url}/models. Raises on failure, the
        same contract as ollama.Client.list()."""
        resp = self._client.get(f"{self._base_url}/models", headers=self._headers)
        resp.raise_for_status()
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
            f"{self._base_url}/chat/completions", headers=self._headers, json=payload
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
                f"{self._base_url}/chat/completions", headers=self._headers, json=retry_payload
            )
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"] or ""
        return {"message": {"content": content}}

    def _stream_chat(self, payload: Dict[str, Any]) -> Iterator[dict]:
        with self._client.stream(
            "POST", f"{self._base_url}/chat/completions", headers=self._headers, json=payload
        ) as resp:
            resp.raise_for_status()
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
        return {
            "type": "json_schema",
            "json_schema": {"name": "response", "schema": format, "strict": True},
        }
    return None


def resolve_active_client(settings: Dict[str, Any]):
    """Pick which LLM backend a request/job should use, from a
    settings-shaped dict (the live settings globals in server.py, or a
    job's snapshotted `inputs` dict -- both carry the same keys).

    Returns (client, model). `client` is None for the default Ollama
    path -- a deliberate sentinel meaning "the caller should use its own
    module-level Ollama client", preserving today's connection reuse and
    the separate short-timeout health client, rather than constructing a
    fresh one here.
    """
    if settings.get("ai_provider") == "custom":
        base = settings.get("custom_api_base_url") or ""
        key = settings.get("custom_api_key") or ""
        model = settings.get("custom_model_name") or ""
        timeout = ollama_client.generation_timeout(
            ollama_client.resolve_timeout_seconds("llm_provider")
        )
        return OpenAICompatClient(base, key, timeout), model

    return None, settings.get("ollama_chat_model", "")
