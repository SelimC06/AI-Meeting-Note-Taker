import json
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app import sessions_store
from app.sessions_store import (
    extract_title,
    load_sessions,
    append_session,
    update_session_fields,
    sweep_stale_partial_mux_files,
    SessionsIndexCorruptError,
)


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


def test_load_sessions_raises_on_corrupt_file(tmp_path: Path):
    """A corrupt index used to read back as [] -- the library looked wiped,
    and the next writer persisted that [] over the user's whole history.
    """
    (tmp_path / "sessions_index.json").write_text("not json", encoding="utf-8")
    with pytest.raises(SessionsIndexCorruptError):
        load_sessions(tmp_path)


def test_load_sessions_raises_on_non_utf8_file(tmp_path: Path):
    (tmp_path / "sessions_index.json").write_bytes(b"\xff\xfe\x00\x01garbage")
    with pytest.raises(SessionsIndexCorruptError):
        load_sessions(tmp_path)


def test_load_sessions_raises_on_wrong_shape(tmp_path: Path):
    (tmp_path / "sessions_index.json").write_text('{"not": "a list"}', encoding="utf-8")
    with pytest.raises(SessionsIndexCorruptError):
        load_sessions(tmp_path)


def test_load_sessions_preserves_corrupt_file_aside_instead_of_discarding_it(tmp_path: Path):
    """Regression test for brief 10: the original bytes of an unparseable
    index must be copied aside so the data isn't lost.
    """
    (tmp_path / "sessions_index.json").write_text("not json at all", encoding="utf-8")

    with pytest.raises(SessionsIndexCorruptError) as excinfo:
        load_sessions(tmp_path)

    preserved = list(tmp_path.glob("sessions_index.corrupt-*.json"))
    assert len(preserved) == 1
    assert preserved[0].read_text(encoding="utf-8") == "not json at all"
    assert excinfo.value.preserved_path == preserved[0]
    # The original path is untouched -- still there, still corrupt.
    assert (tmp_path / "sessions_index.json").read_text(encoding="utf-8") == "not json at all"


def test_repeated_reads_of_a_corrupt_index_keep_a_single_preserved_copy(tmp_path: Path):
    """Every /sessions poll reads the index; while it stays corrupt that
    used to write a fresh .corrupt-<now> copy each time.
    """
    (tmp_path / "sessions_index.json").write_text("not json", encoding="utf-8")

    for _ in range(3):
        with pytest.raises(SessionsIndexCorruptError):
            load_sessions(tmp_path)

    assert len(list(tmp_path.glob("sessions_index.corrupt-*.json"))) == 1


def test_load_sessions_corrupt_preservation_failure_still_raises_corrupt_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    (tmp_path / "sessions_index.json").write_text("not json", encoding="utf-8")

    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("app.corrupt_files.shutil.copy2", boom)

    # Preserving is best-effort; a failure there must surface as the same
    # corrupt-index error (with no copy path), not an OSError.
    with pytest.raises(SessionsIndexCorruptError) as excinfo:
        load_sessions(tmp_path)
    assert excinfo.value.preserved_path is None


@pytest.mark.parametrize("write", [
    lambda d: append_session(d, {"id": "new", "created_at": "", "title": "T"}),
    lambda d: update_session_fields(d, "aaa", title="Renamed"),
    lambda d: sessions_store.remove_session_permanently(d, "aaa"),
    lambda d: sessions_store.rewrite_index_paths(d, d / "old", d / "new"),
])
def test_writers_refuse_to_overwrite_a_corrupt_index(tmp_path: Path, write):
    (tmp_path / "sessions_index.json").write_text('[{"id": "aaa", "title": "trunc', encoding="utf-8")

    with pytest.raises(SessionsIndexCorruptError):
        write(tmp_path)

    assert (tmp_path / "sessions_index.json").read_text(encoding="utf-8") == '[{"id": "aaa", "title": "trunc'


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

    # Once for the index, once for its backup copy (SESSIONS_BACKUP_FILENAME).
    assert len(calls) == 2


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


