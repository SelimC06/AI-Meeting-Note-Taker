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
  custom_vocabulary: "",
  advanced_diarization_enabled: false,
  huggingface_token_set: false,
  ai_provider: "ollama",
  custom_api_base_url: "",
  custom_api_key_set: false,
  custom_model_name: "",
  whisper_model_choices: [
    { value: "tiny.en", label: "Tiny", description: "Fastest, lower accuracy" },
    { value: "base.en", label: "Base", description: "Balanced (default)" },
    { value: "small.en", label: "Small", description: "Slower, more accurate" },
    { value: "medium.en", label: "Medium", description: "Slowest, most accurate" },
  ],
};

// Section content is only mounted while its nav item is selected
// (Transcription is the default), so tests for any other section select it
// first via the sidebar.
const openSection = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name }));
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

it("renders whisper model choices on the default Transcription section, and the storage dir under Storage", async () => {
  render(<SettingsPage active />);

  expect(await screen.findByText(/\[base\.en\]/)).toBeInTheDocument();

  openSection("Storage");
  expect(await screen.findByText(baseSettings.storage_dir)).toBeInTheDocument();
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
  await screen.findByText(/\[base\.en\]/);
  openSection("Storage");

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
  await screen.findByText(/\[base\.en\]/);
  openSection("Storage");

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
  await screen.findByText(/\[base\.en\]/);
  openSection("AI Model");

  expect(await screen.findByText(/gemma3:4b \(not installed\)/)).toBeInTheDocument();
});

it("shows unreachable message and retries on button click", async () => {
  vi.mocked(getOllamaModels).mockResolvedValueOnce({ ok: false, models: [], error: "connection refused" });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("AI Model");

  expect(await screen.findByText(/ollama unreachable/i)).toBeInTheDocument();

  vi.mocked(getOllamaModels).mockResolvedValueOnce({ ok: true, models: ["gemma3:4b"], error: null });
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));

  await waitFor(() => {
    expect(getOllamaModels).toHaveBeenCalledTimes(2);
  });
});

it("shows the local-first privacy statement", async () => {
  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("Privacy");

  expect(await screen.findByText(/never uploaded anywhere/i)).toBeInTheDocument();
  expect(screen.getByText(/permanently deleted after 30 days/i)).toBeInTheDocument();
});

it("shows the current app version and a not-checked-yet message before any check has run (brief 13 #14)", async () => {
  // Regression test: this used to render "You're on the latest version"
  // (the "idle" message) even before any update check had actually run,
  // since "idle" doubled as both the not-yet-checked default AND the
  // completed-check-found-nothing result.
  render(<SettingsPage active={true} />);
  await screen.findByText(/\[base\.en\]/);
  openSection("About");

  await waitFor(() => {
    expect(screen.getByText(/1\.0\.0/)).toBeInTheDocument();
  });
  expect(screen.getByText("Not checked yet")).toBeInTheDocument();
  expect(screen.queryByText("You're on the latest version")).not.toBeInTheDocument();
});

it("shows 'You're on the latest version' once a completed check reports idle", async () => {
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
  await screen.findByText(/\[base\.en\]/);
  openSection("About");

  await waitFor(() => expect(screen.getByText(/1\.0\.0/)).toBeInTheDocument());
  expect(screen.getByText("Not checked yet")).toBeInTheDocument();

  act(() => {
    pushStatus({ state: "idle" });
  });

  expect(screen.getByText("You're on the latest version")).toBeInTheDocument();
  expect(screen.queryByText("Not checked yet")).not.toBeInTheDocument();
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
  await screen.findByText(/\[base\.en\]/);
  openSection("About");

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
  await screen.findByText(/\[base\.en\]/);
  openSection("About");

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
  await screen.findByText(/\[base\.en\]/);
  openSection("AI Model");
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

it("renders the saved custom vocabulary in the textarea", async () => {
  vi.mocked(getSettings).mockResolvedValue({
    ...baseSettings,
    custom_vocabulary: "Kestrel, SSOT",
  });

  render(<SettingsPage active />);

  const textarea = await screen.findByLabelText(/custom vocabulary/i);
  expect(textarea).toHaveValue("Kestrel, SSOT");
});

it("saves an edited custom vocabulary and shows no error on success", async () => {
  vi.mocked(updateSettings).mockResolvedValue({
    ...baseSettings,
    custom_vocabulary: "Kestrel, SSOT, Xiomara",
  });

  render(<SettingsPage active />);

  const textarea = await screen.findByLabelText(/custom vocabulary/i);
  fireEvent.change(textarea, { target: { value: "Kestrel, SSOT, Xiomara" } });
  fireEvent.click(screen.getByRole("button", { name: /save vocabulary/i }));

  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({
      custom_vocabulary: "Kestrel, SSOT, Xiomara",
    });
  });
});

