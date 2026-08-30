# TEKxAI Agent 1.2.0

Release notes for the Desktop Release API's `release_notes` field (rendered via the app's markdown-lite subset — `## headers`, `- bullets`, `**bold**`).

## What's New
- **Background silent updates** — updates now download automatically the moment one is detected, with no interrupting dialog; a small non-blocking indicator shows progress, and you're only prompted once the update is fully downloaded and ready to install
- **Update analytics & richer release notes** — Administration can now see version distribution, pending/successful/failed update counts, and staged rollout status across the fleet
- **Enterprise deployment rings** — releases can be targeted to specific business units, departments, teams, or individual users before a full rollout
- **Emergency disable & rollback** — a bad release can be pulled instantly and any install still running it is force-updated away from it
- **Crash reporting** — the app now reports unexpected crashes back to the backend for diagnosis
- **Desktop diagnostics** — disk/memory/architecture info is now included in update telemetry to help diagnose install issues
- **Daily Report gate on checkout** — clock-out now checks whether a required Daily Report has been submitted first
- Electron upgraded to v43 for security and stability
- App renamed to "TEKxAI Agent" with a new icon across Windows/macOS/Linux
- macOS builds are now notarized and DMGs properly stapled
- Windows code-signing support added (Azure Trusted Signing, local certificate, or certificate-store — auto-detected from build environment)

## Fixes
- Fixed a macOS single-architecture build crash; added proper multi-arch Linux (x64/arm64) support
- **Correction (added retroactively):** this entry originally claimed the Windows installer's "unable to close a running instance during an upgrade" problem was fixed here via `nsis.closeApplication`/`restartApplication`. That was inaccurate — those config keys are not valid electron-builder NSIS options at any version, the change was reverted the same day (commit `0320daf`, ~30 minutes after `9c4fc68`), and the underlying issue ("Another program is currently using this file." when double-clicking the installer while the app is running) remained unresolved through 1.2.1 and 1.2.2. The single-instance lock added alongside it is a real, unrelated fix (prevents a second running copy) and was not reverted. The actual installer fix ships in 1.2.3, below.

## Under the hood
- `electron-updater` auto-update mechanics unchanged (still generic-provider, still backend-decision-driven); this release is the first to have a live, reachable artifact host (`releases.tekxai.services`) behind it

# TEKxAI Agent 1.2.3

## Fixes
- **Windows installer no longer fails with "Another program is currently using this file."** when launched while TEKxAI Agent is already running. The NSIS installer now detects a running `TEKxAI Agent.exe` before installing, asks it to close gracefully, and force-terminates it only if it hasn't exited after a short wait — implemented via a custom NSIS include (`build/installer.nsh`, wired in through `nsis.include`), since electron-builder has no built-in `closeApplication`/`restartApplication` NSIS option at any version (see the corrected 1.2.0 note above for how that was previously misreported as fixed).
