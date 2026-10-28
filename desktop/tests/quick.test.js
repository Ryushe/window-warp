import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const html = fs.readFileSync(new URL("../ui/quick.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../ui/shortcut-picker.js", import.meta.url), "utf8") + "\n" + fs.readFileSync(new URL("../ui/quick.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function popup(bindings, settings = {}, options = {}) {
    const { window, document } = parseHTML(html);
    Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
        configurable: true,
        get() { return this.querySelector("option[selected]")?.value ?? this.querySelector("option")?.value; },
        set(value) {
            this.querySelectorAll("option").forEach((option) => option.removeAttribute("selected"));
            const selected = [...this.querySelectorAll("option")].find((option) => option.value === value);
            if (selected) selected.setAttribute("selected", "");
        }
    });
    const config = { version: 1, bindings, settings: { holdMode: "radial", ...settings } };
    const calls = [];
    const listeners = new Map();
    window.__TAURI__ = {
        event: { listen: async (name, callback) => { listeners.set(name, callback); return () => {}; } },
        core: { invoke: async (command, args) => {
            calls.push({ command, args });
            if (command === "get_config") {
                if (options.waitForConfig) await options.waitForConfig;
                return structuredClone(config);
            }
            if (command === "show_editor") return null;
            if (command === "quick_edit") return null;
            if (command === "start_shortcut_recording" || command === "stop_shortcut_recording" || command === "hide_quick") return null;
            if (command === "save_config") return structuredClone(args.config);
            if (command === "preview_shortcut_reassignment") {
                const proposal = structuredClone(args.config);
                const selected = proposal.bindings[args.index];
                const disabledIndices = [];
                proposal.bindings.forEach((binding, index) => {
                    if (index !== args.index && binding.enabled !== false && binding.shortcut === selected.shortcut) {
                        disabledIndices.push(index);
                        binding.enabled = false;
                    }
                });
                return {config:proposal, disabledIndices};
            }
            throw new Error(command);
        } }
    };
    vm.runInNewContext(source, { window, document });
    await tick();
    return { window, document, calls, listeners };
}

const discord = {
    label: "Discord",
    shortcut: "Super+D",
    action: "pull-app",
    appMatch: "Discord.exe",
    enabled: true,
    mainMonitorAction: "burner",
    burnerLayout: "tile-left"
};

test("popup prefills the Discord shortcut from the same binding the list shows", async () => {
    const page = await popup([discord]);
    await page.listeners.get("quick-edit")({ payload: {
        window: { appId: "discord.exe", path: "C:\\Users\\jaady\\AppData\\Local\\Discord\\Discord.exe", title: "Friends - Discord", desktopId: "" },
        label: "Discord",
        shortcut: "Super+D",
        bindingIndex: 0,
        mainMonitorAction: "burner",
        burnerLayout: "tile-left"
    } });
    await tick();
    assert.equal(page.document.querySelector("#quick-title").textContent, "Shortcut");
    assert.equal(page.document.querySelector("#quick-app").textContent, "Discord");
    assert.equal(page.document.querySelector("#quick-entry").value, "Super+D");
    assert.equal(page.document.querySelector('[data-mod="Super"]').getAttribute("aria-pressed"), "true");
    assert.equal(page.document.querySelector("#quick-key"), null);
    assert.equal(page.document.querySelector("#quick-hint").textContent.includes("Super"), true);
    assert.equal(page.document.querySelector("#quick-hint").textContent.includes("Win"), false);
    assert.equal(page.calls.some(c => c.command === "start_shortcut_recording"), false);
    const pressed = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(pressed, {key:"c", code:"KeyC"});
    page.document.querySelector("#quick-entry").dispatchEvent(pressed);
    assert.equal(page.document.querySelector("#quick-entry").value, "Super+C");
    page.document.querySelector('[data-mod="Alt"]').click();
    assert.equal(page.document.querySelector("#quick-entry").value, "Alt+Super+C");
});

