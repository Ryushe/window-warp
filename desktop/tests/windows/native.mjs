// Opt-in Windows app fixture. All app/browser data stays in target/windows-validation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn, spawnSync} from "node:child_process";
import {createInterface} from "node:readline";
import {createServer} from "node:net";
import {randomUUID} from "node:crypto";

if (process.platform !== "win32") throw new Error("This fixture requires Windows");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const marker = "WARP-NATIVE-" + randomUUID();
const output = path.join(desktop, "src-tauri/target/windows-validation", marker);
const state = path.join(output, "state");
fs.mkdirSync(state, {recursive:true});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, description, timeout = 20000) {
    const deadline = Date.now() + timeout;
    let value;
    while (Date.now() < deadline) {
        value = await read();
        if (predicate(value)) return value;
        await sleep(100);
    }
    throw new Error("Timed out: " + description + "; last observed: " + JSON.stringify(value));
}
async function exit(child, timeout = 180000) {
    if (child.exitCode !== null) return child.exitCode;
    return Promise.race([
        new Promise((resolve, reject) => {child.once("exit", resolve); child.once("error", reject);}),
        new Promise((_, reject) => {const timer = setTimeout(() => reject(new Error("Child process timed out")), timeout); timer.unref();})
    ]);
}
const server = createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const override = {
    identifier:"com.windowwarp.fixture." + randomUUID().replaceAll("-", ""),
    app:{appDirectoriesOverride:state, windows:[{
        label:"main", title:marker, width:1050, height:760, minWidth:760, minHeight:560,
        additionalBrowserArgs:`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`
    }]}
};
fs.writeFileSync(path.join(output, "build-config.json"), JSON.stringify(override, null, 2));
const actions = ["push-left", "push-right", "pull", "tile-left", "tile-right", "toggle-pause", "open-editor", "open-workspaces", "update-workspace"];
const config = {version:1, settings:{mainMonitor:0,burnerMonitor:2}, bindings:actions.map((action,index) => ({
    label:action, shortcut:`Ctrl+Alt+Shift+F${13+index}`, action, enabled:true, appMatch:"", mainMonitorAction:"burner", burnerLayout:"float"
}))};
fs.writeFileSync(path.join(state, "settings.json"), JSON.stringify(config, null, 2));
const buildLog = fs.openSync(path.join(output, "build.log"), "w");
const cargo = path.join(process.env.USERPROFILE, ".cargo/bin/cargo.exe");
console.log("Building isolated native fixture:", output);
const build = spawn(cargo, ["build", "--manifest-path", "src-tauri/Cargo.toml", "--offline", "--features", "tauri/custom-protocol"], {
    cwd:desktop, env:{...process.env, CARGO_INCREMENTAL:"0", CARGO_BUILD_JOBS:"2", TAURI_CONFIG:JSON.stringify(override)},
    windowsHide:true, stdio:["ignore",buildLog,buildLog]
});
const built = await exit(build, 600000);
fs.closeSync(buildLog);
if (built !== 0) throw new Error("Native fixture build failed: " + fs.readFileSync(path.join(output,"build.log"),"utf8").slice(-6000));
const binary = path.join(output, "window-warp-fixture.exe");
fs.copyFileSync(path.join(desktop,"src-tauri/target/debug/window-warp.exe"), binary);

