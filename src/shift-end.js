// Pure helper for the shift-end reminder feature (main.js) — split out from
// main.js specifically so it can be unit-tested directly with `node --test`
// without pulling in Electron (main.js requires 'electron' at the top of the
// file, which throws outside an Electron process). No side effects, no
// module state.

// Asia/Karachi (Pakistan Standard Time) has had no DST since 2009 — a fixed
// UTC+5 offset, same assumption COMPANY_TIMEZONE (renderer.js) already makes
// for every displayed check-in time. This is the company's fixed timezone
// offset, not a hardcoded shift length — the shift's own start/end times
// always come from GET /attendance/my-shift, never from this constant.
const COMPANY_TZ_OFFSET_MS = 5 * 60 * 60 * 1000;

// Given a check-in epoch (ms) and the shift's "HH:MM" end time
// (company-local, 24h), returns the epoch ms of that shift's end on the
// check-in's calendar date — or the next day's, if end_time has already
// passed relative to check-in (covers an overnight shift, or restoring a
// session that started yesterday and is still open).
function shiftEndEpochForCheckIn(checkInEpoch, endTimeStr) {
  const [eh, em] = endTimeStr.split(':').map(Number);
  const companyLocal = new Date(checkInEpoch + COMPANY_TZ_OFFSET_MS);
  const y = companyLocal.getUTCFullYear();
  const m = companyLocal.getUTCMonth();
  const d = companyLocal.getUTCDate();
  let endEpoch = Date.UTC(y, m, d, eh, em, 0) - COMPANY_TZ_OFFSET_MS;
  if (endEpoch <= checkInEpoch) endEpoch += 24 * 60 * 60 * 1000;
  return endEpoch;
}

module.exports = { shiftEndEpochForCheckIn, COMPANY_TZ_OFFSET_MS };
