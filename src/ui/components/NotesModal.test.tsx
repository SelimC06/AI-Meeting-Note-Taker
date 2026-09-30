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

it("renders three or more distinct speakers (Track B n-party)", async () => {
  vi.spyOn(api, "getSessionTranscript").mockResolvedValue([
    { start: 0, end: 1, speaker: "You", text: "welcome everyone", raw_speaker: "You" },
    { start: 1, end: 2, speaker: "SPEAKER_00", text: "thanks for having us", raw_speaker: "SPEAKER_00" },
    { start: 2, end: 3, speaker: "SPEAKER_01", text: "glad to be here", raw_speaker: "SPEAKER_01" },
  ]);

  render(<NotesModal session={session} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Transcript" }));

  await waitFor(() => {
    expect(screen.getByText("welcome everyone")).toBeInTheDocument();
  });
  expect(screen.getByText("thanks for having us")).toBeInTheDocument();
  expect(screen.getByText("glad to be here")).toBeInTheDocument();
  expect(screen.getByText("SPEAKER_00")).toBeInTheDocument();
  expect(screen.getByText("SPEAKER_01")).toBeInTheDocument();
});

it("renames a speaker label and applies the new name to every matching segment", async () => {
  vi.spyOn(api, "getSessionTranscript").mockResolvedValue([
    { start: 0, end: 1, speaker: "SPEAKER_00", text: "hello", raw_speaker: "SPEAKER_00" },
    { start: 2, end: 3, speaker: "SPEAKER_00", text: "how are you", raw_speaker: "SPEAKER_00" },
  ]);
  const updateSpy = vi.spyOn(api, "updateSpeakerNames").mockResolvedValue({ SPEAKER_00: "Alice" });

  render(<NotesModal session={session} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Transcript" }));

  await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());

  fireEvent.click(screen.getAllByRole("button", { name: "Rename SPEAKER_00" })[0]);
  const input = screen.getByRole("textbox", { name: "New name for SPEAKER_00" });
  fireEvent.change(input, { target: { value: "Alice" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => {
    expect(updateSpy).toHaveBeenCalledWith(session.id, { SPEAKER_00: "Alice" });
  });
  expect(screen.getAllByText("Alice")).toHaveLength(2);
  expect(screen.queryByText("SPEAKER_00")).not.toBeInTheDocument();
});

it("shows a no-speech message when the transcript is empty", async () => {
  vi.spyOn(api, "getSessionTranscript").mockResolvedValue([]);

  render(<NotesModal session={session} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Transcript" }));

  await waitFor(() => {
    expect(screen.getByText(/No speech was transcribed/i)).toBeInTheDocument();
  });
  // The old copy blamed missing mic/system tracks -- that's no longer a
  // requirement for having a transcript.
  expect(screen.queryByText(/system audio/i)).not.toBeInTheDocument();
});

it("renders speaker-less segments as plain text, with no rename control", async () => {
  vi.spyOn(api, "getSessionTranscript").mockResolvedValue([
    { start: null, end: null, speaker: null, raw_speaker: null, text: "hello from a mixed track" },
  ]);

  render(<NotesModal session={session} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Transcript" }));

  await waitFor(() => {
    expect(screen.getByText("hello from a mixed track")).toBeInTheDocument();
  });
  expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Rename/ })).not.toBeInTheDocument();
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


it("rolls back a failed speaker rename and says so", async () => {
  vi.spyOn(api, "getSessionTranscript").mockResolvedValue([
    { start: 0, end: 1, speaker: "SPEAKER_00", text: "hello", raw_speaker: "SPEAKER_00" },
  ]);
  vi.spyOn(api, "updateSpeakerNames").mockRejectedValue(new Error("Failed to update speaker names: 500"));

  render(<NotesModal session={session} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Transcript" }));
  await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: "Rename SPEAKER_00" }));
  const input = screen.getByRole("textbox", { name: "New name for SPEAKER_00" });
  fireEvent.change(input, { target: { value: "Alice" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't rename speaker");
  expect(screen.getByText("SPEAKER_00")).toBeInTheDocument();
  expect(screen.queryByText("Alice")).not.toBeInTheDocument();
});

it("an older rename failing doesn't undo a newer rename of the same speaker", async () => {
  vi.spyOn(api, "getSessionTranscript").mockResolvedValue([
    { start: 0, end: 1, speaker: "SPEAKER_00", text: "hello", raw_speaker: "SPEAKER_00" },
  ]);
  let rejectFirst!: (e: unknown) => void;
  vi.spyOn(api, "updateSpeakerNames")
    .mockReturnValueOnce(new Promise((_, reject) => { rejectFirst = reject; }))
    .mockResolvedValueOnce({ SPEAKER_00: "Bob" });

  render(<NotesModal session={session} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Transcript" }));
  await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());

  const rename = (name: string, current: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Rename SPEAKER_00" }));
    const input = screen.getByRole("textbox", { name: "New name for SPEAKER_00" });
    expect(input).toHaveValue(current);
    fireEvent.change(input, { target: { value: name } });
    fireEvent.keyDown(input, { key: "Enter" });
  };
  rename("Alice", "SPEAKER_00");
  rename("Bob", "Alice");
  rejectFirst(new Error("late failure"));

  await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("is a modal dialog labelled by the session title, focusing its first control and closing on Escape", () => {
  const onClose = vi.fn();
  render(<NotesModal session={session} onClose={onClose} />);
  const dialog = screen.getByRole("dialog", { name: "Sprint Planning" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(screen.getByRole("button", { name: "Close notes" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});
