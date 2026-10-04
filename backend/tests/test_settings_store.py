import json
import os
import shutil
import stat
from pathlib import Path

import pytest

from app.settings_store import (
    WHISPER_MODEL_CHOICES,
    WHISPER_MODEL_VALUES,
    default_settings,
    load_checked,
    load_or_init,
    save,
    StorageMoveError,
    move_storage_dir,
)


def test_whisper_model_choices_values_match_set():
    assert WHISPER_MODEL_VALUES == {c["value"] for c in WHISPER_MODEL_CHOICES}
    # Multilingual sizes -- the English-only ".en" variant is picked at
    # transcription time by resolve_whisper_model when the language is "en".
    assert WHISPER_MODEL_VALUES == {"tiny", "base", "small", "medium"}


def test_default_settings_uses_env_vars(monkeypatch, tmp_path):
    monkeypatch.setenv("WHISPER_MODEL", "small.en")
    monkeypatch.setenv("OLLAMA_CHAT_MODEL", "custom-chat:latest")
    storage = tmp_path / "uploads"
    result = default_settings(storage)
    assert result == {
        # A legacy ".en" env value is normalized to its size.
        "whisper_model": "small",
        "transcription_language": "auto",
        "storage_dir": str(storage),
        "ollama_chat_model": "custom-chat:latest",
        "custom_vocabulary": "",
        "advanced_diarization_enabled": False,
        "huggingface_token": "",
        "ai_provider": "builtin",
        "custom_api_base_url": "",
        "custom_api_key": "",
        "custom_model_name": "",
    }


def test_default_settings_includes_custom_provider_fields(tmp_path):
    storage = tmp_path / "uploads"
    result = default_settings(storage)
    assert result["ai_provider"] == "builtin"
    assert result["custom_api_base_url"] == ""
    assert result["custom_api_key"] == ""
    assert result["custom_model_name"] == ""


def test_load_or_init_backfills_custom_provider_fields_for_an_older_settings_file(tmp_path):
    storage = tmp_path / "uploads"
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps({"whisper_model": "small.en", "storage_dir": str(storage)}),
        encoding="utf-8",
    )
    result = load_or_init(path, storage)
    assert result["ai_provider"] == "ollama"
    assert result["custom_api_base_url"] == ""
    assert result["custom_api_key"] == ""
    assert result["custom_model_name"] == ""


def test_default_settings_falls_back_without_env_vars(monkeypatch, tmp_path):
    monkeypatch.delenv("WHISPER_MODEL", raising=False)
    monkeypatch.delenv("OLLAMA_CHAT_MODEL", raising=False)
    storage = tmp_path / "uploads"
    result = default_settings(storage)
    assert result["whisper_model"] == "base"
    assert result["transcription_language"] == "auto"
    assert result["ollama_chat_model"] == "gemma3:4b"
    assert result["storage_dir"] == str(storage)
    assert result["custom_vocabulary"] == ""
    assert result["advanced_diarization_enabled"] is False
    assert result["huggingface_token"] == ""


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
            "whisper_model": "medium",
            "storage_dir": str(tmp_path / "custom"),
            "ollama_chat_model": "llama3.1:8b",
        }),
        encoding="utf-8",
    )

    result = load_or_init(settings_path, storage)

    assert result["whisper_model"] == "medium"
    assert result["storage_dir"] == str(tmp_path / "custom")
    assert result["ollama_chat_model"] == "llama3.1:8b"


def test_load_or_init_migrates_a_legacy_english_only_model(tmp_path):
    """A pre-multilingual settings.json stored a concrete ".en" model name
    and had no language setting: the size is kept and the language pinned
    to English, so resolve_whisper_model lands on the exact model that
    install was already running."""
    from app.settings_store import resolve_whisper_model

    settings_path = tmp_path / "settings.json"
    storage = tmp_path / "uploads"
    settings_path.write_text(
        json.dumps({"whisper_model": "small.en", "storage_dir": str(tmp_path / "custom")}),
        encoding="utf-8",
    )

    result = load_or_init(settings_path, storage)

    assert result["whisper_model"] == "small"
    assert result["transcription_language"] == "en"
    assert resolve_whisper_model(result["whisper_model"], result["transcription_language"]) == "small.en"


