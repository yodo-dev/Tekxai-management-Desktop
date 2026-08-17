const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
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
// Two deliberately separate layers:
//
//  1. Decision — GET be-work's /desktop/latest-version. This is the ONLY
//     source this app trusts to decide whether an update exists, whether
//     it's mandatory, and what its release notes say. Never GitHub, never a
//     bare comparison against electron-updater's own feed in isolation — the
//     backend is "the update provider" from the app's point of view, full
//     stop, and is what drives the non-blocking indicator / ready-to-install
//     / force-block UI in renderer.js.
//  2. Mechanics — electron-updater, still pointed at the generic (non-GitHub)
//     artifact host configured in electron-builder.config.js's publish.url.
//     It actually downloads, checksum-verifies, and installs the signed
//     binary once step 1 says to — proven, cross-platform code this app has
//     no reason to reimplement. autoDownload stays OFF (this app still
//     explicitly calls checkForUpdates()+downloadUpdate() itself, from
//     startDownload() below, rather than letting electron-updater fire on
//     its own timer) — but unlike earlier revisions, that call is no longer
//     gated on a user clicking "Update Now": checkBackendVersion/
//     reportTelemetry trigger it automatically and silently the moment an
//     update is known to exist (Background Silent Updates — see
//     triggerBackgroundDownload). The employee is never interrupted until
//     the download actually finishes and 'update-downloaded' fires below.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let desktopUpdateInfo = null; // last GET /desktop/latest-version payload, cached for the download/progress/ready IPC round-trip
let forcedUpdatePending = false;
// Set only while a real download is in flight (from "Update Now"/an
// auto-triggered forced update through to success or failure) — this is
// what distinguishes an update-analytics-worthy failure from an ordinary
// background-check failure (network hiccup on the periodic check, no
// download ever attempted). Cleared on success or once a failure's been
// reported, whichever comes first — see reportUpdateFailure.
let updateAttempt = null; // { fromVersion, toVersion } | null

// Same integer-segment comparison as be-work's desktop.controller.js
// compare_versions() — plain string comparison ("1.10.0" >= "1.9.0") is
// wrong for semver, and this app and the backend must agree on the answer.
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function osLabel() {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'linux') return 'Linux';
  return process.platform;
}

// Desktop Diagnostics — everything here is best-effort and platform-
// tolerant: `fs.promises.statfs` (disk) isn't guaranteed on every platform/
// Node build, so its failure is swallowed independently of memory/arch,
// which come from Node's `os` module and are always available. Bytes are
// converted to GB at the source (not left as raw bytes for the backend to
// convert) since GB-as-a-float is literally the only thing this data is
// ever displayed as — see prisma schema's desktop_installations comment.
const BYTES_PER_GB = 1024 ** 3;
async function collectDiagnostics() {
  const diagnostics = {
    arch: process.arch,
    memory_total_gb: +(os.totalmem() / BYTES_PER_GB).toFixed(2),
    memory_free_gb: +(os.freemem() / BYTES_PER_GB).toFixed(2),
  };
  try {
    const fs = require('fs');
    const stats = await fs.promises.statfs(app.getPath('userData'));
    diagnostics.disk_total_gb = +((stats.blocks * stats.bsize) / BYTES_PER_GB).toFixed(2);
    diagnostics.disk_free_gb = +((stats.bavail * stats.bsize) / BYTES_PER_GB).toFixed(2);
  } catch (err) {
    console.error('[diagnostics] disk space unavailable', err.message);
  }
  return diagnostics;
}

// The sole trigger for showing the update dialog or the force-update block
// screen — called at startup and periodically. Silent on any failure
// (network hiccup, backend down): a missed check just means "ask again next
// interval," never a crash or a false "you must update" prompt blocking
// someone's whole day over a transient network blip.
// 'stable' is the only channel this app currently opts into — there's no
// UI to switch (not requested), but the backend already supports 'beta'/
// 'internal'/'development' for whenever that's added. `uid` is the last
// logged-in user's id, if this install has ever logged in — purely for the
// backend's staged-rollout percentage bucketing (§ see be-work's
// desktop.controller.js is_in_rollout), never sent as or treated as an auth
// credential.
const UPDATE_CHANNEL = 'stable';

