import { afterEach, expect, it, vi } from "vitest";
import { streamChatReply } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Builds a fetch Response whose body is a ReadableStream yielding the given
// byte chunks one at a time, simulating how the network actually delivers
// bytes (which does not respect UTF-8 character or line boundaries).
function streamResponseFromChunks(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

// Wraps a stream's getReader() so the returned reader's cancel() is spied on
// -- a fully-read (already closed) stream's real cancel() is a spec-defined
// no-op that never reaches the underlying source, so watching for that
// side effect can't tell us whether streamChatReply actually called it.
function trackReaderCancel(stream: ReadableStream<Uint8Array>) {
  const originalGetReader = stream.getReader.bind(stream);
  const cancelSpy = vi.fn();
  (stream as unknown as { getReader: typeof stream.getReader }).getReader = ((...args: []) => {
    const reader = originalGetReader(...args);
    const originalCancel = reader.cancel.bind(reader);
    reader.cancel = (reason?: unknown) => {
      cancelSpy(reason);
      return originalCancel(reason);
    };
    return reader;
  }) as typeof stream.getReader;
  return cancelSpy;
}

it("flushes a multi-byte UTF-8 character split across two network chunks", async () => {
  // "café" -- the "é" encodes to the two bytes 0xC3 0xA9. Split the NDJSON
  // line right between them so neither chunk alone is valid UTF-8.
  const line = JSON.stringify({ token: "café" }) + "\n";
  const bytes = new TextEncoder().encode(line);
  const splitIndex = bytes.indexOf(0xc3) + 1; // right after the first byte of "é"

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      streamResponseFromChunks([bytes.slice(0, splitIndex), bytes.slice(splitIndex)])
    )
  );

  const chunks = await collect(streamChatReply("s1", "hi", []));
  expect(chunks.join("")).toBe("café");
});

it("throws on a mid-stream {error} line instead of yielding it as text", async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ token: "chunk one" }) + "\n" + JSON.stringify({ error: "ollama died" }) + "\n"
  );

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponseFromChunks([bytes])));

  const gen = streamChatReply("s1", "hi", []);
  const received: string[] = [];
  await expect(
    (async () => {
      for await (const chunk of gen) received.push(chunk);
    })()
  ).rejects.toThrow("Chat failed mid-response: ollama died");
  expect(received).toEqual(["chunk one"]);
});

it("treats a truncated NDJSON tail as a connection interruption, not a raw SyntaxError", async () => {
  // The backend died mid-line (crash, watchdog restart): the stream ends
  // cleanly (no error, no more bytes) but the last "line" is a truncated
  // JSON fragment.
  const bytes = new TextEncoder().encode(
    JSON.stringify({ token: "chunk one" }) + "\n" + '{"token": "hal'
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const cancelSpy = trackReaderCancel(stream);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

  const gen = streamChatReply("s1", "hi", []);
  const received: string[] = [];
  await expect(
    (async () => {
      for await (const chunk of gen) received.push(chunk);
    })()
  ).rejects.toThrow("Chat connection was interrupted before the reply finished.");
  expect(received).toEqual(["chunk one"]);
  expect(cancelSpy).toHaveBeenCalled();
});

it("cancels the stream reader once the generator completes cleanly", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ token: "hi" }) + "\n");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const cancelSpy = trackReaderCancel(stream);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

  const chunks = await collect(streamChatReply("s1", "hi", []));
  expect(chunks).toEqual(["hi"]);
  expect(cancelSpy).toHaveBeenCalled();
});

it("cancels the stream reader on a mid-stream {error} line too", async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ token: "chunk one" }) + "\n" + JSON.stringify({ error: "ollama died" }) + "\n"
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const cancelSpy = trackReaderCancel(stream);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

  const gen = streamChatReply("s1", "hi", []);
  await expect(
    (async () => {
      for await (const chunk of gen) {
        void chunk; // drain
      }
    })()
  ).rejects.toThrow("Chat failed mid-response: ollama died");
  expect(cancelSpy).toHaveBeenCalled();
});
