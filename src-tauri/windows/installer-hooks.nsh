; Hooks Tauri's NSIS installer runs (bundle.windows.nsis.installerHooks in tauri.conf.json).

; The installer finds the previous install's folder under Software\<publisher>\Nyxs. Up to 0.8.56
; the publisher was "destinopositivo": an update that finds nothing under the new name would put
; a second copy in the default folder when the user had picked another one. This runs after the
; folder is chosen and before any file is copied, so pointing $INSTDIR back keeps the update in
; place. Only in update mode: a manual install keeps the folder the user picked on the page.
!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
    Push $0
    ReadRegStr $0 SHCTX "Software\Nyxs Code\Nyxs" ""
    ${If} $0 == ""
      ReadRegStr $0 SHCTX "Software\destinopositivo\Nyxs" ""
      ${If} $0 != ""
      ${AndIf} ${FileExists} "$0\*.*"
        StrCpy $INSTDIR $0
        SetOutPath $INSTDIR
      ${EndIf}
    ${EndIf}
    Pop $0
  ${EndIf}
!macroend
