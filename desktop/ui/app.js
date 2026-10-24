const $ = (selector) => document.querySelector(selector);
let config;
let enabled = false;
let dirty = false;
let busy = false;
let platform = "";
let recording = null;
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
    $("#startup").disabled = busy || !startupKnown;
    $("#edit-hint").textContent = enabled ? "Pause shortcuts to make changes." : "Changes take effect after saving and enabling.";
    $("#save-status").textContent = dirty ? "Unsaved changes" : "Stored on this device";
}
function changed() { dirty = true; controls(); }
function render() {
    recording = null;
    $("#bindings").replaceChildren();
    config.bindings.forEach((binding, index) => {
        const card = $("#binding-template").content.cloneNode(true);
        const match = card.querySelector(".match-field");
        const options = card.querySelector(".app-options");
        const appFields = () => {
            match.hidden = !["focus-app", "pull-app"].includes(binding.action);
            options.hidden = binding.action !== "pull-app";
        };
        appFields();
        card.querySelector(".match-hint").textContent = platform === "windows" ? "Executable name, such as firefox.exe. The app must be open." : "Resource class or desktop file ID, such as firefox or org.kde.konsole.";
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
        const record = card.querySelector(".record");
        const shortcut = card.querySelector('[data-field="shortcut"]');
        record.addEventListener("click", () => {
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
    filterBindings();
    controls();
}
async function perform(operation) {
    if (busy) return;
    busy = true;
    controls();
    try { await operation(); } catch (error) { message(String(error), true); }
    finally { busy = false; controls(); }
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
        card.hidden = ![b.label, b.shortcut, b.action, b.appMatch].join(" ").toLowerCase().includes(query);
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
for (const [id, field] of [["main-monitor", "mainMonitor"], ["burner-monitor", "burnerMonitor"]]) {
    $("#" + id).addEventListener("input", () => {
        config.settings ??= {mainMonitor: 0, burnerMonitor: 2};
        config.settings[field] = Number($("#" + id).value);
        changed();
    });
}
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
        await native.event.listen("warp-error", (event) => message(event.payload, true));
        await native.event.listen("warp-enabled", (event) => {
            enabled = event.payload; controls();
            message(enabled ? "Shortcuts are active." : "Shortcuts are paused.");
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
        try {
            startupEnabled = await native.core.invoke("get_startup");
            startupKnown = true;
            $("#startup").checked = startupEnabled;
            controls();
        } catch (error) { message("Could not read startup settings: " + error, true); }
    } catch (error) { message(String(error), true); $("#status").textContent = "Needs attention"; }
}
init();
