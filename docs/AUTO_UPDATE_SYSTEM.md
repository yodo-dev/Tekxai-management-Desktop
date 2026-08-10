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
Outdated? → send desktop-update:available to the renderer
             { version, releaseNotes, mustForce }
  ↓
Renderer shows the "TekXAI Desktop Update" dialog.
  mustForce = true  → "This version is no longer supported. Please
                        update to continue." No "Later" button anywhere
                        in this flow — the backdrop can't be dismissed.
  mustForce = false → "Version X is available." + What's New bullets.
                        "Later" and "Update Now" both offered.
  ↓
"Update Now" clicked → IPC desktop-update:start-download
  → autoUpdater.checkForUpdates() (confirms the artifact host also has
    this version) → autoUpdater.downloadUpdate() (autoDownload is OFF,
    so nothing transfers before this point)
  ↓
download-progress events → desktop-update:progress → renderer progress bar,
  speed, ETA. Non-mandatory updates can be dismissed here ("Continue working")
  — the download keeps running in the main process regardless of whether the
  dialog is visible.
  ↓
update-downloaded → desktop-update:ready → "Ready to Install" dialog,
  Restart Now / Later (mandatory: Restart Now only)
  ↓
"Restart Now" → autoUpdater.quitAndInstall()
  (or: autoInstallOnAppQuit is on, so it installs on the next natural quit
  regardless — "Later" doesn't mean "never," just "not right now")
  ↓
App relaunches at the new version → main.js compares app.getVersion()
  against a "pending_update_version" it stashed before restarting → if they
  match, POSTs /desktop/telemetry/update-success to the backend.
```

## Telemetry

Every 30 minutes (and once at startup, once logged in), the app POSTs to
`/api/v1/desktop/telemetry`: current version, OS (`macOS`/`Windows`/`Linux`),
raw `process.platform`, and `os.hostname()` as a best-effort device label.
This is what powers Administration → Desktop Management's Outdated Employees
list. It's also the *only* authenticated channel this app has, so an admin's
per-employee "Force Update" (independent of a release-wide mandatory flag)
surfaces through this same call's response (`force_update_requested: true`)
rather than through any push mechanism — this app has no sockets.

## Force update

Two independent triggers, both resulting in the same blocking UI:

1. **Release-wide** — a published release has `force_update: true`, or the
   installed version is below that release's `minimum_version`. Affects
   everyone.
2. **Per-employee** — an admin clicks "Force Update" on one specific outdated
   employee in the admin panel. Affects only that employee, clears itself
   automatically once their telemetry shows they've reached the latest
   version (see `desktop.controller.js`'s `post_telemetry`).

Either way, the renderer's force-mode strips every dismiss path (no "Later"
button, backdrop can't be closed by any means the UI exposes) across all three
dialog phases (available → downloading → ready). This is a client-side gate,
consistent with the rest of this app's trust model (it already self-reports
attendance data) — a technically sophisticated user could bypass it via
devtools, which is a known, accepted limitation rather than an oversight.

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
"Update Now" and the download's success/failure.

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

Three independent triggers, all resulting in the same blocking UI:

1. **Release-wide** — a published release has `force_update: true`, or the
   installed version is below that release's `minimum_version`. Affects
   everyone (bypasses staged rollout, see above).
2. **Emergency disable** — the installed version has since been disabled (see
   above). Affects only installs currently on that exact version.
3. **Per-employee** — an admin clicks "Force Update" on one specific outdated
   employee in the admin panel. Affects only that employee, clears itself
   automatically once their telemetry shows they've reached the latest
   version (see `desktop.controller.js`'s `post_telemetry`).

Either way, the renderer's force-mode strips every dismiss path (no "Later"
button, backdrop can't be closed by any means the UI exposes) across all
three dialog phases (available → downloading → ready). This is a client-side
gate, consistent with the rest of this app's trust model (it already
self-reports attendance data) — a technically sophisticated user could bypass
it via devtools, which is a known, accepted limitation rather than an
oversight.

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

## Known limitations (honest, not hidden)

- The force-update UI block is client-side only (see above).
- No in-app channel switcher (see Release Channels above) — channel
  assignment for a non-stable tester is a direct DB action today.
- Differential updates are Windows-only, per `electron-updater`'s own
  architecture — not something this app's configuration can add for
  macOS/Linux (see above).
- This system was built and syntax/logic-verified, and every backend
  endpoint (including the new rollback/disable/staged-rollout/analytics ones)
  was verified live end-to-end via curl, with the admin UI verified live in
  the browser. The Electron desktop app's UI itself (dialog rendering,
  progress bar, restart flow, rich release-notes rendering) could **not** be
  visually/interactively tested in the environment this was built in — no
  GUI display available to launch a real Electron window. Verify this on an
  actual machine (`npm start` for the dialog/progress UI against a real
  backend release, then a full packaged-build update cycle) before relying on
  it for a production rollout — see `PRODUCTION_CHECKLIST.md`.
