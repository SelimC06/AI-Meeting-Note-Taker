export type Session = {
  id: string;
  created_at: string;
  title: string;
  notes: string;
  video_path: string;
  trashed_at: string | null;
  // Absent on session records written before this field existed -- treat
  // missing/undefined the same as "done" (a normal, fully-processed
  // session). "failed": the processing job errored out but the recording
  // data was preserved. "recovered": adopted from an unindexed orphan
  // directory found on disk at startup (crash/restart mid-job).
  status?: "done" | "failed" | "recovered";
  // Only set when status is "failed" -- the error message from the job
  // that failed, shown as the badge's tooltip in the Sidebar.
  error?: string;
};

// Normally :8000, but main.js falls back to a nearby port when 8000 is held
// by some unrelated process (see resolveBackendPort/ensurePortFree there) and
// threads the actual port through via window.BACKEND_CONFIG (preload.js).
// VITE_MEETING_API_URL still wins outright for the plain-vite-dev-server case,
// where there's no Electron preload to read it from.
// 127.0.0.1, not localhost: main.js itself binds/probes the backend at
// 127.0.0.1 (see backend.js's waitForHealth), so "localhost" here resolved
// through DNS/hosts first -- on a machine where that tries IPv6 (::1)
// before IPv4, every single request paid a connection-refused fallback
// before landing on the same IPv4 address main.js was already using.
export const BACKEND_URL =
  import.meta.env.VITE_MEETING_API_URL ??
  `http://127.0.0.1:${window.BACKEND_CONFIG?.port ?? 8000}`;

export const BACKEND_TOKEN_HEADER = "X-DeskRecap-Token";

// The backend rejects (401) every request without the per-launch token main.js
// generated -- 127.0.0.1 is reachable from any web page the user visits, so
// the token is what proves a request came from this app. Electron hands it
// over via window.BACKEND_CONFIG (preload.js); VITE_DESKRECAP_API_TOKEN covers
// the plain-vite-dev-server case (matching DESKRECAP_API_TOKEN on the backend,
// see README). Read per call rather than once at import so a test can set it.
function backendToken(): string | null {
  return window.BACKEND_CONFIG?.token ?? import.meta.env.VITE_DESKRECAP_API_TOKEN ?? null;
}

// Every request to the backend goes through this -- including the streaming
// chat and export downloads -- so none of them can forget the token header.
export function backendFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = backendToken();
  if (token) headers.set(BACKEND_TOKEN_HEADER, token);
  return fetch(input, { ...init, headers });
}

// `code` on the Error getSessions throws when the backend's sessions index
// exists but is damaged (503). The backend refuses every read and write
// until it's recovered via recoverSessionsIndex(), rather than showing an
// empty library or overwriting it -- the UI offers that action for this
// code specifically.
export const SESSIONS_INDEX_CORRUPT = "sessions_index_corrupt";

export type ApiError = Error & { code?: string };

export async function getSessions(includeTrashed = false): Promise<Session[]> {
  const url = includeTrashed
    ? `${BACKEND_URL}/sessions?include_trashed=true`
    : `${BACKEND_URL}/sessions`;
  const resp = await backendFetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    const detail = body?.detail;
    if (detail && typeof detail === "object" && typeof detail.message === "string") {
      const err: ApiError = new Error(detail.message);
      err.code = typeof detail.code === "string" ? detail.code : undefined;
      throw err;
    }
    throw new Error(`Failed to load sessions: ${resp.status}`);
  }
  return (await resp.json()) as Session[];
}

export type RecoverIndexResult = {
  source: "none" | "backup" | "rebuild";
  restored: number;
  adopted: number;
  preserved_copy: string | null;
};

export async function recoverSessionsIndex(): Promise<RecoverIndexResult> {
  const resp = await backendFetch(`${BACKEND_URL}/sessions/recover-index`, { method: "POST" });
  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    throw new Error(
      typeof body?.detail === "string" ? body.detail : `Failed to recover library: ${resp.status}`
    );
  }
  return (await resp.json()) as RecoverIndexResult;
}