test("a new popup shortcut uses the configured modifier and saves on Enter", async () => {
    const page = await popup([], {quickModifier:"Alt"});
    await page.listeners.get("quick-edit")({payload:{window:{appId:"editor.exe"}, label:"Editor"}});
    await tick();
    assert.equal(page.document.querySelector('[data-mod="Alt"]').getAttribute("aria-pressed"), "true");
    const key = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(key, {key:"c", code:"KeyC"});
    page.document.querySelector("#quick-entry").dispatchEvent(key);
    assert.equal(page.document.querySelector("#quick-entry").value, "Alt+C");
    const enter = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(enter, {key:"Enter", code:"Enter"});
    page.document.querySelector("#quick-entry").dispatchEvent(enter);
    await tick();
    assert.equal(page.calls.find(c => c.command === "save_config").args.config.bindings[0].shortcut, "Alt+C");
    assert.equal(page.calls.some(c => c.command === "start_shortcut_recording"), false);
});

test("a conflicting shortcut requires explicit replacement and preserves the displaced binding", async () => {
    const page = await popup([{label:"Push right",shortcut:"Super+C",action:"push-right",appMatch:"",enabled:true}]);
    await page.listeners.get("quick-edit")({payload:{window:{appId:"editor.exe"}, label:"Editor"}});
    await tick();
    const key = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(key, {key:"c", code:"KeyC"});
    page.document.querySelector("#quick-entry").dispatchEvent(key);
    page.document.querySelector("#quick-apply").click();
    await tick();
    assert.equal(page.document.querySelector("#quick-conflict").hidden, false);
    assert.match(page.document.querySelector("#quick-conflict-summary").textContent, /Push right/);
    assert.equal(page.calls.some(c => c.command === "save_config"), false);
    page.document.querySelector("#quick-replace").click();
    await tick();
    const saved = page.calls.find(c => c.command === "save_config").args.config;
    assert.equal(saved.bindings[0].enabled, false);
    assert.equal(saved.bindings[0].shortcut, "Super+C");
    assert.equal(saved.bindings[1].shortcut, "Super+C");
});

test("only the configured editor chord opens the main window from the popup", async () => {
    const page = await popup([
        {label:"Open editor",shortcut:"Ctrl+Alt+K",action:"open-editor",enabled:true},
        discord
    ]);
    await page.listeners.get("quick-edit")({payload:{window:{appId:"discord.exe"},label:"Discord",shortcut:"Super+D",bindingIndex:1}});
    await tick();
    const other = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(other, {key:"b",code:"KeyB",metaKey:true});
    page.document.dispatchEvent(other);
    assert.equal(page.calls.some(c => c.command === "show_editor"), false);
    const editor = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(editor, {key:"k",code:"KeyK",ctrlKey:true,altKey:true});
    page.document.dispatchEvent(editor);
    await tick();
    assert.equal(page.calls.filter(c => c.command === "show_editor").length, 1);
    assert.equal(page.calls.some(c => c.command === "hide_quick"), true);
});

test("the configured editor chord works when the current window has no app name", async () => {
    const page = await popup([{label:"Open editor",shortcut:"Super+B",action:"open-editor",enabled:true}]);
    await page.listeners.get("quick-edit")({payload:{}});
    const editor = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(editor, {key:"b",code:"KeyB",metaKey:true});
    page.document.dispatchEvent(editor);
    await tick();
    assert.equal(page.calls.filter(c => c.command === "show_editor").length, 1);
    assert.equal(page.document.querySelector("#quick-apply").disabled, true);
    assert.equal(page.document.querySelector("#quick-entry").value, "");
});

test("a configured editor chord waits for delayed config instead of changing the shortcut", async () => {
    let releaseConfig;
    const waitForConfig = new Promise(resolve => { releaseConfig = resolve; });
    const page = await popup([
        {label:"Open editor",shortcut:"Ctrl+Alt+K",action:"open-editor",enabled:true},
        discord
    ], {}, {waitForConfig});
    const opening = page.listeners.get("quick-edit")({payload:{window:{appId:"discord.exe"},label:"Discord",shortcut:"Super+D",bindingIndex:1}});
    const editor = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(editor, {key:"k",code:"KeyK",ctrlKey:true,altKey:true});
    page.document.dispatchEvent(editor);
    assert.equal(page.calls.some(c => c.command === "show_editor"), false);
    releaseConfig();
    await opening;
    await tick();
    assert.equal(page.calls.filter(c => c.command === "show_editor").length, 1);
    assert.equal(page.document.querySelector("#quick-entry").value, "Super+D");
});

