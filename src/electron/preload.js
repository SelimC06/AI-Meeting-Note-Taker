const { contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.invoke('win:minimize'),
  close: () => ipcRenderer.invoke('app:quit'),
  toggleRail: () => ipcRenderer.invoke('rail:toggle'),

  getRailState: () => ipcRenderer.invoke('rail:getState'),
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

  expandRail: async (expanded) => {
    try {
      await ipcRenderer.invoke("rail:setExpanded", expanded);
    } catch (e) {
      console.warn("[preload] expandRail failed:", e);
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