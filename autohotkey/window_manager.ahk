#Requires AutoHotkey v2.0
#SingleInstance Force
CoordMode("Mouse", "Screen")

global MoveHistory := []
global LastPushAction := Map()
global ConfiguredAppPreviousWindow := Map()
global ConfiguredPullHotkeyState := Map()
global ConfiguredPullBuilderState := Map()
global PushRetileDelayMs := 1000
global WindowWarpSettingsPath := A_ScriptDir "\windows_warp_settings.ini"
global WindowWarpSettings := LoadWindowWarpSettings()
global ConfiguredPullHoldDelayMs := WindowWarpSettings["holdDelayMs"]
global ConfiguredPullHoldTileEnabled := WindowWarpSettings["holdTileEnabled"]
global ConfiguredPullHoldMode := WindowWarpSettings["holdMode"]
global ConfiguredPullRadialState := Map()
global BurnerMonitorIndex := 2
global ConfiguredPullConfigPath := A_ScriptDir "\window_manager_apps.ini"
global SharedHotkeyRegistryPath := A_ScriptDir "\hotkey_registry.ini"
global WorkspaceOpenerConfigPath := A_ScriptDir "\workspace_openers.ini"
#Include "window_manager_hotkeys.ahk"
#Include "window_manager_opener.ahk"

global SharedHotkeyRegistry := InitializeSharedHotkeyRegistry()
global ConfiguredPullHotkeys := InitializeConfiguredPullHotkeys()
global WorkspaceOpenerProfiles := LoadWorkspaceOpenerProfiles()
global LastLaunchedWorkspaceId := ""
global LastUpdatedWorkspaceId := ""
global WindowWarpHotkeysEnabled := true

#x::HandleMoveWindowDirectionHotkey("left", false)
#c::HandleMoveWindowDirectionHotkey("right", false)
#^x::HandleMoveWindowDirectionHotkey("left", true)
#^c::HandleMoveWindowDirectionHotkey("right", true)
#b::HandleOpenConfiguredHotkeyBuilderHotkey()
#o::HandleOpenWorkspaceOpenerHotkey()
#y::HandleOpenWorkspaceUpdateHotkey()
#r::HandlePullMostRecentWindowHotkey()
#SuspendExempt
#;::ToggleWindowManagerSuspend()
#SuspendExempt False

RegisterConfiguredPullHotkeys()
RegisterRetileHotkeys()
OnMessage(0x100, HandleConfiguredPullBuilderKeyDown)
OnMessage(0x200, HandleConfiguredPullBuilderMouseMove)
OnMessage(0x20A, HandleWindowManagerMouseWheel)


HandleRetileLeft(*) {
    if !ExactHotkeyModifiersMatch(A_ThisHotkey) {
        return
    }
    HandleRetileHotkey("left")
}

HandleRetileRight(*) {
    if !ExactHotkeyModifiersMatch(A_ThisHotkey) {
        return
    }
    HandleRetileHotkey("right")
}

HandleRetileHotkey(direction) {
    global LastPushAction

    if !LastPushAction.Count || !LastPushAction.Has("hwnd") || !LastPushAction.Has("tick") {
        DisableRetileHotkeys()
        return
    }

    if (A_TickCount - LastPushAction["tick"]) > PushRetileDelayMs {
        ClearLastPushAction()
        DisableRetileHotkeys()
        return
    }

    hwnd := LastPushAction["hwnd"]
    if !WinExist("ahk_id " hwnd) {
        ClearLastPushAction()
        DisableRetileHotkeys()
        return
    }

    WinActivate("ahk_id " hwnd)
    TileWindowOnCurrentMonitor(hwnd, direction)
    ClearLastPushAction()
    DisableRetileHotkeys()
}

PullMostRecentWindow(*) {
    global MoveHistory

    while MoveHistory.Length > 0 {
        entry := MoveHistory.Pop()
        hwnd := entry["hwnd"]

        if !WinExist("ahk_id " hwnd) {
            continue
        }

        WinActivate("ahk_id " hwnd)

        if WinGetMinMax("ahk_id " hwnd) = -1 {
            WinRestore("ahk_id " hwnd)
        }

        RestoreWindowPlacement(hwnd, entry)

        CenterMouseOnMonitor(MonitorGetPrimary())
        return
    }
}

