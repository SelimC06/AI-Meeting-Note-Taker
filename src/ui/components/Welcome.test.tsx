import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import Welcome from "./Welcome";
import type { Session } from "../api";

const NOW = new Date("2026-08-08T12:00:00Z").getTime();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: "id",
    created_at: "2026-08-01T00:00:00Z",
    title: "Untitled",
    notes: "",
    video_path: "x",
    trashed_at: null,
    ...overrides,
  };
}

it("shows the app name, tagline, and tips with no meetings", () => {
  render(<Welcome sessions={[]} />);
  expect(screen.getByText(/deskrecap/i)).toBeInTheDocument();
  expect(screen.getByText(/record.*transcribe.*summarize.*chat/i)).toBeInTheDocument();
  expect(screen.getByText(/click start to open the rail, then hit record/i)).toBeInTheDocument();
  expect(screen.getByText(/select a meeting to ask questions about it/i)).toBeInTheDocument();
  expect(screen.getByText(/ctrl\/cmd\+b toggles the sidebar/i)).toBeInTheDocument();
});

it("shows a no-meetings-yet line in the activity panel when there are no sessions", () => {
  render(<Welcome sessions={[]} />);
  expect(screen.getByText(/no meetings recorded yet/i)).toBeInTheDocument();
});

it("shows singular count and the meeting title for exactly one meeting", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const sessions = [makeSession({ id: "a", title: "Solo Sync", created_at: new Date(NOW - 60_000).toISOString() })];
  render(<Welcome sessions={sessions} />);
  expect(screen.getByText(/1 meeting recorded/i)).toBeInTheDocument();
  expect(screen.getByText(/"Solo Sync"/)).toBeInTheDocument();
  expect(screen.getByText(/1m ago/)).toBeInTheDocument();
});

it("shows plural count and the most recently created meeting, not just the last array element", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const sessions = [
    makeSession({ id: "a", title: "Oldest", created_at: new Date(NOW - 3 * 86_400_000).toISOString() }),
    makeSession({ id: "b", title: "Newest", created_at: new Date(NOW - 60_000).toISOString() }),
    makeSession({ id: "c", title: "Middle", created_at: new Date(NOW - 86_400_000).toISOString() }),
  ];
  render(<Welcome sessions={sessions} />);
  expect(screen.getByText(/3 meetings recorded/i)).toBeInTheDocument();
  expect(screen.getByText(/"Newest"/)).toBeInTheDocument();
  expect(screen.queryByText(/"Oldest"/)).not.toBeInTheDocument();
  expect(screen.queryByText(/"Middle"/)).not.toBeInTheDocument();
});
