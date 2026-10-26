RegisterConfiguredPullHotkeys() {
    global ConfiguredPullHotkeys

    for _, config in ConfiguredPullHotkeys {
        RegisterConfiguredPullHotkey(config)
    }
}

RegisterConfiguredPullHotkey(config, enable := true) {
    if !(config.Has("hotkey") && config.Has("match")) || config["hotkey"] = "" {
        return
    }

    normalizedHotkey := NormalizeHotkeyForDynamicRegistration(config["hotkey"])
    releaseHotkey := normalizedHotkey . " Up"

    if enable {
        Hotkey(normalizedHotkey, HandleConfiguredPullHotkeyDown.Bind(config))
        Hotkey(releaseHotkey, HandleConfiguredPullHotkeyUp.Bind(config))
    } else {
        try Hotkey(normalizedHotkey, "Off")
        try Hotkey(releaseHotkey, "Off")
    }

    for _, passThroughHotkey in GetConfiguredPullSystemPassThroughHotkeys(config["hotkey"]) {
        if enable {
            try Hotkey(NormalizeHotkeyForDynamicRegistration(passThroughHotkey), AllowModifiedSystemHotkey, "On")
        } else {
            try Hotkey(NormalizeHotkeyForDynamicRegistration(passThroughHotkey), "Off")
        }
    }
}

AllowModifiedSystemHotkey(*) {
}

RegisterRetileHotkeys() {
    Hotkey("*x", HandleRetileLeft, "Off")
    Hotkey("*c", HandleRetileRight, "Off")
    Hotkey("*#x", HandleRetileLeft, "Off")
    Hotkey("*#c", HandleRetileRight, "Off")
}

InitializeSharedHotkeyRegistry() {
    global SharedHotkeyRegistryPath

    if !FileExist(SharedHotkeyRegistryPath) {
        SaveSharedHotkeyRegistry(DefaultSharedHotkeyRegistry())
    }

    registry := LoadSharedHotkeyRegistry()
    if registry.Length = 0 {
        registry := DefaultSharedHotkeyRegistry()
        SaveSharedHotkeyRegistry(registry)
    } else if NormalizeSharedHotkeyRegistryActions(registry) {
        SaveSharedHotkeyRegistry(registry)
    }

    return registry
}

InitializeConfiguredPullHotkeys() {
    global ConfiguredPullConfigPath

    if !FileExist(ConfiguredPullConfigPath) {
        SaveConfiguredPullHotkeys(DefaultConfiguredPullHotkeys())
    }

    configs := LoadConfiguredPullHotkeys()
    if configs.Length = 0 {
        configs := DefaultConfiguredPullHotkeys()
        SaveConfiguredPullHotkeys(configs)
    }

    return configs
}

DefaultSharedHotkeyRegistry() {
    return [
        Map("id", "wm.move-left", "hotkey", "#x", "action", "Move window left", "source", "script", "script", "window_manager.ahk"),
        Map("id", "wm.move-right", "hotkey", "#c", "action", "Move window right", "source", "script", "script", "window_manager.ahk"),
        Map("id", "wm.move-left-center", "hotkey", "#^x", "action", "Move window left and center mouse", "source", "script", "script", "window_manager.ahk"),
        Map("id", "wm.move-right-center", "hotkey", "#^c", "action", "Move window right and center mouse", "source", "script", "script", "window_manager.ahk"),
        Map("id", "wm.open-builder", "hotkey", "#b", "action", "Open hotkey builder", "source", "script", "script", "window_manager.ahk"),
        Map("id", "wm.open-opener", "hotkey", "#o", "action", "Open workspace opener", "source", "script", "script", "window_manager.ahk"),
        Map("id", "wm.update-workspace", "hotkey", "#y", "action", "Update workspace", "source", "script", "script", "window_manager.ahk"),
        Map("id", "wm.pull-recent", "hotkey", "#r", "action", "Pull most recent window", "source", "script", "script", "window_manager.ahk"),
        Map("id", "wm.toggle-suspend", "hotkey", "#;", "action", "Toggle hotkeys", "source", "script", "script", "window_manager.ahk"),
        Map("id", "fullscreen.toggle", "hotkey", "#z", "action", "Toggle fullscreen", "source", "script", "script", "fullscreen.ahk"),
        Map("id", "kill.close-active", "hotkey", "#q", "action", "Close active window", "source", "script", "script", "kill.ahk")
    ]
}

NormalizeSharedHotkeyRegistryActions(registry) {
    changed := false
    for _, entry in registry {
        if !entry.Has("id") {
            continue
        }

        if entry["id"] = "wm.toggle-suspend" && entry["action"] != "Toggle hotkeys" {
            entry["action"] := "Toggle hotkeys"
            changed := true
            continue
        }

        if entry["id"] = "fullscreen.toggle" && entry["action"] != "Toggle fullscreen" {
            entry["action"] := "Toggle fullscreen"
            changed := true
        }
    }

    return changed
}

LoadSharedHotkeyRegistry() {
    global SharedHotkeyRegistryPath

    registry := []
    if !FileExist(SharedHotkeyRegistryPath) {
        return registry
    }

    count := IniRead(SharedHotkeyRegistryPath, "Meta", "count", "0") + 0
    Loop count {
        section := "Hotkey" . A_Index
        id := IniRead(SharedHotkeyRegistryPath, section, "id", "")
        hotkey := IniRead(SharedHotkeyRegistryPath, section, "hotkey", "")
        action := IniRead(SharedHotkeyRegistryPath, section, "action", "")
        if action = "" {
            continue
        }

        entry := Map(
            "id", id != "" ? id : action,
            "hotkey", hotkey,
            "action", action,
            "source", IniRead(SharedHotkeyRegistryPath, section, "source", "script"),
            "script", IniRead(SharedHotkeyRegistryPath, section, "script", "")
        )
        disabledHotkey := IniRead(SharedHotkeyRegistryPath, section, "disabledHotkey", "")
        if disabledHotkey != "" {
            entry["disabledHotkey"] := disabledHotkey
        }
        registry.Push(entry)
    }

    return registry
}

SaveSharedHotkeyRegistry(registry) {
    global SharedHotkeyRegistryPath

    if FileExist(SharedHotkeyRegistryPath) {
        FileDelete(SharedHotkeyRegistryPath)
    }

    IniWrite(registry.Length, SharedHotkeyRegistryPath, "Meta", "count")
    for index, entry in registry {
        section := "Hotkey" . index
        IniWrite(entry.Has("id") ? entry["id"] : "", SharedHotkeyRegistryPath, section, "id")
        IniWrite(entry["hotkey"], SharedHotkeyRegistryPath, section, "hotkey")
        IniWrite(entry["action"], SharedHotkeyRegistryPath, section, "action")
        IniWrite(entry.Has("source") ? entry["source"] : "script", SharedHotkeyRegistryPath, section, "source")
        IniWrite(entry.Has("script") ? entry["script"] : "", SharedHotkeyRegistryPath, section, "script")
        IniWrite(entry.Has("disabledHotkey") ? entry["disabledHotkey"] : "", SharedHotkeyRegistryPath, section, "disabledHotkey")
    }
}

GetSharedHotkey(id, fallback := "") {
    entry := FindSharedRegistryEntryById(id)
    if entry {
        return entry["hotkey"]
    }

    return fallback
}

DefaultConfiguredPullHotkeys() {
    return [
        Map("hotkey", "#d", "match", "ahk_exe Discord.exe", "label", "Discord", "mainMonitorAction", "burner", "burnerLayout", "tile-left"),
        Map("hotkey", "#p", "match", "ahk_exe Caido.exe", "label", "Caido", "mainMonitorAction", "focus-last"),
        Map("hotkey", "#a", "match", "ahk_exe Claude.exe", "label", "Claude", "mainMonitorAction", "burner", "burnerLayout", "tile-right"),
        Map("hotkey", "#s", "match", "ahk_exe firefox.exe", "label", "Firefox", "mainMonitorAction", "focus-last"),
        Map("hotkey", "#t", "match", "ahk_exe WindowsTerminal.exe", "label", "Windows Terminal", "mainMonitorAction", "burner", "burnerLayout", "float"),
    ]
}

LoadConfiguredPullHotkeys() {
    global ConfiguredPullConfigPath

    configs := []
    count := IniRead(ConfiguredPullConfigPath, "Meta", "count", "0") + 0

    Loop count {
        section := "App" . A_Index
        hotkey := IniRead(ConfiguredPullConfigPath, section, "hotkey", "")
        disabledHotkey := IniRead(ConfiguredPullConfigPath, section, "disabledHotkey", "")
        match := IniRead(ConfiguredPullConfigPath, section, "match", "")
        if (hotkey = "" && disabledHotkey = "") || match = "" {
            continue
        }

        config := Map(
            "hotkey", hotkey,
            "match", match
        )
        if disabledHotkey != "" {
            config["disabledHotkey"] := disabledHotkey
        }

        label := IniRead(ConfiguredPullConfigPath, section, "label", "")
        mainMonitorAction := IniRead(ConfiguredPullConfigPath, section, "mainMonitorAction", "")
        burnerLayout := IniRead(ConfiguredPullConfigPath, section, "burnerLayout", "")

        if label != "" {
            config["label"] := label
        }
        if mainMonitorAction != "" {
            config["mainMonitorAction"] := mainMonitorAction
        }
        if burnerLayout != "" {
            config["burnerLayout"] := burnerLayout
        }

        configs.Push(config)
    }

    return configs
}

SaveConfiguredPullHotkeys(configs) {
    global ConfiguredPullConfigPath

    if FileExist(ConfiguredPullConfigPath) {
        FileDelete(ConfiguredPullConfigPath)
    }

    IniWrite(configs.Length, ConfiguredPullConfigPath, "Meta", "count")
    for index, config in configs {
        section := "App" . index
        IniWrite(config["hotkey"], ConfiguredPullConfigPath, section, "hotkey")
        IniWrite(config.Has("disabledHotkey") ? config["disabledHotkey"] : "", ConfiguredPullConfigPath, section, "disabledHotkey")
        IniWrite(config["match"], ConfiguredPullConfigPath, section, "match")
        IniWrite(config.Has("label") ? config["label"] : "", ConfiguredPullConfigPath, section, "label")
        IniWrite(config.Has("mainMonitorAction") ? config["mainMonitorAction"] : "", ConfiguredPullConfigPath, section, "mainMonitorAction")
        IniWrite(config.Has("burnerLayout") ? config["burnerLayout"] : "", ConfiguredPullConfigPath, section, "burnerLayout")
    }
}

LoadWindowWarpSettings() {
    global WindowWarpSettingsPath

    settings := Map(
        "holdDelayMs", 400,
        "holdTileEnabled", true,
        "holdMode", "tile"
    )

    if !FileExist(WindowWarpSettingsPath) {
        SaveWindowWarpSettings(settings)
        return settings
    }

    holdDelayMs := IniRead(WindowWarpSettingsPath, "Settings", "holdDelayMs", "400") + 0
    holdTileEnabled := IniRead(WindowWarpSettingsPath, "Settings", "holdTileEnabled", "1") + 0
    holdMode := IniRead(WindowWarpSettingsPath, "Settings", "holdMode", "tile")

    settings["holdDelayMs"] := SanitizeWindowWarpHoldDelay(holdDelayMs)
    settings["holdTileEnabled"] := holdTileEnabled != 0
    settings["holdMode"] := SanitizeWindowWarpHoldMode(holdMode)
    return settings
}

SaveWindowWarpSettings(settings) {
    global WindowWarpSettingsPath

    IniWrite(settings["holdDelayMs"], WindowWarpSettingsPath, "Settings", "holdDelayMs")
    IniWrite(settings["holdTileEnabled"] ? 1 : 0, WindowWarpSettingsPath, "Settings", "holdTileEnabled")
    IniWrite(settings["holdMode"], WindowWarpSettingsPath, "Settings", "holdMode")
}

SanitizeWindowWarpHoldDelay(delayMs) {
    if delayMs < 100 {
        return 100
    }
    if delayMs > 5000 {
        return 5000
    }
    return delayMs
}

SanitizeWindowWarpHoldMode(mode) {
    mode := StrLower(Trim(mode))
    return mode = "radial" ? "radial" : "tile"
}

GetStartupShortcutPath() {
    return A_Startup "\Windows Warp.lnk"
}

GetWindowsWarpLaunchTarget() {
    if A_IsCompiled {
        return Map(
            "target", A_ScriptFullPath,
            "args", "",
            "workingDir", A_ScriptDir
        )
    }

    wrapperPath := A_ScriptDir "\Windows Warp.ahk"
    scriptPath := FileExist(wrapperPath) ? wrapperPath : A_ScriptFullPath
    return Map(
        "target", A_AhkPath,
        "args", '"' . scriptPath . '"',
        "workingDir", A_ScriptDir
    )
}

IsWindowsWarpStartupEnabled() {
    shortcutPath := GetStartupShortcutPath()
    return FileExist(shortcutPath) != ""
}

SetWindowsWarpStartupEnabled(enabled) {
    shortcutPath := GetStartupShortcutPath()

    if enabled {
        launchInfo := GetWindowsWarpLaunchTarget()
        if FileExist(shortcutPath) {
            FileDelete(shortcutPath)
        }
        FileCreateShortcut(
            launchInfo["target"],
            shortcutPath,
            launchInfo["workingDir"],
            launchInfo["args"],
            "Launch Windows Warp at startup"
        )
        return
    }

    if FileExist(shortcutPath) {
        FileDelete(shortcutPath)
    }
}


