import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSessions } from "./useSessions";
import { getSessions, type Session } from "../api";

vi.mock("../api");

const sessionA: Session = {
  id: "a1",
  created_at: "2026-08-01T00:00:00Z",
  title: "Sprint Planning",
  notes: "notes",
  video_path: "x",
  trashed_at: null,
};

const trashedSession: Session = {
  id: "t1",
  created_at: "2026-08-01T00:00:00Z",
  title: "Old Standup",
  notes: "notes",
  video_path: "x",
  trashed_at: "2026-08-02T00:00:00Z",
};

afterEach(() => {
  vi.clearAllMocks();
});

it("does not fetch while inactive", async () => {
  vi.mocked(getSessions).mockResolvedValue([sessionA]);
  renderHook(() => useSessions(false, false));
  await new Promise((r) => setTimeout(r, 0));
  expect(getSessions).not.toHaveBeenCalled();
});

it("fetches on mount when active and includeTrashed is false", async () => {
  vi.mocked(getSessions).mockResolvedValue([sessionA]);
  const { result } = renderHook(() => useSessions(true, false));
  await waitFor(() => expect(result.current.sessions).toEqual([sessionA]));
  expect(getSessions).toHaveBeenCalledWith(false);
});

it("filters to trashed-only when includeTrashed is true", async () => {
  vi.mocked(getSessions).mockResolvedValue([sessionA, trashedSession]);
  const { result } = renderHook(() => useSessions(true, true));
  await waitFor(() => expect(result.current.sessions).toEqual([trashedSession]));
  expect(getSessions).toHaveBeenCalledWith(true);
});

it("sets error on failure", async () => {
  vi.mocked(getSessions).mockRejectedValue(new Error("boom"));
  const { result } = renderHook(() => useSessions(true, false));
  await waitFor(() => expect(result.current.error).toBe("boom"));
  expect(result.current.sessions).toBeNull();
});

it("reload() re-fetches", async () => {
  vi.mocked(getSessions).mockResolvedValue([sessionA]);
  const { result } = renderHook(() => useSessions(true, false));
  await waitFor(() => expect(result.current.sessions).toEqual([sessionA]));

  vi.mocked(getSessions).mockResolvedValue([sessionA, { ...sessionA, id: "a2" }]);
  await act(async () => {
    result.current.reload();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(result.current.sessions).toHaveLength(2);
});

it("ignores a stale reload() response that resolves after a newer one already landed (brief 13 #13)", async () => {
  // Regression test: two rapid reload() calls can resolve out of order
  // over the network -- the SECOND (newer) request might resolve first,
  // and without a request-id guard the FIRST (now-stale) request's
  // response landing afterward would overwrite the fresh list with
  // out-of-date data.
  vi.mocked(getSessions).mockResolvedValue([sessionA]);
  const { result } = renderHook(() => useSessions(true, false));
  await waitFor(() => expect(result.current.sessions).toEqual([sessionA]));

  let resolveFirst!: (data: Session[]) => void;
  let resolveSecond!: (data: Session[]) => void;
  const first = new Promise<Session[]>((resolve) => (resolveFirst = resolve));
  const second = new Promise<Session[]>((resolve) => (resolveSecond = resolve));
  vi.mocked(getSessions).mockReturnValueOnce(first).mockReturnValueOnce(second);

  act(() => {
    result.current.reload(); // fires the stale (first) request
  });
  act(() => {
    result.current.reload(); // fires the fresh (second) request
  });

  // The newer request resolves first...
  await act(async () => {
    resolveSecond([{ ...sessionA, id: "fresh" }]);
    await Promise.resolve();
  });
  expect(result.current.sessions).toEqual([{ ...sessionA, id: "fresh" }]);

  // ...then the stale one resolves late. It must be ignored.
  await act(async () => {
    resolveFirst([{ ...sessionA, id: "stale" }]);
    await Promise.resolve();
  });
  expect(result.current.sessions).toEqual([{ ...sessionA, id: "fresh" }]);
});

it("ignores an in-flight fetch's response once the view goes inactive", async () => {
  let resolveFetch!: (data: Session[]) => void;
  vi.mocked(getSessions).mockReturnValueOnce(
    new Promise<Session[]>((resolve) => (resolveFetch = resolve))
  );

  const { result, rerender } = renderHook(({ active }) => useSessions(active, false), {
    initialProps: { active: true },
  });

  rerender({ active: false });

  await act(async () => {
    resolveFetch([sessionA]);
    await Promise.resolve();
  });

  expect(result.current.sessions).toBeNull();
});
