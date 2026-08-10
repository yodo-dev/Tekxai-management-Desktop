# TekXAI Desktop Agent — Release Process

```
Developer
  ↓  bump version, build + sign + publish installers
GitHub Release (source tag) / releases.tekxai.services (artifact host)
  ↓  admin registers the release
Backend Version Registry (be-work desktop_releases table)
  ↓  every installed app polls this
Desktop checks backend (GET /desktop/latest-version)
  ↓
Download update (electron-updater, from releases.tekxai.services)
  ↓
Install
  ↓
Restart → new version launches → POSTs /desktop/telemetry/update-success
```

## 1. Bump the version

Edit `package.json`'s `"version"` field. This must exactly match what you'll
register in step 3 (`desktop_releases.version`) — the comparison logic on both
the backend and in `main.js` is a plain integer-segment compare, so the string
has to be a real `X.Y.Z`, not `v1.2.0` or similar.

## 2. Build and publish the installers

```bash
npm run build:mac      # dmg + zip, universal binary
npm run build:win      # nsis installer
npm run build:linux    # AppImage + deb, x64 + arm64
```

Each of these runs `electron-builder`, which (given the `publish` config in
`package.json` — a generic, non-GitHub provider) uploads the signed installer
plus its `latest*.yml` manifest to `releases.tekxai.services/desktop-app/`.
That upload is what `electron-updater`'s download/verify mechanics rely on —
this step must complete successfully and the artifacts must actually be
reachable at that URL before step 3, or every installed app's "Update Now"
will fail at the `electron-updater.checkForUpdates()` call even though the
backend says a newer version exists.

macOS builds also run notarization (`scripts/notarize.js`, `afterSign` hook)
and DMG stapling (`scripts/staple-dmg.js`) automatically as part of
`electron-builder`'s hooks — don't skip these or run them out of order
manually.

Per the existing platform-split convention: this machine owns the macOS/dmg
build; Windows/exe is built on the other developer's machine, same source
commit/tag.

## 3. Register the release in the backend (this is the new step)

Building and uploading installers does **not** by itself make any employee's
app update — that only happens once an admin explicitly approves the release
by registering it. This is the deliberate "backend becomes the update
provider" gate: an artifact existing on the release host is not the same as
it being rolled out.

Go to **Administration → Desktop Management → Publish Release** (SUPER_ADMIN
only) and fill in:

| Field | What to put |
|---|---|
| Version | Exactly matches `package.json`'s version from step 1 |
| Minimum Supported Version | The floor below which every app is force-updated, regardless of this specific release's mandatory flag — usually left at whatever it already was unless you're deliberately raising the floor |
| Release Channel | `stable` for the normal employee population; `beta`/`internal`/`development` for a subset only that channel's installs will ever see — see `AUTO_UPDATE_SYSTEM.md`'s "Release channels" |
| Staged Rollout | 10/25/50/100% — for a routine release, publish at 100%; for a risk-averse rollout, start at 10%, watch Update Analytics for a while, then widen via the Release History table's rollout dropdown (no need to re-publish) |
| Mandatory | Check this only if this specific release must not be skippable (e.g. a security fix) — bypasses staged rollout entirely, so a 10%-rollout release with this checked still reaches everyone immediately |
| Release Notes | Supports `## Section headers`, `- bullets`, and `**bold**` — see "Rich release notes" below. Plain lines with no markdown still work exactly as before |
| Windows / macOS / Linux URLs | Direct links to the installers uploaded in step 2 (e.g. `https://releases.tekxai.services/desktop-app/TEKxAI-Agent-Setup-1.2.0.exe`) |

This calls `POST /api/v1/desktop/releases`, which creates a `desktop_releases`
row. The newest **`status: 'ACTIVE'`** row in the target channel (by publish
time, not by highest version number — see `desktop.controller.js`'s comment
on why) is what `GET /desktop/latest-version` returns to every desktop app on
its next check, further filtered by staged-rollout bucketing unless the
release is mandatory.

Equivalent direct API call, if scripting this instead of using the admin UI:

