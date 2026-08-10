from __future__ import annotations
import os, time, uuid, json, re
import threading
import anyio.to_thread
from pathlib import Path
from typing import Callable
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

# Mirrors server.py's ROOT resolution: when frozen (PyInstaller), this
# module's source lives inside the bundled archive rather than as a real
# file on disk, so `Path(__file__).resolve().parent` does not point at an
# existing directory and a plain mkdir() would raise FileNotFoundError.
# Falling back to APP_DATA_DIR (set by the launcher) keeps this writable
# both unfrozen and frozen.
_app_data_dir_env = os.getenv("APP_DATA_DIR")
_BASE_DIR = Path(_app_data_dir_env) if _app_data_dir_env else Path(__file__).resolve().parent
LOG_DIR = _BASE_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_PATH = LOG_DIR / "audit.jsonl"
_LOG_LOCK = threading.Lock()

# Simple size-based rotation: audit.jsonl otherwise grows unbounded for the
# life of the app. Keeps exactly one rotated file -- os.replace overwrites
# any previous .1 -- so this never grows past two files' worth.
_LOG_MAX_BYTES = 10 * 1024 * 1024
_LOG_ROTATED_PATH = LOG_DIR / "audit.jsonl.1"

SENSITIVE_KEYS = {"password","token","code","client_secret","authorization","cookie","sid"}

def _redact(d: dict):
    out = {}
    for k, v in d.items():
        if k.lower() in SENSITIVE_KEYS: out[k] = "***"
        elif isinstance(v, dict): out[k] = _redact(v)
        elif isinstance(v, str) and re.search(r"(^|\s)Bearer\s+\S+", v, re.I): out[k] = "Bearer ***"
        else: out[k] = v
    return out

def _write_log_entry(entry: dict) -> None:
    """Synchronous file I/O (rotation check + open/write) -- run off the
    event loop via anyio.to_thread.run_sync below. Running this directly on
    the event loop (as dispatch() used to) blocked it for the duration of
    every write, stalling every other concurrent request being served by
    the same loop.
    """
    with _LOG_LOCK:
        try:
            if LOG_PATH.exists() and LOG_PATH.stat().st_size >= _LOG_MAX_BYTES:
                os.replace(LOG_PATH, _LOG_ROTATED_PATH)
        except Exception:
            # Best-effort: rotation is a convenience, not a correctness
            # requirement -- LOG_PATH may not even support exists()/stat()
            # (e.g. a test double standing in for it), and any such failure
            # must never block the actual write below.
            pass
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(_redact(entry), ensure_ascii=False) + "\n")

class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable):
        rid = request.headers.get("x-request-id") or str(uuid.uuid4())
        request.state.request_id = rid

        entry = {
            "ts": int(time.time()*1000),
            "rid": rid,
            "actor": "local",
            "method": request.method,
            "path": request.url.path,
            "query": dict(request.query_params),
            "ip": request.client.host if request.client else None,
        }

        start_ns = time.perf_counter_ns()
        status_code = 500

        try:
            resp = await call_next(request)
            status_code = resp.status_code
        except Exception as e:
            entry.update({"error": repr(e)})
            raise
        finally:
            duration_ms = round((time.perf_counter_ns() - start_ns) / 1_000_000, 2)
            entry.update({
                "status": status_code,
                "duration_ms": duration_ms,
            })
            try:
                await anyio.to_thread.run_sync(_write_log_entry, entry)
            except Exception as log_err:
                # Best-effort: a logging failure (disk full, permissions)
                # must never take down the actual request.
                print(f"[audit] failed to write log entry: {log_err}", flush=True)
        resp.headers["X-Request-Id"] = rid
        return resp
