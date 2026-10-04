"""Built-in local LLM runtime: the zero-setup default AI provider.

Manages one bundled llama.cpp `llama-server` process plus the single pinned
GGUF model it serves, so a fresh install needs no Ollama (or any other
install step) for chat, summarization, and knowledge-graph extraction:

- The model file is downloaded once, on the user's explicit click in the
  onboarding gate (POST /builtin/setup), into <app data>/models/ -- resumable
  (HTTP Range against the .part file) and verified against a pinned SHA-256
  before it's ever loaded.
- `llama-server` is the binary vendored by scripts/fetch-llama.mjs (resolved
  via bin_paths.LLAMA_SERVER_BIN: env var in packaged builds, vendor/llama in
  a dev checkout, PATH otherwise). It exposes the standard OpenAI
  /v1/chat/completions shape on a loopback-only port, so the existing
  llm_provider.OpenAICompatClient drives it with no changes to chat.py,
  LLaVA_summarize.py, or graph_extract.py.
- Everything stays on this machine: the only network traffic this module
  ever makes is the one-time model download from the pinned URL.

All state lives at module level behind _LOCK (matching settings_store's
module-level SAVE_LOCK convention). The long operations (download, hash,
server boot) run on a single daemon worker thread and never hold the lock;
the lock only guards state transitions, so status() -- polled by the UI
every couple of seconds -- always answers instantly.
"""
from __future__ import annotations

import atexit
import hashlib
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

from .bin_paths import LLAMA_SERVER_BIN

# The one pinned model. gemma-3-4b-it matches the quality tier of the old
# Ollama default (gemma3:4b), so summaries/chat behave the same for users
# who never touch Settings. URL + SHA-256 + size come from HuggingFace's own
# LFS metadata for ggml-org/gemma-3-4b-it-GGUF (verified 2026-10-03); if the
# pin ever changes, update all three together -- _verify_sha256 refuses to
# load a file that doesn't match.
MODEL: Dict[str, Any] = {
    "name": "gemma-3-4b-it-Q4_K_M",
    "label": "Gemma 3 4B",
    "filename": "gemma-3-4b-it-Q4_K_M.gguf",
    "url": "https://huggingface.co/ggml-org/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf",
    "sha256": "882e8d2db44dc554fb0ea5077cb7e4bc49e7342a1f0da57901c0802ea21a0863",
    "size_bytes": 2489757856,
}

# Sent as the "model" field in OpenAI-shaped requests. llama-server serves
# exactly one model and accepts any name, so this is just a stable label
# that shows up in logs.
MODEL_ALIAS = "builtin"

# How long to wait for llama-server to answer /health with 200 after spawn.
# Loading ~2.5 GB of weights from a cold disk (or first-launch antivirus
# scanning, see main.js's health timeout comment) can legitimately take
# minutes; a crash is detected immediately via proc.poll() regardless.
_SERVER_BOOT_TIMEOUT_SECONDS = 600.0
_HEALTH_POLL_INTERVAL_SECONDS = 0.5


class NotReadyError(RuntimeError):
    """The built-in provider is selected but its server isn't serving yet
    (model missing, downloading, verifying, starting, or failed)."""


_LOCK = threading.RLock()
_STATE: str = "idle"  # idle | downloading | verifying | starting | ready | error
_ERROR: Optional[str] = None
_DOWNLOADED_BYTES: int = 0
_MODELS_DIR: Optional[Path] = None
_PROC: Optional[subprocess.Popen] = None
_PORT: Optional[int] = None
_WORKER: Optional[threading.Thread] = None


def configure(models_dir: Path) -> None:
    """Point this module at the directory the model lives in (ROOT/"models",
    i.e. the Electron userData dir in packaged builds). Called once at
    server import; never starts a download or a process by itself."""
    global _MODELS_DIR
    with _LOCK:
        _MODELS_DIR = Path(models_dir)


def _set_state(state: str, error: Optional[str] = None) -> None:
    global _STATE, _ERROR
    with _LOCK:
        _STATE = state
        _ERROR = error


def model_path() -> Path:
    with _LOCK:
        if _MODELS_DIR is None:
            raise RuntimeError("builtin_llm.configure() was never called")
        return _MODELS_DIR / MODEL["filename"]


def model_is_downloaded() -> bool:
    """The completed model file exists with exactly the pinned size. A file
    only ever appears at this path via os.replace after the SHA-256 check
    in _download_model, so size alone is enough here -- this runs on every
    status() poll and must not hash 2.5 GB each time."""
    try:
        path = model_path()
    except RuntimeError:
        return False
    try:
        return path.stat().st_size == MODEL["size_bytes"]
    except OSError:
        return False


