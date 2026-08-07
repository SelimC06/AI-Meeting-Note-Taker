import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import YourActivityPage from "./YourActivityPage";
import { getSessions, trashSession, type Session } from "../api";

vi.mock("../api");

const sessions: Session[] = [
  {
    id: "1",
    created_at: "2026-08-01T00:00:00.000Z",
    title: "Weekly standup",
    notes: "",
    video_path: "",
    trashed_at: null,
  },
  {
    id: "2",
    created_at: "2026-08-02T00:00:00.000Z",
    title: "Budget review",
    notes: "",
    video_path: "",
    trashed_at: null,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("filters the session list by title as the user types", async () => {
  vi.mocked(getSessions).mockResolvedValue(sessions);

  render(<YourActivityPage active />);

  expect(await screen.findByText(/weekly standup/i)).toBeInTheDocument();
  expect(screen.getByText(/budget review/i)).toBeInTheDocument();

  const searchInput = screen.getByPlaceholderText(/search/i);
  fireEvent.change(searchInput, { target: { value: "budget" } });

  expect(screen.queryByText(/weekly standup/i)).not.toBeInTheDocument();
  expect(screen.getByText(/budget review/i)).toBeInTheDocument();
});

it("shows a no-matches message when the query has zero results", async () => {
  vi.mocked(getSessions).mockResolvedValue(sessions);

  render(<YourActivityPage active />);
  await screen.findByText(/weekly standup/i);

  const searchInput = screen.getByPlaceholderText(/search/i);
  fireEvent.change(searchInput, { target: { value: "nonexistent meeting" } });

  expect(await screen.findByText(/no matches for "nonexistent meeting"/i)).toBeInTheDocument();
});

it("clears the query when switching between active and trash views", async () => {
  vi.mocked(getSessions).mockResolvedValue(sessions);

  render(<YourActivityPage active />);
  await screen.findByText(/weekly standup/i);

  const searchInput = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
  fireEvent.change(searchInput, { target: { value: "budget" } });
  expect(searchInput.value).toBe("budget");

  // "[trash]" matches both the view-toggle button and the per-row hover
  // action button for the still-visible "Budget review" row; the toggle
  // button renders first in the DOM.
  fireEvent.click(screen.getAllByText("[trash]")[0]);

  const searchInputAfterSwitch = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
  expect(searchInputAfterSwitch.value).toBe("");
});

it("clears the pending undo-toast timer on unmount", async () => {
  vi.mocked(getSessions).mockResolvedValue(sessions);
  vi.mocked(trashSession).mockResolvedValue(undefined);

  // Note: this deliberately observes clearTimeout being called with the
  // exact timer id setTimeout returned, rather than asserting "no console
  // error after unmount". On React 19.2, a setState call on an unmounted
  // fiber is a silent no-op with no console warning at all, so a
  // console.error-based assertion would pass identically whether or not
  // the timer was actually cleared -- it wouldn't discriminate between the
  // buggy and fixed implementations. Spying on setTimeout/clearTimeout
  // gives a genuine, version-independent proof that the cleanup ran.
  const setTimeoutSpy = vi.spyOn(global, "setTimeout");
  const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

  const { unmount } = render(<YourActivityPage active />);
  await screen.findByText(/weekly standup/i);
  // "[trash]" matches both the view-toggle button and the per-row hover
  // action button; the toggle button renders first in the DOM (see the
  // "clears the query when switching between active and trash views"
  // test above), so index 1 is the first row's trash action.
  const trashButtons = await screen.findAllByText("[trash]");
  fireEvent.click(trashButtons[1]);

  await screen.findByText(/undo/i);

  const undoTimeoutCall = setTimeoutSpy.mock.calls.findIndex(
    (args) => typeof args[1] === "number" && args[1] === 6000
  );
  expect(undoTimeoutCall).toBeGreaterThanOrEqual(0);
  const undoTimeoutId = setTimeoutSpy.mock.results[undoTimeoutCall].value;

  unmount();

  expect(clearTimeoutSpy).toHaveBeenCalledWith(undoTimeoutId);

  setTimeoutSpy.mockRestore();
  clearTimeoutSpy.mockRestore();
});
