import json
import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import audit
from app.audit import AuditMiddleware


@pytest.fixture()
def app_with_failing_route():
    app = FastAPI()
    app.add_middleware(AuditMiddleware)

    @app.get("/boom")
    def boom():
        raise ValueError("kaboom")

    return app


def test_audit_middleware_propagates_original_exception(app_with_failing_route):
    client = TestClient(app_with_failing_route, raise_server_exceptions=True)

    with pytest.raises(ValueError, match="kaboom"):
        client.get("/boom")


def test_audit_log_concurrent_writes_do_not_corrupt_lines(tmp_path, monkeypatch):
    """
    Regression test: concurrent requests must not interleave partial writes
    into audit.jsonl. A controllable delay is injected mid-write (via a
    thin LOG_PATH wrapper) so that without _LOG_LOCK, two threads are
    GUARANTEED to interleave -- not a timing gamble.
    """
    real_path = tmp_path / "audit.jsonl"

    class _SlowWriteFile:
        def __init__(self, f):
            self._f = f

        def write(self, s):
            mid = len(s) // 2
            self._f.write(s[:mid])
            self._f.flush()
            time.sleep(0.02)
            self._f.write(s[mid:])

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            self._f.close()
            return False

    class _SlowLogPath:
        def open(self, mode, encoding=None):
            return _SlowWriteFile(real_path.open(mode, encoding=encoding))

    monkeypatch.setattr(audit, "LOG_PATH", _SlowLogPath())

    test_app = FastAPI()
    test_app.add_middleware(audit.AuditMiddleware)

    @test_app.get("/ping")
    def ping():
        return {"ok": True}

    client = TestClient(test_app)

    n = 8

    def hit():
        client.get("/ping", params={"pad": "x" * 500})

    threads = [threading.Thread(target=hit) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    lines = real_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == n
    for line in lines:
        json.loads(line)
