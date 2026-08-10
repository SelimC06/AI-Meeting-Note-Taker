import React from "react";
import { useBackendLifecycle } from "../hooks/useBackendLifecycle";

const BackendStatusBanner: React.FC = () => {
  const state = useBackendLifecycle();

  // "starting" intentionally renders nothing: Sidebar/Chat already show
  // their own loading states during startup, so a banner on top of them was
  // redundant noise on every launch. The banner only appears for states
  // that need the user's attention (unresponsive/restarting/failed).
  if (state.phase === "healthy" || state.phase === "starting") return null;

  const baseClasses =
    "absolute top-0 left-0 right-0 z-50 px-3 py-1.5 text-xs flex items-center justify-between gap-2";

  if (state.phase === "unresponsive") {
    return (
      <div className={`${baseClasses} bg-panel border-b border-line text-dim`}>
        <span>Backend is not responding.</span>
        <button
          className="text-signal underline"
          onClick={() => window.backendAPI?.restart()}
        >
          Retry
        </button>
      </div>
    );
  }

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
