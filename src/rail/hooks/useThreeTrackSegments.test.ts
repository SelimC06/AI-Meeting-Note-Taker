import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useThreeTrackSegments } from "./useThreeTrackSegments";
import { getSeparateCapture } from "../capture/capture";
import { getAudioRecorder, getVideoRecorder } from "../capture/recorder";

// jsdom (this project's test environment) does not implement MediaStream.
// Provide a minimal stub so tests can construct one; production code never
// touches this since real MediaStream instances come from the browser/Electron.
if (typeof MediaStream === "undefined") {
  (globalThis as unknown as { MediaStream: typeof MediaStream }).MediaStream =
    class {} as unknown as typeof MediaStream;
}

vi.mock("../capture/capture");
vi.mock("../capture/recorder", () => ({
  getVideoRecorder: vi.fn(() => ({ ondata: vi.fn(), start: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn() })),
  getAudioRecorder: vi.fn(() => ({ ondata: vi.fn(), start: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn() })),
}));

afterEach(() => {
  vi.clearAllMocks();
});

it("surfaces a permission-denied message when the browser rejects with NotAllowedError", async () => {
  const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
  vi.mocked(getSeparateCapture).mockRejectedValueOnce(denied);

  const { result } = renderHook(() => useThreeTrackSegments());
  await act(async () => {
    await result.current.record();
  });

  await waitFor(() => {
    expect(result.current.error).toEqual({
      kind: "permission-denied",
      message: "Screen or microphone access denied — check your OS privacy settings.",
    });
  });
  expect(result.current.status).toBe("idle");
});

it("surfaces a generic message for non-permission errors", async () => {
  vi.mocked(getSeparateCapture).mockRejectedValueOnce(new Error("no codec available"));

  const { result } = renderHook(() => useThreeTrackSegments());
  await act(async () => {
    await result.current.record();
  });

  await waitFor(() => {
    expect(result.current.error).toEqual({
      kind: "generic",
      message: "Recording failed: no codec available",
    });
  });
});

it("clears a previous error when a new record() call starts", async () => {
  vi.mocked(getSeparateCapture).mockRejectedValueOnce(new Error("first failure"));
  const { result } = renderHook(() => useThreeTrackSegments());

  await act(async () => {
    await result.current.record();
  });
  await waitFor(() => {
    expect(result.current.error).toEqual({
      kind: "generic",
      message: "Recording failed: first failure",
    });
  });

  vi.mocked(getSeparateCapture).mockResolvedValueOnce({
    screen: undefined,
    system: undefined,
    mic: undefined,
    stopAll: vi.fn(),
  });
  await act(async () => {
    await result.current.record();
  });

  expect(result.current.error).toBeNull();
});

it("exposes the mic MediaStream while recording and clears it on stop", async () => {
  const micStream = new MediaStream();
  vi.mocked(getSeparateCapture).mockResolvedValueOnce({
    mic: micStream,
    stopAll: vi.fn(),
  });

  const { result } = renderHook(() => useThreeTrackSegments());
  expect(result.current.micStream).toBeNull();

  await act(async () => {
    await result.current.record();
  });
  expect(result.current.micStream).toBe(micStream);

  await act(async () => {
    await result.current.stop();
  });
  expect(result.current.micStream).toBeNull();
});

it("exposes the system-audio MediaStream while recording and clears it on stop", async () => {
  const systemStream = new MediaStream();
  vi.mocked(getSeparateCapture).mockResolvedValueOnce({
    system: systemStream,
    mic: new MediaStream(),
    stopAll: vi.fn(),
  });

  const { result } = renderHook(() => useThreeTrackSegments());
  expect(result.current.systemStream).toBeNull();

  await act(async () => {
    await result.current.record();
  });
  expect(result.current.systemStream).toBe(systemStream);

  await act(async () => {
    await result.current.stop();
  });
  expect(result.current.systemStream).toBeNull();
});

it("stop() calls stopAll and resets status to idle even if a recorder's stop() rejects", async () => {
  const stopAll = vi.fn();
  vi.mocked(getSeparateCapture).mockResolvedValueOnce({
    screen: new MediaStream(),
    stopAll,
  });
  vi.mocked(getVideoRecorder).mockReturnValueOnce({
    ondata: vi.fn(),
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn().mockRejectedValueOnce(
      Object.assign(new Error("The MediaRecorder's state is inactive."), { name: "InvalidStateError" })
    ),
  });

  const { result } = renderHook(() => useThreeTrackSegments());
  await act(async () => {
    await result.current.record();
  });
  expect(result.current.status).toBe("recording");

  await act(async () => {
    await result.current.stop();
  });

  expect(stopAll).toHaveBeenCalled();
  expect(result.current.status).toBe("idle");
});

