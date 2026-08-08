// src/ui/components/Sidebar.test.tsx
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Sidebar from "./Sidebar";
import {
  getSessions,
  trashSession,
  renameSession,
  listJobs,
  getJobStatus,
  type Session,
} from "../api";

vi.mock("../api");

beforeEach(() => {
  vi.mocked(listJobs).mockResolvedValue([]);
});

const sessionA: Session = {
  id: "a1",
  created_at: "2026-08-01T00:00:00Z",
  title: "Sprint Planning",
  notes: "notes",
  video_path: "x",
  trashed_at: null,
};
const sessionB: Session = { ...sessionA, id: "b2", title: "Retro" };

function renderSidebar(overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
  const props: ComponentProps<typeof Sidebar> = {
    active: true,
    collapsed: false,
    sessions: [sessionA, sessionB],
    sessionsError: null,
    reloadSessions: vi.fn(),
    selectedId: null,
    onSelect: vi.fn(),
    ...overrides,
  };
  const result = render(<Sidebar {...props} />);
  return { ...props, container: result.container };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("lists sessions and calls onSelect when a row is clicked", () => {
  const props = renderSidebar();
  fireEvent.click(screen.getByText("Sprint Planning"));
  expect(props.onSelect).toHaveBeenCalledWith("a1");
});

it("highlights the selected session", () => {
  renderSidebar({ selectedId: "b2" });
  const retroButton = screen.getByText("Retro").closest("button");
  expect(retroButton?.className).toContain("border-signal");
});

it("filters by search query", () => {
  renderSidebar();
  fireEvent.change(screen.getByLabelText("Search meetings"), { target: { value: "retro" } });
  expect(screen.queryByText("Sprint Planning")).not.toBeInTheDocument();
  expect(screen.getByText("Retro")).toBeInTheDocument();
});

it("right-click opens the context menu; trash calls trashSession and reloadSessions", async () => {
  vi.mocked(trashSession).mockResolvedValue({ ...sessionA, trashed_at: "2026-08-03T00:00:00Z" });
  const props = renderSidebar();

  fireEvent.contextMenu(screen.getByText("Sprint Planning"));
  // The sidebar's own [active]/[trash] view-toggle button also renders the
  // literal text "[trash]", so once the context menu is open there are two
  // matches. Document order places the toggle before the context menu, so
  // the second match is the menu's action button.
  fireEvent.click(screen.getAllByText("[trash]")[1]);

  await waitFor(() => expect(trashSession).toHaveBeenCalledWith("a1"));
  expect(props.reloadSessions).toHaveBeenCalled();
});

it("right-click rename switches the row to an inline input and commits on Enter", async () => {
  vi.mocked(renameSession).mockResolvedValue({ ...sessionA, title: "Renamed" });
  const props = renderSidebar();

  fireEvent.contextMenu(screen.getByText("Sprint Planning"));
  fireEvent.click(screen.getByText("[rename]"));

  const input = screen.getByDisplayValue("Sprint Planning");
  fireEvent.change(input, { target: { value: "Renamed" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => expect(renameSession).toHaveBeenCalledWith("a1", "Renamed"));
  expect(props.reloadSessions).toHaveBeenCalled();
});

it("renders with zero width when collapsed", () => {
  const { container } = renderSidebar({ collapsed: true });
  const outer = container.firstElementChild;
  expect(outer?.className).toContain("w-0");
});

it("switching to the trash view fetches trashed sessions separately", async () => {
  vi.mocked(getSessions).mockResolvedValue([
    sessionA,
    { ...sessionB, trashed_at: "2026-08-02T00:00:00Z" },
  ]);
  renderSidebar();

  fireEvent.click(screen.getByText("[trash]"));

  expect(await screen.findByText("Retro")).toBeInTheDocument();
  expect(screen.queryByText("Sprint Planning")).not.toBeInTheDocument();
  expect(getSessions).toHaveBeenCalledWith(true);
});

it("shows a processing row for an active job and reloads sessions once it finishes", async () => {
  vi.useFakeTimers();
  vi.mocked(listJobs).mockResolvedValue([
    {
      id: "job-1",
      session_id: "s1",
      status: "running",
      stage: "transcribing",
      error: null,
      notes: null,
      video_path: null,
      created_at: "2026-08-06T00:00:00Z",
    },
  ]);
  const props = renderSidebar();

  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByText("processing — transcribing")).toBeInTheDocument();

  vi.mocked(getJobStatus).mockResolvedValue({
    id: "job-1",
    session_id: "s1",
    status: "done",
    stage: null,
    error: null,
    notes: "x",
    video_path: "v",
    created_at: "2026-08-06T00:00:00Z",
  });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });

  expect(props.reloadSessions).toHaveBeenCalled();
  expect(screen.queryByText(/processing/)).not.toBeInTheDocument();
});

it("trash-view rows are not clickable and carry no onSelect affordance", async () => {
  vi.mocked(getSessions).mockResolvedValue([
    { ...sessionA, trashed_at: "2026-08-02T00:00:00Z" },
  ]);
  const props = renderSidebar();

  fireEvent.click(screen.getByText("[trash]"));
  const row = await screen.findByText("Sprint Planning");

  expect(row.closest("button")).toBeNull();
  fireEvent.click(row);
  expect(props.onSelect).not.toHaveBeenCalled();
});