test("ordinary key and Enter remain ordered while config is loading", async () => {
    let releaseConfig;
    const waitForConfig = new Promise(resolve => { releaseConfig = resolve; });
    const page = await popup([], {quickModifier:"Alt"}, {waitForConfig});
    const opening = page.listeners.get("quick-edit")({payload:{window:{appId:"editor.exe"},label:"Editor"}});
    const key = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(key, {key:"c",code:"KeyC"});
    page.document.querySelector("#quick-entry").dispatchEvent(key);
    const enter = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(enter, {key:"Enter",code:"Enter"});
    page.document.querySelector("#quick-entry").dispatchEvent(enter);
    releaseConfig();
    await opening;
    await tick();
    await tick();
    assert.equal(page.calls.find(c => c.command === "save_config").args.config.bindings[0].shortcut, "Alt+C");
});

test("an unnamed popup refreshes the editor chord instead of using a previous one", async () => {
    const bindings = [{label:"Open editor",shortcut:"Ctrl+Alt+K",action:"open-editor",enabled:true}, discord];
    const page = await popup(bindings);
    await page.listeners.get("quick-edit")({payload:{window:{appId:"discord.exe"},label:"Discord"}});
    bindings[0].shortcut = "Super+B";
    await page.listeners.get("quick-edit")({payload:{}});
    const editor = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(editor, {key:"b",code:"KeyB",metaKey:true});
    page.document.dispatchEvent(editor);
    await tick();
    assert.equal(page.calls.filter(c => c.command === "show_editor").length, 1);
});

test("a queued editor chord is discarded if the popup is cancelled while config loads", async () => {
    let releaseConfig;
    const waitForConfig = new Promise(resolve => { releaseConfig = resolve; });
    const page = await popup([{label:"Open editor",shortcut:"Super+B",action:"open-editor",enabled:true}], {}, {waitForConfig});
    const opening = page.listeners.get("quick-edit")({payload:{window:{appId:"editor.exe"},label:"Editor"}});
    const editor = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(editor, {key:"b",code:"KeyB",metaKey:true});
    page.document.dispatchEvent(editor);
    const escape = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(escape, {key:"Escape",code:"Escape"});
    page.document.dispatchEvent(escape);
    releaseConfig();
    await opening;
    await tick();
    assert.equal(page.calls.some(c => c.command === "show_editor"), false);
    assert.equal(page.calls.some(c => c.command === "hide_quick"), true);
});

test("a held editor chord cannot be recorded as the new shortcut", async () => {
    const page = await popup([{label:"Open editor",shortcut:"Super+B",action:"open-editor",enabled:true},discord]);
    await page.listeners.get("quick-edit")({payload:{window:{appId:"discord.exe"},label:"Discord",shortcut:"Super+D",bindingIndex:1}});
    const repeat = new page.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(repeat, {key:"b",code:"KeyB",metaKey:true,repeat:true});
    page.document.dispatchEvent(repeat);
    await tick();
    assert.equal(page.calls.some(c => c.command === "show_editor"), false);
    assert.equal(page.document.querySelector("#quick-entry").value, "Super+D");
});

test("a title that merely mentions Discord does not replace the focused app shortcut", async () => {
    const page = await popup([
        discord,
        { label: "Code", shortcut: "Super+F", action: "pull-app", appMatch: "Code.exe", enabled: true, mainMonitorAction: "focus-last", burnerLayout: "float" }
    ]);
    await page.listeners.get("quick-edit")({ payload: {
        window: { appId: "Code.exe", path: "C:\\Program Files\\Microsoft VS Code\\Code.exe", title: "Discord notes", desktopId: "" },
        label: "Code",
        shortcut: "Super+F",
        bindingIndex: 1
    } });
    await tick();
    assert.equal(page.document.querySelector("#quick-app").textContent, "Code");
    assert.equal(page.document.querySelector("#quick-entry").value, "Super+F");
});
