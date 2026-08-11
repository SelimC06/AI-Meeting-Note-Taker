import subprocess
from io import BytesIO
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


# ---- save_upload -----------------------------------------------------------

class _FakeUploadFile:
    def __init__(self, data: bytes):
        self.file = BytesIO(data)


def test_save_upload_probes_the_rejected_file_only_once(tmp_path, monkeypatch):
    """Regression test for brief 06: the rejection path used to call
    ffprobe_ok(out) twice (once in the condition, once in the log message),
    running the ffprobe subprocess twice for the same file. It must run once.
    """
    probe_calls = []

    def fake_run(cmd):
        probe_calls.append(cmd)
        return _cp(returncode=1, stderr="invalid data")

    monkeypatch.setattr(server_module, "run", fake_run)

    result = server_module.save_upload(tmp_path, _FakeUploadFile(b"not a real video"), "screen.webm")

    assert result is None
    assert len(probe_calls) == 1


# ---- ffmpeg_has_encoder ----------------------------------------------------------

def test_ffmpeg_has_encoder_true_when_present(monkeypatch):
    monkeypatch.setattr(server_module, "run", lambda cmd: _cp(returncode=0, stdout=" V..... libopus  Opus\n"))
    assert server_module.ffmpeg_has_encoder("libopus") is True


def test_ffmpeg_has_encoder_false_when_absent(monkeypatch):
    monkeypatch.setattr(server_module, "run", lambda cmd: _cp(returncode=0, stdout=" V..... libx264  H264\n"))
    assert server_module.ffmpeg_has_encoder("libopus") is False


def test_ffmpeg_has_encoder_tolerates_tab_separated_output(monkeypatch):
    monkeypatch.setattr(
        server_module,
        "run",
        lambda cmd: _cp(returncode=0, stdout=" A.....\tlibopus\tOpus (Interactive Audio Codec)\n"),
    )
    assert server_module.ffmpeg_has_encoder("libopus") is True


def test_ffmpeg_has_encoder_does_not_match_substring_names(monkeypatch):
    monkeypatch.setattr(
        server_module,
        "run",
        lambda cmd: _cp(returncode=0, stdout=" A..... libopus_experimental  Opus (exp)\n"),
    )
    assert server_module.ffmpeg_has_encoder("libopus") is False


def test_ffmpeg_has_encoder_false_when_ffmpeg_command_fails(monkeypatch):
    monkeypatch.setattr(server_module, "run", lambda cmd: _cp(returncode=1, stdout=""))
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

    def fake_run(cmd):
        calls.append(cmd)
        # mux_video_audio now writes to a "<out>.part" temp name and promotes
        # it via os.replace() on success -- the real ffmpeg process creates
        # that file; the mock has to as well.
        Path(cmd[-1]).write_bytes(b"muxed")
        return _cp(returncode=0)

    monkeypatch.setattr(server_module, "run", fake_run)

    result = server_module.mux_video_audio(video, audio, out_path)

    assert result == out_path
    assert result.suffix == ".webm"
    assert "libopus" in calls[0]
    assert not out_path.with_name("." + out_path.name + ".part").exists()


def test_mux_video_audio_falls_back_to_libvorbis(tmp_path, monkeypatch):
    video = tmp_path / "video.webm"
    video.write_bytes(b"vid")
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"aud")
    out_path = tmp_path / "final.webm"

    monkeypatch.setattr(server_module, "ffmpeg_has_encoder", lambda name: name == "libvorbis")

    def fake_run(cmd):
        Path(cmd[-1]).write_bytes(b"muxed")
        return _cp(returncode=0)

    monkeypatch.setattr(server_module, "run", fake_run)

    result = server_module.mux_video_audio(video, audio, out_path)

    assert result.suffix == ".webm"


def test_mux_video_audio_falls_back_to_aac_mp4(tmp_path, monkeypatch):
    video = tmp_path / "video.webm"
    video.write_bytes(b"vid")
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"aud")
    out_path = tmp_path / "final.webm"

    monkeypatch.setattr(server_module, "ffmpeg_has_encoder", lambda name: name == "aac")

    def fake_run(cmd):
        Path(cmd[-1]).write_bytes(b"muxed")
        return _cp(returncode=0)

    monkeypatch.setattr(server_module, "run", fake_run)

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

    def fake_run(cmd):
        # Simulate ffmpeg having written a partial file before failing.
        Path(cmd[-1]).write_bytes(b"partial")
        return _cp(returncode=1, stderr="mux boom")

    monkeypatch.setattr(server_module, "run", fake_run)

    with pytest.raises(RuntimeError, match="mux boom"):
        server_module.mux_video_audio(video, audio, out_path)

    # A failed mux must never leave a partial final.* behind for export's
    # final.* glob to ship as "the recording".
    assert not out_path.exists()
    assert not out_path.with_name("." + out_path.name + ".part").exists()
