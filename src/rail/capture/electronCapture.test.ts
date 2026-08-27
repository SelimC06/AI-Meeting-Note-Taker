import { afterEach, beforeEach, expect, it, vi } from "vitest";
// electronCapture.ts computes `isElectron` from `window.electronAPI` at
// module-evaluation time. A static top-level import is hoisted and runs
// before beforeEach can set window.electronAPI, so isElectron would be
// permanently false. Reset the module registry and import dynamically
// inside each test, after window.electronAPI is in place.

// jsdom does not implement MediaStream; this stub is only as capable as the
// production code in electronCapture.ts actually needs (getTracks() plus
// the video/audio track accessors it calls).
if (typeof MediaStream === "undefined") {
  (globalThis as unknown as { MediaStream: typeof MediaStream }).MediaStream = class {
    private tracks: unknown[];
    constructor(tracks: unknown[] = []) {
      this.tracks = tracks;
    }
    getTracks() {
      return this.tracks;
    }
    getVideoTracks() {
      return this.tracks;
    }
    getAudioTracks() {
      return this.tracks;
    }
  } as unknown as typeof MediaStream;
}

function makeTrack() {
  return { stop: vi.fn() };
}

beforeEach(() => {
  vi.resetModules();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pickPrimaryScreenId: vi.fn().mockResolvedValue("screen:1"),
  };
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

it("uses getDisplayMedia (not the legacy chromeMediaSource constraints) on darwin", async () => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: "darwin",
    pickPrimaryScreenId: vi.fn().mockResolvedValue("screen:1"),
  };

  const screenTracks = [makeTrack()];
  const sysTracks = [makeTrack()];
  const screenAndSystemStream = {
    getTracks: () => [...screenTracks, ...sysTracks],
    getVideoTracks: () => screenTracks,
    getAudioTracks: () => sysTracks,
  };
  const micStream = { getTracks: () => [makeTrack()] };

  const getDisplayMedia = vi.fn().mockResolvedValue(screenAndSystemStream);
  const getUserMedia = vi.fn().mockResolvedValue(micStream);
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getDisplayMedia, getUserMedia },
    configurable: true,
  });

  const { startElectronCapture } = await import("./electronCapture");
  await startElectronCapture({ withSystemAudio: true });

  expect(getDisplayMedia).toHaveBeenCalledWith({
    video: { frameRate: 30 },
    audio: true,
  });
  // The legacy mandatory-constraints call must NOT be used on darwin.
  expect(getUserMedia).not.toHaveBeenCalledWith(
    expect.objectContaining({ video: expect.objectContaining({ mandatory: expect.anything() }) })
  );
});

it("stops already-acquired screen/system tracks if mic capture fails", async () => {
  const screenTracks = [makeTrack(), makeTrack()];
  const screenAndSystemStream = { getTracks: () => screenTracks, getVideoTracks: () => screenTracks, getAudioTracks: () => screenTracks };

  const micError = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
  const getUserMedia = vi
    .fn()
    .mockResolvedValueOnce(screenAndSystemStream) // screen+system call
    .mockRejectedValueOnce(micError); // mic call

  // navigator.mediaDevices does not exist in jsdom by default -- define it
  // fresh for this test rather than assuming a prior test file's global
  // stub is still present (each Vitest file gets its own module registry).
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });

  const { startElectronCapture } = await import("./electronCapture");
  await expect(startElectronCapture()).rejects.toBe(micError);

  for (const track of screenTracks) {
    expect(track.stop).toHaveBeenCalled();
  }
});