OpenConfiguredHotkeyBuilder(*) {
    global ConfiguredPullBuilderState

    windowInfo := GetActiveConfiguredWindowInfo()
    if !windowInfo {
        return
    }

    CloseConfiguredPullBuilder()
    uiTheme := GetUiTheme()

    builderGui := Gui("-Caption +Border +AlwaysOnTop +ToolWindow", "Hotkey Editor")
    builderGui.SetFont("s10", "Segoe UI")
    builderGui.BackColor := uiTheme["surface"]
    builderGui.MarginX := 0
    builderGui.MarginY := 0
    builderGui.OnEvent("Close", (*) => CloseConfiguredPullBuilder())
    builderGui.OnEvent("Escape", (*) => CloseConfiguredPullBuilder())

    left := 18
    contentWidth := 520
    headerBar := builderGui.AddText("x0 y0 w624 h38 Background" . uiTheme["header"], "")
    headerBar.OnEvent("Click", (*) => StartGuiDrag(builderGui))
    builderGui.SetFont("s11", "Segoe UI Semibold")
    headerTitle := builderGui.AddText("x14 y9 w420 c" . uiTheme["headerText"], "Hotkey Editor")
    headerTitle.OnEvent("Click", (*) => StartGuiDrag(builderGui))
    statusText := builderGui.AddText("x444 y9 w170 Right c" . GetWindowWarpStatusColor(uiTheme, WindowWarpHotkeysEnabled), GetWindowWarpStatusLabel())
    closeButton := builderGui.AddText("x630 y5 w26 h26 Center c" . uiTheme["headerText"] . " Background" . uiTheme["closeFill"] . " +0x200 Border", "X")
    closeButton.OnEvent("Click", (*) => CloseConfiguredPullBuilder())

    builderGui.SetFont("s9", "Segoe UI")
    builderGui.AddText(Format("x{} y58 w{} c{}", left, contentWidth, uiTheme["muted"]), "Set the hotkey, choose the behavior, and apply. Changes reload the script automatically.")

    builderGui.AddText(Format("x{} y98 w{} c{}", left, contentWidth, uiTheme["section"]), "TARGET")
    appLabelText := builderGui.AddText(Format("x{} y130 w{} c{}", left, contentWidth, uiTheme["text"]), windowInfo["label"])
    appMatchText := builderGui.AddText(Format("x{} y166 w{} c{}", left, contentWidth, uiTheme["muted"]), windowInfo["match"])

    builderGui.AddText(Format("x{} y206 w{} c{}", left, contentWidth, uiTheme["section"]), "HOTKEY")
    selectedKeyBox := builderGui.AddText(Format("x{} y238 w240 h36 +Border Background{}", left, uiTheme["input"]), "")
    selectedKeyText := builderGui.AddText(Format("x{} y246 w240 h20 Center c{} BackgroundTrans", left, uiTheme["text"]), "")
    hotkeyHintText := builderGui.AddText(Format("x{} y244 w260 c{}", left + 256, uiTheme["muted"]), "Press any key to begin. Press Esc to close.")
    conflictText := builderGui.AddText(Format("x{} y278 w{} c{} Hidden", left, contentWidth, uiTheme["danger"]), "")

    winCheckbox := builderGui.AddCheckBox(Format("x{} y309 w18 h18 Checked", left), "")
    winLabel := builderGui.AddText(Format("x{} y309 c{}", left + 28, uiTheme["text"]), "Win")
    winLabel.OnEvent("Click", (*) => ToggleBuilderCheckbox("winCheckbox"))
    ctrlCheckbox := builderGui.AddCheckBox(Format("x{} y309 w18 h18", left + 92), "")
    ctrlLabel := builderGui.AddText(Format("x{} y309 c{}", left + 120, uiTheme["text"]), "Ctrl")
    ctrlLabel.OnEvent("Click", (*) => ToggleBuilderCheckbox("ctrlCheckbox"))
    altCheckbox := builderGui.AddCheckBox(Format("x{} y309 w18 h18", left + 180), "")
    altLabel := builderGui.AddText(Format("x{} y309 c{}", left + 208, uiTheme["text"]), "Alt")
    altLabel.OnEvent("Click", (*) => ToggleBuilderCheckbox("altCheckbox"))
    shiftCheckbox := builderGui.AddCheckBox(Format("x{} y309 w18 h18", left + 252), "")
    shiftLabel := builderGui.AddText(Format("x{} y309 c{}", left + 280, uiTheme["text"]), "Shift")
    shiftLabel.OnEvent("Click", (*) => ToggleBuilderCheckbox("shiftCheckbox"))

    builderGui.AddText(Format("x{} y350 w{} c{}", left, contentWidth, uiTheme["section"]), "BEHAVIOR")
    mainRadio := builderGui.AddRadio(Format("x{} y378 w150 h22 Checked c{}", left, uiTheme["text"]), "Main monitor config")
    mainRadio.OnEvent("Click", (*) => SelectBuilderBehavior("main"))
    burnerRadio := builderGui.AddRadio(Format("x{} y378 w170 h22 c{}", left + 188, uiTheme["text"]), "Burner monitor config")
    burnerRadio.OnEvent("Click", (*) => SelectBuilderBehavior("burner"))
    helpText := builderGui.AddText(Format("x{} y414 w{} h34 c{}", left, contentWidth, uiTheme["muted"]), "Hover a config type to see what it does.")

    applyButton := builderGui.AddButton(Format("x{} y472 w96 h30 Default", left), "Apply")
    cancelButton := builderGui.AddButton(Format("x{} y472 w96 h30", left + 108), "Cancel")
    hotkeysButton := builderGui.AddButton(Format("x{} y472 w96 h30", left + 216), "Hotkeys")
    openerButton := builderGui.AddButton(Format("x{} y472 w96 h30", left + 324), "Opener")
    settingsButton := builderGui.AddButton(Format("x{} y472 w96 h30", left + 432), "Settings")
    applyButton.OnEvent("Click", (*) => SaveConfiguredPullBuilder())
    cancelButton.OnEvent("Click", (*) => CloseConfiguredPullBuilder())
    hotkeysButton.OnEvent("Click", (*) => ToggleHotkeyKeyboardViewer())
    settingsButton.OnEvent("Click", (*) => OpenWindowWarpSettings())
    openerButton.OnEvent("Click", (*) => OpenWorkspaceOpenerBrowser())

    ConfiguredPullBuilderState := Map(
        "gui", builderGui,
        "guiHwnd", builderGui.Hwnd,
        "uiTheme", uiTheme,
        "appLabelText", appLabelText,
        "appMatchText", appMatchText,
        "selectedKeyBox", selectedKeyBox,
        "selectedKeyText", selectedKeyText,
        "hotkeyHintText", hotkeyHintText,
        "conflictText", conflictText,
        "helpText", helpText,
        "statusText", statusText,
        "applyButton", applyButton,
        "cancelButton", cancelButton,
        "hotkeysButton", hotkeysButton,
        "settingsButton", settingsButton,
        "openerButton", openerButton,
        "closeButton", closeButton,
        "keyboardGui", 0,
        "keyboardGuiHwnd", 0,
        "keyboardCloseButton", 0,
        "keyboardPageIndex", 1,
        "keyboardPages", [],
        "keyboardRenderedControls", [],
        "keyboardPageLabel", 0,
        "keyboardPrevButton", 0,
        "keyboardNextButton", 0,
        "openerGui", 0,
        "openerGuiHwnd", 0,
        "workspaceCaptureGuiHwnd", 0,
        "workspaceCaptureApplyFn", 0,
        "workspaceCaptureToggleFn", 0,
        "textInputGuiHwnd", 0,
        "textInputApplyFn", 0,
        "workspacePickerGuiHwnd", 0,
        "workspacePickerApplyFn", 0,
        "openerSelectedId", "",
        "openerPageIndex", 1,
        "openerPages", [],
        "openerPageLabel", 0,
        "openerPrevButton", 0,
        "openerNextButton", 0,
        "openerDetailsText", 0,
        "captureReadyAt", A_TickCount + 200,
        "winCheckbox", winCheckbox,
        "ctrlCheckbox", ctrlCheckbox,
        "altCheckbox", altCheckbox,
        "shiftCheckbox", shiftCheckbox,
        "winLabel", winLabel,
        "ctrlLabel", ctrlLabel,
        "altLabel", altLabel,
        "shiftLabel", shiftLabel,
        "mainRadio", mainRadio,
        "burnerRadio", burnerRadio,
        "windowInfo", windowInfo,
        "selectedHotkey", "",
        "selectedHotkeyDisplay", "",
        "editingKind", "app",
        "editingSharedId", "",
        "hoverDescriptions", Map(
            mainRadio.Hwnd, "Main monitor config: the hotkey brings the app to the main monitor, and pressing it again while it is focused there switches back to your previous app.",
            burnerRadio.Hwnd, "Burner monitor config: the hotkey brings the app to the main monitor, and pressing it again while it is focused there sends it back to the burner monitor.",
        ),
        "defaultHoverText", "Hover a config type to see what it does."
    )

    SetConfiguredPullBuilderEditingMode("app", windowInfo)
    LoadActiveWindowConfigIntoBuilder(windowInfo)
    builderGui.Show("w664 h526 Center")
    winCheckbox.Focus()
}

CloseConfiguredPullBuilder() {
    global ConfiguredPullBuilderState

    CloseHotkeyKeyboardViewer()
    CloseWorkspaceOpenerBrowser()
    CloseWindowWarpSettings()

    if ConfiguredPullBuilderState.Count && ConfiguredPullBuilderState.Has("gui") {
        try ConfiguredPullBuilderState["gui"].Destroy()
    }

    ConfiguredPullBuilderState := Map()
}

CloseWindowWarpSettings() {
    global ConfiguredPullBuilderState

    if ConfiguredPullBuilderState.Count && ConfiguredPullBuilderState.Has("settingsGui") && ConfiguredPullBuilderState["settingsGui"] {
        try ConfiguredPullBuilderState["settingsGui"].Destroy()
    }

    if ConfiguredPullBuilderState.Count {
        ConfiguredPullBuilderState["settingsGui"] := 0
        ConfiguredPullBuilderState["settingsGuiHwnd"] := 0
        ConfiguredPullBuilderState["workspaceCaptureGuiHwnd"] := 0
        ConfiguredPullBuilderState["workspaceCaptureApplyFn"] := 0
        ConfiguredPullBuilderState["workspaceCaptureToggleFn"] := 0
        ConfiguredPullBuilderState["textInputGuiHwnd"] := 0
        ConfiguredPullBuilderState["textInputApplyFn"] := 0
        ConfiguredPullBuilderState["workspacePickerGuiHwnd"] := 0
        ConfiguredPullBuilderState["workspacePickerApplyFn"] := 0
    }
}

HandleConfiguredPullBuilderKeyDown(wParam, lParam, msg, hwnd) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    activeHwnd := WinExist("A")
    keyName := NormalizeBuilderKeyName(wParam, lParam)

    keyboardGuiHwnd := ConfiguredPullBuilderState.Has("keyboardGuiHwnd") ? ConfiguredPullBuilderState["keyboardGuiHwnd"] : 0
    openerGuiHwnd := ConfiguredPullBuilderState.Has("openerGuiHwnd") ? ConfiguredPullBuilderState["openerGuiHwnd"] : 0
    guiHwnd := ConfiguredPullBuilderState.Has("guiHwnd") ? ConfiguredPullBuilderState["guiHwnd"] : 0
    workspaceCaptureGuiHwnd := ConfiguredPullBuilderState.Has("workspaceCaptureGuiHwnd") ? ConfiguredPullBuilderState["workspaceCaptureGuiHwnd"] : 0
    textInputGuiHwnd := ConfiguredPullBuilderState.Has("textInputGuiHwnd") ? ConfiguredPullBuilderState["textInputGuiHwnd"] : 0
    workspacePickerGuiHwnd := ConfiguredPullBuilderState.Has("workspacePickerGuiHwnd") ? ConfiguredPullBuilderState["workspacePickerGuiHwnd"] : 0

    if workspaceCaptureGuiHwnd && activeHwnd = workspaceCaptureGuiHwnd {
        if keyName = "Left" || keyName = "Right" {
            toggleFn := ConfiguredPullBuilderState.Has("workspaceCaptureToggleFn") ? ConfiguredPullBuilderState["workspaceCaptureToggleFn"] : 0
            if toggleFn {
                toggleFn.Call(keyName = "Left" ? "create" : "update")
                return 0
            }
        }
        if keyName = "Enter" {
            applyFn := ConfiguredPullBuilderState.Has("workspaceCaptureApplyFn") ? ConfiguredPullBuilderState["workspaceCaptureApplyFn"] : 0
            if applyFn {
                applyFn.Call()
                return 0
            }
        }
        return
    }

    if textInputGuiHwnd && activeHwnd = textInputGuiHwnd {
        if keyName = "Enter" {
            applyFn := ConfiguredPullBuilderState.Has("textInputApplyFn") ? ConfiguredPullBuilderState["textInputApplyFn"] : 0
            if applyFn {
                applyFn.Call()
                return 0
            }
        }
        return
    }

    if workspacePickerGuiHwnd && activeHwnd = workspacePickerGuiHwnd {
        if keyName = "Enter" {
            applyFn := ConfiguredPullBuilderState.Has("workspacePickerApplyFn") ? ConfiguredPullBuilderState["workspacePickerApplyFn"] : 0
            if applyFn {
                applyFn.Call()
                return 0
            }
        }
        return
    }

    if keyboardGuiHwnd && activeHwnd = keyboardGuiHwnd {
        if keyName = "Delete" {
            DeleteSelectedHotkeyViewerEntry()
            return 0
        }
        if keyName = "Escape" {
            CloseHotkeyKeyboardViewer()
            return 0
        }
        return
    }

    if openerGuiHwnd && activeHwnd = openerGuiHwnd {
        if keyName = "Delete" {
            DeleteSelectedWorkspaceOpener()
            return 0
        }
        if keyName = "Escape" {
            CloseWorkspaceOpenerBrowser()
            return 0
        }
        return
    }

    if !guiHwnd || activeHwnd != guiHwnd {
        return
    }

    if A_TickCount < ConfiguredPullBuilderState["captureReadyAt"] {
        return 0
    }

    if keyName = "" {
        return 0
    }

    if keyName = "Left" || keyName = "Right" {
        if ConfiguredPullBuilderState["selectedHotkey"] != "" && ConfiguredPullBuilderState["editingKind"] = "app" {
            SelectBuilderBehavior(keyName = "Left" ? "main" : "burner")
            ConfiguredPullBuilderState["applyButton"].Focus()
        }
        return 0
    }

    if keyName = "Enter" {
        if ConfiguredPullBuilderState["selectedHotkey"] != "" {
            ConfiguredPullBuilderState["applyButton"].Focus()
        }
        return
    }

    if keyName = "Escape" {
        CloseConfiguredPullBuilder()
        return 0
    }

    if IsBuilderModifierKey(keyName) {
        return 0
    }

    combo := BuildConfiguredPullBuilderHotkey(keyName)
    if !combo {
        return 0
    }

    SetConfiguredPullBuilderHotkey(combo["hotkey"], combo["display"])
    return 0
}

HandleConfiguredPullBuilderMouseMove(wParam, lParam, msg, hwnd) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count
        || !ConfiguredPullBuilderState.Has("guiHwnd")
        || !ConfiguredPullBuilderState["guiHwnd"] {
        return
    }

    MouseGetPos(, , &winHwnd, &ctrlHwnd, 2)
    if winHwnd != ConfiguredPullBuilderState["guiHwnd"] {
        return
    }

    hoverDescriptions := ConfiguredPullBuilderState["hoverDescriptions"]
    if hoverDescriptions.Has(ctrlHwnd) {
        text := hoverDescriptions[ctrlHwnd]
    } else {
        text := ConfiguredPullBuilderState["defaultHoverText"]
    }

    ConfiguredPullBuilderState["helpText"].Text := text
}

HandleWindowManagerMouseWheel(wParam, lParam, msg, hwnd) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count
        || (!ConfiguredPullBuilderState["keyboardGuiHwnd"] && !ConfiguredPullBuilderState["openerGuiHwnd"]) {
        return
    }

    MouseGetPos(, , &winHwnd,, 2)
    delta := wParam >> 16
    if delta > 0x7FFF {
        delta -= 0x10000
    }

    if ConfiguredPullBuilderState["keyboardGuiHwnd"] && winHwnd = ConfiguredPullBuilderState["keyboardGuiHwnd"] {
        if delta > 0 {
            ChangeHotkeyViewerPage(-1)
        } else if delta < 0 {
            ChangeHotkeyViewerPage(1)
        }
        return 0
    }

    if ConfiguredPullBuilderState["openerGuiHwnd"] && winHwnd = ConfiguredPullBuilderState["openerGuiHwnd"] {
        if delta > 0 {
            ChangeWorkspaceOpenerPage(-1)
        } else if delta < 0 {
            ChangeWorkspaceOpenerPage(1)
        }
    }
    return 0
}

NormalizeBuilderKeyName(wParam, lParam) {
    vk := Format("vk{:02X}", wParam)
    sc := (lParam >> 16) & 0x1FF
    keyName := GetKeyName(vk . "sc" . Format("{:03X}", sc))
    if keyName = "" {
        keyName := GetKeyName(vk)
    }

    if keyName = "Esc" {
        return "Escape"
    }

    return keyName
}