```bash
curl -X POST https://api.tekxai.services/api/v1/desktop/releases \
  -H "Authorization: Bearer $SUPER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "version": "1.2.0",
    "minimum_version": "1.0.0",
    "channel": "stable",
    "rollout_percentage": 10,
    "force_update": false,
    "release_notes": "## New Features\n- **Dark mode**\n## Bug Fixes\n- Fixed crash on startup",
    "windows_url": "https://releases.tekxai.services/desktop-app/TEKxAI-Agent-Setup-1.2.0.exe",
    "mac_url": "https://releases.tekxai.services/desktop-app/TEKxAI-Agent-1.2.0.dmg",
    "linux_url": "https://releases.tekxai.services/desktop-app/TEKxAI-Agent-1.2.0.AppImage"
  }'
```

## 4. Rollout happens automatically

Every installed app checks `/desktop/latest-version` at launch and every 30
minutes thereafter. No further action needed — employees within that
release's rollout wave get the update downloaded silently in the background
(Background Silent Updates, Round 3 — see `AUTO_UPDATE_SYSTEM.md`) with zero
interruption, then see a small "Ready to Install — Restart Now / Later" card
once it's actually finished downloading (mandatory releases: Restart Now
only, no Later). Nobody sees a dialog before the download starts, mandatory
or not.

If you started at less than 100%, widen it from Release History's rollout
column as confidence builds — 10% → 25% → 50% → 100%, watching Update
Analytics' failed-update count between each step. There's no "promote"
button beyond changing that dropdown; it's the same
`PATCH /desktop/releases/:id/rollout` call either way.

## 5. Monitor rollout

Administration → Desktop Management gives three views, all live:

- **Outdated Employees** — who's still behind, with a per-employee **Force
  Update** action for stragglers (flags their next telemetry check, doesn't
  bypass their device).
- **Update Analytics** — version distribution across the whole fleet, plus
  pending/successful/failed counts for the lookback window. A spike in
  failed updates for the version you just published is the signal to stop
  widening the rollout and investigate before going further.
- **Release History** — every published release with its channel, rollout
  percentage, and status (Active/Rolled Back/Disabled).

## Rollback

If a release turns out to be bad, click **Rollback** on it in Release
History (or `POST /desktop/releases/:id/rollback`). No follow-up step needed
— the previous active release in that channel automatically becomes "latest"
again for every subsequent check, since "latest" always excludes
non-`ACTIVE` rows. A rolled-back version stays in history (for the audit
trail) but can never become "latest" again unless a fresh release
re-publishes that exact version number.

## Emergency disable

If a release is actively causing harm (crashes, data loss, a security
issue) rather than just "not great," use **Disable** instead of Rollback —
same "never latest again" effect, plus every install currently *running*
that exact version gets force-updated away from it on its next telemetry
check, regardless of `minimum_version`. Requires a reason (shown in Release
History) — this is for "something is actively wrong," not routine
housekeeping. `POST /desktop/releases/:id/disable` with `{"reason": "..."}`.

## Restricting a release to a specific group (Enterprise Deployment Rings)

Publishing already reaches everyone in the chosen channel by default. To
restrict a release to a Pilot Group, IT Team, specific department, or a
named business unit instead, use Release History's **Targets** column
(defaults to "Everyone") after publishing — add one or more
business-unit/department/team/user targets, OR'd together. See
`AUTO_UPDATE_SYSTEM.md`'s "Enterprise Deployment Rings" section and
`ENTERPRISE_ROLLOUT_GUIDE.md` for a worked example.

## Testing checklist before publishing to the whole company

See `PRODUCTION_CHECKLIST.md` for the full pre-release checklist, covering
platform installs, staged rollout, channels, rollback/disable, and analytics
verification — not duplicated here to avoid two copies drifting apart.

## Further reading

- **`DEPLOYMENT_GUIDE.md`** — end-to-end deployment walkthrough (build →
  publish → verify → monitor), a narrower step-by-step companion to this
  document for someone doing it for the first time.
- **`ROLLBACK_GUIDE.md`** — deciding between Rollback and Emergency Disable,
  and what happens to already-updated installs either way.
- **`UPDATE_TROUBLESHOOTING_GUIDE.md`** — symptom → cause → fix for the
  update pipeline (employee stuck on an old version, download failing,
  force-update not clearing, etc).
- **`ENTERPRISE_ROLLOUT_GUIDE.md`** — staged rollout + release channels +
  deployment rings combined into one recommended enterprise rollout
  playbook.
- **`CRASH_REPORTING.md`** — the crash-reporting scaffold's architecture and
  future Sentry/Crashpad swap-in path.
