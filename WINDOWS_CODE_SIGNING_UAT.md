# TekXAI Internal Code-Signing — Windows UAT Runbook

Run every command below on the real TekXAI Windows employee machine, in an
**elevated (Administrator) PowerShell** window unless a step says otherwise.
Fill in the Result line under each step.

## Files you need (from the transfer package)
- `tekxai-codesign-public.cer` (public certificate only)
- `install-tekxai-code-signing-cert.ps1`
- `uninstall-tekxai-code-signing-cert.ps1`
- `TEKxAI Agent Setup 1.3.3.exe` (the signed installer, transferred separately)

Put the three script/cert files in the same folder (e.g. `C:\tekxai-signing-deploy\`) — the install script looks for `tekxai-codesign-public.cer` next to itself by default.

---

## STEP 1 — Verify Windows

```powershell
[System.Environment]::OSVersion.Version
$PSVersionTable.PSVersion
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```
**Expected:** a Windows 10/11 version number, PowerShell 5.1+, and `True` for the admin check (if `False`, re-open PowerShell as Administrator before continuing).
**Result:** _____

## STEP 2 — Install the public certificate

```powershell
cd C:\tekxai-signing-deploy
powershell -ExecutionPolicy Bypass -File .\install-tekxai-code-signing-cert.ps1
```
**Expected output:** ends with `RESULT: Certificate installed and verified successfully.`, `Subject : CN=TekXAI LLC, O=TekXAI LLC, C=US`, `Thumbprint : 4DAD471705AE5659F3E6ACE19F5C1160F35A39AB`.
**Result:** _____

Confirm directly:
```powershell
$cert = Get-ChildItem Cert:\LocalMachine\TrustedPublisher | Where-Object { $_.Thumbprint -eq '4DAD471705AE5659F3E6ACE19F5C1160F35A39AB' }
$cert | Format-List Subject, Thumbprint
```
**Expected:** `Subject : CN=TekXAI LLC, O=TekXAI LLC, C=US`, `Thumbprint : 4DAD471705AE5659F3E6ACE19F5C1160F35A39AB`.
**Result:** _____

## STEP 3 — Verify certificate store location

```powershell
Test-Path Cert:\LocalMachine\TrustedPublisher\4DAD471705AE5659F3E6ACE19F5C1160F35A39AB
```
**Expected:** `True`.
**Result:** _____

## STEP 4 — Verify NO private key is present

```powershell
$cert.HasPrivateKey
Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.Thumbprint -eq '4DAD471705AE5659F3E6ACE19F5C1160F35A39AB' }
dir C:\tekxai-signing-deploy\*.pfx, C:\tekxai-signing-deploy\*.p12, C:\tekxai-signing-deploy\*.key -ErrorAction SilentlyContinue
```
**Expected:** `$cert.HasPrivateKey` is `False`; the `Cert:\LocalMachine\My` (personal/private) store lookup returns nothing; no `.pfx`/`.p12`/`.key` files exist anywhere on the machine.
**Result:** _____

## STEP 5 — Run the signed installer

```powershell
& "C:\path\to\TEKxAI Agent Setup 1.3.3.exe"
```
While the install prompt is on screen, check the publisher line, then afterward:
```powershell
Get-AuthenticodeSignature "C:\path\to\TEKxAI Agent Setup 1.3.3.exe" | Format-List Status, StatusMessage, SignerCertificate
```
**Expected:** `Status : Valid`, `SignerCertificate.Subject` contains `CN=TekXAI LLC`; the install prompt shows **"Verified publisher: TekXAI LLC"**, not "Unknown Publisher".
**Result — publisher shown:** _____
**Result — signature Status:** _____
**Result — Unknown Publisher warning appeared? (should be No):** _____

## STEP 6 — SmartScreen (record separately — do not act on it)

Observe and record exactly one of:
- [ ] No SmartScreen screen appeared at all
- [ ] A SmartScreen-style screen appeared but the publisher was identified as TekXAI LLC
- [ ] The blue "Windows protected your PC" **unrecognized-app** interstitial appeared (publisher not conveying trust to SmartScreen's reputation system)

**Do not** click through Windows Security settings to disable SmartScreen/Defender to make this go away — just record what appeared. This is a separate system from the Authenticode publisher trust in Step 5 — see the note at the bottom of this file.
**Result:** _____

## STEP 7 — Idempotency (install script run again)

```powershell
powershell -ExecutionPolicy Bypass -File .\install-tekxai-code-signing-cert.ps1
(Get-ChildItem Cert:\LocalMachine\TrustedPublisher | Where-Object { $_.Thumbprint -eq '4DAD471705AE5659F3E6ACE19F5C1160F35A39AB' }).Count
```
**Expected:** output ends with `RESULT: Certificate is already installed. No changes made.`; count is `1` (no duplicate); no error.
**Result:** _____

## STEP 8 — Uninstall test

First capture the current store contents to compare against afterward:
```powershell
Get-ChildItem Cert:\LocalMachine\TrustedPublisher | Select-Object Subject, Thumbprint | Export-Csv C:\tekxai-signing-deploy\before-uninstall.csv -NoTypeInformation
```
Then:
```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-tekxai-code-signing-cert.ps1
Get-ChildItem Cert:\LocalMachine\TrustedPublisher | Select-Object Subject, Thumbprint
```
**Expected:** script output ends with `RESULT: Certificate removed and verified absent.`; the TekXAI entry (thumbprint `4DAD471705AE5659F3E6ACE19F5C1160F35A39AB`) is gone; every other row from `before-uninstall.csv` is still present, unchanged.
**Result — TekXAI cert removed:** _____
**Result — unrelated certs untouched:** _____

## STEP 9 — Reinstall and verify restoration

```powershell
powershell -ExecutionPolicy Bypass -File .\install-tekxai-code-signing-cert.ps1
Get-ChildItem Cert:\LocalMachine\TrustedPublisher | Where-Object { $_.Thumbprint -eq '4DAD471705AE5659F3E6ACE19F5C1160F35A39AB' } | Format-List Subject, Thumbprint
```
**Expected:** installs successfully again (not "already installed", since Step 8 removed it), and the Format-List output matches Step 2 exactly.
**Result:** _____

## STEP 10 — Future update behavior (no re-install needed)

With the certificate now installed (from Step 9), run the same signed v1.3.3 installer again (or a newer signed build if one is available):
```powershell
& "C:\path\to\TEKxAI Agent Setup 1.3.3.exe"
```
**Expected:** installs/launches with the same "Verified publisher: TekXAI LLC" trust as Step 5, with **no certificate-install script run in between** — proving future signed releases will not require employees to reinstall the certificate.
**Result:** _____

---

## Report back exactly this

- **A. Authenticode/signature trust:** pass/fail (Steps 4-signature-check, 5)
- **B. Publisher identity:** pass/fail (Step 5)
- **C. SmartScreen behavior:** exactly what was observed in Step 6 (screenshot ideal)
- Steps 1–10 Result lines, filled in

## Authenticode trust vs. SmartScreen — do not conflate these

Steps 2–5 test **Authenticode publisher trust**: once the TekXAI certificate
is in `LocalMachine\TrustedPublisher`, Windows identifies the installer's
signer as "TekXAI LLC" and drops the generic "Unknown Publisher" warning.
This is a certificate-trust decision made locally on this machine.

Step 6 tests **Microsoft SmartScreen reputation**, a cloud service tied to
download-volume telemetry for a binary/certificate, which a self-signed
internal certificate does not and cannot participate in. A SmartScreen
prompt appearing in Step 6 does **not** mean the certificate trust failed —
it is a separate system, and this internal certificate was never expected to
suppress it on its own.
