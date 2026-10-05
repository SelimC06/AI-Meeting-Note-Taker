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


def test_extract_frames_raises_for_missing_video(tmp_path):
    import app.ffmpeg_transcribe as ft

    with pytest.raises(FileNotFoundError):
        ft.extract_frames(str(tmp_path / "missing.mkv"), out_dir=str(tmp_path / "frames"))


def test_extract_frames_truncates_to_max_frames(tmp_path, monkeypatch):
    import app.ffmpeg_transcribe as ft

    video = tmp_path / "capture.mkv"
    video.write_bytes(b"x")
    out_dir = tmp_path / "frames"

    def fake_run(cmd, check=False):
        outdir = Path(cmd[-1]).parent
        outdir.mkdir(parents=True, exist_ok=True)
        for i in range(1, 6):
            (outdir / f"frame_{i:05d}.png").write_bytes(b"f")

        class FakeCompletedProcess:
            returncode = 0

        return FakeCompletedProcess()

    monkeypatch.setattr(ft.subprocess, "run", fake_run)

    frames = ft.extract_frames(str(video), out_dir=str(out_dir), image_ext="png", max_frames=2)

    assert len(frames) == 2


def test_stop_recording_and_transcribe_separate_tracks_uses_amix(tmp_path, monkeypatch):
    import app.ffmpeg_transcribe as ft

    captured_cmds = []

    def fake_run(cmd, check=False):
        captured_cmds.append(cmd)

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
            return [FakeSegment("hi")], None

    monkeypatch.setattr(ft, "WhisperModel", FakeWhisperModel)

    video_path = str(tmp_path / "capture.mkv")
    transcript_prefix = str(tmp_path / "transcript_")

    ft.stop_recording_and_transcribe(
        video_path=video_path,
        transcript_prefix=transcript_prefix,
        model_name="tiny.en",
        separate_tracks=True,
        extract_frames_after=False,
    )

    assert len(captured_cmds) == 1
    joined = " ".join(captured_cmds[0])
    assert "amix" in joined
    assert "0:a:0" in joined and "0:a:1" in joined


def test_stop_recording_and_transcribe_appends_to_existing_transcript(tmp_path, monkeypatch):
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
            return [FakeSegment("second part")], None

    monkeypatch.setattr(ft, "WhisperModel", FakeWhisperModel)

    video_path = str(tmp_path / "capture.mkv")
    transcript_prefix = str(tmp_path / "transcript_")
    existing_txt = Path(transcript_prefix).with_suffix(".txt")
    existing_txt.write_text("first part", encoding="utf-8")

    out_txt, _ = ft.stop_recording_and_transcribe(
        video_path=video_path,
        transcript_prefix=transcript_prefix,
        model_name="tiny.en",
        separate_tracks=False,
        extract_frames_after=False,
    )

    content = Path(out_txt).read_text(encoding="utf-8")
    assert content == "first part\n---\nsecond part"


def test_stop_recording_and_transcribe_writes_a_fresh_transcript_without_separator(tmp_path, monkeypatch):
    """
    Regression test for brief 13 #1: `out_txt.exists` (missing parens) tested
    the bound method reference, which is always truthy, so even a brand-new
    transcript was written in append mode and got a spurious leading
    "\n---\n" separator that then fed into the summarizer prompt. Fixed to
    `out_txt.exists()` -- a fresh transcript must have no separator.
    """
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
            return [FakeSegment("second part")], None

    monkeypatch.setattr(ft, "WhisperModel", FakeWhisperModel)

    video_path = str(tmp_path / "capture.mkv")
    transcript_prefix = str(tmp_path / "transcript_")
    # Deliberately do NOT pre-create the transcript file, unlike the sibling
    # "appends_to_existing_transcript" test -- this exercises the fresh-file path.

    out_txt, _ = ft.stop_recording_and_transcribe(
        video_path=video_path,
        transcript_prefix=transcript_prefix,
        model_name="tiny.en",
        separate_tracks=False,
        extract_frames_after=False,
    )

    content = Path(out_txt).read_text(encoding="utf-8")
    assert content == "second part"


