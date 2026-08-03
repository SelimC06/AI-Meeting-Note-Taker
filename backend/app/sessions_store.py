from __future__ import annotations
import json
import os
from pathlib import Path
from typing import List

SESSIONS_INDEX_FILENAME = "sessions_index.json"


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


def append_session(store_dir: Path, record: dict) -> None:
    """Append one session record to the index, creating it if needed.

    Writes are atomic: the new content is written to a temporary file in the
    same directory and then swapped into place with os.replace(), so a crash
    or power loss mid-write leaves the previous (intact) index untouched
    instead of leaving a truncated/corrupt file behind.
    """
    sessions = load_sessions(store_dir)
    sessions.append(record)
    final_path = _index_path(store_dir)
    tmp_path = final_path.with_suffix(final_path.suffix + ".tmp")
    tmp_path.write_text(
        json.dumps(sessions, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    os.replace(tmp_path, final_path)
