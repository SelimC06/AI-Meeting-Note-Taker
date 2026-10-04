// Ports NotesModal.test.tsx's coverage onto the main-pane meeting view
// (UI refresh): the notes/transcript content and rename behavior are the
// same contracts, now rendered as panes instead of a modal.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MeetingHeader, NotesPane, TranscriptPane } from "./MeetingPane";
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
  vi.spyOn(api, "getSessionActionItems").mockResolvedValue(null);
  vi.spyOn(api, "getSessionTranscript").mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---- header ----------------------------------------------------------------

it("renders the title, tabs, and speaker chips from the transcript", async () => {
  vi.mocked(api.getSessionTranscript).mockResolvedValue([
    { start: 0, end: 1, speaker: "You", text: "hi", raw_speaker: "You" },
    { start: 1, end: 2, speaker: "Maya", text: "hello", raw_speaker: "SPEAKER_00" },
  ]);
  const onTabChange = vi.fn();
  render(<MeetingHeader session={session} tab="notes" onTabChange={onTabChange} />);

  expect(screen.getByText("Sprint Planning")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText("maya")).toBeInTheDocument());
  expect(screen.getByText("you")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "transcript" }));
  expect(onTabChange).toHaveBeenCalledWith("transcript");
  // The active tab is marked for assistive tech.
  expect(screen.getByRole("button", { name: "notes" })).toHaveAttribute("aria-current", "page");
});

it("renders the header fine when the transcript fetch fails", async () => {
  vi.mocked(api.getSessionTranscript).mockRejectedValue(new Error("boom"));
  render(<MeetingHeader session={session} tab="chat" onTabChange={() => {}} />);
  expect(screen.getByText("Sprint Planning")).toBeInTheDocument();
  await waitFor(() => expect(api.getSessionTranscript).toHaveBeenCalled());
});

// ---- notes pane --------------------------------------------------------------

it("renders the prose notes", () => {
  render(<NotesPane session={session} />);
  expect(screen.getByText(/Discussed roadmap\./)).toBeInTheDocument();
});

it("renders a checklist when structured action items are available", async () => {
  vi.mocked(api.getSessionActionItems).mockResolvedValue([
    { text: "Send follow-up email", owner: "Alice", due: "Friday" },
    { text: "Review the PR", owner: null, due: null },
  ]);

  render(<NotesPane session={session} />);

  await waitFor(() => {
    expect(screen.getByText("Send follow-up email")).toBeInTheDocument();
  });
  expect(screen.getByText("Review the PR")).toBeInTheDocument();
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  expect(screen.getByText(/Alice/)).toBeInTheDocument();
  expect(screen.getByText(/Friday/)).toBeInTheDocument();
  // The prose notes are still rendered alongside the checklist.
  expect(screen.getByText(/Discussed roadmap\./)).toBeInTheDocument();
});

it("toggles a checkbox as checked when clicked", async () => {
  vi.mocked(api.getSessionActionItems).mockResolvedValue([
    { text: "Send follow-up email", owner: null, due: null },
  ]);

  render(<NotesPane session={session} />);

  const checkbox = await screen.findByRole("checkbox", { name: "Send follow-up email" });
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  expect(checkbox).toBeChecked();
  fireEvent.click(checkbox);
  expect(checkbox).not.toBeChecked();
});

it.each([
  ["unavailable (null)", null],
  ["empty list", []],
])("falls back to plain prose notes when action items are %s", async (_label, value) => {
  vi.mocked(api.getSessionActionItems).mockResolvedValue(value as api.ActionItem[] | null);

  render(<NotesPane session={session} />);

  await waitFor(() => {
    expect(api.getSessionActionItems).toHaveBeenCalledWith(session.id);
  });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByText(/Discussed roadmap\./)).toBeInTheDocument();
});

it("falls back to plain prose notes without crashing when the action items fetch fails", async () => {
  vi.mocked(api.getSessionActionItems).mockRejectedValue(new Error("malformed response"));

  render(<NotesPane session={session} />);

  await waitFor(() => {
    expect(api.getSessionActionItems).toHaveBeenCalledWith(session.id);
  });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByText(/Discussed roadmap\./)).toBeInTheDocument();
});

// ---- transcript pane ---------------------------------------------------------

it("fetches and renders speaker-tagged segments", async () => {
  vi.mocked(api.getSessionTranscript).mockResolvedValue([
    { start: 0, end: 1.5, speaker: "You", text: "hey can you hear me" },
    { start: 1.5, end: 3, speaker: "Others", text: "yep loud and clear" },
  ]);

  render(<TranscriptPane sessionId={session.id} />);

  await waitFor(() => {
    expect(screen.getByText("hey can you hear me")).toBeInTheDocument();
  });
  expect(screen.getByText("yep loud and clear")).toBeInTheDocument();
  expect(screen.getAllByText("You")).not.toHaveLength(0);
  expect(screen.getAllByText("Others")).not.toHaveLength(0);
});

