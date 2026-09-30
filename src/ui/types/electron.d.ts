export {};

declare global {
  interface SystemStats {
    cpuPercent: number;
    memPercent: number;
    totalMemBytes: number;
    freeMemBytes: number;
  }

  type BackendStatus =
    // Sent once at launch, before the initial health check resolves --
    // lets BackendStatusBanner render a loading state instead of nothing
    // while the window is shown immediately rather than gated on health.
    | { state: "starting" }
    | { state: "restarting"; attempt: number; maxAttempts: number }
    | { state: "up" }
    // The initial health check (not a crash-triggered recovery) succeeded.
    // Distinct from "up" so the banner doesn't say "reconnected" on a
    // perfectly normal first launch.
    | { state: "ready" }
    | { state: "failed"; logTail: string };

  type UpdaterStatus =
    // Before the very first check has ever run (or reported back) --
    // distinct from "idle" (a completed check that found no update), which
    // used to be the initial/default state too and rendered "You're on the
    // latest version" even though no check had actually happened yet.
    | { state: "not-checked" }
    | { state: "checking" }
    | { state: "available"; version: string }
    // macOS only: a newer version exists but can't be installed in-app
    // (ad-hoc-signed builds; see src/electron/updater.js) -- the user
    // downloads it from `url` instead.
    | { state: "manual"; version: string; url: string }
    | { state: "idle" }
    | { state: "downloading"; percent: number }
    | { state: "ready"; version: string }
    | { state: "error"; message: string };

  type RailPlaybackStatus = "idle" | "starting" | "recording" | "paused";

  type RailStatus = {
    status: RailPlaybackStatus;
    elapsedLabel: string;
    level: number[];
    recordError: string | null;
    // What kind of error recordError is, so the docked pill can offer the
    // same action the rail's own toast does. Optional: statuses from before
    // this field (or a malformed one) just get no action.
    recordErrorKind?: "permission-denied" | "generic" | null;
    // Uploading the just-stopped recording, before the backend has queued
    // a processing job for it. RailApp.tsx's own Record button disables
    // itself for this same window (a toggleRecord click would no-op there
    // anyway) — DockedRail.tsx's remote-control copy needs to know this
    // too, or clicking it silently does nothing with no feedback.
    isProcessing: boolean;
    // True while a previously FAILED upload's FormData/Blobs are still only
    // held in the rail renderer's memory (pendingUploadRef), offered back
    // via the "retry upload" toast action. Status is "idle" and isProcessing
    // is false in this state, so without this flag main.js's close guard
    // can't tell a pending-retry recording apart from one with nothing left
    // to lose (G3).
    hasPendingUpload: boolean;
  };

  // "stopForClose": sent only by main.js's guarded close/quit flow
  // (stopAndSaveRailRecording) -- stops an active recording the same way a
  // manual stop does, but is a safe no-op (acks immediately, doesn't start
  // anything) if the rail is already idle, unlike "toggleRecord".
  // "retryUploadForClose": sent by the pending-upload close dialog's "Retry
  // and wait" choice (retryRailUploadAndWait in main.js) -- re-POSTs the
  // held FormData the same way the toast's own "retry upload" button does.
  type RailCommandAction = "toggleRecord" | "pause" | "resume" | "retryUpload" | "stopForClose" | "retryUploadForClose";

  type RailRect = { x: number; y: number; width: number; height: number };

  type RailPopState = { popped: boolean };

  type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

  interface Window {
    // The port the backend actually bound to -- normally 8000, but a fallback
    // port when that was held by a foreign process (see main.js's
    // resolveBackendPort / ensurePortFree). null outside Electron (e.g. tests).
    // token: the per-launch backend API token, sent on every request as
    // X-DeskRecap-Token (see api.ts's backendFetch).
    BACKEND_CONFIG?: { port: number | null; token?: string | null };
    windowControls?: {
      minimize: () => void;
      close: () => void;
      // Manual resize, driven by ResizeHandles.tsx -- transparent
      // BrowserWindows lose the native resize-by-dragging-the-edge behavior
      // on Windows regardless of `resizable: true`, so this reimplements it.
      beginWindowResize: (direction: ResizeDirection) => Promise<void>;
      windowResizeMove: () => void;
      endWindowResize: () => Promise<void>;
      sendRailCommand: (action: RailCommandAction) => Promise<void>;
      onRailCommand: (callback: (action: RailCommandAction) => void) => () => void;
      pushRailStatus: (status: RailStatus) => Promise<void>;
      // Live level-meter samples (~every 60ms while recording), apart from
      // the throttled status push; the dashboard only receives them while
      // the rail is docked and the dashboard is visible.
      pushRailLevel: (level: number[]) => void;
      onRailLevel: (callback: (level: number[]) => void) => () => void;
      // Acks a stop the main process itself triggered (the close/quit
      // "Stop && Save" dialog) once the upload handoff (or the
      // empty-recording no-op) has finished — see main.js's
      // stopAndSaveRailRecording / rail:stopAndSaveComplete.
      // Carries the rail's pending-upload state as of the ack itself --
      // main.js's cached rail:pushStatus copy lags a re-render behind it.
      notifyStopAndSaveComplete: (payload: { hasPendingUpload: boolean }) => void;
      onRailStatus: (callback: (status: RailStatus) => void) => () => void;
      // Pull side of the pull+push handshake: onRailStatus alone can miss
      // status pushed before a freshly mounted DockedRail's listener is
      // wired up (or simply hasn't arrived yet post-reload), leaving it on
      // DEFAULT_STATUS -- which reads "idle" and enabled -- for up to ~1s.
      // null if the rail hasn't pushed anything yet.
      getRailStatus: () => Promise<RailStatus | null>;
      beginRailFloatDrag: (slotRect: RailRect) => Promise<void>;
      railFloatDragMove: () => void;
      endRailFloatDrag: () => Promise<void>;
      // null explicitly disables the dock slot (sent while the sidebar is
      // collapsed -- its container's rect doesn't change size when the
      // outer wrapper collapses, so there's no geometry-based way for main
      // to detect that on its own).
      updateDockSlotRect: (slotRect: RailRect | null) => void;
      getRailFloating: () => Promise<boolean>;
      onRailFloating: (callback: (floating: boolean) => void) => () => void;
      reattachRail: () => Promise<void>;
      onRailPopState: (callback: (payload: RailPopState) => void) => () => void;
      getVersion: () => Promise<string>;
    };
    electronAPI?: {
      platform: NodeJS.Platform;
      pickPrimaryScreenId: () => Promise<string | null>;
      setRailErrorVisible: (visible: boolean) => Promise<void>;
    };
    systemAPI?: {
      getStats: () => Promise<SystemStats | null>;
    };
    settingsAPI?: {
      chooseFolder: () => Promise<string | null>;
      openPrivacySettings: (kind: "microphone" | "camera" | "screenRecording") => Promise<void>;
    };
    backendAPI?: {
      onStatus: (callback: (status: BackendStatus) => void) => () => void;
      // Pull side of the pull+push handshake: onStatus alone can miss the
      // very first push (sent before the renderer's listener is wired up),
      // so callers fetch the current state once on mount instead of
      // trusting a "healthy" default. null if main hasn't sent any status
      // yet.
      getStatus: () => Promise<BackendStatus | null>;
      restart: () => Promise<void>;
    };
    updaterAPI?: {
      onStatus: (callback: (status: UpdaterStatus) => void) => () => void;
      install: () => Promise<void>;
      getStatus: () => Promise<UpdaterStatus>;
    };
    diagnosticsAPI?: {
      // Fire-and-forget: called from a global window.onerror/unhandledrejection
      // handler, so it can't itself risk throwing or await anything.
      reportRendererError: (payload: { kind: string; message: string; stack?: string }) => void;
      openLogsFolder: () => Promise<void>;
    };
    consentAPI?: {
      // Called from the rail right before a recording starts; resolves
      // false only if the user explicitly declines the one-time notice.
      ensureRecordingConsent: () => Promise<boolean>;
      onShowRecordingNotice: (callback: () => void) => () => void;
      respondToRecordingNotice: (proceed: boolean) => void;
    };
  }
}
