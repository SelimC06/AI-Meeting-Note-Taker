import importlib

import pytest

import app.bin_paths as bin_paths


@pytest.fixture(autouse=True)
def _restore_bin_paths(monkeypatch):
    """Reloads app.bin_paths from the REAL environment after each test.

    The tests below reload the module under a monkeypatched environment, and
    its values are module-level constants read at import time. monkeypatch
    restores the environment variables at teardown but not the module, so it
    kept whatever the last test left -- e.g. the bare "ffprobe" -- and any
    test module imported afterwards (test_server.py, via `from .bin_paths
    import ...`) got that instead of FFMPEG_BIN/FFPROBE_BIN. Hidden locally
    by a Homebrew ffmpeg on PATH; failed in CI, which provides ffmpeg only
    through those variables.

    monkeypatch is undone explicitly first: its own teardown would otherwise
    run after this one, i.e. after the reload.
    """
    yield
    monkeypatch.undo()
    importlib.reload(bin_paths)


def test_defaults_to_ffmpeg_and_ffprobe_on_path(monkeypatch):
    monkeypatch.delenv("FFMPEG_BIN", raising=False)
    monkeypatch.delenv("FFPROBE_BIN", raising=False)
    importlib.reload(bin_paths)
    assert bin_paths.FFMPEG_BIN == "ffmpeg"
    assert bin_paths.FFPROBE_BIN == "ffprobe"


def test_reads_overrides_from_env(monkeypatch):
    monkeypatch.setenv("FFMPEG_BIN", r"C:\resources\ffmpeg\ffmpeg.exe")
    monkeypatch.setenv("FFPROBE_BIN", r"C:\resources\ffmpeg\ffprobe.exe")
    importlib.reload(bin_paths)
    assert bin_paths.FFMPEG_BIN == r"C:\resources\ffmpeg\ffmpeg.exe"
    assert bin_paths.FFPROBE_BIN == r"C:\resources\ffmpeg\ffprobe.exe"


def test_module_matches_the_real_environment_after_the_tests_above():
    # Runs after the two tests above (file order): the autouse fixture must
    # have put the module back to what the real environment says.
    import os

    assert bin_paths.FFMPEG_BIN == os.getenv("FFMPEG_BIN", "ffmpeg")
    assert bin_paths.FFPROBE_BIN == os.getenv("FFPROBE_BIN", "ffprobe")
