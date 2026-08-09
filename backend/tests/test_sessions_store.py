import json
import os
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


def test_load_sessions_preserves_corrupt_file_aside_instead_of_discarding_it(tmp_path: Path):
    """Regression test for brief 10: an unparseable index used to be
    silently treated as an empty history with no trace of the original
    bytes -- it must now be copied aside first so the data isn't lost.
    """
    (tmp_path / "sessions_index.json").write_text("not json at all", encoding="utf-8")

    assert load_sessions(tmp_path) == []

    preserved = list(tmp_path.glob("sessions_index.corrupt-*.json"))
    assert len(preserved) == 1
    assert preserved[0].read_text(encoding="utf-8") == "not json at all"
    # The original path is untouched -- still there, still corrupt, so a
    # repeated read keeps behaving the same way rather than raising later.
    assert (tmp_path / "sessions_index.json").exists()


def test_load_sessions_corrupt_preservation_failure_does_not_raise(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    (tmp_path / "sessions_index.json").write_text("not json", encoding="utf-8")

    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("app.sessions_store.shutil.copy2", boom)

    # Preserving the corrupt file aside is best-effort; a failure there must
    # not prevent load_sessions from returning its normal empty-list result.
    assert load_sessions(tmp_path) == []


def test_append_session_fsyncs_before_replace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    calls = []
    real_fsync = os.fsync
    monkeypatch.setattr(
        "app.sessions_store.os.fsync",
        lambda fd: (calls.append(fd), real_fsync(fd))[1],
    )

    append_session(tmp_path, {
        "id": "aaa", "created_at": "2026-08-01T10:00:00+00:00",
        "title": "T", "notes": "", "video_path": "", "trashed_at": None,
    })

    assert len(calls) == 1


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


ORPHAN_ID = "0123456789abcdef0123456789abcdef"  # 32 lowercase hex chars, like uuid4().hex


def test_sweep_orphaned_sessions_adopts_a_dir_with_recording_data(tmp_path: Path):
    from app.sessions_store import sweep_orphaned_sessions

    orphan = tmp_path / ORPHAN_ID
    orphan.mkdir()
    (orphan / "screen.webm").write_bytes(b"video bytes")

    result = sweep_orphaned_sessions(tmp_path)

    assert result == {"adopted": [ORPHAN_ID], "deleted": []}
    loaded = load_sessions(tmp_path)
    assert len(loaded) == 1
    assert loaded[0]["id"] == ORPHAN_ID
    assert loaded[0]["status"] == "recovered"
    assert orphan.exists()  # adopted, not deleted


def test_sweep_orphaned_sessions_adopts_a_dir_with_only_a_transcript(tmp_path: Path):
    from app.sessions_store import sweep_orphaned_sessions

    orphan = tmp_path / ORPHAN_ID
    orphan.mkdir()
    (orphan / "transcript_1.txt").write_text("hello", encoding="utf-8")

    result = sweep_orphaned_sessions(tmp_path)

    assert result == {"adopted": [ORPHAN_ID], "deleted": []}


def test_sweep_orphaned_sessions_adopts_a_dir_with_only_frame_images(tmp_path: Path):
    from app.sessions_store import sweep_orphaned_sessions

    orphan = tmp_path / ORPHAN_ID
    orphan.mkdir()
    frames_dir = orphan / "frames"
    frames_dir.mkdir()
    (frames_dir / "frame_001.png").write_bytes(b"\x89PNG")

    result = sweep_orphaned_sessions(tmp_path)

    assert result == {"adopted": [ORPHAN_ID], "deleted": []}


def test_sweep_orphaned_sessions_uses_existing_notes_md_title_and_content_when_present(tmp_path: Path):
    from app.sessions_store import sweep_orphaned_sessions

    orphan = tmp_path / ORPHAN_ID
    orphan.mkdir()
    (orphan / "final.webm").write_bytes(b"video bytes")
    (orphan / "notes.md").write_text("# Sprint Planning\n\n## Key Points\n- x\n", encoding="utf-8")

    sweep_orphaned_sessions(tmp_path)

    loaded = load_sessions(tmp_path)[0]
    assert loaded["title"] == "Sprint Planning"
    assert "Sprint Planning" in loaded["notes"]
    assert loaded["video_path"] == str(orphan / "final.webm")


def test_sweep_orphaned_sessions_deletes_an_empty_dir(tmp_path: Path):
    from app.sessions_store import sweep_orphaned_sessions

    orphan = tmp_path / ORPHAN_ID
    orphan.mkdir()

    result = sweep_orphaned_sessions(tmp_path)

    assert result == {"adopted": [], "deleted": [ORPHAN_ID]}
    assert load_sessions(tmp_path) == []
    assert not orphan.exists()


def test_sweep_orphaned_sessions_deletes_a_dir_with_only_junk_files(tmp_path: Path):
    from app.sessions_store import sweep_orphaned_sessions

    orphan = tmp_path / ORPHAN_ID
    orphan.mkdir()
    (orphan / "system.wav").write_bytes(b"x")  # an intermediate, not recognized recording data

    result = sweep_orphaned_sessions(tmp_path)

    assert result == {"adopted": [], "deleted": [ORPHAN_ID]}
    assert not orphan.exists()


def test_sweep_orphaned_sessions_ignores_already_indexed_dirs(tmp_path: Path):
    from app.sessions_store import sweep_orphaned_sessions

    session_dir = tmp_path / ORPHAN_ID
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"video bytes")
    append_session(tmp_path, {
        "id": ORPHAN_ID, "created_at": "2026-01-01T00:00:00+00:00",
        "title": "Already indexed", "notes": "", "video_path": "", "trashed_at": None,
    })

    result = sweep_orphaned_sessions(tmp_path)

    assert result == {"adopted": [], "deleted": []}
    assert load_sessions(tmp_path) == [
        {
            "id": ORPHAN_ID, "created_at": "2026-01-01T00:00:00+00:00",
            "title": "Already indexed", "notes": "", "video_path": "", "trashed_at": None,
        }
    ]


