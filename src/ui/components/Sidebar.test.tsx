// src/ui/components/Sidebar.test.tsx
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Sidebar from "./Sidebar";
import {
  getSessions,
  trashSession,
  restoreSession,
  deleteSessionForever,
  renameSession,
  listJobs,
  getJobStatus,
  recoverSessionsIndex,
  type Session,
} from "../api";

vi.mock("../api");
vi.mock("./DockedRail", () => ({
  default: () => <div data-testid="docked-rail" />,
}));

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
    view: "active",
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

it("renders the docked rail", () => {
  renderSidebar();
  expect(screen.getByTestId("docked-rail")).toBeInTheDocument();
});

it("badges a failed session with its error as the tooltip, but not a normal done session", () => {
  const failedSession: Session = {
    ...sessionA,
    id: "f1",
    title: "Failed One",
    status: "failed",
    error: "Couldn't combine your audio and video",
  };
  renderSidebar({ sessions: [sessionA, failedSession] });

  expect(screen.queryByRole("img", { name: "Processing failed" })).toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: "Processing failed" })
  ).toHaveAttribute("title", "Processing failed: Couldn't combine your audio and video");
});

it("badges a recovered session distinctly from a failed one", () => {
  const recoveredSession: Session = { ...sessionA, id: "r1", title: "Recovered One", status: "recovered" };
  renderSidebar({ sessions: [recoveredSession] });

  expect(screen.getByRole("img", { name: "Recovered recording" })).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "Processing failed" })).not.toBeInTheDocument();
});

it("does not badge a session with no status field (pre-existing records) or an explicit done status", () => {
  const doneSession: Session = { ...sessionA, id: "d1", title: "Done One", status: "done" };
  renderSidebar({ sessions: [sessionA, doneSession] });

  expect(screen.queryByRole("img", { name: "Processing failed" })).not.toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "Recovered recording" })).not.toBeInTheDocument();
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
  fireEvent.click(screen.getByText("[trash]"));

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

it("shows the load-failure banner when a sessions error is present and the backend is up", () => {
  renderSidebar({ sessions: null, sessionsError: "Failed to fetch", backendUp: true });
  expect(screen.getByText(/failed to load: Failed to fetch/i)).toBeInTheDocument();
});

it("shows a neutral loading state instead of the fetch error while the backend isn't up yet (G9)", () => {
  // Regression test: useSessions' very first fetch lands as connection-
  // refused during a normal cold start, before the backend lifecycle has
  // reported healthy -- without gating on backendUp, that showed
  // "failed to load" on every single launch instead of a loading state.
  renderSidebar({ sessions: null, sessionsError: "Failed to fetch", backendUp: false });

  expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument();
  expect(screen.getByText(/loading/i)).toBeInTheDocument();
});

it("defaults backendUp to true when the prop is omitted", () => {
  renderSidebar({ sessions: null, sessionsError: "Failed to fetch" });
  expect(screen.getByText(/failed to load: Failed to fetch/i)).toBeInTheDocument();
});

