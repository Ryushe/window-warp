; startup.rs uses WindowWarp, rather than Tauri's product-name Run value.
; Preserve startup during updates and when another installation owns the value.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    Push $0
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WindowWarp"
    ${If} $0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --startup'
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WindowWarp"
    ${EndIf}
    Pop $0
  ${EndIf}
!macroend