def test_stop_recording_and_transcribe_forwards_initial_prompt(tmp_path, monkeypatch):
    import app.ffmpeg_transcribe as ft

    def fake_run(cmd, check=False):
        class FakeCompletedProcess:
            returncode = 0
        return FakeCompletedProcess()

    monkeypatch.setattr(ft.subprocess, "run", fake_run)

    class FakeSegment:
        def __init__(self, text: str):
            self.text = text

    captured_kwargs = {}

    class FakeWhisperModel:
        def __init__(self, model_name, device="cpu", compute_type="int8"):
            pass

        def transcribe(self, path, **kwargs):
            captured_kwargs.update(kwargs)
            return [FakeSegment("hello")], None

    monkeypatch.setattr(ft, "WhisperModel", FakeWhisperModel)

    video_path = str(tmp_path / "capture.mkv")
    transcript_prefix = str(tmp_path / "transcript_")

    ft.stop_recording_and_transcribe(
        video_path=video_path,
        transcript_prefix=transcript_prefix,
        model_name="tiny.en",
        separate_tracks=False,
        extract_frames_after=False,
        initial_prompt="Kestrel, SSOT, Xiomara",
    )

    assert captured_kwargs["initial_prompt"] == "Kestrel, SSOT, Xiomara"


def test_transcribe_wav_returns_segment_level_timestamps(tmp_path, monkeypatch):
    import app.ffmpeg_transcribe as ft

    class FakeSegment:
        def __init__(self, start, end, text, words=None):
            self.start = start
            self.end = end
            self.text = text
            self.words = words

    captured = {}

    class FakeWhisperModel:
        def __init__(self, model_name, device="cpu", compute_type="int8"):
            pass

        def transcribe(self, path, **kwargs):
            captured["path"] = path
            captured["kwargs"] = kwargs
            return [FakeSegment(0.0, 1.5, "hello there"), FakeSegment(1.5, 3.0, "how are you")], None

    monkeypatch.setattr(ft, "WhisperModel", FakeWhisperModel)

    wav_path = str(tmp_path / "mic.wav")

    result = ft.transcribe_wav(wav_path, model_name="tiny.en", initial_prompt="Kestrel")

    assert result == [
        {"start": 0.0, "end": 1.5, "text": "hello there", "words": []},
        {"start": 1.5, "end": 3.0, "text": "how are you", "words": []},
    ]
    assert captured["path"] == wav_path
    assert captured["kwargs"]["initial_prompt"] == "Kestrel"


def test_transcribe_wav_drops_blank_segments(tmp_path, monkeypatch):
    import app.ffmpeg_transcribe as ft

    class FakeSegment:
        def __init__(self, start, end, text, words=None):
            self.start = start
            self.end = end
            self.text = text
            self.words = words

    class FakeWhisperModel:
        def __init__(self, model_name, device="cpu", compute_type="int8"):
            pass

        def transcribe(self, path, **kwargs):
            return [FakeSegment(0.0, 1.0, "  "), FakeSegment(1.0, 2.0, "real text")], None

    monkeypatch.setattr(ft, "WhisperModel", FakeWhisperModel)

    result = ft.transcribe_wav(str(tmp_path / "mic.wav"), model_name="tiny.en")

    assert result == [{"start": 1.0, "end": 2.0, "text": "real text", "words": []}]


def test_transcribe_wav_strips_whitespace_from_text(tmp_path, monkeypatch):
    import app.ffmpeg_transcribe as ft

    class FakeSegment:
        def __init__(self, start, end, text, words=None):
            self.start = start
            self.end = end
            self.text = text
            self.words = words

    class FakeWhisperModel:
        def __init__(self, model_name, device="cpu", compute_type="int8"):
            pass

        def transcribe(self, path, **kwargs):
            return [FakeSegment(0.0, 1.0, "  padded text  ")], None

    monkeypatch.setattr(ft, "WhisperModel", FakeWhisperModel)

    result = ft.transcribe_wav(str(tmp_path / "mic.wav"), model_name="tiny.en")

    assert result == [{"start": 0.0, "end": 1.0, "text": "padded text", "words": []}]


