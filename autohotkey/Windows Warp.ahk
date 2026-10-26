#Requires AutoHotkey v2.0
#SingleInstance Force

#Include "window_manager.ahk"
#Include "fullscreen.ahk"
#Include "kill.ahk"

CloseLegacyWindowsWarpProcesses()

CloseLegacyWindowsWarpProcesses() {
    currentPid := ProcessExist()
    locator := ComObject("WbemScripting.SWbemLocator")
    service := locator.ConnectServer(".", "root\cimv2")
    query := "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'AutoHotkeyUX.exe' OR Name = 'AutoHotkey64.exe' OR Name = 'AutoHotkey32.exe' OR Name = 'AutoHotkey.exe'"

    for process in service.ExecQuery(query) {
        try pid := process.ProcessId
        catch
            continue

        if pid = currentPid {
            continue
        }

        try commandLine := process.CommandLine
        catch
            commandLine := ""

        if commandLine = "" {
            continue
        }

        lowerCommandLine := StrLower(commandLine)
        if !InStr(lowerCommandLine, StrLower(A_ScriptDir)) {
            continue
        }

        if InStr(lowerCommandLine, StrLower(A_ScriptDir . "\windows warp.ahk")) {
            continue
        }

        if InStr(lowerCommandLine, StrLower(A_ScriptDir . "\window_manager.ahk"))
            || InStr(lowerCommandLine, StrLower(A_ScriptDir . "\fullscreen.ahk"))
            || InStr(lowerCommandLine, StrLower(A_ScriptDir . "\kill.ahk")) {
            try ProcessClose(pid)
        }
    }
}
