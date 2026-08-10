# TekXAI Desktop Agent — Deployment Guide

A step-by-step walkthrough for deploying a new desktop-agent version to the
company, written for someone doing this for the first time. `RELEASE_PROCESS.md`
is the terse reference this guide expands on — read that first if you just
need the commands, come here if you want the reasoning at each step.

## Before you start

- You need a `SUPER_ADMIN` account — Desktop Management's publish/rollback/
  disable/target actions are all gated to that role (matches System
  Settings/Email Logs precedent — see `AUTO_UPDATE_SYSTEM.md`'s "Security").
- Confirm which machine builds which platform — per this repo's existing
  convention, macOS/dmg and Windows/exe are built on two different
  developer machines from the same source commit/tag, not cross-compiled.
- If this release needs Windows code signing, confirm the signing
  environment variables are set on the Windows build machine *before*
  building — see `CODE_SIGNING.md`. An unsigned Windows build isn't a build
  failure (the config warns loudly and proceeds), so it's easy to miss.

## Step 1 — Decide what kind of release this is

| This release is... | Do this |
|---|---|
| A routine feature/bug-fix update | Channel `stable`, rollout 100%, not mandatory |
| Something you want to validate on a small group first | Channel `stable`, rollout 10-50%, widen later — see `ENTERPRISE_ROLLOUT_GUIDE.md` |
| A security fix everyone must get immediately | Channel `stable`, `force_update: true` (bypasses staged rollout and downloads immediately in the background for everyone — see Background Silent Updates in `AUTO_UPDATE_SYSTEM.md`) |
| For internal testers/a pilot group only, not the whole company yet | Channel `internal`/`beta`/`development`, or `stable` + a deployment-ring target — see below |

## Step 2 — Build, sign, publish artifacts

```bash
npm run build:mac      # dmg + zip, universal binary — notarizes + staples automatically
npm run build:win      # nsis installer — signs automatically if CODE_SIGNING.md's env vars are set, else unsigned with a console warning
npm run build:linux    # AppImage + deb, x64 + arm64
```

Confirm the artifacts actually landed at
`https://releases.tekxai.services/desktop-app/` before moving on — `npm run
build:*` uploading successfully doesn't guarantee the URL is publicly
reachable (CDN propagation, permissions, etc.); a quick `curl -I` against the
new installer URL is cheap insurance against every subsequent employee's
"Update Now" failing at the `electron-updater.checkForUpdates()` step.

## Step 3 — Register the release

Administration → Desktop Management → **Publish Release**. See
`RELEASE_PROCESS.md` step 3 for the full field reference. The version string
must exactly match `package.json`'s version from step 2 — this is a plain
string equality check server-side (`desktop_releases.version` is unique),
not a semver-aware match.

## Step 4 — Restrict it, if this isn't for everyone yet

If you chose a deployment-ring target in Step 1, add it now: Release
History → the new row's **Targets** column → Manage → pick
business_unit/department/team/user and the matching value. Leaving this
alone means the release reaches everyone in its channel — this step is
opt-in, not required for a normal release.

## Step 5 — Watch it roll out

Nothing to push — every installed app polls `/desktop/latest-version` on
its own (launch + every 30 minutes) and starts downloading silently the
moment it's outdated and eligible. Watch:

- **Desktop Diagnostics** — who's actually reporting in, on what version,
  OS/arch, disk/memory (Round 3 addition — every reporting install, not
  just outdated ones).
- **Update Analytics** — version distribution and failed-update counts.
  A spike in failures for the version you just published is the signal to
  pause a staged rollout (don't widen it further) and investigate — see
  `UPDATE_TROUBLESHOOTING_GUIDE.md`.
- **Crash Reports** — if failures correlate with actual crashes rather than
  failed downloads, this is where those show up (Round 3 scaffold — see
  `CRASH_REPORTING.md`).

## Step 6 — If something's wrong

Don't wait — see `ROLLBACK_GUIDE.md` for choosing between **Rollback**
(routine "this isn't good, pull it") and **Emergency Disable** (actively
harmful, force-updates anyone already on it away from it too).
