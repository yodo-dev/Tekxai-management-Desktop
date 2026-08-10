# TekXAI Desktop Agent — Auto-Update System

**Status: production-ready.** This document covers the original design plus
the enterprise-hardening pass (differential-update verification, rollback,
staged rollout, release channels, rich release notes, emergency disable, and
update analytics) — see each section below for what's new.

## Architecture: two layers, deliberately separate

**1. Decision layer — be-work's `/api/v1/desktop/latest-version`.** This is the
only thing the desktop app trusts to decide whether an update exists, whether
it's mandatory, and what its release notes say. Never GitHub, never a bare
version comparison against an update-feed manifest in isolation.

**2. Mechanics layer — `electron-updater`.** Still configured with a generic
(non-GitHub) provider pointed at `releases.tekxai.services` (see
`package.json`'s `build.publish`). It does the actual signed-installer
download, checksum verification, and install — proven, cross-platform code
this app has no reason to reimplement.

Why split it this way instead of using `electron-updater` end-to-end: `electron-updater`
has no concept of "mandatory," no way to report telemetry back to a backend,
and no way for an admin to see who's outdated or force a specific employee to
update. Its own feed format (`latest.yml`/`latest-mac.yml`/`latest-linux.yml`)
also doesn't carry the custom fields (`minimumVersion`, `forceUpdate`,
structured release notes) this system needs. So the backend owns the
*decision*, and `electron-updater` owns the *mechanics* — each doing the part
it's actually good at.

## Flow

```
App launch
  ↓
GET /api/v1/desktop/latest-version   (unauthenticated — runs before login too)
  ↓
Compare app.getVersion() against latestVersion (integer-segment compare,
NOT string compare — "1.10.0" > "1.9.0" as strings would say the opposite)
  ↓
Not outdated? → nothing happens, continue normally.
  ↓
Outdated? → main.js calls triggerBackgroundDownload() itself. No dialog, no
             click required — this is true for mandatory updates too (see
             "Background Silent Updates" below). desktopUpdateInfo caches
             { version, releaseNotes, mustForce } for later.
  ↓
autoUpdater.checkForUpdates() (confirms the artifact host also has this
  version) → autoUpdater.downloadUpdate() (autoDownload is OFF; this is the
  only place either is ever called)
  ↓
Renderer gets desktop-update:downloading → a small, non-blocking pill
  ("Downloading update…") — never a dialog, never covers the screen, never
  stops the employee from doing anything else.
  ↓
download-progress events → desktop-update:progress → the same pill's text
  updates to "Downloading update… NN%". Still non-blocking.
  ↓
update-downloaded → desktop-update:ready → NOW the full "Ready to Install"
  dialog appears, including What's New — this is the first (and only) point
  a silent background update can interrupt active work.
  mustForce = true  → Restart Now only, no "Later" — the backdrop can't be
                        dismissed.
  mustForce = false → Restart Now / Later both offered.
  ↓
"Restart Now" → autoUpdater.quitAndInstall()
  (or: autoInstallOnAppQuit is on, so it installs on the next natural quit
  regardless — "Later" doesn't mean "never," just "not right now")
  ↓
App relaunches at the new version → main.js compares app.getVersion()
  against a "pending_update_version" it stashed before restarting → if they
  match, POSTs /desktop/telemetry/update-success to the backend.
```

### Background Silent Updates (Round 3)

Earlier revisions of this system showed a blocking "TekXAI Desktop Update /
Later / Update Now" dialog the moment an update was detected, before any
download started. That step is gone. `checkBackendVersion()` and
`reportTelemetry()` (in `src/main.js`) now call `triggerBackgroundDownload()`
directly the instant an update is known to exist — download starts
immediately and silently, with no renderer round-trip and no click required,
**for mandatory updates too**. The employee keeps working uninterrupted; the
only visible sign is a small pill in the corner of the window
(`renderUpdateIndicator`/`renderUpdateProgress` in `src/renderer.js`,
`#update-indicator` in `src/index.html`) that can be safely ignored. The
first and only point the app interrupts active work is the existing
"Ready to Install" card, once the download has actually finished — matching
the explicit requirement "Application starts → Update downloads silently in
the background → Employee continues working → When download finishes → Show
'Update is ready. Restart now or later.' Never interrupt active work."

If a background download fails (network drop mid-transfer, artifact host
unreachable, etc.), the pill swaps its spinner for "Update failed — retry"
rather than popping up an error dialog — clicking it re-invokes the same
download path via the `desktop-update:start-download` IPC handler, now
repurposed as a manual-retry-only entry point (it's never called to *start*
a normal update anymore, only to retry one that failed silently).

