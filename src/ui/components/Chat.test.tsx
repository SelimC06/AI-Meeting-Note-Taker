import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Chat from "./Chat";
import { streamChatReply, type Session } from "../api";

vi.mock("../api");

// jsdom doesn't implement scrollIntoView at all, but Chat's auto-scroll
// effect calls it on every turns change (i.e. in nearly every test in this
// file) -- stub it globally so tests that don't care about scrolling don't
// have to.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const sessionA: Session = {
  id: "a1",
  created_at: "2026-08-01T00:00:00Z",
  title: "Sprint Planning",
  notes: "notes",
  video_path: "x",
  trashed_at: null,
};

const sessionB: Session = {
  id: "b2",
  created_at: "2026-08-02T00:00:00Z",
  title: "Retro",
  notes: "notes",
  video_path: "x",
  trashed_at: null,
};

async function* twoChunkStream(): AsyncGenerator<string> {
  yield "Hello ";
  yield "world";
}

async function* hangingStreamAfterFirstChunk(signal?: AbortSignal): AsyncGenerator<string> {
  yield "Hello";
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows the Welcome panel when nothing is selected", () => {
  render(<Chat sessions={[sessionA]} sessionsError={null} selectedId={null} />);
  expect(screen.getByText(/meeting note taker/i)).toBeInTheDocument();
  expect(screen.getByText(/1 meeting recorded/i)).toBeInTheDocument();
});

it("shows the Welcome panel's no-meetings state when there are no meetings", () => {
  render(<Chat sessions={[]} sessionsError={null} selectedId={null} />);
  expect(screen.getByText(/meeting note taker/i)).toBeInTheDocument();
  expect(screen.getByText(/no meetings recorded yet/i)).toBeInTheDocument();
});

it("streams chunks and appends them to the last assistant turn", async () => {
  vi.mocked(streamChatReply).mockImplementation(() => twoChunkStream());

  render(<Chat sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  const input = await screen.findByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "what happened?" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(await screen.findByText("Hello world")).toBeInTheDocument();
});

// jsdom's scrollHeight/clientHeight/scrollTop are getter-only and always 0
// by default -- override them via defineProperty to simulate a real
// scroll position for the auto-scroll tests below.
function setScrollMetrics(
  el: Element,
  { scrollTop, scrollHeight, clientHeight }: { scrollTop: number; scrollHeight: number; clientHeight: number }
) {
  Object.defineProperty(el, "scrollTop", { value: scrollTop, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
}

it("auto-scrolls to the bottom as chunks stream in while already near the bottom", async () => {
  vi.mocked(streamChatReply).mockImplementation(() => twoChunkStream());

  const { container } = render(<Chat sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  const messagesContainer = container.querySelector(".overflow-y-auto");
  if (!messagesContainer) throw new Error("messages container not found");
  // Already scrolled to (within a few px of) the bottom.
  setScrollMetrics(messagesContainer, { scrollTop: 480, scrollHeight: 500, clientHeight: 20 });
  const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  scrollIntoView.mockClear(); // discard the mount-time call (default 0/0/0 metrics also count as "near bottom")

  const input = await screen.findByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "what happened?" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await screen.findByText("Hello world");
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
});

it("does not fight manual scrollback while a reply streams in", async () => {
  vi.mocked(streamChatReply).mockImplementation(() => twoChunkStream());

  const { container } = render(<Chat sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  const messagesContainer = container.querySelector(".overflow-y-auto");
  if (!messagesContainer) throw new Error("messages container not found");
  // Scrolled well away from the bottom, reading earlier messages.
  setScrollMetrics(messagesContainer, { scrollTop: 0, scrollHeight: 500, clientHeight: 20 });
  const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  scrollIntoView.mockClear();

  const input = await screen.findByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "what happened?" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await screen.findByText("Hello world");
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it("aborts the stream when Stop is clicked and shows no error", async () => {
  vi.mocked(streamChatReply).mockImplementation((_id, _msg, _hist, signal) =>
    hangingStreamAfterFirstChunk(signal)
  );

  render(<Chat sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  const input = await screen.findByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "hi" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await screen.findByText("Hello");
  const stopButton = await screen.findByRole("button", { name: /stop response/i });
  fireEvent.click(stopButton);

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /stop response/i })).not.toBeInTheDocument();
  });
  expect(screen.queryByText(/error:/i)).not.toBeInTheDocument();
});

it("aborts the in-flight stream and clears turns when the selected meeting changes", async () => {
  vi.mocked(streamChatReply).mockImplementation((_id, _msg, _hist, signal) =>
    hangingStreamAfterFirstChunk(signal)
  );

  const { rerender } = render(
    <Chat sessions={[sessionA, sessionB]} sessionsError={null} selectedId="a1" />
  );
  const input = await screen.findByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "hi" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText("Hello");

  rerender(<Chat sessions={[sessionA, sessionB]} sessionsError={null} selectedId="b2" />);

  await waitFor(() => {
    expect(screen.queryByText("Hello")).not.toBeInTheDocument();
  });
  expect(screen.getByText(sessionB.title, { exact: false })).toBeInTheDocument();
  expect(screen.getByText(/ask anything about this meeting's recording/i)).toBeInTheDocument();
});

it("shows an error message when the stream throws a non-abort error", async () => {
  vi.mocked(streamChatReply).mockImplementation(
    // eslint-disable-next-line require-yield -- intentionally throws before any yield, simulating a stream that fails immediately
    async function* () {
      throw new Error("model unavailable");
    }
  );

  render(<Chat sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  const input = await screen.findByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "hi" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(await screen.findByText(/error: model unavailable/i)).toBeInTheDocument();
});

it("shows a distinct error message when sessions fail to load", () => {
  render(<Chat sessions={null} sessionsError="Failed to fetch" selectedId={null} />);
  expect(screen.getByText(/couldn't load meetings: Failed to fetch/i)).toBeInTheDocument();
});

it("shows a neutral loading state instead of the sessions error while the backend isn't up yet (G9)", () => {
  // Regression test: same G9 cold-start misread as Sidebar's identical fix
  // -- a connection-refused error from before the backend reports healthy
  // must not be shown as a real load failure.
  render(
    <Chat sessions={null} sessionsError="Failed to fetch" selectedId={null} backendUp={false} />
  );

  expect(screen.queryByText(/couldn't load meetings/i)).not.toBeInTheDocument();
  expect(screen.getByText(/loading/i)).toBeInTheDocument();
});
