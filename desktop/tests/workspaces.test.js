import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {parseHTML} from "linkedom";

const html = fs.readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const source = ["error-timer.js", "browser-kinds.js", "workspaces.js"].map(file => fs.readFileSync(new URL(`../ui/${file}`, import.meta.url), "utf8")).join("\n");
const tick = () => new Promise(resolve => setImmediate(resolve));
const item = title => ({label:title, window:{title, appId:"fixture", monitor:1, rect:{width:640,height:400}}, launch:{program:"fixture", args:[], workingDirectory:"", newWindow:false}});
const profile = (id, name) => ({id,name,platform:"linux",items:[item(name + " window")]});

test("workspace locations refresh without changing saved workspaces", async () => {
    const e=await editor({profiles:[profile("work","Work"),profile("home","Home")], desktopWorkspace:"work"});
    const open = () => [...e.document.querySelectorAll('.workspace-card')].filter(card=>card.querySelector('.workspace-open-on').textContent.startsWith('Windows on:')).map(card=>card.dataset.workspaceId);
    assert.deepEqual(open(),["work"]);
    e.setDesktopWorkspace("home");
    e.window.dispatchEvent(new e.window.Event("focus")); await tick();
    assert.deepEqual(open(),["home"]);
    e.setDesktopWorkspace(null);
    e.window.dispatchEvent(new e.window.Event("focus")); await tick();
    assert.deepEqual(open(),[]);
    assert.equal(e.calls.some(call=>call.command==='save_workspaces'),false);
});

test("opening an existing workspace offers to move its windows or go to them", async () => {
    const p=profile("work","Work");
    const other={id:"desk-six",name:"Desktop 6",current:false,windowCount:1,browserCount:0,browserTitles:[],ambiguous:false};
    const e=await editor({profiles:[p],openLocationsByWorkspace:{work:[other]}});
    await e.click('[data-action="restore"]');
    assert.equal(e.calls.some(call=>call.command==='restore_workspace'),false);
    assert.equal(e.document.querySelector('.workspace-open-choice').hidden,false);
    assert.match(e.document.querySelector('.workspace-open-choice').textContent,/Desktop 6/);
    await e.click('.workspace-open-choice-row button:first-of-type');
    assert.equal(e.calls.find(call=>call.command==='workspace_move_to_desktop').args.desktopId,'desk-six');
    assert.equal(e.calls.some(call=>call.command==='restore_workspace'),true);

    const go=await editor({profiles:[p],openLocationsByWorkspace:{work:[other]}});
    await go.click('[data-action="restore"]');
    await go.click('.workspace-open-choice-row button:nth-of-type(2)');
    assert.equal(go.calls.find(call=>call.command==='workspace_go_to_desktop').args.desktopId,'desk-six');
    assert.equal(go.calls.some(call=>call.command==='restore_workspace'),false);
});

test("opening a workspace already on this desktop does not ask to move it", async () => {
    const current={id:"here",name:"Desktop 1",current:true,windowCount:1,browserCount:0,browserTitles:[],ambiguous:false};
    const e=await editor({profiles:[profile("work","Work")],openLocationsByWorkspace:{work:[current]}});
    await e.click('[data-action="restore"]');
    assert.equal(e.calls.some(call=>call.command==='restore_workspace'),true);
    assert.equal(e.document.querySelector('.workspace-open-choice').hidden,true);
});

test("workspace URL update chooses a desktop only when multiple sources exist", async () => {
    const p=profile("browser","Research"); p.items[0].window.appId="firefox.exe";
    p.items[0].browser={kind:"firefox",tabs:[{url:"https://saved.test/",title:"Saved"}],activeTab:1};
    const location=(id,name,title)=>({id,name,current:false,windowCount:1,browserCount:1,browserTitles:[title],ambiguous:false});
    const sources=[location("one","Desktop 1","Firefox — One"),location("three","Desktop 3","Firefox — Three")];
    const e=await editor({profiles:[p],locationsByWorkspace:{browser:sources},savedTabUpdatesByDesktop:{three:[{index:0,browser:{kind:"firefox",tabs:[{url:"https://three.test/",title:"Three"}],activeTab:1}}]}});
    assert.match(e.document.querySelector('.workspace-open-on').textContent,/Browsers on: Desktop 1, Desktop 3/);
    assert.ok(e.calls.filter(call=>call.command==='workspace_locations').every(call=>!call.args?.resolveBrowsers), 'viewing workspaces does not request tabs');
    await e.click('[data-action="refresh-tabs"]');
    assert.ok(e.calls.some(call=>call.command==='workspace_locations' && call.args?.resolveBrowsers), 'the explicit update may look for restarted browsers');
    assert.equal(e.calls.some(call=>call.command==='update_saved_workspace_tabs'),false);
    assert.equal(e.document.querySelector('.workspace-source-menu').hidden,false);
    await e.click('.workspace-source-menu button:nth-of-type(2)');
    const request=e.calls.find(call=>call.command==='update_saved_workspace_tabs');
    assert.equal(request.args.desktopId,'three');
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,'https://three.test/');
    assert.match(e.document.querySelector('.workspace-card-status').textContent,/from Desktop 3/);

    const single=await editor({profiles:[p],locationsByWorkspace:{browser:[sources[1]]},savedTabUpdates:[{index:0,browser:p.items[0].browser}]});
    await single.click('[data-action="refresh-tabs"]');
    assert.equal(single.calls.find(call=>call.command==='update_saved_workspace_tabs').args.desktopId,'three');
    assert.equal(single.document.querySelector('.workspace-source-menu').hidden,true);
});

test("workspace cards show the browser's desktop instead of unrelated partial window locations", async () => {
    const p=profile("browser","Research"); p.items[0].window.appId="firefox.exe";
    p.items[0].browser={kind:"firefox",tabs:[{url:"https://saved.test/",title:"Saved"}],activeTab:1};
    for (let index=0; index<6; index++) p.items.push(item(`Other window ${index}`));
    const locations=[
        {id:"six",name:"Desktop 6",current:false,windowCount:2,browserCount:1,browserTitles:["Firefox"],ambiguous:false},
        {id:"other",name:"Another desktop",current:true,windowCount:2,browserCount:0,browserTitles:[],ambiguous:false}
    ];
    const e=await editor({profiles:[p],locationsByWorkspace:{browser:locations},savedTabUpdates:[{index:0,browser:p.items[0].browser}]});
    assert.equal(e.document.querySelector('.workspace-open-on').textContent,'Browser on: Desktop 6');
    await e.click('[data-action="refresh-tabs"]');
    assert.equal(e.calls.find(call=>call.command==='update_saved_workspace_tabs').args.desktopId,'six');
    assert.equal(e.document.querySelector('.workspace-source-menu').hidden,true);
});

test("waiting for an idle browser does not lock other workspaces", async () => {
    const p=profile("browser","Research"); p.items[0].window.appId="firefox.exe";
    p.items[0].browser={kind:"firefox",tabs:[{url:"https://saved.test/",title:"Saved"}],activeTab:1};
    const source={id:"six",name:"Desktop 6",current:false,windowCount:1,browserCount:1,browserTitles:["Firefox"],ambiguous:false};
    let release;
    const savedTabGate=new Promise(resolve=>{release=resolve;});
    const e=await editor({profiles:[p,profile("other","Other")],locationsByWorkspace:{browser:[source]},savedTabGate,savedTabUpdates:[{index:0,browser:p.items[0].browser}]});
    await e.click('[data-workspace-id="browser"] [data-action="refresh-tabs"]');
    assert.match(e.document.querySelector('[data-workspace-id="browser"] .workspace-card-status').textContent,/Waiting for the browser/);
    assert.equal(e.document.querySelector('[data-workspace-id="browser"] [data-action="refresh-tabs"]').disabled,true);
    assert.equal(e.document.querySelector('[data-workspace-id="other"] [data-action="edit"]').disabled,false);
    await e.click('[data-workspace-id="other"] [data-action="edit"]');
    assert.equal(e.document.querySelector('#workspace-editor').hidden,false);
    release(); await tick(); await tick();
    assert.match(e.document.querySelector('[data-workspace-id="browser"] .workspace-card-status').textContent,/1 window updated from Desktop 6/);
    assert.equal(e.document.querySelector('[data-workspace-id="browser"] [data-action="refresh-tabs"]').disabled,false);
});

