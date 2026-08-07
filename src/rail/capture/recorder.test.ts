import { afterEach, beforeEach, expect, it } from "vitest";
import { getRecorder } from "./recorder";

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
  const firstBlob = await rec.stop();
  expect(firstBlob).toBeInstanceOf(Blob);

  // The bug: calling stop() again (e.g. a double-click, or a caller that
  // doesn't track whether stop() already ran) must not throw/reject.
  const secondBlob = await rec.stop();
  expect(secondBlob).toBeInstanceOf(Blob);
});
