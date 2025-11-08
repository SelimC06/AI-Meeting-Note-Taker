// src/capture/electronCapture.ts
const isElectron = !!(window as any).electronAPI;

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
  const sourceId = opts.sourceId || (await (window as any).electronAPI!.pickPrimaryScreenId());
  if (!sourceId) throw new Error("No capture source selected.");
  const fps = opts.videoFrameRate ?? 30;

  // Chromium/Electron desktop capture constraints
  const videoConstraints: MediaTrackConstraints = {
    mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: sourceId,
      maxFrameRate: fps,
    },
  }as any;

  // When withSystemAudio=true, we ask for the desktop's loopback audio
  const systemAudioConstraints: MediaTrackConstraints | boolean = withSystemAudio
    ? ({ mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId } } as any)
    : false;

  // One getUserMedia for both video and (system) audio
  const screenAndSystem = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: systemAudioConstraints,
  } as any);

  const screen = new MediaStream(screenAndSystem.getVideoTracks());

  // If system audio granted, split it out
  const sysTracks = screenAndSystem.getAudioTracks();
  const systemAudio = sysTracks.length ? new MediaStream(sysTracks) : undefined;

  // Mic capture (separate; no echo cancellation for better sync to desktop)
  const micAudio = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  const stopAll = () => {
    [screen, systemAudio, micAudio, screenAndSystem].forEach(s =>
      s?.getTracks().forEach(t => t.stop())
    );
  };

  return { screen, systemAudio, micAudio, stopAll };
}
