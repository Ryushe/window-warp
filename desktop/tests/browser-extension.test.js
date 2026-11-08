import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {parseHTML} from "linkedom";

const source = fs.readFileSync(new URL("../browser-extension/common/background.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
function event() { return {listeners:[],addListener(fn){this.listeners.push(fn);}}; }
async function fixture(firefox = false, {installType = "development", version = "0.1.1", marker = "fixture-installation"} = {}) {
    const data = {enabled:true,pairing:"43210:0123456789abcdef0123456789abcdef",profilePath:"/profiles/work",profileName:"Work",clientId:"fixture"};
    const calls = [], activated = [], timers = new Map(); let nextTimer = 0, windowReads = 0, reloads = 0, alarm = null, pollBlock = null;
    const server = {live:false,requestId:""};
    const api = {
        storage:{local:{async get(){return {...data};},async set(values){Object.assign(data,values);}},onChanged:event()},
        windows:{async getAll(){windowReads++; return [
            {id:7,incognito:false,left:10,top:20,width:800,height:600,tabs:[{id:71,active:true,url:"https://one.test/",title:"One"},{id:72,active:false,url:"https://two.test/",title:"Two"}]},
            {id:8,incognito:true,tabs:[{id:81,active:true,url:"https://private.test/",title:"Private"}]}
        ];},onRemoved:event(),onFocusChanged:event()},
        tabs:{async update(id,options){activated.push({id,options});},onCreated:event(),onRemoved:event(),onUpdated:event(),onActivated:event()},
        runtime:{getURL:part=>(firefox ? "moz-extension://fixture/" : "chrome-extension://fixture/") + part,getManifest:()=>({version}),reload:()=>{reloads++;},onStartup:event(),onInstalled:event(),onMessage:event()},
        management:{async getSelf(){return {installType};}},
        alarms:{async create(name,options){alarm={name,...options};},async get(){return alarm;},async clear(){alarm=null;return true;},onAlarm:event()}
    };
    const globals = {crypto:{randomUUID:()=>"fixture"},setTimeout:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),fetch:async (url,options)=>{
        if (url.endsWith("/warp-managed.json")) { if (!marker) throw new Error("No managed marker"); return {async json(){return {id:marker};}}; }
        const body=JSON.parse(options.body); calls.push({url,body});
        if (body.action === "poll" && pollBlock) await pollBlock.promise;
        return {async json(){return {...server,updated:1};}};
    }};
    globals[firefox ? "browser" : "chrome"] = api;
    vm.runInNewContext(source, globals);
    await tick();
    const send = (action,options) => new Promise(resolve => api.runtime.onMessage.listeners[0]({action,options},null,resolve));
    const runTimer = async () => {const [id,fn]=timers.entries().next().value; timers.delete(id); await fn(); await tick();};
    return {api,data,calls,activated,server,send,runTimer,clearTimers(){timers.clear();},blockPoll(){let release;const promise=new Promise(resolve=>{release=resolve;});pollBlock={promise,release};},releasePoll(){const blocked=pollBlock;pollBlock=null;blocked.release();},get alarm(){return alarm;},get windowReads(){return windowReads;},get reloads(){return reloads;}};
}
for (const firefox of [false,true]) {
    test(`${firefox ? "Firefox" : "Chromium"} selects only the requested matching browser tab`, async () => {
        const e=await fixture(firefox);
        e.server.focusCommands=[{id:"focus-one",windowId:7,tabIndex:1,expectedUrls:["https://one.test/","https://two.test/"]}];
        await e.api.alarms.onAlarm.listeners[0]({name:"connection"});
        assert.equal(e.activated.length,1);
        assert.equal(e.activated[0].id,72);
        assert.equal(e.activated[0].options.active,true);
        assert.equal(e.calls.find(call=>call.body.action==='focus-result').body.name,'ok');
        assert.equal(e.calls.find(call=>call.body.action==='poll').body.supportsFocus,true);
        e.server.focusCommands=[{id:"focus-stale",windowId:7,tabIndex:1,expectedUrls:["https://changed.test/","https://two.test/"]},{id:"focus-private",windowId:8,tabIndex:0,expectedUrls:["https://private.test/"]}];
        await e.api.alarms.onAlarm.listeners[0]({name:"connection"});
        assert.equal(e.activated.length,1,"changed and private windows must not be changed");
        assert.deepEqual(e.calls.filter(call=>call.body.action==='focus-result').slice(-2).map(call=>call.body.name),['failed','failed']);
    });
}
test("Firefox alarm wakes an idle extension for an on-demand tab request", async () => {
    const e=await fixture(true);
    assert.equal(e.alarm.periodInMinutes,0.1);
    e.clearTimers(); // A suspended event page loses ordinary timers.
    await e.api.alarms.onAlarm.listeners[0]({name:"connection"});
    assert.equal(e.windowReads,0,"the wake-up alone does not share tabs");
    e.server.requestId="requested-after-idle";
    e.clearTimers();
    await e.api.alarms.onAlarm.listeners[0]({name:"connection"});
    assert.equal(e.windowReads,1);
    assert.equal(e.calls.filter(call=>call.body.action==='snapshot').at(-1).body.requestId,"requested-after-idle");
    e.data.enabled=false;
    e.api.storage.onChanged.listeners[0]({enabled:{newValue:false}});
    await tick();
    assert.equal(e.alarm,null,"disconnecting stops periodic wake-ups");
});
test("an alarm waits for an already-running poll before the event page can sleep", async () => {
    const e=await fixture(true);
    e.blockPoll();
    const first=e.api.alarms.onAlarm.listeners[0]({name:"connection"});
    await tick();
    let completed=false;
    const second=e.api.alarms.onAlarm.listeners[0]({name:"connection"}).then(()=>{completed=true;});
    await tick();
    assert.equal(completed,false);
    e.releasePoll();
    await Promise.all([first,second]);
    assert.equal(completed,true);
});

test("disconnect waits for older requests so they cannot reconnect the browser", async () => {
    const e=await fixture();
    e.blockPoll();
    const poll=e.api.alarms.onAlarm.listeners[0]({name:"connection"});
    await tick();
    e.data.enabled=false; e.data.liveSharing=false;
    let completed=false;
    const disconnect=e.send("disconnect").then(result=>{completed=true;return result;});
    await tick();
    assert.equal(completed,false);
    assert.equal(e.calls.some(call=>call.body.action==="disconnect"),false);
    e.releasePoll();
    await Promise.all([poll,disconnect]);
    assert.equal(e.calls.at(-1).body.action,"disconnect");
});
for (const firefox of [false,true]) {
    test(`${firefox ? "Firefox" : "Chromium"} shares no tab data until requested and excludes private windows`, async () => {
        const e=await fixture(firefox);
        assert.equal(e.windowReads,0);
        assert.equal(e.calls[0].body.action,"poll");
        assert.deepEqual(e.calls[0].body.windows,[]);
        assert.equal(e.calls[0].body.installationId,"fixture-installation");
        assert.equal(e.calls[0].body.profilePath,"");
        e.api.tabs.onUpdated.listeners[0](); await tick();
        assert.equal(e.windowReads,0);
        e.server.requestId="capture-1";
        await e.runTimer();
        const capture=e.calls.find(call=>call.body.action==="snapshot");
        assert.equal(capture.body.requestId,"capture-1");
        assert.equal(capture.body.browser,firefox ? "firefox" : "chromium");
        assert.equal(capture.body.windows.length,1);
        assert.deepEqual(capture.body.windows[0].tabs.map(tab=>tab.url),["https://one.test/","https://two.test/"]);
        assert.equal(capture.body.windows[0].id,7);
        assert.equal(capture.body.windows[0].activeTab,1);
        await e.runTimer();
        assert.equal(e.calls.filter(call=>call.body.action==="snapshot").length,1,"one capture request produces one snapshot");
        e.data.enabled=false;
        assert.match((await e.send("update")).error,/Connect/);
    });
}
test("live sharing requires this browser's opt-in and stops before reading tabs", async () => {
    const e=await fixture();
    e.server.live=true; await e.runTimer();
    assert.equal(e.windowReads,0,"another browser's server setting cannot start sharing here");
    e.data.liveSharing=true; await e.runTimer();
    assert.equal(e.calls.filter(call=>call.body.action==="snapshot").length,1);
    e.data.liveSharing=false;
    e.api.tabs.onUpdated.listeners[0]();
    const reads=e.windowReads;
    // The status poll timer may run before the debounced tab event.
    await e.runTimer(); await e.runTimer();
    assert.equal(e.windowReads,reads);
    assert.equal(e.calls.filter(call=>call.body.action==="snapshot").length,1);
});

test("live sharing sends changed tabs and excludes a window while it is closing", async () => {
    const e=await fixture();
    e.server.live=true; e.data.liveSharing=true;
    await e.runTimer();
    e.clearTimers();
    e.api.tabs.onCreated.listeners[0]();
    await e.runTimer();
    let snapshots=e.calls.filter(call=>call.body.action==="snapshot");
    assert.equal(snapshots.length,2,"a tab change triggers a fresh live snapshot");
    assert.equal(snapshots.at(-1).body.windows[0].id,7);
    e.clearTimers();
    e.api.tabs.onRemoved.listeners[0](42,{windowId:7,isWindowClosing:true});
    await e.runTimer();
    snapshots=e.calls.filter(call=>call.body.action==="snapshot");
    assert.equal(snapshots.length,3);
    assert.deepEqual(snapshots.at(-1).body.windows,[],"partial shutdown tabs never replace the saved session");
});

test("the open popup is notified when the live destination changes", async () => {
    const e=await fixture(), events=[];
    e.api.runtime.sendMessage=async message=>{events.push(message);};
    e.server.live=true; e.server.destinations={7:"Research"}; e.data.liveSharing=true;
    await e.runTimer();
    assert.equal(events.length,1);
    e.clearTimers(); e.api.tabs.onUpdated.listeners[0](); await e.runTimer();
    assert.equal(events.length,1,"ordinary tab changes do not continually rebuild the popup");
    e.server.destinations={7:"Work"};
    e.clearTimers(); e.api.tabs.onUpdated.listeners[0](); await e.runTimer();
    assert.equal(events.length,2);
    assert.equal(events.at(-1).event,"warp-live-updated");
});

test("changing the live switch sends no browser tabs", async () => {
    const e=await fixture();
    const before=e.windowReads;
    await e.send("set-live",{live:true});
    assert.equal(e.windowReads,before);
    const call=e.calls.find(call=>call.body.action==='set-live');
    assert.equal(call.body.live,true);
    assert.deepEqual(call.body.windows,[]);
});

test("opening Workspaces sends no browser tabs", async () => {
    const e=await fixture();
    const before=e.windowReads;
    await e.send("open-workspaces");
    assert.equal(e.windowReads,before);
    const call=e.calls.find(call=>call.body.action==='open-workspaces');
    assert.deepEqual(call.body.windows,[]);
});
for (const firefox of [false, true]) {
    test(`${firefox ? "Firefox" : "Chromium"} opens saved tabs beside the current tab without reading open tabs`, async () => {
        const e=await fixture(firefox), created=[];
        e.server.tabs=[{url:"https://one.test/"},{url:"https://bad.test/"},{url:"https://two.test/"}];
        e.api.windows.get=async id=>({id,type:"normal",incognito:false});
        e.api.tabs.create=async options=>{ if(options.url.includes("bad")) throw Error("blocked"); created.push(options); };
        const before=e.windowReads;
        const result=await e.send("open-saved-in-current",{savedBrowserId:"saved",windowId:7});
        assert.deepEqual(JSON.parse(JSON.stringify(result)),{opened:2,failed:1});
        assert.equal(e.windowReads,before,"opening saved tabs does not send the user's existing tabs");
        assert.deepEqual(created.map(item=>({windowId:item.windowId,active:item.active})),[{windowId:7,active:false},{windowId:7,active:false}]);
        e.api.windows.get=async id=>({id,type:"normal",incognito:true});
        assert.match((await e.send("open-saved-in-current",{savedBrowserId:"saved",windowId:7})).error,/non-private/);
        assert.equal(created.length,2);
    });
}
test("only a managed development extension reloads once for a newer version", async () => {
    const e=await fixture();
    e.server.extensionVersion="0.1.2";
    await e.runTimer();
    assert.equal(e.reloads,1);
    assert.equal(e.windowReads,0,"update checks do not read browser tabs");
    await e.runTimer();
    assert.equal(e.reloads,1,"a failed reload does not loop");
    assert.equal((await e.send("status")).updatePending,true);
    const store=await fixture(false,{installType:"normal"}); store.server.extensionVersion="0.1.2";
    await store.runTimer(); assert.equal(store.reloads,0,"store extensions keep browser-managed updates");
    const unmanaged=await fixture(false,{marker:""}); unmanaged.server.extensionVersion="0.1.2";
    await unmanaged.runTimer(); assert.equal(unmanaged.reloads,0,"an unowned extension is not reloaded");
    const newer=await fixture(false,{version:"0.2.0"}); newer.server.extensionVersion="0.1.9";
    await newer.runTimer(); assert.equal(newer.reloads,0,"older desktop files do not downgrade an extension");
    const firefox=await fixture(true); firefox.server.extensionVersion="0.1.2";
    await firefox.runTimer(); assert.equal(firefox.reloads,1,"Firefox development extensions use the same guarded update flow");
});
test("extension manifests use the app icon and grant only local bridge access", () => {
    for (const name of ["chromium","firefox"]) {
        const manifest=JSON.parse(fs.readFileSync(new URL(`../browser-extension/${name}-manifest.json`,import.meta.url),"utf8"));
        assert.deepEqual(manifest.host_permissions,["http://127.0.0.1/*"]);
        assert.ok(manifest.permissions.includes("tabs"));
        const size=name === "firefox" ? "512" : "128";
        assert.equal(manifest.icons[size],"icon.png");
        assert.equal(manifest.action.default_icon[size],"icon.png");
    }
    assert.ok(fs.statSync(new URL("../browser-extension/common/icon.png",import.meta.url)).size > 0);
});
test("popup can update a newly saved workspace without reading tabs at rest", async () => {
    const html=fs.readFileSync(new URL("../browser-extension/common/popup.html",import.meta.url),"utf8");
    const popup=fs.readFileSync(new URL("../browser-extension/common/popup.js",import.meta.url),"utf8");
    const {window,document}=parseHTML(html), calls=[];
    Object.defineProperty(window.HTMLSelectElement.prototype,"value",{configurable:true,
        get(){return this.querySelector("option[selected]")?.value ?? this.querySelector("option")?.value;},
        set(value){this.querySelectorAll("option").forEach(option=>option.removeAttribute("selected")); [...this.querySelectorAll("option")].find(option=>option.value===value)?.setAttribute("selected","");}
    });
    let windowReads=0;
    const api={
        storage:{local:{async get(){return {enabled:true,pairing:"1234:token"};},async set(){}}},
        windows:{async getCurrent(){return {id:7};},async getAll(){windowReads++;return [{id:7,incognito:false,tabs:[{active:true,title:"Example"}]}]; }},
        runtime:{async sendMessage(request){
            calls.push(request);
            if(request.action==="status") return {libraryVersion:1,workspace:null,hasOwners:true,live:false,profiles:[],workspaces:[{id:"work",name:"Work",items:[{index:0,label:"Browser"}]}]};
            if(request.action==="sync-current") return {updated:1,destination:"Work"};
            return {};
        }}
    };
    vm.runInNewContext(popup,{window,document,chrome:api}); await tick();
    assert.equal(windowReads,0);
    assert.equal(document.querySelector("#update").disabled,false);
    document.querySelector("#update").click(); await tick(); await tick();
    assert.equal(calls.filter(call=>call.action==="sync-current").length,1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call=>call.action==="sync-current").options)),{windowId:7});
    assert.match(document.querySelector("#status").textContent,/Synced tabs to Work/);
    assert.equal(windowReads,0,"the popup leaves tab capture to an explicitly requested background action");
});
test("sync elsewhere requires a workspace, browser window, and replacement confirmation", async () => {
    const html=fs.readFileSync(new URL("../browser-extension/common/popup.html",import.meta.url),"utf8");
    const popup=fs.readFileSync(new URL("../browser-extension/common/popup.js",import.meta.url),"utf8");
    const {window,document}=parseHTML(html), calls=[];
    Object.defineProperty(window.HTMLSelectElement.prototype,"value",{configurable:true,
        get(){return this.querySelector("option[selected]")?.value ?? this.querySelector("option")?.value;},
        set(value){this.querySelectorAll("option").forEach(option=>option.removeAttribute("selected")); [...this.querySelectorAll("option")].find(option=>option.value===value)?.setAttribute("selected","");}
    });
    const api={
        storage:{local:{async get(){return {enabled:true,pairing:"1234:token"};},async set(){}}},
        windows:{async getCurrent(){return {id:7};},async getAll(){return [{id:7,incognito:false,tabs:[{active:true,title:"Research"}]}];}},
        runtime:{async sendMessage(request){
            calls.push(request);
            if(request.action==="status") return {libraryVersion:1,workspace:"Work",hasOwners:true,live:false,profiles:[],workspaces:[{id:"work",name:"Work",items:[{index:2,label:"Research",revision:"rev"}]}]};
            if(request.action==="update-elsewhere") return {updated:1,destination:"Work"};
            return {};
        }}
    };
    vm.runInNewContext(popup,{window,document,chrome:api}); await tick();
    document.querySelector("#sync-elsewhere").click();
    document.querySelector("#target-destination").value="workspace:work";
    document.querySelector("#target-destination").dispatchEvent(new window.Event("change"));
    document.querySelector("#chooser-review").click();
    assert.equal(document.querySelector("#chooser-confirm").hidden,false);
    assert.equal(calls.some(call=>call.action==="update-elsewhere"),false);
    document.querySelector("#chooser-confirm-button").click(); await tick(); await tick();
    const manual=calls.find(call=>call.action==="update-elsewhere");
    assert.deepEqual(JSON.parse(JSON.stringify(manual.options)),{workspaceId:"work",itemIndex:2,expectedRevision:"rev",windowId:7});
    assert.match(document.querySelector("#status").textContent,/Updated Work \/ Research once/);
});

