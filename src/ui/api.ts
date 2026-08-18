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

export async function getSessions(includeTrashed = false): Promise<Session[]> {
  const url = includeTrashed
    ? `${BACKEND_URL}/sessions?include_trashed=true`
    : `${BACKEND_URL}/sessions`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to load sessions: ${resp.status}`);
  }
  return (await resp.json()) as Session[];
}

export async function checkHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${BACKEND_URL}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

export type HealthStatus = {
  ok: boolean;
  backend: boolean;
  ollama: boolean;
};

export async function getHealthStatus(): Promise<HealthStatus> {
  try {
    const resp = await fetch(`${BACKEND_URL}/health`);
    if (!resp.ok) return { ok: false, backend: false, ollama: false };
    const data = (await resp.json()) as Partial<HealthStatus>;
    return {
      ok: data.ok ?? false,
      backend: data.backend ?? false,
      ollama: data.ollama ?? false,
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
  const resp = await fetch(`${BACKEND_URL}/chat/${sessionId}`, {
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
  const resp = await fetch(`${BACKEND_URL}/graph/chat`, {
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

export type Settings = {
  whisper_model: string;
  storage_dir: string;
  ollama_chat_model: string;
  custom_vocabulary: string;
  // Track B: true n-party diarization via pyannote. Off by default -- an
  // optional, heavier feature that requires a HuggingFace access token to
  // download the (gated) model weights.
  advanced_diarization_enabled: boolean;
  huggingface_token: string;
  whisper_model_choices: WhisperModelChoice[];
};

export async function getSettings(): Promise<Settings> {
  const resp = await fetch(`${BACKEND_URL}/settings`);
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
      | "storage_dir"
      | "ollama_chat_model"
      | "custom_vocabulary"
      | "advanced_diarization_enabled"
      | "huggingface_token"
    >
  >
): Promise<Settings> {
  const resp = await fetch(`${BACKEND_URL}/settings`, {
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

export type OllamaModelsResult = {
  ok: boolean;
  models: string[];
  error: string | null;
};

export async function getOllamaModels(): Promise<OllamaModelsResult> {
  try {
    const resp = await fetch(`${BACKEND_URL}/ollama/models`);
    if (!resp.ok) {
      return { ok: false, models: [], error: `Request failed: ${resp.status}` };
    }
    return (await resp.json()) as OllamaModelsResult;
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export async function renameSession(id: string, title: string): Promise<Session> {
  const resp = await fetch(`${BACKEND_URL}/sessions/${id}`, {
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
  const resp = await fetch(`${BACKEND_URL}/sessions/${id}/trash`, { method: "POST" });
  if (!resp.ok) {
    throw new Error(`Failed to trash session: ${resp.status}`);
  }
  return (await resp.json()) as Session;
}

export async function restoreSession(id: string): Promise<Session> {
  const resp = await fetch(`${BACKEND_URL}/sessions/${id}/restore`, { method: "POST" });
  if (!resp.ok) {
    throw new Error(`Failed to restore session: ${resp.status}`);
  }
  return (await resp.json()) as Session;
}

export async function deleteSessionForever(id: string): Promise<void> {
  const resp = await fetch(`${BACKEND_URL}/sessions/${id}`, { method: "DELETE" });
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
  start: number;
  end: number;
  speaker: string | null;
  text: string;
  // The original, stable label (e.g. "SPEAKER_00") before any user rename
  // was resolved into `speaker` -- needed to target a second rename at the
  // right key, since `speaker` alone can't be reversed back to it.
  raw_speaker?: string | null;
};

export async function getSessionTranscript(id: string): Promise<TranscriptSegment[]> {
  const resp = await fetch(`${BACKEND_URL}/sessions/${id}/transcript`);
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
  const resp = await fetch(`${BACKEND_URL}/sessions/${id}/speaker-names`, {
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
  const resp = await fetch(`${BACKEND_URL}/sessions/${id}/action-items`);
  if (!resp.ok) {
    throw new Error(`Failed to load action items: ${resp.status}`);
  }
  const data = (await resp.json()) as { action_items: ActionItem[] | null };
  return data.action_items;
}

export function exportSessionNotesUrl(id: string): string {
  return `${BACKEND_URL}/sessions/${id}/export/notes`;
}

export function exportSessionZipUrl(id: string): string {
  return `${BACKEND_URL}/sessions/${id}/export/zip`;
}

export type StorageUsage = {
  used_bytes: number;
  free_bytes: number;
  total_bytes: number;
  session_count: number;
  trashed_count: number;
};

export async function getStorageUsage(): Promise<StorageUsage> {
  const resp = await fetch(`${BACKEND_URL}/storage/usage`);
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
  error: string | null;
  notes: string | null;
  video_path: string | null;
  created_at: string;
};

export async function startProcessing(
  formData: FormData
): Promise<{ job_id: string; session_id: string }> {
  const resp = await fetch(`${BACKEND_URL}/process`, {
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
    throw new Error(detail);
  }

  return (await resp.json()) as { job_id: string; session_id: string };
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const resp = await fetch(`${BACKEND_URL}/jobs/${jobId}`);
  if (!resp.ok) {
    throw new Error(`Failed to fetch job status: ${resp.status}`);
  }
  return (await resp.json()) as JobStatus;
}

export async function listJobs(): Promise<JobStatus[]> {
  const resp = await fetch(`${BACKEND_URL}/jobs`);
  if (!resp.ok) {
    throw new Error(`Failed to list jobs: ${resp.status}`);
  }
  return (await resp.json()) as JobStatus[];
}
