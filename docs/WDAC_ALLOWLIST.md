# Windows Device Guard / WDAC allowlist (interim)

## Why

Tekxai Agent historically used `screenshot-desktop`, which compiles/runs an
unsigned `screenCapture_*.exe` under `%TEMP%`. Windows Defender Application
Control (WDAC) / Device Guard blocks that helper → `CAPTURE_FAILED` →
fail-closed clock-in (Sibghat-class outages on v1.3.6).

**Current agent builds prefer Electron `desktopCapturer`** and do **not**
invoke the unsigned Windows JIT helper. Keep this allowlist for:

- Older agent versions still in the field
- Linux X11 ImageMagick fallback only (not WDAC)
- Defense-in-depth if a dependency regresses

## Recommended policy (IT)

1. Prefer publisher rules for **Tekxai LLC** / **TekXAI LLC** Authenticode
   (thumbprint documented in `scripts/verify-win-signature.js`).
2. Allow the installed Agent path, e.g.
   `C:\Users\*\AppData\Local\Programs\tekxai-agent\**`
   and the Update.exe companion under the same publisher.
3. Do **not** allowlist arbitrary `%TEMP%\screenCapture_*.exe` long-term —
   that re-opens the unsigned-helper trust gap. Upgrade agents instead.
4. Re-test clock-in after each Agent version bump; review
   `CAPTURE_FAILED` in Monitoring Permissions admin quarterly.

## Runbook

1. Confirm Agent version ≥ build that ships `desktopCapturer`-first capture.
2. If still failing: collect Event Viewer → CodeIntegrity / AppLocker blocks.
3. Apply publisher allowlist via MDM (Intune WDAC), not by trusting random TEMP EXEs.
4. Retest capture gate + clock-in; confirm monitoring session starts.
