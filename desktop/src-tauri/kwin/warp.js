/* Loaded inside KWin, with WARP_CONFIG injected as JSON by the desktop app. */
var Warp = (function () {
    "use strict";
    var modern = "activeWindow" in workspace;
    if (!modern && typeof workspace.clientList !== "function") {
        throw new Error("Window Warp requires KDE Plasma 5.27 or 6.");
    }
    var history = [];
    var previousWindows = {};
    var settings = WARP_CONFIG.settings || {mainMonitor: 0, burnerMonitor: 2};
    function copy(rect) {
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    function screens() {
        var outputs = [];
        if (modern) outputs = Array.prototype.slice.call(workspace.screens);
        else for (var i = 0; i < workspace.numScreens; i++) {
            outputs.push({ id: i, name: String(i), geometry: workspace.clientArea(KWin.ScreenArea, i, workspace.currentDesktop) });
        }
        return outputs.sort(function (a, b) {
            return a.geometry.x - b.geometry.x || a.geometry.y - b.geometry.y;
        });
    }
    function area(output) {
        return workspace.clientArea(KWin.MaximizeArea, modern ? output : output.id, workspace.currentDesktop);
    }
    function windows() { return Array.prototype.slice.call(modern ? workspace.stackingOrder : workspace.clientList()); }
    function active() { return modern ? workspace.activeWindow : workspace.activeClient; }
    function outputFor(window, all) { return modern ? window.output : all.filter(function (s) { return s.id === window.screen; })[0]; }
    function send(window, output) { workspace.sendClientToScreen(window, modern ? output : output.id); }
    function relative(rect, source, target) {
        var width = Math.min(target.width, Math.max(1, Math.round(rect.width / Math.max(1, source.width) * target.width)));
        var height = Math.min(target.height, Math.max(1, Math.round(rect.height / Math.max(1, source.height) * target.height)));
        return {
            x: Math.max(target.x, Math.min(target.x + target.width - width, target.x + Math.round((rect.x-source.x) / Math.max(1, source.width) * target.width))),
            y: Math.max(target.y, Math.min(target.y + target.height - height, target.y + Math.round((rect.y-source.y) / Math.max(1, source.height) * target.height))),
            width: width, height: height
        };
    }
    function focus(window) {
        if (!window.onAllDesktops && window.desktops && window.desktops.length) {
            if (modern) workspace.currentDesktop = window.desktops[0];
            else workspace.currentVirtualDesktop = window.desktops[0];
        }
        if (window.activities && window.activities.length && window.activities.indexOf(workspace.currentActivity) < 0) {
            workspace.currentActivity = window.activities[0];
        }
        window.minimized = false;
        if (modern) workspace.activeWindow = window;
        else workspace.activeClient = window;
    }
    function tile(window, output, direction) {
        if (!window.resizeable && !window.fullScreen) return;
        window.fullScreen = false;
        window.setMaximize(false, false);
        send(window, output);
        var rect = copy(area(output));
        if (direction === "tile-up" || direction === "tile-down") {
            var half = Math.floor(rect.height / 2);
            if (direction === "tile-down") { rect.y += half; rect.height -= half; }
            else rect.height = half;
        } else {
            var half = Math.floor(rect.width / 2);
            if (direction === "tile-right") { rect.x += half; rect.width -= half; }
            else rect.width = half;
        }
        window.frameGeometry = rect;
    }
    function matches(window, match) {
        return !window.deleted && !window.dock && !window.desktopWindow &&
            (String(window.resourceClass).toLowerCase() === match || String(window.desktopFileName).toLowerCase() === match);
    }
    function moveRelative(window, from, to) {
        var rect = relative(copy(window.frameGeometry), area(from), area(to));
        send(window, to);
        window.frameGeometry = rect;
    }
    function pullApp(binding, all, holdPointer, selected, previous) {
        var current = previous || active();
        var candidates = windows().filter(function (w) { return matches(w, binding.appMatch.toLowerCase()); });
        var window = selected || (candidates.indexOf(current) >= 0 ? current : candidates[candidates.length - 1]);
        if (selected && candidates.indexOf(selected) < 0) throw new Error("The selected window no longer matches this app.");
        if (!window) { print("Window Warp: no open window for " + binding.appMatch); return; }
        var wasActive = window === current;
        if (!wasActive && current) previousWindows[binding.shortcut] = String(current.internalId);
        var mainIndex = settings.mainMonitor ? Math.min(settings.mainMonitor - 1, all.length - 1) : 0;
        // The origin output is the default; an explicit setting is stable across focus changes.
        if (!settings.mainMonitor) {
            all.forEach(function (s, i) { if (s.geometry.x === 0 && s.geometry.y === 0) mainIndex = i; });
        }
        var main = all[mainIndex];
        var from = outputFor(window, all);
        window.minimized = false;
        if (holdPointer) {
            var work = area(main);
            var direction = work.height > work.width
                ? (holdPointer.y < work.y + work.height / 2 ? "tile-up" : "tile-down")
                : (holdPointer.x < work.x + work.width / 2 ? "tile-left" : "tile-right");
            tile(window, main, direction);
            focus(window);
            return;
        }
        if (from !== main) { moveRelative(window, from || main, main); focus(window); return; }
        if (wasActive && binding.mainMonitorAction === "focus-last") {
            var previous = windows().filter(function (w) { return !w.deleted && String(w.internalId) === previousWindows[binding.shortcut]; })[0];
            if (previous) focus(previous);
            return;
        }
        if (wasActive && all.length > 1) {
            var burnerIndex = Math.min((settings.burnerMonitor || 2) - 1, all.length - 1);
            if (burnerIndex === mainIndex) burnerIndex = (mainIndex + 1) % all.length;
            var burner = all[burnerIndex];
            if (binding.burnerLayout === "tile-left" || binding.burnerLayout === "tile-right") tile(window, burner, binding.burnerLayout);
            else if (binding.burnerLayout === "fullscreen") {
                window.fullScreen = false;
                send(window, burner);
                window.setMaximize(true, true);
            } else moveRelative(window, main, burner);
        }
        focus(window);
    }
    function run(binding, overrides, holdPointer, selected, previous) {
        if (["toggle-pause", "open-editor", "open-workspaces", "update-workspace"].indexOf(binding.action) >= 0) {
            callDBus(WARP_APP.service, "/Control", "com.windowwarp.Control", "Action", WARP_APP.token, binding.action);
            return;
        }
        if (overrides) settings = overrides;
        var all = screens();
        if (!all.length) return;
        var window = active();
        if (binding.action === "pull-app") { pullApp(binding, all, holdPointer, selected, previous); return; }
        if (binding.action === "focus-app") {
            var match = binding.appMatch.toLowerCase();
            var candidates = windows().filter(function (w) {
                return matches(w, match);
            });
            // Stable order lets repeated presses cycle through every instance.
            candidates.sort(function (a, b) { return String(a.internalId).localeCompare(String(b.internalId)); });
            if (candidates.length) focus(candidates[(candidates.indexOf(window) + 1) % candidates.length]);
            else print("Window Warp: no open window for " + binding.appMatch);
            return;
        }
        if (binding.action === "pull") {
            while (history.length) {
                var previous = history.pop();
                var existing = windows().filter(function (w) { return String(w.internalId) === previous.id && !w.deleted; })[0];
                if (!existing) continue;
                var output = all.filter(function (s) { return s.name === previous.output; })[0] || outputFor(existing, all) || all[0];
                send(existing, output);
                existing.frameGeometry = relative(previous.rect, previous.area, area(output));
                focus(existing);
                return;
            }
            return;
        }
        if (!window || window.deleted || window.dock || window.desktopWindow) return;
        if (binding.action === "close-window") { window.closeWindow(); return; }
        if (binding.action === "toggle-maximize") { workspace.slotWindowMaximize(); return; }
        var current = all.indexOf(outputFor(window, all));
        if (current < 0) return;
        var source = area(all[current]);
        if (binding.action.indexOf("tile-") === 0) {
            // Fullscreen windows can report non-movable/non-resizable until
            // fullscreen is cleared. They must still reach this transition.
            tile(window, all[current], binding.action);
            return;
        }
        if (all.length < 2 || !window.moveableAcrossScreens) return;
        var next = (current + (binding.action === "push-left" ? all.length-1 : 1)) % all.length;
        var original = copy(window.frameGeometry);
        if (history.length >= 100) history.shift();
        history.push({ id: String(window.internalId), rect: original, output: all[current].name, area: copy(source) });
        send(window, all[next]);
        // KWin retains maximize/fullscreen state when sending to another output.
        // For floating windows, apply the same relative placement as Windows.
        window.frameGeometry = relative(original, source, area(all[next]));
    }
    WARP_CONFIG.bindings.forEach(function (binding, index) {
        if (binding.enabled === false) return;
        var shortcut = binding.shortcut.replace("Super", "Meta");
        var qtKeys = {Semicolon: ";", Quote: "'", Backquote: "`", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", PageUp: "PgUp", PageDown: "PgDown", Enter: "Return"};
        var parts = shortcut.split("+");
        parts[parts.length - 1] = qtKeys[parts[parts.length - 1]] || parts[parts.length - 1];
        shortcut = parts.join("+");
        // Include the key in the ID: KGlobalAccel otherwise keeps an old key
        // for a reused action name when the user edits a binding.
        var id = "window-warp-" + binding.action + "-" + index + "-" + shortcut.replace(/[^a-z0-9]/gi, "-");
        var holdId = typeof WARP_HOLD_IDS !== "undefined" && WARP_HOLD_IDS[index];
        if (holdId) id = typeof WARP_HOLD_NATIVE_IDS !== "undefined" ? WARP_HOLD_NATIVE_IDS[index] : "window-warp-hold-" + index + "-" + binding.shortcut;
        if (!registerShortcut(id, "Window Warp: " + binding.label, shortcut, function () {
            try {
                if (holdId) {
                    var pointer = workspace.cursorPos;
                    callDBus(WARP_APP.service, "/Control", "com.windowwarp.Control", "GesturePointer", WARP_APP.token, holdId,
                        JSON.stringify({x: Math.round(pointer.x), y: Math.round(pointer.y)}));
                } else run(binding);
            } catch (error) { print("Window Warp: " + String(error)); }
        })) throw new Error("Could not register " + shortcut);
    });
    return {windows: windows, screens: screens, area: area, outputFor: outputFor, focus: focus,
        send: send, relative: relative, copy: copy, tile: tile, run: run, active: active,
        resetAppPulls: function () { previousWindows = {}; }};
})();
