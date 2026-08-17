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
