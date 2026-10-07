import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "./SettingsPage";
import {
  deleteSessionForever,
  deleteSpeakerProfile,
  getOllamaModels,
  getSessions,
  getSettings,
  getSpeakerProfiles,
  getStorageUsage,
  updateSettings,
  type Settings,
} from "../api";

vi.mock("../api");

const baseSettings: Settings = {
  whisper_model: "base",
  transcription_language: "auto",
  note_template: "general",
  custom_note_template: "",
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
    { value: "tiny", label: "Tiny", description: "Fastest, lower accuracy" },
    { value: "base", label: "Base", description: "Balanced (default)" },
    { value: "small", label: "Small", description: "Slower, more accurate" },
    { value: "medium", label: "Medium", description: "Slowest, most accurate" },
  ],
  note_template_choices: [
    { id: "general", label: "General", description: "Any meeting", body: "# (title)\n\n## Key Points\n- (bullet)\n" },
    { id: "standup", label: "Standup", description: "Daily sync", body: "# (title)\n\n## Blockers\n- (blocker)\n" },
  ],
  transcription_language_choices: [
    { value: "auto", label: "Auto-detect" },
    { value: "en", label: "English" },
    { value: "tr", label: "Turkish" },
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
  vi.mocked(getSpeakerProfiles).mockResolvedValue({ available: true, profiles: [] });
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

  expect(await screen.findByText(/\[base\]/)).toBeInTheDocument();

  openSection("Storage");
  expect(await screen.findByText(baseSettings.storage_dir)).toBeInTheDocument();
});

it("selecting a whisper model persists it and updates the UI", async () => {
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, whisper_model: "small" });

  render(<SettingsPage active />);
  const smallButton = await screen.findByText(/\[small\]/);
  fireEvent.click(smallButton);

  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({ whisper_model: "small" });
  });
  expect(await screen.findByText(/\[small\]/)).toBeInTheDocument();
});

it("rolls back the whisper model selection and shows an error when the save fails", async () => {
  vi.mocked(updateSettings).mockRejectedValue(new Error("network down"));

  render(<SettingsPage active />);
  const smallButton = await screen.findByText(/\[small\]/);
  fireEvent.click(smallButton);

  expect(await screen.findByText("network down")).toBeInTheDocument();
  expect(updateSettings).toHaveBeenCalledTimes(1);
});

it("selecting a transcription language persists it", async () => {
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, transcription_language: "tr" });

  render(<SettingsPage active />);
  const select = await screen.findByLabelText("transcription language");
  fireEvent.change(select, { target: { value: "tr" } });

  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({ transcription_language: "tr" });
  });
  expect((select as HTMLSelectElement).value).toBe("tr");
});

it("shows an error when saving the transcription language fails", async () => {
  vi.mocked(updateSettings).mockRejectedValue(new Error("network down"));

  render(<SettingsPage active />);
  const select = await screen.findByLabelText("transcription language");
  fireEvent.change(select, { target: { value: "en" } });

  expect(await screen.findByText("network down")).toBeInTheDocument();
});

it("moves the storage directory on browse success", async () => {
  window.settingsAPI!.chooseFolder = vi.fn().mockResolvedValue("D:\\new-recordings");
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, storage_dir: "D:\\new-recordings" });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
  openSection("AI Model");

  expect(await screen.findByText(/gemma3:4b \(not installed\)/)).toBeInTheDocument();
});

it("shows unreachable message and retries on button click", async () => {
  vi.mocked(getOllamaModels).mockResolvedValueOnce({ ok: false, models: [], error: "connection refused" });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
  openSection("Diarization");

  await screen.findByRole("button", { name: "On" });
  expect(screen.queryByText(/HuggingFace access token is required/i)).not.toBeInTheDocument();
});

it("shows the Ollama model picker by default in the AI Model section", async () => {
  render(<SettingsPage active />);
  await screen.findByText(/\[base\]/);
  openSection("AI Model");

  // Provider is a card radiogroup now (UI refresh), not a select.
  await screen.findByRole("radiogroup", { name: /provider/i });
  expect(screen.getByRole("radio", { name: /ollama/i })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("radio", { name: /built-in/i })).toHaveAttribute("aria-checked", "false");
  expect(screen.queryByLabelText(/base url/i)).not.toBeInTheDocument();
});

