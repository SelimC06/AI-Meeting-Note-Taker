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

// The recorder's negotiated mimeType, else whatever the chunks themselves
// report, else the historical default -- getRecorder() can legitimately
// report "" when it let the browser choose and the browser hasn't said yet.
function blobType(rec: StreamRecorder | undefined, chunks: Blob[], fallback: string): string {
  return rec?.mimeType || chunks[0]?.type || fallback;
}

export function useThreeTrackSegments() {
  const [status, setStatus] = useState<"idle" | "starting" | "recording" | "paused">("idle");
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  // Exposed alongside micStream so the rail's level meter can react to the
  // other side of a call too, not just the user's own voice.
  const [systemStream, setSystemStream] = useState<MediaStream | null>(null);

  // Set by stop() when it's called while record() is still awaiting
  // getSeparateCapture() (status === "starting", recRef/streamsRef not
  // populated yet). record()'s continuation checks this once the capture
  // resolves so it can release the just-acquired streams instead of
  // starting an orphaned recording no button can reach.
  const abortRequestedRef = useRef(false);

  // Set synchronously on entry to record() and cleared once it settles.
  // `status` below is a closure value from the last render, so two record()
  // calls landing before React re-renders (e.g. both clicks queued behind
  // the first-run consent modal) would both see "idle" -- the second one
  // used to overwrite streamsRef/recRef, orphaning the first set of
  // MediaStreams (OS capture indicators stuck on) and leaving its recorders
  // pushing chunks into every later recording's segsRef.
  const recordInFlightRef = useRef(false);

  const stopInFlightRef = useRef<Promise<Combined> | null>(null);

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
    // recRef/streamsRef/stopInFlightRef catch "already recording" or "still
    // flushing a stop" even when `status` hasn't caught up yet.
    if (
      status !== "idle" ||
      recordInFlightRef.current ||
      recRef.current ||
      streamsRef.current ||
      stopInFlightRef.current
    ) {
      return;
    }
    recordInFlightRef.current = true;
    setError(null);
    abortRequestedRef.current = false;
    setStatus("starting");

    try {
      // Get streams (Electron: screen+system+mic; Browser: screen+mic, no system)
      const streams = await getSeparateCapture();

      if (abortRequestedRef.current) {
        // A stop() arrived while we were still awaiting capture -- release
        // the streams we just acquired and bail out before starting any
        // recorders, so the OS capture indicator turns back off and no
        // orphaned recording is left running.
        abortRequestedRef.current = false;
        streams.stopAll?.();
        setStatus("idle");
        return;
      }

      streamsRef.current = streams;
      setMicStream(streams.mic ?? null);
      setSystemStream(streams.system ?? null);

      const screenRec = streams.screen ? getVideoRecorder(streams.screen) : undefined;
      const systemRec = streams.system ? getAudioRecorder(streams.system) : undefined;
      const micRec    = streams.mic    ? getAudioRecorder(streams.mic, 1000)    : undefined;

      recRef.current = { screen: screenRec, system: systemRec, mic: micRec };

      // One callback per recorder -- ondata() replaces rather than adds, so
      // registering a second one just silently discards the first.
      screenRec?.ondata((b) => segsRef.current.screen.push(b));
      systemRec?.ondata((b) => segsRef.current.systemAudio.push(b));
      micRec?.ondata((b) => segsRef.current.micAudio.push(b));

      // A source can end by itself mid-recording -- the mic disconnects,
      // the user clicks macOS's "Stop sharing", the recorder errors out.
      // The other tracks keep recording, but the user must be told this
      // one stopped (stop() ending tracks itself fires no 'ended', and the
      // recRef check skips anything after our own stop).
      const warn = (message: string) => {
        if (recRef.current === null) return;
        setError({ kind: "generic", message });
      };
      const watch = (stream: MediaStream | null | undefined, rec: StreamRecorder | undefined, message: string) => {
        stream?.getTracks?.().forEach((track) => track.addEventListener("ended", () => warn(message)));
        rec?.mediaRecorder?.addEventListener?.("error", () => warn(message));
      };
      watch(streams.mic, micRec, "Microphone disconnected — the rest of the recording continues without it.");
      watch(streams.system, systemRec, "System audio stopped — the rest of the recording continues without it.");
      watch(
        streams.screen,
        screenRec,
        "Screen capture stopped — audio keeps recording. Stop the recording when you're done."
      );

      screenRec?.start();
      systemRec?.start();
      micRec?.start();
      setStatus("recording");
    } catch (e) {
      console.error("record() failed", e);
      // getSeparateCapture() may have already succeeded (streamsRef.current
      // set) before a later step -- recorder construction or .start() --
      // threw. Release those already-granted streams so the OS capture
      // indicator doesn't stay lit and a retry doesn't stack a second set
      // of live streams on top.
      abortRequestedRef.current = false;
      streamsRef.current?.stopAll?.();
      streamsRef.current = null;
      recRef.current = null;
      setError(classifyRecordError(e));
      setStatus("idle");
      setMicStream(null);
      setSystemStream(null);
    } finally {
      recordInFlightRef.current = false;
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
  const doStop = async (): Promise<Combined> => {
    const s = recRef.current;
    // Captured now, before the finally block below replaces segsRef.current
    // with a fresh empty object -- this still points at the live arrays
    // ondata() pushes into, including the final flush each recorder.stop()
    // triggers below, so it ends up complete by the time it's read after
    // the await settles.
    const segs = segsRef.current;

    try {
      // Each recorder's stop() flushes its last timeslice via one final
      // ondataavailable (captured into segs above) before resolving -- the
      // recorder itself no longer returns a Blob (see recorder.ts), so
      // segs is the only source of truth for what was captured.
      await Promise.all([
        s?.screen?.stop() ?? Promise.resolve(),
        s?.system?.stop() ?? Promise.resolve(),
        s?.mic?.stop()    ?? Promise.resolve(),
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
      setSystemStream(null);
    }

    // Typed from what each recorder actually produced (see blobType) --
    // RailApp derives the upload's file extension from these.
    const combined: Combined = {
      screen: segs.screen.length ? new Blob(segs.screen, { type: blobType(s?.screen, segs.screen, "video/webm") }) : undefined,
      systemAudio: segs.systemAudio.length ? new Blob(segs.systemAudio, { type: blobType(s?.system, segs.systemAudio, "audio/webm") }) : undefined,
      micAudio: segs.micAudio.length ? new Blob(segs.micAudio, { type: blobType(s?.mic, segs.micAudio, "audio/webm") }) : undefined,
    };

    return combined;
  };

  const stop = (): Promise<Combined> => {
    if (stopInFlightRef.current) return stopInFlightRef.current;
    if (status === "idle") return Promise.resolve({});
    if (status === "starting") {
      // getSeparateCapture() is still in flight -- recRef/streamsRef aren't
      // populated yet, so there's nothing to stop here. Flag the abort for
      // record()'s continuation to pick up once capture resolves.
      abortRequestedRef.current = true;
      return Promise.resolve({});
    }
    const p = doStop().finally(() => { stopInFlightRef.current = null; });
    stopInFlightRef.current = p;
    return p;
  };

  return { status, record, pause, resume, stop, error, micStream, systemStream };
}
