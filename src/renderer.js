// ── State ─────────────────────────────────────────────────────────────────────

let clockedIn = false;
let clockedOut = false;
let startEpoch = 0;
// Seconds already worked today from sessions completed BEFORE the current
// running one (or the whole day's total once clocked out). Attendance is
// per-day, not per check-in — the ticker below adds this to the running
// session's elapsed time instead of starting from zero on every clock-in.
let priorSeconds = 0;
let tickInterval = null;
let screenshotCount = 0;
let onBreak = false;

// ── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  const token = await window.agent.getStore('auth_token');
  const user  = await window.agent.getStore('user');

  if (token && user) {
    showDashboard(user);
    await refreshToday();
  }

  // Screenshot pulse
  window.agent.onScreenshot(() => {
    screenshotCount++;
    const dot = document.getElementById('ss-dot');
    dot.classList.add('active');
  });

  // Main process cleared the session (refresh token missing/expired/revoked)
  // — fall back to the login screen instead of leaving a stale "logged in"
  // dashboard up against a session that no longer exists.
  window.agent.onSessionExpired(() => {
    clockedIn = false; clockedOut = false; priorSeconds = 0;
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
    showLogin('Your session expired. Please sign in again.');
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

function togglePasswordVisibility() {
  const input = document.getElementById('password');
  const toggle = document.getElementById('password-toggle');
  const eyeIcon = document.getElementById('password-toggle-icon-eye');
  const eyeOffIcon = document.getElementById('password-toggle-icon-eye-off');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  eyeIcon.style.display = show ? 'none' : '';
  eyeOffIcon.style.display = show ? '' : 'none';
  toggle.title = show ? 'Hide password' : 'Show password';
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
  clockedIn = false; clockedOut = false; startEpoch = 0; priorSeconds = 0; screenshotCount = 0;
  showLogin();
}

// Switches back to the login screen — used for an explicit logout and for a
// forced session-expiry (see onSessionExpired above), with an optional
// message shown in the login form's error area to explain why.
function showLogin(message) {
  document.getElementById('login-screen').classList.add('active');
  document.getElementById('dashboard-screen').classList.remove('active');
  document.getElementById('email').value = '';
  document.getElementById('password').value = '';
  const errEl = document.getElementById('login-error');
  if (errEl) errEl.textContent = message || '';
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

// Desktop-app contract with GET /timesheet/today (be-work
// timesheets.controller.js `today_entry`, math in
// timesheets.service.js `summarize_today_entries`):
//
//   clocked_in: boolean
//   clocked_out: boolean
//   entry: null                                              // never clocked in today
//        | { check_in, check_out: null, prior_seconds, status }   // open session
//        | { check_in, check_out, duration_seconds,
//            duration_label, status }                         // day fully closed out
//
// The backend is the single source of truth for this shape — this app must
// NEVER recompute "today's total" from raw session rows itself. If a field
// this app depends on (prior_seconds / duration_seconds / check_in) is ever
// renamed or removed on the backend, that must fail loudly here rather than
// silently rendering "0h 0m" — matching the exact bug this file was fixed
// for (a prior_seconds/duration_seconds field-name mismatch went unnoticed
// for a full release because refreshToday()'s catch swallowed it silently).
function assertTodayContract(data) {
  if (!data.entry) return; // null entry is a valid, documented shape
  const missingCheckIn = data.clocked_in && !data.clocked_out && typeof data.entry.check_in !== 'string';
  const missingPrior = data.clocked_in && !data.clocked_out && typeof data.entry.prior_seconds !== 'number';
  const missingDuration = data.clocked_in && data.clocked_out && typeof data.entry.duration_seconds !== 'number';
  if (missingCheckIn || missingPrior || missingDuration) {
    console.error(
      '[attendance contract violation] GET /timesheet/today returned an entry shape this app does not recognize — ' +
      'refusing to guess and silently show 0h 0m. Expected {check_in, prior_seconds} for an open session or ' +
      '{duration_seconds} for a closed day. Got:', JSON.stringify(data)
    );
    throw new Error('Unexpected /timesheet/today response shape — see console.');
  }
}

async function refreshToday() {
  try {
    const data = await window.agent.getToday();
    if (!data) return;
    assertTodayContract(data);

    if (data.clocked_in && !data.clocked_out) {
      // Active session — restore elapsed time, plus whatever was already
      // worked in earlier sessions today (data.entry.prior_seconds), so the
      // timer resumes the daily total instead of restarting at zero.
      const checkIn = new Date(data.entry.check_in).getTime();
      startEpoch = checkIn;
      priorSeconds = data.entry.prior_seconds || 0;
      clockedIn = true; clockedOut = false;
      onBreak = data.entry.status === 'ON_BREAK';
      setTrackerUI('active');
      startTick();
      setSsIndicator(!onBreak);

      const checkinTime = new Date(data.entry.check_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      document.getElementById('stat-checkin').textContent = checkinTime;
      // Math.max(0, ...) guards against a skewed/behind local clock (see startTick).
      const elapsedNow = Math.max(0, Math.floor((Date.now() - startEpoch) / 1000));
      document.getElementById('stat-today').textContent = fmtDuration(priorSeconds + elapsedNow);
    } else if (data.clocked_in && data.clocked_out) {
      clockedIn = false; clockedOut = true;
      priorSeconds = 0;
      setTrackerUI('done');
      const dur = data.entry.duration_seconds || 0;
      document.getElementById('tracker-time').textContent = fmtHms(dur);
      document.getElementById('stat-today').textContent = fmtDuration(dur);
      const checkinTime = new Date(data.entry.check_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      document.getElementById('stat-checkin').textContent = checkinTime;
    } else {
      // Never clocked in today, or the backend already force-closed the
      // session (e.g. auto-checkout at shift end) before we asked — either
      // way there's nothing active to show.
      clockedIn = false; clockedOut = false;
      priorSeconds = 0;
      stopTick();
      setSsIndicator(false);
      setTrackerUI('idle');
    }
  } catch (_) {}
}

// ── Clock in / out ────────────────────────────────────────────────────────────

function applyClockOutResult(entry) {
  clockedIn = false; clockedOut = true;
  stopTick();
  // entry.duration_sec is only THIS session's length (each check-in/out is
  // its own row) — add the sessions already completed earlier today so the
  // display shows the full daily total, not just the last session.
  const sessionDur = entry.duration_sec || entry.duration_seconds || 0;
  const dailyTotal = priorSeconds + sessionDur;
  document.getElementById('tracker-time').textContent = fmtHms(dailyTotal);
  document.getElementById('stat-today').textContent = fmtDuration(dailyTotal);
  priorSeconds = dailyTotal;
  setTrackerUI('done');
  setSsIndicator(false);
}

async function doClock(action) {
  const btnIn  = document.getElementById('btn-clock-in');
  const actRow = document.getElementById('tracker-actions');

  try {
    if (action === 'in') {
      actRow.innerHTML = '<button class="btn btn-outline" disabled>Clocking in…</button>';
      const entry = await window.agent.clockIn();
      startEpoch = new Date(entry.check_in || Date.now()).getTime();
      // Resume today's accumulated total (earlier completed sessions today)
      // instead of restarting the timer from zero on a second check-in.
      priorSeconds = entry.prior_seconds || 0;
      clockedIn = true; clockedOut = false;
      onBreak = false;
      screenshotCount = 0;
      setTrackerUI('active');
      startTick();
      setSsIndicator(true);
      const checkinTime = new Date(startEpoch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      document.getElementById('stat-checkin').textContent = checkinTime;
    } else {
      actRow.innerHTML = '<button class="btn btn-outline" disabled>Clocking out…</button>';
      const entry = await window.agent.clockOut();
      applyClockOutResult(entry);
    }
  } catch (e) {
    if (action === 'out') {
      const rawMsg = e?.response?.data?.message || e?.message || 'Action failed';
      // The Daily Report gate (main.js's clock-out handler) isn't a stale-
      // state error like the ones below — the session is still genuinely
      // open. Offer the spec's "Skip and submit later" escape hatch rather
      // than just failing the click.
      if (/Daily Report required/i.test(rawMsg)) {
        const skip = confirm(`${rawMsg}\n\nSkip and submit later?`);
        if (skip) {
          try {
            actRow.innerHTML = '<button class="btn btn-outline" disabled>Clocking out…</button>';
            const entry = await window.agent.clockOut({ skip: true });
            applyClockOutResult(entry);
          } catch (e2) {
            setTrackerUI(clockedIn ? 'active' : 'idle');
            alert(e2?.message || 'Action failed');
          }
        } else {
          setTrackerUI('active');
        }
        return;
      }
      // Don't trust the pre-click local state here — a failed clock-out
      // (e.g. the backend already force-closed the session via auto-checkout
      // before the user clicked) means our local "active/ticking" state is
      // stale. Refetch the real state so the UI never gets stuck showing an
      // active session that no longer exists on the backend.
      await refreshToday();
      // ipcRenderer.invoke only carries the Error's message across the
      // bridge, not response.status (see toIpcSafeError in main.js) — so we
      // match on the known backend message text instead of a status code.
      const msg = /no active clock-in/i.test(rawMsg)
        ? 'Your session was already ended automatically (e.g. at end of shift). You are now shown as clocked out.'
        : rawMsg;
      alert(msg);
    } else {
      setTrackerUI(clockedIn ? 'active' : 'idle');
      alert(e?.response?.data?.message || e?.message || 'Action failed');
    }
  }
}

// ── Break ─────────────────────────────────────────────────────────────────────

async function doBreak() {
  const actRow = document.getElementById('tracker-actions');
  try {
    if (!onBreak) {
      actRow.querySelector('#btn-break')?.setAttribute('disabled', 'true');
      await window.agent.breakStart();
      onBreak = true;
    } else {
      actRow.querySelector('#btn-break')?.setAttribute('disabled', 'true');
      await window.agent.breakEnd();
      onBreak = false;
    }
    setTrackerUI('active');
  } catch (e) {
    // Local break state may be out of sync with the backend (e.g. the
    // session was already force-closed) — resync from the real source of
    // truth rather than trusting the pre-click guess.
    await refreshToday();
    const rawMsg = e?.response?.data?.message || e?.message || 'Action failed';
    const msg = /no active clock-in/i.test(rawMsg)
      ? 'Your session was already ended automatically (e.g. at end of shift). You are now shown as clocked out.'
      : rawMsg;
    alert(msg);
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
    onBreak = false;
    actRow.innerHTML = '<button class="btn btn-green" onclick="doClock(\'in\')">▶ Clock In</button>';
  } else if (state === 'active') {
    if (onBreak) {
      statusEl.classList.add('status-break');
      textEl.textContent = 'On break';
    } else {
      statusEl.classList.add('status-active');
      textEl.textContent = 'Clocked in';
    }
    actRow.innerHTML = `
      <button class="btn btn-outline" id="btn-break" onclick="doBreak()">${onBreak ? '▶ Resume' : '⏸ Take Break'}</button>
      <button class="btn btn-red"    onclick="doClock('out')">■ Clock Out</button>
    `;
  } else if (state === 'done') {
    statusEl.classList.add('status-idle');
    textEl.textContent = 'Clocked out for today';
    actRow.innerHTML = '<button class="btn btn-green" onclick="doClock(\'in\')">▶ Clock In Again</button>';
  }
}

function setSsIndicator(active) {
  const dot   = document.getElementById('ss-dot');
  const label = document.getElementById('ss-label');
  if (active) {
    dot.classList.add('active');
    label.textContent = 'Monitoring active';
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
    // Math.max(0, ...) guards against a negative reading if this machine's
    // system clock is behind the server's (check_in is a server timestamp;
    // a skewed/misconfigured local clock would otherwise make `now` appear
    // to be BEFORE check_in and show a nonsensical negative timer).
    const elapsed = priorSeconds + Math.max(0, Math.floor((Date.now() - startEpoch) / 1000));
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