test("a browser can pair and be saved when no workspace exists", async () => {
    const html=fs.readFileSync(new URL("../browser-extension/common/popup.html",import.meta.url),"utf8");
    const popup=fs.readFileSync(new URL("../browser-extension/common/popup.js",import.meta.url),"utf8");
    const {window,document}=parseHTML(html), data={enabled:false,pairing:"",liveSharing:false}, calls=[];
    Object.defineProperty(window.HTMLSelectElement.prototype,"value",{configurable:true,
        get(){return this.querySelector("option[selected]")?.value ?? this.querySelector("option")?.value;},
        set(value){this.querySelectorAll("option").forEach(option=>option.removeAttribute("selected")); [...this.querySelectorAll("option")].find(option=>option.value===value)?.setAttribute("selected","");}
    });
    let destination=null;
    const api={storage:{local:{async get(){return {...data};},async set(values){Object.assign(data,values);}}},
        windows:{async getCurrent(){return {id:7};},async getAll(){return [{id:7,incognito:false,tabs:[{active:true,url:"https://example.test/",title:"Example"}]}];}},
        runtime:{getURL:part=>`moz-extension://fixture/${part}`,async sendMessage(request){
            calls.push(request);
            if(request.action==="status") return {libraryVersion:1,workspace:null,destination,live:false,profiles:[],workspaces:[]};
            if(request.action==="save-browser") {destination=request.options.name; return {saved:true,destination};}
            return {};
        }}
    };
    vm.runInNewContext(popup,{window,document,chrome:api}); await tick();
    document.querySelector("#pairing").value="1234:0123456789abcdef0123456789abcdef";
    document.querySelector("#connect").click(); await tick(); await tick(); await tick();
    assert.equal(data.enabled,true);
    assert.equal(document.querySelector("#connected").hidden,false);
    assert.match(document.querySelector("#workspace").textContent,/No saved destination/);
    assert.equal(document.querySelector("#update").disabled,true);
    document.querySelector("#save-browser").click(); await tick(); await tick();
    document.querySelector("#browser-name").value="Research";
    document.querySelector("#save-browser-form").dispatchEvent(new window.Event("submit",{cancelable:true})); await tick(); await tick(); await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call=>call.action==="save-browser").options)),{name:"Research",windowId:7,makeCurrent:true});
    assert.equal(document.querySelector("#workspace").textContent,"Research");
    assert.match(document.querySelector("#status").textContent,/Saved Research/);
    document.querySelector("#create-workspace").click(); await tick();
    assert.equal(calls.some(call=>call.action==="create-workspace"),true);
    document.querySelector("#open-workspaces").click(); await tick();
    assert.equal(calls.some(call=>call.action==="open-workspaces"),true);
});

