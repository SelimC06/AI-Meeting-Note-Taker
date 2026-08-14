import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Chat from "./Chat";
import { useChatSessions } from "../hooks/useChatSessions";
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

// Like hangingStreamAfterFirstChunk, but resolvable on demand instead of
// only via abort -- used by the persistence tests below to prove a stream
// keeps running (and can complete normally) while its meeting isn't the
// one currently displayed.
function makeControllableStream() {
  let resolveGate: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  async function* stream(signal?: AbortSignal): AsyncGenerator<string> {
    yield "Hello";
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort);
      gate.then(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
    yield " world";
  }
  return { stream, release: () => resolveGate() };
}

// Chat now requires a `chatSessions` instance owned above it (so per-session
// conversations survive Chat re-rendering with a different selectedId) --
// this harness gives every test a real (non-mocked) hook instance, matching
// how App.tsx wires it in production. Only the underlying `streamChatReply`
// network call is mocked, same as before.
type ChatTestProps = Omit<ComponentProps<typeof Chat>, "chatSessions">;

function ChatWithSessions(props: ChatTestProps) {
  const chatSessions = useChatSessions();
  return <Chat {...props} chatSessions={chatSessions} />;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows the all-meetings chat when meetings exist and nothing is selected", () => {
  render(<ChatWithSessions sessions={[sessionA]} sessionsError={null} selectedId={null} />);
  expect(screen.getByText(/all meetings/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/ask across all your meetings/i)).toBeInTheDocument();
});

it("shows the Welcome panel's no-meetings state when there are no meetings", () => {
  render(<ChatWithSessions sessions={[]} sessionsError={null} selectedId={null} />);
  expect(screen.getByText(/deskrecap/i)).toBeInTheDocument();
  expect(screen.getByText(/no meetings recorded yet/i)).toBeInTheDocument();
});

it("passes source-chip clicks through to onSelectSession", async () => {
  const { streamGraphChatReply } = await import("../api");
  async function* stream() {
    yield { type: "sources" as const, sources: [{ id: "a1", title: "Sprint Planning", created_at: "2026-08-01T00:00:00Z" }] };
    yield { type: "token" as const, token: "hi" };
  }
  vi.mocked(streamGraphChatReply).mockImplementation(() => stream());
  const onSelect = vi.fn();

  render(<ChatWithSessions sessions={[sessionA]} sessionsError={null} selectedId={null} onSelectSession={onSelect} />);
  const input = screen.getByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "q" } });
  fireEvent.keyDown(input, { key: "Enter" });

  const chip = await screen.findByRole("button", { name: /Sprint Planning/ });
  fireEvent.click(chip);
  expect(onSelect).toHaveBeenCalledWith("a1");
});

