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
let sessionId = null;

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
  const res = await axios.post(`${API_BASE}/auth/login`, { email, password });
  const { access_token, user } = res.data.payload;
  store.set('auth_token', access_token);
  store.set('user', user);
  updateTrayMenu();
  return { user };
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
  const res = await axios.get(`${API_BASE}/timesheet/today`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data.payload;
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

  const res = await axios.post(`${API_BASE}/timesheet/clock-in`, {}, {
    headers: { Authorization: `Bearer ${token}` },
  });

  store.set('clocked_in', true);
  updateTrayMenu();
  startScreenshots(token);
  return res.data.payload;
});

ipcMain.handle('clock-out', async () => {
  const token = store.get('auth_token');
  const axios = require('axios');

  stopScreenshots();

  const res = await axios.post(`${API_BASE}/timesheet/clock-out`, {}, {
    headers: { Authorization: `Bearer ${token}` },
  });

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

function startScreenshots(token) {
  stopScreenshots();
  takeScreenshot(token); // immediate first capture
  screenshotTimer = setInterval(() => takeScreenshot(token), SCREENSHOT_INTERVAL_MS);
}

function stopScreenshots() {
  if (screenshotTimer) { clearInterval(screenshotTimer); screenshotTimer = null; }
}

async function takeScreenshot(token) {
  if (!sessionId) return;
  try {
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
