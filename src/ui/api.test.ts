import { afterEach, expect, it, vi } from "vitest";
import {
  BACKEND_TOKEN_HEADER,
  backendFetch,
  checkHealth,
  exportSessionZipUrl,
  getHealthStatus,
  getJobStatus,
  getSessionTranscript,
  getSessions,
  getSettings,
  recoverSessionsIndex,
  SESSIONS_INDEX_CORRUPT,
  type ApiError,
  listJobs,
  startProcessing,
  updateSettings,
  updateSpeakerNames,
  streamChatReply,
  streamGraphChatReply,
  type GraphChatEvent,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.BACKEND_CONFIG;
});

function headersOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Headers {
  const init = fetchMock.mock.calls[call][1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

it("sends the per-launch token from BACKEND_CONFIG on every kind of request", async () => {
  window.BACKEND_CONFIG = { port: null, token: "launch-token" };
  const fetchMock = vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify({ segments: [] }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);

  await checkHealth();
  await getSettings();
  await listJobs();
  await updateSettings({ whisper_model: "base.en" });
  await startProcessing(new FormData());
  await backendFetch(exportSessionZipUrl("s1"));
  fetchMock.mockResolvedValueOnce(streamResponseFromChunks([new TextEncoder().encode("")]));
  await collect(streamChatReply("s1", "hi", []));
  fetchMock.mockResolvedValueOnce(streamResponseFromChunks([new TextEncoder().encode("")]));
  await collectEvents(streamGraphChatReply("hi", []));

  expect(fetchMock).toHaveBeenCalledTimes(8);
  for (let i = 0; i < fetchMock.mock.calls.length; i++) {
    expect(headersOf(fetchMock, i).get(BACKEND_TOKEN_HEADER), `call ${i}`).toBe("launch-token");
  }
});

it("keeps caller headers (e.g. Content-Type) alongside the token", async () => {
  window.BACKEND_CONFIG = { port: null, token: "launch-token" };
  const fetchMock = vi.fn().mockResolvedValue(streamResponseFromChunks([new TextEncoder().encode("")]));
  vi.stubGlobal("fetch", fetchMock);

  await collect(streamChatReply("s1", "hi", []));

  const headers = headersOf(fetchMock);
  expect(headers.get("Content-Type")).toBe("application/json");
  expect(headers.get(BACKEND_TOKEN_HEADER)).toBe("launch-token");
});

it("omits the token header when no token is available (not an empty header)", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await listJobs();

  expect(headersOf(fetchMock).has(BACKEND_TOKEN_HEADER)).toBe(false);
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

async function collectEvents(gen: AsyncGenerator<GraphChatEvent>): Promise<GraphChatEvent[]> {
  const out: GraphChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

it("graph chat: yields the sources line as a sources event before token events", async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ sources: [{ id: "m1", title: "Kickoff", created_at: "2026-08-01T10:00:00Z" }] }) + "\n" +
      JSON.stringify({ token: "Hello " }) + "\n" +
      JSON.stringify({ token: "there." }) + "\n"
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponseFromChunks([bytes])));

  const events = await collectEvents(streamGraphChatReply("hi", []));
  expect(events[0]).toEqual({
    type: "sources",
    sources: [{ id: "m1", title: "Kickoff", created_at: "2026-08-01T10:00:00Z" }],
  });
  expect(events.slice(1)).toEqual([
    { type: "token", token: "Hello " },
    { type: "token", token: "there." },
  ]);
});

it("graph chat: posts to /graph/chat with message and history", async () => {
  const fetchMock = vi.fn().mockResolvedValue(streamResponseFromChunks([new TextEncoder().encode("")]));
  vi.stubGlobal("fetch", fetchMock);

  await collectEvents(streamGraphChatReply("question", [{ role: "user", content: "prior" }]));
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toMatch(/\/graph\/chat$/);
  expect(JSON.parse((init as RequestInit).body as string)).toEqual({
    message: "question",
    history: [{ role: "user", content: "prior" }],
  });
});

it("graph chat: throws on a mid-stream error line", async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ sources: [] }) + "\n" +
      JSON.stringify({ token: "chunk one" }) + "\n" +
      JSON.stringify({ error: "ollama died" }) + "\n"
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponseFromChunks([bytes])));

  const received: GraphChatEvent[] = [];
  await expect(
    (async () => {
      for await (const ev of streamGraphChatReply("hi", [])) received.push(ev);
    })()
  ).rejects.toThrow("Chat failed mid-response: ollama died");
  expect(received).toEqual([
    { type: "sources", sources: [] },
    { type: "token", token: "chunk one" },
  ]);
});

