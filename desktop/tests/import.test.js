import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {webcrypto} from "node:crypto";
import {parseHTML} from "linkedom";

const source = fs.readFileSync(new URL("../ui/legacy-import.js",import.meta.url),"utf8");
const scope = {window:{},TextDecoder,Uint8Array,crypto:webcrypto};
vm.runInNewContext(source,scope);
const {decode,preview,shortcut} = scope.window.WindowWarpImport;
const plain = value => JSON.parse(JSON.stringify(value));
const monitors = [{x:-1920,y:30,width:1920,height:1050},{x:0,y:0,width:1920,height:1080}];
const workspace = extra => `[Meta]\ncount=1\n[Profile1]\nid=old-id\nname=Work\nitemCount=1\n[Profile1Item1]\nprocessName=WindowsTerminal.exe\npath=C:\\WindowsApps\\Terminal.exe\ntitle=Dev\nx=-1800\ny=120\nw=800\nh=600\nstate=1\nmonitorIndex=1\n${extra}`;

test("real app/shared/settings INIs retain behavior including pointer-center actions",()=>{
    const read = name => decode(fs.readFileSync(new URL("./fixtures/legacy/"+name+".fixture",import.meta.url)));
    const apps = preview(read("window_manager_apps.ini"));
    assert.equal(apps.length,10);
    assert.equal(apps[0].value.appMatch,"Discord.exe");
    assert.equal(apps[0].value.burnerLayout,"tile-left");
    assert.equal(apps[1].value.mainMonitorAction,"focus-last");
    const hotkeys = preview(read("hotkey_registry.ini"));
    assert.equal(hotkeys.length,11);
    assert.equal(hotkeys.filter(e=>e.value).length,11);
    assert.equal(hotkeys[2].value.action,"push-left-center");
    assert.equal(hotkeys[3].value.action,"push-right-center");
    assert.match(hotkeys[2].raw,/wm.move-left-center/);
    assert.equal(hotkeys[2].problems.length,0);
    assert.deepEqual(plain(preview(read("windows_warp_settings.ini"))[0].value),{holdDelayMs:400,holdTileEnabled:true,holdMode:"radial"});
});
test("disabled shortcuts preserve their key; Linux app matches require explicit adaptation",()=>{
    const ini="[Meta]\ncount=1\n[App1]\nlabel=Disabled\nhotkey=\ndisabledHotkey=#^;\nmatch=ahk_exe app.exe";
    const app=preview(ini)[0].value;
    assert.equal(app.enabled,false); assert.equal(app.shortcut,"Ctrl+Super+;");
    const linux=preview(ini.replace("hotkey=\n","hotkey=#x\n"),{platform:"linux"})[0];
    assert.equal(linux.value.enabled,false); assert.match(linux.notes[0],/KDE/);
    for(const key of ["<^a","~#a","*#a","#a up","a & b","#^", "#F25"]) assert.throws(()=>shortcut(key));
    assert.equal(shortcut("#!PgDn"),"Alt+Super+PageDown");
    assert.equal(shortcut("#\\"),"Super+\\");
});
test("INI decoding supports BOM UTF-16, UTF-8, ANSI and literal equals/semicolons",()=>{
    const text='[Settings]\nvalue="Café=two;three"';
    assert.equal(decode(Buffer.concat([Buffer.from([255,254]),Buffer.from(text,"utf16le")])),text);
    assert.equal(decode(Buffer.from(text,"utf8")),text);
    assert.equal(decode(Buffer.from(text,"latin1")),text);
    const big=Buffer.from(text,"utf16le"); big.swap16();
    assert.equal(decode(Buffer.concat([Buffer.from([254,255]),big])),text);
    const p=preview('[Meta]\ncount=1\n[App1]\nlabel="Café=two;three"\nhotkey=#x\nmatch=ahk_exe app.exe');
    assert.equal(p[0].label,"Café=two;three");
});
test("malformed counts and duplicate INI fields fail visibly without partial conversion",()=>{
    assert.throws(()=>preview("[Meta]\ncount=99999999\n[App1]\nlabel=x"),/count/);
    assert.throws(()=>preview("[Meta]\ncount=2\n[App1]\nlabel=x"),/numbered sections/);
    assert.throws(()=>preview("[Settings]\nholdMode=tile\nholdMode=radial"),/Repeated key/);
    assert.throws(()=>preview("[Settings]\nholdMode=tile\n[Settings]\nholdMode=radial"),/Repeated section/);
    assert.throws(()=>preview("not an ini"),/line 1/);
    const match=preview("[Meta]\ncount=1\n[App1]\nhotkey=#f\nmatch=ahk_exe firefox.exe ahk_class Window\nlabel=Firefox")[0];
    assert.equal(match.value,null); assert.match(match.raw,/ahk_class/);
});
test("workspace migration preserves coordinates, state, legacy WSL and original diagnostic values",()=>{
    const entry=preview(workspace('terminalCommand=wsl.exe -d "Ubuntu-24.04" --exec old-command\nprofileName=Work\npromptIdentity=user@host:~'),{platform:"linux",monitors,uuid:()=>"new-id"})[0];
    assert.equal(entry.value.id,"new-id"); assert.equal(entry.value.platform,"windows");
    const item=entry.value.items[0];
    assert.deepEqual(plain(item.window.rect),{x:-1800,y:120,width:800,height:600});
    assert.deepEqual(plain(item.window.workArea),monitors[0]);
    assert.equal(item.window.maximizedHorizontal,true);
    assert.equal(item.launch.program,"wt.exe");
    assert.equal(item.terminal.shell,"wsl.exe"); assert.equal(item.terminal.wslDistro,"Ubuntu-24.04");
    assert.equal(item.terminal.profileName,"Work"); assert.deepEqual(plain(item.terminal.shellArgs),[]);
    assert.match(item.captureNote,/old-command/);
    assert.doesNotMatch(item.captureNote,/activation target/);
    assert.match(entry.notes.join(" "),/remains a Windows workspace/);
    assert.match(entry.raw,/promptidentity=user@host:~/);
});
test("legacy terminal titles infer known shells and flag unresolved prompt distribution",()=>{
    const shell = title => preview(workspace("").replace("title=Dev","title="+title),{monitors})[0].value.items[0];
    assert.equal(shell("Windows PowerShell").terminal.shell,"powershell.exe");
    assert.equal(shell("PowerShell 7").terminal.shell,"pwsh.exe");
    assert.equal(shell("Command Prompt").terminal.shell,"cmd.exe");
    assert.equal(shell("Ubuntu-24.04").terminal.profileName,"Ubuntu-24.04");
    assert.equal(shell("user@host:~").terminal.shell,"wsl.exe");
    assert.match(shell("user@host:~").captureNote,/cannot be resolved/);
});
test("Firefox profiles, duplicate URLs and active tab survive import",()=>{
    const ini=workspace("browserKind=firefox\nbrowserProfilePath=C:\\profiles\\work\nbrowserProfileName=Work\nbrowserActiveTab=2\nbrowserUrlCount=2\nbrowserUrl1=https://example.test/?x=1;y=2\nbrowserUrl2=https://example.test/?x=1;y=2").replace("WindowsTerminal.exe","firefox.exe");
    const item=preview(ini,{monitors})[0].value.items[0];
    assert.equal(item.browser.tabs.length,2); assert.equal(item.browser.activeTab,2);
    assert.equal(item.browser.tabs[0].url,"https://example.test/?x=1;y=2");
    assert.equal(item.browser.profilePath,"C:\\profiles\\work");
    assert.equal(item.terminal,undefined);
});
test("workspace failures retain every original item and missing monitors are explained",()=>{
    const broken=workspace("").replace("itemCount=1","itemCount=2")+"\n[Profile1Item2]\nprocessName=app.exe\nlabel=Second";
    const bad=preview(broken,{monitors})[0];
    assert.equal(bad.value,null); assert.match(bad.raw,/label=Second/);
    const noMonitor=preview(workspace(""))[0]; assert.equal(noMonitor.value,null); assert.match(noMonitor.problems[0],/No monitor/);
    const absent=preview(workspace("").replace("monitorIndex=1","monitorIndex=3"),{monitors})[0];
    assert.match(absent.value.items[0].captureNote,/saved monitor is absent/);
});

