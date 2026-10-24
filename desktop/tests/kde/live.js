// Runs alongside the unmodified production source, with shortcut callbacks captured.
var modernTest = "activeWindow" in workspace;
var testWindows = modernTest ? workspace.stackingOrder : workspace.clientList();
var originalFocus = modernTest ? workspace.activeWindow : workspace.activeClient;
var fixtureA = null;
var fixtureB = null;
var fixtureC = null;
for (var testIndex = 0; testIndex < testWindows.length; testIndex++) {
    if (testWindows[testIndex].caption === "WARP-TEST-A") fixtureA = testWindows[testIndex];
    if (testWindows[testIndex].caption === "WARP-TEST-B") fixtureB = testWindows[testIndex];
    if (testWindows[testIndex].caption === "WARP-TEST-C") fixtureC = testWindows[testIndex];
}
var testResults = [];
function testRect(r) { return {x:r.x, y:r.y, width:r.width, height:r.height}; }
function testFocus(w) { if (modernTest) workspace.activeWindow = w; else workspace.activeClient = w; }
function testActive() { return modernTest ? workspace.activeWindow : workspace.activeClient; }
function testArea(w) { return workspace.clientArea(KWin.MaximizeArea, w); }
function approximately(a, b) { return Math.abs(a-b) <= 3; }
function check(name, valid, details) {
    testResults.push({name:name, passed:!!valid, details:details || {}});
}
var testTimer = new QTimer();
testTimer.interval = 650;
var testStep = 0;
var startRect;
var startOutput;
var outputCount;
function report() {
    testTimer.stop();
    if (originalFocus && originalFocus !== fixtureA && originalFocus !== fixtureB && originalFocus !== fixtureC && !originalFocus.deleted) testFocus(originalFocus);
    var passed = testResults.length > 0 && testResults.every(function(r) { return r.passed; });
    callDBus("com.windowwarp.Smoke", "/Smoke", "com.windowwarp.Smoke", "report", JSON.stringify({passed:passed, tests:testResults, plasmaApi:modernTest ? 6 : 5}));
}
testTimer.timeout.connect(function() {
    try {
        if (testStep < 25 && (!fixtureA || !fixtureB)) { check("fixture discovery", false); report(); return; }
        var area;
        if (testStep === 0) {
            testFocus(fixtureA);
        } else if (testStep === 1) {
            testCallbacks["Window Warp: Left"]();
        } else if (testStep === 2) {
            area = testArea(fixtureA);
            check("tile left", approximately(fixtureA.frameGeometry.x, area.x) && approximately(fixtureA.frameGeometry.width, Math.floor(area.width/2)), {actual:testRect(fixtureA.frameGeometry), area:testRect(area)});
            testCallbacks["Window Warp: Right"]();
        } else if (testStep === 3) {
            area = testArea(fixtureA);
            check("tile right", approximately(fixtureA.frameGeometry.x, area.x+Math.floor(area.width/2)) && approximately(fixtureA.frameGeometry.width, area.width-Math.floor(area.width/2)), {actual:testRect(fixtureA.frameGeometry)});
            startRect = testRect(fixtureA.frameGeometry);
            startOutput = modernTest ? fixtureA.output.name : fixtureA.screen;
            testCallbacks["Window Warp: Push"]();
        } else if (testStep === 4) {
            var count = modernTest ? workspace.screens.length : workspace.numScreens;
            outputCount = count;
            var output = modernTest ? fixtureA.output.name : fixtureA.screen;
            check(count > 1 ? "push to another output" : "single output push is a no-op", count > 1 ? output !== startOutput : output === startOutput, {outputs:count});
            testCallbacks["Window Warp: Pull"]();
        } else if (testStep === 5) {
            check(outputCount > 1 ? "pull restores placement" : "empty pull is a no-op", approximately(fixtureA.frameGeometry.x,startRect.x) && approximately(fixtureA.frameGeometry.y,startRect.y) && approximately(fixtureA.frameGeometry.width,startRect.width) && approximately(fixtureA.frameGeometry.height,startRect.height), {actual:testRect(fixtureA.frameGeometry)});
            fixtureB.minimized = true;
            testFocus(fixtureA);
            testCallbacks["Window Warp: Focus"]();
        } else if (testStep === 6) {
            check("focus minimized instance", testActive() === fixtureB && !fixtureB.minimized, {resourceClass:String(fixtureB.resourceClass), desktopFileName:String(fixtureB.desktopFileName)});
            testCallbacks["Window Warp: Focus"]();
        } else if (testStep === 7) {
            check("cycle back to first instance", testActive() === fixtureA);
            callDBus("org.kde.kglobalaccel", "/component/kwin", "org.kde.kglobalaccel.Component", "invokeShortcut", registeredTestIds[4]);
        } else if (testStep === 8) {
            check("registered shortcut dispatch", testActive() === fixtureB);
            testFocus(fixtureA);
            fixtureA.setMaximize(true, true);
        } else if (testStep === 9) {
            testCallbacks["Window Warp: Left"]();
        } else if (testStep === 10) {
            area = testArea(fixtureA);
            check("tile a maximized window", approximately(fixtureA.frameGeometry.width, Math.floor(area.width/2)) && approximately(fixtureA.frameGeometry.height, area.height), {actual:testRect(fixtureA.frameGeometry)});
            fixtureA.fullScreen = true;
        } else if (testStep === 11) {
            testCallbacks["Window Warp: Right"]();
        } else if (testStep === 12) {
            area = testArea(fixtureA);
            check("tile a fullscreen window", !fixtureA.fullScreen && approximately(fixtureA.frameGeometry.width, area.width-Math.floor(area.width/2)), {actual:testRect(fixtureA.frameGeometry)});
            testCallbacks["Window Warp: Top"]();
        } else if (testStep === 13) {
            area = testArea(fixtureA);
            check("tile top", approximately(fixtureA.frameGeometry.y, area.y) && approximately(fixtureA.frameGeometry.height, Math.floor(area.height / 2)));
            testCallbacks["Window Warp: Bottom"]();
        } else if (testStep === 14) {
            area = testArea(fixtureA);
            check("tile bottom", approximately(fixtureA.frameGeometry.y, area.y + Math.floor(area.height / 2)));
            startRect = testRect(fixtureA.frameGeometry);
            testCallbacks["Window Warp: Maximize"]();
        } else if (testStep === 15) {
            area = testArea(fixtureA);
            check("maximize toggle", approximately(fixtureA.frameGeometry.width, area.width) && approximately(fixtureA.frameGeometry.height, area.height));
            testCallbacks["Window Warp: Maximize"]();
        } else if (testStep === 16) {
            check("maximize restores geometry", approximately(fixtureA.frameGeometry.y, startRect.y) && approximately(fixtureA.frameGeometry.height, startRect.height));
            workspace.sendClientToScreen(fixtureA, modernTest ? workspace.screens[0] : 0);
        } else if (testStep === 17) {
            startOutput = modernTest ? fixtureA.output.name : fixtureA.screen;
            testCallbacks["Window Warp: App"]();
        } else if (testStep === 18) {
            var output = modernTest ? fixtureA.output.name : fixtureA.screen;
            area = testArea(fixtureA);
            check(outputCount > 1 ? "active app goes to tiled burner" : "one output app stays on main", outputCount > 1 ? output !== startOutput && approximately(fixtureA.frameGeometry.width, area.width - Math.floor(area.width / 2)) : output === startOutput);
            testCallbacks["Window Warp: App"]();
        } else if (testStep === 19) {
            check("app returns to main", (modernTest ? fixtureA.output.name : fixtureA.screen) === startOutput);
            testFocus(fixtureC);
        } else if (testStep === 20) {
            testCallbacks["Window Warp: Previous"]();
        } else if (testStep === 21) {
            check("app remembers previous focus", testActive() === fixtureA || testActive() === fixtureB);
            testCallbacks["Window Warp: Previous"]();
        } else if (testStep === 22) {
            check("app restores previous focus", testActive() === fixtureC);
            testCallbacks["Window Warp: Close"]();
        } else if (testStep === 23) {
            var open = modernTest ? workspace.stackingOrder : workspace.clientList();
            check("graceful close of owned fixture", !open.some(function(w) { return w.caption === "WARP-TEST-C"; }));
            report();
        }
        testStep++;
    } catch (error) { check("runtime exception", false, {error:String(error)}); report(); }
});
testTimer.start();
