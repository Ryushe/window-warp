/* File selection and review only; the existing editors own persistence. */
(() => {
    let entries = [];
    let reading = false;
    const results = document.querySelector("#import-results");
    function renderImport() {
        results.replaceChildren();
        for (const entry of entries) {
            const card = document.createElement("article"); card.className = "workspace-card";
            const heading = document.createElement("label"); heading.className = "enabled-field";
            if (entry.kind !== "workspace" && entry.value) {
                const check = document.createElement("input"); check.type = "checkbox"; check.checked = entry.selected;
                check.addEventListener("change", () => { entry.selected = check.checked; }); heading.append(check);
            }
            const title = document.createElement("span"); title.textContent = entry.label; heading.append(title); card.append(heading);
            const source = document.createElement("small"); source.textContent = entry.source; card.append(source);
            if (entry.value) {
                const summary = document.createElement("p");
                summary.textContent = entry.kind === "binding" ? `${entry.value.shortcut} · ${entry.value.action}${entry.value.enabled ? "" : " · disabled"}` : entry.kind === "workspace" ? `${entry.value.items.length} windows · Windows` : JSON.stringify(entry.value);
                card.append(summary);
            }
            for (const note of [...entry.problems, ...entry.notes]) { const p = document.createElement("p"); p.textContent = note; card.append(p); }
            const detail = document.createElement("details"), label = document.createElement("summary"), raw = document.createElement("pre");
            label.textContent = "Original settings"; raw.textContent = entry.raw; raw.style.whiteSpace = "pre-wrap";
            detail.append(label, raw); card.append(detail);
            if (entry.kind === "workspace" && entry.value) {
                const button = document.createElement("button"); button.textContent = "Review workspace";
                button.addEventListener("click", async () => {
                    if (reading) return;
                    button.disabled = true;
                    try { await window.reviewImportedWorkspace(entry.value); }
                    catch (error) { message(String(error.message || error), true); }
                    finally { button.disabled = false; }
                }); card.append(button);
            }
            results.append(card);
        }
        $("#apply-import").hidden = !entries.some(e => e.value && e.kind !== "workspace");
        $("#clear-import").hidden = !entries.length;
        controls();
    }
    $("#import-files").addEventListener("change", async event => {
        if (reading || busy || enabled || !config) return;
        const files = [...event.target.files];
        if (!files.length) return;
        if (files.length > 20 || files.reduce((n,f) => n + f.size,0) > 32 * 1024 * 1024) { message("Choose at most 20 INI files totaling 32 MiB.", true); return; }
        reading = true; busy = true; controls();
        try {
            const monitors = await native.core.invoke("get_import_monitors");
            const next = [];
            for (const file of files) {
                try {
                    const text = window.WindowWarpImport.decode(await file.arrayBuffer());
                    next.push(...window.WindowWarpImport.preview(text, {name:file.name, platform, monitors}).map(e => ({...e,selected:Boolean(e.value)})));
                } catch (error) { next.push({kind:"error",label:file.name,source:file.name,raw:"",notes:[],problems:[String(error.message || error)],value:null}); }
            }
            entries = next; renderImport();
            message("Review the import. Nothing has been saved. Unsupported entries remain visible with their original settings.");
        } catch (error) { message(String(error.message || error), true); }
        finally { reading = false; busy = false; controls(); }
    });
    $("#apply-import").addEventListener("click", () => {
        if (reading || busy || enabled || !config) return;
        const chosen = entries.filter(e => e.selected && e.value && e.kind !== "workspace");
        if (!chosen.length) { message("Select shortcuts or settings to add to the draft."); return; }
        const next = JSON.parse(JSON.stringify(config));
        for (const entry of chosen) {
            if (entry.kind === "binding") next.bindings.push(JSON.parse(JSON.stringify(entry.value)));
            else next.settings = {...next.settings, ...entry.value};
        }
        if (next.bindings.length > 100) { message("The combined draft exceeds 100 shortcuts. Select fewer entries or remove existing bindings first.", true); return; }
        config = next; changed(); render();
        for (const entry of chosen) entry.selected = false;
        renderImport();
        $("#show-shortcuts").click();
        message("Imported into your unsaved draft. Review app identifiers and conflicting keys, then Save changes. Existing shortcuts were kept.");
    });
    $("#clear-import").addEventListener("click", () => {
        if (reading) return;
        entries = []; $("#import-files").value = ""; renderImport();
    });
})();
