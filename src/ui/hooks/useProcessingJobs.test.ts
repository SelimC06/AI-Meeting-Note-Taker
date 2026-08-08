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

it("marks a job failed with a lost-track error when getJobStatus rejects (e.g. 404 after backend restart)", async () => {
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
