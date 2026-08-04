from __future__ import annotations
import json
import os
import shutil
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List

SESSIONS_INDEX_FILENAME = "sessions_index.json"

_APPEND_LOCK = threading.Lock()


def extract_title(notes: str) -> str:
    """Pull the first Markdown '# ' heading out of notes as a title."""
    for line in notes.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            title = stripped[2:].strip()
            if title.lower().startswith("title:"):
                title = title[len("title:"):].strip()
            if title:
                return title
    return "Untitled meeting"


def _index_path(store_dir: Path) -> Path:
    return store_dir / SESSIONS_INDEX_FILENAME


def load_sessions(store_dir: Path) -> List[dict]:
    """Read the sessions index. Missing or corrupt file -> empty list."""
    path = _index_path(store_dir)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return []
    if not isinstance(data, list):
        return []
    return data


def _write_sessions_atomic(store_dir: Path, sessions: List[dict]) -> None:
    """Atomically write the full sessions list to the index file.

    Writes to a temp file in the same directory then swaps it into place
    with os.replace(), so a crash mid-write leaves the previous (intact)
    index untouched. Callers must hold _APPEND_LOCK.
    """
    final_path = _index_path(store_dir)
    tmp_path = final_path.with_suffix(final_path.suffix + ".tmp")
    tmp_path.write_text(
        json.dumps(sessions, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    os.replace(tmp_path, final_path)


def append_session(store_dir: Path, record: dict) -> None:
    """Append one session record to the index, creating it if needed.

    See _write_sessions_atomic for the atomicity guarantee. The whole
    read-modify-write is serialized by a module-level lock, so concurrent
    callers within this process can't both read the same list before either
    writes, which would otherwise silently drop one of the two appended
    records.
    """
    with _APPEND_LOCK:
        sessions = load_sessions(store_dir)
        sessions.append(record)
        _write_sessions_atomic(store_dir, sessions)


def update_session_fields(store_dir: Path, session_id: str, **fields) -> bool:
    """Update one or more fields on the record matching session_id.

    Returns False (no-op, no write) if no record has that id. Same
    lock + atomic-write guarantees as append_session.
    """
    with _APPEND_LOCK:
        sessions = load_sessions(store_dir)
        found = False
        for record in sessions:
            if record.get("id") == session_id:
                record.update(fields)
                found = True
                break
        if not found:
            return False
        _write_sessions_atomic(store_dir, sessions)
        return True


def remove_session_permanently(store_dir: Path, session_id: str) -> bool:
    """Remove a session's index record and delete its folder from disk.

    Returns False (no-op) if no record has that id. If the record exists
    but its folder is already missing, the index entry is still removed
    and this returns True -- a partially-cleaned-up session shouldn't be
    stuck forever.
    """
    with _APPEND_LOCK:
        sessions = load_sessions(store_dir)
        remaining = [r for r in sessions if r.get("id") != session_id]
        if len(remaining) == len(sessions):
            return False
        _write_sessions_atomic(store_dir, remaining)

    session_dir = store_dir / session_id
    if session_dir.exists():
        shutil.rmtree(session_dir, ignore_errors=True)
    return True


def purge_expired_trash(store_dir: Path, max_age_days: int = 30) -> int:
    """Permanently remove trashed sessions older than max_age_days.

    Records with a missing/unparseable trashed_at are left alone (not
    treated as expired). A per-item failure doesn't abort the sweep --
    remove_session_permanently already tolerates a missing folder, so the
    only realistic failure here is an index write race, which would raise
    and should surface rather than be silently swallowed for every
    remaining item.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    purged = 0
    for record in load_sessions(store_dir):
        trashed_at = record.get("trashed_at")
        if not trashed_at:
            continue
        try:
            trashed_dt = datetime.fromisoformat(trashed_at)
        except (ValueError, TypeError):
            continue
        if trashed_dt <= cutoff:
            if remove_session_permanently(store_dir, record["id"]):
                purged += 1
    return purged


def compute_storage_usage(store_dir: Path) -> dict:
    """Report disk usage for store_dir plus active/trashed session counts.

    Resilient like load_sessions: a missing/unreadable store_dir returns
    zeros for the disk-usage fields rather than raising, so callers (the
    /storage/usage endpoint) never 500 because of a transient FS issue.
    """
    sessions = load_sessions(store_dir)
    session_count = sum(1 for r in sessions if not r.get("trashed_at"))
    trashed_count = len(sessions) - session_count

    used_bytes = 0
    free_bytes = 0
    total_bytes = 0
    try:
        if store_dir.exists():
            for path in store_dir.rglob("*"):
                if path.is_file():
                    used_bytes += path.stat().st_size
            disk = shutil.disk_usage(store_dir)
            free_bytes = disk.free
            total_bytes = disk.total
    except OSError:
        used_bytes = 0
        free_bytes = 0
        total_bytes = 0

    return {
        "used_bytes": used_bytes,
        "free_bytes": free_bytes,
        "total_bytes": total_bytes,
        "session_count": session_count,
        "trashed_count": trashed_count,
    }