def test_load_or_init_respects_an_explicit_language_next_to_a_legacy_model(tmp_path):
    settings_path = tmp_path / "settings.json"
    storage = tmp_path / "uploads"
    settings_path.write_text(
        json.dumps({
            "whisper_model": "small.en",
            "transcription_language": "tr",
            "storage_dir": str(tmp_path / "custom"),
        }),
        encoding="utf-8",
    )

    result = load_or_init(settings_path, storage)

    assert result["whisper_model"] == "small"
    assert result["transcription_language"] == "tr"


def test_resolve_whisper_model_picks_the_en_variant_only_for_english():
    from app.settings_store import resolve_whisper_model

    assert resolve_whisper_model("base", "en") == "base.en"
    assert resolve_whisper_model("base", "auto") == "base"
    assert resolve_whisper_model("base", "tr") == "base"
    # Legacy concrete names from an old queued job's inputs snapshot.
    assert resolve_whisper_model("base.en", "en") == "base.en"
    assert resolve_whisper_model("base.en", "auto") == "base"


def test_resolve_transcribe_language_maps_auto_to_none():
    from app.settings_store import resolve_transcribe_language

    assert resolve_transcribe_language("auto") is None
    assert resolve_transcribe_language("en") == "en"
    assert resolve_transcribe_language("tr") == "tr"


def test_transcription_language_choices_are_valid_and_include_auto():
    from app.settings_store import (
        TRANSCRIPTION_LANGUAGE_CHOICES,
        TRANSCRIPTION_LANGUAGE_VALUES,
    )

    assert TRANSCRIPTION_LANGUAGE_VALUES == {c["value"] for c in TRANSCRIPTION_LANGUAGE_CHOICES}
    assert "auto" in TRANSCRIPTION_LANGUAGE_VALUES
    assert "en" in TRANSCRIPTION_LANGUAGE_VALUES
    # "auto" is the list's first entry (the dropdown default position).
    assert TRANSCRIPTION_LANGUAGE_CHOICES[0]["value"] == "auto"


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
    # The damaged original is NOT replaced with defaults -- that would make
    # the next launch look healthy while silently using the default folder.
    assert settings_path.read_text(encoding="utf-8") == (
        "not json, and holds the user's real storage_dir clue"
    )


def test_load_checked_reports_corrupt_file_and_keeps_a_single_copy(tmp_path):
    settings_path = tmp_path / "settings.json"
    settings_path.write_text("{oops", encoding="utf-8")
    storage = tmp_path / "uploads"

    for _ in range(3):
        settings, error = load_checked(settings_path, storage)

    assert settings["storage_dir"] == str(storage)
    assert error["storage_dir_recovered"] is False
    assert "default recordings folder" in error["message"]
    assert len(list(tmp_path.glob("settings.corrupt-*.json"))) == 1


def test_load_checked_salvages_storage_dir_from_a_truncated_file(tmp_path):
    # The salvage has to undo JSON escaping. On macOS/Linux, quotes in the
    # folder name exercise that; Windows forbids '"' in file names, but there
    # every path is full of backslashes -- which JSON escapes as \\ -- so
    # the plain name still tests the escaped-character salvage.
    custom = tmp_path / ('My Recordings "quoted"' if os.name != "nt" else "My Recordings")
    custom.mkdir()
    full = json.dumps({"whisper_model": "small.en", "storage_dir": str(custom), "custom_api_key": "sk-1"})
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(full[: full.index("custom_api_key")], encoding="utf-8")

    settings, error = load_checked(settings_path, tmp_path / "uploads")

    assert settings["storage_dir"] == str(custom)
    assert error["storage_dir_recovered"] is True
    assert str(custom) in error["message"]


def test_load_checked_ignores_a_salvaged_storage_dir_that_does_not_exist(tmp_path):
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(
        '{"storage_dir": "' + str(tmp_path / "gone") + '", "whisper', encoding="utf-8"
    )

    settings, error = load_checked(settings_path, tmp_path / "uploads")

    assert settings["storage_dir"] == str(tmp_path / "uploads")
    assert error["storage_dir_recovered"] is False


