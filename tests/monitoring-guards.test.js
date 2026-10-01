// Unit tests for screenshot / app-usage in-flight guards and timeouts.
// Run: node --test tests/monitoring-guards.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createInFlightGuard,
  runExclusive,
  withTimeout,
  SCREENSHOT_API_TIMEOUT_MS,
  SCREENSHOT_UPLOAD_TIMEOUT_MS,
  APP_USAGE_ACTIVE_WIN_TIMEOUT_MS,
  APP_USAGE_API_TIMEOUT_MS,
} = require('../src/monitoring-guards');

test('timeout constants are bounded and sensible', () => {
  assert.ok(SCREENSHOT_API_TIMEOUT_MS > 0 && SCREENSHOT_API_TIMEOUT_MS <= 30_000);
  assert.ok(SCREENSHOT_UPLOAD_TIMEOUT_MS > SCREENSHOT_API_TIMEOUT_MS);
  assert.ok(SCREENSHOT_UPLOAD_TIMEOUT_MS <= 120_000);
  assert.ok(APP_USAGE_ACTIVE_WIN_TIMEOUT_MS > 0 && APP_USAGE_ACTIVE_WIN_TIMEOUT_MS <= 15_000);
  assert.ok(APP_USAGE_API_TIMEOUT_MS > 0 && APP_USAGE_API_TIMEOUT_MS <= 30_000);
});

test('guard: first acquire succeeds, second fails until release', () => {
  const g = createInFlightGuard('screenshot');
  assert.equal(g.tryAcquire(), true);
  assert.equal(g.isBusy(), true);
  assert.equal(g.tryAcquire(), false);
  g.release();
  assert.equal(g.isBusy(), false);
  assert.equal(g.tryAcquire(), true);
  g.release();
});

test('runExclusive: runs when free', async () => {
  const g = createInFlightGuard('screenshot');
  const result = await runExclusive(g, async () => 'ok');
  assert.equal(result, 'ok');
  assert.equal(g.isBusy(), false);
});

test('runExclusive: skips while in flight (no queue)', async () => {
  const g = createInFlightGuard('screenshot');
  const skips = [];
  let firstDone = false;

  const first = runExclusive(g, async () => {
    await new Promise((r) => setTimeout(r, 40));
    firstDone = true;
    return 'first';
  }, () => skips.push('a'));

  // Overlap while first is running
  const second = await runExclusive(g, async () => 'second', () => skips.push('skipped'));
  assert.equal(second, undefined);
  assert.deepEqual(skips, ['skipped']);
  assert.equal(await first, 'first');
  assert.equal(firstDone, true);
  assert.equal(g.isBusy(), false);

  // No unbounded queue: another run after release works
  const third = await runExclusive(g, async () => 'third');
  assert.equal(third, 'third');
});

test('runExclusive: releases guard on thrown error', async () => {
  const g = createInFlightGuard('screenshot');
  await assert.rejects(
    () => runExclusive(g, async () => { throw new Error('API failure'); }),
    /API failure/
  );
  assert.equal(g.isBusy(), false);
});

test('runExclusive: releases guard when fn resolves after simulated S3 failure path', async () => {
  const g = createInFlightGuard('screenshot');
  const out = await runExclusive(g, async () => {
    try {
      throw new Error('S3 failure');
    } catch (_) {
      return 'recorded-without-s3';
    }
  });
  assert.equal(out, 'recorded-without-s3');
  assert.equal(g.isBusy(), false);
});

test('runExclusive: releases guard on unexpected exception', async () => {
  const g = createInFlightGuard('app-usage');
  await assert.rejects(
    () => runExclusive(g, async () => { throw new TypeError('boom'); }),
    /boom/
  );
  assert.equal(g.isBusy(), false);
});

test('withTimeout: resolves when work finishes in time', async () => {
  const v = await withTimeout(Promise.resolve(42), 100, 'too slow');
  assert.equal(v, 42);
});

test('withTimeout: rejects and does not leave guard stuck when combined with runExclusive', async () => {
  const g = createInFlightGuard('screenshot');
  await assert.rejects(
    () => runExclusive(g, async () => {
      await withTimeout(new Promise(() => {}), 30, 'Timed out after 30ms');
    }),
    /Timed out after 30ms/
  );
  assert.equal(g.isBusy(), false);
});

test('app-usage: overlapping poll is skipped', async () => {
  const g = createInFlightGuard('app-usage');
  const skips = [];
  const slow = runExclusive(g, async () => {
    await new Promise((r) => setTimeout(r, 50));
    return 'poll';
  });
  const skipped = await runExclusive(g, async () => 'should-not-run', () => skips.push('poll-skipped'));
  assert.equal(skipped, undefined);
  assert.deepEqual(skips, ['poll-skipped']);
  assert.equal(await slow, 'poll');
  assert.equal(g.isBusy(), false);
});
