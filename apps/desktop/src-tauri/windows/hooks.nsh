; NSIS hooks for the Windows installer (bundle.windows.nsis.installerHooks).
; Keep this file ASCII only: NSIS reads it in the installer's own code page.
;
; The shell writes these on every launch, for toast notifications (src-tauri/src/notify.rs, mod toast).
; Remove them on uninstall so nothing is left behind.
; The values must match notify.rs (APP_ID and ACTIVATOR_CLSID); apps/desktop/test/config.test.ts checks that.
; User data under .agent-hangar (the database and the rest) is never touched here.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\dev.agent-hangar.hangar"
  DeleteRegKey HKCU "Software\Classes\CLSID\{1CE6AB2A-D79D-49F4-88B0-5A9E624A75E4}"
  Delete "$PROFILE\.agent-hangar\notify-icon.png"
!macroend
