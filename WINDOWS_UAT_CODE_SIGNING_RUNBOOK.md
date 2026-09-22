# Windows UAT Runbook — TekXAI Internal Code-Signing Certificate

This is the exact step-by-step procedure to run on a real TekXAI Windows
employee machine. Everything here was prepared and pre-verified from the
macOS build machine (signature validity, thumbprint match, no private key
in the transfer package); the sections below marked **[RUN ON WINDOWS]**
have not been executed — no Windows machine was available in this session.
Fill in the "Result" line under each step and send back.

## Files to transfer (nothing else)

From `~/tekxai-signing/windows-transfer-package/` on the build machine:
- `tekxai-codesign-public.cer` (public certificate only — no private key)
- `install-tekxai-code-signing-cert.ps1`
- `uninstall-tekxai-code-signing-cert.ps1`

Plus, separately: `dist/TEKxAI Agent Setup 1.3.3.exe` (the signed installer).

Do **not** transfer `tekxai-codesign.pfx`, `tekxai-codesign.key`, or the
password file — those stay on the signing operator's machine only.

Pre-verified on macOS (re-confirmed just now):
- `osslsigncode verify` on the installer: `Signature verification: ok` (both signature slots), `Number of verified signatures: 2`, `Succeeded`.
- Certificate SHA1 fingerprint: `4D:AD:47:17:05:AE:56:59:F3:E6:AC:E1:9F:5C:11:60:F3:5A:39:AB` — matches the script's hardcoded `$ExpectedThumbprint` exactly.
- `windows-transfer-package/` contains only the 3 files listed above; the `.cer` fails to parse as PKCS12 (proves it holds no private key).

---

## Step 1 — Copy files to the test machine
Copy only the 3 files above to e.g. `C:\tekxai-signing-deploy\`.
**Result:** _____

## Step 2 — Run the install script as Administrator
```powershell
cd C:\tekxai-signing-deploy
powershell -ExecutionPolicy Bypass -File .\install-tekxai-code-signing-cert.ps1
```
(Use your org's normal elevated-PowerShell method — right-click "Run as Administrator", or open an elevated prompt first. `-ExecutionPolicy Bypass` here scopes only to this one script invocation; it does not change the machine's execution policy, per your requirement not to touch security settings.)

Expected output: "Installing certificate..." then "RESULT: Certificate installed and verified successfully." with Subject `CN=TekXAI LLC, O=TekXAI LLC, C=US` and the thumbprint above.
**Result:** _____

## Step 3 — Verify certificate presence, thumbprint, subject, and NO private key
```powershell
$cert = Get-ChildItem Cert:\LocalMachine\TrustedPublisher | Where-Object { $_.Thumbprint -eq '4DAD471705AE5659F3E6ACE19F5C1160F35A39AB' }
$cert | Format-List Subject, Thumbprint, NotBefore, NotAfter, HasPrivateKey
```
Expected: one result, `Subject = CN=TekXAI LLC, O=TekXAI LLC, C=US`, `Thumbprint = 4DAD471705AE5659F3E6ACE19F5C1160F35A39AB`, **`HasPrivateKey = False`**.
**Result:** _____

## Step 4 — Run the signed installer
```powershell
& "C:\path\to\TEKxAI Agent Setup 1.3.3.exe"
```
While the UAC / installer publisher dialog is showing, check the publisher line.

Verify separately:
- **A. Authenticode/signature trust** — right-click the .exe → Properties → Digital Signatures tab → Details: should show "This digital signature is OK", signer `TekXAI LLC`, timestamp present.
  **Result:** _____
- **B. Publisher identity** — the UAC/installer prompt should show "Verified publisher: TekXAI LLC" (not "Unknown Publisher"), because the certificate is now in `TrustedPublisher`.
  **Result:** _____
- **C. SmartScreen behavior** — observe separately whether a SmartScreen "Windows protected your PC" screen appears. **This is expected to still be possible** on a machine seeing this binary for the first time — a self-signed internal certificate does not grant Microsoft SmartScreen reputation (see `WINDOWS_CODE_SIGNING_DEPLOYMENT.md`). Record exactly what appeared, if anything, and whether it was the *publisher-unknown* variant or the *reputation/SmartScreen* variant (they look different — SmartScreen's is the blue "Windows protected your PC" full-screen interstitial with an "More info" → "Run anyway" path; publisher-untrusted is a plain UAC consent dialog).
  **Result:** _____

Do **not** click through/dismiss SmartScreen via registry or Group Policy to make it disappear — just observe and record what happens, per your instruction not to touch security settings.

## Step 5 — (see A/B/C above, same step)

## Step 6 — Run the install script a SECOND time
```powershell
powershell -ExecutionPolicy Bypass -File .\install-tekxai-code-signing-cert.ps1
```
Expected: "RESULT: Certificate is already installed. No changes made." — no duplicate entry created.
Confirm no duplicate:
```powershell
(Get-ChildItem Cert:\LocalMachine\TrustedPublisher | Where-Object { $_.Thumbprint -eq '4DAD471705AE5659F3E6ACE19F5C1160F35A39AB' }).Count
```
Expected: `1`.
**Result:** _____

## Step 7 — Run the uninstall script
```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-tekxai-code-signing-cert.ps1
```
Expected: "RESULT: Certificate removed and verified absent."

Verify only the TekXAI cert was removed, and unrelated certificates in the same store are untouched:
```powershell
Get-ChildItem Cert:\LocalMachine\TrustedPublisher | Select-Object Subject, Thumbprint
```
Compare this list against the one from before Step 7 (capture it beforehand) — every entry except the TekXAI one (thumbprint `4DAD471705AE5659F3E6ACE19F5C1160F35A39AB`) should still be present.
**Result:** _____

## Step 8 — Reinstall and verify again
Repeat Step 2, then Step 3.
**Result:** _____

## Step 9 — Future-release test (no re-install of the certificate)
This proves the certificate, once trusted, covers every future signed release without re-running the install script. Since v1.3.3 is the only signed build available right now, this step needs either:
- (a) a second signed build (e.g., a v1.3.4 test build signed with the same `~/tekxai-signing/tekxai-codesign.pfx`) copied to the Windows machine and run — it should install/launch with the same "Verified publisher: TekXAI LLC" and no fresh certificate prompt, **without running the install script again**; or
- (b) at minimum, re-running `TEKxAI Agent Setup 1.3.3.exe` a second time on this same machine after Step 8, confirming the publisher is still trusted with no re-prompt for certificate trust.
**Result:** _____

## Step 10 — Confirm no security settings were changed
```powershell
Get-ExecutionPolicy -List
```
Compare against a pre-UAT snapshot (capture before Step 1) — should be identical; the scripts never call `Set-ExecutionPolicy`. Also confirm Windows Defender / SmartScreen settings (Windows Security → App & browser control) were not touched.
**Result:** _____

---

## Report back

Once run, send back the filled-in Results above, plus:
- **A. Authenticode/signature trust**: pass/fail
- **B. Publisher identity**: pass/fail
- **C. SmartScreen behavior**: exactly what was observed (screenshot ideal)

I will not claim SmartScreen is "fixed" regardless of outcome — A and B are Authenticode/publisher-trust outcomes; C is a separate, unrelated reputation system this internal certificate does not and cannot affect.