def test_remove_session_permanently_tombstones_a_dir_rmtree_could_not_fully_remove(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Regression test for G5: on Windows a locked file (AV scanner, media
    player, search indexer, an in-flight export) makes
    shutil.rmtree(ignore_errors=True) fail silently -- the dir survives,
    unindexed. Without a tombstone, the next startup's sweep would adopt it
    right back into the index as a "Recovered" session, resurrecting a
    recording the user explicitly, permanently deleted.
    """
    from app.sessions_store import remove_session_permanently, TOMBSTONE_FILENAME

    session_dir = tmp_path / "aaa"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"video bytes")
    append_session(tmp_path, {
        "id": "aaa", "created_at": "2026-08-01T10:00:00+00:00",
        "title": "T", "notes": "", "video_path": "", "trashed_at": None,
    })

    # Simulate a locked file: rmtree "succeeds" (no exception, since real
    # Windows rmtree(ignore_errors=True) doesn't raise either) but leaves
    # the directory behind.
    monkeypatch.setattr("app.sessions_store.shutil.rmtree", lambda *a, **k: None)

    ok = remove_session_permanently(tmp_path, "aaa")

    assert ok is True
    assert load_sessions(tmp_path) == []  # index entry is still gone
    assert session_dir.exists()  # the locked dir survives
    assert (session_dir / TOMBSTONE_FILENAME).exists()


def test_remove_session_permanently_writes_the_tombstone_before_calling_rmtree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Regression test for re-review-12-13 H1/L2: the tombstone used to be
    written only after a failed rmtree, so a crash between the index write
    and rmtree finishing left an unindexed, un-tombstoned dir that the next
    startup's sweep would adopt back as a "Recovered" session -- resurrecting
    a recording the user already permanently deleted. Writing it first means
    a successful rmtree just erases it along with the directory, and a crash
    mid-rmtree still leaves the tombstone behind to prevent adoption.
    """
    from app.sessions_store import remove_session_permanently, TOMBSTONE_FILENAME

    session_dir = tmp_path / "aaa"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"video bytes")
    append_session(tmp_path, {
        "id": "aaa", "created_at": "2026-08-01T10:00:00+00:00",
        "title": "T", "notes": "", "video_path": "", "trashed_at": None,
    })

    seen_tombstone_before_rmtree = {}

    def fake_rmtree(path, *a, **k):
        seen_tombstone_before_rmtree["present"] = (Path(path) / TOMBSTONE_FILENAME).exists()

    monkeypatch.setattr("app.sessions_store.shutil.rmtree", fake_rmtree)

    remove_session_permanently(tmp_path, "aaa")

    assert seen_tombstone_before_rmtree["present"] is True


def test_remove_session_permanently_does_not_tombstone_a_successfully_removed_dir(tmp_path: Path):
    from app.sessions_store import remove_session_permanently

    session_dir = tmp_path / "aaa"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"video bytes")
    append_session(tmp_path, {
        "id": "aaa", "created_at": "2026-08-01T10:00:00+00:00",
        "title": "T", "notes": "", "video_path": "", "trashed_at": None,
    })

    remove_session_permanently(tmp_path, "aaa")

    assert not session_dir.exists()  # nothing left to hold a tombstone in


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


def test_purge_expired_trash_treats_naive_trashed_at_older_than_cutoff_as_utc_and_purges(tmp_path: Path):
    from app.sessions_store import purge_expired_trash

    naive_old_ts = (datetime.now(timezone.utc) - timedelta(days=31)).replace(tzinfo=None).isoformat()
    append_session(tmp_path, {
        "id": "naive-old", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "Naive old", "notes": "", "video_path": "", "trashed_at": naive_old_ts,
    })

    purged = purge_expired_trash(tmp_path)

    assert purged == 1
    assert load_sessions(tmp_path) == []


def test_purge_expired_trash_keeps_naive_trashed_at_newer_than_cutoff(tmp_path: Path):
    from app.sessions_store import purge_expired_trash

    naive_recent_ts = (datetime.now(timezone.utc) - timedelta(days=1)).replace(tzinfo=None).isoformat()
    append_session(tmp_path, {
        "id": "naive-recent", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "Naive recent", "notes": "", "video_path": "", "trashed_at": naive_recent_ts,
    })

    purged = purge_expired_trash(tmp_path)

    assert purged == 0
    assert {r["id"] for r in load_sessions(tmp_path)} == {"naive-recent"}


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


def test_sweep_orphaned_sessions_retries_and_removes_a_tombstoned_dir_once_unlocked(tmp_path: Path):
    """Regression test for G5: a tombstoned dir (rmtree failed last time
    because a file was locked) must be retried, not adopted -- even though
    it still contains recording data that would otherwise qualify it for
    adoption.
    """
    from app.sessions_store import sweep_orphaned_sessions, TOMBSTONE_FILENAME

    orphan = tmp_path / ORPHAN_ID
    orphan.mkdir()
    (orphan / "final.webm").write_bytes(b"video bytes")
    (orphan / TOMBSTONE_FILENAME).touch()

    result = sweep_orphaned_sessions(tmp_path)

    assert result == {"adopted": [], "deleted": [ORPHAN_ID]}
    assert load_sessions(tmp_path) == []
    assert not orphan.exists()