def test_load_checked_valid_or_missing_file_reports_no_error(tmp_path):
    settings_path = tmp_path / "settings.json"
    assert load_checked(settings_path, tmp_path / "uploads")[1] is None  # seeds defaults
    assert load_checked(settings_path, tmp_path / "uploads")[1] is None  # reads them back


def test_save_over_a_corrupt_file_rewrites_it_and_clears_the_error(tmp_path):
    settings_path = tmp_path / "settings.json"
    settings_path.write_text("{oops", encoding="utf-8")
    storage = tmp_path / "uploads"

    save(settings_path, {"whisper_model": "small"}, storage)

    settings, error = load_checked(settings_path, storage)
    assert error is None
    assert settings["whisper_model"] == "small"
    assert len(list(tmp_path.glob("settings.corrupt-*.json"))) == 1


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")
def test_settings_file_is_written_owner_only(tmp_path):
    settings_path = tmp_path / "settings.json"
    # A leftover temp file with loose permissions must not carry them over.
    tmp_file = tmp_path / "settings.json.tmp"
    tmp_file.write_text("", encoding="utf-8")
    os.chmod(tmp_file, 0o644)
    old_umask = os.umask(0o022)
    try:
        save(settings_path, {"custom_api_key": "sk-secret"}, tmp_path / "uploads")
    finally:
        os.umask(old_umask)

    assert stat.S_IMODE(settings_path.stat().st_mode) == 0o600


def test_load_or_init_missing_file_creates_no_corrupt_sibling(tmp_path):
    settings_path = tmp_path / "settings.json"
    storage = tmp_path / "uploads"

    load_or_init(settings_path, storage)

    assert list(tmp_path.glob("settings.corrupt-*.json")) == []


def test_load_or_init_fills_missing_keys_from_defaults(tmp_path):
    settings_path = tmp_path / "settings.json"
    storage = tmp_path / "uploads"
    settings_path.write_text(json.dumps({"whisper_model": "small"}), encoding="utf-8")

    result = load_or_init(settings_path, storage)

    assert result["whisper_model"] == "small"
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


def test_save_persists_advanced_diarization_settings(tmp_path):
    settings_path = tmp_path / "settings.json"
    storage = tmp_path / "uploads"
    load_or_init(settings_path, storage)

    result = save(
        settings_path,
        {"advanced_diarization_enabled": True, "huggingface_token": "hf_abc123"},
        storage,
    )

    assert result["advanced_diarization_enabled"] is True
    assert result["huggingface_token"] == "hf_abc123"
    on_disk = json.loads(settings_path.read_text(encoding="utf-8"))
    assert on_disk["advanced_diarization_enabled"] is True
    assert on_disk["huggingface_token"] == "hf_abc123"


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


def test_move_storage_dir_leaves_the_exports_folder_behind_and_removes_it(tmp_path):
    from app.settings_store import EXPORT_DIR_NAME

    old = tmp_path / "old"
    (old / "sess1").mkdir(parents=True)
    (old / "sess1" / "final.webm").write_bytes(b"v")
    (old / EXPORT_DIR_NAME).mkdir()
    (old / EXPORT_DIR_NAME / "meeting-export-abc.zip").write_bytes(b"zip")
    new = tmp_path / "new"

    move_storage_dir(old, new)

    assert (new / "sess1" / "final.webm").exists()
    assert not (new / EXPORT_DIR_NAME).exists()
    assert not (old / EXPORT_DIR_NAME).exists()


def test_move_storage_dir_is_not_broken_by_an_export_that_cannot_be_removed(tmp_path, monkeypatch):
    from app import settings_store

    old = tmp_path / "old"
    (old / "sess1").mkdir(parents=True)
    (old / settings_store.EXPORT_DIR_NAME).mkdir()
    moved = []
    real_move = shutil.move
    monkeypatch.setattr(settings_store.shutil, "move", lambda s, d: (moved.append(Path(s).name), real_move(s, d))[1])

    move_storage_dir(old, tmp_path / "new")

    assert moved == ["sess1"]  # .exports never attempted


def _case_insensitive(tmp_path):
    probe = tmp_path / "CaseProbe"
    probe.mkdir()
    return (tmp_path / "caseprobe").exists()


