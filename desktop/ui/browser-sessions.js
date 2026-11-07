/* Saved browsers are separate from desktop workspaces. */
(() => {
    const native = window.__TAURI__;
    const list = document.querySelector("#saved-browser-list");
    const empty = document.querySelector("#saved-browsers-empty");
    const status = document.querySelector("#saved-browser-status");
    const dialog = document.querySelector("#saved-browser-destination");
    const dialogStatus = document.querySelector("#saved-browser-destination-status");
    const sourceContent = document.querySelector("#saved-browser-source-content");
    const targetList = document.querySelector("#saved-browser-targets");
    const newButton = document.querySelector("#saved-browser-new");
    const appendButton = document.querySelector("#saved-browser-append");
    const replaceButton = document.querySelector("#saved-browser-replace");
    const cancelButton = document.querySelector("#saved-browser-destination-cancel");
    const {chromiumApp, chromiumName, isBrowserItem} = window.WarpBrowserKinds;
    let store = null;
    let choice = null;
    let destination = null;
    let refreshPending = false;
    let request = 0;

    function feedback(message, error = false) {
        window.WarpErrorTimer.set(status, message, {error, hideWhenEmpty:true});
    }
    function button(label, action) {
        const element = document.createElement("button");
        element.type = "button"; element.textContent = label;
        element.addEventListener("click", action);
        return element;
    }
    function closeChoice({restoreFocus = false, flush = true} = {}) {
        if (!choice) return;
        const previous = choice;
        choice = null;
        previous.panel.hidden = true;
        previous.trigger.setAttribute("aria-expanded", "false");
        if (flush && refreshPending) {
            refreshPending = false;
            refresh(restoreFocus ? {profileId:previous.profileId, action:previous.action} : null);
        } else if (restoreFocus) previous.trigger.focus();
    }
    function openChoice(panel, trigger, profileId, action) {
        if (choice?.trigger === trigger) { closeChoice({restoreFocus:true}); return false; }
        closeChoice({flush:false});
        choice = {panel, trigger, profileId, action};
        panel.replaceChildren(); panel.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        return true;
    }
    async function run(action) {
        try { await action(); } catch (error) { feedback(String(error?.message || error), true); }
    }
    function dialogFeedback(message, error = false) {
        window.WarpErrorTimer.set(dialogStatus, message, {error, hideWhenEmpty:true});
    }
    function browserLabel(item) {
        return item.browser?.kind === "chromium" || chromiumApp(item.window?.appId)
            ? chromiumName(item.window?.appId || "") : "Firefox";
    }
    function tabList(tabs) {
        if (!tabs.length) { const note=document.createElement("small"); note.textContent="No saved URLs."; return note; }
        const urls=document.createElement("ul"); urls.className="saved-browser-urls";
        for (const tab of tabs) { const row=document.createElement("li"); row.textContent=tab.url; urls.append(row); }
        return urls;
    }
    function dialogControls() {
        const ready=!!destination?.source && !!destination?.workspace && !destination.busy;
        const selected=ready && destination.selected !== null;
        newButton.disabled=!ready; appendButton.disabled=!selected; replaceButton.disabled=!selected;
        document.querySelector("#saved-browser-destination-close").disabled=!!destination?.busy;
        cancelButton.disabled=!!destination?.busy;
        targetList.querySelectorAll("input").forEach(input => { input.disabled=!!destination?.busy; });
    }
    function finishDestination() {
        if (!destination) return;
        const previous=destination; destination=null;
        if (refreshPending) { refreshPending=false; refresh({profileId:previous.profileId,action:"add"}); }
        else previous.trigger.focus();
    }
    function closeDestination() {
        if (!destination || destination.busy) return;
        if (typeof dialog.close === "function" && dialog.hasAttribute("open")) dialog.close();
        else { dialog.removeAttribute("open"); finishDestination(); }
    }
    function renderDestination(opened) {
        sourceContent.replaceChildren(); targetList.replaceChildren();
        const item=opened.source.items[0], browser=item.browser;
        const name=document.createElement("strong"); name.textContent=opened.source.name;
        const summary=document.createElement("small"); summary.textContent=`${browserLabel(item)} · ${browser.tabs.length} ${browser.tabs.length === 1 ? "tab" : "tabs"}`;
        sourceContent.append(name, summary, tabList(browser.tabs));
        const candidates=opened.workspace.items.map((item,index)=>({item,index})).filter(({item})=>isBrowserItem(item));
        document.querySelector("#saved-browser-target-empty").hidden=!!candidates.length;
        for (const {item,index} of candidates) {
            const tile=document.createElement("article"); tile.className="saved-browser-target";
            const label=document.createElement("label"); label.className="saved-browser-target-choice";
            const radio=document.createElement("input"); radio.type="radio"; radio.name="saved-browser-target"; radio.value=String(index);
            const text=document.createElement("span");
            const title=document.createElement("strong"); title.textContent=item.label || item.window?.title || browserLabel(item);
            const info=document.createElement("small"); const count=item.browser?.tabs?.length || 0;
            info.textContent=`${browserLabel(item)} · ${count} ${count === 1 ? "tab" : "tabs"}`;
            text.append(title,info); label.append(radio,text); tile.append(label,tabList(item.browser?.tabs || [])); targetList.append(tile);
            const selectTarget=() => {
                if (destination !== opened || opened.busy) return;
                targetList.querySelectorAll('input[name="saved-browser-target"]').forEach(input => { input.checked=input === radio; });
                opened.selected={index,item}; dialogControls();
            };
            radio.addEventListener("change", () => { if (radio.checked) selectTarget(); });
            tile.addEventListener("click", event => {
                if (label.contains(event.target) || opened.busy || destination !== opened) return;
                selectTarget(); radio.focus({preventScroll:true});
            });
        }
        if (candidates.length === 1) {
            const radio=targetList.querySelector("input"); radio.checked=true;
            opened.selected=candidates[0];
        }
        dialogControls();
    }
    async function openDestination(profile, workspace, trigger) {
        closeChoice({flush:false});
        const opened={profileId:profile.id,workspaceId:workspace.id,trigger,source:null,workspace:null,selected:null,busy:false};
        destination=opened;
        sourceContent.replaceChildren(); targetList.replaceChildren();
        document.querySelector("#saved-browser-target-empty").hidden=true;
        document.querySelector("#saved-browser-destination-subtitle").textContent=`Choose where to put these tabs in ${workspace.name}.`;
        dialogFeedback("Checking for current browser tabs…"); dialogControls();
        if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
        try {
            const [refreshResult, currentWorkspaces]=await Promise.all([
                native.core.invoke("refresh_saved_browser", {id:profile.id}).catch(async () => {
                    const saved=await native.core.invoke("get_saved_browsers");
                    return {profile:saved.profiles.find(item=>item.id===profile.id),refreshed:false};
                }),
                native.core.invoke("get_workspaces")
            ]);
            if (destination !== opened) return;
            opened.source=refreshResult.profile;
            opened.workspace=currentWorkspaces.profiles.find(item=>item.id===workspace.id);
            if (!opened.source?.items?.[0]?.browser) throw new Error("This saved browser no longer exists.");
            if (!opened.workspace) throw new Error("This workspace no longer exists.");
            renderDestination(opened);
            dialogFeedback(refreshResult.refreshed ? "Showing current browser tabs." : "Showing saved tabs; the original browser window could not be refreshed.");
            (opened.selected ? replaceButton : targetList.querySelector("input") || newButton).focus();
        } catch (error) {
            if (destination === opened) { dialogFeedback(String(error?.message || error), true); dialogControls(); }
        }
    }
    async function applyDestination(mode) {
        const opened=destination;
        if (!opened || opened.busy || !opened.source || !opened.workspace || (mode !== "new" && !opened.selected)) return;
        opened.busy=true; dialogControls();
        try {
            const target=mode === "new" ? null : {index:opened.selected.index,expected:opened.selected.item,mode};
            await native.core.invoke("add_saved_browser_to_workspace", {
                browserId:opened.profileId, workspaceId:opened.workspaceId,
                expectedSource:opened.source.items[0].browser, target
            });
            const message=mode === "new" ? `Browser added to ${opened.workspace.name}.` : `Tabs ${mode === "append" ? "appended" : "replaced"} in ${opened.workspace.name}.`;
            opened.busy=false; closeDestination(); feedback(message);
        } catch (error) {
            if (destination === opened) { opened.busy=false; dialogControls(); dialogFeedback(String(error?.message || error), true); }
        }
    }
    function handleChooserShortcut(action) {
        if (!destination || destination.busy) return false;
        if (action === "new" && !newButton.disabled) { applyDestination("new"); return true; }
        if (action === "append" && !appendButton.disabled) { applyDestination("append"); return true; }
        if (action === "replace" && !replaceButton.disabled) {
            applyDestination("replace");
            return true;
        }
        return false;
    }
    dialog.addEventListener("close", finishDestination);
    dialog.addEventListener("cancel", event => {
        if (destination?.busy) event.preventDefault();
    });
    dialog.addEventListener("keydown", event => {
        if (!destination || destination.busy || event.repeat || event.metaKey || event.altKey || !event.ctrlKey || !event.shiftKey) return;
        const action={n:"new",a:"append",r:"replace"}[event.key.toLowerCase()];
        if (action && handleChooserShortcut(action)) event.preventDefault();
    });
    document.querySelector("#saved-browser-destination-close").addEventListener("click", closeDestination);
    cancelButton.addEventListener("click", closeDestination);
    newButton.addEventListener("click", () => applyDestination("new"));
    appendButton.addEventListener("click", () => applyDestination("append"));
    replaceButton.addEventListener("click", () => handleChooserShortcut("replace"));
    function render() {
        list.replaceChildren();
        empty.hidden = !!store?.profiles.length;
        for (const [index, profile] of (store?.profiles || []).entries()) {
            const item = profile.items[0], browser = item?.browser;
            const card = document.createElement("article"); card.className="group saved-browser-card"; card.dataset.profileId=profile.id;
            const main = document.createElement("div"); main.className="saved-browser-main";
            const text = document.createElement("div"); text.className="saved-browser-description";
            const title = document.createElement("h3"); title.textContent=profile.name;
            const summary = document.createElement("p");
            const count = browser?.tabs?.length || 0;
            summary.textContent=`${browser?.kind === "chromium" ? "Chromium browser" : "Firefox"} · ${count} ${count === 1 ? "tab" : "tabs"}`;
            text.append(title, summary);
            const actions = document.createElement("div"); actions.className="saved-browser-actions";
            const panel = document.createElement("div"); panel.className="saved-browser-popover"; panel.hidden=true; panel.id=`saved-browser-choice-${index}`;
            const open = button("Open", () => run(async () => {
                closeChoice(); open.disabled=true;
                try {
                    const results=await native.core.invoke("restore_saved_browser", {id:profile.id});
                    const failed=results.find(result=>!result.restored);
                    if (failed) throw new Error(failed.error || "Could not open this saved browser.");
                    if (!results.some(result=>result.restored)) throw new Error("The saved browser did not open.");
                    feedback(results.find(result=>result.warning)?.warning || `Opened ${profile.name}.`);
                } finally { open.disabled=false; }
            }));
            const add = button("Add to workspace", async () => {
                if (!openChoice(panel, add, profile.id, "add")) return;
                const opened = choice;
                const loading=document.createElement("p"); loading.textContent="Finding workspaces…"; panel.append(loading);
                add.disabled=true;
                try {
                    const workspaces=await native.core.invoke("get_workspaces");
                    if (choice !== opened) return;
                    panel.replaceChildren();
                    const choose = workspace => { add.disabled=false; openDestination(profile, workspace, add); };
                    if (workspaces.profiles.length === 1) choose(workspaces.profiles[0]);
                    else if (!workspaces.profiles.length) {
                        const hint=document.createElement("p"); hint.textContent="Create a workspace first, then add this browser.";
                        panel.append(hint, button("Create workspace", () => { closeChoice(); document.querySelector("#capture-workspace").click(); }));
                    } else {
                        const heading=document.createElement("p"); heading.className="saved-browser-popover-title"; heading.textContent="Add to workspace";
                        panel.append(heading);
                        for (const workspace of workspaces.profiles) panel.append(button(workspace.name, () => choose(workspace)));
                    }
                    if (choice === opened) panel.querySelector("button")?.focus();
                } catch (error) {
                    if (choice === opened) closeChoice({restoreFocus:true});
                    feedback(String(error?.message || error), true);
                } finally { add.disabled=false; }
            });
            add.dataset.action="add"; add.setAttribute("aria-expanded", "false"); add.setAttribute("aria-controls", panel.id);
            const more = button("···", () => {
                document.querySelectorAll(".menu").forEach(menu => { menu.hidden=true; });
                if (!openChoice(panel, more, profile.id, "more")) return;
                const opened = choice;
                panel.append(button("Delete", () => {
                    panel.replaceChildren();
                    const hint=document.createElement("p"); hint.textContent="Delete this saved browser? Open windows and workspaces will stay as they are.";
                    const confirm=button("Delete saved browser", () => run(async () => {
                        confirm.disabled=true;
                        try {
                            store=await native.core.invoke("delete_saved_browser", {id:profile.id});
                            if (choice && choice !== opened) refreshPending=true;
                            else { closeChoice(); render(); }
                            feedback("Saved browser deleted.");
                        } finally { confirm.disabled=false; }
                    }));
                    confirm.className="saved-browser-delete";
                    panel.append(hint, confirm, button("Keep it", () => closeChoice({restoreFocus:true})));
                    confirm.focus();
                }));
                panel.querySelector("button")?.focus();
            });
            more.className="menu-button"; more.dataset.action="more";
            more.setAttribute("aria-label", `Actions for ${profile.name}`); more.setAttribute("aria-expanded", "false"); more.setAttribute("aria-controls", panel.id);
            actions.append(open, add, more, panel); main.append(text, actions); card.append(main); list.append(card);
        }
    }
    async function refresh(focus = null) {
        if (!native) return;
        if (choice || destination) { refreshPending=true; return; }
        const sequence=++request;
        try {
            const next=await native.core.invoke("get_saved_browsers");
            if (sequence === request) {
                if (choice || destination) { refreshPending=true; return; }
                store=next; render();
                if (focus) [...list.children].find(card => card.dataset.profileId === focus.profileId)?.querySelector(`[data-action="${focus.action}"]`)?.focus();
            }
        } catch (error) { if (sequence === request) feedback(String(error?.message || error), true); }
    }
    document.addEventListener("click", event => {
        if (choice && !choice.panel.contains(event.target) && !choice.trigger.contains(event.target)) closeChoice();
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && choice) { event.preventDefault(); closeChoice({restoreFocus:true}); }
    });
    document.querySelector("#show-workspaces").addEventListener("click", () => refresh());
    window.addEventListener("warp-saved-browsers-updated", () => refresh());
})();
