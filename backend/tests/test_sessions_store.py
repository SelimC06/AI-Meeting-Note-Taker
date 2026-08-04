import json
import threading
from pathlib import Path

import pytest

from app.sessions_store import extract_title, load_sessions, append_session


def test_extract_title_plain_heading():
    notes = "# Sprint Planning\n\n## Key Points\n- (bullet)\n"
    assert extract_title(notes) == "Sprint Planning"


def test_extract_title_with_prefix():
    notes = "# Title: Zoom Meeting\n\n# Transcript (auto)\nhello\n"
    assert extract_title(notes) == "Zoom Meeting"


def test_extract_title_no_heading_falls_back():
    notes = "no heading here at all\njust text\n"
    assert extract_title(notes) == "Untitled meeting"


def test_extract_title_empty_string_falls_back():
    assert extract_title("") == "Untitled meeting"


def test_load_sessions_missing_file_returns_empty_list(tmp_path: Path):
    assert load_sessions(tmp_path) == []


def test_append_and_load_round_trip(tmp_path: Path):
    record1 = {
        "id": "aaa",
        "created_at": "2026-08-01T10:00:00+00:00",
        "title": "First",
        "notes": "# First\n",
        "video_path": "aaa/final.webm",
    }
    record2 = {
        "id": "bbb",
        "created_at": "2026-08-02T10:00:00+00:00",
        "title": "Second",
        "notes": "# Second\n",
        "video_path": "bbb/final.webm",
    }

    append_session(tmp_path, record1)
    append_session(tmp_path, record2)

    loaded = load_sessions(tmp_path)
    assert len(loaded) == 2
    assert {r["id"] for r in loaded} == {"aaa", "bbb"}


def test_load_sessions_tolerates_corrupt_file(tmp_path: Path):
    (tmp_path / "sessions_index.json").write_text("not json", encoding="utf-8")
    assert load_sessions(tmp_path) == []


def test_load_sessions_tolerates_non_utf8_file(tmp_path: Path):
    (tmp_path / "sessions_index.json").write_bytes(b"\xff\xfe\x00\x01garbage")
    assert load_sessions(tmp_path) == []


def test_append_session_no_leftover_tmp_file(tmp_path: Path):
    record = {
        "id": "aaa",
        "created_at": "2026-08-01T10:00:00+00:00",
        "title": "First",
        "notes": "# First\n",
        "video_path": "aaa/final.webm",
    }
    append_session(tmp_path, record)
    assert not (tmp_path / "sessions_index.json.tmp").exists()
    assert (tmp_path / "sessions_index.json").exists()


def test_append_session_preserves_old_index_if_replace_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    record1 = {
        "id": "aaa",
        "created_at": "2026-08-01T10:00:00+00:00",
        "title": "First",
        "notes": "# First\n",
        "video_path": "aaa/final.webm",
    }
    append_session(tmp_path, record1)
    original_content = (tmp_path / "sessions_index.json").read_text(encoding="utf-8")

    def boom(*args, **kwargs):
        raise OSError("simulated crash before atomic replace")

    monkeypatch.setattr("app.sessions_store.os.replace", boom)

    record2 = {
        "id": "bbb",
        "created_at": "2026-08-02T10:00:00+00:00",
        "title": "Second",
        "notes": "# Second\n",
        "video_path": "bbb/final.webm",
    }
    with pytest.raises(OSError):
        append_session(tmp_path, record2)

    # The real index file must be untouched by the failed write.
    assert (tmp_path / "sessions_index.json").read_text(encoding="utf-8") == original_content
    assert load_sessions(tmp_path) == [record1]


def test_append_session_concurrent_writes_do_not_lose_records(tmp_path: Path):
    n = 20
    barrier = threading.Barrier(n)

    def append_one(i: int) -> None:
        barrier.wait()
        append_session(tmp_path, {
            "id": f"s{i}",
            "created_at": "2026-01-01T00:00:00+00:00",
            "title": f"t{i}",
            "notes": "",
            "video_path": "",
        })

    threads = [threading.Thread(target=append_one, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    sessions = load_sessions(tmp_path)
    assert len(sessions) == n
    assert {s["id"] for s in sessions} == {f"s{i}" for i in range(n)}
