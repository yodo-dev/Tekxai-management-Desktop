const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  getStore:      (key)            => ipcRenderer.invoke('get-store', key),
  setStore:      (key, val)       => ipcRenderer.invoke('set-store', key, val),
  delStore:      (key)            => ipcRenderer.invoke('del-store', key),
  login:         (creds)          => ipcRenderer.invoke('login', creds),
  logout:        ()               => ipcRenderer.invoke('logout'),
  getToday:      ()               => ipcRenderer.invoke('get-today'),
  clockIn:       ()               => ipcRenderer.invoke('clock-in'),
  clockOut:      ()               => ipcRenderer.invoke('clock-out'),
  openDashboard: ()               => ipcRenderer.invoke('open-dashboard'),
  minimizeWindow: ()              => ipcRenderer.invoke('minimize-window'),
  closeWindow:   ()               => ipcRenderer.invoke('close-window'),
  onScreenshot:  (cb)             => ipcRenderer.on('screenshot-taken', cb),
  onSessionExpired: (cb)          => ipcRenderer.on('session-expired', cb),
});