def test_transcribe_wav_includes_word_level_timestamps(tmp_path, monkeypatch):
    import app.ffmpeg_transcribe as ft

    class FakeWord:
        def __init__(self, word, start, end, probability):
            self.word = word
            self.start = start
            self.end = end
            self.probability = probability

    class FakeSegment:
        def __init__(self, start, end, text, words):
            self.start = start
            self.end = end
            self.text = text
            self.words = words

    class FakeWhisperModel:
        def __init__(self, model_name, device="cpu", compute_type="int8"):
            pass

        def transcribe(self, path, **kwargs):
            return [
                FakeSegment(0.0, 1.0, "hi there", [
                    FakeWord("hi", 0.0, 0.4, 0.9),
                    FakeWord("there", 0.4, 1.0, 0.8),
                ])
            ], None

    monkeypatch.setattr(ft, "WhisperModel", FakeWhisperModel)

    result = ft.transcribe_wav(str(tmp_path / "mic.wav"), model_name="tiny.en")

    assert result == [{
        "start": 0.0, "end": 1.0, "text": "hi there",
        "words": [
            {"word": "hi", "start": 0.0, "end": 0.4, "probability": 0.9},
            {"word": "there", "start": 0.4, "end": 1.0, "probability": 0.8},
        ],
    }]


def test_stop_recording_and_transcribe_uses_shared_transcribe_helper_defaults(tmp_path, monkeypatch):
    import app.ffmpeg_transcribe as ft

    def fake_run(cmd, check=False):
        class FakeCompletedProcess:
            returncode = 0
        return FakeCompletedProcess()

    monkeypatch.setattr(ft.subprocess, "run", fake_run)

    class FakeSegment:
        def __init__(self, text: str):
            self.text = text

    captured_kwargs = {}

    class FakeWhisperModel:
        def __init__(self, model_name, device="cpu", compute_type="int8"):
            pass

        def transcribe(self, path, **kwargs):
            captured_kwargs.update(kwargs)
            return [FakeSegment("hello")], None

    monkeypatch.setattr(ft, "WhisperModel", FakeWhisperModel)

    video_path = str(tmp_path / "capture.mkv")
    transcript_prefix = str(tmp_path / "transcript_")

    ft.stop_recording_and_transcribe(
        video_path=video_path,
        transcript_prefix=transcript_prefix,
        model_name="tiny.en",
        separate_tracks=False,
        extract_frames_after=False,
    )

    assert captured_kwargs["beam_size"] == 1
    assert captured_kwargs["vad_filter"] is False
    assert captured_kwargs["word_timestamps"] is True


def test_stop_recording_and_transcribe_defaults_initial_prompt_to_none(tmp_path, monkeypatch):
    import app.ffmpeg_transcribe as ft

    def fake_run(cmd, check=False):
        class FakeCompletedProcess:
            returncode = 0
        return FakeCompletedProcess()

    monkeypatch.setattr(ft.subprocess, "run", fake_run)

    class FakeSegment:
        def __init__(self, text: str):
            self.text = text

    captured_kwargs = {}

    class FakeWhisperModel:
        def __init__(self, model_name, device="cpu", compute_type="int8"):
            pass

        def transcribe(self, path, **kwargs):
            captured_kwargs.update(kwargs)
            return [FakeSegment("hello")], None

    monkeypatch.setattr(ft, "WhisperModel", FakeWhisperModel)

    video_path = str(tmp_path / "capture.mkv")
    transcript_prefix = str(tmp_path / "transcript_")

    ft.stop_recording_and_transcribe(
        video_path=video_path,
        transcript_prefix=transcript_prefix,
        model_name="tiny.en",
        separate_tracks=False,
        extract_frames_after=False,
    )

    assert captured_kwargs["initial_prompt"] is None


