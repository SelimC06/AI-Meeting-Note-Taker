import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useElapsedTime } from "./useElapsedTime";

afterEach(() => {
  vi.useRealTimers();
});

it("starts at 00:00 while idle", () => {
  const { result } = renderHook(() => useElapsedTime("idle"));
  expect(result.current).toBe("00:00");
});

it("counts up in mm:ss while recording", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ status }) => useElapsedTime(status), {
    initialProps: { status: "recording" as const },
  });

  act(() => {
    vi.advanceTimersByTime(65_000);
  });
  rerender({ status: "recording" });

  expect(result.current).toBe("01:05");
});

it("freezes the count while paused", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ status }) => useElapsedTime(status), {
    initialProps: { status: "recording" as const },
  });

  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  rerender({ status: "paused" });

  act(() => {
    vi.advanceTimersByTime(20_000);
  });
  rerender({ status: "paused" });

  expect(result.current).toBe("00:10");
});

it("resumes counting from where it paused", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ status }) => useElapsedTime(status), {
    initialProps: { status: "recording" as const },
  });

  act(() => { vi.advanceTimersByTime(10_000); });
  rerender({ status: "paused" });
  act(() => { vi.advanceTimersByTime(5_000); });
  rerender({ status: "recording" });
  act(() => { vi.advanceTimersByTime(3_000); });
  rerender({ status: "recording" });

  expect(result.current).toBe("00:13");
});

it("resets to 00:00 when returning to idle", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ status }) => useElapsedTime(status), {
    initialProps: { status: "recording" as const },
  });

  act(() => { vi.advanceTimersByTime(10_000); });
  rerender({ status: "idle" });

  expect(result.current).toBe("00:00");
});