it("shows the real error once the backend lifecycle has permanently failed, instead of loading forever (re-review-12-13 H1/L1)", () => {
  // Regression test: backendUp (the 15s health poll) stays false forever
  // once the backend lifecycle reaches 'failed', so gating solely on it
  // left this stuck on "loading" forever with no way to ever see the
  // error. backendFailed lifts the suppression once that's known.
  renderSidebar({
    sessions: null,
    sessionsError: "Failed to fetch",
    backendUp: false,
    backendFailed: true,
  });

  expect(screen.getByText(/failed to load: Failed to fetch/i)).toBeInTheDocument();
  expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
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

it("shows chunk progress while a long meeting is summarizing", async () => {
  vi.mocked(listJobs).mockResolvedValue([
    {
      id: "job-1",
      session_id: "s1",
      status: "running",
      stage: "summarizing",
      progress: { done: 2, total: 4 },
      error: null,
      notes: null,
      video_path: null,
      created_at: "2026-08-06T00:00:00Z",
    },
  ]);
  renderSidebar();

  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByText("processing — summarizing 2/4")).toBeInTheDocument();
});

it("fetches trashed sessions separately when view is trash", async () => {
  vi.mocked(getSessions).mockResolvedValue([
    sessionA,
    { ...sessionB, trashed_at: "2026-08-02T00:00:00Z" },
  ]);
  renderSidebar({ view: "trash" });

  expect(await screen.findByText("Retro")).toBeInTheDocument();
  expect(screen.queryByText("Sprint Planning")).not.toBeInTheDocument();
  expect(getSessions).toHaveBeenCalledWith(true);
});

it("trash-view rows never select the session -- activating one opens its actions menu instead", async () => {
  vi.mocked(getSessions).mockResolvedValue([
    { ...sessionA, trashed_at: "2026-08-02T00:00:00Z" },
  ]);
  const props = renderSidebar({ view: "trash" });

  const row = await screen.findByText("Sprint Planning");
  fireEvent.click(row);
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(screen.getByRole("menu", { name: "Actions for Sprint Planning" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "[restore]" })).toBeInTheDocument();
});

it("right-click in trash view offers restore, which calls restoreSession and reloads both lists", async () => {
  vi.mocked(getSessions).mockResolvedValue([
    { ...sessionA, trashed_at: "2026-08-02T00:00:00Z" },
  ]);
  vi.mocked(restoreSession).mockResolvedValue({ ...sessionA, trashed_at: null });
  const props = renderSidebar({ view: "trash" });

  const row = await screen.findByText("Sprint Planning");
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByText("[restore]"));

  await waitFor(() => expect(restoreSession).toHaveBeenCalledWith("a1"));
  expect(props.reloadSessions).toHaveBeenCalled();
});

it("shows a dismissible error banner and restores selection when trash fails while offline", async () => {
  vi.mocked(trashSession).mockRejectedValue(new TypeError("Failed to fetch"));
  const props = renderSidebar({ selectedId: "a1" });

  fireEvent.contextMenu(screen.getByText("Sprint Planning"));
  fireEvent.click(screen.getByText("[trash]"));

  await waitFor(() =>
    expect(screen.getByText("Couldn't move to trash — backend offline")).toBeInTheDocument()
  );
  // Optimistic deselect must be rolled back once the trash call is known
  // to have failed.
  expect(props.onSelect).toHaveBeenLastCalledWith("a1");

  fireEvent.click(screen.getByRole("button", { name: "dismiss error" }));
  expect(screen.queryByText("Couldn't move to trash — backend offline")).not.toBeInTheDocument();
});

it("shows a distinct error for a non-network (HTTP) trash failure", async () => {
  vi.mocked(trashSession).mockRejectedValue(new Error("Failed to trash session: 500"));
  renderSidebar();

  fireEvent.contextMenu(screen.getByText("Sprint Planning"));
  fireEvent.click(screen.getByText("[trash]"));

  await waitFor(() =>
    expect(
      screen.getByText("Couldn't move to trash — Failed to trash session: 500")
    ).toBeInTheDocument()
  );
});

it("shows an error and restores selection when delete forever fails", async () => {
  vi.mocked(getSessions).mockResolvedValue([
    { ...sessionA, trashed_at: "2026-08-02T00:00:00Z" },
  ]);
  vi.mocked(deleteSessionForever).mockRejectedValue(new TypeError("Failed to fetch"));
  const props = renderSidebar({ view: "trash", selectedId: "a1" });

  const row = await screen.findByText("Sprint Planning");
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByText("[delete forever]"));
  fireEvent.click(screen.getByText("[confirm]"));

  await waitFor(() =>
    expect(screen.getByText("Couldn't delete — backend offline")).toBeInTheDocument()
  );
  expect(props.onSelect).toHaveBeenLastCalledWith("a1");
});

it("shows an error when restore fails", async () => {
  vi.mocked(getSessions).mockResolvedValue([
    { ...sessionA, trashed_at: "2026-08-02T00:00:00Z" },
  ]);
  vi.mocked(restoreSession).mockRejectedValue(new TypeError("Failed to fetch"));
  renderSidebar({ view: "trash" });

  const row = await screen.findByText("Sprint Planning");
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByText("[restore]"));

  await waitFor(() =>
    expect(screen.getByText("Couldn't restore — backend offline")).toBeInTheDocument()
  );
});

