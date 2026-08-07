from __future__ import annotations
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import StreamingResponse, Response
from .audit import AuditMiddleware
from fastapi.middleware.cors import CORSMiddleware
from starlette.types import Scope, Receive, Send
from starlette.responses import PlainTextResponse
from pathlib import Path
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone
import io
import shutil
import subprocess
import tempfile
import uuid
import os
import uvicorn
import re
import zipfile

from .sessions_store import (
    extract_title,
    load_sessions,
    append_session,
    update_session_fields,
    remove_session_permanently,
    purge_expired_trash,
    compute_storage_usage,
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

try:
    from .ffmpeg_transcribe import stop_recording_and_transcribe  # type: ignore
except Exception:
    stop_recording_and_transcribe = None  # noqa: N816

try:
    from .LLaVA_summarize import complete as llava_complete  # type: ignore
except Exception:
    llava_complete = None

try:
    from .chat import assert_ollama_up, stream_chat_reply, OLLAMA_BASE
except Exception:
    assert_ollama_up = None
    stream_chat_reply = None
    OLLAMA_BASE = "http://localhost:11434"

app = FastAPI()


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: List[ChatMessage] = []

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000,http://127.0.0.1:8000")

ORIGINS = [o.strip() for o in ALLOWED_ORIGINS.split(",") if o.strip()]

MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "2048"))
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

_settings = load_settings(SETTINGS_PATH, ROOT / "uploads")
STORE = Path(_settings["storage_dir"])
STORE.mkdir(parents=True, exist_ok=True)
purge_expired_trash(STORE)
WHISPER_MODEL = _settings["whisper_model"]
OLLAMA_CHAT_MODEL = _settings["ollama_chat_model"]

def log(msg: str) -> None:
    print(f"[server] {msg}", flush=True)


