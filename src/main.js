const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

// Without this lock, launching the app while it's already running (e.g. from
// the Start Menu shortcut, or the installer's "run after finish" option)
// spawns a whole second Electron process instead of focusing the existing
// one — each with its own screenshot/tracking timers, and on Windows each
// holding its own lock on the installed files. That second condition is
// exactly what surfaces as the installer's "TEKxAI Agent cannot be closed"
// prompt during an upgrade: some process still has the exe/DLLs open.
// Second launches now just focus the original window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

const store = new Store();
const API_BASE = 'https://api.tekxai.services/api/v1';
const DASHBOARD_URL = 'https://tekxai.services/employee';
const SCREENSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Update feed: see package.json "build.publish" (generic provider). Every
// installed app checks this URL on startup and every 4 hours; a matching
// installer + latest.yml/latest-mac.yml must be uploaded there on release
// (electron-builder's --publish flag does this automatically given AWS/
// generic-server credentials on the build machine — see release docs).
let updateStatus = 'idle'; // idle | checking | available | downloading | ready | none | error


let mainWindow = null;
let screenshotTimer = null;
let appUsageTimer = null;
let sessionId = null;

// App usage tracking state
let lastAppName = null;
let lastWindowTitle = null;
let lastAppStart = null;

// Electron's ipcRenderer.invoke strips custom properties (like AxiosError.response)
// off any Error that crosses the main->renderer boundary, leaving only a generic
// "Error invoking remote method '...'": <err.toString()> string in the renderer.
// Extract the backend's real message here, in the main process, while
// err.response.data.message is still available, and throw a plain Error carrying
// just that string so it survives IPC serialization intact.
function toIpcSafeError(err) {
  const backendMessage = err?.response?.data?.message;
  return new Error(backendMessage || err?.message || 'Request failed');
}

// JWT_EXPIRES_IN is 15 minutes server-side, so every authenticated call needs
// a way to recover once the access token expires mid-session. Every call is
// wrapped in authRequest() below, which retries once via POST /auth/refresh
// on a 401 before giving up.
async function performTokenRefresh() {
  const refresh_token = store.get('refresh_token');
  if (!refresh_token) throw new Error('No refresh token available');

  const axios = require('axios');
  const res = await axios.post(`${API_BASE}/auth/refresh`, { refresh_token });
  const payload = res.data?.payload || res.data?.data;
  const newAccessToken = payload?.accessToken || payload?.access_token;
  // /auth/refresh rotates the refresh token (the old one is revoked server-side
  // the moment a new one is issued) — the new one must be persisted or the
  // *next* refresh attempt will fail against an already-revoked token.
  const newRefreshToken = payload?.refreshToken || payload?.refresh_token;
  if (!newAccessToken) throw new Error('Refresh response missing access token');

  store.set('auth_token', newAccessToken);
  if (newRefreshToken) store.set('refresh_token', newRefreshToken);
  return newAccessToken;
}

// Wraps an authenticated request: on a 401, refreshes the access token once
// and retries the exact same request with it. If the refresh token itself is
// also invalid/expired/revoked, clears the session and tells the renderer to
// fall back to the login screen, rather than leaving a "logged in" UI up
// against a session that no longer exists.
async function authRequest(requestFn) {
  const token = store.get('auth_token');
  try {
    return await requestFn(token);
  } catch (err) {
    if (err?.response?.status !== 401) throw err;
    let refreshedToken;
    try {
      refreshedToken = await performTokenRefresh();
    } catch (_) {
      store.delete('auth_token');
      store.delete('refresh_token');
      store.delete('user');
      mainWindow?.webContents.send('session-expired');
      throw err; // surface the original 401, not the refresh failure
    }
    return await requestFn(refreshedToken);
  }
}

// ── Auto-update ───────────────────────────────────────────────────────────────

