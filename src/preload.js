const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  getStore:      (key)            => ipcRenderer.invoke('get-store', key),
  setStore:      (key, val)       => ipcRenderer.invoke('set-store', key, val),
  delStore:      (key)            => ipcRenderer.invoke('del-store', key),
  login:         (creds)          => ipcRenderer.invoke('login', creds),
  logout:        ()               => ipcRenderer.invoke('logout'),
  getToday:      ()               => ipcRenderer.invoke('get-today'),
  clockIn:       ()               => ipcRenderer.invoke('clock-in'),
  clockOut:      (opts)           => ipcRenderer.invoke('clock-out', opts),
  breakStart:    ()               => ipcRenderer.invoke('break-start'),
  breakEnd:      ()               => ipcRenderer.invoke('break-end'),
  openDashboard: ()               => ipcRenderer.invoke('open-dashboard'),
  minimizeWindow: ()              => ipcRenderer.invoke('minimize-window'),
  closeWindow:   ()               => ipcRenderer.invoke('close-window'),
  onScreenshot:  (cb)             => ipcRenderer.on('screenshot-taken', cb),
  onSessionExpired: (cb)          => ipcRenderer.on('session-expired', cb),

  // Desktop auto-update — main.js is the sole source of truth for whether an
  // update exists/is mandatory (via be-work's /desktop/latest-version); this
  // bridge just carries that decision and electron-updater's own download
  // progress into the renderer's UI, and carries the user's "Update Now" /
  // "Restart Now" clicks back.
  startUpdateDownload:  ()        => ipcRenderer.invoke('desktop-update:start-download'),
  restartAndInstall:    ()        => ipcRenderer.invoke('desktop-update:restart-and-install'),
  onUpdateAvailable:    (cb)      => ipcRenderer.on('desktop-update:available', (_e, data) => cb(data)),
  onUpdateProgress:     (cb)      => ipcRenderer.on('desktop-update:progress', (_e, data) => cb(data)),
  onUpdateReady:        (cb)      => ipcRenderer.on('desktop-update:ready', (_e, data) => cb(data)),
  onUpdateError:        (cb)      => ipcRenderer.on('desktop-update:error', (_e, message) => cb(message)),
});