def test_sweep_orphaned_sessions_leaves_a_still_locked_tombstoned_dir_alone_and_never_adopts_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The file is still locked (rmtree fails again) -- the dir must be left
    tombstoned for the next startup, never indexed/adopted despite still
    containing recording data.
    """
    from app.sessions_store import sweep_orphaned_sessions, TOMBSTONE_FILENAME

    orphan = tmp_path / ORPHAN_ID
    orphan.mkdir()
    (orphan / "final.webm").write_bytes(b"video bytes")
    (orphan / TOMBSTONE_FILENAME).touch()

    monkeypatch.setattr("app.sessions_store.shutil.rmtree", lambda *a, **k: None)

    result = sweep_orphaned_sessions(tmp_path)

    assert result == {"adopted": [], "deleted": []}
    assert load_sessions(tmp_path) == []  # never resurrected into the index
    assert orphan.exists()
    assert (orphan / TOMBSTONE_FILENAME).exists()  # still tombstoned for next time


def _set_mtime_seconds_ago(path: Path, seconds_ago: float) -> None:
    import time

    target = time.time() - seconds_ago
    os.utime(path, (target, target))


def test_sweep_stale_staging_dirs_removes_old_dirs_but_not_recent_ones(tmp_path: Path):
    """Regression test for G6.1: a hard kill mid-upload abandons
    process-staging-* dirs (up to ~2GB each) in the storage dir; the
    session-sweep's hex-only regex skips them and nothing else cleaned them
    up before this fix.
    """
    from app.sessions_store import sweep_stale_staging_dirs, STAGING_DIR_PREFIX

    stale = tmp_path / f"{STAGING_DIR_PREFIX}abc123"
    stale.mkdir()
    (stale / "screen.webm").write_bytes(b"partial upload")
    _set_mtime_seconds_ago(stale, 7200)  # 2 hours old

    fresh = tmp_path / f"{STAGING_DIR_PREFIX}def456"
    fresh.mkdir()
    _set_mtime_seconds_ago(fresh, 5)  # an upload that's currently mid-flight

    removed = sweep_stale_staging_dirs(tmp_path, max_age_seconds=3600)

    assert removed == [stale.name]
    assert not stale.exists()
    assert fresh.exists()  # must not touch an in-progress upload


def test_sweep_stale_staging_dirs_ignores_non_staging_directories(tmp_path: Path):
    from app.sessions_store import sweep_stale_staging_dirs

    unrelated = tmp_path / "not-a-staging-dir"
    unrelated.mkdir()
    _set_mtime_seconds_ago(unrelated, 7200)

    removed = sweep_stale_staging_dirs(tmp_path, max_age_seconds=3600)

    assert removed == []
    assert unrelated.exists()


def test_sweep_stale_staging_dirs_missing_store_dir_returns_empty_list(tmp_path: Path):
    from app.sessions_store import sweep_stale_staging_dirs

    assert sweep_stale_staging_dirs(tmp_path / "does-not-exist") == []


def test_sweep_orphaned_sessions_skips_entirely_when_index_exists_but_is_corrupt(tmp_path: Path):
    """Regression test for G6.2: load_sessions() folds a corrupt index into
    a plain [], which used to make sweep_orphaned_sessions think every real
    session dir was unindexed and adopt all of them as "recovered" --
    losing their real titles/notes and resurrecting trashed sessions as
    active. A corrupt index must make the sweep skip entirely instead.
    """
    from app.sessions_store import sweep_orphaned_sessions

    (tmp_path / "sessions_index.json").write_text("not json", encoding="utf-8")

    real_session = tmp_path / ORPHAN_ID
    real_session.mkdir()
    (real_session / "final.webm").write_bytes(b"video bytes")

    result = sweep_orphaned_sessions(tmp_path)

    assert result == {"adopted": [], "deleted": []}
    assert real_session.exists()  # untouched, not adopted, not deleted


def test_sweep_orphaned_sessions_preserves_the_corrupt_index_aside_even_when_skipping(tmp_path: Path):
    from app.sessions_store import sweep_orphaned_sessions

    (tmp_path / "sessions_index.json").write_text("not json", encoding="utf-8")

    sweep_orphaned_sessions(tmp_path)

    preserved = list(tmp_path.glob("sessions_index.corrupt-*.json"))
    assert len(preserved) == 1


def test_sweep_orphaned_sessions_runs_normally_when_index_is_missing_entirely(tmp_path: Path):
    """A missing index (fresh install, nothing to protect) is not corrupt --
    the sweep must still adopt orphans normally in that case.
    """
    from app.sessions_store import sweep_orphaned_sessions

    orphan = tmp_path / ORPHAN_ID
    orphan.mkdir()
    (orphan / "final.webm").write_bytes(b"video bytes")

    result = sweep_orphaned_sessions(tmp_path)

    assert result == {"adopted": [ORPHAN_ID], "deleted": []}


def test_sweep_orphaned_sessions_rewrites_the_tombstone_when_a_partial_rmtree_strips_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Regression test: shutil.rmtree(ignore_errors=True) doesn't guarantee
    any particular removal order. A partial pass on a tombstoned dir can
    strip the .deleted marker itself before reaching the still-locked file
    -- leaving the dir existing with NO tombstone. Without rewriting it,
    the NEXT boot's sweep would adopt the dir back as "recovered",
    resurrecting a permanently deleted recording two boots later. This is
    distinct from the earlier all-or-nothing rmtree mock (which never
    exercised a partial removal), so it's the case that actually slipped
    through the first pass at this fix.
    """
    from app.sessions_store import sweep_orphaned_sessions, TOMBSTONE_FILENAME

    orphan = tmp_path / ORPHAN_ID
    orphan.mkdir()
    (orphan / "final.webm").write_bytes(b"video bytes")  # simulates the still-locked file
    (orphan / TOMBSTONE_FILENAME).touch()

    def partial_rmtree(path, ignore_errors=False):
        # Removes everything EXCEPT the "locked" file -- including the
        # tombstone marker, same as a real partial pass could.
        p = Path(path)
        for child in list(p.iterdir()):
            if child.name == "final.webm":
                continue
            child.unlink()

    monkeypatch.setattr("app.sessions_store.shutil.rmtree", partial_rmtree)

    # Boot 1: the retry strips the tombstone marker but the locked file
    # survives -- the fix must rewrite the marker before returning.
    result1 = sweep_orphaned_sessions(tmp_path)
    assert result1 == {"adopted": [], "deleted": []}
    assert orphan.exists()
    assert (orphan / TOMBSTONE_FILENAME).exists()
    assert load_sessions(tmp_path) == []

    # Boot 2: without the fix, the tombstone would already be gone here and
    # the still-present recording data would get adopted.
    result2 = sweep_orphaned_sessions(tmp_path)
    assert result2 == {"adopted": [], "deleted": []}
    assert orphan.exists()
    assert (orphan / TOMBSTONE_FILENAME).exists()
    assert load_sessions(tmp_path) == []


