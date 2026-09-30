import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useOllamaReadiness } from "./useOllamaReadiness";
import { getOllamaModels, getSettings } from "../api";

vi.mock("../api");

afterEach(() => {
  vi.clearAllMocks();
});

it("checks immediately when active is true (the default)", async () => {
  vi.mocked(getOllamaModels).mockResolvedValue({ ok: true, models: ["llama3"], error: null });
  vi.mocked(getSettings).mockResolvedValue({
    whisper_model: "base.en",
    storage_dir: "x",
    ollama_chat_model: "llama3",
    whisper_model_choices: [],
  });

  renderHook(() => useOllamaReadiness());

  await waitFor(() => expect(getOllamaModels).toHaveBeenCalledTimes(1));
});

it("does not check on mount while inactive, staying in 'checking' (G9)", async () => {
  // Regression test: getOllamaModels maps a connection-refused fetch (the
  // backend still booting) to the same {ok:false} shape as "Ollama isn't
  // installed" -- checking on mount before the backend is known healthy
  // misread a normal cold start as a setup problem, flashing the
  // "[SETUP REQUIRED] Download Ollama" overlay on every launch.
  vi.mocked(getOllamaModels).mockResolvedValue({ ok: false, models: [], error: "connection refused" });

  const { result } = renderHook(() => useOllamaReadiness(false));

  // Give any (incorrect) mount-time check a chance to fire.
  await act(async () => {
    await Promise.resolve();
  });

  expect(getOllamaModels).not.toHaveBeenCalled();
  expect(result.current.status).toBe("checking");
});

it("runs the first real check once active flips from false to true", async () => {
  vi.mocked(getOllamaModels).mockResolvedValue({ ok: true, models: ["llama3"], error: null });
  vi.mocked(getSettings).mockResolvedValue({
    whisper_model: "base.en",
    storage_dir: "x",
    ollama_chat_model: "llama3",
    whisper_model_choices: [],
  });

  const { result, rerender } = renderHook(({ active }) => useOllamaReadiness(active), {
    initialProps: { active: false },
  });

  expect(getOllamaModels).not.toHaveBeenCalled();
  expect(result.current.status).toBe("checking");

  rerender({ active: true });

  await waitFor(() => expect(getOllamaModels).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(result.current.status).toBe("ready"));
});

it("does not re-check on every rerender while active stays true", async () => {
  vi.mocked(getOllamaModels).mockResolvedValue({ ok: true, models: ["llama3"], error: null });
  vi.mocked(getSettings).mockResolvedValue({
    whisper_model: "base.en",
    storage_dir: "x",
    ollama_chat_model: "llama3",
    whisper_model_choices: [],
  });

  const { rerender } = renderHook(({ active }) => useOllamaReadiness(active), {
    initialProps: { active: true },
  });
  await waitFor(() => expect(getOllamaModels).toHaveBeenCalledTimes(1));

  rerender({ active: true });
  rerender({ active: true });

  await act(async () => {
    await Promise.resolve();
  });
  expect(getOllamaModels).toHaveBeenCalledTimes(1);
});

it("is ready with the custom provider even though Ollama is unreachable", async () => {
  vi.mocked(getOllamaModels).mockResolvedValue({ ok: false, models: [], error: "connection refused" });
  vi.mocked(getSettings).mockResolvedValue({
    whisper_model: "base.en",
    storage_dir: "/x",
    ollama_chat_model: "gemma3:4b",
    custom_vocabulary: "",
    advanced_diarization_enabled: false,
    huggingface_token_set: false,
    ai_provider: "custom",
    custom_api_base_url: "https://api.example.com/v1",
    custom_api_key_set: true,
    custom_model_name: "gpt-4o-mini",
    whisper_model_choices: [],
  });

  const { result } = renderHook(() => useOllamaReadiness());

  await waitFor(() => expect(result.current.status).toBe("ready"));
});