it("shows custom provider fields when Custom is selected, and hides the Ollama model dropdown", async () => {
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, ai_provider: "custom" });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\]/);
  openSection("AI Model");

  fireEvent.click(await screen.findByRole("radio", { name: /custom endpoint/i }));

  expect(await screen.findByLabelText(/base url/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/^api key$/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/model name/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/chat model/i)).not.toBeInTheDocument();
});

it("saves the provider selection immediately", async () => {
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, ai_provider: "custom" });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\]/);
  openSection("AI Model");

  fireEvent.click(await screen.findByRole("radio", { name: /custom endpoint/i }));

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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
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
  await screen.findByText(/\[base\]/);
  openSection("AI Model");

  fireEvent.click(await screen.findByRole("button", { name: /clear key/i }));
  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({ custom_api_key: "" });
  });
  await waitFor(() => {
    expect(screen.queryByText(/an api key is saved/i)).not.toBeInTheDocument();
  });
});


// ---------- optimistic save ordering ----------

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const selectedWhisper = () =>
  screen.getAllByRole("button").find((b) => b.className.includes("bg-signal") && b.textContent?.startsWith("["));

it("keeps the latest whisper choice when an older save answers last", async () => {
  const first = deferred<Settings>();
  const second = deferred<Settings>();
  vi.mocked(updateSettings).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

  render(<SettingsPage active />);
  fireEvent.click(await screen.findByText(/\[small\]/));
  fireEvent.click(screen.getByText(/\[medium\]/));

  await act(async () => {
    second.resolve({ ...baseSettings, whisper_model: "medium" });
    await Promise.resolve();
  });
  await act(async () => {
    first.resolve({ ...baseSettings, whisper_model: "small" });
    await Promise.resolve();
  });

  expect(selectedWhisper()?.textContent).toContain("[medium]");
});

it("a failed older save doesn't roll back a newer choice", async () => {
  const first = deferred<Settings>();
  const second = deferred<Settings>();
  vi.mocked(updateSettings).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

  render(<SettingsPage active />);
  fireEvent.click(await screen.findByText(/\[small\]/));
  fireEvent.click(screen.getByText(/\[medium\]/));

  await act(async () => {
    first.reject(new Error("stale failure"));
    await Promise.resolve();
  });

  expect(selectedWhisper()?.textContent).toContain("[medium]");
  expect(screen.queryByText("stale failure")).not.toBeInTheDocument();

  await act(async () => {
    second.resolve({ ...baseSettings, whisper_model: "medium" });
    await Promise.resolve();
  });
  expect(selectedWhisper()?.textContent).toContain("[medium]");
});

it("a failed latest save rolls back to the last value the backend confirmed", async () => {
  vi.mocked(updateSettings)
    .mockResolvedValueOnce({ ...baseSettings, whisper_model: "small" })
    .mockRejectedValueOnce(new Error("disk full"));

  render(<SettingsPage active />);
  fireEvent.click(await screen.findByText(/\[small\]/));
  await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(screen.getByText(/\[medium\]/));

  expect(await screen.findByText("disk full")).toBeInTheDocument();
  expect(selectedWhisper()?.textContent).toContain("[small]");
});

// ---------- Empty Trash ----------

const trashedSession = (id: string) => ({
  id, created_at: "2026-08-01T00:00:00Z", title: id, notes: "", video_path: "", trashed_at: "2026-08-02T00:00:00Z",
});

async function openStorageWithTrash() {
  vi.mocked(getStorageUsage).mockResolvedValue({
    used_bytes: 0, free_bytes: 100, total_bytes: 100, session_count: 0, trashed_count: 2,
  });
  vi.mocked(getSessions).mockResolvedValue([trashedSession("t1"), trashedSession("t2")]);
  vi.mocked(deleteSessionForever).mockResolvedValue(undefined);
}

