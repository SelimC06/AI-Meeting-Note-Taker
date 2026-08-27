import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import RecordingConsentModal from "./RecordingConsentModal";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows Screen Recording guidance only on darwin", () => {
  vi.stubGlobal("electronAPI", { platform: "darwin" });
  render(<RecordingConsentModal onCancel={vi.fn()} onConfirm={vi.fn()} />);
  expect(screen.getByText(/Screen Recording permission/)).toBeInTheDocument();
});

it("omits Screen Recording guidance on win32", () => {
  vi.stubGlobal("electronAPI", { platform: "win32" });
  render(<RecordingConsentModal onCancel={vi.fn()} onConfirm={vi.fn()} />);
  expect(screen.queryByText(/Screen Recording permission/)).not.toBeInTheDocument();
});
