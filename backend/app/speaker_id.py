"""Shippable speaker identification with persistent voice profiles
(Tier 2.1).

Replaces the un-shippable torch/pyannote dependency for the default
experience: speaker embeddings come from a small pinned ONNX model (CAM++,
3D-Speaker zh/en, 28 MB -- vendored by scripts/fetch-speaker-model.mjs and
run through sherpa-onnx on onnxruntime, no torch, no HuggingFace token),
and diarization reuses the speech spans Whisper already found instead of a
separate VAD: each transcription segment of the remote ("Others") track is
embedded and the embeddings are clustered, so "Others" becomes
SPEAKER_00/SPEAKER_01/... with zero setup. The optional pyannote path
(advanced_diarization_enabled) still wins when the user explicitly set it
up.

Voice profiles make names stick across meetings: every processed session
stores one centroid embedding per detected speaker
(speaker_embeddings.json in the session dir); renaming a speaker (PATCH
/speaker-names) folds that centroid into a named profile in
voice_profiles.json next to settings.json, and every later session's
clusters are matched against the profiles (cosine >= PROFILE_MATCH_
THRESHOLD) and pre-named automatically. Measured on the pinned model:
same-speaker pairs score ~0.9+, different speakers ~0.2, so 0.55 has wide
margin on both sides.

Everything here is best-effort by design: no caller may fail a recording
over speaker ID, and every public function degrades to "no labels" when
the model, sherpa-onnx, or the audio is unavailable.
"""
from __future__ import annotations

import json
import os
import threading
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from .bin_paths import SPEAKER_MODEL_PATH

try:
    import sherpa_onnx
except Exception:  # pragma: no cover - import guard mirrors server.py's style
    sherpa_onnx = None

# Segments shorter than this give unstable embeddings; they inherit the
# label of the nearest embedded segment instead (or keep their original).
MIN_SEGMENT_SECONDS = 0.6
# Max seconds of audio fed per embedding -- a very long segment's first
# chunk is plenty, and it bounds compute per segment.
MAX_SEGMENT_SECONDS = 12.0
# Merge clusters / accept a profile match at this cosine similarity.
CLUSTER_SIMILARITY_THRESHOLD = float(os.getenv("SPEAKER_CLUSTER_THRESHOLD", "0.55"))
PROFILE_MATCH_THRESHOLD = float(os.getenv("SPEAKER_PROFILE_THRESHOLD", "0.55"))
# A profile's running mean stops drifting after this many contributions.
PROFILE_MAX_COUNT = 50

PROFILES_FILENAME = "voice_profiles.json"
SESSION_EMBEDDINGS_FILENAME = "speaker_embeddings.json"

_LOCK = threading.RLock()
_PROFILES_DIR: Optional[Path] = None
_EXTRACTOR = None
_EXTRACTOR_FAILED = False


def configure(profiles_dir: Path) -> None:
    """Where voice_profiles.json lives (ROOT, next to settings.json --
    device-level, so profiles survive storage-folder moves)."""
    global _PROFILES_DIR
    with _LOCK:
        _PROFILES_DIR = Path(profiles_dir)


def available() -> bool:
    """True when speaker ID can actually run: sherpa-onnx imported and the
    pinned model file exists (vendored, or pointed at via
    SPEAKER_MODEL_PATH)."""
    return (
        sherpa_onnx is not None
        and bool(SPEAKER_MODEL_PATH)
        and Path(SPEAKER_MODEL_PATH).is_file()
    )


def _get_extractor():
    """One cached extractor per process (model load is ~100ms and the
    session object is reusable across streams). Returns None when
    unavailable or when construction failed once -- never retries a broken
    model file on every segment."""
    global _EXTRACTOR, _EXTRACTOR_FAILED
    with _LOCK:
        if _EXTRACTOR is not None:
            return _EXTRACTOR
        if _EXTRACTOR_FAILED or not available():
            return None
        try:
            config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(SPEAKER_MODEL_PATH), num_threads=2
            )
            _EXTRACTOR = sherpa_onnx.SpeakerEmbeddingExtractor(config)
        except Exception:
            _EXTRACTOR_FAILED = True
            return None
        return _EXTRACTOR


