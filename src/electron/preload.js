const { contextBridge, ipcRenderer} = require('electron');

// main.js resolves the backend to a fallback port when the preferred one
// (8000) is held by some other, unrelated process (see resolveBackendPort /
// ensurePortFree) and threads the actual port through as a query param on
// each window's loadFile call -- read it here so the renderer's BACKEND_URL
// (src/ui/api.ts) can point at wherever the backend actually ended up.
const backendPortParam = new URL(location.href).searchParams.get('backendPort');

contextBridge.exposeInMainWorld('BACKEND_CONFIG', {
  port: backendPortParam ? Number(backendPortParam) : null,
});

contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.invoke('win:minimize'),
  close: () => ipcRenderer.invoke('app:quit'),

  sendRailCommand: (action) => ipcRenderer.invoke('rail:command', action),
  onRailCommand: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('rail:command', listener);
    return () => ipcRenderer.removeListener('rail:command', listener);
  },

  pushRailStatus: (status) => ipcRenderer.invoke('rail:pushStatus', status),
  notifyStopAndSaveComplete: () => ipcRenderer.send('rail:stopAndSaveComplete'),
  onRailStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('rail:status', listener);
    return () => ipcRenderer.removeListener('rail:status', listener);
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
  listCaptureSources: async (types = ["screen", "window"]) => {
    try {
      return await ipcRenderer.invoke("list-capture-sources", types);
    } catch (e) {
      console.warn("[preload] listCaptureSources failed:", e);
      return [];
    }
  },

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

  restart: async () => {
    try {
      await ipcRenderer.invoke('backend:restart');
    } catch (e) {
      console.warn("[preload] backend restart failed:", e);
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
      return { state: "idle" };
    }
  },
});