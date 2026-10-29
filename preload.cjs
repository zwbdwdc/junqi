const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('junqiApp', Object.freeze({
  version: () => ipcRenderer.invoke('junqi-app:version'),
}));

contextBridge.exposeInMainWorld('junqiExperience', Object.freeze({
  load: () => ipcRenderer.invoke('junqi-experience:load'),
  review: () => ipcRenderer.invoke('junqi-experience:review'),
  restore: profile => ipcRenderer.invoke('junqi-experience:restore', profile),
  save: profile => ipcRenderer.invoke('junqi-experience:save', profile),
  export: profile => ipcRenderer.invoke('junqi-experience:export', profile),
  import: () => ipcRenderer.invoke('junqi-experience:import'),
}));

contextBridge.exposeInMainWorld('junqiArchive', Object.freeze({
  save: record => ipcRenderer.invoke('junqi-archive:save', record),
  list: () => ipcRenderer.invoke('junqi-archive:list'),
  load: id => ipcRenderer.invoke('junqi-archive:load', id),
}));
