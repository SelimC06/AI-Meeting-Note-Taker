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
  const fps = opts.videoFrameRate ?? 30;
  const platform = window.electronAPI!.platform;

  let screenAndSystem: MediaStream;

  if (platform === "darwin") {
    // macOS 13+ (Electron 32+): getDisplayMedia is backed by
    // ScreenCaptureKit and captures system audio natively -- no virtual
    // loopback driver needed. The legacy chromeMediaSource:"desktop"
    // mandatory-constraints path below never captures audio on macOS.
    screenAndSystem = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: fps },
      audio: withSystemAudio,
    });
  } else {
    const sourceId = opts.sourceId || (await window.electronAPI!.pickPrimaryScreenId());
    if (!sourceId) throw new Error("No capture source selected.");

    const videoConstraints: ChromeDesktopCaptureConstraints = {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        maxFrameRate: fps,
      },
    };
    const systemAudioConstraints: ChromeDesktopCaptureConstraints | boolean = withSystemAudio
      ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId } }
      : false;

    screenAndSystem = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: systemAudioConstraints,
    } as unknown as MediaStreamConstraints);
  }

  const screen = new MediaStream(screenAndSystem.getVideoTracks());

  const sysTracks = screenAndSystem.getAudioTracks();
  const systemAudio = sysTracks.length ? new MediaStream(sysTracks) : undefined;

  let micAudio: MediaStream;
  try {
    micAudio = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Echo cancellation subtracts what the speakers are playing from
        // the mic signal. Without it, anyone not on headphones had the
        // other side's audio bleed into the mic track -- so Track A (and
        // the live captions) attributed system audio to "You".
        echoCancellation: true,
        noiseSuppression: true,
        // AGC stays off: it pumps the gain between words, which hurts both
        // the level meter's readability and Whisper's input consistency.
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