it("graph chat: treats a truncated NDJSON tail as a connection interruption", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ sources: [] }) + "\n" + '{"token": "hal');
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponseFromChunks([bytes])));

  await expect(collectEvents(streamGraphChatReply("hi", []))).rejects.toThrow(
    "Chat connection was interrupted before the reply finished."
  );
});

it("getSessionTranscript returns the parsed segments", async () => {
  const segments = [
    { start: 0, end: 1.5, speaker: "You", text: "hello" },
    { start: 1.5, end: 3, speaker: "Others", text: "hi there" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ segments }), { status: 200 }))
  );

  const result = await getSessionTranscript("s1");
  expect(result).toEqual(segments);
});

it("getSessionTranscript throws on a failed request", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));

  await expect(getSessionTranscript("missing")).rejects.toThrow(
    "Failed to load transcript: 404"
  );
});

it("getSessionTranscript passes through arbitrary speaker labels (Track B: SPEAKER_N)", async () => {
  const segments = [{ start: 0, end: 1, speaker: "SPEAKER_00", text: "hi" }];
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ segments }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const result = await getSessionTranscript("s1");
  expect(result).toEqual(segments);
});

it("updateSpeakerNames PATCHes the rename endpoint and returns the merged map", async () => {
  const speaker_names = { SPEAKER_00: "Alice" };
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ speaker_names }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const result = await updateSpeakerNames("s1", { SPEAKER_00: "Alice" });

  expect(result).toEqual(speaker_names);
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toContain("/sessions/s1/speaker-names");
  expect(options.method).toBe("PATCH");
  expect(JSON.parse(options.body)).toEqual({ names: { SPEAKER_00: "Alice" } });
});

it("updateSpeakerNames throws on a failed request", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));

  await expect(updateSpeakerNames("missing", { SPEAKER_00: "Alice" })).rejects.toThrow(
    "Failed to update speaker names: 404"
  );
});

it("getSessions surfaces the damaged-index 503 message and code", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ detail: { code: "sessions_index_corrupt", message: "The meeting library index is damaged" } }),
        { status: 503 }
      )
    )
  );

  const err = (await getSessions().catch((e) => e)) as ApiError;
  expect(err.message).toBe("The meeting library index is damaged");
  expect(err.code).toBe(SESSIONS_INDEX_CORRUPT);
});

it("getSessions keeps the generic message for other failures", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));

  const err = (await getSessions().catch((e) => e)) as ApiError;
  expect(err.message).toBe("Failed to load sessions: 500");
  expect(err.code).toBeUndefined();
});

it("recoverSessionsIndex posts to /sessions/recover-index and surfaces a failure detail", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ source: "backup", restored: 3, adopted: 0, preserved_copy: "x" }), { status: 200 })
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Wait for processing to finish before recovering the library" }), {
        status: 409,
      })
    );
  vi.stubGlobal("fetch", fetchMock);

  await expect(recoverSessionsIndex()).resolves.toMatchObject({ source: "backup", restored: 3 });
  expect(fetchMock.mock.calls[0][0]).toMatch(/\/sessions\/recover-index$/);
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
  await expect(recoverSessionsIndex()).rejects.toThrow("Wait for processing to finish");
});

it("getHealthStatus passes settings_error through, defaulting to null", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, backend: true, ollama: false, settings_error: "damaged" }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, backend: true, ollama: false }), { status: 200 }))
  );

  expect((await getHealthStatus()).settings_error).toBe("damaged");
  expect((await getHealthStatus()).settings_error).toBeNull();
});

it("encodes session and job ids into request paths", async () => {
  const fetchMock = vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify({ segments: [] }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);

  await getSessionTranscript("a/../b?x#y");
  expect(fetchMock.mock.calls[0][0]).toMatch(/\/sessions\/a%2F\.\.%2Fb%3Fx%23y\/transcript$/);

  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: "j" }), { status: 200 }));
  await getJobStatus("j/1");
  expect(fetchMock.mock.calls[1][0]).toMatch(/\/jobs\/j%2F1$/);
  expect(exportSessionZipUrl("a b")).toMatch(/\/sessions\/a%20b\/export\/zip$/);
});

it("listJobs and getJobStatus pass a caller's abort signal through to fetch", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();

  await listJobs(controller.signal);

  expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
});
