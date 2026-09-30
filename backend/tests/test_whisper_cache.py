from app.whisper_cache import get_whisper_model, transcribe_audio


class FakeModel:
    instances_created = 0

    def __init__(self, model_name, **kwargs):
        FakeModel.instances_created += 1
        self.model_name = model_name
        self.kwargs = kwargs


def setup_function():
    FakeModel.instances_created = 0
    # get_whisper_model's module-level _cache persists across tests since
    # it's process-wide -- clear it so each test starts from a clean slate.
    import app.whisper_cache as whisper_cache_module
    whisper_cache_module._cache.clear()


def test_get_whisper_model_reuses_a_cached_instance_for_identical_calls():
    a = get_whisper_model(FakeModel, "tiny.en", device="cpu", compute_type="int8")
    b = get_whisper_model(FakeModel, "tiny.en", device="cpu", compute_type="int8")

    assert a is b
    assert FakeModel.instances_created == 1


def test_get_whisper_model_creates_separate_entries_for_different_kwargs():
    a = get_whisper_model(FakeModel, "tiny.en", compute_type="int8")
    b = get_whisper_model(FakeModel, "tiny.en", device="cpu", compute_type="int8")

    assert a is not b
    assert FakeModel.instances_created == 2


def test_get_whisper_model_matches_server_and_ffmpeg_transcribe_call_conventions():
    """
    Regression test for brief 13 #7: server.py's fallback-whisper call site
    used to pass only compute_type="int8", while ffmpeg_transcribe.py's call
    passed device="cpu", compute_type="int8" -- two different kwargs dicts
    for what's meant to be the same model, doubling RAM if both paths ran.
    server.py now passes the same device="cpu" explicitly, so both call
    conventions must hit the same cache entry.
    """
    server_py_call = get_whisper_model(FakeModel, "base.en", device="cpu", compute_type="int8")
    ffmpeg_transcribe_py_call = get_whisper_model(FakeModel, "base.en", device="cpu", compute_type="int8")

    assert server_py_call is ffmpeg_transcribe_py_call
    assert FakeModel.instances_created == 1


def test_transcribe_audio_default_params_are_consistent_across_all_call_sites():
    """
    Regression test for the primary/fallback/benchmark drift documented in
    docs/Core pipeline quality fix/03-transcription-accuracy.md: three
    separate WhisperModel.transcribe() call sites used to pass different
    beam_size values. transcribe_audio() is now the only place that decides
    these defaults, so every caller (ffmpeg_transcribe.py, server.py's
    fallback path, wer_benchmark.py/speed_benchmark.py) gets the same
    values by construction.
    """
    captured = {}

    class FakeTranscribeModel:
        def transcribe(self, path, **kwargs):
            captured["path"] = path
            captured.update(kwargs)
            return "segments", "info"

    result = transcribe_audio(FakeTranscribeModel(), "audio.wav", initial_prompt="glossary terms")

    assert result == ("segments", "info")
    assert captured["path"] == "audio.wav"
    assert captured["initial_prompt"] == "glossary terms"
    assert captured["beam_size"] == 1
    assert captured["vad_filter"] is False
    assert captured["word_timestamps"] is True
    assert captured["condition_on_previous_text"] is True


def test_only_the_most_recently_used_model_stays_cached(monkeypatch):
    from app import whisper_cache

    monkeypatch.setattr(whisper_cache, "_cache", {})
    built = []

    class FakeModel:
        def __init__(self, name, **kwargs):
            built.append(name)

    tiny = whisper_cache.get_whisper_model(FakeModel, "tiny.en", device="cpu")
    whisper_cache.get_whisper_model(FakeModel, "medium.en", device="cpu")

    assert len(whisper_cache._cache) == 1
    assert tiny not in whisper_cache._cache.values()
    # Same model again: served from the cache, not rebuilt.
    whisper_cache.get_whisper_model(FakeModel, "medium.en", device="cpu")
    assert built == ["tiny.en", "medium.en"]
