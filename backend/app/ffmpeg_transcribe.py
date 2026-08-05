import subprocess
from faster_whisper import WhisperModel
from pathlib import Path
from .bin_paths import FFMPEG_BIN


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


def stop_recording_and_transcribe(
    video_path="capture.mkv",
    transcript_prefix="transcript_",
    model_name="base.en",
    separate_tracks=True,
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

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(wav_path))

    full_text = " ".join(seg.text for seg in segments).strip()
    out_txt = Path(transcript_prefix).with_suffix(".txt")
    if (out_txt.exists):
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

    print(f"Transcript and frames saved")
    return str(out_txt), frame_paths
