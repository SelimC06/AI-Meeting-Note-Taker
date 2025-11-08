// src/capture/recorder.ts

export type StreamRecorder = {
  mediaRecorder: MediaRecorder;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<Blob>;
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

  const chunks: Blob[] = [];
  const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  let ondataCb: ((b: Blob) => void) | null = null;
  mr.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size) {
      chunks.push(e.data);
      ondataCb?.(e.data);
    }
  };

  return {
    mediaRecorder: mr,
    mimeType: mimeType || mr.mimeType,
    start: () => mr.start(timesliceMs),
    pause: () => mr.pause(),
    resume: () => mr.resume(),
    stop: () =>
      new Promise<Blob>((resolve) => {
        mr.onstop = () => resolve(new Blob(chunks, { type: mimeType || mr.mimeType }));
        mr.stop();
      }),
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

/** If you ever want ONE recorder with video + (system/mic) audio */
export function composeAVStream(
  screen: MediaStream,
  systemAudio?: MediaStream,
  micAudio?: MediaStream
): MediaStream {
  const tracks: MediaStreamTrack[] = [];
  tracks.push(...screen.getVideoTracks());
  if (systemAudio) tracks.push(...systemAudio.getAudioTracks());
  if (micAudio) tracks.push(...micAudio.getAudioTracks());
  return new MediaStream(tracks);
}
