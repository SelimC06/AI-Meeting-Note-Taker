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
    micStream: null,
    systemStream: null,
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

it("shows a persistent tooltip when the /process request fails, and keeps it through the next record attempt", async () => {
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

  // Starting a new recording must NOT clear it -- the failed recording is
  // still only in memory, and hiding its error hid its retry action too.
  mockHook({ status: "idle", record, stop, error: null });
  rerender(<RailApp />);
  const recordButtonAgain = container.querySelectorAll("button")[0];
  fireEvent.click(recordButtonAgain);

  await waitFor(() => {
    expect(record).toHaveBeenCalledTimes(1);
  });
  const dotAfterRecord = container.querySelector("span[title]") as HTMLElement;
  expect(dotAfterRecord).toHaveAttribute("title", "boom");
});

it("offers a retry action when /process fails, and retry re-POSTs the same recording and succeeds", async () => {
  // Regression test for brief 09 Stage 1: a failed /process POST used to
  // just discard the assembled blobs, with only the error message left --
  // the recording was unrecoverable. Now the FormData (and its Blobs) is
  // held until upload succeeds, and a "retry upload" action re-sends it.
  const record = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue({ screen: new Blob(["screen bytes"]) });
  mockHook({ status: "recording", record, stop, error: null });

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ detail: "backend restarting" }),
      text: () => Promise.resolve('{"detail":"backend restarting"}'),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: "job-1", session_id: "session-1" }),
    });
  vi.stubGlobal("fetch", fetchMock);

  const { container, getByRole, queryByRole } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];
  fireEvent.click(recordButton);

  const retryButton = await waitFor(() => getByRole("button", { name: "retry upload" }));

  fireEvent.click(retryButton);

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  // The error/retry UI clears once the retry succeeds.
  await waitFor(() => {
    expect(queryByRole("button", { name: "retry upload" })).not.toBeInTheDocument();
  });

  // Both attempts must have carried the exact same recording data -- the
  // whole point is the blobs are never discarded or re-recorded.
  const [firstCall, secondCall] = fetchMock.mock.calls;
  const firstBody = firstCall[1].body as FormData;
  const secondBody = secondCall[1].body as FormData;
  expect(firstBody.get("screen")).toBe(secondBody.get("screen"));
});

