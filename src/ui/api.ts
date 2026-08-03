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
