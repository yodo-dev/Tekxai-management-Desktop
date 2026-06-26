// ── State ─────────────────────────────────────────────────────────────────────

let clockedIn = false;
let clockedOut = false;
let startEpoch = 0;
let tickInterval = null;
let screenshotCount = 0;

// ── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  const token = await window.agent.getStore('auth_token');
  const user  = await window.agent.getStore('user');

  if (token && user) {
    showDashboard(user);
    await refreshToday();
  }

  // Tray triggered clock toggle
  window.agent.onToggleClock(() => {
    if (clockedIn) doClock('out');
    else doClock('in');
  });

  // Screenshot pulse
  window.agent.onScreenshot(() => {
    screenshotCount++;
    const dot = document.getElementById('ss-dot');
    dot.classList.add('active');
    document.getElementById('ss-count').textContent = `${screenshotCount} captured`;
    setTimeout(() => dot.classList.add('active'), 0); // keep active while clocked in
  });
})();

// ── Login ─────────────────────────────────────────────────────────────────────

async function doLogin() {
  const email    = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const btn      = document.getElementById('login-btn');
  const errEl    = document.getElementById('login-error');

  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Email and password are required.'; return; }

  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const { user } = await window.agent.login({ email, password });
    showDashboard(user);
    await refreshToday();
  } catch (e) {
    errEl.textContent = e?.response?.data?.message || e?.message || 'Login failed.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const active = document.querySelector('.screen.active');
    if (active?.id === 'login-screen') doLogin();
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────

async function doLogout() {
  stopTick();
  await window.agent.logout();
  clockedIn = false; clockedOut = false; startEpoch = 0; screenshotCount = 0;
  document.getElementById('login-screen').classList.add('active');
  document.getElementById('dashboard-screen').classList.remove('active');
  document.getElementById('email').value = '';
  document.getElementById('password').value = '';
}

// ── Show dashboard ────────────────────────────────────────────────────────────

function showDashboard(user) {
  const initials = ((user.first_name?.[0] || '') + (user.last_name?.[0] || '')).toUpperCase() || '?';
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-name').textContent   = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  document.getElementById('user-role').textContent   = user.role_name?.replace(/_/g, ' ') || user.email;

  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('dashboard-screen').classList.add('active');
}

// ── Restore today's session ───────────────────────────────────────────────────

async function refreshToday() {
  try {
    const data = await window.agent.getToday();
    if (!data) return;

    if (data.clocked_in && !data.clocked_out) {
      // Active session — restore elapsed time
      const checkIn = new Date(data.entry.check_in).getTime();
      startEpoch = checkIn;
      clockedIn = true; clockedOut = false;
      setTrackerUI('active');
      startTick();
      setSsIndicator(true);

      const checkinTime = new Date(data.entry.check_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      document.getElementById('stat-checkin').textContent = checkinTime;
      document.getElementById('stat-today').textContent = fmtDuration(data.entry.duration_seconds || 0);
    } else if (data.clocked_in && data.clocked_out) {
      clockedIn = false; clockedOut = true;
      setTrackerUI('done');
      const dur = data.entry.duration_seconds || 0;
      document.getElementById('tracker-time').textContent = fmtHms(dur);
      document.getElementById('stat-today').textContent = fmtDuration(dur);
      const checkinTime = new Date(data.entry.check_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      document.getElementById('stat-checkin').textContent = checkinTime;
    }
  } catch (_) {}
}

// ── Clock in / out ────────────────────────────────────────────────────────────

async function doClock(action) {
  const btnIn  = document.getElementById('btn-clock-in');
  const actRow = document.getElementById('tracker-actions');

  try {
    if (action === 'in') {
      actRow.innerHTML = '<button class="btn btn-outline" disabled>Clocking in…</button>';
      const entry = await window.agent.clockIn();
      startEpoch = new Date(entry.check_in || Date.now()).getTime();
      clockedIn = true; clockedOut = false;
      screenshotCount = 0;
      setTrackerUI('active');
      startTick();
      setSsIndicator(true);
      const checkinTime = new Date(startEpoch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      document.getElementById('stat-checkin').textContent = checkinTime;
    } else {
      actRow.innerHTML = '<button class="btn btn-outline" disabled>Clocking out…</button>';
      const entry = await window.agent.clockOut();
      clockedIn = false; clockedOut = true;
      stopTick();
      const dur = entry.duration_sec || entry.duration_seconds || 0;
      document.getElementById('tracker-time').textContent = fmtHms(dur);
      document.getElementById('stat-today').textContent = fmtDuration(dur);
      setTrackerUI('done');
      setSsIndicator(false);
    }
  } catch (e) {
    setTrackerUI(clockedIn ? 'active' : 'idle');
    alert(e?.response?.data?.message || e?.message || 'Action failed');
  }
}

// ── UI state helpers ──────────────────────────────────────────────────────────

function setTrackerUI(state) {
  const actRow   = document.getElementById('tracker-actions');
  const statusEl = document.getElementById('tracker-status');
  const textEl   = document.getElementById('status-text');

  statusEl.className = 'tracker-status';

  if (state === 'idle') {
    statusEl.classList.add('status-idle');
    textEl.textContent = 'Not clocked in';
    actRow.innerHTML = '<button class="btn btn-green" onclick="doClock(\'in\')">▶ Clock In</button>';
  } else if (state === 'active') {
    statusEl.classList.add('status-active');
    textEl.textContent = 'Clocked in';
    actRow.innerHTML = `
      <button class="btn btn-red"    onclick="doClock('out')">■ Clock Out</button>
    `;
  } else if (state === 'done') {
    statusEl.classList.add('status-idle');
    textEl.textContent = 'Clocked out for today';
    actRow.innerHTML = '<button class="btn btn-outline" disabled>Done for today</button>';
  }
}

function setSsIndicator(active) {
  const dot   = document.getElementById('ss-dot');
  const label = document.getElementById('ss-label');
  if (active) {
    dot.classList.add('active');
    label.textContent = 'Screenshots active (every 5 min)';
  } else {
    dot.classList.remove('active');
    label.textContent = 'Screenshots paused';
    document.getElementById('ss-count').textContent = '';
  }
}

// ── Ticker ────────────────────────────────────────────────────────────────────

function startTick() {
  stopTick();
  tickInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startEpoch) / 1000);
    document.getElementById('tracker-time').textContent = fmtHms(elapsed);
    document.getElementById('stat-today').textContent   = fmtDuration(elapsed);
  }, 1000);
}

function stopTick() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtHms(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h:${String(m).padStart(2,'0')}m:${String(s).padStart(2,'0')}s`;
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}
