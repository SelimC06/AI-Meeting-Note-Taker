import threading

_cache = {}
_lock = threading.Lock()


def get_whisper_model(model_cls, model_name, **kwargs):
    """Return a cached WhisperModel instance, constructing it on first use.

    Keyed on (model_cls, model_name, kwargs) rather than just model_name so
    that swapping in a different WhisperModel implementation (e.g. a test
    fake) gets its own cache entry instead of reusing a stale instance built
    from a different class.
    """
    key = (model_cls, model_name, tuple(sorted(kwargs.items())))
    with _lock:
        model = _cache.get(key)
        if model is None:
            model = model_cls(model_name, **kwargs)
            _cache[key] = model
        return model