def run(cmd: List[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


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
    if size == 0 or not ffprobe_ok(out):
        log(f"skip {name}: size={size}, valid={ffprobe_ok(out)}")
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
        shutil.copy(video, out_path)
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

    args = [
        "-i", str(video),
        "-i", str(audio),
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", acodec,
        str(out_path),
    ]
    p = run([FFMPEG_BIN, "-y", *args])
    if p.returncode != 0:
        raise RuntimeError(p.stderr[-1200:] if p.stderr else "mux failed")
    return out_path

@app.get("/health")
@app.get("/healthz")
def health():
    ollama_ok = True
    try:
        if assert_ollama_up is not None:
            assert_ollama_up()
        else:
            ollama_ok = False
    except Exception:
        ollama_ok = False
    return {"ok": True, "backend": True, "ollama": ollama_ok}

@app.get("/")
def root():
    return {"service": "meeting-api", "ok": True}

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
    matching = [s for s in load_sessions(store) if s.get("id") == session_id]
    return matching[0]


@app.post("/sessions/{session_id}/trash")
def trash_session(session_id: str):
    store = STORE
    matching = [s for s in load_sessions(store) if s.get("id") == session_id]
    if not matching:
        raise HTTPException(404, "Session not found")
    if not matching[0].get("trashed_at"):
        update_session_fields(store, session_id, trashed_at=datetime.now(timezone.utc).isoformat())
    matching = [s for s in load_sessions(store) if s.get("id") == session_id]
    return matching[0]


@app.post("/sessions/{session_id}/restore")
def restore_session(session_id: str):
    store = STORE
    ok = update_session_fields(store, session_id, trashed_at=None)
    if not ok:
        raise HTTPException(404, "Session not found")
    matching = [s for s in load_sessions(store) if s.get("id") == session_id]
    return matching[0]


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
    global STORE, WHISPER_MODEL, OLLAMA_CHAT_MODEL

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
            try:
                move_storage_dir(STORE, new_dir)
            except StorageMoveError as e:
                raise HTTPException(400, str(e))
            updates["storage_dir"] = str(new_dir)

        settings = save_settings(SETTINGS_PATH, updates, ROOT / "uploads")

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
    try:
        import ollama as ollama_pkg
        client = ollama_pkg.Client(host=OLLAMA_BASE)
        resp = client.list()
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

    matching = [s for s in load_sessions(store) if s.get("id") == session_id]
    if not matching:
        raise HTTPException(404, "Session not found")
    session_record = matching[0]

    try:
        assert_ollama_up()
    except Exception as e:
        raise HTTPException(503, f"Local model unavailable: {e}")

    history = [{"role": m.role, "content": m.content} for m in body.history]

    def token_stream():
        try:
            for chunk in stream_chat_reply(session_record["notes"], body.message, history, model=chat_model):
                yield chunk
        except Exception as e:
            log(f"chat stream failed: {e}")
            yield f"\n[error: {e}]"

    return StreamingResponse(token_stream(), media_type="text/plain")

@app.post("/process")
async def process(
    screen: UploadFile | None = File(None),   # required logically, but optional type so 422 doesn't fire
    system: UploadFile | None = File(None),   # optional
    mic:    UploadFile | None = File(None),   # optional
    frames: List[UploadFile] | None = File(None)
):
    """
    Accepts blobs from the frontend:
      - screen (video/webm;codecs=vp8 recommended)
      - system (audio/webm;codecs=opus) [optional]
      - mic    (audio/webm;codecs=opus) [optional]

    Steps:
      1) save uploads (skip empty/invalid)
      2) convert audios to wav
      3) mix wavs -> mixed.wav (optional)
      4) mux with video using a safe encoder/container
      5) (optional) run your Whisper+LLaVA pipeline
    """
    # Bind STORE (and WHISPER_MODEL below) to locals once, at the top, so
    # this request sees one consistent snapshot of settings throughout --
    # even though transcription can take minutes and a PATCH /settings
    # changing storage_dir could otherwise land mid-request, causing the
    # video files to land in the OLD folder while the index entry gets
    # appended to the NEW folder's index.
    store = STORE
    whisper_model = WHISPER_MODEL

    session = store / uuid.uuid4().hex
    session.mkdir(parents=True, exist_ok=True)
    log(f"session: {session}")

    # 1) save uploads
    screen_webm = save_upload(session, screen, "screen.webm")
    if not screen_webm:
        raise HTTPException(400, "valid screen video is required")

    system_webm = save_upload(session, system, "system.webm") if system else None
    mic_webm    = save_upload(session, mic,    "mic.webm")    if mic    else None

    # 2) normalize -> wav (16k mono)
    system_wav = to_wav(system_webm, session / "system.wav")
    mic_wav    = to_wav(mic_webm,    session / "mic.wav")

    # 3) mix audio if we have any
    mixed_wav  = mix_audios_wav(system_wav, mic_wav, session / "mixed.wav")

    # 4) mux with video (robust encoder fallback)
    try:
        final_path = mux_video_audio(screen_webm, mixed_wav, session / "final.webm")
    except Exception as e:
        log(f"mux failed: {e}")
        raise HTTPException(
            500,
            "Couldn't combine your audio and video — the recording file may be corrupted. Try recording again.",
        )

    selected_paths: list[str] = []
    if frames:
        k = min(2, len(frames))
        n = len(frames)
        idxs = sorted({round((i + 1) / (k + 1) * (n - 1)) for i in range(k)})  # ~20%,50%,80%, deduped

        frames_dir = session / "frames"
        frames_dir.mkdir(parents=True, exist_ok=True)
        for j, idx in enumerate(idxs, start=1):
            uf = frames[idx]
            out = frames_dir / f"frame_{j:03d}.png"
            with out.open("wb") as f:
                shutil.copyfileobj(uf.file, f)
            selected_paths.append(str(out))

    notes: str = ""
    # 5) (optional) run your pipeline if available
    txt_path: Optional[str] = None
    if stop_recording_and_transcribe is not None:
        # Use your helper on the final muxed video; request frames & transcript
        try:
            txt_path, _ = stop_recording_and_transcribe(
                video_path=str(final_path),
                transcript_prefix=str(session / "transcript_"),
                model_name=whisper_model,
                separate_tracks=False,
                extract_frames_after=True,
                frames_out_dir=str(session / "frames"),
                every_n_seconds=5.0,
                scale_width=960,
                image_ext="png",
                quality=2,
                max_frames=3,
            )
        except Exception as e:
            # Leave txt_path as None so the summarization block below is
            # skipped and the raw-Whisper fallback (further down) runs on
            # final_path instead -- mirrors the llava_complete failure
            # handling immediately below, and guarantees the session still
            # gets appended to the index instead of 500ing and orphaning
            # the already-uploaded video.
            log(f"stop_recording_and_transcribe failed, falling back to raw transcription: {e}")
            txt_path = None

    if txt_path is not None:
        try:
            if llava_complete is None:
                raise RuntimeError("llava_complete import is None (summarizer missing)")

            notes = llava_complete(
                raw_txt_path=txt_path,
                out_path=str(session / "notes.md"),
                frame_paths=selected_paths,
                max_images=min(3, len(selected_paths)),
                max_image_px=1280,
                jpeg_quality=80,
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
                notes = (
                    "# Title: Zoom Meeting\n\n"
                    "# Transcript (auto)\n"
                    + (transcript[:12000] or "(empty)")
                )
            except Exception as read_err:
                log(f"failed to read existing transcript {txt_path}: {read_err}")

    if not notes:
        try:
            from faster_whisper import WhisperModel
            model = get_whisper_model(WhisperModel, whisper_model, compute_type="int8")  # CPU-friendly
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

    record = {
        "id": session.name,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "title": extract_title(notes),
        "notes": notes,
        "video_path": str(final_path),
        "trashed_at": None,
    }
    append_session(store, record)

    return {
        "notes": notes,
        "video_path": str(final_path),
        "session": session.name,
    }


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
    matching = [s for s in load_sessions(store) if s.get("id") == session_id]
    if not matching:
        raise HTTPException(404, "Session not found")
    record = matching[0]
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
    matching = [s for s in load_sessions(store) if s.get("id") == session_id]
    if not matching:
        raise HTTPException(404, "Session not found")
    record = matching[0]
    session_dir = store / session_id
    if not session_dir.exists():
        raise HTTPException(404, "Session files not found")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        final_webm = session_dir / "final.webm"
        if final_webm.exists():
            zf.write(final_webm, arcname="final.webm")

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

    filename = _slugify_filename(record.get("title") or "session") + ".zip"
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def main() -> None:
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))


if __name__ == "__main__":
    main()