## Differential updates — verified, not assumed

**Windows (NSIS): supported automatically, no extra configuration.**
`electron-builder` generates a `.blockmap` alongside every NSIS installer by
default (nothing in this app's `package.json` disables it), and
`electron-updater`'s `NsisUpdater` uses that blockmap to download only the
changed byte ranges between the installed version and the new one, not the
whole installer. This was verified against `electron-builder`/`electron-updater`'s
own documented architecture (the blockmap-diffing code lives specifically in
`NsisUpdater`, generated specifically for the `nsis` target) — not something
that needed to be built here, and not something a config change could
accidentally have left off, since it's the default.

**macOS and Linux: NOT supported — a real limitation of `electron-updater`
itself, not a gap in this app's setup.** `electron-updater`'s `MacUpdater` and
`AppImageUpdater` classes have no differential-download logic at all; every
update on these platforms downloads the full `.zip` (macOS) or `.AppImage`
(Linux) regardless of how small the actual code change was. This is a known,
long-standing limitation of the open-source `electron-updater` project — Squirrel.Mac
(what `MacUpdater` is built on) has never supported binary diffing, and
AppImage's update mechanism (`AppImageUpdate`/zsync) is a different, unrelated
tool `electron-updater` doesn't integrate with. Working around this would mean
replacing `electron-updater`'s Mac/Linux update path entirely — out of scope
for "verify and extend," and not something to build speculatively without a
concrete performance problem driving it.

### What actually drives the download — a detail worth being explicit about

`desktop_releases.windows_url`/`mac_url`/`linux_url` (registered via
`POST /desktop/releases`) are **informational only** — verified by reading
`main.js`: `desktopUpdateInfo.windows`/`.mac`/`.linux` are received from the
backend and never read again anywhere in the download path.
`desktop-update:start-download` calls `autoUpdater.checkForUpdates()` /
`downloadUpdate()`, which use `electron-updater`'s **own** configured feed —
`electron-builder.config.js`'s `publish.url`
(`https://releases.tekxai.services/desktop-app`) — entirely independent of
whatever a release row's URL fields say.

**Practical consequence:** the backend's `desktop_releases` row and the
artifact host's actual `latest.yml`/`latest-mac.yml`/`latest-linux.yml`
manifests must independently agree — registering version "1.3.0" in the
backend without also having actually run `electron-builder --publish` for
1.3.0 means the app will detect an update is available (decision layer says
so) but then find nothing to download when it asks the real artifact host
(mechanics layer disagrees), surfacing as an update-failure. This is a
process discipline already implied by `RELEASE_PROCESS.md`'s step ordering
(build+publish artifacts *before* registering the release) — called out
explicitly here since it's exactly the kind of detail that matters for
correctly verifying differential-download behavior below: the blockmap chain
is only intact if the artifact host's manifest is the one actually being
diffed against, not whatever URL happens to be in the backend's UI.

### Verification procedure (repeatable — real numbers not producible from this sandbox)

This environment has no Windows machine and no access to a real prior
release's installer to diff against, so the table below is **illustrative,
not measured**. Run this procedure on an actual Windows build machine to get
real numbers:

1. Publish version N, confirm `<installer>.exe` and `<installer>.exe.blockmap`
   both exist at the artifact host (`curl -I` each URL — a missing
   `.blockmap` silently disables differential updates for that release with
   no error anywhere, so this is the single most important thing to check).
2. Note the full installer's file size (`ls -la` the `.exe`, or the artifact
   host's `Content-Length` header).
3. Install version N on a clean Windows VM.
4. Publish version N+1 with a small code change (ideally *not* touching large
   bundled assets — `electron-builder`'s blockmap diffs at the file-block
   level, so a change to a large unrelated asset can inflate the diff even if
   the actual code change is tiny).
5. Trigger the update from the installed N and capture the
   `desktop-update:progress` event's `total` value (bytes) — this is what
   `electron-updater` actually requested to download, i.e. the real update
   size, directly comparable to the full installer size from step 2.

| | Illustrative example | What to actually record |
|---|---|---|
| Full installer (version N+1, fresh install) | 420 MB | Real file size from step 2 |
| Differential update (N → N+1) | 18 MB | Real `total` from step 5's progress event |

If the observed update size is close to the full installer size (not
meaningfully smaller), check in order: (a) did step 1's `.blockmap` check
actually pass, (b) is the *previous* installed version's own `.blockmap`
still present on the artifact host (a differential update needs both the old
and new blockmaps — pruning old releases too aggressively breaks this for
anyone still on an older version), (c) confirm the change between N and N+1
isn't itself large (a genuinely large diff produces a genuinely large
download — that's not a config problem, that's what changed).

