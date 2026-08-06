import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useThreeTrackSegments } from "./useThreeTrackSegments";
import { getSeparateCapture } from "../capture/capture";

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

it("clearError resets the error to null without affecting status", async () => {
  vi.mocked(getSeparateCapture).mockRejectedValueOnce(new Error("boom"));
  const { result } = renderHook(() => useThreeTrackSegments());

  await act(async () => {
    await result.current.record();
  });
  await waitFor(() => {
    expect(result.current.error).toEqual({
      kind: "generic",
      message: "Recording failed: boom",
    });
  });

  act(() => {
    result.current.clearError();
  });

  expect(result.current.error).toBeNull();
  expect(result.current.status).toBe("idle");
});
