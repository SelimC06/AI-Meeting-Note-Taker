const { contextBridge, ipcRenderer} = require('electron');

// main.js resolves the backend to a fallback port when the preferred one
// (8000) is held by some other, unrelated process (see resolveBackendPort /
// ensurePortFree) and threads the actual port through as a query param on
// each window's loadFile call -- read it here so the renderer's BACKEND_URL
// (src/ui/api.ts) can point at wherever the backend actually ended up.
const backendPortParam = new URL(location.href).searchParams.get('backendPort');

// The per-launch backend token (see backend.js's generateBackendToken) --
// every request the renderer makes must send it, or the backend answers
// 401. Fetched synchronously so it's in place before api.ts first reads
// BACKEND_CONFIG; main.js only answers this for its own windows.
let backendToken = null;
try {
  backendToken = ipcRenderer.sendSync('backend:getToken');
} catch (e) {
  console.warn("[preload] backend getToken failed:", e);
}

contextBridge.exposeInMainWorld('BACKEND_CONFIG', {
  port: backendPortParam ? Number(backendPortParam) : null,
  token: backendToken,
});

contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.invoke('win:minimize'),
  close: () => ipcRenderer.invoke('app:quit'),

  beginWindowResize: (direction) => ipcRenderer.invoke('window:beginResize', direction),
  windowResizeMove: () => ipcRenderer.send('window:resizeMove'),
  endWindowResize: () => ipcRenderer.invoke('window:endResize'),

  sendRailCommand: (action) => ipcRenderer.invoke('rail:command', action),
  onRailCommand: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('rail:command', listener);
    return () => ipcRenderer.removeListener('rail:command', listener);
  },

  pushRailStatus: (status) => ipcRenderer.invoke('rail:pushStatus', status),
  // { hasPendingUpload } rides along with the ack -- main.js trusts it over
  // its cached rail:pushStatus copy, which lags a re-render behind.
  notifyStopAndSaveComplete: (payload) => ipcRenderer.send('rail:stopAndSaveComplete', payload),
  onRailStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('rail:status', listener);
    return () => ipcRenderer.removeListener('rail:status', listener);
  },
  getRailStatus: async () => {
    try {
      return await ipcRenderer.invoke('rail:getStatus');
    } catch (e) {
      console.warn("[preload] getRailStatus failed:", e);
      return null;
    }
  },

  beginRailFloatDrag: (slotRect) => ipcRenderer.invoke('rail:beginFloatDrag', slotRect),
  railFloatDragMove: () => ipcRenderer.send('rail:dragMove'),
  endRailFloatDrag: () => ipcRenderer.invoke('rail:endFloatDrag'),
  updateDockSlotRect: (slotRect) => ipcRenderer.send('rail:updateDockSlotRect', slotRect),
  getRailFloating: () => ipcRenderer.invoke('rail:getFloating'),
  onRailFloating: (callback) => {
    const listener = (_event, floating) => callback(floating);
    ipcRenderer.on('rail:floatingChanged', listener);
    return () => ipcRenderer.removeListener('rail:floatingChanged', listener);
  },

  reattachRail: () => ipcRenderer.invoke('rail:reattach'),
  onRailPopState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('rail:popState', listener);
    return () => ipcRenderer.removeListener('rail:popState', listener);
  },

  getVersion: async () => {
    try {
      return await ipcRenderer.invoke('app:getVersion');
    } catch (e) {
      console.warn("[preload] getVersion failed:", e);
      return null;
    }
  },
});

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,

  pickPrimaryScreenId: async () => {
    const list = await ipcRenderer.invoke("list-capture-sources", ["screen"]);
    return list[0]?.id ?? null;
  },

  setRailErrorVisible: async (visible) => {
    try {
      await ipcRenderer.invoke("rail:setErrorVisible", visible);
    } catch (e) {
      console.warn("[preload] setRailErrorVisible failed:", e);
    }
  },
});

contextBridge.exposeInMainWorld("systemAPI", {
  getStats: async () => {
    try {
      return await ipcRenderer.invoke("system:getStats");
    } catch (e) {
      console.warn("[preload] getStats failed:", e);
      return null;
    }
  },
});

contextBridge.exposeInMainWorld("settingsAPI", {
  chooseFolder: async () => {
    try {
      return await ipcRenderer.invoke('dialog:chooseFolder');
    } catch (e) {
      console.warn("[preload] chooseFolder failed:", e);
      return null;
    }
  },

  openPrivacySettings: async (kind) => {
    try {
      await ipcRenderer.invoke('shell:openPrivacySettings', kind);
    } catch (e) {
      console.warn("[preload] openPrivacySettings failed:", e);
    }
  },
});

contextBridge.exposeInMainWorld("backendAPI", {
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('backend:status', listener);
    return () => ipcRenderer.removeListener('backend:status', listener);
  },

  getStatus: async () => {
    try {
      return await ipcRenderer.invoke('backend:getStatus');
    } catch (e) {
      console.warn("[preload] backend getStatus failed:", e);
      return null;
    }
  },

  restart: async () => {
    try {
      await ipcRenderer.invoke('backend:restart');
    } catch (e) {
      console.warn("[preload] backend restart failed:", e);
    }
  },
});

contextBridge.exposeInMainWorld("consentAPI", {
  // Called from the rail (RailApp.tsx) right before a recording actually
  // starts. Resolves true immediately after the first time it's ever been
  // confirmed; the very first call instead waits on the dashboard window
  // (see onShowRecordingNotice/respondToRecordingNotice below) for a
  // response, which is what this Promise is actually waiting on.
  ensureRecordingConsent: async () => {
    try {
      return await ipcRenderer.invoke('consent:ensureRecordingConsent');
    } catch (e) {
      console.warn("[preload] ensureRecordingConsent failed:", e);
      return true;
    }
  },

  // Dashboard-window side of the same flow: shown once, ever.
  onShowRecordingNotice: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('consent:showRecordingNotice', listener);
    return () => ipcRenderer.removeListener('consent:showRecordingNotice', listener);
  },
  respondToRecordingNotice: (proceed) => {
    ipcRenderer.send('consent:recordingNoticeResponse', proceed);
  },
});

contextBridge.exposeInMainWorld("diagnosticsAPI", {
  reportRendererError: (payload) => {
    try {
      ipcRenderer.send('diagnostics:reportRendererError', payload);
    } catch (e) {
      console.warn("[preload] reportRendererError failed:", e);
    }
  },

  openLogsFolder: async () => {
    try {
      await ipcRenderer.invoke('diagnostics:openLogsFolder');
    } catch (e) {
      console.warn("[preload] openLogsFolder failed:", e);
    }
  },
});

contextBridge.exposeInMainWorld("updaterAPI", {
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },

  install: async () => {
    try {
      await ipcRenderer.invoke('updater:install');
    } catch (e) {
      console.warn("[preload] updater install failed:", e);
    }
  },

  getStatus: async () => {
    try {
      return await ipcRenderer.invoke('updater:getStatus');
    } catch (e) {
      console.warn("[preload] updater getStatus failed:", e);
      return { state: "not-checked" };
    }
  },
});