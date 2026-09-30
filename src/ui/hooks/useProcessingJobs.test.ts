import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useProcessingJobs } from "./useProcessingJobs";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    listJobs: vi.fn(),
    getJobStatus: vi.fn(),
  };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("starts with an empty job list when listJobs returns none", async () => {
  vi.mocked(api.listJobs).mockResolvedValue([]);

  const { result } = renderHook(() => useProcessingJobs());
  await waitFor(() => expect(api.listJobs).toHaveBeenCalled());

  expect(result.current.jobs).toEqual([]);
});

it("rehydrates active jobs from listJobs on mount", async () => {
  vi.mocked(api.listJobs).mockResolvedValue([
    {
      id: "job-1", session_id: "s1", status: "running", stage: "transcribing",
      error: null, notes: null, video_path: null, created_at: "2026-08-06T00:00:00Z",
    },
    {
      id: "job-2", session_id: "s2", status: "done", stage: null,
      error: null, notes: "x", video_path: "v", created_at: "2026-08-06T00:00:01Z",
    },
  ]);

  const { result } = renderHook(() => useProcessingJobs());

  await waitFor(() => {
    expect(result.current.jobs).toEqual([
      { id: "job-1", stage: "transcribing", status: "running", error: null },
    ]);
  });
});

it("preserves a job added via addJob while listJobs is still in flight", async () => {
  let resolveListJobs!: (value: Awaited<ReturnType<typeof api.listJobs>>) => void;
  vi.mocked(api.listJobs).mockReturnValue(
    new Promise((resolve) => {
      resolveListJobs = resolve;
    })
  );

  const { result } = renderHook(() => useProcessingJobs());

  act(() => {
    result.current.addJob("local-job");
  });
  expect(result.current.jobs).toEqual([
    { id: "local-job", stage: null, status: "queued", error: null },
  ]);

  await act(async () => {
    resolveListJobs([
      {
        id: "server-job", session_id: "s1", status: "running", stage: "transcribing",
        error: null, notes: null, video_path: null, created_at: "2026-08-06T00:00:00Z",
      },
    ]);
    await Promise.resolve();
  });

  await waitFor(() => {
    const ids = result.current.jobs.map((j) => j.id).sort();
    expect(ids).toEqual(["local-job", "server-job"]);
  });
});

it("addJob appends a queued job immediately", async () => {
  vi.mocked(api.listJobs).mockResolvedValue([]);

  const { result } = renderHook(() => useProcessingJobs());
  await waitFor(() => expect(api.listJobs).toHaveBeenCalled());

  act(() => {
    result.current.addJob("job-1");
  });

  expect(result.current.jobs).toEqual([
    { id: "job-1", stage: null, status: "queued", error: null },
  ]);
});

it("polls getJobStatus for active jobs and updates their stage", async () => {
  vi.useFakeTimers();
  vi.mocked(api.listJobs).mockResolvedValue([]);
  vi.mocked(api.getJobStatus).mockResolvedValue({
    id: "job-1", session_id: "s1", status: "running", stage: "summarizing",
    error: null, notes: null, video_path: null, created_at: "2026-08-06T00:00:00Z",
  });

  const { result } = renderHook(() => useProcessingJobs());
  await act(async () => {
    await Promise.resolve();
  });

  act(() => {
    result.current.addJob("job-1");
  });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });

  expect(result.current.jobs).toEqual([
    { id: "job-1", stage: "summarizing", status: "running", error: null },
  ]);
});

it("marks a job failed with a lost-track error only after 5 consecutive rejected polls", async () => {
  vi.useFakeTimers();
  vi.mocked(api.listJobs).mockResolvedValue([]);
  vi.mocked(api.getJobStatus).mockRejectedValue(new Error("Failed to fetch job status: 404"));

  const { result } = renderHook(() => useProcessingJobs());
  await act(async () => {
    await Promise.resolve();
  });

  act(() => {
    result.current.addJob("job-1");
  });

  // 4 consecutive failed polls: still tracked as running, not yet lost.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500 * 4);
  });
  expect(result.current.jobs).toEqual([
    { id: "job-1", stage: null, status: "queued", error: null },
  ]);

  // 5th consecutive failure crosses the threshold.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(result.current.jobs).toEqual([
    {
      id: "job-1",
      stage: null,
      status: "failed",
      error: "Lost track of this recording — the app backend restarted while it was processing.",
    },
  ]);
});

