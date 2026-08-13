import json
import shutil
from pathlib import Path

import pytest

from app.settings_store import (
    WHISPER_MODEL_CHOICES,
    WHISPER_MODEL_VALUES,
    default_settings,
    load_or_init,
    save,
    StorageMoveError,
    move_storage_dir,
)


def test_whisper_model_choices_values_match_set():
    assert WHISPER_MODEL_VALUES == {c["value"] for c in WHISPER_MODEL_CHOICES}
    assert WHISPER_MODEL_VALUES == {"tiny.en", "base.en", "small.en", "medium.en"}


def test_default_settings_uses_env_vars(monkeypatch, tmp_path):
    monkeypatch.setenv("WHISPER_MODEL", "small.en")
    monkeypatch.setenv("OLLAMA_CHAT_MODEL", "custom-chat:latest")
    storage = tmp_path / "uploads"
    result = default_settings(storage)
    assert result == {
        "whisper_model": "small.en",
        "storage_dir": str(storage),
        "ollama_chat_model": "custom-chat:latest",
        "custom_vocabulary": "",
    }


def test_default_settings_falls_back_without_env_vars(monkeypatch, tmp_path):
    monkeypatch.delenv("WHISPER_MODEL", raising=False)
    monkeypatch.delenv("OLLAMA_CHAT_MODEL", raising=False)
    storage = tmp_path / "uploads"
    result = default_settings(storage)
    assert result["whisper_model"] == "tiny.en"
    assert result["ollama_chat_model"] == "gemma3:4b"
    assert result["storage_dir"] == str(storage)
    assert result["custom_vocabulary"] == ""


def test_load_or_init_seeds_and_persists_when_missing(tmp_path):
    settings_path = tmp_path / "settings.json"
    storage = tmp_path / "uploads"

    result = load_or_init(settings_path, storage)

    assert result["storage_dir"] == str(storage)
    assert settings_path.exists()
    on_disk = json.loads(settings_path.read_text(encoding="utf-8"))
    assert on_disk == result


def test_load_or_init_returns_existing_file_unmodified(tmp_path):
    settings_path = tmp_path / "settings.json"
    storage = tmp_path / "uploads"
    settings_path.write_text(
        json.dumps({
            "whisper_model": "medium.en",
            "storage_dir": str(tmp_path / "custom"),
            "ollama_chat_model": "llama3.1:8b",
        }),
        encoding="utf-8",
    )

    result = load_or_init(settings_path, storage)

    assert result["whisper_model"] == "medium.en"
    assert result["storage_dir"] == str(tmp_path / "custom")
    assert result["ollama_chat_model"] == "llama3.1:8b"


def test_load_or_init_tolerates_corrupt_file(tmp_path):
    settings_path = tmp_path / "settings.json"
    settings_path.write_text("not json", encoding="utf-8")
    storage = tmp_path / "uploads"

    result = load_or_init(settings_path, storage)

    assert result["storage_dir"] == str(storage)


def test_load_or_init_preserves_corrupt_file_aside(tmp_path):
    settings_path = tmp_path / "settings.json"
    settings_path.write_text("not json, and holds the user's real storage_dir clue", encoding="utf-8")
    storage = tmp_path / "uploads"

    load_or_init(settings_path, storage)

    corrupt_siblings = list(tmp_path.glob("settings.corrupt-*.json"))
    assert len(corrupt_siblings) == 1
    assert corrupt_siblings[0].read_text(encoding="utf-8") == (
        "not json, and holds the user's real storage_dir clue"
    )
    # The original path now holds the freshly-seeded defaults.
    assert json.loads(settings_path.read_text(encoding="utf-8"))["storage_dir"] == str(storage)


def test_load_or_init_missing_file_creates_no_corrupt_sibling(tmp_path):
    settings_path = tmp_path / "settings.json"
    storage = tmp_path / "uploads"

    load_or_init(settings_path, storage)

    assert list(tmp_path.glob("settings.corrupt-*.json")) == []


