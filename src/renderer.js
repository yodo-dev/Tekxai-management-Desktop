// ── State ─────────────────────────────────────────────────────────────────────

// Attendance is a company-wide policy (shift start/grace-period/lateness are
// all computed server-side against Asia/Karachi — see be-work's
// timesheets.service.js DISPLAY_TIMEZONE and attendance.repository.js's
// compute_violation()), so the displayed check-in clock must show that same
// company timezone — never the laptop's own OS timezone, which is what
// toLocaleTimeString() falls back to when no `timeZone` is given. A laptop
// set to the wrong timezone previously showed a check-in time that didn't
// match Asia/Karachi wall-clock time at all (confirmed in production).
const COMPANY_TIMEZONE = 'Asia/Karachi';

let clockedIn = false;
let clockedOut = false;
let startEpoch = 0;
// Seconds already worked today from sessions completed BEFORE the current
// running one (or the whole day's total once clocked out). Attendance is
// per-day, not per check-in — the ticker below adds this to the running
// session's elapsed time instead of starting from zero on every clock-in.
let priorSeconds = 0;
// Anchor pair for the ticker — see startTick()/anchorTick() below. The
// ticker computes elapsed as tickAnchorElapsedSec + (Date.now() -
// tickAnchorLocalMs), i.e. purely a local-clock-to-itself delta. This is
// what makes the running display immune to server/local clock skew after
// the anchor is set: the one place a skewed local clock can still affect
// the number is the single snapshot computed in computeSessionElapsedSeconds
// (comparing Date.now() to the server's check_in timestamp) — every tick
// after that is safe.
// `var` (not `let`) — same reason as tickInterval/reconcileInterval below:
// asserted on directly by tests/renderer.clock-skew.test.js via the vm
// sandbox's global object.
var tickAnchorLocalMs = 0;
var tickAnchorElapsedSec = 0;
// `var` (not `let`) deliberately: these two are asserted on directly by the
// interval-leak regression test (tests/renderer.reconcile.test.js), which
// loads this file via Node's vm module — only top-level `var`/function
// declarations attach to that sandbox's global object and are reachable
// from outside the script; `let`/`const` would be invisible to the test.
// No behavior change vs. `let` here (both are still just module-top-level
// state used the same way everywhere below).
var tickInterval = null;
// Backstop reconciliation while clocked in — see startTick()/stopTick() below.
var reconcileInterval = null;
let screenshotCount = 0;
let onBreak = false;
// 'IDLE' | 'MANUAL' | null — which flow put the current session ON_BREAK
// (see break_source in be-work's summarize_today_entries). Only an IDLE
// break shows the "placed on break due to inactivity — Resume Work?"
// modal below; a MANUAL break keeps using the existing inline Resume
// button in the tracker actions row (setTrackerUI), unchanged.
let breakSource = null;

// ── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  // Shown on both the login screen (visible before any session exists) and
  // the dashboard footer — fetched once here rather than only inside
  // showDashboard(), which left the login screen with no version at all.
  window.agent.getAppVersion?.()?.then((v) => {
    const text = v ? `v${v}` : '';
    const loginEl = document.getElementById('login-app-version');
    const dashEl = document.getElementById('app-version');
    if (loginEl) loginEl.textContent = text;
    if (dashEl) dashEl.textContent = text;
  }).catch(() => {});

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
    // stopTick() (not just clearing tickInterval) so the periodic
    // backstop reconciliation interval added below is also torn down —
    // otherwise it would keep calling refreshToday() against a session
    // the main process already knows is gone.
    stopTick();
    setClockSkewWarning(false);
    stopProactiveMonitoringChecks();
    showLogin('Your session expired. Please sign in again.');
  });

  // Desktop update — main.js (via be-work's /desktop/latest-version) is the
  // sole decision-maker for whether/when these fire, including when the
  // download itself starts (Background Silent Updates — it's automatic,
  // no click needed); this renderer only reacts to what it's told.
  window.agent.onUpdateDownloading((data) => renderUpdateIndicator(data));
  window.agent.onUpdateProgress((data) => renderUpdateProgress(data));
  window.agent.onUpdateReady((data) => renderUpdateReady(data));
  window.agent.onUpdateError((message) => renderUpdateError(message));

  // Shift-end reminder — main.js owns all scheduling; this renderer only
  // renders what it's told and forwards the two button clicks back.
  // Optional-chained: older/minimal test harnesses that predate this
  // feature don't stub these three agent methods, and that's fine — this
  // wiring is a no-op without them, never a hard failure.
  window.agent.onShiftEndReminderShow?.(() => showShiftEndReminderModal());
  window.agent.onShiftEndReminderHide?.(() => hideShiftEndReminderModal());
  window.agent.onShiftEndReminderCheckedOut?.((entry) => {
    hideShiftEndReminderModal();
    applyClockOutResult(entry || {});
  });
})();

