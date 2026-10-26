LoadWorkspaceOpenerProfiles() {
    global WorkspaceOpenerConfigPath

    profiles := []
    if !FileExist(WorkspaceOpenerConfigPath) {
        return profiles
    }

    count := IniRead(WorkspaceOpenerConfigPath, "Meta", "count", "0") + 0
    Loop count {
        profileSection := "Profile" . A_Index
        profileId := IniRead(WorkspaceOpenerConfigPath, profileSection, "id", "")
        name := IniRead(WorkspaceOpenerConfigPath, profileSection, "name", "")
        itemCount := IniRead(WorkspaceOpenerConfigPath, profileSection, "itemCount", "0") + 0
        if name = "" {
            continue
        }

        items := []
        Loop itemCount {
            itemSection := profileSection . "Item" . A_Index
            processName := IniRead(WorkspaceOpenerConfigPath, itemSection, "processName", "")
            path := IniRead(WorkspaceOpenerConfigPath, itemSection, "path", "")
            title := IniRead(WorkspaceOpenerConfigPath, itemSection, "title", "")
            label := IniRead(WorkspaceOpenerConfigPath, itemSection, "label", "")
            terminalCommand := IniRead(WorkspaceOpenerConfigPath, itemSection, "terminalCommand", "")
            terminalShell := IniRead(WorkspaceOpenerConfigPath, itemSection, "terminalShell", "")
            launchKind := IniRead(WorkspaceOpenerConfigPath, itemSection, "launchKind", "")
            shellKind := IniRead(WorkspaceOpenerConfigPath, itemSection, "shellKind", "")
            wslDistro := IniRead(WorkspaceOpenerConfigPath, itemSection, "wslDistro", "")
            profileName := IniRead(WorkspaceOpenerConfigPath, itemSection, "profileName", "")
            promptIdentity := IniRead(WorkspaceOpenerConfigPath, itemSection, "promptIdentity", "")
            browserKind := IniRead(WorkspaceOpenerConfigPath, itemSection, "browserKind", "")
            browserProfilePath := IniRead(WorkspaceOpenerConfigPath, itemSection, "browserProfilePath", "")
            browserProfileName := IniRead(WorkspaceOpenerConfigPath, itemSection, "browserProfileName", "")
            browserActiveTab := IniRead(WorkspaceOpenerConfigPath, itemSection, "browserActiveTab", "1") + 0
            x := IniRead(WorkspaceOpenerConfigPath, itemSection, "x", "")
            y := IniRead(WorkspaceOpenerConfigPath, itemSection, "y", "")
            w := IniRead(WorkspaceOpenerConfigPath, itemSection, "w", "")
            h := IniRead(WorkspaceOpenerConfigPath, itemSection, "h", "")
            state := IniRead(WorkspaceOpenerConfigPath, itemSection, "state", "0") + 0
            monitorIndex := IniRead(WorkspaceOpenerConfigPath, itemSection, "monitorIndex", "1") + 0
            browserUrlCount := IniRead(WorkspaceOpenerConfigPath, itemSection, "browserUrlCount", "0") + 0
            if processName = "" || x = "" || y = "" || w = "" || h = "" {
                continue
            }

            browserUrls := []
            Loop browserUrlCount {
                url := IniRead(WorkspaceOpenerConfigPath, itemSection, "browserUrl" . A_Index, "")
                if url != "" {
                    browserUrls.Push(url)
                }
            }

            items.Push(Map(
                "processName", processName,
                "path", path,
                "title", title,
                "label", label != "" ? label : title,
                "launchKind", launchKind,
                "shellKind", shellKind != "" ? shellKind : terminalShell,
                "wslDistro", wslDistro,
                "profileName", profileName,
                "promptIdentity", promptIdentity,
                "browserKind", browserKind,
                "browserProfilePath", browserProfilePath,
                "browserProfileName", browserProfileName,
                "browserActiveTab", browserActiveTab,
                "browserUrls", browserUrls,
                "x", x + 0,
                "y", y + 0,
                "w", w + 0,
                "h", h + 0,
                "state", state,
                "monitorIndex", monitorIndex
            ))

            item := items[items.Length]
            MigrateWorkspaceOpenerItem(item, terminalCommand)
        }

        profiles.Push(Map(
            "id", profileId != "" ? profileId : "workspace-" . A_Index,
            "name", name,
            "items", items
        ))
    }

    return profiles
}

SaveWorkspaceOpenerProfiles(profiles) {
    global WorkspaceOpenerConfigPath

    if FileExist(WorkspaceOpenerConfigPath) {
        FileDelete(WorkspaceOpenerConfigPath)
    }

    IniWrite(profiles.Length, WorkspaceOpenerConfigPath, "Meta", "count")
    for profileIndex, profile in profiles {
        profileSection := "Profile" . profileIndex
        IniWrite(profile.Has("id") ? profile["id"] : "workspace-" . profileIndex, WorkspaceOpenerConfigPath, profileSection, "id")
        IniWrite(profile["name"], WorkspaceOpenerConfigPath, profileSection, "name")
        IniWrite(profile["items"].Length, WorkspaceOpenerConfigPath, profileSection, "itemCount")

        for itemIndex, item in profile["items"] {
            itemSection := profileSection . "Item" . itemIndex
            IniWrite(item["processName"], WorkspaceOpenerConfigPath, itemSection, "processName")
            IniWrite(item.Has("path") ? item["path"] : "", WorkspaceOpenerConfigPath, itemSection, "path")
            IniWrite(item.Has("title") ? item["title"] : "", WorkspaceOpenerConfigPath, itemSection, "title")
            IniWrite(item.Has("label") ? item["label"] : "", WorkspaceOpenerConfigPath, itemSection, "label")
            IniWrite("", WorkspaceOpenerConfigPath, itemSection, "terminalCommand")
            IniWrite(item.Has("shellKind") ? item["shellKind"] : "", WorkspaceOpenerConfigPath, itemSection, "terminalShell")
            IniWrite(item.Has("launchKind") ? item["launchKind"] : "", WorkspaceOpenerConfigPath, itemSection, "launchKind")
            IniWrite(item.Has("shellKind") ? item["shellKind"] : "", WorkspaceOpenerConfigPath, itemSection, "shellKind")
            IniWrite(item.Has("wslDistro") ? item["wslDistro"] : "", WorkspaceOpenerConfigPath, itemSection, "wslDistro")
            IniWrite(item.Has("profileName") ? item["profileName"] : "", WorkspaceOpenerConfigPath, itemSection, "profileName")
            IniWrite(item.Has("promptIdentity") ? item["promptIdentity"] : "", WorkspaceOpenerConfigPath, itemSection, "promptIdentity")
            IniWrite(item.Has("browserKind") ? item["browserKind"] : "", WorkspaceOpenerConfigPath, itemSection, "browserKind")
            IniWrite(item.Has("browserProfilePath") ? item["browserProfilePath"] : "", WorkspaceOpenerConfigPath, itemSection, "browserProfilePath")
            IniWrite(item.Has("browserProfileName") ? item["browserProfileName"] : "", WorkspaceOpenerConfigPath, itemSection, "browserProfileName")
            IniWrite(item.Has("browserActiveTab") ? item["browserActiveTab"] : 1, WorkspaceOpenerConfigPath, itemSection, "browserActiveTab")
            browserUrls := item.Has("browserUrls") ? item["browserUrls"] : []
            IniWrite(browserUrls.Length, WorkspaceOpenerConfigPath, itemSection, "browserUrlCount")
            for urlIndex, browserUrl in browserUrls {
                IniWrite(browserUrl, WorkspaceOpenerConfigPath, itemSection, "browserUrl" . urlIndex)
            }
            IniWrite(item["x"], WorkspaceOpenerConfigPath, itemSection, "x")
            IniWrite(item["y"], WorkspaceOpenerConfigPath, itemSection, "y")
            IniWrite(item["w"], WorkspaceOpenerConfigPath, itemSection, "w")
            IniWrite(item["h"], WorkspaceOpenerConfigPath, itemSection, "h")
            IniWrite(item.Has("state") ? item["state"] : 0, WorkspaceOpenerConfigPath, itemSection, "state")
            IniWrite(item.Has("monitorIndex") ? item["monitorIndex"] : 1, WorkspaceOpenerConfigPath, itemSection, "monitorIndex")
        }
    }
}

MigrateWorkspaceOpenerItem(item, legacyTerminalCommand := "") {
    processName := StrLower(item.Has("processName") ? item["processName"] : "")
    path := item.Has("path") ? item["path"] : ""

    if !item.Has("launchKind") || item["launchKind"] = "" {
        if processName = "windowsterminal.exe" {
            item["launchKind"] := "windows-terminal"
        } else if path != "" && IsPackagedAppPath(path) {
            item["launchKind"] := "packaged-app"
        } else if path != "" {
            item["launchKind"] := "app-path"
        }
    }

    if processName = "windowsterminal.exe" {
        if legacyTerminalCommand != "" {
            ApplyLegacyTerminalCommandToItem(item, legacyTerminalCommand)
        }
        NormalizeTerminalLaunchItem(item)
    } else if processName = "firefox.exe" {
        NormalizeFirefoxLaunchItem(item)
    }
}

NormalizeFirefoxLaunchItem(item) {
    item["launchKind"] := "firefox-window"
    item["browserKind"] := "firefox"
    if !item.Has("browserActiveTab") || item["browserActiveTab"] < 1 {
        item["browserActiveTab"] := 1
    }
    if !item.Has("browserUrls") {
        item["browserUrls"] := []
    }
}

ApplyLegacyTerminalCommandToItem(item, legacyTerminalCommand) {
    command := Trim(legacyTerminalCommand)
    lowerCommand := StrLower(command)
    if command = "" {
        return
    }

    if RegExMatch(command, 'i)wsl\.exe\s+-d\s+"([^"]+)"', &match) {
        item["shellKind"] := "wsl"
        item["wslDistro"] := match[1]
        return
    }
    if lowerCommand = "wsl.exe" {
        item["shellKind"] := "wsl"
        return
    }
    if InStr(lowerCommand, "powershell.exe") {
        item["shellKind"] := "powershell"
        return
    }
    if InStr(lowerCommand, "pwsh.exe") {
        item["shellKind"] := "pwsh"
        return
    }
    if InStr(lowerCommand, "cmd.exe") {
        item["shellKind"] := "cmd"
        return
    }
}

