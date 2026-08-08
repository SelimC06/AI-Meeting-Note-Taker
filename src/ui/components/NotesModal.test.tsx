import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import NotesModal from "./NotesModal";
import type { Session } from "../api";

const session: Session = {
  id: "a1",
  created_at: "2026-08-01T00:00:00Z",
  title: "Sprint Planning",
  notes: "Discussed roadmap.\nAssigned action items.",
  video_path: "x",
  trashed_at: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
