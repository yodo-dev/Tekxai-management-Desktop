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
| Mandatory | Check this only if this specific release must not be skippable (e.g. a security fix) — otherwise leave unchecked so employees get the normal dismissible dialog |
| Release Notes | One bullet per line — shown verbatim in the update dialog's "What's New" |
| Windows / macOS / Linux URLs | Direct links to the installers uploaded in step 2 (e.g. `https://releases.tekxai.services/desktop-app/TEKxAI-Agent-Setup-1.2.0.exe`) |

This calls `POST /api/v1/desktop/releases`, which creates a `desktop_releases`
row. The newest row (by publish time, not by highest version number — see
`desktop.controller.js`'s comment on why) is what `GET /desktop/latest-version`
returns to every desktop app on its next check.

Equivalent direct API call, if scripting this instead of using the admin UI:

```bash
curl -X POST https://api.tekxai.services/api/v1/desktop/releases \
  -H "Authorization: Bearer $SUPER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "version": "1.2.0",
    "minimum_version": "1.0.0",
    "force_update": false,
    "release_notes": "Chat improvements\nAttendance fixes\nSecurity enhancements",
    "windows_url": "https://releases.tekxai.services/desktop-app/TEKxAI-Agent-Setup-1.2.0.exe",
    "mac_url": "https://releases.tekxai.services/desktop-app/TEKxAI-Agent-1.2.0.dmg",
    "linux_url": "https://releases.tekxai.services/desktop-app/TEKxAI-Agent-1.2.0.AppImage"
  }'
```

## 4. Rollout happens automatically

Every installed app checks `/desktop/latest-version` at launch and every 30
minutes thereafter. No further action needed — employees see the update
dialog (or, for a mandatory release, the blocking screen) without anyone
pushing anything to them individually.

## 5. Monitor rollout

Administration → Desktop Management's **Outdated Employees** table shows, in
real time (as telemetry pings arrive), who's still behind. Use **Force
Update** on stragglers if a release needs to land faster than the passive
dialog achieves on its own — this doesn't bypass the user's device, it just
flags that specific employee's next telemetry check to trigger the same
mandatory-update UI everyone else would see for a release-wide `force_update`.

## Rollback (not yet implemented)

The admin panel's Release History table has a disabled "Rollback" button —
intentionally present but non-functional, flagged as a future deliverable per
the auto-update system's phased scope. Until it exists, "rolling back" means
publishing a new release row whose `version` is higher than the bad one (so
the comparison logic still treats it as "latest") but which points at the
previous good installer's URLs — a manual workaround, not a real rollback
feature.

## Testing checklist before publishing to the whole company

- [ ] Windows: fresh install, then update from the previous version
- [ ] macOS: fresh install (notarization/Gatekeeper passes), then update
- [ ] Linux: AppImage and deb, fresh install and update
- [ ] Background download doesn't block the app — clock in/out, screenshots
      continue working mid-download
- [ ] Interrupted download (kill network mid-transfer) — app doesn't crash,
      "Update Now" can be retried
- [ ] Force update (`force_update: true` or below `minimum_version`) actually
      blocks normal use, with no dismiss path
- [ ] Optional update can be dismissed and re-prompts on the next periodic
      check
- [ ] Restart Now installs and relaunches at the new version automatically
- [ ] `last_successful_update_at` populates in Desktop Management after the
      relaunch

This checklist has **not** been executed as part of building this system —
see `AUTO_UPDATE_SYSTEM.md`'s "Known limitations" for exactly what was and
wasn't verified. Run it before the first real company-wide rollout.