it("renders three or more distinct speakers (Track B n-party)", async () => {
  vi.mocked(api.getSessionTranscript).mockResolvedValue([
    { start: 0, end: 1, speaker: "You", text: "welcome everyone", raw_speaker: "You" },
    { start: 1, end: 2, speaker: "SPEAKER_00", text: "thanks for having us", raw_speaker: "SPEAKER_00" },
    { start: 2, end: 3, speaker: "SPEAKER_01", text: "glad to be here", raw_speaker: "SPEAKER_01" },
  ]);

  render(<TranscriptPane sessionId={session.id} />);

  await waitFor(() => {
    expect(screen.getByText("welcome everyone")).toBeInTheDocument();
  });
  expect(screen.getByText("thanks for having us")).toBeInTheDocument();
  expect(screen.getByText("glad to be here")).toBeInTheDocument();
  expect(screen.getByText("SPEAKER_00")).toBeInTheDocument();
  expect(screen.getByText("SPEAKER_01")).toBeInTheDocument();
});

it("renames a speaker label and applies the new name to every matching segment", async () => {
  vi.mocked(api.getSessionTranscript).mockResolvedValue([
    { start: 0, end: 1, speaker: "SPEAKER_00", text: "hello", raw_speaker: "SPEAKER_00" },
    { start: 2, end: 3, speaker: "SPEAKER_00", text: "how are you", raw_speaker: "SPEAKER_00" },
  ]);
  const updateSpy = vi.spyOn(api, "updateSpeakerNames").mockResolvedValue({ SPEAKER_00: "Alice" });

  render(<TranscriptPane sessionId={session.id} />);

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
  render(<TranscriptPane sessionId={session.id} />);

  await waitFor(() => {
    expect(screen.getByText(/No speech was transcribed/i)).toBeInTheDocument();
  });
});

it("renders speaker-less segments as plain text, with no rename control", async () => {
  vi.mocked(api.getSessionTranscript).mockResolvedValue([
    { start: null, end: null, speaker: null, raw_speaker: null, text: "hello from a mixed track" },
  ]);

  render(<TranscriptPane sessionId={session.id} />);

  await waitFor(() => {
    expect(screen.getByText("hello from a mixed track")).toBeInTheDocument();
  });
  expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Rename/ })).not.toBeInTheDocument();
});

it("shows an error message when the transcript fetch fails", async () => {
  vi.mocked(api.getSessionTranscript).mockRejectedValue(new Error("boom"));

  render(<TranscriptPane sessionId={session.id} />);

  await waitFor(() => {
    expect(screen.getByText(/Couldn't load transcript/i)).toBeInTheDocument();
  });
});

it("rolls back a failed speaker rename and says so", async () => {
  vi.mocked(api.getSessionTranscript).mockResolvedValue([
    { start: 0, end: 1, speaker: "SPEAKER_00", text: "hello", raw_speaker: "SPEAKER_00" },
  ]);
  vi.spyOn(api, "updateSpeakerNames").mockRejectedValue(new Error("Failed to update speaker names: 500"));

  render(<TranscriptPane sessionId={session.id} />);
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
  vi.mocked(api.getSessionTranscript).mockResolvedValue([
    { start: 0, end: 1, speaker: "SPEAKER_00", text: "hello", raw_speaker: "SPEAKER_00" },
  ]);
  let rejectFirst!: (e: unknown) => void;
  vi.spyOn(api, "updateSpeakerNames")
    .mockReturnValueOnce(new Promise((_, reject) => { rejectFirst = reject; }))
    .mockResolvedValueOnce({ SPEAKER_00: "Bob" });

  render(<TranscriptPane sessionId={session.id} />);
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

it("renders notes markdown as styled sections instead of raw markers", () => {
  const mdSession = {
    ...session,
    notes:
      "# Sprint Planning\n\n## Key Points\n- Ship the rail\n- **Lock** the scope\n\n## Decisions\n\n_Summarized from the transcript._",
  };
  render(<NotesPane session={mdSession} />);

  expect(screen.getByRole("heading", { name: "Key Points" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Decisions" })).toBeInTheDocument();
  const items = screen.getAllByRole("listitem");
  expect(items[0]).toHaveTextContent("Ship the rail");
  expect(items[1]).toHaveTextContent("Lock the scope");
  // Markers are rendered, not shown: no literal #, -, ** or _ survive.
  expect(screen.queryByText(/[#*_]/)).not.toBeInTheDocument();
  // The leading title heading duplicates the meeting header and is dropped.
  expect(screen.queryByRole("heading", { name: "Sprint Planning" })).not.toBeInTheDocument();
});