ApplyRelativePlacement(hwnd, source, target) {
    if source["state"] = 1 {
        WinRestore("ahk_id " hwnd)
    }

    targetWidth := target["workRight"] - target["workLeft"]
    targetHeight := target["workBottom"] - target["workTop"]

    newX := Round(target["workLeft"] + (source["relX"] * targetWidth))
    newY := Round(target["workTop"] + (source["relY"] * targetHeight))
    newW := Max(80, Round(source["relW"] * targetWidth))
    newH := Max(80, Round(source["relH"] * targetHeight))

    if newW > targetWidth {
        newW := targetWidth
    }
    if newH > targetHeight {
        newH := targetHeight
    }

    newX := Max(target["workLeft"], Min(newX, target["workRight"] - newW))
    newY := Max(target["workTop"], Min(newY, target["workBottom"] - newH))

    WinMove(newX, newY, newW, newH, "ahk_id " hwnd)

    if source["state"] = 1 {
        WinMaximize("ahk_id " hwnd)
    }
}

GetWindowPlacementInfo(hwnd) {
    try {
        WinGetPos(&x, &y, &w, &h, "ahk_id " hwnd)
    } catch {
        return 0
    }

    monitors := GetOrderedMonitors()
    if monitors.Length = 0 {
        return 0
    }

    centerX := x + (w / 2)
    centerY := y + (h / 2)
    monitor := FindMonitorForPoint(centerX, centerY, monitors)
    if !monitor {
        return 0
    }

    workWidth := Max(1, monitor["workRight"] - monitor["workLeft"])
    workHeight := Max(1, monitor["workBottom"] - monitor["workTop"])
    state := WinGetMinMax("ahk_id " hwnd)

    if state = 1 {
        relX := 0
        relY := 0
        relW := 1
        relH := 1
    } else {
        relX := Clamp((x - monitor["workLeft"]) / workWidth, 0, 1)
        relY := Clamp((y - monitor["workTop"]) / workHeight, 0, 1)
        relW := Clamp(w / workWidth, 0.05, 1)
        relH := Clamp(h / workHeight, 0.05, 1)
    }

    return Map(
        "monitorIndex", monitor["index"],
        "state", state,
        "x", x,
        "y", y,
        "w", w,
        "h", h,
        "relX", relX,
        "relY", relY,
        "relW", relW,
        "relH", relH
    )
}

GetAdjacentMonitor(currentIndex, direction) {
    monitors := GetOrderedMonitors()
    if monitors.Length = 0 {
        return 0
    }

    currentPos := 0
    for index, monitor in monitors {
        if monitor["index"] = currentIndex {
            currentPos := index
            break
        }
    }

    if !currentPos {
        return 0
    }

    if direction = "left" {
        targetPos := currentPos - 1
        if targetPos < 1 {
            targetPos := monitors.Length
        }
    } else {
        targetPos := currentPos + 1
        if targetPos > monitors.Length {
            targetPos := 1
        }
    }

    return monitors[targetPos]
}

GetMonitorByIndex(targetIndex) {
    monitors := GetOrderedMonitors()
    for _, monitor in monitors {
        if monitor["index"] = targetIndex {
            return monitor
        }
    }

    return 0
}

GetConfiguredBurnerMonitor(primaryIndex) {
    global BurnerMonitorIndex

    burner := GetMonitorByIndex(BurnerMonitorIndex)
    if burner && burner["index"] != primaryIndex {
        return burner
    }

    monitors := GetOrderedMonitors()
    for _, monitor in monitors {
        if monitor["index"] != primaryIndex {
            return monitor
        }
    }

    return 0
}

GetOrderedMonitors() {
    monitors := []
    primaryIndex := MonitorGetPrimary()

    Loop MonitorGetCount() {
        index := A_Index
        MonitorGet(index, &left, &top, &right, &bottom)
        MonitorGetWorkArea(index, &workLeft, &workTop, &workRight, &workBottom)

        monitors.Push(Map(
            "index", index,
            "left", left,
            "top", top,
            "right", right,
            "bottom", bottom,
            "workLeft", workLeft,
            "workTop", workTop,
            "workRight", workRight,
            "workBottom", workBottom,
            "primary", index = primaryIndex
        ))
    }

    if monitors.Length > 1 {
        monitors := SortMonitors(monitors)
    }

    return monitors
}

