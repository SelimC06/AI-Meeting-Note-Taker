from __future__ import annotations
import os, time, uuid, json, re
import threading
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

SENSITIVE_KEYS = {"password","token","code","client_secret","authorization","cookie","sid"}

def _redact(d: dict):
    out = {}
    for k, v in d.items():
        if k.lower() in SENSITIVE_KEYS: out[k] = "***"
        elif isinstance(v, dict): out[k] = _redact(v)
        elif isinstance(v, str) and re.search(r"(^|\s)Bearer\s+\S+", v, re.I): out[k] = "Bearer ***"
        else: out[k] = v
    return out

class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable):
        rid = request.headers.get("x-request-id") or str(uuid.uuid4())
        request.state.request_id = rid

        actor = "local"

        entry = {
            "ts": int(time.time()*1000),
            "rid": rid,
            "actor": actor or "anonymous",
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
            with _LOG_LOCK:
                with LOG_PATH.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(_redact(entry), ensure_ascii=False) + "\n")
        resp.headers["X-Request-Id"] = rid
        return resp
