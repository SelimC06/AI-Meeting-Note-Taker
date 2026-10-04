import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLiveCaptions, CAPTION_WINDOW_MS } from "./useLiveCaptions";
import { liveTranscribe } from "../../ui/api";

vi.mock("../../ui/api");

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  stream: unknown;
  constructor(stream: unknown) {
    this.stream = stream;
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio bytes"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

class FakeMediaStream {
  tracks: unknown[];
  constructor(tracks: unknown[]) {
    this.tracks = tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

function fakeStream(): MediaStream {
  return new FakeMediaStream([{ kind: "audio" }]) as unknown as MediaStream;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeMediaRecorder.instances = [];
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("MediaStream", FakeMediaStream);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const flushAsync = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

it("rotates one caption recorder per track and pushes speaker-tagged captions", async () => {
  vi.mocked(liveTranscribe)
    .mockResolvedValueOnce("hello from the mic")
    .mockResolvedValueOnce("hello from the call");

  // Stable stream identities across re-renders, like RailApp's state refs.
  const mic = fakeStream();
  const system = fakeStream();
  const { result } = renderHook(() => useLiveCaptions(true, "recording", mic, system));

  // One dedicated caption recorder per audio track, already recording.
  expect(FakeMediaRecorder.instances).toHaveLength(2);
  expect(FakeMediaRecorder.instances.every((r) => r.state === "recording")).toBe(true);

  // First window elapses: both recorders stop, restart, and their blobs go
  // to /live/transcribe in the background.
  await act(async () => {
    vi.advanceTimersByTime(CAPTION_WINDOW_MS);
  });
  await flushAsync();

  expect(liveTranscribe).toHaveBeenCalledTimes(2);
  expect(result.current.map((c) => ({ speaker: c.speaker, text: c.text }))).toEqual([
    { speaker: "You", text: "hello from the mic" },
    { speaker: "Others", text: "hello from the call" },
  ]);

  // The NEXT window is already recording (restart wasn't serialized
  // behind transcription).
  expect(FakeMediaRecorder.instances).toHaveLength(4);
  expect(FakeMediaRecorder.instances[2].state).toBe("recording");
});

it("drops windows the backend skipped and empty captions", async () => {
  vi.mocked(liveTranscribe).mockResolvedValue(null); // 429 / failure path

  const { result } = renderHook(() =>
    useLiveCaptions(true, "recording", fakeStream(), null)
  );
  await act(async () => {
    vi.advanceTimersByTime(CAPTION_WINDOW_MS);
  });
  await flushAsync();

  expect(liveTranscribe).toHaveBeenCalledTimes(1);
  expect(result.current).toEqual([]);
});

it("records nothing while disabled or not recording", () => {
  renderHook(() => useLiveCaptions(false, "recording", fakeStream(), fakeStream()));
  renderHook(() => useLiveCaptions(true, "paused", fakeStream(), fakeStream()));
  expect(FakeMediaRecorder.instances).toHaveLength(0);
});

it("stops recorders on unmount and ignores their late results", async () => {
  let resolveText: (t: string | null) => void = () => {};
  vi.mocked(liveTranscribe).mockImplementation(
    () => new Promise((resolve) => { resolveText = resolve; })
  );

  const { result, unmount } = renderHook(() =>
    useLiveCaptions(true, "recording", fakeStream(), null)
  );
  await act(async () => {
    vi.advanceTimersByTime(CAPTION_WINDOW_MS);
  });

  unmount();
  expect(FakeMediaRecorder.instances.every((r) => r.state === "inactive")).toBe(true);

  resolveText("too late");
  await flushAsync();
  expect(result.current).toEqual([]);
});

it("clears captions when a new recording starts", async () => {
  vi.mocked(liveTranscribe).mockResolvedValue("left over");

  const { result, rerender } = renderHook(
    ({ status }: { status: "idle" | "starting" | "recording" | "paused" }) =>
      useLiveCaptions(true, status, fakeStream(), null),
    { initialProps: { status: "recording" as const } }
  );
  await act(async () => {
    vi.advanceTimersByTime(CAPTION_WINDOW_MS);
  });
  await flushAsync();
  expect(result.current).toHaveLength(1);

  rerender({ status: "idle" });
  expect(result.current).toHaveLength(1); // kept after stop, until...
  rerender({ status: "starting" });
  expect(result.current).toEqual([]); // ...the next recording begins
});
