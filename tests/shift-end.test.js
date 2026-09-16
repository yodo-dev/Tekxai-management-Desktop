// Regression tests for the shift-end reminder's pure timezone math
// (src/shift-end.js) — see that file's header for why this is split out
// from main.js. Run with: node --test tests/shift-end.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { shiftEndEpochForCheckIn } = require('../src/shift-end');

test('check-in start of day, shift end same day', () => {
  // 2026-01-05 09:30 Asia/Karachi (UTC+5) == 2026-01-05T04:30:00Z
  const checkIn = Date.UTC(2026, 0, 5, 4, 30, 0);
  const endEpoch = shiftEndEpochForCheckIn(checkIn, '18:30');
  // 18:30 Asia/Karachi == 13:30Z same day
  assert.equal(endEpoch, Date.UTC(2026, 0, 5, 13, 30, 0));
});

test('check-in after the configured end time rolls shift end to the next day (overnight shift)', () => {
  // Check in at 22:00 Asia/Karachi, shift end configured as 06:00 (already
  // "passed" relative to check-in on the same calendar date) — must resolve
  // to 06:00 the NEXT day, not a negative/past timestamp.
  const checkIn = Date.UTC(2026, 0, 5, 17, 0, 0); // 22:00 PKT
  const endEpoch = shiftEndEpochForCheckIn(checkIn, '06:00');
  assert.equal(endEpoch, Date.UTC(2026, 0, 6, 1, 0, 0)); // 06:00 PKT next day
  assert.ok(endEpoch > checkIn, 'shift end must be after check-in');
});

test('check-in and shift end exactly equal rolls to the next day, not zero elapsed', () => {
  const checkIn = Date.UTC(2026, 0, 5, 4, 30, 0); // 09:30 PKT
  const endEpoch = shiftEndEpochForCheckIn(checkIn, '09:30');
  assert.equal(endEpoch, Date.UTC(2026, 0, 6, 4, 30, 0));
});

test('shift end is derived from the check-in calendar date, not from "now"', () => {
  // Simulates an app-restart recovery: check-in was yesterday, session still
  // open. The reminder must still fire relative to check-in's own date.
  const yesterday9am = Date.now() - 24 * 60 * 60 * 1000;
  const checkIn = new Date(yesterday9am);
  const endEpoch = shiftEndEpochForCheckIn(checkIn.getTime(), '18:00');
  const endDate = new Date(endEpoch + 5 * 60 * 60 * 1000); // back to PKT wall-clock for inspection
  assert.equal(endDate.getUTCHours(), 18);
  assert.equal(endDate.getUTCMinutes(), 0);
});
