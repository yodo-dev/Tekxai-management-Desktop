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

# TEKxAI Agent 1.2.4

## Fixes
- **Displayed clock/time-tracking state could get stuck out of sync with the backend after a failed clock-out.** This is a client-side display/synchronization fix, not a data-correction fix — a production investigation confirmed the backend's attendance records were always correct and clock-out is validated atomically before any database write. The issue was that when checkout was blocked by the mandatory Daily Report requirement (`REPORT_REQUIRED`), or when a submitted-report retry checkout failed again, the app kept showing the report-required screen without ever re-fetching the real session state from the server. If the backend later force-closed that session in the background (e.g. the shift-end auto-checkout job), the app's on-screen timer kept counting upward on stale local data instead of reflecting the actual closed session, which could show a badly inflated tracked time until the next user action or app restart. Both failure paths now resync with the backend immediately so the displayed status/timer always reflects the real session state.
- Added a low-frequency (5-minute) background resync while clocked in, as a defense-in-depth backstop: with no fix, an idle session with zero user interaction had no way to notice a server-side force-close until the next click or app restart (unbounded staleness). This closes that gap generally, not just for the specific bug above.

# TEKxAI Agent 1.3.0

(1.2.5 was prepared but never published — its two fixes below ship for the first time in this release, together with the activity heartbeat and monitoring-permission gate.)

## What's New
- **Activity heartbeat** — while clocked in, the agent now sends a ~45-second liveness signal (OS-idle time in seconds, agent version, current app name — no keystroke or mouse content) so a long, unbroken stretch in one application is no longer indistinguishable from an idle machine. Previously, activity was only inferred from foreground-app *switches*, so working in a single window for hours produced no signal at all.
- **Screen-recording permission gate (macOS)** — the app now checks the OS-level Screen Recording permission before allowing clock-in on macOS, and can open System Settings' Screen Recording pane directly if it isn't granted. Windows and Linux have no equivalent OS permission prompt for this app's capture method today, and are treated as not applicable rather than silently assumed granted.

## Fixes
- Fixed a false "session expired" logout on a transient failure of the token-refresh request itself — previously any failure of `POST /auth/refresh` wiped the local session, with no distinction between a genuinely invalid refresh token and a refresh request that simply failed to reach the server.
- Fixed duplicate `/auth/login` requests (the Sign In button and the Enter-key handler could both fire `doLogin()` for the same click) and a raw, unfriendly error message being shown for a 429 rate-limit response on login.

## Under the hood
- Release-process documentation hardened following the v1.2.3 incident: update-path UAT is now called out as a separate, non-substitutable verification step, with explicit manual `aws s3 cp` + CloudFront invalidation steps and staged-rollout guidance.

# TEKxAI Agent 1.3.1

## Fixes
- **Screenshot capture can now be verified before clock-in on every platform, not just macOS.** The previous Screen Recording permission gate (1.3.0) only ever checked macOS's OS-level permission — Windows and Linux have no equivalent prompt, so an employee on those platforms could clock in and track time even when screenshot capture was silently failing on every interval (a missing native capture helper, security software blocking capture, a locked/remote-desktop session, etc.). The app now attempts a real screenshot capture at clock-in time on every platform; if it fails, clock-in is blocked and the actual error is shown so it can be reported to IT, instead of the failure only ever appearing as a local, unreported console log.
- **This check now also runs proactively**, once at login/auto-login and periodically (every 15 minutes) while the app is open — a broken setup is surfaced automatically instead of only being discovered the moment someone tries to clock in.

## Under the hood
- Administration → Monitoring now has a Permissions tab (Super Admin only) listing every employee's device, monitoring status, whether they can currently clock in, and the real captured error for anyone blocked.

# TEKxAI Agent 1.3.2

## Fixes
- **Windows employees could not clock in at all on 1.3.1.** Root cause: `screenshot-desktop`'s Windows capture helper (`screenCapture_1.3.2.bat`, plus its `app.manifest`) was never being packaged into the Windows installer — electron-builder's automatic asar-unpack only catches native `.node` binaries, and this is a plain batch/C#-hybrid file, invisible to that heuristic. Confirmed on a live Windows install: `app.asar.unpacked\node_modules\` contained only `active-win`'s native module, nothing from `screenshot-desktop` at all. 1.3.1's new capture-verification check (see above) was working exactly as designed — it correctly detected that capture was broken and blocked clock-in — but capture had actually never worked on any Windows install of this app, on any version, ever; the failure was previously silent (screen monitoring simply never activated, with no user-visible sign anything was wrong). Fixed by explicitly telling electron-builder to unpack `screenshot-desktop` from the asar archive.
- **Windows attendance timer could appear frozen while the app was minimized/unfocused** — the on-screen ticker (a display-only counter, not the source of truth) was throttled by Chromium's background-tab/window suspension; the underlying attendance record was never affected. Fixed via `backgroundThrottling: false` plus a resync on window focus/visibility change.
- Added a "are you still working?" shift-end reminder — reads the employee's real configured shift end (no hardcoded hours), prompts once near shift end with a 30-second auto-checkout countdown, and re-prompts every 30 minutes if dismissed. All state changes go through the real backend checkout API.
