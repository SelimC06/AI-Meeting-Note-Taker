from __future__ import annotations
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import StreamingResponse, Response, FileResponse
from starlette.background import BackgroundTask
from .audit import AuditMiddleware
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import Scope, Receive, Send
from starlette.responses import PlainTextResponse
from pathlib import Path
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone
from contextlib import asynccontextmanager
import asyncio
import json
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import os
import uvicorn
import re
import zipfile

import httpx

from .sessions_store import (
    extract_title,
    load_sessions,
    append_session,
    update_session_fields,
    remove_session_permanently,
    purge_expired_trash,
    rewrite_index_paths,
    sweep_orphaned_sessions,
    sweep_stale_staging_dirs,
    sweep_stale_partial_mux_files,
    compute_storage_usage,
    STAGING_DIR_PREFIX,
)
from .settings_store import (
    SAVE_LOCK,
    WHISPER_MODEL_CHOICES,
    WHISPER_MODEL_VALUES,
    StorageMoveError,
    load_or_init as load_settings,
    move_storage_dir,
    save as save_settings,
)
from .bin_paths import FFMPEG_BIN, FFPROBE_BIN
from .whisper_cache import get_whisper_model
from . import jobs

try:
    from .ffmpeg_transcribe import stop_recording_and_transcribe  # type: ignore
except Exception:
    stop_recording_and_transcribe = None  # noqa: N816

try:
    from .LLaVA_summarize import complete as llava_complete  # type: ignore
except Exception:
    llava_complete = None

try:
    from .chat import assert_ollama_up, stream_chat_reply, OLLAMA_BASE, _health_client as ollama_health_client
except Exception:
    assert_ollama_up = None
    stream_chat_reply = None
    OLLAMA_BASE = "http://localhost:11434"
    ollama_health_client = None

_DAILY_PURGE_INTERVAL_SECONDS = 24 * 3600


async def _daily_trash_purge_loop() -> None:
    """Runs for the app's lifetime, purging expired trash once a day.

    purge_expired_trash also runs once synchronously at import time
    (below) -- that alone never re-fires on a machine that keeps the app
    running for weeks, silently breaking the "permanently deleted after
    30 days" promise. STORE is read fresh each iteration (module global,
    not captured), so it always targets wherever storage currently lives.
    """
    while True:
        await asyncio.sleep(_DAILY_PURGE_INTERVAL_SECONDS)
        try:
            await asyncio.to_thread(purge_expired_trash, STORE)
        except Exception as e:
            log(f"daily trash purge failed: {e}")


