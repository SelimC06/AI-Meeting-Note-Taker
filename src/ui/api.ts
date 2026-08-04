export type Session = {
  id: string;
  created_at: string;
  title: string;
  notes: string;
  video_path: string;
};

export const BACKEND_URL =
  import.meta.env.VITE_MEETING_API_URL ?? "http://localhost:8000";

export async function getSessions(): Promise<Session[]> {
  const resp = await fetch(`${BACKEND_URL}/sessions`);
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
