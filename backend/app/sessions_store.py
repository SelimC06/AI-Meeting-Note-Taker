from __future__ import annotations
import json
import os
import re
import shutil
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional

from . import knowledge_graph
from .corrupt_files import preserve_corrupt_copy

SESSIONS_INDEX_FILENAME = "sessions_index.json"

# RLock: load_sessions() below acquires this itself, but writers (which
# already hold it across their whole read-modify-write) call load_sessions()
# too -- a plain Lock would deadlock a writer against its own read.
_APPEND_LOCK = threading.RLock()

# str(store_dir) -> (mtime_ns, records) of the last index parsed from disk.
# Guarded by _APPEND_LOCK. Keeps every /sessions poll, session lookup, and
# chat request from re-reading and re-parsing the whole index file every
# time -- only a write (via _write_sessions_atomic) or an externally
# modified mtime actually triggers a reparse.
_index_cache: dict = {}


# Headings that are template echoes or our own fallback scaffolding, not
# names: small models copy the summary template's heading verbatim, which
# used to name nearly every meeting "Title". extract_title skips these
# (and anything still wrapped in template brackets) so the caller can fall
# back to a date-based name instead.
_PLACEHOLDER_TITLES = {
    "title",
    "untitled",
    "untitled meeting",
    "meeting",
    "meeting notes",
    "meeting summary",
    "notes",
    "summary",
    "zoom meeting",
    "transcript",
    "transcript (auto)",
    "specific 3-6 word meeting title",
}

UNTITLED_MEETING = "Untitled meeting"


def extract_title(notes: str) -> str:
    """Pull the first usable Markdown '# ' heading out of notes as a title.

    Placeholder headings (template echoes, our own fallback scaffolding)
    are skipped; when nothing usable exists, returns UNTITLED_MEETING and
    the caller picks a better default (server.py names the session by its
    date instead)."""
    for line in notes.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            title = stripped[2:].strip()
            if title.lower().startswith("title:"):
                title = title[len("title:"):].strip()
            bare = title.strip("()<>[] ").strip().lower()
            if not bare or bare in _PLACEHOLDER_TITLES or title.lower() in _PLACEHOLDER_TITLES:
                continue
            if title.startswith(("(", "<", "[")) and title.endswith((")", ">", "]")):
                # Still wrapped in template brackets: an un-filled slot.
                continue
            return title
    return UNTITLED_MEETING


def _index_path(store_dir: Path) -> Path:
    return store_dir / SESSIONS_INDEX_FILENAME


# Copy of the last index this process successfully wrote, refreshed after
# every write (see _write_sessions_atomic). recover_sessions_index restores
# from it, so a damaged index can come back with every title, status, and
# trashed_at intact instead of re-adopting each folder as "Recovered".
SESSIONS_BACKUP_FILENAME = "sessions_index.backup.json"


class SessionsIndexCorruptError(Exception):
    """sessions_index.json exists but can't be read back as a JSON list.

    Raised by load_sessions (and so by every writer, which all read first)
    instead of folding the file into an empty list: a writer that treated
    it as [] would write that back and replace the user's whole library,
    and a reader returning [] makes the library silently look wiped.
    server.py turns this into a 503 the UI shows with a recover action.
    """

    def __init__(self, path: Path, preserved_path: Optional[Path]):
        self.path = path
        self.preserved_path = preserved_path
        where = f" A copy was saved as {preserved_path.name}." if preserved_path else ""
        super().__init__(
            f"The meeting library index ({path.name}) is damaged and can't be read.{where} "
            "Nothing has been changed; use Recover library to restore it."
        )


def index_is_corrupt(store_dir: Path) -> bool:
    """Public form of _index_exists_but_is_corrupt, for callers outside this
    module that must refuse to act on a damaged index (server.py's storage
    move)."""
    return _index_exists_but_is_corrupt(store_dir)


def _index_exists_but_is_corrupt(store_dir: Path) -> bool:
    """True if sessions_index.json exists but can't be read back as a JSON
    list, so sweep_orphaned_sessions can tell "genuinely nothing indexed"
    apart from "can't trust the index right now" (see there for why that
    distinction matters).
    """
    try:
        load_sessions(store_dir)
    except SessionsIndexCorruptError:
        return True
    return False