// ── Login ─────────────────────────────────────────────────────────────────────

async function doLogin() {
  const btn = document.getElementById('login-btn');
  // Re-entrancy guard — doLogin() has two independent trigger paths (the
  // button's own onclick, and the document-level Enter keydown listener
  // below). If focus is ever on the Sign In button itself, pressing Enter
  // fires BOTH: the browser's native synthetic click on the focused button
  // AND this keydown listener, invoking doLogin() twice in the same tick —
  // before either call's `btn.disabled = true` has taken effect against the
  // other. That produced two simultaneous /auth/login requests from one
  // keypress. Checking disabled state first, before doing anything else,
  // makes the second (re-entrant) call a no-op.
  if (btn.disabled) return;

  const email    = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
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
    errEl.textContent = loginErrorMessage(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

// Surfaces a plain, actionable message instead of the raw Electron IPC error
// text (e.g. "Error invoking remote method 'login': Error: Request failed
// with status code 429"), which is meaningless to a user. e.response never
// survives the main-process IPC boundary — main.js's toIpcSafeError() lifts
// status/retryAfter onto the Error's own properties for exactly this reason;
// read those directly here, not e.response.
function loginErrorMessage(e) {
  if (e?.status === 429) {
    const retryAfter = Number(e?.retryAfter);
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? ` Please try again in about ${Math.ceil(retryAfter / 60) || 1} minute(s).`
      : ' Please wait a moment and try again.';
    return `Too many login attempts.${wait}`;
  }
  return e?.message || 'Login failed.';
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
  stopProactiveMonitoringChecks();
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

  startProactiveMonitoringChecks();
}

// ── Proactive monitoring-permission check ───────────────────────────────────
// Previously this app only ever discovered a broken screen-capture setup
// (permission denied, or — on Windows/Linux, which have no OS permission
// prompt at all — an actual capture failure) the moment someone clicked
// Clock In. An employee who was never going to be able to clock in had no
// way to know until they tried, and if it broke mid-session (permission
// revoked, AV update, etc.) there was no re-check until their next
// clock-in. Runs once right after login/auto-login, then on a recurring
// timer for as long as the renderer is open — pops the same blocking modal
// clock-in uses, without requiring a clock-in attempt to trigger it.
const PROACTIVE_MONITORING_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 min
let proactiveMonitoringCheckTimer = null;

function startProactiveMonitoringChecks() {
  if (proactiveMonitoringCheckTimer) return; // showDashboard can run more than once per app session
  runProactiveMonitoringCheck();
  proactiveMonitoringCheckTimer = setInterval(runProactiveMonitoringCheck, PROACTIVE_MONITORING_CHECK_INTERVAL_MS);
}

function stopProactiveMonitoringChecks() {
  if (proactiveMonitoringCheckTimer) { clearInterval(proactiveMonitoringCheckTimer); proactiveMonitoringCheckTimer = null; }
}

async function runProactiveMonitoringCheck() {
  // Never interrupt a session already clocked in with a background capture
  // attempt mid-work — the recurring screenshot interval already proves
  // capture works while actively tracking, and takeScreenshot() failures
  // during that loop are a separate, already-covered path (main.js still
  // has no per-failure UI for those, but re-verifying here would just be a
  // second capture on top of the real one on the same tick). Only relevant
  // while idle/not clocked in, i.e. exactly when clock-in is what's next.
  if (clockedIn) return;
  // Don't stack a second popup on top of one already showing (e.g. the
  // user hasn't dismissed/resolved the last check yet).
  if (document.getElementById('monitoring-permission-backdrop')?.classList.contains('active')) return;
  try {
    const { status, capture_error } = await window.agent.verifyMonitoringCaptureFull();
    if (status === 'DENIED' || status === 'UNKNOWN') {
      showMonitoringPermissionModal(status === 'UNKNOWN');
    } else if (status === 'CAPTURE_FAILED') {
      showMonitoringCaptureFailedModal(capture_error);
    }
  } catch (_) { /* best-effort — a failed check here must never crash the renderer */ }
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
      breakSource = onBreak ? (data.entry.break_source || null) : null;
      // Anchor BEFORE startTick() so the very first tick (and the
      // stat-today line set immediately below) both read the freshly
      // (re)established anchor, not a stale one from a previous session.
      const elapsedNow = computeSessionElapsedSeconds(checkIn);
      anchorTick(priorSeconds + elapsedNow);
      setTrackerUI('active');
      startTick();
      setSsIndicator(!onBreak);
      if (onBreak && breakSource === 'IDLE') maybeShowIdleBreakModal();
      else hideIdleBreakModal();

      const checkinTime = new Date(data.entry.check_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: COMPANY_TIMEZONE });
      document.getElementById('stat-checkin').textContent = checkinTime;
      document.getElementById('tracker-time').textContent = fmtHms(priorSeconds + elapsedNow);
      document.getElementById('stat-today').textContent = fmtDuration(priorSeconds + elapsedNow);
    } else if (data.clocked_in && data.clocked_out) {
      clockedIn = false; clockedOut = true;
      priorSeconds = 0;
      breakSource = null;
      hideIdleBreakModal();
      // A tickInterval from a previously-active session (restored earlier by
      // the branch above) may still be running — e.g. the backend's own
      // auto-checkout job closed this session before we found out, so we
      // land here via a resync rather than via applyClockOutResult(), which
      // is the only other place that stops it. Without this, the stale
      // interval keeps overwriting the frozen duration below every second.
      stopTick();
      setClockSkewWarning(false);
      setTrackerUI('done');
      // Same leftover-state issue as stopTick() above: if screenshots were
      // active going into this resync (session was live a moment ago), the
      // indicator stays stuck on "Monitoring active" unless explicitly
      // turned off here too — applyClockOutResult() already does this.
      setSsIndicator(false);
      const dur = data.entry.duration_seconds || 0;
      document.getElementById('tracker-time').textContent = fmtHms(dur);
      document.getElementById('stat-today').textContent = fmtDuration(dur);
      const checkinTime = new Date(data.entry.check_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: COMPANY_TIMEZONE });
      document.getElementById('stat-checkin').textContent = checkinTime;
    } else {
      // Never clocked in today, or the backend already force-closed the
      // session (e.g. auto-checkout at shift end) before we asked — either
      // way there's nothing active to show.
      clockedIn = false; clockedOut = false;
      priorSeconds = 0;
      breakSource = null;
      hideIdleBreakModal();
      stopTick();
      setClockSkewWarning(false);
      setSsIndicator(false);
      setTrackerUI('idle');
    }
  } catch (_) {}
}

