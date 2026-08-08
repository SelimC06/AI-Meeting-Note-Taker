import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import App from "./App";
import {
  getSessions,
  checkHealth,
  getSettings,
  getOllamaModels,
  getStorageUsage,
  getHealthStatus,
  listJobs,
  type Session,
  type Settings,
} from "./api";

vi.mock("./api");

const sessionA: Session = {
  id: "a1",
  created_at: "2026-08-01T00:00:00Z",
  title: "Sprint Planning",
  notes: "Discussed roadmap.",
  video_path: "x",
  trashed_at: null,
};

const baseSettings: Settings = {
  whisper_model: "base.en",
  storage_dir: "C:\\recordings",
  ollama_chat_model: "llama3",
  whisper_model_choices: [],
};

beforeEach(() => {
  vi.mocked(getSessions).mockResolvedValue([sessionA]);
  vi.mocked(checkHealth).mockResolvedValue(true);
  vi.mocked(getSettings).mockResolvedValue(baseSettings);
  vi.mocked(getOllamaModels).mockResolvedValue({ ok: true, models: ["llama3"], error: null });
  vi.mocked(getHealthStatus).mockResolvedValue({ ok: true, backend: true, ollama: true });
  vi.mocked(listJobs).mockResolvedValue([]);
  vi.mocked(getStorageUsage).mockResolvedValue({
    used_bytes: 0,
    free_bytes: 100,
    total_bytes: 100,
    session_count: 1,
    trashed_count: 0,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("selecting a meeting in the sidebar shows it in the chat panel", async () => {
  render(<App />);
  const row = await screen.findByText("Sprint Planning");
  fireEvent.click(row);
  expect(await screen.findByText(/ask anything about this meeting's recording/i)).toBeInTheDocument();
});

it("clicking the gear icon opens SettingsModal", async () => {
  render(<App />);
  await screen.findByText("Sprint Planning");
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(await screen.findByText("[SETTINGS]")).toBeInTheDocument();
});