SortMonitors(monitors) {
    count := monitors.Length
    Loop count - 1 {
        outer := A_Index
        Loop count - outer {
            inner := A_Index
            leftMonitor := monitors[inner]
            rightMonitor := monitors[inner + 1]

            if ((leftMonitor["left"] > rightMonitor["left"])
                || (leftMonitor["left"] = rightMonitor["left"] && leftMonitor["top"] > rightMonitor["top"])) {
                monitors[inner] := rightMonitor
                monitors[inner + 1] := leftMonitor
            }
        }
    }

    return monitors
}

FindMonitorForPoint(x, y, monitors) {
    for _, monitor in monitors {
        if x >= monitor["left"] && x < monitor["right"] && y >= monitor["top"] && y < monitor["bottom"] {
            return monitor
        }
    }

    closest := 0
    closestDistance := 0
    for _, monitor in monitors {
        centerX := monitor["left"] + ((monitor["right"] - monitor["left"]) / 2)
        centerY := monitor["top"] + ((monitor["bottom"] - monitor["top"]) / 2)
        distance := ((centerX - x) ** 2) + ((centerY - y) ** 2)

        if !closest || distance < closestDistance {
            closest := monitor
            closestDistance := distance
        }
    }

    return closest
}

FindConfiguredWindow(match) {
    if WinActive(match) {
        return WinExist("A")
    }

    hwnds := FindConfiguredWindows(match)
    for _, hwnd in hwnds {
        return hwnd
    }

    return 0
}

FindConfiguredWindows(match) {
    hwnds := WinGetList(match)
    windows := []
    for _, hwnd in hwnds {
        if WinExist("ahk_id " hwnd) {
            windows.Push(hwnd)
        }
    }

    return windows
}

RestoreWindowPlacement(hwnd, placement) {
    if placement["state"] = 1 {
        WinRestore("ahk_id " hwnd)
    }

    WinMove(
        placement["x"],
        placement["y"],
        placement["w"],
        placement["h"],
        "ahk_id " hwnd
    )

    if placement["state"] = 1 {
        WinMaximize("ahk_id " hwnd)
    }
}

TileWindowOnCurrentMonitor(hwnd, direction) {
    source := GetWindowPlacementInfo(hwnd)
    if !source {
        return
    }

    monitor := GetMonitorByIndex(source["monitorIndex"])
    if !monitor {
        return
    }

    if source["state"] = 1 {
        WinRestore("ahk_id " hwnd)
    }

    workLeft := monitor["workLeft"]
    workTop := monitor["workTop"]
    workWidth := monitor["workRight"] - monitor["workLeft"]
    workHeight := monitor["workBottom"] - monitor["workTop"]
    ApplyTileOnMonitor(hwnd, monitor, direction)
}

ApplyBurnerLayout(hwnd, source, target, layout) {
    layout := StrLower(layout)

    if layout = "tile-left" {
        ApplyTileOnMonitor(hwnd, target, "left")
        return
    }

    if layout = "tile-right" {
        ApplyTileOnMonitor(hwnd, target, "right")
        return
    }

    if layout = "fullscreen" {
        ApplyFullscreenOnMonitor(hwnd, target)
        return
    }

    ApplyRelativePlacement(hwnd, source, target)
}

ApplyTileOnMonitor(hwnd, monitor, direction) {
    WinRestore("ahk_id " hwnd)

    workLeft := monitor["workLeft"]
    workTop := monitor["workTop"]
    workWidth := monitor["workRight"] - monitor["workLeft"]
    workHeight := monitor["workBottom"] - monitor["workTop"]
    halfWidth := Floor(workWidth / 2)
    halfHeight := Floor(workHeight / 2)

    if direction = "left" {
        newX := workLeft
        newY := workTop
        newW := halfWidth
        newH := workHeight
    } else if direction = "right" {
        newX := workLeft + halfWidth
        newY := workTop
        newW := workWidth - halfWidth
        newH := workHeight
    } else if direction = "up" {
        newX := workLeft
        newY := workTop
        newW := workWidth
        newH := halfHeight
    } else {
        newX := workLeft
        newY := workTop + halfHeight
        newW := workWidth
        newH := workHeight - halfHeight
    }

    WinMove(newX, newY, newW, newH, "ahk_id " hwnd)
}