def _record_rank(record: dict) -> int:
    """Which of two records with the same id to keep: anything real beats a
    "recovered" placeholder the orphan sweep made for the same folder."""
    return 0 if record.get("status") == "recovered" else 1


def _collapse_duplicate_ids(records: List[dict]) -> List[dict]:
    """One record per id, in the original order. Keeps the best-ranked
    record (see _record_rank; the first one on a tie). Libraries that already
    picked up a duplicate -- a "Recovered recording" twin of a real meeting,
    from the sweep running mid-recording -- heal on the next load."""
    best: Dict[str, dict] = {}
    for record in records:
        current = best.get(record["id"])
        if current is None or _record_rank(record) > _record_rank(current):
            best[record["id"]] = record
    seen = set()
    collapsed = []
    for record in records:
        rid = record["id"]
        if rid in seen:
            continue
        seen.add(rid)
        collapsed.append(best[rid])
    return collapsed


def _is_valid_record(record) -> bool:
    return isinstance(record, dict) and isinstance(record.get("id"), str) and bool(record["id"])


def load_sessions(store_dir: Path) -> List[dict]:
    """Read the sessions index. Missing file -> empty list; a file that
    exists but won't parse (or isn't a list) -> SessionsIndexCorruptError,
    after copying it aside once (see corrupt_files.preserve_corrupt_copy).

    Cached on the index file's mtime (see _index_cache) -- a cache hit
    returns copies of the cached records (callers mutate what they get back)
    without touching disk. A missing file or a read/parse error always
    invalidates the cache entry, so the resilience paths below never serve a
    stale cache instead of reflecting reality.
    """
    path = _index_path(store_dir)
    key = str(store_dir)
    with _APPEND_LOCK:
        if not path.exists():
            _index_cache.pop(key, None)
            return []
        try:
            mtime_ns = path.stat().st_mtime_ns
        except OSError:
            _index_cache.pop(key, None)
            return []

        cached = _index_cache.get(key)
        if cached is not None and cached[0] == mtime_ns:
            return [dict(r) for r in cached[1]]

        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            data = None
        # Every element must be a record with an id, not just "a list":
        # a stray null / string / id-less object used to make every endpoint
        # 500 on r.get(...), and since the file still parsed as a list,
        # recover-index thought it was healthy and couldn't fix it.
        if not isinstance(data, list) or not all(_is_valid_record(r) for r in data):
            _index_cache.pop(key, None)
            raise SessionsIndexCorruptError(path, preserve_corrupt_copy(path))

        collapsed = _collapse_duplicate_ids(data)
        if len(collapsed) != len(data):
            # Heal it on disk once (this also refreshes the cache), so every
            # endpoint sees -- and delete/rename act on -- a single record.
            print(f"[sessions_store] collapsed {len(data) - len(collapsed)} duplicate session record(s) in {path}", flush=True)
            _write_sessions_atomic(store_dir, collapsed)
            return [dict(r) for r in collapsed]

        _index_cache[key] = (mtime_ns, data)
        return [dict(r) for r in data]


def _write_json_atomic(final_path: Path, text: str) -> None:
    """Temp file in the same directory, fsync, then os.replace(). Without
    the fsync, a power loss between write and replace could leave an
    empty/truncated file behind.
    """
    tmp_path = final_path.with_suffix(final_path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, final_path)


def _write_sessions_atomic(store_dir: Path, sessions: List[dict]) -> None:
    """Atomically write the full sessions list to the index file (see
    _write_json_atomic). Callers must hold _APPEND_LOCK.

    Every caller reaches this through load_sessions() first, which raises
    on a corrupt index -- so this never overwrites a damaged index with a
    list built from nothing.

    Then refreshes SESSIONS_BACKUP_FILENAME with the same content, best-
    effort: the backup is only there for recover_sessions_index, and a
    failure writing it must not fail a write that already succeeded.

    Refreshes _index_cache with the just-written records afterward so the
    next load_sessions() call (by this process) doesn't have to reparse what
    it just wrote. Falls back to invalidating the entry if the post-write
    stat fails, so a reparse happens rather than serving stale data.
    """
    final_path = _index_path(store_dir)
    text = json.dumps(sessions, ensure_ascii=False, indent=2)
    _write_json_atomic(final_path, text)
    try:
        _write_json_atomic(store_dir / SESSIONS_BACKUP_FILENAME, text)
    except OSError as e:
        print(f"[sessions_store] failed to refresh index backup in {store_dir}: {e}", flush=True)

    key = str(store_dir)
    try:
        mtime_ns = final_path.stat().st_mtime_ns
    except OSError:
        _index_cache.pop(key, None)
        return
    _index_cache[key] = (mtime_ns, [dict(r) for r in sessions])


