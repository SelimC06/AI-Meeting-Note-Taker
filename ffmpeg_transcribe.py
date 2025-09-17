import subprocess, signal, sys, threading, tempfile, os
from faster_whisper import WhisperModel
from pathlib import Path

_ffmpeg_proc = None

def start_screen_recording_ffmpeg(
        out_path = "capture.mkv",
        framerate = 30,
        system_dev = 'audio=Stereo Mix (Realtek(R) Audio)',
        mic_dev = 'audio=Microphone Array (Intel® Smart Sound Technology for Digital Microphones)',
        separate_tracks=True
    ):
    """
    seperate_tracks:
        True = MKV
        False = MP4
    """
    global _ffmpeg_proc
    stop_screen_recording_ffmpeg()

    if separate_tracks:
        cmd = [
            "ffmpeg", "-y",
            "-f", "gdigrab", "-framerate", str(framerate), "-i", "desktop",
            "-f", "dshow", "-rtbufsize", "512M", "-i", system_dev,
            "-f", "dshow", "-rtbufsize", "512M", "-i", mic_dev,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ar", "48000", "-ac", "2",
            "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0",
            "-metadata:s:a:0", "title=SystemAudio", "-metadata:s:a:1", "title=Mic",
            out_path
        ]
    else:
        cmd = [
            "ffmpeg", "-y",
            "-f", "gdigrab", "-framerate", str(framerate), "-i", "desktop",
            "-f", "dshow", "-rtbufsize", "512M", "-i", system_dev,
            "-f", "dshow", "-rtbufsize", "512M", "-i", mic_dev,
            "-filter_complex", "[1:a][2:a]amix=inputs=2:duration=longest:dropout_transition=200[a]",
            "-map", "0:v", "-map", "[a]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ar", "48000", "-ac", "2",
            "-metadata:s:a:0", "title=SystemAudio", "-metadata:s:a:1", "title=Mic",
            out_path
        ]
    
    creationflags = 0
    if sys.platform.startswith("win"):
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP

    _ffmpeg_proc = subprocess.Popen(cmd, creationflags=creationflags)
    print(f"Recorded")

def stop_screen_recording_ffmpeg():
    global _ffmpeg_proc
    if _ffmpeg_proc is None:
        return
    
    try:
        if sys.platform.startswith("win"):
            _ffmpeg_proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            _ffmpeg_proc.send_signal(signal.SIGINT)
        _ffmpeg_proc.wait(timeout=10)
    except Exception:
        _ffmpeg_proc.kill()
    finally:
        _ffmpeg_proc = None
        print("Stopped")

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
    cmd = ["ffmpeg", "-y", "-i", str(video), "-vf", vf, "-vsync", "vfr"]
    if image_ext.lower() in ("jpg", "jpeg"):
        cmd += ["-q:v", str(quality)]
    cmd += [pattern]

    subprocess.run(cmd, check=True)
    frames = sorted(outdir.glob(f"frame_*.{image_ext}"))
    if max_frames is not None and len(frames) > max_frames:
        frames = frames[:max_frames]

    return frames

def extract_keyframes_scene(
    video_path: str,
    out_dir: str = "frames_scene",
    scene_threshold: float = 0.35,
    scale_width: int | None = 1280,
    image_ext: str = "png",
    quality: int = 2,
    max_frames: int | None = 10,
) -> list[Path]:
    video = Path(video_path)
    if not video.exists():
        raise FileNotFoundError(f"Video not found: {video}")

    outdir = Path(out_dir)
    outdir.mkdir(parents=True, exist_ok=True)

    select = f"select='gt(scene,{scene_threshold})',metadata=print"
    vf = select
    if scale_width is not None:
        vf += f",scale={scale_width}:-2"

    pattern = str(outdir / f"scene_%05d.{image_ext}")
    cmd = ["ffmpeg","-y","-i",str(video),"-vf",vf,"-vsync","vfr"]
    if image_ext.lower() in ("jpg","jpeg"):
        cmd += ["-q:v", str(quality)]
    cmd += [pattern]

    subprocess.run(cmd, check=True)
    frames = sorted(outdir.glob(f"scene_*.{image_ext}"))
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
    frames_mode: str = "uniform",  # "uniform" or "scene"
    frames_out_dir: str = "frames",
    every_n_seconds: float = 10.0,
    scene_threshold: float = 0.35,
    scale_width: int | None = 1280,
    image_ext: str = "png",
    quality: int = 2,
    max_frames: int | None = 6,):

    stop_screen_recording_ffmpeg()

    wav_path = Path(transcript_prefix).with_suffix(".wav")
    if separate_tracks:
        subprocess.run([
        "ffmpeg", "-y", "-i", video_path,
        "-filter_complex", "[0:a:0][0:a:1]amix=inputs=2:duration=longest:dropout_transition=200",
        "-ac", "1", "-ar", "16000", str(wav_path)
    ], check=True)
    else:
        subprocess.run([
            "ffmpeg","-y","-i",video_path,
            "-map","0:a:0","-ac","1","-ar","16000",str(wav_path)
        ], check=True)

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(wav_path))

    full_text = " ".join(seg.text for seg in segments).strip()
    out_txt = Path(transcript_prefix).with_suffix(".txt")
    Path(out_txt).write_text(full_text, encoding="utf-8")

    frame_paths = None
    if extract_frames_after:
        if frames_mode == "scene":
            frame_paths = extract_keyframes_scene(
                video_path, out_dir=frames_out_dir, scene_threshold=scene_threshold,
                scale_width=scale_width, image_ext=image_ext, quality=quality, max_frames=max_frames
            )
        else:
            frame_paths = extract_frames(
                video_path, out_dir=frames_out_dir, every_n_seconds=every_n_seconds,
                scale_width=scale_width, image_ext=image_ext, quality=quality, max_frames=max_frames
            )

    print(f"Transcript and frames saved")
    return str(out_txt), frame_paths