test("saving another workspace preserves URLs updated while its draft was open", async () => {
    const p=profile("browser","Research"); p.items[0].window.appId="firefox.exe";
    p.items[0].browser={kind:"firefox",tabs:[{url:"https://saved.test/",title:"Saved"}],activeTab:1};
    const updated={kind:"firefox",tabs:[{url:"https://current.test/",title:"Current"}],activeTab:1};
    const source={id:"six",name:"Desktop 6",current:false,windowCount:1,browserCount:1,browserTitles:["Firefox"],ambiguous:false};
    let release; const savedTabGate=new Promise(resolve=>{release=resolve;});
    const e=await editor({profiles:[p,profile("other","Other")],locationsByWorkspace:{browser:[source]},savedTabGate,savedTabUpdates:[{index:0,browser:updated}]});
    await e.click('[data-workspace-id="browser"] [data-action="refresh-tabs"]');
    await e.click('[data-workspace-id="other"] [data-action="edit"]');
    e.input('#workspace-name','Updated other');
    await e.click('#save-workspace');
    assert.match(e.document.querySelector('#workspace-save-status').textContent,/Waiting for the browser update/);
    release(); await tick(); await tick(); await tick();
    assert.equal(e.stored().profiles.find(profile=>profile.id==='browser').items[0].browser.tabs[0].url,'https://current.test/');
    assert.equal(e.stored().profiles.find(profile=>profile.id==='other').name,'Updated other');
});

test("a pending URL update protects the same workspace from a hotkey overwrite", async () => {
    const p=profile("browser","Research"); p.items[0].window.appId="firefox.exe";
    p.items[0].browser={kind:"firefox",tabs:[{url:"https://saved.test/",title:"Saved"}],activeTab:1};
    const source={id:"six",name:"Desktop 6",current:false,windowCount:1,browserCount:1,browserTitles:["Firefox"],ambiguous:false};
    let release; const savedTabGate=new Promise(resolve=>{release=resolve;});
    const e=await editor({profiles:[p],locationsByWorkspace:{browser:[source]},savedTabGate,savedTabUpdates:[{index:0,browser:p.items[0].browser}]});
    await e.click('[data-action="refresh-tabs"]');
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:{action:"update-workspace",capture:{profile:structuredClone(p),suggestedId:"browser"}}}));
    await tick(); await e.click('#workspace-hotkey-update');
    assert.match(e.document.querySelector('#workspace-hotkey-status').textContent,/Updating URLs/);
    assert.equal(e.document.querySelector('#workspace-editor').hidden,true);
    release(); await tick(); await tick();
});

test("a disappeared desktop source keeps the saved URLs", async () => {
    const p=profile("browser","Research"); p.items[0].window.appId="firefox.exe";
    p.items[0].browser={kind:"firefox",tabs:[{url:"https://saved.test/",title:"Saved"}],activeTab:1};
    const location={id:"gone",name:"Desktop 3",current:false,windowCount:1,browserCount:1,browserTitles:["Firefox"],ambiguous:false};
    const e=await editor({profiles:[p],locationsByWorkspace:{browser:[location]},failSavedDesktop:"gone"});
    await e.click('[data-action="refresh-tabs"]');
    assert.match(e.document.querySelector('.workspace-card-status').textContent,/no longer open/);
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,'https://saved.test/');
});

