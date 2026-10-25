// Runs alongside the unmodified production source, with shortcut callbacks captured.
var modernTest = "activeWindow" in workspace;
var testWindows = modernTest ? workspace.stackingOrder : workspace.clientList();
var originalFocus = modernTest ? workspace.activeWindow : workspace.activeClient;
var originalFocusIdentity = originalFocus ? {id:String(originalFocus.internalId),pid:Number(originalFocus.pid)} : null;
var fixtureA = null;
var fixtureB = null;
var fixtureC = null;
for (var testIndex = 0; testIndex < testWindows.length; testIndex++) {
    if (Number(testWindows[testIndex].pid) === WARP_FIXTURE_PIDS.main) {
        if (testWindows[testIndex].caption === "WARP-TEST-A") fixtureA = testWindows[testIndex];
        if (testWindows[testIndex].caption === "WARP-TEST-B") fixtureB = testWindows[testIndex];
    }
    if (Number(testWindows[testIndex].pid) === WARP_FIXTURE_PIDS.other && testWindows[testIndex].caption === "WARP-TEST-C") fixtureC = testWindows[testIndex];
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
var pendingStateChecks = 0;
function checkState(name, window, horizontal, vertical) {
    pendingStateChecks++;
    callDBus("org.kde.KWin", "/KWin", "org.kde.KWin", "getWindowInfo", String(window.internalId), function(info) {
        check(name, !!info && !!info.maximizeHorizontal === horizontal && !!info.maximizeVertical === vertical, info);
        pendingStateChecks--;
    });
}
function sameRect(actual, expected) {
    return ["x","y","width","height"].every(function(key) { return approximately(actual[key], expected[key]); });
}
function report() {
    if (pendingStateChecks) return;
    testTimer.stop();
    var survivingFocus = originalFocusIdentity && (modernTest ? workspace.stackingOrder : workspace.clientList()).filter(function(w) {
        return !w.deleted && String(w.internalId) === originalFocusIdentity.id && Number(w.pid) === originalFocusIdentity.pid;
    })[0];
    if (survivingFocus && survivingFocus !== fixtureA && survivingFocus !== fixtureB && survivingFocus !== fixtureC) testFocus(survivingFocus);
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
            check("graceful close of owned fixture", !open.some(function(w) { return Number(w.pid) === WARP_FIXTURE_PIDS.other && w.caption === "WARP-TEST-C"; }));
            testFocus(fixtureA);
            fixtureA.fullScreen = false;
            fixtureA.setMaximize(false, false);
            area = testArea(fixtureA);
            fixtureA.frameGeometry = {x:area.x+80,y:area.y+90,width:500,height:320};
        } else if (testStep === 24) {
            startRect = testRect(fixtureA.frameGeometry);
            startOutput = modernTest ? fixtureA.output.name : fixtureA.screen;
            testCallbacks["Window Warp: Maximize"]();
        } else if (testStep === 25) {
            checkState("compound fixture maximized", fixtureA, true, true);
            testCallbacks["Window Warp: Push"]();
        } else if (testStep === 26) {
            var movedOutput = (modernTest ? fixtureA.output.name : fixtureA.screen) !== startOutput;
            check(outputCount > 1 ? "maximized push moves to another output" : "single-output maximized push wraps in place", outputCount > 1 ? movedOutput : !movedOutput);
            checkState("push preserves maximization", fixtureA, true, true);
            testCallbacks["Window Warp: Maximize"]();
        } else if (testStep === 27) {
            check("toggle restores original geometry after maximized push", sameRect(fixtureA.frameGeometry,startRect), {actual:testRect(fixtureA.frameGeometry),expected:startRect});
            check("toggle restores original output after maximized push", (modernTest ? fixtureA.output.name : fixtureA.screen) === startOutput);
            checkState("compound toggle is floating", fixtureA, false, false);
            testCallbacks["Window Warp: Maximize"]();
        } else if (testStep === 28) {
            testCallbacks["Window Warp: Push"]();
        } else if (testStep === 29) {
            testCallbacks["Window Warp: Left"]();
        } else if (testStep === 30) {
            checkState("intervening tile clears maximization", fixtureA, false, false);
            testCallbacks["Window Warp: Pull"]();
        } else if (testStep === 31) {
            checkState("history pull restores maximization after tile", fixtureA, true, true);
            check("history pull restores original output after tile", (modernTest ? fixtureA.output.name : fixtureA.screen) === startOutput);
            testCallbacks["Window Warp: Maximize"]();
        } else if (testStep === 32) {
            check("toggle retains floating geometry through history pull", sameRect(fixtureA.frameGeometry,startRect), {actual:testRect(fixtureA.frameGeometry),expected:startRect});
            testCallbacks["Window Warp: Maximize"]();
            testCallbacks["Window Warp: Maximize"]();
        } else if (testStep === 33) {
            check("rapid double-toggle restores floating geometry", sameRect(fixtureA.frameGeometry,startRect), {actual:testRect(fixtureA.frameGeometry),expected:startRect});
            checkState("rapid double-toggle ends restored", fixtureA, false, false);
            testCallbacks["Window Warp: Maximize"]();
            testCallbacks["Window Warp: App"]();
        } else if (testStep === 34) {
            area = testArea(fixtureA);
            if (outputCount > 1) {
                check("rapid maximize then app pull reaches tiled burner", (modernTest ? fixtureA.output.name : fixtureA.screen) !== startOutput && approximately(fixtureA.frameGeometry.x,area.x+Math.floor(area.width/2)) && approximately(fixtureA.frameGeometry.width,area.width-Math.floor(area.width/2)), {actual:testRect(fixtureA.frameGeometry)});
                checkState("rapid maximize then burner tile ends restored", fixtureA, false, false);
            } else {
                check("one-output burner keeps the maximized window on its output", (modernTest ? fixtureA.output.name : fixtureA.screen) === startOutput);
                checkState("one-output burner preserves maximization", fixtureA, true, true);
            }
        } else if (testStep === 35) {
            fixtureA.setMaximize(false, false);
            area = testArea(fixtureA);
            fixtureA.frameGeometry = {x:area.x+80,y:area.y+90,width:500,height:320};
        } else if (testStep === 36) {
            startRect = testRect(fixtureA.frameGeometry);
            startOutput = modernTest ? fixtureA.output.name : fixtureA.screen;
            testCallbacks["Window Warp: Maximize"]();
        } else if (testStep === 37) {
            testCallbacks["Window Warp: Push"]();
        } else if (testStep === 38) {
            testCallbacks["Window Warp: Pull"]();
        } else if (testStep === 39) {
            checkState("direct history pull keeps maximization", fixtureA, true, true);
            check("direct maximized history pull returns to original output", (modernTest ? fixtureA.output.name : fixtureA.screen) === startOutput);
            testCallbacks["Window Warp: Maximize"]();
        } else if (testStep === 40) {
            check("toggle restores floating geometry after direct maximized push-pull", sameRect(fixtureA.frameGeometry,startRect), {actual:testRect(fixtureA.frameGeometry),expected:startRect});
        } else if (testStep >= 41) {
            report();
        }
        testStep++;
    } catch (error) { check("runtime exception", false, {error:String(error)}); report(); }
});
testTimer.start();