it("Empty Trash asks for confirmation and deletes nothing on cancel", async () => {
  await openStorageWithTrash();
  render(<SettingsPage active />);
  await screen.findByText(/\[small\]/);
  openSection("Storage");

  fireEvent.click(await screen.findByRole("button", { name: "Empty Trash" }));
  expect(screen.getByText("delete forever?")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "[cancel]" }));

  expect(deleteSessionForever).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Empty Trash" })).toBeInTheDocument();
});

it("Empty Trash deletes on confirm and reports the deleted ids", async () => {
  await openStorageWithTrash();
  const onSessionsDeleted = vi.fn();
  render(<SettingsPage active onSessionsDeleted={onSessionsDeleted} />);
  await screen.findByText(/\[small\]/);
  openSection("Storage");

  fireEvent.click(await screen.findByRole("button", { name: "Empty Trash" }));
  fireEvent.click(screen.getByRole("button", { name: "[confirm]" }));

  await waitFor(() => expect(onSessionsDeleted).toHaveBeenCalledWith(["t1", "t2"]));
  expect(deleteSessionForever).toHaveBeenCalledTimes(2);
});

it("Empty Trash reports what it did delete even when a later delete fails", async () => {
  await openStorageWithTrash();
  vi.mocked(deleteSessionForever).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("500"));
  const onSessionsDeleted = vi.fn();
  render(<SettingsPage active onSessionsDeleted={onSessionsDeleted} />);
  await screen.findByText(/\[small\]/);
  openSection("Storage");

  fireEvent.click(await screen.findByRole("button", { name: "Empty Trash" }));
  fireEvent.click(screen.getByRole("button", { name: "[confirm]" }));

  await waitFor(() => expect(onSessionsDeleted).toHaveBeenCalledWith(["t1"]));
});

it("on macOS, offers a download link for a new version instead of an install button", async () => {
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
  await screen.findByText(/\[base\]/);
  openSection("About");

  act(() => {
    pushStatus({ state: "manual", version: "1.1.0", url: "https://deskrecap.com" });
  });

  expect(screen.getByText(/Version 1\.1\.0 is available/)).toBeInTheDocument();
  const link = screen.getByRole("link", { name: "download it from deskrecap.com" });
  expect(link).toHaveAttribute("href", "https://deskrecap.com");
  expect(link).toHaveAttribute("target", "_blank");
  expect(screen.queryByRole("button", { name: "restart to update" })).not.toBeInTheDocument();
});

it("tells the app the library changed after the storage folder moves (and not when the move fails)", async () => {
  window.settingsAPI!.chooseFolder = vi.fn().mockResolvedValue("D:\\new-recordings");
  vi.mocked(updateSettings)
    .mockRejectedValueOnce(new Error("Destination folder is not empty"))
    .mockResolvedValueOnce({ ...baseSettings, storage_dir: "D:\\new-recordings" });
  const onLibraryChanged = vi.fn();

  render(<SettingsPage active onLibraryChanged={onLibraryChanged} />);
  await screen.findByText(/\[base\]/);
  openSection("Storage");
  const browse = await screen.findByRole("button", { name: /browse/i });

  fireEvent.click(browse);
  expect(await screen.findByText("Destination folder is not empty")).toBeInTheDocument();
  expect(onLibraryChanged).not.toHaveBeenCalled();

  fireEvent.click(browse);
  await waitFor(() => expect(onLibraryChanged).toHaveBeenCalledTimes(1));
});

