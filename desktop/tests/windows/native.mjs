// Opt-in Windows app fixture. All app/browser data stays in target/windows-validation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {spawn, spawnSync} from "node:child_process";
import {createInterface} from "node:readline";
import {createServer} from "node:net";
import {randomUUID} from "node:crypto";
import {testFirefox} from "./firefox.mjs";
import {testChromium} from "./chromium.mjs";
import {testFirefoxExtension} from "./firefox-extension.mjs";

if (process.platform !== "win32") throw new Error("This fixture requires Windows");
const firefoxProfileLock = process.argv.includes("--firefox-profile-lock");
const positionOnly = process.argv.includes("--position-only");
const workspaceSlow = process.argv.includes("--workspace-slow");
const workspaceOnly = process.argv.includes("--workspace-only") || workspaceSlow;
const desktopOnly = process.argv.includes("--desktop-only");
const reuseOnly = process.argv.includes("--reuse-only");
const chromiumOnly = process.argv.includes("--chromium-only");
const chooserOnly = process.argv.includes("--chooser-only");
const uxOnly = process.argv.includes("--ux-only");
const firefoxExtensionOnly = process.argv.includes("--firefox-extension-only");
const fastOnly = process.argv.includes("--fast-only");
const holdLetterOnly = process.argv.includes("--hold-letter-only");
const holdEditorOnly = process.argv.includes("--hold-editor-only");
const computerTapOnly = process.argv.includes("--computer-tap-only");
const hookOnly = process.argv.includes("--hook-only");
const quickOnly = process.argv.includes("--quick-only") || hookOnly || fastOnly || positionOnly || workspaceOnly || desktopOnly || reuseOnly || chromiumOnly || chooserOnly || uxOnly || firefoxExtensionOnly || holdLetterOnly || holdEditorOnly || computerTapOnly;
const firefoxOnly = process.argv.includes("--firefox-only") || firefoxProfileLock;
const runFirefox = firefoxOnly || process.argv.includes("--firefox");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const buildTarget = process.env.WARP_TEST_CARGO_TARGET_DIR || path.join(desktop, "src-tauri/target");
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
    }, ...JSON.parse(fs.readFileSync(path.join(desktop,"src-tauri/tauri.conf.json"),"utf8")).app.windows.filter(w=>["radial","quick"].includes(w.label)).map(w=>({...w,additionalBrowserArgs:`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`}))]}
};
fs.writeFileSync(path.join(output, "build-config.json"), JSON.stringify(override, null, 2));
const actions = ["push-left", "push-right", "pull", "tile-left", "tile-right", "toggle-pause", "open-editor", "open-workspaces", "update-workspace"];
const config = {version:1, settings:{mainMonitor:0,burnerMonitor:2,enableOnLaunch:false,quickModifier:"Alt"}, bindings:actions.map((action,index) => ({
    label:action, shortcut:`Ctrl+Alt+Shift+F${13+index}`, action, enabled:true, appMatch:"", mainMonitorAction:"burner", burnerLayout:"float"
}))};
if (quickOnly) config.bindings[0].shortcut = "Alt+C";
if (hookOnly) config.bindings.find(binding => binding.action === "open-editor").shortcut = "Super+B";
if (workspaceOnly) {
    const capture = config.bindings.find(binding => binding.action === "update-workspace");
    capture.shortcut = "Super+Y";
    if (workspaceSlow) config.bindings.push({...capture,label:"Capture fixture alias",shortcut:"Ctrl+Alt+Shift+F21"});
}
fs.writeFileSync(path.join(state, "settings.json"), JSON.stringify(config, null, 2));
if (chooserOnly) {
    const rect={x:0,y:0,width:800,height:600};
    const item={label:"Owned browser",window:{id:"owned-browser",pid:0,title:"Owned browser",appId:"chrome.exe",desktopId:"",path:"chrome.exe",rect,workArea:rect,monitor:1,monitorName:"",maximizedHorizontal:false,maximizedVertical:false,fullscreen:false,minimized:false,active:false},launch:{program:"chrome.exe"},browser:{kind:"chromium",profilePath:"",profileName:"",tabs:[{url:"https://example.com/",title:"Example"}],activeTab:1}};
    const source={id:"saved-browser",name:"Owned saved browser",platform:"windows",items:[item]};
    const targetItem={...item,browser:{...item.browser,tabs:[{url:"https://example.org/",title:"Target"}]}};
    const secondItem={...item,label:"Second browser",window:{...item.window,id:"other-browser",appId:"firefox.exe"},browser:{...item.browser,kind:"firefox",tabs:[{url:"https://example.net/",title:"Second target"}]}};
    const target={id:"workspace",name:"Owned workspace",platform:"windows",items:[targetItem,secondItem]};
    fs.writeFileSync(path.join(state,"saved-browsers.json"),JSON.stringify({version:1,profiles:[source]}));
    fs.writeFileSync(path.join(state,"workspaces.json"),JSON.stringify({version:1,profiles:[target]}));
}
const buildLog = fs.openSync(path.join(output, "build.log"), "w");
const cargo = path.join(process.env.USERPROFILE, ".cargo/bin/cargo.exe");
console.log("Building isolated native fixture:", output);
const build = spawn(cargo, ["rustc", "--manifest-path", "src-tauri/Cargo.toml", "--offline", "--features", "tauri/custom-protocol", "--", "-C", "debuginfo=0"], {
    cwd:desktop, env:{...process.env, CARGO_TARGET_DIR:buildTarget, CARGO_INCREMENTAL:"0", CARGO_BUILD_JOBS:"1", TAURI_CONFIG:JSON.stringify(override)},
    windowsHide:true, stdio:["ignore",buildLog,buildLog]
});
const built = await exit(build, 600000);
fs.closeSync(buildLog);
if (built !== 0) throw new Error("Native fixture build failed: " + fs.readFileSync(path.join(output,"build.log"),"utf8").slice(-6000));
const binary = path.join(output, "window-warp-fixture.exe");
fs.copyFileSync(path.join(buildTarget,"debug/window-warp.exe"), binary);
if (process.env.WARP_TEST_WAIT_FOR_START === "1") {
    const signal = path.join(output, "start-test");
    console.log("Fixture built; waiting for start-test signal in", output);
    await until(() => fs.existsSync(signal), Boolean, "test start signal", 180000);
}


