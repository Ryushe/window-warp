const api = globalThis.browser || globalThis.chrome;
const $ = selector => document.querySelector(selector);
const message = async (action, options = {}) => {
    try { return await api.runtime.sendMessage({action, options}); }
    catch { return {error:"The extension could not reach its background process."}; }
};
let workspaces = [], savedBrowsers = [], currentStatus = {}, activeTab = "saved", settingsOpen = false;
let chooserMode = "elsewhere", pendingChoice = null, renaming = null, pendingLive = false, chooserBusy = false, syncBusy = false, statusSequence = 0, compatible = null;
const queries = {saved:"", workspaces:""};

function feedback(element, value, {error = false, quiet = false} = {}) {
    element.textContent = value || "";
    element.classList.toggle("error", error);
    element.classList.toggle("quiet", quiet);
}
const setStatus = (value, options) => feedback($("#status"), value, options);
async function currentWindow() {
    if (typeof api.windows?.getCurrent !== "function") return null;
    const current = await api.windows.getCurrent();
    if (!current || current.incognito || !current.type || current.type === "normal") return current;
    // Some extension hosts display the popup as its own window. Use a normal
    // window only when the browser can identify it without guessing.
    if (typeof api.windows.getAll !== "function") return null;
    const windows = (await api.windows.getAll({populate:false, windowTypes:["normal"]})).filter(win => !win.incognito && (!win.type || win.type === "normal"));
    return windows.find(win => win.focused) || (windows.length === 1 ? windows[0] : null);
}
async function currentWindowId() {
    try { const window = await currentWindow(); return window && !window.incognito ? window.id : undefined; }
    catch { return undefined; }
}
function setConnected(connected) {
    if (!connected) statusSequence++;
    $("#connection").checked = connected;
    $("#connection-label").textContent = connected ? "Connected" : "Connect";
    if (!connected) $("#live").checked = false;
    $("#live-label").textContent = `Live updates: ${$("#live").checked ? "On" : "Off"}`;
    $("#connected").hidden = !connected || settingsOpen;
    $("#pairing-section").hidden = connected || settingsOpen;
}
function switchesBusy(busy) {
    for (const selector of ["#connection", "#live", "#connect"]) $(selector).disabled = busy;
}
function showView(view) {
    for (const [name, selector] of [["library","#library"],["save","#save-browser-form"],["chooser","#chooser"],["rename","#rename-form"]]) $(selector).hidden = name !== view;
}
function option(value, label) {
    const node = document.createElement("option"); node.value = value; node.textContent = label; return node;
}
function button(label, action, className = "") {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label;
    if (className) node.className = className;
    node.addEventListener("click", action); return node;
}
function selectTab(tab, focus = false) {
    queries[activeTab] = $("#list-search").value;
    activeTab = tab;
    for (const [name, selector] of [["saved","#saved-tab"],["workspaces","#workspaces-tab"]]) $(selector).setAttribute("aria-selected", String(name === tab));
    $("#saved-panel").hidden = tab !== "saved";
    $("#workspaces-panel").hidden = tab !== "workspaces";
    $("#search-label").textContent = tab === "saved" ? "Search saved tabs" : "Search workspaces";
    $("#list-search").placeholder = $("#search-label").textContent;
    $("#list-search").value = queries[tab];
    renderList();
    if (focus) $(tab === "saved" ? "#saved-tab" : "#workspaces-tab").focus();
}
function renderList() {
    const target = $(activeTab === "saved" ? "#saved-browser-list" : "#workspace-list");
    const needle = queries[activeTab].trim().toLocaleLowerCase();
    const items = (activeTab === "saved" ? savedBrowsers : workspaces).filter(item => item.name.toLocaleLowerCase().includes(needle));
    const noun = activeTab === "saved" ? "saved browser" : "workspace";
    $("#list-count").textContent = `${items.length} ${noun}${items.length === 1 ? "" : "s"}`;
    target.replaceChildren();
    if (!items.length) { const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = needle ? "No matches. Try a different search." : `No ${noun}s yet.`; target.append(empty); return; }
    for (const item of items) {
        const row = document.createElement("article"); row.className = "library-row";
        const heading = document.createElement("div"); heading.className = "row-heading";
        const name = document.createElement("strong"); name.textContent = item.name; heading.append(name);
        if (activeTab === "saved") {
            const edit = button("✎", () => openRename(item), "rename-button"); edit.setAttribute("aria-label", `Rename ${item.name}`); heading.append(edit);
            heading.addEventListener("dblclick", event => { if (!event.target.closest("button")) openRename(item); });
        }
        const count = document.createElement("span"); count.className = "row-count";
        const amount = activeTab === "saved" ? item.tabCount : item.windowCount;
        count.textContent = Number.isInteger(amount) ? `${amount} ${activeTab === "saved" ? "tab" : "window"}${amount === 1 ? "" : "s"}` : "";
        heading.append(count); row.append(heading);
        const actions = document.createElement("div"); actions.className = "row-actions";
        if (activeTab === "saved") {
            actions.append(button("Open in new browser", event => openDestination("open-saved-browser", {savedBrowserId:item.id}, item.name, event.currentTarget)));
            actions.append(button("Open in current browser", event => openInCurrent(item, event.currentTarget)));
        } else actions.append(button("Open workspace", event => openDestination("open-workspace", {workspaceId:item.id}, item.name, event.currentTarget)));
        row.append(actions); target.append(row);
    }
}
async function showStatus() {
    const sequence = ++statusSequence;
    const result = await message("status", {windowId:await currentWindowId()});
    if (sequence !== statusSequence) return true;
    if (result?.error) { currentStatus = {}; setStatus(result.error, {error:true}); $("#update").disabled = true; return false; }
    const settings = await api.storage.local.get(["liveSharing", "liveError", "profilePath"]);
    if (sequence !== statusSequence) return true;
    currentStatus = result;
    workspaces = result.workspaces || []; savedBrowsers = result.savedBrowsers || [];
    $("#live").checked = !!result.live && !!settings.liveSharing;
    $("#live-label").textContent = `Live updates: ${$("#live").checked ? "On" : "Off"}`;
    const chosen = settings.profilePath || "", profile = $("#profile"); profile.replaceChildren(); profile.append(option("", "Detect automatically"));
    for (const item of result.profiles || []) profile.append(option(item.path, item.name));
    profile.value = [...profile.options].some(item => item.value === chosen) ? chosen : "";
    if (!Number.isInteger(result.libraryVersion) || result.libraryVersion < 1) {
        compatible = false; showView("none"); $("#upgrade-required").hidden = false; $("#update").disabled = true;
        setStatus("Update Window Warp to use the new saved tabs and workspace controls.", {error:true});
        return true;
    }
    $("#upgrade-required").hidden = true;
    if (compatible === false) showView("library");
    compatible = true;
    $("#workspace").textContent = result.destination || "No saved destination yet";
    $("#sharing").textContent = $("#live").checked ? "Live tab changes are saved to the linked destination." : "Tabs are shared only when requested.";
    const destination = $("#destination"); destination.replaceChildren();
    const known = result.destination || (result.hasOwners ? "Detected when you sync" : "No current sync destination");
    destination.append(option("current", known), option("change", "Choose current sync destination…"));
    $("#update").disabled = syncBusy || result.windowsAvailable === false || !(result.destination || result.hasOwners);
    const firefox = typeof api.runtime.getURL === "function" && api.runtime.getURL("").startsWith("moz-extension:");
    $("#save-profile-hint").hidden = firefox || !!chosen;
    renderList();
    const problems = [];
    if (result.storageError) problems.push(result.storageError);
    if (result.windowsAvailable === false) problems.push("Window Warp cannot see open windows. Check its desktop integration.");
    if ($("#live").checked && settings.liveError) problems.push(`Live update failed: ${settings.liveError}`);
    if (problems.length) setStatus(problems.join(" "), {error:true});
    else if (result.updatePending) setStatus("Update ready. Reload the extension if needed.");
    else setStatus("Connected", {quiet:true});
    return true;
}
async function init() {
    const settings = await api.storage.local.get(["enabled", "pairing", "liveSharing"]);
    $("#pairing").value = settings.pairing || "";
    setConnected(!!settings.enabled && !!settings.pairing);
    if (settings.enabled && settings.pairing) {
        if (!await showStatus()) { $("#pairing-section").hidden = false; $("#connected").hidden = true; }
    } else setStatus("Connect to get started.", {quiet:true});
}
async function changeLive(live) {
    switchesBusy(true);
    try {
        if (!live) await api.storage.local.set({liveSharing:false, liveError:""});
        const result = await message("set-live", {live});
        if (result?.error) { $("#live").checked = false; setStatus(result.error, {error:true}); }
        else { await api.storage.local.set({liveSharing:live}); await showStatus(); }
    } finally { switchesBusy(false); }
}
async function connect(live = false) {
    const pairing = $("#pairing").value.trim();
    if (!pairing) { pendingLive = live; setConnected(false); setStatus("Enter the pairing code from Window Warp.", {error:true}); $("#pairing").focus(); return; }
    pendingLive = false; switchesBusy(true);
    try {
        await api.storage.local.set({pairing, enabled:true, liveSharing:false, liveError:""}); setConnected(true);
        const reset = await message("set-live", {live:false});
        if (reset?.error || !await showStatus()) {
            await api.storage.local.set({enabled:false, liveSharing:false}); setConnected(false);
            if (reset?.error) setStatus(reset.error, {error:true}); return;
        }
        if (live) await changeLive(true);
    } finally { switchesBusy(false); }
}
async function openDestination(action, options, name, trigger) {
    trigger.disabled = true; setStatus(`Opening ${name}…`);
    try {
        const started = await message(action, options);
        if (started?.error) { setStatus(started.error, {error:true}); return; }
        if (!started?.operationId) { setStatus("Window Warp did not start opening this item.", {error:true}); return; }
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const result = await message("operation-status", {operationId:started.operationId});
            if (result?.error) { setStatus(result.error, {error:true}); return; }
            if (result?.done) {
                await showStatus();
                const partial = result.failed ? ` ${result.failed} window${result.failed === 1 ? "" : "s"} could not open.` : "";
                setStatus(`Opened ${name}.${partial}${result.warning ? ` ${result.warning}` : ""}`, {error:!!result.failed}); return;
            }
        }
        setStatus("Opening is still in progress. Check Window Warp for the result.", {error:true});
    } finally { trigger.disabled = false; }
}
async function openInCurrent(item, trigger) {
    trigger.disabled = true;
    try {
        const window = await currentWindow();
        if (!window || window.incognito || !Number.isInteger(window.id)) { setStatus("Open a non-private browser window and try again.", {error:true}); return; }
        const result = await message("open-saved-in-current", {savedBrowserId:item.id, windowId:window.id});
        if (result?.error) { setStatus(result.error, {error:true}); return; }
        const opened = result.opened || 0, failed = result.failed || 0;
        if (!opened) { setStatus("No tabs could be opened. Check the saved browser and try again.", {error:true}); return; }
        setStatus(`Opened ${opened} tab${opened === 1 ? "" : "s"} beside your current tabs.${failed ? ` ${failed} could not open.` : ""}`, {error:!!failed});
    } catch { setStatus("Could not open the saved tabs in this browser window.", {error:true}); }
    finally { trigger.disabled = false; }
}
function openRename(item) {
    renaming = item; showView("rename"); $("#rename-name").value = item.name; feedback($("#rename-feedback"), ""); $("#rename-name").focus(); $("#rename-name").select?.();
}
async function prepareSave() {
    try {
        const current = await currentWindow();
        if (current?.incognito) { setStatus("Open a non-private browser window and try again.", {error:true}); return; }
        const windows = (await api.windows.getAll({populate:true, windowTypes:["normal"]})).filter(win => !win.incognito && win.tabs?.some(tab => tab.url));
        if (!windows.length) { setStatus("Open a non-private browser window with tabs to save.", {error:true}); return; }
        const select = $("#save-window"); select.replaceChildren();
        for (const win of windows) select.append(option(String(win.id), `${win.tabs.find(tab => tab.active)?.title || "Browser window"} (${win.tabs.length} tabs)`));
        const match = windows.find(win => win.id === current?.id) || (!current && windows.length === 1 ? windows[0] : null);
        if (match) select.value = String(match.id);
        else { select.prepend(option("", "Choose a browser window")); select.value = ""; }
        $("#save-window-label").hidden = windows.length === 1 && !!match; select.hidden = windows.length === 1 && !!match;
        $("#save-kind").value = "browser";
        $("#save-kind-hint").textContent = "Create a saved browser containing this window’s tabs.";
        $("#browser-name").value = typeof api.runtime.getURL === "function" && api.runtime.getURL("").startsWith("moz-extension:") ? "Firefox tabs" : "Browser tabs";
        $("#save-link").checked = !currentStatus.hasOwners && !currentStatus.destination; feedback($("#save-feedback"), ""); showView("save"); $("#browser-name").focus(); $("#browser-name").select?.();
    } catch { setStatus("Could not read the open browser windows. Try again.", {error:true}); }
}
function fillTargets() {
    const select = $("#target-destination"); select.replaceChildren(); select.append(option("", "Choose a destination"));
    const browsers = document.createElement("optgroup"); browsers.label = "Saved browsers";
    for (const item of savedBrowsers) browsers.append(option(`saved:${item.id}`, item.name));
    const spaces = document.createElement("optgroup"); spaces.label = "Workspaces";
    for (const item of workspaces.filter(item => item.items?.length)) spaces.append(option(`workspace:${item.id}`, item.name));
    if (browsers.children.length) select.append(browsers);
    if (spaces.children.length) select.append(spaces);
    select.value = ""; fillTargetItems();
}
function fillTargetItems() {
    const value = $("#target-destination").value || "", workspace = value.startsWith("workspace:") ? workspaces.find(item => item.id === value.slice(10)) : null;
    const select = $("#target-item"); select.replaceChildren();
    $("#target-item-label").hidden = !workspace; select.hidden = !workspace;
    if (!workspace) return;
    if (workspace.items.length > 1) select.append(option("", "Choose a browser window"));
    for (const item of workspace.items) select.append(option(String(item.index), item.label || "Browser window"));
    if (workspace.items.length === 1) select.value = String(workspace.items[0].index);
}
function selectedChoice() {
    const value = $("#target-destination").value || "";
    if (value.startsWith("saved:")) {
        const item = savedBrowsers.find(item => item.id === value.slice(6));
        return item ? {label:item.name, options:{savedBrowserId:item.id, expectedRevision:item.itemRevision || ""}} : null;
    }
    if (value.startsWith("workspace:")) {
        const workspace = workspaces.find(item => item.id === value.slice(10));
        const raw = $("#target-item").value;
        const item = raw === "" ? null : workspace?.items.find(item => String(item.index) === raw);
        return workspace && item ? {label:`${workspace.name} / ${item.label || "Browser window"}`, options:{workspaceId:workspace.id, itemIndex:item.index, expectedRevision:item.revision || ""}} : null;
    }
    return null;
}
function openChooser(mode) {
    chooserMode = mode; pendingChoice = null; showView("chooser"); fillTargets(); feedback($("#chooser-feedback"), "");
    $("#chooser-confirm").hidden = true; $("#chooser-actions").hidden = false;
    $("#chooser-title").textContent = mode === "link" ? "Current sync destination" : "Sync elsewhere";
    $("#chooser-hint").textContent = mode === "link" ? "Choose where future syncs for this window should go." : "Update a different saved browser or workspace once. Your current sync destination stays the same.";
    $("#chooser-review").textContent = mode === "link" ? "Use destination" : "Review update";
    $("#target-destination").focus();
}
async function applyChoice() {
    if (!pendingChoice || chooserBusy) return;
    const controls = ["#chooser-review", "#chooser-confirm-button", "#chooser-cancel", "#chooser-keep", "#chooser-back", "#target-destination", "#target-item"];
    chooserBusy = true; for (const selector of controls) $(selector).disabled = true;
    try {
        const id = await currentWindowId();
        if (!Number.isInteger(id)) { feedback($("#chooser-feedback"), "Open a non-private browser window and try again.", {error:true}); return; }
        const result = await message(chooserMode === "link" ? "link-current" : "update-elsewhere", {...pendingChoice.options, windowId:id});
        if (result?.error) { feedback($("#chooser-feedback"), result.error, {error:true}); return; }
        const label = pendingChoice.label, mode = chooserMode; showView("library"); await showStatus();
        setStatus((mode === "link" ? `Current sync destination: ${label}.` : `Updated ${label} once. The current sync destination stays the same.`) + (result.warning ? ` ${result.warning}` : ""));
    } finally { chooserBusy = false; for (const selector of controls) $(selector).disabled = false; }
}

