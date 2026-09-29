"""Shared handling for JSON state files that exist but won't parse.

Used by sessions_store, settings_store, and knowledge_graph so a damaged
file is always copied aside the same way before anything else happens to
it. Lives in its own module (rather than in sessions_store, where it
started) so knowledge_graph can use it without an import cycle --
sessions_store imports knowledge_graph to clean up permanently deleted
sessions.
"""
from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def preserve_corrupt_copy(path: Path) -> Optional[Path]:
    """Best-effort: copy an unparseable file aside as
    <stem>.corrupt-<timestamp><suffix> and return the copy's path (None if
    the copy couldn't be made).

    The timestamp is the corrupt file's own mtime, not the current time, so
    re-reading the SAME corrupt file (every /sessions poll hits this while
    the index stays broken) finds its copy already there and doesn't write
    another one -- exactly one preserved copy per distinct corrupt version.
    """
    try:
        mtime = path.stat().st_mtime
        timestamp = datetime.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        dest = path.with_name(f"{path.stem}.corrupt-{timestamp}{path.suffix}")
        if not dest.exists():
            shutil.copy2(path, dest)
        return dest
    except OSError as e:
        print(f"[corrupt_files] failed to preserve corrupt file {path}: {e}", flush=True)
        return None
