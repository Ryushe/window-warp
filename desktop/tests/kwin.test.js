import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src-tauri/kwin/warp.js", import.meta.url), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
function fixture(bindings, legacy = false, settings = {mainMonitor: 1, burnerMonitor: 2}) {
    const left = { name: "left", geometry: { x: -1920, y: 0, width: 1920, height: 1080 } };
    const right = { name: "right", geometry: { x: 0, y: 40, width: 1081, height: 1920 } };
    const window = { internalId: "a", resourceClass: "firefox", desktopFileName: "firefox", output: left,
        frameGeometry: { x: -960, y: 0, width: 960, height: 1080 }, moveable: true, moveableAcrossScreens: true,
        resizeable: true, minimized: false, desktops: ["desktop-1"], activities: [], setMaximize() {} };
    const workspace = { screens: [right, left], stackingOrder: [window], activeWindow: window, currentDesktop: "desktop-1",
        clientArea: (_, output) => output.geometry,
        sendClientToScreen: (win, output) => { win.output = output; } };
    if (legacy) {
        const outputs = workspace.screens;
        delete workspace.screens;
        delete workspace.activeWindow;
        workspace.activeClient = window;
        workspace.currentDesktop = 1;
        workspace.numScreens = outputs.length;
        workspace.clientList = () => workspace.stackingOrder;
        workspace.clientArea = (_, index) => outputs[index].geometry;
        workspace.sendClientToScreen = (win, index) => { win.screen = index; };
        window.screen = 1;
    }
    const shortcuts = new Map();
    const calls = [];
    vm.runInNewContext(source, { workspace, KWin: { MaximizeArea: 0 }, print: () => {},
        WARP_APP: {service:"fixture",token:"test"}, callDBus: (...args) => calls.push(args),
        WARP_CONFIG: { bindings, settings }, registerShortcut: (_, label, key, callback) => { shortcuts.set(label, { key, callback }); return true; } });
    return { workspace, window, left, right, shortcuts, calls, trigger: (label) => shortcuts.get("Window Warp: " + label).callback() };
}
const push = { label: "Push", shortcut: "Ctrl+Alt+Right", action: "push-right", appMatch: "" };
const pull = { label: "Pull", shortcut: "Ctrl+Alt+Down", action: "pull", appMatch: "" };

test("push scales placement across negative origins and portrait outputs; pull restores", () => {
    const f = fixture([push, pull]);
    const original = clone(f.window.frameGeometry);
    f.trigger("Push");
    assert.equal(f.window.output, f.right);
    assert.deepEqual(clone(f.window.frameGeometry), { x: 540, y: 40, width: 541, height: 1920 });
    f.trigger("Pull");
    assert.equal(f.window.output, f.left);
    assert.deepEqual(clone(f.window.frameGeometry), original);
});
test("pull skips closed windows", () => {
    const f = fixture([push, pull]);
    f.trigger("Push");
    f.workspace.stackingOrder = [];
    const before = clone(f.window.frameGeometry);
    f.trigger("Pull");
    assert.deepEqual(clone(f.window.frameGeometry), before);
});
test("pull adapts to a disconnected original monitor", () => {
    const f = fixture([push, pull]);
    f.trigger("Push");
    f.workspace.screens = [f.right];
    f.trigger("Pull");
    const rect = f.window.frameGeometry;
    assert.equal(f.window.output, f.right);
    assert.ok(rect.x >= f.right.geometry.x && rect.x + rect.width <= f.right.geometry.x + f.right.geometry.width);
});
test("odd-width tiling covers the entire usable width", () => {
    const f = fixture([{ label: "Left", shortcut: "Ctrl+Alt+J", action: "tile-left" }, { label: "Right", shortcut: "Ctrl+Alt+L", action: "tile-right" }]);
    f.window.output = f.right;
    f.trigger("Left");
    const left = clone(f.window.frameGeometry);
    f.trigger("Right");
    const right = clone(f.window.frameGeometry);
    assert.equal(left.x + left.width, right.x);
    assert.equal(left.width + right.width, f.right.geometry.width);
});
test("app matching is exact, cycles instances, and restores a minimized app", () => {
    const f = fixture([{ label: "Firefox", shortcut: "Super+F", action: "focus-app", appMatch: "FIREFOX" }]);
    const second = { ...f.window, internalId: "b", minimized: true, desktops: ["desktop-2"] };
    const unrelated = { ...f.window, internalId: "c", resourceClass: "firefox-helper", desktopFileName: "other" };
    f.workspace.stackingOrder = [unrelated, f.window, second];
    f.trigger("Firefox");
    assert.equal(f.workspace.activeWindow, second);
    assert.equal(second.minimized, false);
    assert.equal(f.workspace.currentDesktop, "desktop-2");
    f.trigger("Firefox");
    assert.equal(f.workspace.activeWindow, f.window);
    assert.equal(f.shortcuts.get("Window Warp: Firefox").key, "Meta+F");
});
test("one-monitor push is a no-op", () => {
    const f = fixture([push]);
    f.workspace.screens = [f.left];
    const before = clone(f.window.frameGeometry);
    f.trigger("Push");
    assert.deepEqual(clone(f.window.frameGeometry), before);
});

