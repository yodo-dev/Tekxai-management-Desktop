// Regression tests for the Check-In display timezone bug.
//
// Production incident: an employee's laptop OS timezone did not match
// Asia/Karachi (the company's attendance timezone — the same one
// be-work's timesheets.service.js DISPLAY_TIMEZONE and
// attendance.repository.js's compute_violation() already compute
// shift/lateness against). The check-in TIMESTAMP was always correct
// (stored server-side as a UTC instant, never trusting client-supplied
// time), but renderer.js's `new Date(check_in).toLocaleTimeString([], {...})`
// calls omitted a `timeZone` option, so the DISPLAYED clock silently fell
// back to whatever timezone the laptop's OS happened to be set to instead
// of Asia/Karachi — a 7:48 AM Karachi check-in rendered as 10:48 AM on a
// laptop 3 hours off from Karachi.
//
// These tests force the Node process into a different TZ (America/Los_Angeles)
// via process.env.TZ, then assert the rendered "stat-checkin" text still
// reflects Asia/Karachi wall-clock time — the actual bug scenario — not
// merely that a `timeZone` option string appears somewhere in the source.
//
// Run with: node --test tests/renderer.timezone.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function makeElement(id) {
  const el = {
    id,
    _classes: new Set(),
    _innerHTML: '',
    textContent: '',
    disabled: false,
    title: '',
    type: 'text',
    style: {},
    value: '',
    classList: {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      contains: (c) => el._classes.has(c),
    },
    get className() { return Array.from(el._classes).join(' '); },
    set className(v) { el._classes = new Set(String(v).split(' ').filter(Boolean)); },
    get innerHTML() { return el._innerHTML; },
    set innerHTML(v) { el._innerHTML = v; },
    setAttribute: () => {},
    querySelector: () => makeElement(id + '-child'),
    addEventListener: () => {},
  };
  return el;
}

function buildContext(agentOverrides) {
  const elements = new Map();
  const document = {
    _listeners: {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector: () => null,
    createElement: () => makeElement('tmp'),
    addEventListener(evt, cb) {
      document._listeners[evt] = document._listeners[evt] || [];
      document._listeners[evt].push(cb);
    },
  };

  const defaults = {
    getStore: async () => null,
    onScreenshot: () => {},
    onSessionExpired: () => {},
    onUpdateDownloading: () => {},
    onUpdateProgress: () => {},
    onUpdateReady: () => {},
    onUpdateError: () => {},
    getToday: async () => null,
    clockOut: async () => { throw new Error('not mocked'); },
    clockIn: async () => ({}),
    breakStart: async () => {},
    breakEnd: async () => {},
    openDailyReport: () => {},
  };
  const agent = Object.assign({}, defaults, agentOverrides);

  const context = {
    document,
    window: { agent },
    console,
    alert: () => {},
    setInterval: (...args) => setInterval(...args).unref(),
    clearInterval,
    Date,
    Math,
    JSON,
    String,
    Intl,
  };
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'renderer.js' });
  return { context, document };
}

function checkinText(document) {
  return document.getElementById('stat-checkin').textContent;
}

function karachiExpected(isoString) {
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' });
}

test('resync (refreshToday, active session): check-in time shown is Asia/Karachi wall-clock, not the laptop OS timezone', async () => {
  const original_tz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles'; // 12-13h behind Karachi — guarantees a visibly different hour if the bug regresses
  try {
    // A known instant: 07:48 Asia/Karachi on a fixed date == 02:48 UTC.
    const check_in = '2026-09-04T02:48:00.000Z';
    const { context, document } = buildContext({
      getToday: async () => ({ clocked_in: true, clocked_out: false, entry: { check_in, prior_seconds: 0, status: 'ACTIVE' } }),
    });

    await context.refreshToday();

    assert.equal(checkinText(document), karachiExpected(check_in));
    assert.equal(checkinText(document), '07:48 AM');
  } finally {
    process.env.TZ = original_tz;
  }
});

test('resync (refreshToday, closed session): check-out\'s check-in display also uses Asia/Karachi', async () => {
  const original_tz = process.env.TZ;
  process.env.TZ = 'Pacific/Kiritimati'; // UTC+14 — guarantees a visibly different calendar hour if the bug regresses
  try {
    const check_in = '2026-09-04T02:48:00.000Z';
    const check_out = '2026-09-04T09:00:00.000Z';
    const { context, document } = buildContext({
      getToday: async () => ({
        clocked_in: true, clocked_out: true,
        entry: { check_in, check_out, duration_seconds: 3600, status: 'CLOSED' },
      }),
    });

    await context.refreshToday();

    assert.equal(checkinText(document), karachiExpected(check_in));
    assert.equal(checkinText(document), '07:48 AM');
  } finally {
    process.env.TZ = original_tz;
  }
});

test('doClock("in"): the just-created check-in is displayed in Asia/Karachi, not the laptop OS timezone', async () => {
  const original_tz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const check_in = '2026-09-04T02:48:00.000Z';
    const { context, document } = buildContext({
      clockIn: async () => ({ check_in, prior_seconds: 0 }),
    });

    await context.doClock('in');

    assert.equal(checkinText(document), karachiExpected(check_in));
    assert.equal(checkinText(document), '07:48 AM');
  } finally {
    process.env.TZ = original_tz;
  }
});