IsBuilderModifierKey(keyName) {
    static modifierKeys := Map(
        "Shift", true,
        "LShift", true,
        "RShift", true,
        "Control", true,
        "Ctrl", true,
        "LControl", true,
        "RControl", true,
        "LCtrl", true,
        "RCtrl", true,
        "Alt", true,
        "Menu", true,
        "LMenu", true,
        "RMenu", true,
        "LAlt", true,
        "RAlt", true,
        "Win", true,
        "LWin", true,
        "RWin", true
    )

    return modifierKeys.Has(keyName)
}

BuildConfiguredPullBuilderHotkey(keyName) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return 0
    }

    modifierHotkey := ""
    modifierDisplay := ""
    hasModifier := false

    if ConfiguredPullBuilderState["winCheckbox"].Value = 1 {
        modifierHotkey .= "#"
        modifierDisplay .= (modifierDisplay = "" ? "Win" : "+Win")
        hasModifier := true
    }
    if ConfiguredPullBuilderState["ctrlCheckbox"].Value = 1 {
        modifierHotkey .= "^"
        modifierDisplay .= (modifierDisplay = "" ? "Ctrl" : "+Ctrl")
        hasModifier := true
    }
    if ConfiguredPullBuilderState["altCheckbox"].Value = 1 {
        modifierHotkey .= "!"
        modifierDisplay .= (modifierDisplay = "" ? "Alt" : "+Alt")
        hasModifier := true
    }
    if ConfiguredPullBuilderState["shiftCheckbox"].Value = 1 {
        modifierHotkey .= "+"
        modifierDisplay .= (modifierDisplay = "" ? "Shift" : "+Shift")
        hasModifier := true
    }

    hotkeyKey := ConvertKeyNameToHotkeyToken(keyName)
    if hotkeyKey = "" {
        return 0
    }

    if !hasModifier {
        modifierHotkey := "#"
        modifierDisplay := "Win"
    }

    return Map(
        "hotkey", modifierHotkey . hotkeyKey,
        "display", modifierDisplay . "+" . GetHotkeyDisplayName(keyName)
    )
}

ConvertKeyNameToHotkeyToken(keyName) {
    static specialKeys := Map(
        "Escape", "Esc",
        "Backspace", "Backspace",
        "Delete", "Delete",
        "Insert", "Insert",
        "Home", "Home",
        "End", "End",
        "PgUp", "PgUp",
        "PgDn", "PgDn",
        "Up", "Up",
        "Down", "Down",
        "Left", "Left",
        "Right", "Right",
        "Tab", "Tab",
        "Enter", "Enter",
        "Space", "Space",
        "AppsKey", "AppsKey",
        "PrintScreen", "PrintScreen",
        "CapsLock", "CapsLock",
        "ScrollLock", "ScrollLock",
        "Pause", "Pause",
        "NumLock", "NumLock"
    )

    if specialKeys.Has(keyName) {
        return specialKeys[keyName]
    }

    if RegExMatch(keyName, "i)^F([1-9]|1[0-9]|2[0-4])$") {
        return StrUpper(keyName)
    }

    if StrLen(keyName) = 1 {
        return StrLower(keyName)
    }

    if RegExMatch(keyName, "i)^Numpad([0-9])$") {
        return "Numpad" . SubStr(keyName, 7)
    }

    return keyName
}

GetHotkeyDisplayName(keyName) {
    static displayNames := Map(
        "PgUp", "PageUp",
        "PgDn", "PageDown",
        "AppsKey", "Menu"
    )

    if displayNames.Has(keyName) {
        return displayNames[keyName]
    }

    return keyName
}

LoadActiveWindowConfigIntoBuilder(windowInfo) {
    global ConfiguredPullHotkeys
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    sameAppIndex := FindConfiguredPullIndexByMatch(windowInfo["match"])
    if sameAppIndex {
        config := ConfiguredPullHotkeys[sameAppIndex]
        ApplyHotkeyToBuilderControls(config["hotkey"])
        if GetMainMonitorAction(config) = "focus-last" {
            SelectBuilderBehavior("main")
        } else {
            SelectBuilderBehavior("burner")
        }
        return
    }

    ConfiguredPullBuilderState["winCheckbox"].Value := 1
    ConfiguredPullBuilderState["ctrlCheckbox"].Value := 0
    ConfiguredPullBuilderState["altCheckbox"].Value := 0
    ConfiguredPullBuilderState["shiftCheckbox"].Value := 0
    SelectBuilderBehavior("main")
    SetConfiguredPullBuilderHotkey("", "None")
}

SetConfiguredPullBuilderHotkey(hotkey, display) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    ConfiguredPullBuilderState["selectedHotkey"] := hotkey
    ConfiguredPullBuilderState["selectedHotkeyDisplay"] := display
    ConfiguredPullBuilderState["selectedKeyText"].Text := display
    if hotkey != "" {
        ConfiguredPullBuilderState["applyButton"].Focus()
    }
    UpdateConfiguredPullBuilderConflictState()
}

ToggleBuilderCheckbox(key) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    checkbox := ConfiguredPullBuilderState[key]
    checkbox.Value := checkbox.Value = 1 ? 0 : 1
}

SelectBuilderBehavior(choice) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    if choice = "main" {
        ConfiguredPullBuilderState["mainRadio"].Value := 1
        ConfiguredPullBuilderState["burnerRadio"].Value := 0
        ConfiguredPullBuilderState["helpText"].Text := ConfiguredPullBuilderState["hoverDescriptions"][ConfiguredPullBuilderState["mainRadio"].Hwnd]
    } else {
        ConfiguredPullBuilderState["mainRadio"].Value := 0
        ConfiguredPullBuilderState["burnerRadio"].Value := 1
        ConfiguredPullBuilderState["helpText"].Text := ConfiguredPullBuilderState["hoverDescriptions"][ConfiguredPullBuilderState["burnerRadio"].Hwnd]
    }
}

StartGuiDrag(gui, *) {
    PostMessage(0xA1, 2, , , "ahk_id " gui.Hwnd)
}

ReflowConfiguredPullBuilderLayout(showConflict) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    conflictText := ConfiguredPullBuilderState["conflictText"]
    helpText := ConfiguredPullBuilderState["helpText"]
    applyButton := ConfiguredPullBuilderState["applyButton"]
    cancelButton := ConfiguredPullBuilderState["cancelButton"]
    hotkeysButton := ConfiguredPullBuilderState["hotkeysButton"]
    openerButton := ConfiguredPullBuilderState["openerButton"]
    settingsButton := ConfiguredPullBuilderState["settingsButton"]

    if showConflict {
        conflictText.Move(, 278, , 20)
        helpText.Move(, 430)
        applyButton.Move(, 488)
        cancelButton.Move(, 488)
        hotkeysButton.Move(, 488)
        openerButton.Move(, 488)
        settingsButton.Move(, 488)
    } else {
        conflictText.Move(, 278, , 0)
        helpText.Move(, 414)
        applyButton.Move(, 472)
        cancelButton.Move(, 472)
        hotkeysButton.Move(, 472)
        openerButton.Move(, 472)
        settingsButton.Move(, 472)
    }

    conflictText.Visible := showConflict
}

UpdateConfiguredPullBuilderConflictState() {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    uiTheme := ConfiguredPullBuilderState["uiTheme"]
    selectedHotkey := ConfiguredPullBuilderState["selectedHotkey"]
    conflictText := ConfiguredPullBuilderState["conflictText"]
    selectedKeyBox := ConfiguredPullBuilderState["selectedKeyBox"]
    windowInfo := ConfiguredPullBuilderState["windowInfo"]

    if selectedHotkey = "" {
        selectedKeyBox.Opt("Background" . uiTheme["input"])
        ReflowConfiguredPullBuilderLayout(false)
        return
    }

    conflict := FindConfiguredPullBuilderConflict(
        selectedHotkey,
        ConfiguredPullBuilderState["editingKind"],
        ConfiguredPullBuilderState["editingKind"] = "app" ? windowInfo["match"] : "",
        ConfiguredPullBuilderState["editingKind"] = "shared" ? ConfiguredPullBuilderState["editingSharedId"] : ""
    )
    if conflict {
        conflictText.Text := conflict["message"]
        selectedKeyBox.Opt("Background" . uiTheme["dangerFill"])
        ReflowConfiguredPullBuilderLayout(true)
        return
    }

    selectedKeyBox.Opt("Background" . uiTheme["input"])
    ReflowConfiguredPullBuilderLayout(false)
}

SetConfiguredPullBuilderEditingMode(kind, windowInfo, sharedId := "") {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    ConfiguredPullBuilderState["editingKind"] := kind
    ConfiguredPullBuilderState["editingSharedId"] := sharedId
    ConfiguredPullBuilderState["windowInfo"] := windowInfo
    ConfiguredPullBuilderState["appLabelText"].Text := windowInfo["label"]
    ConfiguredPullBuilderState["appMatchText"].Text := windowInfo["match"]

    if kind = "shared" {
        ConfiguredPullBuilderState["mainRadio"].Enabled := false
        ConfiguredPullBuilderState["burnerRadio"].Enabled := false
        ConfiguredPullBuilderState["helpText"].Text := "Shared hotkeys control built-in script actions. The behavior options do not apply here."
    } else {
        ConfiguredPullBuilderState["mainRadio"].Enabled := true
        ConfiguredPullBuilderState["burnerRadio"].Enabled := true
        ConfiguredPullBuilderState["helpText"].Text := ConfiguredPullBuilderState["defaultHoverText"]
    }
}

FindConfiguredPullBuilderConflict(hotkey, editingKind := "app", currentMatch := "", currentSharedId := "") {
    global SharedHotkeyRegistry

    registryEntry := FindSharedRegistryEntryByHotkey(hotkey)
    if registryEntry && !(editingKind = "shared" && registryEntry["id"] = currentSharedId) {
        return Map(
            "type", "shared",
            "message", "Conflicting with this hotkey: " . registryEntry["action"],
            "label", registryEntry["action"],
            "id", registryEntry["id"]
        )
    }

    sameAppIndex := FindConfiguredPullIndexByMatch(currentMatch)
    collisionIndex := FindConfiguredPullIndexByHotkey(hotkey)
    if collisionIndex && collisionIndex != sameAppIndex {
        collisionLabel := GetConfiguredAppLabel(ConfiguredPullHotkeys[collisionIndex])
        return Map(
            "type", "app",
            "message", "Conflicting with this hotkey: " . collisionLabel,
            "label", collisionLabel,
            "index", collisionIndex
        )
    }

    return 0
}

FindSharedRegistryEntryByHotkey(hotkey) {
    global SharedHotkeyRegistry

    for _, entry in SharedHotkeyRegistry {
        if entry["hotkey"] = hotkey {
            return entry
        }
    }

    return 0
}

FindSharedRegistryEntryById(id) {
    global SharedHotkeyRegistry

    for _, entry in SharedHotkeyRegistry {
        if entry.Has("id") && entry["id"] = id {
            return entry
        }
    }

    return 0
}

FindSharedRegistryIndexById(id) {
    global SharedHotkeyRegistry

    for index, entry in SharedHotkeyRegistry {
        if entry.Has("id") && entry["id"] = id {
            return index
        }
    }

    return 0
}

ToggleHotkeyKeyboardViewer() {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    if ConfiguredPullBuilderState["keyboardGui"] {
        CloseHotkeyKeyboardViewer()
        return
    }

    OpenHotkeyKeyboardViewer()
}

OpenHotkeyKeyboardViewer(initialPage := 1, showOptions := "w720 h620") {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }
    uiTheme := GetUiTheme()

    keyboardGui := Gui("-Caption +Border +AlwaysOnTop +ToolWindow", "Current Hotkeys")
    keyboardGui.SetFont("s9", "Segoe UI")
    keyboardGui.BackColor := uiTheme["surface"]
    keyboardGui.MarginX := 0
    keyboardGui.MarginY := 0
    keyboardGui.OnEvent("Close", (*) => CloseHotkeyKeyboardViewer())
    keyboardGui.OnEvent("Escape", (*) => CloseHotkeyKeyboardViewer())

    headerBar := keyboardGui.AddText("x0 y0 w676 h38 Background" . uiTheme["header"], "")
    headerBar.OnEvent("Click", (*) => StartGuiDrag(keyboardGui))
    keyboardGui.SetFont("s11", "Segoe UI Semibold")
    headerTitle := keyboardGui.AddText("x14 y9 w600 c" . uiTheme["headerText"], "Current Hotkeys")
    headerTitle.OnEvent("Click", (*) => StartGuiDrag(keyboardGui))
    closeButton := keyboardGui.AddText("x682 y5 w24 h26 Center c" . uiTheme["headerText"] . " Background" . uiTheme["closeFill"] . " +0x200 Border", "X")
    closeButton.OnEvent("Click", (*) => CloseHotkeyKeyboardViewer())

    keyboardGui.SetFont("s9", "Segoe UI")
    keyboardGui.AddText("x18 y58 w676 h34 c" . uiTheme["muted"], "Click a card to select it. Double-click or use Open to edit. Shared script hotkeys are gray, app hotkeys are green.")
    openButton := keyboardGui.AddButton("x18 y98 w86 h30", "Open")
    toggleButton := keyboardGui.AddButton("x114 y98 w86 h30", "Disable")
    deleteButton := keyboardGui.AddButton("x210 y98 w86 h30", "Delete")
    selectionText := keyboardGui.AddText("x310 y104 w392 h20 c" . uiTheme["muted"], "Select a hotkey card.")
    openButton.OnEvent("Click", (*) => OpenSelectedHotkeyViewerEntry())
    toggleButton.OnEvent("Click", (*) => ToggleSelectedHotkeyViewerEntry())
    deleteButton.OnEvent("Click", (*) => DeleteSelectedHotkeyViewerEntry())

    prevButton := keyboardGui.AddButton("x438 y576 w92 h28", "Previous")
    pageLabel := keyboardGui.AddText("x540 y581 w90 Center c" . uiTheme["muted"], "Page 1 of 1")
    nextButton := keyboardGui.AddButton("x636 y576 w66 h28", "Next")
    prevButton.OnEvent("Click", (*) => ChangeHotkeyViewerPage(-1))
    nextButton.OnEvent("Click", (*) => ChangeHotkeyViewerPage(1))

    ConfiguredPullBuilderState["keyboardGui"] := keyboardGui
    ConfiguredPullBuilderState["keyboardGuiHwnd"] := keyboardGui.Hwnd
    ConfiguredPullBuilderState["keyboardCloseButton"] := closeButton
    ConfiguredPullBuilderState["keyboardPrevButton"] := prevButton
    ConfiguredPullBuilderState["keyboardNextButton"] := nextButton
    ConfiguredPullBuilderState["keyboardPageLabel"] := pageLabel
    ConfiguredPullBuilderState["keyboardOpenButton"] := openButton
    ConfiguredPullBuilderState["keyboardToggleButton"] := toggleButton
    ConfiguredPullBuilderState["keyboardDeleteButton"] := deleteButton
    ConfiguredPullBuilderState["keyboardSelectionText"] := selectionText
    ConfiguredPullBuilderState["keyboardPageIndex"] := initialPage
    ConfiguredPullBuilderState["keyboardPages"] := []
    ConfiguredPullBuilderState["keyboardRenderedControls"] := []
    if !ConfiguredPullBuilderState.Has("keyboardSelectedKind") {
        ConfiguredPullBuilderState["keyboardSelectedKind"] := ""
    }
    if !ConfiguredPullBuilderState.Has("keyboardSelectedId") {
        ConfiguredPullBuilderState["keyboardSelectedId"] := ""
    }
    ConfiguredPullBuilderState["keyboardCardControls"] := []

    RenderHotkeyCards(keyboardGui, uiTheme)

    keyboardGui.Show(showOptions)
}

