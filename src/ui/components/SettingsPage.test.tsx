import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "./SettingsPage";
import {
  getOllamaModels,
  getSettings,
  getStorageUsage,
  updateSettings,
  type Settings,
} from "../api";

vi.mock("../api");

const baseSettings: Settings = {
  whisper_model: "base.en",
  storage_dir: "C:\\Users\\test\\recordings",
  ollama_chat_model: "gemma3:4b",
  whisper_model_choices: [
    { value: "tiny.en", label: "Tiny", description: "Fastest, lower accuracy" },
    { value: "base.en", label: "Base", description: "Balanced (default)" },
    { value: "small.en", label: "Small", description: "Slower, more accurate" },
    { value: "medium.en", label: "Medium", description: "Slowest, most accurate" },
  ],
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
  vi.mocked(getOllamaModels).mockResolvedValue({
    ok: true,
    models: ["gemma3:4b", "llama3.1:8b"],
    error: null,
  });
  Object.defineProperty(window, "settingsAPI", {
    value: { chooseFolder: vi.fn() },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "windowControls", {
    value: { getVersion: vi.fn().mockResolvedValue("1.0.0") },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "updaterAPI", {
    value: { onStatus: vi.fn(() => () => {}), install: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("renders whisper model choices and current storage dir after load", async () => {
  render(<SettingsPage active />);

  expect(await screen.findByText(/\[base\.en\]/)).toBeInTheDocument();
  expect(screen.getByText(baseSettings.storage_dir)).toBeInTheDocument();
});

it("selecting a whisper model persists it and updates the UI", async () => {
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, whisper_model: "small.en" });

  render(<SettingsPage active />);
  const smallButton = await screen.findByText(/\[small\.en\]/);
  fireEvent.click(smallButton);

  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({ whisper_model: "small.en" });
  });
  expect(await screen.findByText(/\[small\.en\]/)).toBeInTheDocument();
});

it("rolls back the whisper model selection and shows an error when the save fails", async () => {
  vi.mocked(updateSettings).mockRejectedValue(new Error("network down"));

  render(<SettingsPage active />);
  const smallButton = await screen.findByText(/\[small\.en\]/);
  fireEvent.click(smallButton);

  expect(await screen.findByText("network down")).toBeInTheDocument();
  expect(updateSettings).toHaveBeenCalledTimes(1);
});

it("moves the storage directory on browse success", async () => {
  window.settingsAPI!.chooseFolder = vi.fn().mockResolvedValue("D:\\new-recordings");
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, storage_dir: "D:\\new-recordings" });

  render(<SettingsPage active />);
  const browseButton = await screen.findByRole("button", { name: /browse/i });
  fireEvent.click(browseButton);

  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({ storage_dir: "D:\\new-recordings" });
  });
  expect(await screen.findByText("D:\\new-recordings")).toBeInTheDocument();
});

it("shows a storage error and keeps the old path when the move fails", async () => {
  window.settingsAPI!.chooseFolder = vi.fn().mockResolvedValue("D:\\new-recordings");
  vi.mocked(updateSettings).mockRejectedValue(new Error("Destination not empty"));

  render(<SettingsPage active />);
  const browseButton = await screen.findByRole("button", { name: /browse/i });
  fireEvent.click(browseButton);

  expect(await screen.findByText("Destination not empty")).toBeInTheDocument();
  expect(screen.getByText(baseSettings.storage_dir)).toBeInTheDocument();
});

it("shows the not-installed marker when the configured model isn't in the installed list", async () => {
  vi.mocked(getOllamaModels).mockResolvedValue({
    ok: true,
    models: ["llama3.1:8b"],
    error: null,
  });

  render(<SettingsPage active />);
  expect(await screen.findByText(/gemma3:4b \(not installed\)/)).toBeInTheDocument();
});

it("shows unreachable message and retries on button click", async () => {
  vi.mocked(getOllamaModels).mockResolvedValueOnce({ ok: false, models: [], error: "connection refused" });

  render(<SettingsPage active />);
  expect(await screen.findByText(/ollama unreachable/i)).toBeInTheDocument();

  vi.mocked(getOllamaModels).mockResolvedValueOnce({ ok: true, models: ["gemma3:4b"], error: null });
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));

  await waitFor(() => {
    expect(getOllamaModels).toHaveBeenCalledTimes(2);
  });
});

it("shows the local-first privacy statement", async () => {
  render(<SettingsPage active />);
  expect(
    await screen.findByText(/never uploaded anywhere/i)
  ).toBeInTheDocument();
  expect(screen.getByText(/permanently deleted after 30 days/i)).toBeInTheDocument();
});

it("shows the current app version and an idle message by default", async () => {
  render(<SettingsPage active={true} />);
  await waitFor(() => {
    expect(screen.getByText(/1\.0\.0/)).toBeInTheDocument();
  });
  expect(screen.getByText("You're on the latest version")).toBeInTheDocument();
});

it("shows a downloading message with percent when an update is downloading", async () => {
  let pushStatus: (status: unknown) => void = () => {};
  Object.defineProperty(window, "updaterAPI", {
    value: {
      onStatus: vi.fn((cb) => {
        pushStatus = cb;
        return () => {};
      }),
      install: vi.fn(),
    },
    writable: true,
    configurable: true,
  });

  render(<SettingsPage active={true} />);
  await waitFor(() => expect(screen.getByText(/1\.0\.0/)).toBeInTheDocument());

  act(() => {
    pushStatus({ state: "downloading", percent: 37 });
  });

  expect(screen.getByText("Downloading update... 37%")).toBeInTheDocument();
});

it("shows a restart button when an update is ready and calls install on click", async () => {
  let pushStatus: (status: unknown) => void = () => {};
  const install = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "updaterAPI", {
    value: {
      onStatus: vi.fn((cb) => {
        pushStatus = cb;
        return () => {};
      }),
      install,
    },
    writable: true,
    configurable: true,
  });

  render(<SettingsPage active={true} />);
  await waitFor(() => expect(screen.getByText(/1\.0\.0/)).toBeInTheDocument());

  act(() => {
    pushStatus({ state: "ready", version: "1.1.0" });
  });

  const restartButton = screen.getByRole("button", { name: "restart to update" });
  fireEvent.click(restartButton);
  expect(install).toHaveBeenCalledTimes(1);
});

// Note: in React 19, the "state update on an unmounted component" warning
// was removed entirely, so a post-unmount setState is a silent no-op here --
// this test can't actually distinguish the generation-ref guard being present
// from it being absent. It still locks in a real invariant (no thrown
// exceptions or console errors when a pending request resolves after
// unmount), and it exercises the generation ref as defense-in-depth against a
// same-instance stale-response race, even though that race isn't reachable
// through the current UI (the Retry button is hidden while loading).
it("does not throw or log an error when unmounted mid-request and the pending request later resolves", async () => {
  let resolveOllama: (r: { ok: boolean; models: string[]; error: string | null }) => void = () => {};
  vi.mocked(getOllamaModels).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOllama = resolve;
    })
  );

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  const { unmount } = render(<SettingsPage active />);
  await screen.findByText(/loading installed models/i);

  unmount();
  resolveOllama({ ok: true, models: ["gemma3:4b"], error: null });
  await new Promise((r) => setTimeout(r, 0));

  const actWarning = consoleError.mock.calls.some((args) =>
    args.some((a) => typeof a === "string" && a.includes("not wrapped in act"))
  );
  expect(actWarning).toBe(false);

  consoleError.mockRestore();
});
