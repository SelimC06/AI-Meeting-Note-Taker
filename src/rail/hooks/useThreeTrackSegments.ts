// src/hooks/useThreeTrackSegments.ts
import { useRef, useState } from "react";
import { getSeparateCapture, type CaptureStreams } from "../capture/capture";
import {
  getVideoRecorder,
  getAudioRecorder,
  type StreamRecorder,
} from "../capture/recorder";

export type Segments = {
  screen: Blob[];
  systemAudio: Blob[];
  micAudio: Blob[];
};

export type Combined = {
  screen?: Blob;
  systemAudio?: Blob;
  micAudio?: Blob;
};

export function useThreeTrackSegments() {
  const micOnDataRef = useRef<((b: Blob) => void) | null>(null);

  const [status, setStatus] = useState<"idle" | "recording" | "paused">("idle");
  

  const streamsRef = useRef<CaptureStreams | null>(null);
  const recRef = useRef<{
    screen?: StreamRecorder;
    system?: StreamRecorder;
    mic?: StreamRecorder;
  } | null>(null);

  const segsRef = useRef<Segments>({
    screen: [],
    systemAudio: [],
    micAudio: [],
  });

  // ----- RECORD -----
  const record = async () => {
    if (status !== "idle") return;
    setStatus("recording");   

    try {
      // Get streams (Electron: screen+system+mic; Browser: screen+mic, no system)
      const streams = await getSeparateCapture();
      streamsRef.current = streams;

      const screenRec = streams.screen ? getVideoRecorder(streams.screen) : undefined;
      const systemRec = streams.system ? getAudioRecorder(streams.system) : undefined;
      const micRec    = streams.mic    ? getAudioRecorder(streams.mic, 1000)    : undefined;

      recRef.current = { screen: screenRec, system: systemRec, mic: micRec };

      screenRec?.ondata((b) => segsRef.current.screen.push(b));
      systemRec?.ondata((b) => segsRef.current.systemAudio.push(b));
      micRec?.ondata((b) => segsRef.current.micAudio.push(b));

      const micOnData = (chunk: Blob) => {
        segsRef.current.micAudio.push(chunk);
      };
      micOnDataRef.current = micOnData;
      micRec?.ondata(micOnData);
  
      screenRec?.start();
      systemRec?.start();
      micRec?.start();
    } catch (e) {
      console.error("record() failed", e);
      setStatus("idle");
    }

  };

  // ----- PAUSE/RESUME -----
  const pause = async () => {
    if (status !== "recording") return;
    recRef.current?.screen?.pause();
    recRef.current?.system?.pause();
    recRef.current?.mic?.pause();
    setStatus("paused");
  };

  const resume = async () => {
    if (status !== "paused") return;
    recRef.current?.screen?.resume();
    recRef.current?.system?.resume();
    recRef.current?.mic?.resume();
    setStatus("recording");
  };

  // ----- STOP -----
  const stop = async (): Promise<Combined> => {
    if (status === "idle") return {};

    const s = recRef.current;
    // stop returns a final Blob (flushes last timeslice)
    const [screenBlob, systemBlob, micBlob] = await Promise.all([
      s?.screen?.stop() ?? Promise.resolve<Blob | undefined>(undefined),
      s?.system?.stop() ?? Promise.resolve<Blob | undefined>(undefined),
      s?.mic?.stop()    ?? Promise.resolve<Blob | undefined>(undefined),
    ]);

    streamsRef.current?.stopAll?.();

    const combined: Combined = {
      screen:
        screenBlob ??
        (segsRef.current.screen.length
          ? new Blob(segsRef.current.screen, { type: "video/webm" })
          : undefined),
      systemAudio:
        systemBlob ??
        (segsRef.current.systemAudio.length
          ? new Blob(segsRef.current.systemAudio, { type: "audio/webm" })
          : undefined),
      micAudio:
        micBlob ??
        (segsRef.current.micAudio.length
          ? new Blob(segsRef.current.micAudio, { type: "audio/webm" })
          : undefined),
    };

    // reset state
    recRef.current = null;
    streamsRef.current = null;
    segsRef.current = { screen: [], systemAudio: [], micAudio: [] };
    setStatus("idle");

    return combined;
  };

  return { status, record, pause, resume, stop };
}