it("does not offer a retry action for a permission-denied recordError, even if a prior upload also failed", async () => {
  mockHook({
    status: "idle",
    error: { kind: "permission-denied", message: "Screen or microphone access denied — check your OS privacy settings." },
  });

  const { queryByRole, getByRole } = render(<RailApp />);

  expect(queryByRole("button", { name: "retry upload" })).not.toBeInTheDocument();
  expect(getByRole("button", { name: "open privacy settings" })).toBeInTheDocument();
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
  mockHook({ error: { kind: "permission-denied", message: "Screen or microphone access denied — check your OS privacy settings." } });

  const { getByText, getByRole, container, queryByText } = render(<RailApp />);
  expect(
    getByText("Screen or microphone access denied — check your OS privacy settings.")
  ).toBeInTheDocument();

  fireEvent.click(getByRole("button", { name: "close" }));

  // The toast message is gone, but the underlying error state persists --
  // the red dot must still reflect it.
  expect(
    queryByText("Screen or microphone access denied — check your OS privacy settings.")
  ).toBeNull();
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

it("opens the screen-recording privacy pane on macOS when a permission-denied error is shown", () => {
  const openPrivacySettings = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("settingsAPI", { openPrivacySettings });
  vi.stubGlobal("electronAPI", {
    platform: "darwin",
    pickPrimaryScreenId: vi.fn(),
    setRailErrorVisible: vi.fn().mockResolvedValue(undefined),
  });
  mockHook({
    error: {
      kind: "permission-denied",
      message: "Screen or microphone access denied — check your OS privacy settings.",
    },
  });

  const { getByRole } = render(<RailApp />);
  fireEvent.click(getByRole("button", { name: "open privacy settings" }));

  expect(openPrivacySettings).toHaveBeenCalledWith("screenRecording");
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

it("calls the record handler when a toggleRecord command arrives from the dashboard", async () => {
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

  // Recording now waits on consentAPI.ensureRecordingConsent() first (a
  // no-op resolving true when window.consentAPI isn't stubbed, as here) --
  // that adds a microtask hop before record() is actually called.
  await waitFor(() => {
    expect(record).toHaveBeenCalledTimes(1);
  });
});

it("does not start recording when consentAPI.ensureRecordingConsent resolves false", async () => {
  const ensureRecordingConsent = vi.fn().mockResolvedValue(false);
  vi.stubGlobal("consentAPI", { ensureRecordingConsent });
  const record = vi.fn().mockResolvedValue(undefined);
  mockHook({ status: "idle", record });

  const { container } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];
  fireEvent.click(recordButton);

  await waitFor(() => {
    expect(ensureRecordingConsent).toHaveBeenCalledTimes(1);
  });
  expect(record).not.toHaveBeenCalled();
});

it("starts recording once consentAPI.ensureRecordingConsent resolves true", async () => {
  const ensureRecordingConsent = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("consentAPI", { ensureRecordingConsent });
  const record = vi.fn().mockResolvedValue(undefined);
  mockHook({ status: "idle", record });

  const { container } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];
  fireEvent.click(recordButton);

  await waitFor(() => {
    expect(record).toHaveBeenCalledTimes(1);
  });
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

it("waits for an already in-flight upload instead of acking immediately when stopForClose arrives mid-upload", async () => {
  // Regression test: status flips back to "idle" as soon as a manual
  // stop()'s own stopAndUpload() call resolves stop(), well before its
  // POST /process upload finishes. A stopForClose arriving in that window
  // used to see status "idle" and isProcessing true and ack immediately
  // instead of waiting -- letting main.js destroy this window (and the
  // in-flight request with it) mid-upload.
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
  const stop = vi.fn().mockResolvedValue({ screen: new Blob(["x"]) });

  let resolveFetch: (value: unknown) => void = () => {};
  const fetchPromise = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(fetchPromise));

  mockHook({ status: "recording", record, stop, error: null });

  const { container, rerender } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];
  fireEvent.click(recordButton); // manual stop -> stopAndUpload() -> stop() then a still-pending fetch()

  await waitFor(() => {
    expect(stop).toHaveBeenCalledTimes(1);
  });

  // The hook's own status is idle again post-stop() even though the upload
  // is still in flight -- rerender to match, same as main.js would see via
  // rail:pushStatus (status: "idle", isProcessing: true).
  mockHook({ status: "idle", record, stop, error: null });
  rerender(<RailApp />);

  commandCallback?.("stopForClose");

  // Must NOT ack yet -- that would let main.js destroy this window mid-upload --
  // and must not have started a second stop/upload.
  await act(() => Promise.resolve());
  expect(notifyStopAndSaveComplete).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledTimes(1);

  resolveFetch({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ job_id: "job-1", session_id: "session-1" }),
  });

  await waitFor(() => {
    expect(notifyStopAndSaveComplete).toHaveBeenCalledTimes(1);
  });
});

it("does not start a second stopAndUpload when stopForClose arrives while stop() itself is still resolving (G4)", async () => {
  // Regression test: inFlightUploadRef used to only get set inside
  // runUpload, which stopAndUpload doesn't reach until AFTER its own
  // `await stop()` has already resolved. A stopForClose arriving during
  // that recorder-flush window saw inFlightUploadRef still null AND status
  // still "recording" (stop() hasn't resolved yet) -- falling through both
  // of handleStopForClose's early-return checks and calling stopAndUpload a
  // SECOND time concurrently, which would call stop() twice and produce a
  // truncated duplicate upload.
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
  let resolveStop: (value: { screen: Blob }) => void = () => {};
  const stopPromise = new Promise<{ screen: Blob }>((resolve) => {
    resolveStop = resolve;
  });
  const stop = vi.fn().mockReturnValue(stopPromise);
  mockHook({ status: "recording", record, stop, error: null });

  let resolveFetch: (value: unknown) => void = () => {};
  const fetchPromise = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(fetchPromise));

  const { container } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];
  fireEvent.click(recordButton); // manual stop -> stopAndUpload() -> await stop() (still pending)

  // Status is STILL "recording" (no rerender -- stop() hasn't resolved, the
  // hook's own state hasn't changed) when stopForClose arrives.
  commandCallback?.("stopForClose");
  await act(() => Promise.resolve());

  // Must not have started a second stop -- inFlightUploadRef was already
  // set synchronously when the manual click called stopAndUpload(), before
  // stop() itself even began resolving.
  expect(stop).toHaveBeenCalledTimes(1);
  expect(notifyStopAndSaveComplete).not.toHaveBeenCalled();

  resolveStop({ screen: new Blob(["x"]) });
  await waitFor(() => {
    expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  resolveFetch({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ job_id: "job-1", session_id: "session-1" }),
  });

  // Exactly one ack -- both the manual click's stopAndUpload and the
  // stopForClose command are waiting on the SAME in-flight operation, whose
  // own finally sends the single ack for both.
  await waitFor(() => {
    expect(notifyStopAndSaveComplete).toHaveBeenCalledTimes(1);
  });
});