@asynccontextmanager
async def _lifespan(app: FastAPI):
    task = asyncio.create_task(_daily_trash_purge_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(lifespan=_lifespan)


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: List[ChatMessage] = []

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000,http://127.0.0.1:8000")

ORIGINS = [o.strip() for o in ALLOWED_ORIGINS.split(",") if o.strip()]

_DEFAULT_MAX_UPLOAD_MB = 2048
try:
    MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", _DEFAULT_MAX_UPLOAD_MB))
except ValueError:
    print(
        f"[server] ignoring non-numeric MAX_UPLOAD_MB={os.environ['MAX_UPLOAD_MB']!r}, "
        f"using default {_DEFAULT_MAX_UPLOAD_MB}",
        flush=True,
    )
    MAX_UPLOAD_MB = _DEFAULT_MAX_UPLOAD_MB
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024


class _UploadTooLarge(HTTPException):
    def __init__(self):
        super().__init__(413, f"Upload too large (max {MAX_UPLOAD_MB} MB)")


class MaxUploadSizeMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") != "POST" or scope.get("path") != "/process":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        content_length = headers.get(b"content-length")

        if content_length is not None:
            try:
                declared_size = int(content_length)
            except ValueError:
                response = PlainTextResponse("Invalid Content-Length header", status_code=400)
                await response(scope, receive, send)
                return
            if declared_size > MAX_UPLOAD_BYTES:
                response = PlainTextResponse(
                    f"Upload too large (max {MAX_UPLOAD_MB} MB)", status_code=413
                )
                await response(scope, receive, send)
                return
            await self.app(scope, receive, send)
            return

        # No Content-Length header (e.g. chunked transfer-encoding): the
        # declared-size check above can't run, so enforce the cap by
        # counting actual bytes as the body streams in instead.
        seen = 0

        async def limited_receive():
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body") or b"")
                if seen > MAX_UPLOAD_BYTES:
                    raise _UploadTooLarge()
            return message

        await self.app(scope, limited_receive, send)


# Outermost middleware (added first): CORS with an explicit origin list is
# a browser-enforced check only -- it does nothing against DNS rebinding
# (attacker.com resolving to 127.0.0.1), where the browser treats the
# request as same-origin and never applies CORS at all. TrustedHostMiddleware
# checks the Host header itself, which rebinding can't spoof. Starlette
# strips the port before comparing, so "localhost"/"127.0.0.1" alone cover
# every port -- a literal "host:*" pattern would fail its own wildcard
# validation (wildcards are only allowed as a leading "*.").
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])
app.add_middleware(MaxUploadSizeMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,  # ["http://localhost:1420", "http://localhost:5173", "tauri://localhost"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(AuditMiddleware)

_app_data_dir_env = os.getenv("APP_DATA_DIR")
ROOT = Path(_app_data_dir_env) if _app_data_dir_env else Path(__file__).resolve().parent
SETTINGS_PATH = ROOT / "settings.json"

# export_session_zip below builds its temp zip in the OS temp dir with this
# prefix, distinguishing it from anything else that might live there so
# _sweep_stale_export_zips can safely target only this app's own leaked
# files.
EXPORT_TEMP_PREFIX = "meeting-export-"


def _sweep_stale_export_zips(max_age_seconds: int = 3600) -> None:
    """Best-effort: removes export zips leaked by a previous run.

    export_session_zip's temp file is meant to be cleaned up either by its
    own except handler (if building the zip throws) or by the response's
    BackgroundTask (on a normal completed download) -- but a hard kill
    mid-build, or a client disconnecting mid-download (some Starlette
    versions skip the BackgroundTask for that), can leak it in the OS temp
    dir forever. Age-gated so a download actually in progress right now is
    never touched, and scoped to EXPORT_TEMP_PREFIX so this never touches
    anything else in that shared directory.
    """
    tmp_dir = Path(tempfile.gettempdir())
    cutoff = time.time() - max_age_seconds
    for entry in tmp_dir.glob(f"{EXPORT_TEMP_PREFIX}*.zip"):
        try:
            if entry.stat().st_mtime > cutoff:
                continue
            entry.unlink()
        except OSError:
            continue


_settings = load_settings(SETTINGS_PATH, ROOT / "uploads")
STORE = Path(_settings["storage_dir"])
STORE.mkdir(parents=True, exist_ok=True)
try:
    purge_expired_trash(STORE)
except Exception as e:
    print(f"[server] startup trash purge failed (continuing): {e}", flush=True)
try:
    sweep_orphaned_sessions(STORE)
except Exception as e:
    print(f"[server] startup orphan sweep failed (continuing): {e}", flush=True)
# Independent of the sessions index entirely -- runs regardless of whether
# the sweep above skipped due to a corrupt index.
try:
    sweep_stale_staging_dirs(STORE)
except Exception as e:
    print(f"[server] startup staging sweep failed (continuing): {e}", flush=True)
try:
    sweep_stale_partial_mux_files(STORE)
except Exception as e:
    print(f"[server] startup partial-mux sweep failed (continuing): {e}", flush=True)
_sweep_stale_export_zips()
WHISPER_MODEL = _settings["whisper_model"]
OLLAMA_CHAT_MODEL = _settings["ollama_chat_model"]

# Set for the duration of move_storage_dir inside patch_settings below.
# POST /process checks this and rejects with 503 rather than writing a
# fresh upload into a storage dir that's mid-move (jobs.is_busy() only
# blocks moves while a job already exists -- it says nothing about a
# request that arrives before one does).
move_in_progress = False

# Guards move_in_progress AND _active_uploads together: /process's
# "no move running -> count me as an active upload" and patch_settings'
# "no active uploads -> start the move" must each be atomic, or an upload
# and a move can slip past each other's checks (the old single top-of-
# request bool check left the entire minutes-long upload window open).
_store_state_lock = threading.Lock()
_active_uploads = 0

def log(msg: str) -> None:
    print(f"[server] {msg}", flush=True)


def run(cmd: List[str]) -> subprocess.CompletedProcess[str]:
    # encoding="utf-8" (not the default text=True, which decodes with the
    # ANSI locale codepage on Windows): ffmpeg/ffprobe emit UTF-8, including
    # file paths, so a storage folder with non-ASCII characters (e.g. under
    # a Turkish locale) raised UnicodeDecodeError here and 500'd every
    # upload. errors="replace" so a still-unexpected byte degrades a log
    # line instead of crashing the request.
    return subprocess.run(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace",
    )


def run_ffmpeg(args: List[str]) -> None:
    p = run([FFMPEG_BIN, "-y", *args])
    if p.returncode != 0:
        raise RuntimeError(p.stderr[-1200:] if p.stderr else "ffmpeg failed")


def ffprobe_ok(p: Path) -> bool:
    if not p.exists() or p.stat().st_size == 0:
        return False
    probe = run([FFPROBE_BIN, "-v", "error", "-show_streams", "-of", "json", str(p)])
    return probe.returncode == 0 and '"streams": [' in (probe.stdout or "")


def save_upload(dst_dir: Path, uf: Optional[UploadFile], name: str) -> Optional[Path]:
    """Save upload if present and valid; returns path or None."""
    if uf is None:
        return None
    out = dst_dir / name
    with out.open("wb") as f:
        shutil.copyfileobj(uf.file, f)
    size = out.stat().st_size
    valid = size != 0 and ffprobe_ok(out)
    if not valid:
        log(f"skip {name}: size={size}, valid={valid}")
        try:
            out.unlink()
        except Exception:
            pass
        return None
    log(f"saved {name} -> {out} ({size} bytes)")
    return out


def to_wav(src: Optional[Path], dst: Path, ar: int = 16000, ac: int = 1) -> Optional[Path]:
    if src is None:
        return None
    try:
        run_ffmpeg(["-i", str(src), "-ar", str(ar), "-ac", str(ac), str(dst)])
        return dst
    except Exception as e:
        log(f"to_wav failed for {src}: {e}")
        return None


def mix_audios_wav(system_wav: Optional[Path], mic_wav: Optional[Path], out_wav: Path) -> Optional[Path]:
    """Mix 0/1/2 wav inputs into a single wav; returns out_wav or None."""
    if system_wav and mic_wav:
        try:
            run_ffmpeg([
                "-i", str(system_wav),
                "-i", str(mic_wav),
                "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=3,volume=2.0",
                str(out_wav),
            ])
            return out_wav
        except Exception as e:
            log(f"mix failed: {e}")
            # fall through to one of the tracks below

    if system_wav:
        shutil.copy(system_wav, out_wav)
        return out_wav
    if mic_wav:
        shutil.copy(mic_wav, out_wav)
        return out_wav
    return None


def ffmpeg_has_encoder(name: str) -> bool:
    """Check `ffmpeg -encoders` output for an exact encoder name match.

    Matches on whitespace-delimited tokens (the encoder name is always the
    second column, after the capability flags) rather than a literal
    " name " substring, since real ffmpeg builds vary column separators
    between single spaces, multiple spaces, and tabs.
    """
    enc = run([FFMPEG_BIN, "-hide_banner", "-encoders"])
    if enc.returncode != 0 or not enc.stdout:
        return False
    for line in enc.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] == name:
            return True
    return False