def append_session(store_dir: Path, record: dict) -> None:
    """Append one session record to the index, creating it if needed.

    See _write_sessions_atomic for the atomicity guarantee. The whole
    read-modify-write is serialized by a module-level lock, so concurrent
    callers within this process can't both read the same list before either
    writes, which would otherwise silently drop one of the two appended
    records.

    Never creates a second record with an id already in the index (a
    duplicate made delete/rename act on only one of the two):
    - if the existing one is a "recovered" placeholder the orphan sweep made
      for this same folder, the new (real) record replaces it -- keeping the
      placeholder's trashed_at, in case the user already trashed it;
    - otherwise the existing record is kept and this call is a logged no-op.
      Not an exception: the caller (a finished /process job) would treat it
      as a failure and try to append yet another, "failed" record, while the
      record already there points at the very same folder.
    """
    with _APPEND_LOCK:
        sessions = load_sessions(store_dir)
        existing = next((r for r in sessions if r.get("id") == record.get("id")), None)
        if existing is not None:
            if _record_rank(existing) >= _record_rank(record):
                print(f"[sessions_store] session {record.get('id')} is already indexed; keeping the existing record", flush=True)
                return
            replacement = dict(record)
            if existing.get("trashed_at"):
                replacement["trashed_at"] = existing["trashed_at"]
            sessions = [replacement if r.get("id") == record.get("id") else r for r in sessions]
        else:
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
        # Every record with this id (load_sessions collapses duplicates, but
        # an update must never leave a second copy stale either).
        for record in sessions:
            if record.get("id") == session_id:
                record.update(fields)
                found = True
        if not found:
            return False
        _write_sessions_atomic(store_dir, sessions)
        return True


# Marker file left inside a session directory that rmtree couldn't fully
# remove (a locked file -- AV scanner, media player, search indexer, an
# in-flight export -- on Windows makes rmtree(ignore_errors=True) fail
# silently, leaving the dir behind). Without this, the next startup's
# sweep_orphaned_sessions would see an unindexed session-shaped directory
# and adopt it right back into the index as a "Recovered" session --
# resurrecting a recording the user explicitly, permanently deleted.
TOMBSTONE_FILENAME = ".deleted"


def _write_tombstone(session_dir: Path) -> None:
    """Best-effort: mark session_dir as permanently deleted so a failed
    rmtree never gets mistaken for a fresh, adoptable orphan.
    """
    try:
        (session_dir / TOMBSTONE_FILENAME).touch(exist_ok=True)
    except OSError as e:
        print(f"[sessions_store] failed to write tombstone in {session_dir}: {e}", flush=True)


