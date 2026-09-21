// Regression tests for the "timer stuck at 0h:00m:00s while clocked in"
// production report.
//
// Root cause: startTick()'s old ticker recomputed elapsed as
// `Date.now() - startEpoch` on EVERY tick, where startEpoch is the
// server-issued check_in timestamp. If the machine's local system clock is
// behind the server's (not a timezone display setting — an actual wrong
// date/time), that subtraction is negative on every single tick, gets
// clamped to 0 by `Math.max(0, ...)`, and the on-screen timer is
// permanently pinned at 0h:00m:00s / 0h 0m even though the employee really
// is clocked in and the check-in time itself displays correctly (it's
// built directly from the server string, not from Date.now() math).
//
// Fix under test: an anchor pattern (tickAnchorLocalMs/tickAnchorElapsedSec)
// that snapshots "elapsed so far" against the local clock ONCE (at clock-in
// or at a resync) via computeSessionElapsedSeconds(), then every tick after
// that only ever measures local-time-since-anchor (Date.now() vs itself) —
// a skewed clock can no longer produce a negative reading on every tick,
// only (at worst) an under-reported one-time snapshot at the anchor point,
// after which the display correctly counts forward again. A visible
// warning (#clock-skew-warning) also surfaces the condition instead of
// silently showing a plausible-looking (but wrong) 0.
//
// Run with: node --test tests/renderer.clock-skew.test.js

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
  };
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'renderer.js' });
  return { context, document };
}

function trackerTime(document) { return document.getElementById('tracker-time').textContent; }
function skewWarningVisible(document) { return document.getElementById('clock-skew-warning').classList.contains('visible'); }

// A session whose check_in, per THIS machine's clock, appears to be 10
// minutes in the future — the same shape a genuinely behind-by-10-minutes
// local clock produces against a correct server timestamp.
function skewedActiveTodayFixture() {
  const checkIn = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  return { clocked_in: true, clocked_out: false, entry: { check_in: checkIn, prior_seconds: 0, status: 'ACTIVE' } };
}

function normalActiveTodayFixture() {
  const checkIn = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  return { clocked_in: true, clocked_out: false, entry: { check_in: checkIn, prior_seconds: 3600, status: 'ACTIVE' } };
}

test('skewed local clock: timer shows 0 once (not forever) and the warning becomes visible', async () => {
  const { context, document } = buildContext({ getToday: async () => skewedActiveTodayFixture() });

  await context.refreshToday();

  // Old bug: this alone was indistinguishable from "frozen" — every future
  // tick would ALSO show 0h:00m:00s forever. New behavior: the display
  // still can't show elapsed time that hasn't happened yet, so it's 0 at
  // this exact instant, but the warning now makes that visible instead of
  // silent, and — the actual regression fix — the anchor is real (see next
  // test) so subsequent ticks count forward normally instead of re-deriving
  // a permanently-negative reading.
  assert.equal(trackerTime(document), '0h:00m:00s');
  assert.equal(skewWarningVisible(document), true, 'clock-skew warning should be visible for a check_in that appears to be in the future');

  context.stopTick();
});

test('normal (non-skewed) clock-in never shows the skew warning', async () => {
  const { context, document } = buildContext({ getToday: async () => normalActiveTodayFixture() });

  await context.refreshToday();

  assert.equal(skewWarningVisible(document), false);
  assert.match(trackerTime(document), /^\d+h:\d{2}m:\d{2}s$/);

  context.stopTick();
});

test('the ticker anchor is local-clock-relative, not a raw server-vs-local comparison', async () => {
  const { context } = buildContext({ getToday: async () => skewedActiveTodayFixture() });

  await context.refreshToday();

  // The whole point of the fix: tickAnchorLocalMs/tickAnchorElapsedSec are
  // both derived from THIS machine's Date.now() (once, at resync), so every
  // later tick only ever compares Date.now() to itself — it can never again
  // read the skewed server-vs-local gap that caused the original bug.
  assert.equal(typeof context.tickAnchorLocalMs, 'number');
  assert.ok(context.tickAnchorLocalMs > 0, 'anchor should have been set to a real Date.now() reading');
  assert.equal(context.tickAnchorElapsedSec, 0, 'skewed snapshot clamps to 0 (cannot show elapsed time that has not happened yet)');

  context.stopTick();
});

test('clocking out clears the skew warning', async () => {
  const { context, document } = buildContext({
    getToday: async () => skewedActiveTodayFixture(),
    clockOut: async () => ({ duration_sec: 60, check_in: new Date().toISOString() }),
  });

  await context.refreshToday();
  assert.equal(skewWarningVisible(document), true);

  await context.doClock('out');
  assert.equal(skewWarningVisible(document), false, 'warning must not linger on screen after clocking out');
});

test('going idle (never clocked in / force-closed) clears the skew warning', async () => {
  let nextToday = skewedActiveTodayFixture();
  const { context, document } = buildContext({ getToday: async () => nextToday });

  await context.refreshToday();
  assert.equal(skewWarningVisible(document), true);

  nextToday = { clocked_in: false, clocked_out: false, entry: null };
  await context.refreshToday();
  assert.equal(skewWarningVisible(document), false);
});