def mux_video_audio(video: Path, audio: Optional[Path], out_path: Path) -> Path:
    """
    Mux video with audio safely:
      - Prefer WEBM with libopus
      - Fallback to WEBM with libvorbis
      - Fallback to MP4 with aac
    """
    if audio is None:
        # Same temp-then-promote as the ffmpeg branch below -- a crash or
        # disk-full mid-copy of an up-to-2GB screen.webm must never leave a
        # truncated final.webm behind for export to ship.
        tmp_out = out_path.with_name("." + out_path.name + ".part")
        try:
            shutil.copy(video, tmp_out)
        except Exception:
            tmp_out.unlink(missing_ok=True)
            raise
        os.replace(tmp_out, out_path)
        return out_path

    if ffmpeg_has_encoder("libopus"):
        acodec = "libopus"; container = "webm"
    elif ffmpeg_has_encoder("libvorbis"):
        acodec = "libvorbis"; container = "webm"
    elif ffmpeg_has_encoder("aac"):
        acodec = "aac"; container = "mp4"
    else:
        raise RuntimeError("No suitable audio encoder found (need libopus/libvorbis/aac in ffmpeg).")

    if out_path.suffix.lower().lstrip(".") != container:
        out_path = out_path.with_suffix(f".{container}")

    # Write to a temp name and promote only on success -- ffmpeg writing
    # directly to out_path left a partial final.* behind on failure (a failed
    # mux, e.g. disk full mid-write), which export's final.* glob then
    # happily shipped as "the recording". Leading dot keeps the temp name out
    # of export's sorted(glob("final.*")) fallback, which "final.webm.part"
    # (no dot) used to match.
    tmp_out = out_path.with_name("." + out_path.name + ".part")
    args = [
        "-i", str(video),
        "-i", str(audio),
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", acodec,
        "-f", container,
        str(tmp_out),
    ]
    p = run([FFMPEG_BIN, "-y", *args])
    if p.returncode != 0:
        tmp_out.unlink(missing_ok=True)
        raise RuntimeError(p.stderr[-1200:] if p.stderr else "mux failed")
    os.replace(tmp_out, out_path)
    return out_path

_OLLAMA_HEALTH_TTL_SECONDS = 10.0
_ollama_health = {"ok": False, "checked_at": 0.0}
_ollama_health_lock = threading.Lock()

def _ollama_health_cached() -> bool:
    # /health is polled by the Electron watchdog with a 3s abort -- it must
    # answer instantly, always. The real Ollama probe (worst case ~10s
    # against an unroutable host) used to run synchronously on whichever
    # request's TTL expired, stalling that one caller for the full probe.
    # Now the probe always runs on a background daemon thread and every
    # caller -- including the one whose TTL just expired -- gets the cached
    # value immediately. The lock guards "a refresh thread is already
    # running" (released by that thread, not by this function), so a plain
    # Lock is correct even though the acquire/release cross threads.
    # Bound to locals (not looked up via module globals inside _refresh) so
    # the background thread keeps operating on the exact lock/dict it
    # acquired even if something later reassigns the module-level names --
    # e.g. tests that importlib.reload(server_module) while a refresh from a
    # previous call is still in flight would otherwise have the thread
    # release a DIFFERENT, freshly-created (and unlocked) Lock object.
    health = _ollama_health
    lock = _ollama_health_lock
    now = time.time()
    if now - health["checked_at"] >= _OLLAMA_HEALTH_TTL_SECONDS:
        if lock.acquire(blocking=False):
            def _refresh():
                try:
                    ok = assert_ollama_up is not None
                    if ok:
                        try:
                            assert_ollama_up()
                        except Exception:
                            ok = False
                    health["ok"] = ok
                    health["checked_at"] = time.time()
                finally:
                    lock.release()
            try:
                threading.Thread(target=_refresh, daemon=True).start()
            except RuntimeError:
                # Thread creation failed (resource exhaustion) -- release so a
                # later call can retry, and serve the stale value meanwhile.
                lock.release()
    return health["ok"]

