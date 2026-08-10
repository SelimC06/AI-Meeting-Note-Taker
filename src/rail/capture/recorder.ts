// src/capture/recorder.ts

export type StreamRecorder = {
  mediaRecorder: MediaRecorder;
  start: () => void;
  pause: () => void;
  resume: () => void;
  // Resolves once the recorder has fully stopped -- including the final
  // ondataavailable flush, which fires before this resolves. Doesn't return
  // a Blob: the caller (useThreeTrackSegments' segsRef) already retains
  // every chunk via ondata() below, so this recorder no longer keeps its
  // own second copy of the whole recording.
  stop: () => Promise<void>;
  ondata: (cb: (chunk: Blob) => void) => void;
  mimeType: string;
};

/** Pick the first supported MIME from a list */
function pickSupported(mimes: string[]): string {
  for (const m of mimes) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  // Last resort: let the browser choose
  return "";
}

/** Create a recorder with preferred mimes and optional timeslice (ms). */
export function getRecorder(
  stream: MediaStream,
  preferredMimes: string[] | string,
  timesliceMs = 1000
): StreamRecorder {
  const mimeCandidates = Array.isArray(preferredMimes) ? preferredMimes : [preferredMimes];
  const mimeType = pickSupported(mimeCandidates);

  const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  let ondataCb: ((b: Blob) => void) | null = null;
  mr.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size) {
      ondataCb?.(e.data);
    }
  };

  let stopPromise: Promise<void> | null = null;

  return {
    mediaRecorder: mr,
    mimeType: mimeType || mr.mimeType,
    start: () => mr.start(timesliceMs),
    pause: () => mr.pause(),
    resume: () => mr.resume(),
    stop: () => {
      // Same promise for every caller: a second stop() while the first is
      // still flushing must wait for that same final ondataavailable, not
      // resolve early (state is already "inactive" the moment stop() is
      // called) and not clobber the first caller's onstop.
      if (stopPromise) return stopPromise;
      // MediaRecorder.stop() throws InvalidStateError if the recorder is
      // already inactive (e.g. called after an earlier internal error
      // already stopped it). Treat that as "already stopped" and resolve
      // immediately, instead of letting the throw reject this promise and
      // abort whatever caller is awaiting cleanup (see
      // useThreeTrackSegments.ts's stop()).
      if (mr.state === "inactive") {
        stopPromise = Promise.resolve();
        return stopPromise;
      }
      // stop() flushes one final ondataavailable (with whatever's been
      // buffered since the last timeslice) before firing onstop, so the
      // caller's ondata callback has already received every chunk by the
      // time this resolves.
      stopPromise = new Promise<void>((resolve) => {
        mr.onstop = () => resolve();
        mr.stop();
      });
      return stopPromise;
    },
    ondata: (cb) => {
      ondataCb = cb;
    },
  };
}

/** Convenience presets */
export function getVideoRecorder(stream: MediaStream, timesliceMs = 1000): StreamRecorder {
  return getRecorder(
    stream,
    [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp8",
      "video/webm",
    ],
    timesliceMs
  );
}

export function getAudioRecorder(stream: MediaStream, timesliceMs = 1000): StreamRecorder {
  return getRecorder(
    stream,
    [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus", // some Chromium builds
    ],
    timesliceMs
  );
}