def test_rewrite_index_paths_rewrites_video_path_under_new_root(tmp_path: Path):
    from app.sessions_store import rewrite_index_paths

    old_root = tmp_path / "old"
    new_root = tmp_path / "new"
    old_root.mkdir()
    new_root.mkdir()

    append_session(new_root, {
        "id": "abc123", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "T", "notes": "",
        "video_path": str(old_root / "abc123" / "final.webm"),
        "trashed_at": None,
    })

    rewritten = rewrite_index_paths(new_root, old_root, new_root)

    assert rewritten == 1
    record = load_sessions(new_root)[0]
    assert record["video_path"] == str(new_root / "abc123" / "final.webm")


def test_rewrite_index_paths_leaves_none_and_foreign_paths_untouched(tmp_path: Path):
    from app.sessions_store import rewrite_index_paths

    old_root = tmp_path / "old"
    new_root = tmp_path / "new"
    other_root = tmp_path / "somewhere-else"
    old_root.mkdir()
    new_root.mkdir()

    append_session(new_root, {
        "id": "no-path", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "T", "notes": "", "video_path": None, "trashed_at": None,
    })
    append_session(new_root, {
        "id": "foreign", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "T", "notes": "",
        "video_path": str(other_root / "foreign" / "final.webm"),
        "trashed_at": None,
    })

    rewritten = rewrite_index_paths(new_root, old_root, new_root)

    assert rewritten == 0
    records = {r["id"]: r for r in load_sessions(new_root)}
    assert records["no-path"]["video_path"] is None
    assert records["foreign"]["video_path"] == str(other_root / "foreign" / "final.webm")


def test_load_sessions_cache_hit_does_not_reparse(tmp_path: Path, monkeypatch):
    append_session(tmp_path, {
        "id": "aaa", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "First", "notes": "", "video_path": None, "trashed_at": None,
    })
    load_sessions(tmp_path)  # warm the cache

    calls = []
    real_loads = json.loads

    def counting_loads(*args, **kwargs):
        calls.append(True)
        return real_loads(*args, **kwargs)

    monkeypatch.setattr(sessions_store.json, "loads", counting_loads)
    try:
        loaded = load_sessions(tmp_path)
    finally:
        monkeypatch.setattr(sessions_store.json, "loads", real_loads)

    assert calls == []
    assert [r["id"] for r in loaded] == ["aaa"]


