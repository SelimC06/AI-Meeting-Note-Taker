// src/capture/electronCapture.ts

// Window.electronAPI is declared globally in src/ui/types/electron.d.ts.

// Chromium/Electron's `mandatory` desktop-capture constraints aren't part of
// the standard MediaTrackConstraints type in lib.dom.d.ts.
type ChromeDesktopCaptureConstraints = {
  mandatory: {
    chromeMediaSource: "desktop";
    chromeMediaSourceId: string;
    maxFrameRate?: number;
  };
};

const isElectron = !!window.electronAPI;

export type ElectronCaptureOptions = {
  sourceId?: string;          // if omitted, we'll pick the primary screen
  withSystemAudio?: boolean;  // default true
  videoFrameRate?: number;    // default 30
};

export type ElectronCaptureResult = {
  screen: MediaStream;        // video track
  systemAudio?: MediaStream;  // system/desktop audio (if requested/available)
  micAudio: MediaStream;      // microphone
  stopAll: () => void;
};

export async function startElectronCapture(opts: ElectronCaptureOptions = {}): Promise<ElectronCaptureResult> {
  if (!isElectron) throw new Error("Not running in Electron.");

  const withSystemAudio = opts.withSystemAudio !== false;
  const sourceId = opts.sourceId || (await window.electronAPI!.pickPrimaryScreenId());
  if (!sourceId) throw new Error("No capture source selected.");
  const fps = opts.videoFrameRate ?? 30;

  // Chromium/Electron desktop capture constraints
  const videoConstraints: ChromeDesktopCaptureConstraints = {
    mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: sourceId,
      maxFrameRate: fps,
    },
  };

  // When withSystemAudio=true, we ask for the desktop's loopback audio
  const systemAudioConstraints: ChromeDesktopCaptureConstraints | boolean = withSystemAudio
    ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId } }
    : false;

  // One getUserMedia for both video and (system) audio; cast at this single
  // call site since MediaStreamConstraints has no slot for Chromium's
  // non-standard `mandatory` shape.
  const screenAndSystem = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: systemAudioConstraints,
  } as unknown as MediaStreamConstraints);

  const screen = new MediaStream(screenAndSystem.getVideoTracks());

  // If system audio granted, split it out
  const sysTracks = screenAndSystem.getAudioTracks();
  const systemAudio = sysTracks.length ? new MediaStream(sysTracks) : undefined;

  // Mic capture (separate; no echo cancellation for better sync to desktop).
  // If this fails after screen+system audio were already granted, stop
  // those already-acquired tracks before rethrowing -- otherwise the OS
  // capture indicator stays lit with no handle left to turn it off.
  let micAudio: MediaStream;
  try {
    micAudio = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (e) {
    screenAndSystem.getTracks().forEach((t) => t.stop());
    throw e;
  }

  const stopAll = () => {
    [screen, systemAudio, micAudio, screenAndSystem].forEach(s =>
      s?.getTracks().forEach(t => t.stop())
    );
  };

  return { screen, systemAudio, micAudio, stopAll };
}
