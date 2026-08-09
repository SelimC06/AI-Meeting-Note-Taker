import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import RailApp from "./RailApp";
import { useThreeTrackSegments } from "./hooks/useThreeTrackSegments";
import { useProcessingJobs } from "../ui/hooks/useProcessingJobs";

vi.mock("./hooks/useThreeTrackSegments");
vi.mock("../ui/hooks/useProcessingJobs");

// jsdom (this project's test environment) does not implement MediaStream.
// Provide a minimal stub so this file can construct one; production code
// never touches this since real MediaStream instances come from the
// browser/Electron.
if (typeof MediaStream === "undefined") {
  (globalThis as unknown as { MediaStream: typeof MediaStream }).MediaStream =
    class {} as unknown as typeof MediaStream;
}

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
    micStream: null,
    ...overrides,
  });
}

function mockJobsHook(overrides: Partial<ReturnType<typeof useProcessingJobs>> = {}) {
  vi.mocked(useProcessingJobs).mockReturnValue({
    jobs: [],
    addJob: vi.fn(),
    removeJob: vi.fn(),
    ...overrides,
  });
}

beforeEach(() => {
  mockJobsHook();
});

it("shows a persistent red dot with the hook's error as a tooltip", () => {
  mockHook({ error: { kind: "permission-denied", message: "Screen or microphone access denied — check your OS privacy settings." } });

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
  mockHook({ error: { kind: "generic", message: "Recording failed: no codec available" } });

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

it("does not POST when stop() resolves with no captured segments (e.g. aborted while starting)", async () => {
  const stop = vi.fn().mockResolvedValue({});
  mockHook({ status: "recording", stop, error: null });

  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const { container } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];
  fireEvent.click(recordButton);

  await waitFor(() => {
    expect(stop).toHaveBeenCalledTimes(1);
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("routes a click while status is 'starting' to stop() and disables the record button", () => {
  const record = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue({});
  mockHook({ status: "starting", record, stop, error: null });

  const { container } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];
  expect(recordButton).toBeDisabled();

  fireEvent.click(recordButton);
  expect(record).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
});

it("renders an ErrorToast with the display error and hides only the toast (not the red dot) on dismiss", async () => {
  const clearError = vi.fn();
  mockHook({ error: { kind: "permission-denied", message: "Screen or microphone access denied — check your OS privacy settings." }, clearError });

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

it("does not resurrect the toast after dismiss when the error came from a failed /process request", async () => {
  vi.useFakeTimers();
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
  const setRailErrorVisible = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("electronAPI", { setRailErrorVisible });

  const { getByText, getByRole, queryByText, container } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];

  await act(async () => {
    fireEvent.click(recordButton);
    // Flush the mocked fetch's promise microtasks (fake timers don't affect
    // those), then let the just-mounted ErrorToast's own effect (which calls
    // expandRail(true) and schedules its 6s timer) run.
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(getByText("boom")).toBeInTheDocument();

  const expandCallsAfterError = setRailErrorVisible.mock.calls.length;

  fireEvent.click(getByRole("button", { name: "close" }));

  // The toast message is gone immediately after dismiss...
  expect(queryByText("boom")).toBeNull();

  // ...and it must not reappear once the (identity-stable) 6s auto-dismiss
  // timer in ErrorToast fires again, nor should expandRail be re-triggered.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(7000);
  });

  expect(queryByText("boom")).toBeNull();
  expect(setRailErrorVisible.mock.calls.length).toBe(expandCallsAfterError + 1); // only the collapse call from dismiss

  vi.useRealTimers();
});

it("shows an 'open privacy settings' action on a permission-denied error and calls settingsAPI on click", () => {
  const openPrivacySettings = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("settingsAPI", { openPrivacySettings });
  mockHook({
    error: {
      kind: "permission-denied",
      message: "Screen or microphone access denied — check your OS privacy settings.",
    },
  });

  const { getByRole } = render(<RailApp />);
  fireEvent.click(getByRole("button", { name: "open privacy settings" }));

  expect(openPrivacySettings).toHaveBeenCalledWith("microphone");
});

it("does not show the 'open privacy settings' action for a generic error", () => {
  mockHook({ error: { kind: "generic", message: "Recording failed: no codec available" } });

  const { queryByRole } = render(<RailApp />);
  expect(queryByRole("button", { name: "open privacy settings" })).toBeNull();
});

it("calls pause (not resume) when the pause/resume button is clicked while recording", () => {
  const pause = vi.fn().mockResolvedValue(undefined);
  const resume = vi.fn().mockResolvedValue(undefined);
  mockHook({ status: "recording", pause, resume });

  const { getByLabelText } = render(<RailApp />);
  fireEvent.click(getByLabelText("Pause recording"));

  expect(pause).toHaveBeenCalledTimes(1);
  expect(resume).not.toHaveBeenCalled();
});

it("calls resume (not pause) when the pause/resume button is clicked while paused", () => {
  const pause = vi.fn().mockResolvedValue(undefined);
  const resume = vi.fn().mockResolvedValue(undefined);
  mockHook({ status: "paused", pause, resume });

  const { getByLabelText } = render(<RailApp />);
  fireEvent.click(getByLabelText("Resume recording"));

  expect(resume).toHaveBeenCalledTimes(1);
  expect(pause).not.toHaveBeenCalled();
});

it("disables the pause/resume button when idle", () => {
  mockHook({ status: "idle" });

  const { getByLabelText } = render(<RailApp />);
  expect(getByLabelText("Pause recording")).toBeDisabled();
});

it("renders without throwing when given a non-null micStream (RailApp -> useMicLevel integration)", () => {
  mockHook({ status: "recording", micStream: new MediaStream() });

  expect(() => render(<RailApp />)).not.toThrow();
});

it("re-enables recording immediately after /process responds, without waiting for the background job", async () => {
  const addJob = vi.fn();
  mockJobsHook({ jobs: [], addJob });
  const record = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue({ screen: new Blob(["x"]) });
  mockHook({ status: "recording", record, stop, error: null });

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ job_id: "job-1", session_id: "sess-1" }),
    })
  );

  const { container } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];

  await act(async () => {
    fireEvent.click(recordButton);
  });

  expect(recordButton).not.toBeDisabled();
  expect(addJob).toHaveBeenCalledWith("job-1");
});

