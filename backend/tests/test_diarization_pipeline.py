import sys
import types

import pytest


@pytest.fixture(autouse=True)
def _clean_diarization_pipeline_module():
    """Forces app.diarization_pipeline out of sys.modules after every test
    in this file.

    monkeypatch.delitem(..., raising=False) on a key that's ABSENT at call
    time is a complete no-op in pytest (nothing recorded, nothing undone) --
    it does NOT track "restore to absent" the way setitem does. Since
    app.diarization_pipeline doesn't exist in sys.modules until a test's own
    `import` statement creates it, monkeypatch never learns about that entry
    and never reverts it. Without this fixture, the module -- and whatever
    fake pyannote.audio.Pipeline class it was bound to during import --
    stays cached in sys.modules for the rest of the whole pytest session,
    which can leak a fake-backed pyannote_diarize into unrelated server.py
    tests (specifically ones that importlib.reload(server_module), which
    re-runs its `from .diarization_pipeline import diarize` against
    whatever is cached here instead of raising ModuleNotFoundError).
    """
    yield
    sys.modules.pop("app.diarization_pipeline", None)


def _install_fake_pyannote(monkeypatch, pipeline_cls):
    """Injects a fake pyannote.audio module into sys.modules so
    app.diarization_pipeline (which does `from pyannote.audio import
    Pipeline` at module level) is importable/testable in CI without the
    real torch/pyannote.audio installed -- same as test_ffmpeg_transcribe.py
    never needing a real Whisper model on disk. monkeypatch.setitem here
    (unlike the diarization_pipeline case above) DOES revert correctly at
    teardown, since "pyannote"/"pyannote.audio" are absent-then-added keys
    that setitem explicitly tracks.
    """
    fake_pkg = types.ModuleType("pyannote")
    fake_audio = types.ModuleType("pyannote.audio")
    fake_audio.Pipeline = pipeline_cls
    fake_pkg.audio = fake_audio
    monkeypatch.setitem(sys.modules, "pyannote", fake_pkg)
    monkeypatch.setitem(sys.modules, "pyannote.audio", fake_audio)
    sys.modules.pop("app.diarization_pipeline", None)


class _FakeSegment:
    def __init__(self, start, end):
        self.start = start
        self.end = end


class _FakeAnnotation:
    def __init__(self, tracks):
        self._tracks = tracks

    def itertracks(self, yield_label=False):
        for seg, track_name, speaker in self._tracks:
            yield seg, track_name, speaker


def _make_fake_pipeline_cls(tracks, from_pretrained_calls, call_paths):
    class FakePipeline:
        def __init__(self):
            pass

        @classmethod
        def from_pretrained(cls, model_name, token=None):
            from_pretrained_calls.append((model_name, token))
            return cls()

        def __call__(self, wav_path):
            call_paths.append(wav_path)
            return _FakeDiarizeOutput(tracks)

    return FakePipeline


class _FakeDiarizeOutput:
    """pyannote.audio 4.x's pipeline output: an object carrying the
    Annotation(s), not an Annotation itself (so no .itertracks)."""

    def __init__(self, tracks, exclusive_tracks=None):
        self.speaker_diarization = _FakeAnnotation(tracks)
        self.exclusive_speaker_diarization = _FakeAnnotation(
            exclusive_tracks if exclusive_tracks is not None else tracks
        )


def test_diarize_returns_speaker_turns_sorted_by_start(monkeypatch):
    tracks = [
        (_FakeSegment(5.0, 6.0), "track_b", "SPEAKER_01"),
        (_FakeSegment(0.0, 2.0), "track_a", "SPEAKER_00"),
    ]
    calls = []
    paths = []
    _install_fake_pyannote(monkeypatch, _make_fake_pipeline_cls(tracks, calls, paths))

    import app.diarization_pipeline as dp

    result = dp.diarize("mic.wav", token="tok")

    assert result == [("SPEAKER_00", 0.0, 2.0), ("SPEAKER_01", 5.0, 6.0)]
    assert paths == ["mic.wav"]


def test_diarize_passes_the_configured_token_to_from_pretrained(monkeypatch):
    calls = []
    _install_fake_pyannote(monkeypatch, _make_fake_pipeline_cls([], calls, []))

    import app.diarization_pipeline as dp

    dp.diarize("mic.wav", token="my-hf-token")

    assert calls[0] == (dp.MODEL_NAME, "my-hf-token")


def test_load_pipeline_caches_per_token_avoiding_repeated_from_pretrained_calls(monkeypatch):
    calls = []
    _install_fake_pyannote(monkeypatch, _make_fake_pipeline_cls([], calls, []))

    import app.diarization_pipeline as dp

    dp.load_pipeline("tok-a")
    dp.load_pipeline("tok-a")
    dp.load_pipeline("tok-b")

    assert len(calls) == 2
    assert {c[1] for c in calls} == {"tok-a", "tok-b"}


def test_load_pipeline_raises_on_missing_token(monkeypatch):
    _install_fake_pyannote(monkeypatch, _make_fake_pipeline_cls([], [], []))

    import app.diarization_pipeline as dp

    with pytest.raises(ValueError):
        dp.load_pipeline("")


def test_diarize_raises_on_missing_token_without_calling_the_pipeline(monkeypatch):
    calls = []
    paths = []
    _install_fake_pyannote(monkeypatch, _make_fake_pipeline_cls([], calls, paths))

    import app.diarization_pipeline as dp

    with pytest.raises(ValueError):
        dp.diarize("mic.wav", token=None)

    assert paths == []


def test_diarize_prefers_the_exclusive_diarization_of_a_4x_output(monkeypatch):
    overlapping = [
        (_FakeSegment(0.0, 3.0), "a", "SPEAKER_00"),
        (_FakeSegment(2.0, 4.0), "b", "SPEAKER_01"),
    ]
    exclusive = [
        (_FakeSegment(0.0, 2.0), "a", "SPEAKER_00"),
        (_FakeSegment(2.0, 4.0), "b", "SPEAKER_01"),
    ]

    class Pipeline4x:
        @classmethod
        def from_pretrained(cls, model_name, token=None):
            return cls()

        def __call__(self, wav_path):
            return _FakeDiarizeOutput(overlapping, exclusive)

    _install_fake_pyannote(monkeypatch, Pipeline4x)
    import app.diarization_pipeline as dp

    assert dp.diarize("mic.wav", token="tok") == [("SPEAKER_00", 0.0, 2.0), ("SPEAKER_01", 2.0, 4.0)]


def test_diarize_still_reads_a_3x_style_annotation(monkeypatch):
    tracks = [(_FakeSegment(1.0, 2.0), "a", "SPEAKER_00")]

    class Pipeline3x:
        @classmethod
        def from_pretrained(cls, model_name, token=None):
            return cls()

        def __call__(self, wav_path):
            return _FakeAnnotation(tracks)

    _install_fake_pyannote(monkeypatch, Pipeline3x)
    import app.diarization_pipeline as dp

    assert dp.diarize("mic.wav", token="tok") == [("SPEAKER_00", 1.0, 2.0)]


def test_only_the_most_recent_pipeline_is_kept_loaded(monkeypatch):
    calls, paths = [], []
    _install_fake_pyannote(monkeypatch, _make_fake_pipeline_cls([], calls, paths))
    import app.diarization_pipeline as dp

    dp.load_pipeline("token-1")
    dp.load_pipeline("token-2")
    assert list(dp._cache) == [(dp.MODEL_NAME, "token-2")]
    dp.load_pipeline("token-2")
    assert len(calls) == 2  # still cached
