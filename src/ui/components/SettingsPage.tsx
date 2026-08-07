// src/ui/components/SettingsPage.tsx
import { useEffect, useRef, useState } from "react";
import {
  getSettings,
  updateSettings,
  getOllamaModels,
  getStorageUsage,
  getSessions,
  deleteSessionForever,
  type Settings,
  type StorageUsage,
} from "../api";
import { useUpdaterStatus } from "../hooks/useUpdaterStatus";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export default function SettingsPage({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [ollamaLoading, setOllamaLoading] = useState(true);
  const ollamaGenerationRef = useRef(0);

  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);

  const [whisperError, setWhisperError] = useState<string | null>(null);
  const [ollamaSaveError, setOllamaSaveError] = useState<string | null>(null);

  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [emptyingTrash, setEmptyingTrash] = useState(false);

  const updaterStatus = useUpdaterStatus();
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    window.windowControls?.getVersion?.().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

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

  const loadUsage = () => {
    getStorageUsage()
      .then((u) => {
        setUsage(u);
        setUsageError(null);
      })
      .catch((e) => setUsageError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    if (!active) return;
    loadUsage();
  }, [active]);

  const handleEmptyTrash = async () => {
    setEmptyingTrash(true);
    try {
      const trashed = (await getSessions(true)).filter((s) => s.trashed_at);
      for (const s of trashed) {
        await deleteSessionForever(s.id);
      }
      loadUsage();
    } catch (e) {
      setUsageError(e instanceof Error ? e.message : String(e));
    } finally {
      setEmptyingTrash(false);
    }
  };

  const loadOllamaModels = () => {
    const generation = ++ollamaGenerationRef.current;
    setOllamaLoading(true);
    setOllamaError(null);
    getOllamaModels().then((result) => {
      // A newer loadOllamaModels() call, or this component unmounting
      // (which also bumps the generation -- see the mount effect's
      // cleanup below), invalidates this response: applying it now would
      // either overwrite a more recent result or update state after
      // unmount.
      if (generation !== ollamaGenerationRef.current) return;
      setOllamaLoading(false);
      if (result.ok) {
        setOllamaModels(result.models);
      } else {
        setOllamaError(result.error ?? "Ollama unreachable");
      }
    });
  };

  useEffect(() => {
    loadOllamaModels();
    return () => {
      ollamaGenerationRef.current += 1;
    };
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
          privacy
        </h2>
        <p className="text-xs text-phosphor">
          Recordings and notes are stored only on this machine and never uploaded anywhere.
          Items moved to trash are permanently deleted after 30 days.
        </p>
      </div>

      <div className="rounded-sm bg-panel border border-line p-4 flex flex-col gap-2">
        <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">
          storage usage
        </h2>
        {usageError && <p className="text-xs text-red-400">{usageError}</p>}
        {!usageError && usage && (
          <>
            <p className="text-xs text-phosphor">
              {formatBytes(usage.used_bytes)} used across {usage.session_count} session
              {usage.session_count === 1 ? "" : "s"}
            </p>
            <p
              className={
                "text-xs " +
                (usage.total_bytes > 0 &&
                (usage.free_bytes < 5 * 1024 ** 3 || usage.free_bytes / usage.total_bytes < 0.1)
                  ? "text-red-400"
                  : "text-dim")
              }
            >
              {formatBytes(usage.free_bytes)} free on disk
            </p>
            {usage.trashed_count > 0 && (
              <div className="flex items-center gap-2">
                <p className="text-xs text-dim">
                  {usage.trashed_count} session{usage.trashed_count === 1 ? "" : "s"} in trash
                </p>
                <button
                  onClick={handleEmptyTrash}
                  disabled={emptyingTrash}
                  className="px-2 py-0.5 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus:ring-2 focus:ring-signal disabled:opacity-50"
                >
                  {emptyingTrash ? "Emptying..." : "Empty Trash"}
                </button>
              </div>
            )}
          </>
        )}
        {!usageError && !usage && <p className="text-xs text-dim">Loading storage usage...</p>}
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

      <div className="rounded-sm bg-panel border border-line p-4 flex flex-col gap-2">
        <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">
          updates
        </h2>
        <p className="text-xs text-phosphor">
          {appVersion ? `version ${appVersion}` : "loading version..."}
        </p>
        {updaterStatus.state === "idle" && (
          <p className="text-xs text-dim">You're on the latest version</p>
        )}
        {updaterStatus.state === "checking" && (
          <p className="text-xs text-dim">Checking for updates...</p>
        )}
        {updaterStatus.state === "available" && (
          <p className="text-xs text-dim">Update {updaterStatus.version} found — downloading...</p>
        )}
        {updaterStatus.state === "downloading" && (
          <p className="text-xs text-dim">
            Downloading update... {Math.round(updaterStatus.percent)}%
          </p>
        )}
        {updaterStatus.state === "ready" && (
          <div className="flex items-center gap-2">
            <p className="text-xs text-phosphor">Update {updaterStatus.version} ready</p>
            <button
              onClick={() => window.updaterAPI?.install?.()}
              className="px-2 py-0.5 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus:ring-2 focus:ring-signal"
            >
              restart to update
            </button>
          </div>
        )}
        {updaterStatus.state === "error" && (
          <p className="text-xs text-dim">Update check failed: {updaterStatus.message}</p>
        )}
      </div>
    </div>
  );
}
