import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SettingsModal from "./SettingsModal";
import {
  getOllamaModels,
  getSettings,
  getStorageUsage,
  type Settings,
} from "../api";

vi.mock("../api");

const baseSettings: Settings = {
  whisper_model: "base.en",
  storage_dir: "C:\\recordings",
  ollama_chat_model: "llama3",
  custom_vocabulary: "",
  whisper_model_choices: [],
};

beforeEach(() => {
  vi.mocked(getSettings).mockResolvedValue(baseSettings);
  vi.mocked(getStorageUsage).mockResolvedValue({
    used_bytes: 0,
    free_bytes: 100,
    total_bytes: 100,
    session_count: 0,
    trashed_count: 0,
  });
  vi.mocked(getOllamaModels).mockResolvedValue({ ok: true, models: ["llama3"], error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("renders the settings page content", async () => {
  render(<SettingsModal active onClose={() => {}} />);
  expect(await screen.findByText("[SETTINGS]")).toBeInTheDocument();
});

it("calls onClose when the close button is clicked", async () => {
  const onClose = vi.fn();
  render(<SettingsModal active onClose={onClose} />);
  await screen.findByText("[SETTINGS]");
  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("calls onClose on Escape", async () => {
  const onClose = vi.fn();
  render(<SettingsModal active onClose={onClose} />);
  await screen.findByText("[SETTINGS]");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("is a modal dialog labelled [SETTINGS] that takes focus and gives it back on close", () => {
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  try {
    const { unmount } = render(<SettingsModal active onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "[SETTINGS]" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.contains(document.activeElement)).toBe(true);

    unmount();
    expect(opener).toHaveFocus();
  } finally {
    opener.remove();
  }
});