// Deadline for one /health request. A hung backend accepts the connection
// and never answers: without a deadline the poll never settled, so the
// backend was never flagged "unresponsive", and the stuck requests -- from
// several pollers, every few seconds -- filled Chromium's 6-connections-per-
// host limit and stalled chat, settings and export behind them. A timeout
// here reads as "unhealthy" (false / backend:false), which is exactly what
// the unresponsive threshold should count.
export const HEALTH_REQUEST_TIMEOUT_MS = 5000;

function healthSignal(): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) : undefined;
}

export async function checkHealth(signal: AbortSignal | undefined = healthSignal()): Promise<boolean> {
  try {
    const resp = await backendFetch(`${BACKEND_URL}/health`, { signal });
    return resp.ok;
  } catch {
    return false;
  }
}

export type HealthStatus = {
  ok: boolean;
  backend: boolean;
  ollama: boolean;
  // Set when the backend found settings.json damaged at startup (it keeps
  // running on defaults, or on the salvaged storage folder) -- cleared once
  // any setting is saved. Optional: older backends don't send it.
  settings_error?: string | null;
};

export async function getHealthStatus(signal: AbortSignal | undefined = healthSignal()): Promise<HealthStatus> {
  try {
    const resp = await backendFetch(`${BACKEND_URL}/health`, { signal });
    if (!resp.ok) return { ok: false, backend: false, ollama: false };
    const data = (await resp.json()) as Partial<HealthStatus>;
    return {
      ok: data.ok ?? false,
      backend: data.backend ?? false,
      ollama: data.ollama ?? false,
      settings_error: typeof data.settings_error === "string" ? data.settings_error : null,
    };
  } catch {
    return { ok: false, backend: false, ollama: false };
  }
}

export type ChatTurn = { role: "user" | "assistant"; content: string };