@app.get("/health")
@app.get("/healthz")
def health():
    return {"ok": True, "backend": True, "ollama": _ollama_health_cached()}

@app.get("/")
def root():
    return {"service": "meeting-api", "ok": True}

def _get_session_or_404(store: Path, session_id: str) -> dict:
    for record in load_sessions(store):
        if record.get("id") == session_id:
            return record
    raise HTTPException(404, "Session not found")


@app.get("/sessions")
def sessions(include_trashed: bool = False):
    store = STORE
    all_sessions = load_sessions(store)
    if not include_trashed:
        all_sessions = [s for s in all_sessions if not s.get("trashed_at")]
    return sorted(all_sessions, key=lambda r: r.get("created_at", ""), reverse=True)


class SessionRename(BaseModel):
    title: str


@app.patch("/sessions/{session_id}")
def rename_session(session_id: str, body: SessionRename):
    title = body.title.strip()
    if not title:
        raise HTTPException(400, "Title cannot be empty")
    store = STORE
    ok = update_session_fields(store, session_id, title=title)
    if not ok:
        raise HTTPException(404, "Session not found")
    # A concurrent DELETE landed between the update above and this re-read --
    # report the same 404 a request that arrived slightly later would get,
    # instead of an IndexError -> 500.
    return _get_session_or_404(store, session_id)


@app.post("/sessions/{session_id}/trash")
def trash_session(session_id: str):
    store = STORE
    record = _get_session_or_404(store, session_id)
    if not record.get("trashed_at"):
        update_session_fields(store, session_id, trashed_at=datetime.now(timezone.utc).isoformat())
    # A concurrent DELETE landed between the update above and this re-read --
    # report the same 404 a request that arrived slightly later would get,
    # instead of an IndexError -> 500.
    return _get_session_or_404(store, session_id)


@app.post("/sessions/{session_id}/restore")
def restore_session(session_id: str):
    store = STORE
    ok = update_session_fields(store, session_id, trashed_at=None)
    if not ok:
        raise HTTPException(404, "Session not found")
    # A concurrent DELETE landed between the update above and this re-read --
    # report the same 404 a request that arrived slightly later would get,
    # instead of an IndexError -> 500.
    return _get_session_or_404(store, session_id)


@app.delete("/sessions/{session_id}")
def delete_session(session_id: str):
    store = STORE
    ok = remove_session_permanently(store, session_id)
    if not ok:
        raise HTTPException(404, "Session not found")
    return {"ok": True}


class SettingsUpdate(BaseModel):
    whisper_model: Optional[str] = None
    storage_dir: Optional[str] = None
    ollama_chat_model: Optional[str] = None


@app.get("/settings")
def get_settings():
    # Return the live in-memory globals rather than re-reading settings.json:
    # if that file is ever deleted/corrupted while the server is running,
    # re-reading it here would re-seed+persist defaults (e.g. storage_dir
    # back to ROOT/"uploads") even though STORE still correctly points at
    # the user's actual chosen folder, causing this endpoint to report the
    # wrong value and a subsequent PATCH to merge onto the stale re-seed.
    return {
        "whisper_model": WHISPER_MODEL,
        "storage_dir": str(STORE),
        "ollama_chat_model": OLLAMA_CHAT_MODEL,
        "whisper_model_choices": WHISPER_MODEL_CHOICES,
    }


