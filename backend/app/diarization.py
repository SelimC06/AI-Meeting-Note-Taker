from __future__ import annotations
from typing import Dict, List, Optional


def merge_track_segments(
    mic_segments: Optional[List[dict]],
    system_segments: Optional[List[dict]],
) -> List[Dict]:
    """Interleave two independently-transcribed segment streams into one
    chronological timeline, tagging each segment by which track it came from
    (Track A: "You" vs. "Others" 2-party split).

    mic_segments/system_segments are lists of {"start", "end", "text"} dicts
    (faster-whisper Segment timestamps), each optionally carrying a "words"
    list (word-level timestamps, present when word_timestamps=True -- see
    ffmpeg_transcribe.transcribe_wav). Word timestamps are carried through
    into the merged output (defaulting to [] when absent) rather than
    dropped -- Track B's pyannote-turn alignment needs them, and they're
    already computed by the time they reach here. Segments are ordered by
    start time only -- they come from two genuinely simultaneous audio
    tracks (you can talk over remote participants), so overlapping
    timestamps between the two speakers are expected, not a bug, and both
    are kept.
    """
    def _tag(seg: dict, speaker: str) -> Dict:
        return {
            "start": seg["start"],
            "end": seg["end"],
            "speaker": speaker,
            "text": seg["text"],
            "words": seg.get("words", []),
        }

    tagged = [_tag(seg, "You") for seg in (mic_segments or [])] + [
        _tag(seg, "Others") for seg in (system_segments or [])
    ]
    tagged.sort(key=lambda seg: seg["start"])
    return tagged
