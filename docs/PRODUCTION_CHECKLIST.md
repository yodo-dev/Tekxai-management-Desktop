# TekXAI Desktop Agent — Final Production Checklist

Run this before every company-wide release, and in full at least once before
the *first* one. Items marked **(one-time)** only need re-verifying if the
underlying config changes, not on every release.

## Prerequisites (one-time)

- [ ] **(one-time)** macOS signing env vars (`APPLE_ID`,
      `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) confirmed present on the
      build machine — see `CODE_SIGNING.md`.
- [ ] **(one-time)** Windows code-signing certificate/service provisioned and
      wired into `electron-builder` config — **currently missing**, see
      `CODE_SIGNING.md`; do not skip this for a real company-wide rollout,
      only for internal/beta-channel testing where SmartScreen friction is
      acceptable.
- [ ] **(one-time)** `releases.tekxai.services` artifact host reachable and
      writable from the build machine(s) — both mac and Windows builders,
      per the existing platform-split (this machine owns mac, the other
      developer's machine owns Windows).
- [ ] **(one-time)** Backend `/api/v1/desktop/*` routes deployed and reachable
      — this entire system is inert without them.

## Per-release: build

- [ ] Version bumped in `package.json`, matches what will be registered with
      the backend exactly (`X.Y.Z`, no `v` prefix, no pre-release suffix
      unless intentionally using one consistently).
- [ ] `npm run build:mac` completes with no notarization warning in the log
      (a silent notarization skip is the most likely accidental-ship-broken
      failure mode — see `CODE_SIGNING.md`).
- [ ] `npm run build:win` completes and (once signing is provisioned) the
      resulting `.exe` shows a valid signature (right-click → Properties →
      Digital Signatures on Windows, or `signtool verify /pa` from the CLI).
- [ ] `npm run build:linux` completes, both AppImage and deb artifacts
      produced for x64 and arm64.
- [ ] All artifacts + their manifests (`latest.yml`/`latest-mac.yml`) actually
      uploaded and reachable at `releases.tekxai.services/desktop-app/` —
      confirm with a direct `curl -I` on each URL before registering the
      release, not just "the build command exited 0."

## Per-release: platform verification

- [ ] **Windows** — fresh install on a clean VM/machine, then update from the
      immediately-previous published version.
- [ ] **macOS** — fresh install (confirm Gatekeeper accepts it with zero
      warnings — a stapling or notarization failure surfaces exactly here),
      then update from the previous version.
- [ ] **Linux** — AppImage and deb, fresh install and update, on both x64 and
      arm64 if practical.

## Per-release: update flow verification

- [ ] Differential update actually occurs on Windows (check the download size
      in the progress UI/logs is meaningfully smaller than the full
      installer for a small change) — confirms the blockmap pipeline is
      intact, not just assumed working because it usually is.
- [ ] **Background Silent Updates (Round 3)** — no dialog appears the moment
      an update is detected, for mandatory or optional releases alike; the
      download starts immediately and silently (a small non-blocking pill
      is the only visible sign). Clock in/out, screenshots, and normal use
      continue working mid-download without interruption.
- [ ] The "Ready to Install" card is the *only* point the app interrupts —
      confirm it only appears once the download has actually finished, not
      before.
- [ ] Interrupted download (kill network mid-transfer) — app doesn't crash,
      the indicator pill shows "Update failed — retry" and retrying works.
- [ ] Optional "Ready to Install" can be dismissed ("Later") and the app
      remains usable; the pending install still applies automatically on
      next natural quit (`autoInstallOnAppQuit`).
- [ ] Restart Now installs and relaunches at the new version automatically;
      `last_successful_update_at` populates in Desktop Management afterward.

## Per-release: enterprise capabilities

- [ ] **Staged rollout** — publish at 10%, confirm via Update Analytics'
      version distribution that only a fraction of the fleet moves, widen to
      25/50/100 and confirm distribution tracks each step.
- [ ] **Release channels** — a beta-channel release does not appear as
      "latest" to a stable-channel install's `/desktop/latest-version` call
      (and vice versa).
- [ ] **Mandatory bypasses staged rollout** — a `force_update: true` release
      at 10% rollout still reaches a test install outside that 10% bucket.
- [ ] **Rollback** — roll back a test release, confirm the previous release
      becomes "latest" again with no other action, confirm the rolled-back
      version's status shows correctly in Release History.
- [ ] **Emergency disable** — disable a test release, confirm an install
      already on that exact version gets `force_update_requested: true` on
      its next telemetry call, confirm a different install on an older
      (non-disabled) version is unaffected.
- [ ] **Rich release notes** — publish a release with `##` headers, `-`
      bullets, and `**bold**`, confirm it renders correctly in both the
      desktop app's update dialog and the admin panel's preview — and that a
      plain-text (no markdown) release still renders as a simple bullet list,
      unchanged from before this feature existed.
- [ ] **Update analytics** — after the above tests, confirm Update
      Analytics' version distribution, pending/successful/failed counts all
      reflect what actually happened, including at least one deliberately
      failed update (e.g. disconnect network mid-download) showing up under
      Failed Updates.
- [ ] **Deployment ring targeting (Round 3)** — target a test release to a
      business_unit/department/team/user that does NOT match your test
      account, confirm `/desktop/latest-version` returns no update for it;
      add a matching target (OR'd with the first), confirm it now does.
      Confirm an untargeted release still reaches everyone, unchanged.
- [ ] **Desktop Diagnostics (Round 3)** — confirm a real telemetry ping
      populates arch/disk/memory in the Desktop Diagnostics table, and that
      an older installation with no diagnostics data yet shows "—" rather
      than an error.
- [ ] **Crash Reporting (Round 3)** — trigger a real crash on a packaged
      build (not `npm start`) and confirm it appears in Crash Reports with
      the correct version/OS/stack trace/last action; confirm status
      transitions (Open → Acknowledged → Resolved/Ignored) work from the
      admin UI.

## Sign-off

- [ ] All of the above pass on all three platforms before the release is
      published at 100% rollout to the `stable` channel.
- [ ] Release notes reviewed for accuracy and tone — they're shown directly
      to every employee.
- [ ] A rollback/disable plan is understood by whoever's on call for the
      release window (which release to roll back to, who has SUPER_ADMIN
      access to do it) — not something to figure out for the first time
      during an actual incident.

This checklist has not been executed end-to-end as part of building this
system — every backend endpoint (across all three rounds, including
Round 3's deployment-ring targeting, diagnostics telemetry, and crash
reporting) was verified live via curl, and the admin UI was verified live in
a browser, but the Electron desktop app's own UI could not be visually
driven in the environment this was built in (no GUI display). Run this
checklist in full, on real hardware/VMs for each platform, before the first
real company-wide release.

See also: `DEPLOYMENT_GUIDE.md`, `ROLLBACK_GUIDE.md`,
`UPDATE_TROUBLESHOOTING_GUIDE.md`, `ENTERPRISE_ROLLOUT_GUIDE.md`, and
`CRASH_REPORTING.md` for narrower how-to companions to this checklist.