def _read_wav_mono(path: Path) -> Tuple[Optional[np.ndarray], int]:
    """Load a PCM wav as float32 in [-1, 1]. The wavs here always come from
    to_wav (16 kHz mono s16le); anything else returns (None, 0) rather than
    guessing."""
    try:
        with wave.open(str(path), "rb") as w:
            if w.getsampwidth() != 2 or w.getnchannels() != 1:
                return None, 0
            rate = w.getframerate()
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    except Exception:
        return None, 0
    return pcm.astype(np.float32) / 32768.0, rate


def embed_spans(
    wav_path: Path, spans: Sequence[Tuple[float, float]]
) -> List[Optional[np.ndarray]]:
    """One L2-normalized embedding per (start, end) span of the wav, or
    None for spans that are too short / out of range / failed."""
    extractor = _get_extractor()
    if extractor is None:
        return [None] * len(spans)
    samples, rate = _read_wav_mono(Path(wav_path))
    if samples is None or rate <= 0 or len(samples) == 0:
        return [None] * len(spans)

    out: List[Optional[np.ndarray]] = []
    for start, end in spans:
        end = min(end, start + MAX_SEGMENT_SECONDS)
        a = max(0, int(start * rate))
        b = min(len(samples), int(end * rate))
        if (b - a) < int(MIN_SEGMENT_SECONDS * rate):
            out.append(None)
            continue
        try:
            stream = extractor.create_stream()
            stream.accept_waveform(rate, samples[a:b])
            stream.input_finished()
            emb = np.asarray(extractor.compute(stream), dtype=np.float32)
            norm = float(np.linalg.norm(emb))
            out.append(emb / norm if norm > 0 else None)
        except Exception:
            out.append(None)
    return out


def cluster_embeddings(
    embeddings: Sequence[np.ndarray], threshold: float = CLUSTER_SIMILARITY_THRESHOLD
) -> List[int]:
    """Average-linkage agglomerative clustering on cosine similarity:
    repeatedly merge the two most similar clusters until no pair reaches
    the threshold. n is small (segments in one meeting), so the O(n^3)
    simplicity is fine."""
    n = len(embeddings)
    if n == 0:
        return []
    clusters: List[List[int]] = [[i] for i in range(n)]
    centroids: List[np.ndarray] = [np.array(e, dtype=np.float32) for e in embeddings]

    def _norm(v: np.ndarray) -> np.ndarray:
        norm = float(np.linalg.norm(v))
        return v / norm if norm > 0 else v

    while len(clusters) > 1:
        best = (-1.0, -1, -1)
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                sim = float(centroids[i] @ centroids[j])
                if sim > best[0]:
                    best = (sim, i, j)
        sim, i, j = best
        if sim < threshold:
            break
        merged = clusters[i] + clusters[j]
        weight_i, weight_j = len(clusters[i]), len(clusters[j])
        centroid = _norm(
            (centroids[i] * weight_i + centroids[j] * weight_j) / (weight_i + weight_j)
        )
        clusters = [c for k, c in enumerate(clusters) if k not in (i, j)] + [merged]
        centroids = [c for k, c in enumerate(centroids) if k not in (i, j)] + [centroid]

    labels = [0] * n
    for cluster_id, members in enumerate(clusters):
        for idx in members:
            labels[idx] = cluster_id
    return labels


