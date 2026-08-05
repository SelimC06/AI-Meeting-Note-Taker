import { useEffect, useState } from "react";

export type BackendLifecycleState =
  | { phase: "healthy" }
  | { phase: "restarting"; attempt: number; maxAttempts: number }
  | { phase: "reconnected" }
  | { phase: "failed"; logTail: string };

export function useBackendLifecycle(): BackendLifecycleState {
  const [state, setState] = useState<BackendLifecycleState>({ phase: "healthy" });

  useEffect(() => {
    const unsubscribe = window.backendAPI?.onStatus((status: BackendStatus) => {
      if (status.state === "restarting") {
        setState({ phase: "restarting", attempt: status.attempt, maxAttempts: status.maxAttempts });
      } else if (status.state === "up") {
        setState({ phase: "reconnected" });
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

  return state;
}
