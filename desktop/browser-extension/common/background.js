/* Tab data is shared only for a requested capture, an update, or live sharing. */
const api = globalThis.browser || globalThis.chrome;
const firefox = api.runtime.getURL("").startsWith("moz-extension:");
const alarmPeriod = firefox ? 0.1 : 0.5;
let pending;
let pollTimer;
let liveEnabled = false;
let lastRequest = "";
let polling = null;
let pollAgain = false;
let installation;
const closingWindows = new Set();
let lastLiveState = "";
const inFlightRequests = new Set();

function managedInstallation() {
    installation ||= fetch(api.runtime.getURL("warp-managed.json")).then(response => response.json()).then(value => typeof value.id === "string" ? value.id : "").catch(() => "");
    return installation;
}
function newerVersion(next, current) {
    const parse = value => {
        if (typeof value !== "string" || !/^\d+(\.\d+){0,3}$/.test(value)) return null;
        const parts = value.split(".").map(Number);
        return parts.every(part => Number.isSafeInteger(part) && part <= 65535) ? parts : null;
    };
    const a = parse(next), b = parse(current);
    if (!a || !b) return false;
    for (let index=0; index<4; index++) {
        const difference = (a[index] || 0) - (b[index] || 0);
        if (difference) return difference > 0;
    }
    return false;
}
async function reloadUpdatedExtension(status) {
    if (!status.extensionVersion || !api.runtime.getManifest || !api.runtime.reload || !api.management?.getSelf || !newerVersion(status.extensionVersion, api.runtime.getManifest().version)) return false;
    try {
        const id = await managedInstallation();
        if (!id || (await api.management.getSelf()).installType !== "development") return false;
        const key = `${id}:${status.extensionVersion}`;
        if ((await api.storage.local.get("attemptedUpdate")).attemptedUpdate === key) return false;
        await api.storage.local.set({attemptedUpdate:key});
        api.runtime.reload();
        return true;
    } catch { return false; }
}

async function snapshot(action = "snapshot", options = {}) {
    const request = snapshotRequest(action, options);
    inFlightRequests.add(request);
    try { return await request; } finally { inFlightRequests.delete(request); }
}

async function snapshotRequest(action, options) {
    const settings = await api.storage.local.get(["enabled", "pairing", "profilePath", "profileName", "clientId", "liveSharing"]);
    if ((!settings.enabled && action !== "disconnect") || !settings.pairing) return {error:"Connect this browser to Window Warp first."};
    if (options.live && action === "snapshot" && !settings.liveSharing) return {error:"Live tab sharing is off."};
    const [port, token] = settings.pairing.split(":");
    if (!/^\d{1,5}$/.test(port || "") || !/^[a-f0-9]{32}$/.test(token || "")) return {error:"Check the pairing code in Window Warp settings."};
    if (!settings.clientId) {
        settings.clientId = crypto.randomUUID();
        await api.storage.local.set({clientId:settings.clientId});
    }
    const open = ["poll", "status", "disconnect", "set-live", "create-workspace", "open-workspaces", "focus-result"].includes(action) ? [] : await api.windows.getAll({populate:true, windowTypes:["normal"]});
    const windows = open.filter(window => !window.incognito && !closingWindows.has(window.id)).map(window => {
        const tabs = (window.tabs || []).filter(tab => typeof tab.url === "string" && tab.url.length > 0);
        return {id:window.id, title:tabs.find(tab=>tab.active)?.title || "", x:window.left, y:window.top, width:window.width, height:window.height,
            activeTab:Math.max(1, tabs.findIndex(tab=>tab.active)+1), tabs:tabs.map(tab=>({url:tab.url,title:tab.title || ""}))};
    }).filter(window => window.tabs.length > 0);
    try {
        const response = await fetch(`http://127.0.0.1:${port}/bridge`, {method:"POST", headers:{"Content-Type":"text/plain"},
            body:JSON.stringify({token, action, clientId:settings.clientId, installationId:await managedInstallation(), browser:firefox ? "firefox" : "chromium", supportsFocus:true, profilePath:open.length ? settings.profilePath || "" : "", profileName:open.length ? settings.profileName || "" : "", windows, ...options})});
        const result = await response.json();
        if (["poll", "status"].includes(action) && !result.error) liveEnabled = !!result.live && !!settings.liveSharing;
        if (action === "status" && result.extensionVersion && api.runtime.getManifest) result.updatePending = newerVersion(result.extensionVersion, api.runtime.getManifest().version);
        return result;
    } catch { return {error:"Cannot reach Window Warp. Open the app and check the pairing code."}; }
}

