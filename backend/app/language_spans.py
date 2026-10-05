"""Segment-level language detection for code-switched meetings (1.2b).

Whisper's own auto-detection looks at the FIRST 30 seconds and locks the
whole file to that language, so a meeting that moves English -> Turkish ->
English used to come back with the Turkish stretch transliterated into
English nonsense. This module runs the (cheap, encoder-only)
WhisperModel.detect_language over fixed windows of the audio, absorbs
weak detections (silence, breaths, cross-fade windows), and merges the
result into language spans; ffmpeg_transcribe then transcribes each span
with its language pinned.

Live captions already handle switching (each caption window detects
independently); this closes the same gap for the definitive transcript.
"""
from __future__ import annotations

import os
import wave
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

# One detection per window. 20s is small enough to catch real switches
# (people rarely flip languages faster than that for whole stretches)
# and large enough that detection stays reliable. Env-tunable for
# experimentation on real meeting audio.
DETECTION_WINDOW_SECONDS = float(os.getenv("LANG_SPAN_WINDOW_SECONDS", "20"))

# A trailing stub shorter than this rides along with the previous window
# instead of getting its own (unreliable) detection.
MIN_TAIL_SECONDS = 3.0

# Below this probability a window's detection is treated as noise
# (silence, music, overlap) and absorbed into the previous window's
# language rather than starting a bogus span.
WEAK_DETECTION_PROBABILITY = 0.6

# Starting a NEW language mid-meeting requires conviction: a run of
# disagreeing windows only becomes a span when its best detection clears
# this -- middling confidence (accents, crosstalk) keeps the running
# language instead of fragmenting the transcript.
SWITCH_CONFIDENCE = 0.75

# A SINGLE disagreeing window between agreeing neighbors (a loanword, a
# name, a quoted phrase) is held to a higher bar still -- it must be
# nearly certain to split the meeting on its own.
ISLAND_CONFIDENCE = 0.9


def read_wav_f32(path) -> Tuple[Optional[np.ndarray], int]:
    """Load a PCM wav as float32 in [-1, 1]; (None, 0) for anything that
    isn't the pipeline's own 16 kHz mono s16le output."""
    try:
        with wave.open(str(Path(path)), "rb") as w:
            if w.getsampwidth() != 2 or w.getnchannels() != 1:
                return None, 0
            rate = w.getframerate()
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    except Exception:
        return None, 0
    return pcm.astype(np.float32) / 32768.0, rate


def detect_language_spans(
    model,
    samples: np.ndarray,
    rate: int,
    # None = the module default, resolved at CALL time so tests and
    # tuning can adjust it without re-importing.
    window_seconds: Optional[float] = None,
) -> List[Dict]:
    """[{start, end, language, probability}], merged over consecutive
    windows that agree. Returns [] when detection isn't possible (no
    audio, or a model without detect_language -- e.g. a test fake), so
    callers fall back to the single-pass behavior."""
    if samples is None or len(samples) == 0 or rate <= 0:
        return []
    if not hasattr(model, "detect_language"):
        return []

    total_seconds = len(samples) / rate
    window = max(window_seconds if window_seconds is not None else DETECTION_WINDOW_SECONDS, 1.0)

    # Window boundaries; a short tail merges into the final window.
    starts: List[float] = []
    t = 0.0
    while t < total_seconds:
        starts.append(t)
        t += window
    if len(starts) > 1 and (total_seconds - starts[-1]) < MIN_TAIL_SECONDS:
        starts.pop()

    windows: List[Dict] = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else total_seconds
        chunk = samples[int(start * rate):int(end * rate)]
        try:
            language, probability, _all = model.detect_language(audio=chunk)
        except Exception:
            return []
        windows.append({"start": start, "end": end, "language": language, "probability": float(probability)})

    if not windows:
        return []

    # Weak detections ride with the previous window's language -- silence
    # or hubbub must never cut a real span in half. A weak FIRST window
    # takes the first confident language that follows (else stays as-is).
    for i, win in enumerate(windows):
        if win["probability"] >= WEAK_DETECTION_PROBABILITY:
            continue
        if i > 0:
            win["language"] = windows[i - 1]["language"]
        else:
            confident = next((w for w in windows if w["probability"] >= WEAK_DETECTION_PROBABILITY), None)
            if confident is not None:
                win["language"] = confident["language"]

    # Group consecutive agreeing windows into candidate runs, then walk
    # them with a running language: a run in another language only becomes
    # a real switch with conviction (SWITCH_CONFIDENCE; a single-window
    # island needs ISLAND_CONFIDENCE). Rejected runs inherit the running
    # language -- better one honest span than a transcript shredded by
    # borderline detections.
    runs: List[List[Dict]] = []
    for win in windows:
        if runs and runs[-1][0]["language"] == win["language"]:
            runs[-1].append(win)
        else:
            runs.append([win])

    current_language = runs[0][0]["language"]
    for i, run in enumerate(runs[1:], start=1):
        if run[0]["language"] == current_language:
            continue
        best = max(w["probability"] for w in run)
        # The island bar applies only to a true sandwich -- one window
        # whose neighbors agree with each other. A single window that
        # RETURNS to the surrounding conversation's language (en after a
        # tr stretch) is corroborated by what follows and only needs
        # ordinary switch confidence.
        is_island = (
            len(run) == 1
            and i + 1 < len(runs)
            and runs[i - 1][0]["language"] == runs[i + 1][0]["language"]
        )
        threshold = ISLAND_CONFIDENCE if is_island else SWITCH_CONFIDENCE
        if best >= threshold:
            current_language = run[0]["language"]
        else:
            for win in run:
                win["language"] = current_language

    # Merge consecutive windows that (now) agree.
    spans: List[Dict] = []
    for win in windows:
        if spans and spans[-1]["language"] == win["language"]:
            spans[-1]["end"] = win["end"]
            spans[-1]["probability"] = max(spans[-1]["probability"], win["probability"])
        else:
            spans.append(dict(win))
    return spans
