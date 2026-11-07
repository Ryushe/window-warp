import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {parseHTML} from "linkedom";

const html=fs.readFileSync(new URL("../ui/index.html",import.meta.url),"utf8");
const source=["browser-kinds.js","browser-sessions.js"].map(file=>fs.readFileSync(new URL(`../ui/${file}`,import.meta.url),"utf8")).join("\n");
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const browser=(kind,url)=>({kind,profilePath:"",profileName:"",tabs:[{url,title:""}],activeTab:1});
const item=(label,kind,url)=>({label,window:{title:label,appId:kind==="firefox"?"firefox.exe":"chrome.exe"},browser:browser(kind,url)});
const defaultWorkspace={id:"work",name:"Work",items:[item("Work Firefox","firefox","https://old.test/")]};

async function fixture(workspaces=[defaultWorkspace], options={}) {
    const {window,document}=parseHTML(html), calls=[];
    let saved={version:1,profiles:[{id:"saved",name:"Research tabs",platform:"windows",items:[item("Research Chrome","chromium","https://new.test/")]}]};
    window.WarpErrorTimer={set(element,text,{error}){element.textContent=text;element.hidden=!text;element.classList.toggle("error",error);}};
    window.__TAURI__={core:{async invoke(command,args){
        calls.push({command,args});
        if(command==="get_saved_browsers") return structuredClone(saved);
        if(command==="get_workspaces") return {version:1,profiles:(await workspaces).map(workspace=>({items:[],...workspace}))};
        if(command==="refresh_saved_browser") {
            if(options.refreshGate) await options.refreshGate;
            if(options.refreshError) throw new Error("Browser unavailable");
            return {profile:structuredClone(saved.profiles[0]),refreshed:true};
        }
        if(command==="restore_saved_browser") return [{restored:true}];
        if(command==="delete_saved_browser") {saved.profiles=[];return structuredClone(saved);}
        if(command==="add_saved_browser_to_workspace") {
            if(options.addGate) await options.addGate;
            if(options.addError) throw new Error(options.addError);
            return {};
        }
        throw new Error(`Unexpected ${command}`);
    }}};
    vm.runInNewContext(source,{window,document});
    document.querySelector("#show-workspaces").click(); await tick();
    const click=async label=>{const element=[...document.querySelectorAll("#saved-browser-list button")].find(button=>button.textContent===label);assert.ok(element,`Missing ${label}`);element.click();await tick();await tick();};
    const press=async selector=>{const element=document.querySelector(selector);assert.ok(element,`Missing ${selector}`);element.click();await tick();await tick();};
    return {window,document,calls,click,press};
}