NormalizeTerminalLaunchItem(item) {
    item["launchKind"] := "windows-terminal"

    if item.Has("shellKind") {
        shellKind := StrLower(Trim(item["shellKind"]))
        item["shellKind"] := shellKind
    } else {
        shellKind := ""
    }

    if (!item.Has("shellKind") || item["shellKind"] = "") && item.Has("title") {
        shellSpec := InferWindowsTerminalShellSpec(item["title"])
        if shellSpec {
            item["shellKind"] := GetTerminalShellKind(shellSpec["shell"])
            if shellSpec.Has("distro") && shellSpec["distro"] != "" {
                item["wslDistro"] := shellSpec["distro"]
            }
            if shellSpec.Has("profileName") && shellSpec["profileName"] != "" {
                item["profileName"] := shellSpec["profileName"]
            }
            if shellSpec.Has("promptIdentity") && shellSpec["promptIdentity"] != "" {
                item["promptIdentity"] := shellSpec["promptIdentity"]
            }
        }
    }

    if (!item.Has("profileName") || item["profileName"] = "") && item.Has("title") {
        profileName := GetWindowsTerminalProfileName(item["title"])
        if profileName != "" {
            item["profileName"] := profileName
        }
    }
}

EnsureWorkspaceOpenerState() {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        ConfiguredPullBuilderState := Map()
    }

    defaults := Map(
        "uiTheme", GetUiTheme(),
        "openerGui", 0,
        "openerGuiHwnd", 0,
        "settingsGui", 0,
        "settingsGuiHwnd", 0,
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
        "openerDynamicControls", [],
        "openerCardControls", []
    )

    for key, value in defaults {
        if !ConfiguredPullBuilderState.Has(key) {
            ConfiguredPullBuilderState[key] := value
        }
    }
}

OpenWorkspaceOpenerBrowser(initialPage := 1, showOptions := "w760 h640") {
    global ConfiguredPullBuilderState

    EnsureWorkspaceOpenerState()

    CloseWorkspaceOpenerBrowser()
    uiTheme := GetUiTheme()
    ConfiguredPullBuilderState["uiTheme"] := uiTheme
    openerGui := Gui("-Caption +Border +AlwaysOnTop +ToolWindow", "Workspace Openers")
    openerGui.SetFont("s9", "Segoe UI")
    openerGui.BackColor := uiTheme["surface"]
    openerGui.MarginX := 0
    openerGui.MarginY := 0
    openerGui.OnEvent("Close", (*) => CloseWorkspaceOpenerBrowser())
    openerGui.OnEvent("Escape", (*) => CloseWorkspaceOpenerBrowser())

    headerBar := openerGui.AddText("x0 y0 w716 h38 Background" . uiTheme["header"], "")
    headerBar.OnEvent("Click", (*) => StartGuiDrag(openerGui))
    openerGui.SetFont("s11", "Segoe UI Semibold")
    headerTitle := openerGui.AddText("x14 y9 w620 c" . uiTheme["headerText"], "Workspace Openers")
    headerTitle.OnEvent("Click", (*) => StartGuiDrag(openerGui))
    closeButton := openerGui.AddText("x722 y5 w24 h26 Center c" . uiTheme["headerText"] . " Background" . uiTheme["closeFill"] . " +0x200 Border", "X")
    closeButton.OnEvent("Click", (*) => CloseWorkspaceOpenerBrowser())

    openerGui.SetFont("s9", "Segoe UI")
    openerGui.AddText("x18 y58 w700 h34 c" . uiTheme["muted"], "Capture your current desktop layout, then relaunch those apps and window positions later.")

    newButton := openerGui.AddButton("x18 y104 w86 h30", "New")
    updateButton := openerGui.AddButton("x114 y104 w86 h30", "Update")
    launchButton := openerGui.AddButton("x210 y104 w86 h30", "Launch")
    renameButton := openerGui.AddButton("x306 y104 w86 h30", "Rename")
    deleteButton := openerGui.AddButton("x402 y104 w86 h30", "Delete")

    newButton.OnEvent("Click", (*) => OpenWorkspaceNewDialog())
    updateButton.OnEvent("Click", (*) => OpenWorkspaceUpdateDialog())
    launchButton.OnEvent("Click", (*) => LaunchSelectedWorkspaceOpener())
    renameButton.OnEvent("Click", (*) => RenameSelectedWorkspaceOpener())
    deleteButton.OnEvent("Click", (*) => DeleteSelectedWorkspaceOpener())

    detailsText := openerGui.AddText("x18 y532 w700 h62 c" . uiTheme["muted"], "Select a saved workspace to preview what it will open.")
    prevButton := openerGui.AddButton("x478 y602 w92 h28", "Previous")
    pageLabel := openerGui.AddText("x580 y607 w90 Center c" . uiTheme["muted"], "Page 1 of 1")
    nextButton := openerGui.AddButton("x676 y602 w66 h28", "Next")
    prevButton.OnEvent("Click", (*) => ChangeWorkspaceOpenerPage(-1))
    nextButton.OnEvent("Click", (*) => ChangeWorkspaceOpenerPage(1))

    ConfiguredPullBuilderState["openerGui"] := openerGui
    ConfiguredPullBuilderState["openerGuiHwnd"] := openerGui.Hwnd
    ConfiguredPullBuilderState["openerShowOptions"] := showOptions
    ConfiguredPullBuilderState["openerCloseButton"] := closeButton
    ConfiguredPullBuilderState["openerPageIndex"] := initialPage
    ConfiguredPullBuilderState["openerPageLabel"] := pageLabel
    ConfiguredPullBuilderState["openerPrevButton"] := prevButton
    ConfiguredPullBuilderState["openerNextButton"] := nextButton
    ConfiguredPullBuilderState["openerDetailsText"] := detailsText
    ConfiguredPullBuilderState["openerNewButton"] := newButton
    ConfiguredPullBuilderState["openerUpdateButton"] := updateButton
    ConfiguredPullBuilderState["openerLaunchButton"] := launchButton
    ConfiguredPullBuilderState["openerRenameButton"] := renameButton
    ConfiguredPullBuilderState["openerDeleteButton"] := deleteButton

    ConfiguredPullBuilderState["openerShowOptions"] := "w760 h640"
    openerGui.Show("Hide " . showOptions)
    RenderWorkspaceOpenerBrowser()
    openerGui.Show(showOptions)
}

CloseWorkspaceOpenerBrowser() {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    if ConfiguredPullBuilderState.Has("openerGui") && ConfiguredPullBuilderState["openerGui"] {
        try ConfiguredPullBuilderState["openerGui"].Destroy()
        ConfiguredPullBuilderState["openerGui"] := 0
        ConfiguredPullBuilderState["openerGuiHwnd"] := 0
        ConfiguredPullBuilderState["openerShowOptions"] := ""
        ConfiguredPullBuilderState["openerPageLabel"] := 0
        ConfiguredPullBuilderState["openerPrevButton"] := 0
        ConfiguredPullBuilderState["openerNextButton"] := 0
        ConfiguredPullBuilderState["openerDetailsText"] := 0
        ConfiguredPullBuilderState["openerCloseButton"] := 0
        ConfiguredPullBuilderState["openerNewButton"] := 0
        ConfiguredPullBuilderState["openerUpdateButton"] := 0
        ConfiguredPullBuilderState["openerLaunchButton"] := 0
        ConfiguredPullBuilderState["openerRenameButton"] := 0
        ConfiguredPullBuilderState["openerDeleteButton"] := 0
        ConfiguredPullBuilderState["openerDynamicControls"] := []
        ConfiguredPullBuilderState["openerCardControls"] := []
    }
}

RenderWorkspaceOpenerBrowser() {
    global ConfiguredPullBuilderState
    global WorkspaceOpenerProfiles

    if !ConfiguredPullBuilderState.Count || !ConfiguredPullBuilderState["openerGui"] {
        return
    }

    openerGui := ConfiguredPullBuilderState["openerGui"]
    openerGui.SetFont("s10", "Segoe UI Semibold")
    cardsPerPage := 6
    start := ((ConfiguredPullBuilderState["openerPageIndex"] - 1) * cardsPerPage) + 1
    pageProfiles := []
    index := start
    while index <= WorkspaceOpenerProfiles.Length && pageProfiles.Length < cardsPerPage {
        pageProfiles.Push(WorkspaceOpenerProfiles[index])
        index += 1
    }

    ; clear old dynamic controls by recreating the window page in place
    if ConfiguredPullBuilderState.Has("openerDynamicControls") {
        for _, ctrl in ConfiguredPullBuilderState["openerDynamicControls"] {
            try ctrl.Destroy()
        }
    }
    dynamicControls := []
    cardControls := []
    cardWidth := 208
    cardHeight := 104
    startX := 18
    startY := 152
    colGap := 16
    rowGap := 16
    cols := 3
    uiTheme := ConfiguredPullBuilderState["uiTheme"]
    viewportClear := openerGui.AddText("x18 y152 w700 h348 Background" . uiTheme["surface"], "")
    dynamicControls.Push(viewportClear)

    for profileIndex, profile in pageProfiles {
        col := Mod(profileIndex - 1, cols)
        row := Floor((profileIndex - 1) / cols)
        x := startX + (col * (cardWidth + colGap))
        y := startY + (row * (cardHeight + rowGap))
        buttonText := GetWorkspaceOpenerCardText(profile)
        cardButton := openerGui.AddButton(Format("x{} y{} w{} h{} +0x2000", x, y, cardWidth, cardHeight), buttonText)
        cardButton.OnEvent("Click", HandleWorkspaceOpenerCardClick.Bind(profile["id"]))
        dynamicControls.Push(cardButton)
        cardControls.Push(Map(
            "profileId", profile["id"],
            "button", cardButton
        ))
    }

    if pageProfiles.Length = 0 {
        emptyText := openerGui.AddText("x18 y202 w700 h60 Center c" . uiTheme["muted"], "No saved workspaces yet. Capture your current desktop to create one.")
        dynamicControls.Push(emptyText)
    }

    ConfiguredPullBuilderState["openerDynamicControls"] := dynamicControls
    ConfiguredPullBuilderState["openerCardControls"] := cardControls
    UpdateWorkspaceOpenerPagination()
    UpdateWorkspaceOpenerSelectionVisuals()
    UpdateWorkspaceOpenerDetails()
}

