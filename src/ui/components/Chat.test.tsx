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

it("shows the all-meetings chat when meetings exist and nothing is selected", () => {
  render(<Chat sessions={[sessionA]} sessionsError={null} selectedId={null} />);
  expect(screen.getByText(/all meetings/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/ask across all your meetings/i)).toBeInTheDocument();
});

it("shows the Welcome panel's no-meetings state when there are no meetings", () => {
  render(<Chat sessions={[]} sessionsError={null} selectedId={null} />);
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

  render(<Chat sessions={[sessionA]} sessionsError={null} selectedId={null} onSelectSession={onSelect} />);
  const input = screen.getByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "q" } });
  fireEvent.keyDown(input, { key: "Enter" });

  const chip = await screen.findByRole("button", { name: /Sprint Planning/ });
  fireEvent.click(chip);
  expect(onSelect).toHaveBeenCalledWith("a1");
});

it("keeps the all-meetings conversation alive across selecting and deselecting a session (source-chip regression)", async () => {
  // Regression test: AllMeetingsChat used to be conditionally rendered only
  // while nothing was selected, so clicking a source chip (which selects a
  // session) unmounted it and threw away its `turns` state. The fix keeps
  // it mounted and toggles visibility instead, so the SAME component
  // instance must survive a selectedId change -- hence rerender() on the
  // same render() result rather than a fresh render() call.
  const { streamGraphChatReply } = await import("../api");
  async function* stream() {
    yield { type: "token" as const, token: "Hello world" };
  }
  vi.mocked(streamGraphChatReply).mockImplementation(() => stream());

  const { rerender } = render(
    <Chat sessions={[sessionA, sessionB]} sessionsError={null} selectedId={null} />
  );
  const input = screen.getByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "what changed across meetings?" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(await screen.findByText("Hello world")).toBeInTheDocument();

  rerender(<Chat sessions={[sessionA, sessionB]} sessionsError={null} selectedId="a1" />);
  expect(screen.getByText(/ask anything about this meeting's recording/i)).toBeInTheDocument();

  rerender(<Chat sessions={[sessionA, sessionB]} sessionsError={null} selectedId={null} />);
  expect(screen.getByText("Hello world")).toBeInTheDocument();
});

it("streams chunks and appends them to the last assistant turn", async () => {
  vi.mocked(streamChatReply).mockImplementation(() => twoChunkStream());

  render(<Chat sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  // AllMeetingsChat now stays mounted (hidden) alongside the per-session
  // chat whenever a session is selected (source-chip fix), so "Chat
  // message" alone matches two inputs -- disambiguate by placeholder,
  // which differs between the two chat UIs.
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

  const { container } = render(<Chat sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  // Two ".overflow-y-auto" containers exist once a session is selected --
  // AllMeetingsChat's (kept mounted but hidden, source-chip fix) and the
  // per-session one. The per-session container is the one rendered last in
  // DOM order.
  const messagesContainers = container.querySelectorAll(".overflow-y-auto");
  const messagesContainer = messagesContainers[messagesContainers.length - 1];
  if (!messagesContainer) throw new Error("messages container not found");
  // Already scrolled to (within a few px of) the bottom. A real scroll
  // event is what actually updates the "following" ref (H2) -- setting the
  // metrics alone doesn't, since jsdom never fires 'scroll' just because a
  // property was overridden.
  setScrollMetrics(messagesContainer, { scrollTop: 480, scrollHeight: 500, clientHeight: 20 });
  fireEvent.scroll(messagesContainer);
  const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  scrollIntoView.mockClear(); // discard the mount-time call (default 0/0/0 metrics also count as "near bottom")

  // AllMeetingsChat now stays mounted (hidden) alongside the per-session
  // chat whenever a session is selected (source-chip fix), so "Chat
  // message" alone matches two inputs -- disambiguate by placeholder,
  // which differs between the two chat UIs.
  const input = await screen.findByPlaceholderText(/ask about this meeting/i);
  fireEvent.change(input, { target: { value: "what happened?" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await screen.findByText("Hello world");
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
});

it("does not fight manual scrollback while a reply streams in", async () => {
  vi.mocked(streamChatReply).mockImplementation(() => twoChunkStream());

  const { container } = render(<Chat sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  // Two ".overflow-y-auto" containers exist once a session is selected --
  // AllMeetingsChat's (kept mounted but hidden, source-chip fix) and the
  // per-session one. The per-session container is the one rendered last in
  // DOM order.
  const messagesContainers = container.querySelectorAll(".overflow-y-auto");
  const messagesContainer = messagesContainers[messagesContainers.length - 1];
  if (!messagesContainer) throw new Error("messages container not found");
  // Scrolled well away from the bottom, reading earlier messages.
  setScrollMetrics(messagesContainer, { scrollTop: 0, scrollHeight: 500, clientHeight: 20 });
  fireEvent.scroll(messagesContainer);
  const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  scrollIntoView.mockClear();

  // AllMeetingsChat now stays mounted (hidden) alongside the per-session
  // chat whenever a session is selected (source-chip fix), so "Chat
  // message" alone matches two inputs -- disambiguate by placeholder,
  // which differs between the two chat UIs.
  const input = await screen.findByPlaceholderText(/ask about this meeting/i);
  fireEvent.change(input, { target: { value: "what happened?" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await screen.findByText("Hello world");
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it("keeps following when a single chunk grows scrollHeight past the threshold while pinned at bottom (H2)", async () => {
  // Regression test: the old effect measured distanceFromBottom AFTER the
  // triggering chunk was already in the DOM, so a chunk that alone grows
  // scrollHeight by more than NEAR_BOTTOM_THRESHOLD_PX (any two-line chunk)
  // would fail the "near bottom" check even for a user who was pinned at
  // the bottom right before it arrived. The fix decides from the
  // following-ref (last real scroll event) instead of re-measuring, so a
  // content-only scrollHeight change -- which never fires 'scroll' on its
  // own -- must not affect the decision.
  vi.mocked(streamChatReply).mockImplementation(() => twoChunkStream());

  const { container } = render(<Chat sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  // Two ".overflow-y-auto" containers exist once a session is selected --
  // AllMeetingsChat's (kept mounted but hidden, source-chip fix) and the
  // per-session one. The per-session container is the one rendered last in
  // DOM order.
  const messagesContainers = container.querySelectorAll(".overflow-y-auto");
  const messagesContainer = messagesContainers[messagesContainers.length - 1];
  if (!messagesContainer) throw new Error("messages container not found");
  setScrollMetrics(messagesContainer, { scrollTop: 480, scrollHeight: 500, clientHeight: 20 });
  fireEvent.scroll(messagesContainer);
  const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  scrollIntoView.mockClear();

  // Simulate the incoming chunk growing scrollHeight well past the
  // threshold, without any accompanying user scroll -- content growth alone
  // never fires 'scroll' in a real browser either.
  setScrollMetrics(messagesContainer, { scrollTop: 480, scrollHeight: 550, clientHeight: 20 });

  // AllMeetingsChat now stays mounted (hidden) alongside the per-session
  // chat whenever a session is selected (source-chip fix), so "Chat
  // message" alone matches two inputs -- disambiguate by placeholder,
  // which differs between the two chat UIs.
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

  render(<Chat sessions={[sessionA]} sessionsError={null} selectedId="a1" />);
  // AllMeetingsChat now stays mounted (hidden) alongside the per-session
  // chat whenever a session is selected (source-chip fix), so "Chat
  // message" alone matches two inputs -- disambiguate by placeholder,
  // which differs between the two chat UIs.
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

it("aborts the in-flight stream and clears turns when the selected meeting changes", async () => {
  vi.mocked(streamChatReply).mockImplementation((_id, _msg, _hist, signal) =>
    hangingStreamAfterFirstChunk(signal)
  );

  const { rerender } = render(
    <Chat sessions={[sessionA, sessionB]} sessionsError={null} selectedId="a1" />
  );
  // AllMeetingsChat now stays mounted (hidden) alongside the per-session
  // chat whenever a session is selected (source-chip fix), so "Chat
  // message" alone matches two inputs -- disambiguate by placeholder,
  // which differs between the two chat UIs.
  const input = await screen.findByPlaceholderText(/ask about this meeting/i);
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
  // AllMeetingsChat now stays mounted (hidden) alongside the per-session
  // chat whenever a session is selected (source-chip fix), so "Chat
  // message" alone matches two inputs -- disambiguate by placeholder,
  // which differs between the two chat UIs.
  const input = await screen.findByPlaceholderText(/ask about this meeting/i);
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

it("shows the real error once the backend lifecycle has permanently failed, instead of loading forever (re-review-12-13 H1/L1)", () => {
  // Regression test: backendUp (the 15s health poll) stays false forever
  // once the backend lifecycle reaches 'failed', so gating solely on it
  // left this stuck on "loading" forever with no way to ever see the
  // error. backendFailed lifts the suppression once that's known.
  render(
    <Chat
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