it("tolerates a transient poll failure and keeps the job running once a later poll succeeds", async () => {
  vi.useFakeTimers();
  vi.mocked(api.listJobs).mockResolvedValue([]);
  vi.mocked(api.getJobStatus)
    .mockRejectedValueOnce(new Error("Failed to fetch job status: network error"))
    .mockRejectedValueOnce(new Error("Failed to fetch job status: network error"))
    .mockResolvedValue({
      id: "job-1", session_id: "s1", status: "running", stage: "summarizing",
      error: null, notes: null, video_path: null, created_at: "2026-08-06T00:00:00Z",
    });

  const { result } = renderHook(() => useProcessingJobs());
  await act(async () => {
    await Promise.resolve();
  });

  act(() => {
    result.current.addJob("job-1");
  });

  // Two failures, well under the 5-failure threshold, then a success.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500 * 3);
  });

  expect(result.current.jobs).toEqual([
    { id: "job-1", stage: "summarizing", status: "running", error: null },
  ]);

  // The failure counter reset on that success -- two more failures now
  // shouldn't be anywhere near enough to declare it lost.
  vi.mocked(api.getJobStatus).mockRejectedValue(new Error("Failed to fetch job status: network error"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500 * 2);
  });
  expect(result.current.jobs).toEqual([
    { id: "job-1", stage: "summarizing", status: "running", error: null },
  ]);
});

it("does not count failed polls toward the lost-track threshold while the backend lifecycle reports restarting", async () => {
  vi.useFakeTimers();
  let statusListener: ((status: BackendStatus) => void) | null = null;
  vi.stubGlobal("backendAPI", {
    onStatus: (cb: (status: BackendStatus) => void) => {
      statusListener = cb;
      return () => {
        statusListener = null;
      };
    },
    restart: vi.fn(),
  });

  vi.mocked(api.listJobs).mockResolvedValue([]);
  vi.mocked(api.getJobStatus).mockRejectedValue(new Error("Failed to fetch job status: network error"));

  const { result } = renderHook(() => useProcessingJobs());
  await act(async () => {
    await Promise.resolve();
  });
  act(() => statusListener?.({ state: "restarting", attempt: 1, maxAttempts: 3 }));

  act(() => {
    result.current.addJob("job-1");
  });

  // Far more than 5 failed polls, but they're all paused (not counted)
  // while the backend is known to be restarting.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500 * 10);
  });

  expect(result.current.jobs).toEqual([
    { id: "job-1", stage: null, status: "queued", error: null },
  ]);
});

it("removeJob drops a job from the list", async () => {
  vi.mocked(api.listJobs).mockResolvedValue([]);

  const { result } = renderHook(() => useProcessingJobs());
  await waitFor(() => expect(api.listJobs).toHaveBeenCalled());

  act(() => {
    result.current.addJob("job-1");
  });
  expect(result.current.jobs).toHaveLength(1);

  act(() => {
    result.current.removeJob("job-1");
  });
  expect(result.current.jobs).toEqual([]);
});

const runningJob = (id: string) => ({
  id, session_id: "s", status: "running" as const, stage: "transcribing" as const,
  error: null, notes: null, video_path: null, created_at: "2026-08-06T00:00:00Z",
});

it("skips poll ticks while the previous poll is still in flight (hung backend)", async () => {
  vi.useFakeTimers();
  vi.mocked(api.listJobs).mockReturnValue(new Promise(() => {}));

  renderHook(() => useProcessingJobs());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500 * 4);
  });

  // Without the in-flight guard this was 5 requests, all still pending.
  expect(api.listJobs).toHaveBeenCalledTimes(1);
});

it("puts a deadline on every poll request", async () => {
  vi.mocked(api.listJobs).mockResolvedValue([runningJob("job-1")]);
  vi.mocked(api.getJobStatus).mockResolvedValue(runningJob("job-1"));

  renderHook(() => useProcessingJobs());

  // Tracked jobs are refreshed from the second tick on (1.5s).
  await waitFor(() => expect(api.getJobStatus).toHaveBeenCalled(), { timeout: 3000 });
  expect(vi.mocked(api.listJobs).mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  expect(vi.mocked(api.getJobStatus).mock.calls[0][1]).toBeInstanceOf(AbortSignal);
});

it("addJob doesn't duplicate a job discovery already found", async () => {
  vi.mocked(api.listJobs).mockResolvedValue([runningJob("job-1")]);
  vi.mocked(api.getJobStatus).mockResolvedValue(runningJob("job-1"));

  const { result } = renderHook(() => useProcessingJobs());
  await waitFor(() => expect(result.current.jobs).toHaveLength(1));

  act(() => result.current.addJob("job-1"));

  expect(result.current.jobs.map((j) => j.id)).toEqual(["job-1"]);
});

it("a late listJobs response can't re-add a job that was already removed", async () => {
  let resolveListJobs!: (value: Awaited<ReturnType<typeof api.listJobs>>) => void;
  vi.mocked(api.listJobs).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveListJobs = resolve;
    })
  );
  vi.mocked(api.listJobs).mockResolvedValue([]);

  const { result } = renderHook(() => useProcessingJobs());
  act(() => result.current.addJob("job-1"));
  act(() => result.current.removeJob("job-1"));

  await act(async () => {
    // Snapshotted before the job finished, so it still says "running".
    resolveListJobs([runningJob("job-1")]);
    await Promise.resolve();
  });

  expect(result.current.jobs).toEqual([]);
});