async function focusRequestedTab(command) {
    let success = false;
    try {
        const windows = await api.windows.getAll({populate:true, windowTypes:["normal"]});
        const window = windows.find(item => item.id === command.windowId && !item.incognito && !closingWindows.has(item.id));
        const tabs = (window?.tabs || []).filter(tab => typeof tab.url === "string" && tab.url.length > 0);
        if (Array.isArray(command.expectedUrls) && tabs.length === command.expectedUrls.length
            && tabs.every((tab, index) => tab.url === command.expectedUrls[index])
            && Number.isInteger(command.tabIndex) && tabs[command.tabIndex]?.id != null) {
            await api.tabs.update(tabs[command.tabIndex].id, {active:true});
            success = true;
        }
    } catch { /* The browser window or tab may have closed. */ }
    await snapshot("focus-result", {requestId:command.id, name:success ? "ok" : "failed"});
}

async function sendLiveSnapshot() {
    const result = await snapshot("snapshot", {live:true});
    const message = result.error || "";
    if ((await api.storage.local.get("liveError")).liveError !== message) await api.storage.local.set({liveError:message});
    const state = JSON.stringify({destinations:result.destinations || {},error:message});
    if (state !== lastLiveState) {
        lastLiveState = state;
        try { if (api.runtime.sendMessage) await api.runtime.sendMessage({event:"warp-live-updated"}); } catch {}
    }
    return result;
}

function poll() {
    if (polling) { pollAgain = true; return polling; }
    polling = (async () => {
        clearTimeout(pollTimer);
        let connected = false;
        try {
            do {
                pollAgain = false;
                const settings = await api.storage.local.get(["enabled", "pairing", "liveError"]);
                connected = !!settings.enabled && !!settings.pairing;
                const alarm = await api.alarms.get("connection");
                if (connected && (!alarm || alarm.periodInMinutes !== alarmPeriod)) await api.alarms.create("connection", {periodInMinutes:alarmPeriod});
                else if (!connected && alarm) await api.alarms.clear("connection");
                if (connected) {
                    const wasLive = liveEnabled;
                    const status = await snapshot("poll");
                    if (status.requestId && status.requestId !== lastRequest) {
                        const result = await snapshot("snapshot", {requestId:status.requestId});
                        if (!result.error) lastRequest = status.requestId;
                    } else if (!status.error && liveEnabled && (!wasLive || settings.liveError)) await sendLiveSnapshot();
                    if (!status.error && Array.isArray(status.focusCommands)) for (const command of status.focusCommands) await focusRequestedTab(command);
                    if (!status.error) await reloadUpdatedExtension(status);
                } else liveEnabled = false;
            } while (pollAgain);
        } finally {
            polling = null;
            if (connected) pollTimer = setTimeout(poll, 5000);
        }
    })();
    return polling;
}
function schedule() {
    if (!liveEnabled) return;
    clearTimeout(pending);
    pending = setTimeout(async () => {
        const status = await snapshot("poll");
        if (!status.error && liveEnabled) await sendLiveSnapshot();
    }, 500);
}
for (const event of [api.tabs.onCreated, api.tabs.onUpdated, api.tabs.onActivated, api.tabs.onMoved, api.tabs.onAttached, api.tabs.onDetached, api.windows.onCreated, api.windows.onFocusChanged].filter(Boolean)) event.addListener(schedule);
api.tabs.onRemoved.addListener((_tabId, info) => { if (info?.isWindowClosing) closingWindows.add(info.windowId); schedule(); });
api.windows.onRemoved.addListener(windowId => { closingWindows.delete(windowId); schedule(); });
api.runtime.onStartup.addListener(poll);
api.runtime.onInstalled.addListener(poll);
api.storage.onChanged.addListener(changes => { if (changes.liveSharing?.newValue === false || changes.enabled?.newValue === false) lastLiveState=""; if (changes.enabled || changes.pairing || changes.liveSharing) poll(); });
api.alarms.onAlarm.addListener(alarm => { if (alarm.name === "connection") return poll(); });
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!["status", "snapshot", "update", "disconnect", "set-live", "save-browser", "create-workspace", "open-workspaces"].includes(message?.action)) return false;
    const options = message.action === "snapshot" ? {explicit:true} : (message.options || {});
    const run = async () => {
        if (message.action === "disconnect") {
            clearTimeout(pending);
            await Promise.allSettled([...inFlightRequests]);
        }
        return snapshot(message.action, options);
    };
    run().then(sendResponse, error => sendResponse({error:String(error)}));
    return true;
});
poll();