def _is_tombstoned(session_dir: Path) -> bool:
    return (session_dir / TOMBSTONE_FILENAME).exists()


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
        # Written BEFORE rmtree, not just after a failure: a crash between
        # the index write above and rmtree finishing would otherwise leave
        # an unindexed, un-tombstoned directory that sweep_orphaned_sessions
        # adopts back as a "Recovered" session on next boot -- resurrecting
        # a recording the user already permanently deleted. A successful
        # rmtree removes this marker right along with the rest of the dir.
        _write_tombstone(session_dir)
        shutil.rmtree(session_dir, ignore_errors=True)
        if session_dir.exists():
            # rmtree silently failed to fully remove it -- rewrite the
            # tombstone (belt-and-braces) in case the partial rmtree pass
            # itself deleted it, so sweep_orphaned_sessions retries the
            # removal on next startup instead of adopting it back.
            _write_tombstone(session_dir)

    # The knowledge graph holds entity names, aliases, and relations
    # extracted from this meeting's notes -- "permanently deleted" has to
    # cover those too, not just the index record and the folder. Best-
    # effort: the index record and folder are already gone, so a failure
    # here is logged rather than turned into a 500 for a delete that
    # otherwise happened.
    try:
        knowledge_graph.remove_session(store_dir, session_id)
    except Exception as e:  # noqa: BLE001
        print(f"[sessions_store] failed to remove {session_id} from knowledge graph: {e}", flush=True)
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
            if trashed_dt.tzinfo is None:
                # Written by an older version (or hand-edited) without an
                # offset -- all of our own writes are UTC, so interpret it
                # that way rather than letting the aware-vs-naive comparison
                # below raise.
                trashed_dt = trashed_dt.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
        if trashed_dt <= cutoff:
            if remove_session_permanently(store_dir, record["id"]):
                purged += 1
    return purged


def rewrite_index_paths(store_dir: Path, old_root: Path, new_root: Path) -> int:
    """Rewrite absolute per-session paths after a storage move.

    Records written before the move hold absolute video_path values under
    old_root; the move relocated the files but not these strings. Returns
    the number of records rewritten.
    """
    old_root = old_root.resolve()
    with _APPEND_LOCK:
        records = load_sessions(store_dir)
        rewritten = 0
        for record in records:
            vp = record.get("video_path")
            if not vp:
                continue
            try:
                rel = Path(vp).resolve().relative_to(old_root)
            except (ValueError, OSError):
                continue
            record["video_path"] = str(new_root / rel)
            rewritten += 1
        if rewritten:
            _write_sessions_atomic(store_dir, records)
        return rewritten


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
_RECORDING_DATA_FILENAMES = ("screen.webm", "system.webm", "mic.webm", "final.webm", "final.mp4", "notes.md")


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

    # Mirrors the export endpoint's video_path-then-fallback order: webm is
    # the normal container, mp4 is what a fallback (aac-only) ffmpeg mux
    # produces -- either one is a completed recording worth adopting.
    final_webm = session_dir / "final.webm"
    final_mp4 = session_dir / "final.mp4"
    if final_webm.exists():
        video_path = str(final_webm)
    elif final_mp4.exists():
        video_path = str(final_mp4)
    else:
        video_path = ""

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


# A session folder with anything modified this recently is treated as in
# use, not orphaned: /process creates the folder and then spends minutes
# writing into it before the job indexes it. The sweep must never adopt or
# delete a folder mid-recording -- that's exactly what produced "Recovered
# recording" duplicates (and could delete a recording being uploaded) when a
# second process ran the sweep during a job.
ORPHAN_MIN_AGE_SECONDS = 10 * 60


def _newest_mtime(folder: Path) -> float:
    """Latest mtime of the folder or anything inside it (a folder's own mtime
    doesn't change when an existing file inside it is being appended to)."""
    newest = folder.stat().st_mtime
    for path in folder.rglob("*"):
        try:
            newest = max(newest, path.stat().st_mtime)
        except OSError:
            continue
    return newest