it("double-clicking Stop while the recorder is still flushing only uploads once (1B)", async () => {
  // Regression test: clicking Stop twice in quick succession before React
  // re-renders (status closure still "recording") used to call
  // stopAndUpload() -> stop() twice, producing two POST /process calls (one
  // truncated). inFlightUploadRef is set synchronously by the first call's
  // trackInFlight, so the second click's guard must bail before starting a
  // second span.
  const record = vi.fn().mockResolvedValue(undefined);
  let resolveStop: (value: { screen: Blob }) => void = () => {};
  const stopPromise = new Promise<{ screen: Blob }>((resolve) => {
    resolveStop = resolve;
  });
  const stop = vi.fn().mockReturnValue(stopPromise);
  mockHook({ status: "recording", record, stop, error: null });

  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ job_id: "job-1", session_id: "session-1" }),
  });
  vi.stubGlobal("fetch", fetchMock);

  const { container } = render(<RailApp />);
  const recordButton = container.querySelectorAll("button")[0];

  fireEvent.click(recordButton); // click 1: stopAndUpload() -> stop() (still pending)
  fireEvent.click(recordButton); // click 2 (double-click): must bail immediately

  expect(stop).toHaveBeenCalledTimes(1);

  resolveStop({ screen: new Blob(["x"]) });

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it("pushes hasPendingUpload:true after a failed upload and false again once a retry succeeds (G3)", async () => {
  const pushRailStatus = vi.fn();
  vi.stubGlobal("windowControls", { pushRailStatus, onRailCommand: vi.fn(() => () => {}) });

  const record = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue({ screen: new Blob(["x"]) });
  mockHook({ status: "recording", record, stop, error: null });

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("boom") })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: "job-1", session_id: "session-1" }),
    });
  vi.stubGlobal("fetch", fetchMock);

  const { container, getByRole } = render(<RailApp />);
  fireEvent.click(container.querySelectorAll("button")[0]);

  await waitFor(() => {
    expect(pushRailStatus).toHaveBeenCalledWith(expect.objectContaining({ hasPendingUpload: true }));
  });

  fireEvent.click(getByRole("button", { name: "retry upload" }));

  await waitFor(() => {
    expect(pushRailStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ hasPendingUpload: false })
    );
  });
});

it("retryUploadForClose command re-POSTs the pending upload and acks once it resolves (G3)", async () => {
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
  const stop = vi.fn().mockResolvedValue({ screen: new Blob(["x"]) });
  mockHook({ status: "recording", record, stop, error: null });

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("boom") })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: "job-1", session_id: "session-1" }),
    });
  vi.stubGlobal("fetch", fetchMock);

  const { container } = render(<RailApp />);
  fireEvent.click(container.querySelectorAll("button")[0]); // manual stop -> failed upload

  // stopAndUpload acks unconditionally on its own exit (success or
  // failure) -- one ack already happened for that completed operation
  // before the retry command below starts a second, independent one.
  await waitFor(() => expect(notifyStopAndSaveComplete).toHaveBeenCalledTimes(1));

  commandCallback?.("retryUploadForClose");

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(notifyStopAndSaveComplete).toHaveBeenCalledTimes(2));

  const [firstCall, secondCall] = fetchMock.mock.calls;
  expect((firstCall[1].body as FormData).get("screen")).toBe(
    (secondCall[1].body as FormData).get("screen")
  );
});

