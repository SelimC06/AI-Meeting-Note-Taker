import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

it("is a labelled modal dialog that focuses the confirm button (it opens from the rail window)", () => {
  render(<RecordingConsentModal onCancel={vi.fn()} onConfirm={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Let people know they're being recorded." });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(screen.getByRole("button", { name: "got it — start recording" })).toHaveFocus();
});

it("Escape cancels, and Tab stays inside the dialog", () => {
  const onCancel = vi.fn();
  render(<RecordingConsentModal onCancel={onCancel} onConfirm={vi.fn()} />);
  const confirm = screen.getByRole("button", { name: "got it — start recording" });
  fireEvent.keyDown(confirm, { key: "Tab" });
  expect(screen.getByRole("button", { name: "not now" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(onCancel).toHaveBeenCalledTimes(1);
});