GetWorkspaceOpenerSummary(profile) {
    items := profile["items"]
    if items.Length = 0 {
        return "Empty workspace"
    }

    summary := ""
    shown := 0
    for _, item in items {
        label := TrimWorkspaceOpenerLabel(GetSanitizedWorkspaceOpenerLabel(item), 26)
        summary .= (summary = "" ? "" : "`n") . label
        shown += 1
        if shown = 3 {
            break
        }
    }

    if items.Length > shown {
        summary .= "`n+" . (items.Length - shown) . " more"
    }

    return summary
}

GetWorkspaceOpenerCardText(profile) {
    title := TrimWorkspaceOpenerLabel(profile["name"], 20)
    subtitle := GetWorkspaceOpenerCardSubtitle(profile)
    return title . "`n`n" . subtitle
}

GetWorkspaceOpenerCardSubtitle(profile) {
    items := profile["items"]
    if items.Length = 0 {
        return "No apps saved"
    }

    preview := []
    shown := 0
    for _, item in items {
        preview.Push(TrimWorkspaceOpenerLabel(GetSanitizedWorkspaceOpenerLabel(item), 14))
        shown += 1
        if shown = 2 {
            break
        }
    }

    subtitle := JoinTextParts(preview, ", ")
    if items.Length > shown {
        subtitle .= " +" . (items.Length - shown)
    }

    return subtitle
}

JoinTextParts(parts, separator := ", ") {
    text := ""
    for _, part in parts {
        text .= (text = "" ? "" : separator) . part
    }
    return text
}

GetSanitizedWorkspaceOpenerLabel(item) {
    if item.Has("launchKind") && item["launchKind"] = "windows-terminal" {
        return GetWorkspaceOpenerTerminalLabel(item)
    }
    if item.Has("launchKind") && item["launchKind"] = "firefox-window" {
        return GetWorkspaceOpenerBrowserLabel(item)
    }

    label := item.Has("label") && item["label"] != "" ? item["label"] : item["processName"]
    processName := item.Has("processName") ? item["processName"] : label
    processLabel := RegExReplace(processName, "\.exe$", "")

    replacements := Map(
        "WindowsTerminal", "Windows Terminal",
        "Code", "VS Code"
    )
    if replacements.Has(processLabel) {
        processLabel := replacements[processLabel]
    }

    if item.Has("path") && item["path"] != "" {
        SplitPath(item["path"], &exeName)
        if exeName != "" {
            pathLabel := RegExReplace(exeName, "\.exe$", "")
            if replacements.Has(pathLabel) {
                pathLabel := replacements[pathLabel]
            }
            processLabel := pathLabel
        }
    }

    return processLabel
}

GetWorkspaceOpenerMeta(profile) {
    items := profile["items"]
    if items.Length = 0 {
        return "No apps saved"
    }

    monitors := Map()
    for _, item in items {
        monitors[item["monitorIndex"]] := true
    }

    monitorCount := monitors.Count
    return items.Length . " app" . (items.Length = 1 ? "" : "s") . " across " . monitorCount . " monitor" . (monitorCount = 1 ? "" : "s")
}

BuildWorkspaceAppCounts(items) {
    counts := Map()
    for _, item in items {
        processName := StrLower(item["processName"])
        counts[processName] := counts.Has(processName) ? counts[processName] + 1 : 1
    }
    return counts
}

GetWorkspaceOverlapScore(currentCounts, profile) {
    profileCounts := BuildWorkspaceAppCounts(profile["items"])
    score := 0
    for processName, currentCount in currentCounts {
        if profileCounts.Has(processName) {
            score += Min(currentCount, profileCounts[processName]) * 20
        }
    }
    return score
}

GetBestWorkspaceUpdateGuessId(currentItems) {
    global ConfiguredPullBuilderState
    global WorkspaceOpenerProfiles
    global LastLaunchedWorkspaceId
    global LastUpdatedWorkspaceId

    if WorkspaceOpenerProfiles.Length = 0 {
        return ""
    }

    currentCounts := BuildWorkspaceAppCounts(currentItems)
    selectedId := ConfiguredPullBuilderState.Count && ConfiguredPullBuilderState.Has("openerSelectedId")
        ? ConfiguredPullBuilderState["openerSelectedId"]
        : ""

    bestId := WorkspaceOpenerProfiles[1]["id"]
    bestScore := -1
    for _, profile in WorkspaceOpenerProfiles {
        score := GetWorkspaceOverlapScore(currentCounts, profile)
        if selectedId != "" && profile["id"] = selectedId {
            score += 100
        }
        if LastLaunchedWorkspaceId != "" && profile["id"] = LastLaunchedWorkspaceId {
            score += 80
        }
        if LastUpdatedWorkspaceId != "" && profile["id"] = LastUpdatedWorkspaceId {
            score += 60
        }

        if score > bestScore {
            bestScore := score
            bestId := profile["id"]
        }
    }

    return bestId
}

OpenWorkspaceUpdateDialog(*) {
    OpenWorkspaceCaptureDialog("update")
}

UpdateWorkspaceProfile(profileId, items := 0) {
    global WorkspaceOpenerProfiles
    global ConfiguredPullBuilderState
    global LastUpdatedWorkspaceId

    profileIndex := FindWorkspaceOpenerProfileIndexById(profileId)
    if !profileIndex {
        return
    }

    if !items {
        items := CaptureCurrentWorkspaceItems()
        if items.Length = 0 {
            ShowThemedMessageDialog("Update Workspace", "No normal application windows were found to capture.")
            return
        }
    }

    WorkspaceOpenerProfiles[profileIndex]["items"] := items
    SaveWorkspaceOpenerProfiles(WorkspaceOpenerProfiles)
    LastUpdatedWorkspaceId := profileId
    ConfiguredPullBuilderState["openerSelectedId"] := profileId
    RefreshWorkspaceOpenerBrowser()
}

FindWorkspaceOpenerProfileIndexById(profileId) {
    global WorkspaceOpenerProfiles

    for index, profile in WorkspaceOpenerProfiles {
        if profile["id"] = profileId {
            return index
        }
    }

    return 0
}

GetWindowsTerminalShellSpec(hwnd) {
    try terminalPid := WinGetPID("ahk_id " hwnd)
    catch
        return 0

    processes := GetProcessSnapshot()
    if !processes.Has(terminalPid) {
        return 0
    }

    descendants := GetDescendantProcesses(processes, terminalPid)
    if descendants.Length = 0 {
        return 0
    }

    best := 0
    bestScore := -1
    for _, proc in descendants {
        score := GetTerminalShellScore(proc["name"], proc["commandLine"])
        if score > bestScore {
            best := proc
            bestScore := score
        }
    }

    if !best || bestScore < 0 {
        return 0
    }

    command := Trim(best["commandLine"])
    if command = "" {
        command := best["name"]
    }

    return Map(
        "shell", best["name"],
        "command", command
    )
}

InferWindowsTerminalShellSpec(title) {
    title := Trim(title)
    if title = "" {
        return 0
    }

    lowerTitle := StrLower(title)
    if lowerTitle = "windows powershell" || lowerTitle = "administrator: windows powershell" {
        return Map("shell", "powershell.exe", "command", "powershell.exe", "shellKind", "powershell")
    }
    if lowerTitle = "powershell" || lowerTitle = "powershell 7" || lowerTitle = "pwsh" {
        return Map("shell", "pwsh.exe", "command", "pwsh.exe", "shellKind", "pwsh")
    }
    if lowerTitle = "command prompt" || lowerTitle = "cmd" || lowerTitle = "cmd.exe" {
        return Map("shell", "cmd.exe", "command", "cmd.exe", "shellKind", "cmd")
    }
    if RegExMatch(lowerTitle, "^[^@]+@[^:]+:.*$") {
        promptIdentity := title
        return Map("shell", "wsl.exe", "command", "wsl.exe", "shellKind", "wsl", "promptIdentity", promptIdentity)
    }
    if RegExMatch(lowerTitle, "^(ubuntu|debian|kali|arch|opensuse|fedora|alpine)([\s-].*)?$") {
        distro := GetWslDistroNameFromTitle(title)
        command := distro != "" ? 'wsl.exe -d "' . distro . '"' : "wsl.exe"
        return Map("shell", "wsl.exe", "command", command, "shellKind", "wsl", "distro", distro, "profileName", title)
    }

    return 0
}

GetTerminalShellKind(shellName) {
    shellName := StrLower(Trim(shellName))
    if shellName = "wsl.exe" || RegExMatch(shellName, "^ubuntu(\d+(\.\d+)*)?\.exe$") || RegExMatch(shellName, "^(debian|kali|arch|opensuse|fedora|alpine)\.exe$") {
        return "wsl"
    }
    if shellName = "powershell.exe" {
        return "powershell"
    }
    if shellName = "pwsh.exe" {
        return "pwsh"
    }
    if shellName = "cmd.exe" {
        return "cmd"
    }
    return shellName
}

GetWslDistroNameFromTitle(title) {
    title := Trim(title)
    if title = "" {
        return ""
    }

    if RegExMatch(title, "i)^(Ubuntu)(?:[\s-].*)?$", &match) {
        return match[1]
    }
    if RegExMatch(title, "i)^(Debian|Kali|Arch|openSUSE|Fedora|Alpine)(?:[\s-].*)?$", &match) {
        return match[1]
    }

    return ""
}

ResolveWslDistroFromPrompt(title) {
    identity := GetWslPromptIdentity(title)
    if !identity {
        return ""
    }

    target := StrLower(identity["user"] . "@" . identity["host"])
    distros := GetInstalledWslDistros()
    for _, distro in distros {
        currentIdentity := GetWslIdentityForDistro(distro)
        if currentIdentity = "" {
            continue
        }
        if StrLower(currentIdentity) = target {
            return distro
        }
    }

    return ""
}