def sweep_orphaned_sessions(store_dir: Path, min_age_seconds: Optional[float] = None) -> dict:
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
    outright. A TOMBSTONED directory (see TOMBSTONE_FILENAME) is never
    adopted regardless of what it still contains -- it was already
    permanently deleted by the user; rmtree just couldn't finish the job
    last time (a locked file), so this only retries the removal.

    Returns {"adopted": [...ids], "deleted": [...ids]}. Best-effort per
    directory: a failure processing one orphan doesn't abort the rest of
    the sweep.

    If the index file EXISTS but fails to parse, this skips entirely
    (returns the empty result) instead of running -- treating a corrupt
    index as empty would make every real session dir look unindexed and get
    adopted as "recovered", losing their real titles/notes and resurrecting
    trashed sessions as active. The corrupt file is already preserved aside
    (see load_sessions); this just leaves the session directories untouched
    until recover_sessions_index resolves it.
    """
    result: dict = {"adopted": [], "deleted": []}
    if min_age_seconds is None:
        min_age_seconds = ORPHAN_MIN_AGE_SECONDS
    if not store_dir.exists():
        return result
    if _index_exists_but_is_corrupt(store_dir):
        return result

    indexed_ids = {r.get("id") for r in load_sessions(store_dir)}

    for entry in sorted(store_dir.iterdir()):
        if not entry.is_dir() or entry.name in indexed_ids:
            continue
        if not _SESSION_DIR_ID_RE.match(entry.name):
            continue
        try:
            if _is_tombstoned(entry):
                shutil.rmtree(entry, ignore_errors=True)
                if entry.exists():
                    # Still locked. shutil.rmtree(ignore_errors=True) walks
                    # in filesystem enumeration order, not a guaranteed one --
                    # a partial pass can remove the tombstone marker itself
                    # before reaching the still-locked file. Without
                    # rewriting it here, the dir would be left existing with
                    # NO tombstone, and the next boot's sweep would adopt it
                    # back as "recovered" -- a permanently deleted recording
                    # resurrecting two boots later.
                    _write_tombstone(entry)
                else:
                    result["deleted"].append(entry.name)
                continue
            # Tombstoned folders (above) are exempt: nothing writes to a
            # folder the user already deleted, so retrying its removal is
            # always safe.
            # A gate of 0 (the tests; recover_sessions_index) means NO gate --
            # not even computing the age. On Windows a file's mtime comes from
            # a coarser clock than time.time(), so a file written a moment ago
            # can look slightly in the future: age < 0, and "< 0" skipped the
            # folder even with the gate off. With a real gate, that negative
            # age simply reads as "just modified", which is right.
            if min_age_seconds > 0 and time.time() - _newest_mtime(entry) < min_age_seconds:
                continue
            if _has_recording_data(entry):
                record = _adopt_orphan_session(store_dir, entry)
                result["adopted"].append(record["id"])
            else:
                shutil.rmtree(entry, ignore_errors=True)
                result["deleted"].append(entry.name)
        except Exception:
            continue

    return result


def recover_sessions_index(store_dir: Path) -> dict:
    """User-triggered repair for a corrupt sessions index (POST
    /sessions/recover-index). No-op if the index isn't actually corrupt.

    Restores from SESSIONS_BACKUP_FILENAME when it parses -- it mirrors the
    last index this app wrote, so titles, failed statuses, and trash state
    all come back exactly. Without a usable backup it falls back to an
    empty index. Either way sweep_orphaned_sessions then adopts any session
    folder the restored index doesn't list (all of them, in the fallback
    case) as "Recovered", titled from its notes.md -- the same path the
    boot sweep uses, and it still honors tombstones, so permanently
    deleted meetings never come back.

    Refuses (raises OSError) if the corrupt file can't be copied aside
    first: replacing it is only safe once a copy exists.

    Returns {"source": "none"|"backup"|"rebuild", "restored": n,
    "adopted": n, "preserved_copy": str|None}.
    """
    path = _index_path(store_dir)
    with _APPEND_LOCK:
        if not _index_exists_but_is_corrupt(store_dir):
            return {"source": "none", "restored": 0, "adopted": 0, "preserved_copy": None}
        preserved = preserve_corrupt_copy(path)
        if preserved is None:
            raise OSError(f"Couldn't save a copy of the damaged {path.name}; not replacing it")

        records: List[dict] = []
        source = "rebuild"
        backup_path = store_dir / SESSIONS_BACKUP_FILENAME
        try:
            backup = json.loads(backup_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            backup = None
        if isinstance(backup, list) and all(isinstance(r, dict) and r.get("id") for r in backup):
            # Skip anything tombstoned since the backup was written (a
            # permanent delete whose index write is exactly what got lost).
            records = _collapse_duplicate_ids([r for r in backup if not _is_tombstoned(store_dir / r["id"])])
            source = "backup"
        _write_sessions_atomic(store_dir, records)

    # No recency guard here: recovery holds server.py's _store_state_lock and
    # is refused while an upload or job is active, so nothing can be writing
    # a session folder -- and a meeting recorded minutes ago whose index
    # record was lost must still come back.
    swept = sweep_orphaned_sessions(store_dir, min_age_seconds=0)
    return {
        "source": source,
        "restored": len(records),
        "adopted": len(swept["adopted"]),
        "preserved_copy": str(preserved),
    }


# server.py's POST /process stages the screen upload here (via
# tempfile.TemporaryDirectory(prefix=STAGING_DIR_PREFIX, dir=store)) before
# validating it, so a rejected/invalid upload never leaves a permanent
# session dir behind (brief 08). TemporaryDirectory normally auto-cleans on
# exit, but a hard kill (crash, taskkill, power loss) mid-upload skips that
# cleanup entirely -- and these don't match the 32-hex-char session-dir
# shape sweep_orphaned_sessions' regex requires, so nothing else ever
# cleans them up. Left alone they leak forever, up to the ~2GB upload cap
# each.
STAGING_DIR_PREFIX = "process-staging-"


def sweep_stale_staging_dirs(store_dir: Path, max_age_seconds: int = 3600) -> List[str]:
    """Removes process-staging-* scratch dirs older than max_age_seconds.
    Meant to run once at backend startup, alongside sweep_orphaned_sessions.

    Age-gated (not "every staging dir found") so an upload that's currently
    mid-flight -- its staging dir was just created -- is never touched.
    Independent of the sessions index entirely, so it runs regardless of
    whether that index is corrupt (see sweep_orphaned_sessions).

    Returns the names of directories actually removed.
    """
    removed: List[str] = []
    if not store_dir.exists():
        return removed
    cutoff = time.time() - max_age_seconds
    for entry in sorted(store_dir.glob(f"{STAGING_DIR_PREFIX}*")):
        if not entry.is_dir():
            continue
        try:
            if entry.stat().st_mtime > cutoff:
                continue
            shutil.rmtree(entry, ignore_errors=True)
            if not entry.exists():
                removed.append(entry.name)
        except OSError:
            continue
    return removed


# Per-session structured transcript (Track A's "You" vs. "Others" segments),
# stored as its own file rather than in sessions_index.json -- keeps the
# index light per the existing pattern of storing large content (notes.md)
# outside it.
TRANSCRIPT_FILENAME = "transcript.json"


def write_transcript_segments(session_dir: Path, segments: List[dict]) -> None:
    """Atomically write a session's transcript segments to transcript.json.

    Same fsync-before-replace pattern as _write_sessions_atomic /
    settings_store._write_json_dict -- a power loss between write and replace
    must never leave a truncated/empty transcript.json behind.
    """
    session_dir.mkdir(parents=True, exist_ok=True)
    final_path = session_dir / TRANSCRIPT_FILENAME
    tmp_path = final_path.with_suffix(final_path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(segments, ensure_ascii=False, indent=2))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, final_path)


def load_transcript_segments(session_dir: Path) -> List[dict]:
    """Read a session's transcript.json. Missing or corrupt file -> []
    (same resilience contract as load_sessions)."""
    path = session_dir / TRANSCRIPT_FILENAME
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError, UnicodeDecodeError):
        return []
    if not isinstance(data, list):
        return []
    return data


# Per-session structured action items (see LLaVA_summarize.extract_action_items),
# stored as its own file rather than in sessions_index.json -- same rationale
# as TRANSCRIPT_FILENAME above: keeps the index light, and this is only
# written when structured extraction actually succeeded, so its mere
# presence already distinguishes "has structured action items" from "fell
# back to prose notes for this session" without needing a separate flag.
SUMMARY_FILENAME = "summary.json"


def write_action_items(session_dir: Path, action_items: List[dict]) -> None:
    """Atomically write a session's structured action items to summary.json.

    Same fsync-before-replace pattern as write_transcript_segments /
    _write_sessions_atomic. Only ever called with a non-None list -- callers
    that got None back from extract_action_items (both parse attempts
    failed, or extraction wasn't attempted) must simply not call this, so a
    missing file unambiguously means "no structured data for this session".
    """
    session_dir.mkdir(parents=True, exist_ok=True)
    final_path = session_dir / SUMMARY_FILENAME
    tmp_path = final_path.with_suffix(final_path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(json.dumps({"action_items": action_items}, ensure_ascii=False, indent=2))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, final_path)


def load_action_items(session_dir: Path) -> Optional[List[dict]]:
    """Read a session's summary.json. Missing, corrupt, or malformed-shape
    file -> None (same resilience contract as load_sessions/
    load_transcript_segments). Callers (the /action-items endpoint) treat
    None as "structured action items aren't available for this session" --
    an old session recorded before this feature existed, or one where both
    of extract_action_items' parse attempts failed -- and the frontend falls
    back to showing the prose notes instead of a checklist.
    """
    path = session_dir / SUMMARY_FILENAME
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    items = data.get("action_items")
    if not isinstance(items, list):
        return None
    return items


def sweep_stale_partial_mux_files(store_dir: Path, max_age_seconds: int = 3600) -> List[str]:
    """Removes leftover .part mux temp files (see mux_video_audio) older than
    max_age_seconds. Meant to run once at backend startup, alongside the
    other sweeps.

    mux_video_audio writes to a dotted "." + "<name>.part" temp file and
    os.replace()s it onto the real output on success, with an unlink in the
    ffmpeg failure path -- but a hard kill (crash, watchdog kill, power loss)
    mid-mux skips both, leaving the temp file behind forever with nothing
    else to clean it up. Age-gated so a mux actually in progress right now is
    never touched.

    Also matches the pre-batch-10 undotted "final.*.part" name, so partials
    left by an older build aren't stuck on disk forever after an upgrade.

    Returns the names of files actually removed.
    """
    removed: List[str] = []
    if not store_dir.exists():
        return removed
    cutoff = time.time() - max_age_seconds
    seen: set = set()
    entries: List[Path] = []
    for pattern in ("*/.*.part", "*/final.*.part"):
        for entry in store_dir.glob(pattern):
            if entry in seen:
                continue
            seen.add(entry)
            entries.append(entry)
    for entry in sorted(entries):
        if not entry.is_file():
            continue
        try:
            if entry.stat().st_mtime > cutoff:
                continue
            entry.unlink()
            removed.append(entry.name)
        except OSError:
            continue
    return removed


# Track B: user-editable overrides mapping a raw pyannote label
# ("SPEAKER_00") to a real name ("Alice"). Kept as its own small file,
# resolved against transcript.json at the API boundary
# (GET /sessions/{id}/transcript) rather than mutating the raw diarization
# output -- keeps transcript.json immutable/re-mappable if a name is
# corrected twice.
SPEAKER_NAMES_FILENAME = "speaker_names.json"


def load_speaker_names(session_dir: Path) -> Dict[str, str]:
    """Read a session's speaker_names.json. Missing, corrupt, or
    malformed-shape file -> {} (same resilience contract as
    load_transcript_segments)."""
    path = session_dir / SPEAKER_NAMES_FILENAME
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError, UnicodeDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


# Serializes write_speaker_names' read-merge-write, same reasoning as
# _APPEND_LOCK: FastAPI runs sync handlers in a threadpool, so two PATCH
# /speaker-names requests really are concurrent, and without this both read
# the same map and the second write drops the first rename.
_SPEAKER_NAMES_LOCK = threading.Lock()


def write_speaker_names(session_dir: Path, updates: Dict[str, str]) -> None:
    """Merge `updates` into a session's speaker name map and atomically
    write the result -- a partial PATCH (renaming one speaker) must not
    clobber names already set for other speakers in the same session.

    Same fsync-before-replace pattern as write_transcript_segments, but
    with a unique temp name (mkstemp): a fixed ".tmp" shared between two
    writers lets one os.replace() the other's half-written file, or find
    it already moved and fail with FileNotFoundError.
    """
    session_dir.mkdir(parents=True, exist_ok=True)
    final_path = session_dir / SPEAKER_NAMES_FILENAME
    with _SPEAKER_NAMES_LOCK:
        merged = {**load_speaker_names(session_dir), **updates}
        fd, tmp_name = tempfile.mkstemp(dir=session_dir, prefix=f".{SPEAKER_NAMES_FILENAME}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps(merged, ensure_ascii=False, indent=2))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_name, final_path)
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