def status() -> Dict[str, Any]:
    """Shape served by GET /builtin/status (and polled by the onboarding
    gate). `progress` is only non-null while downloading."""
    with _LOCK:
        state = _STATE
        error = _ERROR
        downloaded_bytes = _DOWNLOADED_BYTES
    progress = None
    if state == "downloading":
        progress = {
            "downloaded_bytes": downloaded_bytes,
            "total_bytes": MODEL["size_bytes"],
        }
    return {
        "state": state,
        "error": error,
        "progress": progress,
        "model": {
            "name": MODEL["name"],
            "label": MODEL["label"],
            "size_bytes": MODEL["size_bytes"],
        },
        "model_downloaded": model_is_downloaded(),
    }


def base_url() -> Optional[str]:
    """The OpenAI-compatible base URL (".../v1") when the server is ready,
    else None. OpenAICompatClient appends /chat/completions to this."""
    with _LOCK:
        if _STATE == "ready" and _PORT is not None:
            return f"http://127.0.0.1:{_PORT}/v1"
    return None


def readiness_message() -> Optional[str]:
    """Human-readable reason the provider can't serve yet; None when ready.
    Used verbatim in 503s from the chat endpoints and in the notes fallback
    explanation, so it must tell the user what to actually do."""
    with _LOCK:
        state = _STATE
        error = _ERROR
        downloaded_bytes = _DOWNLOADED_BYTES
    if state == "ready":
        return None
    if state == "downloading":
        pct = int(downloaded_bytes * 100 / MODEL["size_bytes"]) if MODEL["size_bytes"] else 0
        return f"The built-in AI model is still downloading ({pct}%) -- it will be available shortly."
    if state == "verifying":
        return "The built-in AI model download is being verified -- it will be available shortly."
    if state == "starting":
        return "The built-in AI model is starting up -- it will be available shortly."
    if state == "error":
        return f"The built-in AI model failed to start: {error}"
    return (
        "The built-in AI model isn't set up yet -- open DeskRecap and choose "
        "'Download model' (or pick another AI provider in Settings)."
    )


def require_base_url() -> str:
    url = base_url()
    if url is None:
        raise NotReadyError(readiness_message() or "The built-in AI model isn't ready yet.")
    return url


def start_setup() -> None:
    """Begin (or resume) the full setup: download if missing, verify, start
    the server. Idempotent -- a no-op while setup is already running or the
    server is already ready; an errored setup is retried from wherever it
    got to (a partial .part download resumes)."""
    _start_worker(allow_download=True)


def start_if_downloaded() -> None:
    """Start the server only when the model file is already on disk --
    never touches the network. Called at backend startup and when the user
    switches the provider to builtin, so an already-set-up install comes up
    with no interaction; a fresh install stays in "idle" for the onboarding
    gate to offer the download."""
    _start_worker(allow_download=False)


def _start_worker(allow_download: bool) -> None:
    global _WORKER
    with _LOCK:
        if _STATE in ("downloading", "verifying", "starting", "ready"):
            return
        if _WORKER is not None and _WORKER.is_alive():
            return
        if not allow_download and not model_is_downloaded():
            return
        # Transition out of idle/error under the lock so two concurrent
        # POST /builtin/setup calls can't both pass the check above.
        _set_state("downloading" if not model_is_downloaded() else "starting")
        _WORKER = threading.Thread(target=_run_setup, name="builtin-llm-setup", daemon=True)
        _WORKER.start()


def _run_setup() -> None:
    try:
        if not model_is_downloaded():
            _download_model()
        _set_state("starting")
        _spawn_server()
        _set_state("ready")
    except Exception as e:
        _kill_proc()
        _set_state("error", str(e))


def _download_model() -> None:
    global _DOWNLOADED_BYTES
    path = model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")

    pos = 0
    if part.exists():
        pos = part.stat().st_size
        if pos > MODEL["size_bytes"]:
            # Can't be a partial copy of the pinned file -- start over.
            part.unlink()
            pos = 0

    if pos < MODEL["size_bytes"]:
        _set_state("downloading")
        with _LOCK:
            _DOWNLOADED_BYTES = pos
        headers = {"Range": f"bytes={pos}-"} if pos else {}
        # Generous read timeout per chunk rather than per download: the
        # whole 2.5 GB transfer legitimately takes many minutes.
        timeout = httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=30.0)
        with httpx.stream(
            "GET", MODEL["url"], headers=headers, follow_redirects=True, timeout=timeout
        ) as resp:
            if resp.status_code == 200:
                mode = "wb"  # server ignored the Range; restart from zero
                pos = 0
                with _LOCK:
                    _DOWNLOADED_BYTES = 0
            elif resp.status_code == 206:
                mode = "ab"
            else:
                raise RuntimeError(f"Model download failed: HTTP {resp.status_code}")
            with open(part, mode) as f:
                for chunk in resp.iter_bytes(chunk_size=1024 * 1024):
                    f.write(chunk)
                    pos += len(chunk)
                    with _LOCK:
                        _DOWNLOADED_BYTES = pos

    actual_size = part.stat().st_size
    if actual_size != MODEL["size_bytes"]:
        raise RuntimeError(
            f"Model download ended early ({actual_size} of {MODEL['size_bytes']} bytes) -- "
            "check the connection and try again (the download resumes where it left off)."
        )

    _set_state("verifying")
    digest = _sha256_file(part)
    if digest != MODEL["sha256"]:
        # A corrupt file can't be resumed into a good one -- drop it so the
        # retry starts clean.
        part.unlink(missing_ok=True)
        raise RuntimeError(
            "The downloaded model failed its integrity check and was removed -- try again."
        )
    os.replace(part, path)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _log_path() -> Path:
    return model_path().parent / "llama-server.log"


