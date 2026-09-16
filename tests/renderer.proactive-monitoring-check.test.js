// Regression coverage for the proactive monitoring-permission check.
//
// Previously the blocking "Screen Recording permission required" /
// "Screenshot capture isn't working" modal only ever appeared as a reaction
// to a failed Clock In click — an employee whose screenshot capture was
// already broken (denied permission, or a real capture failure on Windows/
// Linux, which have no OS permission prompt at all) had no way to find out
// until they actually tried to clock in. showDashboard() now kicks off a
// proactive check (once on login/auto-login, then periodically) via
// window.agent.verifyMonitoringCaptureFull(), popping the same modal
// without requiring a clock-in attempt.
//
// Uses the same node:vm sandboxed-DOM harness as renderer.reconcile.test.js
// / renderer.login.test.js (no jsdom/jest in this project) to load the real
// renderer.js unmodified.
//
// Run with: node --test tests/renderer.proactive-monitoring-check.test.js

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

function buildContext({ verifyMonitoringCaptureFull }) {
  const elements = new Map();

  const document = {
    _listeners: {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector: (sel) => {
      // showMonitoringPermissionModal/showMonitoringCaptureFailedModal
      // query '#monitoring-permission-card .btn-primary' — a plain stand-in
      // element is enough, nothing in these tests clicks it.
      if (sel.includes('.btn-primary')) return makeElement('btn-primary-stub');
      return { id: 'login-screen', classList: { contains: () => true } };
    },
    createElement: () => makeElement('tmp'),
    addEventListener(evt, cb) {
      document._listeners[evt] = document._listeners[evt] || [];
      document._listeners[evt].push(cb);
    },
  };

  let verifyCallCount = 0;
  const agent = {
    login: async () => ({ user: { id: 'u1' } }),
    getStore: async () => null,
    onScreenshot: () => {},
    onSessionExpired: () => {},
    onUpdateDownloading: () => {},
    onUpdateProgress: () => {},
    onUpdateReady: () => {},
    onUpdateError: () => {},
    verifyMonitoringCaptureFull: async () => { verifyCallCount++; return verifyMonitoringCaptureFull(); },
    openMonitoringPermissionSettings: () => {},
    getAppVersion: async () => '1.3.1',
  };

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
    Number,
  };
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'renderer.js' });
  return { context, elements, getVerifyCallCount: () => verifyCallCount };
}

function backdropActive(elements) {
  return elements.get('monitoring-permission-backdrop')?.classList.contains('active') === true;
}

test('showDashboard() runs the proactive check once, and a GRANTED result shows nothing', async () => {
  const { context, elements, getVerifyCallCount } = buildContext({
    verifyMonitoringCaptureFull: async () => ({ status: 'GRANTED', capture_error: null }),
  });
  context.showDashboard({ id: 'u1', first_name: 'Test', last_name: 'User' });
  // runProactiveMonitoringCheck is fire-and-forget from showDashboard —
  // let its microtask/promise chain settle.
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(getVerifyCallCount(), 1);
  assert.equal(backdropActive(elements), false, 'a healthy GRANTED result must not pop any modal');
});

test('a DENIED result from the proactive check pops the permission modal automatically', async () => {
  const { context, elements } = buildContext({
    verifyMonitoringCaptureFull: async () => ({ status: 'DENIED', capture_error: null }),
  });
  context.showDashboard({ id: 'u1', first_name: 'Test', last_name: 'User' });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(backdropActive(elements), true, 'DENIED must pop the blocking modal without any clock-in attempt');
  assert.match(elements.get('monitoring-permission-card').innerHTML, /Screen Monitoring Permission Required/);
});

test('a CAPTURE_FAILED result pops the capture-failed modal and surfaces the real error text', async () => {
  const { context, elements } = buildContext({
    verifyMonitoringCaptureFull: async () => ({ status: 'CAPTURE_FAILED', capture_error: 'screenCapture.exe ENOENT' }),
  });
  context.showDashboard({ id: 'u1', first_name: 'Test', last_name: 'User' });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(backdropActive(elements), true);
  const html = elements.get('monitoring-permission-card').innerHTML;
  assert.match(html, /Screenshot Capture Isn't Working/);
  assert.match(html, /screenCapture\.exe ENOENT/, 'the real captured error message must reach the employee, not a generic message');
});

test('runProactiveMonitoringCheck() does not stack a second popup on top of one already showing', async () => {
  const { context, elements, getVerifyCallCount } = buildContext({
    verifyMonitoringCaptureFull: async () => ({ status: 'DENIED', capture_error: null }),
  });
  // Simulate a modal already up (e.g. from a previous check) before the
  // periodic timer fires again.
  elements.set('monitoring-permission-backdrop', Object.assign(makeElement('monitoring-permission-backdrop')));
  elements.get('monitoring-permission-backdrop').classList.add('active');

  await context.runProactiveMonitoringCheck();

  assert.equal(getVerifyCallCount(), 0, 'must not even call the check while a modal is already showing');
});
