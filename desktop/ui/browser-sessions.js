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
    const editor = document.querySelector("#saved-browser-editor");
    const editorStatus = document.querySelector("#saved-browser-editor-status");
    const {chromiumApp, chromiumName, isBrowserItem} = window.WarpBrowserKinds;
    let store = null;
    let choice = null;
    let destination = null;
    let browserEdit = null;
    let deletingBrowser = false;
    let refreshPending = false;
    let request = 0;
    const expandedBrowsers = new Set();

    function feedback(message, error = false) {
        window.WarpErrorTimer.set(status, message, {error, hideWhenEmpty:true});
    }
    function button(label, action) {
        const element = document.createElement("button");
        element.type = "button"; element.textContent = label;
        element.addEventListener("click", action);
        return element;
    }
    function iconButton(label, kind, action) {
        const element=button("", action); element.className=`workspace-icon-button${kind === "delete" ? " danger-icon" : ""}`;
        element.title=label; element.setAttribute("aria-label", label);
        element.innerHTML=kind === "edit"
            ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4"/></svg>'
            : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg>';
        return element;
    }
    function editorFeedback(message, error = false) {
        window.WarpErrorTimer.set(editorStatus, message, {error, hideWhenEmpty:true});
    }
    function editorControls() {
        const busy=!!browserEdit?.busy;
        editor.querySelectorAll("input, textarea, button").forEach(element => { element.disabled=busy; });
    }
    function finishBrowserEdit() {
        if (!browserEdit) return;
        const previous=browserEdit; browserEdit=null;
        if (previous.updated) { store=previous.updated; render(); }
        if (refreshPending) { refreshPending=false; refresh({profileId:previous.profileId,action:"edit"}); }
        else if (previous.updated) [...list.children].find(card=>card.dataset.profileId===previous.profileId)?.querySelector('[data-action="edit"]')?.focus();
        else previous.trigger.focus();
    }
    function closeBrowserEdit() {
        if (!browserEdit || browserEdit.busy) return;
        if (typeof editor.close === "function" && editor.hasAttribute("open")) editor.close();
        else { editor.removeAttribute("open"); finishBrowserEdit(); }
    }
    function openBrowserEdit(profile, trigger) {
        if (!profile.items?.[0]?.browser) { feedback("This saved browser cannot be edited.", true); return; }
        closeChoice({flush:false});
        browserEdit={profileId:profile.id,expected:JSON.parse(JSON.stringify(profile)),trigger,busy:false,updated:null};
        const browser=profile.items[0].browser;
        document.querySelector("#saved-browser-editor-name").value=profile.name;
        document.querySelector("#saved-browser-editor-tabs").value=browser.tabs.map(tab=>tab.url).join("\n");
        document.querySelector("#saved-browser-editor-active").value=browser.activeTab || 1;
        editorFeedback(""); editorControls();
        if (typeof editor.showModal === "function") editor.showModal(); else editor.setAttribute("open", "");
        document.querySelector("#saved-browser-editor-name").focus();
    }
    async function saveBrowserEdit() {
        const opened=browserEdit;
        if (!opened || opened.busy) return;
        const name=document.querySelector("#saved-browser-editor-name").value.trim();
        const urls=document.querySelector("#saved-browser-editor-tabs").value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
        const active=Number(document.querySelector("#saved-browser-editor-active").value);
        if (!name) { editorFeedback("Give this saved browser a name.", true); return; }
        if (!Number.isInteger(active) || active < 1 || active > (urls.length || 1)) { editorFeedback(`Choose a selected tab between 1 and ${urls.length || 1}.`, true); return; }
        const previous=opened.expected.items[0].browser.tabs.slice();
        const tabs=urls.map(url=>{
            const index=previous.findIndex(tab=>tab.url === url);
            return {url,title:index < 0 ? "" : previous.splice(index, 1)[0].title};
        });
        opened.busy=true; editorControls(); editorFeedback("");
        try {
            opened.updated=await native.core.invoke("edit_saved_browser", {expected:opened.expected,name,tabs,activeTab:active});
            opened.busy=false; closeBrowserEdit(); feedback("Saved browser updated.");
        } catch (error) {
            if (browserEdit === opened) { opened.busy=false; editorControls(); editorFeedback(String(error?.message || error), true); }
        }
    }
    editor.addEventListener("close", finishBrowserEdit);
    editor.addEventListener("cancel", event => { if (browserEdit?.busy) event.preventDefault(); });
    document.querySelector("#saved-browser-editor-close").addEventListener("click", closeBrowserEdit);
    document.querySelector("#saved-browser-editor-cancel").addEventListener("click", closeBrowserEdit);
    document.querySelector("#saved-browser-editor-save").addEventListener("click", saveBrowserEdit);
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
    function tabList(tabs, showTitles = false, label = "Saved browser tabs") {
        if (!tabs.length) { const note=document.createElement("small"); note.textContent="No saved URLs."; return note; }
        const urls=document.createElement("ul"); urls.className="saved-browser-urls";
        urls.tabIndex=0; urls.setAttribute("aria-label", label);
        for (const tab of tabs) {
            const row=document.createElement("li");
            if (showTitles && tab.title) { const title=document.createElement("strong"); title.textContent=tab.title; row.append(title); }
            const url=document.createElement("span"); url.textContent=tab.url; row.append(url); urls.append(row);
        }
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
        const focused=document.activeElement;
        const focusSelector=focused?.classList.contains("saved-browser-description") ? ".saved-browser-description"
            : focused?.classList.contains("saved-browser-bulk-checkbox") ? ".saved-browser-bulk-checkbox"
            : focused?.classList.contains("saved-browser-urls") ? ".saved-browser-preview .saved-browser-urls" : null;
        const focusId=focusSelector ? focused.closest(".saved-browser-card")?.dataset.profileId : null;
        const focusScroll=focused?.scrollTop || 0;
        list.replaceChildren();
        empty.hidden = !!store?.profiles.length;
        for (const [index, profile] of (store?.profiles || []).entries()) {
            const item = profile.items[0], browser = item?.browser;
            const card = document.createElement("article"); card.className="group saved-browser-card"; card.dataset.profileId=profile.id;
            const main = document.createElement("div"); main.className="saved-browser-main";
            const checkbox = document.createElement("input"); checkbox.type="checkbox"; checkbox.className="saved-browser-bulk-checkbox"; checkbox.hidden=true;
            checkbox.setAttribute("aria-label", `Select saved browser ${profile.name}`);
            checkbox.addEventListener("change", () => window.WarpWorkspaceSelection?.set("browser", profile.id, checkbox.checked));
            const text = document.createElement("button"); text.type="button"; text.className="saved-browser-description"; text.dataset.action="preview";
            const title = document.createElement("span"); title.className="saved-browser-name"; title.textContent=profile.name;
            const summary = document.createElement("span"); summary.className="saved-browser-summary";
            const count = browser?.tabs?.length || 0;
            summary.textContent=`${browser?.kind === "chromium" ? "Chromium browser" : "Firefox"} · ${count} ${count === 1 ? "tab" : "tabs"}`;
            text.append(title, summary);
            const preview=document.createElement("div"); preview.className="saved-browser-preview"; preview.id=`saved-browser-preview-${index}`;
            const expanded=expandedBrowsers.has(profile.id); preview.hidden=!expanded;
            if (expanded) preview.append(tabList(browser?.tabs || [], true, `Tabs in ${profile.name}`));
            text.setAttribute("aria-controls", preview.id); text.setAttribute("aria-expanded", String(expanded));
            text.addEventListener("click", () => {
                if (window.WarpWorkspaceSelection?.active()) { if (!checkbox.disabled) window.WarpWorkspaceSelection.set("browser", profile.id, !checkbox.checked); return; }
                const open=preview.hidden; preview.hidden=!open; text.setAttribute("aria-expanded", String(open));
                if (open) { preview.replaceChildren(tabList(browser?.tabs || [], true, `Tabs in ${profile.name}`)); expandedBrowsers.add(profile.id); }
                else { preview.replaceChildren(); expandedBrowsers.delete(profile.id); }
            });
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
                } finally { open.disabled=deletingBrowser; }
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
                } finally { add.disabled=deletingBrowser; }
            });
            add.dataset.action="add"; add.setAttribute("aria-expanded", "false"); add.setAttribute("aria-controls", panel.id);
            const edit=iconButton(`Edit saved browser ${profile.name}`, "edit", () => openBrowserEdit(profile, edit)); edit.dataset.action="edit";
            const confirmation=document.createElement("div"); confirmation.className="saved-browser-delete-confirm"; confirmation.hidden=true;
            const hint=document.createElement("p"); hint.textContent="Delete this saved browser? Open windows and workspaces will stay as they are.";
            const keep=button("Keep it", () => {
                if (deletingBrowser) return;
                confirmation.hidden=true; remove.focus();
                if (refreshPending) { refreshPending=false; refresh(); }
            });
            const confirm=button("Delete saved browser", () => run(async () => {
                if (deletingBrowser) return;
                deletingBrowser=true; list.dataset.deleting="true"; request++;
                list.querySelectorAll("button, input").forEach(element => { element.disabled=true; });
                window.WarpWorkspaceSelection?.refreshControls?.();
                try {
                    store=await native.core.invoke("delete_saved_browser", {id:profile.id});
                } catch (error) {
                    deletingBrowser=false; delete list.dataset.deleting;
                    list.querySelectorAll("button, input").forEach(element => { element.disabled=false; });
                    window.WarpWorkspaceSelection?.refreshControls?.();
                    keep.focus();
                    throw error;
                }
                deletingBrowser=false; delete list.dataset.deleting;
                closeChoice({flush:false}); render();
                window.WarpWorkspaceSelection?.refreshControls?.();
                if (refreshPending) { refreshPending=false; await refresh(); }
                const next=list.children[Math.min(index, list.children.length - 1)]?.querySelector(".saved-browser-description");
                (next || document.querySelector("#capture-workspace")).focus();
                feedback("Saved browser deleted.");
            }));
            confirm.className="saved-browser-delete";
            confirmation.append(hint, confirm, keep);
            const remove=iconButton(`Delete saved browser ${profile.name}`, "delete", () => { if (deletingBrowser) return; closeChoice(); confirmation.hidden=false; keep.focus(); }); remove.dataset.action="delete";
            actions.append(open, add, edit, remove, panel); main.append(checkbox, text, actions); card.append(main, preview, confirmation); list.append(card);
        }
        window.WarpWorkspaceSelection?.registerBrowsers((store?.profiles || []).map(profile => profile.id));
        if (focusId) {
            const target=[...list.children].find(card => card.dataset.profileId === focusId)?.querySelector(focusSelector);
            if (target) { target.scrollTop=focusScroll; target.focus({preventScroll:true}); }
        }
    }
    async function refresh(focus = null) {
        if (!native) return;
        if (choice || destination || browserEdit || deletingBrowser) { refreshPending=true; return; }
        const sequence=++request;
        try {
            const next=await native.core.invoke("get_saved_browsers");
            if (sequence === request) {
                if (choice || destination || browserEdit || deletingBrowser) { refreshPending=true; return; }
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
