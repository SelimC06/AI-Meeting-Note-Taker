from __future__ import annotations
import threading
from typing import List, Tuple

from pyannote.audio import Pipeline

# Community-1 (pyannote.audio 4.0): measurably more accurate than 3.1 on
# noisy real-world audio, and CC-BY-4.0 (fully permissive) rather than a
# restrictive research-only license. Still a HuggingFace-gated model --
# downloading it requires a (free, auto-approved) HF account and access
# token, same one-time-unlock shape as this app's existing Ollama
# first-pull friction, not an ongoing account requirement to run the app.
MODEL_NAME = "pyannote/speaker-diarization-community-1"

_cache: dict = {}
_lock = threading.Lock()


def load_pipeline(token: str):
    """Return a cached pyannote Pipeline, loading it on first use.

    Cached per token (not just per model) so a token changed in Settings
    doesn't keep serving a pipeline authenticated with the old one.
    """
    if not token:
        raise ValueError("A HuggingFace access token is required for advanced diarization.")
    key = (MODEL_NAME, token)
    with _lock:
        pipeline = _cache.get(key)
        if pipeline is None:
            pipeline = Pipeline.from_pretrained(MODEL_NAME, token=token)
            _cache[key] = pipeline
        return pipeline


def diarize(wav_path: str, token: str) -> List[Tuple[str, float, float]]:
    """Run pyannote diarization on wav_path, returning a list of
    (speaker_label, start, end) tuples sorted by start time -- the shape
    diarization.align_speaker_turns expects."""
    pipeline = load_pipeline(token)
    annotation = pipeline(wav_path)
    turns = [
        (speaker, float(turn.start), float(turn.end))
        for turn, _, speaker in annotation.itertracks(yield_label=True)
    ]
    turns.sort(key=lambda t: t[1])
    return turns