def test_load_or_init_fills_missing_keys_from_defaults(tmp_path):
    settings_path = tmp_path / "settings.json"
    storage = tmp_path / "uploads"
    settings_path.write_text(json.dumps({"whisper_model": "small.en"}), encoding="utf-8")

    result = load_or_init(settings_path, storage)

    assert result["whisper_model"] == "small.en"
    assert result["storage_dir"] == str(storage)
    assert "ollama_chat_model" in result


def test_save_merges_partial_update(tmp_path):
    settings_path = tmp_path / "settings.json"
    storage = tmp_path / "uploads"
    load_or_init(settings_path, storage)

    result = save(settings_path, {"whisper_model": "small.en"}, storage)

    assert result["whisper_model"] == "small.en"
    assert result["storage_dir"] == str(storage)
    on_disk = json.loads(settings_path.read_text(encoding="utf-8"))
    assert on_disk["whisper_model"] == "small.en"


def test_save_no_leftover_tmp_file(tmp_path):
    settings_path = tmp_path / "settings.json"
    storage = tmp_path / "uploads"
    save(settings_path, {"whisper_model": "base.en"}, storage)
    assert not (tmp_path / "settings.json.tmp").exists()
    assert settings_path.exists()


def test_save_fsyncs_before_replace(tmp_path, monkeypatch):
    import os

    settings_path = tmp_path / "settings.json"
    storage = tmp_path / "uploads"
    load_or_init(settings_path, storage)  # seed the file so save() below writes exactly once

    calls = []
    real_fsync = os.fsync
    monkeypatch.setattr(
        "app.settings_store.os.fsync",
        lambda fd: (calls.append(fd), real_fsync(fd))[1],
    )

    save(settings_path, {"whisper_model": "base.en"}, storage)

    assert len(calls) == 1


def test_move_storage_dir_relocates_contents(tmp_path):
    old_dir = tmp_path / "old"
    new_dir = tmp_path / "new"
    old_dir.mkdir()
    (old_dir / "sessions_index.json").write_text("[]", encoding="utf-8")
    session_dir = old_dir / "abc123"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"video")

    move_storage_dir(old_dir, new_dir)

    assert (new_dir / "sessions_index.json").exists()
    assert (new_dir / "abc123" / "final.webm").read_bytes() == b"video"
    assert list(old_dir.iterdir()) == []


def test_move_storage_dir_noop_when_same_path(tmp_path):
    old_dir = tmp_path / "same"
    old_dir.mkdir()
    (old_dir / "sessions_index.json").write_text("[]", encoding="utf-8")

    move_storage_dir(old_dir, old_dir)

    assert (old_dir / "sessions_index.json").exists()


def test_move_storage_dir_refuses_non_empty_destination(tmp_path):
    old_dir = tmp_path / "old"
    new_dir = tmp_path / "new"
    old_dir.mkdir()
    (old_dir / "sessions_index.json").write_text("[]", encoding="utf-8")
    new_dir.mkdir()
    (new_dir / "leftover.txt").write_text("pre-existing", encoding="utf-8")

    with pytest.raises(StorageMoveError, match="not empty"):
        move_storage_dir(old_dir, new_dir)

    # Nothing should have moved.
    assert (old_dir / "sessions_index.json").exists()
    assert (new_dir / "leftover.txt").exists()


def test_move_storage_dir_creates_destination_if_missing(tmp_path):
    old_dir = tmp_path / "old"
    new_dir = tmp_path / "does" / "not" / "exist" / "yet"
    old_dir.mkdir()
    (old_dir / "sessions_index.json").write_text("[]", encoding="utf-8")

    move_storage_dir(old_dir, new_dir)

    assert (new_dir / "sessions_index.json").exists()


def test_move_storage_dir_handles_missing_source(tmp_path):
    old_dir = tmp_path / "old-does-not-exist"
    new_dir = tmp_path / "new"

    move_storage_dir(old_dir, new_dir)

    assert new_dir.exists()
    assert list(new_dir.iterdir()) == []