test("the popup refreshes its live destination when the background connects it", async () => {
    const html=fs.readFileSync(new URL("../browser-extension/common/popup.html",import.meta.url),"utf8");
    const popup=fs.readFileSync(new URL("../browser-extension/common/popup.js",import.meta.url),"utf8");
    const {window,document}=parseHTML(html), listeners=[];
    let destination=null;
    const api={storage:{local:{async get(){return {enabled:true,pairing:"1234:token",liveSharing:true};},async set(){}}},
        windows:{async getCurrent(){return {id:7};},async getAll(){return [];}},
        runtime:{onMessage:{addListener(fn){listeners.push(fn);}},async sendMessage(){return {libraryVersion:1,workspace:null,destination,live:true,profiles:[],workspaces:[]};}}
    };
    vm.runInNewContext(popup,{window,document,chrome:api}); await tick(); await tick();
    assert.match(document.querySelector("#workspace").textContent,/No saved destination/);
    destination="Research"; listeners[0]({event:"warp-live-updated"}); await tick(); await tick();
    assert.equal(document.querySelector("#workspace").textContent,"Research");
    assert.match(document.querySelector("#sharing").textContent,/linked destination/);
});

test("pairing stays connected when desktop integration or saved data is unavailable", async () => {
    const html=fs.readFileSync(new URL("../browser-extension/common/popup.html",import.meta.url),"utf8");
    const popup=fs.readFileSync(new URL("../browser-extension/common/popup.js",import.meta.url),"utf8");
    const {window,document}=parseHTML(html), data={enabled:false,pairing:"",liveSharing:false};
    const api={storage:{local:{async get(){return {...data};},async set(values){Object.assign(data,values);}}},
        windows:{async getCurrent(){return {id:7};},async getAll(){return [];}},
        runtime:{async sendMessage(request){
            if(request.action==="status") return {libraryVersion:1,workspace:null,live:false,profiles:[],workspaces:[],windowsAvailable:false,storageError:"Saved workspaces could not be read."};
            return {};
        }}
    };
    vm.runInNewContext(popup,{window,document,chrome:api}); await tick();
    document.querySelector("#pairing").value="1234:0123456789abcdef0123456789abcdef";
    document.querySelector("#connect").click(); await tick(); await tick(); await tick();
    assert.equal(data.enabled,true);
    assert.equal(document.querySelector("#connected").hidden,false);
    assert.match(document.querySelector("#status").textContent,/could not be read/);
    assert.match(document.querySelector("#status").textContent,/cannot see open windows/);
});