export async function* streamChatReply(
  sessionId: string,
  message: string,
  history: ChatTurn[],
  signal?: AbortSignal
): AsyncGenerator<string> {
  const resp = await backendFetch(`${BACKEND_URL}/chat/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
    signal,
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Chat request failed: ${resp.status}${text ? ` ${text}` : ""}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseLine = (line: string): string => {
    const obj = JSON.parse(line) as { token?: string; error?: string };
    if (obj.error !== undefined) {
      throw new Error(`Chat failed mid-response: ${obj.error}`);
    }
    return obj.token ?? "";
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield parseLine(line);
      }
    }
    // Final flush: a multi-byte character split across the last two chunks is
    // still buffered inside the decoder until this argument-less call.
    buffer += decoder.decode();
    const rest = buffer.trim();
    if (rest) {
      try {
        yield parseLine(rest);
      } catch (e) {
        if (e instanceof SyntaxError) {
          // The backend died mid-line -- surface it as what it is instead of
          // leaking a JSON parser error into the chat UI.
          throw new Error("Chat connection was interrupted before the reply finished.");
        }
        throw e; // a real {"error": ...} line rethrows its own message
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export type GraphSource = { id: string; title: string; created_at: string };

export type GraphChatEvent =
  | { type: "sources"; sources: GraphSource[] }
  | { type: "token"; token: string };

// Streams POST /graph/chat: same NDJSON framing as streamChatReply
// ({"token"}/{"error"} lines) plus one leading {"sources": [...]} line,
// surfaced as a typed event so the UI can render source chips.
export async function* streamGraphChatReply(
  message: string,
  history: ChatTurn[],
  signal?: AbortSignal
): AsyncGenerator<GraphChatEvent> {
  const resp = await backendFetch(`${BACKEND_URL}/graph/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
    signal,
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Chat request failed: ${resp.status}${text ? ` ${text}` : ""}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseLine = (line: string): GraphChatEvent | null => {
    const obj = JSON.parse(line) as { token?: string; error?: string; sources?: GraphSource[] };
    if (obj.error !== undefined) {
      throw new Error(`Chat failed mid-response: ${obj.error}`);
    }
    if (obj.sources !== undefined) {
      return { type: "sources", sources: obj.sources };
    }
    if (obj.token !== undefined && obj.token !== "") {
      return { type: "token", token: obj.token };
    }
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const event = parseLine(line);
          if (event) yield event;
        }
      }
    }
    buffer += decoder.decode();
    const rest = buffer.trim();
    if (rest) {
      try {
        const event = parseLine(rest);
        if (event) yield event;
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new Error("Chat connection was interrupted before the reply finished.");
        }
        throw e;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export type WhisperModelChoice = {
  value: string;
  label: string;
  description: string;
};

export type TranscriptionLanguageChoice = {
  value: string;
  label: string;
};

export type Settings = {
  // The model SIZE ("base"), not a concrete faster-whisper name: the
  // backend picks the multilingual or English-only variant per recording
  // from transcription_language.
  whisper_model: string;
  // "auto" (detect per recording) or a fixed language code from
  // transcription_language_choices.
  transcription_language: string;
  storage_dir: string;
  ollama_chat_model: string;
  custom_vocabulary: string;
  // Track B: true n-party diarization via pyannote. Off by default -- an
  // optional, heavier feature that requires a HuggingFace access token to
  // download the (gated) model weights.
  advanced_diarization_enabled: boolean;
  // Secrets are write-only: the backend never returns their values, only
  // whether one is saved. Send the value via updateSettings to replace it,
  // or "" to clear it.
  huggingface_token_set: boolean;
  // Which LLM backend powers chat, summarization, and knowledge-graph
  // extraction. "builtin" (the default): the bundled llama.cpp server with
  // a one-time local model download -- no Ollama install needed. "ollama"
  // and "custom" (any OpenAI-compatible endpoint) are the advanced options.
  ai_provider: "builtin" | "ollama" | "custom";
  custom_api_base_url: string;
  custom_api_key_set: boolean;
  custom_model_name: string;
  whisper_model_choices: WhisperModelChoice[];
  transcription_language_choices: TranscriptionLanguageChoice[];
};

export type SettingsSecrets = {
  huggingface_token: string;
  custom_api_key: string;
};

export async function getSettings(): Promise<Settings> {
  const resp = await backendFetch(`${BACKEND_URL}/settings`);
  if (!resp.ok) {
    throw new Error(`Failed to load settings: ${resp.status}`);
  }
  return (await resp.json()) as Settings;
}

export async function updateSettings(
  partial: Partial<
    Pick<
      Settings,
      | "whisper_model"
      | "transcription_language"
      | "storage_dir"
      | "ollama_chat_model"
      | "custom_vocabulary"
      | "advanced_diarization_enabled"
      | "ai_provider"
      | "custom_api_base_url"
      | "custom_model_name"
    > &
      SettingsSecrets
  >
): Promise<Settings> {
  const resp = await backendFetch(`${BACKEND_URL}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `Failed to update settings: ${resp.status}`);
  }
  return (await resp.json()) as Settings;
}

// GET /builtin/status, polled by BuiltinModelGate while the built-in
// provider is selected. `progress` is only non-null while downloading.
export type BuiltinStatus = {
  state: "idle" | "downloading" | "verifying" | "starting" | "ready" | "error";
  error: string | null;
  progress: { downloaded_bytes: number; total_bytes: number } | null;
  model: { name: string; label: string; size_bytes: number };
  model_downloaded: boolean;
};

// null rather than throwing on any failure (backend still booting,
// connection refused) -- same tolerance as getOllamaModels: the gate polls
// this and a transient fetch error must read as "unknown", never as a
// setup problem to put a full-screen gate in front of.
export async function getBuiltinStatus(): Promise<BuiltinStatus | null> {
  try {
    const resp = await backendFetch(`${BACKEND_URL}/builtin/status`);
    if (!resp.ok) return null;
    return (await resp.json()) as BuiltinStatus;
  } catch {
    return null;
  }
}

// Starts (or resumes) the one-time model download + server boot. Idempotent
// on the backend; returns the status right after kicking it off.
export async function startBuiltinSetup(): Promise<BuiltinStatus | null> {
  try {
    const resp = await backendFetch(`${BACKEND_URL}/builtin/setup`, { method: "POST" });
    if (!resp.ok) return null;
    return (await resp.json()) as BuiltinStatus;
  } catch {
    return null;
  }
}

// POST /live/transcribe: one standalone audio window from the rail's
// caption recorders in, caption text out. Returns null for every failure
// mode (backend busy with other windows -> 429, transient network error,
// unreadable chunk): live captions simply skip that window -- a dropped
// caption must never surface as an error.
export async function liveTranscribe(chunk: Blob, filename: string): Promise<string | null> {
  const formData = new FormData();
  formData.append("chunk", chunk, filename);
  try {
    const resp = await backendFetch(`${BACKEND_URL}/live/transcribe`, {
      method: "POST",
      body: formData,
    });
    if (!resp.ok) {
      // 429 is routine (both slots busy -- the window is simply skipped);
      // anything else means captions are silently broken (e.g. an old
      // backend without this endpoint), which should at least be visible
      // in the devtools console.
      if (resp.status !== 429) {
        console.warn(`live captions: /live/transcribe answered ${resp.status}`);
      }
      return null;
    }
    const data = (await resp.json()) as { text?: unknown };
    return typeof data.text === "string" ? data.text : null;
  } catch (e) {
    console.warn("live captions: /live/transcribe request failed", e);
    return null;
  }
}

// Fire-and-forget: asks the backend to load the live-caption Whisper model
// now (recording just started), so the first caption window doesn't pay
// the cold model load. Failures are irrelevant -- the first transcribe
// call loads the model itself, just slower.
export function warmLiveTranscription(): void {
  void backendFetch(`${BACKEND_URL}/live/warm`, { method: "POST" }).catch(() => {});
}

// Mirrors the backend's /import whitelist (IMPORT_SUFFIXES in server.py)
// so the file picker only offers what will actually be accepted.
export const IMPORT_FILE_EXTENSIONS = [
  ".mp4", ".m4v", ".mov", ".webm", ".mkv",
  ".m4a", ".mp3", ".wav", ".ogg", ".oga", ".opus", ".flac", ".aac", ".aiff",
];

// POST /import: uploads an existing audio/video recording; the backend
// runs it through the same transcribe -> summarize pipeline as a live
// recording and the returned job shows up in the normal jobs polling.
export async function importRecording(file: File): Promise<{ job_id: string; session_id: string }> {
  const formData = new FormData();
  formData.append("file", file, file.name);
  const resp = await backendFetch(`${BACKEND_URL}/import`, { method: "POST", body: formData });
  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    throw new Error(
      typeof body?.detail === "string" ? body.detail : `Import failed: ${resp.status}`
    );
  }
  return (await resp.json()) as { job_id: string; session_id: string };
}

// Persistent voice profiles (Tier 2.1): name a speaker once in any
// meeting's transcript and their voice is recognized -- and pre-named --
// in later meetings.
export type SpeakerProfile = {
  name: string;
  meetings: number;
  updated_at: string | null;
};

export type SpeakerProfilesResult = {
  // False when this install can't run speaker recognition (embedding
  // model or onnx runtime missing) -- the list is then always empty.
  available: boolean;
  profiles: SpeakerProfile[];
};

export async function getSpeakerProfiles(): Promise<SpeakerProfilesResult> {
  const resp = await backendFetch(`${BACKEND_URL}/speaker-profiles`);
  if (!resp.ok) throw new Error(`Failed to load voice profiles: ${resp.status}`);
  return (await resp.json()) as SpeakerProfilesResult;
}

export async function deleteSpeakerProfile(name: string): Promise<void> {
  const resp = await backendFetch(
    `${BACKEND_URL}/speaker-profiles/${encodeURIComponent(name)}`,
    { method: "DELETE" }
  );
  if (!resp.ok) throw new Error(`Failed to delete voice profile: ${resp.status}`);
}

export type OllamaModelsResult = {
  ok: boolean;
  models: string[];
  error: string | null;
};

export async function getOllamaModels(): Promise<OllamaModelsResult> {
  try {
    const resp = await backendFetch(`${BACKEND_URL}/ollama/models`);
    if (!resp.ok) {
      return { ok: false, models: [], error: `Request failed: ${resp.status}` };
    }
    return (await resp.json()) as OllamaModelsResult;
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// Session and job ids are encodeURIComponent'd into every path below. They
// are uuid hex today, so this changes nothing in practice -- it just means
// an id can never reach a different route ("../", "?", "#") if that ever
// stops being true.
export async function renameSession(id: string, title: string): Promise<Session> {
  const resp = await backendFetch(`${BACKEND_URL}/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `Failed to rename session: ${resp.status}`);
  }
  return (await resp.json()) as Session;
}

