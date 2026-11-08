/* Browser labels and recognition shared by workspace and saved-browser UI. */
(() => {
    const chromiumApp = id => /^(?:chrome|chromium|msedge|brave|vivaldi|opera|google-chrome(?:-stable)?|chromium-browser|microsoft-edge(?:-stable)?|brave-browser)(?:\.exe|\.desktop)?$/i.test(id || "") || /\.(?:chrome|chromium|msedge|brave|vivaldi|opera)\./i.test(id || "");
    const firefoxApp = id => /^(?:firefox(?:\.exe|\.desktop)?|firefox-esr|org\.mozilla\.firefox(?:\.desktop)?|firefoxdeveloperedition|navigator)$/i.test(id || "");
    const chromiumName = id => /edge/i.test(id) ? "Microsoft Edge" : /brave/i.test(id) ? "Brave" : /vivaldi/i.test(id) ? "Vivaldi" : /opera/i.test(id) ? "Opera" : /chromium/i.test(id) ? "Chromium" : "Chrome";
    const isBrowserItem = item => !!item.browser || chromiumApp(item.window?.appId) || firefoxApp(item.window?.appId);
    window.WarpBrowserKinds = Object.freeze({chromiumApp, firefoxApp, chromiumName, isBrowserItem});
})();