@app.patch("/settings")
def patch_settings(body: SettingsUpdate):
    global STORE, WHISPER_MODEL, OLLAMA_CHAT_MODEL, move_in_progress

    if body.whisper_model is not None and body.whisper_model not in WHISPER_MODEL_VALUES:
        raise HTTPException(400, f"Invalid whisper_model: {body.whisper_model!r}")

    if body.storage_dir is not None and not Path(body.storage_dir).is_absolute():
        raise HTTPException(400, "Storage folder must be an absolute path")

    # Hold SAVE_LOCK across the move AND the save AND the global reassignment
    # so a second concurrent PATCH /settings changing storage_dir can't start
    # its own move_storage_dir against the same source directory while this
    # one is still in flight (SAVE_LOCK is an RLock, so save_settings()
    # re-acquiring it below on the same thread is safe).
    with SAVE_LOCK:
        # Build the merge base from the current LIVE globals (not a fresh disk
        # read via load_settings) so a corrupted/deleted settings.json can't
        # cause patch_settings to silently merge onto stale re-seeded defaults.
        # Passing a full dict as `updates` makes save_settings's internal
        # load_or_init-based merge a no-op on whatever is on disk.
        updates: dict = {
            "whisper_model": WHISPER_MODEL,
            "storage_dir": str(STORE),
            "ollama_chat_model": OLLAMA_CHAT_MODEL,
        }
        if body.whisper_model is not None:
            updates["whisper_model"] = body.whisper_model
        if body.ollama_chat_model is not None:
            updates["ollama_chat_model"] = body.ollama_chat_model

        if body.storage_dir is not None:
            new_dir = Path(body.storage_dir)
            # Reject rather than race the job worker: a mid-job move can
            # PermissionError on Windows (open file handles) or split the
            # session index across old/new dirs if the worker appends to a
            # re-created index in the old location after the move.
            if jobs.is_busy():
                raise HTTPException(409, "Wait for processing to finish before moving the storage folder")
            # jobs.is_busy() only blocks moves while a job is queued/running --
            # it says nothing about a fresh POST /process arriving DURING the
            # move itself (no job exists yet at that point), nor about an
            # upload already streaming in when the move starts. Both are
            # closed by _store_state_lock / _active_uploads below and
            # move_in_progress, which /process checks before registering
            # itself as an active upload.
            with _store_state_lock:
                if _active_uploads > 0:
                    raise HTTPException(409, "Wait for the current upload to finish before moving the storage folder")
                move_in_progress = True
            old_store_dir = STORE
            try:
                move_storage_dir(STORE, new_dir)
            except StorageMoveError as e:
                with _store_state_lock:
                    move_in_progress = False
                raise HTTPException(400, str(e))
            # Success: flip STORE and clear move_in_progress in ONE locked step --
            # clearing first (the old finally) let /process register an upload
            # against the old, emptied dir in the gap before the flip.
            with _store_state_lock:
                STORE = Path(new_dir)
                move_in_progress = False
            updates["storage_dir"] = str(new_dir)

        try:
            if body.storage_dir is not None:
                STORE.mkdir(parents=True, exist_ok=True)
                rewrite_index_paths(STORE, old_store_dir, STORE)
            settings = save_settings(SETTINGS_PATH, updates, ROOT / "uploads")
        except OSError as e:
            if body.storage_dir is not None:
                raise HTTPException(
                    500,
                    f"Recordings were moved to {updates['storage_dir']}, but saving "
                    f"settings.json failed: {e}. The app is using the new folder for now; "
                    "fix the settings file (or free disk space) and save settings again -- "
                    "otherwise the app will look in the old folder after a restart.",
                )
            raise HTTPException(500, f"Saving settings failed: {e}")

        STORE = Path(settings["storage_dir"])
        STORE.mkdir(parents=True, exist_ok=True)
        WHISPER_MODEL = settings["whisper_model"]
        OLLAMA_CHAT_MODEL = settings["ollama_chat_model"]

    return {**settings, "whisper_model_choices": WHISPER_MODEL_CHOICES}


@app.get("/storage/usage")
def storage_usage():
    return compute_storage_usage(STORE)


def _extract_ollama_model_names(list_response) -> List[str]:
    models = (
        list_response.get("models")
        if isinstance(list_response, dict)
        else getattr(list_response, "models", [])
    )
    names: List[str] = []
    for m in models or []:
        name = (
            (m.get("model") or m.get("name"))
            if isinstance(m, dict)
            else (getattr(m, "model", None) or getattr(m, "name", None))
        )
        if name:
            names.append(name)
    return names


@app.get("/ollama/models")
def ollama_models():
    # Reuses chat.py's timeout-protected health client instead of building a
    # fresh ollama.Client(...) per request -- that used to default to
    # timeout=None, so a wedged Ollama could hang this request (and every
    # thread handling one) forever, same as the /health and chat bugs.
    if ollama_health_client is None:
        return {"ok": False, "models": [], "error": "Ollama client unavailable on this server"}
    try:
        resp = ollama_health_client.list()
        return {"ok": True, "models": _extract_ollama_model_names(resp), "error": None}
    except Exception as e:
        return {"ok": False, "models": [], "error": str(e)}

@app.post("/chat/{session_id}")
def chat(session_id: str, body: ChatRequest):
    # Bind the settings-backed globals once so this request sees one
    # consistent snapshot even if a PATCH /settings lands mid-request.
    store = STORE
    chat_model = OLLAMA_CHAT_MODEL

    if stream_chat_reply is None or assert_ollama_up is None:
        raise HTTPException(503, "Chat is unavailable on this server")

    session_record = _get_session_or_404(store, session_id)

    try:
        assert_ollama_up()
    except Exception as e:
        raise HTTPException(503, f"Local model unavailable: {e}")

    history = [{"role": m.role, "content": m.content} for m in body.history]

    def token_stream():
        # NDJSON, one object per line: {"token": ...} for model output,
        # {"error": ...} for a mid-stream failure. Plain-text streaming made an
        # error indistinguishable from something the model said -- it got
        # rendered as assistant text and echoed back in the next turn's
        # history.
        try:
            for chunk in stream_chat_reply(session_record["notes"], body.message, history, model=chat_model):
                yield json.dumps({"token": chunk}) + "\n"
        except Exception as e:
            log(f"chat stream failed: {e}")
            yield json.dumps({"error": str(e)}) + "\n"

    return StreamingResponse(token_stream(), media_type="application/x-ndjson")

