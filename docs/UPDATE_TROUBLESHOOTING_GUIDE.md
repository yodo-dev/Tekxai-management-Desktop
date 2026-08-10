# TekXAI Desktop Agent — Update Troubleshooting Guide

Symptom → likely cause → fix, for the update pipeline specifically (not
general desktop-app bugs — see `CRASH_REPORTING.md` for those). Ordered
roughly by how often each actually comes up.

## "An employee is stuck on an old version"

1. Check **Desktop Diagnostics** (Administration → Desktop Management) for
   that employee's `last_seen_at` ("Last Sync"). If it's old (hours/days),
   the app itself isn't running or isn't reaching the backend — this is a
   connectivity/app-not-running problem, not an update problem. Nothing
   about the update pipeline can fix an app that isn't checking in.
2. If `last_seen_at` is recent but `current_version` is still old, check
   whether the release they should be getting has a deployment-ring target
   that excludes them (Release History → Targets column) — a targeted
   release intentionally won't reach non-matching employees. This is
   probably working as designed, not a bug.
3. Check staged rollout — if the release is at less than 100%, the
   employee's stable hash bucket may simply not be in the current wave yet
   (see `AUTO_UPDATE_SYSTEM.md`'s "Staged rollout"). Widen the rollout
   percentage if you want to reach them sooner, or use per-employee **Force
   Update** (Outdated Employees table) to bypass the wave for just that one
   person.
4. If none of the above explains it, use **Force Update** — this sets
   `force_update_requested_at` on their specific installation row, which
   `post_telemetry` checks on their next check-in (within 30 minutes) and
   triggers a silent background download for them specifically, regardless
   of rollout/targeting.

## "The download starts but fails"

- Check **Update Analytics** → Failed Updates and `failed_by_version` — this
  comes from `desktop_update_failures`, populated only for a real in-flight
  download attempt (`main.js`'s `updateAttempt` state), never a routine
  background availability check.
- The most common real-world cause: the artifact host
  (`releases.tekxai.services`) doesn't actually have the version the
  backend says is latest. Remember: `desktop_releases.windows_url`/
  `mac_url`/`linux_url` are **informational only** — `electron-updater`
  never reads them. It always checks `electron-builder.config.js`'s own
  `publish.url` for a `latest*.yml` manifest. If someone registered a
  release in the backend before (or without) actually running
  `npm run build:*`/publish for it, every desktop app's download will fail
  even though the admin UI shows the release as published. See
  `AUTO_UPDATE_SYSTEM.md`'s "What actually drives the download."
- On the affected employee's machine (if reachable): the small
  download-indicator pill (bottom of the window) turns into "Update
  failed — retry" on failure — clicking it retries via the same path. If it
  keeps failing, check that machine's network access to
  `releases.tekxai.services` specifically (proxy/firewall rules sometimes
  allow the main API host but not the artifact host).

## "A per-employee Force Update won't clear"

`force_update_requested_at` clears automatically once that employee's
telemetry shows `current_version >= the latest release they can actually
receive` (respecting deployment-ring targeting as of Round 3 — see
`find_latest_active_release`'s `uid` parameter in `desktop.controller.js`).
If it's not clearing:

- Confirm they're actually reporting a `current_version` at all (Desktop
  Diagnostics) — a stale/missing version means the clear condition can never
  evaluate true.
- If the release they're being compared against is deployment-ring-targeted
  and *doesn't* target them, they can never legitimately reach it through
  the sanctioned pipeline — this would be a configuration mistake (a targeted
  release being used as the force-update bar for someone outside the
  target), not a bug in the clear logic itself. Fix by widening the
  target or force-updating them to a different, untargeted release instead.

## "Mandatory update isn't blocking anything"

The force-update UI block is **client-side only** by design (see
`AUTO_UPDATE_SYSTEM.md`'s "Known limitations") — a technically sophisticated
user could bypass it via devtools. This is a known, accepted limitation, not
a bug to fix. If you need a hard server-side gate, that's a different,
larger feature (e.g. rejecting API requests from below-minimum clients) —
not something this system attempts today.

## "Rollout percentage change didn't seem to do anything"

Confirm you're looking at the right release — widening rollout on a release
that's no longer the newest ACTIVE one in its channel has no visible
effect, since it was never "latest" to begin with (a newer release
superseded it). Only the newest ACTIVE row in a channel is ever compared
against.

## "Windows build is unsigned" / SmartScreen warning

Expected until a certificate or Azure Trusted Signing resource is
provisioned — see `CODE_SIGNING.md`. Check the build log for the
`[build] No Windows code-signing configured...` warning to confirm this is
the cause rather than a signing failure.

## Still stuck

Check `PRODUCTION_CHECKLIST.md` for what's verified-working vs. documented-
but-not-independently-testable in this environment (real Windows
differential-update byte counts, actual packaged-app crash capture, etc.) —
some issues may be in that "known gap," not a regression.
