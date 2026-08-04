from pathlib import Path

import pytest


def test_dead_recording_functions_removed():
    import app.ffmpeg_transcribe as ft

    assert not hasattr(ft, "start_screen_recording_ffmpeg")
    assert not hasattr(ft, "stop_screen_recording_ffmpeg")
    assert not hasattr(ft, "extract_keyframes_scene")
    assert not hasattr(ft, "_ffmpeg_proc")


def test_stop_recording_and_transcribe_extracts_frames_without_frames_mode(tmp_path, monkeypatch):
    import app.ffmpeg_transcribe as ft

    def fake_run(cmd, check=False):
        class FakeCompletedProcess:
            returncode = 0
        return FakeCompletedProcess()

    monkeypatch.setattr(ft.subprocess, "run", fake_run)

    class FakeSegment:
        def __init__(self, text: str):
            self.text = text

    class FakeWhisperModel:
        def __init__(self, model_name, device="cpu", compute_type="int8"):
            pass

        def transcribe(self, path, **kwargs):
            return [FakeSegment("hello"), FakeSegment("world")], None

    monkeypatch.setattr(ft, "WhisperModel", FakeWhisperModel)

    extract_calls = {}

    def fake_extract_frames(video_path, **kwargs):
        extract_calls["video_path"] = video_path
        extract_calls.update(kwargs)
        return [Path("frame_001.png")]

    monkeypatch.setattr(ft, "extract_frames", fake_extract_frames)

    video_path = str(tmp_path / "capture.mkv")
    transcript_prefix = str(tmp_path / "transcript_")

    out_txt, frame_paths = ft.stop_recording_and_transcribe(
        video_path=video_path,
        transcript_prefix=transcript_prefix,
        model_name="tiny.en",
        separate_tracks=False,
        extract_frames_after=True,
        frames_out_dir=str(tmp_path / "frames"),
        every_n_seconds=5.0,
        scale_width=960,
        image_ext="png",
        quality=2,
        max_frames=3,
    )

    assert out_txt == str(Path(transcript_prefix).with_suffix(".txt"))
    written = Path(out_txt).read_text(encoding="utf-8")
    assert "hello" in written and "world" in written
    assert frame_paths == [Path("frame_001.png")]
    assert extract_calls["video_path"] == video_path
    assert extract_calls["out_dir"] == str(tmp_path / "frames")
    assert extract_calls["max_frames"] == 3
