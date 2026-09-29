import { useEffect, useState } from "react";

export const HISTORY_LENGTH = 20;
const SAMPLE_INTERVAL_MS = 60;

// The meter reads in decibels rather than linear RMS: the mic is captured
// with autoGainControl off (see electronCapture.ts), so speech at laptop-mic
// distance only reaches roughly -45..-30 dBFS (RMS ~0.005-0.03), which the
// old linear `rms * 4` rendered at a sliver of the meter. Anything below
// FLOOR_DB is treated as silence (just above a quiet room's noise floor), and
// CEILING_DB and up pegs the meter -- set so ordinary conversational speech
// lands around the middle of it and only loud speech reaches the top.
const FLOOR_DB = -58;
const CEILING_DB = -26;
// Per-tick fall-off applied to the previous level, so the bars drop
// smoothly between syllables instead of flickering to zero (fast attack,
// slower release -- the usual VU-meter feel).
const RELEASE = 0.8;

export function rmsToLevel(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)));
}

function silentHistory(): number[] {
  return Array(HISTORY_LENGTH).fill(0);
}

// Meters the mic and (when captured) system audio together, following
// whichever is louder at each tick -- so the rail moves for the other side
// of a call too, not just for the user's own voice.
export function useMicLevel(
  micStream: MediaStream | null,
  systemStream: MediaStream | null = null
): number[] {
  const [levels, setLevels] = useState<number[]>(silentHistory);

  useEffect(() => {
    const streams = [micStream, systemStream].filter((s): s is MediaStream => s !== null);
    if (streams.length === 0) {
      setLevels(silentHistory());
      return;
    }

    let audioCtx: AudioContext;
    try {
      const AudioContextCtor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new AudioContextCtor();
      audioCtx.resume().catch(() => {});
    } catch {
      return;
    }

    // Wired per stream, so one that can't be metered (e.g. a system stream
    // with no audio tracks) doesn't take the other down with it.
    const taps: {
      source: MediaStreamAudioSourceNode;
      analyser: AnalyserNode;
      floatBuffer: Float32Array<ArrayBuffer> | null;
      byteBuffer: Uint8Array<ArrayBuffer>;
    }[] = [];
    for (const stream of streams) {
      try {
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        taps.push({
          source,
          analyser,
          // Float samples where supported: the 8-bit byte data quantizes
          // anything quieter than ~-42 dBFS to flat silence, which is
          // exactly the soft-speech range this meter needs to show.
          floatBuffer:
            typeof analyser.getFloatTimeDomainData === "function"
              ? new Float32Array(analyser.fftSize)
              : null,
          byteBuffer: new Uint8Array(analyser.frequencyBinCount),
        });
      } catch {
        // skip this stream
      }
    }
    if (taps.length === 0) {
      // Nothing could be wired -- close the context, or each failed attempt
      // leaks a live AudioContext (browsers cap how many can exist at once).
      audioCtx.close().catch(() => {});
      return;
    }

    const intervalId = setInterval(() => {
      let loudest = 0;
      for (const { analyser, floatBuffer, byteBuffer } of taps) {
        let sumSquares = 0;
        let count: number;
        if (floatBuffer) {
          analyser.getFloatTimeDomainData(floatBuffer);
          for (let i = 0; i < floatBuffer.length; i++) sumSquares += floatBuffer[i] * floatBuffer[i];
          count = floatBuffer.length;
        } else {
          analyser.getByteTimeDomainData(byteBuffer);
          for (let i = 0; i < byteBuffer.length; i++) {
            const normalized = (byteBuffer[i] - 128) / 128;
            sumSquares += normalized * normalized;
          }
          count = byteBuffer.length;
        }
        loudest = Math.max(loudest, rmsToLevel(Math.sqrt(sumSquares / count)));
      }
      setLevels((prev) => [...prev.slice(1), Math.max(loudest, prev[prev.length - 1] * RELEASE)]);
    }, SAMPLE_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      for (const { source, analyser } of taps) {
        source.disconnect();
        analyser.disconnect();
      }
      audioCtx.close().catch(() => {});
    };
  }, [micStream, systemStream]);

  return levels;
}
