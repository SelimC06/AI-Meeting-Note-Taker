import { useEffect, useState } from "react";

export const HISTORY_LENGTH = 20;
const SAMPLE_INTERVAL_MS = 60;

function silentHistory(): number[] {
  return Array(HISTORY_LENGTH).fill(0);
}

export function useMicLevel(stream: MediaStream | null): number[] {
  const [levels, setLevels] = useState<number[]>(silentHistory);

  useEffect(() => {
    if (!stream) {
      setLevels(silentHistory());
      return;
    }

    let audioCtx: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    try {
      const AudioContextCtor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new AudioContextCtor();
      audioCtx.resume().catch(() => {});
      source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
    } catch {
      // Partial construction: the context may exist even though wiring it to
      // the stream failed -- close it, or each failed attempt leaks a live
      // AudioContext (browsers cap how many can exist at once).
      audioCtx?.close().catch(() => {});
      return;
    }

    const buffer = new Uint8Array(analyser.frequencyBinCount);

    const intervalId = setInterval(() => {
      analyser.getByteTimeDomainData(buffer);
      let sumSquares = 0;
      for (let i = 0; i < buffer.length; i++) {
        const normalized = (buffer[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / buffer.length);
      const level = Math.min(1, rms * 4);
      setLevels((prev) => [...prev.slice(1), level]);
    }, SAMPLE_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      source.disconnect();
      analyser.disconnect();
      audioCtx?.close();
    };
  }, [stream]);

  return levels;
}
