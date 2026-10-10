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
  SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro HANGAR_EDIT_USER_PATH "add"
!macroend

; Runs before the files are removed, while $INSTDIR still names the installed folder.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro HANGAR_EDIT_USER_PATH "remove"
!macroend

; The shell writes these on every launch, for toast notifications (src-tauri/src/notify.rs, mod toast).
; Remove them on uninstall so nothing is left behind.
; The values must match notify.rs (APP_ID and ACTIVATOR_CLSID); apps/desktop/test/config.test.ts checks that.
; User data under .agent-hangar (the database and the rest) is never touched here.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\dev.agent-hangar.hangar"
  DeleteRegKey HKCU "Software\Classes\CLSID\{1CE6AB2A-D79D-49F4-88B0-5A9E624A75E4}"
  Delete "$PROFILE\.agent-hangar\notify-icon.png"
!macroend