test("updating an existing saved browser elsewhere requires confirmation", async () => {
    const html=fs.readFileSync(new URL("../browser-extension/common/popup.html",import.meta.url),"utf8");
    const popup=fs.readFileSync(new URL("../browser-extension/common/popup.js",import.meta.url),"utf8");
    const {window,document}=parseHTML(html), calls=[];
    Object.defineProperty(window.HTMLSelectElement.prototype,"value",{configurable:true,
        get(){return this.querySelector("option[selected]")?.value ?? this.querySelector("option")?.value;},
        set(value){this.querySelectorAll("option").forEach(option=>option.removeAttribute("selected")); [...this.querySelectorAll("option")].find(option=>option.value===value)?.setAttribute("selected","");}
    });
    const api={storage:{local:{async get(){return {enabled:true,pairing:"1234:token",liveSharing:false};},async set(){}}},
        windows:{async getCurrent(){return {id:7};},async getAll(){return [{id:7,incognito:false,tabs:[{active:true,url:"https://example.test/",title:"Example"}]}];}},
        runtime:{getURL:part=>`chrome-extension://fixture/${part}`,async sendMessage(request){
            calls.push(request);
            if(request.action==="status") return {libraryVersion:1,workspace:null,live:false,profiles:[],workspaces:[],savedBrowsers:[{id:"saved",name:"Research",itemRevision:"item-rev"}]};
            return {saved:true};
        }}
    };
    vm.runInNewContext(popup,{window,document,chrome:api}); await tick(); await tick();
    document.querySelector("#sync-elsewhere").click();
    const select=document.querySelector("#target-destination"); select.value="saved:saved"; select.dispatchEvent(new window.Event("change"));
    document.querySelector("#chooser-review").click();
    assert.equal(document.querySelector("#chooser-confirm").hidden,false);
    assert.equal(calls.some(call=>call.action==="update-elsewhere"),false);
    document.querySelector("#chooser-back").click();
    assert.equal(calls.some(call=>call.action==="update-elsewhere"),false);
    document.querySelector("#chooser-review").click(); document.querySelector("#chooser-confirm-button").click(); await tick(); await tick(); await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call=>call.action==="update-elsewhere").options)),{savedBrowserId:"saved",expectedRevision:"item-rev",windowId:7});
    assert.match(document.querySelector("#status").textContent,/Updated Research once/);
});