GetFirefoxWindowCaptureSpec(hwnd, windowTitle, profileInfo := 0) {
    profiles := GetFirefoxProfiles()
    if profiles.Length = 0 {
        return 0
    }

    candidateProfiles := []
    if profileInfo && profileInfo.Has("profilePath") && profileInfo["profilePath"] != "" {
        for _, profile in profiles {
            if StrLower(profile["path"]) = StrLower(profileInfo["profilePath"]) {
                candidateProfiles.Push(profile)
                break
            }
        }
    }
    if candidateProfiles.Length = 0 {
        candidateProfiles := profiles
    }

    normalizedTitle := NormalizeFirefoxWindowTitle(windowTitle)
    bestSpec := 0
    bestScore := -1
    for _, profile in candidateProfiles {
        sessionWindows := GetFirefoxSessionWindowsForProfile(profile)
        if sessionWindows.Length = 1 {
            return sessionWindows[1]
        }
        for _, spec in sessionWindows {
            score := ScoreFirefoxSessionWindow(normalizedTitle, spec)
            if profileInfo && profileInfo.Has("profilePath") && profileInfo["profilePath"] != "" && spec.Has("profilePath") && StrLower(spec["profilePath"]) = StrLower(profileInfo["profilePath"]) {
                score += 100
            }
            if profileInfo && profileInfo.Has("profileName") && profileInfo["profileName"] != "" && spec.Has("profileName") && StrLower(spec["profileName"]) = StrLower(profileInfo["profileName"]) {
                score += 40
            }
            if score > bestScore {
                bestScore := score
                bestSpec := spec
            }
        }
    }

    if !bestSpec {
        return 0
    }
    if bestScore < 20 && candidateProfiles.Length > 1 {
        return 0
    }

    return bestSpec
}

GetFirefoxProfiles() {
    profiles := []
    baseDir := EnvGet("APPDATA") . "\Mozilla\Firefox"
    profilesIni := baseDir . "\profiles.ini"
    if FileExist(profilesIni) {
        currentSection := ""
        currentProfile := 0
        for _, rawLine in StrSplit(FileRead(profilesIni), "`n", "`r") {
            line := Trim(rawLine)
            if line = "" || SubStr(line, 1, 1) = ";" {
                continue
            }
            if RegExMatch(line, "^\[(.+)\]$", &match) {
                if currentProfile {
                    profiles.Push(currentProfile)
                }
                currentSection := match[1]
                currentProfile := InStr(currentSection, "Profile") = 1 ? Map("name", "", "path", "", "isRelative", 1, "default", 0) : 0
                continue
            }
            if !currentProfile || !InStr(line, "=") {
                continue
            }
            parts := StrSplit(line, "=", , 2)
            key := Trim(parts[1])
            value := Trim(parts[2])
            switch key {
                case "Name":
                    currentProfile["name"] := value
                case "Path":
                    currentProfile["path"] := value
                case "IsRelative":
                    currentProfile["isRelative"] := value + 0
                case "Default":
                    currentProfile["default"] := value + 0
            }
        }
        if currentProfile {
            profiles.Push(currentProfile)
        }
    }

    resolvedProfiles := []
    seenPaths := Map()
    for _, profile in profiles {
        if !profile.Has("path") || profile["path"] = "" {
            continue
        }
        profilePath := profile["isRelative"] ? baseDir . "\" . profile["path"] : profile["path"]
        if !DirExist(profilePath) {
            continue
        }
        seenPaths[StrLower(profilePath)] := true
        resolvedProfiles.Push(Map(
            "name", profile["name"] != "" ? profile["name"] : profile["path"],
            "path", profilePath,
            "default", profile["default"]
        ))
    }

    profilesDir := baseDir . "\Profiles"
    if DirExist(profilesDir) {
        Loop Files, profilesDir . "\*", "D" {
            profilePath := A_LoopFileFullPath
            if seenPaths.Has(StrLower(profilePath)) {
                continue
            }
            resolvedProfiles.Push(Map(
                "name", GetFirefoxProfileNameFromPath(profilePath),
                "path", profilePath,
                "default", 0
            ))
        }
    }

    return resolvedProfiles
}

GetFirefoxWindowProfileInfo(hwnd, windowTitle := "") {
    profiles := GetFirefoxProfiles()
    if profiles.Length = 0 {
        return 0
    }

    profilePath := ""
    profileName := ""
    pid := 0
    try pid := WinGetPID("ahk_id " hwnd)
    if pid {
        commandLine := GetProcessCommandLineByPid(pid)
        if commandLine != "" && RegExMatch(commandLine, 'i)--profile\s+"([^"]+)"', &match) {
            profilePath := match[1]
        }
    }

    titleProfileName := GetFirefoxProfileNameFromWindowTitle(windowTitle)
    if titleProfileName != "" {
        profileName := titleProfileName
    }

    if profilePath != "" {
        for _, profile in profiles {
            if StrLower(profile["path"]) = StrLower(profilePath) {
                if profileName = "" {
                    profileName := profile["name"]
                }
                return Map("profilePath", profilePath, "profileName", profileName)
            }
        }
        if profileName = "" {
            profileName := GetFirefoxProfileNameFromPath(profilePath)
        }
        return Map("profilePath", profilePath, "profileName", profileName)
    }

    if profileName != "" {
        for _, profile in profiles {
            if StrLower(profile["name"]) = StrLower(profileName) {
                return Map("profilePath", profile["path"], "profileName", profile["name"])
            }
        }
    }

    for _, profile in profiles {
        if profile["default"] {
            return Map("profilePath", profile["path"], "profileName", profile["name"])
        }
    }

    return profiles.Length ? Map("profilePath", profiles[1]["path"], "profileName", profiles[1]["name"]) : 0
}

GetFirefoxProfileNameFromPath(profilePath) {
    SplitPath(profilePath, &dirName)
    if dirName = "" {
        return ""
    }
    if InStr(dirName, ".") {
        parts := StrSplit(dirName, ".", , 2)
        return parts[2]
    }
    return dirName
}

GetFirefoxProfileNameFromWindowTitle(windowTitle) {
    windowTitle := Trim(windowTitle)
    if windowTitle = "" || !RegExMatch(windowTitle, "[–—-]\s+Mozilla Firefox$") {
        return ""
    }

    candidates := []
    for _, separator in [" — ", " – ", " - "] {
        pieces := StrSplit(windowTitle, separator)
        if pieces.Length >= 2 {
            candidates.Push(Trim(pieces[pieces.Length - 1]))
        }
    }

    if candidates.Length = 0 {
        return ""
    }

    profiles := GetFirefoxProfiles()
    for _, candidate in candidates {
        for _, profile in profiles {
            if StrLower(candidate) = StrLower(profile["name"]) {
                return profile["name"]
            }
        }
    }

    return ""
}

GetFirefoxSessionWindowsForProfile(profile) {
    jsonText := ReadFirefoxSessionJson(profile["path"])
    if jsonText = "" {
        return []
    }

    session := ParseJsonText(jsonText)
    if !session {
        return []
    }

    sessionWindows := []
    try rawWindows := session.windows
    catch
        return sessionWindows

    windowCount := GetComArrayLength(rawWindows)
    Loop windowCount {
        rawWindow := rawWindows[A_Index - 1]
        spec := BuildFirefoxSessionWindowSpec(rawWindow, profile)
        if spec {
            sessionWindows.Push(spec)
        }
    }

    return sessionWindows
}

GetFirefoxProfileUrlsFallback(profilePath) {
    jsonText := ReadFirefoxSessionJson(profilePath)
    if jsonText = "" {
        return []
    }

    urls := []
    seen := Map()
    startPos := 1
    pattern := '"url":"((?:\\.|[^"])*)"'
    while RegExMatch(jsonText, pattern, &match, startPos) {
        startPos := match.Pos + match.Len
        url := UnescapeFirefoxJsonString(match[1])
        if url = "" {
            continue
        }
        lowerUrl := StrLower(url)
        if InStr(lowerUrl, "about:") = 1 || InStr(lowerUrl, "chrome:") = 1 || InStr(lowerUrl, "moz-extension:") = 1 {
            continue
        }
        if !seen.Has(lowerUrl) {
            seen[lowerUrl] := true
            urls.Push(url)
        }
    }

    return urls
}

ReadFirefoxSessionJson(profilePath) {
    candidates := [
        profilePath . "\sessionstore-backups\recovery.jsonlz4",
        profilePath . "\sessionstore-backups\recovery.baklz4",
        profilePath . "\sessionstore.jsonlz4"
    ]

    for _, candidate in candidates {
        if !FileExist(candidate) {
            continue
        }
        jsonText := ReadMozillaJsonLz4File(candidate)
        if jsonText != "" {
            return jsonText
        }
    }

    return ""
}

ReadMozillaJsonLz4File(path) {
    file := ""
    try file := FileOpen(path, "r")
    catch
        return ""
    if !file {
        return ""
    }

    size := file.Length
    if size <= 8 {
        file.Close()
        return ""
    }

    compressed := Buffer(size, 0)
    file.RawRead(compressed, size)
    file.Close()

    magic := ""
    Loop 8 {
        magic .= Chr(NumGet(compressed, A_Index - 1, "UChar"))
    }
    if magic != "mozLz40`0" {
        return ""
    }

    return DecompressMozLz4ToUtf8(compressed, 8)
}

DecompressMozLz4ToUtf8(src, startOffset := 8) {
    srcSize := src.Size
    srcPos := startOffset
    capacity := Max(65536, (srcSize - startOffset) * 12)
    output := Buffer(capacity, 0)
    outPos := 0

    while srcPos < srcSize {
        token := NumGet(src, srcPos, "UChar")
        srcPos += 1

        literalLength := token >> 4
        if literalLength = 15 {
            while srcPos < srcSize {
                extension := NumGet(src, srcPos, "UChar")
                srcPos += 1
                literalLength += extension
                if extension != 255 {
                    break
                }
            }
        }

        if literalLength > 0 {
            EnsureMozLz4OutputCapacity(&output, &capacity, outPos + literalLength + 1024)
            DllCall("RtlMoveMemory", "ptr", output.Ptr + outPos, "ptr", src.Ptr + srcPos, "uptr", literalLength)
            srcPos += literalLength
            outPos += literalLength
        }

        if srcPos >= srcSize {
            break
        }

        offset := NumGet(src, srcPos, "UShort")
        srcPos += 2
        if offset <= 0 || offset > outPos {
            return ""
        }

        matchLength := token & 0x0F
        if matchLength = 15 {
            while srcPos < srcSize {
                extension := NumGet(src, srcPos, "UChar")
                srcPos += 1
                matchLength += extension
                if extension != 255 {
                    break
                }
            }
        }
        matchLength += 4

        EnsureMozLz4OutputCapacity(&output, &capacity, outPos + matchLength + 1024)
        matchPos := outPos - offset
        Loop matchLength {
            NumPut("UChar", NumGet(output, matchPos + A_Index - 1, "UChar"), output, outPos + A_Index - 1)
        }
        outPos += matchLength
    }

    return StrGet(output, outPos, "UTF-8")
}

