import sounddevice as sd
import soundfile as sf
from faster_whisper import WhisperModel
from pathlib import Path
import numpy as np
from threading import Event

_stop = Event()

def check(out_dir="transcript_"):
    seconds = 2
    sample_rate = 16000
    channels = 1
    out_wav = out_dir + ".wav"
    out_txt = out_dir + ".txt"
    model_name = "base.en"

    block_ms = 30
    frames_per_block = int(sample_rate * block_ms / 1000)

    chunks = []
    _stop.clear()
    # Record
    #while not _stop.is_set():
    #    audio = sd.rec(int(seconds*sample_rate), samplerate=sample_rate,
    #                channels=channels, dtype="float32")
    #    sd.wait()
    #    if _stop.is_set(): break
    #    chunks.append(audio.copy())
    with sd.InputStream(samplerate=sample_rate,
                    channels=channels,
                    dtype="float32",
                    blocksize=frames_per_block,
                    latency='low') as stream:
        while not _stop.is_set():
            data, overflowed = stream.read(frames_per_block)
            if overflowed:
                print("Input overflow")   # optional heads-up
            chunks.append(data.copy())

    if not chunks:
        return None
    
    full = np.concatenate(chunks, axis = 0)

    sd.wait()
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