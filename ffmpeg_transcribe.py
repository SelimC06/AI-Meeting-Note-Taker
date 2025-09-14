import subprocess, signal, sys, threading, tempfile, os
from faster_whisper import WhisperModel
from pathlib import Path

_ffmpeg_proc = None

def start_screen_recording_ffmpeg(
        out_path = "capture.mkv",
        framerate = 30,
        system_dev = 'audio=Stereo Mix (Realtek(R) Audio)',
        mic_dev = 'audio=Microphone Array (Intel® Smart Sound Technology for Digital Microphones)',
        seperate_tracks=True
    ):
    """
    seperate_tracks:
        True = MKV
        False = MP4
    """
    global _ffmpeg_proc
    stop_screen_recording_ffmpeg()

    if seperate_tracks:
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

def stop_recording_and_transcribe(video_path="capture.mkv", transcript_prefix="transcript_"):
    stop_screen_recording_ffmpeg()

    wav_path = Path(transcript_prefix).with_suffix(".wav")
    mix_cmd = [
        "ffmpeg", "-y", "-i", video_path,
        "-filter_complex", "[0:a:0][0:a:1]amix=inputs=2:duration=longest:dropout_transition=200",
        "-ac", "1", "-ar", "16000", str(wav_path)
    ]
    subprocess.run(mix_cmd, check=True)

    model = WhisperModel("base.en", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(wav_path))

    full_text = " ".join(seg.text for seg in segments).strip()
    out_txt = Path(transcript_prefix).with_suffix(".txt")
    Path(out_txt).write_text(full_text, encoding="utf-8")

    print(f"Transcript saved")
    return str(out_txt)
