import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUpdaterStatus } from "./useUpdaterStatus";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("defaults to not-checked before any status is received (brief 13 #14)", () => {
  // Regression test: the default used to be "idle", indistinguishable from
  // a completed check that found no update -- SettingsPage rendered
  // "You're on the latest version" even before any check had actually run.
  vi.stubGlobal("updaterAPI", { onStatus: vi.fn(() => () => {}), install: vi.fn() });
  const { result } = renderHook(() => useUpdaterStatus());
  expect(result.current).toEqual({ state: "not-checked" });
});

it("reflects the latest status pushed via onStatus", () => {
  let callback: (status: unknown) => void = () => {};
  vi.stubGlobal("updaterAPI", {
    onStatus: vi.fn((cb) => {
      callback = cb;
      return () => {};
    }),
    install: vi.fn(),
  });

  const { result } = renderHook(() => useUpdaterStatus());

  act(() => {
    callback({ state: "downloading", percent: 50 });
  });

  expect(result.current).toEqual({ state: "downloading", percent: 50 });
});

it("unsubscribes on unmount", () => {
  const unsubscribe = vi.fn();
  vi.stubGlobal("updaterAPI", { onStatus: vi.fn(() => unsubscribe), install: vi.fn() });

  const { unmount } = renderHook(() => useUpdaterStatus());
  unmount();

  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it("does not throw when window.updaterAPI is undefined", () => {
  expect(() => renderHook(() => useUpdaterStatus())).not.toThrow();
});

it("calls getStatus() on mount and seeds the initial render with its resolved value", async () => {
  const getStatus = vi.fn().mockResolvedValue({ state: "error", message: "feed unreachable" });
  vi.stubGlobal("updaterAPI", {
    onStatus: vi.fn(() => () => {}),
    install: vi.fn(),
    getStatus,
  });

  const { result } = renderHook(() => useUpdaterStatus());

  expect(getStatus).toHaveBeenCalledTimes(1);

  await act(async () => {
    await Promise.resolve();
  });

  expect(result.current).toEqual({ state: "error", message: "feed unreachable" });
});

it("does not throw when window.updaterAPI has no getStatus", () => {
  vi.stubGlobal("updaterAPI", { onStatus: vi.fn(() => () => {}), install: vi.fn() });
  expect(() => renderHook(() => useUpdaterStatus())).not.toThrow();
});
