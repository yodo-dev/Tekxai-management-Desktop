; installer.nsh
;
; Custom NSIS include for the TEKxAI Agent Windows installer.
;
; Why this file exists: electron-builder (24.13.3, and confirmed still true
; as of the current latest 26.15.3 — see NsisOptions typings, there is no
; `closeApplication`/`restartApplication` NSIS option in electron-builder at
; any version; those keys belong to a different installer framework and were
; mistakenly added in commit 9c4fc68, then reverted in 0320daf because
; electron-builder's config validation rejected them outright) has no
; built-in "close the running app before installing" behavior for the NSIS
; target. electron-builder's own supported extension point for exactly this
; kind of need is a custom NSIS include script wired in via `nsis.include`
; (see https://www.electron.build/docs/nsis#custom-nsis-script).
;
; This file is inserted into the generated installer's `.onInit` via the
; `customInit` macro, which electron-builder's installer.nsi template
; invokes BEFORE any files are copied (see
; app-builder-lib/templates/nsis/installer.nsi, "!ifmacrodef customInit").
; That is the correct lifecycle point: detect-and-close must happen before
; file copy, not after, or the "file in use" failure still occurs.
;
; Behavior:
;   1. Check whether TEKxAI Agent.exe is currently running (tasklist).
;   2. If not running, do nothing and continue the install unchanged.
;   3. If running, ask it to close gracefully (taskkill without /F, which
;      sends a WM_CLOSE to the process's windows rather than killing it).
;   4. Poll for up to ~10 seconds for the process to exit on its own.
;   5. If it is still running after that, force-terminate it (taskkill /F)
;      so the installer can proceed instead of failing with
;      "Another program is currently using this file."
;
; Scoped narrowly to the Windows NSIS installer only. Does not touch
; src/main.js, requestSingleInstanceLock(), or the in-app auto-update path
; (autoUpdater.quitAndInstall() already fully quits before installing and is
; unaffected by this file).
;
; TekXAI code-signing certificate trust (added alongside the above,
; unrelated to it — see the running-app block for that):
;
; Windows treats an internal/self-signed Authenticode certificate as
; untrusted unless it is present in the LocalMachine\TrustedPublisher
; store. Without it, this signed installer still shows an "Unknown
; Publisher" warning on every employee machine. Since electron-builder has
; no built-in option for "also trust this certificate," the same
; `customInit` extension point used above is the correct, already-
; supported place to do it — it runs once, before file copy, every install.
;
; `nsis.perMachine: true` (electron-builder.config.js) makes the generated
; installer request admin elevation via the standard Windows UAC prompt
; (`RequestExecutionLevel admin`) — so by the time this macro runs, it is
; already elevated. No custom elevation helper, no UAC bypass.
;
; Idempotency: `certutil -store TrustedPublisher <thumbprint>` exits 0 only
; if a certificate with that exact thumbprint is already present. Only a
; MISSING certificate triggers the `-addstore` import — an already-trusted
; machine does nothing on every subsequent install/update.
;
; Only the PUBLIC certificate (build/tekxai-codesign-public.cer) is ever
; referenced here. The private key/PFX/password are never part of this
; installer's build inputs.

!macro customInit
  ; Only relevant for the real installer, not the uninstaller.
  !ifndef BUILD_UNINSTALLER
    DetailPrint "Checking whether TEKxAI Agent is currently running..."

    ; tasklist exits 0 and prints a row containing the image name if the
    ; process is running; if not running it still exits 0 but prints
    ; "INFO: No tasks..." — so we grep the output rather than rely on the
    ; exit code alone.
    nsExec::ExecToStack 'cmd /C tasklist /FI "IMAGENAME eq TEKxAI Agent.exe" | find /I "TEKxAI Agent.exe"'
    Pop $0 ; exit code of the pipeline (0 = "find" matched a line)
    Pop $1 ; captured stdout, unused beyond the exit code check

    ${If} $0 == 0
      DetailPrint "TEKxAI Agent is running — requesting graceful close before install."

      ; Graceful close attempt: no /F, so Windows sends a close request to
      ; the app's windows instead of killing the process outright.
      nsExec::Exec 'taskkill /IM "TEKxAI Agent.exe"'

      ; Poll for the process to actually exit, up to ~10 seconds.
      StrCpy $2 0 ; elapsed iterations
      loop_wait_close:
        nsExec::ExecToStack 'cmd /C tasklist /FI "IMAGENAME eq TEKxAI Agent.exe" | find /I "TEKxAI Agent.exe"'
        Pop $0
        Pop $1
        ${If} $0 != 0
          ; No longer found — it closed on its own.
          Goto done_wait_close
        ${EndIf}

        IntOp $2 $2 + 1
        ${If} $2 >= 20
          ; ~10 seconds elapsed (20 * 500ms) and it is still running —
          ; stop waiting and force it.
          Goto force_close
        ${EndIf}

        Sleep 500
        Goto loop_wait_close

      force_close:
        DetailPrint "TEKxAI Agent did not close in time — forcing it closed."
        nsExec::Exec 'taskkill /IM "TEKxAI Agent.exe" /F'
        ; Give the OS a brief moment to actually release file handles after
        ; the forced kill before the installer starts copying files.
        Sleep 1000

      done_wait_close:
        DetailPrint "Proceeding with installation."
    ${Else}
      DetailPrint "TEKxAI Agent is not running — continuing installation."
    ${EndIf}

    ; --- TekXAI code-signing certificate trust (idempotent) ---
    DetailPrint "Checking TekXAI code-signing certificate trust..."

    ; certutil's own thumbprint lookup — 0 only if this exact certificate
    ; is already in LocalMachine\TrustedPublisher.
    nsExec::ExecToStack 'certutil -store TrustedPublisher 4DAD471705AE5659F3E6ACE19F5C1160F35A39AB'
    Pop $3 ; exit code
    Pop $4 ; captured stdout, unused beyond the exit code check

    ${If} $3 == 0
      DetailPrint "TekXAI code-signing certificate already trusted — nothing to do."
    ${Else}
      DetailPrint "Installing TekXAI code-signing certificate into LocalMachine\TrustedPublisher..."

      ; Extract the bundled public certificate to a temp dir so certutil has
      ; a real file path to import from. ${BUILD_RESOURCES_DIR} is
      ; electron-builder's own compile-time constant for this project's
      ; build/ directory — the standard way a custom NSIS script bundles a
      ; project file (see electron-builder's NSIS docs). Only the public
      ; .cer is ever referenced; no key/PFX/password exists in build/.
      InitPluginsDir
      SetOutPath "$PLUGINSDIR"
      File "${BUILD_RESOURCES_DIR}\tekxai-codesign-public.cer"

      nsExec::ExecToStack 'certutil -addstore TrustedPublisher "$PLUGINSDIR\tekxai-codesign-public.cer"'
      Pop $5 ; exit code
      Pop $6 ; captured output, shown on failure below

      ${If} $5 == 0
        DetailPrint "TekXAI code-signing certificate installed successfully."
      ${Else}
        ; Fail clearly rather than silently continue as if it had worked —
        ; a missing certificate means every future TEKxAI Agent update
        ; would show "Unknown Publisher" on this machine.
        DetailPrint "ERROR: Failed to install the TekXAI code-signing certificate (certutil exit code $5)."
        MessageBox MB_ICONSTOP "Failed to install the TekXAI code-signing certificate required to trust TEKxAI Agent updates.$\r$\n$\r$\nInstallation cannot continue. Please contact IT support.$\r$\n$\r$\nDetails: $6"
        Abort
      ${EndIf}
    ${EndIf}
  !endif
!macroend