def _record_failed_session(session: Path, error: str) -> None:
    """Best-effort: append a status:"failed" session record so a failed
    job's already-saved recording data (screen/system/mic webm, whatever got
    this far) stays visible and deletable in the UI instead of leaking as an
    invisible, un-indexed orphan directory forever (brief 08).

    Indexes into the CURRENT global STORE (re-read here, not passed in from
    the job's enqueue-time snapshot) so a storage-dir move that lands between
    jobs can't split the index -- jobs.is_busy() blocks moves for the
    duration of this job's own run, but not the moment before it starts.
    """
    try:
        created_at = datetime.now(timezone.utc).isoformat()
        record = {
            "id": session.name,
            "created_at": created_at,
            "title": f"Failed recording ({created_at[:10]})",
            "notes": f"# Recording Failed\n\n_{error}_\n",
            "video_path": "",
            "trashed_at": None,
            "status": "failed",
            "error": error,
        }
        append_session(STORE, record)
    except Exception as append_err:
        log(f"failed to record failed session {session.name}: {append_err}")


def _run_process_job(job_id: str) -> None:
    inputs = jobs.get_job_inputs(job_id)
    if inputs is None:
        jobs.update_job(job_id, status="failed", error="Internal error: job inputs missing")
        return

    job = jobs.get_job(job_id)
    # store here is the enqueue-time snapshot of where files were physically
    # written -- correct for building paths to those already-saved files.
    # Indexing (append_session/_record_failed_session below) re-reads the
    # current global STORE instead, so it always targets wherever the index
    # currently lives even if a move landed in the gap before this job
    # started (jobs.is_busy() only blocks moves for this job's own duration).
    store = Path(inputs["store"])
    session = store / job["session_id"]
    screen_webm = Path(inputs["screen_webm"])
    system_webm = Path(inputs["system_webm"]) if inputs["system_webm"] else None
    mic_webm = Path(inputs["mic_webm"]) if inputs["mic_webm"] else None
    whisper_model = inputs["whisper_model"]
    # .get, not [...]: a job queued by an older build (or persisted across an
    # upgrade) has no "summary_model" key, and that must not crash the worker.
    summary_model = inputs.get("summary_model") or OLLAMA_CHAT_MODEL

    try:
        jobs.update_job(job_id, stage="muxing")

        system_wav = to_wav(system_webm, session / "system.wav")
        mic_wav = to_wav(mic_webm, session / "mic.wav")
        mixed_wav = mix_audios_wav(system_wav, mic_wav, session / "mixed.wav")

        try:
            final_path = mux_video_audio(screen_webm, mixed_wav, session / "final.webm")
        except Exception as e:
            log(f"mux failed: {e}")
            error = (
                "Couldn't combine your audio and video — the recording file may be "
                "corrupted. Try recording again."
            )
            _record_failed_session(session, error)
            jobs.update_job(job_id, status="failed", error=error)
            return

        notes: str = ""
        txt_path: Optional[str] = None
        jobs.update_job(job_id, stage="transcribing")
        if stop_recording_and_transcribe is not None:
            try:
                # extract_frames_after=False: summarization is text-only --
                # llava_complete below runs with no frame_paths, so extracting
                # frames here would just pollute the session dir (and the
                # export zip) with frame_%05d.png outputs nothing ever uses.
                txt_path, _ = stop_recording_and_transcribe(
                    video_path=str(final_path),
                    transcript_prefix=str(session / "transcript_"),
                    model_name=whisper_model,
                    separate_tracks=False,
                    extract_frames_after=False,
                )
            except Exception as e:
                log(f"stop_recording_and_transcribe failed, falling back to raw transcription: {e}")
                txt_path = None

        jobs.update_job(job_id, stage="summarizing")
        if txt_path is not None:
            try:
                if llava_complete is None:
                    raise RuntimeError("llava_complete import is None (summarizer missing)")

                notes = llava_complete(
                    raw_txt_path=txt_path,
                    # Summarization here is text-only (no frame_paths, see the
                    # comment above), so it runs on the configured chat model
                    # rather than LLaVA_summarize's vision-model default. That
                    # default is a SECOND model the user was never told to pull
                    # -- and when it wasn't installed, Ollama's 404 turned every
                    # single recording into "AI summarization failed", even
                    # though the chat model sitting right there could do the job.
                    model=summary_model,
                    out_path=str(session / "notes.md"),
                    max_chars=12000,
                    stream=False,
                    num_ctx=8192,
                    num_predict=800,
                    temperature=0.3,
                )
            except Exception as e:
                log(f"summarization failed, falling back to raw transcript: {e}")
                try:
                    transcript = Path(txt_path).read_text(encoding="utf-8")
                    # Without this, a timed-out (or otherwise failed) summary
                    # silently looks identical to a real AI summary that just
                    # happens to be the raw transcript -- the user has no way to
                    # tell the model never actually ran.
                    if isinstance(e, httpx.TimeoutException):
                        explanation = (
                            "_AI summarization timed out (the local model didn't "
                            "respond in time) -- showing the raw transcript instead._\n\n"
                        )
                    elif "not found" in str(e).lower():
                        # Ollama answers 404 for a model that was never pulled.
                        # Naming the model and the exact command beats a bare
                        # "failed", which gives the user nothing to act on.
                        explanation = (
                            f"_AI summarization failed: the model `{summary_model}` isn't "
                            "installed in Ollama -- showing the raw transcript instead. "
                            f"Run `ollama pull {summary_model}` to enable summaries._\n\n"
                        )
                    else:
                        explanation = (
                            "_AI summarization failed -- showing the raw transcript instead._\n\n"
                        )
                    notes = (
                        "# Title: Zoom Meeting\n\n"
                        + explanation
                        + "# Transcript (auto)\n"
                        + (transcript[:12000] or "(empty)")
                    )
                except Exception as read_err:
                    log(f"failed to read existing transcript {txt_path}: {read_err}")

        if not notes:
            try:
                from faster_whisper import WhisperModel
                # device="cpu" matches ffmpeg_transcribe.py's call exactly --
                # whisper_cache keys on the literal kwargs passed, and
                # WhisperModel's own default (device="auto") is a DIFFERENT
                # value than "cpu", not an equivalent one, so omitting it
                # here used to create a second cached model instance (and
                # double the RAM) for what's otherwise the same model.
                model = get_whisper_model(WhisperModel, whisper_model, device="cpu", compute_type="int8")
                segments, info = model.transcribe(str(final_path), beam_size=1)
                transcript = "\n".join(s.text.strip() for s in segments if s.text)
                notes = (
                    "# Title: Zoom Meeting\n\n"
                    "# Transcript (auto)\n"
                    + (transcript[:12000] or "(empty)")
                )
            except Exception as e:
                log(f"fallback whisper failed: {e}")
                notes = (
                    "# Title: Zoom Meeting\n\n"
                    "# Key Points\n- Uploaded, mixed and muxed successfully.\n"
                    f"- Final file: {final_path.name}\n"
                )

        jobs.update_job(job_id, stage="saving")
        record = {
            "id": session.name,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "title": extract_title(notes),
            "notes": notes,
            "video_path": str(final_path),
            "trashed_at": None,
            "status": "done",
        }
        append_session(STORE, record)

        jobs.update_job(job_id, status="done", notes=notes, video_path=str(final_path))
    except Exception as e:
        # Backstop for anything above that isn't already handled inline (mux
        # failure returns early with its own friendly message and record):
        # to_wav/mix_audios_wav/append_session/etc. raising here used to
        # propagate straight past this function to jobs.py's generic
        # worker-loop catch, which marks the job failed but has no idea a
        # session directory even exists -- leaving a (possibly multi-GB)
        # orphan dir invisible to the UI, excluded from trash purge, and
        # undeletable via DELETE /sessions/{id}.
        log(f"job {job_id} failed unexpectedly: {e}")
        error = f"Something went wrong while processing this recording: {e}"
        _record_failed_session(session, error)
        jobs.update_job(job_id, status="failed", error=error)