async function checkBackendVersion() {
  const axios = require('axios');
  try {
    const cachedUser = store.get('user');
    const params = new URLSearchParams({ channel: UPDATE_CHANNEL });
    if (cachedUser?.id) params.set('uid', cachedUser.id);
    const res = await axios.get(`${API_BASE}/desktop/latest-version?${params.toString()}`);
    const info = res.data?.payload;
    if (!info?.latestVersion) return; // no release registered yet — nothing to do
    desktopUpdateInfo = info;
    const current = app.getVersion();
    const isBelowMinimum = !!info.minimumVersion && compareVersions(current, info.minimumVersion) < 0;
    forcedUpdatePending = !!info.forceUpdate || isBelowMinimum;
    if (compareVersions(current, info.latestVersion) >= 0) return; // already current
    // Background Silent Updates: no dialog here, of any kind — mandatory or
    // not. Start the download immediately in the background and let the
    // employee keep working; see triggerBackgroundDownload for the one
    // lightweight, non-blocking signal sent to the renderer while this runs.
    // The first thing that can ever interrupt active work is the "ready to
    // install" prompt once electron-updater's 'update-downloaded' fires.
    triggerBackgroundDownload();
  } catch (err) {
    console.error('[desktop-update] backend version check failed', err.message);
  }
}

// Best-effort — reports this install's current version/OS/platform/device so
// Administration → Desktop Management can see who's outdated. Also the only
// authenticated channel this app has, so an admin's per-employee "Force
// Update" (independent of the release-wide mandatory flag) surfaces here.
async function reportTelemetry() {
  const token = store.get('auth_token');
  if (!token) return;
  const axios = require('axios');
  try {
    const diagnostics = await collectDiagnostics();
    const res = await authRequest((t) => axios.post(`${API_BASE}/desktop/telemetry`, {
      current_version: app.getVersion(),
      os: osLabel(),
      platform: process.platform,
      device: os.hostname(),
      channel: UPDATE_CHANNEL,
      ...diagnostics,
    }, { headers: { Authorization: `Bearer ${t}` } }));
    if (res.data?.payload?.force_update_requested && desktopUpdateInfo?.latestVersion) {
      forcedUpdatePending = true;
      triggerBackgroundDownload();
    }
  } catch (_) {}
}

// If the app was relaunched right after installing an update (see
// update-downloaded below, which stashes the version it just installed),
// confirm to the backend that the new version actually came up successfully
// — this is what populates last_successful_update_at, distinct from
// last_update_check_at.
async function reportUpdateSuccessIfPending() {
  const pendingVersion = store.get('pending_update_version');
  if (!pendingVersion || pendingVersion !== app.getVersion()) return;
  store.delete('pending_update_version');
  const token = store.get('auth_token');
  if (!token) return;
  const axios = require('axios');
  try {
    await authRequest((t) => axios.post(`${API_BASE}/desktop/telemetry/update-success`, {
      version: app.getVersion(),
    }, { headers: { Authorization: `Bearer ${t}` } }));
  } catch (_) {}
}

// Update Analytics' "Failed Updates" — only called for a failure that
// actually happened mid-update (updateAttempt set), never for a routine
// background availability check that simply couldn't reach the backend.
// Best-effort like every other telemetry call here — a failure to *report*
// a failure shouldn't itself throw or block the UI from showing the user
// what went wrong (renderer already gets the raw error via
// desktop-update:error regardless of whether this succeeds).
async function reportUpdateFailure(errorMessage) {
  if (!updateAttempt) return;
  const { fromVersion, toVersion } = updateAttempt;
  updateAttempt = null;
  const token = store.get('auth_token');
  if (!token) return;
  const axios = require('axios');
  try {
    await authRequest((t) => axios.post(`${API_BASE}/desktop/telemetry/update-failure`, {
      from_version: fromVersion,
      to_version: toVersion,
      error_message: String(errorMessage || 'Unknown error').slice(0, 2000),
      os: osLabel(),
    }, { headers: { Authorization: `Bearer ${t}` } }));
  } catch (_) {}
}