test("workspace updates explain an unresponsive extension and keep saved URLs", async () => {
    const p=profile("browser","Research"); p.items[0].window.appId="firefox.exe";
    p.items[0].browser={kind:"firefox",tabs:[{url:"https://saved.test/",title:"Saved"}],activeTab:1};
    const source={id:"other",name:"Desktop 3",current:false,windowCount:1,browserCount:1,browserTitles:["Firefox"],ambiguous:false};
    const e=await editor({profiles:[p],locationsByWorkspace:{browser:[source]},tabFailure:"extensionDidNotRespond"});
    await e.click('[data-action="refresh-tabs"]');
    assert.match(e.document.querySelector('.workspace-card-status').textContent,/extension didn't respond/);
    assert.match(e.document.querySelector('.workspace-card-status').textContent,/profile/);
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,'https://saved.test/');

    const noSource=await editor({profiles:[p],locationFailures:{browser:"extensionDidNotRespond"}});
    await noSource.click('[data-action="refresh-tabs"]');
    assert.match(noSource.document.querySelector('.workspace-card-status').textContent,/extension didn't respond/);
    assert.equal(noSource.calls.some(call=>call.command==='update_saved_workspace_tabs'),false,"do not wait for a second request after discovery already failed");
});

test("settings opens from the left navigation and leaves shortcuts", async () => {
    const e = await editor();
    assert.equal(e.document.querySelector("#settings-page").hidden, true);
    await e.click("#show-settings");
    assert.equal(e.document.querySelector("#settings-page").hidden, false);
    assert.equal(e.document.querySelector("#shortcuts-page").hidden, true);
    assert.equal(e.document.querySelector("#workspaces-page").hidden, true);
    assert.equal(e.document.querySelector("#show-settings").classList.contains("active"), true);
    await e.click("#show-shortcuts");
    assert.equal(e.document.querySelector("#settings-page").hidden, true);
    assert.equal(e.document.querySelector("#shortcuts-page").hidden, false);
});

test("settings use expandable sections and browser setup opens its section", async () => {
    const p=profile("browser-setup","Research");
    p.items[0].window.appId="chrome.exe";
    const e=await editor({profiles:[p]});
    const sections=[...e.document.querySelectorAll('#settings-page > .setting-item')];
    assert.equal(sections.length,6);
    assert.ok(sections.every(section=>section.querySelector(':scope > summary')));
    await e.click('[data-action="edit"]');
    await e.click('#workspace-editor-browser-settings');
    assert.equal(e.document.querySelector('#settings-page').hidden,false);
    assert.equal(e.document.querySelector('#browser-extensions-settings').open,true);
});

test("workspace save errors appear beside Save and retain the draft", async () => {
    const e = await editor({profiles:[profile("a", "Research")]});
    await e.click('[data-action="edit"]');
    e.input('#workspace-name', '');
    await e.click('#save-workspace');
    assert.match(e.document.querySelector('#workspace-save-status').textContent, /Give this workspace a name/);
    assert.equal(e.document.querySelector('#workspace-editor').hidden, false);
    assert.equal(e.document.querySelector('#message').textContent, '');
    assert.equal(e.stored().profiles[0].name, 'Research');
});

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
test("Use current tabs updates the draft only and reports a missing match", async () => {
    const p=profile("browser-current","Research");
    Object.assign(p.items[0].window,{id:"42",pid:10});
    p.items[0].browser={profilePath:"/profiles/work",profileName:"Work",tabs:[{url:"https://old.test",title:"Old"}],activeTab:1};
    const current={profilePath:"/profiles/work",profileName:"Work",tabs:[{url:"https://new.test",title:"New"}],activeTab:1};
    const e=await editor({profiles:[p],currentBrowserTabs:current});
    await e.click('[data-action="edit"]'); await e.click('.use-current-browser-tabs');
    assert.match(e.document.querySelector('.browser-current-status').textContent,/Save the workspace/);
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,"https://old.test");
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,"https://new.test");
    const missing=await editor({profiles:[p]});
    await missing.click('[data-action="edit"]'); await missing.click('.use-current-browser-tabs');
    assert.match(missing.document.querySelector('.browser-current-status').textContent,/No connected browser window matched/);
    assert.equal(missing.document.querySelector('.browser-current-status').classList.contains('error'),true);
});
test("current tabs do not replace a manually chosen different browser profile", async () => {
    const p=profile("browser-profile-change","Research");
    Object.assign(p.items[0].window,{id:"42",pid:10});
    p.items[0].browser={profilePath:"/profiles/work",profileName:"Work",tabs:[{url:"https://saved.test",title:"Saved"}],activeTab:1};
    const current={profilePath:"/profiles/work",profileName:"Work",tabs:[{url:"https://other.test",title:"Other"}],activeTab:1};
    const e=await editor({profiles:[p],currentBrowserTabs:current});
    await e.click('[data-action="edit"]');
    e.input('[data-browser="profilePath"]',"/profiles/personal");
    await e.click('.use-current-browser-tabs');
    assert.equal(e.document.querySelector('[data-browser="profilePath"]').value,"/profiles/personal");
    assert.equal(e.document.querySelector('[data-browser="tabs"]').value,"https://saved.test");
    assert.equal(e.document.querySelector('.browser-current-status').classList.contains('error'),true);
});
test("a Chromium window captured before connecting can use current tabs later", async () => {
    const p=profile("chrome-current","Research");
    Object.assign(p.items[0].window,{id:"43",pid:11,appId:"chrome.exe"});
    const current={kind:"chromium",profilePath:"",profileName:"",tabs:[{url:"https://new.test",title:"New"}],activeTab:1};
    const e=await editor({profiles:[p],currentBrowserTabs:current});
    await e.click('[data-action="edit"]');
    assert.equal(e.document.querySelector('.browser-settings').hidden,false);
    assert.equal(e.document.querySelector('.browser-summary').textContent,'Chrome profile and tabs');
    assert.equal(e.document.querySelector('.restore-browser').checked,false);
    await e.click('.use-current-browser-tabs');
    assert.equal(e.document.querySelector('.restore-browser').checked,true);
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,"https://new.test");
});
test("manually adding tabs to a previously uncaptured Chromium window enables tab restore", async () => {
    const p=profile("chrome-manual","Research");
    p.items[0].window.appId="chrome.exe";
    const e=await editor({profiles:[p],bridgeStatus:{enabled:true,chromiumConnected:true}});
    await e.click('[data-action="edit"]');
    assert.equal(e.document.querySelector('.workspace-browser-guide').hidden,false);
    assert.equal(e.document.querySelector('.review-browser-tabs').hidden,false);
    await e.click('.review-browser-tabs');
    assert.equal(e.document.querySelector('.workspace-window-options').open,true);
    assert.equal(e.document.querySelector('.workspace-item-toggle').getAttribute('aria-expanded'),'true');
    assert.equal(e.document.querySelector('.browser-settings').hidden,false);
    e.input('[data-browser="tabs"]',"https://example.test/");
    assert.equal(e.document.querySelector('.restore-browser').checked,true);
    assert.equal(e.document.querySelector('.workspace-browser-guide').hidden,true);
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,"https://example.test/");
});
test("browser setup help is shown only while selected browser windows need tabs", async () => {
    const p=profile("missing-tabs","Research");
    p.items.push(item("Browser")); p.items[1].window.appId="firefox.exe";
    p.items[1].browser={profilePath:"",profileName:"",tabs:[],activeTab:1};
    const e=await editor({profiles:[p]});
    await e.click('[data-action="edit"]');
    assert.equal(e.document.querySelector('.workspace-browser-guide').hidden,false);
    e.change('.workspace-item:nth-child(2) .include-window',false);
    assert.equal(e.document.querySelector('.workspace-browser-guide').hidden,true);
    e.change('.workspace-item:nth-child(2) .include-window',true);
    assert.equal(e.document.querySelector('.workspace-browser-guide').hidden,false);
    e.change('.workspace-item:nth-child(2) .restore-browser',false);
    assert.equal(e.document.querySelector('.workspace-browser-guide').hidden,true);
});
test("a disconnected browser warning is dismissible and updates after returning from setup", async () => {
    const p=profile("browser-warning","Research");
    p.items[0].window.appId="chrome.exe";
    p.items[0].browser={kind:"chromium",profilePath:"",profileName:"",tabs:[{url:"https://saved.test",title:""}],activeTab:1};
    const e=await editor({profiles:[p]});
    await e.click('[data-action="edit"]');
    assert.match(e.document.querySelector('#workspace-browser-guide-message').textContent,/isn't connected/);
    assert.equal(e.document.querySelector('.workspace-browser-guide').hidden,false);
    await e.click('#dismiss-workspace-browser-guide');
    assert.equal(e.document.querySelector('.workspace-browser-guide').hidden,true);
    await e.click('#discard-workspace');
    await e.click('[data-action="edit"]');
    assert.equal(e.document.querySelector('.workspace-browser-guide').hidden,true);
    const connected=await editor({profiles:[p]});
    await connected.click('[data-action="edit"]');
    await connected.click('#workspace-editor-browser-settings');
    connected.setBridgeStatus({enabled:true,chromiumConnected:true});
    await connected.click('#show-workspaces');
    assert.equal(connected.document.querySelector('.workspace-browser-guide').hidden,true);
});
test("returning from browser setup fills missing draft tabs without replacing manual tabs", async () => {
    const p=profile("connect-later","Research");
    Object.assign(p.items[0].window,{id:"1",pid:1,appId:"chrome.exe"});
    const manual=structuredClone(p.items[0]); manual.window.id="2"; p.items.push(manual);
    const fresh={kind:"chromium",profilePath:"",profileName:"",tabs:[{url:"https://fresh.test",title:""}],activeTab:1};
    const e=await editor({profiles:[p],currentWorkspaceTabs:[{index:0,browser:fresh},{index:1,browser:fresh}]});
    await e.click('[data-action="edit"]');
    e.input('.workspace-item:nth-child(2) [data-browser="tabs"]','https://manual.test');
    await e.click('#workspace-editor-browser-settings');
    e.setBridgeStatus({enabled:true,chromiumConnected:true});
    await e.click('#show-workspaces'); await tick();
    assert.equal(e.calls.filter(call=>call.command==='current_workspace_tabs').length,1);
    assert.equal(e.document.querySelector('.workspace-item:nth-child(1) [data-browser="tabs"]').value,'https://fresh.test');
    assert.equal(e.document.querySelector('.workspace-item:nth-child(2) [data-browser="tabs"]').value,'https://manual.test');
    assert.equal(e.stored().profiles[0].items[0].browser,undefined);
});
test("one workspace action refreshes selected browser tabs without losing draft edits", async () => {
    const p=profile("refresh-draft","Research");
    Object.assign(p.items[0].window,{id:"1",pid:1,appId:"chrome.exe"});
    p.items[0].browser={kind:"chromium",profilePath:"",profileName:"",tabs:[{url:"https://old.test",title:""}],activeTab:1};
    const excluded=structuredClone(p.items[0]); excluded.window.id="2";
    const unmatched=structuredClone(p.items[0]); unmatched.window.id="3";
    p.items.push(excluded,unmatched);
    const latest={kind:"chromium",profilePath:"",profileName:"",tabs:[{url:"https://new.test",title:"New"}],activeTab:1};
    const e=await editor({profiles:[p],currentWorkspaceTabs:[{index:0,browser:latest},{index:1,browser:latest}],bridgeStatus:{enabled:true,chromiumConnected:true}});
    await e.click('[data-action="edit"]');
    e.input('#workspace-name','Draft name');
    await e.click('.workspace-item-toggle');
    e.change('.workspace-item:nth-child(2) .include-window',false);
    await e.click('#refresh-workspace-tabs');
    assert.equal(e.calls.filter(call=>call.command==='current_workspace_tabs').length,1);
    assert.equal(e.document.querySelector('.workspace-item-toggle').getAttribute('aria-expanded'),'true');
    assert.match(e.document.querySelector('#workspace-tabs-status').textContent,/1 couldn't be matched/);
    assert.match(e.document.querySelector('.workspace-item:nth-child(3) .capture-note').textContent,/Saved tabs were kept/);
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,'https://old.test');
    await e.click('#save-workspace');
    const saved=e.stored().profiles[0];
    assert.equal(saved.name,'Draft name');
    assert.equal(saved.items.length,2);
    assert.equal(saved.items[0].browser.tabs[0].url,'https://new.test');
    assert.equal(saved.items[1].browser.tabs[0].url,'https://old.test');
});
test("saved workspaces update all matched browser tabs with one action", async () => {
    const p=profile("refresh-saved","Research");
    p.items[0].window.appId="chrome.exe";
    p.items[0].browser={kind:"chromium",profilePath:"",profileName:"",tabs:[{url:"https://old.test",title:""}],activeTab:1};
    const latest={kind:"chromium",profilePath:"",profileName:"",tabs:[{url:"https://new.test",title:""}],activeTab:1};
    const e=await editor({profiles:[p],savedTabUpdates:[{index:0,browser:latest}]});
    await e.click('[data-action="refresh-tabs"]');
    assert.equal(e.calls.filter(call=>call.command==='update_saved_workspace_tabs').length,1);
    assert.equal(e.calls.filter(call=>call.command==='save_workspaces').length,0);
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,'https://new.test');
    assert.match(e.document.querySelector('.workspace-card-status').textContent,/1 window updated/);
    await e.click('[data-action="edit"]');
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,'https://new.test');
});
test("a tab refresh with no matching connection keeps existing saved tabs", async () => {
    const p=profile("no-connection","Research");
    p.items[0].window.appId="chrome.exe";
    p.items[0].browser={kind:"chromium",profilePath:"",profileName:"",tabs:[{url:"https://saved.test",title:""}],activeTab:1};
    const e=await editor({profiles:[p]});
    await e.click('[data-action="refresh-tabs"]');
    assert.match(e.document.querySelector('.workspace-card-status').textContent,/couldn't identify/);
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,'https://saved.test');
});
test("editing a saved tab list keeps the selected tab within the remaining tabs", async () => {
    const p=profile("browser-clamp","Research");
    p.items[0].browser={profilePath:"",profileName:"",tabs:[{url:"https://one.test",title:""},{url:"https://two.test",title:""}],activeTab:2};
    const e=await editor({profiles:[p]});
    await e.click('[data-action="edit"]');
    e.input('[data-browser="tabs"]',"https://one.test");
    assert.equal(e.document.querySelector('[data-browser="activeTab"]').value,"1");
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].items[0].browser.activeTab,1);
});
test("visual position selection updates only the draft and cancel preserves the saved position", async () => {
    const p = profile("position", "Position");
    Object.assign(p.items[0].window, {rect:{x:10,y:20,width:640,height:400}, workArea:{x:0,y:0,width:1920,height:1080}, maximizedHorizontal:true, maximizedVertical:true});
    const position = {rect:{x:-800,y:50,width:700,height:600},workArea:{x:-1920,y:0,width:1920,height:1080},monitor:1};
    const e = await editor({profiles:[p], positionResults:[null, position]});
    await e.click('[data-action="edit"]');
    await e.click('.set-position');
    assert.equal(e.document.querySelector('[data-rect="x"]').value, '10');
    await e.click('.set-position');
    assert.equal(e.document.querySelector('[data-rect="x"]').value, '-800');
    assert.equal(e.stored().profiles[0].items[0].window.rect.x, 10);
    e.input('[data-rect="width"]', '720');
    await e.click('#save-workspace');
    const saved = e.stored().profiles[0].items[0].window;
    assert.equal(saved.rect.x, -800);
    assert.equal(saved.workArea.x, -1920);
    assert.equal(saved.rect.width, 720);
    assert.equal(saved.maximizedHorizontal, false);
});

