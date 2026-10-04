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
            # Only the most recently used model stays loaded. Each is
            # hundreds of MB to ~1.5 GB of RAM (medium.en), and switching
            # the Whisper model in Settings used to keep every one ever
            # loaded alive for the rest of the session.
            _cache.clear()
            _cache[key] = model
        return model


def transcribe_audio(
    model,
    path,
    initial_prompt=None,
    language=None,
    beam_size=1,
    vad_filter=False,
    word_timestamps=True,
    condition_on_previous_text=True,
):
    """Single call site for WhisperModel.transcribe(), used by every
    transcription code path (and the WER benchmark) so they can't drift out
    of sync with each other the way the primary/fallback paths previously did.

    Defaults are backed by benchmarks/results/wer_results.json +
    speed_results.json on this branch (see
    docs/Core pipeline quality fix/03-transcription-accuracy.md):
    word_timestamps=True is kept on unconditionally per that plan (needed for
    diarization alignment/future UI), but measurement showed it is NOT
    accuracy-neutral as originally assumed -- it costs a real, repeatable WER
    regression, and that regression is *larger* at beam_size=5 than at
    beam_size=1 (0.0706 vs 0.0691 WER with word_timestamps on, vs 0.0665 vs
    0.0675 with it off) -- so beam_size=1 is the better default once
    word_timestamps is mandatory, even though beam_size=5 alone measured
    better in isolation. vad_filter defaults off because it measured no WER
    or speed benefit on the available benchmark audio (no meaningful dead air
    in either the LibriSpeech utterances or the synthetic speed clips) --
    still exposed as a parameter for callers with real meeting audio to test
    against.

    language=None lets Whisper auto-detect (the "auto" setting); a code
    ("en", "tr", ...) pins it, which skips detection and is what
    settings_store.resolve_transcribe_language passes for a fixed-language
    setting. English-only ".en" models simply ignore it.
    """
    return model.transcribe(
        path,
        initial_prompt=initial_prompt,
        language=language,
        beam_size=beam_size,
        vad_filter=vad_filter,
        word_timestamps=word_timestamps,
        condition_on_previous_text=condition_on_previous_text,
    )
