import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBackendHealth } from "./useBackendHealth";
import { getHealthStatus } from "../api";

vi.mock("../api");

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("does not poll getHealthStatus while inactive", async () => {
  vi.mocked(getHealthStatus).mockResolvedValue({ ok: true, backend: true, ollama: true });

  renderHook(() => useBackendHealth(false));
  await new Promise((r) => setTimeout(r, 0));

  expect(getHealthStatus).not.toHaveBeenCalled();
});

it("polls getHealthStatus on an interval while active", async () => {
  vi.useFakeTimers();
  vi.mocked(getHealthStatus).mockResolvedValue({ ok: true, backend: true, ollama: true });

  renderHook(() => useBackendHealth(true));
  expect(getHealthStatus).toHaveBeenCalledTimes(1);

  // Async form: flushes the pending getHealthStatus() promise between timer
  // ticks (advanceTimersByTime alone does not), which the adaptive fast/slow
  // cadence below depends on knowing the previous poll's result.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(getHealthStatus).toHaveBeenCalledTimes(2);
});

it("polls much faster than the steady-state interval until the backend is first confirmed healthy", async () => {
  // Root cause of the intermittent "Failed to fetch" startup flake: the
  // sidebar/chat error-suppression gate (backendUp) and its reload-on-
  // recovery trigger in App.tsx both depend solely on this poll. At the
  // old fixed 15s cadence, a backend that finishes a normal ~2-8s cold
  // start could still leave the UI stuck for up to 15 unnecessary seconds
  // before the next poll ever notices -- reading as "sometimes it just
  // doesn't fix itself for a long time" even though nothing is actually
  // broken. Polling fast until healthy is first confirmed closes that gap.
  vi.useFakeTimers();
  vi.mocked(getHealthStatus).mockResolvedValue({ ok: false, backend: false, ollama: false });

  renderHook(() => useBackendHealth(true));
  expect(getHealthStatus).toHaveBeenCalledTimes(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(getHealthStatus).toHaveBeenCalledTimes(2);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(getHealthStatus).toHaveBeenCalledTimes(3);
});

it("falls back to the slow steady-state interval once the backend has been confirmed healthy at least once", async () => {
  vi.useFakeTimers();
  vi.mocked(getHealthStatus).mockResolvedValue({ ok: true, backend: true, ollama: true });

  renderHook(() => useBackendHealth(true));
  expect(getHealthStatus).toHaveBeenCalledTimes(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  // Still just the one call -- already confirmed healthy, so no fast retry.
  expect(getHealthStatus).toHaveBeenCalledTimes(1);

  // Total elapsed since the mount-time poll must reach the full 15s
  // steady-state interval (1000 so far + 14000 here) before the next call.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14000);
  });
  expect(getHealthStatus).toHaveBeenCalledTimes(2);
});

it("switches from fast to slow polling the moment the backend first reports healthy", async () => {
  vi.useFakeTimers();
  vi.mocked(getHealthStatus)
    .mockResolvedValueOnce({ ok: false, backend: false, ollama: false })
    .mockResolvedValue({ ok: true, backend: true, ollama: true });

  renderHook(() => useBackendHealth(true));
  expect(getHealthStatus).toHaveBeenCalledTimes(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  // Second call lands and reports healthy -- from here on, fast polling
  // must stop even though we're still well inside what would have been
  // the next 1s fast-poll window.
  expect(getHealthStatus).toHaveBeenCalledTimes(2);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(getHealthStatus).toHaveBeenCalledTimes(2);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(14000);
  });
  expect(getHealthStatus).toHaveBeenCalledTimes(3);
});

it("stops polling when active flips from true to false", async () => {
  vi.useFakeTimers();
  vi.mocked(getHealthStatus).mockResolvedValue({ ok: true, backend: true, ollama: true });

  const { rerender } = renderHook(({ active }) => useBackendHealth(active), {
    initialProps: { active: true },
  });
  expect(getHealthStatus).toHaveBeenCalledTimes(1);

  rerender({ active: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });

  expect(getHealthStatus).toHaveBeenCalledTimes(1);
});
