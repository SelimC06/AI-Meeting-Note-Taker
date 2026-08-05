import subprocess
from pathlib import Path

import pytest

import app.server as server_module


def _cp(returncode: int = 0, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


# ---- to_wav ----------------------------------------------------------------

def test_to_wav_returns_dst_on_success(tmp_path, monkeypatch):
    calls = []

    def fake_run(cmd):
        calls.append(cmd)
        return _cp(returncode=0)

    monkeypatch.setattr(server_module, "run", fake_run)

    src = tmp_path / "in.webm"
    src.write_bytes(b"x")
    dst = tmp_path / "out.wav"

    result = server_module.to_wav(src, dst, ar=16000, ac=1)

    assert result == dst
    assert calls[0][0] == server_module.FFMPEG_BIN
    assert "-ar" in calls[0] and "16000" in calls[0]


def test_to_wav_returns_none_on_ffmpeg_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(server_module, "run", lambda cmd: _cp(returncode=1, stderr="boom"))

    src = tmp_path / "in.webm"
    src.write_bytes(b"x")

    result = server_module.to_wav(src, tmp_path / "out.wav")

    assert result is None


def test_to_wav_returns_none_when_src_is_none(tmp_path):
    result = server_module.to_wav(None, tmp_path / "out.wav")
    assert result is None


# ---- mix_audios_wav ----------------------------------------------------------

def test_mix_audios_wav_mixes_both_tracks_on_success(tmp_path, monkeypatch):
    system_wav = tmp_path / "system.wav"
    system_wav.write_bytes(b"sys")
    mic_wav = tmp_path / "mic.wav"
    mic_wav.write_bytes(b"mic")
    out_wav = tmp_path / "mixed.wav"

    calls = []

    def fake_run(cmd):
        calls.append(cmd)
        Path(cmd[-1]).write_bytes(b"mixed")
        return _cp(returncode=0)

    monkeypatch.setattr(server_module, "run", fake_run)

    result = server_module.mix_audios_wav(system_wav, mic_wav, out_wav)

    assert result == out_wav
    assert out_wav.read_bytes() == b"mixed"
    assert "amix" in " ".join(calls[0])


def test_mix_audios_wav_falls_back_to_system_track_when_mix_fails(tmp_path, monkeypatch):
    system_wav = tmp_path / "system.wav"
    system_wav.write_bytes(b"sys")
    mic_wav = tmp_path / "mic.wav"
    mic_wav.write_bytes(b"mic")
    out_wav = tmp_path / "mixed.wav"

    monkeypatch.setattr(server_module, "run", lambda cmd: _cp(returncode=1, stderr="mix failed"))

    result = server_module.mix_audios_wav(system_wav, mic_wav, out_wav)

    assert result == out_wav
    assert out_wav.read_bytes() == b"sys"


def test_mix_audios_wav_uses_system_only(tmp_path):
    system_wav = tmp_path / "system.wav"
    system_wav.write_bytes(b"sys")
    out_wav = tmp_path / "mixed.wav"

    result = server_module.mix_audios_wav(system_wav, None, out_wav)

    assert result == out_wav
    assert out_wav.read_bytes() == b"sys"


def test_mix_audios_wav_uses_mic_only(tmp_path):
    mic_wav = tmp_path / "mic.wav"
    mic_wav.write_bytes(b"mic")
    out_wav = tmp_path / "mixed.wav"

    result = server_module.mix_audios_wav(None, mic_wav, out_wav)

    assert result == out_wav
    assert out_wav.read_bytes() == b"mic"


def test_mix_audios_wav_returns_none_with_no_tracks(tmp_path):
    result = server_module.mix_audios_wav(None, None, tmp_path / "mixed.wav")
    assert result is None


# ---- ffprobe_ok ----------------------------------------------------------

def test_ffprobe_ok_false_for_missing_file(tmp_path):
    assert server_module.ffprobe_ok(tmp_path / "missing.webm") is False


def test_ffprobe_ok_false_for_empty_file(tmp_path):
    p = tmp_path / "empty.webm"
    p.write_bytes(b"")
    assert server_module.ffprobe_ok(p) is False


def test_ffprobe_ok_false_when_ffprobe_fails(tmp_path, monkeypatch):
    p = tmp_path / "video.webm"
    p.write_bytes(b"data")
    monkeypatch.setattr(server_module, "run", lambda cmd: _cp(returncode=1))

    assert server_module.ffprobe_ok(p) is False


def test_ffprobe_ok_true_when_streams_present(tmp_path, monkeypatch):
    p = tmp_path / "video.webm"
    p.write_bytes(b"data")
    monkeypatch.setattr(server_module, "run", lambda cmd: _cp(returncode=0, stdout='{"streams": [{}]}'))

    assert server_module.ffprobe_ok(p) is True


# ---- ffmpeg_has_encoder ----------------------------------------------------------

def test_ffmpeg_has_encoder_true_when_present(monkeypatch):
    monkeypatch.setattr(server_module, "run", lambda cmd: _cp(returncode=0, stdout=" V..... libopus  Opus\n"))
    assert server_module.ffmpeg_has_encoder("libopus") is True


def test_ffmpeg_has_encoder_false_when_absent(monkeypatch):
    monkeypatch.setattr(server_module, "run", lambda cmd: _cp(returncode=0, stdout=" V..... libx264  H264\n"))
    assert server_module.ffmpeg_has_encoder("libopus") is False


# ---- mux_video_audio ----------------------------------------------------------

def test_mux_video_audio_copies_when_no_audio(tmp_path):
    video = tmp_path / "video.webm"
    video.write_bytes(b"vid")
    out_path = tmp_path / "final.webm"

    result = server_module.mux_video_audio(video, None, out_path)

    assert result == out_path
    assert out_path.read_bytes() == b"vid"


def test_mux_video_audio_prefers_libopus(tmp_path, monkeypatch):
    video = tmp_path / "video.webm"
    video.write_bytes(b"vid")
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"aud")
    out_path = tmp_path / "final.webm"

    monkeypatch.setattr(server_module, "ffmpeg_has_encoder", lambda name: name == "libopus")
    calls = []
    monkeypatch.setattr(server_module, "run", lambda cmd: (calls.append(cmd), _cp(returncode=0))[1])

    result = server_module.mux_video_audio(video, audio, out_path)

    assert result == out_path
    assert result.suffix == ".webm"
    assert "libopus" in calls[0]


