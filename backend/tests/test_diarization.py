def test_merge_track_segments_tags_and_orders_by_start_time():
    from app.diarization import merge_track_segments

    mic = [{"start": 5.0, "end": 6.0, "text": "yes exactly"}]
    system = [{"start": 0.0, "end": 2.0, "text": "hello everyone"}]

    result = merge_track_segments(mic, system)

    assert result == [
        {"start": 0.0, "end": 2.0, "speaker": "Others", "text": "hello everyone", "words": []},
        {"start": 5.0, "end": 6.0, "speaker": "You", "text": "yes exactly", "words": []},
    ]


def test_merge_track_segments_preserves_overlapping_segments_from_both_tracks():
    # Two genuinely simultaneous audio tracks -- talking over a remote
    # participant is expected, not a bug, so overlapping start/end ranges
    # between speakers must both survive the merge, just ordered by start.
    from app.diarization import merge_track_segments

    mic = [{"start": 1.0, "end": 3.0, "text": "wait let me"}]
    system = [{"start": 1.5, "end": 2.5, "text": "so as I was saying"}]

    result = merge_track_segments(mic, system)

    assert len(result) == 2
    assert result[0] == {
        "start": 1.0, "end": 3.0, "speaker": "You", "text": "wait let me", "words": []
    }
    assert result[1] == {
        "start": 1.5, "end": 2.5, "speaker": "Others", "text": "so as I was saying", "words": []
    }


def test_merge_track_segments_handles_one_track_empty():
    from app.diarization import merge_track_segments

    system = [{"start": 0.0, "end": 1.0, "text": "hi"}]

    result = merge_track_segments([], system)

    assert result == [{"start": 0.0, "end": 1.0, "speaker": "Others", "text": "hi", "words": []}]


def test_merge_track_segments_handles_one_track_missing_entirely():
    from app.diarization import merge_track_segments

    mic = [{"start": 0.0, "end": 1.0, "text": "hi"}]

    result = merge_track_segments(mic, None)

    assert result == [{"start": 0.0, "end": 1.0, "speaker": "You", "text": "hi", "words": []}]


def test_merge_track_segments_handles_both_tracks_empty():
    from app.diarization import merge_track_segments

    assert merge_track_segments([], []) == []
    assert merge_track_segments(None, None) == []


def test_merge_track_segments_preserves_word_level_timestamps():
    # transcribe_wav (ffmpeg_transcribe.py) attaches word-level timestamps to
    # each segment now that word_timestamps=True is on by default -- the
    # merge must not silently drop them before they reach transcript.json.
    from app.diarization import merge_track_segments

    mic = [{
        "start": 0.0, "end": 1.0, "text": "hi there",
        "words": [{"word": "hi", "start": 0.0, "end": 0.4, "probability": 0.9}],
    }]

    result = merge_track_segments(mic, [])

    assert result[0]["words"] == [{"word": "hi", "start": 0.0, "end": 0.4, "probability": 0.9}]


def test_merge_track_segments_defaults_words_to_empty_list_when_absent():
    from app.diarization import merge_track_segments

    mic = [{"start": 0.0, "end": 1.0, "text": "hi there"}]

    result = merge_track_segments(mic, [])

    assert result[0]["words"] == []


# ---- align_speaker_turns (Track B: n-party pyannote alignment) -------------

