import subprocess
from faster_whisper import WhisperModel
from pathlib import Path
from .bin_paths import FFMPEG_BIN
from .language_spans import detect_language_spans, read_wav_f32
from .whisper_cache import get_whisper_model, transcribe_audio


def _segment_dicts(segments, offset_seconds: float = 0.0, language: str | None = None) -> list[dict]:
    """faster-whisper segments -> the pipeline's plain dicts, with every
    timestamp (words included) shifted by offset_seconds and tagged with
    the span's language when known."""
    out = []
    for seg in segments:
        if not (seg.text and seg.text.strip()):
            continue
        entry = {
            "start": seg.start + offset_seconds,
            "end": seg.end + offset_seconds,
            "text": seg.text.strip(),
            "words": [
                {
                    "word": w.word,
                    "start": w.start + offset_seconds,
                    "end": w.end + offset_seconds,
                    "probability": w.probability,
                }
                for w in (seg.words or [])
            ],
        }
        if language:
            entry["language"] = language
        out.append(entry)
    return out


def _transcribe_language_spans(model, wav_path: str, initial_prompt: str | None) -> list[dict] | None:
    """Code-switch handling for language="auto" (1.2b): detect languages
    over windows of the audio and transcribe each span with its language
    pinned, so English -> Turkish -> English in one recording stops being
    transliterated into the first language Whisper saw.

    Returns None whenever a single pass is the right call -- unreadable
    audio, detection unavailable, or one language throughout -- and the
    caller then runs the normal path."""
    samples, rate = read_wav_f32(wav_path)
    if samples is None or rate <= 0 or len(samples) == 0:
        return None
    spans = detect_language_spans(model, samples, rate)
    if len(spans) <= 1:
        return None
    results: list[dict] = []
    for span in spans:
        chunk = samples[int(span["start"] * rate):int(span["end"] * rate)]
        if len(chunk) == 0:
            continue
        segments, _ = transcribe_audio(
            model, chunk, initial_prompt=initial_prompt, language=span["language"]
        )
        results.extend(_segment_dicts(segments, offset_seconds=span["start"], language=span["language"]))
    return results


def extract_frames(
    video_path : str,
    out_dir : str = "frames",
    every_n_seconds : float = 10.0,
    scale_width : int | None = 1280,
    image_ext : str = "png",
    quality : int = 2,
    max_frames : int | None = 6,
) -> list[Path]:
    video = Path(video_path)
    if not video.exists():
        raise FileNotFoundError(f"Video not found: {video}")

    outdir = Path(out_dir)
    outdir.mkdir(parents=True, exist_ok=True)

    vf_parts = [f"fps=1/{every_n_seconds}"]
    if scale_width is not None:
        vf_parts.append(f"scale={scale_width}:-2")
    vf = ",".join(vf_parts)

    pattern = str(outdir / f"frame_%05d.{image_ext}")
    cmd = [FFMPEG_BIN, "-y", "-i", str(video), "-vf", vf, "-fps_mode", "vfr"]
    if image_ext.lower() in ("jpg", "jpeg"):
        cmd += ["-q:v", str(quality)]
    cmd += [pattern]

    subprocess.run(cmd, check=True)
    frames = sorted(outdir.glob(f"frame_*.{image_ext}"))
    if max_frames is not None and len(frames) > max_frames:
        frames = frames[:max_frames]

    return frames


def transcribe_wav(
    wav_path: str,
    model_name: str = "base",
    initial_prompt: str | None = None,
    language: str | None = None,
) -> list[dict]:
    """Transcribe a single already-extracted wav file, returning segment-level
    timestamps. Used for the mic/system 2-party split: unlike
    stop_recording_and_transcribe, this skips the ffmpeg audio-extraction
    step entirely since the wav is already 16kHz mono.

    model_name and language arrive already resolved by the caller (see
    settings_store.resolve_whisper_model / resolve_transcribe_language);
    language=None means auto-detect -- including across the recording:
    code-switched audio is split into language spans, each transcribed
    with its own language pinned (see _transcribe_language_spans).
    """
    model = get_whisper_model(WhisperModel, model_name, device="cpu", compute_type="int8")
    if language is None:
        multilingual = _transcribe_language_spans(model, wav_path, initial_prompt)
        if multilingual is not None:
            return multilingual
    segments, _ = transcribe_audio(model, wav_path, initial_prompt=initial_prompt, language=language)
    return _segment_dicts(segments)


def stop_recording_and_transcribe(
    video_path="capture.mkv",
    transcript_prefix="transcript_",
    model_name="base",
    separate_tracks=True,
    initial_prompt: str | None = None,
    language: str | None = None,
    # frame extraction options:
    extract_frames_after: bool = False,
    frames_out_dir: str = "frames",
    every_n_seconds: float = 10.0,
    scale_width: int | None = 1280,
    image_ext: str = "png",
    quality: int = 2,
    max_frames: int | None = 6,):

    wav_path = Path(transcript_prefix).with_suffix(".wav")
    if separate_tracks:
        subprocess.run([
        FFMPEG_BIN, "-y", "-i", video_path,
        "-filter_complex", "[0:a:0][0:a:1]amix=inputs=2:duration=longest:dropout_transition=200",
        "-ac", "1", "-ar", "16000", str(wav_path)
    ], check=True)
    else:
        subprocess.run([
            FFMPEG_BIN,"-y","-i",video_path,
            "-map","0:a:0","-ac","1","-ar","16000",str(wav_path)
        ], check=True)

    model = get_whisper_model(WhisperModel, model_name, device="cpu", compute_type="int8")
    segments, _ = transcribe_audio(model, str(wav_path), initial_prompt=initial_prompt, language=language)

    full_text = " ".join(seg.text for seg in segments).strip()
    out_txt = Path(transcript_prefix).with_suffix(".txt")
    if out_txt.exists():
        with out_txt.open("a", encoding="utf-8") as f:
            f.write(f"\n---\n{full_text}")
    else:
        Path(out_txt).write_text(full_text, encoding="utf-8")

    frame_paths = None
    if extract_frames_after:
        frame_paths = extract_frames(
            video_path, out_dir=frames_out_dir, every_n_seconds=every_n_seconds,
            scale_width=scale_width, image_ext=image_ext, quality=quality, max_frames=max_frames
        )

    print("Transcript and frames saved")
    return str(out_txt), frame_paths
