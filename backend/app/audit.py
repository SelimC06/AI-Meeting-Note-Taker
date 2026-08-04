from __future__ import annotations
import time, uuid, json, re
from pathlib import Path
from typing import Callable
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

LOG_DIR = Path(__file__).resolve().parent / "logs"
LOG_DIR.mkdir(exist_ok=True)
LOG_PATH = LOG_DIR / "audit.jsonl"

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
            with LOG_PATH.open("a", encoding="utf-8") as f:
                f.write(json.dumps(_redact(entry), ensure_ascii=False) + "\n")
        resp.headers["X-Request-Id"] = rid
        return resp
