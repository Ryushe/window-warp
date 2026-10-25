// Opt-in acceptance through the real app. Ownership and cleanup live in fixture.py.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const samePath = (left,right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const urlKey = value => new URL(value).protocol === "file:" ? path.resolve(fileURLToPath(value)).toLowerCase() : value;
const sameRect = (left,right) => ["x","y","width","height"].every(key=>left[key]===right[key]);

export async function testFirefox({output,marker,native,invoke,evaluate,wait,click,screenshot,until,checks,report}) {
    const program = process.env.WARP_FIREFOX_BINARY || String.raw`C:\Program Files\Mozilla Firefox\firefox.exe`;
    assert.ok(fs.existsSync(program), "--firefox requires an installed Firefox executable (or WARP_FIREFOX_BINARY)");
    const profiles = ["firefox main profile","firefox other profile"].map(name=>path.join(output,name));
    const pages = ["first","second"].map(name=>path.join(output,`firefox-${name}.html`));
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
        await native("firefox_begin",{root:output,program,profiles,pages}); prepared = true;
        await native("firefox_launch",{profile:0,page:0});
        await until(async()=>{
            await native("firefox_refresh");
            return windows(profiles[0]);
        },ws=>ws.length===1 && ws[0].title.includes(marker),"owned Firefox first page",60000);
        await native("firefox_launch",{profile:0,page:1,mode:"tab"});
        await native("firefox_refresh");
        const captured = await until(()=>capture(profiles[0]),p=>p.items.length===1 && p.items[0].browser?.tabs.length===2,"initial Firefox tabs loaded",90000);
        selectedUrl = captured.items[0].browser.tabs[captured.items[0].browser.activeTab-1].url;
        assert.ok(completeTabs(captured.items[0]), "Capture must preserve both URLs and the live selected tab");
        const item = captured.items[0];
        assert.equal(item.launch.kind,"executable");
        assert.ok(samePath(item.launch.program,program));
        assert.ok(samePath(item.window.path,program));
        assert.ok(item.browser.tabs.every(tab=>tab.title.startsWith(marker)));
        checks.push("native Windows Firefox captures the owned profile, executable, two local tabs and selected tab");

        captured.id = "firefox-native-fixture"; captured.name = "Owned Firefox workspace";
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

        item.launch.newWindow = true;
        const launched = await restore(captured);
        assert.equal(launched.launched,true);
        await native("firefox_refresh");
        const restored = await until(()=>capture(profiles[0]),profile=>{
            const added = profile.items.filter(i=>!beforeReuse.includes(i.window.id));
            return profile.items.length===2 && added.length===1 && completeTabs(added[0]);
        },"new Firefox window restores two URLs and selected tab",90000);
        const newWindow = restored.items.find(i=>!beforeReuse.includes(i.window.id));
        assert.deepEqual(newWindow.window.rect,requested);
        assert.equal(urlKey(newWindow.browser.tabs[newWindow.browser.activeTab-1].url),urlKey(selectedUrl));
        checks.push("native Windows Firefox forced new-window restore preserves both URLs, selected tab and placement");

        await native("firefox_launch",{profile:1,page:0});
        await until(async()=>{await native("firefox_refresh");return windows(profiles[1]);},ws=>ws.length===1 && ws[0].title.includes(marker),"second owned Firefox profile",60000);
        await native("firefox_launch",{profile:1,page:1,mode:"tab"});
        await native("firefox_refresh");
        const otherCapture = await until(()=>capture(profiles[1]),p=>p.items.length===1
            && p.items[0].browser && samePath(p.items[0].browser.profilePath,profiles[1])
            && p.items[0].browser.tabs.length===2
            && urlKey(p.items[0].browser.tabs[p.items[0].browser.activeTab-1]?.url || "about:blank")===urlKey(selectedUrl),"identical-title second profile session",90000);
        const other = otherCapture.items[0].window;
        assert.equal(other.title,item.window.title,"The competing profile must have the identical active-tab title");
        const away = {...requested,x:area.x+80,y:area.y+80,width:requested.width-40,height:requested.height-40};
        for (const window of await windows(profiles[0])) {
            await native("place",{window:Number(window.id),rect:away});
        }
        await native("place",{window:Number(other.id),rect:{...away,x:area.x+120,y:area.y+100}});
        const otherBefore = (await until(()=>windows(profiles[1]),ws=>ws.length===1 && ws[0].title===item.window.title,"competing profile selected title"))[0];
        assert.equal(otherBefore.active,true,"The conflicting title must be active to exercise profile isolation");
        assert.equal(otherBefore.title,item.window.title,"Focus must preserve the competing identical title");
        assert.ok((await windows(profiles[0])).some(w=>w.title===otherBefore.title),"Both owned profiles must still compete on the same exact title");
        item.launch.newWindow = false;
        assert.equal((await restore(captured)).launched,false);
        await until(()=>windows(profiles[0]),ws=>ws.some(w=>sameRect(w.rect,requested)),"profile-specific reuse despite competing active title");
        assert.deepEqual((await windows(profiles[1]))[0].rect,otherBefore.rect);
        assert.equal((await windows(profiles[0])).length,2);
        checks.push("native Windows Firefox reuse rejects an active identical-title window in another owned profile");

        await evaluate("location.reload()");
        await wait("document.querySelector('#show-workspaces') && !document.querySelector('#toggle').disabled","Firefox editor reload");
        await click("#show-workspaces");
        await wait("document.querySelectorAll('#workspace-list article').length === 1","Firefox workspace list");
        await click('#workspace-list article [data-action="edit"]');
        await wait("!document.querySelector('#workspace-editor').hidden","Firefox workspace editor");
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
        await evaluate("document.querySelector('.browser-settings').open=true;document.querySelector('.browser-settings').scrollIntoView({block:'center'})");
        await screenshot("firefox-workspace.png");
        await click("#save-workspace");
        await wait("document.querySelector('#message').textContent === 'Workspace saved.'","Firefox editor save");
        const saved = (await invoke("get_workspaces")).profiles[0].items[0];
        assert.deepEqual(saved.browser,item.browser);
        checks.push("native Windows workspace editor reviews and saves captured Firefox profile, tab order, active tab and executable");
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