def diarize_segments(
    wav_path: Path,
    segments: Sequence[dict],
    label_prefix: str = "SPEAKER_",
) -> Tuple[List[Optional[str]], Dict[str, List[float]]]:
    """Assign a stable speaker label to each transcription segment of one
    audio track.

    Returns (labels, centroids): labels[i] is "SPEAKER_00"-style (numbered
    by order of first appearance in the meeting) or None when segment i
    couldn't be attributed; centroids maps each label to its cluster's
    mean embedding (the material for voice profiles). Too-short segments
    borrow the label of the nearest embedded segment so one-word replies
    don't fall out of the conversation."""
    spans = [(float(s.get("start") or 0.0), float(s.get("end") or 0.0)) for s in segments]
    embeddings = embed_spans(wav_path, spans)
    embedded_idx = [i for i, e in enumerate(embeddings) if e is not None]
    if not embedded_idx:
        return [None] * len(segments), {}

    cluster_ids = cluster_embeddings([embeddings[i] for i in embedded_idx])

    # Number clusters by first appearance, so SPEAKER_00 is whoever spoke
    # first -- stable and human-explainable.
    order: Dict[int, str] = {}
    for pos, i in enumerate(embedded_idx):
        cid = cluster_ids[pos]
        if cid not in order:
            order[cid] = f"{label_prefix}{len(order):02d}"

    labels: List[Optional[str]] = [None] * len(segments)
    for pos, i in enumerate(embedded_idx):
        labels[i] = order[cluster_ids[pos]]

    # Short segments: nearest labeled neighbor by midpoint distance.
    for i, label in enumerate(labels):
        if label is not None:
            continue
        mid = (spans[i][0] + spans[i][1]) / 2.0
        nearest = min(
            embedded_idx,
            key=lambda j: abs(((spans[j][0] + spans[j][1]) / 2.0) - mid),
        )
        labels[i] = labels[nearest]

    centroids: Dict[str, List[float]] = {}
    sums: Dict[str, np.ndarray] = {}
    counts: Dict[str, int] = {}
    for pos, i in enumerate(embedded_idx):
        label = order[cluster_ids[pos]]
        sums[label] = sums.get(label, 0) + embeddings[i]
        counts[label] = counts.get(label, 0) + 1
    for label, total in sums.items():
        centroid = total / counts[label]
        norm = float(np.linalg.norm(centroid))
        if norm > 0:
            centroid = centroid / norm
        centroids[label] = [float(x) for x in centroid]
    return labels, centroids


def centroids_for_labeled_segments(
    wav_path: Path,
    segments: Sequence[dict],
    skip_labels: Sequence[str] = ("You", "Others"),
) -> Dict[str, List[float]]:
    """One centroid embedding per already-labeled speaker (whatever
    diarizer produced the labels -- the ONNX clustering above or pyannote),
    from that speaker's spans on `wav_path`. Labels in skip_labels (and
    None) are track-provenance buckets, not identities, and get no
    centroid."""
    by_label: Dict[str, List[Tuple[float, float]]] = {}
    for seg in segments:
        label = seg.get("speaker")
        if not isinstance(label, str) or label in skip_labels:
            continue
        by_label.setdefault(label, []).append(
            (float(seg.get("start") or 0.0), float(seg.get("end") or 0.0))
        )
    centroids: Dict[str, List[float]] = {}
    for label, spans in by_label.items():
        embeddings = [e for e in embed_spans(wav_path, spans) if e is not None]
        if not embeddings:
            continue
        centroid = np.mean(np.stack(embeddings), axis=0)
        norm = float(np.linalg.norm(centroid))
        if norm > 0:
            centroid = centroid / norm
        centroids[label] = [float(x) for x in centroid]
    return centroids


# ---- per-session speaker embeddings ----------------------------------------

