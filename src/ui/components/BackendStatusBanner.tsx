import React from "react";
import { useBackendLifecycle } from "../hooks/useBackendLifecycle";

const BackendStatusBanner: React.FC = () => {
  const state = useBackendLifecycle();

  if (state.phase === "healthy") return null;

  const baseClasses =
    "absolute top-0 left-0 right-0 z-50 px-3 py-1.5 text-xs flex items-center justify-between gap-2";

  if (state.phase === "restarting") {
    return (
      <div className={`${baseClasses} bg-panel border-b border-line text-dim`}>
        <span>Backend restarting… (attempt {state.attempt}/{state.maxAttempts})</span>
      </div>
    );
  }

  if (state.phase === "reconnected") {
    return (
      <div className={`${baseClasses} bg-panel border-b border-line text-signal`}>
        <span>Backend reconnected</span>
      </div>
    );
  }

  return (
    <div className={`${baseClasses} bg-panel border-b border-line text-dim`}>
      <span>Backend is not responding. Restart attempts failed.</span>
      <button
        className="text-signal underline"
        onClick={() => window.backendAPI?.restart()}
      >
        Retry
      </button>
    </div>
  );
};

export default BackendStatusBanner;
