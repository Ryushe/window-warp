// Opt-in acceptance through the real app. Ownership and cleanup live in fixture.py.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const samePath = (left,right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const urlKey = value => new URL(value).protocol === "file:" ? path.resolve(fileURLToPath(value)).toLowerCase() : value;
const sameRect = (left,right) => ["x","y","width","height"].every(key=>left[key]===right[key]);

export async function testFirefox({output,marker,native,invoke,evaluate,wait,click,screenshot,until,checks,report,profileLock=false}) {
    const program = process.env.WARP_FIREFOX_BINARY || String.raw`C:\Program Files\Mozilla Firefox\firefox.exe`;
    assert.ok(fs.existsSync(program), "--firefox requires an installed Firefox executable (or WARP_FIREFOX_BINARY)");
    const profiles = ["firefox main profile","firefox other profile"].map(name=>path.join(output,name));
    const pages = ["first","second","third","fourth","fifth"].map(name=>path.join(output,`firefox-${name}.html`));
    const urls = pages.map(page=>pathToFileURL(page).href);
    const preferences = {
        "browser.shell.checkDefaultBrowser":false,"browser.startup.homepage_override.mstone":"ignore",
        "browser.startup.page":0,"browser.aboutwelcome.enabled":false,"browser.newtabpage.enabled":false,
        "browser.sessionstore.interval":1000,"browser.tabs.warnOnClose":false,"browser.tabs.loadInBackground":false,
        "datareporting.policy.dataSubmissionEnabled":false,"datareporting.healthreport.uploadEnabled":false,
        "toolkit.telemetry.enabled":false,"network.captive-portal-service.enabled":false,
        "browser.startup.homepage":"about:blank","browser.messaging-system.whatsNewPanel.enabled":false
    };
    for (const profile of profiles) {
        fs.mkdirSync(profile); // A preexisting or locked profile is never borrowed.
        fs.writeFileSync(path.join(profile,"user.js"),Object.entries(preferences).map(([key,value])=>`user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n"));
    }
    if (profileLock) {
        // Only Warp's discovery reads this isolated registry. Firefox chooses
        // its owned directories through Mozilla's restart environment instead.
        const registry = path.join(output,"firefox-discovery","Mozilla","Firefox");
        fs.mkdirSync(registry,{recursive:true});
        fs.writeFileSync(path.join(registry,"profiles.ini"),profiles.map((profile,index)=>
            `[Profile${index}]\nName=Owned${index}\nIsRelative=0\nPath=${profile}\nDefault=${index}\n`).join("\n"));
    }
    pages.forEach((page,index)=>fs.writeFileSync(page,`<!doctype html><meta charset="utf-8"><title>${marker} Firefox ${index+1}</title><p>Owned local Firefox fixture ${index+1}</p>`));
    const previousStore = await invoke("get_workspaces");
    const errors = [];
    let prepared = false;
    const observations = [];
    const remember = value => {
        // This list is already filtered by helper-proven owned HWND/PID pairs.
        observations.push(value);
        if (observations.length > 8) observations.shift();
        fs.writeFileSync(path.join(output,"firefox-observations.json"),JSON.stringify(observations,null,2));
    };
    const ownership = () => native("firefox_windows");
    const belongs = (window,proof,profile) => proof.some(p=>p.id===window.id && p.pid===window.pid && (!profile || samePath(p.profile,profile)));
    async function windows(profile) {
        const proof = await ownership();
        return (await invoke("get_windows")).filter(w=>belongs(w,proof,profile));
    }
    async function capture(profile) {
        const proof = await ownership();
        // The production API enriches the desktop before returning. Filter
        // immediately; never persist another user's window/profile diagnostics.
        const captured = await invoke("capture_workspace",{name:marker+" Firefox"});
        captured.profile.items = captured.profile.items.filter(item=>belongs(item.window,proof,profile));
        remember(captured.profile.items.map(item=>({window:item.window,browser:item.browser,captureNote:item.captureNote})));
        return captured.profile;
    }
    let selectedUrl;
    const completeTabs = item => item.browser && samePath(item.browser.profilePath,profiles[0])
        && item.browser.tabs.length===2 && item.browser.tabs.every(tab=>urls.map(urlKey).includes(urlKey(tab.url)))
        && new Set(item.browser.tabs.map(tab=>urlKey(tab.url))).size===2
        && urlKey(item.browser.tabs[item.browser.activeTab-1]?.url || "about:blank")===urlKey(selectedUrl)
        && item.window.title.includes(item.browser.tabs[item.browser.activeTab-1].title);
    const restore = async profile => {
        await invoke("save_workspaces",{store:{version:1,profiles:[profile]}});
        const result = await invoke("restore_workspace",{id:profile.id});
        assert.equal(result.length,1);
        assert.equal(result[0].restored,true,JSON.stringify(result));
        return result[0];
    };
    try {
        await invoke("set_enabled",{enabled:false});
        await native("firefox_begin",{root:output,program,profiles,pages:pages.slice(0,2),environmentProfile:profileLock}); prepared = true;
        await native("firefox_launch",{profile:0,page:0});
        await until(async()=>{
            await native("firefox_refresh");
            return windows(profiles[0]);
        },ws=>ws.length===1 && ws[0].title.includes(marker),"owned Firefox first page",60000);
        await native("firefox_launch",{profile:0,page:1,mode:"tab"});
        await native("firefox_refresh");
        const captured = await until(()=>capture(profiles[0]),p=>p.items.length===1 && p.items[0].browser?.tabs.length===2,"initial Firefox tabs loaded",90000);
        if (profileLock) {
            const proof = await native("firefox_refresh");
            assert.equal(proof.find(w=>w.id===captured.items[0].window.id)?.profileArgument,false,
                "The actual owned window process must have no profile argument");
            checks.push("native Firefox restart-environment startup captures its live lock-owned profile without profile argv, despite a different registry default");
        }
        selectedUrl = captured.items[0].browser.tabs[captured.items[0].browser.activeTab-1].url;
        assert.ok(completeTabs(captured.items[0]), "Capture must preserve both URLs and the live selected tab");
        const item = captured.items[0];
        assert.equal(item.launch.kind,"executable");
        assert.ok(samePath(item.launch.program,program));
        assert.ok(samePath(item.window.path,program));
        assert.ok(item.browser.tabs.every(tab=>tab.title.startsWith(marker)));
        checks.push("native Windows Firefox captures the owned profile, executable, two local tabs and selected tab");

        captured.id = "firefox-native-fixture"; captured.name = "Owned Firefox workspace";
        const ambiguous = structuredClone(captured);
        ambiguous.items[0].browser.tabs = [];
        ambiguous.items[0].browser.activeTab = 1;
        ambiguous.items[0].captureNote = "Firefox tabs could not be matched unambiguously.";
        await invoke("save_workspaces", {store:{version:1,profiles:[ambiguous]}});
        // The fixture writes through the backend directly, so refresh the
        // editor before checking its list when the full suite has already
        // visited Workspaces.
        await evaluate("location.reload()");
        await wait("document.querySelector('#show-workspaces') && !document.querySelector('#toggle').disabled", "Firefox editor refresh");
        await click("#show-workspaces");
        await wait("document.querySelectorAll('#workspace-list article').length === 1", "ambiguous Firefox workspace");
        await click('#workspace-list article [data-action="edit"]');
        await evaluate("document.querySelector('.workspace-window-options').open=true");
        await click('.find-browser-tabs');
        await wait("!document.querySelector('.browser-session-choice').hidden", "Firefox session choices", 30000);
        await evaluate("document.querySelector('.browser-session').value='0'");
        await click('.use-browser-session');
        const chosen = await evaluate("document.querySelector('[data-browser=tabs]').value.split('\\n')");
        assert.deepEqual(chosen.map(urlKey),item.browser.tabs.map(tab=>urlKey(tab.url)));
        await click('#save-workspace');
        await wait("[...document.querySelectorAll('.workspace-card-status')].some(status => !status.hidden && status.textContent === 'Saved.')", "chosen Firefox session saved");
        assert.equal((await invoke('get_workspaces')).profiles[0].items[0].browser.tabs.length, 2);
        checks.push('native workspace editor recovers tabs by explicitly choosing an ambiguous Firefox session');
        item.launch.newWindow = false;
        item.window.maximizedHorizontal = false; item.window.maximizedVertical = false;
        item.window.fullscreen = false; item.window.minimized = false;
        const area = item.window.workArea;
        const requested = {x:area.x+40,y:area.y+40,width:Math.min(900,area.width-80),height:Math.min(650,area.height-80)};
        assert.ok(requested.width>=600 && requested.height>=400,"Firefox acceptance requires room for its normal minimum window size");
        item.window.rect = requested;
        const beforeReuse = (await windows(profiles[0])).map(w=>w.id).sort();
        const reused = await restore(captured);
        assert.equal(reused.launched,false);
        const existing = await until(()=>windows(profiles[0]),ws=>ws.some(w=>w.id===item.window.id && sameRect(w.rect,requested)),"Firefox reuse floating placement");
        assert.deepEqual(existing.map(w=>w.id).sort(),beforeReuse);
        checks.push("native Windows Firefox reuses the owned profile window and restores its floating placement");

        const bridge = await invoke("set_bridge_enabled", {enabled:true});
        try {
            const [port,token] = bridge.pairingCode.split(":");
            const send = async body => (await fetch(`http://127.0.0.1:${port}/bridge`, {method:"POST",headers:{"Content-Type":"text/plain","Origin":"moz-extension://fixture"},body:JSON.stringify({token,browser:"firefox",profilePath:profiles[0],profileName:"Fixture",...body})})).json();
            const status = await send({action:"status",windows:[]});
            assert.equal(status.workspace,captured.name);
            const tabs = structuredClone(item.browser.tabs).reverse();
            const activeTab = tabs.findIndex(tab=>urlKey(tab.url)===urlKey(selectedUrl))+1;
            const extWindow = {title:tabs[activeTab-1].title,x:requested.x,y:requested.y,width:requested.width,height:requested.height,activeTab,tabs};
            const update = await send({action:"update",windows:[extWindow]});
            assert.equal(update.updated,1,JSON.stringify(update));
            const updated = (await invoke("get_workspaces")).profiles[0].items[0];
            assert.deepEqual(updated.browser.tabs,tabs);
            assert.deepEqual(updated.window.rect,requested,"URL update must not change placement");
            const invalid = await send({token:"wrong",action:"update",windows:[extWindow]});
            assert.match(invalid.error,/pairing code/);
            checks.push("local paired extension updates only the active owned Firefox workspace and rejects a wrong code");
        } finally { await invoke("set_bridge_enabled", {enabled:false}); }

        // Change the URLs in the saved workspace while the original browser
        // remains open. The selected changed tab has a distinct title so the
        // session fallback can distinguish both owned windows.
        const changed = (await invoke("get_workspaces")).profiles[0];
        changed.items[0].browser.tabs = [structuredClone(item.browser.tabs[0]), {url:urls[2],title:`${marker} Firefox 3`}];
        changed.items[0].browser.activeTab = 2;
        await invoke("save_workspaces",{store:{version:1,profiles:[changed]}});
        const associated = await invoke("restore_workspace",{id:changed.id});
        assert.equal(associated[0].launched,false,"An already-open workspace keeps its associated browser window");
        assert.deepEqual((await invoke("get_workspaces")).profiles[0].items[0].browser.tabs,changed.items[0].browser.tabs,
            "Reopening the associated window must not replace the saved URLs");
        assert.deepEqual((await windows(profiles[0])).map(w=>w.id).sort(),beforeReuse);
        checks.push("reopening an associated workspace keeps its existing browser window and saved URLs");
        // A distinct workspace has no open-window association. It must match
        // the saved tabs rather than inheriting the first workspace's window.
        changed.id = "firefox-native-different-tabs";
        await invoke("save_workspaces",{store:{version:1,profiles:[changed]}});
        const launched = await invoke("restore_workspace",{id:changed.id});
        assert.equal(launched[0].restored,true,JSON.stringify(launched));
        assert.equal(launched[0].launched,true,`Different Firefox URLs must open a new window: ${JSON.stringify(launched)}`);
        await native("firefox_refresh");
        const restored = await until(()=>capture(profiles[0]),profile=>{
            const added = profile.items.filter(i=>!beforeReuse.includes(i.window.id));
            const browser = added[0]?.browser;
            return profile.items.length===2 && added.length===1 && browser?.tabs.length===2
                && browser.tabs.map(t=>urlKey(t.url)).sort().join("|") === changed.items[0].browser.tabs.map(t=>urlKey(t.url)).sort().join("|")
                && urlKey(browser.tabs[browser.activeTab-1].url)===urlKey(urls[2]);
        },"changed Firefox URLs create one new window with both tabs and selected tab",90000);
        const newWindow = restored.items.find(i=>!beforeReuse.includes(i.window.id));
        assert.deepEqual(newWindow.window.rect,requested);
        const allWindows = (await windows(profiles[0])).map(w=>w.id).sort();
        const again = await invoke("restore_workspace",{id:changed.id});
        assert.equal(again[0].restored,true,JSON.stringify(again));
        assert.equal(again[0].launched,false,"Matching Firefox URLs must reuse the new window");
        assert.deepEqual((await windows(profiles[0])).map(w=>w.id).sort(),allWindows);
        checks.push("different saved Firefox URLs create a window with both tabs and selected tab; reopening it reuses that window");
        const reordered = structuredClone(changed);
        reordered.items[0].browser.tabs.reverse();
        reordered.items[0].browser.activeTab = 2;
        await invoke("save_workspaces",{store:{version:1,profiles:[reordered]}});
        const reorderOpen = await invoke("restore_workspace",{id:reordered.id});
        assert.equal(reorderOpen[0].restored,true,JSON.stringify(reorderOpen));
        assert.equal(reorderOpen[0].launched,false,"Reordered tabs or another selected tab must not duplicate a window");
        assert.deepEqual((await windows(profiles[0])).map(w=>w.id).sort(),allWindows);
        checks.push("reordering saved URLs and changing the selected tab reuses the matching Firefox window");

        let otherCapture;
        if (profileLock) {
            // Exercise a separately started profile with no profile arguments.
            await native("firefox_launch",{profile:1,page:0});
            await until(async()=>{await native("firefox_refresh");return windows(profiles[1]);},ws=>ws.length===1 && ws[0].title.includes(marker),"second owned Firefox profile",60000);
            await native("firefox_launch",{profile:1,page:1,mode:"tab"});
            await native("firefox_refresh");
            otherCapture = await until(()=>capture(profiles[1]),p=>p.items.length===1
                && p.items[0].browser && samePath(p.items[0].browser.profilePath,profiles[1])
                && p.items[0].browser.tabs.length===2
                && urlKey(p.items[0].browser.tabs[p.items[0].browser.activeTab-1]?.url || "about:blank")===urlKey(selectedUrl),"identical-title second profile session",90000);
        } else {
            // Open the same workspace in a profile with no running Firefox window.
            // Other Firefox profiles are still present and must not be reused.
            const cold = structuredClone(captured);
            cold.id = "firefox-cold-profile";
            cold.items[0].window.id = "0";
            cold.items[0].window.pid = 0;
            cold.items[0].browser.profilePath = profiles[1];
            cold.items[0].browser.profileName = "";
            await invoke("save_workspaces",{store:{version:1,profiles:[cold]}});
            const coldOpen = await invoke("restore_workspace",{id:cold.id});
            assert.equal(coldOpen[0].restored,true,JSON.stringify(coldOpen));
            assert.equal(coldOpen[0].launched,true,"A profile with no open window must launch Firefox");
            await native("firefox_refresh");
            otherCapture = await until(()=>capture(profiles[1]),p=>p.items.length===1
                && p.items[0].browser && samePath(p.items[0].browser.profilePath,profiles[1])
                && p.items[0].browser.tabs.length===2
                && p.items[0].browser.tabs.map(t=>urlKey(t.url)).sort().join("|") === item.browser.tabs.map(t=>urlKey(t.url)).sort().join("|")
                && urlKey(p.items[0].browser.tabs[p.items[0].browser.activeTab-1]?.url || "about:blank")===urlKey(selectedUrl),"cold Firefox profile restores both tabs and selection",90000);
            checks.push("a Firefox profile without an open window starts with all saved tabs and its selected tab");
        }
        const other = otherCapture.items[0].window;
        if (profileLock) {
            const proof = await native("firefox_refresh");
            assert.equal(proof.find(w=>w.id===other.id)?.profileArgument,false,
                "The competing owned process must also have no profile argument");
            checks.push("native Firefox captures two concurrent no-profile-argv processes with identical titles using their separate live locks");
        }
        assert.equal(other.title,item.window.title,"The competing profile must have the identical active-tab title");
        const away = {...requested,x:area.x+80,y:area.y+80,width:requested.width-40,height:requested.height-40};
        for (const window of await windows(profiles[0])) {
            await native("firefox_place_background",{window:Number(window.id),rect:away});
        }
        await native("firefox_place_background",{window:Number(other.id),rect:{...away,x:area.x+120,y:area.y+100}});
        let competingFocused = true;
        try { await native("firefox_focus",{window:Number(other.id)}); }
        catch (error) {
            if (!String(error).includes("Windows did not focus the owned Firefox test window")) throw error;
            competingFocused = false;
            report.firefoxProfileFocusSkipped = "Windows denied focus to the competing owned Firefox profile; profile isolation was checked without an active competitor.";
        }
        const otherBefore = (await until(()=>windows(profiles[1]),ws=>ws.length===1 && ws[0].title===item.window.title,"competing profile selected title"))[0];
        if (competingFocused) assert.equal(otherBefore.active,true,"The conflicting title must be active to exercise profile isolation");
        assert.equal(otherBefore.title,item.window.title,"Focus must preserve the competing identical title");
        assert.ok((await windows(profiles[0])).some(w=>w.title===otherBefore.title),"Both owned profiles must still compete on the same exact title");
        item.launch.newWindow = false;
        assert.equal((await restore(captured)).launched,false);
        await until(()=>windows(profiles[0]),ws=>ws.some(w=>sameRect(w.rect,requested)),"profile-specific reuse despite competing active title");
        assert.deepEqual((await windows(profiles[1]))[0].rect,otherBefore.rect);
        assert.equal((await windows(profiles[0])).length,2);
        checks.push(competingFocused ? "native Windows Firefox reuse rejects an active identical-title window in another owned profile" : "native Windows Firefox reuse leaves another owned profile unchanged (competitor focus unavailable)");

        await evaluate("location.reload()");
        await wait("document.querySelector('#show-workspaces') && !document.querySelector('#toggle').disabled","Firefox editor reload");
        await click("#show-workspaces");
        await wait("document.querySelectorAll('#workspace-list article').length === 1","Firefox workspace list");
        await click('#workspace-list article [data-action="edit"]');
        await wait("!document.querySelector('#workspace-editor').hidden","Firefox workspace editor");
        await wait("!document.querySelector('#add-workspace-window').disabled","workspace controls ready");
        assert.equal(await evaluate("document.querySelector('#refresh-workspace-tabs').hidden"),false);
        await click('#add-workspace-window');
        assert.equal(await evaluate("document.querySelector('#workspace-add-from-list').textContent"),'Choose open windows');
        await click('#add-workspace-window');
        await evaluate("document.querySelector('.workspace-windows-heading').scrollIntoView({block:'center'})");
        await screenshot("firefox-workspace-toolbar.png");
        const reviewed = await evaluate(`(() => {const row=document.querySelector('.workspace-item');return {
            profilePath:row.querySelector('[data-browser=profilePath]').value,
            profileName:row.querySelector('[data-browser=profileName]').value,
            tabs:row.querySelector('[data-browser=tabs]').value.split('\\n'),
            activeTab:Number(row.querySelector('[data-browser=activeTab]').value),
            program:row.querySelector('[data-launch=program]').value,
            newWindow:row.querySelector('[data-launch=newWindow]').checked};})()`);
        assert.ok(samePath(reviewed.profilePath,profiles[0]));
        assert.equal(reviewed.profileName,item.browser.profileName);
        assert.deepEqual(reviewed.tabs,item.browser.tabs.map(t=>t.url));
        assert.equal(reviewed.activeTab,item.browser.activeTab);
        assert.ok(samePath(reviewed.program,program));
        assert.equal(reviewed.newWindow,false);
        await evaluate("document.querySelector('.workspace-window-options').open=true;document.querySelector('.browser-settings').scrollIntoView({block:'center'})");
        await screenshot("firefox-workspace.png");
        await click("#save-workspace");
        await wait("[...document.querySelectorAll('.workspace-card-status')].some(status => !status.hidden && status.textContent === 'Saved.')","Firefox editor save");
        const saved = (await invoke("get_workspaces")).profiles[0].items[0];
        assert.deepEqual(saved.browser,item.browser);
        checks.push("native Windows workspace editor reviews and saves captured Firefox profile, tab order, active tab and executable");
        // Different URL multiplicities and a single URL both need their own
        // windows; use uniquely titled owned pages to avoid session ambiguity.
        const duplicate = structuredClone(captured);
        duplicate.id = "firefox-duplicate-tabs";
        duplicate.items[0].browser.tabs = [0,1].map(()=>({url:urls[3],title:`${marker} Firefox 4`}));
        duplicate.items[0].browser.activeTab = 2;
        const priorWindows = (await windows(profiles[0])).map(w=>w.id);
        await invoke("save_workspaces",{store:{version:1,profiles:[duplicate]}});
        const duplicateOpen = await invoke("restore_workspace",{id:duplicate.id});
        assert.equal(duplicateOpen[0].restored,true,JSON.stringify(duplicateOpen));
        assert.equal(duplicateOpen[0].launched,true,"Repeated URLs differ from the existing window");
        await native("firefox_refresh");
        const duplicateCapture = await until(()=>capture(profiles[0]),p=>p.items.find(i=>!priorWindows.includes(i.window.id) && i.browser?.tabs.length===2 && i.browser.tabs.every(tab=>urlKey(tab.url)===urlKey(urls[3]))),"Firefox restores two copies of the same URL",90000);
        const duplicateId = duplicateCapture.items.find(i=>!priorWindows.includes(i.window.id) && i.browser?.tabs.length===2 && i.browser.tabs.every(tab=>urlKey(tab.url)===urlKey(urls[3]))).window.id;
        const duplicateAgain = await invoke("restore_workspace",{id:duplicate.id});
        assert.equal(duplicateAgain[0].launched,false,"The repeated-URL window should be reused");
        assert.ok((await windows(profiles[0])).some(w=>w.id===duplicateId));
        checks.push("Firefox restores and reuses a window containing the same URL twice");

        const single = structuredClone(captured);
        single.id = "firefox-single-tab";
        single.items[0].browser.tabs = [{url:urls[4],title:`${marker} Firefox 5`}];
        single.items[0].browser.activeTab = 1;
        const beforeSingle = (await windows(profiles[0])).map(w=>w.id);
        await invoke("save_workspaces",{store:{version:1,profiles:[single]}});
        const singleOpen = await invoke("restore_workspace",{id:single.id});
        assert.equal(singleOpen[0].restored,true,JSON.stringify(singleOpen));
        assert.equal(singleOpen[0].launched,true,"A different single URL must open a window");
        await native("firefox_refresh");
        await until(()=>capture(profiles[0]),p=>p.items.some(i=>!beforeSingle.includes(i.window.id) && i.browser?.tabs.length===1 && urlKey(i.browser.tabs[0].url)===urlKey(urls[4])),"Firefox restores a single URL in a new window",90000);
        checks.push("Firefox restores a single saved URL in a new window");

        const forced = structuredClone(single);
        forced.items[0].launch.newWindow = true;
        const beforeForced = (await windows(profiles[0])).map(w=>w.id);
        await invoke("save_workspaces",{store:{version:1,profiles:[forced]}});
        const forcedOpen = await invoke("restore_workspace",{id:forced.id});
        assert.equal(forcedOpen[0].restored,true,JSON.stringify(forcedOpen));
        assert.equal(forcedOpen[0].launched,true,"Require a new window must override the active workspace association");
        await native("firefox_refresh");
        await until(()=>windows(profiles[0]),ws=>ws.some(w=>!beforeForced.includes(w.id)),"explicit new Firefox window",60000);
        checks.push("requiring a new window overrides an existing workspace association");

        const oldWindows = (await windows(profiles[0])).map(w=>({id:w.id,rect:w.rect})).sort((a,b)=>a.id.localeCompare(b.id));
        const changedProfile = structuredClone(forced);
        changedProfile.items[0].launch.newWindow = false;
        changedProfile.items[0].browser.profilePath = profiles[1];
        changedProfile.items[0].browser.profileName = "";
        changedProfile.items[0].window.rect = {...requested,x:area.x+130,y:area.y+120};
        await invoke("save_workspaces",{store:{version:1,profiles:[changedProfile]}});
        const profileOpen = await invoke("restore_workspace",{id:changedProfile.id});
        assert.equal(profileOpen[0].restored,true,JSON.stringify(profileOpen));
        await native("firefox_refresh");
        await until(()=>windows(profiles[1]),ws=>ws.some(w=>sameRect(w.rect,changedProfile.items[0].window.rect)),
            "changed Firefox profile opens on the requested placement",60000);
        assert.deepEqual((await windows(profiles[0])).map(w=>({id:w.id,rect:w.rect})).sort((a,b)=>a.id.localeCompare(b.id)),oldWindows,
            "Changing profiles must not move windows belonging to the old profile");
        checks.push("changing an associated Firefox profile leaves the old profile's windows untouched");
        report.firefox = {profiles,urls,ownedWindowIds:restored.items.map(i=>i.window.id)};
    } catch (error) {
        errors.push(error);
    } finally {
        if (prepared) {
            try {
                report.firefoxCleanup = await native("firefox_cleanup");
                assert.deepEqual(report.firefoxCleanup.errors,[],"Owned Firefox cleanup must complete");
                checks.push("Firefox cleanup closes only proven-owned profiles and their creation-verified descendants");
            } catch (error) { errors.push(error); }
        }
        try { await invoke("save_workspaces",{store:previousStore}); }
        catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors,"Windows Firefox acceptance or cleanup failed:\n"+errors.map(error=>String(error.stack || error)).join("\n"));
}