it("aborts a record() that's still resolving getSeparateCapture() if stop() lands first, without starting any recorder", async () => {
  let resolveCapture!: (streams: {
    screen: MediaStream;
    stopAll: () => void;
  }) => void;
  const capturePromise = new Promise((resolve) => {
    resolveCapture = resolve;
  });
  vi.mocked(getSeparateCapture).mockReturnValueOnce(capturePromise as ReturnType<typeof getSeparateCapture>);

  const stopAll = vi.fn();
  const acquiredScreen = new MediaStream();

  const { result } = renderHook(() => useThreeTrackSegments());

  // Click record: status flips to "starting" while getSeparateCapture()
  // is still in flight.
  let recordPromise!: Promise<void>;
  act(() => {
    recordPromise = result.current.record();
  });
  expect(result.current.status).toBe("starting");

  // Click stop before the capture resolves -- this is the race: recRef
  // is still null at this point, so stop() has nothing to clean up
  // directly and must instead flag the abort for record() to finish.
  let stopPromise!: ReturnType<typeof result.current.stop>;
  act(() => {
    stopPromise = result.current.stop();
  });
  await act(async () => {
    await stopPromise;
  });
  expect(result.current.status).toBe("starting");
  expect(stopAll).not.toHaveBeenCalled();

  // Now let getSeparateCapture() resolve.
  await act(async () => {
    resolveCapture({ screen: acquiredScreen, stopAll });
    await recordPromise;
  });

  expect(stopAll).toHaveBeenCalledTimes(1);
  expect(vi.mocked(getVideoRecorder)).not.toHaveBeenCalled();
  expect(result.current.status).toBe("idle");
});

it("stop() resolves Combined blobs assembled from chunks delivered via ondata (not from the recorder's own return value)", async () => {
  // Regression test for brief 09: recorder.stop() no longer returns a Blob
  // (the recorder stopped keeping its own duplicate chunk copy) -- the hook
  // must build the final blobs entirely from what it already collected via
  // ondata() into segsRef.
  let screenOnData!: (chunk: Blob) => void;
  vi.mocked(getSeparateCapture).mockResolvedValueOnce({
    screen: new MediaStream(),
    stopAll: vi.fn(),
  });
  vi.mocked(getVideoRecorder).mockReturnValueOnce({
    ondata: (cb) => {
      screenOnData = cb;
    },
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  });

  const { result } = renderHook(() => useThreeTrackSegments());
  await act(async () => {
    await result.current.record();
  });

  const chunk1 = new Blob(["a"]);
  const chunk2 = new Blob(["b"]);
  act(() => {
    screenOnData(chunk1);
    screenOnData(chunk2);
  });

  let combined!: Awaited<ReturnType<typeof result.current.stop>>;
  await act(async () => {
    combined = await result.current.stop();
  });

  expect(combined.screen).toBeInstanceOf(Blob);
  expect(combined.screen?.size).toBe(chunk1.size + chunk2.size);
});

it("record() releases already-acquired streams if recorder setup fails afterward", async () => {
  const stopAll = vi.fn();
  vi.mocked(getSeparateCapture).mockResolvedValueOnce({
    screen: new MediaStream(),
    stopAll,
  });
  vi.mocked(getVideoRecorder).mockImplementationOnce(() => {
    throw new Error("Unsupported mimeType");
  });

  const { result } = renderHook(() => useThreeTrackSegments());
  await act(async () => {
    await result.current.record();
  });

  expect(stopAll).toHaveBeenCalled();
  expect(result.current.status).toBe("idle");
});

it("ignores a second record() call made before the first has re-rendered, so only one set of streams is acquired", async () => {
  // Regression: record() only checked the render-time `status`, so two
  // calls in the same tick both passed and the second orphaned the first
  // set of MediaStreams and recorders.
  vi.mocked(getSeparateCapture).mockResolvedValue({
    screen: new MediaStream(),
    stopAll: vi.fn(),
  });

  const { result } = renderHook(() => useThreeTrackSegments());
  await act(async () => {
    const record = result.current.record;
    await Promise.all([record(), record()]);
  });

  expect(getSeparateCapture).toHaveBeenCalledTimes(1);
  expect(getVideoRecorder).toHaveBeenCalledTimes(1);
  expect(result.current.status).toBe("recording");
});

it("allows a new record() once the previous one has failed", async () => {
  vi.mocked(getSeparateCapture)
    .mockRejectedValueOnce(new Error("first failure"))
    .mockResolvedValueOnce({ screen: new MediaStream(), stopAll: vi.fn() });

  const { result } = renderHook(() => useThreeTrackSegments());
  await act(async () => {
    await result.current.record();
  });
  await act(async () => {
    await result.current.record();
  });

  expect(getSeparateCapture).toHaveBeenCalledTimes(2);
  expect(result.current.status).toBe("recording");
});

