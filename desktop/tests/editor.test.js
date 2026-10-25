import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const html = fs.readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function editor({ failLoad = false, failSave = false, failEnable = false, failReassignment = false } = {}) {
    const { window, document } = parseHTML(html);
    // linkedom exposes select.value as a getter; browsers also provide a setter.
    Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
        configurable: true,
        get() { return this.querySelector("option[selected]")?.value ?? this.querySelector("option")?.value; },
        set(value) {
            this.querySelectorAll("option").forEach(option => option.removeAttribute("selected"));
            const selected = [...this.querySelectorAll("option")].find(option => option.value === value);
            if (selected) selected.setAttribute("selected", "");
        }
    });
    const config = { version: 1, bindings: [{ label: "Move right", shortcut: "Ctrl+Alt+Right", action: "push-right", appMatch: "" }] };
    const calls = [];
    const listeners = new Map();
    window.__TAURI__ = {
        event: { listen: async (name, callback) => { listeners.set(name, callback); return () => {}; } },
        core: { invoke: async (command, args) => {
            calls.push({ command, args });
            if (command === "get_status") return { enabled: false, platform: "windows", settingsPath: "test/settings.json" };
            if (command === "get_config") { if (failLoad) throw "Settings are unreadable"; return structuredClone(config); }
            if (command === "get_startup") return false;
            if (command === "set_startup") return args.enabled;
            if (command === "preview_shortcut_reassignment") {
                if (failReassignment) throw "Use a modifier plus a key";
                const config = structuredClone(args.config);
                config.bindings[0].enabled = false;
                config.bindings[args.index].enabled = true;
                config.bindings[args.index].shortcut = "Ctrl+Alt+Right";
                return {config, disabledIndices:[0]};
            }
            if (command === "save_config") { if (failSave) throw "Duplicate shortcut"; return structuredClone(args.config); }
            if (command === "set_enabled") { if (failEnable) throw "Shortcut is already in use"; return args.enabled; }
            throw new Error(command);
        } }
    };
    vm.runInNewContext(source, { window, document });
    await tick();
    return { window, document, calls, listeners, input(selector, value) {
        const field = document.querySelector(selector);
        field.value = value;
        field.dispatchEvent(new window.Event("input"));
    }, async click(selector) { document.querySelector(selector).click(); await tick(); } };
}

test("unsaved changes block activation; save and pause preserve editor state", async () => {
    const e = await editor();
    e.input('[data-field="shortcut"]', "Ctrl+Alt+F");
    assert.equal(e.document.querySelector("#toggle").disabled, true);
    await e.click("#save");
    assert.equal(e.calls.find((c) => c.command === "save_config").args.config.bindings[0].shortcut, "Ctrl+Alt+F");
    assert.equal(e.document.querySelector("#toggle").disabled, false);
    await e.click("#toggle");
    assert.equal(e.document.querySelector('[data-field="shortcut"]').disabled, true);
    e.listeners.get("warp-enabled")({ payload: false });
    assert.equal(e.document.querySelector('[data-field="shortcut"]').disabled, false);
    assert.equal(e.document.querySelector('[data-field="shortcut"]').value, "Ctrl+Alt+F");
});
test("validation errors retain the user's unsaved edits", async () => {
    const e = await editor({ failSave: true });
    e.input('[data-field="shortcut"]', "Ctrl+Alt+F");
    await e.click("#save");
    assert.match(e.document.querySelector("#message").textContent, /Duplicate/);
    assert.equal(e.document.querySelector('[data-field="shortcut"]').value, "Ctrl+Alt+F");
    assert.equal(e.document.querySelector("#toggle").disabled, true);
    assert.equal(e.document.querySelector("#save").disabled, false);
});
test("failed registration leaves controls paused and editable", async () => {
    const e = await editor({ failEnable: true });
    await e.click("#toggle");
    assert.match(e.document.querySelector("#message").textContent, /already in use/);
    assert.equal(e.document.querySelector("#status").textContent, "○ Paused");
    assert.equal(e.document.querySelector('[data-field="shortcut"]').disabled, false);
});
test("unreadable settings never allow replacing the file with defaults", async () => {
    const e = await editor({ failLoad: true });
    assert.equal(e.document.querySelector("#toggle").disabled, true);
    assert.equal(e.document.querySelector("#save").disabled, true);
    assert.equal(e.document.querySelector("#add").disabled, true);
    assert.equal(e.document.querySelector("#status").textContent, "Needs attention");
});

