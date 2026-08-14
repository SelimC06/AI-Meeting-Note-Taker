import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatSessions } from "./useChatSessions";
import { streamChatReply } from "../api";

vi.mock("../api");

afterEach(() => {
  vi.clearAllMocks();
});

async function* twoChunkStream(): AsyncGenerator<string> {
  yield "Hello ";
  yield "world";
}

// Yields one chunk, then waits on a gate the test controls (resolved via
// release()) instead of only responding to abort -- lets tests prove a
// stream can keep running and complete normally while "elsewhere".
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

it("getState returns the empty shape for a session that has never sent a message", () => {
  const { result } = renderHook(() => useChatSessions());
  expect(result.current.getState("unseen")).toEqual({ turns: [], isStreaming: false, error: null });
});

it("sendMessage appends the user turn then streams into the assistant turn", async () => {
  vi.mocked(streamChatReply).mockImplementation(() => twoChunkStream());
  const { result } = renderHook(() => useChatSessions());

  await act(async () => {
    await result.current.sendMessage("a1", "hi");
  });

  expect(result.current.getState("a1").turns).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: "Hello world" },
  ]);
  expect(result.current.getState("a1").isStreaming).toBe(false);
});

it("does not start a second send for the same session while one is streaming", async () => {
  const { stream, release } = makeControllableStream();
  vi.mocked(streamChatReply).mockImplementation((_id, _msg, _hist, signal) => stream(signal));
  const { result } = renderHook(() => useChatSessions());

  let firstSend!: Promise<void>;
  act(() => {
    firstSend = result.current.sendMessage("a1", "first");
  });
  await waitFor(() => expect(result.current.getState("a1").isStreaming).toBe(true));

  await act(async () => {
    await result.current.sendMessage("a1", "second"); // must be a no-op
  });
  expect(result.current.getState("a1").turns).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "Hello" },
  ]);

  release();
  await act(async () => {
    await firstSend;
  });
  expect(result.current.getState("a1").turns).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "Hello world" },
  ]);
});

it("keeps two sessions' state independent while both are mid-stream", async () => {
  const streamA = makeControllableStream();
  const streamB = makeControllableStream();
  vi.mocked(streamChatReply).mockImplementation((id, _msg, _hist, signal) =>
    id === "a1" ? streamA.stream(signal) : streamB.stream(signal)
  );
  const { result } = renderHook(() => useChatSessions());

  let sendA!: Promise<void>;
  let sendB!: Promise<void>;
  act(() => {
    sendA = result.current.sendMessage("a1", "hi a");
    sendB = result.current.sendMessage("b2", "hi b");
  });
  await waitFor(() => {
    expect(result.current.getState("a1").isStreaming).toBe(true);
    expect(result.current.getState("b2").isStreaming).toBe(true);
  });

  streamA.release();
  await act(async () => {
    await sendA;
  });
  expect(result.current.getState("a1").turns[1]).toEqual({ role: "assistant", content: "Hello world" });
  expect(result.current.getState("b2").turns[1]).toEqual({ role: "assistant", content: "Hello" }); // unaffected

  streamB.release();
  await act(async () => {
    await sendB;
  });
  expect(result.current.getState("b2").turns[1]).toEqual({ role: "assistant", content: "Hello world" });
});

it("stopSession aborts only the targeted session's controller", async () => {
  const streamA = makeControllableStream();
  const streamB = makeControllableStream();
  vi.mocked(streamChatReply).mockImplementation((id, _msg, _hist, signal) =>
    id === "a1" ? streamA.stream(signal) : streamB.stream(signal)
  );
  const { result } = renderHook(() => useChatSessions());

  let sendA!: Promise<void>;
  let sendB!: Promise<void>;
  act(() => {
    sendA = result.current.sendMessage("a1", "hi a");
    sendB = result.current.sendMessage("b2", "hi b");
  });
  await waitFor(() => {
    expect(result.current.getState("a1").isStreaming).toBe(true);
    expect(result.current.getState("b2").isStreaming).toBe(true);
  });

  act(() => {
    result.current.stopSession("a1");
  });
  await act(async () => {
    await sendA;
  });
  expect(result.current.getState("a1").isStreaming).toBe(false);
  expect(result.current.getState("a1").error).toBeNull(); // AbortError is swallowed, not surfaced
  expect(result.current.getState("b2").isStreaming).toBe(true); // untouched

  streamB.release();
  await act(async () => {
    await sendB;
  });
  expect(result.current.getState("b2").turns[1]).toEqual({ role: "assistant", content: "Hello world" });
});

it("discardSession aborts an in-flight stream and removes the session's state", async () => {
  const { stream } = makeControllableStream();
  vi.mocked(streamChatReply).mockImplementation((_id, _msg, _hist, signal) => stream(signal));
  const { result } = renderHook(() => useChatSessions());

  let send!: Promise<void>;
  act(() => {
    send = result.current.sendMessage("a1", "hi");
  });
  await waitFor(() => expect(result.current.getState("a1").isStreaming).toBe(true));

  act(() => {
    result.current.discardSession("a1");
  });
  await act(async () => {
    await send;
  });
  expect(result.current.getState("a1")).toEqual({ turns: [], isStreaming: false, error: null });
});

it("stores a non-abort error on the session instead of throwing it out of the hook", async () => {
  vi.mocked(streamChatReply).mockImplementation(
    // eslint-disable-next-line require-yield -- intentionally throws before any yield
    async function* () {
      throw new Error("model unavailable");
    }
  );
  const { result } = renderHook(() => useChatSessions());

  await act(async () => {
    await result.current.sendMessage("a1", "hi"); // must not throw
  });

  expect(result.current.getState("a1").error).toBe("model unavailable");
  expect(result.current.getState("a1").isStreaming).toBe(false);
});
