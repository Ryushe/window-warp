import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const html = fs.readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const source = ["error-timer.js", "shortcut-picker.js", "app.js"].map(file => fs.readFileSync(new URL(`../ui/${file}`, import.meta.url), "utf8")).join("\n");
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function editor({ failLoad = false, failSave = false, failEnable = false, failReassignment = false, platform = "windows", bindings, settings, windows = [], monitors:initialMonitors = [{id:"left-id",name:"Left display",index:1,primary:true,stable:true},{id:"right-id",name:"Right display",index:2,primary:false,stable:true}], timers = {setTimeout:()=>1, clearTimeout:()=>{}} } = {}) {
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
    const config = { version: 1, bindings: bindings || [{ label: "Move right", shortcut: "Ctrl+Alt+Right", action: "push-right", appMatch: "" }] };
    if (settings) config.settings = structuredClone(settings);
    let monitors = initialMonitors;
    const calls = [];
    const controlRequests = [];
    const listeners = new Map();
    window.__TAURI__ = {
        event: { listen: async (name, callback) => { listeners.set(name, callback); return () => {}; } },
        core: { invoke: async (command, args) => {
            calls.push({ command, args });
            if (command === "get_status") return { enabled: false, platform, settingsPath: "test/settings.json" };
            if (command === "get_config") { if (failLoad) throw "Settings are unreadable"; return structuredClone(config); }
            if (command === "get_windows") return structuredClone(windows);
            if (command === "get_monitors") { if (monitors instanceof Error) throw monitors; return structuredClone(monitors); }
            if (command === "take_control_request") return controlRequests.shift() || null;
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
    vm.runInNewContext(source, { window, document, structuredClone, ...timers });
    await tick();
    return { window, document, calls, listeners, setMonitors(value) { monitors = value; },
        async openMonitors() { const section=document.querySelector('#monitor-settings'); section.open=true; section.dispatchEvent(new window.Event('toggle')); await tick(); },
        async control(request) { controlRequests.push(request); listeners.get("warp-control")(); await tick(); }, input(selector, value) {
        const field = document.querySelector(selector);
        field.value = value;
        field.dispatchEvent(new window.Event("input"));
    }, async click(selector) { document.querySelector(selector).click(); await tick(); } };
}

test("find open apps adds unambiguous identifiers to the draft and reports missing apps", async () => {
    const e = await editor({platform:"linux", bindings:[
        {label:"Firefox",shortcut:"Super+F",action:"pull-app",appMatch:"firefox.exe",enabled:true},
        {label:"Discord",shortcut:"Super+D",action:"pull-app",appMatch:"Discord.exe",enabled:true}
    ], windows:[{appId:"firefox",desktopId:"org.mozilla.firefox"}]});
    await e.click("#find-apps");
    assert.match(e.document.querySelector("#find-apps-result").textContent, /Not found: Discord/);
    assert.equal(e.document.querySelector(".app-matches").value, "firefox\norg.mozilla.firefox");
    assert.equal(e.calls.some(c => c.command === "save_config"), false);
    await e.click("#save");
    const saved = e.calls.find(c => c.command === "save_config").args.config;
    assert.equal(saved.bindings[0].appMatch, "firefox.exe");
    assert.deepEqual([...saved.bindings[0].appMatches], ["firefox", "org.mozilla.firefox"]);
});

test("popup default modifier is saved in settings", async () => {
    const e = await editor();
    const field = e.document.querySelector("#quick-modifier");
    field.value = "Alt";
    field.dispatchEvent(new e.window.Event("change"));
    await e.click("#save-settings");
    assert.equal(e.calls.find(c => c.command === "save_config").args.config.settings.quickModifier, "Alt");
});

test("app discovery leaves ambiguous names unchanged", async () => {
    const e = await editor({bindings:[{label:"Firefox",shortcut:"Super+F",action:"focus-app",appMatch:"firefox.exe",enabled:true}],
        windows:[{appId:"firefox",desktopId:"firefox"},{appId:"org.mozilla.firefox",desktopId:"org.mozilla.firefox"}]});
    await e.click("#find-apps");
    assert.match(e.document.querySelector("#find-apps-result").textContent, /Multiple matches/);
    assert.equal(e.document.querySelector(".app-matches").value, "");
    assert.equal(e.document.querySelector("#save").disabled, true);
});

test("hold settings stay editable while shortcuts are active and save from the settings page", async () => {
    const e = await editor();
    assert.equal(e.document.querySelector("#hold-enabled").checked, true);
    assert.equal(e.document.querySelector("#hold-delay").value, "400");
    const mode = e.document.querySelector("#hold-mode");
    assert.equal(mode.value, "tile");
    mode.value = "radial";
    mode.dispatchEvent(new e.window.Event("change"));
    e.input("#hold-delay", "725");
    const field = e.document.querySelector("#hold-enabled");
    field.checked = false;
    field.dispatchEvent(new e.window.Event("change"));
    await e.click("#save");
    const saved = e.calls.find(c => c.command === "save_config").args.config;
    assert.equal(saved.settings.holdDelayMs, 725);
    assert.equal(saved.settings.holdTileEnabled, false);
    assert.equal(saved.settings.holdMode,"radial");
    await e.click("#toggle");
    await e.openMonitors();
    assert.equal(field.disabled, false);
    assert.equal(mode.disabled, false);
    assert.equal(e.document.querySelector("#hold-delay").disabled, false);
    assert.equal(e.document.querySelector("#main-monitor").disabled, false);
    assert.equal(e.document.querySelector("#enable-on-launch").disabled, false);
    e.input("#hold-delay", "500");
    assert.equal(e.document.querySelector("#save-settings").disabled, false);
    await e.click("#save-settings");
    assert.equal(e.calls.filter(c => c.command === "save_config").at(-1).args.config.settings.holdDelayMs, 500);
    e.listeners.get("warp-enabled")({payload:false});
    assert.equal(field.disabled, false);
    assert.equal(field.checked, false);
    assert.equal(e.document.querySelector("#hold-delay").value, "500");
});

test("push is one action with a direction and a center-pointer checkbox", async () => {
    const e = await editor({bindings:[{label:"Left", shortcut:"Super+X", action:"push-left-center", appMatch:""}]});
    const action = e.document.querySelector('[data-field="action"]');
    assert.equal(action.value, "push");
    assert.equal(action.querySelector("optgroup").getAttribute("label"), "Movement");
    assert.equal(e.document.querySelector(".push-options").hidden, false);
    assert.equal(e.document.querySelector(".push-direction").value, "left");
    assert.equal(e.document.querySelector(".push-center").checked, true);
    const center = e.document.querySelector(".push-center");
    center.checked = false;
    center.dispatchEvent(new e.window.Event("change"));
    await e.click("#save");
    assert.equal(e.calls.find(c => c.command === "save_config").args.config.bindings[0].action, "push-left");
});
test("tile is one action with a side", async () => {
    const e = await editor({bindings:[{label:"Top", shortcut:"Ctrl+Alt+Up", action:"tile-up", appMatch:""}]});
    const action = e.document.querySelector('[data-field="action"]');
    assert.equal(action.value, "tile");
    assert.equal(e.document.querySelector(".tile-options").hidden, false);
    assert.equal(e.document.querySelector(".push-options").hidden, true);
    assert.equal(e.document.querySelector(".tile-side").value, "up");
    e.input(".tile-side", "right");
    await e.click("#save");
    assert.equal(e.calls.find(c => c.command === "save_config").args.config.bindings[0].action, "tile-right");
});
test("cancel changes restores the last saved shortcuts and settings", async () => {
    const e = await editor();
    e.document.querySelector('[data-mod="Shift"]').click();
    e.input("#hold-delay", "900");
    assert.equal(e.document.querySelector("#discard").disabled, false);
    await e.click("#discard");
    assert.equal(e.document.querySelector('[data-field="shortcut"]').value, "Ctrl+Alt+Right");
    assert.equal(e.document.querySelector("#hold-delay").value, "400");
    assert.equal(e.document.querySelector("#save").disabled, true);
    assert.equal(e.calls.some(c => c.command === "save_config"), false);
});
test("bulk shortcut actions are scoped, reversible until saved, and require confirmation to remove", async () => {
    const bindings = [
        {label:"First",shortcut:"Ctrl+Alt+1",action:"pull",enabled:false},
        {label:"Second",shortcut:"Ctrl+Alt+2",action:"pull",enabled:true},
        {label:"Third",shortcut:"Ctrl+Alt+3",action:"pull",enabled:false}
    ];
    const e = await editor({bindings});
    assert.equal(e.document.querySelector('#enable-all-shortcuts').textContent,'Enable all');
    await e.click('#enable-all-shortcuts');
    assert.deepEqual([...e.document.querySelectorAll('[data-field="enabled"]')].map(input => input.checked),[true,true,true]);
    assert.equal(e.document.querySelector('#enable-all-shortcuts').textContent,'Disable all');
    await e.click('#enable-all-shortcuts');
    assert.deepEqual([...e.document.querySelectorAll('[data-field="enabled"]')].map(input => input.checked),[false,false,false]);
    assert.equal(e.document.querySelector('#enable-all-shortcuts').textContent,'Enable all');
    await e.click('#enable-all-shortcuts');
    assert.equal(e.calls.some(c => c.command === 'save_config'),false);
    await e.click('#discard');
    assert.deepEqual([...e.document.querySelectorAll('[data-field="enabled"]')].map(input => input.checked),[false,true,false]);

    await e.click('#select-shortcuts');
    check(e,'.binding:nth-child(1) .select-binding',true);
    check(e,'.binding:nth-child(2) .select-binding',true);
    await e.click('#disable-selected-shortcuts');
    assert.deepEqual([...e.document.querySelectorAll('[data-field="enabled"]')].map(input => input.checked),[false,false,false]);
    await e.click('#enable-selected-shortcuts');
    assert.deepEqual([...e.document.querySelectorAll('[data-field="enabled"]')].map(input => input.checked),[true,true,false]);
    e.input('#search','Third');
    assert.match(e.document.querySelector('#selected-shortcut-count').textContent,/2 hidden by search/);
    await e.click('#select-visible-shortcuts');
    assert.match(e.document.querySelector('#selected-shortcut-count').textContent,/3 selected/);
    await e.click('#remove-selected-shortcuts');
    assert.match(e.document.querySelector('#confirm-remove-shortcuts-text').textContent,/3 selected shortcuts/);
    assert.equal(e.document.querySelectorAll('.binding').length,3);
    await e.click('#cancel-remove-shortcuts');
    assert.equal(e.document.querySelectorAll('.binding').length,3);
    await e.click('#remove-selected-shortcuts');
    await e.click('#confirm-remove-shortcuts-button');
    assert.equal(e.document.querySelectorAll('.binding').length,0);
    assert.equal(e.calls.some(c => c.command === 'save_config'),false);
    await e.click('#discard');
    assert.equal(e.document.querySelectorAll('.binding').length,3);
});
test("selection mode closes when the last shortcut is removed", async () => {
    const e = await editor();
    await e.click('#select-shortcuts');
    await e.click('.binding-summary');
    await e.click('.binding .remove');
    assert.equal(e.document.querySelector('#shortcut-selection').hidden,true);
    assert.equal(e.document.querySelector('#select-shortcuts').getAttribute('aria-pressed'),'false');
});
test("KDE editor offers the same hold settings as Windows", async () => {
    const e = await editor({platform:"linux"});
    assert.equal(e.document.querySelector("#hold-enabled").disabled, false);
    assert.equal(e.document.querySelector("#hold-delay").disabled, false);
    e.input("#hold-delay", "550");
    await e.click("#save");
    assert.equal(e.calls.find(c => c.command === "save_config").args.config.settings.holdDelayMs, 550);
});

const typedBinding = () => ({label:"Work editor",shortcut:"Ctrl+Alt+E",action:"pull-app",appMatch:"editor.exe",enabled:false,windowsMatch:{titleContains:"Work ",className:"EditorClass",executable:"editor.exe",packagedAppId:"",processId:42,windowId:"9007199254740993",activeOnly:false}});
function check(e, selector, value, event="change") {
    const input=e.document.querySelector(selector); input.checked=value; input.dispatchEvent(new e.window.Event(event));
}
test("Windows matching criteria save losslessly, participate in search and lock with shortcuts",async()=>{
    const e=await editor({bindings:[typedBinding()]});
    assert.equal(e.document.querySelector('.windows-match-enabled').checked,true);
    assert.equal(e.document.querySelector('.match-field').hidden,true);
    e.input('[data-windows-match="titleContains"]',"Other ");
    e.input('[data-windows-match="className"]',"ExactClass");
    e.input('[data-windows-match="executable"]',"C:\\Apps\\Editor.exe");
    e.input('[data-windows-match="processId"]',"4294967295");
    e.input('[data-windows-match="windowId"]',"0x20000000000001");
    check(e,'[data-windows-match="activeOnly"]',true,"input");
    assert.equal(e.document.querySelector('#toggle').disabled,true);
    e.input('#search',"ExactClass"); assert.equal(e.document.querySelector('.binding').hidden,false);
    e.input('#search',"not-present"); assert.equal(e.document.querySelector('.binding').hidden,true);
    e.input('#search',"");
    await e.click('#save');
    const saved=e.calls.find(c=>c.command==="save_config").args.config.bindings[0];
    assert.deepEqual(JSON.parse(JSON.stringify(saved.windowsMatch)),{titleContains:"Other ",className:"ExactClass",executable:"C:\\Apps\\Editor.exe",packagedAppId:"",processId:4294967295,windowId:"9007199254740993",activeOnly:true});
    await e.click('#toggle');
    for(const input of e.document.querySelectorAll('.windows-match-field input')) assert.equal(input.disabled,false);
    e.listeners.get('warp-enabled')({payload:false});
    assert.equal(e.document.querySelector('[data-windows-match="titleContains"]').disabled,false);
    assert.equal(e.document.querySelector('[data-windows-match="titleContains"]').value,"Other ");
});
test("Windows criteria can be removed for Linux adaptation without losing the draft",async()=>{
    const e=await editor({platform:"linux",bindings:[typedBinding()]});
    assert.match(e.document.querySelector('.windows-match-hint').textContent,/Windows-only.*KDE/);
    check(e,'.windows-match-enabled',false);
    assert.equal(e.document.querySelector('.match-field').hidden,false);
    e.input('[data-field="appMatch"]',"org.example.Editor");
    await e.click('#save');
    const saved=e.calls.find(c=>c.command==="save_config").args.config.bindings[0];
    assert.equal(saved.windowsMatch,null); assert.equal(saved.appMatch,"org.example.Editor");
    assert.equal(saved.enabled,false);
});
test("enabling advanced matching starts from the edited app identifier and preserves toggled criteria",async()=>{
    const e=await editor({bindings:[{label:"App",shortcut:"Ctrl+Alt+E",action:"pull-app",appMatch:"old.exe"}]});
    e.input('[data-field="appMatch"]',"new.exe");
    check(e,'.windows-match-enabled',true);
    assert.equal(e.document.querySelector('[data-windows-match="executable"]').value,"new.exe");
    e.input('[data-windows-match="titleContains"]',"Work");
    check(e,'.windows-match-enabled',false); check(e,'.windows-match-enabled',true);
    assert.equal(e.document.querySelector('[data-windows-match="titleContains"]').value,"Work");
    await e.click('#save');
    assert.equal(e.calls.find(c=>c.command==="save_config").args.config.bindings[0].windowsMatch.executable,"new.exe");
});
test("enabling advanced matching preserves a packaged app ID while adding a title filter",async()=>{
    const id="Contoso.Editor_abc!Editor";
    const e=await editor({bindings:[{label:"Packaged editor",shortcut:"Ctrl+Alt+E",action:"pull-app",appMatch:id}]});
    check(e,'.windows-match-enabled',true);
    assert.equal(e.document.querySelector('[data-windows-match="executable"]').value,"");
    assert.equal(e.document.querySelector('[data-windows-match="packagedAppId"]').value,id);
    e.input('[data-windows-match="titleContains"]',"Work");
    await e.click('#save');
    const saved=e.calls.find(c=>c.command==="save_config").args.config.bindings[0];
    assert.equal(saved.windowsMatch.packagedAppId,id);
    assert.equal(saved.windowsMatch.executable,"");
    assert.equal(saved.windowsMatch.titleContains,"Work");
    assert.equal(saved.appMatch,id);
});
test("existing typed selectors do not inherit a packaged constraint from dormant appMatch metadata",async()=>{
    const e=await editor({bindings:[{label:"Title",shortcut:"Ctrl+Alt+E",action:"pull-app",appMatch:"Contoso_abc!Editor",windowsMatch:{titleContains:"Work",className:"",executable:"",processId:null,windowId:null,activeOnly:false}}]});
    assert.equal(e.document.querySelector('[data-windows-match="packagedAppId"]').value,"");
    e.input('[data-field="label"]',"Edited title rule");
    await e.click('#save');
    assert.equal(e.calls.find(c=>c.command==="save_config").args.config.bindings[0].windowsMatch.packagedAppId,"");
});
test("current-app editing does not reuse a narrower typed binding through its dormant app identifier",async()=>{
    const e=await editor({bindings:[typedBinding()]});
    await e.control({action:"open-editor",window:{appId:"editor.exe"}});
    assert.equal(e.document.querySelectorAll('.binding').length,2);
    assert.equal(e.document.querySelector('.binding:first-child [data-windows-match="titleContains"]').value,"Work ");
    assert.equal(e.document.querySelector('.binding:last-child .windows-match-enabled').checked,false);
    await e.control({action:"open-editor",window:{appId:"EDITOR.EXE"}});
    assert.equal(e.document.querySelectorAll('.binding').length,2);
});
test("current-app editing reuses a simple imported executable selector and preserves its settings",async()=>{
    const binding=typedBinding();
    binding.windowsMatch={titleContains:"",className:"",executable:"EDITOR.EXE",processId:null,windowId:null,activeOnly:false};
    binding.appMatch="editor.exe";
    const e=await editor({bindings:[binding]});
    e.input('[data-field="label"]',"Unsaved imported edit");
    await e.control({action:"open-editor",window:{appId:"Editor.exe",path:"C:\\Apps\\Editor.exe"}});
    assert.equal(e.document.querySelectorAll('.binding').length,1);
    assert.equal(e.document.querySelector('[data-field="label"]').value,"Unsaved imported edit");
    assert.equal(e.document.querySelector('.windows-match-enabled').checked,true);
    assert.equal(e.document.querySelector('[data-field="shortcut"]').value,"Ctrl+Alt+E");
    assert.equal(e.calls.some(c=>c.command==="save_config"),false);
    await e.click('#save');
    const saved=e.calls.find(c=>c.command==="save_config").args.config.bindings[0];
    assert.equal(saved.enabled,false);
    assert.equal(saved.windowsMatch.executable,"EDITOR.EXE");
});

test("unsaved changes block activation; save and pause preserve editor state", async () => {
    const e = await editor();
    e.input('[data-field="shortcut"]', "Ctrl+Alt+F");
    assert.equal(e.document.querySelector("#toggle").disabled, true);
    await e.click("#save");
    assert.equal(e.calls.find((c) => c.command === "save_config").args.config.bindings[0].shortcut, "Ctrl+Alt+F");
    assert.equal(e.document.querySelector("#toggle").disabled, false);
    await e.click("#toggle");
    assert.equal(e.document.querySelector('[data-field="label"]').disabled, false);
    assert.equal(e.document.querySelector('[data-field="action"]').disabled, false);
    assert.equal(e.document.querySelector('[data-field="shortcut"]').disabled, false);
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
test("settings save errors stay by settings and application errors remain visible and dismissible", async () => {
    const e = await editor({ failSave: true });
    e.document.querySelector("#shortcuts-page").hidden = true;
    e.document.querySelector("#settings-page").hidden = false;
    e.input("#hold-delay", "500");
    await e.click("#save-settings");
    assert.match(e.document.querySelector("#settings-message").textContent, /Duplicate/);
    assert.equal(e.document.querySelector("#message").textContent, "");
    assert.equal(e.document.querySelector("#hold-delay").value, "500");

    e.document.querySelector("#settings-page").hidden = true;
    e.document.querySelector("#workspaces-page").hidden = false;
    e.listeners.get("warp-error")({payload:"An application error"});
    assert.equal(e.document.querySelector("#app-alert").hidden, false);
    assert.equal(e.document.querySelector("#app-alert-text").textContent, "An application error");
    await e.click("#app-alert-dismiss");
    assert.equal(e.document.querySelector("#app-alert").hidden, true);
});
test("application errors restart their countdown and manual dismissal cancels it", async () => {
    let next = 0;
    const pending = new Map();
    const timers = {setTimeout:(fn, delay) => {const id = ++next; pending.set(id, {fn, delay}); return id;}, clearTimeout:id => pending.delete(id)};
    const e = await editor({timers});
    const alert = e.document.querySelector("#app-alert");
    e.listeners.get("warp-error")({payload:"First error"});
    const stale = [...pending.values()][0].fn;
    assert.equal(alert.classList.contains("timed-error"), true);
    assert.equal([...pending.values()][0].delay, 6000);
    e.listeners.get("warp-error")({payload:"Second error"});
    stale();
    assert.equal(alert.hidden, false);
    assert.equal(e.document.querySelector("#app-alert-text").textContent, "Second error");
    const [id, current] = [...pending][0];
    pending.delete(id);
    current.fn();
    assert.equal(alert.hidden, true);
    e.listeners.get("warp-error")({payload:"Third error"});
    await e.click("#app-alert-dismiss");
    assert.equal(alert.hidden, true);
    assert.equal(pending.size, 0);
});
test("quick editor save errors remain visible above the open editor", async () => {
    const e = await editor({ failSave: true });
    await e.control({action:"open-editor",window:{appId:"firefox.exe"}});
    assert.equal(e.document.querySelector("#quick-edit").hidden, false);
    await e.click("#quick-apply");
    assert.equal(e.document.querySelector("#quick-edit").hidden, false);
    assert.equal(e.document.querySelector("#app-alert").hidden, false);
    assert.match(e.document.querySelector("#app-alert-text").textContent, /Duplicate/);
});
test("failed registration leaves controls paused and editable", async () => {
    const e = await editor({ failEnable: true });
    await e.click("#toggle");
    assert.match(e.document.querySelector("#app-alert-text").textContent, /already in use/);
    assert.equal(e.document.querySelector("#app-alert").hidden, false);
    assert.equal(e.document.querySelector("#status").textContent, "Paused");
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
    await e.openMonitors();
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
    assert.equal(config.settings.mainMonitorId, "right-id");
    assert.equal(config.settings.burnerMonitorId, "left-id", "the second monitor follows the other connected display");
});

test("second-monitor placement follows the chosen app behavior and is preserved", async () => {
    const binding={label:"Discord",shortcut:"Super+D",action:"pull-app",appMatch:"Discord.exe",enabled:true,mainMonitorAction:"focus-last",burnerLayout:"tile-right"};
    const e=await editor({bindings:[binding]});
    const options=e.document.querySelector(".app-options");
    const placement=e.document.querySelector(".burner-layout-field");
    assert.equal(options.hidden,false);
    assert.equal(options.firstElementChild.textContent,"Behavior");
    assert.equal(placement.hidden,true);
    e.input('[data-field="mainMonitorAction"]',"burner");
    assert.equal(placement.hidden,false);
    assert.equal(e.document.querySelector('[data-field="burnerLayout"]').value,"tile-right");
    e.input('[data-field="burnerLayout"]',"tile-left");
    e.input('[data-field="mainMonitorAction"]',"focus-last");
    assert.equal(placement.hidden,true);
    await e.click("#save");
    const saved=e.calls.find(call=>call.command==="save_config").args.config.bindings[0];
    assert.equal(saved.mainMonitorAction,"focus-last");
    assert.equal(saved.burnerLayout,"tile-left");
});

test("the inline quick editor hides only the unused monitor placement", async () => {
    const binding={label:"Discord",shortcut:"Super+D",action:"pull-app",appMatch:"Discord.exe",enabled:true,mainMonitorAction:"focus-last",burnerLayout:"tile-right"};
    const e=await editor({bindings:[binding]});
    await e.control({action:"open-editor",window:{appId:"Discord.exe"}});
    const behavior=e.document.querySelector("#quick-behavior"), layout=e.document.querySelector("#quick-layout");
    assert.equal(layout.closest("label").hidden,true);
    behavior.value="burner"; behavior.dispatchEvent(new e.window.Event("change"));
    assert.equal(layout.closest("label").hidden,false);
    assert.equal(layout.value,"tile-right");
    behavior.value="focus-last"; behavior.dispatchEvent(new e.window.Event("change"));
    assert.equal(e.document.querySelector("#quick-layout-hint").hidden,true);
    await e.click("#quick-apply");
    assert.equal(e.calls.find(call=>call.command==="save_config").args.config.bindings[0].burnerLayout,"tile-right");
});

test("monitor settings show detected names and keep identity after display order changes", async () => {
    const e = await editor({settings:{mainMonitor:1,burnerMonitor:2,mainMonitorId:"left-id",burnerMonitorId:"right-id"}});
    await e.openMonitors();
    assert.match(e.document.querySelector('#main-monitor').textContent,/Left display/);
    assert.match(e.document.querySelector('#burner-monitor').textContent,/Right display/);
    e.setMonitors([{id:'right-id',name:'Right display',index:1,primary:false,stable:true},{id:'left-id',name:'Left display',index:2,primary:true,stable:true}]);
    await e.openMonitors();
    assert.equal(e.document.querySelector('#main-monitor').value,'2');
    assert.equal(e.document.querySelector('#burner-monitor').value,'1');
    e.input('#main-monitor','0');
    await e.click('#save');
    const settings=e.calls.filter(call=>call.command==='save_config').at(-1).args.config.settings;
    assert.equal(settings.mainMonitor,0);
    assert.equal(settings.mainMonitorId,'');
    assert.equal(settings.burnerMonitorId,'right-id');
});

test("a disconnected monitor remains visible and saved while detection failures can be retried", async () => {
    const e = await editor({settings:{mainMonitor:1,burnerMonitor:2,mainMonitorId:'missing-id',burnerMonitorId:'right-id'}});
    await e.openMonitors();
    assert.match(e.document.querySelector('#main-monitor').textContent,/disconnected/);
    assert.equal(e.document.querySelector('#main-monitor').value,'missing');
    e.setMonitors(new Error('unavailable'));
    await e.openMonitors();
    assert.equal(e.document.querySelector('#main-monitor').disabled,true);
    assert.equal(e.document.querySelector('#retry-monitors').disabled,false);
    e.setMonitors([{id:'right-id',name:'Right display',index:1,primary:true,stable:true}]);
    await e.click('#retry-monitors');
    assert.equal(e.document.querySelector('#main-monitor').disabled,false);
    assert.match(e.document.querySelector('#main-monitor').textContent,/disconnected/);
    e.input('#hold-delay','500');
    await e.click('#save');
    assert.equal(e.calls.filter(call=>call.command==='save_config').at(-1).args.config.settings.mainMonitorId,'missing-id');
});

test("Plasma 5 keeps positional compatibility and explains display reordering", async () => {
    const e=await editor({platform:'linux',monitors:[{id:'0',name:'Laptop panel',index:1,primary:true,stable:false},{id:'1',name:'External monitor',index:2,primary:false,stable:false}]});
    await e.openMonitors();
    assert.match(e.document.querySelector('#monitor-hint').textContent,/reconnecting or rearranging/i);
    assert.match(e.document.querySelector('#main-monitor').textContent,/Automatic/);
    e.input('#main-monitor','2');
    await e.click('#save');
    const settings=e.calls.filter(call=>call.command==='save_config').at(-1).args.config.settings;
    assert.equal(settings.mainMonitor,2);
    assert.equal(settings.mainMonitorId,'');
});

test("a shortcut is built from modifier buttons and a key, without recording", async () => {
    const e = await editor();
    const field = e.document.querySelector('[data-field="shortcut"]');
    const card = e.document.querySelector(".key-field");
    assert.equal(field.value, "Ctrl+Alt+Right");
    assert.equal(card.querySelector('[data-mod="Ctrl"]').getAttribute("aria-pressed"), "true");
    assert.equal(card.querySelector('[data-mod="Super"]').getAttribute("aria-pressed"), "false");
    const pressed = new e.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(pressed, {key:"x", code:"KeyX"});
    field.dispatchEvent(pressed);
    assert.equal(field.value, "Ctrl+Alt+X");
    card.querySelector('[data-mod="Super"]').click();
    const semicolon = new e.window.Event("keydown", {bubbles:true, cancelable:true});
    Object.assign(semicolon, {key:";", code:"Semicolon"});
    field.dispatchEvent(semicolon);
    assert.equal(field.value, "Ctrl+Alt+Super+Semicolon");
    assert.equal(e.document.querySelector(".shortcut-key"), null);
    assert.equal(e.calls.some(c => c.command === "start_shortcut_recording"), false);
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
    assert.match(failure.document.querySelector(".binding:last-child .binding-feedback").textContent, /modifier/);
    assert.equal(failure.document.querySelector('[data-field="enabled"]').checked, true);
    assert.equal(failure.document.querySelector('.binding:last-child [data-field="shortcut"]').value, "alt+control+right");
});

test("current-app editor requests preserve existing drafts and reuse an existing app binding", async () => {
    const e = await editor();
    e.input('[data-field="label"]', "Unsaved existing edit");
    await e.control({action:"open-editor", window:{appId:"firefox.exe"}});
    assert.equal(e.document.querySelectorAll(".binding").length, 2);
    assert.equal(e.document.querySelector('[data-field="label"]').value, "Unsaved existing edit");
    assert.equal(e.document.querySelector('.binding:last-child [data-field="appMatch"]').value, "firefox.exe");
    e.input('.binding:last-child [data-field="shortcut"]', "Super+F");
    await e.control({action:"open-editor", window:{appId:"FIREFOX.EXE"}});
    assert.equal(e.document.querySelectorAll(".binding").length, 2);
    assert.equal(e.document.querySelector('.binding:last-child [data-field="shortcut"]').value, "Super+F");
    assert.equal(e.calls.some(c => c.command === "save_config"), false);
});

test("application control requests reach the workspace editor without mutating shortcuts", async () => {
    const e = await editor();
    let received;
    e.window.addEventListener("warp-workspace-request", event => { received = event.detail; });
    await e.control({action:"open-workspaces"});
    assert.equal(received.action, "open-workspaces");
    assert.equal(e.document.querySelectorAll(".binding").length, 1);
});

test("resuming saved shortcuts keeps unsaved editor changes clearly identified", async () => {
    const e = await editor();
    e.input('[data-field="label"]', "Unsaved label");
    e.listeners.get("warp-enabled")({payload:true});
    assert.equal(e.document.querySelector("#save-status").textContent, "Unsaved changes");
    assert.equal(e.document.querySelector("#message").textContent, "");
    assert.equal(e.document.querySelector('[data-field="label"]').value, "Unsaved label");
    assert.equal(e.document.querySelector('[data-field="label"]').disabled, false);
});

test("built-in themes, a custom palette, and custom CSS apply without leaving the editor", async () => {
    const e = await editor();
    assert.equal(e.document.documentElement.dataset.theme, "warp");
    const theme = e.document.querySelector("#theme");
    theme.value = "dracula";
    theme.dispatchEvent(new e.window.Event("change"));
    assert.equal(e.document.documentElement.dataset.theme, "dracula");
    const background = e.document.querySelector("#theme-bg");
    background.value = "#112233";
    background.dispatchEvent(new e.window.Event("input"));
    assert.equal(e.document.documentElement.dataset.theme, "custom");
    assert.equal(e.document.documentElement.style.getPropertyValue("--custom-bg"), "#112233");
    assert.equal(e.document.querySelector("#theme-custom").hidden, false);
    const css = e.document.querySelector("#theme-css");
    css.value = "body { color: red; }</style><script>";
    css.dispatchEvent(new e.window.Event("input"));
    const style = e.document.getElementById("theme-user-css");
    assert.match(style.textContent, /color: red/);
    assert.equal(style.textContent.includes("</style"), false);
});
