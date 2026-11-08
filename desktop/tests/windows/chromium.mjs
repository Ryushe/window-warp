// Opt-in Chromium extension acceptance. Uses only a new browser profile and local pages.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {createServer} from "node:http";

export async function testChromium({output,marker,invoke,until,checks,report,evaluate,click,input,wait,screenshot,cdp,native,focusFixture}) {
    const program=process.env.WARP_CHROME_BINARY;
    assert.ok(program && fs.existsSync(program),"Set WARP_CHROME_BINARY to Chrome for Testing or another Chromium browser that supports --load-extension.");
    const root=path.join(output,"owned-chromium-profile"); fs.mkdirSync(root);
    const extension=await invoke("prepare_extension",{browser:"chromium"});
    const bridge=await invoke("set_bridge_enabled",{enabled:true});
    const manifestFile=path.join(extension,"manifest.json"), newestManifest=fs.readFileSync(manifestFile,"utf8");
    const olderManifest=JSON.parse(newestManifest); olderManifest.version="0.1.0";
    fs.writeFileSync(manifestFile,JSON.stringify(olderManifest));
    const log=fs.openSync(path.join(output,"chromium.log"),"w");
    const local=path.join(output,"chromium-local");fs.mkdirSync(local);
    const pages=createServer((request,response)=>{
        const index=request.url==="/one" ? 1 : 2;
        response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
        response.end(`<!doctype html><title>${marker} Chrome ${index}</title><p>Owned fixture page</p>`);
    });
    await new Promise(resolve=>pages.listen(0,"127.0.0.1",resolve));
    const urls=["one","two"].map(name=>`http://127.0.0.1:${pages.address().port}/${name}`);
    const child=spawn(program,[`--user-data-dir=${root}`,"--remote-debugging-port=0","--enable-unsafe-extension-debugging","--no-first-run","--no-default-browser-check","--disable-background-mode","--disable-default-apps","--disable-background-networking",`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,"--new-window",...urls],{windowsHide:true,env:{...process.env,LOCALAPPDATA:local},stdio:["ignore",log,log]});
    let browserSocket, workerSocket, popupSocket;
    const sockets=[];
    const errors=[];
    async function connect(target) {
        const socket=new WebSocket(target); sockets.push(socket);
        await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
        let next=0; const requests=new Map();
        socket.addEventListener("message",event=>{const response=JSON.parse(event.data),pending=requests.get(response.id);if(!pending)return;requests.delete(response.id);clearTimeout(pending.timer);response.error?pending.reject(new Error(`${pending.method}: ${JSON.stringify(response.error)}`)):pending.resolve(response.result);});
        return {socket,call:(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{requests.delete(id);reject(new Error(`Chromium CDP timeout: ${method}`));},15000);requests.set(id,{resolve,reject,timer,method});socket.send(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})}));}),
            async evaluate(expression){const result=await this.call("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);return result.result?.value;}};
    }
    try {
        const portFile=path.join(root,"DevToolsActivePort");
        const lines=await until(()=>{if(child.exitCode!==null)throw new Error("Owned Chrome exited during startup");try{return fs.readFileSync(portFile,"utf8").trim().split(/\r?\n/);}catch{return null;}},value=>value?.length>=2,"owned Chromium debugging endpoint",60000);
        const port=Number(lines[0]); browserSocket=await connect(`ws://127.0.0.1:${port}${lines[1]}`);
        // Chrome requires Developer mode for unpacked extensions after reload.
        // Configure only the disposable test profile through Chrome's own API.
        const settingsTarget=await browserSocket.call("Target.createTarget",{url:"chrome://extensions/"});
        const settings=await until(async()=>(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(value=>value.id===settingsTarget.targetId),Boolean,"owned Chromium extensions settings",30000);
        const settingsSocket=await connect(settings.webSocketDebuggerUrl);
        await until(()=>settingsSocket.evaluate("typeof chrome.developerPrivate?.updateProfileConfiguration === 'function'"),Boolean,"Chromium extension settings API",30000);
        await settingsSocket.evaluate("chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})");
        await browserSocket.call("Target.closeTarget",{targetId:settingsTarget.targetId});
        const nativeWindow=await until(async()=>(await invoke("get_windows")).find(window=>window.pid===child.pid && window.title.includes(marker)),Boolean,"owned Chromium window",60000);
        const worker=await until(async()=>{
            const all=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            for (const value of all.filter(value=>value.type==="service_worker" && /^chrome-extension:\/\//.test(value.url) && value.url.endsWith("/background.js"))) {
                const connection=await connect(value.webSocketDebuggerUrl);
                const name=await connection.evaluate("typeof chrome.storage === 'object' && chrome.runtime.getManifest().name").catch(()=>false);
                if(name==="Window Warp") return {value,connection};
                connection.socket.close();
            }
            return null;
        },Boolean,"unpacked Chromium extension service worker",30000);
        workerSocket=worker.connection;
        const extensionId=new URL(worker.value.url).hostname;
        const profilePath=path.join(root,"Default");
        assert.ok(fs.existsSync(profilePath),"Owned Chrome default profile must exist");
        assert.equal(await workerSocket.evaluate("chrome.runtime.getManifest().version"),"0.1.0");
        assert.equal(await workerSocket.evaluate("chrome.management.getSelf().then(info => info.installType)"),"development");
        const managed=await workerSocket.evaluate("fetch(chrome.runtime.getURL('warp-managed.json')).then(response=>response.json())");
        assert.ok(managed?.id,"The loaded extension must read its managed-folder identity");
        fs.writeFileSync(manifestFile,newestManifest);
        await workerSocket.evaluate(`polling=true; chrome.storage.local.set(${JSON.stringify({enabled:true,pairing:bridge.pairingCode,profilePath,profileName:"Owned fixture"})})`);
        const updateStatus=await workerSocket.evaluate("snapshot('poll')");
        assert.equal(updateStatus.extensionVersion,JSON.parse(newestManifest).version,JSON.stringify(updateStatus));
        await workerSocket.evaluate("setTimeout(()=>{polling=false;poll()},100); true");
        // Chrome may leave a reloaded MV3 service worker idle until a popup opens.
        await new Promise(resolve=>setTimeout(resolve,2000));
        const wakePopup=await browserSocket.call("Target.createTarget",{url:`chrome-extension://${extensionId}/popup.html`,background:true});
        workerSocket=await until(async()=>{
            const all=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            for(const target of all.filter(value=>value.type==="service_worker" && value.url===`chrome-extension://${extensionId}/background.js`)) {
                const connection=await connect(target.webSocketDebuggerUrl);
                if(await connection.evaluate("chrome.runtime.getManifest().version").catch(()=>null)===JSON.parse(newestManifest).version) return connection;
                connection.socket.close();
            }
            return null;
        },Boolean,"reloaded Chromium background",30000);
        await browserSocket.call("Target.closeTarget",{targetId:wakePopup.targetId});
        await workerSocket.evaluate("chrome.windows.create({url:chrome.runtime.getURL('popup.html'),type:'popup',focused:true})");
        const popup=await until(async()=>{
            const all=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            return all.find(value=>value.type==="page" && /^chrome-extension:\/\//.test(value.url) && value.url.endsWith("/popup.html"));
        },Boolean,"owned Chromium extension popup",30000);
        popupSocket=await connect(popup.webSocketDebuggerUrl);
        try {
            await until(()=>popupSocket.evaluate("chrome.runtime?.getManifest?.().version || ''"),version=>version===JSON.parse(newestManifest).version,"managed Chromium extension reloads to the prepared version",15000);
        } catch(error) {
            const view=await popupSocket.evaluate("({url:location.href,title:document.title,text:document.body?.innerText?.slice(0,500),runtime:typeof chrome.runtime})").catch(()=>null);
            const diagTarget=await browserSocket.call("Target.createTarget",{url:"chrome://extensions/"});
            const page=await until(async()=>(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(value=>value.id===diagTarget.targetId),Boolean,"Chromium extension diagnostics");
            const diag=await connect(page.webSocketDebuggerUrl);
            const details=await diag.evaluate(`chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}).then(items=>items.filter(item=>item.id===${JSON.stringify(extensionId)}).map(item=>({id:item.id,state:item.state,version:item.version,disableReasons:item.disableReasons,manifestErrors:item.manifestErrors,runtimeErrors:item.runtimeErrors})))`).catch(()=>null);
            throw new Error(`${error}; popup: ${JSON.stringify(view)}; extension: ${JSON.stringify(details)}`);
        }
        checks.push("managed Chromium extension reloads itself after Window Warp prepares a newer version");
        assert.equal((await invoke("get_workspaces")).profiles.length,0);
        await until(()=>popupSocket.evaluate("document.querySelector('#connection').checked && document.querySelector('#status').textContent.includes('Connected') && !document.querySelector('#connection').disabled"),Boolean,"initial extension connection finishes",15000);
        await popupSocket.evaluate("document.querySelector('#connection').click(); true");
        await until(()=>popupSocket.evaluate("chrome.storage.local.get('enabled').then(value=>!value.enabled && !document.querySelector('#connection').disabled)"),Boolean,"disconnect before entering the pairing code",10000);
        await popupSocket.evaluate(`document.querySelector('#pairing').value=${JSON.stringify(bridge.pairingCode)}; document.querySelector('#connect').click(); true`);
        await until(()=>popupSocket.evaluate("chrome.storage.local.get('enabled').then(value=>value.enabled && !document.querySelector('#connected').hidden)"),Boolean,"pair a browser with no saved workspace",15000);
        await until(()=>popupSocket.evaluate("document.querySelector('#workspace').textContent"),text=>/No saved destination/.test(text),"the no-workspace destination is shown",15000);
        await popupSocket.evaluate("document.querySelector('#save-browser').click(); true");
        await until(()=>popupSocket.evaluate("!document.querySelector('#save-browser-form').hidden"),Boolean,"browser save form",10000);
        await popupSocket.evaluate("document.querySelector('#browser-name').value=''; document.querySelector('#confirm-save-browser').click(); true");
        assert.match(await popupSocket.evaluate("document.querySelector('#save-feedback').textContent"),/Give this browser a name/);
        assert.equal((await invoke('get_saved_browsers')).profiles.length,0,'an invalid save does not create a browser');
        await popupSocket.evaluate("document.querySelector('#browser-name').focus(); true");
        await popupSocket.call('Input.insertText',{text:'Owned saved browser'});
        assert.equal(await popupSocket.evaluate("document.querySelector('#browser-name').value"),'Owned saved browser','keyboard input reaches the name field');
        await popupSocket.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        await popupSocket.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        assert.equal(await popupSocket.evaluate("document.activeElement.id"),'confirm-save-browser','the save action is reachable by keyboard');
        await popupSocket.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
        await popupSocket.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        const savedBrowser=await until(()=>invoke("get_saved_browsers"),store=>store.profiles.find(profile=>profile.name==='Owned saved browser'),"browser saved without a workspace",30000);
        assert.deepEqual(savedBrowser.profiles[0].items[0].browser.tabs.map(tab=>tab.url).sort(),urls.slice().sort());
        assert.equal((await invoke("get_workspaces")).profiles.length,0);
        checks.push("the real Chromium popup pairs and saves a standalone browser without a workspace");

        await popupSocket.evaluate("document.querySelector('#live').click(); true");
        await until(()=>popupSocket.evaluate("chrome.storage.local.get('liveSharing').then(value=>value.liveSharing && !document.querySelector('#live').disabled)"),Boolean,"standalone browser live sharing",10000);
        const savedWindowId=await workerSocket.evaluate("chrome.windows.getAll({populate:true,windowTypes:['normal']}).then(windows=>windows.find(w=>!w.incognito && w.tabs.some(t=>t.url.includes('/one'))).id)");
        const standaloneUrl=`http://127.0.0.1:${pages.address().port}/standalone-live`;
        const standaloneTab=await workerSocket.evaluate(`chrome.tabs.create({windowId:${savedWindowId},url:${JSON.stringify(standaloneUrl)},active:false})`);
        await until(()=>invoke('get_saved_browsers'),store=>store.profiles[0]?.items[0]?.browser?.tabs.some(t=>t.url===standaloneUrl),'live sharing updates the standalone saved browser',30000);
        await workerSocket.evaluate(`chrome.tabs.remove(${standaloneTab.id})`);
        await until(()=>invoke('get_saved_browsers'),store=>{const tabs=store.profiles[0]?.items[0]?.browser?.tabs;return tabs?.length===2 && !tabs.some(t=>t.url===standaloneUrl);},'closing a tab updates the standalone saved browser',30000);
        assert.equal((await workerSocket.evaluate(`snapshot('status',{windowId:${savedWindowId}})`)).destination,'Owned saved browser');
        checks.push("live tab changes update the standalone browser without creating a workspace");

        await popupSocket.evaluate("document.querySelector('#live').click(); true");
        await until(()=>popupSocket.evaluate("chrome.storage.local.get('liveSharing').then(value=>!value.liveSharing && !document.querySelector('#live').disabled)"),Boolean,"turn standalone live sharing off",10000);
        const replacementUrl=`http://127.0.0.1:${pages.address().port}/replacement`;
        const replacementTab=await workerSocket.evaluate(`chrome.tabs.create({windowId:${savedWindowId},url:${JSON.stringify(replacementUrl)},active:false})`);
        await popupSocket.evaluate("document.querySelector('#save-browser').click(); true");
        await until(()=>popupSocket.evaluate("!document.querySelector('#save-browser-form').hidden && document.querySelector('#save-target').options.length>1"),Boolean,"choose an existing saved browser",10000);
        await popupSocket.evaluate(`document.querySelector('#save-target').value=${JSON.stringify(savedBrowser.profiles[0].id)}; document.querySelector('#save-target').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#confirm-save-browser').click(); true`);
        await until(()=>popupSocket.evaluate("!document.querySelector('#replace-browser-confirmation').hidden"),Boolean,"replacement confirmation",10000);
        assert.equal((await invoke('get_saved_browsers')).profiles[0].items[0].browser.tabs.length,2,'saved tabs stay intact until replacement is confirmed');
        await popupSocket.evaluate("document.querySelector('#confirm-replace-browser').click(); true");
        await until(()=>invoke('get_saved_browsers'),store=>store.profiles.length===1 && store.profiles[0].items[0].browser.tabs.some(t=>t.url===replacementUrl),'replace one saved browser after confirmation',30000);
        const refreshUrl=`http://127.0.0.1:${pages.address().port}/automatic-saved-refresh`;
        const refreshTab=await workerSocket.evaluate(`chrome.tabs.create({windowId:${savedWindowId},url:${JSON.stringify(refreshUrl)},active:false})`);
        const refreshedSaved=await invoke('refresh_saved_browser',{id:savedBrowser.profiles[0].id});
        assert.equal(refreshedSaved.refreshed,true,'the saved browser should refresh from its uniquely identified live window');
        assert.ok(refreshedSaved.profile.items[0].browser.tabs.some(tab=>tab.url===refreshUrl));
        await workerSocket.evaluate(`chrome.tabs.remove(${refreshTab.id})`);
        checks.push('a saved browser refreshes its URLs automatically from its identified live window');
        await workerSocket.evaluate(`chrome.tabs.remove(${replacementTab.id})`);
        checks.push("an existing saved browser is replaced only after explicit confirmation");

        await click('#show-settings');
        await popupSocket.evaluate("document.querySelector('#open-workspaces').click(); true");
        await wait("!document.querySelector('#workspaces-page').hidden",'extension opens the Workspaces page',15000);
        checks.push("the extension opens Window Warp directly to Workspaces");

        await popupSocket.evaluate("document.querySelector('#connection').click(); true");
        await until(()=>popupSocket.evaluate("chrome.storage.local.get('enabled').then(value=>!value.enabled && !document.querySelector('#connection').disabled)"),Boolean,"disconnect for draft capture",10000);
        await until(()=>invoke('bridge_status'),status=>!status.chromiumConnected,'disconnect clears the desktop connection status',15000);
        const captured=await invoke("capture_workspace",{name:"Owned Chromium workspace"});
        captured.profile.items=captured.profile.items.filter(item=>item.window.id===nativeWindow.id && item.window.pid===child.pid);
        assert.equal(captured.profile.items.length,1);
        await invoke("save_workspaces",{store:{version:1,profiles:[captured.profile]}});
        // The fixture saved through IPC directly; refresh the already-open UI
        // as a normal frontend save or external browser update would do.
        await evaluate("window.dispatchEvent(new CustomEvent('warp-browser-updated')); true");
        await focusFixture();
        const restored=await invoke("restore_workspace",{id:captured.profile.id});
        assert.equal(restored[0].restored,true,JSON.stringify(restored));
        assert.equal(restored[0].launched,false,"Existing Chromium must not be relaunched");
        assert.ok(!restored[0].warning?.includes("desktop association"),JSON.stringify(restored));
        checks.push("native workspace capture and open reuse the isolated Chromium window");
        await click('#show-workspaces');
        await wait("document.querySelector('[data-action=edit]') !== null",'saved Chromium workspace displayed',30000);
        await click('[data-action="edit"]');
        await wait("!document.querySelector('#workspace-editor').hidden",'unconnected Chromium draft',30000);
        await wait("document.querySelector('.browser-connection-dot')?.dataset.status === 'disconnected'",'unconnected browser indicator',10000);
        await click('.browser-connection-dot');
        await popupSocket.evaluate("document.querySelector('#connection').click(); true");
        await until(()=>popupSocket.evaluate("chrome.storage.local.get('enabled').then(value=>value.enabled && !document.querySelector('#connection').disabled)"),Boolean,"reconnect the isolated browser",10000);
        await focusFixture();
        await popupSocket.call("Page.reload");
        await until(()=>popupSocket.evaluate("document.querySelector('#status')?.textContent || ''").catch(()=>''),text=>text.includes("Connected"),"extension is connected",30000);
        assert.equal(await popupSocket.evaluate("document.querySelector('#connection').checked"),true);
        assert.equal(await popupSocket.evaluate("document.querySelector('#live').checked"),false);
        await click('#show-workspaces');
        await wait("document.querySelector('#workspace-tabs-status').textContent.includes('1 window updated')",'returning from browser setup fills missing tabs',30000);
        assert.equal(await evaluate("document.querySelector('[data-browser=tabs]').value.split('\\n').length"),2);
        assert.ok(!(await invoke('get_workspaces')).profiles[0].items[0].browser,'automatically filled tabs remain a draft');
        await click('#discard-workspace');
        checks.push("returning from browser setup automatically fills missing draft tabs");

        const copy=structuredClone(captured.profile); copy.id+='-copy'; copy.name='Unopened workspace copy';
        await invoke('save_workspaces',{store:{version:1,profiles:[(await invoke('get_workspaces')).profiles[0],copy]}});
        await evaluate("window.dispatchEvent(new CustomEvent('warp-browser-updated')); true");
        await popupSocket.evaluate("document.querySelector('#live').click(); true");
        await until(()=>popupSocket.evaluate("chrome.storage.local.get('liveSharing').then(value=>value.liveSharing && !document.querySelector('#live').disabled)"),Boolean,"live sharing enabled in the real extension",10000);
        assert.equal((await workerSocket.evaluate("snapshot('poll')")).live,true);
        const windowId=await workerSocket.evaluate("chrome.windows.getAll({populate:true,windowTypes:['normal']}).then(windows=>windows.find(w=>!w.incognito && w.tabs.some(t=>t.url.includes('/one'))).id)");
        const liveUrl=`http://127.0.0.1:${pages.address().port}/live`;
        const stale=await invoke('get_workspaces');
        const liveTab=await workerSocket.evaluate(`chrome.tabs.create({windowId:${windowId},url:${JSON.stringify(liveUrl)},active:false})`);
        await until(()=>invoke('get_workspaces'),store=>store.profiles.find(p=>p.id===captured.profile.id)?.items[0].browser?.tabs.some(t=>t.url===liveUrl),"live opening a Chromium tab saves it to the owning workspace",30000);
        const staleSave=await evaluate(`window.__TAURI__.core.invoke('save_workspaces',${JSON.stringify({store:stale,expected:stale})}).then(()=>({ok:true}),error=>({ok:false,error:String(error)}))`);
        assert.equal(staleSave.ok,false,'an old editor draft cannot overwrite newer live tabs');
        assert.match(staleSave.error,/Workspaces changed/);
        assert.ok(!(await invoke('get_workspaces')).profiles.find(p=>p.id===copy.id).items[0].browser,'an unopened workspace copy is unchanged');
        await workerSocket.evaluate(`chrome.tabs.remove(${liveTab.id})`);
        await until(()=>invoke('get_workspaces'),store=>{const tabs=store.profiles.find(p=>p.id===captured.profile.id)?.items[0].browser?.tabs;return tabs?.length===2 && !tabs.some(t=>t.url===liveUrl);},"live closing a Chromium tab saves the change",30000);
        const liveStatus=await workerSocket.evaluate(`snapshot('status',{windowId:${windowId}})`);
        assert.equal(liveStatus.destination,'Owned Chromium workspace');
        checks.push("live tab opening and closing save only the workspace that opened the Chromium window");
        const popupImage=await popupSocket.call("Page.captureScreenshot",{format:"png"});
        fs.writeFileSync(path.join(output,"chromium-extension-popup.png"),Buffer.from(popupImage.data,"base64"));
        await popupSocket.evaluate("document.querySelector('#connection').click(); true");
        await until(()=>popupSocket.evaluate("chrome.storage.local.get(['enabled','liveSharing']).then(value=>({...value,busy:document.querySelector('#connection').disabled,liveChecked:document.querySelector('#live').checked}))"),value=>!value.enabled && !value.liveSharing && !value.busy && !value.liveChecked,"browser connection disabled",10000);
        await popupSocket.evaluate("document.querySelector('#live').click(); true");
        await until(()=>popupSocket.evaluate("chrome.storage.local.get(['enabled','liveSharing']).then(value=>({...value,busy:document.querySelector('#live').disabled}))"),value=>value.enabled && value.liveSharing && !value.busy,"live sharing reconnects the paired browser",10000);
        assert.equal((await workerSocket.evaluate("snapshot('poll')")).live,true);
        await popupSocket.evaluate("document.querySelector('#live').click(); true");
        await until(()=>popupSocket.evaluate("chrome.storage.local.get(['enabled','liveSharing']).then(value=>({...value,busy:document.querySelector('#live').disabled}))"),value=>value.enabled && !value.liveSharing && !value.busy,"live sharing off leaves the connection on",10000);
        checks.push("real Chromium popup controls connection and per-profile live sharing");
        await popupSocket.evaluate("document.querySelector('#update').click(); true");
        try {
            await until(()=>popupSocket.evaluate("document.querySelector('#status')?.textContent || ''"),text=>/Updated 1 browser window/.test(text),"extension URL update",30000);
        } catch(error) {
            const observed=await workerSocket.evaluate("chrome.windows.getAll({populate:true,windowTypes:['normal']})").catch(()=>[]);
            const native=(await invoke("get_windows")).filter(window=>window.pid===child.pid).map(window=>({id:window.id,title:window.title,rect:window.rect}));
            throw new Error(`${error}; owned browser windows: ${JSON.stringify(observed.map(window=>({title:window.tabs?.find(tab=>tab.active)?.title,tabs:window.tabs?.map(tab=>tab.url)})))}; native: ${JSON.stringify(native)}`);
        }
        const item=(await invoke("get_workspaces")).profiles[0].items[0];
        assert.equal(item.browser.kind,"chromium");
        assert.deepEqual(item.browser.tabs.map(tab=>tab.url).sort(),urls.slice().sort());
        assert.equal(path.resolve(item.browser.profilePath).toLowerCase(),path.resolve(profilePath).toLowerCase());
        const after=(await invoke("get_windows")).filter(window=>window.pid===child.pid && window.title.includes(marker));
        assert.equal(after.length,1); assert.equal(after[0].id,nativeWindow.id);
        checks.push("real Chromium extension updates the active owned workspace with both live URLs and profile without duplicating its window");

        const focusStore = await invoke('get_workspaces');
        const focusProfile = focusStore.profiles.find(profile => profile.id === captured.profile.id);
        focusProfile.items[0].browser.activeTab = focusProfile.items[0].browser.tabs.findIndex(tab => tab.url === urls[0]) + 1;
        await invoke('save_workspaces',{store:focusStore});
        await evaluate("window.dispatchEvent(new CustomEvent('warp-browser-updated')); true");
        await workerSocket.evaluate("chrome.tabs.query({windowId:" + windowId + "}).then(tabs=>chrome.tabs.update(tabs.find(tab=>tab.url===" + JSON.stringify(urls[1]) + ").id,{active:true}))");
        await until(()=>invoke('get_windows'),windows=>windows.some(window=>window.id===nativeWindow.id && window.title.includes(marker + ' Chrome 2')),'other owned tab is active',30000);
        await focusFixture();
        const focused = await invoke('restore_workspace',{id:focusProfile.id});
        assert.equal(focused[0].restored,true,JSON.stringify(focused));
        assert.equal(focused[0].launched,false,'restoring the selected tab reuses the browser window');
        assert.ok(!focused[0].warning?.includes('Could not confirm the saved browser tab'),JSON.stringify(focused));
        await until(()=>workerSocket.evaluate("chrome.tabs.query({windowId:" + windowId + ",active:true}).then(tabs=>tabs[0]?.url)"),
            url=>url===urls[0],'saved tab is focused in the reused Chromium window',30000);
        checks.push('real Chromium extension focuses the saved tab in a reused workspace window');

        const newProfile = structuredClone(focusProfile);
        newProfile.id += '-focus-new';
        newProfile.name = 'Focused new browser window';
        newProfile.items[0].launch.newWindow = true;
        const freshUrls = urls.map(url => url + '?new-focus=1');
        newProfile.items[0].browser.tabs = freshUrls.map(url => ({url,title:''}));
        newProfile.items[0].browser.activeTab = 2;
        const newStore = await invoke('get_workspaces');
        newStore.profiles.push(newProfile);
        await invoke('save_workspaces',{store:newStore});
        await evaluate("window.dispatchEvent(new CustomEvent('warp-browser-updated')); true");
        const existingWindowIds = await workerSocket.evaluate("chrome.windows.getAll({populate:true,windowTypes:['normal']}).then(windows=>windows.map(window=>window.id))");
        await focusFixture();
        const openedFocus = await invoke('restore_workspace',{id:newProfile.id});
        assert.equal(openedFocus[0].restored,true,JSON.stringify(openedFocus));
        assert.equal(openedFocus[0].launched,true,'a new browser window is launched when requested');
        assert.ok(!openedFocus[0].warning?.includes('Could not confirm the saved browser tab'),JSON.stringify(openedFocus));
        const newWindow = await until(()=>workerSocket.evaluate("chrome.windows.getAll({populate:true,windowTypes:['normal']})"),
            windows=>windows.find(window=>!existingWindowIds.includes(window.id) && window.tabs.some(tab=>tab.url===freshUrls[0])),
            'new focused Chromium window',30000);
        const focusedWindow = newWindow.find(window=>!existingWindowIds.includes(window.id) && window.tabs.some(tab=>tab.url===freshUrls[0]));
        assert.deepEqual(focusedWindow.tabs.map(tab=>tab.url),freshUrls,'the updated extension preserves URL order');
        assert.equal(focusedWindow.tabs.find(tab=>tab.active).url,freshUrls[1]);
        await workerSocket.evaluate("chrome.windows.remove(" + focusedWindow.id + ")");
        const resetStore = await invoke('get_workspaces');
        resetStore.profiles = resetStore.profiles.filter(profile=>profile.id!==newProfile.id);
        await invoke('save_workspaces',{store:resetStore});
        await evaluate("window.dispatchEvent(new CustomEvent('warp-browser-updated')); true");
        await focusFixture();
        await invoke('restore_workspace',{id:focusProfile.id});
        checks.push('real Chromium extension preserves tab order and focuses the saved tab in a new workspace window');
        const shortcuts=await invoke('get_config');
        for (const binding of shortcuts.bindings) binding.enabled=['update-workspace','toggle-pause'].includes(binding.action);
        await invoke('save_config',{config:shortcuts});
        await invoke('set_enabled',{enabled:true});
        await focusFixture();
        await native('press',{key:0x84});
        await wait("!document.querySelector('#workspace-hotkey-choice').hidden",'workspace capture choices',30000);
        await click('#workspace-hotkey-new');
        await wait("!document.querySelector('#workspace-editor').hidden",'automatic Chromium workspace capture',90000);
        const selected=await evaluate(`(()=>{let count=0;for(const card of document.querySelectorAll('.workspace-item')){const keep=card.querySelector('.window-title').textContent.includes(${JSON.stringify(marker)}) && card.querySelector('[data-window=appId]').value.toLowerCase()===${JSON.stringify(path.basename(program).toLowerCase())};const box=card.querySelector('.include-window');box.checked=keep;box.dispatchEvent(new Event('change',{bubbles:true}));if(keep)count++;}return count;})()`);
        assert.equal(selected,1,'Only the owned Chromium window is selected');
        await input('#workspace-name','Automatically captured Chromium workspace');
        await wait("!document.querySelector('#save-workspace').disabled",'Chromium workspace ready to save',10000);
        await click('#save-workspace');
        const created=await until(()=>invoke('get_workspaces'),store=>store.profiles.find(profile=>profile.name==='Automatically captured Chromium workspace'),'Chromium workspace saved',30000);
        const automatic=created.profiles.find(profile=>profile.name==='Automatically captured Chromium workspace');
        assert.equal(automatic.items.length,1);
        assert.deepEqual(automatic.items[0].browser.tabs.map(tab=>tab.url).sort(),urls.slice().sort());
        assert.equal(path.resolve(automatic.items[0].browser.profilePath).toLowerCase(),path.resolve(profilePath).toLowerCase());
        await invoke('set_enabled',{enabled:false});
        checks.push("the workspace shortcut automatically captures and saves both Chromium tab URLs");
        const third=`http://127.0.0.1:${pages.address().port}/three`;
        await workerSocket.evaluate(`chrome.tabs.create({url:${JSON.stringify(third)},active:false})`);
        await until(()=>workerSocket.evaluate("chrome.tabs.query({}).then(tabs=>tabs.length)"),count=>count>=3,"third Chromium tab opens",30000);
        await evaluate("[...document.querySelectorAll('.workspace-card')].find(card=>card.querySelector('.workspace-title').textContent==='Automatically captured Chromium workspace').querySelector('[data-action=refresh-tabs]').click()");
        await until(()=>invoke('get_workspaces'),store=>store.profiles.find(profile=>profile.id===automatic.id)?.items[0].browser.tabs.length===3,"one-click saved workspace tab update",30000);
        assert.deepEqual((await invoke('get_workspaces')).profiles.find(profile=>profile.id===automatic.id).items[0].browser.tabs.map(tab=>tab.url).sort(),[...urls,third].sort());
        await evaluate("[...document.querySelectorAll('.workspace-card')].find(card=>card.querySelector('.workspace-title').textContent==='Automatically captured Chromium workspace').querySelector('[data-action=edit]').click()");
        await wait("!document.querySelector('#workspace-editor').hidden",'edit captured Chromium workspace',30000);
        assert.match(await evaluate("document.querySelector('.browser-tab-count').textContent"),/^3 tabs/,'editing sees the tabs just saved');
        await input('#workspace-name','');
        await click('#save-workspace');
        await wait("!document.querySelector('#workspace-save-status').hidden && document.querySelector('#workspace-save-status').textContent.includes('Give this workspace a name')",'workspace validation is visible by Save');
        assert.equal(await evaluate("document.querySelector('#workspace-save-status').classList.contains('error')"),true);
        await evaluate("document.querySelector('#save-workspace').scrollIntoView({block:'end'})");
        await screenshot('workspace-save-error.png');
        assert.equal((await invoke('get_workspaces')).profiles.find(profile=>profile.id===automatic.id).name,'Automatically captured Chromium workspace');
        await input('#workspace-name','Edited Chromium workspace');
        const fourth=`http://127.0.0.1:${pages.address().port}/four`;
        await workerSocket.evaluate(`chrome.tabs.create({url:${JSON.stringify(fourth)},active:false})`);
        await until(()=>workerSocket.evaluate("chrome.tabs.query({}).then(tabs=>tabs.length)"),count=>count>=4,"fourth Chromium tab opens",30000);
        await click('#refresh-workspace-tabs');
        await wait("document.querySelector('#workspace-tabs-status').textContent.includes('1 window updated')",'one-click draft tab update',30000);
        await click('.workspace-item-toggle');
        await evaluate("document.querySelector('#workspace-editor').scrollIntoView({block:'start'})");
        await screenshot('workspace-tab-refresh.png');
        assert.equal((await invoke('get_workspaces')).profiles.find(profile=>profile.id===automatic.id).items[0].browser.tabs.length,3,'draft refresh does not save early');
        await click('#save-workspace');
        const edited=await until(()=>invoke('get_workspaces'),store=>store.profiles.find(profile=>profile.id===automatic.id && profile.name==='Edited Chromium workspace'),'refreshed draft saved',30000);
        assert.deepEqual(edited.profiles.find(profile=>profile.id===automatic.id).items[0].browser.tabs.map(tab=>tab.url).sort(),[...urls,third,fourth].sort());
        assert.equal((await workerSocket.evaluate("snapshot('poll')")).live,false);
        checks.push("one click refreshes all Chromium tabs in saved workspaces and drafts with live sharing off");
        await evaluate("document.querySelector('#workspace-list').scrollIntoView({block:'start'})");
        await new Promise(resolve=>setTimeout(resolve,350));
        await screenshot('workspace-list.png');
        await click('#show-settings');
        await new Promise(resolve=>setTimeout(resolve,350));
        await screenshot('settings-sections.png');
        await click('#browser-extensions-settings > summary');
        await new Promise(resolve=>setTimeout(resolve,350));
        await screenshot('settings-browser-expanded.png');
        await click('#show-shortcuts');
        await new Promise(resolve=>setTimeout(resolve,350));
        await screenshot('shortcuts.png');
        await focusFixture();
        const openedSaved=await invoke('restore_saved_browser',{id:savedBrowser.profiles[0].id});
        assert.equal(openedSaved[0].restored,true,JSON.stringify(openedSaved));
        assert.equal(openedSaved[0].launched,true,'a saved browser opens a separate window');
        await until(()=>workerSocket.evaluate("chrome.windows.getAll({populate:true,windowTypes:['normal']}).then(w=>w.length)"),count=>count>=2,'saved browser window is restored',30000);
        await until(()=>workerSocket.evaluate(`chrome.windows.getAll({populate:true,windowTypes:['normal']}).then(windows=>windows.some(window=>window.tabs.some(tab=>tab.url===${JSON.stringify(replacementUrl)})))`),Boolean,'the restored browser includes the manually updated tab',30000);
        checks.push("a standalone saved browser restores its own window");

        // Keep both owned browser windows open and update distinct saved tab
        // sets through the same one-click path used in the workspace list.
        const browserWindows=await until(()=>workerSocket.evaluate("chrome.windows.getAll({populate:true,windowTypes:['normal']})"),windows=>windows.length>=2,'two owned Chromium windows',30000);
        const originalBrowser=browserWindows.find(window=>window.tabs.some(tab=>tab.url===fourth));
        const restoredBrowser=browserWindows.find(window=>window.tabs.some(tab=>tab.url===replacementUrl));
        assert.ok(originalBrowser && restoredBrowser && originalBrowser.id!==restoredBrowser.id,'distinct tab sets identify the two owned windows');
        const nativeBrowsers=await until(async()=>(await invoke('get_windows')).filter(window=>window.pid===child.pid && window.title.includes(marker)),windows=>windows.length>=2,'two owned native Chromium windows',30000);
        const originalNative=nativeBrowsers.find(window=>window.id===nativeWindow.id);
        const restoredNative=nativeBrowsers.find(window=>window.id!==nativeWindow.id);
        assert.ok(originalNative && restoredNative);
        const first=structuredClone(edited.profiles.find(profile=>profile.id===automatic.id).items[0]); first.window=originalNative;
        const second=structuredClone((await invoke('get_saved_browsers')).profiles[0].items[0]); second.window=restoredNative;
        const both={id:`${automatic.id}-two-browsers`,name:'Two owned browser windows',platform:'windows',items:[first,second]};
        const beforeBoth=await invoke('get_workspaces');
        await invoke('save_workspaces',{store:{version:1,profiles:[...beforeBoth.profiles,both]}});
        await evaluate("window.dispatchEvent(new CustomEvent('warp-browser-updated')); true");
        const firstNew=`http://127.0.0.1:${pages.address().port}/first-window-update`;
        const secondNew=`http://127.0.0.1:${pages.address().port}/second-window-update`;
        await workerSocket.evaluate(`chrome.tabs.create({windowId:${originalBrowser.id},url:${JSON.stringify(firstNew)},active:false})`);
        await workerSocket.evaluate(`chrome.tabs.create({windowId:${restoredBrowser.id},url:${JSON.stringify(secondNew)},active:false})`);
        await click('#show-workspaces');
        await wait("[...document.querySelectorAll('.workspace-card')].some(card=>card.querySelector('.workspace-title').textContent==='Two owned browser windows')",'two-window workspace displayed',30000);
        await evaluate("[...document.querySelectorAll('.workspace-card')].find(card=>card.querySelector('.workspace-title').textContent==='Two owned browser windows').querySelector('[data-action=refresh-tabs]').click()");
        const bothUpdated=await until(()=>invoke('get_workspaces'),store=>{
            const profile=store.profiles.find(entry=>entry.id===both.id);
            return profile?.items[0].browser?.tabs.some(tab=>tab.url===firstNew) && profile.items[1].browser?.tabs.some(tab=>tab.url===secondNew);
        },'one-click update matches each browser window to its own tabs',45000);
        const [firstTabs,secondTabs]=bothUpdated.profiles.find(profile=>profile.id===both.id).items.map(entry=>entry.browser.tabs.map(tab=>tab.url));
        assert.ok(!firstTabs.includes(secondNew) && !secondTabs.includes(firstNew),'tabs must not cross between saved windows');
        checks.push('one-click URL update automatically matches two open Chromium windows to their own saved tabs');
        await click('#show-workspaces');
        await wait("document.querySelector('.saved-browser-card [data-action=add]') !== null",'saved browser displayed',30000);
        await click('.saved-browser-card [data-action=add]');
        await wait("[...document.querySelectorAll('.saved-browser-popover button')].some(button=>button.textContent==='Two owned browser windows')",'workspace chooser shown',30000);
        await evaluate("[...document.querySelectorAll('.saved-browser-popover button')].find(button=>button.textContent==='Two owned browser windows').click()");
        await wait("document.querySelector('#saved-browser-destination').open && !document.querySelector('#saved-browser-new').disabled",'browser destination dialog ready',30000);
        assert.equal(await evaluate("document.querySelectorAll('#saved-browser-targets input').length"),2);
        const sourceUrls=await evaluate("[...document.querySelectorAll('#saved-browser-source-content .saved-browser-urls li')].map(item=>item.textContent)");
        await evaluate("document.querySelectorAll('#saved-browser-targets .saved-browser-target')[1].querySelector('li').click()");
        assert.equal(await evaluate("document.querySelectorAll('#saved-browser-targets input')[1].checked"),true);
        await click('#saved-browser-append');
        const appended=await until(()=>invoke('get_workspaces'),store=>{
            const profile=store.profiles.find(entry=>entry.id===both.id);
            return profile && sourceUrls.every(url=>profile.items[1].browser.tabs.some(tab=>tab.url===url));
        },'saved tabs appended to the selected browser',30000);
        const afterTabs=appended.profiles.find(profile=>profile.id===both.id).items[1].browser.tabs.map(tab=>tab.url);
        assert.equal(new Set(afterTabs).size,afterTabs.length,'appending deduplicates exact URLs');
        assert.deepEqual(appended.profiles.find(profile=>profile.id===both.id).items[0].browser.tabs.map(tab=>tab.url),firstTabs,'the other browser stays unchanged');
        checks.push('the destination dialog appends unique saved tabs to the chosen browser');
        await click('.saved-browser-card [data-action=add]');
        await wait("[...document.querySelectorAll('.saved-browser-popover button')].some(button=>button.textContent==='Two owned browser windows')",'workspace chooser shown again',30000);
        await evaluate("[...document.querySelectorAll('.saved-browser-popover button')].find(button=>button.textContent==='Two owned browser windows').click()");
        await wait("document.querySelector('#saved-browser-destination').open && !document.querySelector('#saved-browser-new').disabled",'replacement dialog ready',30000);
        const replacementUrls=await evaluate("[...document.querySelectorAll('#saved-browser-source-content .saved-browser-urls li')].map(item=>item.textContent)");
        await evaluate("document.querySelectorAll('#saved-browser-targets input')[0].click()");
        const replaceKey=async()=>{
            await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'R',code:'KeyR',modifiers:10,windowsVirtualKeyCode:82});
            await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'R',code:'KeyR',modifiers:10,windowsVirtualKeyCode:82});
        };
        await replaceKey();
        const replaced=await until(()=>invoke('get_workspaces'),store=>{
            const tabs=store.profiles.find(profile=>profile.id===both.id)?.items[0].browser.tabs.map(tab=>tab.url);
            return tabs && JSON.stringify(tabs)===JSON.stringify(replacementUrls);
        },'replacement by Ctrl+Shift+R',30000);
        assert.deepEqual(replaced.profiles.find(profile=>profile.id===both.id).items[1].browser.tabs.map(tab=>tab.url),afterTabs,'replacement does not change the other browser');
        checks.push('Ctrl+Shift+R replaces only the selected browser tabs');
        report.chromium={ownedProfile:true,tabCount:item.browser.tabs.length};
    } catch(error) {errors.push(error);}
    finally {
        if(browserSocket) {try {await browserSocket.call("Browser.close");} catch {}}
        for(const connection of sockets) try {connection.socket.close();} catch {}
        if(child.exitCode===null) {
            await Promise.race([new Promise(resolve=>child.once("exit",resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);
            if(child.exitCode===null) spawnSync("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
        }
        try {await invoke("set_bridge_enabled",{enabled:false});} catch(error) {errors.push(error);}
        await new Promise(resolve=>pages.close(resolve));
        fs.closeSync(log);
    }
    if(errors.length)throw new AggregateError(errors,"Chromium extension acceptance failed:\n"+errors.map(error=>String(error.stack || error)).join("\n"));
}
