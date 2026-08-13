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
- Fixed the installer being unable to close a running instance during an upgrade (single-instance lock)

## Under the hood
- `electron-updater` auto-update mechanics unchanged (still generic-provider, still backend-decision-driven); this release is the first to have a live, reachable artifact host (`releases.tekxai.services`) behind it
