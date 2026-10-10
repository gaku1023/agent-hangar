; NSIS hooks for the Windows installer (bundle.windows.nsis.installerHooks).
; Keep this file ASCII only: NSIS reads it in the installer's own code page.

; The bundled CLI (server\bin\hangar.cmd) goes on the user's PATH, so "hangar" works in a new terminal.
; PowerShell edits HKCU\Environment Path directly, instead of NSIS strings:
; NSIS strings are cut at 1024 characters, and a user PATH is often longer than that.
; It keeps the value kind (REG_EXPAND_SZ stays unexpanded, so %USERPROFILE% entries survive),
; appends only when the folder is not there yet (updates run this again), and on remove drops every spelling of it.
; The folder and the operation come in through environment variables, so no path is quoted inside the script.
; apps/desktop/test/nsis-path.test.ts runs this line against a throwaway registry key on Windows.
!define HANGAR_PATH_PS "$$d = $$env:HANGAR_PATH_DIR.TrimEnd('\'); $$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $$h = $$k.GetValueNames() -contains 'Path'; $$t = if ($$h) { $$k.GetValueKind('Path') } else { 'ExpandString' }; $$o = if ($$h) { [string]$$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }; $$p = @($$o -split ';' | ? { $$_ -ne '' }); $$r = @($$p | ? { $$_.TrimEnd('\') -ne $$d }); $$n = $$o; if ($$env:HANGAR_PATH_OP -eq 'add') { if ($$r.Count -eq $$p.Count) { $$n = (@($$p) + $$d) -join ';' } } elseif ($$r.Count -lt $$p.Count) { $$n = $$r -join ';' }; if ($$n -ne $$o) { if ($$n) { $$k.SetValue('Path', $$n, $$t) } else { $$k.DeleteValue('Path') } }; $$k.Close()"

!macro HANGAR_EDIT_USER_PATH OP
  System::Call 'kernel32::SetEnvironmentVariable(t "HANGAR_PATH_DIR", t "$INSTDIR\server\bin")'
  System::Call 'kernel32::SetEnvironmentVariable(t "HANGAR_PATH_OP", t "${OP}")'
  Push $0
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "${HANGAR_PATH_PS}"`
  Pop $0
  Pop $0
  ; Tell Explorer and other running programs that the environment changed (HWND_BROADCAST, WM_SETTINGCHANGE).
  ; SMTO_ABORTIFHUNG (0x2) skips windows that do not respond.
  ; NSIS's SendMessage /TIMEOUT waits the full timeout for each of them: with 10 such windows, install and uninstall stalled for about 50 seconds.
  System::Call 'user32::SendMessageTimeoutW(p 0xFFFF, i 0x1A, p 0, w "Environment", i 0x2, i 5000, p 0)'
!macroend

; The bundled server (with the UI assets) lives in $INSTDIR\server.
; Tauri only overwrites the files of the version being installed, and its uninstaller deletes only those.
; Files that only an older version had (the UI assets carry a hash in their names) were left behind by every update.
; The folder is emptied only when it is known to be Hangar's: the uninstaller and both bundled entry points are there.
; User data (~\.agent-hangar) is never touched.
Var HangarServerOwned

!macro HANGAR_CHECK_SERVER_OWNED
  StrCpy $HangarServerOwned 0
  ${If} $INSTDIR != ""
  ${AndIf} ${FileExists} "$INSTDIR\uninstall.exe"
  ${AndIf} ${FileExists} "$INSTDIR\server\server.mjs"
  ${AndIf} ${FileExists} "$INSTDIR\server\cli.mjs"
    StrCpy $HangarServerOwned 1
  ${EndIf}
!macroend

; Runs before any file is copied, and before Tauri's check for a running app (CheckIfAppIsRunning).
; An update starts the installer and then the app quits, so wait a little for it to go (only with /UPDATE).
; If the app is still running, leave the folder as it is: the install may still be cancelled at Tauri's check,
; and an emptied folder would break the version that is installed now.
!macro NSIS_HOOK_PREINSTALL
  Push $R8
  Push $R9
  !insertmacro HANGAR_CHECK_SERVER_OWNED
  ${If} $HangarServerOwned = 1
    StrCpy $R9 0
    ${Do}
      !if "${INSTALLMODE}" == "currentUser"
        nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
      !else
        nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
      !endif
      ; 0 when the app is running.
      Pop $R8
      ${If} $R8 <> 0
      ${OrIf} $UpdateMode <> 1
      ${OrIf} $R9 >= 20
        ${ExitDo}
      ${EndIf}
      Sleep 500
      IntOp $R9 $R9 + 1
    ${Loop}
    ${If} $R8 <> 0
      RMDir /r "$INSTDIR\server"
    ${EndIf}
  ${EndIf}
  Pop $R9
  Pop $R8
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro HANGAR_EDIT_USER_PATH "add"
!macroend

; Runs before the files are removed, while $INSTDIR still names the installed folder.
; Whether $INSTDIR\server is Hangar's is decided here, while the files are still there.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro HANGAR_EDIT_USER_PATH "remove"
  !insertmacro HANGAR_CHECK_SERVER_OWNED
!macroend

; The shell writes these on every launch, for toast notifications (src-tauri/src/notify.rs, mod toast).
; Remove them on uninstall so nothing is left behind.
; The values must match notify.rs (APP_ID and ACTIVATOR_CLSID); apps/desktop/test/config.test.ts checks that.
; User data under .agent-hangar (the database and the rest) is never touched here.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\dev.agent-hangar.hangar"
  DeleteRegKey HKCU "Software\Classes\CLSID\{1CE6AB2A-D79D-49F4-88B0-5A9E624A75E4}"
  Delete "$PROFILE\.agent-hangar\notify-icon.png"
  ; Tauri removes $INSTDIR only when it is empty, so files left over from older versions kept it.
  ; This runs after Tauri's check for a running app, so the uninstall can no longer be cancelled.
  ${If} $HangarServerOwned = 1
    RMDir /r "$INSTDIR\server"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