it("shows an error when rename fails", async () => {
  vi.mocked(renameSession).mockRejectedValue(new TypeError("Failed to fetch"));
  renderSidebar();

  fireEvent.contextMenu(screen.getByText("Sprint Planning"));
  fireEvent.click(screen.getByText("[rename]"));
  const input = screen.getByDisplayValue("Sprint Planning");
  fireEvent.change(input, { target: { value: "Renamed" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() =>
    expect(screen.getByText("Couldn't rename — backend offline")).toBeInTheDocument()
  );
});

it("undo restores the toast and shows an error when undoing trash fails", async () => {
  vi.mocked(trashSession).mockResolvedValue({ ...sessionA, trashed_at: "2026-08-03T00:00:00Z" });
  vi.mocked(restoreSession).mockRejectedValue(new TypeError("Failed to fetch"));
  renderSidebar();

  fireEvent.contextMenu(screen.getByText("Sprint Planning"));
  fireEvent.click(screen.getByText("[trash]"));
  await waitFor(() => expect(screen.getByText('trashed "Sprint Planning"')).toBeInTheDocument());

  fireEvent.click(screen.getByText("[undo]"));
  // The toast is optimistically dismissed the instant undo is clicked.
  expect(screen.queryByText('trashed "Sprint Planning"')).not.toBeInTheDocument();

  await waitFor(() =>
    expect(screen.getByText("Couldn't undo trash — backend offline")).toBeInTheDocument()
  );
  // Rolled back so the user can try again instead of losing the only path
  // back to the trashed session.
  expect(screen.getByText('trashed "Sprint Planning"')).toBeInTheDocument();
});

it("right-click in trash view offers delete forever, which requires confirmation", async () => {
  vi.mocked(getSessions).mockResolvedValue([
    { ...sessionA, trashed_at: "2026-08-02T00:00:00Z" },
  ]);
  vi.mocked(deleteSessionForever).mockResolvedValue(undefined);
  renderSidebar({ view: "trash" });

  const row = await screen.findByText("Sprint Planning");
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByText("[delete forever]"));
  expect(deleteSessionForever).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText("[confirm]"));
  await waitFor(() => expect(deleteSessionForever).toHaveBeenCalledWith("a1"));
});

it("calls onSessionDeleted with the deleted session's id after delete forever succeeds", async () => {
  vi.mocked(getSessions).mockResolvedValue([
    { ...sessionA, trashed_at: "2026-08-02T00:00:00Z" },
  ]);
  vi.mocked(deleteSessionForever).mockResolvedValue(undefined);
  const onSessionDeleted = vi.fn();
  renderSidebar({ view: "trash", onSessionDeleted });

  const row = await screen.findByText("Sprint Planning");
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByText("[delete forever]"));
  fireEvent.click(screen.getByText("[confirm]"));

  await waitFor(() => expect(deleteSessionForever).toHaveBeenCalledWith("a1"));
  expect(onSessionDeleted).toHaveBeenCalledWith("a1");
});

it("does not crash when onSessionDeleted is not provided", async () => {
  vi.mocked(getSessions).mockResolvedValue([
    { ...sessionA, trashed_at: "2026-08-02T00:00:00Z" },
  ]);
  vi.mocked(deleteSessionForever).mockResolvedValue(undefined);
  renderSidebar({ view: "trash" }); // no onSessionDeleted override -- must not throw

  const row = await screen.findByText("Sprint Planning");
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByText("[delete forever]"));
  fireEvent.click(screen.getByText("[confirm]"));

  await waitFor(() => expect(deleteSessionForever).toHaveBeenCalledWith("a1"));
});

it("shows an all-meetings nav item that deselects the current session", () => {
  const { onSelect } = renderSidebar({ selectedId: "a1" });
  fireEvent.click(screen.getByRole("button", { name: /all meetings/i }));
  expect(onSelect).toHaveBeenCalledWith(null);
});

it("hides the all-meetings nav item when there are no sessions", () => {
  renderSidebar({ sessions: [] });
  expect(screen.queryByRole("button", { name: /all meetings/i })).not.toBeInTheDocument();
});

it("hides the all-meetings nav item in the trash view", () => {
  renderSidebar({ view: "trash" });
  expect(screen.queryByRole("button", { name: /all meetings/i })).not.toBeInTheDocument();
});

