/* Workspace edits are drafts until Save succeeds. Captures never auto-save. */
(() => {
    const select = selector => document.querySelector(selector);
    const native = window.__TAURI__;
    let store = null;
    let draft = null;
    let selected = [];
    let working = false;
    let editingId = "";
    const clone = value => JSON.parse(JSON.stringify(value));
    function say(text, error = false) {
        select("#message").textContent = text;
        select("#message").classList.toggle("error", error);
    }
    function controls() {
        select("#workspaces-page").querySelectorAll("input, textarea, select, button").forEach(el => { el.disabled = working || !store; });
        select("#cancel-restore").disabled = false;
        select("#save-workspace").disabled = working || !store || !draft || !selected.some(Boolean);
    }
    async function perform(action) {
        if (working) return;
        working = true; controls();
        try { await action(); } catch (error) { say(String(error), true); }
        finally { working = false; controls(); }
    }
    async function persist(next) {
        store = await native.core.invoke("save_workspaces", {store: next});
        render();
    }
    function render() {
        select("#workspace-list").replaceChildren();
        select("#workspace-empty").hidden = store.profiles.length > 0;
        store.profiles.forEach((profile, index) => {
            const fragment = select("#workspace-card-template").content.cloneNode(true);
            const card = fragment.querySelector("article");
            card.querySelector(".workspace-title").textContent = profile.name;
            card.querySelector(".workspace-summary").textContent = `${profile.items.length} ${profile.items.length === 1 ? "window" : "windows"} · ${profile.platform === "windows" ? "Windows" : "Linux / KDE"}`;
            card.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => {
                const action = button.dataset.action;
                if (action === "delete" || action === "cancel-delete") { card.querySelector(".workspace-delete-confirm").hidden = action !== "delete"; return; }
                if (action === "edit") { openDraft(clone(profile), profile.id); return; }
                if (action === "update") { capture(profile.id); return; }
                if (action === "restore") { restore(profile); return; }
                perform(async () => {
                    const next = clone(store);
                    if (action === "confirm-delete") next.profiles.splice(index, 1);
                    else {
                        const target = index + (action === "up" ? -1 : 1);
                        if (target < 0 || target >= next.profiles.length) return;
                        [next.profiles[index], next.profiles[target]] = [next.profiles[target], next.profiles[index]];
                    }
                    await persist(next);
                });
            }));
            select("#workspace-list").append(fragment);
        });
    }
    function openDraft(profile, id = "", captured = false, suggestedId = "") {
        draft = profile; editingId = id; selected = profile.items.map(() => true);
        select("#workspace-editor").hidden = false;
        select("#workspace-name").value = profile.name;
        select("#workspace-update-choice").hidden = !captured || !store.profiles.length;
        const target = select("#workspace-target");
        target.replaceChildren();
        const addOption = (value, text) => { const option = document.createElement("option"); option.value = value; option.textContent = text; target.append(option); };
        addOption("", "New workspace");
        store.profiles.forEach(p => addOption(p.id, "Update “" + p.name + "”"));
        target.value = id;
        const suggested = store.profiles.find(p => p.id === suggestedId);
        select("#workspace-suggestion").textContent = suggested ? `Closest match: ${suggested.name}. Choose it above to replace its saved layout.` : "";
        select("#workspace-items").replaceChildren();
        profile.items.forEach((item, index) => {
            const fragment = select("#workspace-item-template").content.cloneNode(true);
            fragment.querySelector(".window-title").textContent = item.label || item.window.title;
            fragment.querySelector(".window-placement").textContent = `${item.window.appId} · Monitor ${item.window.monitor} · ${item.window.rect.width} × ${item.window.rect.height}`;
            const note = fragment.querySelector(".capture-note");
            note.textContent = item.captureNote || "";
            note.hidden = !item.captureNote;
            if (item.browser) {
                const browser = item.browser;
                fragment.querySelector(".browser-settings").hidden = false;
                fragment.querySelector(".restore-browser").addEventListener("change", event => { item.browser = event.target.checked ? browser : null; });
                fragment.querySelectorAll("[data-browser]").forEach(input => {
                    const field = input.dataset.browser;
                    input.value = field === "tabs" ? browser.tabs.map(t => t.url).join("\n") : browser[field];
                    input.addEventListener("input", () => {
                        if (field === "tabs") browser.tabs = input.value.split(/\r?\n/).filter(Boolean).map(url => ({url, title:browser.tabs.find(t => t.url === url)?.title || ""}));
                        else browser[field] = field === "activeTab" ? Number(input.value) : input.value;
                    });
                });
            }
            const include = fragment.querySelector(".include-window");
            if (item.terminal) {
                const terminal = item.terminal;
                fragment.querySelector(".terminal-settings").hidden = false;
                fragment.querySelector(".terminal-summary").textContent = terminal.kind === "konsole" ? "Konsole session" : "Windows Terminal session";
                fragment.querySelector(".wsl-settings").hidden = terminal.kind !== "windows-terminal";
                fragment.querySelector(".konsole-profile").hidden = terminal.kind !== "konsole";
                fragment.querySelector(".restore-terminal").addEventListener("change", event => { item.terminal = event.target.checked ? terminal : null; });
                fragment.querySelectorAll("[data-terminal]").forEach(input => {
                    const field = input.dataset.terminal;
                    input.value = field === "shellArgs" ? terminal.shellArgs.join("\n") : terminal[field] || "";
                    input.addEventListener("input", () => {
                        terminal[field] = field === "shellArgs" ? input.value.split(/\r?\n/).filter(Boolean) : input.value;
                    });
                });
            }
            include.addEventListener("change", () => { selected[index] = include.checked; count(); controls(); });
            fragment.querySelectorAll("[data-launch]").forEach(input => {
                const field = input.dataset.launch;
                if (field === "newWindow") input.checked = item.launch.newWindow;
                else input.value = field === "args" ? item.launch.args.join("\n") : item.launch[field];
                input.addEventListener("input", () => {
                    item.launch[field] = field === "newWindow" ? input.checked : field === "args" ? input.value.split(/\r?\n/).filter(line => line !== "") : input.value;
                });
            });
            select("#workspace-items").append(fragment);
        });
        count(); controls();
    }
    function count() { select("#workspace-item-count").textContent = `${selected.filter(Boolean).length} windows selected`; }
    function capture(id = "") {
        perform(async () => {
            const existing = store.profiles.find(p => p.id === id);
            const capture = await native.core.invoke("capture_workspace", {name:existing?.name || "New workspace"});
            openDraft(capture.profile, id, true, capture.suggestedId);
            say("Review the captured windows, then save the workspace.");
        });
    }
    async function restore(profile) {
        perform(async () => {
            select("#cancel-restore").hidden = false;
            select("#workspace-results").replaceChildren();
            say("Opening “" + profile.name + "”…");
            try {
                const results = await native.core.invoke("restore_workspace", {id:profile.id});
                results.forEach(result => { const row = document.createElement("p"); row.textContent = `${result.restored ? "✓" : "!"} ${result.label}${result.error ? ": " + result.error : ""}`; select("#workspace-results").append(row); });
                say(`Restored ${results.filter(r => r.restored).length} of ${profile.items.length} windows.`, results.some(r => !r.restored));
            } finally { select("#cancel-restore").hidden = true; }
        });
    }
    select("#workspace-target").addEventListener("change", () => {
        editingId = select("#workspace-target").value;
        const target = store.profiles.find(p => p.id === editingId);
        if (target) select("#workspace-name").value = target.name;
    });
    select("#save-workspace").addEventListener("click", () => perform(async () => {
        const profile = clone(draft);
        profile.name = select("#workspace-name").value.trim();
        if (!profile.name) throw new Error("Give this workspace a name.");
        profile.items = profile.items.filter((_, index) => selected[index]);
        if (!profile.items.length) throw new Error("Select at least one window.");
        const next = clone(store);
        if (editingId) {
            const index = next.profiles.findIndex(p => p.id === editingId);
            if (index < 0) throw new Error("The selected workspace no longer exists.");
            profile.id = editingId; next.profiles[index] = profile;
        } else next.profiles.push(profile);
        await persist(next);
        draft = null;
        select("#workspace-editor").hidden = true;
        say("Workspace saved.");
    }));
    select("#discard-workspace").addEventListener("click", () => { draft = null; select("#workspace-editor").hidden = true; controls(); });
    select("#capture-workspace").addEventListener("click", () => capture());
    select("#cancel-restore").addEventListener("click", async () => {
        try { await native.core.invoke("cancel_workspace_restore"); say("Canceling after the current window operation…"); }
        catch (error) { say(String(error), true); }
    });
    select("#show-shortcuts").addEventListener("click", () => { select("#workspaces-page").hidden = true; select("#shortcuts-page").hidden = false; });
    window.addEventListener("warp-workspace-request", event => {
        select("#shortcuts-page").hidden = true; select("#workspaces-page").hidden = false;
        if (working) { say("Finish the current workspace operation before using this shortcut again.", true); return; }
        perform(async () => {
            if (!store) { store = await native.core.invoke("get_workspaces"); render(); }
            if (event.detail.action !== "update-workspace") return;
            if (draft) { say("Save or cancel the current workspace draft, then capture the update again.", true); return; }
            const capture = event.detail.capture;
            const target = store.profiles.find(p => p.id === capture.suggestedId);
            if (target) capture.profile.name = target.name;
            openDraft(capture.profile, target?.id || "", true, capture.suggestedId);
            select("#workspace-editor").scrollIntoView?.({block:"start"});
            select("#workspace-name").focus();
            say("Review the captured windows and update target, then save.");
        });
    });
    select("#show-workspaces").addEventListener("click", async () => {
        select("#shortcuts-page").hidden = true; select("#workspaces-page").hidden = false;
        if (!native || store || working) return;
        await perform(async () => { store = await native.core.invoke("get_workspaces"); render(); });
    });
    controls();
})();
