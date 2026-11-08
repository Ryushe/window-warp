const api = globalThis.browser || globalThis.chrome;
const $ = selector => document.querySelector(selector);
const message = async (action, options) => { try { return await api.runtime.sendMessage({action, options}); } catch { return {error:"The extension could not reach its background process."}; } };
let workspaces = [];
let savedBrowsers = [];
let pendingLive = false;
let manualFill;

function updateProfileHint(chosen) {
    const firefox = typeof api.runtime.getURL === "function" && api.runtime.getURL("").startsWith("moz-extension:");
    $("#save-profile-hint").hidden = firefox || !!chosen;
}

async function currentWindowId() {
    try { return typeof api.windows.getCurrent === "function" ? (await api.windows.getCurrent()).id : undefined; }
    catch { return undefined; }
}

function setConnected(connected) {
    $("#connection").checked = connected;
    if (!connected) $("#live").checked = false;
    $("#pairing-section").hidden = connected;
    $("#connected").hidden = !connected;
}
function switchesBusy(busy) {
    $("#connection").disabled = busy;
    $("#live").disabled = busy;
    $("#connect").disabled = busy;
}
function fillItems() {
    const workspace = workspaces.find(item => item.id === $("#manual-workspace").value);
    const select = $("#manual-item"); select.replaceChildren();
    for (const item of workspace?.items || []) { const option=document.createElement("option"); option.value=String(item.index); option.textContent=item.label; select.append(option); }
}
function fillManual() {
    if (manualFill) return manualFill;
    manualFill = (async () => {
    const workspaceSelect = $("#manual-workspace"); workspaceSelect.replaceChildren();
    for (const workspace of workspaces) { const option=document.createElement("option"); option.value=workspace.id; option.textContent=workspace.name; workspaceSelect.append(option); }
    fillItems();
    const windowSelect = $("#manual-window"); windowSelect.replaceChildren();
    const windows = await api.windows.getAll({populate:true, windowTypes:["normal"]});
    for (const win of windows.filter(win => !win.incognito && win.tabs?.length)) {
        const option=document.createElement("option"); option.value=String(win.id);
        option.textContent = `${win.tabs.find(tab => tab.active)?.title || "Browser window"} (${win.tabs.length} tabs)`;
        windowSelect.append(option);
    }
    $("#use-tabs").disabled = !workspaceSelect.options.length || !$("#manual-item").options.length || !windowSelect.options.length;
    })().finally(() => { manualFill = null; });
    return manualFill;
}
async function showManual() {
    const section = $("#manual"); section.hidden = false; section.open = true;
    await fillManual();
}
async function showStatus() {
    const result = await message("status", {windowId:await currentWindowId()});
    if (result?.error) { $("#status").textContent=result.error; $("#update").disabled=true; return false; }
    $("#status").textContent = result.updatePending ? "Update ready. Reload the extension if needed." : "Connected";
    if (result.storageError) $("#status").textContent = `Connected. ${result.storageError}`;
    workspaces = result.workspaces || [];
    savedBrowsers = result.savedBrowsers || [];
    $("#workspace").textContent = result.destination || "No saved destination yet";
    const settings = await api.storage.local.get(["liveSharing", "liveError"]);
    $("#live").checked = !!result.live && !!settings.liveSharing;
    $("#sharing").textContent = $("#live").checked
        ? result.destination ? "Live tab changes are saved here." : "Live sharing is on. Save this browser or open its workspace to start saving."
        : "Tabs are shared only when requested.";
    if (result.windowsAvailable === false) $("#sharing").textContent = "Connected, but Window Warp can't see open windows yet. Check its desktop integration.";
    if ($("#live").checked && settings.liveError) $("#status").textContent = `Live update failed: ${settings.liveError}`;
    $("#update").disabled = !result.workspace && !workspaces.length;
    $("#update").hidden = !result.workspace && !workspaces.length;
    $("#manual").hidden = !workspaces.length;
    const chosen = (await api.storage.local.get("profilePath")).profilePath || "";
    const select = $("#profile"); select.replaceChildren();
    const fallback = document.createElement("option"); fallback.value=""; fallback.textContent="Detect automatically"; select.append(fallback);
    for (const profile of result.profiles || []) { const option=document.createElement("option"); option.value=profile.path; option.textContent=profile.name; select.append(option); }
    select.value = [...select.options].some(option=>option.value===chosen) ? chosen : "";
    updateProfileHint(chosen);
    return true;
}
async function update(options) {
    $("#update").disabled=true; $("#use-tabs").disabled=true;
    const result=await message("update", options);
    await showStatus();
    if (result?.error) { $("#status").textContent=result.error; if (workspaces.length) await showManual(); }
    else { $("#manual").open=false; $("#status").textContent=`Updated ${result.updated} browser ${result.updated===1 ? "window" : "windows"}${result.workspace ? ` in ${result.workspace}` : ""}.${result.unmatched ? ` ${result.unmatched} need a manual match.` : ""}`; if (result.unmatched) await showManual(); }
}
async function init() {
    const settings=await api.storage.local.get(["enabled","pairing","liveSharing"]);
    $("#pairing").value=settings.pairing || "";
    setConnected(!!settings.enabled && !!settings.pairing);
    if (settings.enabled && settings.pairing) {
        if (!await showStatus()) { $("#pairing-section").hidden = false; $("#connected").hidden = true; }
    } else $("#status").textContent="Connect to get started.";
}
async function changeLive(live) {
    switchesBusy(true);
    try {
        if (!live) await api.storage.local.set({liveSharing:false,liveError:""});
        const result = await message("set-live", {live});
        if (result?.error) {
            $("#live").checked = false;
            $("#status").textContent = result.error;
        } else {
            await api.storage.local.set({liveSharing:live});
            await showStatus();
        }
    } finally { switchesBusy(false); }
}
async function connect(live = false) {
    const pairing = $("#pairing").value.trim();
    if (!pairing) {
        pendingLive = live;
        setConnected(false);
        $("#status").textContent = "Enter the pairing code from Window Warp.";
        $("#pairing").focus();
        return;
    }
    pendingLive = false;
    switchesBusy(true);
    try {
        await api.storage.local.set({pairing,enabled:true,liveSharing:false,liveError:""});
        setConnected(true);
        const reset = await message("set-live", {live:false});
        if (reset?.error || !await showStatus()) {
            await api.storage.local.set({enabled:false,liveSharing:false});
            setConnected(false);
            if (reset?.error) $("#status").textContent = reset.error;
            return;
        }
        if (live) await changeLive(true);
    } finally { switchesBusy(false); }
}
$("#connect").addEventListener("click", () => connect(pendingLive));
$("#connection").addEventListener("change", async event => {
    if (event.target.checked) { await connect(); return; }
    setConnected(false);
    switchesBusy(true);
    try {
        await api.storage.local.set({enabled:false,liveSharing:false});
        await message("disconnect");
        $("#status").textContent="Disconnected.";
    } finally { switchesBusy(false); }
});
$("#live").addEventListener("change", async event => {
    if (event.target.checked && !$("#connection").checked) { await connect(true); return; }
    await changeLive(event.target.checked);
});
$("#profile").addEventListener("change", async event => { const option=event.target.selectedOptions[0]; await api.storage.local.set({profilePath:option.value,profileName:option.value ? option.textContent : ""}); await showStatus(); });
$("#save-browser").addEventListener("click", async () => {
    try {
        const windows = (await api.windows.getAll({populate:true,windowTypes:["normal"]})).filter(win => !win.incognito && win.tabs?.some(tab => tab.url));
        if (!windows.length) { $("#status").textContent="Open a browser window with tabs to save."; return; }
        const select = $("#save-window"); select.replaceChildren();
        for (const win of windows) {
            const option=document.createElement("option"); option.value=String(win.id);
            option.textContent=`${win.tabs.find(tab=>tab.active)?.title || "Browser window"} (${win.tabs.length} tabs)`;
            select.append(option);
        }
        const current = await currentWindowId();
        select.value = String(windows.find(win=>win.id===current)?.id ?? windows.find(win=>win.focused)?.id ?? windows[0].id);
        $("#save-window-label").hidden = windows.length === 1; select.hidden = windows.length === 1;
        $("#browser-name").value = api.runtime.getURL("").startsWith("moz-extension:") ? "Firefox tabs" : "Browser tabs";
        const target=$("#save-target"); target.replaceChildren();
        const fresh=document.createElement("option"); fresh.value=""; fresh.textContent="New saved browser"; target.append(fresh);
        for (const browser of savedBrowsers) { const option=document.createElement("option"); option.value=browser.id; option.textContent=browser.name; target.append(option); }
        target.value=""; target.hidden=!savedBrowsers.length; $("#save-target-label").hidden=!savedBrowsers.length;
        $("#confirm-save-browser").textContent="Save"; $("#replace-browser-confirmation").hidden=true;
        $("#save-feedback").textContent="";
        $("#save-browser-form").hidden=false;
        $("#browser-name").focus(); $("#browser-name").select?.();
    } catch { $("#status").textContent="Could not read the open browser windows. Try again."; }
});
$("#cancel-save-browser").addEventListener("click", () => { $("#save-browser-form").hidden=true; $("#save-browser").focus(); });
$("#save-target").addEventListener("change", event => {
    const browser=savedBrowsers.find(item=>item.id===event.target.value);
    $("#browser-name").value=browser?.name || (api.runtime.getURL("").startsWith("moz-extension:") ? "Firefox tabs" : "Browser tabs");
    $("#confirm-save-browser").textContent=browser ? "Update browser" : "Save";
    $("#replace-browser-confirmation").hidden=true;
});
async function saveBrowser(confirmed = false) {
    const button=$("#confirm-save-browser"), feedback=$("#save-feedback");
    const name=$("#browser-name").value.trim();
    if (!name) { feedback.textContent="Give this browser a name."; feedback.classList.add("error"); $("#browser-name").focus(); return; }
    const savedBrowserId=$("#save-target").value || "";
    if (savedBrowserId && !confirmed) {
        const target=savedBrowsers.find(item=>item.id===savedBrowserId);
        if (!target) { feedback.textContent="Choose a saved browser again."; feedback.classList.add("error"); return; }
        $("#replace-browser-name").textContent=target.name;
        $("#replace-browser-confirmation").hidden=false;
        $("#confirm-replace-browser").focus();
        return;
    }
    button.disabled=true; $("#confirm-replace-browser").disabled=true; feedback.classList.remove("error"); feedback.textContent="Saving…";
    try {
        const options={name,windowId:Number($("#save-window").value)};
        if (savedBrowserId) options.savedBrowserId=savedBrowserId;
        const result=await message("save-browser", options);
        if (result?.error) { feedback.textContent=result.error; feedback.classList.add("error"); return; }
        $("#save-browser-form").hidden=true;
        await showStatus();
        $("#status").textContent=`${savedBrowserId ? "Updated" : "Saved"} ${name}.`;
    } finally { button.disabled=false; $("#confirm-replace-browser").disabled=false; }
}
$("#save-browser-form").addEventListener("submit", event => { event.preventDefault(); saveBrowser(); });
$("#confirm-replace-browser").addEventListener("click", () => saveBrowser(true));
$("#cancel-replace-browser").addEventListener("click", () => { $("#replace-browser-confirmation").hidden=true; $("#confirm-save-browser").focus(); });
$("#create-workspace").addEventListener("click", async () => {
    const button=$("#create-workspace"); button.disabled=true;
    try { const result=await message("create-workspace"); $("#status").textContent=result?.error || "Continue creating the workspace in Window Warp."; }
    finally { button.disabled=false; }
});
$("#open-workspaces").addEventListener("click", async () => {
    const button=$("#open-workspaces"); button.disabled=true;
    try { const result=await message("open-workspaces"); $("#status").textContent=result?.error || "Opening Workspaces in Window Warp…"; }
    finally { button.disabled=false; }
});
$("#update").addEventListener("click", () => update());
$("#manual").addEventListener("toggle", () => { if ($("#manual").open) fillManual(); });
$("#manual-workspace").addEventListener("change", fillItems);
$("#use-tabs").addEventListener("click", () => update({workspaceId:$("#manual-workspace").value,itemIndex:Number($("#manual-item").value),windowId:Number($("#manual-window").value)}));
api.runtime.onMessage?.addListener(message => { if (message?.event === "warp-live-updated") showStatus(); });
init();
