const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store();
const API_BASE = 'https://api.tekxai.services/api/v1';
const DASHBOARD_URL = 'https://tekxai.services/employee';
const SCREENSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let mainWindow = null;
let tray = null;
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

// ── App ready ─────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  // Keep running in tray on all platforms
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

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, '../assets/tray-icon.png');
  const img = nativeImage.createFromPath(iconPath);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('TekXAI Agent');
  updateTrayMenu();

  tray.on('double-click', () => {
    mainWindow?.show();
  });
}

function updateTrayMenu() {
  const token = store.get('auth_token');
  const user = store.get('user');
  const clocked = store.get('clocked_in', false);

  const menu = Menu.buildFromTemplate([
    { label: user ? `${user.first_name} ${user.last_name}` : 'Not logged in', enabled: false },
    { label: clocked ? '🟢 Clocked In' : '⚫ Not clocked in', enabled: false },
    { type: 'separator' },
    { label: 'Open Agent', click: () => mainWindow?.show() },
    { label: 'Open Dashboard', click: () => shell.openExternal(DASHBOARD_URL) },
    { type: 'separator' },
    ...(token ? [
      { label: clocked ? 'Clock Out' : 'Clock In', click: () => mainWindow?.webContents.send('tray-toggle-clock') },
      { type: 'separator' },
    ] : []),
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-store', (_, key) => store.get(key));
ipcMain.handle('set-store', (_, key, value) => store.set(key, value));
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
  const token = payload.accessToken || payload.access_token || payload.token;
  const user = payload.user;
  store.set('auth_token', token);
  store.set('user', user || payload);
  updateTrayMenu();
  return { user: user || payload };
});

ipcMain.handle('logout', async () => {
  stopScreenshots();
  store.delete('auth_token');
  store.delete('user');
  store.set('clocked_in', false);
  sessionId = null;
  updateTrayMenu();
});

ipcMain.handle('get-today', async () => {
  const token = store.get('auth_token');
  if (!token) return null;
  const axios = require('axios');
  try {
    const res = await axios.get(`${API_BASE}/timesheet/today`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.data.payload;
  } catch (err) {
    throw toIpcSafeError(err);
  }
});

ipcMain.handle('clock-in', async () => {
  const token = store.get('auth_token');
  const axios = require('axios');

  // Start monitoring session
  try {
    const sessRes = await axios.post(`${API_BASE}/monitoring/session/start`, {
      agent_version: app.getVersion(),
      os_platform: process.platform,
    }, { headers: { Authorization: `Bearer ${token}` } });
    sessionId = sessRes.data.payload.id;
  } catch (_) {}

  let entry;
  try {
    const res = await axios.post(`${API_BASE}/timesheet/clock-in`, {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
    entry = res.data.payload;
  } catch (err) {
    if (err.response?.status === 409) {
      // Already clocked in — fetch today's entry and resume
      try {
        const todayRes = await axios.get(`${API_BASE}/timesheet/today`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        entry = todayRes.data.payload?.entry;
      } catch (todayErr) {
        throw toIpcSafeError(todayErr);
      }
    } else {
      throw toIpcSafeError(err);
    }
  }

  store.set('clocked_in', true);
  updateTrayMenu();
  startScreenshots(token);
  startAppUsage(token);
  return entry;
});

ipcMain.handle('clock-out', async () => {
  const token = store.get('auth_token');
  const axios = require('axios');

  stopScreenshots();

  let res;
  try {
    res = await axios.post(`${API_BASE}/timesheet/clock-out`, {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw toIpcSafeError(err);
  }

  // End monitoring session
  if (sessionId) {
    try {
      await axios.post(`${API_BASE}/monitoring/session/${sessionId}/end`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (_) {}
    sessionId = null;
  }

  store.set('clocked_in', false);
  updateTrayMenu();
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