it("shows an error and keeps the draft text when saving the vocabulary fails", async () => {
  vi.mocked(updateSettings).mockRejectedValue(new Error("network down"));

  render(<SettingsPage active />);

  const textarea = await screen.findByLabelText(/custom vocabulary/i);
  fireEvent.change(textarea, { target: { value: "Kestrel" } });
  fireEvent.click(screen.getByRole("button", { name: /save vocabulary/i }));

  expect(await screen.findByText("network down")).toBeInTheDocument();
  expect(textarea).toHaveValue("Kestrel");
});

it("shows advanced diarization off by default with no token warning", async () => {
  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("Diarization");

  expect(await screen.findByRole("button", { name: "Off" })).toHaveClass("bg-signal");
  expect(screen.queryByText(/HuggingFace access token is required/i)).not.toBeInTheDocument();
});

it("enabling advanced diarization persists the setting and warns when no token is set", async () => {
  vi.mocked(updateSettings).mockResolvedValue({
    ...baseSettings,
    advanced_diarization_enabled: true,
  });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("Diarization");

  await screen.findByRole("button", { name: "Off" });
  fireEvent.click(screen.getByRole("button", { name: "On" }));

  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({ advanced_diarization_enabled: true });
  });
  expect(await screen.findByText(/HuggingFace access token is required/i)).toBeInTheDocument();
});

it("rolls back the diarization toggle and shows an error when the save fails", async () => {
  vi.mocked(updateSettings).mockRejectedValue(new Error("network down"));

  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("Diarization");

  await screen.findByRole("button", { name: "Off" });
  fireEvent.click(screen.getByRole("button", { name: "On" }));

  expect(await screen.findByText("network down")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Off" })).toHaveClass("bg-signal");
});

it("saves an edited HuggingFace token", async () => {
  vi.mocked(updateSettings).mockResolvedValue({
    ...baseSettings,
    huggingface_token_set: true,
  });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("Diarization");

  const tokenInput = await screen.findByLabelText(/huggingface access token/i);
  fireEvent.change(tokenInput, { target: { value: "hf_abc123" } });
  fireEvent.click(screen.getByRole("button", { name: /save token/i }));

  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({ huggingface_token: "hf_abc123" });
  });
  // The saved value is never echoed back into the field.
  await waitFor(() => expect(tokenInput).toHaveValue(""));
  expect(screen.getByText(/a token is saved/i)).toBeInTheDocument();
});

it("shows a saved HuggingFace token as set without its value, and can clear it", async () => {
  vi.mocked(getSettings).mockResolvedValue({ ...baseSettings, huggingface_token_set: true });
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, huggingface_token_set: false });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("Diarization");

  const tokenInput = await screen.findByLabelText(/huggingface access token/i);
  expect(tokenInput).toHaveValue("");
  expect(tokenInput).toHaveAttribute("placeholder", expect.stringMatching(/saved/i));
  expect(screen.getByRole("button", { name: /save token/i })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: /clear token/i }));
  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({ huggingface_token: "" });
  });
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /clear token/i })).not.toBeInTheDocument();
  });
});

