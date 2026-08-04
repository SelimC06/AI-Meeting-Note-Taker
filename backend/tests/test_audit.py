import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

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