it("offers [recover library] for a damaged index and reloads both lists after recovering", async () => {
  vi.mocked(getSessions).mockResolvedValue([]);
  vi.mocked(recoverSessionsIndex).mockResolvedValue({
    source: "backup",
    restored: 2,
    adopted: 0,
    preserved_copy: "x",
  });
  const { reloadSessions } = renderSidebar({
    sessions: null,
    sessionsError: "The meeting library index is damaged",
    sessionsIndexCorrupt: true,
  });

  expect(screen.getByText(/The meeting library index is damaged/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "[recover library]" }));

  await waitFor(() => expect(recoverSessionsIndex).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(reloadSessions).toHaveBeenCalled());
});

it("shows the recover failure as an action error", async () => {
  vi.mocked(recoverSessionsIndex).mockRejectedValue(new Error("Wait for processing to finish"));
  renderSidebar({ sessions: null, sessionsError: "damaged", sessionsIndexCorrupt: true });

  fireEvent.click(screen.getByRole("button", { name: "[recover library]" }));

  expect(
    await screen.findByText("Couldn't recover library — Wait for processing to finish")
  ).toBeInTheDocument();
});

it("does not offer recovery for an ordinary load error", () => {
  renderSidebar({ sessions: null, sessionsError: "Failed to load sessions: 500" });
  expect(screen.queryByRole("button", { name: "[recover library]" })).not.toBeInTheDocument();
});


it("refetches the trash list when trashRefreshKey changes (Settings' Empty Trash)", async () => {
  vi.mocked(getSessions).mockResolvedValue([]);
  const props: ComponentProps<typeof Sidebar> = {
    view: "trash",
    collapsed: false,
    sessions: [],
    sessionsError: null,
    reloadSessions: vi.fn(),
    selectedId: null,
    onSelect: vi.fn(),
    trashRefreshKey: 0,
  };
  const { rerender } = render(<Sidebar {...props} />);
  await waitFor(() => expect(getSessions).toHaveBeenCalledTimes(1));

  rerender(<Sidebar {...props} />);
  await new Promise((r) => setTimeout(r, 0));
  expect(getSessions).toHaveBeenCalledTimes(1);

  rerender(<Sidebar {...props} trashRefreshKey={1} />);
  await waitFor(() => expect(getSessions).toHaveBeenCalledTimes(2));
  expect(getSessions).toHaveBeenLastCalledWith(true);
});

// ---------- keyboard access to row actions ----------

it("each active row has a visible actions button that opens the same menu, and focus returns to it on Escape", () => {
  renderSidebar();
  const actions = screen.getByRole("button", { name: "Actions for Sprint Planning" });
  expect(actions).toHaveAttribute("aria-haspopup", "menu");
  expect(actions).toHaveAttribute("aria-expanded", "false");

  actions.focus();
  fireEvent.click(actions);

  expect(screen.getByRole("menu", { name: "Actions for Sprint Planning" })).toBeInTheDocument();
  expect(actions).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("menuitem", { name: "[notes]" })).toHaveFocus();

  fireEvent.keyDown(document.activeElement!, { key: "Escape" });

  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(actions).toHaveFocus();
});

it("clicking the actions button again closes the menu", () => {
  renderSidebar();
  const actions = screen.getByRole("button", { name: "Actions for Retro" });
  fireEvent.mouseDown(actions);
  fireEvent.click(actions);
  expect(screen.getByRole("menu")).toBeInTheDocument();
  fireEvent.mouseDown(actions);
  fireEvent.click(actions);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("a keyboard-triggered context menu (no pointer position) opens the menu from the row", () => {
  renderSidebar();
  const row = screen.getByTitle("Sprint Planning");
  fireEvent.contextMenu(row, { clientX: 0, clientY: 0 });
  expect(screen.getByRole("menu", { name: "Actions for Sprint Planning" })).toBeInTheDocument();
});

it("trash rows are keyboard-reachable buttons whose menu restores the meeting", async () => {
  vi.mocked(getSessions).mockResolvedValue([{ ...sessionA, trashed_at: "2026-08-02T00:00:00Z" }]);
  vi.mocked(restoreSession).mockResolvedValue({ ...sessionA, trashed_at: null });
  renderSidebar({ view: "trash" });

  const actions = await screen.findByRole("button", { name: "Actions for Sprint Planning" });
  fireEvent.click(actions);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
  // [notes], [export notes], [export recording], [restore], [delete forever]
  fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
  expect(screen.getByRole("menuitem", { name: "[restore]" })).toHaveFocus();
  fireEvent.click(document.activeElement!);

  await waitFor(() => expect(restoreSession).toHaveBeenCalledWith("a1"));
});
