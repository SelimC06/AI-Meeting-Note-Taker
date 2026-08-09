import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  vi.unstubAllGlobals();
});

function stubRailWindowControls() {
  let statusCallback: ((s: { status: string }) => void) | undefined;
  let floatingCallback: ((floating: boolean) => void) | undefined;
  const onRailStatus = vi.fn((cb: (s: { status: string }) => void) => {
    statusCallback = cb;
    return () => {};
  });
  const onRailFloating = vi.fn((cb: (floating: boolean) => void) => {
    floatingCallback = cb;
    return () => {};
  });
  vi.stubGlobal("windowControls", {
    onRailStatus,
    onRailFloating,
    getRailFloating: vi.fn().mockResolvedValue(false),
    sendRailCommand: vi.fn(),
    onRailCommand: vi.fn(() => () => {}),
    pushRailStatus: vi.fn(),
    beginRailFloatDrag: vi.fn(),
    railFloatDragMove: vi.fn(),
    endRailFloatDrag: vi.fn(),
    updateDockSlotRect: vi.fn(),
    reattachRail: vi.fn().mockResolvedValue(undefined),
    onRailPopState: vi.fn(() => () => {}),
  });
  return {
    emitStatus: (status: string) => act(() => statusCallback?.({ status })),
    emitFloating: (floating: boolean) => act(() => floatingCallback?.(floating)),
  };
}

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

it("blocks collapsing the sidebar while recording is active and the rail is docked, to avoid stranding its controls", async () => {
  const { emitStatus } = stubRailWindowControls();
  render(<App />);
  await screen.findByText("Sprint Planning");

  emitStatus("recording");
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

  expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
});

it("allows collapsing the sidebar while recording once the rail is floating, since its controls no longer live in the sidebar", async () => {
  const { emitStatus, emitFloating } = stubRailWindowControls();
  render(<App />);
  await screen.findByText("Sprint Planning");

  emitStatus("recording");
  emitFloating(true);
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
});

it("blurs whatever got auto-focused on the first window-focus event after launch, but leaves later focus alone", async () => {
  render(<App />);
  await screen.findByText("Sprint Planning");

  const settingsButton = screen.getByRole("button", { name: "Settings" });
  settingsButton.focus();
  expect(document.activeElement).toBe(settingsButton);

  // Simulates main.js's mainWindow.focus() call on 'ready-to-show', which
  // arrives as a real window-focus event well after mount.
  fireEvent(window, new Event("focus"));
  expect(document.activeElement).not.toBe(settingsButton);

  // A later window-focus (e.g. Alt-tabbing back mid-session) must not keep
  // stripping focus from something the user has since legitimately tabbed
  // to — only the very first one after launch should do that.
  settingsButton.focus();
  fireEvent(window, new Event("focus"));
  expect(document.activeElement).toBe(settingsButton);
});