it("retryUploadForClose acks immediately without fetching when nothing is pending (G3)", () => {
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
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mockHook({ status: "idle" });

  render(<RailApp />);
  commandCallback?.("retryUploadForClose");

  expect(fetchMock).not.toHaveBeenCalled();
  expect(notifyStopAndSaveComplete).toHaveBeenCalledTimes(1);
});

it("retryUploadForClose waits for (and does not double-ack) an already in-flight upload (G3)", async () => {
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
  const stop = vi.fn().mockResolvedValue({ screen: new Blob(["x"]) });

  let resolveFetch: (value: unknown) => void = () => {};
  const fetchPromise = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(fetchPromise));

  mockHook({ status: "recording", record, stop, error: null });

  const { container } = render(<RailApp />);
  fireEvent.click(container.querySelectorAll("button")[0]); // manual stop -> upload in flight

  await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

  commandCallback?.("retryUploadForClose");

  // Must not ack while the original (in-flight) upload is still pending --
  // that upload's own finally already owns the single ack for it.
  await act(() => Promise.resolve());
  expect(notifyStopAndSaveComplete).not.toHaveBeenCalled();

  resolveFetch({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ job_id: "job-1", session_id: "session-1" }),
  });

  await waitFor(() => {
    expect(notifyStopAndSaveComplete).toHaveBeenCalledTimes(1);
  });
});

it("handleRetryUpload guards against retryUploadForClose racing it in the same tick (no double-submit)", async () => {
  let commandCallback: ((action: string) => void) | undefined;
  const onRailCommand = vi.fn((cb: (action: string) => void) => {
    commandCallback = cb;
    return () => {};
  });
  const notifyStopAndSaveComplete = vi.fn();
  const pushRailStatus = vi.fn();
  vi.stubGlobal("windowControls", { pushRailStatus, onRailCommand, notifyStopAndSaveComplete });

  const record = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue({ screen: new Blob(["x"]) });
  mockHook({ status: "recording", record, stop, error: null });

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("boom") })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: "job-1", session_id: "session-1" }),
    });
  vi.stubGlobal("fetch", fetchMock);

  const { container, getByRole } = render(<RailApp />);
  fireEvent.click(container.querySelectorAll("button")[0]); // manual stop -> failed upload

  const retryButton = await waitFor(() => getByRole("button", { name: "retry upload" }));

  // retryUploadForClose fires first and sets inFlightUploadRef synchronously
  // via trackInFlight, in the same tick as the button click below -- before
  // React re-renders isProcessing. handleRetryUpload's guard must check that
  // ref (not the stale isProcessing state) to see the upload already
  // in-flight and bail, instead of double-POSTing the same FormData.
  commandCallback?.("retryUploadForClose");
  fireEvent.click(retryButton);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  // Give a wrongly-fired third POST a chance to happen before asserting it didn't.
  await act(() => Promise.resolve());
  expect(fetchMock).toHaveBeenCalledTimes(2);
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

it("starts only one recording when Record is clicked again while the first-run consent notice is still pending", async () => {
  // Regression: handleRecordClick only checked the (stale) status==="idle"
  // closure value, and the button stayed enabled during the consent wait --
  // main.js chains pending consent promises, so both clicks resolved true
  // and record() ran twice, orphaning the first set of MediaStreams.
  let resolveConsent!: (value: boolean) => void;
  const ensureRecordingConsent = vi.fn(
    () => new Promise<boolean>((resolve) => { resolveConsent = resolve; })
  );
  vi.stubGlobal("consentAPI", { ensureRecordingConsent });
  const record = vi.fn().mockResolvedValue(undefined);
  mockHook({ status: "idle", record });

  const { getByLabelText } = render(<RailApp />);
  const recordButton = getByLabelText("Start recording");
  fireEvent.click(recordButton);
  // Same tick, before any re-render -- only the ref guard can catch this one.
  fireEvent.click(recordButton);

  await waitFor(() => expect(recordButton).toBeDisabled());
  fireEvent.click(recordButton);

  await act(async () => {
    resolveConsent(true);
  });

  await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
  expect(ensureRecordingConsent).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(recordButton).not.toBeDisabled());
});

