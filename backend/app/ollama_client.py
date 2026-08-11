from __future__ import annotations
import os
import httpx
import ollama

_DEFAULT_OLLAMA_TIMEOUT_SECONDS = 300.0


def resolve_ollama_base() -> str:
    return os.getenv("OLLAMA_BASE_URL") or os.getenv("OLLAMA_HOST") or "http://localhost:11434"


def resolve_timeout_seconds(caller: str) -> float:
    """Read OLLAMA_TIMEOUT_SECONDS, falling back to the default on anything
    non-numeric instead of crashing the whole backend at import time."""
    raw = os.getenv("OLLAMA_TIMEOUT_SECONDS", _DEFAULT_OLLAMA_TIMEOUT_SECONDS)
    try:
        return float(raw)
    except ValueError:
        print(
            f"[{caller}] ignoring non-numeric OLLAMA_TIMEOUT_SECONDS={os.environ['OLLAMA_TIMEOUT_SECONDS']!r}, "
            f"using default {_DEFAULT_OLLAMA_TIMEOUT_SECONDS}s",
            flush=True,
        )
        return _DEFAULT_OLLAMA_TIMEOUT_SECONDS


def health_timeout() -> httpx.Timeout:
    # Short and fixed: health checks are polled frequently (including by
    # /health) and must fail fast rather than exhausting the threadpool.
    return httpx.Timeout(connect=5.0, read=5.0, write=5.0, pool=5.0)


def generation_timeout(read_seconds: float) -> httpx.Timeout:
    # Generous and configurable: local models can legitimately take minutes
    # to produce a first token after a cold load.
    return httpx.Timeout(connect=5.0, read=read_seconds, write=30.0, pool=30.0)


def make_health_client(base: str) -> ollama.Client:
    return ollama.Client(host=base, timeout=health_timeout())


def make_generation_client(base: str, read_seconds: float) -> ollama.Client:
    # ollama.Client defaults to timeout=None, which disables httpx's timeout
    # entirely -- a wedged Ollama then blocks whichever thread called it
    # forever. This client and make_health_client's are kept as separate
    # instances by callers so the health check's short timeout can never be
    # affected by (or fight with) whatever timeout a concurrent generation
    # call needs.
    return ollama.Client(host=base, timeout=generation_timeout(read_seconds))