def test_sweep_orphaned_sessions_ignores_non_session_shaped_directories(tmp_path: Path):
    """Regression guard: the sweep must never touch a directory whose name
    isn't a 32-char hex uuid, e.g. anything a user might place in the
    storage dir by hand, or a future non-session subfolder.
    """
    from app.sessions_store import sweep_orphaned_sessions

    unrelated = tmp_path / "not-a-session-id"
    unrelated.mkdir()
    (unrelated / "some_file.txt").write_text("do not touch", encoding="utf-8")

    result = sweep_orphaned_sessions(tmp_path)

    assert result == {"adopted": [], "deleted": []}
    assert unrelated.exists()
    assert (unrelated / "some_file.txt").exists()


def test_sweep_orphaned_sessions_ignores_files_at_the_top_level(tmp_path: Path):
    from app.sessions_store import sweep_orphaned_sessions

    # sessions_index.json itself lives here, as would any other top-level file.
    (tmp_path / "sessions_index.json").write_text("[]", encoding="utf-8")

    result = sweep_orphaned_sessions(tmp_path)

    assert result == {"adopted": [], "deleted": []}


def test_sweep_orphaned_sessions_missing_store_dir_returns_empty_result(tmp_path: Path):
    from app.sessions_store import sweep_orphaned_sessions

    result = sweep_orphaned_sessions(tmp_path / "does-not-exist")

    assert result == {"adopted": [], "deleted": []}


def test_sweep_orphaned_sessions_one_bad_directory_does_not_abort_the_rest(tmp_path: Path, monkeypatch):
    """A failure adopting/deleting one orphan (e.g. a permissions error)
    must not stop the sweep from handling the others.
    """
    from app import sessions_store
    from app.sessions_store import sweep_orphaned_sessions

    bad_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    good_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    (tmp_path / bad_id).mkdir()
    ((tmp_path / bad_id) / "final.webm").write_bytes(b"x")
    (tmp_path / good_id).mkdir()
    ((tmp_path / good_id) / "final.webm").write_bytes(b"x")

    real_adopt = sessions_store._adopt_orphan_session

    def flaky_adopt(store_dir, session_dir):
        if session_dir.name == bad_id:
            raise OSError("simulated failure")
        return real_adopt(store_dir, session_dir)

    monkeypatch.setattr(sessions_store, "_adopt_orphan_session", flaky_adopt)

    result = sweep_orphaned_sessions(tmp_path)

    assert result == {"adopted": [good_id], "deleted": []}
