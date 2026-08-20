import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AllMeetingsChat from "./AllMeetingsChat";
import { streamGraphChatReply, type GraphChatEvent, type Session } from "../api";

vi.mock("../api");

// jsdom doesn't implement scrollIntoView; the auto-scroll effect calls it
// on every turns change (same stub as Chat.test.tsx).
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const sessionA: Session = {
  id: "a1",
  created_at: "2026-08-01T00:00:00Z",
  title: "Sprint Planning",
  notes: "notes",
  video_path: "x",
  trashed_at: null,
};

async function* eventStream(): AsyncGenerator<GraphChatEvent> {
  yield { type: "sources", sources: [{ id: "a1", title: "Sprint Planning", created_at: "2026-08-01T00:00:00Z" }] };
  yield { type: "token", token: "Hello " };
  yield { type: "token", token: "world" };
}

it("shows the all-meetings intro card before any messages", () => {
  render(<AllMeetingsChat sessions={[sessionA]} onSelectSession={() => {}} />);
  expect(screen.getByText(/all meetings/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/ask across all your meetings/i)).toBeInTheDocument();
});

it("streams tokens into the assistant turn and renders clickable source chips", async () => {
  vi.mocked(streamGraphChatReply).mockImplementation(() => eventStream());
  const onSelect = vi.fn();

  render(<AllMeetingsChat sessions={[sessionA]} onSelectSession={onSelect} />);
  const input = screen.getByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "what happened?" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(await screen.findByText("Hello world")).toBeInTheDocument();
  const chip = await screen.findByRole("button", { name: /Sprint Planning · 2026-08-01/ });
  fireEvent.click(chip);
  expect(onSelect).toHaveBeenCalledWith("a1");
});

it("sends prior turns as plain role/content history without sources", async () => {
  vi.mocked(streamGraphChatReply).mockImplementation(() => eventStream());
  render(<AllMeetingsChat sessions={[sessionA]} onSelectSession={() => {}} />);
  const input = screen.getByLabelText("Chat message");

  fireEvent.change(input, { target: { value: "first" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText("Hello world");

  vi.mocked(streamGraphChatReply).mockImplementation(() => eventStream());
  fireEvent.change(input, { target: { value: "second" } });
  fireEvent.keyDown(input, { key: "Enter" });

  const lastCall = vi.mocked(streamGraphChatReply).mock.calls.at(-1)!;
  expect(lastCall[0]).toBe("second");
  expect(lastCall[1]).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "Hello world" },
  ]);
});

it("surfaces a stream error without crashing", async () => {
  async function* failingStream(): AsyncGenerator<GraphChatEvent> {
    yield { type: "token", token: "partial" };
    throw new Error("Chat failed mid-response: ollama died");
  }
  vi.mocked(streamGraphChatReply).mockImplementation(() => failingStream());

  render(<AllMeetingsChat sessions={[sessionA]} onSelectSession={() => {}} />);
  const input = screen.getByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "hi" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(await screen.findByText(/ollama died/)).toBeInTheDocument();
});

it("seeds the input from a seed prop, e.g. handed off from a sidebar search", () => {
  const { rerender } = render(
    <AllMeetingsChat sessions={[sessionA]} onSelectSession={() => {}} seed={{ query: "budget", nonce: 1 }} />
  );
  expect(screen.getByLabelText("Chat message")).toHaveValue("budget");

  // A second hand-off with a bumped nonce overwrites the input again, even
  // if the query text itself is unchanged from what's already typed there --
  // the nonce, not the query string, is what should trigger a reseed.
  fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: "something else" } });
  rerender(<AllMeetingsChat sessions={[sessionA]} onSelectSession={() => {}} seed={{ query: "budget", nonce: 2 }} />);
  expect(screen.getByLabelText("Chat message")).toHaveValue("budget");
});
