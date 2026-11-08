; Residue an earlier installation leaves in $INSTDIR.
;
; An installer writes the files it ships and removes none it no longer ships. Switching the host
; from the compiled `omp-host.exe` to `bundle/` therefore leaves a 178 MB unsigned executable
; behind - one this build never starts, and the file antivirus engines flag. This hook deletes
; exactly the names that belong to the retired layout and the update path's own backups.
;
; Nothing else in $INSTDIR is touched: `bundle`, `plugin-templates`, `builtin-browser-marketplace`,
; an installed plugin directory and any file a user put there stay where they are. The same
; allowlist runs at start-up (`services::residue`), for installations an installer never touches.

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\omp_desktop.exe.old"
  Delete "$INSTDIR\omp_desktop.exe.old-*"
  IfFileExists "$INSTDIR\bundle\manifest.json" 0 omp_residue_done
    Delete "$INSTDIR\omp-host.exe"
    Delete "$INSTDIR\omp-host.json"
  omp_residue_done:
!macroend
