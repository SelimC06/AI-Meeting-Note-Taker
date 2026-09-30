from __future__ import annotations
import json
import os
import re
import shutil
import threading
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from .corrupt_files import preserve_corrupt_copy

SAVE_LOCK = threading.RLock()

WHISPER_MODEL_CHOICES = [
    {"value": "tiny.en", "label": "Tiny", "description": "Fastest, lower accuracy"},
    {"value": "base.en", "label": "Base", "description": "Balanced (default)"},
    {"value": "small.en", "label": "Small", "description": "Slower, more accurate"},
    {"value": "medium.en", "label": "Medium", "description": "Slowest, most accurate"},
]
WHISPER_MODEL_VALUES = {c["value"] for c in WHISPER_MODEL_CHOICES}


def default_settings(default_storage_dir: Path) -> Dict[str, Any]:
    return {
        "whisper_model": os.getenv("WHISPER_MODEL", "tiny.en"),
        "storage_dir": str(default_storage_dir),
        "ollama_chat_model": os.getenv("OLLAMA_CHAT_MODEL", "gemma3:4b"),
        "custom_vocabulary": "",
        # Track B: true n-party diarization via pyannote. Off by default --
        # it's an optional, heavier dependency (torch/pyannote.audio) and
        # requires a HuggingFace access token (gated model weights), so it
        # must never turn on without the user explicitly opting in.
        "advanced_diarization_enabled": False,
        "huggingface_token": "",
        # Custom (3rd-party, OpenAI-compatible) LLM provider. Off by
        # default -- Ollama stays the default provider for chat,
        # summarization, and knowledge-graph extraction.
        "ai_provider": "ollama",
        "custom_api_base_url": "",
        "custom_api_key": "",
        "custom_model_name": "",
    }


def _read_json_dict(path: Path) -> Dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def _write_json_dict(path: Path, data: Dict[str, Any]) -> None:
    # fsync before the rename so the write is actually on disk (not just in
    # the OS write cache) before it's swapped into place -- without it, a
    # power loss between write and replace could leave an empty/truncated
    # settings.json behind.
    #
    # Created 0600: the file holds the custom API key and HuggingFace token
    # in plaintext, and the default umask would leave it readable by every
    # account on the machine. fchmod too, since O_CREAT's mode is ignored
    # for a leftover .tmp that already exists. On Windows the mode bits
    # only control read-only and fchmod doesn't exist, so this is a no-op
    # there.
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    if hasattr(os, "fchmod"):
        os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=2))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, path)


# Pulls the "storage_dir" string out of a settings.json that no longer
# parses as a whole (truncated, a stray edit) -- it's the one setting where
# falling back to the default is actively harmful, see load_checked.
_STORAGE_DIR_RE = re.compile(r'"storage_dir"\s*:\s*("(?:[^"\\]|\\.)*")')


def _salvage_storage_dir(path: Path) -> Optional[str]:
    try:
        match = _STORAGE_DIR_RE.search(path.read_text(encoding="utf-8", errors="replace"))
        value = json.loads(match.group(1)) if match else None
    except (ValueError, OSError):
        return None
    # Only trust it if it still names a real folder -- never create one
    # from a guess.
    if isinstance(value, str) and Path(value).is_absolute() and Path(value).is_dir():
        return value
    return None


def load_checked(path: Path, default_storage_dir: Path) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    """Load settings, reporting a corrupt file instead of hiding it.

    Returns (settings, error). error is None normally. For a settings.json
    that exists but won't parse, it's {"message": str, "storage_dir_recovered":
    bool}, and:
    - the file is copied aside once (corrupt_files.preserve_corrupt_copy)
      and otherwise left alone -- NOT replaced with defaults, so the problem
      is still reported on the next launch instead of the defaults quietly
      becoming the user's settings. Saving any setting (save()) is what
      rewrites it.
    - storage_dir is salvaged from the damaged text when possible. Silently
      falling back to the default folder would show a user with a custom
      folder an empty library and point the startup sweeps at the wrong
      folder; server.py skips those sweeps when storage_dir_recovered is
      False.

    A missing file is not an error: defaults are seeded and persisted.
    """
    defaults = default_settings(default_storage_dir)
    existing = _read_json_dict(path)
    if existing is not None:
        return {**defaults, **existing}, None
    if not path.exists():
        _write_json_dict(path, defaults)
        return defaults, None

    preserved = preserve_corrupt_copy(path)
    salvaged = _salvage_storage_dir(path)
    settings = dict(defaults)
    copy_note = f" A copy of the damaged file was saved as {preserved.name}." if preserved else ""
    if salvaged:
        settings["storage_dir"] = salvaged
        message = (
            f"Your settings file ({path.name}) is damaged. Your recordings folder was recovered "
            f"({salvaged}), but other settings are temporarily back to defaults.{copy_note} "
            "Saving any setting rewrites the file and clears this warning."
        )
    else:
        message = (
            f"Your settings file ({path.name}) is damaged, so DeskRecap is using the default "
            f"recordings folder ({defaults['storage_dir']}). Meetings saved in a custom folder won't "
            f"appear until the file is fixed.{copy_note} Repair {path} and restart, or save any "
            "setting to keep the defaults."
        )
    return settings, {"message": message, "storage_dir_recovered": salvaged is not None}


