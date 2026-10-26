const native = window.__TAURI__;
const SECOND_MONITOR = "Where the window sits after it moves to the second monitor.";
const HINTS = {
    "focus-last": "It is already on the main monitor, so this press goes back to the previous app.",
    burner: "It is already on the main monitor, so this press sends it to the second monitor.",
    float: SECOND_MONITOR,
    "tile-left": SECOND_MONITOR,
    "tile-right": SECOND_MONITOR,
    fullscreen: SECOND_MONITOR
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
    entry.placeholder = recorded ? "" : "Click, then press C, X, or another key";
    syncShortcutPicker(document.querySelector(".quick-sheet"), recorded);
}
watchShortcutPicker(document.querySelector(".quick-sheet"), (shortcut) => {
    recorded = shortcut;
    document.querySelector("#quick-entry").value = shortcut;
    document.querySelector("#quick-message").textContent = "";
});
function showHint() {
    const behavior = document.querySelector("#quick-behavior-hint");
    const layout = document.querySelector("#quick-layout-hint");
    if (behavior) behavior.textContent = HINTS[document.querySelector("#quick-behavior").value] || "";
    if (layout) layout.textContent = HINTS[document.querySelector("#quick-layout").value] || "";
}
function shortcutKeyFromEvent(event) {
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return "";
    const key = String(event.code || event.key || "").replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "");
    if (SHORTCUT_KEYS.includes(key)) return key;
    return SHORTCUT_KEYS.includes(key.toUpperCase()) ? key.toUpperCase() : "";
}
async function closePopup(restoreFocus) {
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
    document.querySelector("#quick-entry")?.focus();
}
document.querySelector("#quick-behavior").addEventListener("change", showHint);
document.querySelector("#quick-layout").addEventListener("change", showHint);
document.querySelector("#quick-open").addEventListener("click", async () => {
    const app = document.querySelector("#quick-app").textContent;
    await native.core.invoke("show_editor", { appMatch: app || null }).catch(() => {});
    await native.core.invoke("hide_quick").catch(() => {});
});
document.querySelector("#quick-cancel").addEventListener("click", () => closePopup(true));
document.querySelector("#quick-apply").addEventListener("click", async () => {
    if (!quick) return;
    if (!recorded) {
        document.querySelector("#quick-message").textContent = "Choose a modifier and a key first.";
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
    if (event.key === "Escape") { event.preventDefault(); closePopup(true); return; }
    if (event.key === "Enter") {
        if (event.target?.tagName === "SELECT") return;
        event.preventDefault();
        document.querySelector("#quick-apply")?.click();
        return;
    }
    if (event.target?.tagName === "BUTTON") return;
    const named = shortcutKeyFromEvent(event);
    if (!named) return;
    event.preventDefault();
    const root = document.querySelector(".quick-sheet");
    root.dataset.shortcutKey = named;
    recorded = readShortcutPicker(root);
    showRecorded();
}, true);
native?.event.listen("quick-edit", (event) => openEditor(event.payload || {}));
native?.core.invoke("quick_edit").then((pending) => { if (pending) openEditor(pending); }).catch(() => {});