it("lists saved voice profiles and forgets one on click", async () => {
  vi.mocked(getSpeakerProfiles).mockResolvedValue({
    available: true,
    profiles: [
      { name: "Maya", meetings: 3, updated_at: "2026-10-03T00:00:00+00:00" },
      { name: "Deniz", meetings: 1, updated_at: "2026-10-01T00:00:00+00:00" },
    ],
  });
  vi.mocked(deleteSpeakerProfile).mockResolvedValue(undefined);

  render(<SettingsPage active />);
  await screen.findByText(/\[base\]/);
  openSection("Diarization");

  expect(await screen.findByText(/Maya/)).toBeInTheDocument();
  expect(screen.getByText(/3 meetings/)).toBeInTheDocument();
  expect(screen.getByText(/1 meeting\b/)).toBeInTheDocument();

  const forgetButtons = screen.getAllByRole("button", { name: /forget/i });
  fireEvent.click(forgetButtons[0]);

  await waitFor(() => expect(deleteSpeakerProfile).toHaveBeenCalledWith("Maya"));
  await waitFor(() => expect(screen.queryByText(/Maya/)).not.toBeInTheDocument());
  expect(screen.getByText(/Deniz/)).toBeInTheDocument();
});

it("explains when speaker recognition is unavailable on this install", async () => {
  vi.mocked(getSpeakerProfiles).mockResolvedValue({ available: false, profiles: [] });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\]/);
  openSection("Diarization");

  expect(await screen.findByText(/speaker recognition is unavailable/i)).toBeInTheDocument();
});

it("switches the app theme from the Appearance section", async () => {
  render(<SettingsPage active />);
  await screen.findByText(/\[base\]/);
  openSection("Appearance");

  fireEvent.click(await screen.findByRole("button", { name: /light \(paper\)/i }));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(window.localStorage.getItem("deskrecap.theme")).toBe("light");

  fireEvent.click(screen.getByRole("button", { name: /dark \(phosphor\)/i }));
  expect(document.documentElement.dataset.theme).toBe("dark");
});

it("selects a note template and shows its preview", async () => {
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, note_template: "standup" });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\]/);
  openSection("Notes");

  expect(screen.getByText(/\[general\] General/)).toBeInTheDocument();
  // The general preview is shown for the current selection.
  expect(screen.getByText(/## Key Points/)).toBeInTheDocument();

  fireEvent.click(screen.getByText(/\[standup\] Standup/));
  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({ note_template: "standup" });
  });
  expect(await screen.findByText(/## Blockers/)).toBeInTheDocument();
});

it("saves an edited custom template body", async () => {
  vi.mocked(getSettings).mockResolvedValue({ ...baseSettings, note_template: "custom", custom_note_template: "# (t)\n## Mine\n- x" });
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, note_template: "custom", custom_note_template: "# (t)\n## Mine v2\n- x" });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\]/);
  openSection("Notes");

  const textarea = await screen.findByLabelText(/custom template/i);
  expect(textarea).toHaveValue("# (t)\n## Mine\n- x");
  fireEvent.change(textarea, { target: { value: "# (t)\n## Mine v2\n- x" } });
  fireEvent.click(screen.getByRole("button", { name: /save template/i }));

  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({ custom_note_template: "# (t)\n## Mine v2\n- x" });
  });
});

it("edit-as-custom seeds the custom body from the previewed template and switches to custom", async () => {
  vi.mocked(updateSettings).mockResolvedValue({ ...baseSettings, note_template: "custom" });

  render(<SettingsPage active />);
  await screen.findByText(/\[base\]/);
  openSection("Notes");

  // One action under the preview: it copies whatever template is selected
  // (general here) into the custom body.
  fireEvent.click(await screen.findByRole("button", { name: /edit as custom/i }));

  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({ note_template: "custom" });
  });
  const textarea = await screen.findByLabelText(/custom template/i);
  expect(textarea).toHaveValue("# (title)\n\n## Key Points\n- (bullet)\n");
});

it("opens the third-party notices from About", async () => {
  const openThirdPartyNotices = vi.fn().mockResolvedValue(undefined);
  const previous = window.diagnosticsAPI;
  window.diagnosticsAPI = { ...(previous ?? {}), openThirdPartyNotices } as typeof window.diagnosticsAPI;
  try {
    render(<SettingsPage active />);
    await screen.findByText(/\[base\]/);
    openSection("About");
    fireEvent.click(await screen.findByRole("button", { name: /third-party notices/i }));
    expect(openThirdPartyNotices).toHaveBeenCalledTimes(1);
  } finally {
    window.diagnosticsAPI = previous;
  }
});