def test_load_sessions_cache_invalidated_after_write(tmp_path: Path):
    append_session(tmp_path, {
        "id": "aaa", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "First", "notes": "", "video_path": None, "trashed_at": None,
    })
    assert [r["id"] for r in load_sessions(tmp_path)] == ["aaa"]

    update_session_fields(tmp_path, "aaa", title="Renamed")

    loaded = load_sessions(tmp_path)
    assert loaded[0]["title"] == "Renamed"


def test_load_sessions_reparses_after_external_modification(tmp_path: Path):
    append_session(tmp_path, {
        "id": "aaa", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "First", "notes": "", "video_path": None, "trashed_at": None,
    })
    load_sessions(tmp_path)  # warm the cache

    index_path = tmp_path / "sessions_index.json"
    data = json.loads(index_path.read_text(encoding="utf-8"))
    data.append({
        "id": "bbb", "created_at": "2026-01-02T00:00:00+00:00",
        "title": "Second", "notes": "", "video_path": None, "trashed_at": None,
    })
    index_path.write_text(json.dumps(data), encoding="utf-8")
    # Force a distinct mtime -- some filesystems have coarse mtime
    # resolution, and the write above can otherwise land within the same
    # tick as the cached entry's.
    current = os.stat(index_path).st_mtime_ns
    os.utime(index_path, ns=(current + 1_000_000_000, current + 1_000_000_000))

    loaded = load_sessions(tmp_path)
    assert {r["id"] for r in loaded} == {"aaa", "bbb"}


def test_load_sessions_returned_records_are_copies_not_cache_aliases(tmp_path: Path):
    append_session(tmp_path, {
        "id": "aaa", "created_at": "2026-01-01T00:00:00+00:00",
        "title": "First", "notes": "", "video_path": None, "trashed_at": None,
    })

    first = load_sessions(tmp_path)
    first[0]["title"] = "Mutated by caller"

    second = load_sessions(tmp_path)
    assert second[0]["title"] == "First"


def _age_file(path: Path, seconds_old: int) -> None:
    old = datetime.now(timezone.utc).timestamp() - seconds_old
    os.utime(path, (old, old))


def test_sweep_stale_partial_mux_files_removes_new_and_old_style_names(tmp_path: Path):
    session_dir = tmp_path / "sess-1"
    session_dir.mkdir()
    new_style = session_dir / ".final.webm.part"
    old_style = session_dir / "final.webm.part"
    new_style.write_bytes(b"partial")
    old_style.write_bytes(b"partial")
    _age_file(new_style, 7200)
    _age_file(old_style, 7200)

    removed = sweep_stale_partial_mux_files(tmp_path, max_age_seconds=3600)

    assert set(removed) == {".final.webm.part", "final.webm.part"}
    assert not new_style.exists()
    assert not old_style.exists()


def test_sweep_stale_partial_mux_files_skips_files_within_the_age_cutoff(tmp_path: Path):
    session_dir = tmp_path / "sess-1"
    session_dir.mkdir()
    fresh_new = session_dir / ".final.webm.part"
    fresh_old = session_dir / "final.webm.part"
    fresh_new.write_bytes(b"partial")
    fresh_old.write_bytes(b"partial")

    removed = sweep_stale_partial_mux_files(tmp_path, max_age_seconds=3600)

    assert removed == []
    assert fresh_new.exists()
    assert fresh_old.exists()


def test_sweep_stale_partial_mux_files_does_not_double_process_a_file(tmp_path: Path):
    session_dir = tmp_path / "sess-1"
    session_dir.mkdir()
    stale = session_dir / ".final.webm.part"
    stale.write_bytes(b"partial")
    _age_file(stale, 7200)

    removed = sweep_stale_partial_mux_files(tmp_path, max_age_seconds=3600)

    assert removed == [".final.webm.part"]


def test_sweep_stale_partial_mux_files_missing_store_dir_returns_empty(tmp_path: Path):
    assert sweep_stale_partial_mux_files(tmp_path / "does-not-exist") == []


# ---- transcript segments storage --------------------------------------------

def test_write_and_load_transcript_segments_round_trip(tmp_path: Path):
    from app.sessions_store import write_transcript_segments, load_transcript_segments

    session_dir = tmp_path / "sess-1"
    segments = [
        {"start": 0.0, "end": 1.5, "speaker": "You", "text": "hello"},
        {"start": 1.5, "end": 3.0, "speaker": "Others", "text": "hi there"},
    ]

    write_transcript_segments(session_dir, segments)

    assert load_transcript_segments(session_dir) == segments


