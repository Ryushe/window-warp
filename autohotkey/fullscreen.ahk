#Requires AutoHotkey v2.0

global Saved := Map()
global SharedHotkeyRegistryPath := A_ScriptDir "\hotkey_registry.ini"

fullscreenHotkey := Fullscreen_GetSharedHotkey("fullscreen.toggle", "#z")
if fullscreenHotkey != "" {
    Hotkey(fullscreenHotkey, ToggleFullscreenWindow)
}

ToggleFullscreenWindow(*) {
    if !Fullscreen_ExactHotkeyModifiersMatch(A_ThisHotkey) {
        return
    }

    if !Fullscreen_WindowWarpHotkeysAreEnabled() {
        return
    }

    hwnd := WinGetID("A")
    if !hwnd
        return

    state := WinGetMinMax(hwnd)

    if (state = 1) {
        WinRestore(hwnd)
        Sleep 60

        if Saved.Has(hwnd) {
            r := Saved[hwnd]
            WinMove(r.x, r.y, r.w, r.h, hwnd)
        }
        return
    }

    if (state = -1) {
        WinRestore(hwnd)
        Sleep 60
    }

    x := y := w := h := 0
    WinGetPos(&x, &y, &w, &h, hwnd)
    Saved[hwnd] := { x: x, y: y, w: w, h: h }

    WinMaximize(hwnd)
}

Fullscreen_GetSharedHotkey(id, fallback := "") {
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

Fullscreen_WindowWarpHotkeysAreEnabled() {
    try {
        return WindowWarpHotkeysEnabled
    } catch {
        return true
    }
}

Fullscreen_ExactHotkeyModifiersMatch(hotkey) {
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

    if Fullscreen_IsModifierPressed("#") != hasWin {
        return false
    }
    if Fullscreen_IsModifierPressed("^") != hasCtrl {
        return false
    }
    if Fullscreen_IsModifierPressed("!") != hasAlt {
        return false
    }
    if Fullscreen_IsModifierPressed("+") != hasShift {
        return false
    }

    return true
}

Fullscreen_IsModifierPressed(modifierToken) {
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
