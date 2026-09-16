// Regression tests for the renderer-side half of the shift-end "are you
// still working?" reminder — see src/main.js's scheduleShiftEndReminder/
// fireShiftEndReminder for the actual scheduling (untestable here; main.js
// requires 'electron' and can't be loaded outside an Electron process).
// This only verifies the renderer holds no scheduling state of its own: it
// renders whatever the show/hide/checked-out IPC events tell it, and both
// buttons forward to the corresponding IPC call — nothing more.
//
// Same hand-rolled vm/DOM harness as tests/renderer.reconcile.test.js — see
// that file's header comment for why.
//
// Run with: node --test tests/renderer.shift-end-reminder.test.js

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
    style: {},
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

  const shiftEndCallbacks = {};
  const agentCalls = { shiftEndReminderContinue: 0, shiftEndReminderCheckout: 0 };
  const defaults = {
    getStore: async () => null,
    onScreenshot: () => {},
    onSessionExpired: () => {},
    onUpdateDownloading: () => {},
    onUpdateProgress: () => {},
    onUpdateReady: () => {},
    onUpdateError: () => {},
    getToday: async () => null,
    clockOut: async () => ({}),
    clockIn: async () => ({}),
    breakStart: async () => {},
    breakEnd: async () => {},
    openDailyReport: () => {},
    onShiftEndReminderShow: (cb) => { shiftEndCallbacks.show = cb; },
    onShiftEndReminderHide: (cb) => { shiftEndCallbacks.hide = cb; },
    onShiftEndReminderCheckedOut: (cb) => { shiftEndCallbacks.checkedOut = cb; },
    shiftEndReminderContinue: async () => { agentCalls.shiftEndReminderContinue++; },
    shiftEndReminderCheckout: async () => { agentCalls.shiftEndReminderCheckout++; },
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
  return { context, agentCalls, document, shiftEndCallbacks };
}

test('shift-end-reminder:show makes the modal active', async () => {
  const { document, shiftEndCallbacks } = buildContext();
  // Boot IIFE (async, fire-and-forget in renderer.js) needs a tick to
  // register the onShiftEndReminderShow callback before we can invoke it.
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(shiftEndCallbacks.show, 'renderer did not register onShiftEndReminderShow');
  shiftEndCallbacks.show();
  assert.ok(
    document.getElementById('shift-end-reminder-backdrop').classList.contains('active'),
    'modal backdrop was not activated'
  );
});

test('shift-end-reminder:hide deactivates the modal', async () => {
  const { document, shiftEndCallbacks } = buildContext();
  await new Promise((r) => setTimeout(r, 0));
  shiftEndCallbacks.show();
  shiftEndCallbacks.hide();
  assert.ok(
    !document.getElementById('shift-end-reminder-backdrop').classList.contains('active'),
    'modal backdrop was not deactivated'
  );
});

test('"Yes, Continue Working" forwards to shiftEndReminderContinue and hides the modal — never flips local state itself', async () => {
  const { context, agentCalls, document, shiftEndCallbacks } = buildContext();
  await new Promise((r) => setTimeout(r, 0));
  shiftEndCallbacks.show();
  await context.shiftEndReminderContinue();
  assert.equal(agentCalls.shiftEndReminderContinue, 1);
  assert.ok(!document.getElementById('shift-end-reminder-backdrop').classList.contains('active'));
});

test('"No, Check Out" forwards to shiftEndReminderCheckout', async () => {
  const { context, agentCalls } = buildContext();
  await new Promise((r) => setTimeout(r, 0));
  await context.shiftEndReminderCheckout();
  assert.equal(agentCalls.shiftEndReminderCheckout, 1);
});

test('shift-end-reminder:checked-out applies the clock-out result and hides the modal', async () => {
  const { context, document, shiftEndCallbacks } = buildContext();
  await new Promise((r) => setTimeout(r, 0));
  shiftEndCallbacks.show();
  shiftEndCallbacks.checkedOut({ duration_sec: 3600 });
  assert.ok(!document.getElementById('shift-end-reminder-backdrop').classList.contains('active'));
  assert.equal(document.getElementById('tracker-time').textContent, '1h:00m:00s');
});

test('a failed checkout does not throw and does not apply a clock-out result on its own', async () => {
  // shiftEndReminderCheckout() must never flip clockedIn/clockedOut itself
  // on a failure — only the main-process 'shift-end-reminder:checked-out'
  // event (driven by a real backend response) may do that.
  const { context, document } = buildContext({
    shiftEndReminderCheckout: async () => { throw new Error('network error'); },
  });
  await new Promise((r) => setTimeout(r, 0));
  await assert.doesNotReject(context.shiftEndReminderCheckout());
  assert.notEqual(document.getElementById('tracker-time').textContent, '0h:00m:00s');
});
