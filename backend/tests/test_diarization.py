def test_merge_track_segments_tags_and_orders_by_start_time():
    from app.diarization import merge_track_segments

    mic = [{"start": 5.0, "end": 6.0, "text": "yes exactly"}]
    system = [{"start": 0.0, "end": 2.0, "text": "hello everyone"}]

    result = merge_track_segments(mic, system)

    assert result == [
        {"start": 0.0, "end": 2.0, "speaker": "Others", "text": "hello everyone"},
        {"start": 5.0, "end": 6.0, "speaker": "You", "text": "yes exactly"},
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
    assert result[0] == {"start": 1.0, "end": 3.0, "speaker": "You", "text": "wait let me"}
    assert result[1] == {
        "start": 1.5, "end": 2.5, "speaker": "Others", "text": "so as I was saying"
    }


def test_merge_track_segments_handles_one_track_empty():
    from app.diarization import merge_track_segments

    system = [{"start": 0.0, "end": 1.0, "text": "hi"}]

    result = merge_track_segments([], system)

    assert result == [{"start": 0.0, "end": 1.0, "speaker": "Others", "text": "hi"}]


def test_merge_track_segments_handles_one_track_missing_entirely():
    from app.diarization import merge_track_segments

    mic = [{"start": 0.0, "end": 1.0, "text": "hi"}]

    result = merge_track_segments(mic, None)

    assert result == [{"start": 0.0, "end": 1.0, "speaker": "You", "text": "hi"}]


def test_merge_track_segments_handles_both_tracks_empty():
    from app.diarization import merge_track_segments

    assert merge_track_segments([], []) == []
    assert merge_track_segments(None, None) == []
