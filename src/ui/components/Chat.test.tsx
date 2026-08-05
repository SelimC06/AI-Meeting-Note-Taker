import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Chat from "./Chat";
import { getSessions, streamChatReply, type Session } from "../api";

vi.mock("../api");

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

it("streams chunks and appends them to the last assistant turn", async () => {
  vi.mocked(getSessions).mockResolvedValue([sessionA]);
  vi.mocked(streamChatReply).mockImplementation(() => twoChunkStream());

  render(<Chat active />);
  const input = await screen.findByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "what happened?" } });
  fireEvent.click(screen.getByRole("button", { name: /send/i }));

  expect(await screen.findByText("Hello world")).toBeInTheDocument();
});

it("aborts the stream when Stop is clicked and shows no error", async () => {
  vi.mocked(getSessions).mockResolvedValue([sessionA]);
  vi.mocked(streamChatReply).mockImplementation((_id, _msg, _hist, signal) =>
    hangingStreamAfterFirstChunk(signal)
  );

  render(<Chat active />);
  const input = await screen.findByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "hi" } });
  fireEvent.click(screen.getByRole("button", { name: /send/i }));

  await screen.findByText("Hello");
  const stopButton = await screen.findByRole("button", { name: /stop response/i });
  fireEvent.click(stopButton);

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /stop response/i })).not.toBeInTheDocument();
  });
  expect(screen.queryByText(/error:/i)).not.toBeInTheDocument();
});

it("aborts the in-flight stream and clears turns when switching meetings", async () => {
  vi.mocked(getSessions).mockResolvedValue([sessionA, sessionB]);
  vi.mocked(streamChatReply).mockImplementation((_id, _msg, _hist, signal) =>
    hangingStreamAfterFirstChunk(signal)
  );

  render(<Chat active />);
  const input = await screen.findByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "hi" } });
  fireEvent.click(screen.getByRole("button", { name: /send/i }));
  await screen.findByText("Hello");

  fireEvent.click(screen.getByRole("button", { name: sessionA.title }));
  fireEvent.click(await screen.findByText(sessionB.title, { exact: false }));

  await waitFor(() => {
    expect(screen.queryByText("Hello")).not.toBeInTheDocument();
  });
  expect(screen.getByText(`ask about "${sessionB.title}"`)).toBeInTheDocument();
});

it("shows an error message when the stream throws a non-abort error", async () => {
  vi.mocked(getSessions).mockResolvedValue([sessionA]);
  vi.mocked(streamChatReply).mockImplementation(
    // eslint-disable-next-line require-yield -- intentionally throws before any yield, simulating a stream that fails immediately
    async function* () {
      throw new Error("model unavailable");
    }
  );

  render(<Chat active />);
  const input = await screen.findByLabelText("Chat message");
  fireEvent.change(input, { target: { value: "hi" } });
  fireEvent.click(screen.getByRole("button", { name: /send/i }));

  expect(await screen.findByText(/error: model unavailable/i)).toBeInTheDocument();
});