export async function trashSession(id: string): Promise<Session> {
  const resp = await backendFetch(`${BACKEND_URL}/sessions/${encodeURIComponent(id)}/trash`, { method: "POST" });
  if (!resp.ok) {
    throw new Error(`Failed to trash session: ${resp.status}`);
  }
  return (await resp.json()) as Session;
}

export async function restoreSession(id: string): Promise<Session> {
  const resp = await backendFetch(`${BACKEND_URL}/sessions/${encodeURIComponent(id)}/restore`, { method: "POST" });
  if (!resp.ok) {
    throw new Error(`Failed to restore session: ${resp.status}`);
  }
  return (await resp.json()) as Session;
}

export async function deleteSessionForever(id: string): Promise<void> {
  const resp = await backendFetch(`${BACKEND_URL}/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!resp.ok) {
    throw new Error(`Failed to delete session: ${resp.status}`);
  }
}

// Speaker is "You"/"Others" (Track A's mic-vs-system 2-party split) by
// default, a raw pyannote label like "SPEAKER_00" (or a user-renamed value,
// already resolved server-side) once Track B diarization is enabled, or
// null when no structured transcript was produced at all (e.g. only one of
// the mic/system tracks was captured and diarization wasn't enabled, so
// nothing could label it).
export type TranscriptSegment = {
  // null for a session with only a plain-text transcript (no timings).
  start: number | null;
  end: number | null;
  // null when the audio can't be attributed to anyone (a mixed-down track,
  // or a plain-text transcript) -- rendered as text with no speaker label.
  speaker: string | null;
  text: string;
  // The original, stable label (e.g. "SPEAKER_00") before any user rename
  // was resolved into `speaker` -- needed to target a second rename at the
  // right key, since `speaker` alone can't be reversed back to it.
  raw_speaker?: string | null;
};

export async function getSessionTranscript(id: string): Promise<TranscriptSegment[]> {
  const resp = await backendFetch(`${BACKEND_URL}/sessions/${encodeURIComponent(id)}/transcript`);
  if (!resp.ok) {
    throw new Error(`Failed to load transcript: ${resp.status}`);
  }
  const data = (await resp.json()) as { segments: TranscriptSegment[] };
  return data.segments;
}

// Maps a raw speaker label (e.g. "SPEAKER_00") to a user-chosen display
// name. Partial: only the labels included in `names` are touched, existing
// mappings for other labels in the same session are preserved (the backend
// merges rather than replaces).
export async function updateSpeakerNames(
  id: string,
  names: Record<string, string>
): Promise<Record<string, string>> {
  const resp = await backendFetch(`${BACKEND_URL}/sessions/${encodeURIComponent(id)}/speaker-names`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ names }),
  });
  if (!resp.ok) {
    throw new Error(`Failed to update speaker names: ${resp.status}`);
  }
  const data = (await resp.json()) as { speaker_names: Record<string, string> };
  return data.speaker_names;
}

// null action_items means structured extraction is unavailable for this
// session -- an old session recorded before this feature existed, or one
// where the local model's JSON output never parsed even after the
// backend's own retry. Callers must fall back to rendering the session's
// prose `notes` instead of a checklist; never treat null the same as an
// empty (but valid) list.
export type ActionItem = {
  text: string;
  owner: string | null;
  due: string | null;
};

export async function getSessionActionItems(id: string): Promise<ActionItem[] | null> {
  const resp = await backendFetch(`${BACKEND_URL}/sessions/${encodeURIComponent(id)}/action-items`);
  if (!resp.ok) {
    throw new Error(`Failed to load action items: ${resp.status}`);
  }
  const data = (await resp.json()) as { action_items: ActionItem[] | null };
  return data.action_items;
}

export function exportSessionNotesUrl(id: string): string {
  return `${BACKEND_URL}/sessions/${encodeURIComponent(id)}/export/notes`;
}

export function exportSessionZipUrl(id: string): string {
  return `${BACKEND_URL}/sessions/${encodeURIComponent(id)}/export/zip`;
}

export type StorageUsage = {
  used_bytes: number;
  free_bytes: number;
  total_bytes: number;
  session_count: number;
  trashed_count: number;
};

export async function getStorageUsage(): Promise<StorageUsage> {
  const resp = await backendFetch(`${BACKEND_URL}/storage/usage`);
  if (!resp.ok) {
    throw new Error(`Failed to load storage usage: ${resp.status}`);
  }
  return (await resp.json()) as StorageUsage;
}

export type JobStatus = {
  id: string;
  session_id: string;
  status: "queued" | "running" | "done" | "failed";
  stage: "muxing" | "transcribing" | "summarizing" | "saving" | null;
  // Set while a stage runs several model calls (a long transcript is
  // summarized in chunks), so the UI can show it's still moving.
  progress?: { done: number; total: number } | null;
  error: string | null;
  notes: string | null;
  video_path: string | null;
  created_at: string;
};

export async function startProcessing(
  formData: FormData
): Promise<{ job_id: string; session_id: string }> {
  const resp = await backendFetch(`${BACKEND_URL}/process`, {
    method: "POST",
    body: formData,
  });

  if (!resp.ok) {
    const text = await resp.text();
    let detail: string;
    try {
      const body = JSON.parse(text);
      detail = typeof body?.detail === "string" ? body.detail : JSON.stringify(body);
    } catch {
      detail = text;
    }
    // An empty body (a proxy's bare 502, a crash mid-response) used to throw
    // Error("") -- the rail then showed no message and so no "retry upload",
    // though the recording was queued for one.
    throw new Error(detail.trim() ? detail : `Upload failed: HTTP ${resp.status}`);
  }

  return (await resp.json()) as { job_id: string; session_id: string };
}

// `signal` lets a poller put a deadline on these (see useProcessingJobs):
// against a hung backend a plain fetch never settles, so polls pile up.
export async function getJobStatus(jobId: string, signal?: AbortSignal): Promise<JobStatus> {
  const resp = await backendFetch(`${BACKEND_URL}/jobs/${encodeURIComponent(jobId)}`, { signal });
  if (!resp.ok) {
    throw new Error(`Failed to fetch job status: ${resp.status}`);
  }
  return (await resp.json()) as JobStatus;
}

export async function listJobs(signal?: AbortSignal): Promise<JobStatus[]> {
  const resp = await backendFetch(`${BACKEND_URL}/jobs`, { signal });
  if (!resp.ok) {
    throw new Error(`Failed to list jobs: ${resp.status}`);
  }
  return (await resp.json()) as JobStatus[];
}