def test_load_transcript_segments_missing_file_returns_empty_list(tmp_path: Path):
    from app.sessions_store import load_transcript_segments

    assert load_transcript_segments(tmp_path / "sess-1") == []


def test_load_transcript_segments_tolerates_corrupt_file(tmp_path: Path):
    from app.sessions_store import load_transcript_segments

    session_dir = tmp_path / "sess-1"
    session_dir.mkdir()
    (session_dir / "transcript.json").write_text("{not valid json", encoding="utf-8")

    assert load_transcript_segments(session_dir) == []


def test_load_transcript_segments_tolerates_non_list_json(tmp_path: Path):
    from app.sessions_store import load_transcript_segments

    session_dir = tmp_path / "sess-1"
    session_dir.mkdir()
    (session_dir / "transcript.json").write_text(json.dumps({"not": "a list"}), encoding="utf-8")

    assert load_transcript_segments(session_dir) == []


def test_write_transcript_segments_fsyncs_before_replace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from app.sessions_store import write_transcript_segments

    calls = []
    real_fsync = os.fsync
    monkeypatch.setattr(
        "app.sessions_store.os.fsync",
        lambda fd: (calls.append(fd), real_fsync(fd))[1],
    )

    write_transcript_segments(tmp_path / "sess-1", [{"start": 0.0, "end": 1.0, "speaker": "You", "text": "hi"}])

    assert len(calls) == 1


def test_write_transcript_segments_no_leftover_tmp_file(tmp_path: Path):
    from app.sessions_store import write_transcript_segments

    session_dir = tmp_path / "sess-1"
    write_transcript_segments(session_dir, [{"start": 0.0, "end": 1.0, "speaker": "You", "text": "hi"}])

    assert not (session_dir / "transcript.json.tmp").exists()
    assert (session_dir / "transcript.json").exists()


def test_write_transcript_segments_creates_session_dir_if_missing(tmp_path: Path):
    from app.sessions_store import write_transcript_segments

    session_dir = tmp_path / "not-yet-created"
    write_transcript_segments(session_dir, [])

    assert (session_dir / "transcript.json").exists()


# ---- speaker name overrides (Track B: rename SPEAKER_00 -> a real name) ----

def test_write_and_load_speaker_names_round_trip(tmp_path: Path):
    from app.sessions_store import write_speaker_names, load_speaker_names

    session_dir = tmp_path / "sess-1"
    names = {"SPEAKER_00": "Alice", "SPEAKER_01": "Bob"}

    write_speaker_names(session_dir, names)

    assert load_speaker_names(session_dir) == names


def test_load_speaker_names_missing_file_returns_empty_dict(tmp_path: Path):
    from app.sessions_store import load_speaker_names

    assert load_speaker_names(tmp_path / "sess-1") == {}


def test_load_speaker_names_tolerates_corrupt_file(tmp_path: Path):
    from app.sessions_store import load_speaker_names

    session_dir = tmp_path / "sess-1"
    session_dir.mkdir()
    (session_dir / "speaker_names.json").write_text("{not valid json", encoding="utf-8")

    assert load_speaker_names(session_dir) == {}


def test_load_speaker_names_tolerates_non_dict_json(tmp_path: Path):
    from app.sessions_store import load_speaker_names

    session_dir = tmp_path / "sess-1"
    session_dir.mkdir()
    (session_dir / "speaker_names.json").write_text(json.dumps(["not", "a", "dict"]), encoding="utf-8")

    assert load_speaker_names(session_dir) == {}


def test_write_speaker_names_merges_into_existing_map(tmp_path: Path):
    from app.sessions_store import write_speaker_names, load_speaker_names

    session_dir = tmp_path / "sess-1"
    write_speaker_names(session_dir, {"SPEAKER_00": "Alice"})
    write_speaker_names(session_dir, {"SPEAKER_01": "Bob"})

    assert load_speaker_names(session_dir) == {"SPEAKER_00": "Alice", "SPEAKER_01": "Bob"}


def test_write_speaker_names_no_leftover_tmp_file(tmp_path: Path):
    from app.sessions_store import write_speaker_names

    session_dir = tmp_path / "sess-1"
    write_speaker_names(session_dir, {"SPEAKER_00": "Alice"})

    assert not (session_dir / "speaker_names.json.tmp").exists()
    assert (session_dir / "speaker_names.json").exists()


# ---------- corrupt index recovery ----------

