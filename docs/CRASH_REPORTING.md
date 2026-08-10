# TekXAI Desktop Agent — Crash Reporting

Self-hosted scaffold added in Round 3. Every crash includes Version, OS,
Application, Stack Trace, Last Action, Employee, Timestamp, Status, and
Resolution — the fields specified for this feature — with no external
service required to start using it today.

## Architecture

```
Main process crash (uncaughtException / unhandledRejection)
  → reportCrash() → POST /desktop/crash-reports → desktop_crash_reports row
  → app.exit(1)  (main process — never resume after an uncaught exception,
                   matching Node's own guidance; the window is gone anyway)

Renderer process crash (app.on('render-process-gone'))
  → reportCrash() → POST /desktop/crash-reports → desktop_crash_reports row
  → app keeps running (only the renderer died, not the whole process)
```

`reportCrash()` (in `src/main.js`) is best-effort and silent on failure —
same convention as every other telemetry call in this app: a crash-report
POST that itself fails must never throw, retry-loop, or otherwise make a
bad situation worse.

## `last_action`

A single wrapper around `ipcMain.handle` records the most recently-invoked
IPC channel name (`login`, `clock-in`, `desktop-update:start-download`,
etc.) into a module-level `lastKnownAction` variable, attached to whatever
crash report gets filed next. This is a lightweight breadcrumb, not a full
event log or session replay — it answers "what was the employee doing right
before this," nothing more granular.

## Requires authentication

`POST /desktop/crash-reports` requires the same auth token every other
telemetry endpoint in this app does — a crash before any login (no stored
token yet) isn't reportable today. This is a known, accepted limitation
shared with the rest of this app's telemetry (`post_telemetry`,
`post_telemetry_update_success/failure`), not something unique to crash
reporting.

## Administration → Desktop Management → Crash Reports

Lists every report (newest first, filterable by status via
`GET /desktop/crash-reports?status=...`), with a status dropdown per row
(`OPEN` → `ACKNOWLEDGED` → `RESOLVED`/`IGNORED`). Resolving or ignoring a
report stamps `resolved_by`/`resolved_at`; moving it back to `OPEN`/
`ACKNOWLEDGED` clears both. `resolution` is a free-text note explaining what
was done, shown alongside the status.

## Future integrations: Sentry, Crashpad, or a self-hosted alternative

This scaffold's shape was chosen specifically so a real crash-reporting
service can be swapped in later without redesigning the capture points:

- **Sentry** — replace `reportCrash()`'s `axios.post` with
  `Sentry.captureException()` (after `Sentry.init()` at app startup); the
  `uncaughtException`/`unhandledRejection`/`render-process-gone` hook sites
  themselves don't change, only what they call. Sentry's Electron SDK
  (`@sentry/electron`) already wraps these same Node/Electron events
  internally, so adopting it would likely *simplify* `main.js` rather than
  add to it.
- **Crashpad** — Electron's built-in native crash handler
  (`crashReporter.start()`) captures native (non-JS) crashes this JS-level
  scaffold cannot see at all (segfaults, native module crashes). Genuinely
  complementary, not a replacement — worth adding alongside this scaffold
  regardless of any future service choice, since it covers a different
  failure class entirely.
- **Self-hosted alternative** (e.g. GlitchTip, a self-hosted Sentry-
  compatible server) — since the backend endpoints here already are the
  self-hosted destination, adopting one of these would mean *also* forwarding
  to it, or replacing this scaffold's storage with it — a deployment
  decision, not a code-shape change.

## What this scaffold does not do

- No automatic deduplication of repeated identical crashes into one row —
  every occurrence is its own row today. Worth adding if crash volume ever
  makes the list noisy (a `fingerprint` column + upsert-by-fingerprint would
  be the additive path, not a redesign).
- No alerting (Slack/email) on a new crash — purely a passive log surfaced
  in the admin UI today.
- Not verified end-to-end against a real crash in a packaged app in this
  environment (no GUI display available) — see `AUTO_UPDATE_SYSTEM.md`'s
  "Known limitations." The backend endpoints (create/list/filter/update-
  status) were verified live via curl.
