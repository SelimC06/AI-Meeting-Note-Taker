// src/ui/components/SettingsPage.tsx
import { useEffect, useRef, useState } from "react";
import {
  getSettings,
  updateSettings,
  getOllamaModels,
  getStorageUsage,
  getSessions,
  deleteSessionForever,
  getSpeakerProfiles,
  deleteSpeakerProfile,
  type Settings,
  type StorageUsage,
  type SpeakerProfilesResult,
} from "../api";
import { useUpdaterStatus } from "../hooks/useUpdaterStatus";
import { getTheme, setTheme, type Theme } from "../theme";

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

type SectionId =
  | "transcription"
  | "storage"
  | "ai"
  | "diarization"
  | "appearance"
  | "privacy"
  | "diagnostics"
  | "about";

type DotTone = "ok" | "warn" | "err" | "idle" | "none";

// The settings saved optimistically on click (see saveOptimistic).
type OptimisticField =
  | "whisper_model"
  | "transcription_language"
  | "ollama_chat_model"
  | "ai_provider"
  | "advanced_diarization_enabled";

const NAV_GROUPS: { heading: string; sections: { id: SectionId; label: string }[] }[] = [
  {
    heading: "Settings",
    sections: [
      { id: "transcription", label: "Transcription" },
      { id: "storage", label: "Storage" },
      { id: "ai", label: "AI Model" },
      { id: "diarization", label: "Diarization" },
      { id: "appearance", label: "Appearance" },
    ],
  },
  {
    heading: "Reference",
    sections: [
      { id: "privacy", label: "Privacy" },
      { id: "diagnostics", label: "Diagnostics" },
      { id: "about", label: "About" },
    ],
  },
];

function StatusDot({ tone }: { tone: DotTone }) {
  if (tone === "none") return null;
  const toneClass =
    tone === "ok"
      ? "bg-signal shadow-[0_0_6px_1px_rgba(237,230,214,0.5)]"
      : tone === "warn"
        ? "bg-amber-400 shadow-[0_0_6px_1px_rgba(251,191,36,0.5)]"
        : tone === "err"
          ? "bg-red-400 shadow-[0_0_6px_1px_rgba(248,113,113,0.5)]"
          : "bg-dim";
  return <span aria-hidden="true" className={"inline-block h-1.5 w-1.5 rounded-full shrink-0 " + toneClass} />;
}