# ---- 1.2b: language-switch detection ---------------------------------------

def _write_wav(path, seconds, rate=16000):
    import wave
    import numpy as np

    pcm = (np.sin(np.linspace(0, 400, int(seconds * rate))) * 8000).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


class _Word:
    def __init__(self, word, start, end):
        self.word, self.start, self.end, self.probability = word, start, end, 0.9


class _Seg:
    def __init__(self, start, end, text):
        self.start, self.end, self.text = start, end, text
        self.words = [_Word(text, start, end)]


class _SwitchingModel:
    """Scripted per-window detection; transcribe() echoes the language it
    was pinned to, so span -> language -> transcription is verifiable."""

    def __init__(self, detections):
        self.detections = list(detections)
        self.transcribe_calls = []

    def detect_language(self, audio=None, **kwargs):
        language, prob = self.detections.pop(0)
        return language, prob, []

    def transcribe(self, audio, **kwargs):
        self.transcribe_calls.append({"language": kwargs.get("language"), "samples": len(audio)})
        return [_Seg(0.5, 2.0, f"spoken-{kwargs.get('language')}")], object()


def test_transcribe_wav_splits_code_switched_audio_into_language_spans(tmp_path, monkeypatch):
    import app.ffmpeg_transcribe as ft
    from app.language_spans import DETECTION_WINDOW_SECONDS

    wav = tmp_path / "meeting.wav"
    _write_wav(wav, 3 * DETECTION_WINDOW_SECONDS)
    model = _SwitchingModel([("en", 0.95), ("tr", 0.93), ("en", 0.9)])
    monkeypatch.setattr(ft, "get_whisper_model", lambda cls, name, **kw: model)

    segments = ft.transcribe_wav(str(wav), model_name="base", language=None)

    # One pinned-language transcription per span.
    assert [c["language"] for c in model.transcribe_calls] == ["en", "tr", "en"]
    assert [s["language"] for s in segments] == ["en", "tr", "en"]
    assert [s["text"] for s in segments] == ["spoken-en", "spoken-tr", "spoken-en"]
    # Timestamps (words included) are offset into recording time.
    assert segments[1]["start"] == pytest.approx(DETECTION_WINDOW_SECONDS + 0.5)
    assert segments[1]["words"][0]["start"] == pytest.approx(DETECTION_WINDOW_SECONDS + 0.5)
    assert segments[2]["start"] == pytest.approx(2 * DETECTION_WINDOW_SECONDS + 0.5)


def test_transcribe_wav_single_language_stays_a_single_pass(tmp_path, monkeypatch):
    import app.ffmpeg_transcribe as ft
    from app.language_spans import DETECTION_WINDOW_SECONDS

    wav = tmp_path / "meeting.wav"
    _write_wav(wav, 2 * DETECTION_WINDOW_SECONDS)
    model = _SwitchingModel([("tr", 0.95), ("tr", 0.9)])
    monkeypatch.setattr(ft, "get_whisper_model", lambda cls, name, **kw: model)

    segments = ft.transcribe_wav(str(wav), model_name="base", language=None)

    # One whole-file transcription; auto-detect ran but found one language.
    assert len(model.transcribe_calls) == 1
    assert segments[0]["text"] == "spoken-None"
    assert "language" not in segments[0]


def test_transcribe_wav_pinned_language_never_runs_detection(tmp_path, monkeypatch):
    import app.ffmpeg_transcribe as ft

    wav = tmp_path / "meeting.wav"
    _write_wav(wav, 30)

    class NoDetectAllowed(_SwitchingModel):
        def detect_language(self, audio=None, **kwargs):
            raise AssertionError("detection must not run for a pinned language")

    model = NoDetectAllowed([])
    monkeypatch.setattr(ft, "get_whisper_model", lambda cls, name, **kw: model)

    segments = ft.transcribe_wav(str(wav), model_name="base", language="tr")
    assert model.transcribe_calls[0]["language"] == "tr"
    assert segments[0]["text"] == "spoken-tr"
