#Requires AutoHotkey v2.0

global SharedHotkeyRegistryPath := A_ScriptDir "\hotkey_registry.ini"

killHotkey := Kill_GetSharedHotkey("kill.close-active", "#q")
if killHotkey != "" {
    Hotkey(killHotkey, CloseActiveWindow)
}

CloseActiveWindow(*) {
    if !Kill_ExactHotkeyModifiersMatch(A_ThisHotkey) {
        return
    }

    if !Kill_WindowWarpHotkeysAreEnabled() {
        return
    }

    hwnd := WinExist("A")
    if hwnd {
        WinClose hwnd
    }
}

Kill_GetSharedHotkey(id, fallback := "") {
    global SharedHotkeyRegistryPath

    if !FileExist(SharedHotkeyRegistryPath) {
        return fallback
    }

    count := IniRead(SharedHotkeyRegistryPath, "Meta", "count", "0") + 0
    Loop count {
        section := "Hotkey" . A_Index
        entryId := IniRead(SharedHotkeyRegistryPath, section, "id", "")
        if entryId != id {
            continue
        }

        return IniRead(SharedHotkeyRegistryPath, section, "hotkey", "")
    }

    return fallback
}

Kill_WindowWarpHotkeysAreEnabled() {
    try {
        return WindowWarpHotkeysEnabled
    } catch {
        return true
    }
}

Kill_ExactHotkeyModifiersMatch(hotkey) {
    modifiers := ""
    hotkey := Trim(hotkey)

    if RegExReplace(A_ThisHotkey, "\s+Up$") = hotkey {
        return true
    }

    while hotkey != "" {
        prefix := SubStr(hotkey, 1, 1)
        if InStr("*~$", prefix) {
            hotkey := SubStr(hotkey, 2)
            continue
        }
        if InStr("#^!+", prefix) {
            if !InStr(modifiers, prefix) {
                modifiers .= prefix
            }
            hotkey := SubStr(hotkey, 2)
            continue
        }
        break
    }

    hasWin := InStr(modifiers, "#") > 0
    hasCtrl := InStr(modifiers, "^") > 0
    hasAlt := InStr(modifiers, "!") > 0
    hasShift := InStr(modifiers, "+") > 0

    if Kill_IsModifierPressed("#") != hasWin {
        return false
    }
    if Kill_IsModifierPressed("^") != hasCtrl {
        return false
    }
    if Kill_IsModifierPressed("!") != hasAlt {
        return false
    }
    if Kill_IsModifierPressed("+") != hasShift {
        return false
    }

    return true
}

Kill_IsModifierPressed(modifierToken) {
    switch modifierToken {
        case "#":
            return GetKeyState("LWin", "P") || GetKeyState("RWin", "P")
        case "^":
            return GetKeyState("Ctrl", "P")
        case "!":
            return GetKeyState("Alt", "P")
        case "+":
            return GetKeyState("Shift", "P")
    }

    return false
}
