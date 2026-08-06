import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import RailApp from "./RailApp";
import { useThreeTrackSegments } from "./hooks/useThreeTrackSegments";

vi.mock("./hooks/useThreeTrackSegments");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mockHook(overrides: Partial<ReturnType<typeof useThreeTrackSegments>> = {}) {
  vi.mocked(useThreeTrackSegments).mockReturnValue({
    status: "idle",
    record: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue({}),
    error: null,
    ...overrides,
  });
}

it("shows a persistent red dot with the hook's error as a tooltip", () => {
  mockHook({ error: "Screen or microphone access denied — check your OS privacy settings." });

  const { container } = render(<RailApp />);
  const dot = container.querySelector("span[title]") as HTMLElement;

  expect(dot).toHaveAttribute(
    "title",
    "Screen or microphone access denied — check your OS privacy settings."
  );
  expect(dot.className).toContain("bg-red-500");
});

it("does not auto-clear the error dot after 2 seconds", async () => {
  vi.useFakeTimers();
  mockHook({ error: "Recording failed: no codec available" });

  const { container } = render(<RailApp />);
  await vi.advanceTimersByTimeAsync(3000);

  const dot = container.querySelector("span[title]") as HTMLElement;
  expect(dot).toHaveAttribute("title", "Recording failed: no codec available");
  vi.useRealTimers();
});

it("shows a persistent tooltip when the /process request fails, and clears it on the next record attempt", async () => {
  const record = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue({ screen: new Blob(["x"]) });
  mockHook({ status: "recording", record, stop, error: null });

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("boom") })
  );

  const { container, rerender } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];
  fireEvent.click(recordButton);

  await waitFor(() => {
    const dot = container.querySelector("span[title]") as HTMLElement;
    expect(dot).toHaveAttribute("title", expect.stringContaining("Backend error 500"));
  });

  // Starting a new recording clears the stale processing error.
  mockHook({ status: "idle", record, stop, error: null });
  rerender(<RailApp />);
  const recordButtonAgain = container.querySelectorAll("button")[0];
  fireEvent.click(recordButtonAgain);

  await waitFor(() => {
    expect(record).toHaveBeenCalledTimes(1);
  });
  const dotAfterReset = container.querySelector("span[title]");
  expect(dotAfterReset).toBeNull();
});

it("shows a persistent tooltip when stop() itself rejects, instead of silently reverting to dim", async () => {
  const stop = vi.fn().mockRejectedValue(new Error("recorder stop failed: track ended"));
  mockHook({ status: "recording", stop, error: null });

  const { container } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];
  fireEvent.click(recordButton);

  await waitFor(() => {
    const dot = container.querySelector("span[title]") as HTMLElement;
    expect(dot).toHaveAttribute("title", "recorder stop failed: track ended");
  });

  const dot = container.querySelector("span[title]") as HTMLElement;
  expect(dot.className).toContain("bg-red-500");
  expect(dot.className).not.toContain("bg-amber-400");
  expect(dot.className).not.toContain("bg-dim");
});
