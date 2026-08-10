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

## Windows — architecture ready, certificate still missing

**Status: the build is ready to sign the moment a certificate/signing service
is provisioned — no code change will be needed then, only environment
variables.** This is new since the previous revision of this document, which
found no signing configuration at all. **A certificate itself is still not
provisioned — Windows builds remain unsigned today** — this section documents
readiness, not completion.

Build config moved from `package.json`'s `build.win` field to
`electron-builder.config.js` (a plain JS file, electron-builder's own
supported config format) specifically so signing could become *conditional*
— static JSON can't express "sign only if a certificate is actually
available" without either always attempting to sign (breaking the build the
moment this file exists but no cert does) or never being able to sign at
all. `electron-builder.config.js`'s `resolveWinSigning()` checks, in order:

| Priority | Env vars checked | Path used |
|---|---|---|
| 1 | `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` | Azure Trusted Signing — `electron-builder`'s built-in `azureSignOptions`, no custom script needed |
| 2 | `WIN_CSC_LINK`/`CSC_LINK` (+ matching `*_KEY_PASSWORD`) | A standard or EV certificate as a local `.pfx`/`.p12` file — **needs zero config**, `electron-builder` picks these up automatically the moment they're set; the code change here doesn't add anything for this path, it just documents that it already worked |
| 3 | `WIN_CERT_SUBJECT_NAME` or `WIN_CERT_SHA1` | A certificate already installed in the build machine's Windows certificate store (common for a hardware-token/cloud-HSM-backed cert accessed via a cert-store provider rather than a portable file) |
| none | — | Unsigned, with a loud console warning at build time (mirrors `scripts/notarize.js`'s existing "skip with a warning" pattern for the equivalent macOS gap) — **this is what happens today** |

All four branches were verified directly (`node -e "require('./electron-builder.config.js')"` with each env-var combination set) — each produces exactly the expected `win` config block, and the no-env-vars case produces a `win` block byte-identical to what `package.json` had before this migration, confirmed by diff. Not verified: an actual signed Windows binary, since no certificate/signing-service credentials exist to test against — that's the one thing this document can't complete on its own.

### EV Certificate support

Fully supported via branch 2 or 3 above — `electron-builder` doesn't
distinguish EV from standard certificates in its config (both are just "a
certificate"), the difference is entirely in what the CA issues and how
Windows SmartScreen treats the result. **An EV certificate eliminates the
SmartScreen "Windows protected your PC" warning immediately** on the first
release; a standard certificate still shows the warning until the certificate
builds enough download "reputation" over time. For an internal company tool
being pushed via mandatory auto-update, EV is worth the extra cost — a
first-run SmartScreen warning on a mandatory update is exactly the kind of
friction that generates support tickets and "is this a virus?" Slack
messages.

### Standard Certificate support

Also fully supported via branch 2 or 3. As of 2023, CA/Browser Forum rules
require all new code-signing certificates (standard or EV) to be issued on a
hardware token or cloud HSM — a plain portable `.pfx` file is no longer
issuable for new certificates, though existing ones on a supported HSM can
still be referenced via `WIN_CSC_LINK` if the HSM exposes a file-like
interface, or via the certificate-store branch (3) if it registers into
Windows' cert store.

### Azure Trusted Signing compatibility

Branch 1, native `electron-builder` support (`azureSignOptions`), no custom
script. Requires an Azure Trusted Signing resource (a relatively new, cheaper
alternative to a standalone hardware-token certificate — Microsoft manages
the HSM-backed key on your behalf) with a certificate profile provisioned
for EV or standard, and the three env vars (`AZURE_SIGNING_ENDPOINT`,
`AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`) set on the build machine —
plus the Azure credentials `electron-builder`'s Azure signing path itself
needs at runtime (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
— standard Azure SDK service-principal auth, not specific to this app).

### Future CI/CD signing pipeline

Not built (no CI system runs these builds today — per `RELEASE_PROCESS.md`,
builds are run manually on developer machines, matching the existing
platform-split convention). When a CI pipeline is introduced, the same env
vars above are what it needs to inject as secrets — nothing about
`electron-builder.config.js` changes; a GitHub Actions/other CI runner
setting `AZURE_SIGNING_*` (or `WIN_CSC_LINK` as a base64-encoded secret,
`electron-builder`'s documented convention for passing a certificate through
CI env vars without a file on disk) is a configuration/secrets change on the
CI side, not a code change here. Azure Trusted Signing is the natural fit for
a CI pipeline specifically, since it needs no certificate file to protect as
a CI secret at all — only account identifiers and a service-principal
credential, all safely stored as CI secrets.

**Summary: purchasing/provisioning a certificate or Azure Trusted Signing
resource is the one remaining step — code-wise, this is done.**

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

| Platform | Signed today | Architecture ready | Blocking issue if skipped |
|---|---|---|---|
| macOS | Yes | — (already complete) | None — already correct, contingent on env vars being present at build time |
| Windows | **No** | **Yes** — `electron-builder.config.js` signs automatically the moment Azure Trusted Signing or a certificate is provisioned, no code change needed then | SmartScreen warning on every install — real UX/trust problem for company-wide rollout, until a certificate is provisioned |
| Linux | No | No | Low — no OS-level execution gate, GPG signing would add supply-chain integrity but isn't blocking |