test("a single workspace opens a browser-and-URLs chooser before adding",async()=>{
    const e=await fixture();
    await e.click("Open");
    assert.deepEqual(JSON.parse(JSON.stringify(e.calls.find(call=>call.command==="restore_saved_browser").args)),{id:"saved"});
    await e.click("Add to workspace");
    assert.equal(e.document.querySelector("#saved-browser-destination").hasAttribute("open"),true);
    assert.match(e.document.querySelector("#saved-browser-source-content").textContent,/https:\/\/new\.test\//);
    assert.match(e.document.querySelector("#saved-browser-targets").textContent,/https:\/\/old\.test\//);
    assert.equal(e.calls.some(call=>call.command==="add_saved_browser_to_workspace"),false);
    assert.equal(e.document.querySelector("#saved-browser-replace").disabled,false);
    await e.press("#saved-browser-new");
    const request=e.calls.find(call=>call.command==="add_saved_browser_to_workspace");
    assert.equal(request.args.browserId,"saved"); assert.equal(request.args.workspaceId,"work");
    assert.equal(request.args.target,null);
    assert.equal(request.args.expectedSource.tabs[0].url,"https://new.test/");
    assert.equal(e.document.querySelector("#saved-browser-destination").hasAttribute("open"),false);
});

test("Replace tabs immediately updates the selected existing browser",async()=>{
    const e=await fixture(); await e.click("Add to workspace");
    await e.press("#saved-browser-replace");
    const target=e.calls.find(call=>call.command==="add_saved_browser_to_workspace").args.target;
    assert.equal(target.index,0); assert.equal(target.mode,"replace");
    assert.equal(target.expected.browser.tabs[0].url,"https://old.test/");
    assert.equal(e.document.querySelector("#saved-browser-destination").hasAttribute("open"),false);
});

test("Ctrl+Shift+A appends to the selected existing browser",async()=>{
    const e=await fixture(); await e.click("Add to workspace");
    const event=new e.window.Event("keydown",{bubbles:true,cancelable:true});
    for(const [key,value] of Object.entries({key:"A",altKey:false,ctrlKey:true,shiftKey:true,metaKey:false,repeat:false})) Object.defineProperty(event,key,{value});
    e.document.querySelector("#saved-browser-destination").dispatchEvent(event); await tick(); await tick();
    const target=e.calls.find(call=>call.command==="add_saved_browser_to_workspace").args.target;
    assert.equal(target.mode,"append"); assert.equal(target.index,0); assert.equal(event.defaultPrevented,true);
});

test("Ctrl+Shift+N adds a new browser when no target exists",async()=>{
    const e=await fixture([{id:"work",name:"Work",items:[]}]); await e.click("Add to workspace");
    const event=new e.window.Event("keydown",{bubbles:true,cancelable:true});
    for(const [key,value] of Object.entries({key:"N",altKey:false,ctrlKey:true,shiftKey:true,metaKey:false,repeat:false})) Object.defineProperty(event,key,{value});
    e.document.querySelector("#saved-browser-destination").dispatchEvent(event); await tick(); await tick();
    assert.equal(e.calls.find(call=>call.command==="add_saved_browser_to_workspace").args.target,null);
    assert.equal(event.defaultPrevented,true);
});

test("Ctrl+Shift+R immediately replaces tabs without Alt",async()=>{
    const e=await fixture(); await e.click("Add to workspace");
    const event=new e.window.Event("keydown",{bubbles:true,cancelable:true});
    for(const [key,value] of Object.entries({key:"R",altKey:false,ctrlKey:true,shiftKey:true,metaKey:false,repeat:false})) Object.defineProperty(event,key,{value});
    e.document.querySelector("#saved-browser-destination").dispatchEvent(event); await tick(); await tick();
    assert.equal(event.defaultPrevented,true);
    assert.equal(e.calls.find(call=>call.command==="add_saved_browser_to_workspace").args.target.mode,"replace");
});

test("a pending replacement cannot be submitted twice",async()=>{
    let release; const addGate=new Promise(resolve=>{release=resolve;});
    const e=await fixture([defaultWorkspace],{addGate}); await e.click("Add to workspace");
    await e.press("#saved-browser-replace"); await e.press("#saved-browser-replace");
    assert.equal(e.calls.filter(call=>call.command==="add_saved_browser_to_workspace").length,1);
    assert.equal(e.document.querySelector("#saved-browser-replace").disabled,true);
    release(); await tick(); await tick();
    assert.equal(e.document.querySelector("#saved-browser-destination").hasAttribute("open"),false);
});

test("clicking anywhere on a browser tile selects it for replacement",async()=>{
    const workspace={...defaultWorkspace,items:[...defaultWorkspace.items,item("Second Chrome","chromium","https://second.test/")]};
    const e=await fixture([workspace]); await e.click("Add to workspace");
    assert.equal(e.document.querySelector("#saved-browser-replace").disabled,true);
    const tiles=e.document.querySelectorAll("#saved-browser-targets .saved-browser-target");
    tiles[0].querySelector("li").click();
    assert.equal(tiles[0].querySelector("input").checked,true);
    tiles[1].querySelector("li").click();
    assert.equal(tiles[1].querySelector("input").checked,true);
    assert.equal(tiles[0].querySelector("input").checked,false);
    assert.equal(e.document.querySelector("#saved-browser-append").disabled,false);
    await e.press("#saved-browser-replace");
    const target=e.calls.find(call=>call.command==="add_saved_browser_to_workspace").args.target;
    assert.equal(target.index,1); assert.equal(target.mode,"replace"); assert.equal(target.expected.label,"Second Chrome");
});

test("Cancel closes the chooser without changing the workspace",async()=>{
    const e=await fixture(); await e.click("Add to workspace"); await e.press("#saved-browser-destination-cancel");
    assert.equal(e.document.querySelector("#saved-browser-destination").hasAttribute("open"),false);
    assert.equal(e.calls.some(call=>call.command==="add_saved_browser_to_workspace"),false);
});

test("a failed replacement stays open for retry or cancel",async()=>{
    const e=await fixture([defaultWorkspace],{addError:"Workspace changed"}); await e.click("Add to workspace");
    await e.press("#saved-browser-replace");
    assert.equal(e.document.querySelector("#saved-browser-destination").hasAttribute("open"),true);
    assert.match(e.document.querySelector("#saved-browser-destination-status").textContent,/Workspace changed/);
    assert.equal(e.document.querySelector("#saved-browser-destination-cancel").disabled,false);
});

test("a Firefox window without saved tabs is still offered as a target",async()=>{
    const workspace={...defaultWorkspace,items:[{label:"Firefox",window:{title:"Firefox",appId:"firefox.exe"}}]};
    const e=await fixture([workspace]); await e.click("Add to workspace");
    assert.match(e.document.querySelector("#saved-browser-targets").textContent,/No saved URLs/);
    await e.press("#saved-browser-append");
    assert.equal(e.calls.find(call=>call.command==="add_saved_browser_to_workspace").args.target.index,0);
});

test("a concurrent workspace change stays visible and leaves the chooser open",async()=>{
    const e=await fixture([defaultWorkspace],{addError:"This workspace changed. Reopen the browser chooser."});
    await e.click("Add to workspace"); await e.press("#saved-browser-append");
    assert.equal(e.document.querySelector("#saved-browser-destination").hasAttribute("open"),true);
    assert.match(e.document.querySelector("#saved-browser-destination-status").textContent,/workspace changed/);
    assert.equal(e.document.querySelector("#saved-browser-destination-status").classList.contains("error"),true);
    assert.equal(e.document.querySelector("#saved-browser-destination-cancel").disabled,false);
});

test("choosing one of several workspaces opens its chooser without saving",async()=>{
    const e=await fixture([defaultWorkspace,{id:"study",name:"Study",items:[]}]);
    await e.click("Add to workspace");
    await e.click("Study");
    assert.match(e.document.querySelector("#saved-browser-destination-subtitle").textContent,/Study/);
    assert.equal(e.document.querySelector("#saved-browser-target-empty").hidden,false);
    assert.equal(e.calls.some(call=>call.command==="add_saved_browser_to_workspace"),false);
    await e.press("#saved-browser-new");
    assert.equal(e.calls.find(call=>call.command==="add_saved_browser_to_workspace").args.workspaceId,"study");
});

test("a long workspace list keeps every destination selectable",async()=>{
    const workspaces=Array.from({length:40},(_,index)=>({id:String(index),name:`Workspace ${index+1}`}));
    const e=await fixture(workspaces);
    await e.click("Add to workspace"); await e.click("Workspace 40");
    assert.match(e.document.querySelector("#saved-browser-destination-subtitle").textContent,/Workspace 40/);
    await e.press("#saved-browser-new");
    assert.equal(e.calls.find(call=>call.command==="add_saved_browser_to_workspace").args.workspaceId,"39");
});

test("the workspace list can be dismissed with Escape",async()=>{
    const e=await fixture([defaultWorkspace,{id:"study",name:"Study"}]); await e.click("Add to workspace");
    const escape=new e.window.Event("keydown",{bubbles:true,cancelable:true}); Object.defineProperty(escape,"key",{value:"Escape"});
    e.document.dispatchEvent(escape);
    assert.equal(e.document.querySelector(".saved-browser-popover").hidden,true);
    assert.equal(e.document.querySelector('[data-action="add"]').getAttribute("aria-expanded"),"false");
    assert.equal(e.calls.some(call=>call.command==="add_saved_browser_to_workspace"),false);
});

test("a slow workspace lookup cannot replace a different open menu",async()=>{
    let release; const workspaces=new Promise(resolve=>{release=resolve;});
    const e=await fixture(workspaces); await e.click("Add to workspace"); await e.click("···");
    release([defaultWorkspace]); await tick(); await tick();
    assert.equal(e.document.querySelector('[data-action="more"]').getAttribute("aria-expanded"),"true");
    assert.equal(e.document.querySelector(".saved-browser-popover button").textContent,"Delete");
    assert.equal(e.calls.some(call=>call.command==="add_saved_browser_to_workspace"),false);
});

test("failed refresh falls back to the saved tabs without changing the workspace",async()=>{
    const e=await fixture([defaultWorkspace],{refreshError:true}); await e.click("Add to workspace");
    assert.match(e.document.querySelector("#saved-browser-destination-status").textContent,/Showing saved tabs/);
    assert.match(e.document.querySelector("#saved-browser-source-content").textContent,/https:\/\/new\.test\//);
    assert.equal(e.calls.some(call=>call.command==="add_saved_browser_to_workspace"),false);
});

test("a slow refresh does not reopen a chooser the user canceled",async()=>{
    let release; const refreshGate=new Promise(resolve=>{release=resolve;});
    const e=await fixture([defaultWorkspace],{refreshGate}); await e.click("Add to workspace");
    await e.press("#saved-browser-destination-cancel");
    release(); await tick(); await tick();
    assert.equal(e.document.querySelector("#saved-browser-destination").hasAttribute("open"),false);
    assert.equal(e.calls.some(call=>call.command==="add_saved_browser_to_workspace"),false);
});

test("when there are no workspaces, the browser offers to create one",async()=>{
    const e=await fixture([]); let captured=false;
    e.document.querySelector("#capture-workspace").addEventListener("click",()=>{captured=true;});
    await e.click("Add to workspace"); await e.click("Create workspace");
    assert.equal(captured,true); assert.equal(e.calls.some(call=>call.command==="add_saved_browser_to_workspace"),false);
});

test("deleting a saved browser requires an explicit confirmation",async()=>{
    const e=await fixture(); await e.click("···"); await e.click("Delete");
    assert.equal(e.calls.some(call=>call.command==="delete_saved_browser"),false);
    await e.click("Keep it"); await e.click("···"); await e.click("Delete"); await e.click("Delete saved browser");
    assert.equal(e.calls.filter(call=>call.command==="delete_saved_browser").length,1);
    assert.equal(e.document.querySelector("#saved-browsers-empty").hidden,false);
});