// Actual electron-updater mechanics, shared by the silent auto-trigger
// (triggerBackgroundDownload) and the manual retry path (the
// desktop-update:start-download IPC handler, invoked from the renderer's
// "Try Again" link after a failed download). Guarded by updateAttempt so a
// background trigger and a manual retry — or two background triggers firing
// close together from checkBackendVersion/reportTelemetry — never race into
// a double download. Throws on failure; callers decide how to surface that.
async function startDownload() {
  if (updateAttempt) return; // already downloading (or about to)
  if (!desktopUpdateInfo?.latestVersion) return;
  updateAttempt = { fromVersion: app.getVersion(), toVersion: desktopUpdateInfo.latestVersion };
  // The one signal the renderer gets while this runs — a small, non-blocking
  // indicator (see renderer.js renderUpdateIndicator), never the full
  // backdrop. The employee keeps working; nothing here can interrupt them.
  mainWindow?.webContents.send('desktop-update:downloading', {
    version: desktopUpdateInfo.latestVersion,
    mustForce: forcedUpdatePending,
  });
  await autoUpdater.checkForUpdates();
  await autoUpdater.downloadUpdate();
}

// Auto-triggered the moment checkBackendVersion/reportTelemetry learn an
// update exists — silent and best-effort. Never throws: a failed background
// download just reports the failure and lets the renderer's indicator offer
// a manual retry (which goes through the IPC handler below instead).
async function triggerBackgroundDownload() {
  if (!app.isPackaged) return; // no updater wiring in an unpackaged dev run
  try {
    await startDownload();
  } catch (err) {
    console.error('[auto-update] background download failed', err.message);
    reportUpdateFailure(err.message); // no-ops if the 'error' listener already reported it
    mainWindow?.webContents.send('desktop-update:error', err.message);
  }
}

function initAutoUpdater() {
  // electron-updater no-ops (and logs a warning) against an unpackaged dev
  // run — `npm start` never has a real installer to compare against, so
  // skip wiring it up entirely rather than let it throw/spam the console.
  if (!app.isPackaged) return;

  autoUpdater.on('error', (err) => {
    console.error('[auto-update] error', err);
    mainWindow?.webContents.send('desktop-update:error', err.message);
    reportUpdateFailure(err.message); // no-ops if updateAttempt isn't set (a background check, not an in-flight update)
  });
  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('desktop-update:progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateAttempt = null; // succeeded — nothing to report as a failure
    // Stash the version so the next launch (after "Restart Now" or the next
    // natural quit, since autoInstallOnAppQuit is on) can confirm success to
    // the backend — see reportUpdateSuccessIfPending().
    store.set('pending_update_version', info.version);
    mainWindow?.webContents.send('desktop-update:ready', {
      version: info.version,
      mustForce: forcedUpdatePending,
      // Carried through from the last /desktop/latest-version check so the
      // Ready-to-Install card can still show "What's New" now that there's
      // no separate pre-download dialog to show it at.
      releaseNotes: desktopUpdateInfo?.releaseNotes,
    });
  });

  reportUpdateSuccessIfPending();
  checkBackendVersion();
  reportTelemetry();
  // Re-check periodically for a long-lived session — most users never quit
  // this app, so startup-only checks would leave long-running installs (and
  // a mandatory update) stuck indefinitely. Short enough that a force-update
  // reaches an already-open session promptly; long enough not to hammer the
  // backend for what's a cheap GET+POST either way.
  setInterval(() => {
    checkBackendVersion();
    reportTelemetry();
  }, 30 * 60 * 1000); // 30 minutes
}

// ── Crash reporting ───────────────────────────────────────────────────────────
// Self-hosted scaffold — POSTs to be-work's /desktop/crash-reports, the same
// shape a future Sentry/Crashpad/self-hosted-alternative swap-in would need
// (see docs/CRASH_REPORTING.md). `lastKnownAction` is a lightweight, best-
// effort breadcrumb (not a full event log) — updated at a handful of key
// IPC handlers below, enough to answer "what was the employee doing right
// before this," not a general analytics/replay system.
let lastKnownAction = null;