CloseHotkeyKeyboardViewer() {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    CloseWindowWarpSettings()

    if ConfiguredPullBuilderState.Has("keyboardGui") && ConfiguredPullBuilderState["keyboardGui"] {
        try ConfiguredPullBuilderState["keyboardGui"].Destroy()
        ConfiguredPullBuilderState["keyboardGui"] := 0
        ConfiguredPullBuilderState["keyboardGuiHwnd"] := 0
        ConfiguredPullBuilderState["keyboardCloseButton"] := 0
        ConfiguredPullBuilderState["keyboardPrevButton"] := 0
        ConfiguredPullBuilderState["keyboardNextButton"] := 0
        ConfiguredPullBuilderState["keyboardPageLabel"] := 0
        ConfiguredPullBuilderState["keyboardOpenButton"] := 0
        ConfiguredPullBuilderState["keyboardToggleButton"] := 0
        ConfiguredPullBuilderState["keyboardDeleteButton"] := 0
        ConfiguredPullBuilderState["keyboardSelectionText"] := 0
        ConfiguredPullBuilderState["keyboardPageIndex"] := 1
        ConfiguredPullBuilderState["keyboardPages"] := []
        ConfiguredPullBuilderState["keyboardRenderedControls"] := []
        ConfiguredPullBuilderState["keyboardCardControls"] := []
    }
}


ShowThemedTextInputDialog(title, prompt, initialValue := "") {
    global ConfiguredPullBuilderState

    uiTheme := ConfiguredPullBuilderState.Count && ConfiguredPullBuilderState.Has("uiTheme")
        ? ConfiguredPullBuilderState["uiTheme"]
        : GetUiTheme()

    ownerHwnd := 0
    if ConfiguredPullBuilderState.Count {
        if ConfiguredPullBuilderState.Has("keyboardGuiHwnd") && ConfiguredPullBuilderState["keyboardGuiHwnd"] {
            ownerHwnd := ConfiguredPullBuilderState["keyboardGuiHwnd"]
        } else if ConfiguredPullBuilderState.Has("openerGuiHwnd") && ConfiguredPullBuilderState["openerGuiHwnd"] {
            ownerHwnd := ConfiguredPullBuilderState["openerGuiHwnd"]
        } else if ConfiguredPullBuilderState.Has("guiHwnd") && ConfiguredPullBuilderState["guiHwnd"] {
            ownerHwnd := ConfiguredPullBuilderState["guiHwnd"]
        }
    }

    options := "-Caption +Border +ToolWindow +AlwaysOnTop"
    if ownerHwnd {
        options .= " +Owner" . ownerHwnd
    }

    promptGui := Gui(options, title)
    promptGui.SetFont("s10", "Segoe UI")
    promptGui.BackColor := uiTheme["surface"]
    promptGui.MarginX := 0
    promptGui.MarginY := 0

    state := Map("result", "Cancel", "value", initialValue)

    headerBar := promptGui.AddText("x0 y0 w320 h38 Background" . uiTheme["header"], "")
    headerBar.OnEvent("Click", (*) => StartGuiDrag(promptGui))
    promptGui.SetFont("s11", "Segoe UI Semibold")
    headerTitle := promptGui.AddText("x14 y9 w280 c" . uiTheme["headerText"], title)
    headerTitle.OnEvent("Click", (*) => StartGuiDrag(promptGui))
    closeText := promptGui.AddText("x326 y5 w24 h26 Center c" . uiTheme["headerText"] . " Background" . uiTheme["closeFill"] . " +0x200 Border", "X")

    promptGui.SetFont("s9", "Segoe UI")
    promptText := promptGui.AddText("x18 y56 w324 h34 c" . uiTheme["text"], prompt)
    nameEdit := promptGui.AddEdit("x18 y96 w324 h28", initialValue)
    okButton := promptGui.AddButton("x162 y140 w84 h30 Default", "OK")
    cancelButton := promptGui.AddButton("x258 y140 w84 h30", "Cancel")

    clearDialogState := () => (
        ConfiguredPullBuilderState["textInputGuiHwnd"] := 0,
        ConfiguredPullBuilderState["textInputApplyFn"] := 0
    )
    closeDialog := (*) => (state["result"] := "Cancel", clearDialogState(), promptGui.Destroy())
    submitDialog := (*) => (state["result"] := "OK", state["value"] := nameEdit.Value, clearDialogState(), promptGui.Destroy())
    closeText.OnEvent("Click", closeDialog)
    cancelButton.OnEvent("Click", closeDialog)
    okButton.OnEvent("Click", submitDialog)
    promptGui.OnEvent("Close", closeDialog)
    promptGui.OnEvent("Escape", closeDialog)

    if ownerHwnd {
        WinGetPos(&ownerX, &ownerY, &ownerW, &ownerH, "ahk_id " ownerHwnd)
        promptX := ownerX + Floor((ownerW - 360) / 2)
        promptY := ownerY + Floor((ownerH - 180) / 2)
        promptGui.Show(Format("x{} y{} w360 h184", promptX, promptY))
    } else {
        promptGui.Show("w360 h184 Center")
    }

    ConfiguredPullBuilderState["textInputGuiHwnd"] := promptGui.Hwnd
    ConfiguredPullBuilderState["textInputApplyFn"] := submitDialog
    WinActivate("ahk_id " promptGui.Hwnd)
    nameEdit.Focus()
    nameEdit.Value := initialValue
    SendMessage(0xB1, 0, StrLen(initialValue), nameEdit.Hwnd)
    WinWaitClose("ahk_id " promptGui.Hwnd)
    if ConfiguredPullBuilderState.Count {
        ConfiguredPullBuilderState["textInputGuiHwnd"] := 0
        ConfiguredPullBuilderState["textInputApplyFn"] := 0
    }
    return state
}

ShowThemedMessageDialog(title, message, mode := "OK") {
    global ConfiguredPullBuilderState

    uiTheme := ConfiguredPullBuilderState.Count && ConfiguredPullBuilderState.Has("uiTheme")
        ? ConfiguredPullBuilderState["uiTheme"]
        : GetUiTheme()

    ownerHwnd := 0
    if ConfiguredPullBuilderState.Count {
        if ConfiguredPullBuilderState.Has("keyboardGuiHwnd") && ConfiguredPullBuilderState["keyboardGuiHwnd"] {
            ownerHwnd := ConfiguredPullBuilderState["keyboardGuiHwnd"]
        } else if ConfiguredPullBuilderState.Has("openerGuiHwnd") && ConfiguredPullBuilderState["openerGuiHwnd"] {
            ownerHwnd := ConfiguredPullBuilderState["openerGuiHwnd"]
        } else if ConfiguredPullBuilderState.Has("guiHwnd") && ConfiguredPullBuilderState["guiHwnd"] {
            ownerHwnd := ConfiguredPullBuilderState["guiHwnd"]
        }
    }

    options := "-Caption +Border +ToolWindow +AlwaysOnTop"
    if ownerHwnd {
        options .= " +Owner" . ownerHwnd
    }

    dialogGui := Gui(options, title)
    dialogGui.SetFont("s10", "Segoe UI")
    dialogGui.BackColor := uiTheme["surface"]
    dialogGui.MarginX := 0
    dialogGui.MarginY := 0

    state := Map("result", mode = "YesNo" ? "No" : "OK")

    headerBar := dialogGui.AddText("x0 y0 w320 h38 Background" . uiTheme["header"], "")
    headerBar.OnEvent("Click", (*) => StartGuiDrag(dialogGui))
    dialogGui.SetFont("s11", "Segoe UI Semibold")
    headerTitle := dialogGui.AddText("x14 y9 w280 c" . uiTheme["headerText"], title)
    headerTitle.OnEvent("Click", (*) => StartGuiDrag(dialogGui))
    closeText := dialogGui.AddText("x326 y5 w24 h26 Center c" . uiTheme["headerText"] . " Background" . uiTheme["closeFill"] . " +0x200 Border", "X")

    dialogGui.SetFont("s9", "Segoe UI")
    messageText := dialogGui.AddText("x18 y60 w324 h72 Center c" . uiTheme["text"], message)
    buttonsY := 144

    closeDialog := (*) => (dialogGui.Destroy())
    closeText.OnEvent("Click", closeDialog)
    dialogGui.OnEvent("Close", closeDialog)
    dialogGui.OnEvent("Escape", closeDialog)

    if mode = "YesNo" {
        yesButton := dialogGui.AddButton("x162 y144 w84 h30 Default", "Yes")
        noButton := dialogGui.AddButton("x258 y144 w84 h30", "No")
        yesButton.OnEvent("Click", (*) => (state["result"] := "Yes", dialogGui.Destroy()))
        noButton.OnEvent("Click", (*) => (state["result"] := "No", dialogGui.Destroy()))
    } else {
        okButton := dialogGui.AddButton("x258 y144 w84 h30 Default", "OK")
        okButton.OnEvent("Click", (*) => (state["result"] := "OK", dialogGui.Destroy()))
    }

    if ownerHwnd {
        WinGetPos(&ownerX, &ownerY, &ownerW, &ownerH, "ahk_id " ownerHwnd)
        dialogX := ownerX + Floor((ownerW - 360) / 2)
        dialogY := ownerY + Floor((ownerH - 184) / 2)
        dialogGui.Show(Format("x{} y{} w360 h184", dialogX, dialogY))
    } else {
        dialogGui.Show("w360 h184 Center")
    }

    WinActivate("ahk_id " dialogGui.Hwnd)
    WinWaitClose("ahk_id " dialogGui.Hwnd)
    return state["result"]
}

ShowThemedWorkspacePickerDialog(title, prompt, initialProfileId := "") {
    global ConfiguredPullBuilderState
    global WorkspaceOpenerProfiles

    uiTheme := ConfiguredPullBuilderState.Count && ConfiguredPullBuilderState.Has("uiTheme")
        ? ConfiguredPullBuilderState["uiTheme"]
        : GetUiTheme()

    ownerHwnd := 0
    if ConfiguredPullBuilderState.Count {
        if ConfiguredPullBuilderState.Has("openerGuiHwnd") && ConfiguredPullBuilderState["openerGuiHwnd"] {
            ownerHwnd := ConfiguredPullBuilderState["openerGuiHwnd"]
        } else if ConfiguredPullBuilderState.Has("guiHwnd") && ConfiguredPullBuilderState["guiHwnd"] {
            ownerHwnd := ConfiguredPullBuilderState["guiHwnd"]
        }
    }

    options := "-Caption +Border +ToolWindow +AlwaysOnTop"
    if ownerHwnd {
        options .= " +Owner" . ownerHwnd
    }

    pickerGui := Gui(options, title)
    pickerGui.SetFont("s10", "Segoe UI")
    pickerGui.BackColor := uiTheme["surface"]
    pickerGui.MarginX := 0
    pickerGui.MarginY := 0

    state := Map("result", "Cancel", "profileId", "")
    labels := []
    profileIds := []
    initialIndex := 1

    for index, profile in WorkspaceOpenerProfiles {
        labels.Push(profile["name"])
        profileIds.Push(profile["id"])
        if initialProfileId != "" && profile["id"] = initialProfileId {
            initialIndex := index
        }
    }

    headerBar := pickerGui.AddText("x0 y0 w420 h38 Background" . uiTheme["header"], "")
    headerBar.OnEvent("Click", (*) => StartGuiDrag(pickerGui))
    pickerGui.SetFont("s11", "Segoe UI Semibold")
    headerTitle := pickerGui.AddText("x14 y9 w340 c" . uiTheme["headerText"], title)
    headerTitle.OnEvent("Click", (*) => StartGuiDrag(pickerGui))
    closeText := pickerGui.AddText("x426 y5 w24 h26 Center c" . uiTheme["headerText"] . " Background" . uiTheme["closeFill"] . " +0x200 Border", "X")

    pickerGui.SetFont("s9", "Segoe UI")
    pickerGui.AddText("x18 y60 w380 h34 c" . uiTheme["text"], prompt)
    pickerGui.AddText("x18 y98 w380 h18 c" . uiTheme["muted"], "Suggested based on your open apps and recent workspace activity.")
    workspaceDropDown := pickerGui.AddDropDownList("x18 y126 w384 Choose" . initialIndex, labels)
    applyButton := pickerGui.AddButton("x206 y176 w96 h30 Default", "Apply")
    cancelButton := pickerGui.AddButton("x314 y176 w96 h30", "Cancel")

    clearDialogState := () => (
        ConfiguredPullBuilderState["workspacePickerGuiHwnd"] := 0,
        ConfiguredPullBuilderState["workspacePickerApplyFn"] := 0
    )
    closeDialog := (*) => (state["result"] := "Cancel", clearDialogState(), pickerGui.Destroy())
    applyDialog := (*) => (
        state["result"] := "OK",
        state["profileId"] := profileIds[workspaceDropDown.Value],
        clearDialogState(),
        pickerGui.Destroy()
    )

    closeText.OnEvent("Click", closeDialog)
    cancelButton.OnEvent("Click", closeDialog)
    applyButton.OnEvent("Click", applyDialog)
    pickerGui.OnEvent("Close", closeDialog)
    pickerGui.OnEvent("Escape", closeDialog)

    if ownerHwnd {
        WinGetPos(&ownerX, &ownerY, &ownerW, &ownerH, "ahk_id " ownerHwnd)
        pickerX := ownerX + Floor((ownerW - 452) / 2)
        pickerY := ownerY + Floor((ownerH - 230) / 2)
        pickerGui.Show(Format("x{} y{} w452 h230", pickerX, pickerY))
    } else {
        pickerGui.Show("w452 h230 Center")
    }

    ConfiguredPullBuilderState["workspacePickerGuiHwnd"] := pickerGui.Hwnd
    ConfiguredPullBuilderState["workspacePickerApplyFn"] := applyDialog
    workspaceDropDown.Focus()
    WinActivate("ahk_id " pickerGui.Hwnd)
    WinWaitClose("ahk_id " pickerGui.Hwnd)
    if ConfiguredPullBuilderState.Count {
        ConfiguredPullBuilderState["workspacePickerGuiHwnd"] := 0
        ConfiguredPullBuilderState["workspacePickerApplyFn"] := 0
    }
    return state
}


GetHotkeyCardEntries() {
    global SharedHotkeyRegistry
    global ConfiguredPullHotkeys

    entries := Map("shared", [], "app", [])

    for _, entry in SharedHotkeyRegistry {
        entries["shared"].Push(Map(
            "id", entry["id"],
            "hotkey", entry["hotkey"],
            "display", GetDisplayForHotkey(entry["hotkey"]),
            "action", entry["action"],
            "kind", "shared",
            "script", entry["script"],
            "disabledHotkey", entry.Has("disabledHotkey") ? entry["disabledHotkey"] : ""
        ))
    }

    for _, config in ConfiguredPullHotkeys {
        entries["app"].Push(Map(
            "hotkey", config["hotkey"],
            "disabledHotkey", config.Has("disabledHotkey") ? config["disabledHotkey"] : "",
            "display", GetDisplayForHotkey(config["hotkey"] != "" ? config["hotkey"] : (config.Has("disabledHotkey") ? config["disabledHotkey"] : "")),
            "action", GetConfiguredAppLabel(config),
            "kind", "app",
            "config", config
        ))
    }

    return entries
}

GetHotkeyViewerEntryKey(entry) {
    if entry["kind"] = "shared" {
        return entry["id"]
    }

    return entry["config"]["match"]
}