// ── Clock in / out ────────────────────────────────────────────────────────────

function applyClockOutResult(entry) {
  clockedIn = false; clockedOut = true;
  stopTick();
  setClockSkewWarning(false);
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
      breakSource = null;
      screenshotCount = 0;
      // Anchor before startTick() — see the refreshToday() active-session
      // branch above for why. A fresh clock-in normally has ~0 elapsed, but
      // this still runs through the same skew check for consistency (and
      // in case entry.check_in comes back meaningfully different from
      // "now", e.g. clock resumed a session server-side).
      anchorTick(priorSeconds + computeSessionElapsedSeconds(startEpoch));
      setTrackerUI('active');
      startTick();
      setSsIndicator(true);
      const checkinTime = new Date(startEpoch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: COMPANY_TIMEZONE });
      document.getElementById('stat-checkin').textContent = checkinTime;
    } else {
      actRow.innerHTML = '<button class="btn btn-outline" disabled>Clocking out…</button>';
      const entry = await window.agent.clockOut();
      applyClockOutResult(entry);
    }
  } catch (e) {
    if (action === 'out') {
      const rawMsg = e?.response?.data?.message || e?.message || 'Action failed';
      // Mandatory Daily Report gate — be-work's POST /timesheet/clock-out
      // now enforces this server-side (returns code REPORT_REQUIRED, see
      // timesheets.controller.js) and never accepts a skip. There is no
      // bypass here either: no "Skip Now" path, just the required-report
      // modal and a retry once it's actually submitted.
      if (e?.code === 'REPORT_REQUIRED' || /Daily Report required/i.test(rawMsg)) {
        setTrackerUI('active');
        showReportRequiredModal();
        // Clock-out was rejected, not applied — but the local ticker has
        // been running (and any prior force-close/desync could have already
        // happened) while this request was in flight. Every other failure
        // branch below already resyncs from the backend; this one didn't,
        // which let the displayed timer keep drifting on stale local state
        // even though nothing here is actually still accurate. Resync here
        // too so the report-required modal sits on top of a correct
        // checked-in time/status, not a frozen one.
        await refreshToday();
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
    } else if (e?.code === 'MONITORING_PERMISSION_DENIED' || e?.code === 'MONITORING_PERMISSION_UNVERIFIED') {
      // Blocked locally, before any attendance API call — clockedIn/
      // clockedOut/the ticker were never touched, so 'idle' is correct
      // here (not clockedIn ? 'active' : 'idle' — clock-in genuinely never
      // happened on this attempt).
      setTrackerUI('idle');
      showMonitoringPermissionModal(e.code === 'MONITORING_PERMISSION_UNVERIFIED');
    } else if (e?.code === 'MONITORING_CAPTURE_FAILED') {
      // Same fail-closed shape as the permission-denied branch above, but
      // for the cross-platform case: a real screenshot capture was
      // attempted and threw (no OS permission dialog to point at — this
      // covers Windows/Linux, and a macOS capture that fails despite
      // 'GRANTED' TCC status). e.message carries the real error text.
      setTrackerUI('idle');
      showMonitoringCaptureFailedModal(e.message);
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
      breakSource = 'MANUAL';
    } else {
      actRow.querySelector('#btn-break')?.setAttribute('disabled', 'true');
      await window.agent.breakEnd();
      onBreak = false;
      breakSource = null;
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
    label.textContent = 'Screen monitoring paused';
    document.getElementById('ss-count').textContent = '';
  }
}

// ── Ticker ────────────────────────────────────────────────────────────────────

// Second layer of defense alongside webPreferences.backgroundThrottling:
// false (main.js) — that setting is what actually keeps startTick()'s
// setInterval firing while the window is unfocused/hidden, but resyncing
// immediately the moment the window becomes visible/focused again means
// the on-screen timer snaps to the true elapsed time right away rather
// than waiting for the next 1s tick or the 5-minute reconcileInterval
// backstop, in case anything (OS-level app nap, a slow resume from sleep)
// still introduces a gap. Also doubles as the desktop<->web reconciliation
// point required when returning from a minimize/lock/sleep — refreshToday()
// is the same backend-is-source-of-truth call the 5-minute backstop uses.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshToday(); });
// Belt-and-suspenders alongside visibilitychange above — window focus can
// fire without a visibility change on some Windows minimize/restore
// sequences. refreshToday() is idempotent (it fully reconciles from
// scratch every call), so redundant calls here are harmless.
window.addEventListener?.('focus', () => refreshToday());

// Reads the server-issued check-in timestamp against this machine's local
// clock exactly once (at clock-in or at a resync), rather than on every
// tick — see the tickAnchor* comment above for why that matters. Also
// drives the visible clock-skew warning: a small negative tolerance (5s)
// absorbs normal network/processing latency between the server stamping
// check_in and this code running, so the warning doesn't fire on every
// clock-in from jitter alone — only a real, sustained clock problem.
function computeSessionElapsedSeconds(checkInEpoch) {
  const raw = Math.floor((Date.now() - checkInEpoch) / 1000);
  const skewed = raw < -5;
  setClockSkewWarning(skewed);
  return skewed ? 0 : Math.max(0, raw);
}

function setClockSkewWarning(active) {
  const el = document.getElementById('clock-skew-warning');
  if (!el) return;
  if (active) el.classList.add('visible');
  else el.classList.remove('visible');
}

// Snapshots "elapsed as of right now" against the local clock so every
// subsequent tick only ever measures local-time-since-anchor — see the
// tickAnchor* state comment above.
function anchorTick(elapsedNowSec) {
  tickAnchorLocalMs = Date.now();
  tickAnchorElapsedSec = elapsedNowSec;
}

function startTick() {
  stopTick();
  tickInterval = setInterval(() => {
    // Purely a local-clock-to-itself delta (both readings are Date.now(),
    // taken on this same machine) — unlike the old
    // `Date.now() - startEpoch` (which compared this machine's clock
    // directly against the server's check_in timestamp on every tick), a
    // skewed local clock can no longer pin this at a permanent 0. See
    // anchorTick()/computeSessionElapsedSeconds() for where the anchor is
    // (re)established.
    const elapsed = tickAnchorElapsedSec + Math.max(0, Math.floor((Date.now() - tickAnchorLocalMs) / 1000));
    document.getElementById('tracker-time').textContent = fmtHms(elapsed);
    document.getElementById('stat-today').textContent   = fmtDuration(elapsed);
  }, 1000);

  // Backstop reconciliation: every user-triggered action that can fail
  // already resyncs from the backend on its own error path (see doClock,
  // doBreak, retryCheckoutAfterReport), but if the employee just sits idle
  // with a session open, NOTHING pulls fresh state until they next click
  // something — a server-side force-close (shift-end auto-checkout, admin
  // action) could sit unnoticed indefinitely, with this ticker happily
  // counting forward on a startEpoch the backend no longer honors. This is
  // exactly the "no error, no click, no resync" gap the original 21h/2h
  // desync bug lived in. A low-frequency periodic refreshToday() while
  // clocked in closes that gap without adding meaningful load: one request
  // every 5 minutes per connected employee is negligible, and refreshToday()
  // already no-ops safely on transient failures (see its catch).
  if (reconcileInterval) clearInterval(reconcileInterval);
  reconcileInterval = setInterval(() => { refreshToday(); }, 5 * 60 * 1000);
}

function stopTick() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  if (reconcileInterval) { clearInterval(reconcileInterval); reconcileInterval = null; }
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

// ── Desktop update UI ────────────────────────────────────────────────────────
// Background Silent Updates: the download itself is never something the
// employee has to notice or act on. Two surfaces:
//
//  1. #update-indicator — a small, non-blocking pill (never covers the
//     screen, never stops other clicks) shown only while a download is
//     actually in flight. This is the ONLY thing shown during download.
//  2. #update-backdrop / #update-card — the full-screen card, reserved
//     exclusively for "Ready to Install" once the download finishes. This is
//     the first (and only) point active work can be interrupted.
//
// `updateMustForce` gates whether the ready-to-install card can be
// dismissed — a mandatory update (release-wide forceUpdate, being below
// minimumVersion, or an admin's per-employee force request) removes the
// "Later" path, matching "Disable normal application usage until update is
// installed." It never gates or delays the download itself — that always
// starts immediately and silently regardless of mustForce.
let updateMustForce = false;
let currentUpdateVersion = null;
let currentReleaseNotes = null;
let updateIndicatorVisible = false;

function showUpdateBackdrop() {
  document.getElementById('update-backdrop').classList.add('active');
}
function hideUpdateBackdrop() {
  if (updateMustForce) return; // mandatory — no dismiss path, ever
  document.getElementById('update-backdrop').classList.remove('active');
}

// Fired the moment main.js silently starts downloading an update — never
// interrupts, never asks for a click. Just a quiet "this is happening" pill.
function renderUpdateIndicator({ version, mustForce }) {
  currentUpdateVersion = version || currentUpdateVersion;
  if (mustForce) updateMustForce = true;
  updateIndicatorVisible = true;
  const el = document.getElementById('update-indicator');
  el.className = 'update-indicator active';
  el.innerHTML = `
    <span class="update-indicator-spinner"></span>
    <span class="update-indicator-text" id="update-indicator-text">Downloading update…</span>
  `;
}

function hideUpdateIndicator() {
  updateIndicatorVisible = false;
  document.getElementById('update-indicator').className = 'update-indicator';
}

// Rich release notes — a small hand-rolled markdown-lite subset, same
// "only ever needs to round-trip what this app's own admin panel writes,
// not arbitrary external markdown" convention fe-work's chat module already
// established for the identical problem (messageContent.tsx). Supports:
// `## Section Header` (bold subheading, not a bullet), `- item`/`* item` or
// a bare line (both become a bullet — bare lines are what every release
// published before this feature already used, so old-style plain notes
// still render exactly as before), and inline `**bold**`. Deliberately not
// a general markdown parser — headers/bullets/bold cover everything a
// release-notes field needs.
function renderReleaseNotesInline(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
function renderReleaseNotesHtml(raw) {
  const lines = (raw || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (!lines.length) return '';
  let html = '';
  let bullets = [];
  const flushBullets = () => {
    if (!bullets.length) return;
    html += `<ul class="whats-new-list">${bullets.map((b) => `<li>${renderReleaseNotesInline(b)}</li>`).join('')}</ul>`;
    bullets = [];
  };
  for (const line of lines) {
    const headerMatch = /^#{1,3}\s*(.+)$/.exec(line);
    if (headerMatch) {
      flushBullets();
      html += `<div class="whats-new-label">${renderReleaseNotesInline(headerMatch[1])}</div>`;
      continue;
    }
    const bulletMatch = /^[-*]\s+(.+)$/.exec(line);
    bullets.push(bulletMatch ? bulletMatch[1] : line);
  }
  flushBullets();
  return html ? `<div class="whats-new-label">What's New</div>${html}` : '';
}

// Progress updates land on the indicator pill's text only — never a big
// card, never a progress bar the employee has to look at. Stale progress
// events (e.g. one arriving just after a failure hid the indicator) are
// dropped rather than resurrecting it.
function renderUpdateProgress({ percent }) {
  if (!updateIndicatorVisible) return;
  const pct = Math.round(percent || 0);
  const textEl = document.getElementById('update-indicator-text');
  if (textEl) textEl.textContent = `Downloading update… ${pct}%`;
}

// The first (and only) point a silent background update can interrupt
// active work — the download already finished, nothing left to wait on.
// Includes the same rich release-notes rendering the pre-download dialog
// used to show, so "What's New" isn't lost just because there's no longer a
// pre-download step to show it at.
function renderUpdateReady({ version, mustForce, releaseNotes }) {
  hideUpdateIndicator();
  updateMustForce = !!mustForce || updateMustForce;
  currentReleaseNotes = releaseNotes || currentReleaseNotes;
  document.getElementById('update-card').innerHTML = `
    <div class="update-icon">✓</div>
    <div>
      <div class="update-title">Ready to Install</div>
      <div class="update-subtitle">TekXAI Desktop Update ${version ? escapeHtml(version) : ''} has been downloaded.</div>
    </div>
    ${renderReleaseNotesHtml(currentReleaseNotes)}
    <div class="update-actions">
      ${updateMustForce ? '' : '<button class="btn btn-outline" onclick="hideUpdateBackdrop()">Later</button>'}
      <button class="btn btn-primary" onclick="window.agent.restartAndInstall()">Restart Now</button>
    </div>
  `;
  showUpdateBackdrop();
}

// A failed background download is still just a pill, not a dialog — swap
// the spinner for a retry link rather than interrupting with a modal. Only
// surfaces if a download was actually in flight (updateIndicatorVisible) —
// a routine background availability-check failure never showed the
// indicator at all and shouldn't suddenly pop one up just to report it.
function renderUpdateError(message) {
  if (!updateIndicatorVisible) return;
  const el = document.getElementById('update-indicator');
  el.className = 'update-indicator active failed';
  el.title = message || 'Something went wrong downloading the update.';
  el.innerHTML = `
    <span class="update-indicator-icon">⚠</span>
    <button class="update-indicator-text update-indicator-retry" onclick="startUpdateNow()">Update failed — retry</button>
  `;
}

// ── Mandatory Daily Report gate ─────────────────────────────────────────────
// No dismiss/"Skip Now" path — closing this only options are "Open Daily
// Report" (reuses the existing web page, the only place a report can
// actually be submitted) and "I've Submitted — Retry Checkout", which
// re-runs the exact same clockOut() the button always used, so the backend
// (POST /timesheet/clock-out, the real authority) decides again from
// scratch — this UI never assumes success.
function showReportRequiredModal() {
  document.getElementById('report-required-card').innerHTML = `
    <div class="update-icon force">📋</div>
    <div>
      <div class="update-title">Daily Report Required</div>
      <div class="update-subtitle force">You must submit your Daily Report before you can check out.</div>
    </div>
    <div class="update-actions">
      <button class="btn btn-outline" onclick="window.agent.openDailyReport()">Open Daily Report</button>
      <button class="btn btn-primary" onclick="retryCheckoutAfterReport()">I've Submitted — Retry Checkout</button>
    </div>
  `;
  document.getElementById('report-required-backdrop').classList.add('active');
}
function hideReportRequiredModal() {
  document.getElementById('report-required-backdrop').classList.remove('active');
}

// Monitoring permission gate — mirrors showReportRequiredModal's shape
// exactly: no dismiss/bypass path, only "Open System Settings" (macOS
// can't grant this itself — only the employee can, in that pane) and
// "Check Permission Again" (re-runs the exact same local check main.js's
// clock-in gate uses, then retries clockIn() for real — never assumes
// success locally). `unverified` distinguishes the rare "the OS API check
// itself threw" case from a plain DENIED/UNKNOWN read, per the
// fail-closed requirement — both block identically, only the copy differs.
function showMonitoringPermissionModal(unverified) {
  const subtitle = unverified
    ? 'Unable to verify screen monitoring permission. Please check Screen Recording permission in System Settings and try again.'
    : 'Your monitoring permission is currently disabled. To clock in, please enable the required Screen Recording permission for TEKxAI Agent.';
  document.getElementById('monitoring-permission-card').innerHTML = `
    <div class="update-icon force">🔒</div>
    <div>
      <div class="update-title">Screen Monitoring Permission Required</div>
      <div class="update-subtitle force">${subtitle}</div>
    </div>
    <div id="monitoring-permission-status" class="update-subtitle" style="margin-top:4px"></div>
    <div class="update-actions">
      <button class="btn btn-outline" onclick="window.agent.openMonitoringPermissionSettings()">Open System Settings</button>
      <button class="btn btn-primary" onclick="recheckMonitoringPermission()">Check Permission Again</button>
    </div>
  `;
  document.getElementById('monitoring-permission-backdrop').classList.add('active');
}
function hideMonitoringPermissionModal() {
  document.getElementById('monitoring-permission-backdrop').classList.remove('active');
}
async function recheckMonitoringPermission() {
  const btn = document.querySelector('#monitoring-permission-card .btn-primary');
  const statusEl = document.getElementById('monitoring-permission-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    const status = await window.agent.checkMonitoringPermission();
    if (status === 'GRANTED' || status === 'NOT_APPLICABLE') {
      if (statusEl) statusEl.textContent = 'Permission verified. You can now clock in.';
      hideMonitoringPermissionModal();
      // Re-run the real clock-in — this modal never assumes success on its
      // own; POST /timesheet/clock-in (via main.js's gate, now passing) is
      // still the only thing that actually starts a session.
      await doClock('in');
    } else {
      if (statusEl) statusEl.textContent = 'Screen Recording permission is still not enabled.';
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = e?.message || 'Unable to verify permission. Please try again.';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check Permission Again'; }
  }
}

// The capture_error text this modal displays originates from the
// screenshot-desktop npm package's own thrown Error (main.js's
// verifyScreenshotCaptureWorks) — its wording isn't controlled by this app,
// so it could plausibly contain the literal word "screenshot" even after
// every string this app itself writes has been reworded. Case-insensitive
// so "Screenshot"/"SCREENSHOT" are caught too; only touches what's shown to
// the employee, never the underlying error object/logs.
function sanitizeUserFacingError(text) {
  if (!text) return text;
  return String(text).replace(/screenshot/gi, 'screen monitoring');
}

// Reuses the same backdrop/card DOM as the permission modal above — no
// "Open System Settings" button here, since this isn't a permission the
// employee can grant themselves (native capture helper missing, AV/EDR
// blocking capture, a locked/RDP session, etc). Shows the real captured
// error text so IT has something to act on instead of a generic failure.
function showMonitoringCaptureFailedModal(errorMessage) {
  document.getElementById('monitoring-permission-card').innerHTML = `
    <div class="update-icon force">⚠️</div>
    <div>
      <div class="update-title">Screen Monitoring Isn't Working</div>
      <div class="update-subtitle force">Screen monitoring can't be verified on this device, so you can't clock in yet. Please contact IT with this error:</div>
    </div>
    <div id="monitoring-permission-status" class="update-subtitle" style="margin-top:4px">${sanitizeUserFacingError(errorMessage) || 'Unknown error'}</div>
    <div class="update-actions">
      <button class="btn btn-primary" onclick="retryClockInAfterCaptureFailure()">Try Again</button>
    </div>
  `;
  document.getElementById('monitoring-permission-backdrop').classList.add('active');
}
async function retryClockInAfterCaptureFailure() {
  hideMonitoringPermissionModal();
  // No local status to re-check here (unlike recheckMonitoringPermission,
  // which can ask main.js for a cheap OS permission read first) — the only
  // way to know if capture works now is to attempt clock-in again, which
  // runs the real capture check itself.
  await doClock('in');
}
// ── Shift-end "are you still working?" reminder ─────────────────────────────
// Pure display + button-forwarding — main.js owns the schedule, the 30s
// auto-checkout countdown, and the 30-minute repeat cycle (see
// scheduleShiftEndReminder/fireShiftEndReminder there). This modal never
// decides attendance state on its own; both buttons just invoke an IPC call
// whose result (or the backend's own auto-checkout) is what actually changes
// anything.
function showShiftEndReminderModal() {
  document.getElementById('shift-end-reminder-card').innerHTML = `
    <div class="update-icon force">⏰</div>
    <div>
      <div class="update-title">Are you still working?</div>
      <div class="update-subtitle force">Your shift has ended. Let us know if you're continuing to work — otherwise you'll be checked out automatically in 30 seconds.</div>
    </div>
    <div class="update-actions">
      <button class="btn btn-outline" onclick="shiftEndReminderCheckout()">No, Check Out</button>
      <button class="btn btn-primary" onclick="shiftEndReminderContinue()">Yes, Continue Working</button>
    </div>
  `;
  document.getElementById('shift-end-reminder-backdrop').classList.add('active');
}
function hideShiftEndReminderModal() {
  document.getElementById('shift-end-reminder-backdrop').classList.remove('active');
}
async function shiftEndReminderContinue() {
  hideShiftEndReminderModal();
  try { await window.agent.shiftEndReminderContinue(); } catch (_) {}
}
async function shiftEndReminderCheckout() {
  const btn = document.querySelector('#shift-end-reminder-card .btn-outline');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking out…'; }
  try {
    await window.agent.shiftEndReminderCheckout();
    // The 'shift-end-reminder:checked-out' listener (registered in the boot
    // IIFE) applies the result and hides this modal — no need to duplicate
    // that here.
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'No, Check Out'; }
    alert(e?.message || 'Checkout failed. Please try again.');
  }
}

async function retryCheckoutAfterReport() {
  const btn = document.querySelector('#report-required-card .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    const entry = await window.agent.clockOut();
    hideReportRequiredModal();
    applyClockOutResult(entry);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "I've Submitted — Retry Checkout"; }
    // Still missing (or another failure) — stay on the modal rather than
    // silently closing it; the employee hasn't actually submitted yet.
    if (e?.code !== 'REPORT_REQUIRED' && !/Daily Report required/i.test(e?.message || '')) {
      alert(e?.message || 'Checkout failed. Please try again.');
    }
    // Same gap as the initial REPORT_REQUIRED branch in doClock(): this retry
    // failed too, but nothing here was resyncing the displayed timer/status
    // with the backend, so the local ticker just kept counting on a stale
    // startEpoch. Resync unconditionally so whatever is actually true on the
    // backend (still open, or already force-closed in the meantime) is what
    // gets shown while the employee is stuck on this modal.
    await refreshToday();
  }
}

// ── Idle-triggered break notice ─────────────────────────────────────────────
// Shown only when the backend's own resync (refreshToday) reports
// status ON_BREAK with break_source IDLE — i.e. the scheduler's
// auto-checkout job (be-work auto-checkout.job.js) put this session on
// break because no desktop activity was seen for the configured Idle
// Timeout Duration. That job never auto-resumes an IDLE break on its own
// (see the corresponding backend fix) — only this explicit "Resume Work"
// click, which reuses the existing break-end IPC, ends it. Detecting local
// mouse/keyboard activity again must NOT auto-dismiss this on its own.
function maybeShowIdleBreakModal() {
  const backdrop = document.getElementById('idle-break-backdrop');
  if (backdrop.classList.contains('active')) return; // already showing
  document.getElementById('idle-break-card').innerHTML = `
    <div class="update-icon force">💤</div>
    <div>
      <div class="update-title">You Were Placed On Break</div>
      <div class="update-subtitle force">You were automatically placed on break due to inactivity. Would you like to resume work?</div>
    </div>
    <div class="update-actions">
      <button class="btn btn-primary" onclick="resumeFromIdleBreak()">▶ Resume Work</button>
    </div>
  `;
  backdrop.classList.add('active');
}
function hideIdleBreakModal() {
  document.getElementById('idle-break-backdrop').classList.remove('active');
}
async function resumeFromIdleBreak() {
  const btn = document.querySelector('#idle-break-card .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Resuming…'; }
  try {
    // Same break-end IPC a manual break's "Resume" button already uses —
    // no parallel resume path, no duplicate break/resume transition.
    await window.agent.breakEnd();
    onBreak = false;
    breakSource = null;
    hideIdleBreakModal();
    setTrackerUI('active');
    setSsIndicator(true);
    // Resync from the backend rather than trusting this optimistic local
    // update as final — matches the same pattern doBreak() already uses.
    await refreshToday();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '▶ Resume Work'; }
    const rawMsg = e?.response?.data?.message || e?.message || 'Action failed';
    const msg = /no active clock-in/i.test(rawMsg)
      ? 'Your session was already ended automatically (e.g. at end of shift). You are now shown as clocked out.'
      : rawMsg;
    alert(msg);
    await refreshToday();
  }
}

async function startUpdateNow() {
  renderUpdateIndicator({ version: currentUpdateVersion, mustForce: updateMustForce });
  try {
    await window.agent.startUpdateDownload();
  } catch (e) {
    renderUpdateError(e?.message || 'Failed to start the update download.');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
