# TEKxAI Agent — Internal Windows Code-Signing Deployment

## What this is

TEKxAI Agent Windows installers are signed with an **internal, self-signed**
Authenticode certificate — `CN=TekXAI LLC, O=TekXAI LLC, C=US`. This is
**not** a publicly-trusted CA certificate. It is intended only for
TekXAI-managed Windows machines, and it is trusted only after each machine
explicitly installs the TekXAI public certificate as described below.

- **Employees receive only the public certificate** (`tekxai-codesign-public.cer`).
- **The private key / PFX / password are never distributed** — they stay in
  the signing operator's local `~/tekxai-signing/` directory and are used
  only at build time to produce signed installers.
- The public `.cer` is **not committed to this repository**. It is
  distributed separately (secure internal file share, IT-managed deployment
  channel, etc.) and placed next to the install script, or its path is
  passed explicitly with `-CertPath`.

## Certificate identity

| Field | Value |
|---|---|
| Subject | `CN=TekXAI LLC, O=TekXAI LLC, C=US` |
| Thumbprint (SHA1) | `4DAD471705AE5659F3E6ACE19F5C1160F35A39AB` |
| Valid | 2026-09-22 → 2031-09-22 |

The install/uninstall scripts hard-code this thumbprint and refuse to act on
any certificate that doesn't match it — this prevents them from ever
installing or removing the wrong certificate.

## Administrator: installing trust on a company Windows machine

1. Obtain `tekxai-codesign-public.cer` from an approved internal source
   (never generate or accept one from an untrusted source).
2. Place it next to `install-tekxai-code-signing-cert.ps1`, or note its path.
3. Open PowerShell **as Administrator**.
4. Run:

   ```powershell
   .\install-tekxai-code-signing-cert.ps1
   # or, if the cert is elsewhere:
   .\install-tekxai-code-signing-cert.ps1 -CertPath "C:\path\to\tekxai-codesign-public.cer"
   ```

The script:
- Requires Administrator privileges (checks and exits clearly if not elevated).
- Is idempotent — if the certificate is already installed (matched by
  thumbprint), it reports that and makes no change.
- Refuses to install a file that isn't the expected TekXAI certificate
  (thumbprint mismatch) or that contains a private key.
- Installs into `Cert:\LocalMachine\TrustedPublisher` (machine-wide, so it
  covers all users on that machine and survives future TEKxAI Agent updates).
- Verifies the certificate is actually present in the store after installing,
  and reports success/failure explicitly.

## Verifying installation

```powershell
Get-ChildItem Cert:\LocalMachine\TrustedPublisher |
    Where-Object { $_.Thumbprint -eq '4DAD471705AE5659F3E6ACE19F5C1160F35A39AB' }
```

A matching result confirms the certificate is trusted on that machine. You
can also right-click the signed `TEKxAI Agent Setup 1.3.3.exe` → Properties →
Digital Signatures tab, and confirm the signer shows as `TekXAI LLC` without
a certificate warning.

## Uninstalling

```powershell
.\uninstall-tekxai-code-signing-cert.ps1
```

- Requires Administrator privileges.
- Removes **only** the certificate matching the exact TekXAI thumbprint —
  it will never remove an unrelated certificate, even one that happens to
  share a similar subject name.
- Reports "already absent" cleanly if nothing needs to be done.

## How future signed releases use the same certificate

```
Internal TekXAI LLC certificate (created once, ~5yr validity)
    ↓
Private signing key/PFX (kept outside Git, on the signing operator's machine)
    ↓
electron-builder (resolveWinSigning() auto-detects WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD)
    ↓
Signed TEKxAI Agent installer (new version each release, same certificate/thumbprint)
    ↓
Company Windows machines that already installed the TekXAI certificate
continue to trust every future release automatically — no per-release
certificate reinstall needed.
```

To build a new signed release:

```bash
export WIN_CSC_LINK="$HOME/tekxai-signing/tekxai-codesign.pfx"
export WIN_CSC_KEY_PASSWORD="<the PFX password, from the local password file — never hard-code it>"
npm run build:win
```

No electron-builder config changes are needed for a new version — the
certificate and env vars are reused as-is.

## Authenticode trust vs. SmartScreen reputation — these are different things

Installing the TekXAI certificate into `TrustedPublisher` establishes
**Authenticode publisher trust**: Windows will identify the installer's
publisher as "TekXAI LLC" instead of "Unknown Publisher," and the basic
certificate-warning dialog goes away.

This is **separate** from **Microsoft SmartScreen reputation**, which is a
cloud-based reputation system tied to a public, widely-distributed
certificate and download telemetry that a self-signed internal certificate
does not and cannot participate in. Concretely:

- With the TekXAI certificate installed and trusted: no "Unknown Publisher"
  certificate warning; Explorer/Properties shows the signer as TekXAI LLC.
- SmartScreen may still show an "unrecognized app" warning on first runs,
  especially on machines seeing this binary for the first time, purely
  because of low download-volume reputation — **not** because the signature
  is invalid or untrusted.
- Do not represent this internal certificate as removing all SmartScreen
  warnings. It removes the *publisher-identity* warning; it does not buy
  public reputation, which only a publicly-trusted (paid, CA-issued or EV)
  certificate with sufficient distribution volume can build over time.

## Git safety

- The public `.cer` is **not** stored in this repository.
- `.gitignore` excludes `*.pfx`, `*.p12`, `*.key`, `*.cer`, `*.crt`,
  `*password*.txt`, and a `signing/` directory, so none of this material can
  be accidentally committed.
- The install/uninstall scripts contain no certificate bytes, no private key,
  and no password — only the public thumbprint (which is not secret; it is
  the certificate's own public fingerprint).
