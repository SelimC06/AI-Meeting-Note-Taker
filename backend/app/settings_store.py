from __future__ import annotations
import json
import os
import shutil
import threading
from pathlib import Path
from typing import Any, Dict

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
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp_path, path)


def load_or_init(path: Path, default_storage_dir: Path) -> Dict[str, Any]:
    """Load settings from `path`, seeding+persisting defaults if missing/corrupt.

    An existing file's keys always win over defaults; any keys missing from
    an older/partial file are filled in from the defaults so callers always
    get all three settings back.
    """
    defaults = default_settings(default_storage_dir)
    existing = _read_json_dict(path)
    if existing is None:
        _write_json_dict(path, defaults)
        return defaults
    return {**defaults, **existing}


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
        old_dir.iterdir(), key=lambda p: (p.name == "sessions_index.json", p.name)
    )
    try:
        for entry in entries:
            shutil.move(str(entry), str(new_dir / entry.name))
    except OSError as e:
        raise StorageMoveError(f"Failed to move recordings: {e}") from e
