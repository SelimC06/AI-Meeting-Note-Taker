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

function mapStatusToPhase(status: BackendStatus): BackendLifecycleState {
  if (status.state === "starting") return { phase: "starting" };
  if (status.state === "restarting") {
    return { phase: "restarting", attempt: status.attempt, maxAttempts: status.maxAttempts };
  }
  if (status.state === "up") return { phase: "reconnected" };
  if (status.state === "ready") return { phase: "healthy" };
  return { phase: "failed", logTail: status.logTail };
}

export function useBackendLifecycle(): BackendLifecycleState {
  const [state, setState] = useState<BackendLifecycleState>({ phase: "healthy" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const firstFailureAtRef = useRef<number | null>(null);
  // Guards the pull (getStatus) below against clobbering a more recent push
  // (onStatus) that arrived first -- the pull's IPC round-trip can resolve
  // after a status event that landed in the meantime.
  const receivedPushRef = useRef(false);

  useEffect(() => {
    const unsubscribe = window.backendAPI?.onStatus((status: BackendStatus) => {
      receivedPushRef.current = true;
      setState(mapStatusToPhase(status));
    });
    return () => unsubscribe?.();
  }, []);

  // Pull side of the pull+push handshake (see backendAPI.getStatus): main.js
  // sends {state:'starting'} synchronously right after creating the window,
  // well before this component mounts and registers the onStatus listener
  // above -- Electron does not buffer webContents.send, so that first push
  // is silently dropped on every single launch, and this hook would
  // otherwise sit on its "healthy" default while the backend is still
  // coming up (showing a live dashboard against a connection-refused
  // backend, or worse, flipping to "unresponsive" and offering a Retry that
  // races/kills a normal cold start). Fetching the current state once on
  // mount closes that gap.
  useEffect(() => {
    let cancelled = false;
    window.backendAPI?.getStatus().then((status) => {
      if (cancelled || receivedPushRef.current || !status) return;
      setState(mapStatusToPhase(status));
    });
    return () => {
      cancelled = true;
    };
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