test("popup live sharing connects this browser automatically and disconnecting stops it", async () => {
    const html=fs.readFileSync(new URL("../browser-extension/common/popup.html",import.meta.url),"utf8");
    const popup=fs.readFileSync(new URL("../browser-extension/common/popup.js",import.meta.url),"utf8");
    const {window,document}=parseHTML(html), data={enabled:false,pairing:'',liveSharing:false};
    const calls=[]; let live=false;
    const api={
        storage:{local:{async get(){return {...data};},async set(values){Object.assign(data,values);}}},
        windows:{async getAll(){return [];}},
        runtime:{async sendMessage(request){
            calls.push(request);
            if(request.action==='set-live') { live=request.options.live; return {live}; }
            if(request.action==='disconnect') { live=false; return {disconnected:true}; }
            if(request.action==='status') return {libraryVersion:1,workspace:'Work',live,profiles:[],workspaces:[]};
            return {};
        }}
    };
    vm.runInNewContext(popup,{window,document,chrome:api}); await tick();
    const liveSwitch=document.querySelector('#live'), connection=document.querySelector('#connection');
    liveSwitch.checked=true; liveSwitch.dispatchEvent(new window.Event('change')); await tick(); await tick();
    assert.equal(data.enabled,false);
    assert.match(document.querySelector('#status').textContent,/Enter the pairing code/);
    document.querySelector('#pairing').value='1234:token';
    document.querySelector('#connect').click(); await tick(); await tick();
    assert.equal(data.enabled,true); assert.equal(data.liveSharing,true); assert.equal(live,true);
    assert.equal(connection.checked,true); assert.equal(liveSwitch.checked,true);
    connection.checked=false; connection.dispatchEvent(new window.Event('change')); await tick();
    assert.equal(data.enabled,false); assert.equal(data.liveSharing,false); assert.equal(live,false);
    assert.equal(liveSwitch.checked,false);
    connection.checked=true; connection.dispatchEvent(new window.Event('change')); await tick(); await tick();
    assert.equal(data.enabled,true); assert.equal(data.liveSharing,false); assert.equal(live,false);
    assert.ok(calls.some(call=>call.action==='disconnect'));
});

