const $ = (selector) => document.querySelector(selector);
let config;
let savedConfig = null;
let enabled = false;
let dirty = false;
let busy = false;
let platform = "";
let reassignment = null;
let controlPending = false;
let startupEnabled = false;
let startupKnown = false;
let openBinding = -1;
const native = window.__TAURI__;
const THEME_KEYS = ["bg", "sidebar", "text", "chord", "button"];
function actionSummary(action) {
    const name = String(action || "");
    if (name.startsWith("push-")) return "Push window";
    if (name.startsWith("tile-")) return "Tile window";
    return {
        pull: "Bring the last window back",
        "toggle-maximize": "Maximize or restore",
        "close-window": "Close the window",
        "pull-app": "Bring this app here",
        "focus-app": "Cycle windows",
        "toggle-pause": "Pause or resume",
        "open-editor": "Edit this app",
        "open-workspaces": "Browse workspaces",
        "update-workspace": "Save workspace"
    }[name] || "Action";
}
function themeStorage() {
    try { return window.localStorage || null; } catch { return null; }
}
function buttonInk(hex) {
    const value = String(hex || "").replace("#", "");
    if (!/^[0-9a-f]{6}$/i.test(value)) return "#1c1b19";
    const red = parseInt(value.slice(0, 2), 16), green = parseInt(value.slice(2, 4), 16), blue = parseInt(value.slice(4, 6), 16);
    return (red * 299 + green * 587 + blue * 114) / 1000 > 150 ? "#1c1b19" : "#f4efe6";
}
function currentThemeColors() {
    const colors = {};
    for (const key of THEME_KEYS) colors[key] = $("#theme-" + key)?.value || "";
    return colors;
}
function applyTheme(name, colors, css) {
    const theme = ["warp", "dracula", "ink", "light", "custom"].includes(name) ? name : "warp";
    document.documentElement.dataset.theme = theme;
    if (colors) {
        for (const key of THEME_KEYS) if (colors[key]) document.documentElement.style.setProperty("--custom-" + key, colors[key]);
        if (colors.button) document.documentElement.style.setProperty("--custom-button-text", buttonInk(colors.button));
    }
    let style = document.getElementById("theme-user-css");
    if (!style) {
        style = document.createElement("style");
        style.id = "theme-user-css";
        document.head.append(style);
    }
    style.textContent = String(css || "").replace(/<\/style/gi, "");
    const store = themeStorage();
    if (store) {
        store.setItem("window-warp-theme", theme);
        if (colors) store.setItem("window-warp-theme-colors", JSON.stringify(colors));
        store.setItem("window-warp-theme-css", String(css || ""));
    }
    const select = $("#theme");
    if (select && select.value !== theme) select.value = theme;
    const custom = $("#theme-custom");
    if (custom) custom.hidden = theme !== "custom";
    try { window.__TAURI__?.event?.emit?.("warp-theme", { name: theme, colors: colors || null, css: String(css || "") }); } catch { /* the popup keeps the last theme it could read */ }
}

