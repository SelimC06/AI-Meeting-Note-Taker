from __future__ import annotations
from typing import Dict, List, Optional, Tuple


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
        tagged = {
            "start": seg["start"],
            "end": seg["end"],
            "speaker": speaker,
            "text": seg["text"],
            "words": seg.get("words", []),
        }
        # Carried when the multilingual span pass set it (1.2b) -- the UI
        # tags minority-language segments with it.
        if seg.get("language"):
            tagged["language"] = seg["language"]
        return tagged

    tagged = [_tag(seg, "You") for seg in (mic_segments or [])] + [
        _tag(seg, "Others") for seg in (system_segments or [])
    ]
    tagged.sort(key=lambda seg: seg["start"])
    return tagged


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _best_turn_for_range(
    start: float, end: float, turns: List[Tuple[str, float, float]]
) -> Optional[str]:
    best_speaker = None
    best_overlap = 0.0
    for speaker, t_start, t_end in turns:
        overlap = _overlap(start, end, t_start, t_end)
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = speaker
    return best_speaker


# What a segment pyannote attributed to no one gets labeled, when no turn is
# close enough to borrow a speaker from (see _fallback_speaker). A real
# label, not None: transcript_.txt is written as "<speaker>: <text>" and
# used to get literal "None: ..." lines, and a string label can also be
# renamed like any other speaker.
UNKNOWN_SPEAKER = "Unknown"

# How far (seconds) outside every turn a segment can sit and still be given
# the nearest turn's speaker. Unattributed segments are mostly speech at
# the ragged edge of a turn -- a trailing word, a breath before the next
# sentence -- which pyannote's boundaries clip by a fraction of a second,
# so the adjacent speaker is almost always right. Further away than this,
# a guess would be as likely to name the wrong person as the right one,
# which is worse than an honest "Unknown".
NEAREST_TURN_MAX_GAP_SECONDS = 1.0


def _fallback_speaker(
    start: float, end: float, turns: List[Tuple[str, float, float]], fallback: str
) -> str:
    best_speaker = None
    best_gap = NEAREST_TURN_MAX_GAP_SECONDS
    for speaker, t_start, t_end in turns:
        gap = max(t_start - end, start - t_end, 0.0)
        if gap <= best_gap and (best_speaker is None or gap < best_gap):
            best_gap = gap
            best_speaker = speaker
    return best_speaker if best_speaker is not None else fallback


def _split_segment_by_words(seg: dict, turns: List[Tuple[str, float, float]]) -> List[Dict]:
    """Split one Whisper segment at word boundaries wherever the
    best-overlapping pyannote turn changes between consecutive words. A word
    with no overlapping turn (e.g. a short silence pyannote didn't attribute)
    carries forward the previous word's speaker rather than breaking the
    group, so a lone unattributed word doesn't fragment the segment."""
    groups: List[Tuple[Optional[str], List[dict]]] = []
    current_speaker: Optional[str] = None
    current_words: List[dict] = []

    for word in seg["words"]:
        speaker = _best_turn_for_range(word["start"], word["end"], turns)
        if speaker is None and current_words:
            speaker = current_speaker
        if current_words and speaker != current_speaker:
            groups.append((current_speaker, current_words))
            current_words = []
        current_speaker = speaker
        current_words.append(word)

    if current_words:
        groups.append((current_speaker, current_words))

    return [
        {
            "start": group_words[0]["start"],
            "end": group_words[-1]["end"],
            "speaker": speaker,
            "text": " ".join(w["word"].strip() for w in group_words).strip(),
            "words": group_words,
        }
        for speaker, group_words in groups
    ]


def align_speaker_turns(
    segments: List[dict],
    turns: List[Tuple[str, float, float]],
    fallback_speaker: str = UNKNOWN_SPEAKER,
) -> List[Dict]:
    """Assign a pyannote speaker label to each Whisper segment via
    majority-overlap matching against pyannote's speaker turns.

    segments: list of {"start", "end", "text", "words"} dicts (Whisper
    segments, e.g. from ffmpeg_transcribe.transcribe_wav). turns: list of
    (speaker_label, start, end) tuples (pyannote diarization turns), any
    order.

    A segment overlapping exactly one turn is assigned that turn's speaker
    wholesale. A segment overlapping more than one turn (a mid-sentence
    speaker change) is split at the word boundary closest to the turn
    change using `words`, so a speaker change doesn't get silently
    attributed to the wrong person -- this is why word_timestamps are
    carried through `merge_track_segments` in the first place. Without word
    timestamps available, a straddling segment falls back to majority
    overlap over the whole segment rather than splitting. A segment with no
    overlapping turn at all (or leading words of a split segment that
    precede every turn) is never dropped: it takes the nearest turn's
    speaker if one is within NEAREST_TURN_MAX_GAP_SECONDS, else
    `fallback_speaker` -- "Unknown" by default; server.py passes "Others"
    when refining the system track, since that audio is known to be a
    remote participant even when pyannote can't say which one.
    """
    result: List[Dict] = []
    for seg in segments:
        overlapping = [t for t in turns if _overlap(seg["start"], seg["end"], t[1], t[2]) > 0]

        if len(overlapping) <= 1:
            speaker = overlapping[0][0] if overlapping else None
            result.append({
                "start": seg["start"],
                "end": seg["end"],
                "speaker": speaker,
                "text": seg["text"],
                "words": seg.get("words", []),
            })
            continue

        if not seg.get("words"):
            speaker = _best_turn_for_range(seg["start"], seg["end"], overlapping)
            result.append({
                "start": seg["start"],
                "end": seg["end"],
                "speaker": speaker,
                "text": seg["text"],
                "words": [],
            })
            continue

        result.extend(_split_segment_by_words(seg, overlapping))

    for item in result:
        if item["speaker"] is None:
            item["speaker"] = _fallback_speaker(item["start"], item["end"], turns, fallback_speaker)

    result.sort(key=lambda s: s["start"])
    return result