test("workspace monitor control selects a display while preserving the source placement", async () => {
    const p = profile("monitor", "Work");
    Object.assign(p.items[0].window, {monitor:2,monitorName:"old-display",rect:{x:2100,y:100,width:800,height:600},workArea:{x:1920,y:0,width:1920,height:1080}});
    const e = await editor({profiles:[p], monitors:[{x:0,y:0,width:1920,height:1080},{x:1920,y:0,width:1920,height:1080}]});
    await e.click('[data-action="edit"]');
    const monitor = e.document.querySelector('.window-placement');
    assert.equal(monitor.value,'2');
    assert.deepEqual([...monitor.options].map(option=>option.textContent),['Monitor 1','Monitor 2']);
    monitor.value = '1'; monitor.dispatchEvent(new e.window.Event('change'));
    assert.equal(e.stored().profiles[0].items[0].window.monitor,2);
    await e.click('#save-workspace');
    const saved = e.stored().profiles[0].items[0].window;
    assert.equal(saved.monitor,1);
    assert.equal(saved.monitorName,'');
    assert.deepEqual(saved.rect,p.items[0].window.rect);
    assert.deepEqual(saved.workArea,p.items[0].window.workArea);
});

test("workspace monitor remains editable when display discovery is unavailable", async () => {
    const e = await editor({profiles:[profile('monitor-fallback','Work')], monitors:null});
    await e.click('[data-action="edit"]');
    assert.equal(e.document.querySelector('.window-placement').hidden,true);
    assert.equal(e.document.querySelector('.window-placement-fallback').hidden,false);
    const number = e.document.querySelector('.monitor-number');
    number.value='2'; number.dispatchEvent(new e.window.Event('change'));
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].items[0].window.monitor,2);
});

test("expanded workspace windows reveal launch and browser options without another click", async () => {
    const p = profile('visible-options','Work');
    p.items[0].window.appId='chrome.exe';
    p.items[0].browser={kind:'chromium',profilePath:'',profileName:'',tabs:[{url:'https://example.test',title:''}],activeTab:1};
    const e = await editor({profiles:[p]});
    await e.click('[data-action="edit"]');
    await e.click('.workspace-item-toggle');
    assert.equal(e.document.querySelector('.workspace-window-options').open,true);
    assert.equal(e.document.querySelector('.browser-settings > details').hasAttribute('open'),true);
    assert.equal(e.document.querySelector('.workspace-window-options > details:last-child').hasAttribute('open'),true);
});

test("workspace footer keeps Cancel next to Save and discards only the draft", async () => {
    const e = await editor({profiles:[profile("a", "Original")]});
    await e.click('[data-action="edit"]');
    const footer = e.document.querySelector('#workspace-editor .editor-footer');
    assert.equal(footer.querySelector('#discard-workspace').nextElementSibling.id, 'save-workspace');
    e.input('#workspace-name', 'Unsaved');
    await e.click('#discard-workspace');
    assert.equal(e.document.querySelector('#workspace-editor').hidden, true);
    assert.equal(e.stored().profiles[0].name, 'Original');
    assert.equal(e.calls.some(call => call.command === 'save_workspaces'), false);
});

test("Firefox profile selection saves its name and path without changing captured tabs", async () => {
    const p = profile("browser-picker", "Research");
    p.items[0].browser = {profilePath:"/profiles/work", profileName:"Work", tabs:[{url:"https://example.test/", title:"Example"}], activeTab:1};
    const e = await editor({profiles:[p], browserProfiles:[{name:"Work",path:"/profiles/work"},{name:"Personal",path:"/profiles/personal"}]});
    await e.click('[data-action="edit"]');
    const picker = e.document.querySelector('.browser-profile');
    assert.equal(picker.value, "/profiles/work");
    picker.value = "/profiles/personal";
    picker.dispatchEvent(new e.window.Event("change"));
    await e.click("#save-workspace");
    const saved = e.stored().profiles[0].items[0].browser;
    assert.equal(saved.profileName, "Personal");
    assert.equal(saved.profilePath, "/profiles/personal");
    assert.equal(saved.tabs[0].url, "https://example.test/");
});

test("ambiguous Firefox capture can be resolved by choosing a saved browser window", async () => {
    const p = profile("browser-ambiguous", "Research");
    p.items[0].browser = {profilePath:"/profiles/work",profileName:"Work",tabs:[],activeTab:1};
    p.items[0].captureNote = "Firefox tabs could not be matched unambiguously.";
    const sessions = [{profilePath:"/profiles/work",profileName:"Work",tabs:[{url:"https://one.test",title:"One"}],activeTab:1},{profilePath:"/profiles/work",profileName:"Work",tabs:[{url:"https://two.test",title:"Two"}],activeTab:1}];
    const e = await editor({profiles:[p],browserSessions:sessions});
    await e.click('[data-action="edit"]');
    assert.match(e.document.querySelector('.capture-note').textContent, /No Firefox tabs are saved/);
    await e.click('.find-browser-tabs');
    assert.equal(e.document.querySelector('.browser-session-choice').hidden, false);
    const picker = e.document.querySelector('.browser-session');
    picker.value = '1';
    await e.click('.use-browser-session');
    assert.equal(e.document.querySelector('[data-browser="tabs"]').value, 'https://two.test');
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url, 'https://two.test');
    assert.equal(e.stored().profiles[0].items[0].captureNote, '');
});

test("Firefox tab recovery appears below URLs and reports errors beside the control", async () => {
    const p = profile("missing-browser", "Research");
    p.items[0].browser = {profilePath:"",profileName:"",tabs:[],activeTab:1};
    const e = await editor({profiles:[p], browserSessionError:"Firefox session is unavailable."});
    await e.click('[data-action="edit"]');
    const settings = e.document.querySelector('.browser-settings');
    const children = [...settings.querySelector('.find-browser-tabs').parentNode.children];
    assert.ok(children.indexOf(settings.querySelector('[data-browser="tabs"]').parentNode) < children.indexOf(settings.querySelector('.find-browser-tabs')));
    await e.click('.find-browser-tabs');
    assert.match(e.document.querySelector('.browser-session-status').textContent, /Choose a Firefox profile/);
    assert.equal(e.document.querySelector('.browser-session-status').classList.contains('error'), true);
    assert.doesNotMatch(e.document.querySelector('#message').textContent, /Choose a Firefox profile/);
    e.input('[data-browser="profilePath"]', '/profiles/work');
    await e.click('.find-browser-tabs');
    assert.match(e.document.querySelector('.browser-session-status').textContent, /session is unavailable/);
});

test("profile picker shows matching names without exposing duplicate paths", async () => {
    const p = profile("browser-names", "Research"); p.platform = "windows";
    p.items[0].browser = {profilePath:"C:\\Profiles\\work",profileName:"old",tabs:[],activeTab:1};
    const e = await editor({profiles:[p], browserProfiles:[{name:"Work",path:"c:/profiles/work"},{name:"Work",path:"C:/profiles/other"}]});
    await e.click('[data-action="edit"]');
    const picker = e.document.querySelector('.browser-profile');
    assert.equal(picker.value, 'c:/profiles/work');
    assert.deepEqual([...picker.querySelectorAll('option')].slice(1).map(option => option.textContent), ['Work (1)', 'Work (2)']);
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].items[0].browser.profileName, 'Work');
    assert.equal(e.stored().profiles[0].items[0].browser.profilePath, 'C:\\Profiles\\work');
});