it("pulses the amber dot with a stage-specific tooltip while a background job is active", () => {
  mockHook();
  mockJobsHook({
    jobs: [{ id: "job-1", stage: "transcribing", status: "running", error: null }],
  });

  const { container } = render(<RailApp />);
  const dot = container.querySelector("span[title]") as HTMLElement;

  expect(dot.className).toContain("bg-amber-400");
  expect(dot).toHaveAttribute("title", "Processing: transcribing");
});

it("flashes success and drops the job once it reaches done", () => {
  mockHook();
  const removeJob = vi.fn();
  mockJobsHook({
    jobs: [{ id: "job-1", stage: null, status: "done", error: null }],
    removeJob,
  });

  const { container } = render(<RailApp />);

  expect(removeJob).toHaveBeenCalledWith("job-1");
  const dot = container.querySelector("span[title]") as HTMLElement;
  expect(dot.className).toContain("bg-signal");
});

it("shows the job's error via the toast and drops the job once it fails", () => {
  mockHook();
  const removeJob = vi.fn();
  mockJobsHook({
    jobs: [
      {
        id: "job-1",
        stage: "muxing",
        status: "failed",
        error:
          "Couldn't combine your audio and video — the recording file may be corrupted. Try recording again.",
      },
    ],
    removeJob,
  });

  const { getByText } = render(<RailApp />);

  expect(removeJob).toHaveBeenCalledWith("job-1");
  expect(
    getByText(
      "Couldn't combine your audio and video — the recording file may be corrupted. Try recording again."
    )
  ).toBeInTheDocument();
});

it("shows a count in the dot's tooltip when more than one job is processing", () => {
  mockHook();
  mockJobsHook({
    jobs: [
      { id: "job-1", stage: "transcribing", status: "running", error: null },
      { id: "job-2", stage: "muxing", status: "running", error: null },
    ],
  });

  const { container } = render(<RailApp />);
  const dot = container.querySelector("span[title]") as HTMLElement;

  expect(dot).toHaveAttribute("title", "2 recordings processing");
});

it("pushes its recording status to windowControls whenever status/elapsed/level/error change", () => {
  const pushRailStatus = vi.fn();
  vi.stubGlobal("windowControls", { pushRailStatus, onRailCommand: vi.fn(() => () => {}) });
  mockHook({ status: "recording" });

  render(<RailApp />);

  expect(pushRailStatus).toHaveBeenCalledWith(
    expect.objectContaining({ status: "recording", recordError: null, isProcessing: false })
  );
});

it("calls the record handler when a toggleRecord command arrives from the dashboard", () => {
  let commandCallback: ((action: string) => void) | undefined;
  const onRailCommand = vi.fn((cb: (action: string) => void) => {
    commandCallback = cb;
    return () => {};
  });
  vi.stubGlobal("windowControls", { pushRailStatus: vi.fn(), onRailCommand });
  const record = vi.fn().mockResolvedValue(undefined);
  mockHook({ status: "idle", record });

  render(<RailApp />);
  commandCallback?.("toggleRecord");

  expect(record).toHaveBeenCalledTimes(1);
});