// autoDownload: fetch the update in the background as soon as one is found,
// so it's ready the moment the user is willing to restart — matches how
// most desktop apps (Slack, VS Code, etc.) behave, no extra click required
// to start the download.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function initAutoUpdater() {
  // electron-updater no-ops (and logs a warning) against an unpackaged dev
  // run — `npm start` never has a real installer to compare against, so
  // skip wiring it up entirely rather than let it throw/spam the console.
  if (!app.isPackaged) return;

  autoUpdater.on('checking-for-update', () => { updateStatus = 'checking'; });
  autoUpdater.on('update-available', () => { updateStatus = 'available'; });
  autoUpdater.on('update-not-available', () => { updateStatus = 'none'; });
  autoUpdater.on('error', (err) => {
    updateStatus = 'error';
    console.error('[auto-update] error', err);
  });
  autoUpdater.on('download-progress', () => { updateStatus = 'downloading'; });
  autoUpdater.on('update-downloaded', (info) => {
    updateStatus = 'ready';
    // A silent background download is fine, but installing must never
    // happen without the user's say-so — they may be mid clock-in/out or
    // mid-screenshot-capture. Ask, and only quitAndInstall() on "Restart Now".
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Ready',
      message: `TEKxAI Agent ${info.version} has been downloaded.`,
      detail: 'Restart now to apply the update, or it will install automatically the next time you quit the app.',
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.checkForUpdates().catch((err) => console.error('[auto-update] initial check failed', err));
  // Re-check periodically for a long-lived session — most users never quit
  // this app, so startup-only checks would leave long-running installs
  // stuck on old versions indefinitely.
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[auto-update] periodic check failed', err));
  }, 4 * 60 * 60 * 1000); // 4 hours
}

// ── App ready ─────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  initAutoUpdater();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else showMainWindow(); });
});

// No more tray icon to keep the process alive invisibly — closing the
// window now means what it means in any normal desktop app: quit. macOS is
// the one platform-standard exception (apps conventionally stay in the dock
// with no open windows; `activate` above reopens one on a dock-icon click).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  stopScreenshots();
  if (sessionId) {
    const token = store.get('auth_token');
    if (token) {
      try {
        const axios = require('axios');
        await axios.post(`${API_BASE}/monitoring/session/${sessionId}/end`, {}, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (_) {}
    }
  }
});

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 620,
    resizable: false,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../assets/icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

// mainWindow can be destroyed (not just hidden/minimized) in edge cases a
// plain `mainWindow?.show()` doesn't catch — e.g. Windows session-ending
// events — and calling any method on a destroyed BrowserWindow throws
// "Object has been destroyed". Recreate rather than crash.
function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-store', (_, key) => store.get(key));
ipcMain.handle('set-store', (_, key, value) => store.set(key, value));
ipcMain.handle('minimize-window', () => mainWindow?.minimize());
ipcMain.handle('close-window', () => app.quit());
ipcMain.handle('del-store', (_, key) => store.delete(key));

ipcMain.handle('login', async (_, { email, password }) => {
  const axios = require('axios');
  let res;
  try {
    res = await axios.post(`${API_BASE}/auth/login`, { email, password });
  } catch (err) {
    throw toIpcSafeError(err);
  }
  if (!res.data?.success || (!res.data?.payload && !res.data?.data)) {
    throw new Error(res.data?.message || 'Login failed');
  }
  const payload = res.data.payload || res.data.data;
  // A 2FA-enabled account gets a challenge response ({requires_2fa, user_id})
  // instead of tokens — this app has no OTP-entry UI to complete that
  // challenge, so surface a clear error now rather than silently storing an
  // undefined token and letting the renderer show a "logged in" dashboard
  // against a session that was never actually established.
  if (payload.requires_2fa) {
    throw new Error('This account has two-factor authentication enabled, which the desktop app does not yet support. Please sign in from the web dashboard instead.');
  }
  const token = payload.accessToken || payload.access_token || payload.token;
  const refreshToken = payload.refreshToken || payload.refresh_token;
  const user = payload.user;
  if (!token) throw new Error('Login response did not include an access token.');
  store.set('auth_token', token);
  if (refreshToken) store.set('refresh_token', refreshToken);
  store.set('user', user || payload);
  return { user: user || payload };
});

