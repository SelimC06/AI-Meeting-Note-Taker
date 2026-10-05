import numpy as np
import pytest

from app.language_spans import (
    DETECTION_WINDOW_SECONDS,
    detect_language_spans,
    read_wav_f32,
)

RATE = 16000


class FakeModel:
    """detect_language returns the scripted (language, prob) per call."""

    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def detect_language(self, audio=None, **kwargs):
        self.calls.append(len(audio))
        language, probability = self.results.pop(0)
        return language, probability, []


def _seconds(n):
    return np.zeros(int(n * RATE), dtype=np.float32)


def test_merges_consecutive_windows_of_the_same_language():
    model = FakeModel([("en", 0.95), ("en", 0.9), ("tr", 0.92), ("en", 0.88)])
    spans = detect_language_spans(model, _seconds(4 * DETECTION_WINDOW_SECONDS), RATE)
    assert [s["language"] for s in spans] == ["en", "tr", "en"]
    assert spans[0]["start"] == 0.0
    assert spans[0]["end"] == pytest.approx(2 * DETECTION_WINDOW_SECONDS)
    assert spans[1]["end"] == pytest.approx(3 * DETECTION_WINDOW_SECONDS)
    assert spans[-1]["end"] == pytest.approx(4 * DETECTION_WINDOW_SECONDS)


def test_weak_detections_ride_with_the_previous_language():
    # Window 2 is near-silence misdetected as "cy" at low confidence -- it
    # must not split the English run.
    model = FakeModel([("en", 0.9), ("cy", 0.3), ("en", 0.85)])
    spans = detect_language_spans(model, _seconds(3 * DETECTION_WINDOW_SECONDS), RATE)
    assert [s["language"] for s in spans] == ["en"]


def test_weak_first_window_takes_the_first_confident_language():
    model = FakeModel([("nn", 0.2), ("tr", 0.9), ("tr", 0.92)])
    spans = detect_language_spans(model, _seconds(3 * DETECTION_WINDOW_SECONDS), RATE)
    assert [s["language"] for s in spans] == ["tr"]


def test_short_tail_merges_into_the_last_window():
    # 2 windows + a 1s tail: only two detections, last window extends to EOF.
    model = FakeModel([("en", 0.9), ("en", 0.9)])
    duration = 2 * DETECTION_WINDOW_SECONDS + 1.0
    spans = detect_language_spans(model, _seconds(duration), RATE)
    assert len(model.calls) == 2
    assert spans[-1]["end"] == pytest.approx(duration)


def test_single_window_audio_and_missing_capability():
    model = FakeModel([("en", 0.9)])
    assert len(detect_language_spans(model, _seconds(5), RATE)) == 1

    class NoDetect:
        pass

    assert detect_language_spans(NoDetect(), _seconds(5), RATE) == []
    assert detect_language_spans(model, np.zeros(0, dtype=np.float32), RATE) == []


def test_read_wav_f32_round_trip(tmp_path):
    import wave

    path = tmp_path / "x.wav"
    pcm = (np.sin(np.linspace(0, 100, RATE)) * 10000).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    samples, rate = read_wav_f32(path)
    assert rate == RATE
    assert samples is not None and len(samples) == RATE
    assert float(np.abs(samples).max()) <= 1.0

    assert read_wav_f32(tmp_path / "missing.wav") == (None, 0)


def test_confident_but_not_certain_island_is_absorbed():
    """A single window flagged as another language between agreeing
    neighbors -- a loanword, a name, crosstalk -- must not split the
    meeting, even at probabilities that would otherwise allow a switch."""
    model = FakeModel([("en", 0.9), ("de", 0.8), ("en", 0.88)])
    spans = detect_language_spans(model, _seconds(3 * DETECTION_WINDOW_SECONDS), RATE)
    assert [s["language"] for s in spans] == ["en"]


def test_near_certain_island_survives():
    model = FakeModel([("en", 0.9), ("tr", 0.97), ("en", 0.88)])
    spans = detect_language_spans(model, _seconds(3 * DETECTION_WINDOW_SECONDS), RATE)
    assert [s["language"] for s in spans] == ["en", "tr", "en"]


def test_switching_requires_conviction():
    # Disagreeing windows below SWITCH_CONFIDENCE inherit the running
    # language -- even two in a row.
    model = FakeModel([("en", 0.9), ("tr", 0.7), ("tr", 0.72), ("en", 0.9)])
    spans = detect_language_spans(model, _seconds(4 * DETECTION_WINDOW_SECONDS), RATE)
    assert [s["language"] for s in spans] == ["en"]


def test_sustained_moderately_confident_switch_still_works():
    model = FakeModel([("en", 0.9), ("tr", 0.8), ("tr", 0.82), ("tr", 0.78)])
    spans = detect_language_spans(model, _seconds(4 * DETECTION_WINDOW_SECONDS), RATE)
    assert [s["language"] for s in spans] == ["en", "tr"]