it("calls stop (not record) for a stopForClose command while recording, and acks when it resolves", async () => {
  let commandCallback: ((action: string) => void) | undefined;
  const onRailCommand = vi.fn((cb: (action: string) => void) => {
    commandCallback = cb;
    return () => {};
  });
  const notifyStopAndSaveComplete = vi.fn();
  vi.stubGlobal("windowControls", {
    pushRailStatus: vi.fn(),
    onRailCommand,
    notifyStopAndSaveComplete,
  });
  const record = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue({});
  mockHook({ status: "recording", record, stop, error: null });

  render(<RailApp />);
  commandCallback?.("stopForClose");

  await waitFor(() => {
    expect(stop).toHaveBeenCalledTimes(1);
  });
  expect(record).not.toHaveBeenCalled();
  expect(notifyStopAndSaveComplete).toHaveBeenCalledTimes(1);
});

it("acks a stopForClose command immediately without starting a new recording when already idle", () => {
  let commandCallback: ((action: string) => void) | undefined;
  const onRailCommand = vi.fn((cb: (action: string) => void) => {
    commandCallback = cb;
    return () => {};
  });
  const notifyStopAndSaveComplete = vi.fn();
  vi.stubGlobal("windowControls", {
    pushRailStatus: vi.fn(),
    onRailCommand,
    notifyStopAndSaveComplete,
  });
  const record = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue({});
  mockHook({ status: "idle", record, stop });

  render(<RailApp />);
  commandCallback?.("stopForClose");

  expect(record).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  expect(notifyStopAndSaveComplete).toHaveBeenCalledTimes(1);
});

it("calls pause when a pause command arrives while recording", () => {
  let commandCallback: ((action: string) => void) | undefined;
  const onRailCommand = vi.fn((cb: (action: string) => void) => {
    commandCallback = cb;
    return () => {};
  });
  vi.stubGlobal("windowControls", { pushRailStatus: vi.fn(), onRailCommand });
  const pause = vi.fn().mockResolvedValue(undefined);
  mockHook({ status: "recording", pause });

  render(<RailApp />);
  commandCallback?.("pause");

  expect(pause).toHaveBeenCalledTimes(1);
});

it("marks the whole pill as an OS-level drag handle, so the floating window can be repositioned or dragged back to the dock from almost anywhere on it", () => {
  mockHook();
  const { getByLabelText } = render(<RailApp />);
  expect(getByLabelText("Elapsed recording time").parentElement?.className).toContain("[-webkit-app-region:drag]");
});

it("excludes the Record and Pause/Resume buttons from the drag region, so clicking them doesn't get intercepted as a window drag", () => {
  mockHook();
  const { getByLabelText } = render(<RailApp />);
  expect(getByLabelText("Start recording").parentElement?.className).toContain("[-webkit-app-region:no-drag]");
  expect(getByLabelText("Pause recording").parentElement?.className).toContain("[-webkit-app-region:no-drag]");
});

it("plays the pop-in animation class by default, switches to pop-out on a pop-out signal, and replays pop-in on the next reset", () => {
  let popCallback: ((payload: { popped: boolean }) => void) | undefined;
  const onRailPopState = vi.fn((cb: (payload: { popped: boolean }) => void) => {
    popCallback = cb;
    return () => {};
  });
  vi.stubGlobal("windowControls", { pushRailStatus: vi.fn(), onRailCommand: vi.fn(() => () => {}), onRailPopState });
  mockHook({ status: "idle" });

  const { getByRole } = render(<RailApp />);
  // Re-queried after each signal rather than holding one reference: a
  // "popped: false" reset remounts the pill (see floatGeneration in
  // RailApp.tsx) so its CSS entrance animation replays, which means the
  // DOM node itself changes identity on that transition.
  expect(getByRole("timer").parentElement?.className).toContain("rail-pop-in");
  expect(getByRole("timer").parentElement?.className).not.toContain("rail-pop-out");

  act(() => popCallback?.({ popped: true }));
  expect(getByRole("timer").parentElement?.className).toContain("rail-pop-out");
  expect(getByRole("timer").parentElement?.className).not.toContain("rail-pop-in");

  act(() => popCallback?.({ popped: false }));
  expect(getByRole("timer").parentElement?.className).toContain("rail-pop-in");
  expect(getByRole("timer").parentElement?.className).not.toContain("rail-pop-out");
});
