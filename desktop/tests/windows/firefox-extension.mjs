// Real temporary Firefox extension/profile; no user profile is opened or changed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawn,spawnSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createServer} from "node:http";

export async function testFirefoxExtension({output,marker,native,fixtureWindow,invoke,until,checks,report,evaluate,click,input,wait,focusFixture}) {
    const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
    const tool=path.join(desktop,"src-tauri/target/windows-validation/web-ext-tool/node_modules/web-ext/bin/web-ext.js");
    const firefox=process.env.WARP_FIREFOX_BINARY || String.raw`C:\Program Files\Mozilla Firefox\firefox.exe`;
    assert.ok(fs.existsSync(tool),"Install Mozilla web-ext in the isolated test tool directory first");
    assert.ok(fs.existsSync(firefox),"Firefox is required");
    const profile=path.join(output,"owned-firefox-extension-profile");fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile,"user.js"),[
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("browser.startup.page", 0);',
        'user_pref("browser.aboutwelcome.enabled", false);',
        'user_pref("browser.sessionstore.interval", 1000);',
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);'
    ].join("\n"));
    const pages=["one","two"].map(name=>path.join(output,`firefox-extension-${name}.html`));
    pages.forEach((file,index)=>fs.writeFileSync(file,`<!doctype html><title>${marker} Extension ${index+1}</title><p>Owned fixture</p>`));
    const urls=pages.map(page=>pathToFileURL(page).href);
    const extension=await invoke("prepare_extension",{browser:"firefox"});
    fs.writeFileSync(path.join(extension,"fixture-window.html"),`<!doctype html><title>${marker} Shared title</title>`);
    const bridge=await invoke("set_bridge_enabled",{enabled:true});
    const manifestFile=path.join(extension,"manifest.json"), newestManifest=fs.readFileSync(manifestFile,"utf8");
    const olderManifest=JSON.parse(newestManifest); olderManifest.version="0.1.0";
    fs.writeFileSync(manifestFile,JSON.stringify(olderManifest));
    const startup={enabled:true,pairing:bridge.pairingCode};
    await focusFixture();
    let progress={phase:"waiting"}, addTabRequested=false, extensionUpdateRequested=false, addAppTabRequested=false;
    let liveTestRequested=false, closeLiveTabRequested=false, stopLiveRequested=false; const requestedSnapshots=[];
    const diagnostics=createServer((request,response)=>{
        if(request.method==="GET") { response.writeHead(200,{"Access-Control-Allow-Origin":"*","Content-Type":"application/json"}); response.end(JSON.stringify({addTabRequested,extensionUpdateRequested,addAppTabRequested,liveTestRequested,closeLiveTabRequested,stopLiveRequested})); return; }
        let body=""; request.setEncoding("utf8"); request.on("data",chunk=>{body+=chunk;});
        request.on("end",()=>{try{progress=JSON.parse(body);if(progress.phase==="requested snapshot")requestedSnapshots.push(progress);}catch{} response.writeHead(200,{"Access-Control-Allow-Origin":"*"});response.end("ok");});
    });
    await new Promise(resolve=>diagnostics.listen(0,"127.0.0.1",resolve));
    const diagnosticUrl=`http://127.0.0.1:${diagnostics.address().port}/`;
    // Test-only bootstrap supplies the pairing normally entered in the popup.
    // The production extension code is otherwise unchanged.
    fs.appendFileSync(path.join(extension,"background.js"),`\n(async()=>{
        const report=async phase=>{try{await fetch(${JSON.stringify(diagnosticUrl)},{method:"POST",headers:{"Content-Type":"text/plain"},body:JSON.stringify(phase)});}catch{}};
        const originalSnapshot=snapshot; let holdPollUntil=0;
        snapshot=async (...args)=>{if(args[0]==='poll' && Date.now()<holdPollUntil)return {live:false};const result=await originalSnapshot(...args);if(args[0]==='snapshot' && args[1]?.requestId && !result.error) await report({phase:'requested snapshot'});return result;};
        try {
        await report({phase:"loaded",version:api.runtime.getManifest().version});
        await new Promise(resolve=>setTimeout(resolve,5000));
        await api.storage.local.set(${JSON.stringify(startup)});
        const liveOn=await snapshot('set-live',{live:true});
        if(liveOn.error || !liveOn.live) throw Error('Could not enable Firefox live sharing: '+JSON.stringify(liveOn));
        await api.storage.local.set({liveSharing:true});
        const liveStatus=await snapshot('poll');
        if(!liveStatus.live) throw Error('Firefox live sharing did not stay enabled');
        await api.storage.local.set({liveSharing:false});
        const liveOff=await snapshot('set-live',{live:false});
        if(liveOff.error || liveOff.live) throw Error('Could not disable Firefox live sharing: '+JSON.stringify(liveOff));
        await report({phase:'live sharing disabled'});
        let focusedBrowser = false, extraTabAdded = false, firstUpdateChecked = false, appTabAdded = false;
        let liveTabId = null, liveTabClosed = false, liveTestFinished = false;
        for(let i=0;i<240;i++){
            let status=await snapshot('status');
            const workspace=status.workspaces?.find(workspace=>workspace.name==='Owned Firefox extension workspace');
            const requests=await fetch(${JSON.stringify(diagnosticUrl)}).then(response=>response.json());
            if(workspace && requests.liveTestRequested && liveTabId === null && !liveTestFinished){
                const open=await api.windows.getAll({populate:true,windowTypes:["normal"]});
                const win=open.find(window=>!window.incognito && window.tabs?.length>=2);
                if(win){
                    await snapshot('set-live',{live:true}); await api.storage.local.set({liveSharing:true});
                    await poll();
                    const tab=await api.tabs.create({windowId:win.id,url:'about:blank',active:false});
                    liveTabId=tab.id; await report({phase:'live tab opened'});
                }
            }
            if(liveTabId !== null && !liveTabClosed && requests.closeLiveTabRequested){
                await api.tabs.remove(liveTabId); liveTabClosed=true; await report({phase:'live tab closed'});
            }
            if(liveTabClosed && !liveTestFinished && requests.stopLiveRequested){
                await api.storage.local.set({liveSharing:false}); await snapshot('set-live',{live:false});
                liveTestFinished=true; await report({phase:'live test finished'});
            }
            if(workspace && !status.workspace && !extraTabAdded && (await fetch(${JSON.stringify(diagnosticUrl)}).then(response=>response.json())).addTabRequested){
                const open=await api.windows.getAll({populate:true,windowTypes:["normal"]});
                const win=open.find(window=>!window.incognito && window.tabs?.length>=2);
                if(win){await api.tabs.create({windowId:win.id,url:'about:blank',active:false});extraTabAdded=true;await report({phase:'extra tab ready'});}
            }
            if(workspace && !status.workspace && extraTabAdded && !firstUpdateChecked && (await fetch(${JSON.stringify(diagnosticUrl)}).then(response=>response.json())).extensionUpdateRequested){
                const updated=await snapshot('update'); firstUpdateChecked=true;
                await report({phase:'new workspace update',error:updated.error || null,updated:updated.updated,workspace:updated.workspace});
            }
            if(workspace && !status.workspace && firstUpdateChecked && !appTabAdded && (await fetch(${JSON.stringify(diagnosticUrl)}).then(response=>response.json())).addAppTabRequested){
                const open=await api.windows.getAll({populate:true,windowTypes:["normal"]});
                const win=open.find(window=>!window.incognito && window.tabs?.length>=3);
                if(win){
                    await api.tabs.create({windowId:win.id,url:'about:blank',active:false});
                    // Simulate an idle event page losing its ordinary timer.
                    // Only the extension alarm should wake the next poll.
                    if(polling) await polling;
                    clearTimeout(pollTimer);
                    // Model an older suspended add-on that cannot answer
                    // during Warp's original eight-second request window.
                    holdPollUntil=Date.now()+18000;
                    await api.alarms.create('connection',{delayInMinutes:0.1,periodInMinutes:0.1});
                    appTabAdded=true;await report({phase:'app refresh tab ready'});
                }
            }
            if(workspace && !status.workspace && !focusedBrowser){
                const open=await api.windows.getAll({populate:true,windowTypes:["normal"]});
                const win=open.find(window=>!window.incognito && window.tabs?.length>=2);
                if(win){await api.windows.update(win.id,{focused:true});focusedBrowser=true;status=await snapshot('status');}
            }
            if(status.workspace && workspace){
                const open=await api.windows.getAll({populate:true,windowTypes:["normal"]});
                const win=open.find(window=>!window.incognito && window.tabs?.length>=2);
                if(!win) throw Error("The original Firefox window was not found");
                const shared=api.runtime.getURL("fixture-window.html");
                await api.tabs.create({windowId:win.id,url:shared,active:true});
                const extra=await api.windows.create({url:shared,type:"normal"});
                await report({phase:"two windows created"});
                await api.tabs.create({windowId:win.id,url:"about:blank",active:false});
                for(let j=0;j<40;j++){
                    await new Promise(r=>setTimeout(r,500));
                    const updated=await snapshot('update');
                    if(updated.error) await report({phase:"automatic update",error:updated.error});
                    if(!updated.error){
                        await api.tabs.create({windowId:win.id,url:"about:blank",active:false});
                        const manual=await snapshot('update',{workspaceId:workspace.id,itemIndex:workspace.items[0].index,windowId:win.id});
                        await report({phase:"manual update",error:manual.error || null,liveToggleVerified:true});
                        if(!manual.error){await api.windows.remove(extra.id);await snapshot('disconnect');await api.storage.local.set({enabled:false});}
                        break;
                    }
                }
                break;
            }
            await new Promise(r=>setTimeout(r,500));
        }
        } catch(error) { await report({phase:"extension error",error:String(error)}); }
    })();\n`);
    const roaming=path.join(output,"firefox-extension-roaming"),local=path.join(output,"firefox-extension-local");
    fs.mkdirSync(roaming);fs.mkdirSync(local);
    const log=fs.openSync(path.join(output,"firefox-extension.log"),"w");
    const child=spawn(process.execPath,[tool,"run","--no-input","--no-reload","--no-config-discovery",`--source-dir=${extension}`,`--firefox=${firefox}`,`--firefox-profile=${profile}`,"--keep-profile-changes",...urls.map(url=>`--start-url=${url}`)],{windowsHide:true,env:{...process.env,APPDATA:roaming,LOCALAPPDATA:local,MOZ_NO_REMOTE:"1"},stdio:["ignore",log,log]});
    const errors=[];
    try {
        await until(()=>progress,value=>value.phase==="loaded" && value.version==="0.1.0","older Firefox test extension loads",30000);
        fs.writeFileSync(manifestFile,newestManifest);
        await until(()=>progress,value=>value.phase==="loaded" && value.version===JSON.parse(newestManifest).version,"managed Firefox extension reloads to the prepared version",45000);
        checks.push("managed Firefox extension reloads itself after Window Warp prepares a newer version");
        await until(()=>invoke("bridge_status"),value=>value.firefoxConnected,"Firefox extension connected",45000);
        await until(()=>progress,value=>value.phase==='live sharing disabled','Firefox live sharing disabled',30000);
        await click('#show-workspaces');
        await wait("!document.querySelector('#capture-workspace').disabled",'workspace page ready',30000);
        await focusFixture();
        await click('#capture-workspace');
        await wait("!document.querySelector('#workspace-editor').hidden",'automatic Firefox workspace capture',90000);
        const selected=await evaluate(`(()=>{let count=0;for(const card of document.querySelectorAll('.workspace-item')){const keep=card.querySelector('.window-title').textContent.includes(${JSON.stringify(marker)}) && card.querySelector('[data-window=appId]').value.toLowerCase()==='firefox.exe';const box=card.querySelector('.include-window');box.checked=keep;box.dispatchEvent(new Event('change',{bubbles:true}));if(keep)count++;}return count;})()`);
        assert.equal(selected,1,'Only the owned Firefox window is selected');
        await input('#workspace-name','Owned Firefox extension workspace');
        await wait("!document.querySelector('#save-workspace').disabled",'Firefox workspace ready to save',10000);
        await click('#save-workspace');
        const saved=await until(()=>invoke('get_workspaces'),store=>store.profiles.length===1,'Firefox workspace saved',30000);
        const capture=saved.profiles[0];
        await until(()=>requestedSnapshots.length,count=>count>0,'on-demand Firefox tab snapshot',10000);
        assert.equal(capture.items.length,1);
        const item=capture.items[0], expected=item.browser.tabs.map(tab=>tab.url).sort();
        assert.deepEqual(expected,urls.slice().sort());
        assert.equal(path.resolve(item.browser.profilePath).toLowerCase(),path.resolve(profile).toLowerCase());
        const originalWindow={id:item.window.id,pid:item.window.pid};
        const current=await until(()=>invoke("current_browser_tabs",{windowId:originalWindow.id,pid:originalWindow.pid}),value=>value?.tabs.length===2,"extension snapshot and automatic Firefox profile",30000);
        assert.deepEqual(current.tabs.map(tab=>tab.url).sort(),urls.slice().sort());
        assert.equal(path.resolve(current.profilePath).toLowerCase(),path.resolve(profile).toLowerCase());
        checks.push("creating a Firefox workspace automatically requests and saves both open tab URLs");
        liveTestRequested=true;
        await until(()=>progress,value=>value.phase==='live tab opened','Firefox live tab opens',30000);
        await until(()=>invoke('get_workspaces'),store=>store.profiles[0]?.items[0]?.browser?.tabs.length===3,'Firefox live sharing saves a newly opened tab',30000);
        closeLiveTabRequested=true;
        await until(()=>progress,value=>value.phase==='live tab closed','Firefox live tab closes',30000);
        await until(()=>invoke('get_workspaces'),store=>store.profiles[0]?.items[0]?.browser?.tabs.length===2,'Firefox live sharing saves the closed tab',30000);
        stopLiveRequested=true;
        await until(()=>progress,value=>value.phase==='live test finished','Firefox live sharing is off again',30000);
        checks.push("Firefox live sharing saves opened and closed tabs to the workspace captured for that window");
        addTabRequested=true;
        await until(()=>progress,value=>value.phase==='extra tab ready','third Firefox tab opens',30000);
        assert.equal((await invoke('get_workspaces')).profiles[0].items[0].browser.tabs.length,2,'live sharing is off');
        extensionUpdateRequested=true;
        const firstUpdate=await until(()=>progress,value=>value.phase==='new workspace update','extension updates a newly saved workspace',30000);
        assert.equal(firstUpdate.error,null,JSON.stringify(firstUpdate));
        assert.equal(firstUpdate.updated,1);
        assert.equal(firstUpdate.workspace,'Owned Firefox extension workspace');
        await until(()=>invoke('get_workspaces'),store=>store.profiles[0]?.items[0]?.browser?.tabs.length===3,'extension saves the third tab',30000);
        checks.push("Firefox extension updates a uniquely matched newly saved workspace without opening it or enabling live sharing");
        addAppTabRequested=true;
        await until(()=>progress,value=>value.phase==='app refresh tab ready','fourth Firefox tab opens',30000);
        const snapshotsBeforeRefresh=requestedSnapshots.length;
        await focusFixture();
        const appWindow = await native('app_window');
        const switched = await native('switch_fixture_desktop',{window:fixtureWindow});
        try {
            if (switched) {
                await invoke('show_editor',{appMatch:null});
                await until(()=>native('app_on_current_desktop',{window:appWindow}),Boolean,'Warp opens on the second desktop',10000);
            }
            const refreshStarted=Date.now();
            await click('[data-action="refresh-tabs"]');
            await wait("document.querySelector('.workspace-card-status').textContent.includes('Waiting for the browser')",'idle browser update is visible',10000);
            assert.equal(await evaluate("document.querySelector('#capture-workspace').disabled"),false,'other workspace actions stay available');
            const refreshed=await until(()=>invoke('get_workspaces'),store=>store.profiles[0]?.items[0]?.browser?.tabs.length===4,'one-click saved Firefox tab update',30000);
            assert.ok(Date.now()-refreshStarted>=8000,'the update survives the old request timeout');
            await until(()=>requestedSnapshots.length,count=>count>snapshotsBeforeRefresh,'Firefox alarm delivers the on-demand request',10000);
            assert.ok(refreshed.profiles[0].items[0].browser.tabs.some(tab=>tab.url==='about:blank'));
            checks.push(switched ? "one click refreshes Firefox tabs from another desktop with live sharing off" : "one click refreshes Firefox tabs in a saved workspace with live sharing off");
            if (!switched) report.skipped.push("Cross-desktop Firefox update requires an adjacent virtual desktop");
        } finally {
            if (switched) {
                await native('switch_fixture_desktop',{window:fixtureWindow,restore:true});
                await invoke('show_editor',{appMatch:null});
            }
        }
        await focusFixture();
        const opened=await invoke("restore_workspace",{id:capture.id});
        assert.equal(opened[0].restored,true,JSON.stringify(opened));
        assert.equal(opened[0].launched,false);
        assert.ok(!opened[0].warning?.includes("desktop association"),JSON.stringify(opened));
        const updated=await until(()=>invoke("get_workspaces"),store=>store.profiles[0]?.items[0]?.browser?.tabs.length===7,"automatic and manual Firefox workspace updates",60000);
        const updatedUrls=updated.profiles[0].items[0].browser.tabs.map(tab=>tab.url);
        await until(()=>progress,value=>value.liveToggleVerified===true,"Firefox per-profile live controls",10000);
        assert.equal(updatedUrls.filter(url=>url==="about:blank").length,4);
        assert.ok(urls.every(url=>updatedUrls.includes(url)));
        assert.ok(updatedUrls.some(url=>url.startsWith("moz-extension:") && url.endsWith("/fixture-window.html")));
        await until(()=>invoke("current_browser_tabs",{windowId:originalWindow.id,pid:originalWindow.pid}),value=>value===null,"disabled Firefox extension clears its snapshot",30000);
        const remaining=(await invoke("get_windows")).filter(window=>window.pid===originalWindow.pid && window.title.includes(marker));
        assert.equal(remaining.length,1);assert.equal(remaining[0].id,originalWindow.id);
        checks.push("real Firefox extension identifies its profile automatically, distinguishes two similarly titled windows, updates the active workspace automatically and manually, and clears its snapshot when disabled");
        report.firefoxExtension={ownedProfile:true,tabCount:urls.length+5};
    } catch(error) {errors.push(new Error(`${error.stack || error}\nExtension progress: ${JSON.stringify(progress)}`));}
    finally {
        if(child.exitCode===null) {
            spawnSync("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
            await Promise.race([new Promise(resolve=>child.once("exit",resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);
        }
        // web-ext may leave Firefox detached from its process tree. Close only
        // Firefox processes still using this fixture's unique profile directory.
        const closeFixture=`
            $profile = [IO.Path]::GetFullPath($env:WARP_OWNED_FIREFOX_PROFILE)
            if (-not $profile.EndsWith('\\owned-firefox-extension-profile', [StringComparison]::OrdinalIgnoreCase)) { exit 2 }
            Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'" | ForEach-Object {
                if ($_.CommandLine -and $_.CommandLine.Contains($profile) -and $_.CommandLine.Contains('-start-debugger-server')) {
                    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.ProcessId)"
                    if ($null -ne $current -and $current.CreationDate -eq $_.CreationDate -and $current.CommandLine -eq $_.CommandLine) {
                        Stop-Process -Id $_.ProcessId -ErrorAction Stop
                    }
                }
            }`;
        const cleanup=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",closeFixture],{windowsHide:true,env:{...process.env,WARP_OWNED_FIREFOX_PROFILE:profile},encoding:"utf8"});
        if(cleanup.status!==0) errors.push(new Error("Could not close the isolated Firefox profile: "+cleanup.stderr));
        try {await invoke("set_bridge_enabled",{enabled:false});} catch(error) {errors.push(error);}
        await new Promise(resolve=>diagnostics.close(resolve));
        fs.closeSync(log);
    }
    if(errors.length)throw new AggregateError(errors,"Firefox extension acceptance failed:\n"+errors.map(error=>String(error.stack || error)).join("\n"));
}