test("Plasma 5 uses screen indexes and restores a pushed window", () => {
    const f = fixture([push, pull], true);
    const original = clone(f.window.frameGeometry);
    f.trigger("Push");
    assert.equal(f.window.screen, 0);
    assert.deepEqual(clone(f.window.frameGeometry), { x: 540, y: 40, width: 541, height: 1920 });
    f.trigger("Pull");
    assert.equal(f.window.screen, 1);
    assert.deepEqual(clone(f.window.frameGeometry), original);
    assert.equal(f.workspace.activeClient, f.window);
});

test("fullscreen capability flags do not block leaving fullscreen to tile", () => {
    const f = fixture([{label: "Tile", shortcut: "Ctrl+Alt+J", action: "tile-left"}]);
    f.window.fullScreen = true;
    f.window.moveable = false;
    f.window.resizeable = false;
    f.trigger("Tile");
    assert.equal(f.window.fullScreen, false);
    assert.equal(f.window.frameGeometry.width, 960);
});

test("top and bottom tiling cover odd-height work areas without gaps", () => {
    const f = fixture(["up", "down"].map(d => ({label:d, shortcut: "Ctrl+Alt+" + d, action: "tile-" + d})));
    f.left.geometry.height = 1081;
    f.trigger("up");
    const top = clone(f.window.frameGeometry);
    f.trigger("down");
    assert.equal(top.y + top.height, f.window.frameGeometry.y);
    assert.equal(top.height + f.window.frameGeometry.height, 1081);
});

for (const legacy of [false, true]) test(`app pull toggles between main and tiled burner on Plasma ${legacy ? 5 : 6}`, () => {
    const f = fixture([{label: "App", action: "pull-app", appMatch: "firefox", shortcut: "Ctrl+Alt+F", mainMonitorAction: "burner", burnerLayout: "tile-right"}], legacy);
    f.trigger("App");
    assert.equal(legacy ? f.window.screen : f.window.output, legacy ? 0 : f.right);
    assert.equal(f.window.frameGeometry.width, 541);
    f.trigger("App");
    assert.equal(legacy ? f.window.screen : f.window.output, legacy ? 1 : f.left);
    assert.equal(f.window.frameGeometry.width, 961);
});

test("focus-last remembers the previous application and ignores closed windows", () => {
    const f = fixture([{label: "App", action: "pull-app", appMatch: "firefox", shortcut: "Ctrl+Alt+F", mainMonitorAction: "focus-last"}]);
    const other = {...f.window, internalId: "other", resourceClass: "terminal", desktopFileName: "terminal"};
    f.workspace.stackingOrder.push(other);
    f.workspace.activeWindow = other;
    f.trigger("App");
    assert.equal(f.workspace.activeWindow, f.window);
    f.trigger("App");
    assert.equal(f.workspace.activeWindow, other);
    f.trigger("App");
    f.workspace.stackingOrder = [f.window];
    f.trigger("App");
    assert.equal(f.workspace.activeWindow, f.window);
});

test("disabled bindings do not register; punctuation keys use Qt syntax", () => {
    const f = fixture([{...push, enabled: false}, {label: "Punctuation", action: "tile-left", shortcut: "Super+Semicolon"}]);
    assert.equal(f.shortcuts.size, 1);
    assert.equal(f.shortcuts.get("Window Warp: Punctuation").key, "Meta+;");
});

test("maximize and close dispatch to compositor operations on the active fixture", () => {
    const f = fixture([{label:"Max", action:"toggle-maximize", shortcut:"Ctrl+Alt+M"}, {label:"Close", action:"close-window", shortcut:"Ctrl+Alt+Q"}]);
    let maximized = false, closed = false;
    f.workspace.slotWindowMaximize = () => { maximized = !maximized; };
    f.window.closeWindow = () => { closed = true; };
    f.trigger("Max"); assert.equal(maximized, true);
    f.trigger("Max"); assert.equal(maximized, false);
    f.trigger("Close"); assert.equal(closed, true);
});

test("application controls use the native bridge even when no desktop window is active", () => {
    const f = fixture([{label:"Pause",shortcut:"Ctrl+Alt+P",action:"toggle-pause"}]);
    f.workspace.activeWindow = null;
    f.workspace.screens = [];
    f.trigger("Pause");
    assert.deepEqual(f.calls[0], ["fixture","/Control","com.windowwarp.Control","Action","test","toggle-pause"]);
});