def test_move_storage_dir_refuses_direct_child_destination(tmp_path):
    old_dir = tmp_path / "old"
    old_dir.mkdir()
    (old_dir / "sessions_index.json").write_text("[]", encoding="utf-8")

    with pytest.raises(StorageMoveError, match="inside"):
        move_storage_dir(old_dir, old_dir / "nested")

    assert (old_dir / "sessions_index.json").exists()


def test_move_storage_dir_wraps_oserror_during_move(tmp_path, monkeypatch):
    old_dir = tmp_path / "old"
    new_dir = tmp_path / "new"
    old_dir.mkdir()
    (old_dir / "sessions_index.json").write_text("[]", encoding="utf-8")
    session_dir = old_dir / "abc123"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"video")

    import app.settings_store as settings_store_module

    def failing_move(src, dst):
        raise OSError("simulated locked file")

    monkeypatch.setattr(settings_store_module.shutil, "move", failing_move)

    with pytest.raises(StorageMoveError):
        move_storage_dir(old_dir, new_dir)


def test_move_storage_dir_wraps_mkdir_oserror(tmp_path):
    old_dir = tmp_path / "old"
    old_dir.mkdir()
    (old_dir / "sessions_index.json").write_text("[]", encoding="utf-8")

    # new_dir's path already exists as a regular file (not a directory), so
    # Path.mkdir(parents=True, exist_ok=True) raises FileExistsError -- this
    # must surface as StorageMoveError, not the raw FileExistsError.
    new_dir = tmp_path / "new_is_a_file"
    new_dir.write_text("i am a file, not a directory", encoding="utf-8")

    with pytest.raises(StorageMoveError):
        move_storage_dir(old_dir, new_dir)


def test_move_storage_dir_moves_index_last(tmp_path, monkeypatch):
    """
    sessions_index.json must be moved last so that a failure partway through
    the loop never orphans it in new_dir while session folders remain in
    old_dir (which would make GET /sessions read old_dir, find no index, and
    report the user's meeting history as gone).
    """
    old_dir = tmp_path / "old"
    new_dir = tmp_path / "new"
    old_dir.mkdir()
    (old_dir / "sessions_index.json").write_text("[]", encoding="utf-8")
    session_dir = old_dir / "abc123"
    session_dir.mkdir()
    (session_dir / "final.webm").write_bytes(b"video")

    import app.settings_store as settings_store_module

    moved_order = []
    real_move = settings_store_module.shutil.move

    def tracking_move(src, dst):
        moved_order.append(Path(src).name)
        return real_move(src, dst)

    monkeypatch.setattr(settings_store_module.shutil, "move", tracking_move)

    move_storage_dir(old_dir, new_dir)

    assert moved_order[-1] == "sessions_index.json"


def test_move_storage_dir_refuses_deeply_nested_destination(tmp_path):
    old_dir = tmp_path / "old"
    session_dir = old_dir / "abc123"
    session_dir.mkdir(parents=True)
    (session_dir / "final.webm").write_bytes(b"video")

    with pytest.raises(StorageMoveError, match="inside"):
        move_storage_dir(old_dir, session_dir / "archive")

    assert (session_dir / "final.webm").read_bytes() == b"video"


def test_save_lock_is_reentrant(tmp_path):
    """
    server.py's patch_settings holds SAVE_LOCK across move_storage_dir AND
    save() (which itself acquires SAVE_LOCK) to close the storage-move race.
    That only works if the lock is reentrant -- a plain threading.Lock would
    deadlock here.
    """
    from app.settings_store import SAVE_LOCK, save

    settings_path = tmp_path / "settings.json"
    default_dir = tmp_path / "uploads"

    with SAVE_LOCK:
        result = save(settings_path, {"whisper_model": "small.en"}, default_dir)

    assert result["whisper_model"] == "small.en"
