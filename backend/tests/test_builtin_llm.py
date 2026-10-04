import contextlib
import hashlib

import pytest

from app import builtin_llm
from app.llm_provider import OpenAICompatClient, resolve_active_client


@pytest.fixture(autouse=True)
def _reset_builtin_state(tmp_path):
    """builtin_llm keeps module-level state (same convention as
    settings_store's SAVE_LOCK); point it at a temp models dir and put it
    back to a cold "idle" after each test so nothing leaks across tests --
    or into test_server.py's module-level AI_PROVIDER pin."""
    builtin_llm.configure(tmp_path / "models")

    def _cold():
        with builtin_llm._LOCK:
            builtin_llm._STATE = "idle"
            builtin_llm._ERROR = None
            builtin_llm._DOWNLOADED_BYTES = 0
            builtin_llm._PROC = None
            builtin_llm._PORT = None
            builtin_llm._WORKER = None

    _cold()
    yield
    _cold()


def _force(state, *, error=None, port=None, downloaded_bytes=0):
    with builtin_llm._LOCK:
        builtin_llm._STATE = state
        builtin_llm._ERROR = error
        builtin_llm._PORT = port
        builtin_llm._DOWNLOADED_BYTES = downloaded_bytes


def test_initial_status_is_idle_with_no_progress():
    status = builtin_llm.status()
    assert status["state"] == "idle"
    assert status["error"] is None
    assert status["progress"] is None
    assert status["model_downloaded"] is False
    assert status["model"]["size_bytes"] == builtin_llm.MODEL["size_bytes"]


def test_status_reports_progress_only_while_downloading():
    _force("downloading", downloaded_bytes=1234)
    status = builtin_llm.status()
    assert status["progress"] == {
        "downloaded_bytes": 1234,
        "total_bytes": builtin_llm.MODEL["size_bytes"],
    }
    _force("starting")
    assert builtin_llm.status()["progress"] is None


def test_model_is_downloaded_requires_the_exact_pinned_size():
    path = builtin_llm.model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"truncated")
    assert builtin_llm.model_is_downloaded() is False


def test_base_url_only_when_ready():
    assert builtin_llm.base_url() is None
    _force("ready", port=43210)
    assert builtin_llm.base_url() == "http://127.0.0.1:43210/v1"
    # ready without a recorded port (can't happen in practice, but the
    # accessor must not fabricate a URL)
    _force("ready", port=None)
    assert builtin_llm.base_url() is None


@pytest.mark.parametrize(
    "state,needle",
    [
        ("idle", "isn't set up yet"),
        ("downloading", "downloading"),
        ("verifying", "verified"),
        ("starting", "starting up"),
        ("error", "failed to start"),
    ],
)
def test_readiness_message_names_what_is_happening(state, needle):
    _force(state, error="boom" if state == "error" else None)
    message = builtin_llm.readiness_message()
    assert message is not None
    assert needle in message


def test_readiness_message_is_none_when_ready():
    _force("ready", port=43210)
    assert builtin_llm.readiness_message() is None


def test_readiness_message_includes_download_percent():
    _force("downloading", downloaded_bytes=builtin_llm.MODEL["size_bytes"] // 2)
    assert "(50%)" in builtin_llm.readiness_message()


def test_require_base_url_raises_not_ready_with_the_message():
    with pytest.raises(builtin_llm.NotReadyError) as exc_info:
        builtin_llm.require_base_url()
    assert "isn't set up yet" in str(exc_info.value)


def test_start_if_downloaded_is_a_noop_without_the_model_file():
    builtin_llm.start_if_downloaded()
    with builtin_llm._LOCK:
        assert builtin_llm._STATE == "idle"
        assert builtin_llm._WORKER is None


def test_resolve_active_client_builtin_returns_openai_compat_client():
    _force("ready", port=43210)
    client, model = resolve_active_client({"ai_provider": "builtin"})
    try:
        assert isinstance(client, OpenAICompatClient)
        assert client._base_url == "http://127.0.0.1:43210/v1"
        assert client._label == "Built-in AI model"
        assert model == builtin_llm.MODEL_ALIAS
    finally:
        # The provider caches clients by base URL; drop this one so a later
        # test (or run) with the same fake port can't reuse a closed pool.
        from app import llm_provider

        with llm_provider._clients_lock:
            for key in [k for k in llm_provider._clients if k[0].endswith(":43210/v1")]:
                with contextlib.suppress(Exception):
                    llm_provider._clients.pop(key).close()


def test_resolve_active_client_builtin_raises_not_ready_when_down():
    with pytest.raises(builtin_llm.NotReadyError):
        resolve_active_client({"ai_provider": "builtin"})


def test_openai_compat_client_sends_no_auth_header_without_a_key():
    """The builtin provider has no API key; an empty 'Bearer ' value is an
    illegal header httpx refuses to send at all (LocalProtocolError), which
    broke every builtin chat call until the header was made conditional."""
    import httpx

    client = OpenAICompatClient("http://127.0.0.1:1/v1", "", httpx.Timeout(5.0))
    assert "Authorization" not in client._headers


def test_download_verification_rejects_a_corrupt_file(monkeypatch, tmp_path):
    """_download_model with a fully 'downloaded' .part whose hash doesn't
    match the pin: the file must be deleted and the error must say so --
    never renamed into place for llama-server to load."""
    payload = b"not the real model"
    monkeypatch.setitem(builtin_llm.MODEL, "size_bytes", len(payload))
    monkeypatch.setitem(builtin_llm.MODEL, "sha256", "0" * 64)

    path = builtin_llm.model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    part.write_bytes(payload)

    with pytest.raises(RuntimeError, match="integrity check"):
        builtin_llm._download_model()
    assert not part.exists()
    assert not path.exists()


def test_download_verification_accepts_a_matching_file(monkeypatch):
    payload = b"small fake model"
    monkeypatch.setitem(builtin_llm.MODEL, "size_bytes", len(payload))
    monkeypatch.setitem(builtin_llm.MODEL, "sha256", hashlib.sha256(payload).hexdigest())

    path = builtin_llm.model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    part.write_bytes(payload)

    builtin_llm._download_model()
    assert not part.exists()
    assert path.read_bytes() == payload
    assert builtin_llm.model_is_downloaded() is True


def test_wait_ready_does_not_wait_on_a_download():
    _force("downloading")
    # Must return immediately (False), not sit out the timeout.
    import time

    started = time.time()
    assert builtin_llm.wait_ready(5.0) is False
    assert time.time() - started < 1.0