async function editor({profiles = [], browserProfiles = [], browserSessions = [], browserSessionError = null, currentBrowserTabs = null, currentWorkspaceTabs = [], currentWorkspaceTabsByDesktop = {}, savedTabUpdates = [], savedTabUpdatesByDesktop = {}, savedTabGate = null, captureInitial = null, captureEnrichment = null, captureEnrichmentGate = null, pickedWindow = null, openWindows = [], locationsByWorkspace = {}, openLocationsByWorkspace = {}, locationFailures = {}, tabFailure = "windowNotMatched", failSavedDesktop = null, bridgeStatus = {enabled:false}, desktopWorkspace = null, positionResults = [], monitors = [{x:0,y:0,width:1920,height:1080}], failSave = false, failLoad = false, prepareImport = p => p, timers = {setTimeout:()=>1,clearTimeout:()=>{}}} = {}) {
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
        if (command === "get_import_monitors") return structuredClone(monitors);
        if (command === "firefox_profiles") return structuredClone(browserProfiles);
        if (command === "browser_profiles") return structuredClone(browserProfiles);
        if (command === "bridge_status") return structuredClone(bridgeStatus);
        if (command === "current_desktop_workspace") return desktopWorkspace;
        if (command === "workspace_locations") return (args?.profile ? [args.profile] : stored.profiles).map(profile => ({workspaceId:profile.id,locations:structuredClone(locationsByWorkspace[profile.id] || (profile.id === desktopWorkspace ? [{id:"desktop-one",name:"Desktop 1",current:true,windowCount:profile.items.length,browserCount:0,browserTitles:[],ambiguous:false}] : [])),failure:args?.resolveBrowsers ? locationFailures[profile.id] || null : null}));
        if (command === "workspace_open_locations") return structuredClone(openLocationsByWorkspace[args.workspaceId] || []);
        if (command === "workspace_move_to_desktop") { openLocationsByWorkspace[args.workspaceId] = (openLocationsByWorkspace[args.workspaceId] || []).filter(location=>location.id!==args.desktopId); return; }
        if (command === "workspace_go_to_desktop") return;
        if (command === "current_browser_tabs") return structuredClone(currentBrowserTabs);
        if (command === "current_workspace_tabs") {const updates=currentWorkspaceTabsByDesktop[args.desktopId] || currentWorkspaceTabs;return {updates:structuredClone(updates),failure:updates.length ? null : tabFailure};}
        if (command === "update_saved_workspace_tabs") {
            if (savedTabGate) await savedTabGate;
            if (args.desktopId && args.desktopId === failSavedDesktop) throw "The browser is no longer open on that desktop. Choose a source again.";
            const workspace = stored.profiles.find(profile => profile.id === args.workspaceId);
            const updates = savedTabUpdatesByDesktop[args.desktopId] || savedTabUpdates;
            for (const update of updates) workspace.items[update.index].browser = structuredClone(update.browser);
            const count = workspace.items.filter(item => item.browser || /firefox|chrome/i.test(item.window.appId)).length;
            return {store:structuredClone(stored),updated:updates.length,unmatched:count-updates.length,failure:updates.length ? null : tabFailure};
        }
        if (command === "firefox_sessions") { if (browserSessionError) throw browserSessionError; return structuredClone(browserSessions); }
        if (command === "choose_position") return structuredClone(positionResults.shift() ?? null);
        if (command === "capture_workspace" || command === "start_workspace_capture") return {profile:structuredClone(captureInitial || {id:"captured",name:args.name,platform:"linux",items:[item("First"),item("Second")]}),suggestedId:profiles[0]?.id};
        if (command === "enrich_workspace_capture") {if(captureEnrichmentGate) await captureEnrichmentGate; return structuredClone(captureEnrichment || args.profile);}
        if (command === "pick_workspace_window") return structuredClone(pickedWindow);
        if (command === "workspace_open_windows") return structuredClone(openWindows);
        if (command === "prepare_workspace_import") return prepareImport(structuredClone(args.profile));
        if (command === "save_workspaces") {if(failSave) throw "Disk is read-only"; stored=structuredClone(args.store); return structuredClone(stored);}
        if (command === "restore_workspace") return [{label:"Fixture",restored:false,launched:false,error:"Missing app"}];
        if (command === "cancel_workspace_restore") return;
        throw new Error(command);
    }}};
    vm.runInNewContext(source,{window,document,...timers});
    const result = {window,document,calls,stored:()=>stored,replaceStored:value=>{stored=structuredClone(value);},setBridgeStatus:value=>{bridgeStatus=value;},setDesktopWorkspace:value=>{desktopWorkspace=value;},
        async click(selector){document.querySelector(selector).click();await tick();},
        input(selector,value){const input=document.querySelector(selector);input.value=value;input.dispatchEvent(new window.Event("input",{bubbles:true}));},
        change(selector,checked){const input=document.querySelector(selector);input.checked=checked;input.dispatchEvent(new window.Event("change"));}
    };
    await result.click("#show-workspaces");
    return result;
}
test("native import preparation resolves only a review draft until explicit save",async()=>{
    const p=profile("package-import","Old package");
    p.items[0].launch={kind:"packaged-app",program:"",args:[],workingDirectory:"",newWindow:false};
    const e=await editor({prepareImport:input=>{
        input.items[0].launch.program="ResolvedFamily!Application";
        input.items[0].window.desktopId="ResolvedFamily!Application";
        return input;
    }});
    await e.window.reviewImportedWorkspace(p);
    assert.equal(e.document.querySelector('[data-launch="program"]').value,"ResolvedFamily!Application");
    assert.equal(e.calls.some(c=>c.command==="save_workspaces"),false);
    assert.equal(p.items[0].launch.program,"");
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].items[0].launch.program,"ResolvedFamily!Application");
});

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
    assert.equal(e.document.querySelector('#workspace-replace-saved').hidden,false);
    assert.equal(e.stored().profiles[0].name,"A");
    await e.click('#workspace-replace-cancel');
    assert.equal(e.document.querySelector('#workspace-editor').hidden,false);
    await e.click('#save-workspace');
    await e.click('#workspace-replace-confirm');
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
    assert.match(e.document.querySelector("#workspace-save-status").textContent,/Disk is read-only/);
    assert.equal(e.stored().profiles[0].name,"A");
    const calls=e.calls.length;
    await e.click('[data-action="delete"]');
    assert.equal(e.calls.length,calls);
    assert.equal(e.document.querySelector(".workspace-delete-confirm").hidden,false);
    await e.click('[data-action="cancel-delete"]');
    assert.equal(e.document.querySelector(".workspace-delete-confirm").hidden,true);
});
test("a timed workspace save error clears without discarding the draft", async () => {
    let next = 0; const pending = new Map();
    const timers = {setTimeout:fn=>{const id=++next; pending.set(id,fn); return id;},clearTimeout:id=>pending.delete(id)};
    const e=await editor({profiles:[profile("a","A")],failSave:true,timers});
    await e.click('[data-action="edit"]');
    e.input('#workspace-name',"Unsaved");
    await e.click('#save-workspace');
    const status=e.document.querySelector('#workspace-save-status');
    assert.match(status.textContent,/Disk is read-only/);
    assert.equal(status.classList.contains('timed-error'),true);
    const [id, expire]=[...pending][0]; pending.delete(id); expire();
    assert.equal(status.hidden,true);
    assert.equal(e.document.querySelector('#workspace-editor').hidden,false);
    assert.equal(e.document.querySelector('#workspace-name').value,"Unsaved");
    assert.equal(e.stored().profiles[0].name,"A");
});
test("unreadable store prevents capture and restore failures are shown per app",async()=>{
    const bad=await editor({failLoad:true});
    assert.equal(bad.document.querySelector("#capture-workspace").disabled,true);
    const e=await editor({profiles:[profile("a","A")]});
    await e.click('[data-action="restore"]');
    assert.match(e.document.querySelector(".workspace-card-results .error").textContent,/Missing app/);
    assert.match(e.document.querySelector(".workspace-card-status").textContent,/Opened 0 of 1/);
    assert.equal(e.document.querySelector(".workspace-card-status").classList.contains("error"),true);
    assert.equal(e.document.querySelector("#cancel-restore").hidden,true);
});