test("a saved pairing can be corrected when Window Warp cannot be reached", async () => {
    const html=fs.readFileSync(new URL("../browser-extension/common/popup.html",import.meta.url),"utf8");
    const popup=fs.readFileSync(new URL("../browser-extension/common/popup.js",import.meta.url),"utf8");
    const {window,document}=parseHTML(html);
    const api={
        storage:{local:{async get(){return {enabled:true,pairing:'old-code'};},async set(){}}},
        runtime:{async sendMessage(){return {error:'Cannot reach Window Warp.'};}}
    };
    vm.runInNewContext(popup,{window,document,chrome:api}); await tick();
    assert.equal(document.querySelector('#pairing-section').hidden,false);
    assert.equal(document.querySelector('#connected').hidden,true);
    assert.equal(document.querySelector('#pairing').value,'old-code');
    assert.match(document.querySelector('#status').textContent,/Cannot reach/);
});

async function libraryPopup(overrides = {}) {
    const html=fs.readFileSync(new URL("../browser-extension/common/popup.html",import.meta.url),"utf8");
    const source=fs.readFileSync(new URL("../browser-extension/common/popup.js",import.meta.url),"utf8");
    const {window,document}=parseHTML(html), calls=[];
    Object.defineProperty(window.HTMLSelectElement.prototype,"value",{configurable:true,
        get(){return this.querySelector("option[selected]")?.value ?? this.querySelector("option")?.value;},
        set(value){this.querySelectorAll("option").forEach(item=>item.removeAttribute("selected")); [...this.querySelectorAll("option")].find(item=>item.value===value)?.setAttribute("selected","");}
    });
    const data={enabled:true,pairing:"1234:token",liveSharing:false};
    const status={libraryVersion:1,destination:"Focus",destinationId:"focus",hasOwners:true,live:false,profiles:[],savedBrowsers:[
        {id:"research",name:"Research",tabCount:4,revision:"profile-r",itemRevision:"item-r"},
        {id:"reading",name:"Reading",tabCount:2,revision:"profile-b",itemRevision:"item-b"}
    ],workspaces:[{id:"focus",name:"Focus",windowCount:3,items:[{index:0,label:"First browser",revision:"a"},{index:2,label:"Second browser",revision:"b"}]},{id:"empty",name:"Home",windowCount:1,items:[]}]};
    let reads=0;
    const api={storage:{local:{async get(){return {...data};},async set(values){Object.assign(data,values);}}},
        windows:{async getCurrent(){return {id:7,incognito:false};},async getAll(){reads++;return [{id:7,incognito:false,tabs:[{active:true,url:"https://example.test/",title:"Example"}]}];}},
        runtime:{getURL:part=>`moz-extension://fixture/${part}`,onMessage:event(),async sendMessage(request){
            calls.push(request);
            if (overrides[request.action]) return overrides[request.action](request,status);
            if (request.action==="status") return {...status};
            if (request.action==="open-workspace" || request.action==="open-saved-browser") return {operationId:"operation"};
            if (request.action==="operation-status") return {done:true,opened:1,failed:0};
            return {saved:true,updated:1,linked:true};
        }}
    };
    vm.runInNewContext(source,{window,document,chrome:api,setTimeout:fn=>{fn();return 1;},Date});
    await tick(); await tick();
    return {window,document,api,data,status,calls,get reads(){return reads;}};
}