GetMouseDrivenTileDirection(monitor, mouseX := "", mouseY := "") {
    if mouseX = "" || mouseY = "" {
        MouseGetPos(&mouseX, &mouseY)
    }

    if IsPortraitMonitor(monitor) {
        midY := monitor["workTop"] + ((monitor["workBottom"] - monitor["workTop"]) / 2)
        return mouseY < midY ? "up" : "down"
    }

    midX := monitor["workLeft"] + ((monitor["workRight"] - monitor["workLeft"]) / 2)
    return mouseX < midX ? "left" : "right"
}

IsPortraitMonitor(monitor) {
    width := monitor["workRight"] - monitor["workLeft"]
    height := monitor["workBottom"] - monitor["workTop"]
    return height > width
}

ApplyFullscreenOnMonitor(hwnd, monitor) {
    WinRestore("ahk_id " hwnd)

    workLeft := monitor["workLeft"]
    workTop := monitor["workTop"]
    workWidth := monitor["workRight"] - monitor["workLeft"]
    workHeight := monitor["workBottom"] - monitor["workTop"]

    WinMove(workLeft, workTop, workWidth, workHeight, "ahk_id " hwnd)
    WinMaximize("ahk_id " hwnd)
}

GetBurnerLayout(config) {
    if config.Has("burnerLayout") {
        return config["burnerLayout"]
    }

    return "float"
}

GetMainMonitorAction(config) {
    if config.Has("mainMonitorAction") {
        return StrLower(config["mainMonitorAction"])
    }

    return "burner"
}

StoreConfiguredPreviousWindow(config, currentHwnd, targetHwnd) {
    global ConfiguredAppPreviousWindow

    if !currentHwnd || currentHwnd = targetHwnd {
        return
    }

    ConfiguredAppPreviousWindow[GetConfiguredAppKey(config)] := currentHwnd
}

FocusConfiguredPreviousWindow(config) {
    global ConfiguredAppPreviousWindow

    key := GetConfiguredAppKey(config)
    if !ConfiguredAppPreviousWindow.Has(key) {
        return false
    }

    hwnd := ConfiguredAppPreviousWindow[key]
    if !WinExist("ahk_id " hwnd) {
        ConfiguredAppPreviousWindow.Delete(key)
        return false
    }

    WinActivate("ahk_id " hwnd)
    return true
}

GetConfiguredAppKey(config) {
    return config.Has("hotkey") ? config["hotkey"] : config["match"]
}

GetMonitorIndexForWindow(hwnd, fallbackIndex := 1) {
    source := GetWindowPlacementInfo(hwnd)
    if !source {
        return fallbackIndex
    }

    return source["monitorIndex"]
}

RememberLastPushAction(hwnd) {
    global LastPushAction

    LastPushAction := Map(
        "hwnd", hwnd,
        "tick", A_TickCount
    )
}

EnableRetileHotkeys() {
    Hotkey("*x", "On")
    Hotkey("*c", "On")
    Hotkey("*#x", "On")
    Hotkey("*#c", "On")
    SetTimer(DisableRetileHotkeys, -PushRetileDelayMs)
}

DisableRetileHotkeys() {
    Hotkey("*x", "Off")
    Hotkey("*c", "Off")
    Hotkey("*#x", "Off")
    Hotkey("*#c", "Off")
}

ClearLastPushAction() {
    global LastPushAction

    LastPushAction := Map()
}

CenterMouseOnMonitor(index) {
    MonitorGetWorkArea(index, &left, &top, &right, &bottom)
    centerX := Round(left + ((right - left) / 2))
    centerY := Round(top + ((bottom - top) / 2))
    MouseMove(centerX, centerY, 0)
}

Clamp(value, minValue, maxValue) {
    if value < minValue {
        return minValue
    }
    if value > maxValue {
        return maxValue
    }
    return value
}