jobs.start_worker(_run_process_job)


@app.post("/process", status_code=202)
def process(
    screen: UploadFile | None = File(None),   # required logically, but optional type so 422 doesn't fire
    system: UploadFile | None = File(None),   # optional
    mic:    UploadFile | None = File(None),   # optional
):
    """
    Accepts blobs from the frontend:
      - screen (video/webm;codecs=vp8 recommended)
      - system (audio/webm;codecs=opus) [optional]
      - mic    (audio/webm;codecs=opus) [optional]

    Saves the uploads synchronously, then hands the slow ffmpeg/Whisper/
    LLaVA pipeline off to the background job queue (see _run_process_job)
    and returns immediately with a job id to poll via GET /jobs/{job_id}.

    Plain def, not async def: the body does multi-GB shutil.copyfileobj
    writes and blocking ffprobe subprocess calls with no `await` anywhere,
    so as an async def it ran that I/O directly on the event loop and
    stalled every other request (/health, /sessions, job polling) for the
    duration of an upload. FastAPI runs plain-def endpoints in its
    threadpool automatically, which fixes that without any other change.
    """
    # Checked-and-registered atomically under _store_state_lock: a move in
    # progress means STORE is about to (or has just started to) point
    # somewhere new while files are still being relocated -- writing an
    # upload into the old dir right now risks a partial move or a session
    # indexed with paths that no longer exist once the move finishes.
    # Registering as an active upload here (not just checking the flag) is
    # what closes the TOCTOU against patch_settings: a move can no longer
    # start once this request holds _active_uploads > 0, even though the
    # upload itself takes minutes and this check is instantaneous.
    global _active_uploads
    with _store_state_lock:
        if move_in_progress:
            raise HTTPException(503, "Storage folder is being moved -- try again in a moment")
        _active_uploads += 1
    try:
        # Bind STORE (and WHISPER_MODEL below) to locals once, at the top, so
        # this request sees one consistent snapshot of settings -- a PATCH
        # /settings changing storage_dir mid-request shouldn't split where the
        # video files land from where the session index entry gets appended.
        store = STORE
        whisper_model = WHISPER_MODEL
        summary_model = OLLAMA_CHAT_MODEL

        # Validate the screen upload fully before creating the permanent session
        # directory: staged in a scratch temp dir first (on the same filesystem
        # as `store`, so the move below is a cheap rename, not a multi-GB copy)
        # so a rejected upload (missing/invalid video) never leaves a
        # mkdir'd-but-otherwise-empty session folder behind (brief 08). The temp
        # dir is removed on the way out either way, success or rejection.
        with tempfile.TemporaryDirectory(prefix=STAGING_DIR_PREFIX, dir=store) as staging:
            staged_screen = save_upload(Path(staging), screen, "screen.webm")
            if not staged_screen:
                raise HTTPException(400, "valid screen video is required")

            session = store / uuid.uuid4().hex
            session.mkdir(parents=True, exist_ok=True)
            log(f"session: {session}")

            screen_webm = session / "screen.webm"
            shutil.move(str(staged_screen), str(screen_webm))

        system_webm = save_upload(session, system, "system.webm") if system else None
        mic_webm    = save_upload(session, mic,    "mic.webm")    if mic    else None

        job_id = jobs.create_job(
            session_id=session.name,
            inputs={
                "store": str(store),
                "screen_webm": str(screen_webm),
                "system_webm": str(system_webm) if system_webm else None,
                "mic_webm": str(mic_webm) if mic_webm else None,
                "whisper_model": whisper_model,
                "summary_model": summary_model,
            },
        )
        jobs.enqueue(job_id)

        return {"job_id": job_id, "session_id": session.name}
    finally:
        with _store_state_lock:
            _active_uploads -= 1


