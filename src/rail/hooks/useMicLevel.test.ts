import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { rmsToLevel, useMicLevel } from "./useMicLevel";

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
  close = vi.fn().mockResolvedValue(undefined);
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

it("closes the AudioContext if wiring it to the stream throws mid-construction", () => {
  let created: FakeAudioContext | undefined;
  class ThrowingAudioContext extends FakeAudioContext {
    createMediaStreamSource = vi.fn(() => {
      throw new Error("dead stream");
    });
  }
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function AudioContextCtor() {
      created = new ThrowingAudioContext();
      return created;
    })
  );

  const stream = new MediaStream();
  const { result } = renderHook(() => useMicLevel(stream));

  // The construction failed, so the hook falls back to its default silent
  // levels -- but the AudioContext it already created must still be closed.
  expect(result.current.every((v) => v === 0)).toBe(true);
  expect(created?.close).toHaveBeenCalledTimes(1);
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

it("maps conversational-speech RMS well up the meter, and room noise to near zero", () => {
  const dbToRms = (db: number) => Math.pow(10, db / 20);
  expect(rmsToLevel(0)).toBe(0);
  expect(rmsToLevel(dbToRms(-70))).toBe(0);
  // Normal speech into a laptop mic with AGC off.
  expect(rmsToLevel(dbToRms(-40))).toBeGreaterThan(0.5);
  // Loud speech pegs it.
  expect(rmsToLevel(dbToRms(-26))).toBe(1);
});

// An analyser whose float samples are a constant amplitude, so its RMS is
// exactly that amplitude.
function analyserAt(amplitude: number) {
  return {
    fftSize: 256,
    frequencyBinCount: 128,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(amplitude),
    getByteTimeDomainData: vi.fn(),
  };
}

function stubContextWithAnalysers(analysers: ReturnType<typeof analyserAt>[]) {
  const queue = [...analysers];
  class Ctx extends FakeAudioContext {
    createAnalyser = vi.fn(() => queue.shift()!) as never;
  }
  vi.stubGlobal("AudioContext", Ctx);
}

it("meters system audio on its own when there is no mic stream", () => {
  vi.useFakeTimers();
  stubContextWithAnalysers([analyserAt(0.02)]);

  const system = new MediaStream();
  const { result } = renderHook(() => useMicLevel(null, system));
  act(() => { vi.advanceTimersByTime(60); });

  expect(result.current[result.current.length - 1]).toBeCloseTo(rmsToLevel(0.02));
  expect(result.current[result.current.length - 1]).toBeGreaterThan(0);
});

it("follows whichever of mic and system audio is louder", () => {
  vi.useFakeTimers();
  // Quiet mic, loud call audio.
  stubContextWithAnalysers([analyserAt(0.001), analyserAt(0.02)]);

  const mic = new MediaStream();
  const system = new MediaStream();
  const { result } = renderHook(() => useMicLevel(mic, system));
  act(() => { vi.advanceTimersByTime(60); });

  expect(result.current[result.current.length - 1]).toBeCloseTo(rmsToLevel(0.02));
});

it("keeps metering the mic when the system stream can't be wired", () => {
  vi.useFakeTimers();
  const mic = new MediaStream();
  const system = new MediaStream();
  const analyser = analyserAt(0.02);
  class Ctx extends FakeAudioContext {
    createMediaStreamSource = vi.fn((s: MediaStream) => {
      if (s === system) throw new Error("no audio tracks");
      return { connect: vi.fn(), disconnect: vi.fn() };
    }) as never;
    createAnalyser = vi.fn(() => analyser) as never;
  }
  vi.stubGlobal("AudioContext", Ctx);

  const { result } = renderHook(() => useMicLevel(mic, system));
  act(() => { vi.advanceTimersByTime(60); });

  expect(result.current[result.current.length - 1]).toBeCloseTo(rmsToLevel(0.02));
});

it("decays smoothly instead of dropping straight to zero when sound stops", () => {
  vi.useFakeTimers();
  const amplitude = { value: 0.05 };
  const analyser = {
    ...analyserAt(0),
    getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(amplitude.value),
  };
  stubContextWithAnalysers([analyser]);

  const stream = new MediaStream();
  const { result } = renderHook(() => useMicLevel(stream));
  act(() => { vi.advanceTimersByTime(60); });
  const peak = result.current[result.current.length - 1];

  amplitude.value = 0;
  act(() => { vi.advanceTimersByTime(60); });
  const next = result.current[result.current.length - 1];

  expect(next).toBeGreaterThan(0);
  expect(next).toBeLessThan(peak);
});