test("file review appends to an existing unsaved draft and never saves until Save", async()=>{
    const {window,document}=parseHTML(fs.readFileSync(new URL("../ui/index.html",import.meta.url),"utf8"));
    Object.defineProperty(window.HTMLSelectElement.prototype,"value",{configurable:true,get(){return this.querySelector("option[selected]")?.value ?? this.querySelector("option")?.value;},set(v){this.querySelectorAll("option").forEach(o=>o.removeAttribute("selected"));[...this.querySelectorAll("option")].find(o=>o.value===v)?.setAttribute("selected","");}});
    const calls=[];
    window.__TAURI__={event:{listen:async()=>()=>{}},core:{invoke:async(command,args)=>{
        calls.push({command,args});
        if(command==="get_status")return {enabled:false,platform:"windows",settingsPath:"test"};
        if(command==="get_config")return {version:1,bindings:[],settings:{mainMonitor:0,burnerMonitor:2}};
        if(command==="get_startup")return false;
        if(command==="take_control_request")return null;
        if(command==="get_import_monitors")return monitors;
        if(command==="save_config")return args.config;
        throw Error(command);
    }}};
    const context=vm.createContext({window,document,TextDecoder,Uint8Array,crypto:webcrypto});
    for(const file of ["app.js","legacy-import.js","import-ui.js"])vm.runInContext(fs.readFileSync(new URL("../ui/"+file,import.meta.url),"utf8"),context);
    const tick=()=>new Promise(r=>setImmediate(r)); await tick();
    document.querySelector("#add").click();
    const label=document.querySelector('[data-field="label"]');label.value="Unsaved app";label.dispatchEvent(new window.Event("input"));
    const bytes=Buffer.from("[Meta]\ncount=1\n[App1]\nlabel=<img src=x>\nhotkey=#x\nmatch=ahk_exe app.exe");
    const input=document.querySelector("#import-files");
    Object.defineProperty(input,"files",{value:[{name:"apps.ini",size:bytes.length,arrayBuffer:async()=>bytes}]});
    input.dispatchEvent(new window.Event("change"));await tick();
    assert.equal(document.querySelectorAll("#import-results article").length,1);
    assert.equal(document.querySelector("#import-results img"),null);
    assert.equal(calls.some(c=>c.command==="save_config"),false);
    document.querySelector("#apply-import").click();
    assert.equal(document.querySelectorAll(".binding").length,2);
    assert.equal(document.querySelector('[data-field="label"]').value,"Unsaved app");
    assert.equal(calls.some(c=>c.command==="save_config"),false);
    document.querySelector("#apply-import").click();
    assert.equal(document.querySelectorAll(".binding").length,2);
    document.querySelector("#save").click(); await tick();
    assert.equal(calls.find(c=>c.command==="save_config").args.config.bindings[1].appMatch,"app.exe");
});
