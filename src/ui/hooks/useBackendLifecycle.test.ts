import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useBackendLifecycle } from "./useBackendLifecycle";
import { checkHealth } from "../api";

vi.mock("../api");

function stubBackendAPI() {
  let listener: ((status: BackendStatus) => void) | null = null;
  vi.stubGlobal("backendAPI", {
    onStatus: (cb: (status: BackendStatus) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    restart: vi.fn().mockResolvedValue(undefined),
  });
  return {
    emit: (status: BackendStatus) => {
      listener?.(status);
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("starts healthy when the health poll succeeds and no IPC status has arrived", async () => {
  stubBackendAPI();
  vi.mocked(checkHealth).mockResolvedValue(true);

  const { result } = renderHook(() => useBackendLifecycle());

  await waitFor(() => expect(checkHealth).toHaveBeenCalled());
  expect(result.current).toEqual({ phase: "healthy" });
});

it("reflects 'starting' from an IPC status event", () => {
  const backend = stubBackendAPI();
  vi.mocked(checkHealth).mockResolvedValue(true);

  const { result } = renderHook(() => useBackendLifecycle());
  act(() => backend.emit({ state: "starting" }));

  expect(result.current).toEqual({ phase: "starting" });
});

it("reflects 'restarting' with attempt info from an IPC status event", () => {
  const backend = stubBackendAPI();
  vi.mocked(checkHealth).mockResolvedValue(true);

  const { result } = renderHook(() => useBackendLifecycle());
  act(() => backend.emit({ state: "restarting", attempt: 2, maxAttempts: 3 }));

  expect(result.current).toEqual({ phase: "restarting", attempt: 2, maxAttempts: 3 });
});

it("goes 'reconnected' then 'healthy' after a few seconds on 'up'", () => {
  vi.useFakeTimers();
  const backend = stubBackendAPI();
  vi.mocked(checkHealth).mockResolvedValue(true);

  const { result } = renderHook(() => useBackendLifecycle());
  act(() => backend.emit({ state: "up" }));
  expect(result.current).toEqual({ phase: "reconnected" });

  act(() => {
    vi.advanceTimersByTime(3000);
  });
  expect(result.current).toEqual({ phase: "healthy" });
});

it("goes straight to 'healthy' on 'ready' (first-launch success), not 'reconnected'", () => {
  const backend = stubBackendAPI();
  vi.mocked(checkHealth).mockResolvedValue(true);

  const { result } = renderHook(() => useBackendLifecycle());
  act(() => backend.emit({ state: "ready" }));

  expect(result.current).toEqual({ phase: "healthy" });
});

it("reflects 'failed' with the log tail from an IPC status event", () => {
  const backend = stubBackendAPI();
  vi.mocked(checkHealth).mockResolvedValue(true);

  const { result } = renderHook(() => useBackendLifecycle());
  act(() => backend.emit({ state: "failed", logTail: "traceback..." }));

  expect(result.current).toEqual({ phase: "failed", logTail: "traceback..." });
});

it("goes 'unresponsive' after its own health poll fails for more than ~10s with no IPC event", async () => {
  vi.useFakeTimers();
  stubBackendAPI();
  vi.mocked(checkHealth).mockResolvedValue(false);

  const { result } = renderHook(() => useBackendLifecycle());

  // Just under the threshold: still healthy (no banner, no premature retry).
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(result.current).toEqual({ phase: "healthy" });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(result.current).toEqual({ phase: "unresponsive" });
});

it("recovers from 'unresponsive' back to 'healthy' once its own health poll succeeds again", async () => {
  vi.useFakeTimers();
  stubBackendAPI();
  vi.mocked(checkHealth).mockResolvedValue(false);

  const { result } = renderHook(() => useBackendLifecycle());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12000);
  });
  expect(result.current).toEqual({ phase: "unresponsive" });

  vi.mocked(checkHealth).mockResolvedValue(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(result.current).toEqual({ phase: "healthy" });
});

it("does not go 'unresponsive' while phase is 'starting' -- a normal cold-start wait", async () => {
  vi.useFakeTimers();
  const backend = stubBackendAPI();
  vi.mocked(checkHealth).mockResolvedValue(false);

  const { result } = renderHook(() => useBackendLifecycle());
  act(() => backend.emit({ state: "starting" }));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(result.current).toEqual({ phase: "starting" });
});

it("does not override 'restarting' with 'unresponsive' while a main-driven recovery is in progress", async () => {
  vi.useFakeTimers();
  const backend = stubBackendAPI();
  vi.mocked(checkHealth).mockResolvedValue(false);

  const { result } = renderHook(() => useBackendLifecycle());
  act(() => backend.emit({ state: "restarting", attempt: 1, maxAttempts: 3 }));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(result.current).toEqual({ phase: "restarting", attempt: 1, maxAttempts: 3 });
});