test("workspace hotkey prompts before replacing an existing draft", async () => {
    const e = await editor({profiles:[profile("a","Research")]});
    const request = {action:"update-workspace",capture:{profile:profile("new","New workspace"),suggestedId:"a"}};
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:request}));
    await tick();
    assert.equal(e.document.querySelector("#workspace-hotkey-choice").hidden, false);
    assert.equal(e.document.querySelector("#workspace-hotkey-target").value, "a");
    await e.click("#workspace-hotkey-update");
    assert.equal(e.document.querySelector("#workspace-target"), null);
    assert.equal(e.document.querySelector("#workspace-name").value, "Research");
    assert.equal(e.calls.some(c => c.command === "save_workspaces"), false);
    e.input("#workspace-name", "Unsaved rename");
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:request}));
    await tick();
    assert.equal(e.document.querySelector("#workspace-name").value, "Unsaved rename");
    assert.equal(e.document.querySelector("#workspace-recapture").hidden, false);
    await e.click("#workspace-keep-draft");
    await e.click("#save-workspace");
    await e.click("#workspace-replace-confirm");
    assert.equal(e.stored().profiles.length, 1);
    assert.equal(e.stored().profiles[0].id, "a");
    assert.equal(e.stored().profiles[0].name, "Unsaved rename");
});

test("workspace hotkey New makes a new review draft", async () => {
    const e = await editor({profiles:[profile("a","Existing")]});
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:{action:"update-workspace",capture:{profile:profile("new","New workspace"),suggestedId:"a"}}}));
    await tick(); await e.click("#workspace-hotkey-new");
    assert.equal(e.document.querySelector("#workspace-target"), null);
    e.input("#workspace-name", "My new workspace");
    await e.click("#save-workspace");
    assert.equal(e.stored().profiles.length, 2);
    assert.equal(e.stored().profiles[1].name, "My new workspace");
});

test("workspace shortcut shows the page during capture and prompts before recapturing a draft", async () => {
    const e=await editor();
    await e.click("#show-shortcuts");
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:{action:"open-workspaces",capturing:true}}));
    await tick();
    assert.equal(e.document.querySelector("#workspaces-page").hidden,false);
    assert.match(e.document.querySelector("#workspace-status").textContent,/Capturing/);
    const send=profile=>e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:{action:"update-workspace",capture:{profile,suggestedId:null}}}));
    send(profile("first","New workspace")); await tick();
    send(profile("second","New workspace")); await tick();
    assert.equal(e.document.querySelector("#workspace-recapture").hidden,false);
    await e.click('#workspace-recapture-confirm');
    e.input("#workspace-name","Recaptured"); await e.click("#save-workspace");
    assert.equal(e.stored().profiles[0].id,"second");
    assert.equal(e.stored().profiles[0].name,"Recaptured");
});

test("a fast capture is not lost while the workspace list is still loading", async () => {
    const {window,document}=parseHTML(html); let finishLoad;
    window.__TAURI__={core:{invoke:command=>{
        if (command==='get_workspaces') return new Promise(resolve=>{finishLoad=resolve;});
        if (command==='browser_profiles') return Promise.resolve([]);
        throw Error(command);
    }}};
    vm.runInNewContext(source,{window,document,setTimeout:()=>1,clearTimeout:()=>{}});
    window.dispatchEvent(new window.CustomEvent('warp-workspace-request',{detail:{action:'open-workspaces',capturing:true}}));
    window.dispatchEvent(new window.CustomEvent('warp-workspace-request',{detail:{action:'update-workspace',capture:{profile:profile('captured','New workspace'),suggestedId:null}}}));
    assert.equal(document.querySelector('#workspaces-page').hidden,false);
    finishLoad({version:1,profiles:[]});
    await tick(); await tick();
    assert.equal(document.querySelector('#workspace-editor').hidden,false);
    assert.equal(document.querySelector('#workspace-name').value,'New workspace');
});

test("the workspace choice is available while browser capture finishes", async () => {
    const e=await editor({profiles:[profile('saved','Saved')]});
    const initial=profile('new','New workspace');
    initial.items[0].window.appId='firefox.exe';
    const send=detail=>e.window.dispatchEvent(new e.window.CustomEvent('warp-workspace-request',{detail}));
    send({action:'update-workspace',captureId:1,capturing:true,capture:{profile:initial,suggestedId:'saved'}}); await tick();
    assert.equal(e.document.querySelector('#workspace-hotkey-choice').hidden,false);
    await e.click('#workspace-hotkey-new');
    assert.equal(e.document.querySelector('#workspace-tabs-loading').hidden,false);
    assert.equal(e.document.querySelector('#workspace-editor').hidden,false);
    e.input('#workspace-name','Captured workspace');
    await e.click('#save-workspace');
    assert.match(e.document.querySelector('#workspace-save-status').textContent,/Saving when URLs/);
    assert.equal(e.stored().profiles.length,1);
    const complete=structuredClone(initial);
    complete.items[0].browser={profilePath:'/profile',profileName:'Work',tabs:[{url:'https://example.test',title:'Example'}],activeTab:1};
    send({action:'update-workspace',captureId:1,capturing:false,capture:{profile:complete,suggestedId:'saved'}}); await tick();
    await tick();
    assert.equal(e.document.querySelector('#workspace-tabs-loading').hidden,true);
    assert.equal(e.stored().profiles[1].name,'Captured workspace');
    assert.equal(e.stored().profiles[1].items[0].browser.tabs[0].url,'https://example.test');
});

test("manual capture stays editable and does not replace URLs entered while loading", async () => {
    const initial=profile('new','New workspace'); initial.items[0].window.appId='firefox.exe';
    const enriched=structuredClone(initial); enriched.items[0].browser={tabs:[{url:'https://captured.test/',title:'Captured'}],activeTab:1};
    let release; const captureEnrichmentGate=new Promise(resolve=>{release=resolve;});
    const e=await editor({captureInitial:initial,captureEnrichment:enriched,captureEnrichmentGate});
    await e.click('#capture-workspace');
    assert.equal(e.document.querySelector('#workspace-editor').hidden,false);
    assert.equal(e.document.querySelector('#workspace-tabs-loading').hidden,false);
    e.input('#workspace-name','My work');
    e.input('[data-browser="tabs"]','https://manual.test/');
    await e.click('#save-workspace');
    release(); await tick(); await tick();
    assert.equal(e.stored().profiles[0].name,'My work');
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,'https://manual.test/');
});

test("failed background capture keeps the draft available for retry or save", async () => {
    const initial=profile('new','New workspace'); initial.items[0].window.appId='firefox.exe';
    let reject; const captureEnrichmentGate=new Promise((_,fail)=>{reject=fail;});
    const e=await editor({captureInitial:initial,captureEnrichmentGate});
    await e.click('#capture-workspace'); await e.click('#save-workspace');
    reject(new Error('Unavailable')); await tick(); await tick();
    assert.equal(e.document.querySelector('#workspace-editor').hidden,false);
    assert.match(e.document.querySelector('#workspace-save-status').textContent,/Retry or save without/);
    assert.match(e.document.querySelector('#workspace-tabs-status').textContent,/Unavailable.*Existing URLs were kept/);
    assert.equal(e.stored().profiles.length,0);
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles.length,1);
});

test("adding an existing window preserves the draft and avoids duplicates", async () => {
    const original=profile('saved','Research');
    const added=item('Editor'); Object.assign(added.window,{id:'42',pid:10,appId:'editor.exe'});
    const e=await editor({profiles:[original],pickedWindow:added,openWindows:[added]});
    await e.click('[data-action="edit"]');
    e.input('#workspace-name','Edited research');
    await e.click('#add-workspace-window');
    assert.equal(e.document.querySelectorAll('.workspace-item').length,2);
    assert.equal(e.document.querySelector('#workspace-name').value,'Edited research');
    await e.click('#workspace-add-from-list');
    assert.equal(e.document.querySelector('#workspace-add-from-list').getAttribute('aria-expanded'),'true');
    const escape = new e.window.Event('keydown', {bubbles:true, cancelable:true}); escape.key = 'Escape';
    e.document.querySelector('#workspace-add-window-list').dispatchEvent(escape);
    assert.equal(e.document.querySelector('#workspace-add-window-list').hidden,true);
    assert.equal(e.document.querySelector('#workspace-add-from-list').getAttribute('aria-expanded'),'false');
    await e.click('#workspace-add-from-list');
    await e.click('#workspace-add-window-list button');
    assert.equal(e.document.querySelectorAll('.workspace-item').length,2);
    assert.match(e.document.querySelector('#workspace-editor-status').textContent,/already/);
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].items[1].window.id,'42');
    assert.equal(e.stored().profiles[0].name,'Edited research');
});

test("an empty window list can be dismissed from its keyboard trigger", async () => {
    const e = await editor({profiles:[profile('saved','Research')]});
    await e.click('[data-action="edit"]');
    await e.click('#workspace-add-from-list');
    assert.match(e.document.querySelector('#workspace-add-window-list').textContent,/No open windows/);
    const escape = new e.window.Event('keydown', {bubbles:true, cancelable:true}); escape.key = 'Escape';
    e.document.querySelector('#workspace-add-from-list').dispatchEvent(escape);
    assert.equal(e.document.querySelector('#workspace-add-window-list').hidden,true);
    assert.equal(e.document.querySelector('#workspace-add-from-list').getAttribute('aria-expanded'),'false');
});

