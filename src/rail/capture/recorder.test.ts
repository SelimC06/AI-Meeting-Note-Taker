import { afterEach, beforeEach, expect, it } from "vitest";
import { extensionForMimeType, getRecorder } from "./recorder";

// jsdom does not implement MediaStream/MediaRecorder. This stub mirrors the
// real MediaRecorder state machine closely enough to reproduce the bug:
// calling stop() while state is already "inactive" throws InvalidStateError,
// exactly like the browser does.
class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }

  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = "video/webm";


  start(): void {
    this.state = "recording";
  }

  pause(): void {
    this.state = "paused";
  }

  resume(): void {
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") {
      throw Object.assign(
        new Error("Failed to execute 'stop' on 'MediaRecorder': The MediaRecorder's state is inactive."),
        { name: "InvalidStateError" }
      );
    }
    this.state = "inactive";
    this.onstop?.();
  }
}

let originalMediaRecorder: unknown;

beforeEach(() => {
  originalMediaRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  (globalThis as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
});

afterEach(() => {
  (globalThis as { MediaRecorder: unknown }).MediaRecorder = originalMediaRecorder;
});

it("stop() resolves instead of throwing when called on an already-inactive recorder", async () => {
  const fakeStream = {} as MediaStream;
  const rec = getRecorder(fakeStream, "video/webm");

  rec.start();
  await expect(rec.stop()).resolves.toBeUndefined();

  // The bug: calling stop() again (e.g. a double-click, or a caller that
  // doesn't track whether stop() already ran) must not throw/reject.
  await expect(rec.stop()).resolves.toBeUndefined();
});

it("ondata fires for every chunk, including the final flush stop() triggers, without the recorder retaining its own copy", () => {
  const fakeStream = {} as MediaStream;
  const rec = getRecorder(fakeStream, "video/webm");
  const received: Blob[] = [];
  rec.ondata((chunk) => received.push(chunk));

  rec.start();
  const chunk1 = new Blob(["a"]);
  const chunk2 = new Blob(["b"]);
  rec.mediaRecorder.ondataavailable?.({ data: chunk1 } as BlobEvent);
  rec.mediaRecorder.ondataavailable?.({ data: chunk2 } as BlobEvent);

  expect(received).toEqual([chunk1, chunk2]);
});

it("two stop() calls made while still recording return the same promise and both resolve after onstop fires once", async () => {
  const fakeStream = {} as MediaStream;
  const rec = getRecorder(fakeStream, "video/webm");

  rec.start();
  const first = rec.stop();
  const second = rec.stop();

  expect(second).toBe(first);
  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();
});

it("ignores an ondataavailable event with a zero-size (or missing) data payload", () => {
  const fakeStream = {} as MediaStream;
  const rec = getRecorder(fakeStream, "video/webm");
  const received: Blob[] = [];
  rec.ondata((chunk) => received.push(chunk));

  rec.start();
  rec.mediaRecorder.ondataavailable?.({ data: new Blob([]) } as BlobEvent);
  rec.mediaRecorder.ondataavailable?.({ data: undefined } as unknown as BlobEvent);

  expect(received).toEqual([]);
});

it("extensionForMimeType maps a recorder mimeType to its container's file extension", () => {
  expect(extensionForMimeType("audio/ogg;codecs=opus")).toBe("ogg");
  expect(extensionForMimeType("audio/webm;codecs=opus")).toBe("webm");
  expect(extensionForMimeType("video/mp4")).toBe("mp4");
  expect(extensionForMimeType("")).toBe("webm");
  expect(extensionForMimeType(undefined)).toBe("webm");
  expect(extensionForMimeType("application/x-unknown")).toBe("webm");
});

it("pause()/resume() are no-ops on a recorder that went inactive by itself (no InvalidStateError)", () => {
  class StrictRecorder extends FakeMediaRecorder {
    pause(): void {
      if (this.state !== "recording") throw Object.assign(new Error("invalid"), { name: "InvalidStateError" });
      super.pause();
    }
    resume(): void {
      if (this.state !== "paused") throw Object.assign(new Error("invalid"), { name: "InvalidStateError" });
      super.resume();
    }
  }
  (globalThis as { MediaRecorder: unknown }).MediaRecorder = StrictRecorder;
  const rec = getRecorder({} as MediaStream, "video/webm");

  // Never started / track ended: state is "inactive".
  expect(() => rec.pause()).not.toThrow();
  expect(() => rec.resume()).not.toThrow();

  rec.start();
  rec.pause();
  expect(rec.mediaRecorder.state).toBe("paused");
  expect(() => rec.pause()).not.toThrow(); // already paused
  rec.resume();
  expect(rec.mediaRecorder.state).toBe("recording");
});
