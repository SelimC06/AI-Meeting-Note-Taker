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
