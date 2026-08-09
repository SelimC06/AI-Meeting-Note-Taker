export {};

declare global {
  interface SystemStats {
    cpuPercent: number;
    memPercent: number;
    totalMemBytes: number;
    freeMemBytes: number;
  }

  type BackendStatus =
    | { state: "restarting"; attempt: number; maxAttempts: number }
    | { state: "up" }
    | { state: "failed"; logTail: string };

  type UpdaterStatus =
    | { state: "checking" }
    | { state: "available"; version: string }
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
    // Uploading the just-stopped recording, before the backend has queued
    // a processing job for it. RailApp.tsx's own Record button disables
    // itself for this same window (a toggleRecord click would no-op there
    // anyway) — DockedRail.tsx's remote-control copy needs to know this
    // too, or clicking it silently does nothing with no feedback.
    isProcessing: boolean;
  };

  type RailCommandAction = "toggleRecord" | "pause" | "resume";

  type RailRect = { x: number; y: number; width: number; height: number };

  type RailPopState = { popped: boolean };

  interface Window {
    windowControls?: {
      minimize: () => void;
      close: () => void;
      sendRailCommand: (action: RailCommandAction) => Promise<void>;
      onRailCommand: (callback: (action: RailCommandAction) => void) => () => void;
      pushRailStatus: (status: RailStatus) => Promise<void>;
      onRailStatus: (callback: (status: RailStatus) => void) => () => void;
      beginRailFloatDrag: (slotRect: RailRect) => Promise<void>;
      railFloatDragMove: () => void;
      endRailFloatDrag: () => Promise<void>;
      updateDockSlotRect: (slotRect: RailRect) => void;
      getRailFloating: () => Promise<boolean>;
      onRailFloating: (callback: (floating: boolean) => void) => () => void;
      reattachRail: () => Promise<void>;
      onRailPopState: (callback: (payload: RailPopState) => void) => () => void;
      getVersion: () => Promise<string>;
    };
    electronAPI?: {
      listCaptureSources: (types?: string[]) => Promise<{ id: string; name: string }[]>;
      pickPrimaryScreenId: () => Promise<string | null>;
      setRailErrorVisible: (visible: boolean) => Promise<void>;
    };
    systemAPI?: {
      getStats: () => Promise<SystemStats | null>;
    };
    settingsAPI?: {
      chooseFolder: () => Promise<string | null>;
      openPrivacySettings: (kind: "microphone" | "camera") => Promise<void>;
    };
    backendAPI?: {
      onStatus: (callback: (status: BackendStatus) => void) => () => void;
      restart: () => Promise<void>;
    };
    updaterAPI?: {
      onStatus: (callback: (status: UpdaterStatus) => void) => () => void;
      install: () => Promise<void>;
      getStatus: () => Promise<UpdaterStatus>;
    };
  }
}