HotkeyViewerEntryMatchesSelection(entry) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return false
    }

    return ConfiguredPullBuilderState["keyboardSelectedKind"] = entry["kind"]
        && ConfiguredPullBuilderState["keyboardSelectedId"] = GetHotkeyViewerEntryKey(entry)
}

GetSelectedHotkeyViewerEntry() {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return 0
    }

    selectedKind := ConfiguredPullBuilderState["keyboardSelectedKind"]
    selectedId := ConfiguredPullBuilderState["keyboardSelectedId"]
    if selectedKind = "" || selectedId = "" {
        return 0
    }

    groupedEntries := GetHotkeyCardEntries()
    for _, entry in groupedEntries["shared"] {
        if selectedKind = "shared" && entry["id"] = selectedId {
            return entry
        }
    }

    for _, entry in groupedEntries["app"] {
        if selectedKind = "app" && entry["config"]["match"] = selectedId {
            return entry
        }
    }

    return 0
}

RenderHotkeyCards(keyboardGui, uiTheme) {
    global ConfiguredPullBuilderState

    groupedEntries := GetHotkeyCardEntries()
    ConfiguredPullBuilderState["keyboardPages"] := BuildHotkeyViewerPages(groupedEntries)
    pageIndex := ConfiguredPullBuilderState["keyboardPageIndex"]
    if pageIndex < 1 || pageIndex > ConfiguredPullBuilderState["keyboardPages"].Length {
        pageIndex := 1
    }
    ConfiguredPullBuilderState["keyboardPageIndex"] := pageIndex
    RenderHotkeyViewerPage(pageIndex)
}

BuildHotkeyViewerPages(groupedEntries) {
    cols := 3
    maxRowsPerPage := 4
    pages := []
    currentPage := Map("items", [], "rows", 0)

    for _, sectionInfo in [
        Map("title", "Shared Hotkeys", "entries", groupedEntries["shared"]),
        Map("title", "App Hotkeys", "entries", groupedEntries["app"])
    ] {
        rows := []
        currentRow := []
        for _, entry in sectionInfo["entries"] {
            currentRow.Push(entry)
            if currentRow.Length = cols {
                rows.Push(currentRow)
                currentRow := []
            }
        }
        if currentRow.Length {
            rows.Push(currentRow)
        }

        rowIndex := 1
        while rowIndex <= rows.Length {
            if currentPage["rows"] = maxRowsPerPage {
                pages.Push(currentPage)
                currentPage := Map("items", [], "rows", 0)
            }

            if currentPage["items"].Length = 0 || currentPage["items"][currentPage["items"].Length]["kind"] != "section" || currentPage["items"][currentPage["items"].Length]["title"] != sectionInfo["title"] {
                currentPage["items"].Push(Map("kind", "section", "title", sectionInfo["title"]))
            }

            while rowIndex <= rows.Length && currentPage["rows"] < maxRowsPerPage {
                currentPage["items"].Push(Map("kind", "row", "entries", rows[rowIndex]))
                currentPage["rows"] += 1
                rowIndex += 1
            }

            if rowIndex <= rows.Length {
                pages.Push(currentPage)
                currentPage := Map("items", [], "rows", 0)
            }
        }
    }

    if currentPage["items"].Length {
        pages.Push(currentPage)
    }
    if pages.Length = 0 {
        pages.Push(Map("items", [], "rows", 0))
    }

    return pages
}

RenderHotkeyViewerPage(pageIndex) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count
        || !ConfiguredPullBuilderState["keyboardGuiHwnd"] {
        return
    }

    for _, ctrl in ConfiguredPullBuilderState["keyboardRenderedControls"] {
        try ctrl.Destroy()
    }
    ConfiguredPullBuilderState["keyboardRenderedControls"] := []

    pages := ConfiguredPullBuilderState["keyboardPages"]
    pageCount := pages.Length
    pageIndex := Max(Min(pageIndex, pageCount), 1)
    ConfiguredPullBuilderState["keyboardPageIndex"] := pageIndex

    keyboardGui := ConfiguredPullBuilderState["keyboardGui"]
    uiTheme := ConfiguredPullBuilderState["uiTheme"]
    rendered := []
    page := pages[pageIndex]
    y := 142
    startX := 18
    cardWidth := 168
    cardHeight := 82
    colGap := 12
    rowGap := 12
    cardControls := []

    for _, item in page["items"] {
        if item["kind"] = "section" {
            keyboardGui.SetFont("s10", "Segoe UI Semibold")
            sectionTitle := keyboardGui.AddText(Format("x{} y{} w500 c{}", startX, y, uiTheme["text"]), item["title"])
            rendered.Push(sectionTitle)
            y += 28
            continue
        }

        for col, entry in item["entries"] {
            selected := HotkeyViewerEntryMatchesSelection(entry)
            borderColor := selected
                ? uiTheme["text"]
                : (entry["kind"] = "shared" ? uiTheme["sharedBorder"] : uiTheme["appBorder"])
            fillColor := entry["kind"] = "shared" ? uiTheme["sharedFill"] : uiTheme["appFill"]
            x := startX + ((col - 1) * (cardWidth + colGap))

            cardBorder := keyboardGui.AddText(Format("x{} y{} w{} h{} Background{}", x, y, cardWidth, cardHeight, borderColor), "")
            cardFill := keyboardGui.AddText(Format("x{} y{} w{} h{} Background{} +0x200 +0x100", x + 3, y + 3, cardWidth - 6, cardHeight - 6, fillColor), "")
            comboText := keyboardGui.AddText(Format("x{} y{} w{} h20 Center c{} Background{} +0x100", x + 14, y + 12, cardWidth - 28, uiTheme["cardText"], fillColor), entry["display"])
            comboText.SetFont("s9", "Segoe UI Semibold")
            actionText := keyboardGui.AddText(Format("x{} y{} w{} h34 Center c{} Background{} +0x100", x + 14, y + 36, cardWidth - 28, uiTheme["cardText"], fillColor), entry["action"])

            selectHandler := SelectHotkeyViewerEntry.Bind(entry)
            openHandler := OpenHotkeyViewerEntry.Bind(entry)
            cardFill.OnEvent("Click", selectHandler)
            comboText.OnEvent("Click", selectHandler)
            actionText.OnEvent("Click", selectHandler)
            cardFill.OnEvent("DoubleClick", openHandler)
            comboText.OnEvent("DoubleClick", openHandler)
            actionText.OnEvent("DoubleClick", openHandler)

            rendered.Push(cardBorder)
            rendered.Push(cardFill)
            rendered.Push(comboText)
            rendered.Push(actionText)
            cardControls.Push(Map(
                "kind", entry["kind"],
                "key", GetHotkeyViewerEntryKey(entry),
                "border", cardBorder
            ))
        }
        y += cardHeight + rowGap
    }

    ConfiguredPullBuilderState["keyboardRenderedControls"] := rendered
    ConfiguredPullBuilderState["keyboardCardControls"] := cardControls
    UpdateHotkeyViewerPagination()
    UpdateHotkeyViewerActionState()
}

UpdateHotkeyViewerPagination() {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    pageCount := Max(ConfiguredPullBuilderState["keyboardPages"].Length, 1)
    pageIndex := ConfiguredPullBuilderState["keyboardPageIndex"]
    ConfiguredPullBuilderState["keyboardPageLabel"].Text := "Page " . pageIndex . " of " . pageCount
    ConfiguredPullBuilderState["keyboardPrevButton"].Enabled := pageIndex > 1
    ConfiguredPullBuilderState["keyboardNextButton"].Enabled := pageIndex < pageCount
}

UpdateHotkeyViewerActionState() {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count || !ConfiguredPullBuilderState["keyboardGui"] {
        return
    }

    entry := GetSelectedHotkeyViewerEntry()
    hasEntry := !!entry
    openButton := ConfiguredPullBuilderState["keyboardOpenButton"]
    toggleButton := ConfiguredPullBuilderState["keyboardToggleButton"]
    deleteButton := ConfiguredPullBuilderState["keyboardDeleteButton"]
    selectionText := ConfiguredPullBuilderState["keyboardSelectionText"]

    openButton.Enabled := hasEntry
    toggleButton.Enabled := hasEntry
    deleteButton.Enabled := false
    deleteButton.Visible := false

    if !hasEntry {
        toggleButton.Text := "Disable"
        selectionText.Text := "Select a hotkey card."
        return
    }

    if entry["kind"] = "shared" {
        toggleButton.Text := entry["hotkey"] = "" ? "Enable" : "Disable"
    } else {
        toggleButton.Text := entry["hotkey"] = "" ? "Enable" : "Disable"
        deleteButton.Visible := true
        deleteButton.Enabled := true
    }

    selectionText.Text := entry["display"] . " - " . entry["action"]
}

UpdateHotkeyViewerSelectionVisuals() {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    uiTheme := ConfiguredPullBuilderState["uiTheme"]
    for _, card in ConfiguredPullBuilderState["keyboardCardControls"] {
        selected := ConfiguredPullBuilderState["keyboardSelectedKind"] = card["kind"]
            && ConfiguredPullBuilderState["keyboardSelectedId"] = card["key"]
        borderColor := selected
            ? uiTheme["text"]
            : (card["kind"] = "shared" ? uiTheme["sharedBorder"] : uiTheme["appBorder"])
        try card["border"].Opt("Background" . borderColor)
    }
}

ChangeHotkeyViewerPage(step) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    newPage := ConfiguredPullBuilderState["keyboardPageIndex"] + step
    if newPage < 1 || newPage > ConfiguredPullBuilderState["keyboardPages"].Length {
        return
    }

    ReopenHotkeyViewerPage(newPage)
}

ReopenHotkeyViewerPage(pageIndex) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count || !ConfiguredPullBuilderState["keyboardGui"] {
        return
    }

    keyboardGui := ConfiguredPullBuilderState["keyboardGui"]
    WinGetPos(&guiX, &guiY,,, "ahk_id " keyboardGui.Hwnd)
    CloseHotkeyKeyboardViewer()
    OpenHotkeyKeyboardViewer(pageIndex, Format("x{} y{} w720 h620", guiX, guiY))
}

SelectHotkeyViewerEntry(entry, *) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    ConfiguredPullBuilderState["keyboardSelectedKind"] := entry["kind"]
    ConfiguredPullBuilderState["keyboardSelectedId"] := GetHotkeyViewerEntryKey(entry)
    UpdateHotkeyViewerSelectionVisuals()
    UpdateHotkeyViewerActionState()
}

OpenHotkeyViewerEntry(entry, *) {
    SelectHotkeyViewerEntry(entry)

    if entry["kind"] = "app" {
        LoadHotkeyCardIntoBuilder(entry)
        return
    }

    LoadSharedHotkeyCardIntoBuilder(entry)
}

OpenSelectedHotkeyViewerEntry(*) {
    entry := GetSelectedHotkeyViewerEntry()
    if !entry {
        return
    }

    OpenHotkeyViewerEntry(entry)
}

ToggleSelectedHotkeyViewerEntry(*) {
    entry := GetSelectedHotkeyViewerEntry()
    if !entry {
        return
    }

    if entry["kind"] = "shared" {
        ToggleSelectedSharedHotkey(entry)
        return
    }

    ToggleSelectedAppHotkey(entry)
}

DeleteSelectedHotkeyViewerEntry(*) {
    entry := GetSelectedHotkeyViewerEntry()
    if !entry || entry["kind"] != "app" {
        return
    }

    DeleteSelectedAppHotkey(entry)
}

DeleteSelectedAppHotkey(entry) {
    global ConfiguredPullBuilderState
    global ConfiguredPullHotkeys

    result := ShowThemedMessageDialog("Delete Hotkey", "Delete " . entry["display"] . " for " . entry["action"] . "?", "YesNo")
    if result != "Yes" {
        return
    }

    deleteIndex := FindConfiguredPullIndexByMatch(entry["config"]["match"])
    if !deleteIndex {
        return
    }

    RegisterConfiguredPullHotkey(entry["config"], false)
    ConfiguredPullHotkeys.RemoveAt(deleteIndex)
    SaveConfiguredPullHotkeys(ConfiguredPullHotkeys)

    ConfiguredPullBuilderState["keyboardSelectedKind"] := ""
    ConfiguredPullBuilderState["keyboardSelectedId"] := ""
    RenderHotkeyCards(ConfiguredPullBuilderState["keyboardGui"], ConfiguredPullBuilderState["uiTheme"])
}

ToggleSelectedAppHotkey(entry) {
    global ConfiguredPullBuilderState
    global ConfiguredPullHotkeys

    configIndex := FindConfiguredPullIndexByMatch(entry["config"]["match"])
    if !configIndex {
        return
    }

    config := ConfiguredPullHotkeys[configIndex]
    currentHotkey := config["hotkey"]
    if currentHotkey = "" {
        restoredHotkey := config.Has("disabledHotkey") ? config["disabledHotkey"] : ""
        if restoredHotkey = "" {
            return
        }

        if !ResolveHotkeyEnableConflict(restoredHotkey, "app", config["match"], "", GetConfiguredAppLabel(config)) {
            return
        }

        global WindowWarpHotkeysEnabled
        config["hotkey"] := restoredHotkey
        config["disabledHotkey"] := ""
        if WindowWarpHotkeysEnabled {
            RegisterConfiguredPullHotkey(config)
        }
    } else {
        RegisterConfiguredPullHotkey(config, false)
        config["disabledHotkey"] := currentHotkey
        config["hotkey"] := ""
    }

    ConfiguredPullHotkeys[configIndex] := config
    SaveConfiguredPullHotkeys(ConfiguredPullHotkeys)
    ConfiguredPullBuilderState["keyboardSelectedKind"] := "app"
    ConfiguredPullBuilderState["keyboardSelectedId"] := config["match"]
    RenderHotkeyCards(ConfiguredPullBuilderState["keyboardGui"], ConfiguredPullBuilderState["uiTheme"])
}

ToggleSelectedSharedHotkey(entry) {
    global ConfiguredPullBuilderState
    global SharedHotkeyRegistry

    sharedIndex := FindSharedRegistryIndexById(entry["id"])
    if !sharedIndex {
        return
    }

    currentHotkey := SharedHotkeyRegistry[sharedIndex]["hotkey"]
    if currentHotkey = "" {
        restoredHotkey := SharedHotkeyRegistry[sharedIndex].Has("disabledHotkey")
            ? SharedHotkeyRegistry[sharedIndex]["disabledHotkey"]
            : GetDefaultSharedHotkey(entry["id"])
        if restoredHotkey = "" {
            return
        }

        if !ResolveHotkeyEnableConflict(restoredHotkey, "shared", "", entry["id"], entry["action"]) {
            return
        }

        SharedHotkeyRegistry[sharedIndex]["hotkey"] := restoredHotkey
        SharedHotkeyRegistry[sharedIndex]["disabledHotkey"] := ""
        ApplySharedHotkeyLiveState(entry["id"], restoredHotkey, true)
    } else {
        ApplySharedHotkeyLiveState(entry["id"], currentHotkey, false)
        SharedHotkeyRegistry[sharedIndex]["disabledHotkey"] := currentHotkey
        SharedHotkeyRegistry[sharedIndex]["hotkey"] := ""
    }

    SaveSharedHotkeyRegistry(SharedHotkeyRegistry)

    ConfiguredPullBuilderState["keyboardSelectedKind"] := "shared"
    ConfiguredPullBuilderState["keyboardSelectedId"] := entry["id"]
    RenderHotkeyCards(ConfiguredPullBuilderState["keyboardGui"], ConfiguredPullBuilderState["uiTheme"])
}

