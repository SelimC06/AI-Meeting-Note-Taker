import { useEffect, useRef, useState } from "react";
import { checkHealth } from "../api";

export type BackendLifecycleState =
  | { phase: "healthy" }
  // Detected by this hook's own health poll below, independent of any
  // main-process signal -- covers a backend that's hung but hasn't been
  // (or never gets) caught by main.js's watchdog, so the user still has a
  // manual Retry rather than a banner-less "healthy" phase forever.
  | { phase: "unresponsive" }
  | { phase: "starting" }
  | { phase: "restarting"; attempt: number; maxAttempts: number }
  | { phase: "reconnected" }
  | { phase: "failed"; logTail: string };

const HEALTH_POLL_INTERVAL_MS = 3000;
const UNRESPONSIVE_THRESHOLD_MS = 10000;

export function useBackendLifecycle(): BackendLifecycleState {
  const [state, setState] = useState<BackendLifecycleState>({ phase: "healthy" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const firstFailureAtRef = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = window.backendAPI?.onStatus((status: BackendStatus) => {
      if (status.state === "starting") {
        setState({ phase: "starting" });
      } else if (status.state === "restarting") {
        setState({ phase: "restarting", attempt: status.attempt, maxAttempts: status.maxAttempts });
      } else if (status.state === "up") {
        setState({ phase: "reconnected" });
      } else if (status.state === "ready") {
        setState({ phase: "healthy" });
      } else if (status.state === "failed") {
        setState({ phase: "failed", logTail: status.logTail });
      }
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    if (state.phase !== "reconnected") return;
    const timer = setTimeout(() => setState({ phase: "healthy" }), 3000);
    return () => clearTimeout(timer);
  }, [state.phase]);

  // Independent client-side health probe. main.js's watchdog is the primary
  // recovery mechanism for a hung-but-alive backend, but it only reports
  // back through "restarting"/"failed" once it has actually noticed and
  // acted -- this poll gives the Retry button a path to appear even if that
  // hasn't happened yet, without waiting on or depending on it. Only ever
  // acts while phase is "healthy": it must never fight a more specific
  // main-driven phase like "starting" (still within its own normal cold-
  // start window) or "restarting"/"failed" (already showing their own
  // messaging).
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const ok = await checkHealth();
      if (cancelled) return;
      if (ok) {
        firstFailureAtRef.current = null;
        if (stateRef.current.phase === "unresponsive") setState({ phase: "healthy" });
        return;
      }
      if (stateRef.current.phase !== "healthy" && stateRef.current.phase !== "unresponsive") return;
      if (firstFailureAtRef.current === null) firstFailureAtRef.current = Date.now();
      const unreachableForMs = Date.now() - firstFailureAtRef.current;
      if (unreachableForMs >= UNRESPONSIVE_THRESHOLD_MS && stateRef.current.phase === "healthy") {
        setState({ phase: "unresponsive" });
      }
    };

    poll();
    const interval = setInterval(poll, HEALTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return state;
}