// Every IPC call from the renderer (clock-in, break, login, update actions,
// ...) is a reasonable breadcrumb for crash reporting's last_action — wrap
// ipcMain.handle once here rather than hand-instrumenting each of the
// individual handlers below.
const rawIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => rawIpcHandle(channel, (...args) => {
  lastKnownAction = channel;
  return listener(...args);
});

async function reportCrash(stack_trace) {
  const token = store.get('auth_token');
  if (!token) return; // matches this app's existing telemetry limitation — no unauthenticated channel to report through
  const axios = require('axios');
  try {
    await authRequest((t) => axios.post(`${API_BASE}/desktop/crash-reports`, {
      version: app.getVersion(),
      os: osLabel(),
      stack_trace: String(stack_trace || 'Unknown error').slice(0, 10000),
      last_action: lastKnownAction,
    }, { headers: { Authorization: `Bearer ${t}` } }));
  } catch (_) {}
}

// Main process crashes — these are genuinely fatal to this process, so the
// crash is reported and the app exits deliberately rather than continuing
// in a possibly-corrupt state (the same rationale Node's own docs give for
// not resuming after an uncaughtException).
process.on('uncaughtException', (err) => {
  console.error('[crash] uncaughtException', err);
  reportCrash(err?.stack || err?.message).finally(() => app.exit(1));
});
process.on('unhandledRejection', (reason) => {
  console.error('[crash] unhandledRejection', reason);
  reportCrash(reason?.stack || String(reason));
});

// Renderer crashes (as opposed to main-process crashes above) — the window
// itself survives, so this is reported without exiting the app.
app.on('render-process-gone', (_event, _webContents, details) => {
  console.error('[crash] render-process-gone', details);
  reportCrash(`Renderer process gone: reason=${details?.reason}, exitCode=${details?.exitCode}`);
});

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
    const payload = res.data.payload;

    // Root-cause fix for the "reopens on break after an update" bug:
    // startScreenshots/startAppUsage were previously only ever started from
    // the clock-in and break-end IPC handlers — never from this resync path,
    // which is the ONLY thing that runs on a fresh app launch (including an
    // auto-updater relaunch). So a genuinely-working session that survives
    // an app restart stopped reporting app_usage_logs the moment the old
    // process quit, and never resumed. be-work's auto-checkout job (see
    // auto-checkout.job.js) treats that silence as real idle time and, once
    // idle_timeout_minutes (default 15) elapses with zero fresh activity, it
    // legitimately flips the session to ON_BREAK (break_source: 'IDLE') —
    // the renderer then correctly (and truthfully) shows "On Break" on
    // reopen, because by then it genuinely IS on break per the backend's own
    // records. The bug was never in how break state gets restored (that
    // already treats the backend as authoritative, correctly) — it was that
    // this app silently stopped holding up its end of the activity contract
    // across a restart, which is what caused the backend to (correctly, by
    // its own rules) create that break in the first place.
    //
    // Fix: resync monitoring to match the real backend status every time
    // this resolves, not just on explicit clock-in/break-end. If the entry
    // is open and NOT on break, resume screenshots/app-usage so a restart
    // (update or otherwise) never again produces a silent activity gap long
    // enough to trigger the idle job. If the entry IS on break — including a
    // break that already existed before this restart — leave/put monitoring
    // stopped, exactly like a manual break does; this is what correctly
    // preserves a genuine active break instead of clearing it. Both
    // startScreenshots/startAppUsage and stopScreenshots already start by
    // clearing their own timers, so calling them redundantly here is safe.
    if (payload?.clocked_in && !payload?.clocked_out) {
      const currentToken = store.get('auth_token');
      if (payload.entry?.status === 'ON_BREAK') {
        stopScreenshots();
      } else {
        startScreenshots(currentToken);
        startAppUsage(currentToken);
      }
    } else {
      stopScreenshots();
    }

    return payload;
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

