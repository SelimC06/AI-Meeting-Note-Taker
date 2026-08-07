// src/hooks/useThreeTrackSegments.ts
import { useCallback, useRef, useState } from "react";
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

export type ClassifiedError = {
  kind: "permission-denied" | "generic";
  message: string;
};

function classifyRecordError(err: unknown): ClassifiedError {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return {
      kind: "permission-denied",
      message: "Screen or microphone access denied — check your OS privacy settings.",
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "generic", message: `Recording failed: ${message}` };
}

export function useThreeTrackSegments() {
  const micOnDataRef = useRef<((b: Blob) => void) | null>(null);

  const [status, setStatus] = useState<"idle" | "recording" | "paused">("idle");
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);


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
    setError(null);
    setStatus("recording");

    try {
      // Get streams (Electron: screen+system+mic; Browser: screen+mic, no system)
      const streams = await getSeparateCapture();
      streamsRef.current = streams;
      setMicStream(streams.mic ?? null);

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
      // getSeparateCapture() may have already succeeded (streamsRef.current
      // set) before a later step -- recorder construction or .start() --
      // threw. Release those already-granted streams so the OS capture
      // indicator doesn't stay lit and a retry doesn't stack a second set
      // of live streams on top.
      streamsRef.current?.stopAll?.();
      streamsRef.current = null;
      recRef.current = null;
      setError(classifyRecordError(e));
      setStatus("idle");
      setMicStream(null);
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
    const segs = segsRef.current;

    let screenBlob: Blob | undefined;
    let systemBlob: Blob | undefined;
    let micBlob: Blob | undefined;

    try {
      // stop returns a final Blob (flushes last timeslice)
      [screenBlob, systemBlob, micBlob] = await Promise.all([
        s?.screen?.stop() ?? Promise.resolve<Blob | undefined>(undefined),
        s?.system?.stop() ?? Promise.resolve<Blob | undefined>(undefined),
        s?.mic?.stop()    ?? Promise.resolve<Blob | undefined>(undefined),
      ]);
    } catch (e) {
      // A rejected recorder.stop() (e.g. an unexpected InvalidStateError a
      // different task's fix didn't anticipate) must not prevent the
      // cleanup below -- otherwise streams are never released and status
      // never leaves "recording", leaving the UI stuck with no way to stop.
      console.error("stop() failed while stopping one or more recorders", e);
    } finally {
      streamsRef.current?.stopAll?.();
      recRef.current = null;
      streamsRef.current = null;
      segsRef.current = { screen: [], systemAudio: [], micAudio: [] };
      setStatus("idle");
      setMicStream(null);
    }

    const combined: Combined = {
      screen:
        screenBlob ??
        (segs.screen.length
          ? new Blob(segs.screen, { type: "video/webm" })
          : undefined),
      systemAudio:
        systemBlob ??
        (segs.systemAudio.length
          ? new Blob(segs.systemAudio, { type: "audio/webm" })
          : undefined),
      micAudio:
        micBlob ??
        (segs.micAudio.length
          ? new Blob(segs.micAudio, { type: "audio/webm" })
          : undefined),
    };

    return combined;
  };

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return { status, record, pause, resume, stop, error, clearError, micStream };
}
