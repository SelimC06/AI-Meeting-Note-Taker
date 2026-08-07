import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSystemStats } from "./useSystemStats";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("does not poll window.systemAPI.getStats while inactive", async () => {
  const getStats = vi.fn().mockResolvedValue({
    cpuPercent: 1,
    memPercent: 1,
    totalMemBytes: 1,
    freeMemBytes: 1,
  });
  vi.stubGlobal("systemAPI", { getStats });

  renderHook(() => useSystemStats(false));
  await new Promise((r) => setTimeout(r, 0));

  expect(getStats).not.toHaveBeenCalled();
});

it("polls window.systemAPI.getStats on an interval while active", () => {
  vi.useFakeTimers();
  const getStats = vi.fn().mockResolvedValue({
    cpuPercent: 1,
    memPercent: 1,
    totalMemBytes: 1,
    freeMemBytes: 1,
  });
  vi.stubGlobal("systemAPI", { getStats });

  renderHook(() => useSystemStats(true));
  expect(getStats).toHaveBeenCalledTimes(1);

  act(() => {
    vi.advanceTimersByTime(1500);
  });
  expect(getStats).toHaveBeenCalledTimes(2);
});

it("stops polling when active flips from true to false", () => {
  vi.useFakeTimers();
  const getStats = vi.fn().mockResolvedValue({
    cpuPercent: 1,
    memPercent: 1,
    totalMemBytes: 1,
    freeMemBytes: 1,
  });
  vi.stubGlobal("systemAPI", { getStats });

  const { rerender } = renderHook(({ active }) => useSystemStats(active), {
    initialProps: { active: true },
  });
  expect(getStats).toHaveBeenCalledTimes(1);

  rerender({ active: false });
  act(() => {
    vi.advanceTimersByTime(5000);
  });

  expect(getStats).toHaveBeenCalledTimes(1);
});