@app.get("/jobs/{job_id}")
def job_status(job_id: str):
    job = jobs.get_job(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return job


@app.get("/jobs")
def jobs_list():
    # Strip the potentially large notes/video_path fields from the bulk list
    # response -- the only current consumer (useProcessingJobs's mount-time
    # rehydration) immediately filters down to queued/running jobs and
    # discards the rest, so shipping up to 50 terminal jobs' full notes
    # markdown (up to ~12000 chars each) here is pure waste. Callers needing
    # the full job detail should hit GET /jobs/{job_id} instead.
    return [{**job, "notes": None, "video_path": None} for job in jobs.list_jobs()]


def _slugify_filename(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower()
    return slug or "session"


_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _is_valid_session_id(session_id: str) -> bool:
    """Session ids are always uuid.uuid4().hex (32 lowercase hex chars); this
    is a defense-in-depth format check before session_id is used to build a
    filesystem path, independent of the sessions_index.json lookup."""
    return bool(session_id) and "/" not in session_id and "\\" not in session_id and _SESSION_ID_RE.match(session_id) is not None


@app.get("/sessions/{session_id}/export/notes")
def export_session_notes(session_id: str):
    store = STORE
    record = _get_session_or_404(store, session_id)
    notes = record.get("notes", "")
    filename = _slugify_filename(record.get("title") or "session") + ".md"
    return Response(
        content=notes,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/sessions/{session_id}/export/zip")
def export_session_zip(session_id: str):
    if not _is_valid_session_id(session_id):
        raise HTTPException(400, "Invalid session id")
    store = STORE
    record = _get_session_or_404(store, session_id)
    session_dir = store / session_id
    if not session_dir.exists():
        raise HTTPException(404, "Session files not found")

    # Built on disk, not in an io.BytesIO -- final.webm alone can be up to the
    # 2 GB upload cap, and zipfile.ZipFile.write() already streams file
    # contents internally, so buffering the whole archive in memory (then
    # copying it again via getvalue()) just to hand it to Response() peaked
    # at ~2x archive size for no reason. FileResponse below streams it back
    # off disk in constant memory, and the BackgroundTask cleans up the temp
    # file once the response has actually been sent -- except is a fallback
    # for a failure BUILDING the zip (BackgroundTask never gets attached in
    # that case, since the response is never returned) and
    # _sweep_stale_export_zips is a backstop for the remaining leak class: a
    # hard kill mid-build, or a client disconnecting mid-download (some
    # Starlette versions skip the BackgroundTask for that).
    tmp = tempfile.NamedTemporaryFile(delete=False, prefix=EXPORT_TEMP_PREFIX, suffix=".zip")
    tmp_path = tmp.name
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
            # The mux picks its container from the available encoders (webm
            # normally, mp4 on an aac-only ffmpeg) -- the literal "final.webm"
            # name silently dropped the recording from exports for
            # mp4-fallback sessions.
            video_file = None
            recorded_path = record.get("video_path")
            if recorded_path:
                candidate = Path(recorded_path)
                if candidate.exists():
                    video_file = candidate
            if video_file is None:
                for candidate in sorted(session_dir.glob("final.*")):
                    video_file = candidate
                    break
            if video_file is not None:
                zf.write(video_file, arcname=video_file.name)

            notes_md = session_dir / "notes.md"
            if notes_md.exists():
                zf.write(notes_md, arcname="notes.md")
            else:
                zf.writestr("notes.md", record.get("notes", ""))

            for transcript in sorted(session_dir.glob("transcript_*.txt")):
                zf.write(transcript, arcname=transcript.name)

            frames_dir = session_dir / "frames"
            if frames_dir.is_dir():
                for frame in sorted(frames_dir.glob("*.png")):
                    zf.write(frame, arcname=f"frames/{frame.name}")
    except Exception:
        tmp.close()
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    finally:
        tmp.close()

    filename = _slugify_filename(record.get("title") or "session") + ".zip"
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=filename,
        background=BackgroundTask(os.unlink, tmp_path),
    )


def main() -> None:
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))


if __name__ == "__main__":
    main()
