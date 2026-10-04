import os
import sys
from pathlib import Path

FFMPEG_BIN = os.getenv("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.getenv("FFPROBE_BIN", "ffprobe")


def _default_llama_server() -> str:
    """Where the llama.cpp server binary lives when LLAMA_SERVER_BIN isn't
    set (Electron sets it in packaged builds, mirroring FFMPEG_BIN): a dev
    checkout's vendor/llama (populated by `npm run fetch:llama`), else a
    bare name resolved on PATH."""
    exe = "llama-server.exe" if sys.platform == "win32" else "llama-server"
    vendored = Path(__file__).resolve().parents[2] / "vendor" / "llama" / exe
    if vendored.exists():
        return str(vendored)
    return exe


LLAMA_SERVER_BIN = os.getenv("LLAMA_SERVER_BIN") or _default_llama_server()
