import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMicLevel } from "./useMicLevel";

if (typeof MediaStream === "undefined") {
  // jsdom does not provide a MediaStream global; this hook's tests only need
  // a constructible stand-in since AudioContext itself is fully mocked.
  (globalThis as unknown as { MediaStream: new () => unknown }).MediaStream = class {} as never;
}

class FakeAnalyserNode {
  fftSize = 256;
  frequencyBinCount = 128;
  connect = vi.fn();
  disconnect = vi.fn();
  getByteTimeDomainData(buffer: Uint8Array) {
    // Constant max-amplitude square wave -> RMS should be ~1 after normalization.
    buffer.fill(255);
  }
}

class FakeAudioContext {
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createAnalyser = vi.fn(() => new FakeAnalyserNode());
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("returns 20 zeros when there is no stream", () => {
  const { result } = renderHook(() => useMicLevel(null));
  expect(result.current).toHaveLength(20);
  expect(result.current.every((v) => v === 0)).toBe(true);
});

it("samples the analyser on an interval and pushes levels into a rolling buffer", () => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", FakeAudioContext);

  const stream = new MediaStream();
  const { result } = renderHook(() => useMicLevel(stream));

  act(() => {
    vi.advanceTimersByTime(60);
  });

  expect(result.current).toHaveLength(20);
  const last = result.current[result.current.length - 1];
  expect(last).toBeGreaterThan(0.9);
});

it("resets to zeros when the stream goes back to null", () => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", FakeAudioContext);

  const stream = new MediaStream();
  const { result, rerender } = renderHook(({ s }) => useMicLevel(s), {
    initialProps: { s: stream as MediaStream | null },
  });

  act(() => { vi.advanceTimersByTime(60); });
  rerender({ s: null });

  expect(result.current.every((v) => v === 0)).toBe(true);
});