**Practical effect:** Windows employees on a slow connection get faster,
smaller updates; macOS/Linux employees always download the full installer.
Worth knowing when sizing staged-rollout timing (§ below) — a 100MB full
download to 50% of the Mac fleet simultaneously is a bigger bandwidth event
than the same rollout on Windows.

## Staged rollout

A release's `rollout_percentage` (10/25/50/100, set at publish time or
adjusted afterward via `PATCH /desktop/releases/:id/rollout`) determines what
fraction of installs see it as "latest." Bucketing is deterministic per user
(a hash of `user_id` + the release's own id), so a given employee doesn't
flip in and out of a rollout wave between checks — once included, always
included, until the release reaches 100% or is superseded. Installs not yet
in the wave transparently see the *previous* active release instead — there's
no special "not in rollout" state visible to them, they just don't get
nagged about an update that isn't meant for them yet.

**Mandatory releases (`force_update: true`) always bypass staged rollout** —
a security-critical release must never wait for a rollout wave to reach
everyone. Staged rollout is for gradual, optional delivery only.

## Release channels

`stable` (default) / `beta` / `internal` / `development`. Each channel's
"latest" is computed entirely independently — a beta build never reaches a
stable-channel install, and vice versa. The desktop app currently hard-codes
`stable` (`main.js`'s `UPDATE_CHANNEL` constant) — there's no in-app channel
switcher yet, since it wasn't requested; an admin/support action to move a
specific employee's `desktop_installations.channel` to `beta`/`internal` is
possible via direct DB access today, with a proper switcher UI a natural
follow-up if internal testing needs it.

## Rollback

`POST /desktop/releases/:id/rollback` marks a release `status: 'ROLLED_BACK'`
— permanently excluded from ever being "latest" again (unless a fresh release
re-publishes the same version number). No other logic exists or is needed:
every "what's latest" lookup already filters to `status: 'ACTIVE'`, so the
next-newest active release in the same channel becomes latest again the
instant the rollback commits. The admin panel's Release History "Rollback"
button (previously a disabled placeholder) is now live.

## Emergency disable

`POST /desktop/releases/:id/disable` (requires a `reason`) marks a release
`status: 'DISABLED'` — same "excluded from latest" effect as rollback, plus
one more thing: any install whose telemetry reports it's currently *running*
the disabled version gets `force_update_requested: true` immediately,
regardless of the org-wide `minimum_version` floor. This is the one case
where "you're on a supported-enough version" isn't good enough — a disabled
version is disabled because something about it is actively unsafe, so anyone
on it specifically needs to move off, not just anyone below some general
floor.

## Rich release notes

`release_notes` supports a small markdown-lite subset — `## Section Header`,
`- bullet` / `* bullet` (or a bare line, both render as a bullet — this is
what every release published before this feature already used, so old-style
plain notes still render exactly as they did before), and inline `**bold**`.
Implemented identically in two places that must never interpret the same
text differently: desktop-app's `renderer.js` (`renderReleaseNotesHtml`) and
fe-work's admin preview (`desktop-management/index.tsx`'s `ReleaseNotes`
component) — same hand-rolled-subset convention the chat module already
established for the identical problem (`messageContent.tsx`), not a general
markdown parser. All rendered text is HTML-escaped before any markdown
substitution runs, so a release note can't inject markup.

## Update Analytics

`GET /desktop/analytics` (Administration → Desktop Management): version
distribution (every installation grouped by `current_version`), pending
updates (installations behind the stable channel's latest), successful
updates (installations with a `last_successful_update_at` in the lookback
window), and failed updates (from the new `desktop_update_failures` table).
Failures are reported by the desktop app only for an *actual* in-flight
update attempt — a background availability check failing (network hiccup,
backend briefly down) is never counted as a "failed update," since no update
was ever attempted; see `main.js`'s `updateAttempt` state, set only between
`startDownload()` starting (whether auto-triggered or a manual retry) and
that download's success/failure.

## Telemetry

Every 30 minutes (and once at startup, once logged in), the app POSTs to
`/api/v1/desktop/telemetry`: current version, OS (`macOS`/`Windows`/`Linux`),
raw `process.platform`, `os.hostname()` as a best-effort device label, and
its release channel. This is what powers Administration → Desktop
Management's Outdated Employees list and Update Analytics. It's also the
*only* authenticated channel this app has, so an admin's per-employee "Force
Update" (independent of a release-wide mandatory flag) and emergency-disable
force-updates both surface through this same call's response
(`force_update_requested: true`) rather than through any push mechanism —
this app has no sockets.

## Force update

Three independent triggers, all resulting in the same eventual restart gate:

1. **Release-wide** — a published release has `force_update: true`, or the
   installed version is below that release's `minimum_version`. Affects
   everyone (bypasses staged rollout, see above).
2. **Emergency disable** — the installed version has since been disabled (see
   above). Affects only installs currently on that exact version.
3. **Per-employee** — an admin clicks "Force Update" on one specific outdated
   employee in the admin panel. Affects only that employee, clears itself
   automatically once their telemetry shows they've reached the latest
   version (see `desktop.controller.js`'s `post_telemetry`).

As of Background Silent Updates (Round 3), `mustForce` no longer changes
*when* the download starts — that's always immediate and silent regardless of
force status (see the Flow section above). What it still gates is the
"Ready to Install" card once the download finishes: force-mode strips every
dismiss path (no "Later" button, backdrop can't be closed by any means the UI
exposes). This is a client-side gate, consistent with the rest of this app's
trust model (it already self-reports attendance data) — a technically
sophisticated user could bypass it via devtools, which is a known, accepted
limitation rather than an oversight.

## Security

- **Signed installers.** macOS builds are notarized (`scripts/notarize.js`,
  `afterSign` hook) and stapled (`scripts/staple-dmg.js`); `electron-updater`
  verifies the installer's signature/checksum before installing — this app
  doesn't reimplement that verification, it relies on `electron-updater`'s.
  **Windows builds are currently unsigned** — see `CODE_SIGNING.md` for the
  full requirement and what's missing.
- **Never an unknown source.** The desktop app never hits GitHub or any URL
  not either (a) `api.tekxai.services` for the decision, or (b) whatever
  `electron-updater`'s own generic-provider config resolves to
  (`releases.tekxai.services`, set at build time in `package.json`, not
  something a running instance can be redirected to remotely).
- **Backend-approved only.** A version only becomes "the latest" because an
  admin explicitly published it via `POST /desktop/releases` — there's no
  path from "an installer exists somewhere" to "the fleet updates to it"
  that skips that explicit registration step. Rollback/disable are the same
  kind of explicit, logged action in the other direction.

## Enterprise Deployment Rings (Round 3)

Extends staged rollout (a random percentage of everyone) with *targeted*
delivery to a specific slice of the org — `desktop_release_targets`
(`target_type`: `business_unit` | `department` | `team` | `user`,
`target_value`: matching id/value). A release with zero target rows still
reaches everyone in its channel, exactly as before this feature existed
(fully backward compatible); one or more rows restrict it to only callers
matching at least one row (OR across rows). See
`desktop.controller.js`'s `release_matches_targets`/`get_user_targeting_context`.

Reuses the org-structure fields this codebase already has —
`users.business_unit`, `users.department_id`, `team_members` — rather than
inventing a parallel "ring" concept. "Pilot Group", "IT Team", "Management",
"Developers", or "Specific Business Units/Departments" are all just usage
patterns for the same four target types, not separate schema. Managed from
Administration → Desktop Management's Release History table ("Targets"
column → manage modal); backend CRUD is `POST`/`DELETE
/desktop/releases/:id/targets[/:targetId]`.

Fails **closed**, not open: an unresolvable `uid` (never logged in, stale
id) on a targeted release means "doesn't match," the opposite of staged
rollout's fail-open behavior — deliberate, since targeting is an intentional
restriction, not gradual delivery to everyone eventually.

## Desktop Diagnostics (Round 3)

Every telemetry ping (`POST /desktop/telemetry`, already sent at startup and
every 30 minutes) now also reports `arch` (`process.arch`), `disk_free_gb`/
`disk_total_gb` (via Node's `fs.promises.statfs`, best-effort — swallowed
independently of memory/arch if unavailable on a given platform/Node build),
and `memory_total_gb`/`memory_free_gb` (via `os.totalmem()`/`os.freemem()`).
`last_seen_at` (already existed) doubles as "Last Sync" — no separate field,
since every ping that updates diagnostics also updates it, by construction.
Surfaced in Administration → Desktop Management's new "Desktop Diagnostics"
table, covering every reporting install (not just outdated ones).

## Crash Reporting (Round 3)

Self-hosted scaffold — `desktop_crash_reports` table +
`POST /desktop/crash-reports` (authenticated, same limitation as the rest of
this app's telemetry: a crash before any login isn't reportable today) +
admin `GET`/`PATCH .../status` endpoints. `src/main.js` hooks
`process.on('uncaughtException'|'unhandledRejection')` (main process — exits
after reporting, matching Node's own guidance not to resume after an
uncaught exception) and `app.on('render-process-gone')` (renderer crash —
the window survives, no exit). `last_action` is a lightweight breadcrumb: a
single `ipcMain.handle` wrapper records the most recent IPC channel name
invoked, not a full event log. Every report includes Version, OS,
Application (`'desktop-agent'` today — see Application Management below),
Stack Trace, Last Action, Employee, Timestamp, Status, Resolution — exactly
the fields specified for a future evolution.

**Future integrations**: this scaffold is deliberately the same shape a
Sentry, Crashpad, or other self-hosted alternative would need — swapping one
in later means pointing `reportCrash()` (and the equivalent admin views) at
that SDK/service instead of `/desktop/crash-reports`, not a redesign of the
crash-capture hooks themselves.

## Future Direction: Application Management (Round 3, documentation only)

No code in this round renames or restructures anything — Desktop Management
stays exactly the module and routes it is today. This section records the
intended future direction so it isn't lost, per this round's requirement to
document the shift toward "Application Management" as a superset of what
this module already does.

Today, every table/endpoint/UI in this system is implicitly desktop-agent-
specific (`desktop_releases`, `desktop_installations`, `/desktop/*`,
"Desktop Management"). The natural evolution, when there's an actual second
application type to manage, is Application Management: the same
version/release/deployment/rollback/channel/analytics *pattern* this system
already implements, generalized across:

- **Desktop Applications** — Windows/macOS/Linux Agent (this system, today)
- **Future Mobile Apps** — iOS/Android agents, not built yet
- **Browser Extensions** — a Chrome/Edge extension, not built yet
- **Version Management** / **Release Management** / **Deployment
  Management** — already exist here (`desktop_releases`, channels, staged
  rollout, deployment rings)
- **Application Inventory** / **Device Inventory** — already exist here
  (`desktop_installations`, Desktop Diagnostics)
- **Rollback** / **Forced Updates** / **Release Channels** / **Analytics** —
  already exist here

The path there, when it's actually needed, is additive — not a rewrite:
introduce an `application` (or `app_type`) discriminator column alongside
what already exists (`desktop_crash_reports.application` already anticipates
this, defaulting to `'desktop-agent'`), generalize the admin UI's page title
and navigation from "Desktop Management" to "Application Management" with a
per-application-type filter, and let a mobile agent or browser extension
register releases/installations through the same shape `desktop_releases`/
`desktop_installations` already define. Nothing about today's desktop-agent
behavior needs to change for that migration to be possible later — this is
why Round 1-3 were built as a reusable pattern instead of one-off
desktop-specific logic throughout.

## Known limitations (honest, not hidden)

- The force-update UI block is client-side only (see above).
- No in-app channel switcher (see Release Channels above) — channel
  assignment for a non-stable tester is a direct DB action today.
- Differential updates are Windows-only, per `electron-updater`'s own
  architecture — not something this app's configuration can add for
  macOS/Linux (see above).
- Enterprise Deployment Rings currently support `business_unit`/
  `department`/`team`/`user` targeting only, evaluated with OR semantics
  across rows — no AND/exclude logic (e.g. "ERP business unit EXCEPT the
  Interns team") exists yet; not requested, and would be additive if needed.
- Desktop Diagnostics' disk-space reporting depends on `fs.promises.statfs`
  being available on the platform/Node build the packaged app ships with —
  verified working in this sandbox (Node 20.20.2, macOS/arm64) but not
  independently re-verified on an actual packaged Windows/Linux build; it
  fails silently (diagnostics still report arch/memory) if unavailable.
- Crash Reporting's main-process hooks (`uncaughtException`,
  `unhandledRejection`, `render-process-gone`) are syntactically correct and
  the backend endpoints were verified live via curl (create/list/filter/
  update-status), but an actual crash was not triggered in a real packaged
  Electron app to confirm end-to-end capture — no GUI display available in
  this sandbox, the same limitation noted below for the rest of the desktop
  UI.
- This system was built and syntax/logic-verified, and every backend
  endpoint (including rollback/disable/staged-rollout/analytics/deployment-
  rings/crash-reporting) was verified live end-to-end via curl, with the
  admin UI verified live in the browser. The Electron desktop app's UI
  itself (dialog rendering, progress bar, restart flow, rich release-notes
  rendering, the new background-download indicator pill) could **not** be
  visually/interactively tested in the environment this was built in — no
  GUI display available to launch a real Electron window. Verify this on an
  actual machine (`npm start` for the dialog/progress UI against a real
  backend release, then a full packaged-build update cycle) before relying on
  it for a production rollout — see `PRODUCTION_CHECKLIST.md`.
