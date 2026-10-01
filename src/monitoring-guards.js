// Pure helpers for screenshot / app-usage in-flight protection.
// Kept out of main.js so node:test can exercise them without Electron.
//
// Contract: at most one operation of each kind runs at a time. Overlapping
// ticks skip (no queue). The guard is always cleared in finally.

'use strict';

/** Small JSON API calls (presign, record, session recover). */
const SCREENSHOT_API_TIMEOUT_MS = 15_000;
/** S3 PUT of a full-resolution PNG (can be multi-MB on Retina). */
const SCREENSHOT_UPLOAD_TIMEOUT_MS = 60_000;
/** Native active-window helper should return almost immediately. */
const APP_USAGE_ACTIVE_WIN_TIMEOUT_MS = 5_000;
/** App-usage POST — same ballpark as monitoring heartbeat. */
const APP_USAGE_API_TIMEOUT_MS = 10_000;

function createInFlightGuard(label) {
  let busy = false;
  return {
    isBusy: () => busy,
    /** @returns {boolean} true if this caller acquired the lock */
    tryAcquire() {
      if (busy) return false;
      busy = true;
      return true;
    },
    release() {
      busy = false;
    },
    get label() {
      return label;
    },
  };
}

/**
 * Run `fn` only if the guard is free. Skipped runs invoke `onSkip` and
 * resolve to undefined. Always releases in finally when acquired.
 */
async function runExclusive(guard, fn, onSkip) {
  if (!guard.tryAcquire()) {
    if (typeof onSkip === 'function') onSkip();
    return undefined;
  }
  try {
    return await fn();
  } finally {
    guard.release();
  }
}

/**
 * Reject if `promise` does not settle within `ms`. Does not cancel the
 * underlying work (native helpers / axios abort where supported separately);
 * callers must not retain large inputs past this race.
 */
function withTimeout(promise, ms, message) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || `Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

module.exports = {
  SCREENSHOT_API_TIMEOUT_MS,
  SCREENSHOT_UPLOAD_TIMEOUT_MS,
  APP_USAGE_ACTIVE_WIN_TIMEOUT_MS,
  APP_USAGE_API_TIMEOUT_MS,
  createInFlightGuard,
  runExclusive,
  withTimeout,
};
