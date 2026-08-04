export {};

declare global {
  interface SystemStats {
    cpuPercent: number;
    memPercent: number;
    totalMemBytes: number;
    freeMemBytes: number;
  }

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
    };
    systemAPI?: {
      getStats: () => Promise<SystemStats | null>;
    };
    settingsAPI?: {
      chooseFolder: () => Promise<string | null>;
    };
  }
}