def test_mux_video_audio_falls_back_to_libvorbis(tmp_path, monkeypatch):
    video = tmp_path / "video.webm"
    video.write_bytes(b"vid")
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"aud")
    out_path = tmp_path / "final.webm"

    monkeypatch.setattr(server_module, "ffmpeg_has_encoder", lambda name: name == "libvorbis")
    monkeypatch.setattr(server_module, "run", lambda cmd: _cp(returncode=0))

    result = server_module.mux_video_audio(video, audio, out_path)

    assert result.suffix == ".webm"


def test_mux_video_audio_falls_back_to_aac_mp4(tmp_path, monkeypatch):
    video = tmp_path / "video.webm"
    video.write_bytes(b"vid")
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"aud")
    out_path = tmp_path / "final.webm"

    monkeypatch.setattr(server_module, "ffmpeg_has_encoder", lambda name: name == "aac")
    monkeypatch.setattr(server_module, "run", lambda cmd: _cp(returncode=0))

    result = server_module.mux_video_audio(video, audio, out_path)

    assert result.suffix == ".mp4"
    assert result != out_path


def test_mux_video_audio_raises_when_no_encoder_available(tmp_path, monkeypatch):
    video = tmp_path / "video.webm"
    video.write_bytes(b"vid")
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"aud")
    out_path = tmp_path / "final.webm"

    monkeypatch.setattr(server_module, "ffmpeg_has_encoder", lambda name: False)

    with pytest.raises(RuntimeError, match="No suitable audio encoder"):
        server_module.mux_video_audio(video, audio, out_path)


def test_mux_video_audio_raises_on_ffmpeg_failure(tmp_path, monkeypatch):
    video = tmp_path / "video.webm"
    video.write_bytes(b"vid")
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"aud")
    out_path = tmp_path / "final.webm"

    monkeypatch.setattr(server_module, "ffmpeg_has_encoder", lambda name: name == "libopus")
    monkeypatch.setattr(server_module, "run", lambda cmd: _cp(returncode=1, stderr="mux boom"))

    with pytest.raises(RuntimeError, match="mux boom"):
        server_module.mux_video_audio(video, audio, out_path)
