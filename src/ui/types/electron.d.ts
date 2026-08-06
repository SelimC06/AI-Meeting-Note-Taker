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

  interface Window {
    windowControls?: {
      minimize: () => void;
      close: () => void;
      toggleRail: () => Promise<boolean>;
      getRailState: () => Promise<boolean>;
      getVersion: () => Promise<string>;
    };
    electronAPI?: {
      listCaptureSources: (types?: string[]) => Promise<{ id: string; name: string }[]>;
      pickPrimaryScreenId: () => Promise<string | null>;
      expandRail: (expanded: boolean) => Promise<void>;
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