ipcMain.handle('logout', async () => {
  stopScreenshots();
  store.delete('auth_token');
  store.delete('refresh_token');
  store.delete('user');
  store.set('clocked_in', false);
  sessionId = null;
});

ipcMain.handle('get-today', async () => {
  if (!store.get('auth_token')) return null;
  const axios = require('axios');
  try {
    const res = await authRequest((token) => axios.get(`${API_BASE}/timesheet/today`, {
      headers: { Authorization: `Bearer ${token}` },
    }));
    return res.data.payload;
  } catch (err) {
    throw toIpcSafeError(err);
  }
});

ipcMain.handle('clock-in', async () => {
  const axios = require('axios');

  // Start monitoring session
  try {
    await authRequest(async (token) => {
      const sessRes = await axios.post(`${API_BASE}/monitoring/session/start`, {
        agent_version: app.getVersion(),
        os_platform: process.platform,
      }, { headers: { Authorization: `Bearer ${token}` } });
      sessionId = sessRes.data.payload.id;
    });
  } catch (_) {}

  let entry;
  try {
    const res = await authRequest((token) => axios.post(`${API_BASE}/timesheet/clock-in`, {}, {
      headers: { Authorization: `Bearer ${token}` },
    }));
    entry = res.data.payload;
  } catch (err) {
    if (err.response?.status === 409) {
      // Already clocked in — fetch today's entry and resume
      try {
        const todayRes = await authRequest((token) => axios.get(`${API_BASE}/timesheet/today`, {
          headers: { Authorization: `Bearer ${token}` },
        }));
        entry = todayRes.data.payload?.entry;
      } catch (todayErr) {
        throw toIpcSafeError(todayErr);
      }
    } else {
      throw toIpcSafeError(err);
    }
  }

  // The raw POST /timesheet/clock-in response is just the brand-new entry
  // row — it has no idea whether the user already worked earlier sessions
  // today. Fetch /timesheet/today right after (same call the 409 branch
  // above already makes) so the renderer always gets prior_seconds and can
  // resume the daily total instead of restarting the timer from zero. This
  // is a display-only merge — the backend's timesheet_entries rows (the
  // real source of truth) are untouched.
  try {
    const todayRes = await authRequest((token) => axios.get(`${API_BASE}/timesheet/today`, {
      headers: { Authorization: `Bearer ${token}` },
    }));
    const prior_seconds = todayRes.data.payload?.entry?.prior_seconds;
    if (typeof prior_seconds === 'number') entry = { ...entry, prior_seconds };
  } catch (_) {}

  store.set('clocked_in', true);
  // Re-read from store rather than reusing a captured variable — authRequest()
  // above may have refreshed the access token mid-call, and the timers below
  // need the current one, not whatever was valid when clock-in started.
  const currentToken = store.get('auth_token');
  startScreenshots(currentToken);
  startAppUsage(currentToken);
  return entry;
});

ipcMain.handle('clock-out', async () => {
  const axios = require('axios');

  stopScreenshots();

  let res;
  try {
    res = await authRequest((token) => axios.post(`${API_BASE}/timesheet/clock-out`, {}, {
      headers: { Authorization: `Bearer ${token}` },
    }));
  } catch (err) {
    throw toIpcSafeError(err);
  }

  // End monitoring session
  if (sessionId) {
    try {
      await authRequest((token) => axios.post(`${API_BASE}/monitoring/session/${sessionId}/end`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      }));
    } catch (_) {}
    sessionId = null;
  }

  store.set('clocked_in', false);
  return res.data.payload;
});

ipcMain.handle('open-dashboard', () => {
  shell.openExternal(DASHBOARD_URL);
});

// ── Screenshot capture ────────────────────────────────────────────────────────

