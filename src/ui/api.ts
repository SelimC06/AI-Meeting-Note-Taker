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
export const BACKEND_URL =
  import.meta.env.VITE_MEETING_API_URL ??
  `http://localhost:${window.BACKEND_CONFIG?.port ?? 8000}`;

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
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
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
  partial: Partial<Pick<Settings, "whisper_model" | "storage_dir" | "ollama_chat_model">>
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
