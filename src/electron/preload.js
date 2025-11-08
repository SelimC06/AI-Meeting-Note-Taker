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
});