$("#connect").addEventListener("click", () => connect(pendingLive));
$("#connection").addEventListener("change", async event => {
    if (event.target.checked) { await connect(); return; }
    setConnected(false); switchesBusy(true);
    try { await api.storage.local.set({enabled:false, liveSharing:false}); await message("disconnect"); setStatus("Disconnected.", {quiet:true}); }
    finally { switchesBusy(false); }
});
$("#live").addEventListener("change", async event => {
    if (event.target.checked && !$("#connection").checked) { await connect(true); return; }
    await changeLive(event.target.checked);
});
$("#settings-toggle").addEventListener("click", () => { settingsOpen = !settingsOpen; $("#settings-panel").hidden = !settingsOpen; $("#settings-toggle").setAttribute("aria-expanded", String(settingsOpen)); setConnected($("#connection").checked); if (settingsOpen) $("#profile").focus(); });
$("#settings-back").addEventListener("click", () => { settingsOpen = false; $("#settings-panel").hidden = true; $("#settings-toggle").setAttribute("aria-expanded", "false"); setConnected($("#connection").checked); $("#settings-toggle").focus(); });
$("#profile").addEventListener("change", async event => { const selected = event.target.selectedOptions[0]; await api.storage.local.set({profilePath:selected.value, profileName:selected.value ? selected.textContent : ""}); await showStatus(); });
for (const [tab, selector] of [["saved","#saved-tab"],["workspaces","#workspaces-tab"]]) {
    $(selector).addEventListener("click", () => selectTab(tab));
    $(selector).addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); selectTab(event.key === "Home" ? "saved" : event.key === "End" ? "workspaces" : activeTab === "saved" ? "workspaces" : "saved", true);
    });
}
$("#list-search").addEventListener("input", event => { queries[activeTab] = event.target.value; renderList(); });
$("#destination").addEventListener("change", event => {
    if (event.target.value === "change") { event.target.value = "current"; openChooser("link"); }
});
$("#save-browser").addEventListener("click", prepareSave);
$("#cancel-save-browser").addEventListener("click", () => { showView("library"); $("#save-browser").focus(); });
$("#save-kind").addEventListener("change", event => { $("#save-kind-hint").textContent = event.target.value === "workspace" ? "Create a workspace containing this browser window and its tabs." : "Create a saved browser containing this window’s tabs."; });
$("#save-browser-form").addEventListener("submit", async event => {
    event.preventDefault(); const name = $("#browser-name").value.trim(), raw = $("#save-window").value;
    if (!name) { feedback($("#save-feedback"), "Give this item a name.", {error:true}); $("#browser-name").focus(); return; }
    if (!raw) { feedback($("#save-feedback"), "Choose a browser window.", {error:true}); $("#save-window").focus(); return; }
    const action = $("#save-kind").value === "workspace" ? "save-workspace" : "save-browser", submit = $("#confirm-save-browser");
    submit.disabled = true; feedback($("#save-feedback"), "Saving…");
    try {
        const result = await message(action, {name, windowId:Number(raw), makeCurrent:$("#save-link").checked});
        if (result?.error) { feedback($("#save-feedback"), result.error, {error:true}); return; }
        showView("library"); selectTab(action === "save-workspace" ? "workspaces" : "saved"); await showStatus();
        setStatus(`Saved ${name}.${result.warning ? ` ${result.warning}` : ""}`, {error:!!result.warning});
    } finally { submit.disabled = false; }
});
$("#update").addEventListener("click", async () => {
    if (syncBusy) return;
    const expectedDestinationId = currentStatus.destinationId;
    syncBusy = true; $("#update").disabled = true;
    try {
        const id = await currentWindowId();
        if (!Number.isInteger(id)) { setStatus("Open a non-private browser window and try again.", {error:true}); return; }
        const options = {windowId:id};
        if (typeof expectedDestinationId === "string") options.expectedDestinationId = expectedDestinationId;
        const result = await message("sync-current", options); await showStatus();
        if (result?.error) setStatus(result.error, {error:true}); else setStatus(`Synced tabs to ${result.destination}.`);
    } finally { syncBusy = false; $("#update").disabled = currentStatus.windowsAvailable === false || !(currentStatus.destination || currentStatus.hasOwners); }
});
$("#sync-elsewhere").addEventListener("click", () => openChooser("elsewhere"));
$("#target-destination").addEventListener("change", fillTargetItems);
$("#chooser-cancel").addEventListener("click", () => { showView("library"); $("#sync-elsewhere").focus(); });
$("#chooser-keep").addEventListener("click", () => { showView("library"); $("#sync-elsewhere").focus(); });
$("#chooser-back").addEventListener("click", () => { $("#chooser-confirm").hidden = true; $("#chooser-actions").hidden = false; $("#chooser-review").focus(); });
$("#chooser-review").addEventListener("click", () => {
    pendingChoice = selectedChoice();
    if (!pendingChoice) { feedback($("#chooser-feedback"), "Choose a destination and browser window.", {error:true}); return; }
    feedback($("#chooser-feedback"), "");
    if (chooserMode === "link" && !$("#live").checked) { applyChoice(); return; }
    $("#chooser-confirm-text").textContent = chooserMode === "link" ? `Live updates may replace the saved tabs in ${pendingChoice.label}. Change the current destination?` : `Replace the saved tabs in ${pendingChoice.label} with tabs from this window? This is a one-time update.`;
    $("#chooser-confirm-button").textContent = chooserMode === "link" ? "Change destination" : "Update saved tabs";
    $("#chooser-actions").hidden = true; $("#chooser-confirm").hidden = false; $("#chooser-confirm-button").focus();
});
$("#chooser-confirm-button").addEventListener("click", applyChoice);
$("#rename-cancel").addEventListener("click", () => { showView("library"); renaming = null; });
$("#rename-form").addEventListener("submit", async event => {
    event.preventDefault(); const name = $("#rename-name").value.trim();
    if (!name) { feedback($("#rename-feedback"), "Give this saved browser a name.", {error:true}); return; }
    const result = await message("rename-saved-browser", {savedBrowserId:renaming.id, name, expectedRevision:renaming.revision || ""});
    if (result?.error) { feedback($("#rename-feedback"), result.error, {error:true}); return; }
    showView("library"); renaming = null; await showStatus(); setStatus(`Renamed saved browser to ${name}.`);
});
$("#create-workspace").addEventListener("click", async () => { const result = await message("create-workspace"); setStatus(result?.error || "Continue creating the workspace in Window Warp.", {error:!!result?.error}); });
$("#open-workspaces").addEventListener("click", async () => { const result = await message("open-workspaces"); setStatus(result?.error || "Opening Workspaces in Window Warp…", {error:!!result?.error}); });
$("#upgrade-open-workspaces").addEventListener("click", async () => { const result = await message("open-workspaces"); if (result?.error) setStatus(result.error, {error:true}); });
api.runtime.onMessage?.addListener(event => { if (event?.event === "warp-live-updated") showStatus(); });
init();
