/* Workspace edits are drafts until Save succeeds. Captures never auto-save. */
(() => {
    const select = selector => document.querySelector(selector);
    const native = window.__TAURI__;
    let store = null;
    let draft = null;
    let selected = [];
    let comparisonBase = null;
    let comparisonRendered = {before:null, after:null};
    let comparisonKept = new Map();
    let draftSelectionSetters = [];
    let draftPositionSetters = [];
    let browserStatusSetters = [];
    let browserFocusSetters = [];
    let draftDirty = false;
    let afterSaveAction = null;
    let selectingDraftWindows = false;
    const selectedDraftWindows = new Set();
    const invalidFocusedTabs = new Set();
    const editedBrowserUrls = new Set();
    let pendingTabUpdate = null;
    let workspaceSurface = "library";
    let pendingSurfaceFocus = null;
    let displayContext = {platform:"", monitors:[], areas:null, main:null};
    let displayRequest = 0, displayRevision = 0;
    let draftMonitorSetters = [];
    const expandedWorkspaces = new Set();
    let selectingWorkspaceItems = false;
    const selectedWorkspaces = new Set(), selectedBrowsers = new Set();
    let availableBrowsers = new Set();
    let working = false;
    let editingId = "";
    let pendingCapture = null;
    let pendingDraftAction = null;
    let pendingDraftCancel = null;
    let replacingSaved = false;
    let currentCapture = null;
    let latestCaptureId = 0;
    let queuedWorkspaceRequest = null;
    let browserUpdatePending = false;
    let browserUpdateSequence = 0;
    let browserUpdateUnknown = false;
    const browserUpdatedIds = new Set();
    let ignoredBrowserTabs = new Set();
    let browserBridgeStatus = null;
    let bridgeStatusRequest = 0;
    let browserSetters = [];
    let browserMissingSetters = [];
    let appendDraftWindow = null;
    let bridgeBeforeSettings = null;
    let workspaceLocations = new Map();
    let locationsReady = false;
    let desktopRequest = 0;
    let pendingTabRefresh = false;
    const draftCaptures = new Set();
    let saveAfterCapture = false;
    const pendingSavedTabRefreshes = new Map();
    const clone = value => JSON.parse(JSON.stringify(value));
    const errorText = error => String(error?.message || error).replace(/^Error:\s*/i, "");
    const profilePathKey = path => {
        const normalized = String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
        return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
    };
    const browserProfileKey = item => profilePathKey(item.browser?.profilePath || item.browser?.profileName || "");
    const samePhysicalWindow = (a, b) => {
        const before = browserProfileKey(a), after = browserProfileKey(b);
        return a.window?.id && b.window?.id && a.window?.pid && b.window?.pid && a.window.id === b.window.id && a.window.pid === b.window.pid
            && String(a.window.appId || "").toLowerCase() === String(b.window.appId || "").toLowerCase()
            && !(before && after && before !== after);
    };
    const {chromiumApp, firefoxApp, chromiumName, isBrowserItem} = window.WarpBrowserKinds;
    const wantsTabs = (item, index) => selected[index] && !ignoredBrowserTabs.has(index) && isBrowserItem(item);
    function monitorDirection(monitor) {
        const main = displayContext.main, rect = monitor?.geometry, base = main?.geometry;
        if (!rect || !base) return "";
        if (monitor.index === main.index) return "Main monitor";
        const horizontal = rect.x + rect.width <= base.x ? "left" : rect.x >= base.x + base.width ? "right" : "";
        const vertical = rect.y + rect.height <= base.y ? "top" : rect.y >= base.y + base.height ? "bottom" : "";
        if (vertical && horizontal) return `${vertical[0].toUpperCase() + vertical.slice(1)} ${horizontal} monitor`;
        const direction = horizontal || vertical;
        return direction ? `${direction[0].toUpperCase() + direction.slice(1)} monitor` : "Other monitor";
    }
    function monitorLabel(monitor) {
        const direction = monitorDirection(monitor);
        if (!direction) return "";
        return displayContext.monitors.filter(other => monitorDirection(other) === direction).length > 1 && monitor.name
            ? `${direction} · ${monitor.name}` : direction;
    }
    function lookupSavedMonitor(windowInfo) {
        const monitors = displayContext.monitors;
        if (!monitors.length) return {monitor:null, unavailable:false};
        const source = String(windowInfo?.monitorName || "").toLowerCase();
        let monitor = source && monitors.find(item => [item.id, item.sourceId].some(id => String(id || "").toLowerCase() === source));
        if (source && !monitor && monitors.some(item => item.sourceId)) return {monitor:null, unavailable:true};
        if (!monitor) monitor = monitors.find(item => item.index === windowInfo?.monitor);
        return {monitor:monitor || null, unavailable:false};
    }
    function savedMonitorLabel(windowInfo) {
        const result = lookupSavedMonitor(windowInfo);
        return result.unavailable ? "Display unavailable" : monitorLabel(result.monitor);
    }
    function positionArea(windowInfo) {
        const usable = area => area && Number.isFinite(area.x) && Number.isFinite(area.y) && area.width > 0 && area.height > 0;
        if (usable(windowInfo.workArea)) return windowInfo.workArea;
        const monitor = lookupSavedMonitor(windowInfo).monitor;
        const area = displayContext.areas?.[(monitor?.index || windowInfo.monitor || 1) - 1];
        return usable(area) ? area : usable(monitor?.geometry) ? monitor.geometry : null;
    }
    function positionPresets(area) {
        const left = Math.floor(area.width / 2), top = Math.floor(area.height / 2);
        return {
            fill:{...area},
            left:{x:area.x,y:area.y,width:left,height:area.height},
            right:{x:area.x + left,y:area.y,width:area.width - left,height:area.height},
            top:{x:area.x,y:area.y,width:area.width,height:top},
            bottom:{x:area.x,y:area.y + top,width:area.width,height:area.height - top}
        };
    }
    function positionLabel(windowInfo, area) {
        if (!area || !windowInfo.rect) return {value:"custom", label:"Custom"};
        if (!windowInfo.fullscreen) {
            if (windowInfo.maximizedHorizontal && windowInfo.maximizedVertical) return {value:"fill", label:"Fill monitor"};
            for (const [value, rect] of Object.entries(positionPresets(area))) {
                if (["x", "y", "width", "height"].every(key => Math.abs((windowInfo.rect[key] ?? 0) - rect[key]) <= 1)) return {value, label:""};
            }
        }
        const rect = windowInfo.rect;
        const x = (rect.x + rect.width / 2 - area.x) / area.width;
        const y = (rect.y + rect.height / 2 - area.y) / area.height;
        const direction = rect.width < area.width * 0.7 && (x < 0.4 ? "left" : x > 0.6 ? "right" : "")
            || rect.height < area.height * 0.7 && (y < 0.4 ? "top" : y > 0.6 ? "bottom" : "");
        return {value:"custom", label:direction ? `Custom - ${direction}` : "Custom"};
    }
    function preserveFocusedTab(previous, active, next, allowLineEdit = false) {
        const index = Math.max(0, Number(active || 1) - 1), selected = previous[index];
        if (!selected || !next.length) return null;
        if (next.length === 1) return 1;
        const matches = next.map((tab, i) => tab.url === selected.url ? i : -1).filter(i => i >= 0);
        if (matches.length === 1) return matches[0] + 1;
        if (matches.length > 1 && previous.length === next.length && previous.every((tab, i) => tab.url === next[i].url)) return index + 1;
        if (allowLineEdit && previous.length === next.length) {
            const changed = previous.map((tab, i) => tab.url !== next[i].url ? i : -1).filter(i => i >= 0);
            if (changed.length === 1 && changed[0] === index) return index + 1;
        }
        return null;
    }
    function workspaceSummary(profile) {
        const count = `${profile.items.length} ${profile.items.length === 1 ? "window" : "windows"}`;
        return displayContext.platform && profile.platform !== displayContext.platform ? `${count} · ${profile.platform === "windows" ? "Windows" : "Linux / KDE"}` : count;
    }
    async function refreshDisplayContext() {
        if (!native) return;
        const request = ++displayRequest;
        const [status, config, monitors, areas] = await Promise.allSettled(
            ["get_status", "get_config", "get_monitors", "get_import_monitors"].map(command => Promise.resolve().then(() => native.core.invoke(command)))
        );
        if (request !== displayRequest) return;
        const available = monitors.status === "fulfilled" && Array.isArray(monitors.value) ? monitors.value : [];
        const settings = config.status === "fulfilled" ? config.value?.settings || {} : {};
        const configuredId = String(settings.mainMonitorId || "").toLowerCase();
        const primary = available.find(monitor => monitor.primary) || available[0] || null;
        const main = configuredId ? available.find(monitor => [monitor.id, monitor.sourceId].some(id => String(id || "").toLowerCase() === configuredId)) || primary
            : settings.mainMonitor ? available.find(monitor => monitor.index === settings.mainMonitor) || available[available.length - 1] || primary : primary;
        displayContext = {platform:status.status === "fulfilled" ? status.value?.platform || "" : displayContext.platform, monitors:available, areas:areas.status === "fulfilled" && Array.isArray(areas.value) ? areas.value : [], main};
        displayRevision++;
        if (store) {
            for (const card of select("#workspace-list").querySelectorAll(".workspace-card")) {
                const profile = store.profiles.find(value => value.id === card.dataset.workspaceId);
                if (!profile) continue;
                card.querySelector(".workspace-summary-text").textContent = workspaceSummary(profile);
                const preview = card.querySelector(".workspace-preview"), content = card.querySelector(".workspace-preview-content");
                if (!preview.hidden) {
                    const focused = document.activeElement === content, scroll = content.scrollTop;
                    content.replaceChildren(workspaceContents(profile)); content.scrollTop = scroll;
                    if (focused) content.focus({preventScroll:true});
                }
            }
        }
        draftMonitorSetters.forEach(set => set?.());
        renderComparison();
    }
    function displayWorkspaceSurface(surface) {
        workspaceSurface = surface;
        select("#workspace-library").hidden = surface !== "library";
        select("#workspace-hotkey-choice").hidden = surface !== "choice";
        select("#workspace-editor").hidden = surface !== "editor";
        select("#workspace-back-to-library").hidden = surface === "library";
        select(".workspace-header-buttons").hidden = surface !== "library";
        select("#workspace-draft-banner").hidden = surface !== "library" || !draft;
        if (draft) select("#workspace-draft-banner-text").textContent = `Draft: ${select("#workspace-name").value || "New workspace"}`;
    }
    function selectionUI() {
        const total = selectedWorkspaces.size + selectedBrowsers.size;
        const available = (store?.profiles.length || 0) + availableBrowsers.size;
        const browserDeleting = select("#saved-browser-list").dataset.deleting === "true";
        const toggle = select("#select-workspace-items");
        toggle.textContent = selectingWorkspaceItems ? "Done" : "Select";
        toggle.setAttribute("aria-pressed", String(selectingWorkspaceItems));
        toggle.disabled = working || browserDeleting || !store || (!available && !selectingWorkspaceItems);
        select("#capture-workspace").disabled = working || !store || selectingWorkspaceItems;
        select("#workspaces-page").classList.toggle("is-selecting", selectingWorkspaceItems);
        select("#workspace-selection").hidden = !selectingWorkspaceItems;
        select("#selected-workspace-count").textContent = `${total} selected`;
        select("#select-all-workspace-items").disabled = working || browserDeleting || !available;
        select("#select-all-workspace-items").textContent = available && total === available ? "Clear all" : "Select all";
        select("#delete-selected-workspace-items").disabled = working || browserDeleting || !total;
        select("#confirm-delete-workspace-button").disabled = working || browserDeleting || !total;
        select("#cancel-delete-workspace-items").disabled = working || browserDeleting;
        document.querySelectorAll(".workspace-bulk-checkbox, .saved-browser-bulk-checkbox").forEach(box => {
            const browser = box.classList.contains("saved-browser-bulk-checkbox");
            const card = box.closest(browser ? ".saved-browser-card" : ".workspace-card");
            const id = card?.dataset[browser ? "profileId" : "workspaceId"];
            box.hidden = !selectingWorkspaceItems;
            box.checked = (browser ? selectedBrowsers : selectedWorkspaces).has(id);
            box.disabled = working || (browser && browserDeleting) || (browser ? selectingWorkspaceItems && !store : !store || pendingSavedTabRefreshes.has(id));
            const row = card?.querySelector(browser ? ".saved-browser-description" : ".workspace-preview-toggle");
            if (row) {
                row.disabled = working || (browser && browserDeleting) || (browser ? selectingWorkspaceItems && !store : !store || pendingSavedTabRefreshes.has(id));
                if (selectingWorkspaceItems) { row.removeAttribute("aria-expanded"); row.setAttribute("aria-pressed", String(box.checked)); }
                else { row.removeAttribute("aria-pressed"); row.setAttribute("aria-expanded", String(!card.querySelector(browser ? ".saved-browser-preview" : ".workspace-preview").hidden)); }
            }
        });
    }
    function clearWorkspaceSelection() {
        selectingWorkspaceItems = false; selectedWorkspaces.clear(); selectedBrowsers.clear();
        select("#confirm-delete-workspace-items").hidden = true;
        selectionUI();
    }
    window.WarpWorkspaceSelection = {
        registerBrowsers(ids) {
            const count = selectedBrowsers.size;
            availableBrowsers = new Set(ids);
            for (const id of selectedBrowsers) if (!availableBrowsers.has(id)) selectedBrowsers.delete(id);
            if (selectedBrowsers.size !== count) selectionChangedDuringRefresh();
            selectionUI();
        },
        set(kind, id, checked) {
            const group = kind === "browser" ? selectedBrowsers : selectedWorkspaces;
            if (checked) group.add(id); else group.delete(id);
            select("#confirm-delete-workspace-items").hidden = true;
            selectionUI();
        },
        active:() => selectingWorkspaceItems,
        refresh:selectionUI,
        refreshControls:controls
    };
    function selectionChangedDuringRefresh() {
        select("#confirm-delete-workspace-items").hidden = true;
        if (selectingWorkspaceItems && !working) inlineStatus("#workspace-status", "Selection changed. Review it before deleting.");
    }
    function focusWhenReady(action) {
        if (working) pendingSurfaceFocus = action;
        else action();
    }
    function workspaceChanges() {
        const previous = comparisonBase?.items || [];
        const current = draft?.items || [];
        const pairs = new Map(), used = new Set(), badges = new Map();
        const appIdentity = item => {
            const app = String(item.window?.appId || "").toLowerCase();
            const kind = item.browser?.kind || (chromiumApp(app) ? "chromium" : firefoxApp(app) || item.browser ? "firefox" : "");
            return [app, kind].join("\0");
        };
        const identity = item => [appIdentity(item), browserProfileKey(item)].join("\0");
        const launchIdentity = item => JSON.stringify({kind:item.launch?.kind || "executable",program:profilePathKey(item.launch?.program || ""),args:item.launch?.args || [],workingDirectory:profilePathKey(item.launch?.workingDirectory || ""),terminal:item.terminal || null});
        const hasSpecificIdentity = item => item.browser ? !!browserProfileKey(item) : !!(item.launch?.args?.length || item.launch?.workingDirectory || item.terminal?.profilePath || item.terminal?.profileName || item.terminal?.shell || item.terminal?.workingDirectory);
        const sameWindow = samePhysicalWindow;
        current.forEach((item, index) => {
            if (!selected[index]) return;
            const matches = previous.map((old, oldIndex) => ({old, oldIndex})).filter(({old, oldIndex}) => !used.has(oldIndex) && sameWindow(old, item));
            if (matches.length === 1) { pairs.set(index, matches[0].oldIndex); used.add(matches[0].oldIndex); }
        });
        const keys = new Set([...previous.map(identity), ...current.filter((_, index) => selected[index]).map(identity)]);
        for (const key of keys) {
            const old = previous.map((item, index) => ({item, index})).filter(value => !used.has(value.index) && identity(value.item) === key);
            const fresh = current.map((item, index) => ({item, index})).filter(value => selected[value.index] && !pairs.has(value.index) && identity(value.item) === key);
            if (old.length === 1 && fresh.length === 1 && hasSpecificIdentity(old[0].item) && hasSpecificIdentity(fresh[0].item) && launchIdentity(old[0].item) === launchIdentity(fresh[0].item)) { pairs.set(fresh[0].index, old[0].index); used.add(old[0].index); }
        }
        const appKeys = new Set([...previous.map(appIdentity), ...current.filter((_, index) => selected[index]).map(appIdentity)]);
        const removedItems = [], unresolvedItems = [];
        for (const key of appKeys) {
            const old = previous.map((item, index) => ({item, index})).filter(value => !used.has(value.index) && appIdentity(value.item) === key);
            const fresh = current.map((item, index) => ({item, index})).filter(value => selected[value.index] && !pairs.has(value.index) && appIdentity(value.item) === key);
            if (old.length === 1 && fresh.length === 1) {
                const beforeProfile = profilePathKey(old[0].item.browser?.profilePath || old[0].item.browser?.profileName || "");
                const afterProfile = profilePathKey(fresh[0].item.browser?.profilePath || fresh[0].item.browser?.profileName || "");
                if ((beforeProfile && afterProfile && beforeProfile !== afterProfile) || launchIdentity(old[0].item) !== launchIdentity(fresh[0].item)) { removedItems.push(old[0].item); badges.set(fresh[0].index, "new"); }
                else { badges.set(fresh[0].index, "review"); unresolvedItems.push(old[0].item); }
            }
            else if (!old.length) fresh.forEach(value => badges.set(value.index, "new"));
            else if (!fresh.length) removedItems.push(...old.map(value => value.item));
            else { fresh.forEach(value => badges.set(value.index, "review")); unresolvedItems.push(...old.map(value => value.item)); }
        }
        const comparable = item => ({
            label:item.label || "", window:{title:item.window?.title || "",appId:item.window?.appId || "",desktopId:item.window?.desktopId || "",path:item.window?.path || "",className:item.window?.className || "",rect:item.window?.rect || null,workArea:item.window?.workArea || null,monitor:item.window?.monitor || 0,monitorName:item.window?.monitorName || "",maximizedHorizontal:!!item.window?.maximizedHorizontal,maximizedVertical:!!item.window?.maximizedVertical,fullscreen:!!item.window?.fullscreen,minimized:!!item.window?.minimized},
            launch:{kind:item.launch?.kind || "executable",program:item.launch?.program || "",args:item.launch?.args || [],workingDirectory:item.launch?.workingDirectory || "",newWindow:!!item.launch?.newWindow},
            browser:item.browser ? {kind:item.browser.kind || "firefox",profilePath:item.browser.profilePath || "",profileName:item.browser.profileName || "",tabs:item.browser.tabs || [],activeTab:item.browser.activeTab} : null,
            terminal:item.terminal || null
        });
        for (const [index, oldIndex] of pairs) if (JSON.stringify(comparable(current[index])) !== JSON.stringify(comparable(previous[oldIndex]))) badges.set(index, "changed");
        for (const kept of comparisonKept.values()) { const index = current.indexOf(kept); if (index >= 0) badges.delete(index); }
        const isExcluded = old => current.some((item, index) => {
            if (selected[index]) return false;
            if (sameWindow(old, item)) return true;
            return previous.filter(saved => identity(saved) === identity(old)).length === 1 && identity(item) === identity(old) && launchIdentity(item) === launchIdentity(old);
        });
        const missingItems = [...removedItems.filter(old => !comparisonKept.has(old) && !isExcluded(old)), ...unresolvedItems.filter(old => !comparisonKept.has(old) && !isExcluded(old))];
        return {badges, removed:removedItems.length, missingItems};
    }
    function workspaceContents(profile, showPlacement = false) {
        const content = document.createElement("div");
        const items = profile?.items || [];
        if (!items.length) { const note = document.createElement("p"); note.textContent = "No windows."; content.append(note); return content; }
        const list = document.createElement("ul"); list.className = "workspace-contents-list";
        for (const item of items) {
            const row = document.createElement("li");
            const label = document.createElement("strong"); label.textContent = item.label || item.window?.title || item.window?.appId || "Window";
            row.append(label);
            const parts = [];
            if (item.window?.appId) parts.push(isBrowserItem(item) ? (item.browser?.kind === "chromium" || chromiumApp(item.window.appId) ? chromiumName(item.window.appId) : "Firefox") : item.window.appId.replace(/\.(?:exe|desktop)$/i, ""));
            const monitor = savedMonitorLabel(item.window);
            if (monitor) parts.push(monitor);
            else if (showPlacement && item.window?.monitor) parts.push(`Monitor ${item.window.monitor}`);
            if (showPlacement && item.window?.rect?.width && item.window?.rect?.height) parts.push(`${item.window.rect.width} × ${item.window.rect.height} at ${item.window.rect.x ?? 0}, ${item.window.rect.y ?? 0}`);
            if (parts.length) { const meta = document.createElement("small"); meta.textContent = parts.join(" · "); row.append(meta); }
            if (item.browser) {
                const tabs = item.browser.tabs || [];
                const description = document.createElement("small"); description.textContent = `${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`; row.append(description);
                if (tabs.length) {
                    const urls = document.createElement("ul"); urls.className = "workspace-content-tabs";
                    tabs.forEach((tab, index) => { const entry = document.createElement("li"); entry.textContent = `${index + 1 === item.browser.activeTab ? "Current: " : ""}${tab.title ? tab.title + " - " : ""}${tab.url}`; urls.append(entry); });
                    row.append(urls);
                }
            }
            if (showPlacement) {
                const info = [];
                if (item.launch?.program) info.push(`Launch: ${item.launch.program}`);
                if (item.launch?.args?.length) info.push(`Arguments: ${item.launch.args.join(" · ")}`);
                if (item.launch?.workingDirectory) info.push(`Working directory: ${item.launch.workingDirectory}`);
                if (item.launch?.newWindow) info.push("Require a new window");
                if (item.browser?.profileName || item.browser?.profilePath) info.push(`Browser profile: ${[item.browser.profileName, item.browser.profilePath].filter(Boolean).join(" · ")}`);
                if (item.terminal) info.push(`Terminal: ${[item.terminal.kind, item.terminal.profileName, item.terminal.shell, item.terminal.workingDirectory].filter(Boolean).join(" · ")}`);
                if (info.length) {
                    const details = document.createElement("details"); details.className = "workspace-content-details";
                    const summary = document.createElement("summary"); summary.textContent = "Launch and profile details"; details.append(summary);
                    info.forEach(text => { const line = document.createElement("small"); line.textContent = text; details.append(line); });
                    row.append(details);
                }
            }
            list.append(row);
        }
        content.append(list);
        return content;
    }
    function renderComparison() {
        const comparison = select("#workspace-comparison");
        comparison.hidden = !comparisonBase || !draft;
        const summary = select("#workspace-change-summary");
        summary.hidden = comparison.hidden;
        const changes = comparison.hidden ? null : workspaceChanges();
        const missing = select("#workspace-missing-windows"), missingList = select("#workspace-missing-list");
        missing.hidden = !changes?.missingItems.length;
        missingList.replaceChildren();
        for (const item of changes?.missingItems || []) {
            const row = document.createElement("div"); row.className = "workspace-removed-row";
            const name = item.label || item.window?.title || item.window?.appId || "Window";
            const details = workspaceContents({items:[item]}); details.className = "workspace-missing-details"; details.tabIndex = 0; details.setAttribute("aria-label", `Saved details for ${name}`);
            const keep = document.createElement("button"); keep.type = "button"; keep.textContent = "Keep"; keep.setAttribute("aria-label", `Keep ${name} in workspace`);
            keep.addEventListener("click", () => {
                const copy = clone(item);
                if (appendDraftWindow?.(copy)) {
                    comparisonKept.set(item, copy);
                    renderComparison();
                    inlineStatus("#workspace-editor-status", "Saved window added to the draft.");
                    select("#workspace-items").lastElementChild?.querySelector(".workspace-item-toggle")?.focus({preventScroll:true});
                }
            });
            row.append(details, keep); missingList.append(row);
        }
        const badges = changes?.badges || new Map();
        select("#workspace-items").querySelectorAll(".workspace-item").forEach((card, index) => {
            const badge = card.querySelector(".workspace-change-badge"), kind = badges.get(index);
            badge.hidden = !kind;
            badge.textContent = {new:"New",changed:"Changed",review:"Review match"}[kind] || "";
            badge.dataset.kind = kind || "";
        });
        if (comparison.hidden) return;
        const count = kind => [...changes.badges.values()].filter(value => value === kind).length;
        const parts = [[count("new"), "new"], [count("changed"), "changed"], [changes.removed, "removed"], [count("review"), "need matching review"]].filter(([number]) => number).map(([number, label]) => `${number} ${label}`);
        if (select("#workspace-name").value.trim() !== comparisonBase.name) parts.push("Name changed");
        if (select("#workspace-platform").value !== comparisonBase.platform) parts.push("Platform changed");
        summary.textContent = parts.length ? parts.join(" · ") : "No changes yet";
        if (!comparison.open) return;
        const after = {...draft, name:select("#workspace-name").value, platform:select("#workspace-platform").value, items:draft.items.filter((_, index) => selected[index])};
        for (const [side, profile] of [["before", comparisonBase], ["after", after]]) {
            const container = select(`#workspace-comparison-${side}`);
            let summary = container.querySelector(".workspace-comparison-summary");
            if (!summary) { summary = document.createElement("p"); summary.className = "workspace-comparison-summary"; container.replaceChildren(summary); }
            summary.textContent = `${profile.name || "Unnamed workspace"} · ${workspaceSummary(profile)}`;
            const signature = `${displayRevision}:${JSON.stringify(profile.items)}`;
            if (comparisonRendered[side] !== signature) {
                container.replaceChildren(summary, workspaceContents(profile, true));
                comparisonRendered[side] = signature;
            }
        }
        select("#workspace-comparison-loading").hidden = ![...draftCaptures].some(job => job.profile === draft && job.items.some(isBrowserItem));
    }
    select("#workspace-comparison").addEventListener("toggle", renderComparison);
    function refreshBrowserGuide() {
        browserStatusSetters.forEach(set => set?.());
    }
    async function refreshBridgeStatus() {
        const request = ++bridgeStatusRequest;
        try {
            const status = await native.core.invoke("bridge_status");
            if (request === bridgeStatusRequest) { browserBridgeStatus = status; refreshBrowserGuide(); return status; }
        } catch {
            if (request === bridgeStatusRequest) { browserBridgeStatus = null; refreshBrowserGuide(); }
        }
        return null;
    }
    function say(text, error = false) {
        if (!error) return;
        const status = draft && !select("#workspace-editor").hidden ? select("#workspace-save-status") : select("#workspace-status");
        setStatus(status, text, true);
    }
    function setStatus(status, text, error = false) {
        window.WarpErrorTimer.set(status, error ? errorText(text) : text, {error, hideWhenEmpty:true});
    }
    function inlineStatus(id, text, error = false) {
        setStatus(select(id), text, error);
    }
    function replaceDraft(action, cancel = null) {
        if (!draft) { action(); return; }
        pendingDraftAction = action;
        pendingDraftCancel = cancel;
        select("#workspace-recapture-message").textContent = `Discard your unsaved changes to “${select("#workspace-name").value || "New workspace"}” and continue?`;
        select("#workspace-recapture").hidden = false;
        select("#workspace-recapture").scrollIntoView?.({block:"start"});
        select("#workspace-keep-draft").focus();
    }
    function detachDeletedDraft(ids) {
        if (!draft || !editingId || !ids.includes(editingId) || store.profiles.some(profile => profile.id === editingId)) return;
        editingId = ""; replacingSaved = false; comparisonBase = null; draftDirty = true;
        select("#workspace-editor-title").textContent = "New workspace";
        select("#workspace-draft-banner-text").textContent = `Draft: ${select("#workspace-name").value || "New workspace"}`;
    }
    function editSavedWorkspace(id) {
        const profile = store?.profiles.find(item => item.id === id);
        if (!profile) { inlineStatus("#workspace-status", "That workspace is no longer available.", true); return; }
        currentCapture = null;
        openDraft(clone(profile), id);
    }
    function requestWorkspaceEdit(card, profile) {
        if (!draft) { editSavedWorkspace(profile.id); return; }
        if (editingId === profile.id) { displayWorkspaceSurface("editor"); select("#workspace-name").focus(); return; }
        if (!draftDirty && ![...draftCaptures].some(job => job.profile === draft)) { editSavedWorkspace(profile.id); return; }
        document.querySelectorAll(".workspace-draft-switch").forEach(panel => panel.remove());
        const panel = document.createElement("div"); panel.className = "workspace-draft-switch";
        const message = document.createElement("p");
        message.textContent = `Save changes to “${select("#workspace-name").value || "New workspace"}” before editing “${profile.name}”?`;
        const actions = document.createElement("div"); actions.className = "footer-actions";
        const button = (label, action) => { const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.addEventListener("click", action); actions.append(node); return node; };
        const keep = button("Keep editing", () => { panel.remove(); displayWorkspaceSurface("editor"); select("#workspace-name").focus(); });
        button("Discard and switch", () => { panel.remove(); editSavedWorkspace(profile.id); });
        const save = button("Save and switch", () => { panel.remove(); displayWorkspaceSurface("editor"); saveWorkspace(() => editSavedWorkspace(profile.id)); });
        save.className = "primary"; panel.append(message, actions); card.append(panel); keep.focus();
    }
    function controls() {
        select("#workspaces-page").querySelectorAll("input, textarea, select, button").forEach(el => { el.disabled = working || !!el.closest('[data-deleting="true"]') || (!store && !el.closest("#saved-browsers")); });
        select("#workspace-list").querySelectorAll(".workspace-card").forEach(card => {
            if (pendingSavedTabRefreshes.has(card.dataset.workspaceId)) card.querySelectorAll("button").forEach(button => { button.disabled = true; });
        });
        select("#cancel-restore").disabled = false;
        select("#save-workspace").disabled = working || !store || !draft || !selected.some(Boolean);
        const draftSelect = select("#select-draft-windows");
        draftSelect.textContent = selectingDraftWindows ? "Done" : "Select windows";
        draftSelect.setAttribute("aria-pressed", String(selectingDraftWindows));
        draftSelect.disabled = working || !store || !draft || (!selectingDraftWindows && selected.filter(Boolean).length < 2);
        select("#draft-window-selection").hidden = !selectingDraftWindows;
        select("#selected-draft-window-count").textContent = `${selectedDraftWindows.size} selected`;
        select("#remove-selected-draft-windows").disabled = working || !selectedDraftWindows.size;
        select("#select-all-draft-windows").disabled = working || !selected.some(Boolean);
        select("#select-all-draft-windows").textContent = selectedDraftWindows.size && selectedDraftWindows.size === selected.filter(Boolean).length ? "Clear all" : "Select all";
        document.querySelectorAll(".draft-window-checkbox").forEach(box => { box.hidden = !selectingDraftWindows; box.disabled = working; });
        document.querySelectorAll(".remove-workspace-window").forEach(button => { button.hidden = selectingDraftWindows; });
        const addSelected = select("#workspace-add-window-list .add-selected-windows");
        if (addSelected) addSelected.disabled = working || ![...select("#workspace-add-window-list").querySelectorAll('input[type="checkbox"]')].some(box => box.checked);
        draftPositionSetters.forEach(set => set?.());
        browserFocusSetters.forEach(set => set?.());
        select("#workspace-hotkey-urls").disabled = working || !store?.profiles.length;
        select("#workspace-hotkey-update").disabled = working || !store?.profiles.length;
        select("#workspace-hotkey-target").disabled = working || !store?.profiles.length;
        select("#workspace-hotkey-empty").hidden = !store || store.profiles.length > 0;
        const updateTabs = select("#refresh-workspace-tabs");
        updateTabs.hidden = !draft?.items.some(isBrowserItem);
        updateTabs.disabled = working || !store || !draft?.items.some(wantsTabs);
        selectionUI();
    }
    async function perform(action, reportError = error => say(String(error), true)) {
        if (working) return;
        working = true; controls();
        try { await action(); } catch (error) { reportError(error); }
        finally {
            working = false; controls();
            const focus = pendingSurfaceFocus; pendingSurfaceFocus = null; focus?.();
            if (saveAfterCapture && draft && ![...draftCaptures].some(job => job.profile === draft)) {
                saveAfterCapture = false;
                saveWorkspace();
            } else if (queuedWorkspaceRequest) {
                const request = queuedWorkspaceRequest;
                queuedWorkspaceRequest = null;
                receiveWorkspaceRequest(request);
            } else if (pendingTabRefresh && draft) {
                pendingTabRefresh = false;
                refreshDraftTabs();
            } else if (browserUpdatePending && !draft) refreshBrowserUpdate();
        }
    }
    function refreshBrowserUpdate() {
        if (working || draft || !browserUpdatePending) return;
        perform(refreshPendingWorkspaceStore);
    }
    async function persist(next) {
        const pending = [...pendingSavedTabRefreshes.entries()];
        if (pending.length) {
            if (draft) inlineStatus("#workspace-save-status", "Waiting for the browser update…");
            await Promise.all(pending.map(([, completed]) => completed));
            // A save for another workspace was prepared before the browser
            // update finished. Keep its freshly saved tabs in the store.
            for (const [id] of pending) {
                const index = next.profiles.findIndex(profile => profile.id === id);
                const latest = store.profiles.find(profile => profile.id === id);
                if (index >= 0 && latest) next.profiles[index] = clone(latest);
            }
        }
        store = await native.core.invoke("save_workspaces", {store: next, expected: clone(store)});
        render();
        await refreshWorkspaceLocations();
    }
    function markWorkspaceLocations() {
        select("#workspace-list").querySelectorAll(".workspace-card").forEach(card => {
            const label = card.querySelector(".workspace-open-on");
            const locations = workspaceLocations.get(card.dataset.workspaceId) || [];
            const profile = store?.profiles.find(item => item.id === card.dataset.workspaceId);
            const browsers = locations.filter(location => location.browserCount > 0);
            label.hidden = !locationsReady;
            if (browsers.length) {
                const count = browsers.reduce((total, location) => total + location.browserCount, 0);
                label.textContent = `${count === 1 ? "Browser" : "Browsers"} on: ${browsers.map(location => location.name).join(", ")}`;
            } else {
                label.textContent = locations.length ? `Windows on: ${locations.map(location => location.windowCount < profile.items.length ? `${location.name} (${location.windowCount}/${profile.items.length} windows)` : location.name).join(", ")}` : "No matching windows open";
            }
        });
    }
    async function refreshWorkspaceLocations() {
        if (!native) return;
        const request = ++desktopRequest;
        let result;
        try { result = await native.core.invoke("workspace_locations"); } catch { result = null; }
        if (request !== desktopRequest) return;
        locationsReady = Array.isArray(result);
        workspaceLocations = new Map((result || []).map(entry => [entry.workspaceId, entry.locations]));
        markWorkspaceLocations();
    }
    async function browserSources(profile, waitForIdle = false) {
        const result = await native.core.invoke("workspace_locations", {profile:clone(profile), resolveBrowsers:true, waitForIdle});
        if (result[0]?.failure) throw new Error(tabFailureMessage(result[0].failure));
        return (result[0]?.locations || []).filter(location => location.browserCount > 0);
    }
    function showSourceMenu(menu, sources, choose) {
        closeWindowList();
        menu.replaceChildren();
        const label = document.createElement("p"); label.textContent = "Update URLs from"; menu.append(label);
        for (const source of sources) {
            const button = document.createElement("button"); button.type = "button";
            const title = source.browserTitles?.[0];
            button.textContent = `${source.name}${title ? ` · ${title.slice(0, 90)}` : ""}${source.ambiguous ? " · multiple windows" : ""}`;
            button.addEventListener("click", () => { menu.hidden = true; choose(source); });
            menu.append(button);
        }
        menu.hidden = false;
        menu.querySelector("button")?.focus();
    }
    function savedWorkspaceCard(id) {
        return [...select("#workspace-list").querySelectorAll(".workspace-card")].find(card => card.dataset.workspaceId === id);
    }
    function savedTabStatus(id, message, error = false) {
        const status = savedWorkspaceCard(id)?.querySelector(".workspace-card-status");
        if (status) setStatus(status, message, error);
    }
    async function applySavedTabs(profile, source) {
        savedTabStatus(profile.id, "Waiting for the browser extension…");
        const result = await native.core.invoke("update_saved_workspace_tabs", {workspaceId:profile.id, desktopId:source?.id || null});
        store = result.store;
        render();
        const message = tabUpdateMessage(result.updated, result.unmatched, source?.name, result.failure);
        savedTabStatus(profile.id, result.updated ? `Saved: ${message}` : message, !result.updated);
    }
    function refreshSavedTabs(profile) {
        const run = async action => {
            if (working || pendingSavedTabRefreshes.has(profile.id)) return;
            let finish;
            pendingSavedTabRefreshes.set(profile.id, new Promise(resolve => { finish = resolve; }));
            controls();
            try { await action(); }
            catch (error) { savedTabStatus(profile.id, errorText(error), true); }
            finally { pendingSavedTabRefreshes.delete(profile.id); finish(); controls(); }
        };
        savedTabStatus(profile.id, "Finding browser windows…");
        run(async () => {
            const sources = await browserSources(profile, true);
            if (sources.length > 1) {
                savedTabStatus(profile.id, "");
                const current = savedWorkspaceCard(profile.id);
                if (current) showSourceMenu(current.querySelector(".workspace-source-menu"), sources, source => run(() => applySavedTabs(profile, source)));
            } else await applySavedTabs(profile, sources[0]);
        });
    }
    function render() {
        const available = new Set(store.profiles.map(profile => profile.id));
        const count = selectedWorkspaces.size;
        for (const id of selectedWorkspaces) if (!available.has(id)) selectedWorkspaces.delete(id);
        if (selectedWorkspaces.size !== count) selectionChangedDuringRefresh();
        const focused = document.activeElement;
        const focusSelector = focused?.classList.contains("workspace-preview-toggle") ? ".workspace-preview-toggle"
            : focused?.classList.contains("workspace-bulk-checkbox") ? ".workspace-bulk-checkbox"
            : focused?.classList.contains("workspace-preview-content") ? ".workspace-preview-content" : null;
        const focusId = focusSelector ? focused.closest(".workspace-card")?.dataset.workspaceId : null;
        const focusScroll = focused?.scrollTop || 0;
        select("#workspace-list").replaceChildren();
        select("#workspace-empty").hidden = store.profiles.length > 0;
        store.profiles.forEach((profile, index) => {
            const fragment = select("#workspace-card-template").content.cloneNode(true);
            const card = fragment.querySelector("article");
            card.dataset.workspaceId = profile.id;
            const checkbox = card.querySelector(".workspace-bulk-checkbox");
            checkbox.setAttribute("aria-label", `Select workspace ${profile.name}`);
            checkbox.addEventListener("change", () => window.WarpWorkspaceSelection.set("workspace", profile.id, checkbox.checked));
            card.querySelector('[data-action="edit"]').setAttribute("aria-label", `Edit workspace ${profile.name}`);
            card.querySelector('[data-action="delete"]').setAttribute("aria-label", `Delete workspace ${profile.name}`);
            card.querySelector(".workspace-title").textContent = profile.name;
            card.querySelector(".workspace-summary-text").textContent = workspaceSummary(profile);
            const preview = card.querySelector(".workspace-preview");
            const previewContent = card.querySelector(".workspace-preview-content");
            const toggle = card.querySelector(".workspace-preview-toggle");
            preview.id = `workspace-preview-${index}`;
            previewContent.setAttribute("role", "region"); previewContent.setAttribute("aria-label", `Windows in ${profile.name}`); previewContent.tabIndex = 0;
            toggle.setAttribute("aria-controls", preview.id);
            const expanded = expandedWorkspaces.has(profile.id);
            preview.hidden = !expanded;
            if (expanded) previewContent.append(workspaceContents(profile));
            toggle.setAttribute("aria-expanded", String(expanded));
            toggle.addEventListener("click", () => {
                if (selectingWorkspaceItems) { if (!checkbox.disabled) window.WarpWorkspaceSelection.set("workspace", profile.id, !checkbox.checked); return; }
                const open = preview.hidden;
                preview.hidden = !open;
                toggle.setAttribute("aria-expanded", String(open));
                if (open) { previewContent.replaceChildren(workspaceContents(profile)); expandedWorkspaces.add(profile.id); }
                else { previewContent.replaceChildren(); expandedWorkspaces.delete(profile.id); }
            });
            card.querySelector('[data-action="refresh-tabs"]').hidden = !profile.items.some(isBrowserItem);
            if (pendingSavedTabRefreshes.has(profile.id)) {
                card.querySelectorAll("button").forEach(button => { button.disabled = true; });
                const status = card.querySelector(".workspace-card-status");
                status.hidden = false; status.textContent = "Waiting for the browser extension…";
            }
            card.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => {
                const action = button.dataset.action;
                if (button.closest(".menu")) button.closest(".menu").hidden = true;
                if (action === "delete" || action === "cancel-delete") {
                    card.querySelector(".workspace-delete-confirm p").textContent = draft && editingId === profile.id
                        ? "Delete this saved workspace? Your unsaved changes will remain as a new workspace. Open windows will stay open."
                        : "Delete this saved workspace? Open windows will stay open.";
                    card.querySelector(".workspace-delete-confirm").hidden = action !== "delete";
                    card.querySelector(action === "delete" ? '[data-action="cancel-delete"]' : '[data-action="delete"]').focus();
                    return;
                }
                if (action === "edit") { requestWorkspaceEdit(card, profile); return; }
                if (action === "update") { capture(profile.id); return; }
                if (action === "restore") { restore(profile, card); return; }
                if (action === "refresh-tabs") {
                    if (draft && editingId === profile.id) { refreshDraftTabs(); return; }
                    refreshSavedTabs(profile);
                    return;
                }
                perform(async () => {
                    const next = clone(store);
                    if (action === "confirm-delete") next.profiles.splice(index, 1);
                    else {
                        const target = index + (action === "up" ? -1 : 1);
                        if (target < 0 || target >= next.profiles.length) return;
                        [next.profiles[index], next.profiles[target]] = [next.profiles[target], next.profiles[index]];
                    }
                    await persist(next);
                    if (action === "confirm-delete") detachDeletedDraft([profile.id]);
                });
            }));
            card.style.animationDelay = `${Math.min(index, 8) * 40}ms`;
            const menu = card.querySelector(".workspace-action-menu");
            card.querySelector(".menu-button").addEventListener("click", event => {
                event.stopPropagation();
                const willOpen = menu.hidden;
                document.querySelectorAll(".menu").forEach(open => { open.hidden = true; });
                closeWindowList();
                menu.hidden = !willOpen;
            });
            select("#workspace-list").append(fragment);
        });
        markWorkspaceLocations();
        selectionUI();
        if (focusId) {
            const target = savedWorkspaceCard(focusId)?.querySelector(focusSelector);
            if (target) { target.scrollTop = focusScroll; target.focus({preventScroll:true}); }
        }
    }
    async function refreshPendingWorkspaceStore() {
        if (browserUpdatePending) {
            const version = browserUpdateSequence;
            store = await native.core.invoke("get_workspaces");
            render();
            if (version === browserUpdateSequence) {
                browserUpdatePending = false;
                browserUpdateUnknown = false;
                browserUpdatedIds.clear();
            }
        }
    }
    select("#select-workspace-items").addEventListener("click", () => {
        if (selectingWorkspaceItems) { clearWorkspaceSelection(); return; }
        if (working || !store) return;
        selectingWorkspaceItems = true;
        selectionUI();
    });
    select("#select-all-workspace-items").addEventListener("click", () => {
        const workspaceIds = store.profiles.map(profile => profile.id);
        const all = workspaceIds.length + availableBrowsers.size;
        const clear = all && selectedWorkspaces.size + selectedBrowsers.size === all;
        selectedWorkspaces.clear(); selectedBrowsers.clear();
        if (!clear) { workspaceIds.forEach(id => selectedWorkspaces.add(id)); availableBrowsers.forEach(id => selectedBrowsers.add(id)); }
        select("#confirm-delete-workspace-items").hidden = true;
        selectionUI();
    });
    select("#delete-selected-workspace-items").addEventListener("click", () => {
        const pieces = [];
        if (selectedWorkspaces.size) pieces.push(`${selectedWorkspaces.size} ${selectedWorkspaces.size === 1 ? "workspace" : "workspaces"}`);
        if (selectedBrowsers.size) pieces.push(`${selectedBrowsers.size} saved ${selectedBrowsers.size === 1 ? "browser" : "browsers"}`);
        if (!pieces.length) return;
        const keepsDraft = draft && editingId && selectedWorkspaces.has(editingId);
        select("#confirm-delete-workspace-text").textContent = `Delete ${pieces.join(" and ")}? Open windows will stay open.${keepsDraft ? " Your unsaved changes will remain as a new workspace." : ""}`;
        select("#confirm-delete-workspace-items").hidden = false;
        select("#cancel-delete-workspace-items").focus();
    });
    select("#cancel-delete-workspace-items").addEventListener("click", () => { select("#confirm-delete-workspace-items").hidden = true; select("#delete-selected-workspace-items").focus(); });
    select("#confirm-delete-workspace-button").addEventListener("click", () => {
        const workspaces = [...selectedWorkspaces], browsers = [...selectedBrowsers];
        if (!workspaces.length && !browsers.length) return;
        perform(async () => {
            let deletedWorkspaces = 0, deletedBrowsers = 0;
            if (workspaces.length) {
                await Promise.all([...pendingSavedTabRefreshes.values()]);
                if (browserUpdatePending) await refreshPendingWorkspaceStore();
                store = await native.core.invoke("get_workspaces");
                const next = clone(store);
                next.profiles = next.profiles.filter(profile => !workspaces.includes(profile.id));
                deletedWorkspaces = store.profiles.length - next.profiles.length;
                if (deletedWorkspaces) { await persist(next); detachDeletedDraft(workspaces); }
                workspaces.forEach(id => selectedWorkspaces.delete(id));
            }
            const failures = [];
            for (const id of browsers) {
                try { await native.core.invoke("delete_saved_browser", {id}); selectedBrowsers.delete(id); deletedBrowsers++; }
                catch (error) { failures.push(errorText(error)); }
            }
            if (browsers.length) window.dispatchEvent(new window.Event("warp-saved-browsers-updated"));
            select("#confirm-delete-workspace-items").hidden = true;
            const result = `${deletedWorkspaces} ${deletedWorkspaces === 1 ? "workspace" : "workspaces"} and ${deletedBrowsers} saved ${deletedBrowsers === 1 ? "browser" : "browsers"} deleted.`;
            if (failures.length) inlineStatus("#workspace-status", `${result} ${failures.length} could not be deleted: ${failures[0]}`, true);
            else { clearWorkspaceSelection(); inlineStatus("#workspace-status", result); }
            selectionUI();
        }, error => { select("#confirm-delete-workspace-items").hidden = true; inlineStatus("#workspace-status", errorText(error), true); }).then(() => {
            focusWhenReady(() => {
                const target = selectingWorkspaceItems && (selectedWorkspaces.size || selectedBrowsers.size)
                    ? select("#delete-selected-workspace-items") : select("#select-workspace-items");
                (target.disabled ? select("#capture-workspace") : target).focus({preventScroll:true});
            });
        });
    });
    async function useRecapture(capture) {
        await refreshPendingWorkspaceStore();
        openDraft(capture.profile);
        focusWhenReady(() => { if (workspaceSurface === "editor") { select("#workspace-name").focus(); select("#workspace-name").select?.(); } });
    }
    function keepKnownBrowserTabs(profile, previous) {
        if (!previous) return;
        for (const item of profile.items) {
            const matches = previous.items.filter(saved => saved.browser && saved.window.id && saved.window.id === item.window.id && saved.window.pid === item.window.pid && saved.window.appId === item.window.appId);
            if (matches.length === 1 && !item.browser) item.browser = clone(matches[0].browser);
        }
    }
    function beginDraftCapture(profile, captureId = null, items = profile.items.slice()) {
        const job = {profile, captureId, items, edited:new Set()};
        draftCaptures.add(job);
        select("#workspace-tabs-loading").hidden = ![...draftCaptures].some(pending => pending.profile === profile && pending.items.some(isBrowserItem));
        refreshBrowserGuide();
        renderComparison();
        return job;
    }
    function markCapturedBrowserEdited(item) {
        for (const job of draftCaptures) if (job.profile === draft && job.items.includes(item)) job.edited.add(item);
    }
    function finishDraftCapture(job, enriched, error = null) {
        if (!draftCaptures.has(job) || draft !== job.profile) return;
        let missing = false;
        for (const [originalIndex, item] of job.items.entries()) {
            const index = draft.items.indexOf(item);
            if (index < 0 || job.edited.has(item) || !isBrowserItem(item)) continue;
            const saved = enriched?.items.find(candidate => candidate.window.id && candidate.window.id === item.window.id && candidate.window.pid === item.window.pid)
                || (!item.window.id ? enriched?.items[originalIndex] : null);
            if (saved?.browser?.tabs?.length && browserSetters[index]?.(saved.browser)) continue;
            if (selected[index]) missing = true;
            browserMissingSetters[index]?.();
        }
        draftCaptures.delete(job);
        const remaining = [...draftCaptures].some(pending => pending.profile === draft);
        select("#workspace-tabs-loading").hidden = ![...draftCaptures].some(pending => pending.profile === draft && pending.items.some(isBrowserItem));
        refreshBrowserGuide();
        renderComparison();
        const failed = !!error || missing;
        if (failed) {
            const message = error
                ? `Browser URLs couldn't be loaded: ${errorText(error)}. Existing URLs were kept.`
                : "Some browser URLs couldn't be matched. Check Browser setup or review the affected windows. Existing URLs were kept.";
            inlineStatus("#workspace-tabs-status", message, true);
        }
        if (saveAfterCapture && failed) {
            saveAfterCapture = false;
            afterSaveAction = null;
            inlineStatus("#workspace-save-status", "URLs could not be loaded. Retry or save without them.", true);
        } else if (saveAfterCapture && !remaining && !working) {
            saveAfterCapture = false;
            saveWorkspace();
        }
    }
    function openDraft(profile, id = "", replaceSaved = false) {
        if (selectingWorkspaceItems) clearWorkspaceSelection();
        closeWindowList();
        draftCaptures.clear(); saveAfterCapture = false;
        select("#workspace-tabs-loading").hidden = true;
        pendingCapture = null;
        pendingDraftAction = null;
        pendingDraftCancel = null;
        replacingSaved = replaceSaved;
        select("#workspace-hotkey-choice").hidden = true;
        select("#workspace-recapture").hidden = true;
        select("#workspace-replace-saved").hidden = true;
        select("#workspace-capture-pending").hidden = true;
        inlineStatus("#workspace-status", "");
        inlineStatus("#workspace-editor-status", "");
        inlineStatus("#workspace-save-status", "");
        draft = profile; editingId = id; selected = profile.items.map(() => true); ignoredBrowserTabs = new Set();
        draftDirty = !id || replaceSaved; afterSaveAction = null;
        selectingDraftWindows = false; selectedDraftWindows.clear(); invalidFocusedTabs.clear(); editedBrowserUrls.clear(); pendingTabUpdate = null;
        select("#workspace-tabs-confirm").hidden = true;
        comparisonBase = replaceSaved && id ? clone(store.profiles.find(saved => saved.id === id) || null) : null;
        comparisonRendered = {before:null, after:null};
        comparisonKept = new Map();
        select("#workspace-comparison").open = false;
        select("#workspace-comparison-before").replaceChildren();
        select("#workspace-comparison-after").replaceChildren();
        draftSelectionSetters = []; draftMonitorSetters = []; draftPositionSetters = []; browserStatusSetters = []; browserFocusSetters = [];
        select("#workspace-removed-items").replaceChildren();
        select("#workspace-removed").hidden = true;
        select("#workspace-removed").open = false;
        browserSetters = []; browserMissingSetters = [];
        inlineStatus("#workspace-tabs-status", "");
        displayWorkspaceSurface("editor");
        select("#workspace-editor-title").textContent = id ? `Edit “${store.profiles.find(p => p.id === id)?.name || profile.name}”` : "New workspace";
        select(".workspace-options").removeAttribute("open");
        select("#workspace-name").value = profile.name;
        select("#workspace-platform").value = profile.platform;
        select("#workspace-items").replaceChildren();
        select("#workspace-items-empty").hidden = profile.items.length > 0;
        refreshDisplayContext();
        const renderItem = (item, index) => {
            const fragment = select("#workspace-item-template").content.cloneNode(true);
            const itemCard = fragment.querySelector(".workspace-item");
            itemCard.dataset.index = String(index);
            fragment.querySelector(".window-title").textContent = item.label || item.window.title;
            const windowOptions = fragment.querySelector(".workspace-window-options");
            const windowToggle = fragment.querySelector(".workspace-item-toggle");
            const setWindowExpanded = expanded => { windowOptions.open = expanded; windowToggle.setAttribute("aria-expanded", String(expanded)); };
            windowToggle.addEventListener("click", () => setWindowExpanded(!windowOptions.open));
            fragment.querySelector(".include-window").setAttribute("aria-label", `Include ${item.label || item.window.title}`);
            const note = fragment.querySelector(".capture-note");
            note.textContent = item.captureNote || "";
            note.hidden = !item.captureNote;
            const rectInputs = [...fragment.querySelectorAll("[data-rect]")];
            const areaInputs = [...fragment.querySelectorAll("[data-area]")];
            const placement = fragment.querySelector(".window-placement");
            const position = fragment.querySelector(".window-position");
            const monitorFallback = fragment.querySelector(".monitor-number");
            const fallbackLabel = fragment.querySelector(".window-placement-fallback");
            const windowName = item.label || item.window.title || "window";
            // Native restore accepts a stable Windows display ID or a KWin output name.
            // Plasma 5 exposes numeric output names, which can change after reconnecting.
            const monitorIdentity = monitor => monitor ? (monitor.stable && monitor.id || monitor.sourceId || "") : "";
            placement.setAttribute("aria-label", `Monitor for ${windowName}`);
            position.setAttribute("aria-label", `Position for ${windowName}`);
            monitorFallback.setAttribute("aria-label", `Monitor number for ${windowName}`);
            const showMonitor = () => {
                const resolved = lookupSavedMonitor(item.window);
                const value = resolved.unavailable ? "unavailable" : String(resolved.monitor?.index || item.window.monitor);
                if (![...placement.options].some(option => option.value === value)) {
                    const option = document.createElement("option"); option.value = value; option.textContent = value === "unavailable" ? "Display unavailable" : `Monitor ${value} (unavailable)`; placement.append(option);
                }
                placement.value = value;
                monitorFallback.value = String(item.window.monitor);
            };
            const changeMonitor = value => {
                const number = Number(value);
                if (!Number.isInteger(number) || number < 1 || number > 100) { showMonitor(); return; }
                const target = displayContext.monitors.find(monitor => monitor.index === number);
                item.window.monitor = number;
                item.window.monitorName = monitorIdentity(target);
                draftDirty = true;
                showMonitor();
                showPosition();
            };
            const showPosition = () => {
                const area = positionArea(item.window), current = positionLabel(item.window, area);
                position.querySelector('option[value="custom"]').textContent = current.value === "custom" ? current.label : "Custom";
                position.value = current.value;
                position.disabled = working || !area;
                position.title = area ? "" : "Monitor dimensions are unavailable.";
            };
            position.addEventListener("change", () => {
                const area = positionArea(item.window), preset = area && positionPresets(area)[position.value];
                if (!preset) { showPosition(); return; }
                Object.assign(item.window.rect ||= {}, preset);
                Object.assign(item.window.workArea ||= {}, area);
                item.window.maximizedHorizontal = position.value === "fill";
                item.window.maximizedVertical = position.value === "fill";
                item.window.fullscreen = false; item.window.minimized = false; draftDirty = true;
                rectInputs.forEach(input => { input.value = item.window.rect[input.dataset.rect]; });
                areaInputs.forEach(input => { input.value = item.window.workArea[input.dataset.area]; });
                showPosition(); renderComparison();
            });
            draftPositionSetters[index] = showPosition;
            placement.addEventListener("change", () => changeMonitor(placement.value));
            monitorFallback.addEventListener("change", () => changeMonitor(monitorFallback.value));
            showMonitor();
            const updateMonitorChoices = () => {
                if (draft !== profile) return;
                const options = displayContext.monitors.length ? displayContext.monitors : displayContext.areas;
                if (!options?.length) { placement.hidden = true; fallbackLabel.hidden = false; return; }
                placement.hidden = false; fallbackLabel.hidden = true;
                placement.replaceChildren();
                options.slice(0, 100).forEach((monitor, number) => {
                    const index = monitor.index || number + 1;
                    const option = document.createElement("option"); option.value = String(index);
                    option.textContent = monitorLabel(displayContext.monitors.find(current => current.index === index)) || `Monitor ${index}`;
                    placement.append(option);
                });
                showMonitor();
                showPosition();
            };
            draftMonitorSetters[index] = updateMonitorChoices;
            updateMonitorChoices();
            fragment.querySelector(".set-position").addEventListener("click", () => perform(async () => {
                const result = await native.core.invoke("choose_position", {rect:clone(item.window.rect)});
                if (!result) return;
                await refreshDisplayContext();
                Object.assign(item.window.rect, result.rect);
                Object.assign(item.window.workArea ||= {}, result.workArea);
                item.window.monitor = result.monitor;
                const target = displayContext.monitors.find(monitor => ["x", "y", "width", "height"].every(key => monitor.geometry?.[key] === result.workArea[key]));
                item.window.monitorName = monitorIdentity(target);
                item.window.maximizedHorizontal = false;
                item.window.maximizedVertical = false;
                item.window.fullscreen = false;
                item.window.minimized = false;
                draftDirty = true;
                rectInputs.forEach(input => { input.value = result.rect[input.dataset.rect]; });
                areaInputs.forEach(input => { input.value = result.workArea[input.dataset.area]; });
                showMonitor();
                showPosition();
                renderComparison();
            }));
            fragment.querySelectorAll("[data-window], [data-rect], [data-area]").forEach(input => {
                const field = input.dataset.window || input.dataset.rect || input.dataset.area;
                const target = input.dataset.rect ? item.window.rect : input.dataset.area ? (item.window.workArea ||= {}) : item.window;
                input.value = target[field] ?? "";
                input.addEventListener("input", () => {
                    target[field] = input.type === "number" ? Number(input.value) : input.value;
                    if (field === "monitor") item.window.monitorName = "";
                    draftDirty = true; showPosition();
                });
            });
            const browserApp = chromiumApp(item.window.appId);
            if (item.browser || browserApp || firefoxApp(item.window.appId)) {
                const browser = item.browser || {kind:browserApp ? "chromium" : "firefox",profilePath:"",profileName:"",tabs:[],activeTab:1};
                const firefox = !browser.kind || browser.kind === "firefox";
                const browserName = firefox ? "Firefox" : chromiumName(item.window.appId || "");
                const connection = fragment.querySelector(".browser-connection-dot");
                connection.hidden = false;
                const updateConnection = () => {
                    const value = browserBridgeStatus && (firefox ? browserBridgeStatus.firefoxConnected : browserBridgeStatus.chromiumConnected);
                    const status = typeof value !== "boolean" ? "Status unavailable" : value ? "Connected" : "Not connected";
                    connection.dataset.status = typeof value !== "boolean" ? "unknown" : value ? "connected" : "disconnected";
                    connection.title = `Connection to ${browserName} extension: ${status}`;
                    connection.setAttribute("aria-label", `Connection to ${browserName} extension: ${status}. Open browser extension settings.`);
                };
                browserStatusSetters[index] = updateConnection;
                updateConnection();
                connection.addEventListener("click", () => openBrowserSettings());
                if (!browser.tabs.length) {
                    note.textContent = `${item.captureNote ? item.captureNote + " " : ""}No ${browserName} tabs are saved for this window.`;
                    note.hidden = false;
                }
                fragment.querySelector(".browser-settings").hidden = false;
                fragment.querySelector(".browser-advanced").hidden = false;
                const reviewTabs = fragment.querySelector(".review-browser-tabs");
                const browserSettings = fragment.querySelector(".browser-settings");
                browserSettings.addEventListener("input", () => markCapturedBrowserEdited(item));
                browserSettings.addEventListener("change", () => markCapturedBrowserEdited(item));
                browserSettings.addEventListener("click", event => { if (event.target.closest?.("button")) markCapturedBrowserEdited(item); });
                fragment.querySelector(".browser-advanced").addEventListener("input", () => markCapturedBrowserEdited(item));
                fragment.querySelector(".browser-advanced").addEventListener("change", () => markCapturedBrowserEdited(item));
                reviewTabs.hidden = !item.captureNote && !!browser.tabs.length;
                reviewTabs.addEventListener("click", () => {
                    setWindowExpanded(true);
                    browserSettings.scrollIntoView?.({block:"nearest"});
                });
                fragment.querySelector(".browser-summary").textContent = `${browserName} profile and tabs`;
                fragment.querySelector(".browser-restore-label").textContent = `Restore this ${browserName} profile and its tabs`;
                fragment.querySelector(".browser-profile-label").textContent = `${browserName} profile`;
                fragment.querySelector(".browser-restore-hint").textContent = firefox ? "Firefox reuses a window when its URLs match; otherwise it opens a new one. The selected tab is focused when possible." : "Existing browser windows are reused without changing their tabs. The selected tab is focused when possible.";
                fragment.querySelector(".workspace-browser-hint").textContent = firefox ? "Firefox can use its saved session without an extension; it may be out of date. A connected extension can provide newer tabs." : "For current Chrome or Chromium tabs, install and connect the browser extension. Review captured tabs before saving.";
                fragment.querySelector(".find-browser-tabs").hidden = !firefox;
                const restoreBrowser = fragment.querySelector(".restore-browser");
                restoreBrowser.checked = !!item.browser;
                restoreBrowser.addEventListener("change", event => {
                    item.browser = event.target.checked ? browser : null;
                    if (event.target.checked) ignoredBrowserTabs.delete(index); else ignoredBrowserTabs.add(index);
                    refreshBrowserGuide();
                });
                const profileSelect = fragment.querySelector(".browser-profile");
                const pathInput = fragment.querySelector('[data-browser="profilePath"]');
                const nameInput = fragment.querySelector('[data-browser="profileName"]');
                const tabsInput = fragment.querySelector('[data-browser="tabs"]');
                const activeInput = fragment.querySelector('[data-browser="activeTab"]');
                const sessionChoice = fragment.querySelector(".browser-session-choice");
                const sessionSelect = fragment.querySelector(".browser-session");
                const sessionStatus = fragment.querySelector(".browser-session-status");
                const tabCount = fragment.querySelector(".browser-tab-count");
                const tabSummary = fragment.querySelector(".window-tabs-summary");
                const focusedStatus = fragment.querySelector(".focused-tab-status");
                tabSummary.hidden = false;
                const currentStatus = fragment.querySelector(".browser-current-status");
                let focusedSignature = "";
                const showFocusedTab = () => {
                    const needsChoice = invalidFocusedTabs.has(item);
                    const signature = JSON.stringify([needsChoice, browser.activeTab, browser.tabs.map(tab => tab.url)]);
                    if (signature !== focusedSignature) {
                        focusedSignature = signature;
                        activeInput.replaceChildren();
                        if (!browser.tabs.length) {
                            const option = document.createElement("option"); option.value = ""; option.textContent = "No URLs saved"; activeInput.append(option);
                        } else {
                            if (needsChoice) { const option = document.createElement("option"); option.value = ""; option.textContent = "Choose a focused tab"; activeInput.append(option); }
                            browser.tabs.forEach((tab, number) => { const option = document.createElement("option"); option.value = String(number + 1); option.textContent = `${number + 1}. ${tab.url}`; activeInput.append(option); });
                            activeInput.value = needsChoice ? "" : String(browser.activeTab);
                        }
                        window.WarpErrorTimer.set(focusedStatus, needsChoice ? "The previously focused tab is missing or ambiguous. Choose a focused tab." : "", {error:needsChoice, hideWhenEmpty:true});
                    }
                    activeInput.disabled = working || !browser.tabs.length;
                };
                browserFocusSetters[index] = showFocusedTab;
                const showTabCount = () => {
                    const count = `${browser.tabs.length} ${browser.tabs.length === 1 ? "tab" : "tabs"}`;
                    tabSummary.textContent = browser.tabs.length ? count : "No tabs";
                    tabCount.textContent = `${count} saved · ${browser.profileName || (browser.profilePath ? "Captured profile" : "Browser default; profile not identified")}`;
                    showFocusedTab();
                };
                showTabCount();
                const applyCurrentTabs = current => {
                    if (!current || (current.kind || "firefox") !== (browser.kind || "firefox")) return false;
                    if (browser.profilePath && (!current.profilePath || profilePathKey(browser.profilePath) !== profilePathKey(current.profilePath))) return false;
                    if (!browser.profilePath && browser.profileName && browser.profileName !== current.profileName) return false;
                    const previous = browser.tabs, wasInvalid = invalidFocusedTabs.has(item), focused = preserveFocusedTab(previous, browser.activeTab, current.tabs);
                    browser.tabs = clone(current.tabs);
                    if (previous.length && browser.tabs.length && (!focused || (wasInvalid && browser.tabs.length > 1))) invalidFocusedTabs.add(item);
                    else { invalidFocusedTabs.delete(item); browser.activeTab = focused || current.activeTab || 1; }
                    draftDirty = true;
                    if (current.profilePath) {
                        browser.profilePath = pathInput.value = current.profilePath; browser.profileName = nameInput.value = current.profileName;
                        const option = [...profileSelect.options].find(option => option.value === current.profilePath);
                        profileSelect.options[0].textContent = current.profileName || "Captured profile";
                        profileSelect.value = option ? option.value : "";
                    }
                    item.browser = browser; restoreBrowser.checked = true; ignoredBrowserTabs.delete(index);
                    tabsInput.value = browser.tabs.map(tab => tab.url).join("\n");
                    item.captureNote = ""; note.textContent = ""; note.hidden = true;
                    reviewTabs.hidden = true; refreshBrowserGuide(); showTabCount(); renderComparison();
                    return true;
                };
                browserSetters[index] = applyCurrentTabs;
                browserMissingSetters[index] = () => {
                    note.textContent = browser.tabs.length ? "Current tabs couldn't be matched. Saved tabs were kept." : "Current tabs couldn't be matched for this window.";
                    note.hidden = false; reviewTabs.hidden = false;
                };
                const useCurrentTabs = () => {
                    window.WarpErrorTimer.set(currentStatus, "Getting current tabs…");
                    perform(async () => {
                        const current = await native.core.invoke("current_browser_tabs", {windowId:item.window.id, pid:item.window.pid});
                        if (!applyCurrentTabs(current)) throw new Error("No connected browser window matched. Use Update browser tabs to choose a desktop, or choose a window below.");
                        editedBrowserUrls.delete(item);
                        window.WarpErrorTimer.set(currentStatus, "Current tabs added. Save the workspace to keep them.");
                    }, error => window.WarpErrorTimer.set(currentStatus, errorText(error), {error:true}));
                };
                fragment.querySelector(".use-current-browser-tabs").addEventListener("click", () => {
                    if (editedBrowserUrls.has(item)) confirmTabUpdate(useCurrentTabs);
                    else useCurrentTabs();
                });
                let sessions = [];
                const clearSessions = () => { sessions = []; sessionChoice.hidden = true; window.WarpErrorTimer.set(sessionStatus, ""); };
                fragment.querySelector(".find-browser-tabs").addEventListener("click", () => {
                    const path = browser.profilePath;
                    clearSessions();
                    perform(async () => {
                    if (!path) throw new Error("Choose a Firefox profile or enter its folder first.");
                    sessions = await native.core.invoke("firefox_sessions", {profilePath:path});
                    if (path !== browser.profilePath) { clearSessions(); return; }
                    if (!sessions.length) { sessionStatus.textContent = "No saved Firefox windows with tabs were found."; return; }
                    sessionSelect.replaceChildren();
                    const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Choose a saved window"; sessionSelect.append(placeholder);
                    sessions.forEach((session, index) => {
                        const option = document.createElement("option");
                        option.value = String(index);
                        const active = session.tabs[session.activeTab - 1];
                        option.textContent = `${active?.title || active?.url || "Untitled window"} (${session.tabs.length} ${session.tabs.length === 1 ? "tab" : "tabs"})`;
                        sessionSelect.append(option);
                    });
                    sessionChoice.hidden = false;
                    sessionStatus.textContent = "Choose the window you want; Firefox's saved session may be out of date.";
                    }, error => {
                        if (path !== browser.profilePath) return;
                        window.WarpErrorTimer.set(sessionStatus, errorText(error), {error:true});
                    });
                });
                fragment.querySelector(".use-browser-session").addEventListener("click", () => {
                    if (sessionSelect.value === "") { window.WarpErrorTimer.set(sessionStatus, "Choose a saved Firefox window first.", {error:true}); return; }
                    const session = sessions[Number(sessionSelect.value)];
                    if (!session) return;
                    const useSession = () => {
                        browser.tabs = clone(session.tabs);
                        browser.activeTab = session.activeTab;
                        invalidFocusedTabs.delete(item); editedBrowserUrls.delete(item); draftDirty = true;
                        item.browser = browser; restoreBrowser.checked = true; ignoredBrowserTabs.delete(index);
                        showTabCount();
                        tabsInput.value = browser.tabs.map(tab => tab.url).join("\n");
                        item.captureNote = "";
                        note.textContent = ""; note.hidden = true;
                        reviewTabs.hidden = true; refreshBrowserGuide(); renderComparison();
                        window.WarpErrorTimer.set(sessionStatus, "Tabs added to this draft. Review them before saving.");
                    };
                    if (editedBrowserUrls.has(item)) confirmTabUpdate(useSession);
                    else useSession();
                });
                native.core.invoke("browser_profiles", {browser:firefox ? "firefox" : "chromium"}).then(profiles => {
                    const counts = new Map();
                    profiles.forEach(profile => counts.set(profile.name, (counts.get(profile.name) || 0) + 1));
                    const seen = new Map();
                    profiles.forEach(profile => {
                        const option = document.createElement("option");
                        option.value = profile.path;
                        const name = profile.name || "Unnamed profile";
                        const number = (seen.get(profile.name) || 0) + 1;
                        seen.set(profile.name, number);
                        option.textContent = name + (counts.get(profile.name) > 1 ? ` (${number})` : "");
                        option.title = profile.path;
                        profileSelect.append(option);
                    });
                    const current = profiles.find(p => profilePathKey(p.path) === profilePathKey(browser.profilePath) && browser.profilePath);
                    profileSelect.options[0].textContent = browser.profileName || (browser.profilePath ? "Captured profile" : "Browser default; profile not identified");
                    profileSelect.value = current ? current.path : "";
                    if (current) browser.profileName = nameInput.value = current.name;
                    profileSelect.addEventListener("change", () => {
                        const profile = profiles.find(p => p.path === profileSelect.value);
                        if (!profile) return;
                        browser.profilePath = pathInput.value = profile.path;
                        browser.profileName = nameInput.value = profile.name;
                        showTabCount();
                        clearSessions();
                    });
                }).catch(() => { profileSelect.options[0].textContent = "Profiles unavailable; use the fields below"; });
                fragment.querySelectorAll("[data-browser]").forEach(input => {
                    const field = input.dataset.browser;
                    if (field !== "activeTab") input.value = field === "tabs" ? browser.tabs.map(t => t.url).join("\n") : browser[field];
                    const changed = () => {
                        if (field === "tabs") {
                            editedBrowserUrls.add(item);
                            const previous = browser.tabs;
                            const next = input.value.split(/\r?\n/).map(url => url.trim()).filter(Boolean).map(url => ({url, title:previous.find(t => t.url === url)?.title || ""}));
                            const focused = invalidFocusedTabs.has(item) ? null : preserveFocusedTab(previous, browser.activeTab, next, true);
                            browser.tabs = next;
                            if (browser.tabs.length) { item.browser = browser; restoreBrowser.checked = true; ignoredBrowserTabs.delete(index); }
                            if (!browser.tabs.length) { invalidFocusedTabs.delete(item); browser.activeTab = 1; }
                            else if (browser.tabs.length === 1 || !previous.length) { invalidFocusedTabs.delete(item); browser.activeTab = 1; }
                            else if (focused) { invalidFocusedTabs.delete(item); browser.activeTab = focused; }
                            else invalidFocusedTabs.add(item);
                            showTabCount();
                            if (browser.tabs.length) { item.captureNote = ""; note.textContent = ""; note.hidden = true; }
                            else { note.textContent = `No ${browserName} URLs are saved for this window.`; note.hidden = false; }
                            reviewTabs.hidden = !!browser.tabs.length; refreshBrowserGuide();
                        } else if (field === "activeTab") {
                            const selected = Number(input.value);
                            if (selected >= 1 && selected <= browser.tabs.length) { browser.activeTab = selected; invalidFocusedTabs.delete(item); showFocusedTab(); }
                        } else browser[field] = input.value;
                        if (field === "profilePath" || field === "profileName") { profileSelect.value = ""; clearSessions(); }
                        draftDirty = true;
                    };
                    input.addEventListener("input", changed);
                    if (input.tagName === "SELECT") input.addEventListener("change", changed);
                });
                showFocusedTab();
            }
            const include = fragment.querySelector(".include-window");
            const bulk = fragment.querySelector(".draft-window-checkbox");
            bulk.dataset.index = String(index);
            bulk.setAttribute("aria-label", `Select ${windowName}`);
            bulk.addEventListener("change", () => { if (bulk.checked) selectedDraftWindows.add(index); else selectedDraftWindows.delete(index); controls(); });
            include.checked = selected[index];
            const remove = fragment.querySelector(".remove-workspace-window");
            remove.setAttribute("aria-label", `Remove ${windowName} from workspace`);
            const removedRow = document.createElement("div"); removedRow.className = "workspace-removed-row"; removedRow.hidden = true;
            const removedName = document.createElement("span"); removedName.textContent = windowName;
            const undo = document.createElement("button"); undo.type = "button"; undo.textContent = "Undo";
            undo.setAttribute("aria-label", `Restore ${windowName} to workspace`);
            removedRow.append(removedName, undo); select("#workspace-removed-items").append(removedRow);
            const setSelected = value => {
                if (value && !selected[index] && selected.filter(Boolean).length >= 100) {
                    include.checked = false;
                    inlineStatus("#workspace-editor-status", "A workspace can contain up to 100 windows.", true);
                    return false;
                }
                if (selected[index] !== value) draftDirty = true;
                selected[index] = value; include.checked = value; itemCard.hidden = !value; removedRow.hidden = value;
                if (!value) { selectedDraftWindows.delete(index); bulk.checked = false; }
                return true;
            };
            draftSelectionSetters[index] = setSelected;
            const changed = () => { count(); refreshBrowserGuide(); controls(); };
            remove.addEventListener("click", () => { setSelected(false); changed(); select("#workspace-removed").open = true; undo.focus(); });
            undo.addEventListener("click", () => { if (setSelected(true)) { changed(); remove.focus(); } });
            if (item.terminal) {
                const terminal = item.terminal;
                fragment.querySelector(".terminal-settings").hidden = false;
                // Keep references after the DocumentFragment is inserted into the page.
                const summary = fragment.querySelector(".terminal-summary");
                const wslFields = fragment.querySelector(".wsl-settings");
                const konsoleFields = fragment.querySelector(".konsole-profile");
                const terminalFields = () => {
                    summary.textContent = terminal.kind === "konsole" ? "Konsole session" : "Windows Terminal session";
                    wslFields.hidden = terminal.kind !== "windows-terminal" && !terminal.wslDistro && !terminal.wslUser;
                    konsoleFields.hidden = terminal.kind !== "konsole";
                };
                terminalFields();
                fragment.querySelector(".restore-terminal").addEventListener("change", event => { item.terminal = event.target.checked ? terminal : null; });
                fragment.querySelectorAll("[data-terminal]").forEach(input => {
                    const field = input.dataset.terminal;
                    input.value = field === "shellArgs" ? terminal.shellArgs.join("\n") : terminal[field] || "";
                    input.addEventListener("input", () => {
                        terminal[field] = field === "shellArgs" ? input.value.split(/\r?\n/).filter(Boolean) : input.value;
                        if (["kind", "wslDistro", "wslUser"].includes(field)) {
                            terminalFields();
                        }
                    });
                });
            }
            include.addEventListener("change", () => { setSelected(include.checked); changed(); });
            item.launch.kind ||= "executable";
            const launchTargetLabel = fragment.querySelector(".launch-target-label");
            const launchArgsLabel = fragment.querySelector(".launch-args-label");
            const launchHint = fragment.querySelector(".launch-hint");
            const launchFields = () => {
                const kind = item.launch.kind;
                launchTargetLabel.textContent = kind === "desktop-entry" ? "Desktop entry ID" : kind === "packaged-app" ? "Application user model ID (AUMID)" : "Program";
                launchArgsLabel.textContent = kind === "desktop-entry" ? "Documents / URLs (one per line)" : "Arguments (one per line)";
                launchHint.textContent = kind === "executable" ? "Apps that reuse an existing window may not support opening a new one." : "The app controls whether activation opens a new window. Clear Working directory; the app or desktop entry supplies it.";
            };
            launchFields();
            fragment.querySelectorAll("[data-launch]").forEach(input => {
                const field = input.dataset.launch;
                if (field === "newWindow") input.checked = item.launch.newWindow;
                else input.value = field === "args" ? item.launch.args.join("\n") : item.launch[field];
                input.addEventListener("input", () => {
                    item.launch[field] = field === "newWindow" ? input.checked : field === "args" ? input.value.split(/\r?\n/).filter(line => line !== "") : input.value;
                    if (field === "kind") launchFields();
                });
            });
            fragment.querySelectorAll("input, textarea, select").forEach(input => {
                input.addEventListener("input", renderComparison);
                input.addEventListener("change", renderComparison);
            });
            select("#workspace-items").append(fragment);
        };
        profile.items.forEach(renderItem);
        appendDraftWindow = item => {
            if (draft !== profile) return false;
            const existing = profile.items.findIndex(saved => samePhysicalWindow(saved, item));
            if (existing >= 0) {
                const wasSelected = selected[existing];
                if (!draftSelectionSetters[existing](true)) return false;
                inlineStatus("#workspace-editor-status", wasSelected ? "That window is already in this workspace." : "Window added back to this workspace.");
                count(); refreshBrowserGuide(); controls();
                return false;
            }
            if (selected.filter(Boolean).length >= 100) { inlineStatus("#workspace-editor-status", "A workspace can contain up to 100 windows.", true); return false; }
            profile.items.push(item); selected.push(true);
            draftDirty = true;
            renderItem(item, profile.items.length - 1);
            select("#workspace-items-empty").hidden = true;
            inlineStatus("#workspace-editor-status", "");
            count(); refreshBrowserGuide(); controls();
            return true;
        };
        count(); refreshBrowserGuide(); controls(); refreshBridgeStatus();
        select("#workspace-editor").scrollIntoView?.({block:"start"});
        focusWhenReady(() => { if (draft === profile && workspaceSurface === "editor") select("#workspace-name").focus(); });
    }
    function count() {
        const total = selected.filter(Boolean).length;
        const removed = selected.length - total;
        select("#workspace-item-count").textContent = `${total} ${total === 1 ? "window" : "windows"} selected`;
        select("#workspace-removed").hidden = !removed;
        select("#workspace-removed-heading").textContent = `Removed windows (${removed})`;
        const empty = select("#workspace-items-empty");
        empty.hidden = !!total;
        empty.textContent = selected.length ? "All windows were removed. Add a window or restore one below." : "No windows were captured. Open the windows you want, then capture again.";
        renderComparison();
    }
    select("#select-draft-windows").addEventListener("click", () => {
        selectingDraftWindows = !selectingDraftWindows;
        if (!selectingDraftWindows) selectedDraftWindows.clear();
        controls();
        if (selectingDraftWindows) select("#select-all-draft-windows").focus();
    });
    select("#select-all-draft-windows").addEventListener("click", () => {
        const allSelected = selectedDraftWindows.size && selectedDraftWindows.size === selected.filter(Boolean).length;
        selectedDraftWindows.clear();
        if (!allSelected) selected.forEach((value, index) => { if (value) selectedDraftWindows.add(index); });
        document.querySelectorAll(".draft-window-checkbox").forEach(box => { box.checked = selectedDraftWindows.has(Number(box.dataset.index)); });
        controls();
    });
    select("#remove-selected-draft-windows").addEventListener("click", () => {
        for (const index of selectedDraftWindows) draftSelectionSetters[index]?.(false);
        selectedDraftWindows.clear(); selectingDraftWindows = false;
        count(); refreshBrowserGuide(); controls();
        select("#workspace-removed").open = true;
        select("#restore-all-workspace-windows").focus();
    });
    select("#restore-all-workspace-windows").addEventListener("click", () => {
        draftSelectionSetters.forEach(set => set(true));
        count(); refreshBrowserGuide(); controls();
        (selected.every(Boolean) ? select("#select-draft-windows") : select("#restore-all-workspace-windows")).focus();
    });
    select("#workspace-editor").addEventListener("input", () => { if (draft) draftDirty = true; });
    select("#workspace-editor").addEventListener("change", () => { if (draft) draftDirty = true; });
    select("#workspace-name").addEventListener("input", renderComparison);
    select("#workspace-platform").addEventListener("change", renderComparison);
    select("#workspace-back-to-library").addEventListener("click", () => {
        if (workspaceSurface === "choice") { pendingCapture = null; currentCapture = null; }
        const cancel = pendingDraftCancel;
        select("#workspace-recapture").hidden = true; select("#workspace-capture-pending").hidden = true; pendingDraftAction = null; pendingDraftCancel = null; cancel?.();
        displayWorkspaceSurface("library");
        (draft ? select("#workspace-resume-draft") : select("#capture-workspace")).focus({preventScroll:true});
    });
    select("#workspace-resume-draft").addEventListener("click", () => {
        if (!draft) return;
        displayWorkspaceSurface("editor");
        select("#workspace-name").focus({preventScroll:true});
    });
    function tabFailureMessage(failure) {
        if (failure === "extensionDidNotRespond") return "The browser extension didn't respond. Open it in the profile for this window, then try again. Saved URLs were kept.";
        return "The connected extension couldn't identify this window. Check that it's connected in the same browser profile. Saved URLs were kept.";
    }
    function tabUpdateMessage(updated, unmatched, source, failure) {
        if (!updated) return tabFailureMessage(failure);
        return `${updated} ${updated === 1 ? "window" : "windows"} updated${source ? ` from ${source}` : ""}.${unmatched ? ` ${unmatched} couldn't be matched; saved URLs were kept.` : ""}`;
    }
    function confirmTabUpdate(action) {
        pendingTabUpdate = action;
        select("#workspace-tabs-confirm").hidden = false;
        select("#workspace-tabs-confirm").scrollIntoView?.({block:"nearest"});
        select("#workspace-tabs-keep").focus();
    }
    select("#workspace-tabs-keep").addEventListener("click", () => { pendingTabUpdate = null; select("#workspace-tabs-confirm").hidden = true; select("#refresh-workspace-tabs").focus(); });
    select("#workspace-tabs-replace").addEventListener("click", () => { const action = pendingTabUpdate; pendingTabUpdate = null; select("#workspace-tabs-confirm").hidden = true; action?.(); });
    function refreshDraftTabs(indices = null, confirmed = false) {
        if (!draft || working) return;
        const eligible = (item, index) => wantsTabs(item, index) && (!indices || indices.has(index));
        const total = draft.items.filter(eligible).length;
        if (!total) return;
        if (!confirmed && draft.items.some((item, index) => eligible(item, index) && editedBrowserUrls.has(item))) { confirmTabUpdate(() => refreshDraftTabs(indices, true)); return; }
        draft.items.forEach((item, index) => { if (eligible(item, index)) markCapturedBrowserEdited(item); });
        const targetDraft = draft;
        inlineStatus("#workspace-tabs-status", "Finding browser windows…");
        const apply = async source => {
            if (draft !== targetDraft) return;
            inlineStatus("#workspace-tabs-status", "Getting current URLs…");
            const result = await native.core.invoke("current_workspace_tabs", {profile:clone(draft), desktopId:source?.id || null});
            let updated = 0;
            const matched = new Set();
            for (const update of result.updates) {
                if (eligible(draft.items[update.index], update.index) && browserSetters[update.index]?.(update.browser)) { updated++; matched.add(update.index); editedBrowserUrls.delete(draft.items[update.index]); }
            }
            draft.items.forEach((item, index) => { if (eligible(item, index) && !matched.has(index)) browserMissingSetters[index]?.(); });
            const message = tabUpdateMessage(updated, total - updated, source?.name, result.failure);
            inlineStatus("#workspace-tabs-status", message, !updated);
            await refreshBridgeStatus();
        };
        const report = error => { inlineStatus("#workspace-tabs-status", String(error), true); };
        perform(async () => {
            const sources = await browserSources(targetDraft);
            if (sources.length > 1) {
                if (indices) { inlineStatus("#workspace-tabs-status", "Choose a desktop to update URLs."); return; }
                inlineStatus("#workspace-tabs-status", "");
                showSourceMenu(select("#workspace-draft-sources"), sources, source => perform(() => apply(source), report));
            } else await apply(sources[0]);
        }, report);
    }
    function finishHotkeyChoice(mode, targetId = null, focus = true) {
        if (!pendingCapture) return;
        const capture = pendingCapture;
        const target = store.profiles.find(p => p.id === (targetId ?? select("#workspace-hotkey-target").value));
        if (mode !== "new" && !target) { inlineStatus("#workspace-hotkey-status", "Select a workspace to update.", true); return; }
        if (mode !== "new" && pendingSavedTabRefreshes.has(target.id)) { inlineStatus("#workspace-hotkey-status", "Updating URLs for this workspace. Try again when it finishes.", true); return; }
        if (currentCapture?.pending && mode !== "urls") {
            currentCapture.choice = {mode, targetId:target?.id || ""};
            currentCapture.awaitingReplacement = false;
            const profile = clone(capture.profile);
            if (target && mode === "update") profile.name = target.name;
            if (mode === "update") keepKnownBrowserTabs(profile, target);
            openDraft(profile, mode === "new" ? "" : target.id, mode !== "new");
            currentCapture.draftJob = beginDraftCapture(profile, currentCapture.id);
            if (focus) focusWhenReady(() => { if (workspaceSurface === "editor") select("#workspace-name").focus(); });
            return;
        }
        const profile = clone(mode === "urls" ? target : capture.profile);
        if (target && mode === "update") profile.name = target.name;
        if (mode === "update") keepKnownBrowserTabs(profile, target);
        pendingCapture = null;
        select("#workspace-hotkey-choice").hidden = true;
        openDraft(profile, mode === "new" ? "" : target.id, mode !== "new");
        currentCapture = null;
        if (mode === "urls") {
            pendingTabRefresh = true;
            if (!working) { pendingTabRefresh = false; refreshDraftTabs(); }
        }
        if (focus) focusWhenReady(() => { if (workspaceSurface === "editor") select("#workspace-name").focus(); });
    }
    select("#workspace-hotkey-new").addEventListener("click", () => finishHotkeyChoice("new"));
    select("#workspace-hotkey-urls").addEventListener("click", () => finishHotkeyChoice("urls"));
    select("#workspace-hotkey-update").addEventListener("click", () => finishHotkeyChoice("update"));
    select("#workspace-hotkey-target").addEventListener("change", () => inlineStatus("#workspace-hotkey-status", ""));
    const openBrowserSettings = () => {
        select("#show-settings").click();
        select("#browser-extensions-settings").open = true;
        select("#browser-extensions-settings").scrollIntoView?.({block:"start"});
    };
    select("#refresh-workspace-tabs").addEventListener("click", () => refreshDraftTabs());
    function addCapturedWindow(item) {
        if (!draft || !item || !appendDraftWindow?.(item)) return;
        if (!isBrowserItem(item)) return;
        const job = beginDraftCapture(draft, null, [item]);
        const profile = clone(draft); profile.items = [clone(item)];
        native.core.invoke("enrich_workspace_capture", {profile})
            .then(enriched => finishDraftCapture(job, enriched), error => finishDraftCapture(job, null, error));
    }
    const addWindowButton = select("#add-workspace-window"), addWindowMenu = select("#workspace-add-menu");
    const windowList = select("#workspace-add-window-list");
    const windowListButton = select("#workspace-add-from-list");
    const closeAddWindowMenu = () => { addWindowMenu.hidden = true; addWindowButton.setAttribute("aria-expanded", "false"); };
    const closeWindowList = () => { windowList.hidden = true; windowListButton.setAttribute("aria-expanded", "false"); addWindowButton.setAttribute("aria-expanded", "false"); };
    addWindowButton.addEventListener("click", event => {
        event.stopPropagation();
        const open = addWindowMenu.hidden && windowList.hidden;
        document.querySelectorAll(".menu").forEach(menu => { menu.hidden = true; });
        closeWindowList(); addWindowMenu.hidden = !open;
        addWindowButton.setAttribute("aria-expanded", String(open));
        if (open) select("#workspace-pick-on-screen").focus();
    });
    select("#workspace-pick-on-screen").addEventListener("click", () => {
        if (!draft) return;
        closeAddWindowMenu();
        const targetDraft = draft;
        inlineStatus("#workspace-editor-status", "Click an app window to add it, or press Escape to cancel.");
        perform(async () => {
            const item = await native.core.invoke("pick_workspace_window");
            if (draft !== targetDraft) return;
            inlineStatus("#workspace-editor-status", "");
            addCapturedWindow(item);
        }, error => inlineStatus("#workspace-editor-status", errorText(error), true));
    });
    windowListButton.addEventListener("click", event => {
        event.stopPropagation();
        if (!windowList.hidden) { closeWindowList(); return; }
        const targetDraft = draft;
        closeAddWindowMenu();
        windowList.replaceChildren();
        const loading = document.createElement("p"); loading.className = "workspace-tabs-loading"; loading.setAttribute("role", "status");
        const spinner = document.createElement("span"); spinner.className = "workspace-spinner"; spinner.setAttribute("aria-hidden", "true");
        loading.append(spinner, document.createTextNode("Finding open windows…")); windowList.append(loading);
        windowList.hidden = false; windowListButton.setAttribute("aria-expanded", "true"); addWindowButton.setAttribute("aria-expanded", "true");
        perform(async () => {
            const windows = await native.core.invoke("workspace_open_windows");
            if (draft !== targetDraft) { closeWindowList(); return; }
            windowList.replaceChildren();
            const choices = [];
            for (const item of windows) {
                const label = document.createElement("label"), box = document.createElement("input"), content = document.createElement("span");
                const name = document.createElement("strong"), app = document.createElement("small");
                box.type = "checkbox"; name.textContent = item.label || item.window.title || item.window.appId || "Window";
                const identity = String(item.window.appId || item.window.path || "").replace(/\\/g, "/").split("/").pop().replace(/\.(exe|desktop)$/i, "");
                app.textContent = identity;
                content.append(name); if (identity && identity !== name.textContent) content.append(app);
                label.append(box, content); windowList.append(label); choices.push({box, item});
                box.addEventListener("change", () => { add.disabled = !choices.some(choice => choice.box.checked); });
            }
            if (!windows.length) { const note = document.createElement("p"); note.textContent = "No open windows found."; windowList.append(note); }
            const add = document.createElement("button"); add.type = "button"; add.className = "add-selected-windows"; add.textContent = "Add selected windows"; add.disabled = true;
            add.addEventListener("click", () => {
                for (const choice of choices) if (choice.box.checked) addCapturedWindow(choice.item);
                closeWindowList(); addWindowButton.focus();
            });
            if (windows.length) windowList.append(add);
            focusWhenReady(() => { if (!windowList.hidden) windowList.querySelector("input")?.focus(); });
        }, error => { closeWindowList(); inlineStatus("#workspace-editor-status", errorText(error), true); addWindowButton.focus(); });
    });
    const dismissWindowList = event => {
        if (event.key === "Escape" && (!windowList.hidden || !addWindowMenu.hidden)) { event.preventDefault(); closeWindowList(); closeAddWindowMenu(); addWindowButton.focus(); }
    };
    windowList.addEventListener("keydown", dismissWindowList);
    windowListButton.addEventListener("keydown", dismissWindowList);
    addWindowMenu.addEventListener("keydown", dismissWindowList);
    addWindowButton.addEventListener("keydown", dismissWindowList);
    select("#workspace-hotkey-cancel").addEventListener("click", () => { pendingCapture = null; currentCapture = null; displayWorkspaceSurface("library"); select("#capture-workspace").focus({preventScroll:true}); });
    select("#workspace-capture-cancel").addEventListener("click", () => { pendingCapture = null; currentCapture = null; select("#workspace-capture-pending").hidden = true; displayWorkspaceSurface(draft ? "editor" : "library"); });
    function capture(id = "", confirmed = false) {
        if (draft && !confirmed) { replaceDraft(() => capture(id, true)); return; }
        currentCapture = null;
        pendingCapture = null;
        select("#workspace-capture-pending").hidden = true;
        select("#workspace-hotkey-choice").hidden = true;
        perform(async () => {
            inlineStatus("#workspace-status", "Capturing…");
            const existing = store.profiles.find(p => p.id === id);
            const capture = await native.core.invoke("start_workspace_capture", {name:existing?.name || "New workspace"});
            keepKnownBrowserTabs(capture.profile, existing);
            openDraft(capture.profile, id, !!id);
            const job = beginDraftCapture(draft);
            native.core.invoke("enrich_workspace_capture", {profile:clone(draft)})
                .then(profile => finishDraftCapture(job, profile), error => finishDraftCapture(job, null, error));
            inlineStatus("#workspace-status", "");
            if (!id) focusWhenReady(() => { if (workspaceSurface === "editor") { select("#workspace-name").focus(); select("#workspace-name").select?.(); } });
        }, error => inlineStatus("#workspace-status", String(error), true));
    }
    function chooseWorkspaceDesktop(profile, card, locations) {
        const choice = card.querySelector(".workspace-open-choice");
        choice.replaceChildren();
        const prompt = document.createElement("p");
        prompt.textContent = "Workspace windows are already open on another desktop.";
        choice.append(prompt);
        locations.forEach(location => {
            const row = document.createElement("div"); row.className = "workspace-open-choice-row";
            const name = document.createElement("span"); name.textContent = `${location.name} · ${location.windowCount} ${location.windowCount === 1 ? "window" : "windows"}`;
            const move = document.createElement("button"); move.type = "button"; move.textContent = "Move here";
            move.setAttribute("aria-label", `Move windows from ${location.name} here`);
            move.addEventListener("click", () => restore(profile, card, {action:"move", id:location.id}));
            const go = document.createElement("button"); go.type = "button"; go.textContent = "Go there";
            go.setAttribute("aria-label", `Go to ${location.name}`);
            go.addEventListener("click", () => restore(profile, card, {action:"go", id:location.id}));
            row.append(name, move, go); choice.append(row);
        });
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => { choice.hidden = true; card.querySelector('[data-action="restore"]').focus(); });
        choice.append(cancel); choice.hidden = false;
    }
    async function restore(profile, card, decision = null) {
        perform(async () => {
            const details = card.querySelector(".workspace-card-results");
            details.replaceChildren();
            const choice = card.querySelector(".workspace-open-choice"); choice.hidden = true;
            const status = card.querySelector(".workspace-card-status");
            setStatus(status, decision?.action === "move" ? "Moving…" : "Checking…");
            try {
                if (decision?.action === "go") {
                    await native.core.invoke("workspace_go_to_desktop", {workspaceId:profile.id, desktopId:decision.id});
                    setStatus(status, "");
                    return;
                }
                if (decision?.action === "move") await native.core.invoke("workspace_move_to_desktop", {workspaceId:profile.id, desktopId:decision.id});
                const other = (await native.core.invoke("workspace_open_locations", {workspaceId:profile.id})).filter(location => !location.current);
                if (other.length) {
                    setStatus(status, "");
                    chooseWorkspaceDesktop(profile, card, other);
                    return;
                }
                select("#cancel-restore").hidden = false;
                status.textContent = "Opening…";
                const results = await native.core.invoke("restore_workspace", {id:profile.id});
                results.filter(result => !result.restored || result.warning).forEach(result => {
                    const row = document.createElement("p");
                    row.className = result.restored ? "workspace-result warning" : "workspace-result error";
                    row.textContent = `${result.label}${result.error ? ": " + errorText(result.error) : ""}${result.warning ? ": " + result.warning : ""}`;
                    details.append(row);
                    if (!result.restored) window.WarpErrorTimer.start(row, () => row.remove());
                });
                setStatus(status, `Opened ${results.filter(r => r.restored).length} of ${profile.items.length} windows.${results.some(r => r.warning || !r.restored) ? " See details below." : ""}`, results.some(r => !r.restored));
                await refreshWorkspaceLocations();
            } finally { select("#cancel-restore").hidden = true; }
        }, error => setStatus(card.querySelector(".workspace-card-status"), error, true));
    }
    function saveWorkspace(onSaved = null) {
        if (onSaved) afterSaveAction = onSaved;
        inlineStatus("#workspace-save-status", "");
        const invalid = draft?.items.findIndex((item, index) => selected[index] && item.browser && invalidFocusedTabs.has(item)) ?? -1;
        if (invalid >= 0) {
            const card = select(`#workspace-items .workspace-item[data-index="${invalid}"]`);
            card.querySelector(".workspace-window-options").open = true;
            card.querySelector(".workspace-item-toggle").setAttribute("aria-expanded", "true");
            card.querySelector(".workspace-advanced").open = true;
            inlineStatus("#workspace-save-status", "Choose a focused browser tab before saving.", true);
            card.querySelector('[data-browser="activeTab"]').focus();
            afterSaveAction = null;
            return;
        }
        if ([...draftCaptures].some(job => job.profile === draft)) {
            saveAfterCapture = true;
            inlineStatus("#workspace-save-status", "Saving when URLs finish loading…");
            return;
        }
        let savedId = null;
        inlineStatus("#workspace-save-status", "Saving workspace…");
        perform(async () => {
            const draftChanged = () => editingId && (browserUpdateUnknown || browserUpdatedIds.has(editingId));
            if (browserUpdatePending && draftChanged()) throw new Error("Browser URLs changed while this draft was open. Cancel and reopen the workspace to avoid overwriting them.");
            if (browserUpdatePending) {
                await refreshPendingWorkspaceStore();
                if (browserUpdatePending && draftChanged()) throw new Error("Browser URLs changed while this draft was open. Cancel and reopen the workspace to avoid overwriting them.");
            }
            const profile = clone(draft);
            profile.name = select("#workspace-name").value.trim();
            profile.platform = select("#workspace-platform").value;
            if (!profile.name) throw new Error("Give this workspace a name.");
            profile.items = profile.items.filter((_, index) => selected[index]);
            if (!profile.items.length) throw new Error("Select at least one window.");
            const next = clone(store);
            if (editingId) {
                const index = next.profiles.findIndex(p => p.id === editingId);
                if (index < 0) throw new Error("The selected workspace no longer exists.");
                profile.id = editingId; next.profiles[index] = profile;
            } else next.profiles.push(profile);
            await persist(next);
            draft = null;
            pendingDraftAction = null;
            select("#workspace-recapture").hidden = true;
            displayWorkspaceSurface("library");
            savedId = profile.id;
            const savedCard = [...select("#workspace-list").querySelectorAll(".workspace-card")].find(card => card.dataset.workspaceId === profile.id);
            if (savedCard) { const status = savedCard.querySelector(".workspace-card-status"); status.hidden = false; status.textContent = "Saved."; }
            const action = afterSaveAction; afterSaveAction = null;
            if (action) { savedId = null; action(); }
        }, error => { afterSaveAction = null; inlineStatus("#workspace-save-status", String(error), true); }).then(() => {
            if (savedId) focusWhenReady(() => (savedWorkspaceCard(savedId)?.querySelector(".workspace-preview-toggle") || select("#capture-workspace")).focus());
        });
    }
    select("#save-workspace").addEventListener("click", () => {
        if (replacingSaved && editingId) {
            const original = store.profiles.find(profile => profile.id === editingId);
            select("#workspace-replace-saved-message").textContent = `Replace the saved workspace “${original?.name || select("#workspace-name").value}”?`;
            select("#workspace-replace-saved").hidden = false;
            select("#workspace-replace-saved").scrollIntoView?.({block:"nearest"});
            select("#workspace-replace-cancel").focus();
        } else saveWorkspace();
    });
    select("#workspace-replace-cancel").addEventListener("click", () => { select("#workspace-replace-saved").hidden = true; });
    select("#workspace-replace-confirm").addEventListener("click", () => { select("#workspace-replace-saved").hidden = true; saveWorkspace(); });
    select("#discard-workspace").addEventListener("click", () => { draft = null; draftCaptures.clear(); saveAfterCapture = false; afterSaveAction = null; currentCapture = null; pendingCapture = null; pendingDraftAction = null; select("#workspace-tabs-loading").hidden = true; select("#workspace-recapture").hidden = true; displayWorkspaceSurface("library"); controls(); refreshBrowserUpdate(); select("#capture-workspace").focus({preventScroll:true}); });
    select("#workspace-keep-draft").addEventListener("click", () => { const cancel = pendingDraftCancel; pendingDraftAction = null; pendingDraftCancel = null; select("#workspace-recapture").hidden = true; cancel?.(); if (draft) { displayWorkspaceSurface("editor"); select("#workspace-name").focus(); } });
    select("#workspace-recapture-confirm").addEventListener("click", () => {
        const action = pendingDraftAction;
        pendingDraftAction = null;
        pendingDraftCancel = null;
        select("#workspace-recapture").hidden = true;
        action?.();
    });
    select("#capture-workspace").addEventListener("click", () => capture());
    select("#cancel-restore").addEventListener("click", async () => {
        try { await native.core.invoke("cancel_workspace_restore"); inlineStatus("#workspace-status", "Stopping…"); }
        catch (error) { say(String(error), true); }
    });
    const showPage = page => {
        for (const name of ["shortcuts", "workspaces", "settings"]) {
            const el = select("#" + name + "-page");
            el.hidden = name !== page;
            el.classList.remove("is-entering");
            if (name === page) {
                if (typeof el.offsetWidth === "number") void el.offsetWidth;
                el.classList.add("is-entering");
            }
            select("#show-" + name).classList.toggle("active", name === page);
        }
    };
    document.addEventListener("click", event => {
        if (event.target.closest?.(".menu, .menu-button")) return;
        document.querySelectorAll(".menu").forEach(menu => { menu.hidden = true; });
        closeWindowList(); closeAddWindowMenu();
    });
    select("#show-shortcuts").addEventListener("click", () => showPage("shortcuts"));
    select("#show-settings").addEventListener("click", () => {
        if (draft) bridgeBeforeSettings = browserBridgeStatus;
        showPage("settings");
    });
    function showCaptureChoices() {
        select("#workspace-capture-pending").hidden = true;
        const picker = select("#workspace-hotkey-target");
        picker.replaceChildren();
        const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Choose a workspace"; picker.append(placeholder);
        store.profiles.forEach(profile => { const option = document.createElement("option"); option.value = profile.id; option.textContent = profile.name + (profile.id === pendingCapture.suggestedId ? " (suggested)" : ""); picker.append(option); });
        if (store.profiles.some(p => p.id === pendingCapture.suggestedId)) picker.value = pendingCapture.suggestedId;
        else if (store.profiles.length === 1) picker.value = store.profiles[0].id;
        inlineStatus("#workspace-hotkey-status", "");
        displayWorkspaceSurface("choice");
        select("#workspace-hotkey-choice").scrollIntoView?.({block:"start"});
        focusWhenReady(() => { if (workspaceSurface === "choice") select("#workspace-hotkey-new").focus({preventScroll:true}); });
    }
    function receiveWorkspaceRequest(request) {
        showPage("workspaces");
        if (request.action === "open-workspaces" && request.capturing) inlineStatus("#workspace-status", "Capturing…");
        else if (["update-workspace", "workspace-capture-failed"].includes(request.action)) inlineStatus("#workspace-status", "");
        if (working) {
            if (["update-workspace", "workspace-capture-failed"].includes(request.action) && (!queuedWorkspaceRequest || (request.captureId || 0) >= (queuedWorkspaceRequest.captureId || 0))) queuedWorkspaceRequest = request;
            return;
        }
        perform(async () => {
            if (!store) { store = await native.core.invoke("get_workspaces"); render(); }
            if (request.captureId && request.captureId < latestCaptureId) return;
            if (request.action === "workspace-capture-failed") {
                if (request.captureId === latestCaptureId && !currentCapture) return;
                if (currentCapture?.draftJob) finishDraftCapture(currentCapture.draftJob, null, request.error);
                latestCaptureId = request.captureId;
                currentCapture = null; pendingCapture = null; pendingDraftAction = null; pendingDraftCancel = null;
                select("#workspace-hotkey-choice").hidden = true;
                select("#workspace-recapture").hidden = true;
                select("#workspace-capture-pending-message").textContent = "Capture failed. Press the shortcut to try again.";
                select("#workspace-capture-pending").hidden = !!draft;
                say(request.error || "Could not capture the workspace.", true);
                return;
            }
            if (request.action !== "update-workspace") {
                return;
            }
            if (request.captureId && request.capturing) {
                latestCaptureId = request.captureId;
                for (const job of [...draftCaptures]) if (job.captureId) finishDraftCapture(job, null, "Capture interrupted");
                const hadDraft = !!draft;
                currentCapture = {id:request.captureId, pending:true, choice:null, awaitingReplacement:false};
                pendingCapture = request.capture;
                if (hadDraft) {
                    currentCapture.awaitingReplacement = true;
                    const id = request.captureId;
                    replaceDraft(() => perform(async () => {
                        await refreshPendingWorkspaceStore();
                        if (currentCapture?.id === id) finishHotkeyChoice("new");
                    }), () => {
                        if (currentCapture?.id === id) { currentCapture = null; pendingCapture = null; }
                    });
                } else if (!store.profiles.length) finishHotkeyChoice("new");
                else showCaptureChoices();
                return;
            }
            if (request.captureId && request.captureId === latestCaptureId) {
                if (!currentCapture || currentCapture.id !== request.captureId) return;
                const choice = currentCapture.choice;
                currentCapture.pending = false;
                pendingCapture = request.capture;
                if (currentCapture.awaitingReplacement) return;
                if (currentCapture.draftJob) {
                    finishDraftCapture(currentCapture.draftJob, request.capture.profile);
                    currentCapture = null; pendingCapture = null;
                    return;
                }
                if (choice) finishHotkeyChoice(choice.mode, choice.targetId);
                else {
                    const picker = select("#workspace-hotkey-target");
                    if (!picker.value && store.profiles.some(p => p.id === request.capture.suggestedId)) picker.value = request.capture.suggestedId;
                }
                return;
            }
            if (request.captureId) latestCaptureId = request.captureId;
            if (draft) {
                replaceDraft(() => perform(() => useRecapture(request.capture)));
                return;
            }
            pendingCapture = request.capture;
            if (!store.profiles.length) { finishHotkeyChoice("new"); return; }
            showCaptureChoices();
        });
    }
    window.addEventListener("warp-workspace-request", event => receiveWorkspaceRequest(event.detail));
    window.addEventListener("focus", () => { if (!select("#workspaces-page").hidden) { refreshWorkspaceLocations(); refreshDisplayContext(); if (draft) refreshBridgeStatus(); } });
    const bridgePoll = window.setInterval?.(() => { if (native && draft && !select("#workspaces-page").hidden && draft.items.some(isBrowserItem)) refreshBridgeStatus(); }, 15000);
    bridgePoll?.unref?.();
    window.addEventListener("warp-desktop-changed", () => { if (!select("#workspaces-page").hidden) { refreshWorkspaceLocations(); refreshDisplayContext(); } });
    window.addEventListener("warp-browser-updated", event => {
        browserUpdateSequence++;
        browserUpdatePending = true;
        if (typeof event.detail === "string" && event.detail) browserUpdatedIds.add(event.detail);
        else browserUpdateUnknown = true;
        if (draft && editingId && (browserUpdateUnknown || browserUpdatedIds.has(editingId))) {
            const message = "Browser URLs changed while this draft was open. Cancel and reopen it to keep the newer URLs.";
            inlineStatus("#workspace-save-status", message, true);
        }
        else if (!draft) refreshBrowserUpdate();
    });
    select("#show-workspaces").addEventListener("click", async () => {
        showPage("workspaces");
        refreshWorkspaceLocations();
        refreshDisplayContext();
        const before = bridgeBeforeSettings;
        bridgeBeforeSettings = null;
        if (native) {
            const status = await refreshBridgeStatus();
            if (draft && before && status) {
                const indices = new Set();
                draft.items.forEach((item, index) => {
                    const chromium = item.browser?.kind === "chromium" || chromiumApp(item.window.appId);
                    const newlyConnected = chromium ? !before.chromiumConnected && status.chromiumConnected : !before.firefoxConnected && status.firefoxConnected;
                    if (newlyConnected && wantsTabs(item, index) && !item.browser?.tabs?.length && !editedBrowserUrls.has(item)) indices.add(index);
                });
                if (indices.size) refreshDraftTabs(indices);
            }
        }
        if (!native || store || working) return;
        await perform(async () => { store = await native.core.invoke("get_workspaces"); render(); });
    });
    window.reviewImportedWorkspace = async profile => {
        if (working || draft) throw new Error("Save or cancel the current workspace draft before reviewing an import.");
        await perform(async () => {
            if (!store) { store = await native.core.invoke("get_workspaces"); render(); }
            if (store.profiles.some(p => p.id === profile.id)) throw new Error("This imported workspace is already saved. Edit it in the workspace list.");
            const prepared = await native.core.invoke("prepare_workspace_import", {profile:clone(profile)});
            openDraft(prepared);
            showPage("workspaces");
        });
    };
    controls();
})();
