from app.whisper_cache import get_whisper_model


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