def write_session_embeddings(session_dir: Path, centroids: Dict[str, List[float]]) -> None:
    """Atomically persist a session's per-speaker centroids; merged over
    whatever is already there (the dual-track and single-track passes may
    both contribute)."""
    if not centroids:
        return
    path = Path(session_dir) / SESSION_EMBEDDINGS_FILENAME
    merged = {**load_session_embeddings(session_dir), **centroids}
    tmp = path.with_name("." + path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(merged, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def load_session_embeddings(session_dir: Path) -> Dict[str, List[float]]:
    path = Path(session_dir) / SESSION_EMBEDDINGS_FILENAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        k: v
        for k, v in data.items()
        if isinstance(k, str) and isinstance(v, list) and all(isinstance(x, (int, float)) for x in v)
    }


# ---- persistent voice profiles ----------------------------------------------

def _profiles_path() -> Optional[Path]:
    with _LOCK:
        return (_PROFILES_DIR / PROFILES_FILENAME) if _PROFILES_DIR else None


def load_profiles() -> Dict[str, dict]:
    path = _profiles_path()
    if path is None:
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_profiles(profiles: Dict[str, dict]) -> None:
    path = _profiles_path()
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name("." + path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(profiles, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def learn_profile(name: str, embedding: Sequence[float]) -> None:
    """Fold one meeting's centroid for `name` into their profile (running
    mean, capped so an established profile stops drifting). Called when the
    user names/renames a speaker -- including correcting a wrong automatic
    match, which pulls the profile toward the corrected voice."""
    name = name.strip()
    if not name:
        return
    vec = np.asarray(list(embedding), dtype=np.float32)
    norm = float(np.linalg.norm(vec))
    if norm <= 0:
        return
    vec = vec / norm
    with _LOCK:
        profiles = load_profiles()
        existing = profiles.get(name)
        if (
            isinstance(existing, dict)
            and isinstance(existing.get("embedding"), list)
            and len(existing["embedding"]) == len(vec)
        ):
            count = int(existing.get("count", 1))
            old = np.asarray(existing["embedding"], dtype=np.float32)
            merged = (old * count + vec) / (count + 1)
            norm = float(np.linalg.norm(merged))
            if norm > 0:
                merged = merged / norm
            profiles[name] = {
                "embedding": [float(x) for x in merged],
                "count": min(count + 1, PROFILE_MAX_COUNT),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        else:
            profiles[name] = {
                "embedding": [float(x) for x in vec],
                "count": 1,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        _write_profiles(profiles)


def forget_profile(name: str) -> bool:
    with _LOCK:
        profiles = load_profiles()
        if name not in profiles:
            return False
        del profiles[name]
        _write_profiles(profiles)
        return True


def list_profiles() -> List[dict]:
    """Public shape for GET /speaker-profiles -- no embeddings, just what
    the Settings UI shows."""
    out = []
    for name, p in sorted(load_profiles().items()):
        if not isinstance(p, dict):
            continue
        out.append({
            "name": name,
            "meetings": int(p.get("count", 1)),
            "updated_at": p.get("updated_at"),
        })
    return out


def match_profiles(
    centroids: Dict[str, List[float]], threshold: float = PROFILE_MATCH_THRESHOLD
) -> Dict[str, str]:
    """Best named profile for each session speaker: {raw_label: name} for
    every centroid whose best profile similarity clears the threshold."""
    profiles = load_profiles()
    if not profiles or not centroids:
        return {}
    names: List[str] = []
    vectors: List[np.ndarray] = []
    for name, p in profiles.items():
        emb = p.get("embedding") if isinstance(p, dict) else None
        if isinstance(emb, list) and emb:
            v = np.asarray(emb, dtype=np.float32)
            norm = float(np.linalg.norm(v))
            if norm > 0:
                names.append(name)
                vectors.append(v / norm)
    if not names:
        return {}

    matches: Dict[str, str] = {}
    for label, centroid in centroids.items():
        c = np.asarray(centroid, dtype=np.float32)
        norm = float(np.linalg.norm(c))
        if norm <= 0 or len(c) != len(vectors[0]):
            continue
        c = c / norm
        sims = [float(c @ v) for v in vectors]
        best = int(np.argmax(sims))
        if sims[best] >= threshold:
            matches[label] = names[best]
    return matches