test("a newer hotkey replaces an unfinished capture and ignores its late result", async () => {
    const e=await editor();
    const send=detail=>e.window.dispatchEvent(new e.window.CustomEvent('warp-workspace-request',{detail}));
    const first=profile('first','New workspace'), second=profile('second','New workspace');
    send({action:'update-workspace',captureId:1,capturing:true,capture:{profile:first,suggestedId:null}}); await tick();
    send({action:'update-workspace',captureId:2,capturing:true,capture:{profile:second,suggestedId:null}}); await tick();
    assert.equal(e.document.querySelector('#workspace-recapture').hidden,false);
    await e.click('#workspace-recapture-confirm');
    send({action:'update-workspace',captureId:1,capturing:false,capture:{profile:first,suggestedId:null}}); await tick();
    assert.equal(e.document.querySelector('#workspace-editor').hidden,false);
    send({action:'update-workspace',captureId:2,capturing:false,capture:{profile:second,suggestedId:null}}); await tick();
    e.input('#workspace-name','Latest draft');
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].id,'second');
    assert.equal(e.stored().profiles[0].name,'Latest draft');
});

test("canceling a pending capture does not reopen its draft", async () => {
    const e=await editor(), captured=profile('new','New workspace');
    const send=capturing=>e.window.dispatchEvent(new e.window.CustomEvent('warp-workspace-request',{detail:{action:'update-workspace',captureId:1,capturing,capture:{profile:captured,suggestedId:null}}}));
    send(true); await tick(); await e.click('#discard-workspace');
    send(false); await tick();
    assert.equal(e.document.querySelector('#workspace-editor').hidden,true);
    assert.equal(e.stored().profiles.length,0);
});

test("Win+Y prompts to replace a draft while capture completes in the background", async () => {
    const e=await editor();
    await e.click('#capture-workspace');
    e.input('#workspace-name','Keep this draft');
    const send=(id,capturing)=>e.window.dispatchEvent(new e.window.CustomEvent('warp-workspace-request',{detail:{action:'update-workspace',captureId:id,capturing,capture:{profile:profile(`capture-${id}`,'New workspace'),suggestedId:null}}}));
    send(1,true); await tick();
    assert.equal(e.document.querySelector('#workspace-recapture').hidden,false);
    assert.equal(e.document.querySelector('#workspace-name').value,'Keep this draft');
    send(1,false); await tick();
    assert.equal(e.document.querySelector('#workspace-name').value,'Keep this draft');
    await e.click('#workspace-keep-draft');
    assert.equal(e.document.querySelector('#workspace-name').value,'Keep this draft');
    send(2,true); await tick();
    await e.click('#workspace-recapture-confirm');
    assert.equal(e.document.querySelector('#workspace-editor').hidden,false);
    send(2,false); await tick();
    assert.equal(e.document.querySelector('#workspace-name').value,'New workspace');
    e.input('#workspace-name','Replacement'); await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].id,'capture-2');
});

test("keeping a draft after a browser update still protects the newer saved data", async () => {
    const e=await editor({profiles:[profile('saved','Before')]});
    await e.click('[data-action="edit"]');
    e.replaceStored({version:1,profiles:[profile('saved','Updated by browser')]});
    e.window.dispatchEvent(new e.window.Event('warp-browser-updated'));
    e.window.dispatchEvent(new e.window.CustomEvent('warp-workspace-request',{detail:{action:'update-workspace',captureId:1,capturing:true,capture:{profile:profile('new','New workspace'),suggestedId:null}}}));
    await tick(); await e.click('#workspace-keep-draft');
    await e.click('#save-workspace');
    assert.match(e.document.querySelector('#workspace-save-status').textContent,/Browser URLs changed/);
    assert.equal(e.stored().profiles[0].name,'Updated by browser');
});

test("the hotkey replaces an edited draft after confirmation", async () => {
    const e=await editor();
    const send=profile=>e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:{action:"update-workspace",capture:{profile,suggestedId:null}}}));
    send(profile("first","New workspace")); await tick();
    e.input("#workspace-name","Unsaved");
    send(profile("second","New workspace")); await tick();
    assert.equal(e.document.querySelector("#workspace-recapture").hidden,false);
    assert.equal(e.document.querySelector("#workspace-name").value,"Unsaved");
    await e.click("#workspace-recapture-confirm");
    assert.equal(e.document.querySelector("#workspace-name").value,"New workspace");
    e.input("#workspace-name","Replacement"); await e.click("#save-workspace");
    assert.equal(e.stored().profiles[0].id,"second");
    assert.equal(e.stored().profiles[0].name,"Replacement");
});

test("recapturing after a browser update preserves the newer saved workspace", async () => {
    const e=await editor({profiles:[profile("saved","Before")]});
    await e.click('[data-action="edit"]');
    e.input('#workspace-name','Unsaved draft');
    e.replaceStored({version:1,profiles:[profile("saved","Updated by browser")]});
    e.window.dispatchEvent(new e.window.Event('warp-browser-updated'));
    e.window.dispatchEvent(new e.window.CustomEvent('warp-workspace-request',{detail:{action:'update-workspace',capture:{profile:profile('new','New workspace'),suggestedId:null}}}));
    await tick(); await e.click('#workspace-recapture-confirm');
    e.input('#workspace-name','Fresh capture'); await e.click('#save-workspace');
    assert.deepEqual(e.stored().profiles.map(p=>p.name),['Updated by browser','Fresh capture']);
});

test("workspace hotkey requires an update target when several exist and none is suggested", async () => {
    const e = await editor({profiles:[profile("a","First"),profile("b","Second")]});
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:{action:"update-workspace",capture:{profile:profile("new","New workspace"),suggestedId:null}}}));
    await tick();
    assert.equal(e.document.querySelector('#workspace-hotkey-target').value, '');
    await e.click('#workspace-hotkey-update');
    assert.match(e.document.querySelector('#workspace-hotkey-status').textContent, /Select a workspace/);
    assert.equal(e.document.querySelector('#message').textContent, '');
    assert.equal(e.document.querySelector('#workspace-editor').hidden, true);
});

test("workspace hotkey starts a new draft directly when no workspaces exist", async () => {
    const e = await editor();
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:{action:"update-workspace",capture:{profile:profile("new","New workspace"),suggestedId:null}}}));
    await tick();
    assert.equal(e.document.querySelector('#workspace-hotkey-choice').hidden, true);
    assert.equal(e.document.querySelector('#workspace-editor').hidden, false);
    assert.equal(e.document.querySelector('.workspace-browser-guide').hidden, true);
    assert.equal(e.stored().profiles.length, 0);
});
test("workspace hotkey selects the only saved workspace when no match is suggested", async () => {
    const e=await editor({profiles:[profile('a','Only workspace')]});
    e.window.dispatchEvent(new e.window.CustomEvent('warp-workspace-request',{detail:{action:'update-workspace',capture:{profile:profile('new','New workspace'),suggestedId:null}}}));
    await tick();
    assert.equal(e.document.querySelector('#workspace-hotkey-target').value,'a');
    await e.click('#workspace-hotkey-update');
    assert.equal(e.document.querySelector('#workspace-editor-title').textContent,'Edit “Only workspace”');
    assert.equal(e.calls.some(c=>c.command==='save_workspaces'),false);
});

test("an empty capture explains why saving is unavailable", async () => {
    const e=await editor();
    const captured={id:'empty',name:'New workspace',platform:'windows',items:[]};
    e.window.dispatchEvent(new e.window.CustomEvent('warp-workspace-request',{detail:{action:'update-workspace',capture:{profile:captured,suggestedId:null}}}));
    await tick();
    assert.equal(e.document.querySelector('#workspace-items-empty').hidden,false);
    assert.equal(e.document.querySelector('#save-workspace').disabled,true);
    assert.match(e.document.querySelector('#workspace-items-empty').textContent,/No windows were captured/);
});

test("manual capture and editing another workspace offer to replace the draft", async () => {
    const e=await editor({profiles:[profile('a','First'),profile('b','Second')]});
    await e.click('[data-action="edit"]');
    e.input('#workspace-name','Unfinished work');
    await e.click('#capture-workspace');
    assert.equal(e.calls.some(call=>call.command==='capture_workspace'),false);
    assert.equal(e.document.querySelector('#workspace-recapture').hidden,false);
    await e.click('#workspace-keep-draft');
    e.document.querySelectorAll('[data-action="edit"]')[1].click(); await tick();
    assert.equal(e.document.querySelector('#workspace-recapture').hidden,false);
    await e.click('#workspace-keep-draft');
    assert.equal(e.document.querySelector('#workspace-name').value,'Unfinished work');
    await e.click('#save-workspace');
    assert.equal(e.stored().profiles[0].name,'Unfinished work');
    assert.equal(e.stored().profiles[1].name,'Second');
});