it("does not warn about a missing token once diarization is enabled and a token is already saved", async () => {
  vi.mocked(getSettings).mockResolvedValue({
    ...baseSettings,
    advanced_diarization_enabled: true,
    huggingface_token_set: true,
  });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("Diarization");

  await screen.findByRole("button", { name: "On" });
  expect(screen.queryByText(/HuggingFace access token is required/i)).not.toBeInTheDocument();
});

it("shows the Ollama model picker by default in the AI Model section", async () => {
  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("AI Model");

  const providerSelect = await screen.findByLabelText(/provider/i);
  expect(providerSelect).toHaveValue("ollama");
  expect(screen.queryByLabelText(/base url/i)).not.toBeInTheDocument();
});

it("shows custom provider fields when Custom is selected, and hides the Ollama model dropdown", async () => {
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, ai_provider: "custom" });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("AI Model");

  const providerSelect = await screen.findByLabelText(/provider/i);
  fireEvent.change(providerSelect, { target: { value: "custom" } });

  expect(await screen.findByLabelText(/base url/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/^api key$/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/model name/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/chat model/i)).not.toBeInTheDocument();
});

it("saves the provider selection immediately", async () => {
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, ai_provider: "custom" });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("AI Model");

  const providerSelect = await screen.findByLabelText(/provider/i);
  fireEvent.change(providerSelect, { target: { value: "custom" } });

  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({ ai_provider: "custom" });
  });
});

it("saves the custom provider connection fields together", async () => {
  vi.mocked(getSettings).mockResolvedValue({ ...baseSettings, ai_provider: "custom" });
  vi.mocked(updateSettings).mockResolvedValue({
    ...baseSettings,
    ai_provider: "custom",
    custom_api_base_url: "https://api.openai.com/v1",
    custom_api_key_set: true,
    custom_model_name: "gpt-4o-mini",
  });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("AI Model");

  const baseUrlInput = await screen.findByLabelText(/base url/i);
  fireEvent.change(baseUrlInput, { target: { value: "https://api.openai.com/v1" } });
  fireEvent.change(screen.getByLabelText(/^api key$/i), { target: { value: "sk-test" } });
  fireEvent.change(screen.getByLabelText(/model name/i), { target: { value: "gpt-4o-mini" } });
  fireEvent.click(screen.getByRole("button", { name: /save connection/i }));

  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({
      custom_api_base_url: "https://api.openai.com/v1",
      custom_api_key: "sk-test",
      custom_model_name: "gpt-4o-mini",
    });
  });
  await waitFor(() => expect(screen.getByLabelText(/^api key$/i)).toHaveValue(""));
  expect(screen.getByText(/an api key is saved/i)).toBeInTheDocument();
});

it("keeps a saved API key when the connection is saved with the key field left empty", async () => {
  vi.mocked(getSettings).mockResolvedValue({
    ...baseSettings,
    ai_provider: "custom",
    custom_api_key_set: true,
  });
  vi.mocked(updateSettings).mockResolvedValue({
    ...baseSettings,
    ai_provider: "custom",
    custom_api_key_set: true,
    custom_model_name: "gpt-4o",
  });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("AI Model");

  const keyInput = await screen.findByLabelText(/^api key$/i);
  expect(keyInput).toHaveValue("");
  expect(keyInput).toHaveAttribute("placeholder", expect.stringMatching(/saved/i));
  fireEvent.change(screen.getByLabelText(/model name/i), { target: { value: "gpt-4o" } });
  fireEvent.click(screen.getByRole("button", { name: /save connection/i }));

  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({
      custom_api_base_url: "",
      custom_model_name: "gpt-4o",
    });
  });
});

it("clears a saved API key", async () => {
  vi.mocked(getSettings).mockResolvedValue({
    ...baseSettings,
    ai_provider: "custom",
    custom_api_key_set: true,
  });
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, ai_provider: "custom" });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\.en\]/);
  openSection("AI Model");

  fireEvent.click(await screen.findByRole("button", { name: /clear key/i }));
  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({ custom_api_key: "" });
  });
  await waitFor(() => {
    expect(screen.queryByText(/an api key is saved/i)).not.toBeInTheDocument();
  });
});
