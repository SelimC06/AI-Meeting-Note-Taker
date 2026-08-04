// src/ui/components/SettingsPage.tsx
import { useEffect, useState } from "react";
import {
  getSettings,
  updateSettings,
  getOllamaModels,
  type Settings,
} from "../api";

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [ollamaLoading, setOllamaLoading] = useState(true);
  const [ollamaLoadingCancelled, setOllamaLoadingCancelled] = useState(false);

  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);

  const [whisperError, setWhisperError] = useState<string | null>(null);
  const [ollamaSaveError, setOllamaSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadOllamaModels = () => {
    setOllamaLoading(true);
    setOllamaError(null);
    setOllamaLoadingCancelled(false);
    getOllamaModels().then((result) => {
      if (!ollamaLoadingCancelled) {
        setOllamaLoading(false);
        if (result.ok) {
          setOllamaModels(result.models);
        } else {
          setOllamaError(result.error ?? "Ollama unreachable");
        }
      }
    });
  };

  useEffect(() => {
    loadOllamaModels();
  }, []);

  const handleWhisperChange = async (value: string) => {
    const prev = settings;
    setSettings((s) => (s ? { ...s, whisper_model: value } : s));
    setWhisperError(null);
    try {
      const updated = await updateSettings({ whisper_model: value });
      setSettings(updated);
      setWhisperError(null);
    } catch (e) {
      setSettings(prev);
      setWhisperError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleOllamaChange = async (value: string) => {
    const prev = settings;
    setSettings((s) => (s ? { ...s, ollama_chat_model: value } : s));
    setOllamaSaveError(null);
    try {
      const updated = await updateSettings({ ollama_chat_model: value });
      setSettings(updated);
      setOllamaSaveError(null);
    } catch (e) {
      setSettings(prev);
      setOllamaSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleBrowseStorage = async () => {
    const chosen = await window.settingsAPI?.chooseFolder?.();
    if (!chosen || !settings) return;

    setStorageBusy(true);
    setStorageError(null);
    try {
      const updated = await updateSettings({ storage_dir: chosen });
      setSettings(updated);
    } catch (e) {
      setStorageError(e instanceof Error ? e.message : String(e));
    } finally {
      setStorageBusy(false);
    }
  };

  if (loadError && !settings) {
    return (
      <div className="h-full flex items-center justify-center text-dim text-xs px-6">
        Failed to load settings: {loadError}
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="h-full flex items-center justify-center text-dim text-xs">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col px-6 py-4 gap-3 text-phosphor overflow-y-auto">
      <div>
        <h1 className="text-sm font-semibold tracking-wide uppercase">[SETTINGS]</h1>
        <p className="text-xs text-dim">transcription, storage, and chat preferences</p>
      </div>

      <div className="rounded-sm bg-panel border border-line p-4 flex flex-col gap-2">
        <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">
          whisper model
        </h2>
        <div className="flex flex-col gap-1">
          {settings.whisper_model_choices.map((choice) => (
            <button
              key={choice.value}
              onClick={() => handleWhisperChange(choice.value)}
              className={
                "text-left px-2 py-1 rounded-sm text-xs transition focus:outline-none focus:ring-2 focus:ring-signal " +
                (settings.whisper_model === choice.value
                  ? "bg-signal text-void"
                  : "text-dim hover:text-phosphor border border-line")
              }
            >
              [{choice.value}] {choice.label} — {choice.description}
            </button>
          ))}
        </div>
        {whisperError && (
          <p className="text-xs text-red-400">{whisperError}</p>
        )}
      </div>

      <div className="rounded-sm bg-panel border border-line p-4 flex flex-col gap-2">
        <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">
          storage location
        </h2>
        <p className="text-xs text-phosphor break-all">{settings.storage_dir}</p>
        <button
          onClick={handleBrowseStorage}
          disabled={storageBusy}
          className="self-start px-2 py-1 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus:ring-2 focus:ring-signal disabled:opacity-50"
        >
          {storageBusy ? "Moving recordings..." : "Browse..."}
        </button>
        {storageError && (
          <p className="text-xs text-red-400">{storageError}</p>
        )}
      </div>

      <div className="rounded-sm bg-panel border border-line p-4 flex flex-col gap-2">
        <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">
          chat model (ollama)
        </h2>
        {ollamaLoading ? (
          <p className="text-xs text-dim">Loading installed models...</p>
        ) : ollamaError ? (
          <div className="flex items-center gap-2">
            <p className="text-xs text-red-400">Ollama unreachable — is it running?</p>
            <button
              onClick={loadOllamaModels}
              className="px-2 py-0.5 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus:ring-2 focus:ring-signal"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <select
              value={settings.ollama_chat_model}
              onChange={(e) => handleOllamaChange(e.target.value)}
              className="bg-void border border-line rounded-sm text-xs px-2 py-1 text-phosphor focus:outline-none focus:ring-2 focus:ring-signal"
            >
              {!ollamaModels.includes(settings.ollama_chat_model) && (
                <option value={settings.ollama_chat_model}>
                  {settings.ollama_chat_model} (not installed)
                </option>
              )}
              {ollamaModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {ollamaSaveError && (
              <p className="text-xs text-red-400">{ollamaSaveError}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