it("ignores a second toggleRecord command that arrives while the first is still starting", async () => {
  let commandCallback: ((action: string) => void) | undefined;
  const onRailCommand = vi.fn((cb: (action: string) => void) => {
    commandCallback = cb;
    return () => {};
  });
  vi.stubGlobal("windowControls", { pushRailStatus: vi.fn(), onRailCommand });
  let resolveRecord!: () => void;
  const record = vi.fn(() => new Promise<void>((resolve) => { resolveRecord = resolve; }));
  mockHook({ status: "idle", record });

  render(<RailApp />);
  commandCallback?.("toggleRecord");
  await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
  // record() hasn't settled and the mocked status is still "idle".
  commandCallback?.("toggleRecord");
  await act(() => Promise.resolve());
  expect(record).toHaveBeenCalledTimes(1);

  await act(async () => resolveRecord());
});

it("keeps an earlier failed upload queued when a later recording uploads successfully, and retry re-POSTs it", async () => {
  // Regression: pendingUploadRef held a single FormData, so recording B's
  // successful upload nulled it and recording A was silently lost.
  const pushRailStatus = vi.fn();
  vi.stubGlobal("windowControls", { pushRailStatus, onRailCommand: vi.fn(() => () => {}) });

  const screenA = new Blob(["recording A"]);
  const screenB = new Blob(["recording B"]);
  const stop = vi.fn()
    .mockResolvedValueOnce({ screen: screenA })
    .mockResolvedValueOnce({ screen: screenB });
  mockHook({ status: "recording", stop, error: null });

  const ok = (jobId: string) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ job_id: jobId, session_id: "s" }),
  });
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("A failed") })
    .mockResolvedValueOnce(ok("job-b"))
    .mockResolvedValueOnce(ok("job-a"));
  vi.stubGlobal("fetch", fetchMock);

  const { container, getByRole } = render(<RailApp />);
  fireEvent.click(container.querySelectorAll("button")[0]); // A -> fails
  await waitFor(() => getByRole("button", { name: "retry upload" }));

  fireEvent.click(container.querySelectorAll("button")[0]); // B -> succeeds
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(container.querySelectorAll("button")[0]).not.toBeDisabled());

  // A is still pending: its error, retry action and close-guard flag all remain.
  expect(container.querySelector("span[title]")).toHaveAttribute("title", "A failed");
  expect(pushRailStatus).toHaveBeenLastCalledWith(expect.objectContaining({ hasPendingUpload: true }));

  fireEvent.click(getByRole("button", { name: "retry upload" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(await ((fetchMock.mock.calls[2][1].body as FormData).get("screen") as File).text()).toBe("recording A");

  await waitFor(() => {
    expect(pushRailStatus).toHaveBeenLastCalledWith(expect.objectContaining({ hasPendingUpload: false }));
  });
});

it("queues both recordings when two uploads fail in a row, and retry re-POSTs each, oldest first", async () => {
  // Regression: the second failure used to overwrite the first's FormData.
  vi.stubGlobal("windowControls", { pushRailStatus: vi.fn(), onRailCommand: vi.fn(() => () => {}) });

  const screenA = new Blob(["recording A"]);
  const screenB = new Blob(["recording B"]);
  const stop = vi.fn()
    .mockResolvedValueOnce({ screen: screenA })
    .mockResolvedValueOnce({ screen: screenB });
  mockHook({ status: "recording", stop, error: null });

  const ok = { ok: true, status: 200, json: () => Promise.resolve({ job_id: "j", session_id: "s" }) };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("A failed") })
    .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("B failed") })
    .mockResolvedValue(ok);
  vi.stubGlobal("fetch", fetchMock);

  const { container, getByRole, queryByRole } = render(<RailApp />);
  fireEvent.click(container.querySelectorAll("button")[0]);
  await waitFor(() => getByRole("button", { name: "retry upload" }));
  fireEvent.click(container.querySelectorAll("button")[0]);

  await waitFor(() => {
    expect(container.querySelector("span[title]")).toHaveAttribute(
      "title",
      "2 recordings failed to upload: B failed"
    );
  });

  fireEvent.click(getByRole("button", { name: "retry upload" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  expect(await ((fetchMock.mock.calls[2][1].body as FormData).get("screen") as File).text()).toBe("recording A");
  expect(await ((fetchMock.mock.calls[3][1].body as FormData).get("screen") as File).text()).toBe("recording B");
  await waitFor(() => expect(queryByRole("button", { name: "retry upload" })).toBeNull());
});

it("names each uploaded file after its blob's real container (e.g. an ogg mic track isn't sent as .webm)", async () => {
  const stop = vi.fn().mockResolvedValue({
    screen: new Blob(["v"], { type: "video/webm;codecs=vp9" }),
    micAudio: new Blob(["a"], { type: "audio/ogg;codecs=opus" }),
  });
  mockHook({ status: "recording", stop, error: null });
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ job_id: "j", session_id: "s" }),
  });
  vi.stubGlobal("fetch", fetchMock);

  const { container } = render(<RailApp />);
  fireEvent.click(container.querySelectorAll("button")[0]);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const body = fetchMock.mock.calls[0][1].body as FormData;
  expect((body.get("screen") as File).name).toBe("screen.webm");
  expect((body.get("mic") as File).name).toBe("mic.ogg");
});

