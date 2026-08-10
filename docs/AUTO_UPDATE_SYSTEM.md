# TekXAI Desktop Agent — Auto-Update System

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

## Security

- **Signed installers.** macOS builds are notarized (`scripts/notarize.js`,
  `afterSign` hook) and stapled (`scripts/staple-dmg.js`); `electron-updater`
  verifies the installer's signature/checksum before installing — this app
  doesn't reimplement that verification, it relies on `electron-updater`'s.
- **Never an unknown source.** The desktop app never hits GitHub or any URL
  not either (a) `api.tekxai.services` for the decision, or (b) whatever
  `electron-updater`'s own generic-provider config resolves to
  (`releases.tekxai.services`, set at build time in `package.json`, not
  something a running instance can be redirected to remotely).
- **Backend-approved only.** A version only becomes "the latest" because an
  admin explicitly published it via `POST /desktop/releases` — there's no
  path from "an installer exists somewhere" to "the fleet updates to it"
  that skips that explicit registration step.

## Known limitations (honest, not hidden)

- The force-update UI block is client-side only (see above).
- Rollback is not implemented — the admin panel's "Rollback" button is
  present and intentionally disabled, per the phased plan (see release
  process doc's "Future" section).
- This system was built and syntax/logic-verified, and the backend API +
  admin UI were verified live end-to-end (curl + browser). The Electron
  desktop app's UI itself (dialog rendering, progress bar, restart flow)
  could **not** be visually/interactively tested in the environment this was
  built in — no GUI display available to launch a real Electron window.
  Verify this on an actual machine (`npm start` for the dialog/progress UI
  against a real backend release, then a full packaged-build update cycle)
  before relying on it for a production rollout.
