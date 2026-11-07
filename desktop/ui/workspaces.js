/* Workspace edits are drafts until Save succeeds. Captures never auto-save. */
(() => {
    const select = selector => document.querySelector(selector);
    const native = window.__TAURI__;
    let store = null;
    let draft = null;
    let selected = [];
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
    let browserGuideDismissed = false;
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
    const {chromiumApp, firefoxApp, chromiumName, isBrowserItem} = window.WarpBrowserKinds;
    const wantsTabs = (item, index) => selected[index] && !ignoredBrowserTabs.has(index) && isBrowserItem(item);
    function refreshBrowserGuide() {
        const items = draft?.items.filter(wantsTabs) || [];
        const disconnected = !!browserBridgeStatus && items.some(item =>
            (item.browser?.kind === "chromium" || chromiumApp(item.window.appId)) ? !browserBridgeStatus.chromiumConnected : !browserBridgeStatus.firefoxConnected);
        const missing = items.some(item => !item.browser?.tabs?.length);
        const guide = select(".workspace-browser-guide");
        guide.hidden = browserGuideDismissed || [...draftCaptures].some(job => job.profile === draft) || (!disconnected && !missing);
        select("#workspace-browser-guide-message").textContent = disconnected
            ? "A browser extension isn't connected. Tabs may be missing or out of date."
            : "Some browser tabs weren't captured. Update all tabs or review the windows below.";
        select("#workspace-editor-browser-settings").hidden = !disconnected && !!browserBridgeStatus;
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
        select("#workspace-recapture").hidden = false;
        select("#workspace-recapture").scrollIntoView?.({block:"start"});
        select("#workspace-keep-draft").focus();
    }
    function controls() {
        select("#workspaces-page").querySelectorAll("input, textarea, select, button").forEach(el => { el.disabled = working || !store; });
        select("#workspace-list").querySelectorAll(".workspace-card").forEach(card => {
            if (pendingSavedTabRefreshes.has(card.dataset.workspaceId)) card.querySelectorAll("button").forEach(button => { button.disabled = true; });
        });
        select("#cancel-restore").disabled = false;
        select("#save-workspace").disabled = working || !store || !draft || !selected.some(Boolean);
        select("#workspace-hotkey-urls").disabled = working || !store?.profiles.length;
        select("#workspace-hotkey-update").disabled = working || !store?.profiles.length;
        select("#workspace-hotkey-target").disabled = working || !store?.profiles.length;
        select("#workspace-hotkey-empty").hidden = !store || store.profiles.length > 0;
        const updateTabs = select("#refresh-workspace-tabs");
        updateTabs.hidden = !draft?.items.some(isBrowserItem);
        updateTabs.disabled = working || !store || !draft?.items.some(wantsTabs);
    }
    async function perform(action, reportError = error => say(String(error), true)) {
        if (working) return;
        working = true; controls();
        try { await action(); } catch (error) { reportError(error); }
        finally {
            working = false; controls();
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
        savedTabStatus(profile.id, message, !result.updated);
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
        select("#workspace-list").replaceChildren();
        select("#workspace-empty").hidden = store.profiles.length > 0;
        store.profiles.forEach((profile, index) => {
            const fragment = select("#workspace-card-template").content.cloneNode(true);
            const card = fragment.querySelector("article");
            card.dataset.workspaceId = profile.id;
            card.querySelector(".workspace-title").textContent = profile.name;
            card.querySelector(".workspace-summary-text").textContent = `${profile.items.length} ${profile.items.length === 1 ? "window" : "windows"} · ${profile.platform === "windows" ? "Windows" : "Linux / KDE"}`;
            card.querySelector('[data-action="refresh-tabs"]').hidden = !profile.items.some(isBrowserItem);
            if (pendingSavedTabRefreshes.has(profile.id)) {
                card.querySelectorAll("button").forEach(button => { button.disabled = true; });
                const status = card.querySelector(".workspace-card-status");
                status.hidden = false; status.textContent = "Waiting for the browser extension…";
            }
            card.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => {
                const action = button.dataset.action;
                if (button.closest(".menu")) button.closest(".menu").hidden = true;
                if (action === "delete" || action === "cancel-delete") { card.querySelector(".workspace-delete-confirm").hidden = action !== "delete"; return; }
                if (action === "edit") { replaceDraft(() => { currentCapture = null; openDraft(clone(profile), profile.id); }); return; }
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
    async function useRecapture(capture) {
        await refreshPendingWorkspaceStore();
        openDraft(capture.profile);
        select("#workspace-name").focus(); select("#workspace-name").select?.();
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
        const failed = !!error || missing;
        if (failed) {
            const message = error
                ? `Browser URLs couldn't be loaded: ${errorText(error)}. Existing URLs were kept.`
                : "Some browser URLs couldn't be matched. Check Browser setup or review the affected windows. Existing URLs were kept.";
            inlineStatus("#workspace-tabs-status", message, true);
        }
        if (saveAfterCapture && failed) {
            saveAfterCapture = false;
            inlineStatus("#workspace-save-status", "URLs could not be loaded. Retry or save without them.", true);
        } else if (saveAfterCapture && !remaining && !working) {
            saveAfterCapture = false;
            saveWorkspace();
        }
    }
    function openDraft(profile, id = "", replaceSaved = false) {
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
        browserSetters = []; browserMissingSetters = [];
        inlineStatus("#workspace-tabs-status", "");
        select("#workspace-editor").hidden = false;
        select("#workspace-editor-title").textContent = id ? `Edit “${store.profiles.find(p => p.id === id)?.name || profile.name}”` : "New workspace";
        select(".workspace-options").removeAttribute("open");
        select("#workspace-name").value = profile.name;
        select("#workspace-platform").value = profile.platform;
        select("#workspace-items").replaceChildren();
        select("#workspace-items-empty").hidden = profile.items.length > 0;
        const monitors = native.core.invoke("get_import_monitors").catch(() => null);
        const renderItem = (item, index) => {
            const fragment = select("#workspace-item-template").content.cloneNode(true);
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
            const monitorFallback = fragment.querySelector(".monitor-number");
            const fallbackLabel = fragment.querySelector(".window-placement-fallback");
            const windowName = item.label || item.window.title || "window";
            placement.setAttribute("aria-label", `Monitor for ${windowName}`);
            monitorFallback.setAttribute("aria-label", `Monitor number for ${windowName}`);
            const showMonitor = () => {
                const value = String(item.window.monitor);
                if (![...placement.options].some(option => option.value === value)) {
                    const option = document.createElement("option"); option.value = value; option.textContent = `Monitor ${value} (unavailable)`; placement.append(option);
                }
                placement.value = value;
                monitorFallback.value = value;
            };
            const changeMonitor = value => {
                const number = Number(value);
                if (!Number.isInteger(number) || number < 1 || number > 100) { showMonitor(); return; }
                if (item.window.monitor !== number) { item.window.monitor = number; item.window.monitorName = ""; }
                showMonitor();
            };
            placement.addEventListener("change", () => changeMonitor(placement.value));
            monitorFallback.addEventListener("change", () => changeMonitor(monitorFallback.value));
            showMonitor();
            monitors.then(areas => {
                if (draft !== profile) return;
                if (!Array.isArray(areas) || !areas.length) { placement.hidden = true; fallbackLabel.hidden = false; return; }
                placement.replaceChildren();
                areas.slice(0, 100).forEach((area, number) => { const option = document.createElement("option"); option.value = String(number + 1); option.textContent = `Monitor ${number + 1}`; placement.append(option); });
                showMonitor();
            });
            fragment.querySelector(".set-position").addEventListener("click", () => perform(async () => {
                const result = await native.core.invoke("choose_position", {rect:clone(item.window.rect)});
                if (!result) return;
                Object.assign(item.window.rect, result.rect);
                Object.assign(item.window.workArea ||= {}, result.workArea);
                item.window.monitor = result.monitor;
                item.window.monitorName = "";
                item.window.maximizedHorizontal = false;
                item.window.maximizedVertical = false;
                item.window.fullscreen = false;
                item.window.minimized = false;
                rectInputs.forEach(input => { input.value = result.rect[input.dataset.rect]; });
                areaInputs.forEach(input => { input.value = result.workArea[input.dataset.area]; });
                showMonitor();
            }));
            fragment.querySelectorAll("[data-window], [data-rect], [data-area]").forEach(input => {
                const field = input.dataset.window || input.dataset.rect || input.dataset.area;
                const target = input.dataset.rect ? item.window.rect : input.dataset.area ? (item.window.workArea ||= {}) : item.window;
                input.value = target[field] ?? "";
                input.addEventListener("input", () => {
                    target[field] = input.type === "number" ? Number(input.value) : input.value;
                    if (field === "monitor") item.window.monitorName = "";
                });
            });
            const browserApp = chromiumApp(item.window.appId);
            if (item.browser || browserApp || firefoxApp(item.window.appId)) {
                const browser = item.browser || {kind:browserApp ? "chromium" : "firefox",profilePath:"",profileName:"",tabs:[],activeTab:1};
                const firefox = !browser.kind || browser.kind === "firefox";
                const browserName = firefox ? "Firefox" : chromiumName(item.window.appId || "");
                if (!browser.tabs.length) {
                    note.textContent = `${item.captureNote ? item.captureNote + " " : ""}No ${browserName} tabs are saved for this window.`;
                    note.hidden = false;
                }
                fragment.querySelector(".browser-settings").hidden = false;
                const reviewTabs = fragment.querySelector(".review-browser-tabs");
                const browserSettings = fragment.querySelector(".browser-settings");
                browserSettings.addEventListener("input", () => markCapturedBrowserEdited(item));
                browserSettings.addEventListener("change", () => markCapturedBrowserEdited(item));
                browserSettings.addEventListener("click", event => { if (event.target.closest?.("button")) markCapturedBrowserEdited(item); });
                reviewTabs.hidden = !item.captureNote && !!browser.tabs.length;
                reviewTabs.addEventListener("click", () => {
                    setWindowExpanded(true);
                    browserSettings.scrollIntoView?.({block:"nearest"});
                });
                fragment.querySelector(".browser-summary").textContent = `${browserName} profile and tabs`;
                fragment.querySelector(".browser-restore-label").textContent = `Restore this ${browserName} profile and its tabs`;
                fragment.querySelector(".browser-profile-label").textContent = `${browserName} profile`;
                fragment.querySelector(".browser-restore-hint").textContent = firefox ? "Firefox reuses a window when its URLs match; otherwise it opens a new one. The selected tab opens first." : "Existing browser windows are reused without changing their tabs.";
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
                tabSummary.hidden = false;
                const currentStatus = fragment.querySelector(".browser-current-status");
                const showTabCount = () => {
                    const count = `${browser.tabs.length} ${browser.tabs.length === 1 ? "tab" : "tabs"}`;
                    tabSummary.textContent = browser.tabs.length ? count : "No tabs";
                    tabCount.textContent = `${count} saved · ${browser.profileName || (browser.profilePath ? "Captured profile" : "Browser default; profile not identified")}`;
                };
                showTabCount();
                const applyCurrentTabs = current => {
                    if (!current || (current.kind || "firefox") !== (browser.kind || "firefox")) return false;
                    if (browser.profilePath && (!current.profilePath || profilePathKey(browser.profilePath) !== profilePathKey(current.profilePath))) return false;
                    if (!browser.profilePath && browser.profileName && browser.profileName !== current.profileName) return false;
                    browser.tabs = clone(current.tabs); browser.activeTab = current.activeTab;
                    if (current.profilePath) {
                        browser.profilePath = pathInput.value = current.profilePath; browser.profileName = nameInput.value = current.profileName;
                        const option = [...profileSelect.options].find(option => option.value === current.profilePath);
                        profileSelect.options[0].textContent = current.profileName || "Captured profile";
                        profileSelect.value = option ? option.value : "";
                    }
                    item.browser = browser; restoreBrowser.checked = true; ignoredBrowserTabs.delete(index);
                    tabsInput.value = browser.tabs.map(tab => tab.url).join("\n"); activeInput.value = browser.activeTab;
                    item.captureNote = ""; note.textContent = ""; note.hidden = true;
                    reviewTabs.hidden = true; refreshBrowserGuide(); showTabCount();
                    return true;
                };
                browserSetters[index] = applyCurrentTabs;
                browserMissingSetters[index] = () => {
                    note.textContent = browser.tabs.length ? "Current tabs couldn't be matched. Saved tabs were kept." : "Current tabs couldn't be matched for this window.";
                    note.hidden = false; reviewTabs.hidden = false;
                };
                fragment.querySelector(".use-current-browser-tabs").addEventListener("click", () => {
                    window.WarpErrorTimer.set(currentStatus, "Getting current tabs…");
                    perform(async () => {
                        const current = await native.core.invoke("current_browser_tabs", {windowId:item.window.id, pid:item.window.pid});
                        if (!applyCurrentTabs(current)) throw new Error("No connected browser window matched. Use Update URLs to choose a desktop, or choose a window below.");
                        window.WarpErrorTimer.set(currentStatus, "Current tabs added. Save the workspace to keep them.");
                    }, error => window.WarpErrorTimer.set(currentStatus, errorText(error), {error:true}));
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
                    browser.tabs = clone(session.tabs);
                    browser.activeTab = session.activeTab;
                    item.browser = browser; restoreBrowser.checked = true; ignoredBrowserTabs.delete(index);
                    showTabCount();
                    tabsInput.value = browser.tabs.map(tab => tab.url).join("\n");
                    activeInput.value = browser.activeTab;
                    item.captureNote = "";
                    note.textContent = ""; note.hidden = true;
                    reviewTabs.hidden = true; refreshBrowserGuide();
                    window.WarpErrorTimer.set(sessionStatus, "Tabs added to this draft. Review them before saving.");
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
                    input.value = field === "tabs" ? browser.tabs.map(t => t.url).join("\n") : browser[field];
                    input.addEventListener("input", () => {
                        if (field === "tabs") {
                            browser.tabs = input.value.split(/\r?\n/).filter(Boolean).map(url => ({url, title:browser.tabs.find(t => t.url === url)?.title || ""}));
                            if (browser.tabs.length) { item.browser = browser; restoreBrowser.checked = true; ignoredBrowserTabs.delete(index); }
                            browser.activeTab = Math.max(1, Math.min(Number(browser.activeTab) || 1, browser.tabs.length || 1));
                            activeInput.value = browser.activeTab;
                            showTabCount();
                            if (browser.tabs.length) { item.captureNote = ""; note.textContent = ""; note.hidden = true; }
                            else { note.textContent = `No ${browserName} URLs are saved for this window.`; note.hidden = false; }
                            reviewTabs.hidden = !!browser.tabs.length; refreshBrowserGuide();
                        } else browser[field] = field === "activeTab" ? Number(input.value) : input.value;
                        if (field === "profilePath" || field === "profileName") { profileSelect.value = ""; clearSessions(); }
                    });
                });
            }
            const include = fragment.querySelector(".include-window");
            include.checked = selected[index];
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
            include.addEventListener("change", () => { selected[index] = include.checked; count(); refreshBrowserGuide(); controls(); });
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
            select("#workspace-items").append(fragment);
        };
        profile.items.forEach(renderItem);
        appendDraftWindow = item => {
            if (draft !== profile) return false;
            const existing = profile.items.findIndex(saved => item.window.id && saved.window.id === item.window.id && saved.window.pid === item.window.pid);
            if (existing >= 0) {
                selected[existing] = true;
                const input = select("#workspace-items").querySelectorAll(".include-window")[existing];
                if (input) input.checked = true;
                inlineStatus("#workspace-editor-status", "That window is already in this workspace.");
                count(); controls();
                return false;
            }
            if (profile.items.length >= 100) { inlineStatus("#workspace-editor-status", "A workspace can contain up to 100 windows.", true); return false; }
            profile.items.push(item); selected.push(true);
            renderItem(item, profile.items.length - 1);
            select("#workspace-items-empty").hidden = true;
            inlineStatus("#workspace-editor-status", "");
            count(); refreshBrowserGuide(); controls();
            return true;
        };
        count(); refreshBrowserGuide(); controls(); refreshBridgeStatus();
        select("#workspace-editor").scrollIntoView?.({block:"start"});
    }
    function count() { const count = selected.filter(Boolean).length; select("#workspace-item-count").textContent = `${count} ${count === 1 ? "window" : "windows"} selected`; }
    function tabFailureMessage(failure) {
        if (failure === "extensionDidNotRespond") return "The browser extension didn't respond. Open it in the profile for this window, then try again. Saved URLs were kept.";
        return "The connected extension couldn't identify this window. Check that it's connected in the same browser profile. Saved URLs were kept.";
    }
    function tabUpdateMessage(updated, unmatched, source, failure) {
        if (!updated) return tabFailureMessage(failure);
        return `${updated} ${updated === 1 ? "window" : "windows"} updated${source ? ` from ${source}` : ""}.${unmatched ? ` ${unmatched} couldn't be matched; saved URLs were kept.` : ""}`;
    }
    function refreshDraftTabs(indices = null) {
        if (!draft || working) return;
        const eligible = (item, index) => wantsTabs(item, index) && (!indices || indices.has(index));
        const total = draft.items.filter(eligible).length;
        if (!total) return;
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
                if (eligible(draft.items[update.index], update.index) && browserSetters[update.index]?.(update.browser)) { updated++; matched.add(update.index); }
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
            if (focus) select("#workspace-name").focus();
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
        if (focus) select("#workspace-name").focus();
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
    select("#workspace-editor-browser-settings").addEventListener("click", openBrowserSettings);
    select("#dismiss-workspace-browser-guide").addEventListener("click", () => { browserGuideDismissed = true; refreshBrowserGuide(); });
    select("#refresh-workspace-tabs").addEventListener("click", () => refreshDraftTabs());
    function addCapturedWindow(item) {
        if (!draft || !item || !appendDraftWindow?.(item)) return;
        if (!isBrowserItem(item)) return;
        const job = beginDraftCapture(draft, null, [item]);
        const profile = clone(draft); profile.items = [clone(item)];
        native.core.invoke("enrich_workspace_capture", {profile})
            .then(enriched => finishDraftCapture(job, enriched), error => finishDraftCapture(job, null, error));
    }
    select("#add-workspace-window").addEventListener("click", () => {
        if (!draft) return;
        const targetDraft = draft;
        inlineStatus("#workspace-editor-status", "Click an app window to add it, or press Escape to cancel.");
        perform(async () => {
            const item = await native.core.invoke("pick_workspace_window");
            if (draft !== targetDraft) return;
            inlineStatus("#workspace-editor-status", "");
            addCapturedWindow(item);
        }, error => inlineStatus("#workspace-editor-status", errorText(error), true));
    });
    const windowList = select("#workspace-add-window-list");
    const windowListButton = select("#workspace-add-from-list");
    const closeWindowList = () => { windowList.hidden = true; windowListButton.setAttribute("aria-expanded", "false"); };
    windowListButton.addEventListener("click", event => {
        event.stopPropagation();
        if (!windowList.hidden) { closeWindowList(); return; }
        const targetDraft = draft;
        perform(async () => {
            const windows = await native.core.invoke("workspace_open_windows");
            if (draft !== targetDraft) return;
            windowList.replaceChildren();
            for (const item of windows) {
                const button = document.createElement("button"); button.type = "button";
                button.textContent = item.label || item.window.title || item.window.appId;
                button.addEventListener("click", () => { closeWindowList(); addCapturedWindow(item); windowListButton.focus(); });
                windowList.append(button);
            }
            if (!windows.length) { const note = document.createElement("p"); note.textContent = "No open windows found."; windowList.append(note); }
            document.querySelectorAll(".menu").forEach(open => { open.hidden = true; });
            windowList.hidden = false;
            windowListButton.setAttribute("aria-expanded", "true");
            windowList.querySelector("button")?.focus();
        }, error => inlineStatus("#workspace-editor-status", errorText(error), true));
    });
    const dismissWindowList = event => {
        if (event.key === "Escape" && !windowList.hidden) { event.preventDefault(); closeWindowList(); windowListButton.focus(); }
    };
    windowList.addEventListener("keydown", dismissWindowList);
    windowListButton.addEventListener("keydown", dismissWindowList);
    select("#workspace-hotkey-cancel").addEventListener("click", () => { pendingCapture = null; currentCapture = null; select("#workspace-hotkey-choice").hidden = true; });
    select("#workspace-capture-cancel").addEventListener("click", () => { pendingCapture = null; currentCapture = null; select("#workspace-capture-pending").hidden = true; });
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
            if (!id) { select("#workspace-name").focus(); select("#workspace-name").select?.(); }
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
    function saveWorkspace() {
        inlineStatus("#workspace-save-status", "");
        if ([...draftCaptures].some(job => job.profile === draft)) {
            saveAfterCapture = true;
            inlineStatus("#workspace-save-status", "Saving when URLs finish loading…");
            return;
        }
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
            select("#workspace-editor").hidden = true;
            const savedCard = [...select("#workspace-list").querySelectorAll(".workspace-card")].find(card => card.dataset.workspaceId === profile.id);
            if (savedCard) { const status = savedCard.querySelector(".workspace-card-status"); status.hidden = false; status.textContent = "Saved."; }
        }, error => inlineStatus("#workspace-save-status", String(error), true));
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
    select("#discard-workspace").addEventListener("click", () => { draft = null; draftCaptures.clear(); saveAfterCapture = false; currentCapture = null; pendingCapture = null; pendingDraftAction = null; select("#workspace-tabs-loading").hidden = true; select("#workspace-recapture").hidden = true; select("#workspace-editor").hidden = true; controls(); refreshBrowserUpdate(); });
    select("#workspace-keep-draft").addEventListener("click", () => { const cancel = pendingDraftCancel; pendingDraftAction = null; pendingDraftCancel = null; select("#workspace-recapture").hidden = true; cancel?.(); });
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
        windowListButton.setAttribute("aria-expanded", "false");
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
        select("#workspace-hotkey-choice").hidden = false;
        select("#workspace-hotkey-choice").scrollIntoView?.({block:"start"});
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
    window.addEventListener("focus", () => { if (!select("#workspaces-page").hidden) refreshWorkspaceLocations(); });
    window.addEventListener("warp-desktop-changed", () => { if (!select("#workspaces-page").hidden) refreshWorkspaceLocations(); });
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
        const before = bridgeBeforeSettings;
        bridgeBeforeSettings = null;
        if (native) {
            const status = await refreshBridgeStatus();
            if (draft && before && status) {
                const indices = new Set();
                draft.items.forEach((item, index) => {
                    const chromium = item.browser?.kind === "chromium" || chromiumApp(item.window.appId);
                    const newlyConnected = chromium ? !before.chromiumConnected && status.chromiumConnected : !before.firefoxConnected && status.firefoxConnected;
                    if (newlyConnected && wantsTabs(item, index) && !item.browser?.tabs?.length) indices.add(index);
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
