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
let configReady = Promise.resolve(null);
let popupGeneration = 0;
let pendingKeys = Promise.resolve();
let quick = null;
let recorded = "";
let previousWindow = null;
let conflictProposal = null;

function clearConflict() {
    conflictProposal = null;
    document.querySelector("#quick-conflict").hidden = true;
}

function baseName(value) {
    return String(value || "").split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();
}
function appName(window) {
    return window?.appId || window?.path?.split(/[\\/]/).pop() || window?.desktopId || "";
}
function sameApp(binding, info, app) {
    const needles = [binding.appMatch, ...(binding.appMatches || []), binding.windowsMatch?.executable, binding.label].map(baseName).filter(name => name.length > 1);
    const hay = [app, info?.appId, info?.path, info?.desktopId].map(baseName).filter(Boolean);
    return needles.some(name => hay.includes(name));
}
function bindingIndex(info, app) {
    return config.bindings.findIndex(binding => ["pull-app", "focus-app"].includes(binding.action) && sameApp(binding, info, app));
}
function showRecorded() {
    const entry = document.querySelector("#quick-entry");
    entry.value = recorded || "";
    entry.placeholder = recorded ? "" : "Press a key";
    syncShortcutPicker(document.querySelector(".quick-sheet"), recorded);
}
watchShortcutPicker(document.querySelector(".quick-sheet"), (shortcut) => {
    clearConflict();
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
function isEditorShortcut(event) {
    const editor = config?.bindings.find(binding => binding.enabled !== false && binding.action === "open-editor");
    const key = shortcutKeyFromEvent(event);
    if (!editor || !key) return false;
    const modifiers = new Set();
    if (event.ctrlKey) modifiers.add("Ctrl");
    if (event.altKey) modifiers.add("Alt");
    if (event.shiftKey) modifiers.add("Shift");
    if (event.metaKey) modifiers.add("Super");
    return formatShortcut(modifiers, key) === editor.shortcut;
}
async function closePopup(restoreFocus) {
    popupGeneration++;
    pendingKeys = Promise.resolve();
    const target = previousWindow;
    previousWindow = null;
    await native.core.invoke("hide_quick").catch(() => {});
    if (restoreFocus && target?.id) {
        native.core.invoke("focus_captured", { id: String(target.id), pid: target.pid }).catch(() => {});
    }
}
async function openEditor(payload) {
    const generation = ++popupGeneration;
    pendingKeys = Promise.resolve();
    config = undefined;
    quick = null;
    // The editor chord also works when the current window has no app name.
    // Keep keys entered while this request is pending until its result arrives.
    const ready = native.core.invoke("get_config").then((loaded) => {
        if (generation === popupGeneration) config = loaded;
        return loaded;
    }).catch((error) => {
        if (generation === popupGeneration) {
            document.querySelector("#quick-message").textContent = String(error);
            document.querySelector("#quick-apply").disabled = true;
        }
        return null;
    });
    configReady = ready;
    clearConflict();
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
        await ready;
        return;
    }
    if (!await ready || generation !== popupGeneration) return;
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
    if (!recorded) {
        const modifier = config.settings?.quickModifier || "Super";
        const button = document.querySelector(`[data-mod="${modifier}"]`);
        if (button) button.setAttribute("aria-pressed", "true");
    }
    showHint();
    document.querySelector("#quick-entry")?.focus();
}
document.querySelector("#quick-behavior").addEventListener("change", () => { clearConflict(); showHint(); });
document.querySelector("#quick-layout").addEventListener("change", () => { clearConflict(); showHint(); });
document.querySelector("#quick-open").addEventListener("click", async () => {
    popupGeneration++;
    pendingKeys = Promise.resolve();
    const app = document.querySelector("#quick-app").textContent;
    await native.core.invoke("show_editor", { appMatch: app || null }).catch(() => {});
    await native.core.invoke("hide_quick").catch(() => {});
});
document.querySelector("#quick-cancel").addEventListener("click", () => closePopup(true));
async function saveQuick(value) {
    await native.core.invoke("save_config", {config:value});
    quick = null;
    await closePopup(true);
}
document.querySelector("#quick-keep").addEventListener("click", clearConflict);
document.querySelector("#quick-replace").addEventListener("click", async () => {
    if (!conflictProposal) return;
    try { await saveQuick(conflictProposal.config); }
    catch (error) { document.querySelector("#quick-message").textContent = String(error); }
});
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
        const proposal = await native.core.invoke("preview_shortcut_reassignment", {config, index:quick.index});
        if (proposal.disabledIndices.length) {
            conflictProposal = proposal;
            const names = proposal.disabledIndices.map(index => proposal.config.bindings[index].label);
            document.querySelector("#quick-conflict-summary").textContent = `${recorded} is used by ${names.join(", ")}. Replacing it disables those shortcuts but keeps their settings.`;
            document.querySelector("#quick-conflict").hidden = false;
            return;
        }
        await saveQuick(config);
    } catch (error) {
        document.querySelector("#quick-message").textContent = String(error);
    }
});
function handleKey(event) {
    if (isEditorShortcut(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) document.querySelector("#quick-open").click();
        return;
    }
    if (event.key === "Escape") { event.preventDefault(); closePopup(true); return; }
    if (event.key === "Enter") {
        if (["SELECT", "BUTTON"].includes(event.target?.tagName)) return;
        event.preventDefault();
        document.querySelector("#quick-apply")?.click();
        return;
    }
    if (event.key === "Tab" || event.target?.tagName === "SELECT" || (event.target?.tagName === "BUTTON" && event.key === " ")) return;
    const named = shortcutKeyFromEvent(event);
    if (!named) return;
    clearConflict();
    event.preventDefault();
    const root = document.querySelector(".quick-sheet");
    root.dataset.shortcutKey = named;
    recorded = readShortcutPicker(root);
    showRecorded();
}
document.addEventListener("keydown", (event) => {
    if (config || event.key === "Escape" || event.key === "Tab" || event.target?.tagName === "SELECT" || (event.target?.tagName === "BUTTON" && (event.key === " " || event.key === "Enter"))) {
        handleKey(event);
        return;
    }
    if (event.key !== "Enter" && !shortcutKeyFromEvent(event)) return;
    // Event objects can be reused by the browser, so retain only the fields
    // needed after the config request finishes. Prevent the picker from
    // consuming this chord before it can be compared to the editor shortcut.
    event.preventDefault();
    event.stopImmediatePropagation();
    const generation = popupGeneration;
    const ready = configReady;
    const key = {
        key: event.key, code: event.code, repeat: event.repeat,
        ctrlKey: event.ctrlKey, altKey: event.altKey,
        shiftKey: event.shiftKey, metaKey: event.metaKey,
        target: event.target, preventDefault() {}, stopImmediatePropagation() {}
    };
    pendingKeys = pendingKeys.then(() => ready).then((loaded) => {
        if (loaded && generation === popupGeneration) handleKey(key);
    });
}, true);
native?.event.listen("quick-edit", (event) => openEditor(event.payload || {}));
native?.core.invoke("quick_edit").then((pending) => { if (pending) openEditor(pending); }).catch(() => {});
