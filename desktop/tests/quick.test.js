import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const html = fs.readFileSync(new URL("../ui/quick.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../ui/shortcut-picker.js", import.meta.url), "utf8") + "\n" + fs.readFileSync(new URL("../ui/quick.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function popup(bindings) {
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
    const config = { version: 1, bindings, settings: { holdMode: "radial" } };
    const calls = [];
    const listeners = new Map();
    window.__TAURI__ = {
        event: { listen: async (name, callback) => { listeners.set(name, callback); return () => {}; } },
        core: { invoke: async (command, args) => {
            calls.push({ command, args });
            if (command === "get_config") return structuredClone(config);
            if (command === "quick_edit") return null;
            if (command === "start_shortcut_recording" || command === "stop_shortcut_recording" || command === "hide_quick") return null;
            if (command === "save_config") return structuredClone(args.config);
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
