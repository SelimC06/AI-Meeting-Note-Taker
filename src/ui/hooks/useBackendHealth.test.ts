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

it("polls getHealthStatus on an interval while active", () => {
  vi.useFakeTimers();
  vi.mocked(getHealthStatus).mockResolvedValue({ ok: true, backend: true, ollama: true });

  renderHook(() => useBackendHealth(true));
  expect(getHealthStatus).toHaveBeenCalledTimes(1);

  act(() => {
    vi.advanceTimersByTime(15000);
  });
  expect(getHealthStatus).toHaveBeenCalledTimes(2);
});

it("stops polling when active flips from true to false", () => {
  vi.useFakeTimers();
  vi.mocked(getHealthStatus).mockResolvedValue({ ok: true, backend: true, ollama: true });

  const { rerender } = renderHook(({ active }) => useBackendHealth(active), {
    initialProps: { active: true },
  });
  expect(getHealthStatus).toHaveBeenCalledTimes(1);

  rerender({ active: false });
  act(() => {
    vi.advanceTimersByTime(60000);
  });

  expect(getHealthStatus).toHaveBeenCalledTimes(1);
});