test("app behavior, monitor selection, and per-binding disable are saved", async () => {
    const e = await editor();
    e.input('[data-field="action"]', "pull-app");
    e.input('[data-field="appMatch"]', "firefox.exe");
    e.input('[data-field="mainMonitorAction"]', "focus-last");
    e.input('[data-field="burnerLayout"]', "tile-right");
    assert.equal(e.document.querySelector(".app-options").hidden, false);
    e.input("#main-monitor", "2");
    const enabled = e.document.querySelector('[data-field="enabled"]');
    enabled.checked = false;
    enabled.dispatchEvent(new e.window.Event("input"));
    await e.click("#save");
    const config = e.calls.find(c => c.command === "save_config").args.config;
    assert.equal(config.bindings[0].enabled, false);
    assert.equal(config.bindings[0].mainMonitorAction, "focus-last");
    assert.equal(config.bindings[0].burnerLayout, "tile-right");
    assert.equal(config.settings.mainMonitor, 2);
});

test("shortcut recording saves physical key names and supports cancellation", async () => {
    const e = await editor();
    await e.click(".record");
    const event = new e.window.Event("keydown", {cancelable:true});
    Object.assign(event, {key:";", code:"Semicolon", metaKey:true});
    e.document.dispatchEvent(event);
    assert.equal(e.document.querySelector('[data-field="shortcut"]').value, "Super+Semicolon");
    await e.click(".record");
    const cancel = new e.window.Event("keydown", {cancelable:true});
    Object.assign(cancel, {key:"Escape", code:"Escape"});
    e.document.dispatchEvent(cancel);
    assert.equal(e.document.querySelector(".record").textContent, "Record keys");
    e.input("#search", "missing");
    assert.equal(e.document.querySelector(".binding").hidden, true);
    e.input("#search", "move");
    assert.equal(e.document.querySelector(".binding").hidden, false);
});

async function conflictingShortcut(e) {
    await e.click("#add");
    e.input('.binding:last-child [data-field="label"]', "New owner");
    e.input('.binding:last-child [data-field="shortcut"]', "alt+control+right");
    e.input('.binding:last-child [data-field="appMatch"]', "firefox.exe");
    await e.click(".binding:last-child .reassign");
}

test("reassignment previews affected shortcuts and only saves after confirmation and Save", async () => {
    const e = await editor();
    await conflictingShortcut(e);
    assert.match(e.document.querySelector(".binding:last-child .reassignment-summary").textContent, /Move right/);
    assert.equal(e.document.querySelector(".binding:last-child .reassignment").hidden, false);
    assert.equal(e.calls.filter(c => c.command === "save_config").length, 0);
    await e.click(".binding:last-child .cancel-reassignment");
    assert.equal(e.document.querySelector(".binding:last-child .reassignment").hidden, true);
    assert.equal(e.document.querySelector('[data-field="enabled"]').checked, true);
    await e.click(".binding:last-child .reassign");
    await e.click(".binding:last-child .confirm-reassignment");
    assert.equal(e.document.querySelector('[data-field="enabled"]').checked, false);
    assert.equal(e.calls.filter(c => c.command === "save_config").length, 0);
    await e.click("#save");
    const saved = e.calls.find(c => c.command === "save_config").args.config;
    assert.equal(saved.bindings[0].enabled, false);
    assert.equal(saved.bindings[0].label, "Move right");
    assert.equal(saved.bindings[1].enabled, true);
    assert.equal(saved.bindings[1].shortcut, "Ctrl+Alt+Right");
});

test("editing invalidates reassignment proposals and errors preserve the draft", async () => {
    const e = await editor();
    await conflictingShortcut(e);
    e.input('.binding:last-child [data-field="label"]', "Changed since preview");
    assert.equal(e.document.querySelector(".binding:last-child .reassignment").hidden, true);
    await e.click(".binding:last-child .confirm-reassignment");
    assert.equal(e.document.querySelector('[data-field="enabled"]').checked, true);
    assert.equal(e.document.querySelector('.binding:last-child [data-field="label"]').value, "Changed since preview");
    const failure = await editor({failReassignment:true});
    await conflictingShortcut(failure);
    assert.match(failure.document.querySelector("#message").textContent, /modifier/);
    assert.equal(failure.document.querySelector('[data-field="enabled"]').checked, true);
    assert.equal(failure.document.querySelector('.binding:last-child [data-field="shortcut"]').value, "alt+control+right");
});
