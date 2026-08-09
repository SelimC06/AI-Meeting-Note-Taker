from __future__ import annotations
import json
import os
import re
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


def _preserve_corrupt_index(path: Path) -> None:
    """Best-effort: copy an unparseable index aside before it's overwritten
    or ignored, so a corrupted file (e.g. truncated by a power loss during
    the old fsync-less write) doesn't silently erase the user's meeting
    history without leaving a trace to recover from.
    """
    try:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        dest = path.with_name(f"{path.stem}.corrupt-{timestamp}{path.suffix}")
        shutil.copy2(path, dest)
    except OSError as e:
        print(f"[sessions_store] failed to preserve corrupt index {path}: {e}", flush=True)


def load_sessions(store_dir: Path) -> List[dict]:
    """Read the sessions index. Missing or corrupt file -> empty list."""
    path = _index_path(store_dir)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        _preserve_corrupt_index(path)
        return []
    if not isinstance(data, list):
        return []
    return data


def _write_sessions_atomic(store_dir: Path, sessions: List[dict]) -> None:
    """Atomically write the full sessions list to the index file.

    Writes to a temp file in the same directory, fsyncs it so the data is
    actually on disk (not just in the OS write cache) before the rename, then
    swaps it into place with os.replace(). Without the fsync, a power loss
    between write and replace could leave an empty/truncated index behind.
    Callers must hold _APPEND_LOCK.
    """
    final_path = _index_path(store_dir)
    tmp_path = final_path.with_suffix(final_path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(sessions, ensure_ascii=False, indent=2))
        f.flush()
        os.fsync(f.fileno())
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


# Session directories are always named uuid.uuid4().hex (32 lowercase hex
# chars) -- restricting the sweep below to that exact shape means it never
# touches an unrelated directory (a future subfolder, something a user put
# in the storage dir by hand, etc.), only ones this app itself could have
# created via POST /process.
_SESSION_DIR_ID_RE = re.compile(r"^[0-9a-f]{32}$")

# Presence of any of these (or a transcript_*.txt, or a non-empty frames/
# dir -- checked separately below) marks a directory as real recording/
# processing output rather than empty junk, for the sweep's adopt-vs-delete
# decision.
_RECORDING_DATA_FILENAMES = ("screen.webm", "system.webm", "mic.webm", "final.webm", "notes.md")


def _has_recording_data(session_dir: Path) -> bool:
    if any((session_dir / name).exists() for name in _RECORDING_DATA_FILENAMES):
        return True
    if any(session_dir.glob("transcript_*.txt")):
        return True
    frames_dir = session_dir / "frames"
    if frames_dir.is_dir() and any(frames_dir.iterdir()):
        return True
    return False


def _adopt_orphan_session(store_dir: Path, session_dir: Path) -> dict:
    created_at = datetime.fromtimestamp(session_dir.stat().st_mtime, tz=timezone.utc).isoformat()

    notes = ""
    notes_path = session_dir / "notes.md"
    if notes_path.exists():
        try:
            notes = notes_path.read_text(encoding="utf-8")
        except OSError:
            notes = ""

    title = extract_title(notes) if notes else ""
    if not title or title == "Untitled meeting":
        title = f"Recovered recording ({created_at[:10]})"
    if not notes:
        notes = (
            "_This recording was interrupted (e.g. an app crash or restart) "
            "before it finished processing, and was automatically recovered "
            "on the next launch. Its raw files are preserved in this "
            "session's folder._\n"
        )

    final_webm = session_dir / "final.webm"
    video_path = str(final_webm) if final_webm.exists() else ""

    record = {
        "id": session_dir.name,
        "created_at": created_at,
        "title": title,
        "notes": notes,
        "video_path": video_path,
        "trashed_at": None,
        "status": "recovered",
    }
    append_session(store_dir, record)
    return record


def sweep_orphaned_sessions(store_dir: Path) -> dict:
    """Reconciles session-shaped directories on disk with the index, meant
    to run once at backend startup (alongside purge_expired_trash).

    A session dir can end up on disk with no matching index entry: a
    mid-job crash or backend restart (the job queue in jobs.py is in-memory
    only, so a queued/running job's dir is simply abandoned), or historically,
    a validation-rejected /process request (fixed separately, but old orphans
    from before that fix still need cleaning up). Left alone these leak
    forever -- invisible to the UI, excluded from trash purge, undeletable
    via DELETE /sessions/{id}, yet still counted in /storage/usage.

    Directories that actually contain recording/processing output are
    adopted into the index as status:"recovered" so the user can see,
    export, or delete them like any other session -- their audio may still
    be valuable even though processing never finished. Directories with
    nothing recognizable in them (empty, or leftover junk) are deleted
    outright.

    Returns {"adopted": [...ids], "deleted": [...ids]}. Best-effort per
    directory: a failure processing one orphan doesn't abort the rest of
    the sweep.
    """
    result: dict = {"adopted": [], "deleted": []}
    if not store_dir.exists():
        return result

    indexed_ids = {r.get("id") for r in load_sessions(store_dir)}

    for entry in sorted(store_dir.iterdir()):
        if not entry.is_dir() or entry.name in indexed_ids:
            continue
        if not _SESSION_DIR_ID_RE.match(entry.name):
            continue
        try:
            if _has_recording_data(entry):
                record = _adopt_orphan_session(store_dir, entry)
                result["adopted"].append(record["id"])
            else:
                shutil.rmtree(entry, ignore_errors=True)
                result["deleted"].append(entry.name)
        except Exception:
            continue

    return result
