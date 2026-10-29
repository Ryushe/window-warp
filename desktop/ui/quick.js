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
let conflictSaving = false;
let saving = false;
let editVersion = 0;
let previewVersion = 0;

function clearConflict() {
    conflictProposal = null;
    document.querySelector("#quick-conflict").hidden = true;
    if (!saving) document.querySelector(".quick-sheet").removeAttribute("inert");
    document.querySelector("#quick-conflict-error").textContent = "";
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
document.querySelector("#quick-entry").addEventListener("keydown", (event) => {
    if (saving) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }
}, true);
watchShortcutPicker(document.querySelector(".quick-sheet"), (shortcut) => {
    editVersion++;
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
    clearConflict();
    const target = previousWindow;
    previousWindow = null;
    const wasOpen = await native.core.invoke("hide_quick").catch(() => false);
    if (wasOpen && restoreFocus && target?.id) {
        native.core.invoke("focus_captured", { id: String(target.id), pid: target.pid }).catch(() => {});
    }
}
function editBinding(index, { blank = false } = {}) {
    const binding = config.bindings[index];
    editVersion++;
    quick = { index, created: false };
    document.querySelector("#quick-app").textContent = binding.label;
    document.querySelector("#quick-behavior-section").hidden = !["pull-app", "focus-app"].includes(binding.action);
    document.querySelector("#quick-behavior").value = binding.mainMonitorAction || "burner";
    document.querySelector("#quick-layout").value = binding.burnerLayout || "float";
    document.querySelector("#quick-apply").disabled = false;
    const claimed = binding.enabled === false && config.bindings.some((other, otherIndex) =>
        otherIndex !== index && other.enabled !== false && other.shortcut === binding.shortcut);
    recorded = blank || claimed ? "" : binding.shortcut || "";
    showRecorded();
    if (!recorded) {
        const modifier = config.settings?.quickModifier || "Super";
        document.querySelector(`[data-mod="${modifier}"]`)?.setAttribute("aria-pressed", "true");
    }
    showHint();
    document.querySelector("#quick-entry")?.focus();
}
async function openEditor(payload) {
    const generation = ++popupGeneration;
    editVersion++;
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
    editBinding(index);
    quick.created = created;
}
document.querySelector("#quick-behavior").addEventListener("change", () => { editVersion++; clearConflict(); showHint(); });
document.querySelector("#quick-layout").addEventListener("change", () => { editVersion++; clearConflict(); showHint(); });
document.querySelector("#quick-open").addEventListener("click", async () => {
    popupGeneration++;
    pendingKeys = Promise.resolve();
    const app = document.querySelector("#quick-app").textContent;
    await native.core.invoke("show_editor", { appMatch: app || null }).catch(() => {});
    await native.core.invoke("hide_quick").catch(() => {});
});
document.querySelector("#quick-cancel").addEventListener("click", () => closePopup(true));
async function saveQuick(value) {
    const generation = popupGeneration;
    if (!await persistConfig(value)) return;
    if (generation !== popupGeneration) return;
    quick = null;
    await closePopup(true);
}
async function persistConfig(value) {
    if (saving) return false;
    saving = true;
    const sheet = document.querySelector(".quick-sheet");
    const apply = document.querySelector("#quick-apply");
    sheet.setAttribute("inert", "");
    apply.disabled = true;
    try {
        await native.core.invoke("save_config", {config:value});
        return true;
    } finally {
        saving = false;
        if (!conflictProposal) sheet.removeAttribute("inert");
        apply.disabled = !quick;
    }
}
document.querySelector("#quick-keep").addEventListener("click", () => {
    if (conflictSaving) return;
    clearConflict();
    document.querySelector("#quick-entry")?.focus();
});
document.querySelector("#quick-conflict").addEventListener("click", (event) => {
    if (!conflictSaving && event.target === event.currentTarget) {
        clearConflict();
        document.querySelector("#quick-entry")?.focus();
    }
});
async function replaceConflict(editOld) {
    if (!conflictProposal || conflictSaving || saving) return;
    const proposal = conflictProposal;
    const generation = popupGeneration;
    conflictSaving = true;
    const buttons = document.querySelectorAll(".quick-conflict-actions button");
    buttons.forEach(button => { button.disabled = true; });
    try {
        if (!editOld) {
            await saveQuick(proposal.config);
        } else {
            if (!await persistConfig(proposal.config)) return;
            if (generation !== popupGeneration || !await native.core.invoke("quick_is_open").catch(() => false) || generation !== popupGeneration) return;
            config = proposal.config;
            clearConflict();
            document.querySelector("#quick-message").textContent = "Choose a new shortcut for the previous action.";
            editBinding(proposal.disabledIndices[0], { blank: true });
        }
    } catch (error) {
        if (generation === popupGeneration && conflictProposal === proposal) document.querySelector("#quick-conflict-error").textContent = String(error);
    } finally {
        conflictSaving = false;
        buttons.forEach(button => { button.disabled = false; });
    }
}
document.querySelector("#quick-replace").addEventListener("click", () => replaceConflict(false));
document.querySelector("#quick-replace-edit").addEventListener("click", () => replaceConflict(true));
document.querySelector("#quick-apply").addEventListener("click", async () => {
    if (!quick || saving) return;
    if (!recorded) {
        document.querySelector("#quick-message").textContent = "Choose a modifier and a key first.";
        return;
    }
    const binding = config.bindings[quick.index];
    binding.shortcut = recorded;
    if (["pull-app", "focus-app"].includes(binding.action)) {
        binding.mainMonitorAction = document.querySelector("#quick-behavior").value;
        binding.burnerLayout = document.querySelector("#quick-layout").value;
    }
    const generation = popupGeneration;
    const version = editVersion;
    const preview = ++previewVersion;
    const index = quick.index;
    try {
        const proposal = await native.core.invoke("preview_shortcut_reassignment", {config, index});
        if (generation !== popupGeneration || version !== editVersion || preview !== previewVersion || quick?.index !== index) return;
        if (proposal.disabledIndices.length) {
            conflictProposal = proposal;
            const names = proposal.disabledIndices.map(index => proposal.config.bindings[index].label);
            document.querySelector("#quick-conflict-summary").textContent = `${recorded} is used by ${names.join(", ")}. Replace it, or replace it and choose a new key for the previous action.`;
            document.querySelector("#quick-conflict").hidden = false;
            document.querySelector(".quick-sheet").setAttribute("inert", "");
            document.querySelector("#quick-keep").focus();
            return;
        }
        await saveQuick(proposal.config);
    } catch (error) {
        if (generation === popupGeneration && version === editVersion && preview === previewVersion) document.querySelector("#quick-message").textContent = String(error);
    }
});
function handleKey(event) {
    if (isEditorShortcut(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) document.querySelector("#quick-open").click();
        return;
    }
    if (saving && !conflictProposal) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }
    if (conflictProposal) {
        if (conflictSaving) return;
        if (event.key === "Escape") {
            event.preventDefault();
            clearConflict();
            document.querySelector("#quick-entry")?.focus();
        } else if (event.key === "Tab") {
            const buttons = [...document.querySelectorAll(".quick-conflict-actions button")].filter(button => !button.disabled);
            const index = buttons.indexOf(document.activeElement);
            if (buttons.length && ((event.shiftKey && index <= 0) || (!event.shiftKey && index === buttons.length - 1))) {
                event.preventDefault();
                buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
            }
        }
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
    editVersion++;
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
native?.event.listen("quick-hidden", async () => {
    const generation = popupGeneration;
    const open = await native.core.invoke("quick_is_open").catch(() => false);
    if (open || generation !== popupGeneration) return;
    popupGeneration++;
    editVersion++;
    pendingKeys = Promise.resolve();
    previousWindow = null;
    quick = null;
    clearConflict();
});
native?.core.invoke("quick_edit").then((pending) => { if (pending) openEditor(pending); }).catch(() => {});