def test_move_storage_dir_treats_a_differently_cased_path_as_the_same_folder(tmp_path):
    if not _case_insensitive(tmp_path):
        pytest.skip("case-sensitive filesystem")
    old = tmp_path / "Recordings"
    (old / "sess1").mkdir(parents=True)

    move_storage_dir(old, tmp_path / "recordings")  # no-op, not a move into itself

    assert (old / "sess1").is_dir()


def test_move_storage_dir_refuses_a_differently_cased_path_inside_itself(tmp_path):
    if not _case_insensitive(tmp_path):
        pytest.skip("case-sensitive filesystem")
    old = tmp_path / "Recordings"
    (old / "sess1").mkdir(parents=True)

    with pytest.raises(StorageMoveError, match="inside"):
        move_storage_dir(old, tmp_path / "recordings" / "sub")
    assert sorted(p.name for p in old.iterdir()) == ["sess1"]


def test_move_storage_dir_refuses_a_symlinked_alias_inside_itself(tmp_path):
    old = tmp_path / "old"
    (old / "sess1").mkdir(parents=True)
    alias = tmp_path / "alias"
    try:
        alias.symlink_to(old, target_is_directory=True)
    except OSError as e:
        # Windows without Developer Mode / the symlink privilege.
        pytest.skip(f"can't create symlinks here: {e}")

    with pytest.raises(StorageMoveError, match="inside"):
        move_storage_dir(old, alias / "nested")


def test_a_move_that_fails_partway_puts_everything_back(tmp_path, monkeypatch):
    from app import settings_store

    old = tmp_path / "old"
    for name in ("a", "b", "c"):
        (old / name).mkdir(parents=True)
    (old / "sessions_index.json").write_text("[]", encoding="utf-8")
    new = tmp_path / "new"
    real_move = shutil.move

    def failing_on_c(src, dst):
        if Path(src).name == "c":
            raise OSError("disk full")
        return real_move(src, dst)

    monkeypatch.setattr(settings_store.shutil, "move", failing_on_c)

    with pytest.raises(StorageMoveError, match="Nothing was changed"):
        move_storage_dir(old, new)

    assert sorted(p.name for p in old.iterdir()) == ["a", "b", "c", "sessions_index.json"]
    assert list(new.iterdir()) == []
    # ...so a retry isn't refused as "not empty".
    monkeypatch.setattr(settings_store.shutil, "move", real_move)
    move_storage_dir(old, new)
    assert sorted(p.name for p in new.iterdir()) == ["a", "b", "c", "sessions_index.json"]


def test_a_move_that_cannot_be_undone_says_exactly_what_is_where(tmp_path, monkeypatch):
    from app import settings_store

    old = tmp_path / "old"
    for name in ("a", "b"):
        (old / name).mkdir(parents=True)
    new = tmp_path / "new"
    real_move = shutil.move

    def flaky(src, dst):
        if Path(src).name == "b":
            raise OSError("disk full")
        if Path(src).parent == new:  # moving back
            raise OSError("permission denied")
        return real_move(src, dst)

    monkeypatch.setattr(settings_store.shutil, "move", flaky)

    with pytest.raises(StorageMoveError) as excinfo:
        move_storage_dir(old, new)
    message = str(excinfo.value)
    assert "could not be moved back" in message and "a" in message and str(new) in message


def test_a_partial_copy_left_by_a_failed_move_is_removed(tmp_path, monkeypatch):
    from app import settings_store

    old = tmp_path / "old"
    (old / "a").mkdir(parents=True)
    (old / "a" / "final.webm").write_bytes(b"video")
    new = tmp_path / "new"

    def half_copy(src, dst):
        # A cross-drive copy dying midway: partial destination, source intact.
        Path(dst).mkdir()
        (Path(dst) / "final.webm").write_bytes(b"vi")
        raise OSError("device disconnected")

    monkeypatch.setattr(settings_store.shutil, "move", half_copy)

    with pytest.raises(StorageMoveError):
        move_storage_dir(old, new)
    assert (old / "a" / "final.webm").read_bytes() == b"video"
    assert list(new.iterdir()) == []
