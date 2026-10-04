import { useEffect, useRef, useState } from "react";
import { liveTranscribe } from "../../ui/api";
import { extensionForMimeType } from "../capture/recorder";

export type LiveCaption = {
  id: number;
  speaker: "You" | "Others";
  text: string;
};

// How much audio each caption window holds. Short enough to feel live,
// long enough for Whisper to have real context (and for the per-window
// language auto-detect to be reliable).
export const CAPTION_WINDOW_MS = 7000;

// Rolling buffer cap -- the panel only shows the tail, this just bounds
// memory over a multi-hour meeting.
const MAX_CAPTIONS = 60;

const CAPTION_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

function pickCaptionMime(): string | undefined {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return undefined;
  return CAPTION_MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
}

/**
 * Live captions (Tier 2.2): while recording, run one dedicated extra
 * MediaRecorder per audio stream, rotated every CAPTION_WINDOW_MS so each
 * stop() yields a STANDALONE decodable blob (the main recorders' timeslice
 * chunks are continuations and can't be transcribed individually -- which
 * is also why these can't just reuse them). Each finished window is sent
 * to POST /live/transcribe in the background while the next window is
 * already recording, so transcription latency never gaps the audio.
 *
 * Everything is best-effort: a window the backend was too busy for (429),
 * a failed POST, an empty/silent window -- all silently dropped. The
 * definitive transcript comes from the normal pipeline after stop.
 */
export function useLiveCaptions(
  enabled: boolean,
  status: "idle" | "starting" | "recording" | "paused",
  micStream: MediaStream | null,
  systemStream: MediaStream | null
) {
  const [captions, setCaptions] = useState<LiveCaption[]>([]);
  const nextIdRef = useRef(1);

  // A new recording starts with a clean pane; pause/resume keeps it.
  useEffect(() => {
    if (status === "starting") setCaptions([]);
  }, [status]);

  const running = enabled && status === "recording";

  useEffect(() => {
    if (!running) return;
    if (typeof MediaRecorder === "undefined") return;
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const push = (speaker: LiveCaption["speaker"], text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setCaptions((current) => {
        const next = [...current, { id: nextIdRef.current++, speaker, text: trimmed }];
        return next.length > MAX_CAPTIONS ? next.slice(next.length - MAX_CAPTIONS) : next;
      });
    };

    const runTrack = (stream: MediaStream | null, speaker: LiveCaption["speaker"]) => {
      const tracks = stream?.getAudioTracks?.() ?? [];
      if (tracks.length === 0) return;
      let recorder: MediaRecorder | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cycle = () => {
        if (cancelled) return;
        const chunks: Blob[] = [];
        try {
          const mime = pickCaptionMime();
          recorder = new MediaRecorder(
            new MediaStream(tracks),
            mime ? { mimeType: mime } : undefined
          );
        } catch {
          return; // stream gone / recorder unavailable: captions just stop
        }
        const rec = recorder;
        rec.ondataavailable = (e: BlobEvent) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        rec.onstop = () => {
          // A cleanup-triggered stop (pause, recording ended, toggle off)
          // drops its partial window entirely -- the definitive transcript
          // comes from the real pipeline, so there's no reason to keep the
          // backend busy on a caption nobody will see.
          if (cancelled) return;
          // Restart the next window FIRST, transcribe this one in the
          // background -- serializing them would gap the audio by however
          // long each transcription takes.
          cycle();
          const type = rec.mimeType || chunks[0]?.type || "audio/webm";
          const blob = new Blob(chunks, { type });
          if (blob.size === 0) return;
          void liveTranscribe(blob, `live.${extensionForMimeType(type)}`).then((text) => {
            if (!cancelled && text) push(speaker, text);
          });
        };
        try {
          rec.start();
        } catch {
          return;
        }
        timer = setTimeout(() => {
          try {
            if (rec.state !== "inactive") rec.stop();
          } catch {
            /* already stopped */
          }
        }, CAPTION_WINDOW_MS);
      };

      cycle();
      cleanups.push(() => {
        if (timer !== null) clearTimeout(timer);
        try {
          if (recorder && recorder.state !== "inactive") recorder.stop();
        } catch {
          /* already stopped */
        }
      });
    };

    runTrack(micStream, "You");
    runTrack(systemStream, "Others");

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, [running, micStream, systemStream]);

  return captions;
}
