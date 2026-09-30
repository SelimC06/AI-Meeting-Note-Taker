import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useThrottledValue } from "./useThrottledValue";

afterEach(() => {
  vi.useRealTimers();
});

it("passes the first change straight through, then collapses a burst into one trailing update", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 200), { initialProps: { v: 0 } });
  expect(result.current).toBe(0);

  rerender({ v: 1 });
  // Within 200ms of the initial emit: held back.
  expect(result.current).toBe(0);

  for (const v of [2, 3, 4]) {
    act(() => vi.advanceTimersByTime(50));
    rerender({ v });
  }
  expect(result.current).toBe(0);

  act(() => vi.advanceTimersByTime(60));
  // The trailing update carries the latest value, never an intermediate.
  expect(result.current).toBe(4);
});

it("updates at most once per interval under a steady 60ms stream (the mic level cadence)", () => {
  vi.useFakeTimers();
  const seen: number[] = [];
  const { rerender } = renderHook(
    ({ v }) => {
      const t = useThrottledValue(v, 200);
      if (seen[seen.length - 1] !== t) seen.push(t);
      return t;
    },
    { initialProps: { v: 0 } }
  );

  for (let v = 1; v <= 33; v++) {
    act(() => vi.advanceTimersByTime(60));
    rerender({ v });
  }
  act(() => vi.advanceTimersByTime(200));

  // ~2s of 60ms updates -> about 10 emits, not 33.
  expect(seen.length).toBeLessThanOrEqual(12);
  expect(seen[seen.length - 1]).toBe(33);
});
