// Regression tests for the REPORT_REQUIRED clock-out desync bug (v1.2.4).
//
// renderer.js is plain browser script (no module.exports, relies directly on
// global `document`/`window`), not a module — there is no existing test
// runner or DOM library in this project (no jest/mocha/vitest, no jsdom in
// devDependencies; package.json has no "test" script at all). Rather than
// pull in a new test framework/dependency for one file, this uses Node's
// built-in `node:test` + `node:assert` (Node 20, no install needed) and a
// hand-rolled minimal DOM/window stub covering exactly the element ids and
// window.agent methods renderer.js actually touches. This is enough to load
// the real renderer.js source unmodified via vm and exercise its actual
// control flow — it is NOT full UI/integration coverage (no real rendering,
// no Electron), and that limitation is intentional and called out in the
// PR/report rather than glossed over.
//
// Run with: node --test tests/renderer.reconcile.test.js

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
    querySelector: () => makeElement(id + '-child'), // generic stand-in (e.g. .btn-primary)
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

  // Every call through window.agent.* is counted here regardless of whether
  // the test supplied an override, so assertions on call-counts are always
  // accurate — a raw Object.assign would silently drop the counting wrapper
  // for any method a test overrides (i.e. every REPORT_REQUIRED test, since
  // they all override clockOut/getToday).
  const agentCalls = { getToday: 0, clockOut: 0 };
  const defaults = {
    getStore: async () => null, // skip auto-login on boot for these tests
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
  const merged = Object.assign({}, defaults, agentOverrides);
  const agent = Object.assign({}, merged, {
    getToday: async (...args) => { agentCalls.getToday++; return merged.getToday(...args); },
    clockOut: async (...args) => { agentCalls.clockOut++; return merged.clockOut(...args); },
  });

  const context = {
    document,
    window: { agent },
    console,
    alert: () => {}, // swallow — tests assert on state/call-counts, not dialogs
    // renderer.js's real 1s ticker and 5-minute reconcile interval are real
    // timers under vm — unref() so a test that doesn't explicitly stopTick()
    // (asserting only on call-counts/state) can't hold the Node process open.
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
  return { context, agentCalls, document };
}

// renderer.js declares clockedIn/clockedOut/etc with `let`, which (per the
// vm module's semantics) do NOT attach to the sandbox's global object, so
// they aren't reachable as context.clockedIn from outside the script — only
// tickInterval/reconcileInterval are (declared with `var` specifically so
// the interval-leak test below can see them). For everything else, assert
// on the same DOM text a real user would see, via setTrackerUI()'s output —
// this is arguably the more meaningful assertion anyway (black-box, not
// implementation-detail).
function statusText(document) {
  return document.getElementById('status-text').textContent;
}

// Backend "today" fixture for an open session started 30 minutes ago.
function activeTodayFixture() {
  const checkIn = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  return { clocked_in: true, clocked_out: false, entry: { check_in: checkIn, prior_seconds: 3600, status: 'ACTIVE' } };
}

// Backend "today" fixture reflecting the session already closed server-side
// (e.g. the earlier real-world bug: local ticker thinks it's still running).
function closedTodayFixture() {
  const checkIn = new Date(Date.now() - 2 * 3600 * 1000 - 4 * 60 * 1000).toISOString();
  const checkOut = new Date().toISOString();
  return {
    clocked_in: true,
    clocked_out: true,
    entry: { check_in: checkIn, check_out: checkOut, duration_seconds: 2 * 3600 + 4 * 60, status: 'CLOSED' },
  };
}

test('REPORT_REQUIRED clock-out failure triggers a resync (refreshToday call)', async () => {
  let getTodayCallCount = 0;
  let nextToday = activeTodayFixture();
  const { context, agentCalls, document } = buildContext({
    getToday: async () => { getTodayCallCount++; return nextToday; },
    clockOut: async () => {
      const err = new Error('Daily Report required before clock-out');
      err.code = 'REPORT_REQUIRED';
      throw err;
    },
  });

  // Establish an active clocked-in state first (as if the app had been
  // running for a while), same as boot/login would.
  await context.refreshToday();
  assert.equal(getTodayCallCount, 1);
  assert.equal(statusText(document), 'Clocked in');

  // Now the backend has force-closed the session in the background (this is
  // the exact scenario from the production incident) — the NEXT
  // refreshToday() call should reveal that.
  nextToday = closedTodayFixture();

  await context.doClock('out'); // rejects with REPORT_REQUIRED
  assert.equal(agentCalls.clockOut, 1);

  // Fix under test: doClock's REPORT_REQUIRED branch must call refreshToday()
  // — without the fix this stays at 1 (only the boot call).
  assert.equal(getTodayCallCount, 2, 'refreshToday() was not called on REPORT_REQUIRED failure');

  // And it must actually have picked up the corrected (closed) backend state,
  // not just made a network call that got ignored.
  assert.equal(statusText(document), 'Clocked out for today', 'displayed state did not resync to backend-closed session');
});

test('retryCheckoutAfterReport: report submitted, retry succeeds, final state shows checked out', async () => {
  const { context, agentCalls, document } = buildContext({
    clockOut: async () => ({ duration_sec: 7200, check_in: new Date().toISOString() }),
  });

  context.showReportRequiredModal(); // enter the modal state, as doClock would leave it
  await context.retryCheckoutAfterReport();

  assert.equal(agentCalls.clockOut, 1);
  assert.equal(statusText(document), 'Clocked out for today', 'successful retry did not leave state checked out');
});

test('retryCheckoutAfterReport: retry still fails (report still missing) — resyncs, UI stays consistent', async () => {
  let getTodayCallCount = 0;
  const closed = closedTodayFixture();
  const { context, agentCalls, document } = buildContext({
    getToday: async () => { getTodayCallCount++; return closed; },
    clockOut: async () => {
      const err = new Error('Daily Report required before clock-out');
      err.code = 'REPORT_REQUIRED';
      throw err;
    },
  });

  context.showReportRequiredModal();
  await context.retryCheckoutAfterReport();

  assert.equal(agentCalls.clockOut, 1);
  // Fix under test: the catch block must call refreshToday() too.
  assert.equal(getTodayCallCount, 1, 'refreshToday() was not called when the retry itself failed again');
  assert.equal(statusText(document), 'Clocked out for today', 'UI did not pick up the actual backend state after a failed retry');
});

test('successful direct clock-out (non-REPORT_REQUIRED path) is unaffected by the fix', async () => {
  const { context, agentCalls, document } = buildContext({
    clockOut: async () => ({ duration_sec: 1800, check_in: new Date().toISOString() }),
  });

  await context.doClock('out');
  assert.equal(agentCalls.clockOut, 1);
  assert.equal(statusText(document), 'Clocked out for today');
});

test('startTick()/stopTick() arm and fully tear down the periodic backstop reconciliation interval (no leak)', async () => {
  const { context, agentCalls } = buildContext({
    getToday: async () => { return activeTodayFixture(); },
  });

  await context.refreshToday(); // active session -> startTick() called internally
  // Real interval was created (not asserting on the 5-minute firing itself,
  // since that would require faking timers this test file has no framework
  // for — see note in test file header). We assert the handle exists and
  // that stopTick() clears BOTH intervals it owns, which is what the
  // onSessionExpired leak fix (renderer.js) depends on.
  assert.notEqual(context.tickInterval, null);
  assert.notEqual(context.reconcileInterval, null);

  context.stopTick();
  assert.equal(context.tickInterval, null);
  assert.equal(context.reconcileInterval, null);
});