let app, helper, socket, second, startupTouched = false;
const checks = [];
const skipped = [];
let fixture, native;
let report = {passed:false, checks, skipped};
const appLog = fs.openSync(path.join(output,"app.log"), "w");
try {
    app = spawn(binary, [], {cwd:output, windowsHide:true, stdio:["ignore",appLog,appLog]});
    const target = await until(async () => {
        try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page" && /^https?:\/\/tauri\.localhost\//.test(t.url)); }
        catch { if (app.exitCode !== null) throw new Error("Fixture app exited before its WebView was ready"); return null; }
    }, Boolean, "owned WebView", 45000);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject) => {socket.addEventListener("open",resolve,{once:true}); socket.addEventListener("error",reject,{once:true});});
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
    });
    const cdp = (method, params = {}) => new Promise((resolve,reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {pending.delete(id); reject(new Error(`CDP timeout: ${method}`));}, 60000);
        pending.set(id,{resolve,reject,timer}); socket.send(JSON.stringify({id,method,params}));
    });
    const evaluate = async expression => {
        const result = await cdp("Runtime.evaluate", {expression,awaitPromise:true,returnByValue:true});
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result?.value;
    };
    const invoke = (command,args={}) => evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
    const wait = (expression, description, timeout) => until(() => evaluate(expression), Boolean, description, timeout);
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const input = (selector,value) => evaluate(`(() => {const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const screenshot = async name => fs.writeFileSync(path.join(output,name), Buffer.from((await cdp("Page.captureScreenshot")).data,"base64"));
    await wait("document.querySelectorAll('.binding').length === 9 && !document.querySelector('#toggle').disabled", "editor initialization");
    const status = await invoke("get_status");
    assert.equal(path.resolve(status.settingsPath).toLowerCase(), path.join(state,"settings.json").toLowerCase());
    assert.equal(status.enabled, false);
    assert.equal(status.shortcutError, null);
    checks.push("native WebView renders using isolated settings and browser state");

    helper = spawn("python", [path.join(desktop,"tests/windows/fixture.py"), "--marker", marker, "--app-pid", String(app.pid)], {windowsHide:true, stdio:["pipe","pipe","pipe"]});
    let helperError = "";
    helper.stderr.on("data", chunk => {helperError += chunk.toString();});
    const lines = createInterface({input:helper.stdout});
    const replies = new Map();
    let ready;
    lines.on("line", line => {
        const result = JSON.parse(line);
        if (result.ready) {ready = result; return;}
        const request = replies.get(result.id);
        if (!request) return;
        replies.delete(result.id); clearTimeout(request.timer);
        result.error ? request.reject(new Error(result.error)) : request.resolve(result.result);
    });
    fixture = await until(() => {if (helper.exitCode !== null) throw new Error(helperError); return ready;}, Boolean, "owned Win32 fixture");
    let commandId = 0;
    native = (command, args={}) => new Promise((resolve,reject) => {
        const id = ++commandId;
        const timer = setTimeout(() => {replies.delete(id); reject(new Error(`Fixture timeout: ${command}`));},10000);
        replies.set(id,{resolve,reject,timer}); helper.stdin.write(JSON.stringify({id,command,...args})+"\n");
    });
    const press = f => native("press",{key:0x70 + f - 1});
    const paused = wanted => until(() => invoke("get_status"), s => s.enabled !== wanted, wanted ? "paused" : "active");
    await press(18); await paused(false);
    await press(18); await paused(true);
    checks.push("Win32 keyboard input resumes and pauses while retaining the pause registration");

    await native("reserve",{key:0x87}); // F24, reserved by this fixture only.
    const pauseField = '.binding:nth-child(6) [data-field="shortcut"]';
    await input(pauseField,"Ctrl+Alt+Shift+F24"); await click("#save");
    await wait("document.querySelector('#message').textContent.includes('Cannot register the pause shortcut')", "pause conflict error");
    assert.equal((await invoke("get_config")).bindings[5].shortcut,"Ctrl+Alt+Shift+F18");
    await press(18); await paused(false);
    await wait("document.querySelector('#message').textContent.includes('unsaved edits')", "saved-settings banner");
    await press(18); await paused(true);
    await input(pauseField,"Ctrl+Alt+Shift+F18"); await click("#save");
    await wait("!document.querySelector('#add').disabled && document.querySelector('#message').textContent.startsWith('Saved.')", "restored pause key");
    checks.push("failed pause-key reassignment preserves the settings file and previous working key");

    const actionField = '.binding:nth-child(3) [data-field="shortcut"]';
    await input(actionField,"Ctrl+Alt+Shift+F24"); await click("#save");
    await wait("!document.querySelector('#add').disabled && document.querySelector('#message').textContent.startsWith('Saved.')", "conflicting action draft saved");
    await click("#toggle");
    await wait("document.querySelector('#message').textContent.includes('Cannot register')", "action registration failure");
    assert.equal((await invoke("get_status")).enabled,false);
    for (const key of [0x7c,0x7d]) {await native("reserve",{key});await native("release",{key});}
    await assert.rejects(() => native("reserve",{key:0x81})); // Pause F18 still belongs to app.
    await input(actionField,"Ctrl+Alt+Shift+F15"); await click("#save");
    await wait("!document.querySelector('#add').disabled && document.querySelector('#message').textContent.startsWith('Saved.')", "action recovery saved");
    await native("release",{key:0x87});
    checks.push("partial registration failure releases earlier action keys without dropping pause");

    await press(18); await paused(false);
    await press(19);
    await wait("document.querySelectorAll('.binding').length === 10 && document.querySelector('#status').textContent.includes('Paused')", "active-app editor");
    assert.equal((await evaluate("document.querySelector('.binding:last-child [data-field=appMatch]').value")).toLowerCase(),path.basename(fixture.executable).toLowerCase());
    await click(".binding:last-child .record");
    await native("press",{key:0x86,window:await native("app_window")}); // F23 delivered to the editor.
    await wait("document.querySelector('.binding:last-child [data-field=shortcut]').value === 'Ctrl+Alt+Shift+F23'", "native shortcut recorder");
    await click("#save");
    await wait("!document.querySelector('#add').disabled && document.querySelector('#message').textContent.startsWith('Saved.')", "current app binding saved");
    checks.push("editor shortcut captures the owned foreground app, pauses, and saves its binding");
    checks.push("shortcut recorder accepts Windows keyboard events and persists the physical key name");
    await input('.binding:last-child [data-field="shortcut"]',"shift+control+alt+F14");
    await click(".binding:last-child .reassign");
    await wait("!document.querySelector('.binding:last-child .reassignment').hidden && !document.querySelector('.binding:last-child .confirm-reassignment').disabled", "native conflict review");
    assert.ok((await evaluate("document.querySelector('.binding:last-child .reassignment-summary').textContent")).includes("push-right"));
    await click(".binding:last-child .confirm-reassignment");
    assert.equal((await invoke("get_config")).bindings[1].enabled,true);
    await click("#save");
    await wait("!document.querySelector('#add').disabled && document.querySelector('#message').textContent.startsWith('Saved.')", "conflict reassignment saved");
    const reassigned = await invoke("get_config");
    assert.equal(reassigned.bindings[1].enabled,false);
    assert.equal(reassigned.bindings[9].shortcut,"Ctrl+Alt+Shift+F14");
    await screenshot("current-app.png");
    checks.push("native conflict review reassigns aliases while preserving the disabled binding");

    // App matching is executable-wide. Refuse this section if any matching
    // window belongs to another process, rather than risking another Python UI.
    const matching = (await invoke("get_windows")).filter(w => w.appId.toLowerCase() === path.basename(fixture.executable).toLowerCase());
    assert.ok(matching.length === 2 && matching.every(w => w.pid === fixture.pid), "Hold fixture requires exclusively owned matching windows");
    const ownedWindow = matching.find(w => w.id === String(fixture.windows[0]));
    const area = ownedWindow.workArea;
    const initial = {x:area.x+100,y:area.y+100,width:500,height:320};
    const readOwned = async () => (await invoke("get_windows")).find(w=>w.id===ownedWindow.id);
    const placeOwned = () => native("place",{window:fixture.windows[0],rect:initial});
    await input("#main-monitor",String(ownedWindow.monitor));
    await input("#hold-delay","700");
    await input('.binding:last-child [data-field="mainMonitorAction"]',"focus-last");
    await click("#save");
    await wait("!document.querySelector('#add').disabled && document.querySelector('#message').textContent.startsWith('Saved.')", "hold settings saved");
    assert.equal((await invoke("get_config")).settings.holdDelayMs,700);
    await evaluate("(() => {document.querySelector('#hold-delay').closest('details').open=true;document.querySelector('#hold-enabled').scrollIntoView({block:'center'});})()");
    await screenshot("hold-settings.png");
    await press(18); await paused(false);
    await placeOwned();
    const appWindow = await native("app_window");
    await native("hold_start",{key:0x7d,window:appWindow}); // F14 app pull.
    await sleep(80);
    assert.equal((await readOwned()).active,false,"tap must wait for release");
    await native("key_up",{keys:[0x11]}); // Ctrl released before F14.
    await until(readOwned,w=>w.active,"modifier-first release pulls the owned app");
    assert.deepEqual((await readOwned()).rect,initial);
    await native("key_up");
    checks.push("app-pull tap waits for release and accepts modifier-first release without tiling");

    await placeOwned();
    await native("pointer",{x:area.x+20,y:area.y+20});
    await native("hold_start",{key:0x7d});
    await sleep(80);
    await native("pointer",{x:area.x+area.width-20,y:area.y+area.height-20});
    await native("repeat",{key:0x7d});
    const tile = area.height > area.width
        ? {...area,height:Math.floor(area.height/2)} : {...area,width:Math.floor(area.width/2)};
    await until(readOwned,w=>Object.entries(tile).every(([key,value])=>w.rect[key]===value),"hold tiles using the key-down pointer position");
    await placeOwned(); // Moving it while held must not trigger another tile.
    await native("repeat",{key:0x7d});
    await sleep(800);
    assert.deepEqual((await readOwned()).rect,initial);
    await native("key_up"); await sleep(100);
    assert.deepEqual((await readOwned()).rect,initial);
    assert.equal((await readOwned()).active,true,"hold release must not also tap focus-last");
    checks.push("hold tiles once from the initial pointer position; repeats and release do not retrigger");

    await native("hold_start",{key:0x7d});
    await sleep(80);
    await native("held_tap",{key:0x81}); await paused(true);
    await native("held_tap",{key:0x81}); await paused(false);
    await sleep(850);
    assert.deepEqual((await readOwned()).rect,initial);
    await native("key_up"); await sleep(100);
    assert.deepEqual((await readOwned()).rect,initial);
    assert.equal((await readOwned()).active,true);
    checks.push("pause cancels a pending hold even when shortcuts resume before key release");

    await press(18); await paused(true);
    await evaluate("(() => {const field=document.querySelector('#hold-enabled');field.checked=false;field.dispatchEvent(new Event('change'));})()");
    await click("#save");
    await wait("!document.querySelector('#add').disabled && document.querySelector('#message').textContent.startsWith('Saved.')", "disabled hold saved");
    assert.equal((await invoke("get_config")).settings.holdTileEnabled,false);
    await press(18); await paused(false);
    await placeOwned();
    await native("hold_start",{key:0x7d,window:appWindow});
    await sleep(850);
    assert.deepEqual((await readOwned()).rect,initial);
    assert.equal((await readOwned()).active,false);
    await native("key_up");
    await until(readOwned,w=>w.active,"disabled hold still taps on release");
    checks.push("saved disable-hold setting preserves tap-on-release after a long press");
    await press(18); await paused(true);

    await press(18); await paused(false);
    await press(20);
    await wait("!document.querySelector('#workspaces-page').hidden && !document.querySelector('#capture-workspace').disabled", "workspace browser hotkey");
    await click("#capture-workspace");
    await wait("!document.querySelector('#workspace-editor').hidden", "workspace capture",60000);
    const selected = await evaluate(`(() => {let count=0;document.querySelectorAll('.workspace-item').forEach(card=>{const keep=card.querySelector('.window-title').textContent.startsWith(${JSON.stringify(marker)});const input=card.querySelector('.include-window');input.checked=keep;input.dispatchEvent(new Event('change'));if(keep)count++;});return count;})()`);
    assert.equal(selected,2);
    await input("#workspace-name","Owned Windows workspace"); await click("#save-workspace");
    await wait("document.querySelector('#message').textContent === 'Workspace saved.'", "owned workspace saved");
    let store = await invoke("get_workspaces");
    assert.equal(store.profiles.length,1);
    assert.equal(store.profiles[0].items.length,2);
    assert.ok(store.profiles[0].items.every(i => i.window.pid === fixture.pid));
    checks.push("native workspace capture review saves only selected owned windows");

    await press(21);
    await wait("!document.querySelector('#workspace-editor').hidden", "workspace update hotkey",60000);
    assert.equal(await evaluate("document.querySelector('#workspace-target').value"),store.profiles[0].id);
    assert.deepEqual(await invoke("get_workspaces"),store);
    await click("#discard-workspace");
    checks.push("workspace update hotkey opens closest-match review without auto-saving");
    for (const [index,item] of store.profiles[0].items.entries()) {
        item.window.rect = {x:item.window.workArea.x+90+index*120,y:item.window.workArea.y+90+index*80,width:560,height:380};
        item.window.maximizedHorizontal = item.window.maximizedVertical = item.window.fullscreen = item.window.minimized = false;
    }
    await invoke("save_workspaces",{store});
    await click('[data-action="restore"]');
    await wait("document.querySelector('#message').textContent === 'Restored 2 of 2 windows.'", "workspace reuse");
    const existing = (await invoke("get_windows")).filter(w => w.pid === fixture.pid);
    for (const item of store.profiles[0].items) assert.deepEqual(existing.find(w=>w.id===item.window.id).rect,item.window.rect);
    checks.push("workspace restore reuses both owned windows with independent native placements");

    const launch = structuredClone(store.profiles[0]);
    launch.id = "launch-fixture"; launch.name = "Owned launch fixture"; launch.items = [launch.items[0]];
    launch.items[0].label = marker+"-launch-0"; launch.items[0].window.title = marker+"-launch-0";
    launch.items[0].launch = {program:fixture.executable,args:[path.join(desktop,"tests/windows/fixture.py"),"--marker",marker+"-launch","--standalone"],workingDirectory:"",newWindow:true};
    store.profiles.push(launch);
    await invoke("save_workspaces",{store});
    await cdp("Page.reload");
    await wait("document.querySelectorAll('.binding').length === 10", "reloaded settings");
    await click("#show-workspaces");
    await wait("document.querySelectorAll('#workspace-list article').length === 2", "reloaded workspaces");
    await click('#workspace-list article:last-child [data-action="restore"]');
    await wait("document.querySelector('#message').textContent === 'Restored 1 of 1 windows.'", "new-window workspace launch",30000);
    const launched = (await invoke("get_windows")).filter(w=>w.title===marker+"-launch-0");
    assert.equal(launched.length,1); assert.notEqual(launched[0].pid,fixture.pid);
    assert.deepEqual(launched[0].rect,launch.items[0].window.rect);
    await screenshot("workspaces.png");
    checks.push("workspace launch opens a distinct owned process and restores its placement");

    const priorStartup = await native("startup_value");
    if (priorStartup === null) {
        await wait("!document.querySelector('#startup').disabled", "startup control ready");
        startupTouched = true;
        await evaluate("(() => {document.querySelector('#show-shortcuts').click();const field=document.querySelector('#startup');field.checked=true;field.dispatchEvent(new Event('change'));})()");
        await until(() => native("startup_value"),value => value === `"${binary}" --startup`,"startup registration");
        await wait("!document.querySelector('#startup').disabled", "startup toggle completed");
        await evaluate("(() => {const field=document.querySelector('#startup');field.checked=false;field.dispatchEvent(new Event('change'));})()");
        await until(() => native("startup_value"),value => value === null,"startup registration removal");
        startupTouched = false;
        checks.push("Windows startup toggle creates and removes its owned Run entry");
    } else skipped.push("Startup toggle: an existing WindowWarp Run entry was preserved");
    second = spawn(binary,[],{cwd:output,windowsHide:true,stdio:"ignore"});
    assert.equal(await exit(second,15000),0);
    assert.equal(app.exitCode,null);
    checks.push("second instance exits and preserves the existing app and settings");
    report.passed = true;
} catch (error) {
    report.error = String(error.stack || error);
} finally {
    if (startupTouched && native && helper?.exitCode === null) {
        const actual = await native("startup_value").catch(()=>null);
        if (actual === `"${binary}" --startup`) {
            // Delete only the fixture value we just verified; no existing user entry is replaced.
            const result = spawnSync("reg.exe",["delete",String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,"/v","WindowWarp","/f"],{windowsHide:true,encoding:"utf8"});
            if (result.status !== 0) {report.passed=false;report.cleanupError="Could not remove the owned startup fixture entry";}
        }
    }
    if (socket) socket.close();
    if (second?.exitCode === null) {spawnSync("taskkill.exe",["/PID",String(second.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});await exit(second,10000).catch(()=>{});}
    if (app?.exitCode === null) {spawnSync("taskkill.exe",["/PID",String(app.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});await exit(app,10000).catch(()=>{});}
    if (helper?.exitCode === null) {
        if (native) {
            try {await native("reserve",{key:0x81});await native("release",{key:0x81});checks.push("process exit releases the native pause key");}
            catch {report.passed=false;report.cleanupError="Pause key remained registered after fixture process exit";}
        }
        helper.stdin.end(); await exit(helper,3000).catch(()=>helper.kill());
    }
    fs.closeSync(appLog);
    // The fixture copied its executable already; restore the ordinary debug build.
    const normalLog = fs.openSync(path.join(output,"restore-build.log"),"w");
    const normalEnv = {...process.env,CARGO_INCREMENTAL:"0",CARGO_BUILD_JOBS:"2"};
    delete normalEnv.TAURI_CONFIG;
    const normal = spawn(cargo,["build","--manifest-path","src-tauri/Cargo.toml","--offline","--features","tauri/custom-protocol"],{
        cwd:desktop,env:normalEnv,windowsHide:true,stdio:["ignore",normalLog,normalLog]
    });
    try {
        if (await exit(normal,600000) !== 0) {report.passed=false;report.cleanupError="Normal debug build failed; inspect restore-build.log";}
    } catch (error) {report.passed=false;report.cleanupError=String(error);}
    finally {fs.closeSync(normalLog);}

    fs.writeFileSync(path.join(output,"result.json"),JSON.stringify(report,null,2));
    console.log(JSON.stringify({...report,output},null,2));
}
if (!report.passed) process.exitCode = 1;
