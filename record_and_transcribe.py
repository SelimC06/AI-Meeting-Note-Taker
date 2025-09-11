import soundcard as sc
import soundfile as sf
from faster_whisper import WhisperModel
from pathlib import Path
import numpy as np
from threading import Event

_stop = Event()

def _mono(x):
    if x.ndim == 1: 
        x = x[:, None]
    return x.mean(axis=1, keepdims=True).astype(np.float32, copy=False)

def check(out_dir="transcript_"):
    out_wav = out_dir + ".wav"
    out_txt = out_dir + ".txt"
    model_name = "base.en"

    sample_rate = 48000
    block_ms = 100
    frames_per_block = int(sample_rate * block_ms / 1000)

    chunks = []
    _stop.clear()

    mic = sc.default_microphone()
    spk = sc.default_speaker()
    loopback = sc.get_microphone(spk.name, include_loopback=True)
    
    with mic.recorder(samplerate=sample_rate, blocksize=frames_per_block) as mic_rec, \
        loopback.recorder(samplerate=sample_rate, blocksize=frames_per_block) as sys_rec:

        while not _stop.is_set():
            mic_block = mic_rec.record(frames_per_block) if mic_rec else None
            sys_block = sys_rec.record(frames_per_block) if sys_rec else None

            if (mic_block is None or mic_block.size == 0) and (sys_block is None or sys_block.size == 0):
                continue

            mix = None
            if mic_block is not None:
                mix = _mono(mic_block)
            if sys_block is not None:
                sys_mono = _mono(sys_block)
                mix = sys_mono if mix is None else (mix + sys_mono)

            chunks.append(np.clip(mix, -1.0, 1.0).copy())

    if not chunks:
        return None
    
    full = np.concatenate(chunks, axis = 0)
    sf.write(out_wav, full, sample_rate)
    print(f"Saved: {out_wav}")

    # Transcribe (local)
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(out_wav)

    #print("\n--- Transcript ---")
    full_text = []
    for seg in segments:
        #print(f"[{seg.start:.1f}-{seg.end:.1f}] {seg.text}")
        full_text.append(seg.text)

    transcript_text = " ".join(full_text).strip()
    Path(out_txt).write_text(transcript_text, encoding="utf-8")
    print(f"Transcript saved to {out_txt}")
    return str(out_txt)

def close():
    _stop.set()