def _rec(sid, **fields):
    return {"id": sid, "created_at": "2026-08-01T10:00:00+00:00", "title": f"Title {sid}",
            "notes": f"# Title {sid}\n", "video_path": "", "trashed_at": None, **fields}


def _session_dir(store: Path, sid: str) -> Path:
    d = store / sid
    d.mkdir()
    (d / "final.webm").write_bytes(b"video")
    (d / "notes.md").write_text(f"# Notes heading {sid}\n", encoding="utf-8")
    return d


A_ID = "a" * 32
B_ID = "b" * 32
C_ID = "c" * 32


def test_every_index_write_refreshes_the_backup_copy(tmp_path: Path):
    append_session(tmp_path, _rec(A_ID))
    update_session_fields(tmp_path, A_ID, title="Renamed")

    backup = json.loads((tmp_path / sessions_store.SESSIONS_BACKUP_FILENAME).read_text(encoding="utf-8"))
    assert backup == load_sessions(tmp_path)
    assert backup[0]["title"] == "Renamed"


def test_recover_sessions_index_restores_metadata_from_backup(tmp_path: Path):
    _session_dir(tmp_path, A_ID)
    _session_dir(tmp_path, B_ID)
    append_session(tmp_path, _rec(A_ID, title="Board review", status="failed"))
    append_session(tmp_path, _rec(B_ID, trashed_at="2026-08-02T10:00:00+00:00"))
    (tmp_path / "sessions_index.json").write_text("[{trunc", encoding="utf-8")

    result = sessions_store.recover_sessions_index(tmp_path)

    assert result["source"] == "backup"
    assert result["restored"] == 2 and result["adopted"] == 0
    by_id = {r["id"]: r for r in load_sessions(tmp_path)}
    # Titles, failed status, and trash state all survive -- the old boot
    # sweep path re-adopted all of these as active "Recovered" sessions.
    assert by_id[A_ID]["title"] == "Board review"
    assert by_id[A_ID]["status"] == "failed"
    assert by_id[B_ID]["trashed_at"] == "2026-08-02T10:00:00+00:00"
    # The damaged original is kept.
    assert Path(result["preserved_copy"]).read_text(encoding="utf-8") == "[{trunc"


def test_recover_sessions_index_adopts_folders_missing_from_the_backup(tmp_path: Path):
    _session_dir(tmp_path, A_ID)
    append_session(tmp_path, _rec(A_ID))
    _session_dir(tmp_path, B_ID)  # recorded, but its index write is what got lost
    (tmp_path / "sessions_index.json").write_text("garbage", encoding="utf-8")

    result = sessions_store.recover_sessions_index(tmp_path)

    assert result == {**result, "source": "backup", "restored": 1, "adopted": 1}
    assert {r["id"] for r in load_sessions(tmp_path)} == {A_ID, B_ID}


def test_recover_sessions_index_rebuilds_from_folders_without_a_backup(tmp_path: Path):
    _session_dir(tmp_path, A_ID)
    _session_dir(tmp_path, B_ID)
    tomb = _session_dir(tmp_path, C_ID)
    (tomb / sessions_store.TOMBSTONE_FILENAME).touch()
    (tmp_path / "sessions_index.json").write_text("garbage", encoding="utf-8")

    result = sessions_store.recover_sessions_index(tmp_path)

    assert result["source"] == "rebuild"
    records = load_sessions(tmp_path)
    assert {r["id"] for r in records} == {A_ID, B_ID}  # tombstoned C stays deleted
    assert all(r["status"] == "recovered" for r in records)
    assert {r["title"] for r in records} == {f"Notes heading {A_ID}", f"Notes heading {B_ID}"}


def test_recover_sessions_index_skips_backup_records_tombstoned_since(tmp_path: Path):
    _session_dir(tmp_path, A_ID)
    b_dir = _session_dir(tmp_path, B_ID)
    append_session(tmp_path, _rec(A_ID))
    append_session(tmp_path, _rec(B_ID))
    (b_dir / sessions_store.TOMBSTONE_FILENAME).touch()
    (tmp_path / "sessions_index.json").write_text("garbage", encoding="utf-8")

    sessions_store.recover_sessions_index(tmp_path)

    assert [r["id"] for r in load_sessions(tmp_path)] == [A_ID]


def test_recover_sessions_index_is_a_noop_on_a_healthy_index(tmp_path: Path):
    append_session(tmp_path, _rec(A_ID))
    before = (tmp_path / "sessions_index.json").read_text(encoding="utf-8")

    assert sessions_store.recover_sessions_index(tmp_path)["source"] == "none"
    assert (tmp_path / "sessions_index.json").read_text(encoding="utf-8") == before


