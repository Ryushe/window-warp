import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {parseHTML} from "linkedom";

const html = fs.readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../ui/workspaces.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const item = title => ({label:title, window:{title, appId:"fixture", monitor:1, rect:{width:640,height:400}}, launch:{program:"fixture", args:[], workingDirectory:"", newWindow:false}});
const profile = (id, name) => ({id,name,platform:"linux",items:[item(name + " window")]});

test("launch types round trip through the editor and keep target and argument semantics visible",async()=>{
    const e=await editor({profiles:[profile("launch","Launch")]});
    await e.click('[data-action="edit"]');
    assert.equal(e.document.querySelector('[data-launch="kind"]').value,"executable");
    e.input('[data-launch="kind"]',"desktop-entry");
    e.input('[data-launch="program"]',"org.example.Editor");
    e.input('[data-launch="args"]',"file:///tmp/a%20b.txt\nhttps://example.test/document");
    assert.equal(e.document.querySelector('.launch-target-label').textContent,"Desktop entry ID");
    assert.match(e.document.querySelector('.launch-args-label').textContent,/URLs/);
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].items[0].launch.kind,"desktop-entry");
    assert.equal(e.stored().profiles[0].items[0].launch.args.length,2);
    await e.click('[data-action="edit"]');
    e.input('[data-launch="kind"]',"packaged-app");
    e.input('[data-launch="program"]',"Contoso_abc!OtherApp");
    assert.match(e.document.querySelector('.launch-target-label').textContent,/AUMID/);
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].items[0].launch.kind,"packaged-app");
    assert.equal(e.stored().profiles[0].items[0].launch.program,"Contoso_abc!OtherApp");
});

test("imported workspace stays a draft, preserves existing drafts and permits platform/placement adaptation",async()=>{
    const e=await editor();
    const p=profile("imported","Imported");p.platform="windows";
    p.items[0].window.workArea={x:0,y:0,width:1920,height:1080};
    await e.window.reviewImportedWorkspace(p);
    assert.equal(e.calls.some(c=>c.command==="save_workspaces"),false);
    await assert.rejects(()=>e.window.reviewImportedWorkspace(profile("next","Next")),/Save or cancel/);
    e.input("#workspace-platform","linux");
    e.input('[data-window="appId"]',"org.kde.konsole");
    e.input('[data-area="width"]',"1280");
    e.input('[data-rect="x"]',"40");
    await e.click("#save-workspace");
    const saved=e.stored().profiles[0];
    assert.equal(saved.platform,"linux");assert.equal(saved.items[0].window.appId,"org.kde.konsole");
    assert.equal(saved.items[0].window.workArea.width,1280);assert.equal(saved.items[0].window.rect.x,40);
    assert.equal(p.platform,"windows");
});

test("terminal profile, WSL identity and shell arguments remain editable in a workspace draft", async()=>{
    const p=profile("terminal","Development");
    p.items[0].terminal={kind:"windows-terminal",profileName:"Ubuntu",shell:"wsl.exe",shellArgs:[],wslDistro:"Ubuntu",wslUser:"",workingDirectory:"/home/alice"};
    const e=await editor({profiles:[p]});
    await e.click('[data-action="edit"]');
    assert.equal(e.document.querySelector(".terminal-settings").hidden,false);
    assert.equal(e.document.querySelector(".wsl-settings").hidden,false);
    e.input('[data-terminal="wslDistro"]',"Ubuntu-24.04");
    e.input('[data-terminal="wslUser"]',"alice");
    e.input('[data-terminal="workingDirectory"]',"/home/alice/my work");
    e.input('[data-terminal="shellArgs"]',"--exec\n/bin/bash\n--noprofile");
    await e.click("#save-workspace");
    const terminal=e.stored().profiles[0].items[0].terminal;
    assert.equal(terminal.wslDistro,"Ubuntu-24.04");
    assert.equal(terminal.wslUser,"alice");
    assert.equal(terminal.workingDirectory,"/home/alice/my work");
    assert.deepEqual(terminal.shellArgs,["--exec","/bin/bash","--noprofile"]);
    await e.click('[data-action="edit"]');
    e.input('[data-terminal="kind"]',"konsole");
    assert.equal(e.document.querySelector(".wsl-settings").hidden,false,"saved WSL fields remain reachable for clearing during adaptation");
    e.input('[data-terminal="wslDistro"]',"");e.input('[data-terminal="wslUser"]',"");
    assert.equal(e.document.querySelector(".wsl-settings").hidden,true);
    e.change(".restore-terminal",false);
    await e.click("#save-workspace");
    assert.equal(e.stored().profiles[0].items[0].terminal,null);
});

