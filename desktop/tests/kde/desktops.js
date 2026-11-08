// Runs against owned fixture windows inside a private KWin session.
var desktopTests = [];
var desktopStep = 0;
var desktopTicks = 0;
var fixtureBrowser;
var fixtureEditor;
var desktopTimer = new QTimer();
desktopTimer.interval = 500;
function desktopCheck(name, value, details) {
    desktopTests.push({name:name, passed:!!value, details:details || {}});
}
function desktopReport(error) {
    desktopTimer.stop();
    realCallDBus("com.windowwarp.DesktopsSmoke", "/Smoke", "com.windowwarp.DesktopsSmoke", "report",
        JSON.stringify({passed:!error && desktopTests.length > 0 && desktopTests.every(function(test) { return test.passed; }), error:error || "", tests:desktopTests}));
}
function desktopCommand(kind, args) {
    testReply = null;
    testJob = {id:desktopStep, expires:Date.now()+5000, command:{kind:kind}};
    if (args) Object.keys(args).forEach(function(key) { testJob.command[key] = args[key]; });
    desktopDispatch();
}
desktopTimer.timeout.connect(function() {
    try {
        if (++desktopTicks > 35) { desktopReport("Timed out waiting for the KWin bridge"); return; }
        if (desktopStep === 0) {
            var windows = Warp.windows();
            fixtureBrowser = windows.filter(function(w) { return Number(w.pid) === TEST_OTHER_PID && String(w.caption) === "WARP-TEST-C"; })[0];
            fixtureEditor = windows.filter(function(w) { return Number(w.pid) === WARP_CONTROL.ownPid && String(w.caption) === "Window Warp desktop test"; })[0];
            if (!fixtureBrowser || !fixtureEditor) return;
            if (typeof workspace.currentDesktop !== "number") { desktopReport("This fixture expects Plasma 5"); return; }
            fixtureBrowser.desktop = 2;
            fixtureEditor.desktop = 1;
            workspace.currentDesktop = 1;
            desktopStep++;
        } else if (desktopStep === 1) {
            desktopCommand("desktop-snapshot"); desktopStep++;
        } else if (desktopStep === 2 && testReply) {
            if (testReply.error) { desktopReport(testReply.error); return; }
            var result = testReply.result;
            var browser = result.windows.filter(function(w) { return w.window.pid === TEST_OTHER_PID; })[0];
            desktopCheck("snapshot sees the browser on another desktop", result.current.id === "kde-number:1" && browser && browser.desktops.some(function(d) { return d.id === "kde-number:2"; }), result);
            workspace.currentDesktop = 2;
            desktopCommand("focus-editor"); desktopStep++;
        } else if (desktopStep === 3 && testReply) {
            desktopCheck("editor follows the current desktop", testReply.result === true && workspace.currentDesktop === 2 && fixtureEditor.desktop === 2,
                {current:workspace.currentDesktop, editor:fixtureEditor.desktop});
            fixtureBrowser.desktop = 1;
            desktopCommand("desktop-snapshot"); desktopStep++;
        } else if (desktopStep === 4 && testReply) {
            if (testReply.error) { desktopReport(testReply.error); return; }
            var moved = testReply.result.windows.filter(function(w) { return w.window.pid === TEST_OTHER_PID; })[0];
            desktopCheck("a moved browser is reported on its new desktop", testReply.result.current.id === "kde-number:2" && moved && moved.desktops.some(function(d) { return d.id === "kde-number:1"; }), testReply.result);
            desktopCommand("move-desktop", {desktop:"kde-number:2", window:{id:String(fixtureBrowser.internalId),pid:Number(fixtureBrowser.pid)}}); desktopStep++;
        } else if (desktopStep === 5 && testReply) {
            desktopCheck("the selected workspace window moves to the requested desktop", !testReply.error && fixtureBrowser.desktop === 2, testReply);
            desktopCommand("switch-desktop", {desktop:"kde-number:1"}); desktopStep++;
        } else if (desktopStep === 6 && testReply) {
            desktopCheck("go there switches to the requested desktop", !testReply.error && workspace.currentDesktop === 1, testReply);
            desktopReport();
        }
    } catch (error) { desktopReport(String(error)); }
});
desktopTimer.start();