def _log_tail(max_chars: int = 600) -> str:
    try:
        text = _log_path().read_text(encoding="utf-8", errors="replace")
        return text[-max_chars:].strip()
    except OSError:
        return ""


def _spawn_server() -> None:
    global _PROC, _PORT
    port = _pick_free_port()
    args = [
        LLAMA_SERVER_BIN,
        "-m", str(model_path()),
        "--host", "127.0.0.1",  # loopback only -- never reachable off-machine
        "--port", str(port),
        # Matches the num_ctx every caller passes (chat.py, graph_chat.py,
        # LLaVA_summarize.py all use 8192; OpenAICompatClient drops the
        # per-request num_ctx option, so the server-side value is what counts).
        "-c", "8192",
        # Offload everything to the GPU where a backend exists (Metal on
        # macOS); the CPU-only Windows build just logs a warning and runs.
        "-ngl", "99",
        "--jinja",
        "--no-webui",
    ]
    creationflags = 0
    if sys.platform == "win32":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    # One log file, truncated per boot: enough to quote in the error path
    # below and small enough to never need rotation.
    log_f = open(_log_path(), "wb")
    try:
        proc = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=log_f,
            stderr=subprocess.STDOUT,
            creationflags=creationflags,
        )
    except FileNotFoundError:
        log_f.close()
        raise RuntimeError(
            f"The bundled model server ({LLAMA_SERVER_BIN}) is missing. "
            "Reinstall DeskRecap, or run `npm run fetch:llama` in a dev checkout."
        )
    finally:
        # The child inherited the handle; the parent's copy isn't needed.
        if not log_f.closed:
            log_f.close()

    with _LOCK:
        _PROC = proc
        _PORT = port

    deadline = time.time() + _SERVER_BOOT_TIMEOUT_SECONDS
    health_url = f"http://127.0.0.1:{port}/health"
    with httpx.Client(timeout=httpx.Timeout(5.0)) as client:
        while time.time() < deadline:
            if proc.poll() is not None:
                tail = _log_tail()
                raise RuntimeError(
                    f"the local model server exited with code {proc.returncode}"
                    + (f": {tail}" if tail else "")
                )
            try:
                if client.get(health_url).status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(_HEALTH_POLL_INTERVAL_SECONDS)
    _kill_proc()
    raise RuntimeError(
        f"the local model server didn't become ready within "
        f"{int(_SERVER_BOOT_TIMEOUT_SECONDS)}s"
    )


def _kill_proc() -> None:
    global _PROC, _PORT
    with _LOCK:
        proc = _PROC
        _PROC = None
        _PORT = None
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
    except Exception:
        pass


def shutdown() -> None:
    """Stop the model server (lifespan shutdown, atexit, or the user
    switching to another provider -- the loaded model holds ~3 GB of RAM,
    so it's released rather than kept warm). The downloaded file stays; a
    later switch back is just a restart."""
    _kill_proc()
    with _LOCK:
        if _STATE != "error":
            _set_state("idle")


def wait_ready(timeout_seconds: float) -> bool:
    """Block while the server is in a fast transitional state (verifying /
    starting), up to the timeout. Deliberately does NOT wait on a download:
    the processing job that calls this would otherwise sit on 'summarizing'
    for however long 2.5 GB takes, looking stuck."""
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        with _LOCK:
            state = _STATE
        if state == "ready":
            return True
        if state not in ("verifying", "starting"):
            return False
        time.sleep(0.5)
    return False


# Backstop for exits that skip the FastAPI lifespan (uvicorn killed hard,
# dev Ctrl+C mid-boot): never leave a 3 GB llama-server orphaned.
atexit.register(_kill_proc)