export default function SettingsPage({
  active,
  onSessionsDeleted,
  onLibraryChanged,
}: {
  active: boolean;
  // Told which sessions Empty Trash permanently deleted, so the rest of the
  // app can drop them too (the Sidebar's trash list, per-meeting chat
  // state) -- this page has no other way to reach those.
  onSessionsDeleted?: (ids: string[]) => void;
  // Told when the storage folder changed: every list of meetings on screen
  // (the sidebar, its trash view) was fetched from the old one.
  onLibraryChanged?: () => void;
}) {
  const [activeSection, setActiveSection] = useState<SectionId>("transcription");

  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [ollamaLoading, setOllamaLoading] = useState(true);
  const ollamaGenerationRef = useRef(0);

  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);

  const [whisperError, setWhisperError] = useState<string | null>(null);
  const [languageSaveError, setLanguageSaveError] = useState<string | null>(null);
  const [ollamaSaveError, setOllamaSaveError] = useState<string | null>(null);

  const [providerSaveError, setProviderSaveError] = useState<string | null>(null);
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [customModelDraft, setCustomModelDraft] = useState("");
  const [connectionSaveError, setConnectionSaveError] = useState<string | null>(null);

  const [vocabularyDraft, setVocabularyDraft] = useState("");
  const [vocabularySaveError, setVocabularySaveError] = useState<string | null>(null);

  const [diarizationError, setDiarizationError] = useState<string | null>(null);
  const [voiceProfiles, setVoiceProfiles] = useState<SpeakerProfilesResult | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  // Per-machine, applied instantly to both windows (see ../theme.ts) --
  // deliberately not a backend setting.
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  const handleThemeChange = (value: Theme) => {
    setTheme(value);
    setThemeState(value);
  };
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenSaveError, setTokenSaveError] = useState<string | null>(null);

  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const [confirmingEmptyTrash, setConfirmingEmptyTrash] = useState(false);

  // Optimistic saves, per field: the generation of the latest change, and
  // the last value the backend confirmed (what a failed save rolls back
  // to). Each click used to capture `prev` in its own closure and apply its
  // response whenever it arrived -- two quick clicks answered out of order
  // left the older choice on screen, and one field's rollback or response
  // could clobber another field's change still in flight.
  const fieldGenerationRef = useRef<Partial<Record<OptimisticField, number>>>({});
  const pendingFieldsRef = useRef<Set<OptimisticField>>(new Set());
  const confirmedRef = useRef<Settings | null>(null);

  const updaterStatus = useUpdaterStatus();
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    window.windowControls?.getVersion?.().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((s) => {
        if (!cancelled) {
          confirmedRef.current = s;
          setSettings(s);
          setVocabularyDraft(s.custom_vocabulary);
          // No token/API-key drafts to seed: the backend never sends the
          // saved secrets back (only *_set flags), so those inputs always
          // start empty and only ever carry a replacement value.
          setBaseUrlDraft(s.custom_api_base_url);
          setCustomModelDraft(s.custom_model_name);
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Applies a full settings response from a non-optimistic save (storage
  // folder, secrets, vocabulary...) without undoing an optimistic change
  // that's still waiting on its own response.
  const applyServerSettings = (updated: Settings) => {
    confirmedRef.current = updated;
    setSettings((current) => {
      if (!current) return updated;
      const merged = { ...updated };
      for (const field of pendingFieldsRef.current) {
        (merged as Record<OptimisticField, unknown>)[field] = current[field];
      }
      return merged;
    });
  };

  const saveOptimistic = async <K extends OptimisticField>(
    field: K,
    value: Settings[K],
    setError: (message: string | null) => void
  ) => {
    const generation = (fieldGenerationRef.current[field] ?? 0) + 1;
    fieldGenerationRef.current[field] = generation;
    pendingFieldsRef.current.add(field);
    setSettings((s) => (s ? { ...s, [field]: value } : s));
    setError(null);
    try {
      const updated = await updateSettings({ [field]: value } as Parameters<typeof updateSettings>[0]);
      if (confirmedRef.current) confirmedRef.current = { ...confirmedRef.current, [field]: updated[field] };
      // A newer change to this field was made meanwhile: its own response
      // (or rollback) decides what's shown, not this one.
      if (fieldGenerationRef.current[field] !== generation) return;
      pendingFieldsRef.current.delete(field);
      setSettings((s) => (s ? { ...s, [field]: updated[field] } : s));
    } catch (e) {
      if (fieldGenerationRef.current[field] !== generation) return;
      pendingFieldsRef.current.delete(field);
      const confirmed = confirmedRef.current;
      setSettings((s) => (s && confirmed ? { ...s, [field]: confirmed[field] } : s));
      setError(e instanceof Error ? e.message : String(e));
    }
  };

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

  // Only runs from the "[confirm]" step below -- this is permanent, and
  // used to fire on a single click.
  const handleEmptyTrash = async () => {
    setConfirmingEmptyTrash(false);
    setEmptyingTrash(true);
    const deleted: string[] = [];
    try {
      const trashed = (await getSessions(true)).filter((s) => s.trashed_at);
      for (const s of trashed) {
        await deleteSessionForever(s.id);
        deleted.push(s.id);
      }
    } catch (e) {
      setUsageError(e instanceof Error ? e.message : String(e));
    } finally {
      setEmptyingTrash(false);
      // Reported even after a partial failure: whatever did get deleted is
      // gone, and a stale trash row for it would 404 on restore.
      if (deleted.length > 0) onSessionsDeleted?.(deleted);
      loadUsage();
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

  const handleWhisperChange = (value: string) => saveOptimistic("whisper_model", value, setWhisperError);

  const handleLanguageChange = (value: string) =>
    saveOptimistic("transcription_language", value, setLanguageSaveError);

  const handleOllamaChange = (value: string) => saveOptimistic("ollama_chat_model", value, setOllamaSaveError);

  const handleProviderChange = (value: "builtin" | "ollama" | "custom") =>
    saveOptimistic("ai_provider", value, setProviderSaveError);

  const handleSaveConnection = async () => {
    setConnectionSaveError(null);
    try {
      const updated = await updateSettings({
        custom_api_base_url: baseUrlDraft,
        // An empty key field means "keep the saved key" (it's never shown,
        // so the field is always empty until the user types a new one);
        // clearing it goes through handleClearApiKey instead.
        ...(apiKeyDraft ? { custom_api_key: apiKeyDraft } : {}),
        custom_model_name: customModelDraft,
      });
      applyServerSettings(updated);
      setBaseUrlDraft(updated.custom_api_base_url);
      setApiKeyDraft("");
      setCustomModelDraft(updated.custom_model_name);
    } catch (e) {
      setConnectionSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleClearApiKey = async () => {
    setConnectionSaveError(null);
    try {
      const updated = await updateSettings({ custom_api_key: "" });
      applyServerSettings(updated);
      setApiKeyDraft("");
    } catch (e) {
      setConnectionSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSaveVocabulary = async () => {
    setVocabularySaveError(null);
    try {
      const updated = await updateSettings({ custom_vocabulary: vocabularyDraft });
      applyServerSettings(updated);
      setVocabularyDraft(updated.custom_vocabulary);
    } catch (e) {
      setVocabularySaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDiarizationToggle = (value: boolean) =>
    saveOptimistic("advanced_diarization_enabled", value, setDiarizationError);

  // Voice profiles are loaded when the Diarization section is opened --
  // they only change through renames and this section's own Forget button.
  useEffect(() => {
    if (activeSection !== "diarization") return;
    let cancelled = false;
    getSpeakerProfiles()
      .then((result) => {
        if (cancelled) return;
        setVoiceProfiles(result);
        setProfilesError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setProfilesError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [activeSection]);

  const handleForgetProfile = async (name: string) => {
    try {
      await deleteSpeakerProfile(name);
      setVoiceProfiles((current) =>
        current
          ? { ...current, profiles: current.profiles.filter((p) => p.name !== name) }
          : current
      );
      setProfilesError(null);
    } catch (e) {
      setProfilesError(e instanceof Error ? e.message : String(e));
    }
  };

  // "" clears the saved token; any other value replaces it.
  const saveToken = async (value: string) => {
    setTokenSaveError(null);
    try {
      const updated = await updateSettings({ huggingface_token: value });
      applyServerSettings(updated);
      setTokenDraft("");
    } catch (e) {
      setTokenSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleBrowseStorage = async () => {
    const chosen = await window.settingsAPI?.chooseFolder?.();
    if (!chosen || !settings) return;

    setStorageBusy(true);
    setStorageError(null);
    try {
      const updated = await updateSettings({ storage_dir: chosen });
      applyServerSettings(updated);
      onLibraryChanged?.();
    } catch (e) {
      setStorageError(e instanceof Error ? e.message : String(e));
    } finally {
      setStorageBusy(false);
    }
  };

  if (loadError && !settings) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-dim text-xs px-6">
        Failed to load settings: {loadError}
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-dim text-xs">
        Loading settings...
      </div>
    );
  }

  const diskLow =
    usage != null &&
    usage.total_bytes > 0 &&
    (usage.free_bytes < 5 * 1024 ** 3 || usage.free_bytes / usage.total_bytes < 0.1);

  const diarizationNeedsToken =
    settings.advanced_diarization_enabled && !settings.huggingface_token_set;

  const dotFor = (id: SectionId): DotTone => {
    switch (id) {
      case "storage":
        return usage == null ? "none" : diskLow ? "warn" : "ok";
      case "ai":
        return ollamaLoading ? "none" : ollamaError ? "err" : "ok";
      case "diarization":
        if (!settings.advanced_diarization_enabled) return "idle";
        return diarizationNeedsToken ? "err" : "ok";
      case "about":
        if (updaterStatus.state === "error") return "err";
        if (updaterStatus.state === "ready") return "ok";
        if (
          updaterStatus.state === "available" ||
          updaterStatus.state === "downloading" ||
          updaterStatus.state === "manual"
        )
          return "warn";
        if (updaterStatus.state === "idle") return "ok";
        return "none";
      default:
        return "none";
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-row text-phosphor">
      <nav className="w-40 shrink-0 border-r border-line bg-void/40 p-2 flex flex-col gap-0.5">
        {NAV_GROUPS.map((group) => (
          <div key={group.heading}>
            <p className="px-2 pt-2 pb-1.5 text-[9px] tracking-[0.15em] text-dim/50 select-none">
              {group.heading.toUpperCase()}
            </p>
            {group.sections.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                aria-current={activeSection === section.id ? "true" : undefined}
                className={
                  "w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-sm text-xs text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-signal " +
                  (activeSection === section.id
                    ? "bg-signal text-void font-semibold"
                    : "text-dim hover:text-phosphor hover:bg-line")
                }
              >
                <span>{section.label}</span>
                <StatusDot tone={dotFor(section.id)} />
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {activeSection === "transcription" && (
          <section className="flex flex-col gap-5">
            <div>
              <h2 className="text-xs font-semibold text-dim uppercase tracking-wide mb-2">
                whisper model
              </h2>
              <div className="flex flex-col gap-1">
                {settings.whisper_model_choices.map((choice) => (
                  <button
                    key={choice.value}
                    onClick={() => handleWhisperChange(choice.value)}
                    className={
                      "text-left px-2 py-1 rounded-sm text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-signal " +
                      (settings.whisper_model === choice.value
                        ? "bg-signal text-void"
                        : "text-dim hover:text-phosphor border border-line")
                    }
                  >
                    [{choice.value}] {choice.label} — {choice.description}
                  </button>
                ))}
              </div>
              {whisperError && <p className="text-xs text-red-400 mt-2">{whisperError}</p>}
            </div>

            <div className="pt-5 border-t border-line/60 flex flex-col gap-2">
              <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">
                language
              </h2>
              <p className="text-xs text-dim">
                Auto-detect figures out the spoken language per recording (each audio track
                separately). Pinning a language skips detection; English also uses the more
                accurate English-only models.
              </p>
              <label htmlFor="transcription-language" className="sr-only">
                transcription language
              </label>
              <select
                id="transcription-language"
                value={settings.transcription_language ?? "auto"}
                onChange={(e) => handleLanguageChange(e.target.value)}
                className="self-start bg-void border border-line rounded-sm text-xs px-2 py-1 text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
              >
                {(settings.transcription_language_choices ?? []).map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
              {languageSaveError && <p className="text-xs text-red-400">{languageSaveError}</p>}
            </div>

            <div className="pt-5 border-t border-line/60 flex flex-col gap-2">
              <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">
                custom vocabulary
              </h2>
              <p className="text-xs text-dim">
                Names, project codenames, and acronyms Whisper should recognize (comma-separated).
              </p>
              <label htmlFor="custom-vocabulary" className="sr-only">
                custom vocabulary
              </label>
              <textarea
                id="custom-vocabulary"
                value={vocabularyDraft}
                onChange={(e) => setVocabularyDraft(e.target.value)}
                rows={3}
                className="bg-void border border-line rounded-sm text-xs px-2 py-1 text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal resize-none"
              />
              <button
                onClick={handleSaveVocabulary}
                className="self-start px-2 py-1 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
              >
                Save vocabulary
              </button>
              {vocabularySaveError && (
                <p className="text-xs text-red-400">{vocabularySaveError}</p>
              )}
            </div>
          </section>
        )}

        {activeSection === "storage" && (
          <section className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">
                storage location
              </h2>
              <p className="text-xs text-phosphor break-all">{settings.storage_dir}</p>
              <button
                onClick={handleBrowseStorage}
                disabled={storageBusy}
                className="self-start px-2 py-1 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:opacity-50"
              >
                {storageBusy ? "Moving recordings..." : "Browse..."}
              </button>
              {storageError && <p className="text-xs text-red-400">{storageError}</p>}
            </div>

            <div className="pt-5 border-t border-line/60 flex flex-col gap-2">
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
                  <p className={"text-xs " + (diskLow ? "text-red-400" : "text-dim")}>
                    {formatBytes(usage.free_bytes)} free on disk
                  </p>
                  {usage.trashed_count > 0 && (
                    <div
                      className={
                        "flex items-center gap-2 mt-1 p-2 rounded-sm border " +
                        (diskLow ? "border-red-400/40 bg-red-400/5" : "border-line")
                      }
                    >
                      <p className="text-xs text-dim flex-1">
                        {usage.trashed_count} session{usage.trashed_count === 1 ? "" : "s"} in
                        trash — purges automatically after 30 days
                      </p>
                      {confirmingEmptyTrash ? (
                        <div className="shrink-0 flex items-center gap-2 text-xs text-red-400">
                          <span>delete forever?</span>
                          <button
                            onClick={handleEmptyTrash}
                            className="text-red-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                          >
                            [confirm]
                          </button>
                          <button
                            onClick={() => setConfirmingEmptyTrash(false)}
                            className="text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                          >
                            [cancel]
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmingEmptyTrash(true)}
                          disabled={emptyingTrash}
                          className="shrink-0 px-2 py-0.5 rounded-sm text-xs border border-red-400/40 text-red-400 hover:bg-red-400/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:opacity-50"
                        >
                          {emptyingTrash ? "Emptying..." : "Empty Trash"}
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
              {!usageError && !usage && <p className="text-xs text-dim">Loading storage usage...</p>}
            </div>
          </section>
        )}

        {activeSection === "ai" && (
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">AI model</h2>
            <p className="text-xs text-dim">Used for chat, meeting summarization, and the knowledge graph.</p>

            <div className="flex items-center gap-2">
              <label htmlFor="ai-provider" className="text-xs text-dim">
                Provider
              </label>
              <select
                id="ai-provider"
                value={settings.ai_provider}
                onChange={(e) => handleProviderChange(e.target.value as "builtin" | "ollama" | "custom")}
                className="bg-void border border-line rounded-sm text-xs px-2 py-1 text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
              >
                <option value="builtin">Built-in (recommended)</option>
                <option value="ollama">Ollama (local)</option>
                <option value="custom">Custom (OpenAI-compatible)</option>
              </select>
            </div>
            {providerSaveError && <p className="text-xs text-red-400">{providerSaveError}</p>}

            {settings.ai_provider === "builtin" && (
              <div className="mt-2 pl-3 border-l-2 border-line flex flex-col gap-2">
                <p className="text-xs text-dim">
                  Runs the bundled model (Gemma 3 4B) on this machine via llama.cpp — no
                  Ollama or account needed, and nothing leaves your computer. The model is
                  downloaded once (~2.5 GB) the first time it's used.
                </p>
              </div>
            )}

            {settings.ai_provider === "ollama" && (
              <div className="mt-2 pl-3 border-l-2 border-line flex flex-col gap-2">
                {ollamaLoading ? (
                  <p className="text-xs text-dim">Loading installed models...</p>
                ) : ollamaError ? (
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-red-400">Ollama unreachable — is it running?</p>
                    <button
                      onClick={loadOllamaModels}
                      className="px-2 py-0.5 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <>
                    <label htmlFor="ollama-chat-model" className="text-xs text-dim">
                      Chat model
                    </label>
                    <select
                      id="ollama-chat-model"
                      value={settings.ollama_chat_model}
                      onChange={(e) => handleOllamaChange(e.target.value)}
                      className="bg-void border border-line rounded-sm text-xs px-2 py-1 text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
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
                    {ollamaSaveError && <p className="text-xs text-red-400">{ollamaSaveError}</p>}
                  </>
                )}
              </div>
            )}

            {settings.ai_provider === "custom" && (
              <div className="mt-2 pl-3 border-l-2 border-line flex flex-col gap-2">
                <p className="text-xs text-dim">
                  Connects to any OpenAI-compatible endpoint. Meeting content is sent to this
                  provider instead of staying on this machine.
                </p>
                <label htmlFor="custom-base-url" className="text-xs text-dim">
                  Base URL
                </label>
                <input
                  id="custom-base-url"
                  type="text"
                  value={baseUrlDraft}
                  onChange={(e) => setBaseUrlDraft(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="bg-void border border-line rounded-sm text-xs px-2 py-1 text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                />
                <label htmlFor="custom-api-key" className="text-xs text-dim">
                  API Key
                </label>
                <input
                  id="custom-api-key"
                  type="password"
                  value={apiKeyDraft}
                  onChange={(e) => setApiKeyDraft(e.target.value)}
                  placeholder={settings.custom_api_key_set ? "Saved -- type a new key to replace it" : "sk-..."}
                  className="bg-void border border-line rounded-sm text-xs px-2 py-1 text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                />
                {settings.custom_api_key_set && (
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-dim">An API key is saved.</p>
                    <button
                      onClick={handleClearApiKey}
                      className="px-2 py-0.5 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                    >
                      Clear key
                    </button>
                  </div>
                )}
                <label htmlFor="custom-model-name" className="text-xs text-dim">
                  Model name
                </label>
                <input
                  id="custom-model-name"
                  type="text"
                  value={customModelDraft}
                  onChange={(e) => setCustomModelDraft(e.target.value)}
                  placeholder="gpt-4o-mini"
                  className="bg-void border border-line rounded-sm text-xs px-2 py-1 text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                />
                <button
                  onClick={handleSaveConnection}
                  className="self-start px-2 py-1 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                >
                  Save connection
                </button>
                {connectionSaveError && <p className="text-xs text-red-400">{connectionSaveError}</p>}
              </div>
            )}
          </section>
        )}

        {activeSection === "diarization" && (
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">
              voice profiles
            </h2>
            <p className="text-xs text-dim">
              Meeting speakers are told apart by voice automatically. Name a speaker once in a
              transcript and that voice is recognized — and pre-named — in future meetings.
            </p>
            {voiceProfiles !== null && !voiceProfiles.available && (
              <p className="text-xs text-dim">
                Speaker recognition is unavailable on this install (embedding model missing).
              </p>
            )}
            {voiceProfiles !== null && voiceProfiles.available && voiceProfiles.profiles.length === 0 && (
              <p className="text-xs text-dim">
                No saved voices yet — open a meeting's transcript and rename a speaker to create
                one.
              </p>
            )}
            {voiceProfiles !== null && voiceProfiles.profiles.length > 0 && (
              <ul className="flex flex-col gap-1">
                {voiceProfiles.profiles.map((p) => (
                  <li
                    key={p.name}
                    className="flex items-center justify-between gap-2 border border-line rounded-sm px-2 py-1"
                  >
                    <span className="text-xs text-phosphor truncate">
                      {p.name}{" "}
                      <span className="text-dim">
                        · {p.meetings} {p.meetings === 1 ? "meeting" : "meetings"}
                      </span>
                    </span>
                    <button
                      onClick={() => handleForgetProfile(p.name)}
                      className="shrink-0 px-2 py-0.5 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                    >
                      Forget
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {profilesError && <p className="text-xs text-red-400">{profilesError}</p>}

            <h2 className="text-xs font-semibold text-dim uppercase tracking-wide mt-4 pt-4 border-t border-line/60">
              advanced diarization
            </h2>
            <p className="text-xs text-dim">
              Split multiple remote participants into individually labeled speakers instead of one
              generic "Others" bucket. Optional -- downloads a larger model on first use and
              requires a free HuggingFace account.
            </p>
            <div className="flex gap-1">
              {[
                { value: false, label: "Off" },
                { value: true, label: "On" },
              ].map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => handleDiarizationToggle(opt.value)}
                  className={
                    "px-2 py-1 rounded-sm text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-signal " +
                    (settings.advanced_diarization_enabled === opt.value
                      ? "bg-signal text-void"
                      : "text-dim hover:text-phosphor border border-line")
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {diarizationError && <p className="text-xs text-red-400">{diarizationError}</p>}
            {diarizationNeedsToken && (
              <p className="text-xs text-red-400 rounded-sm border border-red-400/40 bg-red-400/5 px-2 py-1.5">
                A HuggingFace access token is required for diarization to actually run -- add one
                below.
              </p>
            )}
            <label htmlFor="huggingface-token" className="text-xs text-dim mt-2">
              HuggingFace access token
            </label>
            <input
              id="huggingface-token"
              type="password"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder={settings.huggingface_token_set ? "Saved -- type a new token to replace it" : "hf_..."}
              className="bg-void border border-line rounded-sm text-xs px-2 py-1 text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            />
            {settings.huggingface_token_set && <p className="text-xs text-dim">A token is saved.</p>}
            <div className="flex gap-2">
              <button
                onClick={() => saveToken(tokenDraft)}
                disabled={!tokenDraft}
                className="self-start px-2 py-1 rounded-sm text-xs border border-line text-dim hover:text-phosphor disabled:opacity-40 disabled:hover:text-dim focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
              >
                Save token
              </button>
              {settings.huggingface_token_set && (
                <button
                  onClick={() => saveToken("")}
                  className="self-start px-2 py-1 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                >
                  Clear token
                </button>
              )}
            </div>
            {tokenSaveError && <p className="text-xs text-red-400">{tokenSaveError}</p>}
          </section>
        )}

        {activeSection === "appearance" && (
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">theme</h2>
            <p className="text-xs text-dim">
              Applies to the whole app, the recording rail included. Saved on this machine.
            </p>
            <div className="flex gap-1" role="group" aria-label="Theme">
              {(
                [
                  { value: "dark", label: "Dark (phosphor)" },
                  { value: "light", label: "Light (paper)" },
                ] as { value: Theme; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleThemeChange(opt.value)}
                  aria-pressed={theme === opt.value}
                  className={
                    "px-2 py-1 rounded-sm text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-signal " +
                    (theme === opt.value
                      ? "bg-signal text-void"
                      : "text-dim hover:text-phosphor border border-line")
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </section>
        )}

        {activeSection === "privacy" && (
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">privacy</h2>
            <p className="text-xs text-dim max-w-md leading-relaxed">
              Recordings and notes are stored only on this machine and never uploaded anywhere.
              Items moved to trash are permanently deleted after 30 days.
            </p>
          </section>
        )}

        {activeSection === "diagnostics" && (
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">diagnostics</h2>
            <p className="text-xs text-dim max-w-md leading-relaxed">
              If something breaks, this app writes what happened to a local log file — nothing is
              sent anywhere automatically. Open the folder below to find it if you want to look
              into an issue yourself, or attach it if you're reporting a bug.
            </p>
            <button
              onClick={() => window.diagnosticsAPI?.openLogsFolder()}
              className="self-start px-2 py-1 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              Open logs folder
            </button>
          </section>
        )}

        {activeSection === "about" && (
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">updates</h2>
            <p className="text-xs text-phosphor">
              {appVersion ? `version ${appVersion}` : "loading version..."}
            </p>
            {updaterStatus.state === "not-checked" && (
              <p className="text-xs text-dim">Not checked yet</p>
            )}
            {updaterStatus.state === "idle" && (
              <p className="text-xs text-dim">You're on the latest version</p>
            )}
            {updaterStatus.state === "checking" && (
              <p className="text-xs text-dim">Checking for updates...</p>
            )}
            {updaterStatus.state === "available" && (
              <p className="text-xs text-dim">
                Update {updaterStatus.version} found — downloading...
              </p>
            )}
            {updaterStatus.state === "manual" && (
              <p className="text-xs text-phosphor">
                Version {updaterStatus.version} is available —{" "}
                <a
                  href={updaterStatus.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-signal underline focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                >
                  download it from deskrecap.com
                </a>
              </p>
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
                  className="px-2 py-0.5 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                >
                  restart to update
                </button>
              </div>
            )}
            {updaterStatus.state === "error" && (
              <p className="text-xs text-dim">Update check failed: {updaterStatus.message}</p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
