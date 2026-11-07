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
let selectingBindings = false;
let monitors = null;
let monitorRequest = 0;
const selectedBindings = new Set();
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
        "update-workspace": "Capture workspace"
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

function setFeedback(element, text, error = false) {
    window.WarpErrorTimer.set(element, error ? String(text).replace(/^Error:\s*/i, "") : text, {error});
}
function showAppAlert(text) {
    $("#app-alert-text").textContent = String(text).replace(/^Error:\s*/i, "");
    const alert = $("#app-alert");
    alert.hidden = false;
    window.WarpErrorTimer.start(alert, () => { alert.hidden = true; });
}
function message(text, error = false) {
    if (!$("#settings-page").hidden) setFeedback($("#settings-message"), text, error);
    else if (!$("#shortcuts-page").hidden) setFeedback($("#message"), text, error);
    else if (error) showAppAlert(text);
}
$("#app-alert-dismiss").addEventListener("click", () => {
    const alert = $("#app-alert");
    window.WarpErrorTimer.cancel(alert);
    alert.hidden = true;
});
function updateShortcutSelection() {
    const bindings = config?.bindings || [];
    if (!bindings.length && selectingBindings) { selectingBindings = false; selectedBindings.clear(); $("#confirm-remove-shortcuts").hidden = true; }
    for (const binding of selectedBindings) if (!bindings.includes(binding)) selectedBindings.delete(binding);
    const cards = [...$("#bindings").querySelectorAll(".binding")];
    cards.forEach((card, index) => {
        card.classList.toggle("is-selecting", selectingBindings);
        card.querySelector(".binding-select").hidden = !selectingBindings;
        card.querySelector(".select-binding").checked = selectedBindings.has(bindings[index]);
    });
    const selected = bindings.filter(binding => selectedBindings.has(binding));
    const hidden = cards.filter((card, index) => card.hidden && selectedBindings.has(bindings[index])).length;
    $("#shortcut-selection").hidden = !selectingBindings;
    $("#select-shortcuts").setAttribute("aria-pressed", String(selectingBindings));
    $("#select-shortcuts").textContent = selectingBindings ? "Done" : "Select";
    $("#select-shortcuts").disabled = busy || !config || !bindings.length;
    const allEnabled = bindings.length > 0 && bindings.every(binding => binding.enabled !== false);
    $("#enable-all-shortcuts").textContent = allEnabled ? "Disable all" : "Enable all";
    $("#enable-all-shortcuts").disabled = busy || !config || !bindings.length;
    $("#select-visible-shortcuts").textContent = $("#search").value.trim() ? "Select visible" : "Select all";
    $("#select-visible-shortcuts").disabled = busy || !cards.some((card, index) => !card.hidden && !selectedBindings.has(bindings[index]));
    $("#selected-shortcut-count").textContent = `${selected.length} selected${hidden ? ` · ${hidden} hidden by search` : ""}`;
    $("#enable-selected-shortcuts").disabled = busy || !selected.some(binding => binding.enabled === false);
    $("#disable-selected-shortcuts").disabled = busy || !selected.some(binding => binding.enabled !== false);
    $("#remove-selected-shortcuts").disabled = busy || !selected.length;
    $("#cancel-remove-shortcuts").disabled = busy;
    $("#confirm-remove-shortcuts-button").disabled = busy;
}
function selectionChanged() {
    $("#confirm-remove-shortcuts").hidden = true;
    updateShortcutSelection();
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
    $("#find-apps").disabled = busy || !config;
    $("#bindings").querySelectorAll("input, textarea, select, button").forEach((el) => { el.disabled = busy; });
    $("#quick-shortcut").disabled = $("#quick-apply").disabled = $("#quick-behavior").disabled = $("#quick-layout").disabled = busy;
    $("#main-monitor").disabled = $("#burner-monitor").disabled = busy || !config || !monitors;
    $("#retry-monitors").disabled = busy || !config;
    $("#hold-mode").disabled = $("#hold-enabled").disabled = $("#hold-delay").disabled = busy || !config;
    $("#enable-on-launch").disabled = busy || !config;
    $("#quick-modifier").disabled = busy || !config;
    $("#startup").disabled = busy || !startupKnown;
    $("#import-files").disabled = busy || enabled || !config;
    $("#apply-import").disabled = busy || enabled || !config;
    const saveStatus = dirty ? "Unsaved changes" : "";
    $("#save-status").textContent = saveStatus;
    $("#settings-save-status").textContent = saveStatus;
    updateShortcutSelection();
}
function cancelReassignment() {
    reassignment = null;
    document.querySelectorAll(".reassignment").forEach(panel => { panel.hidden = true; });
}
function changed() { cancelReassignment(); dirty = true; setFeedback($("#message"), ""); setFeedback($("#settings-message"), ""); setFeedback($("#find-apps-result"), ""); controls(); }
function copyConfig(value) { return JSON.parse(JSON.stringify(value)); }
function rememberSaved() { savedConfig = copyConfig(config); }
function discardChanges() {
    if (busy || !dirty || !savedConfig) return;
    config = copyConfig(savedConfig);
    dirty = false;
    quick = null;
    $("#quick-edit").hidden = true;
    render();
    message("Changes discarded.");
}
function render() {
    cancelReassignment();
    $("#bindings").replaceChildren();
    config.bindings.forEach((binding, index) => {
        const card = $("#binding-template").content.cloneNode(true);
        const match = card.querySelector(".match-field");
        const alternatives = card.querySelector(".alternative-matches");
        const options = card.querySelector(".app-options");
        const burnerLayoutField = card.querySelector(".burner-layout-field");
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
            alternatives.hidden = !appAction;
            windowsFields.hidden = !appAction;
            windowsDetails.hidden = !binding.windowsMatch;
            options.hidden = binding.action !== "pull-app";
            burnerLayoutField.hidden = (binding.mainMonitorAction || "burner") !== "burner";
            pushOptions.hidden = !String(binding.action).startsWith("push-");
            tileOptions.hidden = !String(binding.action).startsWith("tile-");
        };
        appFields();
        const identifiersInput = card.querySelector(".app-matches");
        identifiersInput.value = (binding.appMatches || []).join("\n");
        identifiersInput.addEventListener("input", () => {
            binding.appMatches = identifiersInput.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
            changed();
        });
        windowsToggle.checked = Boolean(binding.windowsMatch);
        windowsDetails.open = Boolean(binding.windowsMatch);
        card.querySelector(".windows-match-hint").textContent = platform === "windows"
            ? "All entered criteria must match. Title text and class names are case-sensitive; executable names, full paths and packaged app IDs are not. Process and window IDs may change when an app restarts."
            : "Windows-only criteria are preserved. On KDE, add a resource class or desktop ID under Additional app identifiers before enabling this shortcut.";
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
                if (input.dataset.field === "action" || input.dataset.field === "mainMonitorAction") appFields();
                changed();
            });
        });
        const review = card.querySelector(".reassignment");
        const confirm = card.querySelector(".confirm-reassignment");
        const bindingFeedback = card.querySelector(".binding-feedback");
        card.querySelector(".reassign").addEventListener("click", () => perform(async () => {
            setFeedback(bindingFeedback, "");
            cancelReassignment();
            const proposal = await native.core.invoke("preview_shortcut_reassignment", {config, index});
            if (!proposal.disabledIndices.length) { setFeedback(bindingFeedback, "No other shortcut uses this key."); return; }
            reassignment = {proposal, index};
            const labels = proposal.disabledIndices.map(i => proposal.config.bindings[i].label || "Unnamed shortcut");
            review.querySelector(".reassignment-summary").textContent =
                `Use ${proposal.config.bindings[index].shortcut} for “${binding.label || "Unnamed shortcut"}”? Disable: ${labels.join(", ")}. Their settings will be kept.`;
            review.hidden = false;
        }, error => setFeedback(bindingFeedback, String(error), true)));
        confirm.addEventListener("click", () => {
            if (busy || reassignment?.index !== index) return;
            config = reassignment.proposal.config;
            changed(); render();
            message("Shortcut reassigned. Save changes to apply.");
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
        const selection = card.querySelector(".select-binding");
        selection.setAttribute("aria-label", `Select ${binding.label || "shortcut"}`);
        selection.addEventListener("change", () => {
            if (selection.checked) selectedBindings.add(binding); else selectedBindings.delete(binding);
            selectionChanged();
        });
        const paintSummary = () => {
            article.querySelector('[data-summary="shortcut"]').textContent = binding.shortcut || "Set a key";
            article.querySelector('[data-summary="label"]').textContent = binding.label || "Untitled";
            article.querySelector('[data-summary="action"]').textContent = actionSummary(binding.action);
            selection.setAttribute("aria-label", `Select ${binding.label || "shortcut"}`);
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
    renderMonitorOptions();
    $("#enable-on-launch").checked = config.settings?.enableOnLaunch ?? true;
    $("#quick-modifier").value = config.settings?.quickModifier || "Super";
    $("#hold-enabled").checked = config.settings?.holdTileEnabled ?? true;
    $("#hold-delay").value = config.settings?.holdDelayMs ?? 400;
    $("#hold-mode").value = config.settings?.holdMode ?? "tile";
    $("#hold-hint").textContent = "Tap to pull or send the app. Hold to tile from the original pointer position, or choose a window in the radial picker. Release in the center to cancel; Escape also cancels.";
    filterBindings();
    controls();
}
async function perform(operation, reportError = error => message(String(error), true)) {
    if (busy) return;
    busy = true;
    controls();
    try { await operation(); } catch (error) { reportError(error); }
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
        if (!request.window) { message("No active app was available. Focus an application window, then press the shortcut again.", true); return; }
        const app = request.window.appId || request.window.path?.split(/[\\/]/).pop() || request.window.desktopId;
        if (!app) { message("This window has no usable app identifier.", true); return; }
        openQuick(app);
    });
}
function appBindingIndex(app) {
    return config.bindings.findIndex(b => {
        if (!["pull-app", "focus-app"].includes(b.action)) return false;
        const selector = b.windowsMatch;
        if (!selector) return [b.appMatch, ...(b.appMatches || [])].some(id => id?.toLowerCase() === app.toLowerCase());
        if (platform !== "windows") return (b.appMatches || []).some(id => id.toLowerCase() === app.toLowerCase());
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
    $("#quick-layout").closest("label").hidden = $("#quick-behavior").value !== "burner";
    $("#quick-layout-hint").hidden = $("#quick-behavior").value !== "burner";
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
    $("#quick-layout").closest("label").hidden = $("#quick-behavior").value !== "burner";
    $("#quick-layout-hint").hidden = $("#quick-behavior").value !== "burner";
}
$("#add").addEventListener("click", () => {
    $("#search").value = "";
    config.bindings.push({ label: "", shortcut: "", action: "pull-app", appMatch: "", enabled: true, mainMonitorAction: "burner", burnerLayout: "float" });
    openBinding = config.bindings.length - 1;
    changed(); render();
    $("#bindings").lastElementChild.querySelector('[data-field="label"]').focus();
});
function appNameKey(value) {
    const base = String(value || "").split(/[\\/]/).pop().replace(/\.exe$/i, "").split(".").pop();
    return base.toLowerCase().replace(/[^a-z0-9]/g, "");
}
$("#find-apps").addEventListener("click", () => perform(async () => {
    const result = $("#find-apps-result");
    setFeedback(result, "Finding open apps…");
    try {
        const windows = await native.core.invoke("get_windows");
        const missing = [], ambiguous = [], found = [];
        for (const binding of config.bindings.filter(b => ["pull-app", "focus-app"].includes(b.action))) {
            const keys = [binding.label, binding.appMatch, binding.windowsMatch?.executable, ...(binding.appMatches || [])].map(appNameKey).filter(Boolean);
            const groups = new Map();
            for (const window of windows) {
                const ids = [window.appId, window.desktopId].filter(Boolean);
                if (!ids.some(id => keys.includes(appNameKey(id)))) continue;
                const group = String(window.appId || window.desktopId).toLowerCase();
                if (!groups.has(group)) groups.set(group, new Set());
                ids.forEach(id => groups.get(group).add(id));
            }
            if (groups.size === 0) { missing.push(binding.label); continue; }
            if (groups.size > 1) { ambiguous.push(binding.label); continue; }
            const ids = [...groups.values()][0];
            const known = new Set([binding.appMatch, ...(binding.appMatches || [])].filter(Boolean).map(id => id.toLowerCase()));
            const additions = [...ids].filter(id => !known.has(id.toLowerCase()));
            if (additions.length) { binding.appMatches = [...(binding.appMatches || []), ...additions]; found.push(binding.label); }
        }
        if (found.length) { changed(); render(); }
        setFeedback(result, [found.length ? `Added names for: ${found.join(", ")}. Review and save changes.` : "No new names added.", missing.length ? `Not found: ${missing.join(", ")}. Open those apps and try again.` : "", ambiguous.length ? `Multiple matches; review manually: ${ambiguous.join(", ")}.` : ""].filter(Boolean).join(" "));
    } catch (error) {
        setFeedback(result, `Could not find open apps: ${error}`, true);
    }
}));
function filterBindings() {
    const query = $("#search").value.trim().toLowerCase();
    $("#bindings").querySelectorAll(".binding").forEach((card, index) => {
        const b = config.bindings[index];
        card.hidden = ![b.label, b.shortcut, b.action, b.appMatch, ...(b.appMatches || []), ...Object.values(b.windowsMatch || {}), b.windowsMatch?.activeOnly ? "active window" : ""].join(" ").toLowerCase().includes(query);
    });
    updateShortcutSelection();
}
$("#search").addEventListener("input", () => { if (config) filterBindings(); });
$("#select-shortcuts").addEventListener("click", () => {
    selectingBindings = !selectingBindings;
    setFeedback($("#find-apps-result"), "");
    if (!selectingBindings) selectedBindings.clear();
    selectionChanged();
});
$("#select-visible-shortcuts").addEventListener("click", () => {
    [...$("#bindings").querySelectorAll(".binding")].forEach((card, index) => { if (!card.hidden) selectedBindings.add(config.bindings[index]); });
    selectionChanged();
});
function setBindingsEnabled(bindings, value) {
    const targets = bindings.filter(binding => (binding.enabled !== false) !== value);
    if (!targets.length) return;
    targets.forEach(binding => { binding.enabled = value; });
    $("#confirm-remove-shortcuts").hidden = true;
    changed(); render();
}
$("#enable-all-shortcuts").addEventListener("click", () => setBindingsEnabled(config.bindings, config.bindings.some(binding => binding.enabled === false)));
$("#enable-selected-shortcuts").addEventListener("click", () => setBindingsEnabled(config.bindings.filter(binding => selectedBindings.has(binding)), true));
$("#disable-selected-shortcuts").addEventListener("click", () => setBindingsEnabled(config.bindings.filter(binding => selectedBindings.has(binding)), false));
$("#remove-selected-shortcuts").addEventListener("click", () => {
    const count = selectedBindings.size;
    if (!count) return;
    $("#confirm-remove-shortcuts-text").textContent = `Remove ${count} selected ${count === 1 ? "shortcut" : "shortcuts"}?`;
    $("#confirm-remove-shortcuts").hidden = false;
    $("#cancel-remove-shortcuts").focus();
});
$("#cancel-remove-shortcuts").addEventListener("click", () => { $("#confirm-remove-shortcuts").hidden = true; });
$("#confirm-remove-shortcuts-button").addEventListener("click", () => {
    const count = selectedBindings.size;
    if (!count) return;
    config.bindings = config.bindings.filter(binding => !selectedBindings.has(binding));
    selectedBindings.clear(); selectingBindings = false; openBinding = -1;
    $("#confirm-remove-shortcuts").hidden = true;
    changed(); render();
    message(`${count} ${count === 1 ? "shortcut" : "shortcuts"} removed. Save changes to apply.`);
});
$("#startup").addEventListener("change", () => perform(async () => {
    const requested = $("#startup").checked;
    setFeedback($("#startup-feedback"), "");
    try {
        startupEnabled = await native.core.invoke("set_startup", {enabled: requested});
    } finally { $("#startup").checked = startupEnabled; }
}, error => setFeedback($("#startup-feedback"), String(error), true)));
function renderMonitorOptions() {
    if (!config || !monitors) return;
    const settings = config.settings || {};
    const currentMain = settings.mainMonitorId ? monitors.find(monitor => monitor.id === settings.mainMonitorId)
        : (settings.mainMonitor ?? 0) === 0 ? monitors.find(monitor => monitor.primary)
        : monitors.find(monitor => monitor.index === settings.mainMonitor);
    for (const [elementId, numberKey, identityKey, fallback] of [
        ["main-monitor", "mainMonitor", "mainMonitorId", 0],
        ["burner-monitor", "burnerMonitor", "burnerMonitorId", 2]
    ]) {
        const select = $("#" + elementId);
        const number = settings[numberKey] ?? fallback;
        const identity = settings[identityKey] || "";
        const chosen = identity ? monitors.find(monitor => monitor.id === identity) : monitors.find(monitor => monitor.index === number);
        select.replaceChildren();
        const add = (value, label, disabled = false) => {
            const option = document.createElement("option"); option.value = value; option.textContent = label; option.disabled = disabled; select.append(option);
        };
        if (elementId === "main-monitor") {
            const primary = monitors.find(monitor => monitor.primary);
            const automatic = platform === "windows" ? "System primary" : "Automatic";
            add("0", primary ? `${automatic} (${primary.name})` : automatic);
        }
        for (const monitor of monitors) add(String(monitor.index), monitor.name + (monitor.primary ? (platform === "windows" ? " (primary)" : " (automatic)") : ""),
            elementId === "burner-monitor" && monitors.length > 1 && monitor.id === currentMain?.id);
        if (elementId === "burner-monitor" && monitors.length < 2) {
            add("missing", "No second monitor connected", true);
            select.value = "missing";
        } else if (chosen) select.value = String(chosen.index);
        else if (!identity && number === 0 && elementId === "main-monitor") select.value = "0";
        else {
            add("missing", !identity && elementId === "burner-monitor" && monitors.length < 2 ? "No second monitor connected" : "Previously selected monitor is disconnected", true);
            select.value = "missing";
        }
    }
}
async function refreshMonitors() {
    const request = ++monitorRequest;
    try {
        const found = await native.core.invoke("get_monitors");
        if (request !== monitorRequest) return;
        if (!Array.isArray(found) || !found.length) throw new Error("No connected monitors were found.");
        monitors = found;
        $("#monitor-hint").textContent = monitors.some(monitor => !monitor.stable)
            ? "For displays without a stable ID, reconnecting or rearranging can change their order. Refresh this list and check your choices."
            : "If a selected display is unavailable or both choices match, Warp uses an available display.";
        setFeedback($("#monitor-status"), "");
        renderMonitorOptions(); controls();
    } catch {
        if (request !== monitorRequest) return;
        monitors = null;
        setFeedback($("#monitor-status"), "Could not detect monitors. Try again.", true);
        controls();
    }
}
$("#monitor-settings").addEventListener("toggle", () => { if ($("#monitor-settings").open) refreshMonitors(); });
$("#retry-monitors").addEventListener("click", refreshMonitors);
window.addEventListener("focus", () => { if ($("#monitor-settings").open) refreshMonitors(); });
for (const [elementId, numberKey, identityKey] of [
    ["main-monitor", "mainMonitor", "mainMonitorId"],
    ["burner-monitor", "burnerMonitor", "burnerMonitorId"]
]) {
    $("#" + elementId).addEventListener("input", () => {
        const number = Number($("#" + elementId).value);
        if (!Number.isInteger(number) || !monitors) return;
        const selected = monitors.find(monitor => monitor.index === number);
        if (!selected && !(elementId === "main-monitor" && number === 0)) return;
        config.settings ??= {mainMonitor: 0, burnerMonitor: 2};
        config.settings[numberKey] = number;
        config.settings[identityKey] = selected?.stable ? selected.id : "";
        if (elementId === "main-monitor" && monitors.length > 1) {
            const main = selected || monitors.find(monitor => monitor.primary);
            const second = config.settings.burnerMonitorId
                ? monitors.find(monitor => monitor.id === config.settings.burnerMonitorId)
                : monitors.find(monitor => monitor.index === (config.settings.burnerMonitor ?? 2));
            if (main && second?.id === main.id) {
                const other = monitors.find(monitor => monitor.id !== main.id);
                config.settings.burnerMonitor = other.index;
                config.settings.burnerMonitorId = other.stable ? other.id : "";
            }
        }
        renderMonitorOptions();
        changed();
    });
}
for (const [id, field] of [["hold-delay", "holdDelayMs"]]) {
    $("#" + id).addEventListener("input", () => {
        config.settings ??= {mainMonitor: 0, burnerMonitor: 2};
        config.settings[field] = Number($("#" + id).value);
        changed();
    });
}
$("#hold-mode").addEventListener("change", () => { config.settings ??= {}; config.settings.holdMode = $("#hold-mode").value; changed(); });
$("#quick-modifier").addEventListener("change", () => { config.settings ??= {}; config.settings.quickModifier = $("#quick-modifier").value; changed(); });
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
    message("Saved.");
}, error => showAppAlert(String(error))));
$("#save").addEventListener("click", () => perform(async () => {
    config = await native.core.invoke("save_config", { config });
    rememberSaved();
    dirty = false; render();
    message("Saved.");
}));
$("#save-settings").addEventListener("click", () => $("#save").click());
$("#discard").addEventListener("click", discardChanges);
$("#discard-settings").addEventListener("click", discardChanges);
$("#toggle").addEventListener("click", () => perform(async () => {
    enabled = await native.core.invoke("set_enabled", { enabled: !enabled });
}, error => showAppAlert(String(error))));
async function init() {
    if (!native) {
        showAppAlert("Open Window Warp as a desktop application to configure and control your windows.");
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
        await native.event.listen("warp-browser-updated", (event) => window.dispatchEvent(new CustomEvent("warp-browser-updated", {detail:event.payload})));
        await native.event.listen("warp-saved-browsers-updated", () => window.dispatchEvent(new CustomEvent("warp-saved-browsers-updated")));
        await native.event.listen("warp-desktop-changed", () => window.dispatchEvent(new CustomEvent("warp-desktop-changed")));
        await native.event.listen("warp-error", (event) => showAppAlert(event.payload));
        await native.event.listen("warp-enabled", (event) => {
            enabled = event.payload; controls();
        });
        const status = await native.core.invoke("get_status");
        platform = status.platform;
        enabled = status.enabled;
        $("#platform").textContent = platform === "windows" ? "Windows · native" : "Linux · KDE Plasma";
        config = await native.core.invoke("get_config");
        rememberSaved();
        render();
        if (status.shortcutError) showAppAlert("Pause shortcut needs attention: " + status.shortcutError);
        receiveControl();
        try {
            startupEnabled = await native.core.invoke("get_startup");
            startupKnown = true;
            $("#startup").checked = startupEnabled;
            controls();
        } catch (error) { showAppAlert("Could not read startup settings: " + error); }
    } catch (error) { showAppAlert(String(error)); $("#status").textContent = "Needs attention"; }
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