function message(text, error = false) {
    $("#message").textContent = text;
    $("#message").classList.toggle("error", error);
}
function controls() {
    $("#toggle").disabled = busy || !config || (!enabled && dirty);
    $("#toggle").classList.toggle("is-on", enabled);
    $("#toggle").title = enabled ? "Pause shortcuts" : "Enable shortcuts";
    $("#status").textContent = enabled ? "Shortcuts active" : "Paused";
    $("#status").classList.toggle("active", enabled);
    document.body.classList.toggle("is-dirty", dirty);
    const cannotSave = busy || !dirty || !config;
    $("#save").disabled = cannotSave;
    $("#save-settings").disabled = cannotSave;
    $("#discard").disabled = cannotSave;
    $("#discard-settings").disabled = cannotSave;
    $("#add").disabled = busy || !config;
    $("#bindings").querySelectorAll("input, select, button").forEach((el) => { el.disabled = busy; });
    $("#quick-shortcut").disabled = $("#quick-apply").disabled = $("#quick-behavior").disabled = $("#quick-layout").disabled = busy;
    $("#main-monitor").disabled = $("#burner-monitor").disabled = busy || !config;
    $("#hold-mode").disabled = $("#hold-enabled").disabled = $("#hold-delay").disabled = busy || !config;
    $("#enable-on-launch").disabled = busy || !config;
    $("#startup").disabled = busy || !startupKnown;
    $("#import-files").disabled = busy || enabled || !config;
    $("#apply-import").disabled = busy || enabled || !config;
    $("#edit-hint").textContent = enabled ? "Shortcuts are on. Save updates them without pausing." : "Save, then turn shortcuts on.";
    const saveStatus = dirty ? "Unsaved changes" : "Stored on this device";
    $("#save-status").textContent = saveStatus;
    $("#settings-save-status").textContent = saveStatus;
}
function cancelReassignment() {
    reassignment = null;
    document.querySelectorAll(".reassignment").forEach(panel => { panel.hidden = true; });
}
function changed() { cancelReassignment(); dirty = true; controls(); }
function copyConfig(value) { return JSON.parse(JSON.stringify(value)); }
function rememberSaved() { savedConfig = copyConfig(config); }
function discardChanges() {
    if (busy || !dirty || !savedConfig) return;
    config = copyConfig(savedConfig);
    dirty = false;
    quick = null;
    $("#quick-edit").hidden = true;
    render();
    message("Canceled unsaved changes.");
}
function render() {
    cancelReassignment();
    $("#bindings").replaceChildren();
    config.bindings.forEach((binding, index) => {
        const card = $("#binding-template").content.cloneNode(true);
        const match = card.querySelector(".match-field");
        const options = card.querySelector(".app-options");
        const windowsFields = card.querySelector(".windows-match-field");
        const windowsDetails = card.querySelector(".windows-match-details");
        const windowsToggle = card.querySelector(".windows-match-enabled");
        const executableCriterion = card.querySelector('[data-windows-match="executable"]');
        const packagedCriterion = card.querySelector('[data-windows-match="packagedAppId"]');
        let hasCriteria = Boolean(binding.windowsMatch);
        const seedIdentity = () => {
            const id = platform === "windows" ? binding.appMatch || "" : "";
            const packaged = id.includes("!") && !/[\\/]/.test(id);
            return {executable:packaged ? "" : id, packagedAppId:packaged ? id : ""};
        };
        let criteria = {titleContains:"", className:"", ...(binding.windowsMatch ? {executable:"", packagedAppId:""} : seedIdentity()), processId:null, windowId:null, activeOnly:false, ...binding.windowsMatch};
        if (binding.windowsMatch) binding.windowsMatch = criteria;
        const pushOptions = card.querySelector(".push-options");
        const pushDirection = card.querySelector(".push-direction");
        const pushCenter = card.querySelector(".push-center");
        const tileOptions = card.querySelector(".tile-options");
        const tileSide = card.querySelector(".tile-side");
        const writePush = () => {
            const left = pushDirection.value !== "right";
            binding.action = left
                ? (pushCenter.checked ? "push-left-center" : "push-left")
                : (pushCenter.checked ? "push-right-center" : "push-right");
        };
        const writeTile = () => { binding.action = `tile-${tileSide.value}`; };
        const appFields = () => {
            const appAction = ["focus-app", "pull-app"].includes(binding.action);
            match.hidden = !appAction || Boolean(binding.windowsMatch);
            windowsFields.hidden = !appAction;
            windowsDetails.hidden = !binding.windowsMatch;
            options.hidden = binding.action !== "pull-app";
            pushOptions.hidden = !String(binding.action).startsWith("push-");
            tileOptions.hidden = !String(binding.action).startsWith("tile-");
        };
        appFields();
        windowsToggle.checked = Boolean(binding.windowsMatch);
        windowsDetails.open = Boolean(binding.windowsMatch);
        card.querySelector(".windows-match-hint").textContent = platform === "windows"
            ? "All entered criteria must match. Title text and class names are case-sensitive; executable names, full paths and packaged app IDs are not. Process and window IDs may change when an app restarts."
            : "Windows-only criteria. To use this shortcut on Linux, turn these off and enter a KDE resource class or desktop ID in App identifier before enabling it.";
        windowsToggle.addEventListener("change", () => {
            if (windowsToggle.checked && !hasCriteria) {
                Object.assign(criteria, seedIdentity());
                executableCriterion.value = criteria.executable;
                packagedCriterion.value = criteria.packagedAppId;
                hasCriteria = true;
            }
            binding.windowsMatch = windowsToggle.checked ? criteria : null;
            windowsDetails.open = windowsToggle.checked;
            appFields(); changed();
        });
        card.querySelectorAll("[data-windows-match]").forEach(input => {
            const field = input.dataset.windowsMatch;
            if (input.type === "checkbox") input.checked = criteria[field];
            else input.value = criteria[field] ?? "";
            input.addEventListener("input", () => {
                if (input.type === "checkbox") criteria[field] = input.checked;
                else if (field === "processId") criteria[field] = input.value === "" ? null : Number(input.value);
                else if (field === "windowId") criteria[field] = input.value === "" ? null : /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(input.value) ? BigInt(input.value).toString() : input.value;
                else criteria[field] = input.value;
                changed();
            });
        });
        card.querySelector(".match-hint").textContent = platform === "windows" ? "Executable name, full path or packaged app ID. The app must be open." : "Resource class or desktop file ID, such as firefox or org.kde.konsole.";
        card.querySelector('[data-field="appMatch"]').placeholder = platform === "windows" ? "firefox.exe" : "org.kde.konsole";
        card.querySelector(".remove").setAttribute("aria-label", `Remove ${binding.label || "shortcut"}`);
        card.querySelectorAll("[data-field]").forEach((input) => {
            if (input.type === "checkbox") input.checked = binding.enabled !== false;
            else if (input.dataset.field === "action" && String(binding.action).startsWith("push-")) input.value = "push";
            else if (input.dataset.field === "action" && String(binding.action).startsWith("tile-")) input.value = "tile";
            else input.value = binding[input.dataset.field] ?? ({mainMonitorAction: "burner", burnerLayout: "float"}[input.dataset.field] || "");
            input.addEventListener("input", () => {
                if (input.dataset.field === "action" && input.value === "push") {
                    if (!String(binding.action).startsWith("push-")) binding.action = "push-left";
                    pushDirection.value = binding.action.includes("right") ? "right" : "left";
                    pushCenter.checked = binding.action.endsWith("-center");
                } else if (input.dataset.field === "action" && input.value === "tile") {
                    if (!String(binding.action).startsWith("tile-")) binding.action = "tile-left";
                    tileSide.value = binding.action.slice(5);
                } else binding[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value;
                if (input.dataset.field === "action") appFields();
                changed();
            });
        });
        const review = card.querySelector(".reassignment");
        const confirm = card.querySelector(".confirm-reassignment");
        card.querySelector(".reassign").addEventListener("click", () => perform(async () => {
            cancelReassignment();
            const proposal = await native.core.invoke("preview_shortcut_reassignment", {config, index});
            if (!proposal.disabledIndices.length) { message("No other enabled shortcut uses this key."); return; }
            reassignment = {proposal, index};
            const labels = proposal.disabledIndices.map(i => proposal.config.bindings[i].label || "Unnamed shortcut");
            review.querySelector(".reassignment-summary").textContent =
                `Use ${proposal.config.bindings[index].shortcut} for “${binding.label || "Unnamed shortcut"}”? Disable: ${labels.join(", ")}. Their settings will be kept.`;
            review.hidden = false;
            message("Review the conflicting shortcuts below. Save changes afterward to apply.");
        }));
        confirm.addEventListener("click", () => {
            if (busy || reassignment?.index !== index) return;
            config = reassignment.proposal.config;
            changed(); render();
            message("Key reassigned in this draft. Save changes to apply.");
        });
        card.querySelector(".cancel-reassignment").addEventListener("click", cancelReassignment);
        const shortcut = card.querySelector('[data-field="shortcut"]');
        const summaryChord = card.querySelector('[data-summary="shortcut"]');
        shortcut.title = "Click here, then press the key, such as C or X. The buttons below choose Super, Ctrl, Alt, and Shift.";
        const keyField = card.querySelector(".key-field");
        syncShortcutPicker(keyField, binding.shortcut || "");
        watchShortcutPicker(keyField, (shortcutValue) => {
            binding.shortcut = shortcutValue;
            shortcut.value = shortcutValue;
            summaryChord.textContent = shortcutValue || "Set a key";
            changed();
        });
        if (String(binding.action).startsWith("push-")) {
            pushDirection.value = binding.action.includes("right") ? "right" : "left";
            pushCenter.checked = binding.action.endsWith("-center");
        }
        if (String(binding.action).startsWith("tile-")) tileSide.value = binding.action.slice(5);
        const syncPush = () => { writePush(); appFields(); changed(); };
        const syncTile = () => { writeTile(); appFields(); changed(); };
        pushDirection.addEventListener("change", syncPush);
        pushCenter.addEventListener("change", syncPush);
        tileSide.addEventListener("change", syncTile);
        tileSide.addEventListener("input", syncTile);
        const hints = { main: CHOICE_HINTS[binding.mainMonitorAction || "burner"], layout: CHOICE_HINTS[binding.burnerLayout || "float"] };
        card.querySelectorAll(".choice-hint").forEach((hint) => {
            hint.textContent = hints[hint.dataset.hint] || "";
            const select = hint.parentElement.querySelector("select");
            const show = () => { hint.textContent = CHOICE_HINTS[select.value] || ""; };
            select.addEventListener("change", show);
            select.addEventListener("focus", show);
            select.addEventListener("mouseenter", show);
        });
        card.querySelector(".remove").addEventListener("click", () => { config.bindings.splice(index, 1); if (openBinding === index) openBinding = -1; changed(); render(); });
        const article = card.querySelector(".binding");
        const paintSummary = () => {
            article.querySelector('[data-summary="shortcut"]').textContent = binding.shortcut || "Set a key";
            article.querySelector('[data-summary="label"]').textContent = binding.label || "Untitled";
            article.querySelector('[data-summary="action"]').textContent = actionSummary(binding.action);
        };
        paintSummary();
        article.addEventListener("input", paintSummary);
        article.addEventListener("change", paintSummary);
        article.classList.toggle("is-open", index === openBinding);
        article.style.animationDelay = `${Math.min(index, 8) * 30}ms`;
        article.querySelector(".binding-summary").addEventListener("click", () => {
            openBinding = article.classList.contains("is-open") ? -1 : index;
            document.querySelectorAll(".binding").forEach((row, rowIndex) => row.classList.toggle("is-open", rowIndex === openBinding));
        });
        $("#bindings").append(card);
    });
    $("#count").textContent = config.bindings.length;
    $("#empty").hidden = config.bindings.length > 0;
    $("#main-monitor").value = config.settings?.mainMonitor ?? 0;
    $("#burner-monitor").value = config.settings?.burnerMonitor ?? 2;
    $("#enable-on-launch").checked = config.settings?.enableOnLaunch ?? true;
    $("#hold-enabled").checked = config.settings?.holdTileEnabled ?? true;
    $("#hold-delay").value = config.settings?.holdDelayMs ?? 400;
    $("#hold-mode").value = config.settings?.holdMode ?? "tile";
    $("#hold-hint").textContent = "Tap to pull or send the app. Hold to tile from the original pointer position, or choose a window in the radial picker. Release in the center to cancel; Escape also cancels.";
    filterBindings();
    controls();
}
async function perform(operation) {
    if (busy) return;
    busy = true;
    controls();
    try { await operation(); } catch (error) { message(String(error), true); }
    finally { busy = false; controls(); if (controlPending) receiveControl(); }
}
function receiveControl() {
    controlPending = true;
    if (!config || busy) return;
    perform(async () => {
        controlPending = false;
        const request = await native.core.invoke("take_control_request");
        if (!request) return;
        if (request.action !== "open-editor") {
            window.dispatchEvent(new window.CustomEvent("warp-workspace-request", {detail:request}));
            return;
        }
        if (!request.window) { message("No active app was available. Focus an application window, then press the shortcut again."); return; }
        const app = request.window.appId || request.window.path?.split(/[\\/]/).pop() || request.window.desktopId;
        if (!app) { message("This window has no usable app identifier.", true); return; }
        openQuick(app);
    });
}
function appBindingIndex(app) {
    return config.bindings.findIndex(b => {
        if (!["pull-app", "focus-app"].includes(b.action)) return false;
        const selector = b.windowsMatch;
        if (!selector) return b.appMatch.toLowerCase() === app.toLowerCase();
        return platform === "windows" && !selector.titleContains && !selector.className && !selector.packagedAppId
            && selector.processId == null && selector.windowId == null && !selector.activeOnly
            && Boolean(selector.executable) && !/[\\/]/.test(selector.executable)
            && selector.executable.toLowerCase() === app.toLowerCase();
    });
}
let quick = null;
function openQuick(app) {
    let index = appBindingIndex(app);
    let created = false;
    if (index < 0) {
        if (config.bindings.length >= 100) { message("Remove a shortcut before adding another app (maximum 100).", true); return; }
        config.bindings.push({label:app.replace(/\.exe$/i, "").slice(0,120), shortcut:"", action:"pull-app", appMatch:app, enabled:true, mainMonitorAction:"burner", burnerLayout:"float"});
        index = config.bindings.length - 1;
        created = true;
        render();
    }
    const binding = config.bindings[index];
    quick = { index, created, snapshot: structuredClone(binding) };
    $("#quick-title").textContent = binding.label || app;
    $("#quick-match").textContent = app;
    $("#quick-shortcut").value = binding.shortcut || "";
    syncShortcutPicker($("#quick-edit"), binding.shortcut || "");
    $("#quick-behavior").value = binding.mainMonitorAction || "burner";
    $("#quick-layout").value = binding.burnerLayout || "float";
    $("#quick-behavior-hint").textContent = CHOICE_HINTS[$("#quick-behavior").value] || "";
    $("#quick-layout-hint").textContent = CHOICE_HINTS[$("#quick-layout").value] || "";
    $("#quick-edit").hidden = false;
}
function closeQuick(restore) {
    if (restore && quick) {
        if (quick.created) config.bindings.splice(quick.index, 1);
        else config.bindings[quick.index] = quick.snapshot;
        render();
    }
    quick = null;
    $("#quick-edit").hidden = true;
}
function showQuickHint(select, hint) {
    if (!quick) return;
    config.bindings[quick.index][select.id === "quick-behavior" ? "mainMonitorAction" : "burnerLayout"] = select.value;
    hint.textContent = CHOICE_HINTS[select.value] || "";
}
$("#add").addEventListener("click", () => {
    $("#search").value = "";
    config.bindings.push({ label: "", shortcut: "", action: "pull-app", appMatch: "", enabled: true, mainMonitorAction: "burner", burnerLayout: "float" });
    openBinding = config.bindings.length - 1;
    changed(); render();
    $("#bindings").lastElementChild.querySelector("input").focus();
});
function filterBindings() {
    const query = $("#search").value.trim().toLowerCase();
    $("#bindings").querySelectorAll(".binding").forEach((card, index) => {
        const b = config.bindings[index];
        card.hidden = ![b.label, b.shortcut, b.action, b.appMatch, ...Object.values(b.windowsMatch || {}), b.windowsMatch?.activeOnly ? "active window" : ""].join(" ").toLowerCase().includes(query);
    });
}
$("#search").addEventListener("input", () => { if (config) filterBindings(); });
$("#startup").addEventListener("change", () => perform(async () => {
    const requested = $("#startup").checked;
    try {
        startupEnabled = await native.core.invoke("set_startup", {enabled: requested});
        message(startupEnabled ? "Window Warp will start at login with saved shortcuts enabled." : "Startup disabled.");
    } finally { $("#startup").checked = startupEnabled; }
}));
for (const [id, field] of [["main-monitor", "mainMonitor"], ["burner-monitor", "burnerMonitor"], ["hold-delay", "holdDelayMs"]]) {
    $("#" + id).addEventListener("input", () => {
        config.settings ??= {mainMonitor: 0, burnerMonitor: 2};
        config.settings[field] = Number($("#" + id).value);
        changed();
    });
}
$("#hold-mode").addEventListener("change", () => { config.settings ??= {}; config.settings.holdMode = $("#hold-mode").value; changed(); });
$("#hold-enabled").addEventListener("change", () => {
    config.settings ??= {};
    config.settings.holdTileEnabled = $("#hold-enabled").checked;
    changed();
});
$("#enable-on-launch").addEventListener("change", () => {
    config.settings ??= {};
    config.settings.enableOnLaunch = $("#enable-on-launch").checked;
    changed();
});
const SECOND_MONITOR = "Where the window sits after it moves to the second monitor.";
const CHOICE_HINTS = {
    "focus-last": "It is already on the main monitor, so this press goes back to the previous app.",
    burner: "It is already on the main monitor, so this press sends it to the second monitor.",
    float: SECOND_MONITOR,
    "tile-left": SECOND_MONITOR,
    "tile-right": SECOND_MONITOR,
    fullscreen: SECOND_MONITOR
};
watchShortcutPicker($("#quick-edit"), (shortcutValue) => {
    $("#quick-shortcut").value = shortcutValue;
    if (quick) config.bindings[quick.index].shortcut = shortcutValue;
    changed();
});
$("#quick-behavior").addEventListener("change", () => showQuickHint($("#quick-behavior"), $("#quick-behavior-hint")));
$("#quick-layout").addEventListener("change", () => showQuickHint($("#quick-layout"), $("#quick-layout-hint")));
$("#quick-cancel").addEventListener("click", () => closeQuick(true));
$("#quick-apply").addEventListener("click", () => perform(async () => {
    if (!quick) return;
    const binding = config.bindings[quick.index];
    binding.shortcut = $("#quick-shortcut").value;
    binding.mainMonitorAction = $("#quick-behavior").value;
    binding.burnerLayout = $("#quick-layout").value;
    config = await native.core.invoke("save_config", { config });
    rememberSaved();
    dirty = false;
    quick = null;
    $("#quick-edit").hidden = true;
    render();
    message(enabled ? "Saved. The shortcuts in use were updated." : "Saved.");
}));
$("#save").addEventListener("click", () => perform(async () => {
    config = await native.core.invoke("save_config", { config });
    rememberSaved();
    dirty = false; render();
    message(enabled ? "Saved. The shortcuts in use were updated." : "Saved. Enable shortcuts when you’re ready.");
}));
$("#save-settings").addEventListener("click", () => $("#save").click());
$("#discard").addEventListener("click", discardChanges);
$("#discard-settings").addEventListener("click", discardChanges);
$("#toggle").addEventListener("click", () => perform(async () => {
    enabled = await native.core.invoke("set_enabled", { enabled: !enabled });
    message(enabled ? "Shortcuts are on." : "Shortcuts are paused.");
}));
async function init() {
    if (!native) {
        message("Open Window Warp as a desktop application to configure and control your windows.", true);
        $("#status").textContent = "Desktop app required";
        return;
    }
    try {
        await native.event.listen("reveal-app", (event) => {
            document.querySelector("#show-shortcuts")?.click();
            const index = appBindingIndex(event.payload || "");
            if (index >= 0) openBinding = index;
            const card = index >= 0 ? document.querySelector("#bindings")?.children[index] : null;
            card?.classList.add("is-open");
            card?.scrollIntoView?.({ block: "center" });
        });
        await native.event.listen("warp-control", receiveControl);
        await native.event.listen("warp-error", (event) => message(event.payload, true));
        await native.event.listen("warp-enabled", (event) => {
            enabled = event.payload; controls();
            message(enabled ? (dirty ? "Shortcuts are on. Unsaved edits are still here." : "Shortcuts are on.") : "Shortcuts are paused.");
        });
        const status = await native.core.invoke("get_status");
        platform = status.platform;
        enabled = status.enabled;
        $("#platform").textContent = platform === "windows" ? "Windows · native" : "Linux · KDE Plasma";
        config = await native.core.invoke("get_config");
        rememberSaved();
        render();
        message(enabled ? "Shortcuts are on." : "Shortcuts are paused.");
        if (status.shortcutError) message("Pause shortcut needs attention: " + status.shortcutError, true);
        receiveControl();
        try {
            startupEnabled = await native.core.invoke("get_startup");
            startupKnown = true;
            $("#startup").checked = startupEnabled;
            controls();
        } catch (error) { message("Could not read startup settings: " + error, true); }
    } catch (error) { message(String(error), true); $("#status").textContent = "Needs attention"; }
}
{
    const store = themeStorage();
    let colors = null;
    let css = "";
    if (store) {
        try { colors = JSON.parse(store.getItem("window-warp-theme-colors") || "null"); } catch { colors = null; }
        css = store.getItem("window-warp-theme-css") || "";
    }
    for (const key of THEME_KEYS) {
        const field = $("#theme-" + key);
        if (field && colors?.[key]) field.value = colors[key];
    }
    const cssField = $("#theme-css");
    if (cssField) cssField.value = css;
    applyTheme(document.documentElement.dataset.theme || store?.getItem("window-warp-theme") || "warp", colors || currentThemeColors(), css);
    $("#theme")?.addEventListener("change", () => applyTheme($("#theme").value, currentThemeColors(), $("#theme-css").value));
    for (const key of THEME_KEYS) $("#theme-" + key)?.addEventListener("input", () => applyTheme("custom", currentThemeColors(), $("#theme-css").value));
    $("#theme-css")?.addEventListener("input", () => applyTheme($("#theme").value, currentThemeColors(), $("#theme-css").value));
}
init();
