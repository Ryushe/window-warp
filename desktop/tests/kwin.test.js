import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src-tauri/kwin/warp.js", import.meta.url), "utf8");
const controlSource = fs.readFileSync(new URL("../src-tauri/kwin/control.js", import.meta.url), "utf8");
const shortcutsSource = fs.readFileSync(new URL("../src-tauri/kwin/shortcuts.js", import.meta.url), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
function fixture(bindings, legacy = false, settings = {mainMonitor: 1, burnerMonitor: 2}, holdIds, nativeIds) {
    const states = new Map();
    const nativeRestore = new Map();
    const timers = [], clock = {now:Date.now()};
    function QTimer() { this.running=false; this.timeout={connect:callback=>{this.callback=callback;}}; timers.push(this); }
    QTimer.prototype.start=function(){this.running=true;};
    QTimer.prototype.stop=function(){this.running=false;};
    const left = { name: "left", geometry: { x: -1920, y: 0, width: 1920, height: 1080 } };
    const right = { name: "right", geometry: { x: 0, y: 40, width: 1081, height: 1920 } };
    const window = { internalId: "a", resourceClass: "firefox", desktopFileName: "firefox", output: left,
        frameGeometry: { x: -960, y: 0, width: 960, height: 1080 }, moveable: true, moveableAcrossScreens: true,
        resizeable: true, minimized: false, desktops: ["desktop-1"], activities: [],
        setMaximize(vertical,horizontal) {
            const prior=states.get(this) || {};
            if ((vertical || horizontal) && !prior.maximizeVertical && !prior.maximizeHorizontal) nativeRestore.set(this,clone(this.frameGeometry));
            if (!vertical && !horizontal && (prior.maximizeVertical || prior.maximizeHorizontal) && nativeRestore.has(this)) this.frameGeometry=clone(nativeRestore.get(this));
            states.set(this,{maximizeVertical:vertical,maximizeHorizontal:horizontal});
            const area=legacy ? [right,left][this.screen]?.geometry : this.output?.geometry;
            if(area) {
                if(horizontal) {this.frameGeometry.x=area.x;this.frameGeometry.width=area.width;}
                if(vertical) {this.frameGeometry.y=area.y;this.frameGeometry.height=area.height;}
            }
        } };
    function moved(win,output) {
        const state=states.get(win) || {};
        if(win.fullScreen || state.maximizeHorizontal) {win.frameGeometry.x=output.geometry.x;win.frameGeometry.width=output.geometry.width;}
        if(win.fullScreen || state.maximizeVertical) {win.frameGeometry.y=output.geometry.y;win.frameGeometry.height=output.geometry.height;}
    }
    const workspace = { screens: [right, left], stackingOrder: [window], activeWindow: window, currentDesktop: "desktop-1",
        clientArea: (_, output) => output.geometry,
        sendClientToScreen: (win, output) => { win.output = output; moved(win,output); } };
    if (legacy) {
        const outputs = workspace.screens;
        delete workspace.screens;
        delete workspace.activeWindow;
        workspace.activeClient = window;
        workspace.currentDesktop = 1;
        workspace.numScreens = outputs.length;
        workspace.clientList = () => workspace.stackingOrder;
        workspace.clientArea = (_, index) => outputs[index].geometry;
        workspace.sendClientToScreen = (win, index) => { win.screen = index; moved(win,outputs[index]); };
        window.screen = 1;
    }
    const shortcuts = new Map();
    const calls = [];
    const errors = [], stateReplies = [], stateRpc = {defer:false};
    const context = { workspace, QTimer, Date:{now:()=>clock.now}, KWin: { MaximizeArea: 0 }, print: error => errors.push(error),
        WARP_APP: {service:"fixture",token:"test",generation:"generation-1"}, callDBus: (...args) => {
            calls.push(args);
            if (args[3] === "Shortcut") {
                const invocation=JSON.parse(args[6]); invocation.generation=args[5];
                context.Warp.run(invocation.binding,invocation.settings,null,null,null,undefined,invocation);
            }
            if (args[3] === "getWindowInfo") {
                const target = workspace.stackingOrder.find(w=>String(w.internalId)===args[4] && !w.deleted);
                const info = target ? {uuid:String(target.internalId),maximizeHorizontal:false,maximizeVertical:false,...states.get(target)} : null;
                const reply = () => args.at(-1)(info);
                if (stateRpc.defer) stateReplies.push(reply); else reply();
            }
        },
        WARP_HOLD_IDS: holdIds, WARP_HOLD_NATIVE_IDS: nativeIds,
        WARP_CONFIG: { bindings, settings }, registerShortcut: (id, label, key, callback) => { shortcuts.set(label, { id, key, callback }); return true; } };
    vm.runInNewContext(source, context);
    context.Warp.configureSession("generation-1");
    const register=(generation="generation-1",rows=bindings)=>{
        const registration={...context,WARP_APP:{...context.WARP_APP,generation},WARP_CONFIG:{bindings:rows,settings}};
        delete registration.Warp;
        vm.runInNewContext(shortcutsSource,registration);
    };
    register();
    return { workspace, window, left, right, shortcuts, calls, states, errors, stateRpc, stateReplies, timers,
        tick(ms=25){clock.now+=ms;timers.filter(timer=>timer.running).forEach(timer=>timer.callback());},
        flush(){let count=0;while(stateReplies.length){assert.ok(++count<30,"state replies must settle");stateReplies.shift()();}},
        register, clock, context, warp:context.Warp, trigger: (label) => shortcuts.get("Window Warp: " + label).callback() };
}
const push = { label: "Push", shortcut: "Ctrl+Alt+Right", action: "push-right", appMatch: "" };
const pull = { label: "Pull", shortcut: "Ctrl+Alt+Down", action: "pull", appMatch: "" };

test("a late generation bootstrap cannot undo a newer session update",()=>{
    let bootstrap,dispatch;
    const generations=[],replies=[];
    vm.runInNewContext(controlSource,{
        WARP_CONTROL:{service:"fixture",token:"owned",action:"dispatch"},
        Warp:{configureSession:g=>generations.push(g)},print:()=>{},
        registerShortcut:(_id,_label,_key,callback)=>{dispatch=callback;return true;},
        callDBus:(_service,_path,_interface,method,...args)=>{
            if(method==="InputGeneration") bootstrap=args.at(-1);
            else if(method==="Next") args.at(-1)(JSON.stringify({id:1,expires:Date.now()+5000,command:{kind:"input-session",generation:"new"}}));
            else replies.push(JSON.parse(args.at(-1)));
        }
    });
    dispatch(); bootstrap(JSON.stringify("old"));
    assert.deepEqual(generations,["new"]);
    assert.deepEqual(replies,[{result:true}]);
});

for(const legacy of [false,true]) {
    test(`registration reload and pause retain owner history and saved maximize on Plasma ${legacy?5:6}`,()=>{
        const max={label:"Max",action:"toggle-maximize",shortcut:"Ctrl+M"};
        const f=fixture([max,push,pull],legacy);
        const original=clone(f.window.frameGeometry);
        f.trigger("Max"); f.trigger("Push");
        f.warp.configureSession(null);
        f.warp.configureSession("generation-2"); f.register("generation-2");
        f.trigger("Pull");
        assert.deepEqual(f.states.get(f.window),{maximizeHorizontal:true,maximizeVertical:true});
        f.trigger("Max");
        assert.deepEqual(clone(f.window.frameGeometry),original);
        assert.equal(legacy?f.window.screen:f.window.output,legacy?1:f.left);
        assert.deepEqual(f.errors,[]);
    });
    test(`pause cancels pending and queued input and ignores old replies on Plasma ${legacy?5:6}`,()=>{
        const f=fixture([],legacy),results=[];
        const invocation={generation:"generation-1",at:f.clock.now,window:{id:"a",pid:0},previous:{id:"a",pid:0}};
        f.stateRpc.defer=true;
        f.warp.run({action:"toggle-maximize"},null,null,null,null,(error,_result,cancelled)=>results.push({error,cancelled}),invocation);
        f.warp.run({action:"tile-right"},null,null,null,null,(error,_result,cancelled)=>results.push({error,cancelled}),invocation);
        const old=f.stateReplies.shift();
        f.warp.configureSession(null);
        assert.equal(results.length,2);
        assert.ok(results.every(result=>result.cancelled));
        f.warp.configureSession("generation-2"); f.stateRpc.defer=false;
        f.warp.run({action:"tile-left"},null,null,null,null,undefined,{...invocation,generation:"generation-2"});
        const current=clone(f.window.frameGeometry);
        old();
        f.warp.run({action:"tile-right"},null,null,null,null,undefined,invocation);
        assert.deepEqual(clone(f.window.frameGeometry),current);
        assert.deepEqual(f.errors,[]);
        assert.ok(f.timers.every(timer=>!timer.running));
    });
    test(`retile fallback targets the window captured before its asynchronous reply on Plasma ${legacy?5:6}`,()=>{
        const f=fixture([{label:"Existing",shortcut:"Super+C",action:"tile-left"}],legacy);
        f.trigger("Existing");
        const fallback=f.calls.at(-1).at(-1);
        const other={...f.window,internalId:"other",pid:99,frameGeometry:{x:1,y:2,width:300,height:200}};
        f.workspace.stackingOrder.push(other);
        if(legacy)f.workspace.activeClient=other;else f.workspace.activeWindow=other;
        fallback(false);
        assert.equal(f.window.frameGeometry.x,-1920);
        assert.deepEqual(other.frameGeometry,{x:1,y:2,width:300,height:200});
    });
    test(`focus-last identity survives pause and rejects reused UUID with another PID on Plasma ${legacy?5:6}`,()=>{
        const binding={label:"App",shortcut:"Ctrl+J",action:"pull-app",appMatch:"firefox",mainMonitorAction:"focus-last"};
        const f=fixture([binding],legacy);
        const other={...f.window,internalId:"other",pid:7,resourceClass:"terminal",desktopFileName:"terminal"};
        f.workspace.stackingOrder.push(other);
        if(legacy)f.workspace.activeClient=other;else f.workspace.activeWindow=other;
        f.trigger("App");
        f.warp.configureSession(null); f.warp.configureSession("generation-2"); f.register("generation-2");
        f.trigger("App");
        assert.equal(legacy?f.workspace.activeClient:f.workspace.activeWindow,other);
        f.trigger("App");
        f.workspace.stackingOrder=[f.window,{...other,pid:8}];
        f.trigger("App");
        assert.equal(legacy?f.workspace.activeClient:f.workspace.activeWindow,f.window);
    });
    test(`workspace restores share the input queue and respect their caller deadline on Plasma ${legacy?5:6}`,()=>{
        const f=fixture([],legacy),results=[];
        const saved={rect:{x:-1500,y:100,width:500,height:400},workArea:clone(f.left.geometry),monitorName:legacy?"1":"left",monitor:1,maximizedHorizontal:false,maximizedVertical:false,fullscreen:false,minimized:false};
        f.stateRpc.defer=true;
        f.warp.run({action:"toggle-maximize"});
        f.warp.restore(f.window,saved,(error,result)=>results.push({error,result}),f.clock.now+10);
        f.tick(20); f.stateRpc.defer=false; f.flush();
        assert.match(results[0].error,/expired/);
        assert.deepEqual(f.states.get(f.window),{maximizeHorizontal:true,maximizeVertical:true});
        f.warp.restore(f.window,saved,(error,result)=>results.push({error,result}),f.clock.now+1800);
        assert.equal(results[1].error,null);
        assert.deepEqual(clone(results[1].result),saved.rect);
        assert.deepEqual(clone(f.window.frameGeometry),saved.rect);
    });
}

test("forwarded focus-app completes for both matching and missing windows",()=>{
    const f=fixture([]),results=[];
    const invocation={generation:"generation-1",at:f.clock.now,window:{id:"a",pid:0}};
    for(const appMatch of ["firefox","absent"]) f.warp.run({action:"focus-app",appMatch},null,null,null,null,error=>results.push(error),invocation);
    assert.equal(results[0],null);
    assert.match(results[1],/No matching/);
});

test("Windows selectors cannot fall back to a broader KDE app match",()=>{
    const f=fixture([]);
    const binding={label:"Windows import",shortcut:"Ctrl+Alt+J",action:"pull-app",appMatch:"firefox",windowsMatch:{className:"WindowsOnly"}};
    assert.throws(()=>f.warp.run(binding),/Windows window-match/);
    binding.action="focus-app";
    assert.throws(()=>f.warp.run(binding),/Windows window-match/);
});

for (const legacy of [false,true]) test(`radial selection preserves the pre-picker active window on Plasma ${legacy ? 5 : 6}`, () => {
    const binding = {label:"App",shortcut:"Ctrl+Alt+J",action:"pull-app",appMatch:"firefox",mainMonitorAction:"burner",burnerLayout:"tile-right"};
    const settings = {mainMonitor:1,burnerMonitor:2};
    const f = fixture([],legacy,settings);
    const picker = {internalId:"picker",resourceClass:"window-warp"};
    f.workspace.stackingOrder.push(picker);
    if (legacy) f.workspace.activeClient=picker; else f.workspace.activeWindow=picker;
    f.warp.run(binding,settings,null,f.window,f.window);
    assert.deepEqual(clone(f.window.frameGeometry),{x:540,y:40,width:541,height:1920});
    assert.equal(legacy ? f.workspace.activeClient : f.workspace.activeWindow,f.window);
    assert.throws(()=>f.warp.run(binding,settings,null,picker,f.window),/no longer matches/);
});

test("native editor focus selects only this process's normal window and reports mapping delays", () => {
    const owned = {pid:42,normalWindow:true};
    let windows = [{pid:42,normalWindow:false},{pid:7,normalWindow:true},owned];
    const focused = [], replies = [];
    let dispatch;
    vm.runInNewContext(controlSource, {
        WARP_CONTROL:{service:"fixture",token:"owned",ownPid:42,action:"dispatch"},
        Warp:{windows:()=>windows,focus:window=>focused.push(window)},
        print:()=>{}, registerShortcut:(_id,_label,_key,callback)=>{dispatch=callback;return true;},
        callDBus:(_service,_path,_interface,method,...args)=>{
            if (method === "InputGeneration") return;
            if (method === "Next") args.at(-1)(JSON.stringify({id:1,expires:Date.now()+5000,command:{kind:"focus-editor"}}));
            else replies.push(JSON.parse(args.at(-1)));
        }
    });
    dispatch();
    assert.deepEqual(focused,[owned]);
    assert.deepEqual(replies.at(-1),{result:true});
    windows = windows.slice(0,2);
    dispatch();
    assert.equal(focused.length,1);
    assert.deepEqual(replies.at(-1),{result:false});
});

for(const kind of ["app-pull","pull-selected"]) test(`control ${kind} replies only after Warp completion and propagates failure`,()=>{
    const owned={internalId:"a",pid:42}, replies=[];
    let dispatch, completion;
    vm.runInNewContext(controlSource,{
        WARP_CONTROL:{service:"fixture",token:"owned",ownPid:42,action:"dispatch"},
        Warp:{windows:()=>[owned],run:(...args)=>{completion=args[5];}},
        print:()=>{},registerShortcut:(_id,_label,_key,callback)=>{dispatch=callback;return true;},
        callDBus:(_service,_path,_interface,method,...args)=>{
            if(method==="InputGeneration") return;
            if(method==="Next") args.at(-1)(JSON.stringify({id:1,expires:Date.now()+5000,command:{kind,window:{id:"a",pid:42},binding:{action:"pull-app"}}}));
            else replies.push(JSON.parse(args.at(-1)));
        }
    });
    dispatch(); assert.deepEqual(replies,[]);
    completion("KWin did not confirm the requested window state.");
    assert.deepEqual(replies,[{error:"KWin did not confirm the requested window state."}]);
    dispatch(); assert.equal(replies.length,1);
    completion(null); assert.deepEqual(replies.at(-1),{result:true});
});

test("native hold binding captures its pointer and defers action to press/release handling", () => {
    const binding = {label:"App",shortcut:"Ctrl+Alt+J",action:"pull-app",appMatch:"firefox"};
    const f = fixture([binding],false,undefined,["owned-generation-0"]);
    f.workspace.cursorPos = {x:-1800,y:200};
    const original = clone(f.window.frameGeometry);
    f.trigger("App");
    assert.deepEqual(clone(f.window.frameGeometry),original);
    assert.equal(f.shortcuts.get("Window Warp: App").id,"window-warp-hold-0-Ctrl+Alt+J");
    assert.deepEqual(f.calls[0].slice(0,6),["fixture","/Control","com.windowwarp.Control","GesturePointer","test","owned-generation-0"]);
    f.workspace.cursorPos.x = 500;
    assert.deepEqual(JSON.parse(f.calls[0][6]),{x:-1800,y:200,previous:{id:"a",pid:0},generation:"generation-1"});
    const resumed = fixture([binding],false,undefined,["next-generation-0"]);
    assert.equal(resumed.shortcuts.get("Window Warp: App").id,f.shortcuts.get("Window Warp: App").id);
    resumed.workspace.cursorPos = {x:1,y:2};
    resumed.trigger("App");
    assert.equal(resumed.calls[0][5],"next-generation-0");
    const independent = fixture([binding],false,undefined,["private-callback"],["window-warp-gesture-1234"]);
    assert.equal(independent.shortcuts.get("Window Warp: App").id,"window-warp-gesture-1234");
    independent.workspace.cursorPos = {x:3,y:4};
    independent.trigger("App");
    assert.equal(independent.calls[0][5],"private-callback");
});

for (const legacy of [false,true]) test(`held app pull tiles on main using portrait pointer halves on Plasma ${legacy ? 5 : 6}`, () => {
    const binding = {label:"App",shortcut:"Ctrl+Alt+J",action:"pull-app",appMatch:"firefox",mainMonitorAction:"burner"};
    const settings = {mainMonitor:2,burnerMonitor:1};
    const f = fixture([],legacy,settings);
    f.right.geometry.height = 1921;
    f.warp.run(binding,settings,{x:-10000,y:1000});
    assert.deepEqual(clone(f.window.frameGeometry),{x:0,y:40,width:1081,height:960});
    f.warp.run(binding,settings,{x:10000,y:1001});
    assert.deepEqual(clone(f.window.frameGeometry),{x:0,y:1000,width:1081,height:961});
    assert.equal(legacy ? f.workspace.activeClient : f.workspace.activeWindow,f.window);
});

test("push scales placement across negative origins and portrait outputs; pull restores", () => {
    const f = fixture([push, pull]);
    const original = clone(f.window.frameGeometry);
    f.trigger("Push");
    assert.equal(f.window.output, f.right);
    assert.deepEqual(clone(f.window.frameGeometry), { x: 540, y: 40, width: 541, height: 1920 });
    f.trigger("Pull");
    assert.equal(f.window.output, f.left);
    assert.deepEqual(clone(f.window.frameGeometry), original);
});
test("pull skips closed windows", () => {
    const f = fixture([push, pull]);
    f.trigger("Push");
    f.workspace.stackingOrder = [];
    const before = clone(f.window.frameGeometry);
    f.trigger("Pull");
    assert.deepEqual(clone(f.window.frameGeometry), before);
});
test("pull adapts to a disconnected original monitor", () => {
    const f = fixture([push, pull]);
    f.trigger("Push");
    f.workspace.screens = [f.right];
    f.trigger("Pull");
    const rect = f.window.frameGeometry;
    assert.equal(f.window.output, f.right);
    assert.ok(rect.x >= f.right.geometry.x && rect.x + rect.width <= f.right.geometry.x + f.right.geometry.width);
});
test("odd-width tiling covers the entire usable width", () => {
    const f = fixture([{ label: "Left", shortcut: "Ctrl+Alt+J", action: "tile-left" }, { label: "Right", shortcut: "Ctrl+Alt+L", action: "tile-right" }]);
    f.window.output = f.right;
    f.trigger("Left");
    const left = clone(f.window.frameGeometry);
    f.trigger("Right");
    const right = clone(f.window.frameGeometry);
    assert.equal(left.x + left.width, right.x);
    assert.equal(left.width + right.width, f.right.geometry.width);
});
test("app matching is exact, cycles instances, and restores a minimized app", () => {
    const f = fixture([{ label: "Firefox", shortcut: "Super+F", action: "focus-app", appMatch: "FIREFOX" }]);
    const second = { ...f.window, internalId: "b", minimized: true, desktops: ["desktop-2"] };
    const unrelated = { ...f.window, internalId: "c", resourceClass: "firefox-helper", desktopFileName: "other" };
    f.workspace.stackingOrder = [unrelated, f.window, second];
    f.trigger("Firefox");
    assert.equal(f.workspace.activeWindow, second);
    assert.equal(second.minimized, false);
    assert.equal(f.workspace.currentDesktop, "desktop-2");
    f.trigger("Firefox");
    assert.equal(f.workspace.activeWindow, f.window);
    assert.equal(f.shortcuts.get("Window Warp: Firefox").key, "Meta+F");
});
test("one-monitor push wraps in place and still arms retiling", () => {
    const f = fixture([push]);
    f.workspace.screens = [f.left];
    const before = clone(f.window.frameGeometry);
    f.trigger("Push");
    assert.deepEqual(clone(f.window.frameGeometry), before);
    assert.equal(f.calls.filter(c=>c[3]==="ArmRetile").length,1);
});

test("Plasma 5 uses screen indexes and restores a pushed window", () => {
    const f = fixture([push, pull], true);
    const original = clone(f.window.frameGeometry);
    f.trigger("Push");
    assert.equal(f.window.screen, 0);
    assert.deepEqual(clone(f.window.frameGeometry), { x: 540, y: 40, width: 541, height: 1920 });
    f.trigger("Pull");
    assert.equal(f.window.screen, 1);
    assert.deepEqual(clone(f.window.frameGeometry), original);
    assert.equal(f.workspace.activeClient, f.window);
});

test("fullscreen capability flags do not block leaving fullscreen to tile", () => {
    const f = fixture([{label: "Tile", shortcut: "Ctrl+Alt+J", action: "tile-left"}]);
    f.window.fullScreen = true;
    f.window.moveable = false;
    f.window.resizeable = false;
    f.trigger("Tile");
    assert.equal(f.window.fullScreen, false);
    assert.equal(f.window.frameGeometry.width, 960);
});

test("top and bottom tiling cover odd-height work areas without gaps", () => {
    const f = fixture(["up", "down"].map(d => ({label:d, shortcut: "Ctrl+Alt+" + d, action: "tile-" + d})));
    f.left.geometry.height = 1081;
    f.trigger("up");
    const top = clone(f.window.frameGeometry);
    f.trigger("down");
    assert.equal(top.y + top.height, f.window.frameGeometry.y);
    assert.equal(top.height + f.window.frameGeometry.height, 1081);
});

for (const legacy of [false, true]) test(`app pull toggles between main and tiled burner on Plasma ${legacy ? 5 : 6}`, () => {
    const f = fixture([{label: "App", action: "pull-app", appMatch: "firefox", shortcut: "Ctrl+Alt+F", mainMonitorAction: "burner", burnerLayout: "tile-right"}], legacy);
    f.trigger("App");
    assert.equal(legacy ? f.window.screen : f.window.output, legacy ? 0 : f.right);
    assert.equal(f.window.frameGeometry.width, 541);
    f.trigger("App");
    assert.equal(legacy ? f.window.screen : f.window.output, legacy ? 1 : f.left);
    assert.equal(f.window.frameGeometry.width, 961);
});

test("focus-last remembers the previous application and ignores closed windows", () => {
    const f = fixture([{label: "App", action: "pull-app", appMatch: "firefox", shortcut: "Ctrl+Alt+F", mainMonitorAction: "focus-last"}]);
    const other = {...f.window, internalId: "other", resourceClass: "terminal", desktopFileName: "terminal"};
    f.workspace.stackingOrder.push(other);
    f.workspace.activeWindow = other;
    f.trigger("App");
    assert.equal(f.workspace.activeWindow, f.window);
    f.trigger("App");
    assert.equal(f.workspace.activeWindow, other);
    f.trigger("App");
    f.workspace.stackingOrder = [f.window];
    f.trigger("App");
    assert.equal(f.workspace.activeWindow, f.window);
});

test("disabled bindings do not register; punctuation keys use Qt syntax", () => {
    const f = fixture([{...push, enabled: false}, {label: "Punctuation", action: "tile-left", shortcut: "Super+Semicolon"}]);
    assert.equal(f.shortcuts.size, 1);
    assert.equal(f.shortcuts.get("Window Warp: Punctuation").key, "Meta+;");
});

test("maximize and close dispatch to compositor operations on the active fixture", () => {
    const f = fixture([{label:"Max", action:"toggle-maximize", shortcut:"Ctrl+Alt+M"}, {label:"Close", action:"close-window", shortcut:"Ctrl+Alt+Q"}]);
    let closed = false;
    f.window.closeWindow = () => { closed = true; };
    f.trigger("Max"); assert.deepEqual(f.states.get(f.window), {maximizeVertical:true,maximizeHorizontal:true});
    f.trigger("Max"); assert.deepEqual(f.states.get(f.window), {maximizeVertical:false,maximizeHorizontal:false});
    f.trigger("Close"); assert.equal(closed, true);
});

const maximize = {label:"Max",action:"toggle-maximize",shortcut:"Ctrl+Alt+M"};
for (const legacy of [false,true]) {
    test(`direct maximized history pull preserves state without a floating transition on Plasma ${legacy ? 5 : 6}`,()=>{
        const f=fixture([maximize,push,pull],legacy);
        f.trigger("Max"); f.trigger("Push");
        const normalSetMaximize=f.window.setMaximize.bind(f.window), requests=[];
        f.window.setMaximize=(v,h)=>{
            requests.push([v,h]);
            // Model the native same-size restore: false cannot acknowledge
            // without a resize. Direct maximized pull must never request it.
            if(v||h) normalSetMaximize(v,h);
        };
        f.trigger("Pull");
        assert.deepEqual(requests,[[true,true]]);
        assert.equal(legacy ? f.window.screen : f.window.output,legacy ? 1 : f.left);
        assert.deepEqual(clone(f.window.frameGeometry),clone(f.left.geometry));
        assert.deepEqual(f.states.get(f.window),{maximizeHorizontal:true,maximizeVertical:true});
        assert.ok(f.timers.every(timer=>!timer.running));
        assert.deepEqual(f.errors,[]);
    });
    test(`retile starts its full time window after delayed push acknowledgment on Plasma ${legacy ? 5 : 6}`,()=>{
        const startedAt=Date.now();
        const f=fixture([push],legacy);
        f.stateRpc.defer=true;
        f.trigger("Push");
        f.stateReplies.shift()(); // Initial query applies the move; acknowledgment remains pending.
        assert.equal(f.calls.filter(call=>call[3]==="ArmRetile").length,0);
        f.tick(1200);
        f.flush();
        const arms=f.calls.filter(call=>call[3]==="ArmRetile");
        assert.equal(arms.length,1);
        assert.ok(Number(arms[0][6])>=startedAt+1200,"arm timestamp reflects acknowledgment, not mutation time");
        assert.deepEqual(f.errors,[]);
    });
    test(`same-size Wayland restore uses saved geometry to trigger acknowledgment on Plasma ${legacy ? 5 : 6}`,()=>{
        const f=fixture([maximize,push,pull],legacy);
        const saved=clone(f.window.frameGeometry);
        f.trigger("Max"); f.trigger("Push"); f.warp.run({action:"tile-left"}); f.trigger("Pull");
        assert.deepEqual(f.states.get(f.window),{maximizeHorizontal:true,maximizeVertical:true});
        let geometry=clone(f.window.frameGeometry), awaitingResize=false;
        const writes=[];
        const normalSetMaximize=f.window.setMaximize.bind(f.window);
        f.window.setMaximize=(v,h)=>{
            if(!v&&!h) awaitingResize=true;
            else normalSetMaximize(v,h);
        };
        Object.defineProperty(f.window,"frameGeometry",{
            get:()=>geometry,
            set:rect=>{
                writes.push(clone(rect));
                geometry=clone(rect);
                if(awaitingResize && (rect.width!==f.left.geometry.width || rect.height!==f.left.geometry.height)) {
                    awaitingResize=false;
                    f.states.set(f.window,{maximizeHorizontal:false,maximizeVertical:false});
                    // The client acknowledges the configure with its own restore
                    // rectangle; Warp must reapply the saved rectangle afterward.
                    geometry={x:-1600,y:80,width:700,height:500};
                }
            }
        });
        f.trigger("Max");
        assert.deepEqual(writes,[saved,saved]);
        assert.deepEqual(clone(f.window.frameGeometry),saved);
        assert.deepEqual(f.states.get(f.window),{maximizeHorizontal:false,maximizeVertical:false});
        assert.deepEqual(f.errors,[]);
        assert.ok(f.timers.every(timer=>!timer.running));
    });
    test(`rapid toggles wait for compositor state and restore geometry on Plasma ${legacy ? 5 : 6}`,()=>{
        const f=fixture([maximize],legacy);
        const original=clone(f.window.frameGeometry), pending=[];
        const commit=f.window.setMaximize.bind(f.window);
        f.window.setMaximize=(v,h)=>pending.push([v,h]);
        f.trigger("Max"); f.trigger("Max");
        assert.deepEqual(pending,[[true,true]],"second toggle waits for the first commit");
        // State alone is insufficient: the frame is still the floating frame.
        f.states.set(f.window,{maximizeHorizontal:true,maximizeVertical:true});
        f.tick();
        assert.equal(pending.length,1);
        f.window.frameGeometry=clone(f.left.geometry);
        f.tick();
        assert.deepEqual(pending,[[true,true],[false,false]]);
        // Simulate the client's delayed built-in restore overwriting geometry.
        commit(false,false);
        f.window.frameGeometry={x:-1500,y:90,width:500,height:400};
        f.tick();
        assert.deepEqual(clone(f.window.frameGeometry),original,"saved geometry applies after the restore commit");
        assert.deepEqual(f.errors,[]);
        assert.ok(f.timers.every(timer=>!timer.running));
        const queries=f.calls.length; f.tick(5000);
        assert.equal(f.calls.length,queries,"there is no idle polling");
    });
    test(`queued app pull preserves its invocation identity after a pending maximize on Plasma ${legacy ? 5 : 6}`,()=>{
        const f=fixture([maximize],legacy);
        const commit=f.window.setMaximize.bind(f.window), pending=[];
        f.window.setMaximize=(v,h)=>pending.push([v,h]);
        f.trigger("Max");
        const results=[];
        f.warp.run({action:"pull-app",appMatch:"firefox",shortcut:"Ctrl+J",mainMonitorAction:"burner",burnerLayout:"float"},undefined,null,undefined,undefined,error=>results.push(error));
        const picker={internalId:"picker",pid:99,resourceClass:"picker"};
        f.workspace.stackingOrder.push(picker);
        if(legacy) f.workspace.activeClient=picker; else f.workspace.activeWindow=picker;
        assert.equal(legacy ? f.window.screen : f.window.output,legacy ? 1 : f.left);
        commit(true,true); f.tick();
        assert.equal(legacy ? f.window.screen : f.window.output,legacy ? 0 : f.right);
        assert.deepEqual(results,[null]);
        assert.deepEqual(f.errors,[]);
    });
    test(`missing initial replies time out, release queued work and ignore late callbacks on Plasma ${legacy ? 5 : 6}`,()=>{
        const f=fixture([],legacy), results=[];
        f.stateRpc.defer=true;
        f.warp.run(maximize,undefined,null,undefined,undefined,error=>results.push(error));
        f.tick(100);
        f.warp.run({action:"tile-left"});
        const late=f.stateReplies.shift();
        f.stateRpc.defer=false; f.tick(1700);
        assert.match(results[0],/1\.8 seconds/);
        assert.equal(results.length,1);
        const tiled=clone(f.window.frameGeometry);
        late();
        assert.deepEqual(clone(f.window.frameGeometry),tiled);
        assert.deepEqual(f.states.get(f.window),{maximizeHorizontal:false,maximizeVertical:false});
        assert.ok(f.timers.every(timer=>!timer.running));
    });
    test(`unacknowledged setters and closed targets release the queue on Plasma ${legacy ? 5 : 6}`,()=>{
        const f=fixture([],legacy), results=[];
        f.window.setMaximize=()=>{};
        f.warp.run(maximize,undefined,null,undefined,undefined,error=>results.push(error));
        f.tick(100);
        let closed=false; f.window.closeWindow=()=>{closed=true;};
        f.warp.run({action:"close-window"});
        f.tick(1700);
        assert.match(results[0],/1\.8 seconds/);
        assert.equal(closed,true);
        const diagnostic=JSON.parse(f.errors[0].split("; geometry ")[1]);
        assert.equal(diagnostic.action,"toggle-maximize");
        assert.equal(diagnostic.expected.horizontal,true);
        assert.equal(diagnostic.observed.horizontal,false);
        assert.deepEqual(diagnostic.observed.rect,clone(f.window.frameGeometry));
        assert.equal(f.errors.length,1,"failure logs one bounded diagnostic");
        assert.equal(results[0].includes("geometry {"),false,"public errors omit diagnostic data");
        assert.equal(JSON.stringify(diagnostic).includes("firefox"),false);
        f.warp.run(maximize,undefined,null,undefined,undefined,error=>results.push(error));
        f.workspace.stackingOrder=[]; f.tick();
        assert.match(results[1],/closed or changed identity/);
        assert.ok(f.timers.every(timer=>!timer.running));
    });
    test(`expired queued actions never mutate windows after a stalled operation on Plasma ${legacy ? 5 : 6}`,()=>{
        const f=fixture([],legacy), results=[], setters=[];
        const original=clone(f.window.frameGeometry);
        f.window.setMaximize=(v,h)=>setters.push([v,h]);
        f.warp.run(maximize,undefined,null,undefined,undefined,error=>results.push(error));
        f.warp.run({action:"tile-left"},undefined,null,undefined,undefined,error=>results.push(error));
        f.warp.run(maximize,undefined,null,undefined,undefined,error=>results.push(error));
        f.tick(1800);
        assert.equal(results.length,3);
        assert.match(results[0],/1\.8 seconds/);
        assert.ok(results.slice(1).every(error=>/expired while waiting/.test(error)));
        assert.deepEqual(setters,[[true,true]],"stale queued setters are never called");
        assert.deepEqual(clone(f.window.frameGeometry),original);
        assert.ok(f.timers.every(timer=>!timer.running));
        f.tick(10000);
        assert.equal(setters.length,1);
    });
    test(`numeric KWin maximize flags support zero and axis bit values on Plasma ${legacy ? 5 : 6}`,()=>{
        const f=fixture([maximize,push,pull],legacy);
        f.states.set(f.window,{maximizeHorizontal:0,maximizeVertical:0});
        f.trigger("Max");
        assert.deepEqual(f.states.get(f.window),{maximizeHorizontal:true,maximizeVertical:true});
        f.states.set(f.window,{maximizeHorizontal:1,maximizeVertical:2});
        f.trigger("Push");
        f.warp.run({action:"tile-left"});
        f.trigger("Pull");
        assert.deepEqual(f.states.get(f.window),{maximizeHorizontal:true,maximizeVertical:true});
        f.states.set(f.window,{maximizeHorizontal:2,maximizeVertical:1});
        f.trigger("Max");
        assert.deepEqual(f.states.get(f.window),{maximizeHorizontal:false,maximizeVertical:false});
        assert.deepEqual(f.errors,[]);
    });
    test(`maximize restores its exact saved rectangle/output after a maximized move on Plasma ${legacy ? 5 : 6}`,()=>{
        const f=fixture([maximize,push],legacy);
        const original=clone(f.window.frameGeometry);
        f.trigger("Max");
        f.window.frameGeometry=clone(f.left.geometry); // compositor's maximized geometry
        f.trigger("Push");
        f.window.frameGeometry=clone(f.right.geometry);
        f.trigger("Max");
        assert.deepEqual(clone(f.window.frameGeometry),original);
        assert.equal(legacy ? f.window.screen : f.window.output,legacy ? 1 : f.left);
        assert.deepEqual(f.states.get(f.window),{maximizeHorizontal:false,maximizeVertical:false});
        // Built-in maximize after a Warp restore must still reuse the saved
        // rectangle. Restoration does not consume AHK's Saved entry.
        f.window.setMaximize(true,true);
        f.window.frameGeometry=clone(f.right.geometry);
        if(legacy) f.window.screen=0; else f.window.output=f.right;
        f.trigger("Max");
        assert.deepEqual(clone(f.window.frameGeometry),original);
        // A later Warp maximize from a new floating position replaces it.
        const changed={x:-1800,y:90,width:600,height:450};
        f.window.frameGeometry=clone(changed);
        f.trigger("Max"); f.window.frameGeometry=clone(f.left.geometry); f.trigger("Max");
        assert.deepEqual(clone(f.window.frameGeometry),changed);
    });
    test(`built-in maximized windows restore through KWin without an invented rectangle on Plasma ${legacy ? 5 : 6}`,()=>{
        const f=fixture([maximize],legacy);
        const nativeRestore={x:-1700,y:80,width:700,height:500};
        f.window.setMaximize(true,true);
        f.window.frameGeometry=clone(f.left.geometry);
        const setMaximize=f.window.setMaximize;
        f.window.setMaximize=function(v,h){setMaximize.call(this,v,h);if(!v&&!h)this.frameGeometry=clone(nativeRestore);};
        f.trigger("Max");
        assert.deepEqual(clone(f.window.frameGeometry),nativeRestore);
        assert.deepEqual(f.states.get(f.window),{maximizeHorizontal:false,maximizeVertical:false});
    });
    test(`history restores full, per-axis and floating maximize state after tiling on Plasma ${legacy ? 5 : 6}`,()=>{
        for(const [vertical,horizontal,fullscreen] of [[true,true,false],[true,false,false],[false,true,false],[false,false,false],[false,false,true]]) {
            const f=fixture([push,pull],legacy);
            f.window.setMaximize(vertical,horizontal); f.window.fullScreen=fullscreen;
            if(fullscreen) f.window.frameGeometry=clone(f.left.geometry);
            const original=clone(f.window.frameGeometry);
            f.trigger("Push");
            f.warp.run({action:"tile-right"});
            f.trigger("Pull");
            assert.deepEqual(f.states.get(f.window),{maximizeVertical:vertical,maximizeHorizontal:horizontal});
            assert.equal(f.window.fullScreen,fullscreen);
            assert.deepEqual(clone(f.window.frameGeometry),original);
            assert.equal(legacy ? f.window.screen : f.window.output,legacy ? 1 : f.left);
        }
    });
    test(`queued push/pull and double toggle preserve shortcut order on Plasma ${legacy ? 5 : 6}`,()=>{
        const f=fixture([push,pull,maximize],legacy);
        const original=clone(f.window.frameGeometry);
        f.stateRpc.defer=true;
        f.trigger("Push"); f.trigger("Pull");
        assert.equal(f.stateReplies.length,1);
        f.flush();
        assert.deepEqual(clone(f.window.frameGeometry),original);
        assert.equal(legacy ? f.window.screen : f.window.output,legacy ? 1 : f.left);
        f.trigger("Max"); f.trigger("Max");
        assert.equal(f.stateReplies.length,1);
        f.flush();
        assert.deepEqual(f.states.get(f.window),{maximizeVertical:false,maximizeHorizontal:false});
        assert.deepEqual(clone(f.window.frameGeometry),original);
    });
    test(`a failed maximize-state reply leaves placement alone and releases queued work on Plasma ${legacy ? 5 : 6}`,()=>{
        const f=fixture([maximize],legacy);
        const original=clone(f.window.frameGeometry);
        f.stateRpc.defer=true;
        f.trigger("Max");
        f.warp.run({action:"tile-left"});
        const pending=f.calls.find(c=>c[3]==="getWindowInfo");
        f.stateReplies.shift();
        pending.at(-1)(null);
        assert.equal(f.errors.length,1);
        assert.match(f.errors[0],/maximize state/);
        assert.deepEqual(clone(f.window.frameGeometry),{...original,x:-1920,width:960});
        f.stateRpc.defer=false;
        f.flush();
        f.trigger("Max");
        assert.deepEqual(f.states.get(f.window),{maximizeVertical:true,maximizeHorizontal:true});
    });
    test(`closed or replaced identities cannot receive queued actions or old restore geometry on Plasma ${legacy ? 5 : 6}`,()=>{
        const f=fixture([push,pull,maximize],legacy);
        f.window.pid=10;
        f.trigger("Max"); f.trigger("Push");
        f.window.deleted=true;
        const replacement={...f.window,deleted:false,pid:11,frameGeometry:{x:11,y:22,width:333,height:444}};
        f.workspace.stackingOrder=[replacement];
        if(legacy) f.workspace.activeClient=replacement; else f.workspace.activeWindow=replacement;
        const before=clone(replacement.frameGeometry);
        f.trigger("Pull");
        assert.deepEqual(clone(replacement.frameGeometry),before);
        replacement.setMaximize(true,true);
        f.trigger("Max");
        assert.deepEqual(clone(replacement.frameGeometry),before,"stale saved maximize rectangle must not apply");
        f.stateRpc.defer=true;
        f.trigger("Push");
        f.workspace.stackingOrder=[];
        f.stateReplies.shift()();
        assert.deepEqual(clone(replacement.frameGeometry),before,"closing during state lookup cancels the action");
        assert.equal(f.errors.length,1);
        assert.match(f.errors[0],/closed or changed identity/);
    });
}

test("application controls use the native bridge even when no desktop window is active", () => {
    const f = fixture([{label:"Pause",shortcut:"Ctrl+Alt+P",action:"toggle-pause"}]);
    f.workspace.activeWindow = null;
    f.workspace.screens = [];
    f.trigger("Pause");
    assert.deepEqual(f.calls[0], ["fixture","/Control","com.windowwarp.Control","Action","test","toggle-pause"]);
});

for (const legacy of [false,true]) test(`pointer centers only on requested push and pull-to-main on Plasma ${legacy ? 5 : 6}`, () => {
    const centerPush = {...push,action:"push-left-center"};
    const f = fixture([centerPush,pull],legacy);
    const centers = () => f.calls.filter(c=>c[3]==="CenterPointer").map(c=>JSON.parse(c[5]));
    f.trigger("Push");
    assert.deepEqual(centers(),[{x:541,y:1000}]);
    f.trigger("Pull");
    assert.deepEqual(centers().at(-1),{x:-960,y:540}); // no origin output: first sorted output
    f.warp.run(push);
    assert.equal(centers().length,2,"ordinary push leaves pointer alone");
    const binding={action:"pull-app",appMatch:"firefox",shortcut:"Ctrl+J",mainMonitorAction:"burner",burnerLayout:"float"};
    f.warp.run(binding,{mainMonitor:1,burnerMonitor:2});
    assert.deepEqual(centers().at(-1),{x:-960,y:540});
    assert.equal(centers().length,3);
    f.warp.run(binding); // active on main: send to burner
    assert.equal(centers().length,3);
    f.warp.run(binding,undefined,{x:-1800,y:200}); // hold tile does not move pointer
    assert.equal(centers().length,3);
});

for (const legacy of [false,true]) test(`push arms retile for the moved identity and an existing key falls back only when unconsumed on Plasma ${legacy ? 5 : 6}`, () => {
    const f = fixture([push,{label:"Existing",shortcut:"Super+C",action:"tile-up"}],legacy);
    f.window.pid = 73;
    f.trigger("Push");
    const arm = f.calls.find(c=>c[3]==="ArmRetile");
    assert.deepEqual(JSON.parse(arm[5]),{id:"a",pid:73,generation:"generation-1"});
    assert.ok(Math.abs(Number(arm[6])-Date.now()) < 1000);
    const before = clone(f.window.frameGeometry);
    f.trigger("Existing");
    const consumed = f.calls.at(-1);
    assert.equal(consumed[3],"Retile");
    assert.equal(consumed[5],"Super+C");
    consumed.at(-1)(true);
    assert.deepEqual(clone(f.window.frameGeometry),before);
    f.trigger("Existing");
    f.calls.at(-1).at(-1)(false);
    assert.equal(f.window.frameGeometry.height,960);
});
