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
    clearError: vi.fn(),
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
    vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ detail: "boom" }),
      text: () => Promise.resolve('{"detail":"boom"}'),
    })
  );

  const { container, rerender } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];
  fireEvent.click(recordButton);

  await waitFor(() => {
    const dot = container.querySelector("span[title]") as HTMLElement;
    expect(dot).toHaveAttribute("title", "boom");
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

it("shows a friendly message when the /process request can't reach the backend at all", async () => {
  const record = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue({ screen: new Blob(["x"]) });
  mockHook({ status: "recording", record, stop, error: null });

  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
  );

  const { container } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];
  fireEvent.click(recordButton);

  await waitFor(() => {
    const dot = container.querySelector("span[title]") as HTMLElement;
    expect(dot).toHaveAttribute(
      "title",
      "Couldn't reach the app backend — is it running?"
    );
  });
});

it("falls back to raw response text when the /process error body isn't JSON", async () => {
  const record = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue({ screen: new Blob(["x"]) });
  mockHook({ status: "recording", record, stop, error: null });

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve("plain text failure"),
    })
  );

  const { container } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];
  fireEvent.click(recordButton);

  await waitFor(() => {
    const dot = container.querySelector("span[title]") as HTMLElement;
    expect(dot).toHaveAttribute("title", "plain text failure");
  });
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

it("renders an ErrorToast with the display error and hides only the toast (not the red dot) on dismiss", async () => {
  const clearError = vi.fn();
  mockHook({ error: "Screen or microphone access denied — check your OS privacy settings.", clearError });

  const { getByText, getByRole, container, queryByText } = render(<RailApp />);
  expect(
    getByText("Screen or microphone access denied — check your OS privacy settings.")
  ).toBeInTheDocument();

  fireEvent.click(getByRole("button", { name: "close" }));

  // The toast message is gone...
  expect(
    queryByText("Screen or microphone access denied — check your OS privacy settings.")
  ).toBeNull();
  // ...but the underlying error state was never cleared.
  expect(clearError).not.toHaveBeenCalled();
  const dot = container.querySelector("span[title]") as HTMLElement;
  expect(dot).toHaveAttribute(
    "title",
    "Screen or microphone access denied — check your OS privacy settings."
  );
  expect(dot.className).toContain("bg-red-500");
});
