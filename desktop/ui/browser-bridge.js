(() => {
    const native = window.__TAURI__;
    if (!native) return;
    const code = document.querySelector("#browser-bridge-code");
    const status = document.querySelector("#browser-bridge-status");
    const summary = document.querySelector("#browser-connection-summary");
    const path = document.querySelector("#browser-extension-path");
    const instructions = document.querySelector("#browser-extension-instructions");
    const copyCode = document.querySelector("#copy-browser-code");
    const setStatus = (text, error = false) => window.WarpErrorTimer.set(status, text, {error});
    let preparation = 0;
    let statusRequest = 0;
    const render = value => {
        code.value = value.pairingCode || "";
        copyCode.disabled = !code.value;
        const connected = [value.chromiumConnected && "Chrome", value.firefoxConnected && "Firefox"].filter(Boolean);
        summary.textContent = connected.length ? `${connected.join(" and ")} connected` : "No browser connected";
        if (value.extensionUpdateError) setStatus(value.extensionUpdateError, true);
    };
    const refresh = async () => {
        const request = ++statusRequest;
        try { const value = await native.core.invoke("bridge_status"); if (request === statusRequest) render(value); }
        catch { if (request === statusRequest) setStatus("Browser setup is unavailable. Try again.", true); }
    };
    refresh();
    document.querySelector("#show-settings").addEventListener("click", refresh);
    native.core.invoke("extension_setup_options").then(options => {
        const store = !!options.firefoxStoreAvailable;
        const developer = !!options.developer;
        document.querySelector("#open-firefox-addon").hidden = !store;
        const development = document.querySelector("#developer-extension-setup");
        development.hidden = store && !developer;
        development.open = !store;
        document.querySelector("#developer-extension-summary").textContent = store ? "Developer extension setup" : "Temporary Firefox setup";
        document.querySelector("#prepare-chromium").hidden = !developer;
    }).catch(() => {
        document.querySelector("#developer-extension-setup").hidden = false;
        document.querySelector("#developer-extension-setup").open = true;
        setStatus("Browser setup is unavailable. Try again.", true);
    });
    document.querySelector("#open-firefox-addon").addEventListener("click", async () => {
        try { await native.core.invoke("open_firefox_addon"); }
        catch (error) { setStatus(String(error), true); }
    });
    document.querySelector("#get-browser-code").addEventListener("click", async () => {
        const request = ++preparation;
        ++statusRequest;
        try {
            const connection = await native.core.invoke("set_bridge_enabled", {enabled:true});
            if (request !== preparation) return;
            ++statusRequest;
            render(connection);
            setStatus(connection.extensionUpdateError || "Paste this code into the Firefox add-on.", !!connection.extensionUpdateError);
        } catch (error) { if (request === preparation) setStatus(String(error), true); }
    });
    copyCode.addEventListener("click", async () => {
        try { await window.navigator.clipboard.writeText(code.value); setStatus("Pairing code copied."); }
        catch { setStatus("Select and copy the pairing code above.", true); }
    });
    for (const browser of ["chromium", "firefox"]) {
        document.querySelector(`#prepare-${browser}`).addEventListener("click", async () => {
            const request = ++preparation;
            ++statusRequest;
            document.querySelector("#extension-instructions-prompt").hidden = true;
            for (const kind of ["chromium", "firefox"]) document.querySelector(`#${kind}-instructions`).hidden = kind !== browser;
            instructions.removeAttribute("open");
            path.value = "";
            setStatus("Preparing extension…");
            try {
                const folder = await native.core.invoke("prepare_extension", {browser});
                if (request !== preparation) return;
                const connection = await native.core.invoke("set_bridge_enabled", {enabled:true});
                if (request === preparation) {
                    path.value = folder;
                    ++statusRequest;
                    render(connection);
                    setStatus(connection.extensionUpdateError || "Extension ready. Open the installation instructions below.", !!connection.extensionUpdateError);
                }
            } catch (error) { if (request === preparation) setStatus(String(error), true); }
        });
    }
    for (const [browser, address] of [["chromium", "chrome://extensions"], ["firefox", "about:debugging#/runtime/this-firefox"]]) {
        document.querySelector(`#copy-${browser}-address`).addEventListener("click", async () => {
            try { await window.navigator.clipboard.writeText(address); setStatus("Setup address copied."); }
            catch { setStatus(`Copy this address into your browser: ${address}`); }
        });
    }
})();
