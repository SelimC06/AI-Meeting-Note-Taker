import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSeparateCapture } from "./capture";

function makeTrack() {
  return { stop: vi.fn() };
}

beforeEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("stops the already-acquired screen stream if mic capture fails (browser fallback path)", async () => {
  const screenTracks = [makeTrack()];
  const screenStream = { getTracks: () => screenTracks };

  const micError = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
  const getDisplayMedia = vi.fn().mockResolvedValueOnce(screenStream);
  const getUserMedia = vi.fn().mockRejectedValueOnce(micError);

  Object.defineProperty(navigator, "mediaDevices", {
    value: { getDisplayMedia, getUserMedia },
    configurable: true,
  });

  await expect(getSeparateCapture()).rejects.toBe(micError);

  for (const track of screenTracks) {
    expect(track.stop).toHaveBeenCalled();
  }
});