it("registers the mic recorder's ondata callback exactly once", async () => {
  const micOndata = vi.fn();
  vi.mocked(getSeparateCapture).mockResolvedValueOnce({
    mic: new MediaStream(),
    stopAll: vi.fn(),
  });
  vi.mocked(getAudioRecorder).mockReturnValueOnce({
    ondata: micOndata,
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
  } as unknown as ReturnType<typeof getAudioRecorder>);

  const { result } = renderHook(() => useThreeTrackSegments());
  await act(async () => {
    await result.current.record();
  });

  expect(micOndata).toHaveBeenCalledTimes(1);
});

it("types each Combined blob with its recorder's actual mimeType instead of hard-coded webm", async () => {
  let micOnData!: (chunk: Blob) => void;
  let screenOnData!: (chunk: Blob) => void;
  vi.mocked(getSeparateCapture).mockResolvedValueOnce({
    screen: new MediaStream(),
    mic: new MediaStream(),
    stopAll: vi.fn(),
  });
  vi.mocked(getVideoRecorder).mockReturnValueOnce({
    ondata: (cb: (chunk: Blob) => void) => { screenOnData = cb; },
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    // "" = the browser chose; falls back to the default below.
    mimeType: "",
  } as unknown as ReturnType<typeof getVideoRecorder>);
  vi.mocked(getAudioRecorder).mockReturnValueOnce({
    ondata: (cb: (chunk: Blob) => void) => { micOnData = cb; },
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    mimeType: "audio/ogg;codecs=opus",
  } as unknown as ReturnType<typeof getAudioRecorder>);

  const { result } = renderHook(() => useThreeTrackSegments());
  await act(async () => {
    await result.current.record();
  });
  act(() => {
    screenOnData(new Blob(["v"]));
    micOnData(new Blob(["a"]));
  });

  let combined!: Awaited<ReturnType<typeof result.current.stop>>;
  await act(async () => {
    combined = await result.current.stop();
  });

  expect(combined.micAudio?.type).toBe("audio/ogg;codecs=opus");
  expect(combined.screen?.type).toBe("video/webm");
});

// ---------- a source ending mid-recording ----------

function fakeTrackStream() {
  const target = new EventTarget();
  const track = Object.assign(target, { stop: vi.fn() });
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, endTrack: () => target.dispatchEvent(new Event("ended")) };
}

it("warns when the microphone disconnects mid-recording, and keeps recording", async () => {
  const mic = fakeTrackStream();
  vi.mocked(getSeparateCapture).mockResolvedValueOnce({
    screen: undefined, system: undefined, mic: mic.stream, stopAll: vi.fn(),
  });
  const { result } = renderHook(() => useThreeTrackSegments());
  await act(async () => {
    await result.current.record();
  });
  expect(result.current.status).toBe("recording");

  act(() => mic.endTrack());

  expect(result.current.error).toEqual({
    kind: "generic",
    message: "Microphone disconnected — the rest of the recording continues without it.",
  });
  expect(result.current.status).toBe("recording");
});

it("pausing still pauses the remaining recorders and flips status after one source ended", async () => {
  const pauseCalls: string[] = [];
  vi.mocked(getVideoRecorder).mockReturnValueOnce({
    ondata: vi.fn(), start: vi.fn(), pause: vi.fn(() => pauseCalls.push("screen")), resume: vi.fn(), stop: vi.fn(),
  } as unknown as ReturnType<typeof getVideoRecorder>);
  vi.mocked(getAudioRecorder).mockReturnValueOnce({
    // The mic's recorder went inactive; recorder.ts makes this a no-op.
    ondata: vi.fn(), start: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
  } as unknown as ReturnType<typeof getAudioRecorder>);
  const mic = fakeTrackStream();
  vi.mocked(getSeparateCapture).mockResolvedValueOnce({
    screen: new MediaStream(), system: undefined, mic: mic.stream, stopAll: vi.fn(),
  });
  const { result } = renderHook(() => useThreeTrackSegments());
  await act(async () => {
    await result.current.record();
  });
  act(() => mic.endTrack());

  await act(async () => {
    await result.current.pause();
  });

  expect(pauseCalls).toEqual(["screen"]);
  expect(result.current.status).toBe("paused");
});

it("tracks ending after the recording was stopped don't raise a warning", async () => {
  const mic = fakeTrackStream();
  vi.mocked(getSeparateCapture).mockResolvedValueOnce({
    screen: undefined, system: undefined, mic: mic.stream, stopAll: vi.fn(),
  });
  const { result } = renderHook(() => useThreeTrackSegments());
  await act(async () => {
    await result.current.record();
  });
  await act(async () => {
    await result.current.stop();
  });

  act(() => mic.endTrack());

  expect(result.current.error).toBeNull();
});
