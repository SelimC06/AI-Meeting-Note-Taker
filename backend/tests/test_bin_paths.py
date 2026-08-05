import importlib


def test_defaults_to_ffmpeg_and_ffprobe_on_path(monkeypatch):
    monkeypatch.delenv("FFMPEG_BIN", raising=False)
    monkeypatch.delenv("FFPROBE_BIN", raising=False)
    import app.bin_paths as bin_paths
    importlib.reload(bin_paths)
    assert bin_paths.FFMPEG_BIN == "ffmpeg"
    assert bin_paths.FFPROBE_BIN == "ffprobe"


def test_reads_overrides_from_env(monkeypatch):
    monkeypatch.setenv("FFMPEG_BIN", r"C:\resources\ffmpeg\ffmpeg.exe")
    monkeypatch.setenv("FFPROBE_BIN", r"C:\resources\ffmpeg\ffprobe.exe")
    import app.bin_paths as bin_paths
    importlib.reload(bin_paths)
    try:
        assert bin_paths.FFMPEG_BIN == r"C:\resources\ffmpeg\ffmpeg.exe"
        assert bin_paths.FFPROBE_BIN == r"C:\resources\ffmpeg\ffprobe.exe"
    finally:
        monkeypatch.delenv("FFMPEG_BIN", raising=False)
        monkeypatch.delenv("FFPROBE_BIN", raising=False)
        importlib.reload(bin_paths)
