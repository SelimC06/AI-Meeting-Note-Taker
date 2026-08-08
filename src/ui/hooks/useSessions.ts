import { useCallback, useEffect, useState } from "react";
import { getSessions, type Session } from "../api";

export function useSessions(active: boolean, includeTrashed: boolean) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchAndSet = useCallback(
    (onDone?: () => boolean) => {
      getSessions(includeTrashed)
        .then((data) => {
          if (onDone && !onDone()) return;
          setSessions(includeTrashed ? data.filter((s) => s.trashed_at) : data);
          setError(null);
        })
        .catch((e) => {
          if (onDone && !onDone()) return;
          setError(e instanceof Error ? e.message : String(e));
        });
    },
    [includeTrashed]
  );

  const reload = useCallback(() => fetchAndSet(), [fetchAndSet]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setSessions(null);
    setError(null);
    fetchAndSet(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [active, fetchAndSet]);

  return { sessions, error, reload };
}
