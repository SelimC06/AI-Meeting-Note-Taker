import { useCallback, useEffect, useRef, useState } from "react";
import { getSessions, SESSIONS_INDEX_CORRUPT, type ApiError, type Session } from "../api";

export function useSessions(active: boolean, includeTrashed: boolean) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True when `error` is the backend's damaged-index 503, so the sidebar
  // can offer "recover library" instead of just the message.
  const [indexCorrupt, setIndexCorrupt] = useState(false);
  // Monotonically increasing so an in-flight fetch's response can check
  // "am I still the latest request" and be ignored otherwise. Two rapid
  // reload() calls (or a reload() racing the mount-time fetch) can resolve
  // out of order over the network -- without this, a STALE response
  // (from an earlier request) landing after a newer one could overwrite
  // the list with out-of-date data.
  const requestIdRef = useRef(0);

  const fetchAndSet = useCallback(() => {
    const requestId = ++requestIdRef.current;
    // A new fetch invalidates any previously shown error: without this, the
    // stale mount-time "failed to fetch" (from before the backend was up)
    // stays visible for the whole duration of the reload-on-health fetch,
    // flashing an error at the user right before the list appears.
    setError(null);
    setIndexCorrupt(false);
    getSessions(includeTrashed)
      .then((data) => {
        if (requestId !== requestIdRef.current) return;
        setSessions(includeTrashed ? data.filter((s) => s.trashed_at) : data);
        setError(null);
      })
      .catch((e) => {
        if (requestId !== requestIdRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setIndexCorrupt((e as ApiError | null)?.code === SESSIONS_INDEX_CORRUPT);
      });
  }, [includeTrashed]);

  const reload = useCallback(() => fetchAndSet(), [fetchAndSet]);

  useEffect(() => {
    if (!active) return;
    setSessions(null);
    setError(null);
    setIndexCorrupt(false);
    fetchAndSet();
    return () => {
      // Invalidates any request still in flight from this run (active
      // flipped false, or includeTrashed changed) so its response can
      // never land after this view has moved on.
      requestIdRef.current += 1;
    };
  }, [active, fetchAndSet]);

  return { sessions, error, indexCorrupt, reload };
}