test("extension settings are reachable from a workspace draft without losing edits", async () => {
    const p=profile('a','Research'); p.items[0].window.appId='firefox.exe';
    p.items[0].browser={profilePath:'',profileName:'',tabs:[],activeTab:1};
    const e=await editor({profiles:[p],bridgeStatus:{enabled:false}});
    await e.click('[data-action="edit"]');
    e.input('#workspace-name','Unfinished work');
    assert.equal(e.document.querySelector('.workspace-browser-guide').hidden,false);
    await e.click('#workspace-editor-browser-settings');
    assert.equal(e.document.querySelector('#settings-page').hidden,false);
    await e.click('#show-workspaces');
    assert.equal(e.document.querySelector('#workspace-editor').hidden,false);
    assert.equal(e.document.querySelector('#workspace-name').value,'Unfinished work');
});

test("workspace hotkey URLs changes only confidently matched Firefox tabs", async () => {
    const saved = profile("a", "Research");
    Object.assign(saved.items[0].window,{id:"42",pid:10});
    saved.items[0].browser = {profilePath:"/profiles/work",profileName:"Work",tabs:[{url:"https://old.test",title:"Old"}],activeTab:1};
    const captured = structuredClone(saved);
    captured.items[0].window.rect.x = 900;
    captured.items[0].browser.tabs = [{url:"https://new.test",title:"New"}];
    const e = await editor({profiles:[saved],currentWorkspaceTabs:[{index:0,browser:captured.items[0].browser}]});
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:{action:"update-workspace",capture:{profile:captured,suggestedId:"a"}}}));
    await tick(); await e.click("#workspace-hotkey-urls");
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url, "https://old.test");
    await e.click("#save-workspace");
    await e.click("#workspace-replace-confirm");
    const result = e.stored().profiles[0].items[0];
    assert.equal(result.browser.tabs[0].url, "https://new.test");
    assert.equal(result.window.rect.x, undefined);
});

test("workspace hotkey URLs opens a manual review when Firefox capture is uncertain", async () => {
    const saved = profile("a", "Research");
    saved.items[0].browser = {profilePath:"/profiles/work",profileName:"Work",tabs:[{url:"https://old.test",title:"Old"}],activeTab:1};
    const captured = structuredClone(saved);
    captured.items[0].captureNote = "Review the tab URLs.";
    const e = await editor({profiles:[saved]});
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:{action:"update-workspace",capture:{profile:captured,suggestedId:"a"}}}));
    await tick(); await e.click("#workspace-hotkey-urls");
    assert.match(e.document.querySelector("#workspace-tabs-status").textContent, /couldn't identify/);
    assert.equal(e.document.querySelector("#message").textContent, "");
    assert.equal(e.document.querySelector("#workspace-editor").hidden, false);
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url, "https://old.test");
});

test("workspace hotkey URLs selects a source desktop before changing the draft", async () => {
    const saved = profile("a", "Research");
    saved.items[0].window.appId = "firefox.exe";
    saved.items[0].browser = {kind:"firefox",tabs:[{url:"https://old.test",title:"Old"}],activeTab:1};
    const location = (id, name) => ({id,name,current:false,windowCount:1,browserCount:1,browserTitles:[name],ambiguous:false});
    const updated = {kind:"firefox",tabs:[{url:"https://desktop-three.test",title:"Three"}],activeTab:1};
    const e = await editor({profiles:[saved],locationsByWorkspace:{a:[location("one","Desktop 1"),location("three","Desktop 3")]},currentWorkspaceTabsByDesktop:{three:[{index:0,browser:updated}]}});
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:{action:"update-workspace",capture:{profile:structuredClone(saved),suggestedId:"a"}}}));
    await tick(); await e.click("#workspace-hotkey-urls");
    assert.equal(e.document.querySelector("#workspace-draft-sources").hidden,false);
    assert.equal(e.calls.some(call=>call.command === "current_workspace_tabs"),false);
    await e.click("#workspace-draft-sources button:nth-of-type(2)");
    assert.equal(e.calls.find(call=>call.command === "current_workspace_tabs").args.desktopId,"three");
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,"https://old.test");
    await e.click("#save-workspace"); await e.click("#workspace-replace-confirm");
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,"https://desktop-three.test");
});

test("workspace hotkey URLs can add Chromium tabs to an existing app entry", async () => {
    const saved = profile("chrome", "Research");
    Object.assign(saved.items[0].window,{id:"42",pid:10,appId:"chrome.exe"});
    const captured = structuredClone(saved);
    captured.items[0].browser = {kind:"chromium",profilePath:"C:/Chrome/Default",profileName:"Person",tabs:[{url:"https://example.test",title:"Example"}],activeTab:1};
    const e = await editor({profiles:[saved],currentWorkspaceTabs:[{index:0,browser:captured.items[0].browser}]});
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:{action:"update-workspace",capture:{profile:captured,suggestedId:"chrome"}}}));
    await tick(); await e.click("#workspace-hotkey-urls"); await e.click("#save-workspace"); await e.click("#workspace-replace-confirm");
    const browser = e.stored().profiles[0].items[0].browser;
    assert.equal(browser.kind, "chromium");
    assert.equal(browser.tabs[0].url, "https://example.test");
});

test("workspace URL update recognizes a KDE Chrome desktop ID", async () => {
    const saved = profile("chrome", "Research");
    saved.platform = "linux";
    Object.assign(saved.items[0].window,{id:"42",pid:10,appId:"google-chrome.desktop"});
    const captured = structuredClone(saved);
    captured.items[0].browser = {kind:"chromium",profilePath:"/home/test/.config/google-chrome/Default",profileName:"Person",tabs:[{url:"https://example.test",title:"Example"}],activeTab:1};
    const e = await editor({profiles:[saved],currentWorkspaceTabs:[{index:0,browser:captured.items[0].browser}]});
    e.window.dispatchEvent(new e.window.CustomEvent("warp-workspace-request",{detail:{action:"update-workspace",capture:{profile:captured,suggestedId:"chrome"}}}));
    await tick(); await e.click("#workspace-hotkey-urls"); await e.click("#save-workspace"); await e.click("#workspace-replace-confirm");
    assert.equal(e.stored().profiles[0].items[0].browser.tabs[0].url,"https://example.test");
});

test("an extension update cannot be overwritten by an already open draft", async () => {
    const saved = profile("a", "Research");
    const e = await editor({profiles:[saved]});
    await e.click('[data-action="edit"]');
    const newer = {version:1,profiles:[{...saved,name:"Updated by extension"}]};
    e.replaceStored(newer);
    e.window.dispatchEvent(new e.window.CustomEvent("warp-browser-updated",{detail:"a"}));
    assert.match(e.document.querySelector('#workspace-save-status').textContent, /Browser URLs changed/);
    await e.click('#save-workspace');
    assert.match(e.document.querySelector('#workspace-save-status').textContent, /Cancel and reopen/);
    assert.equal(e.stored().profiles[0].name,"Updated by extension");
    await e.click('#discard-workspace'); await tick();
    assert.match(e.document.querySelector('#workspace-list').textContent,/Updated by extension/);
});

test("a live update to another workspace does not block the current draft", async () => {
    const work=profile("work","Work"), other=profile("other","Other");
    const e=await editor({profiles:[work,other]});
    await e.click('[data-workspace-id="work"] [data-action="edit"]');
    e.input('#workspace-name','Edited work');
    e.replaceStored({version:1,profiles:[work,{...other,name:"Other with new tabs"}]});
    e.window.dispatchEvent(new e.window.CustomEvent("warp-browser-updated",{detail:"other"}));
    assert.doesNotMatch(e.document.querySelector('#workspace-save-status').textContent,/Browser URLs changed/);
    await e.click('#save-workspace'); await tick();
    assert.deepEqual(e.stored().profiles.map(p=>p.name),['Edited work','Other with new tabs']);
});

test("a new workspace draft preserves live updates to existing workspaces", async () => {
    const existing=profile("existing","Before");
    const e=await editor({profiles:[existing]});
    await e.click('#capture-workspace'); await tick();
    e.input('#workspace-name','New workspace');
    e.replaceStored({version:1,profiles:[{...existing,name:"Updated tabs"}]});
    e.window.dispatchEvent(new e.window.CustomEvent("warp-browser-updated",{detail:"existing"}));
    await e.click('#save-workspace'); await tick();
    assert.deepEqual(e.stored().profiles.map(p=>p.name),['Updated tabs','New workspace']);
});
