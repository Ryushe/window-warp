const native = window.__TAURI__;
const HINTS = {
    "focus-last": "Brings the app to the main monitor. If it is already focused there, switches back to the previous app.",
    burner: "Brings the app to the main monitor. If it is already focused there, sends it to the burner monitor.",
    float: "Keeps the window's size and place, scaled onto that monitor.",
    "tile-left": "Uses the left half of that monitor.",
    "tile-right": "Uses the right half of that monitor.",
    fullscreen: "Fills that monitor."
};
let config;
let quick = null;
let recorded = "";
let previousWindow = null;

function baseName(value) {
    return String(value || "").split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();
}
function appName(window) {
    return window?.appId || window?.path?.split(/[\\/]/).pop() || window?.desktopId || "";
}
function sameApp(binding, info, app) {
    const needles = [binding.appMatch, binding.windowsMatch?.executable, binding.label].map(baseName).filter(name => name.length > 1);
    const hay = [app, info?.appId, info?.path, info?.desktopId].map(baseName).filter(Boolean);
    return needles.some(name => hay.includes(name));
}
function bindingIndex(info, app) {
    return config.bindings.findIndex(binding => ["pull-app", "focus-app"].includes(binding.action) && sameApp(binding, info, app));
}
function showRecorded() {
    const entry = document.querySelector("#quick-entry");
    entry.value = recorded || "";
    entry.placeholder = recorded ? "" : "Press a shortcut";
}
function showHint() {
    document.querySelector("#quick-behavior-hint").textContent = HINTS[document.querySelector("#quick-behavior").value] || "";
    document.querySelector("#quick-layout-hint").textContent = HINTS[document.querySelector("#quick-layout").value] || "";
}
async function closePopup(restoreFocus) {
    native?.core.invoke("stop_shortcut_recording").catch(() => {});
    const target = previousWindow;
    previousWindow = null;
    await native.core.invoke("hide_quick").catch(() => {});
    if (restoreFocus && target?.id) {
        native.core.invoke("focus_captured", { id: String(target.id), pid: target.pid }).catch(() => {});
    }
}
async function openEditor(payload) {
    const windowInfo = payload?.window || null;
    previousWindow = windowInfo;
    const preset = typeof payload?.shortcut === "string" ? payload.shortcut : "";
    const named = payload?.label || appName(windowInfo);
    recorded = preset;
    document.querySelector("#quick-title").textContent = "Shortcut";
    document.querySelector("#quick-app").textContent = named || "Focus an application window, then try again.";
    document.querySelector("#quick-message").textContent = "";
    showRecorded();
    if (!named) {
        document.querySelector("#quick-apply").disabled = true;
        return;
    }
    config = await native.core.invoke("get_config");
    let index = Number.isInteger(payload?.bindingIndex) ? payload.bindingIndex : -1;
    let created = false;
    if (index < 0 || !config.bindings[index]) index = bindingIndex(windowInfo, named);
    if (index < 0) {
        config.bindings.push({ label: named.replace(/\.exe$/i, "").slice(0, 120), shortcut: preset, action: "pull-app", appMatch: appName(windowInfo) || named, enabled: true, mainMonitorAction: "burner", burnerLayout: "float" });
        index = config.bindings.length - 1;
        created = true;
    }
    const binding = config.bindings[index];
    if (preset) binding.shortcut = preset;
    if (payload.label) binding.label = payload.label;
    if (payload.mainMonitorAction) binding.mainMonitorAction = payload.mainMonitorAction;
    if (payload.burnerLayout) binding.burnerLayout = payload.burnerLayout;
    quick = { index, created };
    document.querySelector("#quick-app").textContent = binding.label || named;
    document.querySelector("#quick-behavior").value = binding.mainMonitorAction || "burner";
    document.querySelector("#quick-layout").value = binding.burnerLayout || "float";
    document.querySelector("#quick-apply").disabled = false;
    recorded = binding.shortcut || preset;
    showRecorded();
    showHint();
    native.core.invoke("start_shortcut_recording", { popup: true }).catch(() => {});
}
document.querySelector("#quick-behavior").addEventListener("change", showHint);
document.querySelector("#quick-layout").addEventListener("change", showHint);
document.querySelector("#quick-open").addEventListener("click", async () => {
    const app = document.querySelector("#quick-app").textContent;
    native?.core.invoke("stop_shortcut_recording").catch(() => {});
    await native.core.invoke("show_editor", { appMatch: app || null }).catch(() => {});
    await native.core.invoke("hide_quick").catch(() => {});
});
document.querySelector("#quick-cancel").addEventListener("click", () => closePopup(true));
document.querySelector("#quick-apply").addEventListener("click", async () => {
    if (!quick) return;
    if (!recorded) {
        document.querySelector("#quick-message").textContent = "Press a shortcut first.";
        return;
    }
    const binding = config.bindings[quick.index];
    binding.shortcut = recorded;
    binding.mainMonitorAction = document.querySelector("#quick-behavior").value;
    binding.burnerLayout = document.querySelector("#quick-layout").value;
    try {
        await native.core.invoke("save_config", { config });
        quick = null;
        await closePopup(true);
    } catch (error) {
        document.querySelector("#quick-message").textContent = String(error);
    }
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closePopup(true); }
});
native?.event.listen("shortcut-recorded", (event) => {
    const shortcut = event.payload || "";
    if (!shortcut) { closePopup(true); return; }
    if (shortcut === "clear") { recorded = ""; showRecorded(); return; }
    recorded = shortcut;
    showRecorded();
});
native?.event.listen("quick-edit", (event) => openEditor(event.payload || {}));
native?.core.invoke("quick_edit").then((pending) => { if (pending) openEditor(pending); }).catch(() => {});