it("keeps the all-meetings conversation alive across selecting and deselecting a session (source-chip regression)", async () => {
  const { streamGraphChatReply } = await import("../api");
  async function* stream() {
    yield { type: "token" as const, token: "Hello world" };
  }
  vi.mocked(streamGraphChatReply).mockImplementation(() => stream());

  const { rerender } = render(
    <ChatWithSessions sessions={[sessionA, sessionB]} sessionsError={null} selectedId={null} />
  );
  const input = screen.getByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "what changed across meetings?" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(await screen.findByText("Hello world")).toBeInTheDocument();

  rerender(<ChatWithSessions sessions={[sessionA, sessionB]} sessionsError={null} selectedId="a1" />);
  expect(screen.getByText(/ask anything about this meeting's recording/i)).toBeInTheDocument();

  rerender(<ChatWithSessions sessions={[sessionA, sessionB]} sessionsError={null} selectedId={null} />);
  expect(screen.getByText("Hello world")).toBeInTheDocument();
});

it("streams chunks and appends them to the last assistant turn", async () => {
  vi.mocked(streamChatReply).mockImplementation(() => twoChunkStream());

  render(<ChatWithSessions sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  const input = await screen.findByPlaceholderText(/ask about this meeting/i);
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

  const { container } = render(<ChatWithSessions sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  const messagesContainers = container.querySelectorAll(".overflow-y-auto");
  const messagesContainer = messagesContainers[messagesContainers.length - 1];
  if (!messagesContainer) throw new Error("messages container not found");
  setScrollMetrics(messagesContainer, { scrollTop: 480, scrollHeight: 500, clientHeight: 20 });
  fireEvent.scroll(messagesContainer);
  const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  scrollIntoView.mockClear();

  const input = await screen.findByPlaceholderText(/ask about this meeting/i);
  fireEvent.change(input, { target: { value: "what happened?" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await screen.findByText("Hello world");
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
});

it("does not fight manual scrollback while a reply streams in", async () => {
  vi.mocked(streamChatReply).mockImplementation(() => twoChunkStream());

  const { container } = render(<ChatWithSessions sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  const messagesContainers = container.querySelectorAll(".overflow-y-auto");
  const messagesContainer = messagesContainers[messagesContainers.length - 1];
  if (!messagesContainer) throw new Error("messages container not found");
  setScrollMetrics(messagesContainer, { scrollTop: 0, scrollHeight: 500, clientHeight: 20 });
  fireEvent.scroll(messagesContainer);
  const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  scrollIntoView.mockClear();

  const input = await screen.findByPlaceholderText(/ask about this meeting/i);
  fireEvent.change(input, { target: { value: "what happened?" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await screen.findByText("Hello world");
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it("keeps following when a single chunk grows scrollHeight past the threshold while pinned at bottom (H2)", async () => {
  vi.mocked(streamChatReply).mockImplementation(() => twoChunkStream());

  const { container } = render(<ChatWithSessions sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  const messagesContainers = container.querySelectorAll(".overflow-y-auto");
  const messagesContainer = messagesContainers[messagesContainers.length - 1];
  if (!messagesContainer) throw new Error("messages container not found");
  setScrollMetrics(messagesContainer, { scrollTop: 480, scrollHeight: 500, clientHeight: 20 });
  fireEvent.scroll(messagesContainer);
  const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  scrollIntoView.mockClear();

  setScrollMetrics(messagesContainer, { scrollTop: 480, scrollHeight: 550, clientHeight: 20 });

  const input = await screen.findByPlaceholderText(/ask about this meeting/i);
  fireEvent.change(input, { target: { value: "what happened?" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await screen.findByText("Hello world");
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
});

it("aborts the stream when Stop is clicked and shows no error", async () => {
  vi.mocked(streamChatReply).mockImplementation((_id, _msg, _hist, signal) =>
    hangingStreamAfterFirstChunk(signal)
  );

  render(<ChatWithSessions sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  const input = await screen.findByPlaceholderText(/ask about this meeting/i);
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

it("keeps a typed follow-up in the input instead of discarding it when sent while already streaming", async () => {
  vi.mocked(streamChatReply).mockImplementation((_id, _msg, _hist, signal) =>
    hangingStreamAfterFirstChunk(signal)
  );

  render(<ChatWithSessions sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  const input = await screen.findByPlaceholderText(/ask about this meeting/i);
  fireEvent.change(input, { target: { value: "hi" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText("Hello");

  fireEvent.change(input, { target: { value: "follow-up" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(input).toHaveValue("follow-up");
  expect(screen.queryByText("follow-up")).not.toBeInTheDocument();
});

it("keeps streaming and preserves turns when the selected meeting changes away and back", async () => {
  // The actual bug this spec fixes: switching selectedId used to abort the
  // in-flight request and wipe `turns`. Now the request must keep running
  // and the full answer -- including whatever arrived while a different
  // meeting was displayed -- must be there on return.
  const { stream, release } = makeControllableStream();
  vi.mocked(streamChatReply).mockImplementation((_id, _msg, _hist, signal) => stream(signal));

  const { rerender } = render(
    <ChatWithSessions sessions={[sessionA, sessionB]} sessionsError={null} selectedId="a1" />
  );
  const input = await screen.findByPlaceholderText(/ask about this meeting/i);
  fireEvent.change(input, { target: { value: "hi" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText("Hello");

  // Switch away while the stream is still in flight.
  rerender(<ChatWithSessions sessions={[sessionA, sessionB]} sessionsError={null} selectedId="b2" />);
  expect(screen.getByText(sessionB.title, { exact: false })).toBeInTheDocument();

  // Let the rest of the response arrive while a1 isn't displayed.
  release();

  // Switch back -- the complete answer must be there, not a blank chat.
  rerender(<ChatWithSessions sessions={[sessionA, sessionB]} sessionsError={null} selectedId="a1" />);
  expect(await screen.findByText("Hello world")).toBeInTheDocument();
});

it("Stop only aborts the currently selected session's stream, not another meeting's", async () => {
  const streamA = makeControllableStream();
  const streamB = makeControllableStream();
  vi.mocked(streamChatReply).mockImplementation((id, _msg, _hist, signal) =>
    id === "a1" ? streamA.stream(signal) : streamB.stream(signal)
  );

  const { rerender } = render(
    <ChatWithSessions sessions={[sessionA, sessionB]} sessionsError={null} selectedId="a1" />
  );
  let input = await screen.findByPlaceholderText(/ask about this meeting/i);
  fireEvent.change(input, { target: { value: "hi a" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText("Hello");

  rerender(<ChatWithSessions sessions={[sessionA, sessionB]} sessionsError={null} selectedId="b2" />);
  input = await screen.findByPlaceholderText(/ask about this meeting/i);
  fireEvent.change(input, { target: { value: "hi b" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText("Hello");

  const stopButton = await screen.findByRole("button", { name: /stop response/i });
  fireEvent.click(stopButton);
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /stop response/i })).not.toBeInTheDocument();
  });

  // b2 stopped with no error; a1's stream is untouched and still completes.
  expect(screen.queryByText(/error:/i)).not.toBeInTheDocument();
  streamA.release();
  rerender(<ChatWithSessions sessions={[sessionA, sessionB]} sessionsError={null} selectedId="a1" />);
  expect(await screen.findByText("Hello world")).toBeInTheDocument();
});

it("shows an error message when the stream throws a non-abort error", async () => {
  vi.mocked(streamChatReply).mockImplementation(
    // eslint-disable-next-line require-yield -- intentionally throws before any yield, simulating a stream that fails immediately
    async function* () {
      throw new Error("model unavailable");
    }
  );

  render(<ChatWithSessions sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  const input = await screen.findByPlaceholderText(/ask about this meeting/i);
  fireEvent.change(input, { target: { value: "hi" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(await screen.findByText(/error: model unavailable/i)).toBeInTheDocument();
});

it("shows a distinct error message when sessions fail to load", () => {
  render(<ChatWithSessions sessions={null} sessionsError="Failed to fetch" selectedId={null} />);
  expect(screen.getByText(/couldn't load meetings: Failed to fetch/i)).toBeInTheDocument();
});

it("shows a neutral loading state instead of the sessions error while the backend isn't up yet (G9)", () => {
  render(
    <ChatWithSessions sessions={null} sessionsError="Failed to fetch" selectedId={null} backendUp={false} />
  );

  expect(screen.queryByText(/couldn't load meetings/i)).not.toBeInTheDocument();
  expect(screen.getByText(/loading/i)).toBeInTheDocument();
});

it("shows the real error once the backend lifecycle has permanently failed, instead of loading forever (re-review-12-13 H1/L1)", () => {
  render(
    <ChatWithSessions
      sessions={null}
      sessionsError="Failed to fetch"
      selectedId={null}
      backendUp={false}
      backendFailed={true}
    />
  );

  expect(screen.getByText(/couldn't load meetings: Failed to fetch/i)).toBeInTheDocument();
  expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
});
