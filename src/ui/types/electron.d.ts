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

  interface Window {
    windowControls?: {
      minimize: () => void;
      close: () => void;
      toggleRail: () => Promise<boolean>;
      getRailState: () => Promise<boolean>;
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
    };
    backendAPI?: {
      onStatus: (callback: (status: BackendStatus) => void) => () => void;
      restart: () => Promise<void>;
    };
  }
}