async function startScreenshots(token) {
  stopScreenshots();
  let intervalMs = SCREENSHOT_INTERVAL_MS;
  try {
    const axios = require('axios');
    const res = await axios.get(`${API_BASE}/settings/system/public`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const minutes = Number(res.data?.payload?.screenshot_interval_minutes);
    if (minutes && minutes > 0) intervalMs = minutes * 60 * 1000;
  } catch (_) {}
  takeScreenshot(token);
  screenshotTimer = setInterval(() => takeScreenshot(token), intervalMs);
}

function stopScreenshots() {
  if (screenshotTimer) { clearInterval(screenshotTimer); screenshotTimer = null; }
  stopAppUsage();
}

// ── App usage tracking ────────────────────────────────────────────────────────

async function startAppUsage(token) {
  stopAppUsage();
  lastAppName = null;
  lastWindowTitle = null;
  lastAppStart = Date.now();
  appUsageTimer = setInterval(() => pollAppUsage(token), 10_000); // poll every 10s
}

function stopAppUsage() {
  if (appUsageTimer) { clearInterval(appUsageTimer); appUsageTimer = null; }
}

async function pollAppUsage(token) {
  if (!sessionId) return;
  try {
    const activeWin = require('active-win');
    const win = await activeWin();
    if (!win) return;

    const appName = win.owner?.name || win.title || 'Unknown';
    const windowTitle = win.title || '';
    const url = win.url || null; // populated for browsers via active-win

    const now = Date.now();

    // If same app/window, just accumulate — don't log yet
    if (appName === lastAppName && windowTitle === lastWindowTitle) return;

    // App switched — log the previous one
    if (lastAppName && lastAppStart) {
      const duration = Math.round((now - lastAppStart) / 1000);
      if (duration >= 5) { // ignore blips under 5s
        const axios = require('axios');
        await axios.post(`${API_BASE}/monitoring/app-usage`, {
          session_id: sessionId,
          app_name: lastAppName,
          window_title: lastWindowTitle,
          url: null,
          duration_seconds: duration,
          captured_at: new Date(lastAppStart).toISOString(),
        }, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
      }
    }

    lastAppName = appName;
    lastWindowTitle = windowTitle;
    lastAppStart = now;
  } catch (_) {}
}

async function takeScreenshot(token) {
  try {
    // Try to recover sessionId if missing
    if (!sessionId) {
      const axios = require('axios');
      try {
        const sessRes = await axios.post(`${API_BASE}/monitoring/session/start`, {
          agent_version: app.getVersion(),
          os_platform: process.platform,
        }, { headers: { Authorization: `Bearer ${token}` } });
        sessionId = sessRes.data?.payload?.id;
      } catch (_) {}
    }

    const screenshot = require('screenshot-desktop');
    const axios = require('axios');

    const img = await screenshot({ format: 'png' });
    const key = `screenshots/${store.get('user')?.id || 'unknown'}/${Date.now()}.png`;

    // Get presigned upload URL from backend
    const fileName = `${Date.now()}.png`;
    let fileKey = key;
    let fileUrl = null;

    try {
      const presignRes = await axios.post(`${API_BASE}/storage/presign`, {
        file_name: fileName,
        mime_type: 'image/png',
        entity_type: 'screenshot',
      }, { headers: { Authorization: `Bearer ${token}` } });

      const uploadUrl = presignRes.data?.payload?.upload_url;
      fileKey = presignRes.data?.payload?.file_key || key;

      if (uploadUrl && !uploadUrl.includes('localhost')) {
        await axios.put(uploadUrl, img, { headers: { 'Content-Type': 'image/png' } });
        fileUrl = uploadUrl.split('?')[0];
      }
    } catch (_) {}

    // Record in backend (with or without S3 URL)
    await axios.post(`${API_BASE}/monitoring/screenshot`, {
      session_id: sessionId,
      file_key: fileKey,
      file_url: fileUrl || `data:image/png;base64,${img.toString('base64').slice(0, 100)}`,
      captured_at: new Date().toISOString(),
    }, { headers: { Authorization: `Bearer ${token}` } });

    mainWindow?.webContents.send('screenshot-taken');
  } catch (err) {
    console.error('[screenshot]', err.message);
  }
}
