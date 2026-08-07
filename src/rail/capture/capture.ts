// src/capture/capture.ts
import { startElectronCapture } from "./electronCapture";

const isElectron = !!window.electronAPI;

export type CaptureStreams = {
  screen?: MediaStream;
  system?: MediaStream; // NOTE: name it `system` here
  mic?: MediaStream;
  stopAll: () => void;
};

export async function getSeparateCapture(): Promise<CaptureStreams> {
  if (isElectron) {
    const { screen, systemAudio, micAudio, stopAll } = await startElectronCapture({
      withSystemAudio: true,
      videoFrameRate: 30,
    });
    return { screen, system: systemAudio, mic: micAudio, stopAll };
  }

  // Browser fallback (no system audio)
  const screen = await (navigator.mediaDevices as any).getDisplayMedia({
    video: { frameRate: 30 },
    audio: false,
  });
  // If mic capture fails after screen was already granted, stop the
  // already-acquired screen tracks before rethrowing -- otherwise the OS
  // capture indicator stays lit with no handle left to turn it off.
  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    screen.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    throw e;
  }

  const stopAll = () => {
    ([screen, mic] as Array<MediaStream | undefined>).forEach((s) =>
      s?.getTracks().forEach((t: MediaStreamTrack) => t.stop())
    );
  };

  return { screen, mic, stopAll };
}