EnsureMozLz4OutputCapacity(&buffer, &capacity, required) {
    if required <= capacity {
        return
    }

    newCapacity := capacity
    while newCapacity < required {
        newCapacity := Max(newCapacity * 2, required)
    }

    newBuffer := Buffer(newCapacity, 0)
    DllCall("RtlMoveMemory", "ptr", newBuffer.Ptr, "ptr", buffer.Ptr, "uptr", capacity)
    buffer := newBuffer
    capacity := newCapacity
}

ParseJsonText(jsonText) {
    static htmlDocument := 0

    if jsonText = "" {
        return 0
    }
    if !htmlDocument {
        htmlDocument := ComObject("htmlfile")
        htmlDocument.write("<meta http-equiv='X-UA-Compatible' content='IE=9'>")
    }

    try {
        return htmlDocument.parentWindow.JSON.parse(jsonText)
    } catch {
        return 0
    }
}

UnescapeFirefoxJsonString(value) {
    value := StrReplace(value, "\\", "\")
    value := StrReplace(value, "\/", "/")
    value := StrReplace(value, '\"', '"')
    value := StrReplace(value, "\u003A", ":")
    value := StrReplace(value, "\u002F", "/")
    value := StrReplace(value, "\u0026", "&")
    return value
}

BuildFirefoxSessionWindowSpec(rawWindow, profile) {
    try rawTabs := rawWindow.tabs
    catch
        return 0

    tabs := []
    rawTabCount := GetComArrayLength(rawTabs)
    if rawTabCount <= 0 {
        return 0
    }

    Loop rawTabCount {
        rawTab := rawTabs[A_Index - 1]
        currentEntry := GetFirefoxCurrentTabEntry(rawTab)
        if !currentEntry {
            continue
        }
        url := currentEntry["url"]
        if url = "" {
            continue
        }
        tabs.Push(Map(
            "url", url,
            "title", currentEntry.Has("title") ? currentEntry["title"] : ""
        ))
    }

    if tabs.Length = 0 {
        return 0
    }

    selectedIndex := 1
    try selectedIndex := rawWindow.selected + 0
    if selectedIndex < 1 || selectedIndex > tabs.Length {
        selectedIndex := 1
    }

    activeTab := tabs[selectedIndex]
    urls := []
    for _, tab in tabs {
        urls.Push(tab["url"])
    }

    return Map(
        "profilePath", profile["path"],
        "profileName", profile["name"],
        "urls", urls,
        "activeTab", selectedIndex,
        "activeTitle", activeTab.Has("title") ? activeTab["title"] : "",
        "activeUrl", activeTab["url"],
        "label", "Firefox"
    )
}

GetFirefoxCurrentTabEntry(rawTab) {
    try entries := rawTab.entries
    catch
        return 0

    entryCount := GetComArrayLength(entries)
    if entryCount <= 0 {
        return 0
    }

    index := 1
    try index := rawTab.index + 0
    if index < 1 || index > entryCount {
        index := entryCount
    }

    entry := entries[index - 1]
    url := ""
    title := ""
    try url := entry.url
    try title := entry.title
    if url = "" {
        return 0
    }

    return Map(
        "url", url,
        "title", title
    )
}

ScoreFirefoxSessionWindow(normalizedLiveTitle, spec) {
    score := 0
    activeTitle := NormalizeFirefoxWindowTitle(spec.Has("activeTitle") ? spec["activeTitle"] : "")
    activeUrl := spec.Has("activeUrl") ? spec["activeUrl"] : ""

    if activeTitle != "" && activeTitle = normalizedLiveTitle {
        score += 120
    } else if activeTitle != "" && (InStr(activeTitle, normalizedLiveTitle) || InStr(normalizedLiveTitle, activeTitle)) {
        score += 80
    }

    if normalizedLiveTitle != "" {
        for _, url in spec["urls"] {
            if InStr(StrLower(url), normalizedLiveTitle) {
                score += 20
                break
            }
        }
    }

    if activeUrl != "" {
        score += 5
    }
    if spec.Has("profileName") && spec["profileName"] != "" {
        score += 2
    }

    return score
}

NormalizeFirefoxWindowTitle(title) {
    title := Trim(title)
    title := RegExReplace(title, "\s+[-–—]\s+Mozilla Firefox$")
    title := RegExReplace(title, "\s+[-–—]\s+Firefox Developer Edition$")
    title := RegExReplace(title, "\s+[-–—]\s+Nightly$")
    return StrLower(Trim(title))
}

GetComArrayLength(value) {
    try return value.length + 0
    catch
        return 0
}

GetWslPromptIdentity(title) {
    title := Trim(title)
    if !RegExMatch(title, "^([^@]+)@([^:]+):", &match) {
        return 0
    }

    return Map(
        "user", Trim(match[1]),
        "host", Trim(match[2])
    )
}

GetInstalledWslDistros(forceRefresh := false) {
    static cachedDistros := []

    if !forceRefresh && cachedDistros.Length {
        return cachedDistros
    }

    cachedDistros := []
    output := ReadCommandOutput("wsl.exe -l -q", 10000)
    if output = "" {
        return cachedDistros
    }

    output := StrReplace(output, Chr(0), "")
    lines := StrSplit(output, "`n", "`r")
    for _, line in lines {
        distro := Trim(line)
        if distro != "" {
            cachedDistros.Push(distro)
        }
    }

    return cachedDistros
}

GetWslIdentityForDistro(distro) {
    static cachedIdentities := Map()

    if cachedIdentities.Has(distro) {
        return cachedIdentities[distro]
    }

    command := 'wsl.exe -d "' . distro . '" sh -lc "printf \"%s@%s\" \"$USER\" \"$(hostname)\""'
    identity := Trim(ReadCommandOutput(command, 20000))
    identity := StrReplace(identity, Chr(0), "")
    cachedIdentities[distro] := identity
    return identity
}

ReadCommandOutput(command, timeoutMs := 10000) {
    try exec := ComObject("WScript.Shell").Exec(command)
    catch
        return ""

    startTick := A_TickCount
    while !exec.Status {
        if (A_TickCount - startTick) >= timeoutMs {
            try exec.Terminate()
            break
        }
        Sleep(50)
    }

    output := ""
    try output := exec.StdOut.ReadAll()
    catch
        output := ""

    if output = "" {
        try output := exec.StdErr.ReadAll()
        catch
            output := ""
    }

    return output
}

GetProcessSnapshot() {
    processes := Map()
    try service := ComObject("WbemScripting.SWbemLocator").ConnectServer(".", "root\cimv2")
    catch
        return processes

    for proc in service.ExecQuery("SELECT ProcessId, ParentProcessId, Name, CommandLine FROM Win32_Process") {
        processes[proc.ProcessId + 0] := Map(
            "pid", proc.ProcessId + 0,
            "parentPid", proc.ParentProcessId + 0,
            "name", proc.Name != "" ? proc.Name : "",
            "commandLine", proc.CommandLine != "" ? proc.CommandLine : ""
        )
    }

    return processes
}

GetProcessCommandLineByPid(pid) {
    processes := GetProcessSnapshot()
    if processes.Has(pid) {
        return processes[pid]["commandLine"]
    }
    return ""
}

GetDescendantProcesses(processes, rootPid) {
    descendants := []
    queue := [rootPid]

    while queue.Length {
        parentPid := queue.RemoveAt(1)
        for _, proc in processes {
            if proc["parentPid"] != parentPid {
                continue
            }

            descendants.Push(proc)
            queue.Push(proc["pid"])
        }
    }

    return descendants
}

GetTerminalShellScore(processName, commandLine := "") {
    name := StrLower(processName)
    command := StrLower(commandLine)

    if name = "wsl.exe" {
        return 100
    }
    if RegExMatch(name, "^ubuntu(\d+(\.\d+)*)?\.exe$") {
        return 95
    }
    if RegExMatch(name, "^(debian|kali|arch|opensuse|fedora|alpine)\.exe$") {
        return 90
    }
    if name = "pwsh.exe" {
        return 80
    }
    if name = "powershell.exe" {
        return 70
    }
    if name = "cmd.exe" {
        return 60
    }
    if name = "bash.exe" {
        return 50
    }
    if InStr(command, "wsl.exe") {
        return 45
    }

    return -1
}

TrimWorkspaceOpenerLabel(text, maxLen := 24) {
    if StrLen(text) <= maxLen {
        return text
    }

    return SubStr(text, 1, maxLen - 3) . "..."
}

UpdateWorkspaceOpenerPagination() {
    global ConfiguredPullBuilderState
    global WorkspaceOpenerProfiles

    if !ConfiguredPullBuilderState.Count || !ConfiguredPullBuilderState["openerPageLabel"] {
        return
    }

    cardsPerPage := 6
    pageCount := Max(Ceil(WorkspaceOpenerProfiles.Length / cardsPerPage), 1)
    pageIndex := Max(Min(ConfiguredPullBuilderState["openerPageIndex"], pageCount), 1)
    ConfiguredPullBuilderState["openerPageIndex"] := pageIndex
    ConfiguredPullBuilderState["openerPageLabel"].Text := "Page " . pageIndex . " of " . pageCount
    ConfiguredPullBuilderState["openerPrevButton"].Enabled := pageIndex > 1
    ConfiguredPullBuilderState["openerNextButton"].Enabled := pageIndex < pageCount
}

RefreshWorkspaceOpenerBrowser(pageIndex := 0) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count || !ConfiguredPullBuilderState.Has("openerGui") || !ConfiguredPullBuilderState["openerGui"] {
        return
    }

    openerGui := ConfiguredPullBuilderState["openerGui"]
    WinGetPos(&guiX, &guiY,,, "ahk_id " openerGui.Hwnd)
    showOptions := ConfiguredPullBuilderState.Has("openerShowOptions") && ConfiguredPullBuilderState["openerShowOptions"] != ""
        ? ConfiguredPullBuilderState["openerShowOptions"]
        : "w760 h640"
    if pageIndex = 0 {
        pageIndex := ConfiguredPullBuilderState["openerPageIndex"]
    }

    CloseWorkspaceOpenerBrowser()
    OpenWorkspaceOpenerBrowser(pageIndex, Format("x{} y{} {}", guiX, guiY, showOptions))
}