test("the extension lists and searches saved browsers and workspaces without capturing tabs", async () => {
    const e=await libraryPopup(), {document,window}=e;
    assert.equal(e.reads,0);
    assert.equal(document.querySelectorAll("#saved-browser-list .library-row").length,2);
    const search=document.querySelector("#list-search"); search.value="read"; search.dispatchEvent(new window.Event("input"));
    assert.equal(document.querySelectorAll("#saved-browser-list .library-row").length,1);
    assert.match(document.querySelector("#saved-browser-list").textContent,/Reading/);
    document.querySelector("#workspaces-tab").click();
    assert.equal(document.querySelectorAll("#workspace-list .library-row").length,2,"workspaces without a matching browser can still be opened");
    assert.equal(document.querySelector("#workspaces-panel").hidden,false);
    assert.match(document.querySelector("#workspace-list").textContent,/Open workspace/);
    assert.equal(e.reads,0);
});

test("saving current tabs can create a browser-only workspace and opt into linking", async () => {
    const e=await libraryPopup(), {document,window}=e;
    document.querySelector("#save-browser").click(); await tick(); await tick();
    document.querySelector("#save-kind").value="workspace";
    document.querySelector("#save-kind").dispatchEvent(new window.Event("change"));
    assert.match(document.querySelector("#save-kind-hint").textContent,/this browser window/);
    document.querySelector("#browser-name").value="Writing"; document.querySelector("#save-link").checked=true;
    document.querySelector("#save-browser-form").dispatchEvent(new window.Event("submit",{cancelable:true})); await tick(); await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(e.calls.find(call=>call.action==="save-workspace").options)),{name:"Writing",windowId:7,makeCurrent:true});
    assert.equal(document.querySelector("#workspaces-panel").hidden,false);
});

test("renaming uses the displayed revision and preserves an error for a changed record", async () => {
    const e=await libraryPopup({"rename-saved-browser":()=>({error:"The saved tabs changed. Reopen the chooser."})}), {document,window}=e;
    document.querySelector("#saved-browser-list .rename-button").click();
    document.querySelector("#rename-name").value="New name";
    document.querySelector("#rename-form").dispatchEvent(new window.Event("submit",{cancelable:true})); await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(e.calls.find(call=>call.action==="rename-saved-browser").options)),{savedBrowserId:"research",name:"New name",expectedRevision:"profile-r"});
    assert.equal(document.querySelector("#rename-form").hidden,false);
    assert.match(document.querySelector("#rename-feedback").textContent,/changed/);
});

test("opening a workspace waits for the background operation without sending tab snapshots", async () => {
    const e=await libraryPopup(), {document}=e;
    document.querySelector("#workspaces-tab").click();
    document.querySelector("#workspace-list .row-actions button").click();
    for(let i=0;i<5;i++) await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(e.calls.find(call=>call.action==="open-workspace").options)),{workspaceId:"focus"});
    assert.deepEqual(JSON.parse(JSON.stringify(e.calls.find(call=>call.action==="operation-status").options)),{operationId:"operation"});
    assert.match(document.querySelector("#status").textContent,/Opened Focus/);
    assert.equal(e.reads,0);
});

test("an ambiguous workspace choice cannot overwrite tabs until a window is selected", async () => {
    const e=await libraryPopup(), {document,window}=e;
    document.querySelector("#sync-elsewhere").click();
    const select=document.querySelector("#target-destination"); select.value="workspace:focus"; select.dispatchEvent(new window.Event("change"));
    document.querySelector("#chooser-review").click();
    assert.match(document.querySelector("#chooser-feedback").textContent,/Choose a destination and browser window/);
    assert.equal(e.calls.some(call=>call.action==="update-elsewhere"),false);
    document.querySelector("#target-item").value="2"; document.querySelector("#chooser-review").click();
    assert.match(document.querySelector("#chooser-confirm-text").textContent,/one-time update/);
    document.querySelector("#chooser-confirm-button").click(); for(let i=0;i<4;i++) await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(e.calls.find(call=>call.action==="update-elsewhere").options)),{workspaceId:"focus",itemIndex:2,expectedRevision:"b",windowId:7});
    assert.match(document.querySelector("#status").textContent,/current sync destination stays the same/);
});

test("a separate extension popup uses the sole normal window without guessing among several", async () => {
    const e=await libraryPopup(), {document}=e;
    e.api.windows.getCurrent=async()=>({id:88,type:"popup",incognito:false});
    let windows=[{id:7,type:"normal",incognito:false}];
    e.api.windows.getAll=async options=>{assert.equal(options.populate,false);return windows;};
    document.querySelectorAll("#saved-browser-list .row-actions button")[1].click();
    for(let i=0;i<4;i++) await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(e.calls.find(call=>call.action==="open-saved-in-current").options)),{savedBrowserId:"research",windowId:7});
    windows=[{id:7,type:"normal"},{id:9,type:"normal"}];
    document.querySelectorAll("#saved-browser-list .row-actions button")[1].click();
    for(let i=0;i<3;i++) await tick();
    assert.equal(e.calls.filter(call=>call.action==="open-saved-in-current").length,1);
    assert.match(document.querySelector("#status").textContent,/non-private browser window/);
});

