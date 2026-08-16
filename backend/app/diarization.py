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
    (faster-whisper Segment timestamps). Segments are ordered by start time
    only -- they come from two genuinely simultaneous audio tracks (you can
    talk over remote participants), so overlapping timestamps between the two
    speakers are expected, not a bug, and both are kept.
    """
    tagged = [
        {"start": seg["start"], "end": seg["end"], "speaker": "You", "text": seg["text"]}
        for seg in (mic_segments or [])
    ] + [
        {"start": seg["start"], "end": seg["end"], "speaker": "Others", "text": seg["text"]}
        for seg in (system_segments or [])
    ]
    tagged.sort(key=lambda seg: seg["start"])
    return tagged