ChangeWorkspaceOpenerPage(step) {
    global ConfiguredPullBuilderState
    global WorkspaceOpenerProfiles

    if !ConfiguredPullBuilderState.Count {
        return
    }

    cardsPerPage := 6
    pageCount := Max(Ceil(WorkspaceOpenerProfiles.Length / cardsPerPage), 1)
    newPage := ConfiguredPullBuilderState["openerPageIndex"] + step
    if newPage < 1 || newPage > pageCount {
        return
    }

    ConfiguredPullBuilderState["openerPageIndex"] := newPage
    RefreshWorkspaceOpenerBrowser(newPage)
}

HandleWorkspaceOpenerCardClick(profileId, *) {
    global ConfiguredPullBuilderState

    static lastProfileId := ""
    static lastClickTick := 0

    if !ConfiguredPullBuilderState.Count {
        return
    }

    currentTick := A_TickCount
    isDoubleClick := (lastProfileId = profileId) && (currentTick - lastClickTick <= 325)
    lastProfileId := profileId
    lastClickTick := currentTick

    SelectWorkspaceOpenerProfile(profileId)
    if isDoubleClick {
        LaunchWorkspaceOpenerById(profileId)
    }
}

SelectWorkspaceOpenerProfile(profileId, *) {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count {
        return
    }

    ConfiguredPullBuilderState["openerSelectedId"] := profileId
    UpdateWorkspaceOpenerSelectionVisuals()
    UpdateWorkspaceOpenerDetails()
}

UpdateWorkspaceOpenerSelectionVisuals() {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count || !ConfiguredPullBuilderState.Has("openerCardControls") {
        return
    }

    uiTheme := ConfiguredPullBuilderState["uiTheme"]
    selectedId := ConfiguredPullBuilderState["openerSelectedId"]
    focusedButton := 0
    for _, card in ConfiguredPullBuilderState["openerCardControls"] {
        if card["profileId"] = selectedId {
            focusedButton := card["button"]
            break
        }
    }

    if focusedButton {
        try focusedButton.Focus()
    }
}

UpdateWorkspaceOpenerDetails() {
    global ConfiguredPullBuilderState

    if !ConfiguredPullBuilderState.Count || !ConfiguredPullBuilderState["openerDetailsText"] {
        return
    }

    profile := FindWorkspaceOpenerProfileById(ConfiguredPullBuilderState["openerSelectedId"])
    if !profile {
        ConfiguredPullBuilderState["openerDetailsText"].Text := "Select a saved workspace to preview what it will open."
        return
    }

    details := profile["name"] . "`n"
    for _, item in profile["items"] {
        label := GetSanitizedWorkspaceOpenerLabel(item)
        details .= label . " -> monitor " . item["monitorIndex"] . " (" . GetWorkspaceOpenerPlacementLabel(item) . ")" . "`n"
    }
    ConfiguredPullBuilderState["openerDetailsText"].Text := RTrim(details, "`n")
}

FindWorkspaceOpenerProfileById(profileId) {
    global WorkspaceOpenerProfiles

    for _, profile in WorkspaceOpenerProfiles {
        if profile["id"] = profileId {
            return profile
        }
    }

    return 0
}

OpenWorkspaceNewDialog(*) {
    OpenWorkspaceCaptureDialog("create")
}

OpenWorkspaceCaptureDialog(initialMode := "create") {
    global WorkspaceOpenerProfiles
    global ConfiguredPullBuilderState

    currentItems := CaptureCurrentWorkspaceItems()
    if currentItems.Length = 0 {
        ShowThemedMessageDialog("Capture Workspace", "No normal application windows were found to capture.")
        return
    }

    defaultName := "Workspace " . (WorkspaceOpenerProfiles.Length + 1)
    guessedId := GetBestWorkspaceUpdateGuessId(currentItems)
    result := ShowThemedWorkspaceCaptureDialog(initialMode, defaultName, guessedId)
    if result["result"] != "OK" {
        return
    }

    if result["mode"] = "update" {
        if result["profileId"] = "" {
            return
        }
        UpdateWorkspaceProfile(result["profileId"], currentItems)
        return
    }

    profileId := "workspace-" . A_Now . "-" . Random(100, 999)
    WorkspaceOpenerProfiles.Push(Map(
        "id", profileId,
        "name", Trim(result["value"]) != "" ? Trim(result["value"]) : defaultName,
        "items", currentItems
    ))
    SaveWorkspaceOpenerProfiles(WorkspaceOpenerProfiles)
    ConfiguredPullBuilderState["openerSelectedId"] := profileId
    ConfiguredPullBuilderState["openerPageIndex"] := Max(Ceil(WorkspaceOpenerProfiles.Length / 6), 1)
    RefreshWorkspaceOpenerBrowser(ConfiguredPullBuilderState["openerPageIndex"])
}

CaptureCurrentWorkspaceItems() {
    items := []
    hwnds := WinGetList()
    for _, hwnd in hwnds {
        item := CaptureWorkspaceWindowItem(hwnd)
        if item {
            items.Push(item)
        }
    }
    return items
}

CaptureWorkspaceWindowItem(hwnd) {
    static ignoredTitles := Map("Hotkey Editor", true, "Current Hotkeys", true, "Workspace Openers", true)

    if !DllCall("IsWindowVisible", "ptr", hwnd, "int") {
        return 0
    }

    try title := WinGetTitle("ahk_id " hwnd)
    catch
        return 0

    if title = "" || ignoredTitles.Has(title) {
        return 0
    }

    try processName := WinGetProcessName("ahk_id " hwnd)
    catch
        return 0

    if !IsCapturableWorkspaceWindow(hwnd, processName, title) {
        return 0
    }

    placement := GetWindowPlacementInfo(hwnd)
    if !placement || placement["w"] < 120 || placement["h"] < 80 {
        return 0
    }

    path := ""
    try path := WinGetProcessPath("ahk_id " hwnd)
    item := Map(
        "processName", processName,
        "path", path,
        "title", title,
        "label", GetSanitizedProcessLabel(processName, path),
        "x", placement["x"],
        "y", placement["y"],
        "w", placement["w"],
        "h", placement["h"],
        "state", placement["state"],
        "monitorIndex", placement["monitorIndex"]
    )

    loweredProcessName := StrLower(processName)
    if loweredProcessName = "windowsterminal.exe" {
        shellSpec := GetWindowsTerminalShellSpec(hwnd)
        if !shellSpec {
            shellSpec := InferWindowsTerminalShellSpec(title)
        }
        item["launchKind"] := "windows-terminal"
        if shellSpec {
            item["shellKind"] := shellSpec.Has("shellKind") ? shellSpec["shellKind"] : GetTerminalShellKind(shellSpec["shell"])
            if shellSpec.Has("distro") && shellSpec["distro"] != "" {
                item["wslDistro"] := shellSpec["distro"]
            }
            if shellSpec.Has("profileName") && shellSpec["profileName"] != "" {
                item["profileName"] := shellSpec["profileName"]
            }
            if shellSpec.Has("promptIdentity") && shellSpec["promptIdentity"] != "" {
                item["promptIdentity"] := shellSpec["promptIdentity"]
            } else if RegExMatch(title, "^[^@]+@[^:]+:.*$") {
                item["promptIdentity"] := title
            }
        }
        item["label"] := GetWorkspaceOpenerTerminalLabel(item)
    } else if loweredProcessName = "firefox.exe" {
        profileInfo := GetFirefoxWindowProfileInfo(hwnd, title)
        browserSpec := GetFirefoxWindowCaptureSpec(hwnd, title, profileInfo)
        item["launchKind"] := "firefox-window"
        item["browserKind"] := "firefox"
        if profileInfo {
            item["browserProfilePath"] := profileInfo["profilePath"]
            item["browserProfileName"] := profileInfo["profileName"]
        }
        if browserSpec {
            if !item.Has("browserProfilePath") || item["browserProfilePath"] = "" {
                item["browserProfilePath"] := browserSpec["profilePath"]
            }
            if !item.Has("browserProfileName") || item["browserProfileName"] = "" {
                item["browserProfileName"] := browserSpec["profileName"]
            }
            item["browserActiveTab"] := browserSpec["activeTab"]
            item["browserUrls"] := browserSpec["urls"]
            item["title"] := browserSpec["activeTitle"] != "" ? browserSpec["activeTitle"] : item["title"]
            item["label"] := browserSpec["label"]
        } else {
            item["browserActiveTab"] := 1
            item["browserUrls"] := profileInfo && profileInfo.Has("profilePath") ? GetFirefoxProfileUrlsFallback(profileInfo["profilePath"]) : []
            item["label"] := "Firefox"
        }
    } else if path != "" && IsPackagedAppPath(path) {
        item["launchKind"] := "packaged-app"
    } else if path != "" {
        item["launchKind"] := "app-path"
    }

    return item
}

IsCapturableWorkspaceWindow(hwnd, processName, title) {
    if InStr(processName, "AutoHotkey") {
        return false
    }

    if IsWindowCloaked(hwnd) {
        return false
    }

    try className := WinGetClass("ahk_id " hwnd)
    catch
        return false

    static ignoredClasses := Map(
        "Shell_TrayWnd", true,
        "NotifyIconOverflowWindow", true,
        "Progman", true,
        "WorkerW", true
    )
    if ignoredClasses.Has(className) {
        return false
    }

    exStyle := 0
    try exStyle := WinGetExStyle("ahk_id " hwnd)
    if (exStyle & 0x80) { ; WS_EX_TOOLWINDOW
        return false
    }

    state := 0
    try state := WinGetMinMax("ahk_id " hwnd)
    if state = -1 {
        return false
    }

    if StrLower(processName) = "explorer.exe" {
        return className = "CabinetWClass" || className = "ExploreWClass"
    }

    return title != ""
}

IsWindowCloaked(hwnd) {
    cloaked := Buffer(4, 0)
    result := DllCall("dwmapi\DwmGetWindowAttribute", "ptr", hwnd, "uint", 14, "ptr", cloaked, "uint", 4, "int")
    if result != 0 {
        return false
    }

    return NumGet(cloaked, 0, "uint") != 0
}

GetSanitizedProcessLabel(processName, path := "") {
    label := RegExReplace(processName, "\.exe$", "")
    replacements := Map(
        "WindowsTerminal", "Windows Terminal",
        "Code", "VS Code"
    )

    if path != "" {
        SplitPath(path, &exeName)
        if exeName != "" {
            label := RegExReplace(exeName, "\.exe$", "")
        }
    }

    if replacements.Has(label) {
        return replacements[label]
    }

    return label
}