it("acks a stopForClose whose upload fails with hasPendingUpload: true, read at ack time (not from the later status push)", async () => {
  // Regression: main.js used to read hasPendingUpload only from the
  // rail:pushStatus copy, which the effect sends a re-render AFTER this ack
  // -- so a failed stop-for-close upload looked like "nothing pending" and
  // the close destroyed the recording without the Retry/Discard dialog.
  let commandCallback: ((action: string) => void) | undefined;
  const onRailCommand = vi.fn((cb: (action: string) => void) => {
    commandCallback = cb;
    return () => {};
  });
  const pushRailStatus = vi.fn();
  let pushedHasPendingAtAck: boolean | undefined;
  const notifyStopAndSaveComplete = vi.fn(() => {
    pushedHasPendingAtAck = pushRailStatus.mock.calls.at(-1)?.[0]?.hasPendingUpload;
  });
  vi.stubGlobal("windowControls", { pushRailStatus, onRailCommand, notifyStopAndSaveComplete });

  const stop = vi.fn().mockResolvedValue({ screen: new Blob(["x"]) });
  mockHook({ status: "recording", stop, error: null });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("boom") })
  );

  render(<RailApp />);
  commandCallback?.("stopForClose");

  await waitFor(() => expect(notifyStopAndSaveComplete).toHaveBeenCalledTimes(1));
  expect(notifyStopAndSaveComplete).toHaveBeenCalledWith({ hasPendingUpload: true });
  // Proves the ack couldn't have relied on the status push: at ack time the
  // last push still said false.
  expect(pushedHasPendingAtAck).toBe(false);
});

it("acks with hasPendingUpload: false when a stopForClose upload succeeds and nothing else is queued", async () => {
  let commandCallback: ((action: string) => void) | undefined;
  const onRailCommand = vi.fn((cb: (action: string) => void) => {
    commandCallback = cb;
    return () => {};
  });
  const notifyStopAndSaveComplete = vi.fn();
  vi.stubGlobal("windowControls", { pushRailStatus: vi.fn(), onRailCommand, notifyStopAndSaveComplete });

  const stop = vi.fn().mockResolvedValue({ screen: new Blob(["x"]) });
  mockHook({ status: "recording", stop, error: null });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: "j", session_id: "s" }),
    })
  );

  render(<RailApp />);
  commandCallback?.("stopForClose");

  await waitFor(() => expect(notifyStopAndSaveComplete).toHaveBeenCalledWith({ hasPendingUpload: false }));
});

// ---------- retry upload while a new recording is live ----------

