// Regression tests for the double-login-request bug.
//
// Root cause: doLogin() had no re-entrancy guard, and has two independent
// trigger paths — the Sign In button's own onclick, and a document-level
// Enter keydown listener that also calls doLogin() directly. If focus is
// ever on the button itself, pressing Enter fires BOTH the browser's native
// synthetic click on the focused button AND the keydown listener in the
// same tick, before either call's `btn.disabled = true` could block the
// other — producing two simultaneous /auth/login requests from one
// keypress, which can trip a server-side rate limiter.
//
// Uses the same node:vm sandboxed-DOM harness as renderer.reconcile.test.js
// (no jsdom/jest in this project) to load the real renderer.js unmodified.
//
// Run with: node --test tests/renderer.login.test.js

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

function buildContext(loginImpl) {
  const elements = new Map();
  elements.set('email', Object.assign(makeElement('email'), { value: 'user@tekxai.com' }));
  elements.set('password', Object.assign(makeElement('password'), { value: 'hunter2' }));
  elements.set('login-btn', makeElement('login-btn'));
  elements.set('login-error', makeElement('login-error'));

  const document = {
    _listeners: {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector: () => ({ id: 'login-screen', classList: { contains: () => true } }),
    createElement: () => makeElement('tmp'),
    addEventListener(evt, cb) {
      document._listeners[evt] = document._listeners[evt] || [];
      document._listeners[evt].push(cb);
    },
  };

  let loginCallCount = 0;
  const agent = {
    login: async (...args) => { loginCallCount++; return loginImpl(...args); },
    getStore: async () => null,
    onScreenshot: () => {},
    onSessionExpired: () => {},
    onUpdateDownloading: () => {},
    onUpdateProgress: () => {},
    onUpdateReady: () => {},
    onUpdateError: () => {},
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
  return { context, elements, getLoginCallCount: () => loginCallCount };
}

test('doLogin() re-entrancy guard: two calls before the first resolves produce exactly one /auth/login request', async () => {
  let resolveLogin;
  const pending = new Promise((resolve) => { resolveLogin = resolve; });
  const { context, elements, getLoginCallCount } = buildContext(async () => {
    await pending;
    return { user: { id: 'u1', name: 'Test User' } };
  });

  // First call starts and awaits the pending login (btn.disabled = true is
  // set synchronously before the first await, matching the real bug's
  // exact race window).
  const first = context.doLogin();
  assert.equal(elements.get('login-btn').disabled, true, 'button must be disabled while a login is in flight');

  // Second call — simulates the dual click+keydown-Enter re-entrant
  // invocation. Must be a no-op, not a second network call.
  const second = context.doLogin();

  resolveLogin();
  await Promise.all([first, second]);

  assert.equal(getLoginCallCount(), 1, 'exactly one login request must have been made, not two');
});

test('doLogin() allows a fresh login after a previous one completes (guard does not get stuck)', async () => {
  const { context, getLoginCallCount } = buildContext(async () => ({ user: { id: 'u1', name: 'Test User' } }));
  await context.doLogin();
  await context.doLogin();
  assert.equal(getLoginCallCount(), 2, 'the guard must not block legitimate sequential login attempts');
});

test('loginErrorMessage: a 429 with retryAfter produces a friendly, specific wait message', () => {
  const { context } = buildContext(async () => { throw new Error('unused'); });
  const msg = context.loginErrorMessage({ status: 429, retryAfter: '120', message: 'Request failed with status code 429' });
  assert.match(msg, /too many login attempts/i);
  assert.match(msg, /2 minute/i);
  assert.doesNotMatch(msg, /Request failed with status code/i, 'the raw Axios/IPC error text must never reach the user');
});

test('loginErrorMessage: a 429 with no retryAfter still produces a friendly generic message', () => {
  const { context } = buildContext(async () => { throw new Error('unused'); });
  const msg = context.loginErrorMessage({ status: 429, message: 'Request failed with status code 429' });
  assert.match(msg, /too many login attempts/i);
  assert.doesNotMatch(msg, /Request failed with status code/i);
});

test('loginErrorMessage: a normal (non-429) error still surfaces its real message unchanged', () => {
  const { context } = buildContext(async () => { throw new Error('unused'); });
  const msg = context.loginErrorMessage({ message: 'Invalid email or password' });
  assert.equal(msg, 'Invalid email or password');
});

test('doLogin() end to end: a 429 IPC rejection is shown as the friendly message, not the raw error, and re-enables the button', async () => {
  const { context, elements } = buildContext(async () => {
    const e = new Error("Error invoking remote method 'login': Error: Request failed with status code 429");
    e.status = 429;
    e.retryAfter = '60';
    throw e;
  });

  await context.doLogin();

  assert.match(elements.get('login-error').textContent, /too many login attempts/i);
  assert.doesNotMatch(elements.get('login-error').textContent, /invoking remote method/i);
  assert.equal(elements.get('login-btn').disabled, false, 'button must re-enable after a failed attempt so the user can retry');
});