def test_recover_sessions_index_refuses_when_the_corrupt_file_cannot_be_preserved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    (tmp_path / "sessions_index.json").write_text("garbage", encoding="utf-8")
    monkeypatch.setattr(sessions_store, "preserve_corrupt_copy", lambda path: None)

    with pytest.raises(OSError):
        sessions_store.recover_sessions_index(tmp_path)
    assert (tmp_path / "sessions_index.json").read_text(encoding="utf-8") == "garbage"


# ---------- knowledge graph cleanup on permanent delete ----------

def _index_in_graph(store: Path, sid: str, name: str) -> None:
    from app import knowledge_graph
    knowledge_graph.merge_extraction(store, sid, {
        "entities": [
            {"id": 1, "type": "person", "name": name, "aliases": []},
            {"id": 2, "type": "project", "name": f"Project of {sid}", "aliases": []},
        ],
        "relations": [{"source_id": 1, "relation": "owns", "target_id": 2}],
    })


def test_remove_session_permanently_removes_its_knowledge_graph_data(tmp_path: Path):
    from app import knowledge_graph

    append_session(tmp_path, _rec(A_ID))
    append_session(tmp_path, _rec(B_ID))
    _index_in_graph(tmp_path, A_ID, "Sarah Klein")
    _index_in_graph(tmp_path, B_ID, "Sarah Klein")

    sessions_store.remove_session_permanently(tmp_path, A_ID)

    graph = knowledge_graph.load_graph(tmp_path)
    assert graph["indexed_sessions"] == [B_ID]
    assert all(e["session_id"] != A_ID for e in graph["edges"])
    assert all(A_ID not in n["sessions"] for n in graph["nodes"].values())
    # A's own project node is gone; the person shared with B is kept.
    assert {n["name"] for n in graph["nodes"].values()} == {"Sarah Klein", f"Project of {B_ID}"}
    assert A_ID not in (tmp_path / "knowledge_graph.json").read_text(encoding="utf-8")


def test_purge_expired_trash_removes_knowledge_graph_data(tmp_path: Path):
    from app import knowledge_graph

    old = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
    append_session(tmp_path, _rec(A_ID, trashed_at=old))
    _index_in_graph(tmp_path, A_ID, "Sarah Klein")

    assert sessions_store.purge_expired_trash(tmp_path) == 1

    assert knowledge_graph.load_graph(tmp_path) == knowledge_graph.empty_graph()


def test_remove_session_permanently_survives_a_knowledge_graph_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from app import knowledge_graph

    append_session(tmp_path, _rec(A_ID))

    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(knowledge_graph, "remove_session", boom)

    assert sessions_store.remove_session_permanently(tmp_path, A_ID) is True
    assert load_sessions(tmp_path) == []


# ---------- speaker names concurrency ----------

def test_concurrent_speaker_name_writes_keep_every_rename(tmp_path: Path):
    from app.sessions_store import write_speaker_names, load_speaker_names

    session_dir = tmp_path / "sess"
    errors = []
    barrier = threading.Barrier(16)

    def rename(i):
        try:
            barrier.wait()
            write_speaker_names(session_dir, {f"SPEAKER_{i:02d}": f"Name {i}"})
        except Exception as e:  # pragma: no cover - asserted below
            errors.append(e)

    threads = [threading.Thread(target=rename, args=(i,)) for i in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    assert load_speaker_names(session_dir) == {f"SPEAKER_{i:02d}": f"Name {i}" for i in range(16)}
    assert list(session_dir.glob("*.tmp")) == []


def test_write_speaker_names_uses_a_unique_temp_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from app.sessions_store import write_speaker_names

    session_dir = tmp_path / "sess"
    replaced_from = []
    real_replace = os.replace
    monkeypatch.setattr(
        "app.sessions_store.os.replace",
        lambda src, dst: (replaced_from.append(Path(src).name), real_replace(src, dst))[1],
    )

    write_speaker_names(session_dir, {"SPEAKER_00": "Alice"})
    write_speaker_names(session_dir, {"SPEAKER_01": "Bob"})

    assert len(set(replaced_from)) == 2
    assert "speaker_names.json.tmp" not in replaced_from


def test_write_speaker_names_cleans_up_temp_file_on_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from app.sessions_store import write_speaker_names

    session_dir = tmp_path / "sess"

    def boom(src, dst):
        raise OSError("replace failed")

    monkeypatch.setattr("app.sessions_store.os.replace", boom)

    with pytest.raises(OSError):
        write_speaker_names(session_dir, {"SPEAKER_00": "Alice"})
    assert list(session_dir.iterdir()) == []