def test_align_speaker_turns_assigns_whole_segment_to_single_overlapping_turn():
    from app.diarization import align_speaker_turns

    segments = [{"start": 0.0, "end": 2.0, "text": "hello everyone", "words": []}]
    turns = [("SPEAKER_00", 0.0, 2.0)]

    result = align_speaker_turns(segments, turns)

    assert result == [
        {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_00", "text": "hello everyone", "words": []}
    ]


def test_align_speaker_turns_picks_the_turn_with_greatest_overlap():
    from app.diarization import align_speaker_turns

    # Segment mostly overlaps SPEAKER_01's turn (1.8s) vs SPEAKER_00's (0.2s).
    segments = [{"start": 0.8, "end": 3.0, "text": "so anyway", "words": []}]
    turns = [("SPEAKER_00", 0.0, 1.0), ("SPEAKER_01", 1.0, 3.0)]

    result = align_speaker_turns(segments, turns)

    assert result[0]["speaker"] == "SPEAKER_01"


def test_align_speaker_turns_labels_a_far_unmatched_segment_unknown():
    from app.diarization import align_speaker_turns

    segments = [{"start": 10.0, "end": 11.0, "text": "silence gap", "words": []}]
    turns = [("SPEAKER_00", 0.0, 1.0)]

    result = align_speaker_turns(segments, turns)

    assert result == [
        {"start": 10.0, "end": 11.0, "speaker": "Unknown", "text": "silence gap", "words": []}
    ]


def test_align_speaker_turns_handles_no_turns_at_all():
    from app.diarization import align_speaker_turns

    segments = [{"start": 0.0, "end": 1.0, "text": "hi", "words": []}]

    assert align_speaker_turns(segments, []) == [
        {"start": 0.0, "end": 1.0, "speaker": "Unknown", "text": "hi", "words": []}
    ]
    assert align_speaker_turns([], [("SPEAKER_00", 0.0, 1.0)]) == []


def test_align_speaker_turns_splits_a_segment_that_straddles_a_speaker_change():
    # A single Whisper segment spanning a mid-sentence speaker handoff must
    # split at the word boundary closest to the turn change, not get
    # assigned wholesale to one speaker -- this is why word_timestamps are
    # carried through merge_track_segments at all.
    from app.diarization import align_speaker_turns

    segments = [{
        "start": 0.0, "end": 2.0, "text": "go ahead no you go",
        "words": [
            {"word": "go", "start": 0.0, "end": 0.4, "probability": 0.9},
            {"word": "ahead", "start": 0.4, "end": 0.9, "probability": 0.9},
            {"word": "no", "start": 1.0, "end": 1.3, "probability": 0.9},
            {"word": "you", "start": 1.3, "end": 1.6, "probability": 0.9},
            {"word": "go", "start": 1.6, "end": 2.0, "probability": 0.9},
        ],
    }]
    turns = [("SPEAKER_00", 0.0, 1.0), ("SPEAKER_01", 1.0, 2.0)]

    result = align_speaker_turns(segments, turns)

    assert result == [
        {
            "start": 0.0, "end": 0.9, "speaker": "SPEAKER_00", "text": "go ahead",
            "words": segments[0]["words"][:2],
        },
        {
            "start": 1.0, "end": 2.0, "speaker": "SPEAKER_01", "text": "no you go",
            "words": segments[0]["words"][2:],
        },
    ]


def test_align_speaker_turns_falls_back_to_majority_overlap_without_word_timestamps():
    # A segment straddling two turns but with no word-level timestamps
    # (words == []) can't be split -- must fall back to majority-overlap
    # over the whole segment instead of crashing or losing text.
    from app.diarization import align_speaker_turns

    segments = [{"start": 0.0, "end": 2.0, "text": "go ahead no you go", "words": []}]
    turns = [("SPEAKER_00", 0.0, 0.5), ("SPEAKER_01", 0.5, 2.0)]

    result = align_speaker_turns(segments, turns)

    assert result == [
        {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_01", "text": "go ahead no you go", "words": []}
    ]


def test_align_speaker_turns_orders_multiple_segments_by_start_time():
    from app.diarization import align_speaker_turns

    segments = [
        {"start": 5.0, "end": 6.0, "text": "second", "words": []},
        {"start": 0.0, "end": 1.0, "text": "first", "words": []},
    ]
    turns = [("SPEAKER_00", 0.0, 1.0), ("SPEAKER_01", 5.0, 6.0)]

    result = align_speaker_turns(segments, turns)

    assert [r["text"] for r in result] == ["first", "second"]


def test_align_speaker_turns_borrows_the_nearest_speaker_within_the_gap():
    """Speech just past a turn's edge (pyannote clipping a trailing word)
    belongs to the adjacent speaker, not "Unknown"."""
    from app.diarization import align_speaker_turns

    segments = [{"start": 5.4, "end": 6.0, "text": "right.", "words": []}]
    turns = [("SPEAKER_00", 0.0, 2.0), ("SPEAKER_01", 2.0, 5.0), ("SPEAKER_02", 6.8, 9.0)]

    assert align_speaker_turns(segments, turns)[0]["speaker"] == "SPEAKER_01"


def test_align_speaker_turns_uses_the_given_fallback_label():
    from app.diarization import align_speaker_turns

    segments = [{"start": 10.0, "end": 11.0, "text": "far away", "words": []}]

    result = align_speaker_turns(segments, [("SPEAKER_00", 0.0, 1.0)], fallback_speaker="Others")

    assert result[0]["speaker"] == "Others"


def test_align_speaker_turns_never_leaves_a_split_group_unlabeled():
    """Words before the first overlapping turn of a straddling segment used
    to form a speaker=None group."""
    from app.diarization import align_speaker_turns

    seg = {
        "start": 0.0, "end": 9.0, "text": "early words then alice then bob",
        "words": [
            {"word": "early", "start": 0.0, "end": 0.5},
            {"word": "alice", "start": 3.0, "end": 3.5},
            {"word": "bob", "start": 6.0, "end": 6.5},
        ],
    }
    turns = [("SPEAKER_00", 2.9, 5.0), ("SPEAKER_01", 5.5, 9.0)]

    result = align_speaker_turns([seg], turns)

    assert all(r["speaker"] is not None for r in result)
    assert [r["speaker"] for r in result] == ["Unknown", "SPEAKER_00", "SPEAKER_01"]