function setupRetryWhileRecording() {
  let commandCallback: ((action: string) => void) | undefined;
  const onRailCommand = vi.fn((cb: (action: string) => void) => {
    commandCallback = cb;
    return () => {};
  });
  const notifyStopAndSaveComplete = vi.fn();
  const pushRailStatus = vi.fn();
  vi.stubGlobal("windowControls", { pushRailStatus, onRailCommand, notifyStopAndSaveComplete });

  // Status stays "recording": after the first (failed) upload the user has
  // started a NEW recording.
  const stop = vi.fn().mockResolvedValue({ screen: new Blob(["x"]) });
  mockHook({ status: "recording", stop, error: null });

  let resolveRetry!: (v: unknown) => void;
  const fetchMock = vi
    .fn()
    // 1: first recording's upload fails
    .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("boom") })
    // 2: the manual retry of it -- held until the test releases it
    .mockReturnValueOnce(new Promise((resolve) => { resolveRetry = resolve; }))
    // 3: the live recording's upload, once stopped for the close
    .mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: "job-2", session_id: "session-2" }),
    });
  vi.stubGlobal("fetch", fetchMock);
  return {
    stop, fetchMock, notifyStopAndSaveComplete, pushRailStatus,
    command: (a: string) => commandCallback?.(a),
    releaseRetry: () =>
      resolveRetry({ ok: true, status: 200, json: () => Promise.resolve({ job_id: "job-1", session_id: "session-1" }) }),
  };
}

it("a quit during a manual retry still stops and uploads the live recording, then acks once", async () => {
  const t = setupRetryWhileRecording();
  const { container, getByRole } = render(<RailApp />);
  fireEvent.click(container.querySelectorAll("button")[0]); // stop #1 -> upload fails
  fireEvent.click(await waitFor(() => getByRole("button", { name: "retry upload" })));
  await waitFor(() => expect(t.fetchMock).toHaveBeenCalledTimes(2)); // retry in flight
  t.notifyStopAndSaveComplete.mockClear(); // the first (failed) stop's own ack

  t.command("stopForClose");
  await act(() => Promise.resolve());
  // Waits for the retry: nothing acked, the live recording not stopped yet.
  expect(t.notifyStopAndSaveComplete).not.toHaveBeenCalled();
  expect(t.stop).toHaveBeenCalledTimes(1);

  await act(async () => {
    t.releaseRetry();
  });

  // Then stops the live recording, uploads it, and acks exactly once.
  await waitFor(() => expect(t.stop).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(t.fetchMock).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(t.notifyStopAndSaveComplete).toHaveBeenCalledTimes(1));
  expect(t.notifyStopAndSaveComplete).toHaveBeenCalledWith({ hasPendingUpload: false });
});

it("a manual retry doesn't ack main by itself (only a close handoff's own handler does)", async () => {
  const t = setupRetryWhileRecording();
  const { container, getByRole } = render(<RailApp />);
  fireEvent.click(container.querySelectorAll("button")[0]);
  fireEvent.click(await waitFor(() => getByRole("button", { name: "retry upload" })));
  t.notifyStopAndSaveComplete.mockClear(); // the failed stop's own ack
  await act(async () => {
    t.releaseRetry();
  });
  await waitFor(() => expect(t.fetchMock).toHaveBeenCalledTimes(2));
  await act(() => Promise.resolve());
  expect(t.notifyStopAndSaveComplete).not.toHaveBeenCalled();
});

it("a retry upload in flight doesn't block stopping the live recording", async () => {
  const t = setupRetryWhileRecording();
  const { container, getByRole, getByLabelText } = render(<RailApp />);
  fireEvent.click(container.querySelectorAll("button")[0]);
  fireEvent.click(await waitFor(() => getByRole("button", { name: "retry upload" })));
  await waitFor(() => expect(t.fetchMock).toHaveBeenCalledTimes(2));

  const stopButton = getByLabelText("Stop recording");
  expect(stopButton).toBeEnabled();
  fireEvent.click(stopButton);

  await waitFor(() => expect(t.stop).toHaveBeenCalledTimes(2));
});

it("a 'retryUpload' command (from the docked pill) retries the pending upload", async () => {
  const t = setupRetryWhileRecording();
  const { container, getByRole } = render(<RailApp />);
  fireEvent.click(container.querySelectorAll("button")[0]);
  await waitFor(() => getByRole("button", { name: "retry upload" }));

  t.command("retryUpload");

  await waitFor(() => expect(t.fetchMock).toHaveBeenCalledTimes(2));
});

it("pushes the error kind along with the message, so the docked pill can offer an action", async () => {
  const t = setupRetryWhileRecording();
  const { container } = render(<RailApp />);
  fireEvent.click(container.querySelectorAll("button")[0]);
  await waitFor(() =>
    expect(t.pushRailStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ recordErrorKind: "generic", hasPendingUpload: true })
    )
  );
});