GetWorkspaceOpenerTerminalLabel(item) {
    if item.Has("shellKind") && StrLower(item["shellKind"]) = "wsl" {
        return "WSL"
    }

    return "Windows Terminal"
}

GetWorkspaceOpenerBrowserLabel(item) {
    browserKind := item.Has("browserKind") ? StrLower(item["browserKind"]) : ""
    if browserKind = "firefox" {
        return "Firefox"
    }
    return item.Has("label") ? item["label"] : "Browser"
}

GetWorkspaceOpenerPlacementLabel(item) {
    monitor := GetMonitorByIndex(item["monitorIndex"])
    if !monitor {
        return "saved position"
    }

    workLeft := monitor["workLeft"]
    workTop := monitor["workTop"]
    workWidth := Max(1, monitor["workRight"] - monitor["workLeft"])
    workHeight := Max(1, monitor["workBottom"] - monitor["workTop"])
    relX := (item["x"] - workLeft) / workWidth
    relY := (item["y"] - workTop) / workHeight
    relW := item["w"] / workWidth
    relH := item["h"] / workHeight
    tolerance := 0.12

    if item["state"] = 1 || (relW >= 0.92 && relH >= 0.92) {
        return "fullscreen"
    }

    if relW <= 0.58 && relH >= 0.82 {
        if relX <= tolerance {
            return "left"
        }
        if relX + relW >= 1 - tolerance {
            return "right"
        }
    }

    if relH <= 0.58 && relW >= 0.82 {
        if relY <= tolerance {
            return "top"
        }
        if relY + relH >= 1 - tolerance {
            return "bottom"
        }
    }

    return "float"
}

LaunchSelectedWorkspaceOpener() {
    global ConfiguredPullBuilderState
    global LastLaunchedWorkspaceId

    profile := FindWorkspaceOpenerProfileById(ConfiguredPullBuilderState["openerSelectedId"])
    if !profile {
        ShowThemedMessageDialog("Workspace Openers", "Select a workspace first.")
        return
    }

    launchedItems := profile["items"]
    builderOpen := ConfiguredPullBuilderState.Has("gui") && ConfiguredPullBuilderState["gui"]
    if builderOpen {
        CloseConfiguredPullBuilder()
    } else {
        CloseWorkspaceOpenerBrowser()
    }
    LastLaunchedWorkspaceId := profile["id"]
    for _, item in launchedItems {
        LaunchWorkspaceOpenerItem(item)
    }
}

LaunchWorkspaceOpenerById(profileId, *) {
    global ConfiguredPullBuilderState

    ConfiguredPullBuilderState["openerSelectedId"] := profileId
    LaunchSelectedWorkspaceOpener()
}

LaunchWorkspaceOpenerItem(item) {
    hwnd := 0
    if StrLower(item["processName"]) = "windowsterminal.exe" {
        existingTerminalWindows := GetVisibleWindowsForProcess(item["processName"])
        if LaunchWindowsTerminalItem(item) {
            hwnd := WaitForWorkspaceItemWindow(item, 8000, existingTerminalWindows)
        }
    } else if item.Has("launchKind") && item["launchKind"] = "firefox-window" {
        existingFirefoxWindows := GetVisibleWindowsForProcess(item["processName"])
        if LaunchFirefoxWorkspaceItem(item) {
            hwnd := WaitForWorkspaceItemWindow(item, 12000, existingFirefoxWindows)
        }
    } else {
        hwnd := FindWorkspaceWindowForItem(item)
        if !hwnd && item.Has("path") && item["path"] != "" && IsAllowedWorkspaceAppPath(item["path"]) {
            if !LaunchWorkspaceItemPath(item["path"]) {
                try Run('"' . item["path"] . '"')
            }
            hwnd := WaitForWorkspaceItemWindow(item)
        }
    }

    if !hwnd {
        return
    }

    RestoreWindowPlacement(hwnd, Map(
        "x", item["x"],
        "y", item["y"],
        "w", item["w"],
        "h", item["h"],
        "state", item["state"]
    ))
}

LaunchWindowsTerminalItem(item) {
    launchSpec := GetWindowsTerminalLaunchSpec(item)
    if launchSpec != "" {
        try {
            Run('wt.exe -w new new-tab ' . launchSpec)
            return true
        } catch {
        }
    }

    if item.Has("profileName") && Trim(item["profileName"]) != "" {
        profileName := Trim(item["profileName"])
        try {
            Run('wt.exe -w new new-tab --profile "' . profileName . '"')
            return true
        } catch {
        }
    }

    if item.Has("title") {
        profileName := GetWindowsTerminalProfileName(item["title"])
        if profileName != "" {
            try {
                Run('wt.exe -w new new-tab --profile "' . profileName . '"')
                return true
            } catch {
            }
        }
    }

    if item.Has("path") && item["path"] != "" {
        return LaunchWorkspaceItemPath(item["path"])
    }

    try {
        Run("wt.exe -w new")
        return true
    } catch {
        return false
    }
}

GetWindowsTerminalLaunchSpec(item) {
    if !item.Has("shellKind") {
        return ""
    }

    shellKind := StrLower(Trim(item["shellKind"]))
    switch shellKind {
        case "wsl":
            distro := item.Has("wslDistro") ? Trim(item["wslDistro"]) : ""
            if distro = "" && item.Has("promptIdentity") {
                distro := ResolveWslDistroFromPrompt(item["promptIdentity"])
                if distro != "" {
                    item["wslDistro"] := distro
                }
            }
            return distro != "" ? 'wsl.exe -d "' . distro . '"' : "wsl.exe"
        case "powershell":
            return "powershell.exe"
        case "pwsh":
            return "pwsh.exe"
        case "cmd":
            return "cmd.exe"
    }

    return ""
}

LaunchFirefoxWorkspaceItem(item) {
    firefoxPath := item.Has("path") ? Trim(item["path"]) : ""
    profilePath := item.Has("browserProfilePath") ? Trim(item["browserProfilePath"]) : ""
    profileName := item.Has("browserProfileName") ? Trim(item["browserProfileName"]) : ""
    urls := item.Has("browserUrls") ? item["browserUrls"] : []
    activeTab := item.Has("browserActiveTab") ? item["browserActiveTab"] : 1

    if firefoxPath = "" || !FileExist(firefoxPath) {
        return false
    }
    if profilePath = "" || !DirExist(profilePath) {
        if profileName != "" {
            orderedUrls := GetFirefoxLaunchUrlOrder(urls, activeTab)
            launchUrl := orderedUrls.Length ? orderedUrls[1] : "about:blank"
            try {
                Run('"' . firefoxPath . '" -P "' . profileName . '" -no-remote -new-window "' . launchUrl . '"')
                if orderedUrls.Length > 1 {
                    Sleep(700)
                    Loop orderedUrls.Length - 1 {
                        nextUrl := orderedUrls[A_Index + 1]
                        try Run('"' . firefoxPath . '" -P "' . profileName . '" -no-remote -new-tab "' . nextUrl . '"')
                        Sleep(120)
                    }
                }
                return true
            } catch {
            }
        }
        try {
            Run('"' . firefoxPath . '"')
            return true
        } catch {
            return false
        }
    }

    orderedUrls := GetFirefoxLaunchUrlOrder(urls, activeTab)
    launchUrl := orderedUrls.Length ? orderedUrls[1] : "about:blank"
    try {
        Run('"' . firefoxPath . '" -profile "' . profilePath . '" -no-remote -new-window "' . launchUrl . '"')
    } catch {
        return false
    }

    if orderedUrls.Length > 1 {
        Sleep(700)
        Loop orderedUrls.Length - 1 {
            nextUrl := orderedUrls[A_Index + 1]
            try Run('"' . firefoxPath . '" -profile "' . profilePath . '" -no-remote -new-tab "' . nextUrl . '"')
            Sleep(120)
        }
    }

    return true
}

GetFirefoxLaunchUrlOrder(urls, activeTab) {
    ordered := []
    if urls.Length = 0 {
        return ordered
    }

    activeTab := Max(1, Min(activeTab, urls.Length))
    Loop urls.Length {
        if A_Index != activeTab {
            ordered.Push(urls[A_Index])
        }
    }
    ordered.Push(urls[activeTab])
    return ordered
}

IsAllowedWorkspaceAppPath(path) {
    path := Trim(path)
    if path = "" {
        return false
    }
    if IsPackagedAppPath(path) {
        return true
    }
    return FileExist(path) != ""
}

GetWindowsTerminalProfileName(title) {
    title := Trim(title)
    if title = "" {
        return ""
    }

    static ignoredTitles := Map(
        "Windows Terminal", true,
        "Administrator: Windows Terminal", true
    )
    if ignoredTitles.Has(title) {
        return ""
    }

    if RegExMatch(title, "i)^[^@]+@[^:]+:.*$") {
        return ""
    }
    if RegExMatch(title, "i)^PS .+>$") {
        return ""
    }

    return title
}

