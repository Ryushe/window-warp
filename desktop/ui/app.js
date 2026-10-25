const $ = (selector) => document.querySelector(selector);
let config;
let enabled = false;
let dirty = false;
let busy = false;
let platform = "";
let recording = null;
let reassignment = null;
let controlPending = false;
let startupEnabled = false;
let startupKnown = false;
const native = window.__TAURI__;

function message(text, error = false) {
    $("#message").textContent = text;
    $("#message").classList.toggle("error", error);
}
function controls() {
    $("#toggle").disabled = busy || !config || (!enabled && dirty);
    $("#toggle").textContent = enabled ? "Pause shortcuts" : "Enable shortcuts ↗";
    $("#status").textContent = enabled ? "● Shortcuts active" : "○ Paused";
    $("#status").classList.toggle("active", enabled);
    $("#save").disabled = busy || enabled || !dirty || !config;
    $("#add").disabled = busy || enabled || !config;
    $("#bindings").querySelectorAll("input, select, button").forEach((el) => { el.disabled = busy || enabled; });
    $("#main-monitor").disabled = $("#burner-monitor").disabled = busy || enabled || !config;
    $("#hold-mode").disabled = $("#hold-enabled").disabled = $("#hold-delay").disabled = busy || enabled || !config;
    $("#startup").disabled = busy || !startupKnown;
    $("#import-files").disabled = busy || enabled || !config;
    $("#apply-import").disabled = busy || enabled || !config;
    $("#edit-hint").textContent = enabled ? "Pause shortcuts to make changes." : "Changes take effect after saving and enabling.";
    $("#save-status").textContent = dirty ? "Unsaved changes" : "Stored on this device";
}
function cancelReassignment() {
    reassignment = null;
    document.querySelectorAll(".reassignment").forEach(panel => { panel.hidden = true; });
}
function changed() { cancelReassignment(); dirty = true; controls(); }
function render() {
    cancelReassignment();
    recording = null;
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
        const appFields = () => {
            const appAction = ["focus-app", "pull-app"].includes(binding.action);
            match.hidden = !appAction || Boolean(binding.windowsMatch);
            windowsFields.hidden = !appAction;
            windowsDetails.hidden = !binding.windowsMatch;
            options.hidden = binding.action !== "pull-app";
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
            else input.value = binding[input.dataset.field] ?? ({mainMonitorAction: "burner", burnerLayout: "float"}[input.dataset.field] || "");
            input.addEventListener("input", () => {
                binding[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value;
                if (input.dataset.field === "action") appFields();
                changed();
            });
        });
        const review = card.querySelector(".reassignment");
        const confirm = card.querySelector(".confirm-reassignment");
        card.querySelector(".reassign").addEventListener("click", () => perform(async () => {
            cancelReassignment();
            if (recording) { recording.button.textContent = "Record keys"; recording = null; }
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
            if (enabled || busy || reassignment?.index !== index) return;
            config = reassignment.proposal.config;
            changed(); render();
            message("Key reassigned in this draft. Save changes to apply.");
        });
        card.querySelector(".cancel-reassignment").addEventListener("click", cancelReassignment);
        const record = card.querySelector(".record");
        const shortcut = card.querySelector('[data-field="shortcut"]');
        record.addEventListener("click", () => {
            cancelReassignment();
            if (recording) recording.button.textContent = "Record keys";
            recording = {button: record, input: shortcut, binding};
            record.textContent = "Press keys…";
            shortcut.focus();
            message("Press a modifier and key together. Escape cancels recording.");
        });
        card.querySelector(".remove").addEventListener("click", () => { config.bindings.splice(index, 1); changed(); render(); });
        $("#bindings").append(card);
    });
    $("#count").textContent = config.bindings.length;
    $("#empty").hidden = config.bindings.length > 0;
    $("#main-monitor").value = config.settings?.mainMonitor ?? 0;
    $("#burner-monitor").value = config.settings?.burnerMonitor ?? 2;
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
        $("#show-shortcuts").click();
        if (!request.window) { message("No active app was available. Add or edit a shortcut below."); return; }
        const app = request.window.appId || request.window.path?.split(/[\\/]/).pop() || request.window.desktopId;
        if (!app) { message("This window has no usable app identifier.", true); return; }
        let index = config.bindings.findIndex(b => {
            if (!["pull-app", "focus-app"].includes(b.action)) return false;
            const selector = b.windowsMatch;
            if (!selector) return b.appMatch.toLowerCase() === app.toLowerCase();
            // Imported ahk_exe-only selectors are equivalent for current-app
            // editing. A narrower selector must remain a separate shortcut.
            return platform === "windows" && !selector.titleContains && !selector.className && !selector.packagedAppId
                && selector.processId == null && selector.windowId == null && !selector.activeOnly
                && Boolean(selector.executable) && !/[\\/]/.test(selector.executable)
                && selector.executable.toLowerCase() === app.toLowerCase();
        });
        if (index < 0) {
            if (config.bindings.length >= 100) { message("Remove a shortcut before adding another app (maximum 100).", true); return; }
            index = config.bindings.length;
            config.bindings.push({label:app.replace(/\.exe$/i, "").slice(0,120), shortcut:"", action:"pull-app", appMatch:app, enabled:true, mainMonitorAction:"burner", burnerLayout:"float"});
            changed();
        }
        $("#search").value = "";
        render();
        const card = $("#bindings").children[index];
        card.scrollIntoView?.({block:"center"});
        card.querySelector('[data-field="shortcut"]').focus();
        message(`Editing ${app}. Shortcuts are paused; save edits before enabling them.`);
    });
}
$("#add").addEventListener("click", () => {
    $("#search").value = "";
    config.bindings.push({ label: "", shortcut: "", action: "pull-app", appMatch: "", enabled: true, mainMonitorAction: "burner", burnerLayout: "float" });
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
document.addEventListener("keydown", (event) => {
    if (!recording || enabled || busy) return;
    event.preventDefault();
    if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
        recording.button.textContent = "Record keys"; recording = null; message("Recording canceled."); return;
    }
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;
    const mods = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super"].filter(Boolean);
    if (!mods.length) { message("Include Ctrl, Alt, Shift, or Super.", true); return; }
    let key = event.code || event.key;
    key = key.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "");
    if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Left|Right|Up|Down|Space|Tab|Enter|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Semicolon|Quote|Backquote|Comma|Period|Slash|Backslash|Minus|Equal|BracketLeft|BracketRight)$/.test(key)) {
        message("That key is not supported. Try a letter, navigation key, punctuation, or function key.", true); return;
    }
    const shortcut = [...mods, key].join("+");
    recording.binding.shortcut = shortcut;
    recording.input.value = shortcut;
    recording.button.textContent = "Record keys";
    recording = null;
    changed(); message("Recorded " + shortcut + ". Save to apply.");
});
$("#save").addEventListener("click", () => perform(async () => {
    config = await native.core.invoke("save_config", { config });
    dirty = false; render();
    message("Saved. Enable shortcuts when you’re ready.");
}));
$("#toggle").addEventListener("click", () => perform(async () => {
    enabled = await native.core.invoke("set_enabled", { enabled: !enabled });
    message(enabled ? "Shortcuts are active. Focus another app and try a shortcut. Close this window to keep Warp in the tray." : "Shortcuts are paused. You can edit your bindings now.");
}));
async function init() {
    if (!native) {
        message("Open Window Warp as a desktop application to configure and control your windows.", true);
        $("#status").textContent = "Desktop app required";
        return;
    }
    try {
        await native.event.listen("warp-control", receiveControl);
        await native.event.listen("warp-error", (event) => message(event.payload, true));
        await native.event.listen("warp-enabled", (event) => {
            enabled = event.payload; controls();
            message(enabled ? (dirty ? "Saved shortcuts are active. Your unsaved edits are still in this editor." : "Shortcuts are active.") : "Shortcuts are paused.");
        });
        const status = await native.core.invoke("get_status");
        platform = status.platform;
        enabled = status.enabled;
        $("#platform").textContent = platform === "windows" ? "Windows · native" : "Linux · KDE Plasma";
        $("#settings-path").textContent = "Settings file: " + status.settingsPath;
        $("#compatibility").textContent = platform === "windows"
            ? "If a key is already used by Windows or AutoHotkey, choose another binding or pause the old script. Some Windows-key combinations are reserved. Elevated apps may restrict window control."
            : "Supports Plasma 5.27 and 6 with Qt’s qdbus tool. KWin handles both Wayland and X11 windows. Resolve desktop shortcut conflicts in KDE System Settings → Keyboard → Shortcuts. Runtime details appear in the KWin journal.";
        config = await native.core.invoke("get_config");
        render();
        message(enabled ? "Shortcuts are active." : "Start with a few shortcuts. Save any edits, then enable them above.");
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
init();
