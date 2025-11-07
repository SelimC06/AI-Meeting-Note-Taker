const { contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.invoke('win:minimize'),
  close: () => ipcRenderer.invoke('app:quit'),
  toggleRail: () => ipcRenderer.invoke('rail:toggle'),

  getRailState: () => ipcRenderer.invoke('rail:getState'),
});