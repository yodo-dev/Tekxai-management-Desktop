# TekXAI Desktop Agent — Code Signing Requirements

Verified against the actual `package.json`/`scripts/notarize.js` in this repo
— this document states what's configured and working today vs. what's
required but missing, not a generic signing tutorial.

## macOS — configured and working

| Requirement | Status |
|---|---|
| Apple Developer ID Application certificate | Required, installed in the build machine's keychain. `package.json`'s `mac.identity: "Tekxai LLC (64GRQF7C5Z)"` names it. |
| Code signing | Handled by `electron-builder` automatically at build time using the identity above, with `hardenedRuntime: true` and `entitlements`/`entitlementsInherit` pointing at `build/entitlements.mac.plist`. |
| Notarization | `mac.notarize: false` deliberately disables `electron-builder`'s *built-in* notarizer — a custom `afterSign` hook (`scripts/notarize.js`) does it instead, using `@electron/notarize` directly. The script's own comment explains why: electron-builder's built-in notarizer crashes without extra config it wasn't given, so the custom script is the only path. |
| Stapling | `afterAllArtifactBuild: "scripts/staple-dmg.js"` staples the notarization ticket to the DMG after notarization completes, so Gatekeeper can verify offline. |
| Required environment variables at build time | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — `scripts/notarize.js` **skips notarization with a warning** (not a hard failure) if any are missing, producing a signed-but-not-notarized DMG that Gatekeeper will reject on any Mac other than the one that built it. **Always confirm these three env vars are set on the build machine before a release build** — a silent skip here is the single most likely way a macOS release accidentally ships broken. |

**What's needed to keep this working:** the Developer ID Application
certificate must not expire (Apple issues these with multi-year validity —
track the expiry), and the three env vars must be present in whatever shell/CI
environment runs `npm run build:mac`.

## Windows — NOT configured (real gap, not silently worked around)

`package.json`'s `win` block has only `target: "nsis"` and an icon — no
`certificateFile`, `certificatePassword`, `certificateSubjectName`,
`signingHashAlgorithms`, or any other signing configuration. **Windows builds
today are unsigned.**

**Practical consequence:** an unsigned `.exe` triggers Windows SmartScreen's
"Windows protected your PC" warning on first run, and looks untrustworthy to
anyone installing it — a real barrier for company-wide rollout, and a
plausible source of employees clicking "don't run" instead of proceeding.

**What's required to fix this** (not done here — requires a real-world
purchase/provisioning step this document can flag but can't complete):

1. **A code-signing certificate.** Two paths:
   - A traditional standalone Authenticode certificate from a CA (DigiCert,
     Sectigo, etc.) — as of 2023, all new code-signing certs (including
     standard, non-EV) must be issued on a hardware token (USB HSM) or a
     cloud HSM per CA/Browser Forum requirements; a plain `.pfx` file
     approach is no longer issuable for new certificates.
   - **Recommended:** a cloud signing service built for exactly this — Azure
     Trusted Signing (Microsoft's own, integrates with `electron-builder` via
     its `win.azureSignOptions`) or SignPath (has an official
     `electron-builder` integration and a free tier for open-source, paid
     tiers for commercial). Either avoids provisioning a physical HSM token
     on the build machine.
2. **`electron-builder` config** once a certificate/service is chosen — the
   exact keys depend on which path above: `certificateFile`+`certificatePassword`
   for a local `.pfx` (increasingly rare now), or `azureSignOptions`/a custom
   `sign` hook for a cloud service.
3. **An EV (Extended Validation) certificate specifically** eliminates the
   SmartScreen warning immediately on first release (a standard cert still
   builds "reputation" over time/downloads before SmartScreen stops warning)
   — worth the higher cost if a smooth first-run experience for the whole
   company matters, which for an internal company tool being pushed via
   mandatory auto-update, it does.

This is a genuine prerequisite for a fully polished Windows rollout, flagged
here rather than worked around — purchasing a certificate/signing service
subscription isn't something achievable from a code change.

## Linux — no equivalent mechanism configured, lower priority

Linux has no direct equivalent to Authenticode/Apple codesign for a
standalone binary. Integrity/trust is normally established one of two ways:

- **GPG-signed repository** (for `.deb` distributed via an APT repo) — not
  applicable here since these builds are downloaded directly, not through a
  repo.
- **AppImage's own signing** — AppImage supports embedding a GPG signature
  (`appimagetool -s`), verifiable via `AppImageUpdate`/`sha256sum`, but
  `electron-builder`'s AppImage target doesn't wire this up out of the box and
  it isn't configured here.

**Practical impact is lower than Windows/macOS:** Linux doesn't have an OS-level
Gatekeeper/SmartScreen-style warning gate blocking execution of an unsigned
binary — the file just runs (after `chmod +x` for AppImage, or a normal
`dpkg -i` for `.deb`). Worth adding GPG signing eventually for supply-chain
integrity (proving the AppImage wasn't tampered with in transit, on top of
the SHA-256 checksum this system already verifies at the application level
via `desktop_releases`/`file_metadata`-style tracking), but not the blocking
UX problem Windows' lack of signing is.

## Summary

| Platform | Signed | Notarized/Verified | Blocking issue if skipped |
|---|---|---|---|
| macOS | Yes | Yes (custom script) | None — already correct, contingent on env vars being present at build time |
| Windows | **No** | N/A | SmartScreen warning on every install — real UX/trust problem for company-wide rollout |
| Linux | No | No | Low — no OS-level execution gate, GPG signing would add supply-chain integrity but isn't blocking |
