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


def test_audit_log_rotates_when_it_exceeds_the_size_cap(tmp_path, monkeypatch):
    """
    Regression test for brief 13 #6: audit.jsonl grew unbounded for the life
    of the app. Once it crosses the size cap, the next write must rotate the
    existing file aside (keeping exactly one rotated copy) before appending
    the new entry to a fresh file.
    """
    log_path = tmp_path / "audit.jsonl"
    rotated_path = tmp_path / "audit.jsonl.1"
    log_path.write_text("old entry\n", encoding="utf-8")

    monkeypatch.setattr(audit, "LOG_PATH", log_path)
    monkeypatch.setattr(audit, "_LOG_ROTATED_PATH", rotated_path)
    monkeypatch.setattr(audit, "_LOG_MAX_BYTES", 1)  # anything non-empty exceeds this

    test_app = FastAPI()
    test_app.add_middleware(audit.AuditMiddleware)

    @test_app.get("/ping")
    def ping():
        return {"ok": True}

    client = TestClient(test_app)
    client.get("/ping")

    assert rotated_path.read_text(encoding="utf-8") == "old entry\n"
    new_lines = log_path.read_text(encoding="utf-8").splitlines()
    assert len(new_lines) == 1
    json.loads(new_lines[0])


def test_audit_log_does_not_rotate_when_under_the_size_cap(tmp_path, monkeypatch):
    log_path = tmp_path / "audit.jsonl"
    rotated_path = tmp_path / "audit.jsonl.1"
    log_path.write_text("old entry\n", encoding="utf-8")

    monkeypatch.setattr(audit, "LOG_PATH", log_path)
    monkeypatch.setattr(audit, "_LOG_ROTATED_PATH", rotated_path)
    monkeypatch.setattr(audit, "_LOG_MAX_BYTES", 10 * 1024 * 1024)

    test_app = FastAPI()
    test_app.add_middleware(audit.AuditMiddleware)

    @test_app.get("/ping")
    def ping():
        return {"ok": True}

    client = TestClient(test_app)
    client.get("/ping")

    assert not rotated_path.exists()
    lines = log_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    assert lines[0] == "old entry"


def test_audit_entry_actor_is_local(tmp_path, monkeypatch):
    log_path = tmp_path / "audit.jsonl"
    monkeypatch.setattr(audit, "LOG_PATH", log_path)

    test_app = FastAPI()
    test_app.add_middleware(audit.AuditMiddleware)

    @test_app.get("/ping")
    def ping():
        return {"ok": True}

    client = TestClient(test_app)
    client.get("/ping")

    entry = json.loads(log_path.read_text(encoding="utf-8").splitlines()[0])
    assert entry["actor"] == "local"