ResolveHotkeyEnableConflict(hotkey, enablingKind, currentMatch := "", currentSharedId := "", enablingLabel := "") {
    global SharedHotkeyRegistry
    global ConfiguredPullHotkeys

    sharedConflict := FindSharedRegistryEntryByHotkey(hotkey)
    if sharedConflict
        && !(enablingKind = "shared" && sharedConflict["id"] = currentSharedId) {
        result := ShowThemedMessageDialog(
            "Enable Hotkey",
            hotkey . " is already assigned to " . sharedConflict["action"] . "." . "`n`nEnable " . enablingLabel . " and disable the other hotkey?",
            "YesNo"
        )
        if result != "Yes" {
            return false
        }

        otherIndex := FindSharedRegistryIndexById(sharedConflict["id"])
        if otherIndex {
            ApplySharedHotkeyLiveState(sharedConflict["id"], SharedHotkeyRegistry[otherIndex]["hotkey"], false)
            SharedHotkeyRegistry[otherIndex]["disabledHotkey"] := SharedHotkeyRegistry[otherIndex]["hotkey"]
            SharedHotkeyRegistry[otherIndex]["hotkey"] := ""
            SaveSharedHotkeyRegistry(SharedHotkeyRegistry)
        }
    }

    appConflictIndex := FindConfiguredPullIndexByHotkey(hotkey)
    if appConflictIndex
        && !(enablingKind = "app" && ConfiguredPullHotkeys[appConflictIndex]["match"] = currentMatch) {
        conflictLabel := GetConfiguredAppLabel(ConfiguredPullHotkeys[appConflictIndex])
        result := ShowThemedMessageDialog(
            "Enable Hotkey",
            hotkey . " is already assigned to " . conflictLabel . "." . "`n`nEnable " . enablingLabel . " and disable the other hotkey?",
            "YesNo"
        )
        if result != "Yes" {
            return false
        }

        RegisterConfiguredPullHotkey(ConfiguredPullHotkeys[appConflictIndex], false)
        ConfiguredPullHotkeys[appConflictIndex]["disabledHotkey"] := ConfiguredPullHotkeys[appConflictIndex]["hotkey"]
        ConfiguredPullHotkeys[appConflictIndex]["hotkey"] := ""
        SaveConfiguredPullHotkeys(ConfiguredPullHotkeys)
    }

    return true
}

GetDefaultSharedHotkey(id) {
    for _, entry in DefaultSharedHotkeyRegistry() {
        if entry["id"] = id {
            return entry["hotkey"]
        }
    }

    return ""
}

ApplySharedHotkeyLiveState(sharedId, hotkey, enable) {
    global WindowWarpHotkeysEnabled

    if enable && !WindowWarpHotkeysEnabled && sharedId != "wm.toggle-suspend" {
        enable := false
    }

    static managedIds := Map(
        "wm.move-left", true,
        "wm.move-right", true,
        "wm.move-left-center", true,
        "wm.move-right-center", true,
        "wm.open-builder", true,
        "wm.open-opener", true,
        "wm.update-workspace", true,
        "wm.pull-recent", true,
        "wm.toggle-suspend", true,
        "fullscreen.toggle", true,
        "kill.close-active", true
    )

    if managedIds.Has(sharedId) {
        Hotkey(NormalizeHotkeyForDynamicRegistration(hotkey), enable ? "On" : "Off")
        return
    }

    ReloadExternalSharedHotkeyScript(sharedId)
}

NormalizeHotkeyForDynamicRegistration(hotkey) {
    if hotkey = "" {
        return hotkey
    }

    return StrReplace(hotkey, ";", "`;")
}

GetConfiguredPullSystemPassThroughHotkeys(hotkey) {
    normalized := NormalizeSimpleHotkeyForComparison(hotkey)
    if normalized = "" {
        return []
    }

    parsed := ParseSimpleHotkey(normalized)
    if !parsed || !InStr(parsed["modifiers"], "#") || InStr(parsed["modifiers"], "^") {
        return []
    }

    ctrlVariant := BuildSimpleHotkey(parsed["modifiers"] . "^", parsed["key"])
    if ctrlVariant = "" || IsHotkeyAssigned(ctrlVariant) {
        return []
    }

    return ["~" . ctrlVariant]
}

IsHotkeyAssigned(hotkey) {
    global ConfiguredPullHotkeys
    global SharedHotkeyRegistry

    target := NormalizeSimpleHotkeyForComparison(hotkey)
    if target = "" {
        return true
    }

    for _, entry in SharedHotkeyRegistry {
        if entry.Has("hotkey") && NormalizeSimpleHotkeyForComparison(entry["hotkey"]) = target {
            return true
        }
    }

    for _, config in ConfiguredPullHotkeys {
        if config.Has("hotkey") && NormalizeSimpleHotkeyForComparison(config["hotkey"]) = target {
            return true
        }
    }

    return false
}

ExactHotkeyModifiersMatch(hotkey) {
    parsed := ParseSimpleHotkey(hotkey)
    if !parsed {
        return true
    }

    if HotkeyMatchesTriggeredHotkey(hotkey) {
        return true
    }

    requiredModifiers := parsed["modifiers"]
    hasWin := InStr(requiredModifiers, "#") > 0
    hasCtrl := InStr(requiredModifiers, "^") > 0
    hasAlt := InStr(requiredModifiers, "!") > 0
    hasShift := InStr(requiredModifiers, "+") > 0

    if IsHotkeyModifierPressed("#") != hasWin {
        return false
    }
    if IsHotkeyModifierPressed("^") != hasCtrl {
        return false
    }
    if IsHotkeyModifierPressed("!") != hasAlt {
        return false
    }
    if IsHotkeyModifierPressed("+") != hasShift {
        return false
    }

    return true
}

HotkeyMatchesTriggeredHotkey(hotkey) {
    triggeredHotkey := A_ThisHotkey
    if triggeredHotkey = "" {
        return false
    }

    triggeredHotkey := RegExReplace(triggeredHotkey, "\s+Up$")
    return NormalizeSimpleHotkeyForComparison(triggeredHotkey) = NormalizeSimpleHotkeyForComparison(hotkey)
}

IsHotkeyModifierPressed(modifierToken) {
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

NormalizeSimpleHotkeyForComparison(hotkey) {
    parsed := ParseSimpleHotkey(hotkey)
    if !parsed {
        return ""
    }

    return BuildSimpleHotkey(parsed["modifiers"], parsed["key"])
}

ParseSimpleHotkey(hotkey) {
    hotkey := Trim(hotkey)
    if hotkey = "" || InStr(hotkey, "&") {
        return 0
    }

    while hotkey != "" {
        prefix := SubStr(hotkey, 1, 1)
        if InStr("*~$", prefix) {
            hotkey := SubStr(hotkey, 2)
            continue
        }

        break
    }

    if InStr(hotkey, "<") || InStr(hotkey, ">") {
        return 0
    }

    modifiers := ""
    while hotkey != "" {
        prefix := SubStr(hotkey, 1, 1)
        if InStr("#^!+", prefix) {
            if !InStr(modifiers, prefix) {
                modifiers .= prefix
            }
            hotkey := SubStr(hotkey, 2)
            continue
        }

        break
    }

    hotkey := Trim(hotkey)
    if hotkey = "" {
        return 0
    }

    return Map("modifiers", modifiers, "key", hotkey)
}

BuildSimpleHotkey(modifiers, key) {
    orderedModifiers := ""
    for _, modifier in ["#", "^", "!", "+"] {
        if InStr(modifiers, modifier) {
            orderedModifiers .= modifier
        }
    }

    return orderedModifiers . key
}

ReloadExternalSharedHotkeyScript(sharedId) {
    scriptPath := ""
    switch sharedId {
        case "fullscreen.toggle":
            scriptPath := A_ScriptDir "\fullscreen.ahk"
        case "kill.close-active":
            scriptPath := A_ScriptDir "\kill.ahk"
    }

    if scriptPath = "" || !FileExist(scriptPath) {
        return
    }

    try Run('"' . A_AhkPath . '" "' . scriptPath . '"')
}

GetUiTheme() {
    try {
        appsUseLightTheme := RegRead("HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme")
    } catch {
        appsUseLightTheme := 1
    }

    if appsUseLightTheme = 0 {
        return Map(
            "surface", "1E1F22",
            "title", "F9FAFB",
            "text", "F3F4F6",
            "muted", "A1A1AA",
            "section", "C7CDD6",
            "input", "2B2D31",
            "danger", "FCA5A5",
            "dangerFill", "40262B",
            "header", "1E1F22",
            "headerText", "F9FAFB",
            "closeFill", "B42318",
            "scrollTrack", "0F1012",
            "scrollThumb", "737983",
            "sharedBorder", "636873",
            "sharedFill", "1E1F22",
            "appBorder", "5E8A68",
            "appFill", "1E1F22",
            "cardText", "F3F4F6"
        )
    }

    return Map(
        "surface", "F5F7FA",
        "title", "16202A",
        "text", "111827",
        "muted", "6B7280",
        "section", "94A3B8",
        "input", "FFFFFF",
        "danger", "B42318",
        "dangerFill", "FDE8E8",
        "header", "F5F7FA",
        "headerText", "16202A",
        "closeFill", "D14D41",
        "scrollTrack", "D1D5DB",
        "scrollThumb", "6B7280",
        "sharedBorder", "A5AFBE",
        "sharedFill", "F5F7FA",
        "appBorder", "6BA07A",
        "appFill", "F5F7FA",
        "cardText", "111827"
    )
}

LoadHotkeyCardIntoBuilder(entry, *) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    config := entry["config"]
    windowInfo := Map(
        "match", config["match"],
        "label", GetConfiguredAppLabel(config)
    )
    SetConfiguredPullBuilderEditingMode("app", windowInfo)
    ApplyHotkeyToBuilderControls(config["hotkey"])

    if GetMainMonitorAction(config) = "focus-last" {
        ConfiguredPullBuilderState["mainRadio"].Value := 1
        ConfiguredPullBuilderState["burnerRadio"].Value := 0
    } else {
        ConfiguredPullBuilderState["mainRadio"].Value := 0
        ConfiguredPullBuilderState["burnerRadio"].Value := 1
    }

    UpdateConfiguredPullBuilderConflictState()
    CloseHotkeyKeyboardViewer()
    ConfiguredPullBuilderState["gui"].Show()
}

LoadSharedHotkeyCardIntoBuilder(entry, *) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    sharedInfo := Map(
        "match", entry["script"],
        "label", entry["action"]
    )
    SetConfiguredPullBuilderEditingMode("shared", sharedInfo, entry["id"])
    ApplyHotkeyToBuilderControls(entry["hotkey"])
    CloseHotkeyKeyboardViewer()
    ConfiguredPullBuilderState["gui"].Show()
}

ApplyHotkeyToBuilderControls(hotkey) {
    global ConfiguredPullBuilderState

    parts := ParseHotkeyForBuilder(hotkey)
    if !parts {
        return
    }

    ConfiguredPullBuilderState["winCheckbox"].Value := parts["win"]
    ConfiguredPullBuilderState["ctrlCheckbox"].Value := parts["ctrl"]
    ConfiguredPullBuilderState["altCheckbox"].Value := parts["alt"]
    ConfiguredPullBuilderState["shiftCheckbox"].Value := parts["shift"]
    SetConfiguredPullBuilderHotkey(hotkey, GetDisplayForHotkey(hotkey))
}

ParseHotkeyForBuilder(hotkey) {
    parts := Map(
        "win", 0,
        "ctrl", 0,
        "alt", 0,
        "shift", 0
    )

    while hotkey != "" {
        prefix := SubStr(hotkey, 1, 1)
        if prefix = "#" {
            parts["win"] := 1
            hotkey := SubStr(hotkey, 2)
            continue
        }
        if prefix = "^" {
            parts["ctrl"] := 1
            hotkey := SubStr(hotkey, 2)
            continue
        }
        if prefix = "!" {
            parts["alt"] := 1
            hotkey := SubStr(hotkey, 2)
            continue
        }
        if prefix = "+" {
            parts["shift"] := 1
            hotkey := SubStr(hotkey, 2)
            continue
        }

        break
    }

    if hotkey = "" {
        return 0
    }

    return parts
}

GetDisplayForHotkey(hotkey) {
    if hotkey = "" {
        return "None"
    }

    displayParts := []

    while hotkey != "" {
        prefix := SubStr(hotkey, 1, 1)
        if prefix = "#" {
            displayParts.Push("Win")
            hotkey := SubStr(hotkey, 2)
            continue
        }
        if prefix = "^" {
            displayParts.Push("Ctrl")
            hotkey := SubStr(hotkey, 2)
            continue
        }
        if prefix = "!" {
            displayParts.Push("Alt")
            hotkey := SubStr(hotkey, 2)
            continue
        }
        if prefix = "+" {
            displayParts.Push("Shift")
            hotkey := SubStr(hotkey, 2)
            continue
        }

        break
    }

    if hotkey != "" {
        displayParts.Push(GetHotkeyDisplayName(hotkey))
    }

    return JoinDisplayParts(displayParts)
}

JoinDisplayParts(parts) {
    text := ""
    for _, part in parts {
        text .= (text = "" ? "" : "+") . part
    }

    return text
}

SaveConfiguredPullBuilder() {
    global ConfiguredPullBuilderState
    global ConfiguredPullHotkeys
    global SharedHotkeyRegistry

    if !ConfiguredPullBuilderState.Count {
        return
    }

    selectedHotkey := ConfiguredPullBuilderState["selectedHotkey"]
    selectedHotkeyDisplay := ConfiguredPullBuilderState["selectedHotkeyDisplay"]
    if selectedHotkey = "" {
        MsgBox("Press a key combo for the new hotkey first. Press Esc if you want to clear and choose again.", "Create App Hotkey")
        return
    }

    editingKind := ConfiguredPullBuilderState["editingKind"]
    currentMatch := editingKind = "app" ? ConfiguredPullBuilderState["windowInfo"]["match"] : ""
    currentSharedId := editingKind = "shared" ? ConfiguredPullBuilderState["editingSharedId"] : ""
    conflict := FindConfiguredPullBuilderConflict(selectedHotkey, editingKind, currentMatch, currentSharedId)

    if conflict {
        result := MsgBox(
            selectedHotkeyDisplay . " is already assigned to " . conflict["label"] . "." . "`n`n" . "Are you sure you would like to overwrite it?",
            "Confirm Hotkey Overwrite",
            "YesNo"
        )
        if result != "Yes" {
            return
        }
    }

    if editingKind = "shared" {
        SaveSharedHotkeyBuilderSelection(selectedHotkey, conflict)
        return
    }

    windowInfo := ConfiguredPullBuilderState["windowInfo"]
    newConfig := BuildConfiguredPullConfig(windowInfo, selectedHotkey, ConfiguredPullBuilderState["mainRadio"].Value = 1)
    sameAppIndex := FindConfiguredPullIndexByMatch(windowInfo["match"])
    collisionIndex := conflict && conflict["type"] = "app" ? conflict["index"] : 0

    if collisionIndex && collisionIndex != sameAppIndex {
        ConfiguredPullHotkeys.RemoveAt(collisionIndex)
        if sameAppIndex > collisionIndex {
            sameAppIndex -= 1
        }
    }

    if sameAppIndex {
        ConfiguredPullHotkeys[sameAppIndex] := newConfig
    } else {
        ConfiguredPullHotkeys.Push(newConfig)
    }

    SaveConfiguredPullHotkeys(ConfiguredPullHotkeys)
    CloseConfiguredPullBuilder()
    Reload()
}