ipcMain.handle('clock-out', async (event, opts) => {
  const axios = require('axios');
  const skip_report_gate = opts?.skip === true;

  // Daily Report gate — the report itself is submitted on the web ERP (not
  // here), so this only checks status before letting checkout complete.
  // Never blocks on its own failure (network hiccup, etc.) — only an
  // explicit "report required and missing" response holds up checkout.
  if (!skip_report_gate) {
    try {
      const status_res = await authRequest((token) => axios.get(`${API_BASE}/timesheet/compliance-status`, {
        headers: { Authorization: `Bearer ${token}` },
      }));
      const status = status_res.data?.payload;
      if (status?.report_required && !status?.report_submitted) {
        const err = new Error('Daily Report required before checkout — submit it on the web dashboard, or choose to skip and submit later.');
        err.is_report_gate = true;
        throw err;
      }
    } catch (err) {
      if (err.is_report_gate) throw err; // re-throw as-is — caught again below and turned into a safe IPC error
      // Any other failure (network, endpoint down) — don't block checkout
      // over a compliance check that couldn't even run.
    }
  }

  stopScreenshots();

  let res;
  try {
    res = await authRequest((token) => axios.post(`${API_BASE}/timesheet/clock-out`, {}, {
      headers: { Authorization: `Bearer ${token}` },
    }));
  } catch (err) {
    // 404 here means the backend has no open session for us to close — most
    // often the auto-checkout job (shift-end grace period) already force-closed
    // it before the user got to click Clock Out. That's not a failed action,
    // it's a stale local state: reconcile the store now so we don't keep
    // reporting "clocked in" after a restart, and end the monitoring session
    // that's still open locally.
    if (err.response?.status === 404) {
      store.set('clocked_in', false);
      if (sessionId) {
        try {
          await authRequest((token) => axios.post(`${API_BASE}/monitoring/session/${sessionId}/end`, {}, {
            headers: { Authorization: `Bearer ${token}` },
          }));
        } catch (_) {}
        sessionId = null;
      }
    }
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

// Manual equivalent of the auto-checkout job's idle-triggered ON_BREAK flip
// (be-work scheduler/jobs/auto-checkout.job.js) — same backend status, just
// user-initiated instead of idle-triggered. Screenshot/app-usage capture is
// paused for the same reason the job pauses it on idle: nothing worth
// recording while the user has stepped away on purpose.
ipcMain.handle('break-start', async () => {
  const axios = require('axios');
  try {
    const res = await authRequest((token) => axios.post(`${API_BASE}/timesheet/break/start`, {}, {
      headers: { Authorization: `Bearer ${token}` },
    }));
    stopScreenshots();
    return res.data.payload;
  } catch (err) {
    throw toIpcSafeError(err);
  }
});

ipcMain.handle('break-end', async () => {
  const axios = require('axios');
  try {
    const res = await authRequest((token) => axios.post(`${API_BASE}/timesheet/break/end`, {}, {
      headers: { Authorization: `Bearer ${token}` },
    }));
    const currentToken = store.get('auth_token');
    startScreenshots(currentToken);
    startAppUsage(currentToken);
    return res.data.payload;
  } catch (err) {
    throw toIpcSafeError(err);
  }
});

ipcMain.handle('open-dashboard', () => {
  shell.openExternal(DASHBOARD_URL);
});

// ── Desktop update IPC ───────────────────────────────────────────────────────

// Manual retry only — every normal update is started automatically by
// triggerBackgroundDownload the moment one is known to exist (see
// checkBackendVersion/reportTelemetry). This handler exists for the
// renderer's "Try Again" link after a background download failed
// (updateAttempt was cleared by that failure, so startDownload() proceeds
// rather than no-opping). Confirms electron-updater's own feed also has
// this version (it independently verifies against the artifact host's
// manifest/checksums; our backend's /desktop/latest-version is the
// decision, this is the actual secure mechanics).
ipcMain.handle('desktop-update:start-download', async () => {
  if (!app.isPackaged) throw new Error('Updates are only available in the installed app, not this dev build.');
  try {
    await startDownload();
  } catch (err) {
    // May already have been reported by the 'error' event listener above if
    // electron-updater emitted one for this same failure — reportUpdateFailure
    // no-ops on a second call since it clears updateAttempt on the first.
    reportUpdateFailure(err.message);
    throw toIpcSafeError(err);
  }
});

ipcMain.handle('desktop-update:restart-and-install', () => {
  autoUpdater.quitAndInstall();
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
