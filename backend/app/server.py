from __future__ import annotations
from fastapi import FastAPI, UploadFile, File, HTTPException
from .audit import AuditMiddleware
from fastapi.middleware.cors import CORSMiddleware
from starlette.types import Scope, Receive, Send
from pathlib import Path
from typing import Optional, List
from datetime import datetime, timezone
import shutil
import subprocess
import tempfile
import uuid
import os

from .auth import router as auth_routher
from .sessions_store import extract_title, load_sessions, append_session

try:
    from .ffmpeg_transcribe import stop_recording_and_transcribe  # type: ignore
except Exception:
    stop_recording_and_transcribe = None  # noqa: N816

try:
    from .LLaVA_summarize import complete as llava_complete  # type: ignore
except Exception:
    llava_complete = None

app = FastAPI()

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000,http://127.0.0.1:8000")

ORIGINS = [o.strip() for o in ALLOWED_ORIGINS.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,  # ["http://localhost:1420", "http://localhost:5173", "tauri://localhost"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(AuditMiddleware)

ROOT = Path(__file__).resolve().parent
STORE = ROOT / "uploads"
STORE.mkdir(exist_ok=True)

def log(msg: str) -> None:
    print(f"[server] {msg}", flush=True)


def run(cmd: List[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def run_ffmpeg(args: List[str]) -> None:
    p = run(["ffmpeg", "-y", *args])
    if p.returncode != 0:
        raise RuntimeError(p.stderr[-1200:] if p.stderr else "ffmpeg failed")


def ffprobe_ok(p: Path) -> bool:
    if not p.exists() or p.stat().st_size == 0:
        return False
    probe = run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(p)])
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
    enc = run(["ffmpeg", "-hide_banner", "-encoders"])
    return enc.returncode == 0 and f" {name} " in (enc.stdout or "")


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
    p = run(["ffmpeg", "-y", *args])
    if p.returncode != 0:
        raise RuntimeError(p.stderr[-1200:] if p.stderr else "mux failed")
    return out_path

app.include_router(auth_routher)

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/healthz")
def healthz():
    return {"ok": True}

@app.get("/")
def root():
    return {"service": "meeting-api", "ok": True}

@app.get("/debug/ollama")
def debug_ollama():
    import os, requests
    base = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    try:
        r = requests.get(f"{base}/api/tags", timeout=3)
        return {"ok": True, "base": base, "models": [m["name"] for m in r.json().get("models", [])]}
    except Exception as e:
        return {"ok": False, "base": base, "error": str(e)}

@app.get("/sessions")
def sessions():
    return sorted(load_sessions(STORE), key=lambda r: r.get("created_at", ""), reverse=True)

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
    session = STORE / uuid.uuid4().hex
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
    final_path = mux_video_audio(screen_webm, mixed_wav, session / "final.webm")

    selected_paths: list[str] = []
    if frames:
        k = min(2, len(frames))
        n = len(frames)
        idxs = [round((i + 1) / (k + 1) * (n - 1)) for i in range(k)]  # ~20%,50%,80%

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
        txt_path, _ = stop_recording_and_transcribe(
            video_path=str(final_path),
            transcript_prefix=str(session / "transcript_"),
            model_name="tiny.en",
            separate_tracks=False,
            extract_frames_after=True,
            frames_mode="uniform",
            frames_out_dir=str(session / "frames"),
            every_n_seconds=5.0,
            scale_width=960,
            image_ext="png",
            quality=2,
            max_frames=3,
        )

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
            log(f"pipeline failed, returning stub notes: {e}")

    if not notes:
        try:
            from faster_whisper import WhisperModel
            model_name = os.getenv("WHISPER_MODEL", "tiny.en")
            model = WhisperModel(model_name, compute_type="int8")  # CPU-friendly
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
    }
    append_session(STORE, record)

    return {
        "notes": notes,
        "video_path": str(final_path),
        "session": session.name,
    }