SaveSharedHotkeyBuilderSelection(selectedHotkey, conflict := 0) {
    global ConfiguredPullBuilderState
    global SharedHotkeyRegistry
    global ConfiguredPullHotkeys

    currentSharedId := ConfiguredPullBuilderState["editingSharedId"]
    sharedIndex := FindSharedRegistryIndexById(currentSharedId)
    if !sharedIndex {
        return
    }

    if conflict {
        if conflict["type"] = "shared" {
            otherIndex := FindSharedRegistryIndexById(conflict["id"])
            if otherIndex {
                SharedHotkeyRegistry[otherIndex]["hotkey"] := ""
            }
        } else if conflict["type"] = "app" {
            ConfiguredPullHotkeys.RemoveAt(conflict["index"])
            SaveConfiguredPullHotkeys(ConfiguredPullHotkeys)
        }
    }

    SharedHotkeyRegistry[sharedIndex]["hotkey"] := selectedHotkey
    SaveSharedHotkeyRegistry(SharedHotkeyRegistry)
    CloseConfiguredPullBuilder()
    Reload()
}

BuildConfiguredPullConfig(windowInfo, hotkey, useMainMonitorConfig) {
    config := Map(
        "hotkey", hotkey,
        "match", windowInfo["match"],
        "label", windowInfo["label"]
    )

    if useMainMonitorConfig {
        config["mainMonitorAction"] := "focus-last"
        return config
    }

    config["mainMonitorAction"] := "burner"
    config["burnerLayout"] := "float"
    return config
}

GetActiveConfiguredWindowInfo() {
    hwnd := WinExist("A")
    if !hwnd {
        return 0
    }

    try {
        processName := WinGetProcessName("ahk_id " hwnd)
    } catch {
        return 0
    }

    if processName = "" {
        return 0
    }

    return Map(
        "match", "ahk_exe " . processName,
        "label", StrLower(RegExReplace(processName, "\.exe$", ""))
    )
}

FindConfiguredPullIndexByHotkey(hotkey) {
    global ConfiguredPullHotkeys

    for index, config in ConfiguredPullHotkeys {
        if config["hotkey"] = hotkey {
            return index
        }
    }

    return 0
}

FindConfiguredPullIndexByMatch(match) {
    global ConfiguredPullHotkeys

    for index, config in ConfiguredPullHotkeys {
        if config["match"] = match {
            return index
        }
    }

    return 0
}

GetConfiguredAppLabel(config) {
    if config.Has("label") && config["label"] != "" {
        return config["label"]
    }

    if config.Has("match") {
        return config["match"]
    }

    return "this app"
}

WindowWarpHotkeysAreEnabled() {
    global WindowWarpHotkeysEnabled
    return WindowWarpHotkeysEnabled
}

HandleMoveWindowDirectionHotkey(direction, centerMouse) {
    if !ExactHotkeyModifiersMatch(A_ThisHotkey) {
        return
    }
    if !WindowWarpHotkeysAreEnabled() {
        return
    }
    MoveWindowDirection(direction, centerMouse)
}

HandleOpenConfiguredHotkeyBuilderHotkey() {
    if !ExactHotkeyModifiersMatch(A_ThisHotkey) {
        return
    }
    if !WindowWarpHotkeysAreEnabled() {
        return
    }
    OpenConfiguredHotkeyBuilder()
}

HandleOpenWorkspaceOpenerHotkey() {
    if !ExactHotkeyModifiersMatch(A_ThisHotkey) {
        return
    }
    if !WindowWarpHotkeysAreEnabled() {
        return
    }
    OpenWorkspaceOpenerBrowser()
}

HandleOpenWorkspaceUpdateHotkey() {
    if !ExactHotkeyModifiersMatch(A_ThisHotkey) {
        return
    }
    if !WindowWarpHotkeysAreEnabled() {
        return
    }
    OpenWorkspaceUpdateDialog()
}

HandlePullMostRecentWindowHotkey() {
    if !ExactHotkeyModifiersMatch(A_ThisHotkey) {
        return
    }
    if !WindowWarpHotkeysAreEnabled() {
        return
    }
    PullMostRecentWindow()
}

GetWindowWarpStatusLabel() {
    global WindowWarpHotkeysEnabled
    return WindowWarpHotkeysEnabled ? "[Enabled]" : "[Disabled]"
}

GetWindowWarpStatusColor(uiTheme, enabled) {
    return enabled
        ? (uiTheme["surface"] = "1E1F22" ? "86EFAC" : "166534")
        : uiTheme["danger"]
}

UpdateWindowWarpEnabledStatusVisual() {
    global ConfiguredPullBuilderState
    global WindowWarpHotkeysEnabled

    if !ConfiguredPullBuilderState.Count || !ConfiguredPullBuilderState.Has("statusText") || !ConfiguredPullBuilderState["statusText"] {
        return
    }

    uiTheme := ConfiguredPullBuilderState["uiTheme"]
    statusText := ConfiguredPullBuilderState["statusText"]
    statusText.Text := GetWindowWarpStatusLabel()
    try statusText.Opt("c" . GetWindowWarpStatusColor(uiTheme, WindowWarpHotkeysEnabled))
}

SetWindowWarpHotkeysEnabled(enabled) {
    global WindowWarpHotkeysEnabled

    Suspend(enabled ? 0 : 1)
    WindowWarpHotkeysEnabled := enabled

    if !enabled {
        DisableRetileHotkeys()
        ClearLastPushAction()
    }

    UpdateWindowWarpEnabledStatusVisual()
}

ToggleWindowManagerSuspend(*) {
    global WindowWarpHotkeysEnabled

    if !ExactHotkeyModifiersMatch(A_ThisHotkey) {
        return
    }

    SetWindowWarpHotkeysEnabled(!WindowWarpHotkeysEnabled)
    TrayTip("Window Manager", WindowWarpHotkeysEnabled ? "Hotkeys enabled" : "Hotkeys disabled")
}

HandleConfiguredPullHotkeyDown(config, *) {
    global ConfiguredPullHotkeyState

    if !WindowWarpHotkeysAreEnabled() {
        return
    }

    if !ExactHotkeyModifiersMatch(config["hotkey"]) {
        fallbackConfig := FindSyntheticCtrlFallbackConfiguredPullConfig(config)
        if fallbackConfig {
            HandleConfiguredPullHotkeyDown(fallbackConfig)
        }
        return
    }

    stateKey := GetConfiguredPullStateKey(config)
    if ConfiguredPullHotkeyState.Has(stateKey) {
        return
    }

    MouseGetPos(&mouseX, &mouseY)
    ConfiguredPullHotkeyState[stateKey] := Map(
        "mouseX", mouseX,
        "mouseY", mouseY,
        "startTick", A_TickCount,
        "holdTriggered", false,
        "timer", ""
    )

    timer := MonitorConfiguredPullHotkey.Bind(stateKey, config)
    ConfiguredPullHotkeyState[stateKey]["timer"] := timer
    SetTimer(timer, 25)
}

HandleConfiguredPullHotkeyUp(config, *) {
    global ConfiguredPullHotkeyState

    stateKey := GetConfiguredPullStateKey(config)
    if !ConfiguredPullHotkeyState.Has(stateKey) {
        fallbackConfig := FindSyntheticCtrlFallbackConfiguredPullConfig(config)
        if fallbackConfig {
            HandleConfiguredPullHotkeyUp(fallbackConfig)
        }
        return
    }

    CompleteConfiguredPullHotkeyState(config, stateKey)
}

FindSyntheticCtrlFallbackConfiguredPullConfig(config) {
    global ConfiguredPullHotkeys

    if !(config.Has("hotkey")) {
        return 0
    }

    parsed := ParseSimpleHotkey(config["hotkey"])
    if !parsed || !InStr(parsed["modifiers"], "#") || !InStr(parsed["modifiers"], "^") {
        return 0
    }

    if IsHotkeyModifierPressed("^") {
        return 0
    }

    fallbackHotkey := BuildSimpleHotkey(StrReplace(parsed["modifiers"], "^", ""), parsed["key"])
    if fallbackHotkey = "" {
        return 0
    }

    for _, candidate in ConfiguredPullHotkeys {
        if candidate == config {
            continue
        }

        if candidate.Has("hotkey") && NormalizeSimpleHotkeyForComparison(candidate["hotkey"]) = fallbackHotkey {
            return candidate
        }
    }

    return 0
}

MonitorConfiguredPullHotkey(stateKey, config) {
    global ConfiguredPullHotkeyState
    global ConfiguredPullHoldDelayMs
    global ConfiguredPullHoldTileEnabled
    global ConfiguredPullHoldMode

    if !ConfiguredPullHotkeyState.Has(stateKey) {
        return
    }

    state := ConfiguredPullHotkeyState[stateKey]

    if !IsConfiguredPullHotkeyStillPressed(config) {
        CompleteConfiguredPullHotkeyState(config, stateKey)
        return
    }

    if state["holdTriggered"] {
        if state.Has("holdAction") && state["holdAction"] = "radial" {
            UpdateConfiguredPullRadialSelection()
        }
        return
    }

    if (A_TickCount - state["startTick"]) < ConfiguredPullHoldDelayMs {
        return
    }

    if !ConfiguredPullHoldTileEnabled {
        return
    }

    holdMode := SanitizeWindowWarpHoldMode(ConfiguredPullHoldMode)
    state["holdTriggered"] := true
    state["holdAction"] := holdMode
    ConfiguredPullHotkeyState[stateKey] := state

    if holdMode = "radial" && ShowConfiguredPullRadialMenu(config, state["mouseX"], state["mouseY"]) {
        UpdateConfiguredPullRadialSelection()
        return
    }

    state["holdAction"] := "tile"
    ConfiguredPullHotkeyState[stateKey] := state
    PullConfiguredWindow(config, true, state["mouseX"], state["mouseY"])
}

CompleteConfiguredPullHotkeyState(config, stateKey) {
    global ConfiguredPullHotkeyState

    if !ConfiguredPullHotkeyState.Has(stateKey) {
        return false
    }

    state := ConfiguredPullHotkeyState[stateKey]
    SetTimer(state["timer"], 0)
    ConfiguredPullHotkeyState.Delete(stateKey)

    if state["holdTriggered"] && state.Has("holdAction") && state["holdAction"] = "radial" {
        FinalizeConfiguredPullRadialSelection(config)
    } else if !state["holdTriggered"] {
        PullConfiguredWindow(config)
    }

    return true
}

IsConfiguredPullHotkeyStillPressed(config) {
    if !(config.Has("hotkey")) {
        return true
    }

    parsed := ParseSimpleHotkey(config["hotkey"])
    if !parsed {
        return true
    }

    try {
        if !GetKeyState(parsed["key"], "P") {
            return false
        }
    } catch {
        return true
    }

    modifiers := parsed["modifiers"]
    for _, modifier in ["#", "^", "!", "+"] {
        if InStr(modifiers, modifier) && !IsHotkeyModifierPressed(modifier) {
            return false
        }
    }

    return true
}

ShowConfiguredPullRadialMenu(config, mouseX, mouseY) {
    global ConfiguredPullRadialState

    candidates := GetConfiguredWindowCandidates(config)
    if candidates.Length = 0 {
        CloseConfiguredPullRadialMenu()
        return false
    }

    CloseConfiguredPullRadialMenu()

    uiTheme := GetUiTheme()
    slotCount := Min(candidates.Length, 8)
    ringRadius := slotCount <= 4 ? 64 : 84
    slotWidth := 104
    slotHeight := 42
    guiSize := 260
    centerOffset := Floor(guiSize / 2)

    workArea := GetWorkAreaForPoint(mouseX, mouseY)
    minX := workArea["left"]
    maxX := workArea["right"] - guiSize
    minY := workArea["top"]
    maxY := workArea["bottom"] - guiSize
    showX := Clamp(mouseX - centerOffset, minX, Max(minX, maxX))
    showY := Clamp(mouseY - centerOffset, minY, Max(minY, maxY))

    radialGui := Gui("-Caption +ToolWindow +AlwaysOnTop +Border", "Hold Menu")
    radialGui.MarginX := 0
    radialGui.MarginY := 0
    radialGui.BackColor := uiTheme["surface"]
    radialGui.SetFont("s9", "Segoe UI")
    radialGui.OnEvent("Close", (*) => CloseConfiguredPullRadialMenu())
    radialGui.OnEvent("Escape", (*) => CloseConfiguredPullRadialMenu())

    radialGui.AddText(Format("x0 y0 w{} h{} Background{}", guiSize, guiSize, uiTheme["surface"]), "")

    slotControls := []
    Loop slotCount {
        index := A_Index
        angleDeg := -90 + ((index - 1) * (360 / slotCount))
        angleRad := angleDeg * 0.0174532925199433
        slotX := Round(centerOffset + (ringRadius * Cos(angleRad)) - (slotWidth / 2))
        slotY := Round(centerOffset + (ringRadius * Sin(angleRad)) - (slotHeight / 2))
        fill := radialGui.AddText(Format("x{} y{} w{} h{} Center Background{} c{}", slotX, slotY, slotWidth, slotHeight, uiTheme["sharedFill"], uiTheme["text"]), "")
        fill.Opt("+Border")
        text := radialGui.AddText(Format("x{} y{} w{} h{} Center c{} BackgroundTrans", slotX + 8, slotY + 6, slotWidth - 16, slotHeight - 12, uiTheme["text"]), GetConfiguredWindowCandidateDisplayLabel(candidates[index], index))
        slotControls.Push(Map(
            "fill", fill,
            "text", text
        ))
    }

    radialGui.Show(Format("NA x{} y{} w{} h{}", showX, showY, guiSize, guiSize))

    ConfiguredPullRadialState := Map(
        "gui", radialGui,
        "guiHwnd", radialGui.Hwnd,
        "candidates", candidates,
        "slotControls", slotControls,
        "slotCount", slotCount,
        "selectedIndex", 0,
        "showX", showX,
        "showY", showY,
        "size", guiSize,
        "centerX", showX + centerOffset,
        "centerY", showY + centerOffset,
        "deadzoneRadius", 10,
        "uiTheme", uiTheme,
        "config", config
    )

    return true
}

CloseConfiguredPullRadialMenu() {
    global ConfiguredPullRadialState

    if ConfiguredPullRadialState.Count && ConfiguredPullRadialState.Has("gui") && ConfiguredPullRadialState["gui"] {
        try ConfiguredPullRadialState["gui"].Destroy()
    }

    ConfiguredPullRadialState := Map()
}

UpdateConfiguredPullRadialSelection() {
    global ConfiguredPullRadialState

    if !ConfiguredPullRadialState.Count {
        return
    }

    MouseGetPos(&mouseX, &mouseY)
    dx := mouseX - ConfiguredPullRadialState["centerX"]
    dy := mouseY - ConfiguredPullRadialState["centerY"]
    distance := Sqrt((dx * dx) + (dy * dy))
    selectedIndex := 0

    if distance >= ConfiguredPullRadialState["deadzoneRadius"] {
        step := 360 / ConfiguredPullRadialState["slotCount"]
        angle := GetConfiguredPullRadialAngle(dx, dy)
        selectedIndex := Floor(Mod(angle + (step / 2), 360) / step) + 1
    }

    if selectedIndex = ConfiguredPullRadialState["selectedIndex"] {
        return
    }

    ConfiguredPullRadialState["selectedIndex"] := selectedIndex
    ApplyConfiguredPullRadialSelectionStyles()
}