test("sync disables its action while resolving the current window and rejects duplicate clicks", async () => {
    const e=await libraryPopup(), {document}=e;
    let finish;
    e.api.windows.getCurrent=()=>new Promise(resolve=>{finish=resolve;});
    document.querySelector("#update").click();
    assert.equal(document.querySelector("#update").disabled,true);
    document.querySelector("#update").click();
    // The refresh that follows sync also checks the current window.
    e.api.windows.getCurrent=async()=>({id:7,incognito:false});
    finish({id:7,incognito:false});
    for(let i=0;i<4;i++) await tick();
    assert.equal(e.calls.filter(call=>call.action==="sync-current").length,1);
});

test("canceling destination selection keeps the current destination visible and can be reopened", async () => {
    const e=await libraryPopup(), {document,window}=e, select=document.querySelector("#destination");
    select.value="change"; select.dispatchEvent(new window.Event("change"));
    assert.equal(document.querySelector("#chooser").hidden,false);
    document.querySelector("#chooser-cancel").click();
    assert.equal(select.value,"current");
    assert.equal(select.querySelector("option[selected]").textContent,"Focus");
    select.value="change"; select.dispatchEvent(new window.Event("change"));
    assert.equal(document.querySelector("#chooser").hidden,false);
});

test("saving from a private window does not silently select another browser window", async () => {
    const e=await libraryPopup(), {document}=e;
    e.api.windows.getCurrent=async()=>({id:88,type:"normal",incognito:true});
    document.querySelector("#save-browser").click();
    for(let i=0;i<3;i++) await tick();
    assert.equal(document.querySelector("#save-browser-form").hidden,true);
    assert.match(document.querySelector("#status").textContent,/non-private browser window/);
    assert.equal(e.reads,0);
});

test("changing a live current destination requires confirmation before linking", async () => {
    const e=await libraryPopup(), {document,window}=e;
    e.data.liveSharing=true; e.status.live=true;
    e.api.runtime.onMessage.listeners[0]({event:"warp-live-updated"});
    await tick(); await tick();
    const current=document.querySelector("#destination"); current.value="change"; current.dispatchEvent(new window.Event("change"));
    const target=document.querySelector("#target-destination"); target.value="saved:research"; target.dispatchEvent(new window.Event("change"));
    document.querySelector("#chooser-review").click();
    assert.match(document.querySelector("#chooser-confirm-text").textContent,/Live updates may replace/);
    assert.equal(e.calls.some(call=>call.action==="link-current"),false);
    document.querySelector("#chooser-confirm-button").click();
    for(let i=0;i<4;i++) await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(e.calls.find(call=>call.action==="link-current").options)),{savedBrowserId:"research",expectedRevision:"item-r",windowId:7});
});

test("opening a saved browser in a new window reports partial failures", async () => {
    const e=await libraryPopup({"operation-status":()=>({done:true,opened:1,failed:1})}), {document}=e;
    document.querySelector("#saved-browser-list .row-actions button").click();
    for(let i=0;i<5;i++) await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(e.calls.find(call=>call.action==="open-saved-browser").options)),{savedBrowserId:"research"});
    assert.match(document.querySelector("#status").textContent,/1 window could not open/);
    assert.equal(document.querySelector("#status").classList.contains("error"),true);
    assert.equal(e.reads,0);
});

test("an older desktop asks for an update and keeps a way to open Window Warp", async () => {
    let old=true;
    const e=await libraryPopup({status:(_request,status)=>old ? {live:false,profiles:[],workspaces:[]} : {...status}}), {document}=e;
    assert.equal(document.querySelector("#connection").checked,true);
    assert.equal(document.querySelector("#library").hidden,true);
    assert.equal(document.querySelector("#upgrade-required").hidden,false);
    assert.match(document.querySelector("#status").textContent,/Update Window Warp/);
    document.querySelector("#upgrade-open-workspaces").click(); await tick();
    assert.equal(e.calls.some(call=>call.action==="open-workspaces"),true);
    old=false; e.api.runtime.onMessage.listeners[0]({event:"warp-live-updated"});
    await tick(); await tick();
    assert.equal(document.querySelector("#upgrade-required").hidden,true);
    assert.equal(document.querySelector("#library").hidden,false);
});

test("sync sends the destination shown when the user clicked", async () => {
    const e=await libraryPopup({"sync-current":(_request,status)=>{
        status.destination="Other"; status.destinationId="other";
        return {error:"The current sync destination changed. Review it and try again."};
    }}), {document}=e;
    document.querySelector("#update").click();
    for(let i=0;i<5;i++) await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(e.calls.find(call=>call.action==="sync-current").options)),{windowId:7,expectedDestinationId:"focus"});
    assert.match(document.querySelector("#status").textContent,/destination changed/);
    assert.match(document.querySelector("#destination").textContent,/Other/);
});