def load_or_init(path: Path, default_storage_dir: Path) -> Dict[str, Any]:
    """load_checked without the error report: settings only.

    An existing file's keys always win over defaults; any keys missing from
    an older/partial file are filled in from the defaults so callers always
    get every setting back.
    """
    return load_checked(path, default_storage_dir)[0]


def save(path: Path, updates: Dict[str, Any], default_storage_dir: Path) -> Dict[str, Any]:
    """Read-modify-write settings.json with `updates` merged on top.

    The whole read-modify-write is serialized by a module-level lock, so
    concurrent PATCH /settings calls (the Settings UI auto-saves on every
    click with no debounce, and FastAPI sync handlers run in a threadpool,
    so concurrent requests are genuinely parallel) can't interleave and
    tear/lose a write, mirroring sessions_store.append_session's locking.

    SAVE_LOCK is reentrant (RLock) because server.py's patch_settings also
    holds it across move_storage_dir before calling this function, and this
    function acquiring it again on the same thread must not deadlock.
    """
    with SAVE_LOCK:
        current = load_or_init(path, default_storage_dir)
        merged = {**current, **updates}
        _write_json_dict(path, merged)
        return merged


class StorageMoveError(Exception):
    pass


# server.py builds export zips in <storage>/EXPORT_DIR_NAME (defined here so
# move_storage_dir below and server.py agree on it). Only transient files
# live there, so a storage move leaves it behind and deletes it afterwards
# instead of moving it: an export zip still open for a download made the
# move fail on Windows, and a cross-drive copy that died partway left
# new_dir/.exports behind, so every retry failed with "Destination folder
# is not empty".
EXPORT_DIR_NAME = ".exports"


def move_storage_dir(old_dir: Path, new_dir: Path) -> None:
    old_resolved = old_dir.resolve()
    new_resolved = new_dir.resolve()

    if old_dir.exists() and old_resolved == new_resolved:
        return

    if old_dir.exists() and new_resolved != old_resolved:
        try:
            new_resolved.relative_to(old_resolved)
        except ValueError:
            pass  # new_dir is not nested inside old_dir; fine to proceed
        else:
            raise StorageMoveError("Destination folder cannot be inside the current storage folder")

    try:
        new_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise StorageMoveError(f"Could not create destination folder: {e}") from e

    if any(new_dir.iterdir()):
        raise StorageMoveError("Destination folder is not empty")

    if not old_dir.exists():
        return

    # Move sessions_index.json LAST. iterdir() order is OS-dependent, so if a
    # move fails partway through, moving the index first (or in arbitrary
    # order) could leave it orphaned in new_dir while most/all session
    # folders remain in old_dir -- making GET /sessions read old_dir, find no
    # index, and report the user's entire meeting history as gone. Moving it
    # last guarantees a partial failure always leaves the index alongside
    # whichever directory still holds the bulk of the session folders.
    entries = sorted(
        (p for p in old_dir.iterdir() if p.name != EXPORT_DIR_NAME),
        key=lambda p: (p.name == "sessions_index.json", p.name),
    )
    try:
        for entry in entries:
            shutil.move(str(entry), str(new_dir / entry.name))
    except OSError as e:
        raise StorageMoveError(f"Failed to move recordings: {e}") from e
    # Best-effort: a zip still open for download stays behind and is cleaned
    # up by server.py's startup export sweep if it's ever pointed here again.
    shutil.rmtree(old_dir / EXPORT_DIR_NAME, ignore_errors=True)