ApplyConfiguredPullRadialSelectionStyles() {
    global ConfiguredPullRadialState

    if !ConfiguredPullRadialState.Count {
        return
    }

    uiTheme := ConfiguredPullRadialState["uiTheme"]
    selectedIndex := ConfiguredPullRadialState["selectedIndex"]
    slotControls := ConfiguredPullRadialState["slotControls"]

    for index, controls in slotControls {
        isSelected := index = selectedIndex
        fillColor := isSelected ? uiTheme["appBorder"] : uiTheme["sharedFill"]
        textColor := isSelected ? uiTheme["title"] : uiTheme["text"]
        controls["fill"].Opt("+Background" . fillColor)
        controls["text"].Opt("c" . textColor)
    }
}

FinalizeConfiguredPullRadialSelection(config) {
    global ConfiguredPullRadialState

    if !ConfiguredPullRadialState.Count {
        return
    }

    selectedIndex := ConfiguredPullRadialState["selectedIndex"]
    candidates := ConfiguredPullRadialState["candidates"]
    CloseConfiguredPullRadialMenu()

    if selectedIndex < 1 || selectedIndex > candidates.Length {
        return
    }

    PullConfiguredWindowByHwnd(config, candidates[selectedIndex]["hwnd"])
}

GetConfiguredWindowCandidates(config) {
    candidates := []
    hwnds := FindConfiguredWindows(config["match"])
    appLabel := GetConfiguredAppLabel(config)

    for _, hwnd in hwnds {
        if !WinExist("ahk_id " hwnd) {
            continue
        }

        try title := Trim(WinGetTitle("ahk_id " hwnd))
        catch
            title := ""

        baseLabel := title != "" ? title : appLabel

        candidates.Push(Map(
            "hwnd", hwnd,
            "title", title,
            "label", baseLabel,
            "sortKey", StrLower(baseLabel),
            "displayLabel", ""
        ))
    }

    SortConfiguredWindowCandidates(&candidates)

    titleCounts := Map()
    for _, candidate in candidates {
        label := candidate["label"]
        if titleCounts.Has(label) {
            titleCounts[label] := titleCounts[label] + 1
            candidate["displayLabel"] := label . " (" . titleCounts[label] . ")"
        } else {
            titleCounts[label] := 1
            candidate["displayLabel"] := label
        }
    }

    while candidates.Length > 8 {
        candidates.Pop()
    }

    return candidates
}

GetConfiguredWindowCandidateDisplayLabel(candidate, index) {
    label := TrimConfiguredPullRadialText(candidate["displayLabel"], 30)
    return index . ". " . label
}

SortConfiguredWindowCandidates(&candidates) {
    if candidates.Length < 2 {
        return
    }

    Loop candidates.Length - 1 {
        outerIndex := A_Index
        Loop candidates.Length - outerIndex {
            leftIndex := A_Index
            rightIndex := leftIndex + 1
            leftCandidate := candidates[leftIndex]
            rightCandidate := candidates[rightIndex]
            if CompareConfiguredWindowCandidates(leftCandidate, rightCandidate) > 0 {
                candidates[leftIndex] := rightCandidate
                candidates[rightIndex] := leftCandidate
            }
        }
    }
}

CompareConfiguredWindowCandidates(leftCandidate, rightCandidate) {
    leftKey := leftCandidate["sortKey"]
    rightKey := rightCandidate["sortKey"]
    keyComparison := StrCompare(leftKey, rightKey, false)
    if keyComparison != 0 {
        return keyComparison
    }

    leftHwnd := leftCandidate["hwnd"] + 0
    rightHwnd := rightCandidate["hwnd"] + 0
    if leftHwnd < rightHwnd {
        return -1
    }
    if leftHwnd > rightHwnd {
        return 1
    }

    return 0
}

TrimConfiguredPullRadialText(text, maxLength) {
    text := Trim(RegExReplace(text, "\s+", " "))
    if StrLen(text) <= maxLength {
        return text
    }

    return RTrim(SubStr(text, 1, maxLength - 1)) . Chr(0x2026)
}

GetConfiguredPullRadialAngle(dx, dy) {
    angle := DllCall("msvcrt\atan2", "double", dy, "double", dx, "CDECL double")
    return Mod((angle * 57.29577951308232) + 450, 360)
}

GetWorkAreaForPoint(x, y) {
    monitors := GetOrderedMonitors()
    for _, monitor in monitors {
        if x >= monitor["workLeft"] && x <= monitor["workRight"] && y >= monitor["workTop"] && y <= monitor["workBottom"] {
            return Map(
                "left", monitor["workLeft"],
                "top", monitor["workTop"],
                "right", monitor["workRight"],
                "bottom", monitor["workBottom"]
            )
        }
    }

    primary := GetMonitorByIndex(MonitorGetPrimary())
    return Map(
        "left", primary["workLeft"],
        "top", primary["workTop"],
        "right", primary["workRight"],
        "bottom", primary["workBottom"]
    )
}

GetConfiguredPullStateKey(config) {
    return config.Has("hotkey") ? config["hotkey"] : config["match"]
}

PullConfiguredWindow(config, tileOnPullToMain := false, mouseX := "", mouseY := "", *) {
    hwnd := FindConfiguredWindow(config["match"])
    if !hwnd {
        return
    }

    PullConfiguredWindowByHwnd(config, hwnd, tileOnPullToMain, mouseX, mouseY)
}

PullConfiguredWindowByHwnd(config, hwnd, tileOnPullToMain := false, mouseX := "", mouseY := "") {
    global ConfiguredAppPreviousWindow

    if !WinExist("ahk_id " hwnd) {
        return
    }

    if WinGetMinMax("ahk_id " hwnd) = -1 {
        WinRestore("ahk_id " hwnd)
    }

    source := GetWindowPlacementInfo(hwnd)
    primary := GetMonitorByIndex(MonitorGetPrimary())
    burner := GetConfiguredBurnerMonitor(primary["index"])
    if !source || !primary {
        return
    }

    if tileOnPullToMain {
        if !WinActive("ahk_id " hwnd) {
            StoreConfiguredPreviousWindow(config, WinExist("A"), hwnd)
        }

        WinActivate("ahk_id " hwnd)
        ApplyTilePullToMain(hwnd, source, primary, mouseX, mouseY)
        return
    }

    wasActive := WinActive("ahk_id " hwnd)
    if !wasActive {
        StoreConfiguredPreviousWindow(config, WinExist("A"), hwnd)
    }

    if source["monitorIndex"] = primary["index"] {
        WinActivate("ahk_id " hwnd)

        if wasActive {
            if GetMainMonitorAction(config) = "focus-last" {
                if FocusConfiguredPreviousWindow(config) {
                    return
                }
            } else if burner {
                ApplyBurnerLayout(hwnd, source, burner, GetBurnerLayout(config))
                return
            }

            return
        }

        CenterMouseOnMonitor(primary["index"])
        return
    }

    WinActivate("ahk_id " hwnd)
    ApplyRelativePlacement(hwnd, source, primary)

    CenterMouseOnMonitor(primary["index"])
}

ApplyTilePullToMain(hwnd, source, primary, mouseX, mouseY) {
    direction := GetMouseDrivenTileDirection(primary, mouseX, mouseY)

    ApplyTileOnMonitor(hwnd, primary, direction)
}

MoveWindowDirection(direction, centerMouse) {
    global MoveHistory

    hwnd := WinExist("A")
    if !hwnd {
        return
    }

    if WinGetMinMax("ahk_id " hwnd) = -1 {
        WinRestore("ahk_id " hwnd)
    }

    source := GetWindowPlacementInfo(hwnd)
    if !source {
        return
    }

    target := GetAdjacentMonitor(source["monitorIndex"], direction)
    if !target {
        return
    }

    MoveHistory.Push(Map(
        "hwnd", hwnd,
        "state", source["state"],
        "x", source["x"],
        "y", source["y"],
        "w", source["w"],
        "h", source["h"]
    ))

    ApplyRelativePlacement(hwnd, source, target)
    RememberLastPushAction(hwnd)
    EnableRetileHotkeys()

    if centerMouse {
        CenterMouseOnMonitor(target["index"])
    }
}

OpenWindowWarpSettings() {
    global ConfiguredPullBuilderState
    global WindowWarpSettings

    if !ConfiguredPullBuilderState.Count {
        return
    }

    if ConfiguredPullBuilderState.Has("settingsGui") && ConfiguredPullBuilderState["settingsGui"] {
        try WinActivate("ahk_id " ConfiguredPullBuilderState["settingsGuiHwnd"])
        return
    }

    uiTheme := GetUiTheme()
    ownerHwnd := 0
    if ConfiguredPullBuilderState.Has("keyboardGuiHwnd") && ConfiguredPullBuilderState["keyboardGuiHwnd"] {
        ownerHwnd := ConfiguredPullBuilderState["keyboardGuiHwnd"]
    } else if ConfiguredPullBuilderState.Has("guiHwnd") && ConfiguredPullBuilderState["guiHwnd"] {
        ownerHwnd := ConfiguredPullBuilderState["guiHwnd"]
    }

    options := "-Caption +Border +ToolWindow +AlwaysOnTop"
    if ownerHwnd {
        options .= " +Owner" . ownerHwnd
    }

    settingsGui := Gui(options, "Settings")
    settingsGui.SetFont("s10", "Segoe UI")
    settingsGui.BackColor := uiTheme["surface"]
    settingsGui.MarginX := 0
    settingsGui.MarginY := 0
    settingsGui.OnEvent("Close", (*) => CloseWindowWarpSettings())
    settingsGui.OnEvent("Escape", (*) => CloseWindowWarpSettings())

    headerBar := settingsGui.AddText("x0 y0 w420 h38 Background" . uiTheme["header"], "")
    headerBar.OnEvent("Click", (*) => StartGuiDrag(settingsGui))
    settingsGui.SetFont("s11", "Segoe UI Semibold")
    headerTitle := settingsGui.AddText("x14 y9 w340 c" . uiTheme["headerText"], "Settings")
    headerTitle.OnEvent("Click", (*) => StartGuiDrag(settingsGui))
    closeButton := settingsGui.AddText("x426 y5 w24 h26 Center c" . uiTheme["headerText"] . " Background" . uiTheme["closeFill"] . " +0x200 Border", "X")
    closeButton.OnEvent("Click", (*) => CloseWindowWarpSettings())

    settingsGui.SetFont("s9", "Segoe UI")
    settingsGui.AddText("x18 y58 w396 h34 c" . uiTheme["muted"], "Choose what hold does, tune the delay, and decide whether Windows Warp starts with Windows.")

    holdTileCheckbox := settingsGui.AddCheckBox("x18 y106 w18 h18", "")
    holdTileCheckbox.Value := WindowWarpSettings["holdTileEnabled"] ? 1 : 0
    holdTileLabel := settingsGui.AddText("x46 y106 w280 c" . uiTheme["text"], "Enable hold action")
    holdTileLabel.OnEvent("Click", (*) => ToggleSettingsCheckbox("holdTileCheckbox"))

    settingsGui.AddText("x18 y144 w220 c" . uiTheme["text"], "Hold action")
    tileModeRadio := settingsGui.AddRadio(Format("x18 y168 w160 h22 c{}", uiTheme["text"]), "Tile under mouse")
    radialModeRadio := settingsGui.AddRadio(Format("x18 y194 w220 h22 c{}", uiTheme["text"]), "Radial app picker")
    if WindowWarpSettings["holdMode"] = "radial" {
        radialModeRadio.Value := 1
    } else {
        tileModeRadio.Value := 1
    }

    settingsGui.AddText("x18 y234 w220 c" . uiTheme["text"], "Hold delay (milliseconds)")
    holdDelayEdit := settingsGui.AddEdit("x18 y258 w120 h26 Number")
    holdDelayEdit.Value := WindowWarpSettings["holdDelayMs"]

    startupCheckbox := settingsGui.AddCheckBox("x18 y304 w18 h18", "")
    startupCheckbox.Value := IsWindowsWarpStartupEnabled() ? 1 : 0
    startupLabel := settingsGui.AddText("x46 y304 w280 c" . uiTheme["text"], "Start Windows Warp with Windows")
    startupLabel.OnEvent("Click", (*) => ToggleSettingsCheckbox("startupCheckbox"))

    applyButton := settingsGui.AddButton("x18 y352 w96 h30 Default", "Apply")
    cancelButton := settingsGui.AddButton("x126 y352 w96 h30", "Cancel")
    applyButton.OnEvent("Click", (*) => SaveWindowWarpSettingsFromGui())
    cancelButton.OnEvent("Click", (*) => CloseWindowWarpSettings())

    ConfiguredPullBuilderState["settingsGui"] := settingsGui
    ConfiguredPullBuilderState["settingsGuiHwnd"] := settingsGui.Hwnd
    ConfiguredPullBuilderState["settingsHoldTileCheckbox"] := holdTileCheckbox
    ConfiguredPullBuilderState["settingsHoldModeTileRadio"] := tileModeRadio
    ConfiguredPullBuilderState["settingsHoldModeRadialRadio"] := radialModeRadio
    ConfiguredPullBuilderState["settingsHoldDelayEdit"] := holdDelayEdit
    ConfiguredPullBuilderState["settingsStartupCheckbox"] := startupCheckbox

    if ownerHwnd {
        WinGetPos(&ownerX, &ownerY, &ownerW, &ownerH, "ahk_id " ownerHwnd)
        settingsX := ownerX + Floor((ownerW - 452) / 2)
        settingsY := ownerY + Floor((ownerH - 406) / 2)
        settingsGui.Show(Format("x{} y{} w452 h406", settingsX, settingsY))
    } else {
        settingsGui.Show("w452 h406 Center")
    }

    holdTileCheckbox.Focus()
}

ToggleSettingsCheckbox(key) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count || !ConfiguredPullBuilderState.Has(key) {
        return
    }

    checkbox := ConfiguredPullBuilderState[key]
    checkbox.Value := checkbox.Value ? 0 : 1
}

SaveWindowWarpSettingsFromGui() {
    global ConfiguredPullBuilderState
    global WindowWarpSettings
    global ConfiguredPullHoldDelayMs
    global ConfiguredPullHoldTileEnabled
    global ConfiguredPullHoldMode

    if !ConfiguredPullBuilderState.Count || !ConfiguredPullBuilderState.Has("settingsGui") {
        return
    }

    holdDelayValue := Trim(ConfiguredPullBuilderState["settingsHoldDelayEdit"].Value)
    if holdDelayValue = "" || !RegExMatch(holdDelayValue, "^\d+$") {
        ShowThemedMessageDialog("Settings", "Enter a valid hold delay in milliseconds.")
        return
    }

    settings := Map(
        "holdDelayMs", SanitizeWindowWarpHoldDelay(holdDelayValue + 0),
        "holdTileEnabled", ConfiguredPullBuilderState["settingsHoldTileCheckbox"].Value = 1,
        "holdMode", ConfiguredPullBuilderState["settingsHoldModeRadialRadio"].Value = 1 ? "radial" : "tile"
    )

    SaveWindowWarpSettings(settings)
    WindowWarpSettings := settings
    ConfiguredPullHoldDelayMs := settings["holdDelayMs"]
    ConfiguredPullHoldTileEnabled := settings["holdTileEnabled"]
    ConfiguredPullHoldMode := settings["holdMode"]

    try {
        SetWindowsWarpStartupEnabled(ConfiguredPullBuilderState["settingsStartupCheckbox"].Value = 1)
    } catch {
        ShowThemedMessageDialog("Settings", "Windows Warp couldn't update the Startup shortcut.")
        return
    }

    CloseWindowWarpSettings()
}