LaunchWorkspaceItemPath(path) {
    if !IsPackagedAppPath(path) {
        return false
    }

    appId := GetPackagedAppUserModelId(path)
    if appId = "" {
        return false
    }

    try {
        Run('explorer.exe "shell:AppsFolder\' . appId . '"')
        return true
    } catch {
        return false
    }
}

IsPackagedAppPath(path) {
    return InStr(path, "\WindowsApps\") > 0
}

GetPackagedAppUserModelId(path) {
    SplitPath(path, , &dir)
    if dir = "" {
        return ""
    }

    packageFullName := ""
    parts := StrSplit(dir, "\")
    for _, part in parts {
        if InStr(part, "_") && RegExMatch(part, "__[A-Za-z0-9]+$") {
            packageFullName := part
        }
    }
    if packageFullName = "" {
        return ""
    }

    if !RegExMatch(packageFullName, "^(?<name>.+?)_[^_]+_[^_]+__(?<publisher>[A-Za-z0-9]+)$", &match) {
        return ""
    }

    packageFamily := match["name"] . "_" . match["publisher"]
    return packageFamily . "!App"
}

WaitForWorkspaceItemWindow(item, timeoutMs := 8000, excludedHwnds := 0) {
    deadline := A_TickCount + timeoutMs
    while A_TickCount < deadline {
        hwnd := FindWorkspaceWindowForItem(item, excludedHwnds)
        if hwnd {
            return hwnd
        }
        Sleep(150)
    }
    return 0
}

FindWorkspaceWindowForItem(item, excludedHwnds := 0) {
    hwnds := WinGetList("ahk_exe " . item["processName"])
    for _, hwnd in hwnds {
        if excludedHwnds && excludedHwnds.Has(hwnd) {
            continue
        }

        try title := WinGetTitle("ahk_id " hwnd)
        catch
            continue

        if !DllCall("IsWindowVisible", "ptr", hwnd, "int") {
            continue
        }

        if item.Has("title") && item["title"] != "" && title = item["title"] {
            return hwnd
        }

        if item.Has("path") && item["path"] != "" {
            try currentPath := WinGetProcessPath("ahk_id " hwnd)
            if currentPath = item["path"] {
                return hwnd
            }
        }
    }

    return 0
}

GetVisibleWindowsForProcess(processName) {
    hwnds := WinGetList("ahk_exe " . processName)
    visible := Map()
    for _, hwnd in hwnds {
        try {
            if DllCall("IsWindowVisible", "ptr", hwnd, "int") {
                visible[hwnd] := true
            }
        }
    }

    return visible
}

RenameSelectedWorkspaceOpener() {
    global ConfiguredPullBuilderState
    global WorkspaceOpenerProfiles

    profile := FindWorkspaceOpenerProfileById(ConfiguredPullBuilderState["openerSelectedId"])
    if !profile {
        ShowThemedMessageDialog("Workspace Openers", "Select a workspace first.")
        return
    }

    result := ShowThemedTextInputDialog("Rename Workspace", "Rename this workspace:", profile["name"])
    if result["result"] != "OK" {
        return
    }

    profile["name"] := Trim(result["value"]) != "" ? Trim(result["value"]) : profile["name"]
    SaveWorkspaceOpenerProfiles(WorkspaceOpenerProfiles)
    RefreshWorkspaceOpenerBrowser()
}

DeleteSelectedWorkspaceOpener() {
    global ConfiguredPullBuilderState
    global WorkspaceOpenerProfiles

    profileId := ConfiguredPullBuilderState["openerSelectedId"]
    if profileId = "" {
        ShowThemedMessageDialog("Workspace Openers", "Select a workspace first.")
        return
    }

    result := ShowThemedMessageDialog("Delete Workspace", "Delete this saved workspace?", "YesNo")
    if result != "Yes" {
        return
    }

    removedIndex := 0
    for index, profile in WorkspaceOpenerProfiles {
        if profile["id"] = profileId {
            WorkspaceOpenerProfiles.RemoveAt(index)
            removedIndex := index
            break
        }
    }

    if WorkspaceOpenerProfiles.Length = 0 {
        ConfiguredPullBuilderState["openerSelectedId"] := ""
    } else {
        nextIndex := removedIndex - 1
        if nextIndex < 1 {
            nextIndex := 1
        }
        if nextIndex > WorkspaceOpenerProfiles.Length {
            nextIndex := WorkspaceOpenerProfiles.Length
        }
        ConfiguredPullBuilderState["openerSelectedId"] := WorkspaceOpenerProfiles[nextIndex]["id"]
        ConfiguredPullBuilderState["openerPageIndex"] := Max(Ceil(nextIndex / 6), 1)
    }

    SaveWorkspaceOpenerProfiles(WorkspaceOpenerProfiles)
    RefreshWorkspaceOpenerBrowser(ConfiguredPullBuilderState["openerPageIndex"])
}

MoveSelectedWorkspaceOpener(direction) {
    global ConfiguredPullBuilderState
    global WorkspaceOpenerProfiles

    profileId := ConfiguredPullBuilderState["openerSelectedId"]
    if profileId = "" {
        ShowThemedMessageDialog("Workspace Openers", "Select a workspace first.")
        return
    }

    for index, profile in WorkspaceOpenerProfiles {
        if profile["id"] != profileId {
            continue
        }

        targetIndex := index + direction
        if targetIndex < 1 || targetIndex > WorkspaceOpenerProfiles.Length {
            return
        }

        temp := WorkspaceOpenerProfiles[index]
        WorkspaceOpenerProfiles[index] := WorkspaceOpenerProfiles[targetIndex]
        WorkspaceOpenerProfiles[targetIndex] := temp
        SaveWorkspaceOpenerProfiles(WorkspaceOpenerProfiles)
        RefreshWorkspaceOpenerBrowser()
        return
    }
}


ShowThemedWorkspaceCaptureDialog(initialMode := "create", defaultName := "", initialProfileId := "") {
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

    captureGui := Gui(options, "Capture Workspace")
    captureGui.SetFont("s10", "Segoe UI")
    captureGui.BackColor := uiTheme["surface"]
    captureGui.MarginX := 0
    captureGui.MarginY := 0

    state := Map("result", "Cancel", "mode", "create", "value", defaultName, "profileId", "")
    labels := []
    profileIds := []
    initialIndex := 1
    hasProfiles := WorkspaceOpenerProfiles.Length > 0
    for index, profile in WorkspaceOpenerProfiles {
        labels.Push(profile["name"])
        profileIds.Push(profile["id"])
        if initialProfileId != "" && profile["id"] = initialProfileId {
            initialIndex := index
        }
    }

    mode := StrLower(initialMode)
    if mode != "update" {
        mode := "create"
    }
    if !hasProfiles {
        mode := "create"
    }

    headerBar := captureGui.AddText("x0 y0 w468 h38 Background" . uiTheme["header"], "")
    headerBar.OnEvent("Click", (*) => StartGuiDrag(captureGui))
    captureGui.SetFont("s11", "Segoe UI Semibold")
    headerTitle := captureGui.AddText("x14 y9 w372 c" . uiTheme["headerText"], "Capture Workspace")
    headerTitle.OnEvent("Click", (*) => StartGuiDrag(captureGui))
    closeText := captureGui.AddText("x434 y5 w24 h26 Center c" . uiTheme["headerText"] . " Background" . uiTheme["closeFill"] . " +0x200 Border", "X")

    captureGui.SetFont("s9", "Segoe UI")
    captureGui.AddText("x18 y60 w410 h18 c" . uiTheme["text"], "Choose whether to create a new workspace or update an existing one.")
    createRadio := captureGui.AddRadio(Format("x18 y96 w90 h22 {} c{}", mode = "create" ? "Checked" : "", uiTheme["text"]), "Create")
    updateRadio := captureGui.AddRadio(Format("x126 y96 w90 h22 {} c{}", mode = "update" ? "Checked" : "", uiTheme["text"]), "Update")
    helperText := captureGui.AddText("x18 y128 w410 h18 c" . uiTheme["muted"], "")
    nameEdit := captureGui.AddEdit("x18 y156 w410 h28", defaultName)
    workspaceDropDown := captureGui.AddDropDownList("x18 y156 w410 Choose" . initialIndex, labels)
    applyButton := captureGui.AddButton("x222 y206 w96 h30 Default", "Apply")
    cancelButton := captureGui.AddButton("x332 y206 w96 h30", "Cancel")

    setMode := 0
    setMode := (newMode) => (
        state["mode"] := (!hasProfiles && newMode = "update") ? "create" : newMode,
        createRadio.Value := state["mode"] = "create" ? 1 : 0,
        updateRadio.Value := state["mode"] = "update" ? 1 : 0,
        helperText.Text := state["mode"] = "create"
            ? "Type a workspace name, then press Enter to save it."
            : "Use " . Chr(8593) . " and " . Chr(8595) . " to choose a workspace, then press Enter to update it.",
        nameEdit.Visible := state["mode"] = "create",
        workspaceDropDown.Visible := state["mode"] = "update",
        state["mode"] = "create" ? nameEdit.Focus() : workspaceDropDown.Focus()
    )

    clearDialogState := () => (
        ConfiguredPullBuilderState["workspaceCaptureGuiHwnd"] := 0,
        ConfiguredPullBuilderState["workspaceCaptureApplyFn"] := 0,
        ConfiguredPullBuilderState["workspaceCaptureToggleFn"] := 0
    )
    closeDialog := (*) => (state["result"] := "Cancel", clearDialogState(), captureGui.Destroy())
    applyDialog := (*) => (
        state["result"] := "OK",
        state["value"] := nameEdit.Value,
        state["profileId"] := (state["mode"] = "update" && workspaceDropDown.Value >= 1 && workspaceDropDown.Value <= profileIds.Length) ? profileIds[workspaceDropDown.Value] : "",
        clearDialogState(),
        captureGui.Destroy()
    )

    createRadio.OnEvent("Click", (*) => setMode("create"))
    updateRadio.OnEvent("Click", (*) => setMode("update"))
    closeText.OnEvent("Click", closeDialog)
    cancelButton.OnEvent("Click", closeDialog)
    applyButton.OnEvent("Click", applyDialog)
    captureGui.OnEvent("Close", closeDialog)
    captureGui.OnEvent("Escape", closeDialog)

    if ownerHwnd {
        WinGetPos(&ownerX, &ownerY, &ownerW, &ownerH, "ahk_id " ownerHwnd)
        dialogX := ownerX + Floor((ownerW - 468) / 2)
        dialogY := ownerY + Floor((ownerH - 254) / 2)
        captureGui.Show(Format("x{} y{} w468 h254", dialogX, dialogY))
    } else {
        captureGui.Show("w468 h254 Center")
    }

    ConfiguredPullBuilderState["workspaceCaptureGuiHwnd"] := captureGui.Hwnd
    ConfiguredPullBuilderState["workspaceCaptureApplyFn"] := applyDialog
    ConfiguredPullBuilderState["workspaceCaptureToggleFn"] := setMode
    setMode(mode)
    if state["mode"] = "create" {
        nameEdit.Value := defaultName
        SendMessage(0xB1, 0, StrLen(defaultName), nameEdit.Hwnd)
    }
    WinActivate("ahk_id " captureGui.Hwnd)
    WinWaitClose("ahk_id " captureGui.Hwnd)
    if ConfiguredPullBuilderState.Count {
        ConfiguredPullBuilderState["workspaceCaptureGuiHwnd"] := 0,
        ConfiguredPullBuilderState["workspaceCaptureApplyFn"] := 0,
        ConfiguredPullBuilderState["workspaceCaptureToggleFn"] := 0
    }
    return state
}
