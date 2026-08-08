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