test("Konsole shows terminal profile controls without WSL fields", async()=>{
    const p=profile("konsole","Development");
    p.items[0].terminal={kind:"konsole",profileName:"Work",shell:"/bin/bash",shellArgs:[],wslDistro:"",wslUser:"",workingDirectory:"/tmp"};
    const e=await editor({profiles:[p]});
    await e.click('[data-action="edit"]');
    assert.equal(e.document.querySelector(".terminal-summary").textContent,"Konsole session");
    assert.equal(e.document.querySelector(".wsl-settings").hidden,true);
    e.input('[data-terminal="profileName"]',"Development");
    await e.click("#save-workspace");
    assert.equal(e.stored().profiles[0].items[0].terminal.profileName,"Development");
});

test("Firefox profile, tabs, active tab and capture notes survive review and save",async()=>{
    const p=profile("browser","Research");
    p.items[0].browser={profilePath:"/profiles/work",profileName:"Work",tabs:[{url:"https://example.test/one",title:"One"}],activeTab:1};
    p.items[0].captureNote="Review captured tabs.";
    const e=await editor({profiles:[p]});
    await e.click('[data-action="edit"]');
    assert.equal(e.document.querySelector(".browser-settings").hidden,false);
    assert.equal(e.document.querySelector(".capture-note").textContent,"Review captured tabs.");
    e.input('[data-browser="profilePath"]',"/profiles/another path");
    e.input('[data-browser="tabs"]',"https://example.test/one\nhttps://example.test/two?q=a%20b");
    e.input('[data-browser="activeTab"]',"2");
    await e.click("#save-workspace");
    const browser=e.stored().profiles[0].items[0].browser;
    assert.equal(browser.profilePath,"/profiles/another path");
    assert.equal(browser.tabs[0].title,"One");
    assert.equal(browser.tabs[1].url,"https://example.test/two?q=a%20b");
    assert.equal(browser.activeTab,2);
    await e.click('[data-action="edit"]');
    e.change(".restore-browser",false);
    await e.click("#save-workspace");
    assert.equal(e.stored().profiles[0].items[0].browser,null);
});
async function editor({profiles = [], failSave = false, failLoad = false} = {}) {
    const {window,document} = parseHTML(html);
    Object.defineProperty(window.HTMLSelectElement.prototype,"value", {configurable:true,
        get(){return this.querySelector("option[selected]")?.value ?? this.querySelector("option")?.value;},
        set(value){this.querySelectorAll("option").forEach(o => o.removeAttribute("selected")); [...this.querySelectorAll("option")].find(o=>o.value===value)?.setAttribute("selected","");}
    });
    const calls = [];
    let stored = {version:1, profiles:structuredClone(profiles)};
    window.__TAURI__ = {core:{invoke:async(command,args) => {
        calls.push({command,args:structuredClone(args)});
        if (command === "get_workspaces") {if(failLoad) throw "Unreadable workspace file"; return structuredClone(stored);}
        if (command === "capture_workspace") return {profile:{id:"captured",name:args.name,platform:"linux",items:[item("First"),item("Second")]},suggestedId:profiles[0]?.id};
        if (command === "save_workspaces") {if(failSave) throw "Disk is read-only"; stored=structuredClone(args.store); return structuredClone(stored);}
        if (command === "restore_workspace") return [{label:"Fixture",restored:false,launched:false,error:"Missing app"}];
        if (command === "cancel_workspace_restore") return;
        throw new Error(command);
    }}};
    vm.runInNewContext(source,{window,document});
    const result = {window,document,calls,stored:()=>stored,
        async click(selector){document.querySelector(selector).click();await tick();},
        input(selector,value){const input=document.querySelector(selector);input.value=value;input.dispatchEvent(new window.Event("input"));},
        change(selector,checked){const input=document.querySelector(selector);input.checked=checked;input.dispatchEvent(new window.Event("change"));}
    };
    await result.click("#show-workspaces");
    return result;
}
test("capture is a review draft; excluded windows and edited arguments persist on Save",async()=>{
    const e=await editor();
    await e.click("#capture-workspace");
    assert.equal(e.calls.some(c=>c.command==="save_workspaces"),false);
    e.input("#workspace-name","Research");
    e.input('[data-launch="args"]',"one argument with spaces\n--new-window");
    e.change(".workspace-item:nth-child(2) .include-window",false);
    await e.click("#save-workspace");
    assert.equal(e.stored().profiles[0].name,"Research");
    assert.equal(e.stored().profiles[0].items.length,1);
    assert.deepEqual(e.stored().profiles[0].items[0].launch.args,["one argument with spaces","--new-window"]);
});
test("update preserves workspace identity; rename and reordering persist",async()=>{
    const e=await editor({profiles:[profile("a","A"),profile("b","B")]});
    await e.click('[data-action="update"]');
    e.input("#workspace-name","Updated A");
    await e.click("#save-workspace");
    assert.equal(e.stored().profiles[0].id,"a");
    assert.equal(e.stored().profiles[0].items.length,2);
    await e.click('[data-action="down"]');
    assert.deepEqual(e.stored().profiles.map(p=>p.id),["b","a"]);
    await e.click('[data-action="edit"]');
    e.input("#workspace-name","Renamed B");
    await e.click("#save-workspace");
    assert.equal(e.stored().profiles[0].name,"Renamed B");
});
test("failed save keeps the draft and deletion requires a concrete confirmation",async()=>{
    const e=await editor({profiles:[profile("a","A")],failSave:true});
    await e.click('[data-action="edit"]');
    e.input("#workspace-name","Unsaved");
    await e.click("#save-workspace");
    assert.equal(e.document.querySelector("#workspace-editor").hidden,false);
    assert.equal(e.document.querySelector("#workspace-name").value,"Unsaved");
    assert.equal(e.stored().profiles[0].name,"A");
    const calls=e.calls.length;
    await e.click('[data-action="delete"]');
    assert.equal(e.calls.length,calls);
    assert.equal(e.document.querySelector(".workspace-delete-confirm").hidden,false);
    await e.click('[data-action="cancel-delete"]');
    assert.equal(e.document.querySelector(".workspace-delete-confirm").hidden,true);
});
test("unreadable store prevents capture and restore failures are shown per app",async()=>{
    const bad=await editor({failLoad:true});
    assert.equal(bad.document.querySelector("#capture-workspace").disabled,true);
    const e=await editor({profiles:[profile("a","A")]});
    await e.click('[data-action="restore"]');
    assert.match(e.document.querySelector("#workspace-results").textContent,/Missing app/);
    assert.match(e.document.querySelector("#message").textContent,/Restored 0 of 1/);
    assert.equal(e.document.querySelector("#cancel-restore").hidden,true);
});

test("workspace update hotkey selects the closest profile and preserves an existing draft", async () => {
    const e = await editor({profiles:[profile("a","Research")]});
    const request = {action:"update-workspace",capture:{profile:profile("new","New workspace"),suggestedId:"a"}};
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:request}));
    await tick();
    assert.equal(e.document.querySelector("#workspace-target").value, "a");
    assert.equal(e.document.querySelector("#workspace-name").value, "Research");
    assert.equal(e.calls.some(c => c.command === "save_workspaces"), false);
    e.input("#workspace-name", "Unsaved rename");
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:request}));
    await tick();
    assert.equal(e.document.querySelector("#workspace-name").value, "Unsaved rename");
    assert.match(e.document.querySelector("#message").textContent, /Save or cancel/);
    await e.click("#save-workspace");
    assert.equal(e.stored().profiles.length, 1);
    assert.equal(e.stored().profiles[0].id, "a");
    assert.equal(e.stored().profiles[0].name, "Unsaved rename");
});
