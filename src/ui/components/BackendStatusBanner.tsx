import React, { useState } from "react";
import { useBackendLifecycle } from "../hooks/useBackendLifecycle";

const BackendStatusBanner: React.FC = () => {
  const state = useBackendLifecycle();
  const [retrying, setRetrying] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

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

  // Recovery gave up (or the first start never became healthy): main.js has
  // stopped its watchdog and waits for backend:restart, so without this the
  // app sat on a dead backend with no way forward short of relaunching --
  // this phase used to render nothing at all. The log tail main.js sends
  // along is what the user (or a bug report) needs to see why.
  if (state.phase === "failed") {
    const retry = async () => {
      setRetrying(true);
      try {
        await window.backendAPI?.restart();
      } finally {
        setRetrying(false);
      }
    };
    return (
      <div role="alert" className={`${baseClasses} flex-wrap bg-panel border-b border-red-500 text-red-400`}>
        <span>The app backend stopped and couldn't be restarted.</span>
        <div className="flex items-center gap-3">
          {state.logTail && (
            <button className="text-dim underline" onClick={() => setShowDetails((v) => !v)}>
              {showDetails ? "Hide details" : "Details"}
            </button>
          )}
          {window.diagnosticsAPI?.openLogsFolder && (
            <button className="text-dim underline" onClick={() => window.diagnosticsAPI?.openLogsFolder()}>
              Open logs
            </button>
          )}
          <button className="text-signal underline disabled:opacity-50" disabled={retrying} onClick={retry}>
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
        {showDetails && state.logTail && (
          <pre className="basis-full max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-dim">
            {state.logTail}
          </pre>
        )}
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

  return null;
};

export default BackendStatusBanner;
