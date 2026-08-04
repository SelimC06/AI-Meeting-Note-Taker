import json
import threading
from datetime import datetime, timedelta, timezone
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


def test_update_session_fields_updates_matching_record(tmp_path: Path):
    from app.sessions_store import update_session_fields

    append_session(tmp_path, {
        "id": "aaa",
        "created_at": "2026-08-01T10:00:00+00:00",
        "title": "Old Title",
        "notes": "notes",
        "video_path": "aaa/final.webm",
        "trashed_at": None,
    })

    ok = update_session_fields(tmp_path, "aaa", title="New Title")

    assert ok is True
    loaded = load_sessions(tmp_path)
    assert loaded[0]["title"] == "New Title"


def test_update_session_fields_returns_false_for_unknown_id(tmp_path: Path):
    from app.sessions_store import update_session_fields

    assert update_session_fields(tmp_path, "does-not-exist", title="x") is False


def test_update_session_fields_can_set_and_clear_trashed_at(tmp_path: Path):
    from app.sessions_store import update_session_fields

    append_session(tmp_path, {
        "id": "aaa",
        "created_at": "2026-08-01T10:00:00+00:00",
        "title": "T",
        "notes": "",
        "video_path": "",
        "trashed_at": None,
    })

    update_session_fields(tmp_path, "aaa", trashed_at="2026-08-04T00:00:00+00:00")
    assert load_sessions(tmp_path)[0]["trashed_at"] == "2026-08-04T00:00:00+00:00"

    update_session_fields(tmp_path, "aaa", trashed_at=None)
    assert load_sessions(tmp_path)[0]["trashed_at"] is None


def test_remove_session_permanently_deletes_record_and_folder(tmp_path: Path):
    from app.sessions_store import remove_session_permanently

    session_dir = tmp_path / "aaa"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"video bytes")

    append_session(tmp_path, {
        "id": "aaa",
        "created_at": "2026-08-01T10:00:00+00:00",
        "title": "T",
        "notes": "",
        "video_path": str(session_dir / "final.webm"),
        "trashed_at": None,
    })

    ok = remove_session_permanently(tmp_path, "aaa")

    assert ok is True
    assert load_sessions(tmp_path) == []
    assert not session_dir.exists()


def test_remove_session_permanently_returns_false_for_unknown_id(tmp_path: Path):
    from app.sessions_store import remove_session_permanently

    assert remove_session_permanently(tmp_path, "does-not-exist") is False


def test_remove_session_permanently_tolerates_missing_folder(tmp_path: Path):
    from app.sessions_store import remove_session_permanently

    append_session(tmp_path, {
        "id": "aaa",
        "created_at": "2026-08-01T10:00:00+00:00",
        "title": "T",
        "notes": "",
        "video_path": "",
        "trashed_at": None,
    })
    # No folder created on disk for "aaa" -- must not raise.

    ok = remove_session_permanently(tmp_path, "aaa")

    assert ok is True
    assert load_sessions(tmp_path) == []


def test_purge_expired_trash_removes_only_old_trashed_sessions(tmp_path: Path):
    from app.sessions_store import purge_expired_trash

    old_ts = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
    recent_ts = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()

    append_session(tmp_path, {
        "id": "old", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "Old", "notes": "", "video_path": "", "trashed_at": old_ts,
    })
    append_session(tmp_path, {
        "id": "recent", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "Recent", "notes": "", "video_path": "", "trashed_at": recent_ts,
    })
    append_session(tmp_path, {
        "id": "active", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "Active", "notes": "", "video_path": "", "trashed_at": None,
    })

    purged = purge_expired_trash(tmp_path)

    assert purged == 1
    remaining_ids = {r["id"] for r in load_sessions(tmp_path)}
    assert remaining_ids == {"recent", "active"}


def test_purge_expired_trash_returns_zero_when_nothing_expired(tmp_path: Path):
    from app.sessions_store import purge_expired_trash

    append_session(tmp_path, {
        "id": "active", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "Active", "notes": "", "video_path": "", "trashed_at": None,
    })

    assert purge_expired_trash(tmp_path) == 0


def test_purge_expired_trash_respects_custom_max_age(tmp_path: Path):
    from app.sessions_store import purge_expired_trash

    ts_5_days_ago = (datetime.now(timezone.utc) - timedelta(days=5)).isoformat()
    append_session(tmp_path, {
        "id": "aaa", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "T", "notes": "", "video_path": "", "trashed_at": ts_5_days_ago,
    })

    purged = purge_expired_trash(tmp_path, max_age_days=3)

    assert purged == 1
    assert load_sessions(tmp_path) == []


def test_compute_storage_usage_counts_active_and_trashed_sessions(tmp_path: Path):
    from app.sessions_store import compute_storage_usage

    append_session(tmp_path, {
        "id": "a", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "A", "notes": "", "video_path": "", "trashed_at": None,
    })
    append_session(tmp_path, {
        "id": "b", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "B", "notes": "", "video_path": "", "trashed_at": "2026-01-02T00:00:00+00:00",
    })

    usage = compute_storage_usage(tmp_path)

    assert usage["session_count"] == 1
    assert usage["trashed_count"] == 1


def test_compute_storage_usage_sums_file_sizes_under_store_dir(tmp_path: Path):
    from app.sessions_store import compute_storage_usage

    session_dir = tmp_path / "a"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"x" * 100)
    (session_dir / "notes.md").write_bytes(b"y" * 50)

    usage = compute_storage_usage(tmp_path)

    assert usage["used_bytes"] >= 150


def test_compute_storage_usage_reports_free_and_total_bytes(tmp_path: Path):
    from app.sessions_store import compute_storage_usage

    usage = compute_storage_usage(tmp_path)

    assert usage["free_bytes"] > 0
    assert usage["total_bytes"] > 0
    assert usage["total_bytes"] >= usage["free_bytes"]


def test_compute_storage_usage_missing_dir_returns_zeros(tmp_path: Path):
    from app.sessions_store import compute_storage_usage

    missing = tmp_path / "does-not-exist"

    usage = compute_storage_usage(missing)

    assert usage == {
        "used_bytes": 0,
        "free_bytes": 0,
        "total_bytes": 0,
        "session_count": 0,
        "trashed_count": 0,
    }
