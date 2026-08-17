import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import NotesModal from "./NotesModal";
import * as api from "../api";
import type { Session } from "../api";

const session: Session = {
  id: "a1",
  created_at: "2026-08-01T00:00:00Z",
  title: "Sprint Planning",
  notes: "Discussed roadmap.\nAssigned action items.",
  video_path: "x",
  trashed_at: null,
};

beforeEach(() => {
  // Default: no structured action items available -- matches an old
  // session / a session where the backend's malformed-JSON fallback
  // kicked in. Tests exercising the checklist itself override this.
  vi.spyOn(api, "getSessionActionItems").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("renders the session title and notes", () => {
  render(<NotesModal session={session} onClose={() => {}} />);
  expect(screen.getByText("Sprint Planning")).toBeInTheDocument();
  expect(screen.getByText(/Discussed roadmap\./)).toBeInTheDocument();
});

it("calls onClose when the close button is clicked", () => {
  const onClose = vi.fn();
  render(<NotesModal session={session} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Close notes" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("calls onClose on Escape", () => {
  const onClose = vi.fn();
  render(<NotesModal session={session} onClose={onClose} />);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("shows the Notes view by default without fetching the transcript", () => {
  const spy = vi.spyOn(api, "getSessionTranscript");
  render(<NotesModal session={session} onClose={() => {}} />);
  expect(screen.getByText(/Discussed roadmap\./)).toBeInTheDocument();
  expect(spy).not.toHaveBeenCalled();
});

it("fetches and renders speaker-tagged segments when switching to the Transcript tab", async () => {
  vi.spyOn(api, "getSessionTranscript").mockResolvedValue([
    { start: 0, end: 1.5, speaker: "You", text: "hey can you hear me" },
    { start: 1.5, end: 3, speaker: "Others", text: "yep loud and clear" },
  ]);

  render(<NotesModal session={session} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Transcript" }));

  await waitFor(() => {
    expect(screen.getByText("hey can you hear me")).toBeInTheDocument();
  });
  expect(screen.getByText("yep loud and clear")).toBeInTheDocument();
  expect(screen.getAllByText("You")).not.toHaveLength(0);
  expect(screen.getAllByText("Others")).not.toHaveLength(0);
});

it("shows a fallback message when no structured transcript is available", async () => {
  vi.spyOn(api, "getSessionTranscript").mockResolvedValue([]);

  render(<NotesModal session={session} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Transcript" }));

  await waitFor(() => {
    expect(screen.getByText(/No structured transcript/i)).toBeInTheDocument();
  });
});

it("shows an error message when the transcript fetch fails", async () => {
  vi.spyOn(api, "getSessionTranscript").mockRejectedValue(new Error("boom"));

  render(<NotesModal session={session} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Transcript" }));

  await waitFor(() => {
    expect(screen.getByText(/Couldn't load transcript/i)).toBeInTheDocument();
  });
});

it("renders a checklist when structured action items are available", async () => {
  vi.spyOn(api, "getSessionActionItems").mockResolvedValue([
    { text: "Send follow-up email", owner: "Alice", due: "Friday" },
    { text: "Review the PR", owner: null, due: null },
  ]);

  render(<NotesModal session={session} onClose={() => {}} />);

  await waitFor(() => {
    expect(screen.getByText("Send follow-up email")).toBeInTheDocument();
  });
  expect(screen.getByText("Review the PR")).toBeInTheDocument();
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  // Owner/due badges are shown for the item that has them.
  expect(screen.getByText(/Alice/)).toBeInTheDocument();
  expect(screen.getByText(/Friday/)).toBeInTheDocument();
  // The prose notes are still rendered alongside the checklist.
  expect(screen.getByText(/Discussed roadmap\./)).toBeInTheDocument();
});

it("toggles a checkbox as checked when clicked", async () => {
  vi.spyOn(api, "getSessionActionItems").mockResolvedValue([
    { text: "Send follow-up email", owner: null, due: null },
  ]);

  render(<NotesModal session={session} onClose={() => {}} />);

  const checkbox = await screen.findByRole("checkbox", { name: "Send follow-up email" });
  expect(checkbox).not.toBeChecked();

  fireEvent.click(checkbox);
  expect(checkbox).toBeChecked();

  fireEvent.click(checkbox);
  expect(checkbox).not.toBeChecked();
});

it("falls back to plain prose notes (no checklist) when action items are unavailable", async () => {
  vi.spyOn(api, "getSessionActionItems").mockResolvedValue(null);

  render(<NotesModal session={session} onClose={() => {}} />);

  await waitFor(() => {
    expect(api.getSessionActionItems).toHaveBeenCalledWith(session.id);
  });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByText(/Discussed roadmap\./)).toBeInTheDocument();
});

it("falls back to plain prose notes when the model found none (empty list)", async () => {
  vi.spyOn(api, "getSessionActionItems").mockResolvedValue([]);

  render(<NotesModal session={session} onClose={() => {}} />);

  await waitFor(() => {
    expect(api.getSessionActionItems).toHaveBeenCalledWith(session.id);
  });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByText(/Discussed roadmap\./)).toBeInTheDocument();
});

it("falls back to plain prose notes without crashing when the action items fetch fails", async () => {
  vi.spyOn(api, "getSessionActionItems").mockRejectedValue(new Error("malformed response"));

  render(<NotesModal session={session} onClose={() => {}} />);

  await waitFor(() => {
    expect(api.getSessionActionItems).toHaveBeenCalledWith(session.id);
  });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByText(/Discussed roadmap\./)).toBeInTheDocument();
});