let app, helper, peerHelper, socket, second, slowBrowser, startupTouched = false, calculatorPrepared = false;
const checks = [];
const skipped = [];
let fixture, native;
let report = {passed:false, checks, skipped};
const appLog = fs.openSync(path.join(output,"app.log"), "w");
try {
    const appEnvironment = {...process.env,
        ...((firefoxProfileLock || firefoxExtensionOnly) ? {APPDATA:path.join(output,"firefox-discovery")} : {}),
        ...(chromiumOnly ? {LOCALAPPDATA:path.join(output,"chromium-discovery")} : {})};
    app = spawn(binary, [], {cwd:output, env:appEnvironment, windowsHide:true, stdio:["ignore",appLog,appLog]});
    const target = await until(async () => {
        try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page" && /^https?:\/\/tauri\.localhost\/(?:index.html)?$/.test(t.url)); }
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
    await wait(`document.querySelectorAll('.binding').length === ${config.bindings.length} && !document.querySelector('#toggle').disabled`, "editor initialization");
    const status = await invoke("get_status");
    assert.equal(path.resolve(status.settingsPath).toLowerCase(), path.join(state,"settings.json").toLowerCase());
    assert.equal(status.enabled, false);
    assert.equal(status.shortcutError, null);
    checks.push("native WebView renders using isolated settings and browser state");

    helper = spawn("python", [path.join(desktop,"tests/windows/fixture.py"), "--marker", marker, "--app-pid", String(app.pid),
        "--lifetime",runFirefox ? "1200" : "180", "--windows",fastOnly ? "3" : "2"], {windowsHide:true, stdio:["pipe","pipe","pipe"]});
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
        const timer = setTimeout(() => {replies.delete(id); reject(new Error(`Fixture timeout: ${command}`));},command.startsWith("firefox_") ? 30000 : 10000);
        replies.set(id,{resolve,reject,timer}); helper.stdin.write(JSON.stringify({id,command,...args})+"\n");
    });
    if (positionOnly) {
        const area = (await invoke("get_import_monitors"))[0];
        assert.ok(area, "Position preview requires a monitor");
        const initial = {x:area.x+80,y:area.y+80,width:700,height:500};
        await evaluate(`window.__positionDone=false; window.__TAURI__.core.invoke('choose_position',{rect:${JSON.stringify(initial)}}).then(v=>{window.__positionResult=v;window.__positionDone=true},e=>{window.__positionError=String(e);window.__positionDone=true}); true`);
        {
            const preview = await until(async()=>{
                if (await evaluate('window.__positionDone')) throw new Error(await evaluate('window.__positionError || "Position preview closed early"'));
                return native('position_preview').catch(()=>null);
            }, Boolean, 'owned position preview');
            const requested = {...initial,x:initial.x+40,y:initial.y+30,width:650,height:450};
            const actual = await native('place_position_preview',{rect:requested});
            assert.deepEqual(actual.rect, requested);
            const target = await until(async () => {
                const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
                return pages.find(t => t.type === 'page' && /\/position\.html$/.test(t.url));
            }, Boolean, 'position preview WebView');
            const previewSocket = new WebSocket(target.webSocketDebuggerUrl);
            await new Promise((resolve,reject)=>{previewSocket.addEventListener('open',resolve,{once:true});previewSocket.addEventListener('error',reject,{once:true});});
            try {
                const captured = new Promise((resolve,reject) => {
                    const timer = setTimeout(()=>reject(new Error('Preview screenshot timed out')),10000);
                    previewSocket.addEventListener('message',event=>{clearTimeout(timer);resolve(JSON.parse(event.data));},{once:true});
                });
                previewSocket.send(JSON.stringify({id:1,method:'Page.captureScreenshot'}));
                const screenshot = await captured;
                assert.ok(screenshot.result?.data, 'Preview screenshot must be available');
                fs.writeFileSync(path.join(output,'position-preview.png'), Buffer.from(screenshot.result.data,'base64'));
            } finally { previewSocket.close(); }
            await native('position_key',{window:preview.handle,key:13});
            await wait('window.__positionDone', 'position apply');
            assert.equal(await evaluate('window.__positionError || null'), null);
            assert.deepEqual((await evaluate('window.__positionResult')).rect, actual.rect);
            checks.push('native position preview moves and resizes on screen and Enter applies its rectangle');
            await evaluate(`window.__positionDone=false;window.__TAURI__.core.invoke('choose_position',{rect:${JSON.stringify(initial)}}).then(v=>{window.__positionResult=v;window.__positionDone=true});true`);
            const reopened = await until(()=>native('position_preview').catch(()=>null), Boolean, 'reopened position preview');
            await native('position_key',{window:reopened.handle,key:27});
            await wait('window.__positionDone', 'position cancel');
            assert.equal(await evaluate('window.__positionResult'), null);
            checks.push('native position preview Escape returns no placement');
        }
    }
    const press = f => native("press",{key:0x70 + f - 1});
    const paused = wanted => until(() => invoke("get_status"), s => s.enabled !== wanted, wanted ? "paused" : "active");
    if (computerTapOnly) {
        await native("focus",{window:fixture.windows[0]});
        const owned = await until(async()=>(await invoke("get_windows")).find(window=>window.id===String(fixture.windows[0]) && window.pid===fixture.pid),Boolean,"owned tap target",30000);
        const testConfig=await invoke("get_config");
        testConfig.settings.holdDelayMs=2000;
        testConfig.bindings.push({label:"Owned computer-use tap",shortcut:"Ctrl+Alt+Shift+X",action:"pull-app",enabled:true,
            appMatch:path.basename(fixture.executable),windowsMatch:{windowId:String(fixture.windows[0]),processId:fixture.pid},
            mainMonitorAction:"focus-last",burnerLayout:"float"});
        await invoke("save_config",{config:testConfig});
        await invoke("set_enabled",{enabled:true});
        const area=owned.workArea, rect={x:area.x+100,y:area.y+100,width:500,height:320};
        await native("place",{window:fixture.windows[0],rect});
        const editor=await native("app_window");
        await native("focus",{window:editor});
        console.log("COMPUTER_READY", JSON.stringify({marker,editor}));
        const tapped=await until(async()=>(await invoke("get_windows")).find(window=>window.id===String(fixture.windows[0]) && window.pid===fixture.pid),window=>window?.active,"computer-use shortcut focuses owned target",90000);
        assert.deepEqual(tapped.rect,rect,"The computer-use shortcut should tap without tiling");
        checks.push("Windows computer-use chord focuses the owned application from the editor without tiling");
    }
    if (holdLetterOnly || holdEditorOnly) {
        await native("focus",{window:fixture.windows[0]});
        const owned = await until(async()=>(await invoke("get_windows")).find(window=>window.id===String(fixture.windows[0]) && window.pid===fixture.pid),Boolean,"owned hold target",30000);
        const testConfig = await invoke("get_config");
        testConfig.settings.holdDelayMs = 2000;
        testConfig.settings.holdTileEnabled = true;
        testConfig.bindings.push({label:"Owned hold target",shortcut:"Ctrl+Alt+Shift+X",action:"pull-app",enabled:true,
            appMatch:path.basename(fixture.executable),windowsMatch:{windowId:String(fixture.windows[0]),processId:fixture.pid},
            mainMonitorAction:"focus-last",burnerLayout:"float"});
        await invoke("save_config",{config:testConfig});
        await invoke("set_enabled",{enabled:true});
        const area=owned.workArea, rect={x:area.x+100,y:area.y+100,width:500,height:320};
        await native("place",{window:fixture.windows[0],rect});
        const startWindow=holdEditorOnly ? await native("app_window") : fixture.windows[1];
        await native("hold_start",{key:88,window:startWindow,gap_ms:30});
        try {
            await sleep(80);
            const read=async()=>(await invoke("get_windows")).find(window=>window.id===String(fixture.windows[0]) && window.pid===fixture.pid);
            assert.equal((await read()).active,false,"Held app shortcut must not tap early");
            await native("key_up",{keys:[0x11]});
            const tapped=await until(read,window=>window?.active,"non-Super app shortcut taps on modifier release",700);
            assert.deepEqual(tapped.rect,rect,"Modifier release must tap without tiling");
            checks.push("native Ctrl+Alt+Shift+X app shortcut waits for modifier release and taps without tiling");
        } finally { await native("key_up").catch(()=>{}); }
        await native("place",{window:fixture.windows[0],rect});
        await native("hold_start",{key:88,window:startWindow,gap_ms:30});
        try {
            const read=async()=>(await invoke("get_windows")).find(window=>window.id===String(fixture.windows[0]) && window.pid===fixture.pid);
            await sleep(80);
            assert.equal((await read()).active,false,"Shortcut must not tap before the main key is released");
            await native("key_up",{keys:[88]});
            const tapped=await until(read,window=>window?.active,"non-Super app shortcut taps on main key release",700);
            assert.deepEqual(tapped.rect,rect,"Main key release must tap without tiling");
            checks.push("native app shortcut taps on main key release while modifiers remain held");
        } finally { await native("key_up").catch(()=>{}); }
        await native("place",{window:fixture.windows[0],rect});
        await native("hold_start",{key:88,window:startWindow,gap_ms:30});
        try {
            const read=async()=>(await invoke("get_windows")).find(window=>window.id===String(fixture.windows[0]) && window.pid===fixture.pid);
            await sleep(150);
            assert.equal((await read()).active,false,"Hold must wait for its configured delay");
            await until(read,window=>window && JSON.stringify(window.rect)!==JSON.stringify(rect),"non-Super hold tiles after its delay",5000);
            checks.push("native app shortcut hold tiles after its configured delay");
        } finally { await native("key_up").catch(()=>{}); }
        await native("place",{window:fixture.windows[0],rect});
        await native("hold_start",{key:88,window:startWindow,gap_ms:30});
        try {
            await sleep(100);
            await invoke("set_enabled",{enabled:false});
            await invoke("set_enabled",{enabled:true});
            await sleep(2200);
            const after=(await invoke("get_windows")).find(window=>window.id===String(fixture.windows[0]) && window.pid===fixture.pid);
            assert.deepEqual(after.rect,rect,"Pause must cancel the hold even if shortcuts resume while keys remain down");
            assert.equal(after.active,false,"A cancelled hold must not issue a tap");
            checks.push("pause and resume cancel a pending non-Super hold");
        } finally { await native("key_up").catch(()=>{}); }
    }
    if (reuseOnly) {
        const owned = await until(async () => (await invoke('get_windows')).filter(w=>w.pid===fixture.pid && !w.minimized), windows=>windows.length>0, 'owned workspace windows',60000);
        const capture = await invoke('capture_workspace',{name:'Owned reuse fixture'});
        capture.profile.items = capture.profile.items.filter(item=>item.window.pid===fixture.pid);
        assert.equal(capture.profile.items.length,owned.length);
        await invoke('save_workspaces',{store:{version:1,profiles:[capture.profile]}});
        const restored = await invoke('restore_workspace',{id:capture.profile.id});
        assert.equal(restored.length,owned.length);
        assert.ok(restored.every(result=>result.restored && !result.launched),JSON.stringify(restored));
        const after = (await invoke('get_windows')).filter(window=>window.pid===fixture.pid && !window.minimized);
        assert.deepEqual(after.map(window=>window.id).sort(),owned.map(window=>window.id).sort());
        checks.push('native workspace captures and opens existing owned windows without launching duplicates');
    }
    if (desktopOnly) {
        const [ownedWindow, anchor] = fixture.windows;
        await native('focus',{window:ownedWindow});
        await until(async () => (await invoke('get_windows')).some(window=>window.id===String(ownedWindow) && window.pid===fixture.pid), Boolean, 'owned window is ready for capture',30000);
        const capture = await invoke('capture_workspace',{name:'Owned desktop fixture'});
        capture.profile.items = capture.profile.items.filter(item=>item.window.id===String(ownedWindow) && item.window.pid===fixture.pid);
        assert.equal(capture.profile.items.length,1);
        await invoke('save_workspaces',{store:{version:1,profiles:[capture.profile]}});
        assert.ok((await invoke('restore_workspace',{id:capture.profile.id}))[0].restored);
        await click('#show-workspaces');
        await wait("document.querySelectorAll('.workspace-card').length===1",'fixture workspace card');
        const appWindow = await native('app_window');
        await native('focus',{window:anchor});
        const switched = await native('switch_fixture_desktop',{window:anchor});
        if (!switched) {
            skipped.push('Moving a workspace requires an adjacent virtual desktop');
        } else try {
            second = spawn(binary,[],{cwd:output,windowsHide:true,stdio:'ignore'});
            assert.equal(await exit(second,15000),0);
            await until(()=>native('app_on_current_desktop',{window:appWindow}),Boolean,'a second launch brings Warp to the current desktop',15000);
            await click('[data-action="restore"]');
            await wait("!document.querySelector('.workspace-open-choice').hidden",'existing workspace desktop choice',15000);
            await click('.workspace-open-choice-row button:nth-of-type(2)');
            await until(()=>native('fixture_on_current_desktop',{window:anchor}),Boolean,'Go there returns to the source desktop',15000);
            await native('switch_fixture_desktop',{window:anchor,restore:true});
            await native('focus',{window:anchor});
            assert.equal(await native('switch_fixture_desktop',{window:anchor}),true);
            await invoke('show_editor',{appMatch:null});
            await click('[data-action="restore"]');
            await wait("!document.querySelector('.workspace-open-choice').hidden",'desktop move choice',15000);
            await click('.workspace-open-choice-row button:first-of-type');
            await wait("document.querySelector('.workspace-card-status').textContent.includes('Opened')",'workspace moved and opened',30000);
            assert.equal(await native('fixture_on_current_desktop',{window:ownedWindow}),true);
            assert.equal(await native('fixture_on_current_desktop',{window:anchor}),false);
            const open = (await invoke('get_windows')).filter(window=>window.pid===fixture.pid);
            assert.deepEqual(open.map(window=>window.id),[String(ownedWindow)]);
            checks.push('a second launch brings Warp to the current desktop; Go there and Move here use only the tracked workspace window');
        } finally {
            await native('switch_fixture_desktop',{window:anchor,restore:true});
            await invoke('show_editor',{appMatch:null});
        }
    }
    if (workspaceOnly) {
        if (workspaceSlow) {
            const browser = process.env.WARP_CHROME_BINARY;
            assert.ok(browser && fs.existsSync(browser), 'Set WARP_CHROME_BINARY to Chrome for Testing');
            const profile = path.join(output,'slow-browser-profile'); fs.mkdirSync(profile);
            const local = path.join(output,'slow-browser-local'); fs.mkdirSync(local);
            const page = path.join(output,'slow-browser.html');
            fs.writeFileSync(page,`<!doctype html><title>${marker} slow browser</title><p>Owned test page</p>`);
            slowBrowser = spawn(browser,[`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-extensions','--new-window',pathToFileURL(page).href],{windowsHide:true,env:{...process.env,LOCALAPPDATA:local},stdio:'ignore'});
            await until(async()=>(await invoke('get_windows')).find(window=>window.pid===slowBrowser.pid && window.title.includes(marker)),Boolean,'owned browser window',60000);
            const bridge = await invoke('set_bridge_enabled',{enabled:true});
            const [bridgePort,token] = bridge.pairingCode.split(':');
            const response = await fetch(`http://127.0.0.1:${bridgePort}/bridge`,{method:'POST',headers:{Origin:'chrome-extension://warp-fixture','Content-Type':'text/plain'},body:JSON.stringify({token,action:'poll',browser:'chromium',clientId:'slow-fixture',windows:[]})});
            assert.equal((await response.json()).error,undefined);
        }
        await invoke('set_enabled',{enabled:true});
        const mainWindow = await native('app_window');
        await native('app_close',{window:mainWindow});
        await until(()=>native('app_state',{window:mainWindow}),state=>!state.visible,'hide fixture editor');
        await native('focus',{window:fixture.windows[0]});
        await evaluate("window.__workspaceStarts=[]; window.addEventListener('warp-workspace-request',event=>{if(event.detail.capturing && event.detail.captureId)window.__workspaceStarts.push(event.detail.captureId);})");
        const captureStarted = Date.now();
        await native('plain_press',{key:89,meta:true,window:fixture.windows[0],gap_ms:30});
        await until(()=>native('app_state',{window:mainWindow}),state=>state.visible && state.foreground,'Win+Y shows the workspace editor',10000);
        await wait("!document.querySelector('#workspaces-page').hidden", 'workspace section becomes visible',5000);
        assert.equal(await evaluate("document.querySelector('#workspaces-page').hidden"),false);
        if (workspaceSlow) {
            await wait("!document.querySelector('#workspace-capture-pending').hidden", 'workspace capture starts',3000);
            report.workspaceOpenMs = Date.now()-captureStarted;
            assert.ok(report.workspaceOpenMs < 3000,`The workspace screen took ${report.workspaceOpenMs} ms to appear`);
            await press(21);
            await wait("window.__workspaceStarts.length >= 2", 'another capture shortcut starts while tabs are still loading',4000);
        }
        await wait("!document.querySelector('#workspace-editor').hidden", 'new workspace draft',30000);
        await wait("document.querySelector('#workspace-capture-pending').hidden", 'workspace capture completes',30000);
        assert.equal(await evaluate("document.querySelector('#workspace-hotkey-choice').hidden"),true);
        assert.equal((await invoke('get_workspaces')).profiles.length,0);
        const fixtureItem = `[...document.querySelectorAll('.workspace-item')].find(card=>card.querySelector('.window-title').textContent===${JSON.stringify(marker + '-0')})`;
        assert.equal(await evaluate(`!!${fixtureItem}`),true);
        await evaluate(`(() => {const input=${fixtureItem}.querySelector('.include-window');input.checked=false;input.dispatchEvent(new Event('change'));})()`);
        await native('focus',{window:fixture.windows[0]});
        await native('click_events');
        await click('#add-workspace-window');
        await until(()=>native('picker_click',{window:fixture.windows[0]}).catch(()=>false), Boolean, 'the picker covers the fixture window',10000);
        await wait(`${fixtureItem}.querySelector('.include-window').checked`, 'choosing a window adds it back to the draft',10000);
        assert.deepEqual(await native('click_events'),[], 'the picker must consume the selection click');
        await native('focus',{window:fixture.windows[0]});
        await click('#add-workspace-window');
        await until(()=>native('picker_escape').catch(()=>false),Boolean,'picker receives Escape',10000);
        await wait("!document.querySelector('#add-workspace-window').disabled", 'cancelled picker returns to the editor',10000);
        checks.push('click-to-add consumes the selection click, restores an excluded window, and cancels with Escape');
        const selected = await evaluate(`(() => {let n=0;document.querySelectorAll('.workspace-item').forEach(card=>{const keep=card.querySelector('.window-title').textContent.startsWith(${JSON.stringify(marker + "-")});const input=card.querySelector('.include-window');input.checked=keep;input.dispatchEvent(new Event('change'));if(keep)n++;});return n;})()`);
        assert.ok(selected > 0, 'The draft must contain a fixture-owned window');
        await input('#workspace-name','Owned workspace');
        await click('#save-workspace');
        await wait("[...document.querySelectorAll('.workspace-card-status')].some(status => !status.hidden && status.textContent === 'Saved.')", 'fixture workspace saved');
        const saved = await invoke('get_workspaces');
        assert.equal(saved.profiles.length,1);
        assert.ok(saved.profiles[0].items.every(item=>item.window.pid===fixture.pid));
        await click('#workspace-list [data-action="edit"]');
        await wait("!document.querySelector('#workspace-editor').hidden", 'saved workspace review');
        await sleep(500);
        await screenshot('workspace-review.png');
        await input('#workspace-name','Unfinished draft');
        await click('#capture-workspace');
        await wait("!document.querySelector('#workspace-recapture').hidden", 'manual capture asks before replacing the draft');
        await screenshot('workspace-replace-prompt.png');
        await click('#workspace-keep-draft');
        assert.equal(await evaluate("document.querySelector('#workspace-name').value"),'Unfinished draft');
        await click('#capture-workspace');
        await click('#workspace-recapture-confirm');
        await wait("document.querySelector('#workspace-editor-title').textContent === 'New workspace'", 'manual capture replaces the confirmed draft',30000);
        await wait("!document.querySelector('#save-workspace').disabled", 'manual capture finishes',30000);
        await click('#discard-workspace');
        await wait("document.querySelector('#workspace-editor').hidden", 'manual capture draft closed');
        const restored = await invoke('restore_workspace',{id:saved.profiles[0].id});
        assert.equal(restored.length,saved.profiles[0].items.length);
        assert.ok(restored.every(result=>result.restored && !result.launched), JSON.stringify(restored));
        const stillOpen = (await invoke('get_windows')).filter(window=>window.pid===fixture.pid);
        assert.equal(stillOpen.length,saved.profiles[0].items.length);
        checks.push('native workspace Open reuses its existing fixture windows without launching duplicates');
        await native('focus',{window:fixture.windows[0]});
        if (workspaceSlow) await press(21); else await native('plain_press',{key:89,meta:true,window:fixture.windows[0],gap_ms:30});
        try { await wait("!document.querySelector('#workspace-hotkey-choice').hidden", 'workspace update choices',60000); }
        catch (error) {
            report.workspaceDiagnostics=await evaluate("({starts:window.__workspaceStarts,message:document.querySelector('#workspace-status').textContent,editorHidden:document.querySelector('#workspace-editor').hidden,replaceHidden:document.querySelector('#workspace-recapture').hidden,pendingHidden:document.querySelector('#workspace-capture-pending').hidden})");
            throw error;
        }
        assert.equal(await evaluate("document.querySelector('#workspace-hotkey-target').value"),saved.profiles[0].id);
        await click('#workspace-hotkey-update');
        await wait("!document.querySelector('#workspace-editor').hidden", 'update review draft');
        await wait("!document.querySelector('#save-workspace').disabled", 'update review is ready');
        assert.deepEqual(await invoke('get_workspaces'),saved);
        await click('#save-workspace');
        await wait("!document.querySelector('#workspace-replace-saved').hidden", 'saved workspace replacement confirmation');
        assert.deepEqual(await invoke('get_workspaces'),saved);
        await click('#workspace-replace-cancel');
        if (workspaceSlow) await press(21); else await native('plain_press',{key:89,meta:true,window:fixture.windows[0],gap_ms:30});
        await wait("!document.querySelector('#workspace-recapture').hidden", 'Win+Y asks before replacing the draft',60000);
        await click('#workspace-recapture-confirm');
        await wait("document.querySelector('#workspace-editor-title').textContent === 'New workspace'", 'Win+Y recaptures while the workspace editor is open',60000);
        await click('#discard-workspace');
        await click('#show-settings');
        await click('#browser-extensions-settings > summary');
        await click('#prepare-firefox');
        await wait("document.querySelector('#browser-extension-path').value && document.querySelector('#browser-bridge-code').value", 'Firefox extension prepared',10000);
        assert.equal(await evaluate("document.querySelector('#browser-bridge-enabled')"),null);
        assert.match(await evaluate("document.querySelector('#firefox-instructions').textContent"),/about:debugging#\/runtime\/this-firefox/);
        await click('#browser-extension-instructions summary');
        await evaluate("document.querySelector('#browser-extensions-settings').scrollIntoView({block:'start'})");
        await sleep(300);
        await screenshot('browser-settings.png');
        checks.push('browser setup prepares a pairing code and Firefox folder with direct setup instructions');
        await invoke('set_enabled',{enabled:false});
        checks.push('workspace capture shortcut and manual capture ask before replacing a draft');
    }
    if (fastOnly) {
        peerHelper = spawn("python", [path.join(desktop,"tests/windows/fixture.py"), "--marker", marker+"-peer", "--windows", "1"],
            {windowsHide:true, stdio:["pipe","pipe","pipe"]});
        let peerError = "", peerReady, peerCommandId = 0;
        const peerReplies = new Map();
        peerHelper.stderr.on("data", chunk => {peerError += chunk.toString();});
        createInterface({input:peerHelper.stdout}).on("line", line => {
            const result = JSON.parse(line);
            if (result.ready) { peerReady = result; return; }
            const request = peerReplies.get(result.id);
            if (!request) return;
            peerReplies.delete(result.id); clearTimeout(request.timer);
            result.error ? request.reject(new Error(result.error)) : request.resolve(result.result);
        });
        const peer = await until(()=>{if (peerHelper.exitCode !== null) throw new Error(peerError); return peerReady;},Boolean,"second process owned Win32 fixture");
        const nativePeer = (command,args={}) => new Promise((resolve,reject)=>{
            const id = ++peerCommandId;
            const timer = setTimeout(()=>{peerReplies.delete(id);reject(new Error(`Peer fixture timeout: ${command}`));},10000);
            peerReplies.set(id,{resolve,reject,timer});
            peerHelper.stdin.write(JSON.stringify({id,command,...args})+"\n");
        });
        await native("focus", {window:fixture.windows[0]});
        const owned = await until(async () => (await invoke("get_windows")).find(window => window.id === String(fixture.windows[0]) && window.pid === fixture.pid), Boolean, "owned fast-shortcut target", 5000);
        const fastConfig = await invoke("get_config");
        fastConfig.settings.mainMonitor = owned.monitor;
        fastConfig.settings.holdDelayMs = 400;
        fastConfig.settings.holdTileEnabled = true;
        fastConfig.settings.holdMode = "tile";
        fastConfig.bindings.push({label:"Test fast app shortcut", shortcut:"Super+F22", action:"pull-app", enabled:true,
            appMatch:path.basename(fixture.executable), windowsMatch:{windowId:owned.id, processId:fixture.pid},
            mainMonitorAction:"focus-last", burnerLayout:"float"});
        await invoke("save_config", {config:fastConfig});
        await invoke("set_enabled", {enabled:true});
        await evaluate("(async()=>{window.__fastErrors=[];window.__fastErrorStop=await window.__TAURI__.event.listen('warp-error',e=>window.__fastErrors.push(e.payload));})()");
        const readTarget = async () => (await invoke("get_windows")).find(window=>window.id === owned.id && window.pid === fixture.pid);
        report.fastTaps = [];
        for (let i=0; i<10; i++) {
            await native("focus", {window:fixture.windows[2]});
            await native("plain_press", {key:0x85, meta:true, window:fixture.windows[2]});
            try {
                await until(readTarget,window=>window?.active, `fast Super+F22 tap ${i+1}`,2500);
                report.fastTaps.push(true);
            } catch { report.fastTaps.push(false); }
        }
        await native("focus", {window:fixture.windows[2]});
        await native("activation_events");
        await native("burst", {key:0x85, window:fixture.windows[2]});
        const transitions = [];
        try {
            await until(async()=>{transitions.push(...await native("activation_events"));return transitions;},
                events=>events.includes(fixture.windows[0]) && events.lastIndexOf(fixture.windows[2]) > events.indexOf(fixture.windows[0]),
                "two rapid presses both run in order",4000);
        } catch (error) {
            report.fastErrors = await evaluate("window.__fastErrors");
            report.burstTransitions = transitions;
            throw error;
        }
        checks.push("back-to-back Super+F22 presses focus the target and return to the previous window");
        const initial = {x:owned.workArea.x+100,y:owned.workArea.y+100,width:500,height:320};
        await native("place", {window:fixture.windows[0], rect:initial});
        await native("focus", {window:fixture.windows[2]});
        await native("pointer", {x:owned.workArea.x+20,y:owned.workArea.y+20});
        await native("hold_start", {key:0x85,meta:true,window:fixture.windows[2]});
        try {
            await sleep(80);
            assert.equal((await readTarget()).active,false,"a held shortcut must not tap before release or the hold threshold");
            await until(readTarget,window=>window?.active && JSON.stringify(window.rect)!==JSON.stringify(initial), "held Super+F22 tiles the owned window",3000);
            const tiled = (await readTarget()).rect;
            await native("key_up");
            await sleep(100);
            assert.deepEqual((await readTarget()).rect,tiled,"hold release must not trigger another window action");
        } finally { await native("key_up").catch(()=>{}); }
        checks.push("held Super+F22 tiles once and does not issue a tap on release");
        await native("place", {window:fixture.windows[0], rect:initial});
        await native("focus", {window:fixture.windows[2]});
        await native("hold_start", {key:0x85,meta:true,window:fixture.windows[2]});
        try {
            await sleep(80);
            await native("key_up", {keys:[0x5b]});
            await until(readTarget,window=>window?.active,"modifier-first release triggers the app tap",3000);
            await sleep(500);
            assert.deepEqual((await readTarget()).rect,initial,"releasing the modifier must cancel the pending hold");
        } finally { await native("key_up").catch(()=>{}); }
        checks.push("releasing Win before F22 triggers a tap and cannot turn into a hold");
        await native("minimize", {window:fixture.windows[0]});
        await until(readTarget,window=>window?.minimized,"owned target minimized");
        await native("plain_press", {key:0x85,meta:true,window:fixture.windows[2]});
        await until(readTarget,window=>window?.active && !window.minimized,"fast shortcut restores the minimized target",3000);
        checks.push("fast Super+F22 restores and focuses a minimized owned window");
        await native("place", {window:fixture.windows[0],rect:initial});
        await native("focus", {window:fixture.windows[2]});
        await native("hold_start", {key:0x85,meta:true,window:fixture.windows[2]});
        try {
            await sleep(80);
            await invoke("set_enabled", {enabled:false});
            await native("key_up");
            await invoke("set_enabled", {enabled:true});
            await sleep(500);
            const cancelled = await readTarget();
            assert.equal(cancelled.active,false,"pausing must cancel the pending app shortcut");
            assert.deepEqual(cancelled.rect,initial,"a cancelled hold must not tile after resume");
        } finally { await native("key_up").catch(()=>{}); }
        checks.push("pause and resume cancel a pending Super shortcut without a late tap or hold");
        await native("focus", {window:fixture.windows[1]});
        const other = await until(async()=> (await invoke("get_windows")).find(window=>window.id===String(fixture.windows[1]) && window.pid===fixture.pid), Boolean, "second owned shortcut target", 5000);
        const overlapConfig = await invoke("get_config");
        overlapConfig.settings.holdDelayMs = 900;
        overlapConfig.bindings.push({...structuredClone(overlapConfig.bindings.at(-1)),label:"Test overlapping app shortcut",shortcut:"Super+F23",
            windowsMatch:{windowId:other.id,processId:fixture.pid}});
        await invoke("set_enabled", {enabled:false});
        await invoke("save_config", {config:overlapConfig});
        await invoke("set_enabled", {enabled:true});
        await nativePeer("focus", {window:peer.windows[0]});
        const crossProcessTarget = await until(async()=> (await invoke("get_windows")).find(window=>window.id===String(peer.windows[0]) && window.pid===peer.pid),Boolean,"second process app target",5000);
        const switchConfig = structuredClone(overlapConfig);
        switchConfig.bindings.at(-1).windowsMatch = {windowId:crossProcessTarget.id,processId:peer.pid};
        await invoke("set_enabled", {enabled:false});
        await invoke("save_config", {config:switchConfig});
        await invoke("set_enabled", {enabled:true});
        report.fastSwitches = [];
        const switchFailures = [];
        for (const spacingMs of [80, 0]) for (const releaseWin of [false, true]) {
            if (switchFailures.length) {
                // Cancel any unfinished action from a failed case before
                // collecting the next case; the failure is still reported.
                await invoke("set_enabled", {enabled:false});
                await invoke("set_enabled", {enabled:true});
            }
            await native("focus", {window:fixture.windows[2]});
            await native("activation_events");
            await nativePeer("activation_events");
            const events = [];
            let releases = [];
            const expected = Array.from({length:4},()=>[fixture.windows[0],peer.windows[0]]).flat();
            try {
                releases = await native("switch_burst", {window:fixture.windows[2],peer_window:peer.windows[0],peer_pid:peer.pid,release_win:releaseWin,spacing_ms:spacingMs});
                await until(async()=> {
                    const [local, remote] = await Promise.all([native("timed_activation_events"),nativePeer("timed_activation_events")]);
                    events.push(...local,...remote);
                    return events;
                }, received=>received.length >= expected.length, "eight alternating app switches", 5000);
                await sleep(200);
                const [local, remote] = await Promise.all([native("timed_activation_events"),nativePeer("timed_activation_events")]);
                events.push(...local,...remote);
                events.sort((a,b)=>a[1]-b[1]);
                assert.deepEqual(events.map(([id])=>id), expected, "every distinct app shortcut must focus its target once, in press order");
                const latencyMs = events.map(([,at],index)=>at - releases[index]);
                assert.ok(latencyMs.every(ms=>ms >= 0 && ms <= 500), `every alternating switch must activate within 500 ms of key release: ${latencyMs}`);
            } catch (error) {
                report.fastErrors = await evaluate("window.__fastErrors").catch(()=>["Could not retrieve fast shortcut errors"]);
                switchFailures.push(new Error(`Alternating switches with ${spacingMs} ms spacing and Win ${releaseWin ? "released" : "held"}: ${error}`));
            } finally {
                events.sort((a,b)=>a[1]-b[1]);
                report.fastSwitches.push({spacingMs,releaseWin,source:fixture.windows[2],targetA:fixture.windows[0],targetB:peer.windows[0],
                    observed:events.map(([id])=>id),expected,releases,events,
                    latencyMs:events.map(([,at],index)=>at - releases[index])});
                await native("key_up").catch(()=>{});
            }
        }
        if (switchFailures.length) throw new AggregateError(switchFailures,"Alternating shortcut acceptance failed: " + switchFailures.map(error=>String(error)).join("; "));
        checks.push("eight alternating Super+F22/F23 presses switch between separate fixture processes in order, at 80 ms and zero spacing, with Win held or released between presses");
        await invoke("set_enabled", {enabled:false});
        await invoke("save_config", {config:overlapConfig});
        await invoke("set_enabled", {enabled:true});
        await native("place", {window:fixture.windows[0], rect:initial});
        await native("place", {window:fixture.windows[1], rect:{...initial,x:initial.x+40,y:initial.y+40}});
        await native("focus", {window:fixture.windows[2]});
        await native("pointer", {x:owned.workArea.x+20,y:owned.workArea.y+20});
        await native("hold_start", {key:0x85,meta:true,window:fixture.windows[2]});
        try {
            await sleep(80);
            await native("held_tap", {key:0x86});
            await until(async()=> (await invoke("get_windows")).find(window=>window.id===other.id && window.pid===fixture.pid),
                window=>window?.active,"overlapping Super+F23 tap focuses its own target before F22 hold",700);
            await until(readTarget,window=>window?.active && JSON.stringify(window.rect)!==JSON.stringify(initial),
                "held Super+F22 still tiles after the other shortcut",3000);
        } finally { await native("key_up").catch(()=>{}); }
        checks.push("an overlapping Super app tap does not cancel or wait for an earlier held shortcut");
        const radialConfig = await invoke("get_config");
        radialConfig.settings.holdMode = "radial";
        radialConfig.settings.holdDelayMs = 400;
        const radialBinding = radialConfig.bindings.find(binding=>binding.shortcut === "Super+F22");
        radialBinding.windowsMatch = {processId:fixture.pid,titleContains:marker};
        await invoke("set_enabled", {enabled:false});
        await invoke("save_config", {config:radialConfig});
        await invoke("set_enabled", {enabled:true});
        await native("focus", {window:fixture.windows[2]});
        await native("pointer", {x:owned.workArea.x+Math.floor(owned.workArea.width/2),y:owned.workArea.y+Math.floor(owned.workArea.height/2)});
        await native("hold_start", {key:0x85,meta:true,window:fixture.windows[2]});
        try {
            await until(()=>invoke("radial_view"),view=>view?.labels?.length === 3,"held Super shortcut opens radial",4000);
            await native("key_up");
            await until(()=>invoke("radial_view"),view=>view === null,"Super radial closes on release",4000);
        } finally { await native("key_up").catch(()=>{}); }
        checks.push("held Super app shortcut opens its radial and closes on release");
        report.fastErrors = await evaluate("window.__fastErrors");
        await evaluate("if(window.__fastErrorStop)window.__fastErrorStop()");
        assert.deepEqual(report.fastErrors, [], "fast app shortcuts must not emit native errors");
        assert.deepEqual(report.fastTaps, Array(10).fill(true), "every fast app shortcut must focus its owned target");
        checks.push("ten rapid Super+F22 app taps focus their owned target");
    }
    if (hookOnly) {
        // Install another process's listener before Warp's hook, then after it,
        // to cover both launch orders without observing any physical input.
        const mainWindow = await native("app_window");
        await native("observe_start");
        report.coexistence = [];
        const observeEditor = async (order, registered, directFocus=false) => {
            if (directFocus) await native("focus", {window:mainWindow});
            else await invoke("show_editor", {appMatch:null});
            await until(()=>native("app_state",{window:mainWindow}),s=>s.foreground,"focus fixture editor",4000);
            const initialEvents = (await native("hotkey_events")).length;
            await native("hold_start", {key:0x86, meta:true, window:mainWindow});
            let held, released, hotkey;
            try {
                if (registered) {
                    try { await until(()=>native("hotkey_events"),events=>events.length > initialEvents,"registered unowned hotkey",3000); hotkey=true; } catch { hotkey=false; }
                }
                await sleep(100);
                held = await native("observe_events");
            } finally { await native("key_up"); }
            await sleep(100);
            released = await native("observe_events");
            report.coexistence.push({order,surface:"Warp editor",...(registered ? {hotkey} : {}),held,released});
        };
        await observeEditor("before, Warp disabled and no registered hotkey", false);
        await native("reserve", {key:0x86, meta:true});
        await observeEditor("before, Warp disabled", true);
        await native("release", {key:0x86});
        await invoke("set_enabled", {enabled:true});
        await observeEditor("before, no registered hotkey", false);
        await native("focus", {window:fixture.windows[0]});
        await observeEditor("before, direct editor focus, no registered hotkey", false, true);
        await native("reserve", {key:0x86, meta:true});
        for (const order of ["before", "after"]) {
            if (order === "after") {
                await native("observe_stop");
                await native("observe_start");
            }
            // Repeat the first case, and return to it after another app has
            // focus, so a startup anomaly is distinguishable from focus.
            for (const [surface, window] of [["Warp editor", mainWindow], ["Warp editor", mainWindow], ["another app", fixture.windows[0]], ["Warp editor", mainWindow]]) {
                if (surface === "Warp editor") {
                    await invoke("show_editor", {appMatch:null});
                    await until(()=>native("app_state",{window:mainWindow}),s=>s.foreground,"focus fixture editor",4000);
                }
                const initialEvents = (await native("hotkey_events")).length;
                await native("hold_start", {key:0x86, meta:true, window});
                let held = [], released = [], hotkey = false;
                try {
                    try { await until(()=>native("hotkey_events"),events=>events.length > initialEvents,"unowned Win+F23 delivered while held",3000); hotkey=true; } catch {}
                    await sleep(100);
                    held = await native("observe_events");
                } finally {
                    await native("key_up");
                }
                await sleep(100);
                released = await native("observe_events");
                report.coexistence.push({order, surface, hotkey, held, released});
            }
        }
        await native("release", {key:0x86});
        for (const [surface, window] of [["another app", fixture.windows[0]], ["Warp editor", mainWindow]]) {
            if (surface === "Warp editor") {
                await invoke("show_editor", {appMatch:null});
                await until(()=>native("app_state",{window:mainWindow}),s=>s.foreground,"focus fixture editor without registered hotkey",4000);
            }
            await native("hold_start", {key:0x86, meta:true, window});
            let held, released;
            try { await sleep(100); held = await native("observe_events"); }
            finally { await native("key_up"); }
            await sleep(100);
            released = await native("observe_events");
            report.coexistence.push({order:"after, without registered hotkey", surface, held, released});
        }
        await native("observe_stop");
        const hookErrors = [];
        for (const row of report.coexistence) {
            try {
                if ("hotkey" in row) assert.equal(row.hotkey, true, `hotkey while held: ${row.order}, ${row.surface}`);
                assert.deepEqual(row.held, [[0x5b,false],[0x86,false]], `down events: ${row.order}, ${row.surface}`);
                assert.deepEqual(row.released, [[0x86,true],[0x5b,true]], `up events: ${row.order}, ${row.surface}`);
            } catch (error) { hookErrors.push(error); }
        }
        if (process.env.WARP_TEST_POPUP_OBSERVER === "downstream") {
            await invoke("set_enabled", {enabled:false});
            await native("observe_start");
            await invoke("set_enabled", {enabled:true});
        }
        if (!hookErrors.length) checks.push("unowned Win+F23 reaches another application's listener on down and up in both hook orders with Warp or another app focused");
        await native("app_close",{window:mainWindow});
        await until(()=>native("app_state",{window:mainWindow}),s=>!s.visible,"hide fixture editor");
        await native("plain_press",{key:66,meta:true});
        const quickWindow = await until(()=>native("app_window").catch(()=>null),Boolean,"Win+B opens popup",4000);
        // Let the first key cycle and popup-open dispatch finish before the
        // second distinct press, without holding the modifier between presses.
        await sleep(Number(process.env.WARP_TEST_POPUP_DELAY || 200));
        if (["1", "transient"].includes(process.env.WARP_TEST_POPUP_OBSERVER)) await native("observe_start");
        if (process.env.WARP_TEST_POPUP_OBSERVER === "transient") await native("observe_stop");
        await native("plain_press",{key:66,meta:true,window:quickWindow,gap_ms:Number(process.env.WARP_TEST_INPUT_GAP || 0)});
        try {
            await until(()=>native("app_state",{window:mainWindow}),s=>s.visible && s.foreground,"second Win+B opens the main window",4000);
        } catch (error) {
            report.popupDiagnostics = {quick:await native("fixture_window_state",{window:quickWindow}), observer:process.env.WARP_TEST_POPUP_OBSERVER === "1" ? await native("observe_events") : null};
            hookErrors.push(error);
        } finally {if (["1", "downstream"].includes(process.env.WARP_TEST_POPUP_OBSERVER)) await native("observe_stop");}
        if (hookErrors.length) throw new AggregateError(hookErrors,"Native hook and popup acceptance failed: " + hookErrors.map(error=>String(error)).join("; "));
        checks.push("one further Win+B hides the popup and opens the main editor");
    }
    if (quickOnly && !hookOnly && !fastOnly && !positionOnly && !workspaceOnly && !desktopOnly && !reuseOnly && !holdLetterOnly && !holdEditorOnly && !computerTapOnly && !firefoxExtensionOnly && !chromiumOnly && !chooserOnly && !uxOnly) {
        // The conflict target is another owned window with an explicit
        // selector, so reopening it exercises the displaced app binding.
        const quickConfig = await invoke("get_config");
        // Keep the production Win hook active so Win-held blur is meaningful.
        quickConfig.bindings[0].shortcut = "Super+F24";
        quickConfig.bindings.push({label:"Old fixture app",shortcut:"Alt+C",action:"pull-app",enabled:true,
            appMatch:"fixture-old.exe",windowsMatch:{windowId:String(fixture.windows[1]),processId:fixture.pid},
            mainMonitorAction:"burner",burnerLayout:"float"});
        await invoke("save_config", {config:quickConfig});
        await invoke("set_enabled",{enabled:true});
        const mainWindow = await native("app_window");
        await native("app_close",{window:mainWindow});
        await until(()=>native("app_state",{window:mainWindow}),s=>!s.visible,"hide fixture editor");
        await press(19);
        const quickTarget = await until(async()=>{
            try {return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type === "page" && /\/quick\.html$/.test(t.url));}
            catch {return null;}
        }, Boolean, "quick popup WebView", 30000);
        const quickSocket = new WebSocket(quickTarget.webSocketDebuggerUrl);
        await new Promise((resolve,reject)=>{quickSocket.addEventListener("open",resolve,{once:true});quickSocket.addEventListener("error",reject,{once:true});});
        let quickId=0;
        const quickPending=new Map();
        quickSocket.addEventListener("message",event=>{const response=JSON.parse(event.data);const pending=quickPending.get(response.id);if(!pending)return;quickPending.delete(response.id);response.error?pending.reject(new Error(JSON.stringify(response.error))):pending.resolve(response.result);});
        const quickEval = expression => new Promise((resolve,reject)=>{const id=++quickId;quickPending.set(id,{resolve:result=>result.exceptionDetails?reject(new Error(result.exceptionDetails.text)):resolve(result.result?.value),reject});quickSocket.send(JSON.stringify({id,method:"Runtime.evaluate",params:{expression,awaitPromise:true,returnByValue:true}}));});
        const quickScreenshot = async name => {
            const id=++quickId;
            const data=await new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>{quickSocket.removeEventListener("message",listener);reject(new Error("Quick screenshot timed out"));},10000);
                const listener=event=>{
                    const response=JSON.parse(event.data);
                    if(response.id!==id)return;
                    clearTimeout(timer);quickSocket.removeEventListener("message",listener);
                    response.error?reject(new Error(JSON.stringify(response.error))):resolve(response.result.data);
                };
                quickSocket.addEventListener("message",listener);
                quickSocket.send(JSON.stringify({id,method:"Page.captureScreenshot"}));
            });
            fs.writeFileSync(path.join(output,name),Buffer.from(data,"base64"));
        };
        try {
            await until(()=>quickEval("document.querySelector('#quick-app').textContent"),v=>Boolean(v),"popup identifies focused fixture");
            const quickWindow=await native("app_window");
            await native("plain_press",{key:67,window:quickWindow});
            await until(()=>quickEval("document.querySelector('#quick-entry').value"),v=>v==="Alt+C","plain key uses default Alt");
            await native("plain_press",{key:13,window:quickWindow});
            await until(()=>quickEval("!document.querySelector('#quick-conflict').hidden"),Boolean,"conflict review");
            assert.match(await quickEval("document.querySelector('#quick-conflict-summary').textContent"),/Old fixture app/);
            assert.equal((await invoke("get_config")).bindings.length,10,"conflict preview must not save");
            await quickScreenshot("quick-conflict.png");
            await quickEval("document.querySelector('#quick-replace').click()");
            const saved=await until(()=>invoke("get_config"),c=>c.bindings.length===11,"popup saves binding");
            assert.equal(saved.bindings[9].enabled,false);
            assert.equal(saved.bindings[10].shortcut,"Alt+C");
            assert.equal(saved.bindings[10].enabled,true);
            checks.push("real popup replaces the conflicting app shortcut and preserves its disabled binding");
            await until(()=>native("app_window").then(()=>false,()=>true),Boolean,"first popup closes");
            await native("press",{key:0x82,window:fixture.windows[1]}); // F19 opens for displaced app B.
            await until(()=>quickEval("document.querySelector('#quick-app').textContent"),v=>v==="Old fixture app","reopen displaced app");
            assert.equal(await quickEval("document.querySelector('#quick-entry').value"),"", "a displaced app must not show the stolen shortcut");
            let reopened=await until(()=>native("app_window").catch(()=>null),Boolean,"reopened displaced popup");
            await native("plain_press",{key:88,window:reopened});
            await until(()=>quickEval("document.querySelector('#quick-entry').value"),v=>v==="Alt+X","new key for displaced app");
            await native("plain_press",{key:13,window:reopened});
            const reassigned=await until(()=>invoke("get_config"),c=>c.bindings[9].enabled && c.bindings[9].shortcut==="Alt+X","displaced app gets new shortcut");
            assert.equal(reassigned.bindings[10].shortcut,"Alt+C");
            assert.equal(reassigned.bindings[10].enabled,true);
            checks.push("reopening a displaced app shows no stale key and can enable a new shortcut");
            await until(()=>native("app_window").then(()=>false,()=>true),Boolean,"displaced popup closes");
            await native("press",{key:0x82,window:fixture.windows[0]});
            await until(()=>quickEval("document.querySelector('#quick-entry').value"),v=>v==="Alt+C","reopen app A");
            reopened=await until(()=>native("app_window").catch(()=>null),Boolean,"reopened app A popup");
            await native("plain_press",{key:88,window:reopened});
            await native("plain_press",{key:13,window:reopened});
            await until(()=>quickEval("!document.querySelector('#quick-conflict').hidden"),Boolean,"second conflict review");
            const beforeKeep=await invoke("get_config");
            await quickEval("document.querySelector('#quick-keep').click()");
            await until(()=>quickEval("document.querySelector('#quick-conflict').hidden"),Boolean,"keep closes only conflict dialog");
            assert.deepEqual(await invoke("get_config"),beforeKeep,"keeping the existing key must not persist a replacement");
            await quickEval("document.querySelector('#quick-apply').click()");
            await until(()=>quickEval("!document.querySelector('#quick-conflict').hidden"),Boolean,"conflict review reopens");
            await quickEval("document.querySelector('#quick-replace-edit').click()");
            await until(()=>quickEval("document.querySelector('#quick-app').textContent"),v=>v==="Old fixture app","replace and edit opens displaced app");
            await until(()=>quickEval("document.querySelector('#quick-entry').value"),v=>v==="","displaced shortcut is blank for editing");
            const replaced=await invoke("get_config");
            assert.equal(replaced.bindings[9].enabled,false);
            assert.equal(replaced.bindings[10].shortcut,"Alt+X");
            assert.equal(replaced.bindings[10].enabled,true);
            reopened=await until(()=>native("app_window").catch(()=>null),Boolean,"edit-old popup stays open");
            await native("plain_press",{key:67,window:reopened});
            await until(()=>quickEval("document.querySelector('#quick-entry').value"),v=>v==="Alt+C","replacement key for old app");
            await native("plain_press",{key:13,window:reopened});
            const finalConfig=await until(()=>invoke("get_config"),c=>c.bindings[9].enabled && c.bindings[9].shortcut==="Alt+C","edit-old shortcut saved");
            assert.equal(finalConfig.bindings[10].shortcut,"Alt+X");
            assert.equal(finalConfig.bindings[10].enabled,true);
            checks.push("cancel preserves both shortcuts; replace and edit old opens a blank picker and saves both app bindings");
            await until(()=>native("app_window").then(()=>false,()=>true),Boolean,"edit-old popup closes");
            await native("press",{key:0x82,window:fixture.windows[1]});
            await until(()=>quickEval("document.querySelector('#quick-entry').value"),v=>v==="Alt+C","reopen edited old shortcut");
            reopened=await until(()=>native("app_window").catch(()=>null),Boolean,"popup before click-away");
            const beforeAway=await invoke("get_config");
            await native("click_owned",{window:fixture.windows[0]});
            await until(()=>native("fixture_window_state",{window:reopened}),s=>!s.visible,"popup closes when another owned app takes focus");
            assert.deepEqual(await invoke("get_config"),beforeAway,"clicking away must not change saved shortcuts");
            checks.push("popup closes on click-away without changing saved shortcuts");
            await native("press",{key:0x82,window:fixture.windows[1]});
            await until(()=>quickEval("document.querySelector('#quick-entry').value"),v=>v==="Alt+C","reopen popup before recording click-away");
            reopened=await until(()=>native("app_window").catch(()=>null),Boolean,"popup before recording click-away");
            await native("focus",{window:reopened});
            await until(()=>native("fixture_window_state",{window:reopened}),state=>state.visible && state.foreground,"focus popup before recording click-away");
            // Exercise a real outside click while recording is active. The
            // separate no-mouse unfocused watcher path remains unverified:
            // Windows denied the fixture's programmatic focus transition even
            // when the candidate owned both windows. No Win key is injected.
            await invoke("start_shortcut_recording",{popup:true});
            try {
                const recordingPopup = await native("fixture_window_state",{window:reopened});
                report.recordingClick = {beforeClick:{visible:recordingPopup.visible,foreground:recordingPopup.foreground}};
                assert.equal(recordingPopup.visible && recordingPopup.foreground,true,"recording popup must be focused before the outside click");
                await native("click_owned",{window:fixture.windows[0]});
                await until(()=>native("fixture_window_state",{window:reopened}),s=>!s.visible,"outside click closes the recording popup");
                assert.deepEqual(await invoke("get_config"),beforeAway,"recording click-away must not change saved shortcuts");
                // The hook swallows this chord while recording, so the normal
                // open-editor shortcut can fire only after recording stops.
                await native("press",{key:0x82,window:fixture.windows[1]});
                await until(()=>native("app_window").catch(()=>null),Boolean,"editor shortcut works after click-away stops recording");
                await invoke("hide_quick");
                checks.push("click-away closes a focused recording popup and releases recording");
                skipped.push("Click-away after an already-unfocused Win or recording blur: Windows denied the fixture's no-mouse focus transition; requires a physical test");
            } finally { await invoke("stop_shortcut_recording").catch(()=>{}); }
        } finally {quickSocket.close();}
        const discovery=await invoke("get_config");
        discovery.bindings.push({label:path.basename(fixture.executable,".exe"),shortcut:"Ctrl+Alt+Shift+F24",action:"focus-app",appMatch:"not-this-app.exe",enabled:false});
        await invoke("save_config",{config:discovery});
        await evaluate("location.reload()");
        await wait("document.querySelectorAll('.binding').length === 12", "discovery draft reload");
        await click("#find-apps");
        await wait("document.querySelector('#find-apps-result').textContent.includes('Review and save')", "open app discovery");
        assert.match(await evaluate("document.querySelector('.binding:last-child .app-matches').value"),/python/i);
        await click("#save");
        await wait("document.querySelector('#message').textContent.startsWith('Saved.')", "discovered names saved");
        const found=await invoke("get_config");
        assert.ok(found.bindings[11].appMatches.some(name=>name.toLowerCase().includes("python")));
        checks.push("real editor discovers the owned app identifier and persists it only after Save");
    }
    if (!firefoxOnly && !quickOnly) {
    await press(18); await paused(false);
    await press(18); await paused(true);
    checks.push("Win32 keyboard input resumes and pauses while retaining the pause registration");

    await native("reserve",{key:0x87}); // F24, reserved by this fixture only.
    const pauseField = '.binding:nth-child(6) [data-field="shortcut"]';
    await input(pauseField,"Ctrl+Alt+Shift+F24"); await click("#save");
    await wait("document.querySelector('#message').textContent.includes('Cannot register the pause shortcut')", "pause conflict error");
    assert.equal((await invoke("get_config")).bindings[5].shortcut,"Ctrl+Alt+Shift+F18");
    await press(18); await paused(false);
    await wait("document.querySelector('#save-status').textContent === 'Unsaved changes'", "unsaved changes remain identified");
    await press(18); await paused(true);
    await input(pauseField,"Ctrl+Alt+Shift+F18"); await click("#save");
    await wait("!document.querySelector('#add').disabled && document.querySelector('#message').textContent.startsWith('Saved.')", "restored pause key");
    checks.push("failed pause-key reassignment preserves the settings file and previous working key");

    const actionField = '.binding:nth-child(3) [data-field="shortcut"]';
    await input(actionField,"Ctrl+Alt+Shift+F24"); await click("#save");
    await wait("!document.querySelector('#add').disabled && document.querySelector('#message').textContent.startsWith('Saved.')", "conflicting action draft saved");
    await click("#toggle");
    await wait("!document.querySelector('#app-alert').hidden && document.querySelector('#app-alert-text').textContent.includes('Cannot register')", "action registration failure");
    assert.equal((await invoke("get_status")).enabled,false);
    for (const key of [0x7c,0x7d]) {await native("reserve",{key});await native("release",{key});}
    await assert.rejects(() => native("reserve",{key:0x81})); // Pause F18 still belongs to app.
    await input(actionField,"Ctrl+Alt+Shift+F15"); await click("#save");
    await wait("!document.querySelector('#add').disabled && document.querySelector('#message').textContent.startsWith('Saved.')", "action recovery saved");
    await native("release",{key:0x87});
    checks.push("partial registration failure releases earlier action keys without dropping pause");

    await press(18); await paused(false);
    const mainBeforeQuick = await native("app_window");
    await native("app_close",{window:mainBeforeQuick});
    await until(()=>native("app_state",{window:mainBeforeQuick}),state=>!state.visible,"hide editor for quick popup");
    await press(19);
    const quickTarget = await until(async()=>{
        try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target=>target.type==="page" && /\/quick\.html$/.test(target.url)); }
        catch { return null; }
    },Boolean,"quick popup WebView",30000);
    const quickSocket = new WebSocket(quickTarget.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{quickSocket.addEventListener("open",resolve,{once:true});quickSocket.addEventListener("error",reject,{once:true});});
    let quickId=0;
    const quickPending=new Map();
    quickSocket.addEventListener("message",event=>{const response=JSON.parse(event.data),pending=quickPending.get(response.id);if(!pending)return;quickPending.delete(response.id);response.error?pending.reject(new Error(JSON.stringify(response.error))):pending.resolve(response.result);});
    const quickEval=expression=>new Promise((resolve,reject)=>{const id=++quickId;quickPending.set(id,{resolve:result=>result.exceptionDetails?reject(new Error(result.exceptionDetails.text)):resolve(result.result?.value),reject});quickSocket.send(JSON.stringify({id,method:"Runtime.evaluate",params:{expression,awaitPromise:true,returnByValue:true}}));});
    try {
        const label = await until(()=>quickEval("document.querySelector('#quick-app').textContent"),value=>Boolean(value),"quick popup identifies the focused app");
        assert.ok(label.toLowerCase().includes(path.basename(fixture.executable,".exe").toLowerCase()));
        await until(()=>quickEval("!document.querySelector('#quick-apply').disabled"),Boolean,"quick popup finishes loading");
        await quickEval("document.querySelector('[data-mod=Ctrl]').click();document.querySelector('[data-mod=Shift]').click()");
        const quickWindow = await until(()=>native("app_window").catch(()=>null),Boolean,"focused quick popup");
        await native("plain_press",{key:88,window:quickWindow});
        await until(()=>quickEval("document.querySelector('#quick-entry').value"),value=>value==="Ctrl+Alt+Shift+X","popup accepts native shortcut key");
        await quickEval("document.querySelector('#quick-apply').click()");
        await until(()=>invoke("get_config"),value=>value.bindings.length===10 && value.bindings[9].shortcut==="Ctrl+Alt+Shift+X","popup saves app binding");
        assert.equal((await invoke("get_status")).enabled,true);
    } finally { quickSocket.close(); }
    await invoke("show_editor",{appMatch:null});
    await evaluate("location.reload()");
    await wait("document.querySelectorAll('.binding').length === 10 && !document.querySelector('#toggle').disabled","editor loads saved popup binding");
    await press(18); await paused(true);
    checks.push("quick popup names the focused app, accepts a native key, and saves its binding while shortcuts stay on");
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
    await click('#show-settings');
    await click('#monitor-settings > summary');
    await wait("!document.querySelector('#main-monitor').disabled",'detected monitors');
    await input("#main-monitor",String(ownedWindow.monitor));
    await click('#show-shortcuts');
    await input("#hold-delay","700");
    await input('.binding:last-child [data-field="mainMonitorAction"]',"focus-last");
    await click("#save");
    await wait("!document.querySelector('#add').disabled && document.querySelector('#message').textContent.startsWith('Saved.')", "hold settings saved");
    assert.equal((await invoke("get_config")).settings.holdDelayMs,700);
    await click("#show-settings");
    await evaluate("document.querySelector('#hold-enabled').scrollIntoView({block:'center'})");
    await screenshot("hold-settings.png");
    await click("#show-shortcuts");
    await press(18); await paused(false);
    await placeOwned();
    const appWindow = await native("app_window");
    const holdStartedAt = Date.now();
    await native("hold_start",{key:0x7d,window:appWindow}); // F14 app pull.
    await sleep(80);
    const heldWindow = await readOwned();
    assert.equal(heldWindow.active,false,`tap must wait for release (elapsed ${Date.now()-holdStartedAt} ms, rect ${JSON.stringify(heldWindow.rect)})`);
    await evaluate("window.__holdErrors=[];window.__TAURI__.event.listen('warp-error',event=>window.__holdErrors.push(event.payload))");
    await native("key_up",{keys:[0x11]}); // Ctrl released before F14.
    try { await until(readOwned,w=>w.active,"modifier-first release pulls the owned app"); }
    catch(error) { throw new Error(`${error}; app errors: ${JSON.stringify(await evaluate("window.__holdErrors"))}`); }
    assert.deepEqual((await readOwned()).rect,initial);
    await native("key_up");
    checks.push("app-pull tap waits for release and accepts modifier-first release without tiling");
    assert.deepEqual(await native("pointer_position"),{x:Math.round(area.x+area.width/2),y:Math.round(area.y+area.height/2)});
    checks.push("native app pull centers the pointer on the configured main monitor");

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

    {
        const previous = await invoke("get_config");
        const overlap = structuredClone(previous);
        overlap.settings.holdDelayMs = 1200;
        overlap.settings.mainMonitor = ownedWindow.monitor;
        const first = overlap.bindings.at(-1);
        first.windowsMatch = {windowId:ownedWindow.id,processId:fixture.pid};
        first.mainMonitorAction = "focus-last";
        overlap.bindings.push({...structuredClone(first),label:"Owned overlapping app B",shortcut:"Ctrl+Alt+Shift+F24",
            windowsMatch:{windowId:String(fixture.windows[1]),processId:fixture.pid}});
        const secondInitial = {...initial,x:initial.x+40,y:initial.y+40};
        const readPair = async () => {
            const windows = await invoke("get_windows");
            const pair = fixture.windows.map(id=>windows.find(w=>w.id===String(id)));
            assert.ok(pair.every(w=>w?.pid===fixture.pid),"Overlapping app chords must target only the two original owned HWND/PID pairs");
            return pair;
        };
        const errors = [];
        try {
            await invoke("set_enabled",{enabled:false});
            await invoke("save_config",{config:overlap});
            await invoke("set_enabled",{enabled:true});
            await evaluate("(async()=>{window.__overlapErrors=[]; window.__overlapStop=await window.__TAURI__.event.listen('warp-error',e=>window.__overlapErrors.push(e.payload));})()");
            await placeOwned();
            await native("place",{window:fixture.windows[1],rect:secondInitial});
            await native("pointer",{x:area.x+20,y:area.y+20});
            await native("hold_start",{key:0x7d,window:fixture.windows[0]});
            await sleep(80);
            await native("held_tap",{key:0x87}); // B releases only F24; A and shared modifiers stay held.
            const tapped = await until(readPair,([a,b])=>b.active&&!a.active,"overlapping B tap focuses its distinct owned target");
            assert.deepEqual(tapped[0].rect,initial,"B must tap before A's hold fires");
            assert.deepEqual(tapped[1].rect,secondInitial);
            await until(readPair,([a,b])=>a.active&&!b.active&&Object.entries(tile).every(([key,value])=>a.rect[key]===value),
                "releasing B leaves A pending until its own tile threshold");
            await placeOwned();
            await native("held_tap",{key:0x87});
            await until(readPair,([a,b])=>b.active&&!a.active,"B can tap again while the consumed A hold remains down");
            await native("repeat",{key:0x7d});
            await sleep(overlap.settings.holdDelayMs+150);
            const held = await readPair();
            assert.deepEqual(held[0].rect,initial,"A repeat after B must not create another hold");
            assert.deepEqual(held[1].rect,secondInitial,"B taps must not become delayed holds");
            assert.equal(held[1].active,true,"A must not refocus after B's tap");
            await native("key_up");
            await sleep(150);
            const released = await readPair();
            assert.deepEqual(released[0].rect,initial);
            assert.deepEqual(released[1].rect,secondInitial);
            assert.equal(released[1].active,true,"A release must not issue a stale tap over B");
            assert.deepEqual(await evaluate("window.__overlapErrors"),[]);
            checks.push("native distinct overlapping app chords keep A's hold independent of B taps, ignore A repeats and prevent a stale release tap");
        } catch (error) { errors.push(error); }
        finally {
            for (const cleanup of [()=>native("key_up"),()=>invoke("set_enabled",{enabled:false}),
                ()=>invoke("save_config",{config:previous}),()=>invoke("set_enabled",{enabled:true}),
                ()=>evaluate("if(window.__overlapStop){window.__overlapStop();delete window.__overlapStop;}")]) {
                try { await cleanup(); } catch (error) { errors.push(error); }
            }
        }
        if (errors.length) throw new AggregateError(errors,"Overlapping native app chord acceptance or cleanup failed:\n"+errors.map(error=>String(error.stack || error)).join("\n"));
        await placeOwned();
    }

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

    await evaluate("(() => {const field=document.querySelector('#hold-enabled');field.checked=true;field.dispatchEvent(new Event('change'));const mode=document.querySelector('#hold-mode');mode.value='radial';mode.dispatchEvent(new Event('change'));})()");
    await click("#save");
    await wait("!document.querySelector('#add').disabled && document.querySelector('#message').textContent.startsWith('Saved.')", "radial mode saved");
    assert.equal((await invoke("get_config")).settings.holdMode,"radial");
    await press(18); await paused(false);
    const center = {x:area.x+Math.floor(area.width/2),y:area.y+Math.floor(area.height/2)};
    const radialOpen = (count=2) => until(()=>invoke("radial_view"),v=>v?.labels?.length===count,"native radial opens");
    const radialClosed = () => until(()=>invoke("radial_view"),v=>v===null,"native radial closes");
    const readSecond = async () => (await invoke("get_windows")).find(w=>w.id===String(fixture.windows[1]));
    await placeOwned();
    await native("pointer",center);
    await native("hold_start",{key:0x7d});
    const view = await radialOpen();
    assert.deepEqual(view.labels,[marker+"-0",marker+"-1"]);
    assert.equal(view.selected,null);
    await native("pointer",{x:center.x,y:center.y+90});
    await until(()=>invoke("radial_view"),v=>v?.selected===1,"pointer selects second radial slot");
    assert.equal((await readSecond()).active,false,"radial selection must wait for release");
    const radialTarget = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.url.endsWith("/radial.html"));
    assert.ok(radialTarget,"Picker has a native webview");
    const inspectRadial = async expression => {
        const socket = new WebSocket(radialTarget.webSocketDebuggerUrl);
        await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
        try {
            const result = await new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>reject(new Error("Picker inspection timed out")),10000);
                socket.addEventListener("message",event=>{const reply=JSON.parse(event.data);if(reply.id===1){clearTimeout(timer);reply.error?reject(new Error(JSON.stringify(reply.error))):resolve(reply.result);}});
                socket.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression,returnByValue:true}}));
            });
            return result.result?.value;
        } finally {socket.close();}
    };
    const radialSocket = new WebSocket(radialTarget.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{radialSocket.addEventListener("open",resolve,{once:true});radialSocket.addEventListener("error",reject,{once:true});});
    try {
        const result = await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(new Error("Radial screenshot timed out")),10000);
            radialSocket.addEventListener("message",event=>{const message=JSON.parse(event.data);if(message.id===1){clearTimeout(timer);message.error?reject(new Error(JSON.stringify(message.error))):resolve(message.result);} });
            radialSocket.send(JSON.stringify({id:1,method:"Page.captureScreenshot"}));
        });
        fs.writeFileSync(path.join(output,"radial.png"),Buffer.from(result.data,"base64"));
    } finally { radialSocket.close(); }
    await native("repeat",{key:0x7d});
    await native("key_up");
    await radialClosed();
    await until(readSecond,w=>w.active,"release focuses the selected second window");
    assert.deepEqual((await readOwned()).rect,initial);
    checks.push("native radial uses stable window order, tracks pointer, ignores repeats and selects only on release");

    await placeOwned(); await native("pointer",center);
    await native("hold_start",{key:0x7d}); await radialOpen();
    await native("key_up"); await radialClosed();
    assert.deepEqual((await readOwned()).rect,initial);
    assert.equal((await readSecond()).active,false);
    checks.push("radial release inside the dead zone cancels without selecting or moving a window");

    for (let attempt=0; attempt<5; attempt++) {
        await native("pointer",center); await native("hold_start",{key:0x7d}); await radialOpen();
        await native("pointer",{x:center.x,y:center.y+90});
        await until(()=>invoke("radial_view"),v=>v?.selected===1,"select before Escape");
        const beforeEscape = await inspectRadial(`(() => {window.escapeEvents=[];if(!window.escapeProbeInstalled){for(const name of ['keydown','keyup']) document.addEventListener(name,event=>{if(event.key==='Escape') window.escapeEvents.push({type:event.type,ctrl:event.ctrlKey,alt:event.altKey,shift:event.shiftKey});},{capture:true});window.escapeProbeInstalled=true;}return {focused:document.hasFocus(),view:current?.id};})()`);
        await native("held_tap",{key:0x1b});
        try { await radialClosed(); }
        catch (error) {
            report.escapeProbe = {attempt,before:beforeEscape,foreground:await native("foreground_state"),after:await inspectRadial("({focused:document.hasFocus(),view:current?.id,events:window.escapeEvents})")};
            throw error;
        }
        // Alt+Escape may itself cycle to either fixture window. Verify the app
        // dismisses before release and release adds no selection/placement action.
        const cancelledFocus = await native("foreground_state");
        const cancelledRects = [(await readOwned()).rect,(await readSecond()).rect];
        await native("key_up"); await sleep(100);
        assert.deepEqual(await native("foreground_state"),cancelledFocus);
        assert.deepEqual([(await readOwned()).rect,(await readSecond()).rect],cancelledRects);
    }
    checks.push("native Escape cancels a selected radial gesture without applying it on release");

    await native("pointer",center); await native("hold_start",{key:0x7d}); await radialOpen();
    await invoke("set_enabled",{enabled:false}); await radialClosed();
    await invoke("set_enabled",{enabled:true}); await sleep(850);
    assert.equal(await invoke("radial_view"),null);
    await native("key_up"); await sleep(100);
    assert.equal((await readSecond()).active,false);
    checks.push("pause closes an open radial and resume cannot revive it while the key remains held");
    await press(18); await paused(true);

    await press(18); await paused(false);
    await press(20);
    await wait("!document.querySelector('#workspaces-page').hidden && !document.querySelector('#capture-workspace').disabled", "workspace browser hotkey");
    await click("#capture-workspace");
    await wait("!document.querySelector('#workspace-editor').hidden", "workspace capture",60000);
    const selected = await evaluate(`(() => {let count=0;document.querySelectorAll('.workspace-item').forEach(card=>{const keep=card.querySelector('.window-title').textContent.startsWith(${JSON.stringify(marker)});const input=card.querySelector('.include-window');input.checked=keep;input.dispatchEvent(new Event('change'));if(keep)count++;});return count;})()`);
    assert.equal(selected,2);
    await input("#workspace-name","Owned Windows workspace"); await click("#save-workspace");
    await wait("[...document.querySelectorAll('.workspace-card-status')].some(status => !status.hidden && status.textContent === 'Saved.')", "owned workspace saved");
    let store = await invoke("get_workspaces");
    assert.equal(store.profiles.length,1);
    assert.equal(store.profiles[0].items.length,2);
    assert.ok(store.profiles[0].items.every(i => i.window.pid === fixture.pid));
    checks.push("native workspace capture review saves only selected owned windows");

    await press(21);
    await wait("!document.querySelector('#workspace-hotkey-choice').hidden", "workspace capture choices",60000);
    await click("#workspace-hotkey-update");
    await wait("!document.querySelector('#workspace-editor').hidden", "workspace update hotkey",60000);
    assert.equal(await evaluate("document.querySelector('#workspace-name').value"),store.profiles[0].name);
    assert.deepEqual(await invoke("get_workspaces"),store);
    await click("#discard-workspace");
    checks.push("workspace update hotkey opens closest-match review without auto-saving");
    for (const [index,item] of store.profiles[0].items.entries()) {
        item.window.rect = {x:item.window.workArea.x+90+index*120,y:item.window.workArea.y+90+index*80,width:560,height:380};
        item.window.maximizedHorizontal = item.window.maximizedVertical = item.window.fullscreen = item.window.minimized = false;
    }
    await invoke("save_workspaces",{store});
    await click('[data-action="restore"]');
    await wait("[...document.querySelectorAll('.workspace-card-status')].some(status => !status.hidden && status.textContent === 'Opened 2 of 2 windows.')", "workspace reuse");
    const existing = (await invoke("get_windows")).filter(w => w.pid === fixture.pid);
    for (const item of store.profiles[0].items) assert.deepEqual(existing.find(w=>w.id===item.window.id).rect,item.window.rect);
    checks.push("workspace restore reuses both owned windows with independent native placements");

    const launch = structuredClone(store.profiles[0]);
    launch.id = "launch-fixture"; launch.name = "Owned launch fixture"; launch.items = [launch.items[0]];
    launch.items[0].label = marker+"-launch-0"; launch.items[0].window.title = marker+"-launch-0";
    launch.items[0].launch = {kind:"executable",program:fixture.executable,args:[path.join(desktop,"tests/windows/fixture.py"),"--marker",marker+"-launch","--standalone"],workingDirectory:"",newWindow:true};
    store.profiles.push(launch);
    await invoke("save_workspaces",{store});
    await cdp("Page.reload");
    await wait("document.querySelectorAll('.binding').length === 10", "reloaded settings");
    await click("#show-workspaces");
    await wait("document.querySelectorAll('#workspace-list article').length === 2", "reloaded workspaces");
    await click('#workspace-list article:last-child [data-action="restore"]');
    await wait("[...document.querySelectorAll('.workspace-card-status')].some(status => !status.hidden && status.textContent === 'Opened 1 of 1 windows.')", "new-window workspace launch",30000);
    const launched = (await invoke("get_windows")).filter(w=>w.title===marker+"-launch-0");
    assert.equal(launched.length,1); assert.notEqual(launched[0].pid,fixture.pid);
    assert.deepEqual(launched[0].rect,launch.items[0].window.rect);
    await screenshot("workspaces.png");
    checks.push("workspace launch opens a distinct owned process and restores its placement");

    await invoke("set_enabled",{enabled:false}); await paused(true);
    await wait("!document.querySelector('#import-files').disabled", "import available while paused");
    const beforeImport = await invoke("get_config");
    const importFiles = [
        ["apps.ini", `[Meta]\ncount=3\n[App1]\nlabel=Imported disabled app\nhotkey=\ndisabledHotkey=^!+F22\nmatch=ahk_exe fixture.exe\n[App2]\nlabel=Needs manual match\nhotkey=#f\nmatch=ahk_group UndefinedGroup\n[App3]\nlabel=Owned title and class\nhotkey=^!+F24\nmatch=${marker}-0 ahk_class ${ownedWindow.className} ahk_exe ${fixture.executable} ahk_pid ${fixture.pid}`],
        ["settings.ini", "[Settings]\nholdDelayMs=850\nholdTileEnabled=1\nholdMode=radial"],
        ["workspaces.ini", "[Meta]\ncount=1\n[Profile1]\nid=legacy-id\nname=Imported workspace\nitemCount=2\n[Profile1Item1]\nprocessName=WindowsTerminal.exe\npath=C:\\WindowsApps\\Terminal.exe\ntitle=Development\nterminalCommand=wsl.exe -d \"Ubuntu\"\nprofileName=Dev\nx=100\ny=100\nw=600\nh=400\nmonitorIndex=1\n[Profile1Item2]\nprocessName=firefox.exe\npath=firefox.exe\ntitle=Research\nbrowserProfileName=Work\nbrowserUrlCount=2\nbrowserUrl1=https://example.test/one\nbrowserUrl2=https://example.test/two?a=1;b=2\nbrowserActiveTab=2\nx=150\ny=150\nw=700\nh=500\nmonitorIndex=1"]
    ].map(([name,text])=>{const file=path.join(output,name);fs.writeFileSync(file,Buffer.concat([Buffer.from([255,254]),Buffer.from(text,"utf16le")]));return file;});
    await evaluate("document.querySelector('#legacy-import').open=true");
    const dom = await cdp("DOM.getDocument");
    const fileNode = await cdp("DOM.querySelector",{nodeId:dom.root.nodeId,selector:"#import-files"});
    await cdp("DOM.setFileInputFiles",{nodeId:fileNode.nodeId,files:importFiles});
    await wait("document.querySelectorAll('#import-results article').length === 5", "INI file review");
    assert.deepEqual(await invoke("get_config"),beforeImport);
    assert.deepEqual(await invoke("get_workspaces"),store);
    assert.ok((await evaluate("document.querySelector('#import-results').textContent")).includes("ahk_group"));
    await screenshot("import-review.png");
    await click("#apply-import");
    assert.deepEqual(await invoke("get_config"),beforeImport);
    await click("#save");
    await wait("document.querySelector('#message').textContent.startsWith('Saved.')", "imported shortcuts explicitly saved");
    const importedConfig = await invoke("get_config");
    assert.equal(importedConfig.bindings.length,beforeImport.bindings.length+2);
    assert.equal(importedConfig.bindings.at(-2).enabled,false);
    assert.equal(importedConfig.bindings.at(-2).shortcut,"Ctrl+Alt+Shift+F22");
    assert.equal(importedConfig.bindings.at(-1).windowsMatch.titleContains,marker+"-0");
    assert.equal(importedConfig.bindings.at(-1).windowsMatch.className,ownedWindow.className);
    assert.equal(importedConfig.bindings.at(-1).windowsMatch.executable,fixture.executable);
    await evaluate("document.querySelector('.binding:last-child .windows-match-details').scrollIntoView({block:'center'})");
    await screenshot("windows-match.png");
    assert.equal(importedConfig.settings.holdDelayMs,850);
    checks.push("native UTF-16 INI review preserves unsupported entries and disabled keys without saving until explicit Save");
    await click("#import-results article:last-child button");
    await wait("!document.querySelector('#workspace-editor').hidden", "imported workspace draft");
    assert.deepEqual(await invoke("get_workspaces"),store);
    assert.equal(await evaluate("document.querySelector('[data-terminal=wslDistro]').value"),"Ubuntu");
    assert.equal(await evaluate("document.querySelector('.workspace-item:nth-child(2) [data-browser=activeTab]').value"),"2");
    await input('[data-rect="x"]',"120");
    await screenshot("import-workspace.png");
    await click("#save-workspace");
    await wait("[...document.querySelectorAll('.workspace-card-status')].some(status => !status.hidden && status.textContent === 'Saved.')", "imported workspace explicitly saved");
    const importedStore = await invoke("get_workspaces");
    assert.equal(importedStore.profiles.length,store.profiles.length+1);
    const importedProfile = importedStore.profiles.at(-1);
    assert.notEqual(importedProfile.id,"legacy-id");
    assert.equal(importedProfile.items[0].terminal.wslDistro,"Ubuntu");
    assert.equal(importedProfile.items[0].window.rect.x,120);
    assert.equal(importedProfile.items[1].browser.tabs[1].url,"https://example.test/two?a=1;b=2");
    checks.push("native workspace INI import reviews terminal, Firefox and editable placement before saving a new profile");

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
    const instanceWindow = await native("app_window");
    const instanceConfig = await invoke("get_config"), instanceStore = await invoke("get_workspaces");
    await native("app_close",{window:instanceWindow});
    await until(()=>native("app_state",{window:instanceWindow}),s=>!s.visible,"closing the editor hides the same owned main window");
    assert.equal(app.exitCode,null);
    checks.push("native close-to-tray hides the editor while its owned process and main HWND survive");
    second = spawn(binary,[],{cwd:output,windowsHide:true,stdio:"ignore"});
    assert.equal(await exit(second,15000),0);
    assert.equal(app.exitCode,null);
    const reopened = await until(()=>native("app_state",{window:instanceWindow}),s=>s.visible&&s.foreground,"second instance reopens and focuses the original main HWND");
    assert.equal(reopened.pid,app.pid);
    assert.equal(await native("app_window"),instanceWindow);
    assert.deepEqual(await invoke("get_config"),instanceConfig);
    assert.deepEqual(await invoke("get_workspaces"),instanceStore);
    checks.push("second instance exits, reopens the same owned HWND/PID and preserves settings and workspaces");
    const pointerConfig = await invoke("get_config");
    const monitorAreas = await invoke("get_import_monitors");
    {
        await invoke("set_enabled",{enabled:false});
        const centered = structuredClone(pointerConfig);
        centered.bindings = ["push-left-center","push-right-center","pull"].map((action,i)=>({label:action,action,shortcut:`Ctrl+Alt+Shift+F${13+i}`,enabled:true,appMatch:""}));
        await invoke("save_config",{config:centered});
        await invoke("set_enabled",{enabled:true});
        await placeOwned();
        const before = await readOwned();
        await native("pointer",{x:area.x+20,y:area.y+20});
        const centerOf = r => ({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
        const primaryArea = monitorAreas.find(r=>r.x<=0 && r.x+r.width>0 && r.y<=0 && r.y+r.height>0) || monitorAreas.find(r=>r.x===0) || monitorAreas[0];
        if (monitorAreas.length === 1) {
            for (const [key, opposite] of [[13,67],[14,88]]) {
                await placeOwned();
                const half = Math.floor(area.width / 2);
                const expected = key === 13
                    ? {...area, width:half}
                    : {...area, x:area.x+half, width:area.width-half};
                await press(key);
                await until(async()=>({window:await readOwned(),pointer:await native("pointer_position")}),
                    ({window:w,pointer:p})=>Object.entries(expected).every(([k,v])=>w.rect[k]===v)
                        && p.x===centerOf(area).x && p.y===centerOf(area).y,
                    "single-monitor push tiles the owned window and centers the pointer");
                await native("plain_press",{key:opposite,window:fixture.windows[1]});
                await sleep(200);
                assert.deepEqual((await readOwned()).rect,expected,"single-monitor tiling must not arm a follow-up retile");
            }
            checks.push("single-monitor centered pushes tile left and right without arming a follow-up retile");
        } else {
        for (const key of [13,14]) {
            await press(key);
            const moved = await until(readOwned,w=>w.monitor !== before.monitor,"centered push wraps to its destination monitor");
            assert.deepEqual(await native("pointer_position"),centerOf(moved.workArea));
            await press(15);
            await until(readOwned,w=>w.monitor===before.monitor && w.rect.x===before.rect.x && w.rect.width===before.rect.width,"history pull restores owned window");
            assert.deepEqual(await native("pointer_position"),centerOf(primaryArea));
        }
        checks.push("native centered push in both directions and history pull use the destination and primary pointer centers");
        for (const key of [88,67]) {
            await placeOwned(); await press(13); await sleep(80);
            const pushed = await readOwned();
            const retileStarted=Date.now();
            await native("plain_press",{key,window:fixture.windows[1]});
            const inputElapsed=Date.now()-retileStarted;
            const r = pushed.workArea, half = Math.floor(r.width/2);
            const expected = key===88 ? {...r,width:half} : {...r,x:r.x+half,width:r.width-half};
            try { await until(readOwned,w=>w.active && Object.entries(expected).every(([k,v])=>w.rect[k]===v),"retile acts on the pushed window after focus changes"); }
            catch (error) { throw new Error(`${error}; focus and input took ${inputElapsed} ms`); }
            await native("plain_press",{key:key===88?67:88});
            assert.deepEqual((await readOwned()).rect,expected,"a consumed push must not tile twice");
        }
        checks.push("native X/C retile the pushed window after focus changes and consume each push once");
        await placeOwned(); await press(13);
        const expired = (await readOwned()).rect;
        await sleep(1150); await native("plain_press",{key:88});
        assert.deepEqual((await readOwned()).rect,expired);
        checks.push("native Windows retile expires after one second");
        await placeOwned(); await press(13); await sleep(550); await press(14); await sleep(550);
        await native("plain_press",{key:67});
        const renewed = (await readOwned()).workArea, half = Math.floor(renewed.width/2);
        await until(readOwned,w=>w.rect.x===renewed.x+half && w.rect.width===renewed.width-half,"second push refreshes retile deadline");
        checks.push("native consecutive pushes refresh the Windows retile deadline");
        await placeOwned(); await press(13);
        const paused = (await readOwned()).rect;
        await invoke("set_enabled",{enabled:false}); await invoke("set_enabled",{enabled:true});
        await native("plain_press",{key:88});
        assert.deepEqual((await readOwned()).rect,paused);
        checks.push("native Windows pause cancels retile and resume does not revive it");
        }
        await invoke("set_enabled",{enabled:false});
        await invoke("save_config",{config:pointerConfig});
    }
    if (monitorAreas.length < 2) skipped.push("Physical Windows multi-monitor push, history pull, retile and burner geometry require a second display");

    await invoke("set_enabled",{enabled:false});
    const matchConfig = await invoke("get_config");
    const typedConfig = structuredClone(matchConfig);
    const typed = typedConfig.bindings.at(-1);
    assert.equal(typed.label,"Owned title and class");
    typed.mainMonitorAction="focus-last";
    typedConfig.settings.holdMode="radial";
    typedConfig.settings.holdDelayMs=400;
    await invoke("save_config",{config:typedConfig});
    await invoke("set_enabled",{enabled:true});
    await native("press",{key:0x87,window:fixture.windows[1]});
    await until(readOwned,w=>w.active,"typed title/class/path/PID pull chooses the owned first window");
    await native("pointer",center);
    await native("hold_start",{key:0x87,window:fixture.windows[1]});
    const typedView = await radialOpen(1);
    assert.deepEqual(typedView.labels,[marker+"-0"],"Picker must use the same conjunctive selector as tap");
    await native("pointer",{x:center.x,y:center.y-90});
    await until(()=>invoke("radial_view"),v=>v?.selected===0,"typed radial selects its only matching window");
    await native("key_up");await radialClosed();
    await until(readOwned,w=>w.active,"typed radial release selects the same owned window");
    checks.push("imported title, class, executable path and PID match the same owned window for native tap and radial selection");
    await invoke("set_enabled",{enabled:false});
    typed.action="focus-app";
    typed.windowsMatch.titleContains=(marker+"-0").toLowerCase();
    await invoke("save_config",{config:typedConfig});
    await invoke("set_enabled",{enabled:true});
    await native("press",{key:0x87,window:fixture.windows[1]});
    await wait("!document.querySelector('#app-alert').hidden && document.querySelector('#app-alert-text').textContent.includes('No open window')","case-sensitive selector refuses a lowercase title");
    assert.equal((await readSecond()).active,true);
    checks.push("native Windows title matching preserves case and rejects a mismatched conjunction");
    await invoke("set_enabled",{enabled:false});
    typed.windowsMatch=null;
    typed.appMatch=fixture.executable;
    assert.ok((await invoke("get_windows")).filter(w=>w.path.toLowerCase()===fixture.executable.toLowerCase()).every(w=>[fixture.pid,launched[0].pid].includes(w.pid)&&w.title.startsWith(marker)),"Full-path test requires exclusively owned matching windows");
    await invoke("save_config",{config:typedConfig});
    await invoke("set_enabled",{enabled:true});
    await native("press",{key:0x87,window:await native("app_window")});
    await until(()=>invoke("get_windows"),ws=>ws.some(w=>w.title.startsWith(marker)&&w.active),"full executable path focuses an owned matching window");
    checks.push("native full-path app identifiers work without requiring an advanced selector");
    await invoke("set_enabled",{enabled:false});

    // Reuse the fixture's private F24 binding for each action. Keep the typed
    // HWND/PID selector narrow so no unrelated application can be targeted.
    const actionConfig = structuredClone(matchConfig);
    const actionBinding = actionConfig.bindings.at(-1);
    actionBinding.windowsMatch = {windowId:ownedWindow.id,processId:fixture.pid};
    actionBinding.mainMonitorAction = "focus-last";
    actionConfig.bindings[0].action = "push-left-center";
    actionConfig.settings.holdTileEnabled = false;
    const selectAction = async action => {
        await invoke("set_enabled",{enabled:false});
        actionBinding.action = action;
        await invoke("save_config",{config:actionConfig});
        await invoke("set_enabled",{enabled:true});
    };
    const actionPress = window => native("press",{key:0x87,window});
    const isMaximized = w => w.maximizedHorizontal && w.maximizedVertical;
    const pauseReloadResume = async () => {
        await press(18); await paused(true);
        await invoke("save_config",{config:actionConfig});
        await press(18); await paused(false);
    };
    await selectAction("toggle-maximize");
    await placeOwned();
    await actionPress(fixture.windows[0]);
    await until(readOwned,isMaximized,"maximize shortcut");
    await actionPress(fixture.windows[0]);
    await until(readOwned,w=>!isMaximized(w)&&Object.keys(initial).every(k=>w.rect[k]===initial[k]),"restore shortcut");
    assert.deepEqual((await readOwned()).rect,initial);
    checks.push("native maximize/restore shortcut preserves the original floating rectangle");

    if (monitorAreas.length > 1) {
    await actionPress(fixture.windows[0]);
    await until(readOwned,isMaximized,"maximize before push");
    await native("pointer",{x:area.x+25,y:area.y+25});
    await press(13);
    await until(async()=>({window:await readOwned(),pointer:await native("pointer_position")}),
        ({window:w,pointer:p})=>p.x===Math.round(w.workArea.x+w.workArea.width/2)&&p.y===Math.round(w.workArea.y+w.workArea.height/2),
        "push finishes placement before centering the pointer");
    assert.ok(isMaximized(await readOwned()),"Push must preserve maximization before history pull");
    // Changing the state before pull makes restoration observable.
    await placeOwned();
    await pauseReloadResume();
    await press(15);
    await until(readOwned,w=>isMaximized(w)&&w.active,"history pull restores maximized state");
    checks.push("native push and history pull preserve a maximized window");
    await actionPress(fixture.windows[0]);
    await until(readOwned,w=>!isMaximized(w)&&Object.keys(initial).every(k=>w.rect[k]===initial[k]),"restore after maximized push and history pull");
    assert.deepEqual((await readOwned()).rect,initial,"Restore must use the original toggle's floating rectangle after intervening moves");
    checks.push("native maximize toggle retains floating geometry through maximized push and history pull");
    checks.push("native pause and configuration reload preserve push history and saved maximize geometry");
    } else {
        skipped.push("Maximized push and history preservation require a second display");
    }
    await placeOwned();
    await selectAction("pull-app");
    await actionPress(fixture.windows[1]);
    await until(readOwned,w=>w.active,"focus-last pulls the selected app");
    await actionPress(fixture.windows[0]);
    await until(readSecond,w=>w.active,"focus-last returns to previous window");
    await actionPress(fixture.windows[1]);
    await until(readOwned,w=>w.active,"focus-last returns to selected app again");
    checks.push("native app pull focus-last toggles between the selected and previous windows");
    await pauseReloadResume();
    await actionPress(fixture.windows[0]);
    await until(readSecond,w=>w.active,"focus-last survives pause and configuration reload");
    checks.push("native pause and configuration reload preserve the previous focus target");

    for (const action of ["pull-app","focus-app"]) {
        await selectAction(action);
        await native("minimize",{window:fixture.windows[0]});
        await until(readOwned,w=>w.minimized,"minimized target is still discoverable");
        await actionPress(fixture.windows[1]);
        await until(readOwned,w=>w.active&&!w.minimized,action+" restores a minimized window");
        assert.deepEqual((await readOwned()).rect,initial);
    }
    checks.push("native pull-app and focus-app recover minimized windows without changing their floating rectangle");

    if (monitorAreas.length === 1) {
        actionBinding.mainMonitorAction = "burner";
        await evaluate("window.__warpActionErrors=[]; window.__TAURI__.event.listen('warp-error',e=>window.__warpActionErrors.push(e.payload))");
        for (const layout of ["float","tile-left","tile-right","fullscreen"]) {
            actionBinding.burnerLayout = layout;
            await selectAction("pull-app");
            await actionPress(fixture.windows[1]);
            await until(readOwned,w=>w.active,"burner binding pulls the target before its second tap");
            await actionPress(fixture.windows[0]);
            // The successful single-monitor second tap deliberately has no
            // visible transition; allow key-release dispatch to settle.
            await sleep(250);
            assert.equal((await readOwned()).active,true);
            assert.deepEqual((await readOwned()).rect,initial);
            assert.equal(isMaximized(await readOwned()),false);
        }
        assert.deepEqual(await evaluate("window.__warpActionErrors"),[]);
        checks.push("all burner layouts retain the active window on a single-monitor desktop");
    } else {
        actionBinding.mainMonitorAction = "burner";
        actionConfig.settings.mainMonitor = ownedWindow.monitor;
        const burnerIndex = monitorAreas.findIndex((_,index)=>index+1!==ownedWindow.monitor);
        actionConfig.settings.burnerMonitor = burnerIndex+1;
        const burnerArea = monitorAreas[burnerIndex];
        const sameRect = (left,right) => Object.keys(right).every(key=>left[key]===right[key]);
        const round = value => value<0 ? -Math.round(-value) : Math.round(value);
        // A pull from the burner scales its current placement back to main;
        // it does not recover the rectangle from before a burner tile.
        const relativeRect = (rect,source,target) => {
            const width = Math.max(1,Math.min(target.width,round(rect.width/source.width*target.width)));
            const height = Math.max(1,Math.min(target.height,round(rect.height/source.height*target.height)));
            return {x:Math.max(target.x,Math.min(target.x+target.width-width,target.x+round((rect.x-source.x)/source.width*target.width))),
                y:Math.max(target.y,Math.min(target.y+target.height-height,target.y+round((rect.y-source.y)/source.height*target.height))),width,height};
        };
        const coversArea = (rect,target) => rect.x<=target.x && rect.y<=target.y
            && rect.x+rect.width>=target.x+target.width && rect.y+rect.height>=target.y+target.height;
        const readBurnerTarget = async () => {
            const window = await readOwned();
            assert.ok(window && window.id===ownedWindow.id && window.pid===fixture.pid,"Burner target must retain the fixture HWND/PID");
            return window;
        };
        await evaluate("window.__warpActionErrors=[]; window.__TAURI__.event.listen('warp-error',e=>window.__warpActionErrors.push(e.payload))");
        for (const [layout,startMaximized] of [["float",false],["float",true],["tile-left",true],["tile-right",true],["fullscreen",false]]) {
            await placeOwned();
            await until(readBurnerTarget,w=>w.monitor===ownedWindow.monitor && !isMaximized(w) && sameRect(w.rect,initial),"burner starts from the owned main-monitor rectangle");
            if (startMaximized) {
                await selectAction("toggle-maximize");
                await actionPress(fixture.windows[0]);
                await until(readBurnerTarget,isMaximized,"maximize the owned burner source");
            }
            actionBinding.burnerLayout = layout;
            await selectAction("pull-app");
            await actionPress(fixture.windows[1]);
            const source = await until(readBurnerTarget,w=>w.active && w.monitor===ownedWindow.monitor,"first burner tap focuses the owned target on main");
            assert.equal(isMaximized(source),startMaximized,"The first tap must preserve the source maximize state");
            assert.deepEqual(source.workArea,monitorAreas[ownedWindow.monitor-1]);
            const half = Math.floor(burnerArea.width/2);
            const expected = layout==="tile-left" ? {...burnerArea,width:half}
                : layout==="tile-right" ? {...burnerArea,x:burnerArea.x+half,width:burnerArea.width-half}
                : relativeRect(source.rect,source.workArea,burnerArea);
            const expectMaximized = layout==="fullscreen" || (layout==="float" && startMaximized);
            await actionPress(fixture.windows[0]);
            const sent = await until(readBurnerTarget,w=>w.active && w.monitor===burnerIndex+1
                && isMaximized(w)===expectMaximized && (expectMaximized ? coversArea(w.rect,burnerArea) : sameRect(w.rect,expected)),
                `${layout} burner placement${startMaximized ? " from maximized" : ""}`);
            assert.deepEqual(sent.workArea,burnerArea);
            assert.equal(sent.minimized,false);
            if (!expectMaximized) assert.deepEqual(sent.rect,expected);
            // Maximized Win32 frames include non-client borders outside the
            // work area; maximize state plus coverage avoids assuming a DPI.
            const returnedRect = relativeRect(sent.rect,burnerArea,source.workArea);
            await native("pointer",{x:burnerArea.x+25,y:burnerArea.y+25});
            await actionPress(fixture.windows[0]);
            const returned = await until(readBurnerTarget,w=>w.active && w.monitor===ownedWindow.monitor
                && isMaximized(w)===expectMaximized && (expectMaximized ? coversArea(w.rect,source.workArea) : sameRect(w.rect,returnedRect)),
                `${layout} burner return pull preserves current relative geometry and maximize state`);
            assert.deepEqual(returned.workArea,source.workArea);
            await until(()=>native("pointer_position"),p=>p.x===round(source.workArea.x+source.workArea.width/2)
                && p.y===round(source.workArea.y+source.workArea.height/2),"burner return pull centers the pointer on main");
            checks.push(`native two-monitor ${layout} burner${startMaximized ? " from maximized" : ""} and return pull preserve expected geometry and maximize state`);
        }
        assert.deepEqual(await evaluate("window.__warpActionErrors"),[]);
        await placeOwned();
    }
    const closeWindow = await native("close_fixture");
    await selectAction("close-window");
    await actionPress(closeWindow);
    const vetoed = await until(()=>native("close_status"),s=>s.requests===1,"graceful close sends WM_CLOSE");
    assert.equal(vetoed.exists,true,"The application may refuse a close request");
    await native("close_status",{allow:true});
    await actionPress(closeWindow);
    await until(()=>native("close_status"),s=>s.requests===2&&!s.exists,"accepted graceful close destroys only its window");
    assert.ok(await readOwned(),"Other windows in the same process must survive graceful close");
    checks.push("native graceful close respects a veto and leaves sibling windows running after acceptance");
    await invoke("set_enabled",{enabled:false});
    await invoke("save_config",{config:matchConfig});
    const previousStore = await invoke("get_workspaces");
    const packaged = structuredClone(store.profiles[0]);
    packaged.id = "packaged-fixture"; packaged.name = "Packaged application fixture";
    packaged.items = [packaged.items[0]];
    const packagedItem = packaged.items[0];
    const missingId = "WindowWarpNonexistentFixture_abc!App";
    packagedItem.window.desktopId = missingId;
    packagedItem.launch = {kind:"packaged-app",program:missingId,args:[],workingDirectory:"",newWindow:true};
    await invoke("save_workspaces",{store:{version:1,profiles:[packaged]}});
    const failedActivation = await invoke("restore_workspace",{id:packaged.id});
    assert.equal(failedActivation.length,1);
    assert.equal(failedActivation[0].restored,false);
    assert.equal(failedActivation[0].launched,false);
    assert.match(failedActivation[0].error,/Cannot activate packaged application/);
    checks.push("missing packaged activation reports an individual restore failure without an error dialog");

    const calculatorId = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
    const registered = spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",`[bool](Get-StartApps | Where-Object { $_.AppID -eq '${calculatorId}' })`],{windowsHide:true,encoding:"utf8",timeout:10000});
    if (registered.status !== 0 || registered.stdout.trim() !== "True") {
        skipped.push("Calculator packaged fixture is unavailable or its registration could not be verified");
    } else {
        packagedItem.label = "Owned Calculator";
        packagedItem.window.desktopId = calculatorId;
        packagedItem.window.appId = "CalculatorApp.exe";
        packagedItem.window.title = "";
        packagedItem.window.path = "";
        const area = packagedItem.window.workArea;
        // Calculator enforces a DPI-scaled minimum size. Use the work area's
        // available dimensions rather than a fixed 600px height below that limit.
        packagedItem.window.rect = {x:area.x+20,y:area.y+20,width:area.width-40,height:area.height-40};
        packagedItem.launch.program = calculatorId;
        await invoke("save_workspaces",{store:{version:1,profiles:[packaged]}});
        // This helper checks both windows and processes immediately before
        // activation, retaining process creation times and the preexisting set.
        calculatorPrepared = await native("calculator_begin");
        if (!calculatorPrepared) {
            skipped.push("Calculator is already running; packaged activation fixture leaves it untouched");
        } else {
            const activated = await invoke("restore_workspace",{id:packaged.id});
            assert.deepEqual(activated.map(r=>({restored:r.restored,launched:r.launched})),[{restored:true,launched:true}]);
            const calculator = await until(async()=>(await invoke("get_windows")).filter(w=>w.desktopId===calculatorId),ws=>ws.length===1,"new packaged Calculator window");
            assert.deepEqual(calculator[0].rect,packagedItem.window.rect);
            const capture = await invoke("capture_workspace",{name:"Captured packaged fixture"});
            const item = capture.profile.items.find(i=>i.window.id===calculator[0].id);
            assert.ok(item,"Captured workspace includes the owned Calculator window");
            assert.equal(item.window.desktopId,calculatorId);
            assert.equal(item.launch.kind,"packaged-app");
            assert.equal(item.launch.program,calculatorId);
            capture.profile.items = [item];
            await invoke("save_workspaces",{store:{version:1,profiles:[capture.profile]}});
            const reused = await invoke("restore_workspace",{id:capture.profile.id});
            assert.deepEqual(reused.map(r=>({restored:r.restored,launched:r.launched})),[{restored:true,launched:false}]);
            assert.equal((await invoke("get_windows")).filter(w=>w.desktopId===calculatorId).length,1);
            const legacy = structuredClone(capture.profile);
            legacy.id = "legacy-package-fixture";
            const legacyItem = legacy.items[0];
            // Calculator may use ApplicationFrameHost for its current window;
            // model the historical INI path independently of that window owner.
            legacyItem.window.path = "C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_0.0.0.0_x64__8wekyb3d8bbwe\\CalculatorApp.exe";
            legacyItem.window.desktopId = "";
            legacyItem.launch.program = "";
            legacyItem.captureNote = "Legacy packaged fixture";
            const beforePackageImport = await invoke("get_workspaces");
            await evaluate(`window.reviewImportedWorkspace(${JSON.stringify(legacy)})`);
            assert.equal(await evaluate("document.querySelector('[data-launch=program]').value"),calculatorId);
            assert.deepEqual(await invoke("get_workspaces"),beforePackageImport,"Resolution must only prepare a review draft");
            await evaluate("document.querySelector('#save-workspace').click()");
            await until(()=>invoke("get_workspaces"),s=>s.profiles.some(p=>p.id===legacy.id),"explicit package import save");
            const importedPackage = (await invoke("get_workspaces")).profiles.find(p=>p.id===legacy.id).items[0];
            assert.equal(importedPackage.launch.program,calculatorId);
            assert.equal(importedPackage.window.desktopId,calculatorId);
            assert.equal(importedPackage.window.path,legacyItem.window.path);
            checks.push("legacy package review resolves a stale versioned path to its registered AUMID without saving until explicit Save");
            assert.equal(await native("calculator_cleanup"),1);
            calculatorPrepared = false;
            checks.push("native packaged Calculator activation captures its real AUMID, restores placement, reuses its window and closes only the new fixture");
        }
    }
    await invoke("save_workspaces",{store:previousStore});
    } else {
        skipped.push(computerTapOnly ? "General native checks omitted by --computer-tap-only" : holdEditorOnly ? "General native checks omitted by --hold-editor-only" : holdLetterOnly ? "General native checks omitted by --hold-letter-only" : fastOnly ? "General native checks omitted by --fast-only" : hookOnly ? "General native checks omitted by --hook-only" : chooserOnly ? "General native checks omitted by --chooser-only" : quickOnly ? "General native checks omitted by --quick-only" : "General native checks omitted by --firefox-only");
    }
    if (uxOnly) {
        const initialConfig = await invoke('get_config');
        assert.equal(await evaluate("[...document.querySelectorAll('.binding .chord')].every(chord=>chord.scrollWidth<=chord.clientWidth)"),true,
            'Full shortcut chords must remain visible in the list');
        checks.push('long shortcut chords remain visible in the native list');
        await evaluate("(() => {const field=document.querySelector('[data-field=enabled]');field.checked=false;field.dispatchEvent(new Event('input',{bubbles:true}));})()");
        await click('#enable-all-shortcuts');
        assert.equal(await evaluate("[...document.querySelectorAll('[data-field=enabled]')].every(field=>field.checked)"),true);
        await click('#discard');
        await click('#select-shortcuts');
        await click('.binding:nth-child(1) .select-binding');
        await click('.binding:nth-child(2) .select-binding');
        await click('#disable-selected-shortcuts');
        assert.equal(await evaluate("[...document.querySelectorAll('[data-field=enabled]')].slice(0,2).every(field=>!field.checked)"),true);
        await sleep(350); await screenshot('ux-shortcut-bulk.png');
        await click('#remove-selected-shortcuts');
        await wait("!document.querySelector('#confirm-remove-shortcuts').hidden",'bulk removal confirmation');
        await click('#confirm-remove-shortcuts-button');
        assert.equal(await evaluate("document.querySelectorAll('.binding').length"),initialConfig.bindings.length-2);
        await click('#discard');
        assert.equal(await evaluate("document.querySelectorAll('.binding').length"),initialConfig.bindings.length);
        assert.deepEqual(await invoke('get_config'),initialConfig,'bulk edits remain a draft until saved');
        await click('#add');
        assert.equal(await evaluate("document.activeElement.dataset.field"),'label','adding a shortcut focuses its name field');
        await click('#discard');
        checks.push('bulk shortcut changes are scoped, confirmed for removal and reversible until saved');

        await click('#show-settings');
        await click('#monitor-settings > summary');
        await wait("!document.querySelector('#main-monitor').disabled",'named monitors detected');
        const monitorOptions = await invoke('get_monitors');
        assert.ok(monitorOptions.length && monitorOptions.every(monitor=>monitor.name && monitor.id));
        const selectedMonitor = monitorOptions.find(monitor=>!monitor.primary) || monitorOptions[0];
        assert.ok(await evaluate(`document.querySelector('#main-monitor').textContent.includes(${JSON.stringify(selectedMonitor.name)})`));
        await input('#main-monitor',String(selectedMonitor.index));
        await click('#save-settings');
        await wait("document.querySelector('#settings-message').textContent.startsWith('Saved.')",'named monitor saved');
        assert.equal((await invoke('get_config')).settings.mainMonitorId,selectedMonitor.id);
        await screenshot('ux-monitor-settings.png');
        checks.push('native settings detect named monitors and save the chosen display identity');

        const capture = await invoke('capture_workspace',{name:'UX fixture workspace'});
        capture.profile.items = capture.profile.items.filter(item=>item.window.pid===fixture.pid).slice(0,1);
        assert.equal(capture.profile.items.length,1,'Workspace uses only a fixture-owned window');
        await invoke('save_workspaces',{store:{version:1,profiles:[capture.profile]}});
        await click('#show-workspaces');
        await wait("document.querySelector('#workspace-list .workspace-card') !== null",'owned workspace');
        await click('.workspace-card [data-action=restore]');
        await wait("document.querySelector('.workspace-card .workspace-card-status').textContent.startsWith('Opened ')",'workspace restore completes',30000);
        await wait("!document.querySelector('.workspace-card .workspace-open-on').hidden && document.querySelector('.workspace-card .workspace-open-on').textContent.startsWith('Windows on:')",'workspace desktop location',30000);
        assert.equal(await invoke('current_desktop_workspace'),capture.profile.id);
        checks.push('opening a workspace marks the workspace associated with this desktop');
        await click('.workspace-card .menu-button'); await click('.workspace-card [data-action=edit]');
        await wait("!document.querySelector('#workspace-editor').hidden",'workspace draft');
        assert.equal(await evaluate("document.querySelector('.workspace-card .workspace-action-menu').hidden"),true);
        const areas = await invoke('get_import_monitors');
        let targetMonitor = null;
        if (areas.length > 1) {
            await wait("!document.querySelector('.window-placement').hidden && document.querySelector('.window-placement').options.length > 1",'monitor selector');
            targetMonitor = capture.profile.items[0].window.monitor === 1 ? 2 : 1;
            await evaluate(`(() => {const field=document.querySelector('.window-placement');field.value=${JSON.stringify(String(targetMonitor))};field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
            assert.equal((await invoke('get_workspaces')).profiles[0].items[0].window.monitor,capture.profile.items[0].window.monitor);
        } else skipped.push('Moving an owned workspace window to another monitor requires two displays');
        await sleep(350); await screenshot('ux-workspace-monitor.png');
        await click('.workspace-item-toggle');
        assert.equal(await evaluate("document.querySelector('.workspace-window-options > details:last-child').open"),true);
        await evaluate("document.querySelector('#workspace-editor').scrollIntoView({block:'start'})");
        await sleep(350); await screenshot('ux-workspace-expanded.png');
        await input('#workspace-name',''); await click('#save-workspace');
        await wait("!document.querySelector('#workspace-save-status').hidden && document.querySelector('#workspace-save-status').classList.contains('error')",'noticeable workspace save error');
        assert.equal(await evaluate("document.querySelector('#workspace-save-status').textContent"),'Give this workspace a name.');
        await screenshot('ux-workspace-error.png');
        await input('#workspace-name','UX fixture workspace'); await click('#save-workspace');
        await wait("document.querySelector('#workspace-editor').hidden",'workspace draft saved');
        if (targetMonitor) {
            const saved = (await invoke('get_workspaces')).profiles[0].items[0].window;
            assert.equal(saved.monitor,targetMonitor); assert.equal(saved.monitorName,'');
            assert.deepEqual(saved.rect,capture.profile.items[0].window.rect);
            assert.deepEqual(saved.workArea,capture.profile.items[0].window.workArea);
            await invoke('restore_workspace',{id:capture.profile.id});
            await until(async()=>(await invoke('get_windows')).find(window=>window.id===saved.id),window=>window?.monitor===targetMonitor,'owned window opens on selected monitor',30000);
            checks.push('workspace monitor selector saves and restores the owned window on the selected monitor');
        }
        checks.push('workspace editor exposes related options and identifies save errors in context');
    }
    if (runFirefox) {
        await testFirefox({output,marker,native,invoke,evaluate,wait,click,screenshot,until,checks,report,profileLock:firefoxProfileLock});
    }
    if (chromiumOnly) {
        await testChromium({output,marker,invoke,until,checks,report,evaluate,click,input,wait,screenshot,cdp,native,focusFixture:()=>native('focus',{window:fixture.windows[0]})});
    }
    if (chooserOnly) {
        await click('#show-workspaces');
        await wait("document.querySelector('.saved-browser-card [data-action=add]') !== null",'saved browser');
        await click('.saved-browser-card [data-action=add]');
        await wait("document.querySelector('#saved-browser-destination').open && !document.querySelector('#saved-browser-new').disabled",'chooser ready');
        assert.equal(await evaluate("document.querySelector('#saved-browser-replace').disabled"),true);
        await evaluate("document.querySelectorAll('#saved-browser-targets .saved-browser-target')[1].querySelector('li').click()");
        assert.equal(await evaluate("document.querySelectorAll('#saved-browser-targets input')[1].checked"),true);
        await screenshot('chooser-select.png');
        await click('#saved-browser-destination-cancel');
        await wait("!document.querySelector('#saved-browser-destination').open",'chooser canceled');
        assert.equal((await invoke('get_workspaces')).profiles[0].items[1].browser.tabs[0].url,'https://example.net/');
        await click('.saved-browser-card [data-action=add]');
        await wait("document.querySelector('#saved-browser-destination').open && !document.querySelector('#saved-browser-new').disabled",'chooser reopened');
        await evaluate("document.querySelectorAll('#saved-browser-targets .saved-browser-target')[1].querySelector('li').click()");
        const window=await native('app_window');
        let replaceKey=()=>native('chooser_press',{window,key:82,gap_ms:30});
        try { await replaceKey(); }
        catch (error) {
            if (!/Owned title bar is covered|could not take focus/.test(String(error))) throw error;
            skipped.push('Windows denied focus for the owned keyboard fixture; Ctrl+Shift+R was sent to the WebView only');
            replaceKey=async()=>{
                await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'R',code:'KeyR',modifiers:10,windowsVirtualKeyCode:82});
                await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'R',code:'KeyR',modifiers:10,windowsVirtualKeyCode:82});
            };
            await replaceKey();
        }
        const saved=await until(()=>invoke('get_workspaces'),store=>store.profiles[0].items[1].browser.tabs[0].url==='https://example.com/','replacement',10000);
        assert.equal(saved.profiles[0].items[0].browser.tabs[0].url,'https://example.org/');
        checks.push('clicking a browser card selects it; Cancel preserves tabs and Ctrl+Shift+R replaces only the selected browser');
    }
    if (firefoxExtensionOnly) {
        await testFirefoxExtension({output,marker,native,fixtureWindow:fixture.windows[0],invoke,until,checks,report,evaluate,click,input,wait,focusFixture:()=>native('focus',{window:fixture.windows[0]})});
    }
    // Exercise the real native tray callback/menu route before failure-only
    // process cleanup below. This does not click Explorer's notification area.
    if (!quickOnly) {
    const lifecycleWindow = await native("app_window");
    const lifecycleConfig = await invoke("get_config"), lifecycleStore = await invoke("get_workspaces");
    await invoke("set_enabled",{enabled:true});
    await native("app_close",{window:lifecycleWindow});
    await until(()=>native("app_state",{window:lifecycleWindow}),s=>!s.visible,"hide editor before tray Open");
    report.tray = [await native("tray_menu",{action:"open"})];
    await until(()=>native("app_state",{window:lifecycleWindow}),s=>s.visible&&s.foreground,"native tray Open restores the same editor");
    assert.deepEqual(await invoke("get_config"),lifecycleConfig);
    assert.deepEqual(await invoke("get_workspaces"),lifecycleStore);
    checks.push("owned native tray callback and observed Open menu item reopen the same editor");
    await assert.rejects(()=>native("reserve",{key:0x7c})); // Active F13 action.
    report.tray.push(await native("tray_menu",{action:"pause"}));
    await paused(true);
    await native("reserve",{key:0x7c}); await native("release",{key:0x7c});
    await assert.rejects(()=>native("reserve",{key:0x81})); // Pause F18 remains registered.
    checks.push("native tray Pause releases action keys while preserving the pause key");
    report.tray.push(await native("tray_menu",{action:"enable"}));
    await paused(false);
    await assert.rejects(()=>native("reserve",{key:0x7c}));
    checks.push("native tray Enable restores shortcuts without opening the editor settings");
    const persisted = ["settings.json","workspaces.json"].map(name=>{
        const file=path.join(state,name); return {file,bytes:fs.existsSync(file)?fs.readFileSync(file):null};
    });
    report.tray.push(await native("tray_menu",{action:"quit"}));
    assert.equal(await exit(app,15000),0,"Tray Quit must complete a graceful successful process exit");
    for (const key of [0x7c,0x81]) {await native("reserve",{key});await native("release",{key});}
    for (const {file,bytes} of persisted) assert.deepEqual(fs.existsSync(file)?fs.readFileSync(file):null,bytes);
    checks.push("native tray Quit exits gracefully, releases action and pause keys, and preserves saved files before fallback cleanup");
    }
    report.passed = true;
} catch (error) {
    report.error = String(error.stack || error);
} finally {
    if (calculatorPrepared) {
        try {
            if (!native || helper?.exitCode !== null) throw new Error("Calculator cleanup helper is unavailable; inspect the owned fixture before continuing");
            await native("calculator_cleanup");calculatorPrepared=false;
        }
        catch (error) {report.passed=false;report.calculatorCleanupError=String(error);}
    }
    if (startupTouched && native && helper?.exitCode === null) {
        const actual = await native("startup_value").catch(()=>null);
        if (actual === `"${binary}" --startup`) {
            // Delete only the fixture value we just verified; no existing user entry is replaced.
            const result = spawnSync("reg.exe",["delete",String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,"/v","WindowWarp","/f"],{windowsHide:true,encoding:"utf8"});
            if (result.status !== 0) {report.passed=false;report.cleanupError="Could not remove the owned startup fixture entry";}
        }
    }
    if (socket) socket.close();
    if (slowBrowser?.exitCode === null) {spawnSync("taskkill.exe",["/PID",String(slowBrowser.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});await exit(slowBrowser,10000).catch(()=>{});}
    if (second?.exitCode === null) {spawnSync("taskkill.exe",["/PID",String(second.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});await exit(second,10000).catch(()=>{});}
    if (app?.exitCode === null) {spawnSync("taskkill.exe",["/PID",String(app.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});await exit(app,10000).catch(()=>{});}
    if (peerHelper?.exitCode === null) {peerHelper.stdin.end(); await exit(peerHelper,3000).catch(()=>peerHelper.kill());}
    if (helper?.exitCode === null) {
        if (native) {
            try {await native("reserve",{key:0x81});await native("release",{key:0x81});checks.push("process exit releases the native pause key");}
            catch (error) {report.passed=false;report.cleanupError=`Could not verify pause-key release after fixture exit: ${String(error)}`;}
        }
        helper.stdin.end(); await exit(helper,3000).catch(()=>helper.kill());
    }
    fs.closeSync(appLog);
    // The fixture copied its executable already; restore the ordinary debug build.
    const normalLog = fs.openSync(path.join(output,"restore-build.log"),"w");
    const normalEnv = {...process.env,CARGO_TARGET_DIR:buildTarget,CARGO_INCREMENTAL:"0",CARGO_BUILD_JOBS:"1"};
    delete normalEnv.TAURI_CONFIG;
    const normal = spawn(cargo,["rustc","--manifest-path","src-tauri/Cargo.toml","--offline","--features","tauri/custom-protocol","--","-C","debuginfo=0"],{
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
