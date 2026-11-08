import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {parseHTML} from "linkedom";

const html=fs.readFileSync(new URL("../ui/index.html",import.meta.url),"utf8");
const source=["error-timer.js","browser-bridge.js"].map(file=>fs.readFileSync(new URL(`../ui/${file}`,import.meta.url),"utf8")).join("\n");
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test("preparing an extension starts pairing and shows the corresponding folder and instructions", async () => {
    const {window,document}=parseHTML(html), calls=[];
    window.__TAURI__={core:{invoke:async(command,args)=>{
        calls.push({command,args});
        if(command==="bridge_status") return {enabled:false,pairingCode:""};
        if(command==="extension_setup_options") return {developer:true,firefoxStoreAvailable:false};
        if(command==="set_bridge_enabled") return {enabled:true,pairingCode:"1234:token"};
        if(command==="prepare_extension") return `fixture/${args.browser}`;
        throw new Error(command);
    }}};
    vm.runInNewContext(source,{window,document,setTimeout:()=>1,clearTimeout:()=>{}}); await tick();
    assert.equal(calls.some(call=>call.command==='set_bridge_enabled'),false,"viewing settings does not turn on the connection");
    assert.equal(document.querySelector('#browser-bridge-enabled'),null);
    assert.equal(document.querySelector('#browser-bridge-live'),null);
    document.querySelector('#prepare-firefox').click(); await tick();
    assert.equal(document.querySelector('#browser-bridge-code').value,'1234:token');
    assert.equal(document.querySelector('#browser-extension-path').value,'fixture/firefox');
    assert.equal(document.querySelector('#browser-extension-instructions').hasAttribute('open'),false);
    assert.equal(document.querySelector('#firefox-instructions').hidden,false);
    assert.equal(document.querySelector('#chromium-instructions').hidden,true);
    assert.match(document.querySelector('#firefox-instructions').textContent,/about:debugging#\/runtime\/this-firefox/);
    assert.doesNotMatch(document.querySelector('#firefox-instructions').textContent,/Select This Firefox/);
    document.querySelector('#prepare-chromium').click(); await tick();
    assert.equal(document.querySelector('#browser-extension-path').value,'fixture/chromium');
    assert.equal(document.querySelector('#chromium-instructions').hidden,false);
    assert.deepEqual(calls.filter(call=>call.command==='prepare_extension').map(call=>call.args.browser),['firefox','chromium']);
});

test("switching browsers while preparation is pending keeps the latest result", async () => {
    const {window,document}=parseHTML(html), pending={};
    window.__TAURI__={core:{invoke:(command,args)=>{
        if(command==='bridge_status') return Promise.resolve({enabled:false,pairingCode:''});
        if(command==='extension_setup_options') return Promise.resolve({developer:true,firefoxStoreAvailable:false});
        if(command==='set_bridge_enabled') return Promise.resolve({enabled:true,pairingCode:'code'});
        if(command==='prepare_extension') return new Promise((resolve,reject)=>{pending[args.browser]={resolve,reject};});
        throw Error(command);
    }}};
    vm.runInNewContext(source,{window,document,setTimeout:()=>1,clearTimeout:()=>{}}); await tick();
    document.querySelector('#prepare-chromium').click();
    document.querySelector('#prepare-firefox').click();
    pending.firefox.resolve('fixture/firefox'); await tick();
    pending.chromium.resolve('fixture/chromium'); await tick();
    assert.equal(document.querySelector('#browser-extension-path').value,'fixture/firefox');
    assert.equal(document.querySelector('#firefox-instructions').hidden,false);
    document.querySelector('#prepare-chromium').click();
    pending.chromium.reject(new Error('Cannot prepare folder')); await tick();
    assert.match(document.querySelector('#browser-bridge-status').textContent,/Cannot prepare folder/);
});

test("a slow initial status cannot overwrite the newly prepared pairing code", async () => {
    const {window,document}=parseHTML(html); let resolveStatus;
    window.__TAURI__={core:{invoke:(command)=>{
        if(command==='bridge_status') return new Promise(resolve=>{resolveStatus=resolve;});
        if(command==='extension_setup_options') return Promise.resolve({developer:true,firefoxStoreAvailable:false});
        if(command==='prepare_extension') return Promise.resolve('fixture/firefox');
        if(command==='set_bridge_enabled') return Promise.resolve({enabled:true,pairingCode:'new-code'});
        throw Error(command);
    }}};
    vm.runInNewContext(source,{window,document,setTimeout:()=>1,clearTimeout:()=>{}});
    document.querySelector('#prepare-firefox').click(); await tick();
    resolveStatus({enabled:false,pairingCode:''}); await tick();
    assert.equal(document.querySelector('#browser-bridge-code').value,'new-code');
});

test("the Firefox setup address can be copied for the selected profile", async () => {
    const {window,document}=parseHTML(html); let copied='';
    const runtimeWindow={__TAURI__:{core:{invoke:async()=>({})}},navigator:{clipboard:{writeText:async value=>{copied=value;}}}};
    vm.runInNewContext(source,{window:runtimeWindow,document,setTimeout:()=>1,clearTimeout:()=>{}}); await tick();
    document.querySelector('#copy-firefox-address').click(); await tick();
    assert.equal(copied,'about:debugging#/runtime/this-firefox');
    assert.match(document.querySelector('#browser-bridge-status').textContent,/copied/i);
});

test("the Firefox store setup offers pairing without showing development controls", async () => {
    const {document}=parseHTML(html), calls=[]; let copied='';
    const runtimeWindow={navigator:{clipboard:{writeText:async value=>{copied=value;}}}};
    runtimeWindow.__TAURI__={core:{invoke:async(command,args)=>{
        calls.push({command,args});
        if(command==='bridge_status') return {enabled:false,pairingCode:''};
        if(command==='extension_setup_options') return {developer:false,firefoxStoreAvailable:true};
        if(command==='set_bridge_enabled') return {enabled:true,pairingCode:'pairing-code'};
        if(command==='open_firefox_addon') return;
        throw Error(command);
    }}};
    vm.runInNewContext(source,{window:runtimeWindow,document,setTimeout:()=>1,clearTimeout:()=>{}}); await tick();
    assert.equal(document.querySelector('#firefox-store-setup').hidden,false);
    assert.equal(document.querySelector('#developer-extension-setup').hidden,true);
    assert.equal(calls.some(call=>call.command==='set_bridge_enabled'),false);
    document.querySelector('#open-firefox-addon').click();
    document.querySelector('#get-browser-code').click(); await tick();
    assert.equal(document.querySelector('#browser-bridge-code').value,'pairing-code');
    document.querySelector('#copy-browser-code').click(); await tick();
    assert.equal(copied,'pairing-code');
    assert.equal(calls.filter(call=>call.command==='open_firefox_addon').length,1);
});

test("the temporary Firefox setup remains available until the store listing exists", async () => {
    const {window,document}=parseHTML(html);
    window.__TAURI__={core:{invoke:async command=>command==='extension_setup_options'
        ? {developer:false,firefoxStoreAvailable:false} : command==='set_bridge_enabled'
            ? {enabled:true,pairingCode:'local-code'} : {enabled:false,pairingCode:''}}};
    vm.runInNewContext(source,{window,document,setTimeout:()=>1,clearTimeout:()=>{}}); await tick();
    assert.equal(document.querySelector('#firefox-store-setup').hidden,false);
    assert.equal(document.querySelector('#open-firefox-addon').hidden,true);
    assert.equal(document.querySelector('#developer-extension-setup').hidden,false);
    assert.equal(document.querySelector('#developer-extension-setup').open,true);
    assert.equal(document.querySelector('#prepare-chromium').hidden,true);
    assert.equal(document.querySelector('#prepare-firefox').hidden,false);
    document.querySelector('#get-browser-code').click(); await tick();
    assert.equal(document.querySelector('#browser-bridge-code').value,'local-code');
});

test("store-link and pairing failures are reported", async () => {
    const {window,document}=parseHTML(html);
    window.__TAURI__={core:{invoke:async command=>{
        if(command==='extension_setup_options') return {developer:false,firefoxStoreAvailable:true};
        if(command==='bridge_status') return {enabled:false,pairingCode:''};
        if(command==='open_firefox_addon') throw Error('Could not open Firefox Add-ons.');
        if(command==='set_bridge_enabled') throw Error('Could not start pairing.');
    }}};
    vm.runInNewContext(source,{window,document,setTimeout:()=>1,clearTimeout:()=>{}}); await tick();
    document.querySelector('#open-firefox-addon').click(); await tick();
    assert.match(document.querySelector('#browser-bridge-status').textContent,/Could not open Firefox/);
    document.querySelector('#get-browser-code').click(); await tick();
    assert.match(document.querySelector('#browser-bridge-status').textContent,/Could not start pairing/);
});
