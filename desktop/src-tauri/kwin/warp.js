/* Loaded inside KWin, with WARP_CONFIG injected as JSON by the desktop app. */
var Warp = (function () {
    "use strict";
    var modern = "activeWindow" in workspace;
    if (!modern && typeof workspace.clientList !== "function") {
        throw new Error("Window Warp requires KDE Plasma 5.27 or 6.");
    }
    var history = [];
    var savedMaximize = [];
    var geometryQueue = [];
    var geometryBusy = false;
    var activeJob = null;
    var inputGeneration = null;
    var stateWait = null;
    var stateTimer = new QTimer();
    stateTimer.interval = 25;
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
    function primary(all) {
        return all.filter(function(s) { return s.geometry.x === 0 && s.geometry.y === 0; })[0] || all[0];
    }
    function centerPointer(output) {
        var r = area(output);
        function round(value) { return value < 0 ? -Math.round(-value) : Math.round(value); }
        var point = {x:round(r.x + r.width/2), y:round(r.y + r.height/2)};
        var endpoint = typeof WARP_CONTROL !== "undefined" ? WARP_CONTROL : WARP_APP;
        callDBus(endpoint.service, "/Control", "com.windowwarp.Control", "CenterPointer", endpoint.token, JSON.stringify(point));
    }
    function windows() { return Array.prototype.slice.call(modern ? workspace.stackingOrder : workspace.clientList()); }
    function identity(window) { return {id:String(window.internalId), pid:Number(window.pid || 0)}; }
    function live(target) {
        return windows().filter(function(w) {
            return !w.deleted && String(w.internalId) === target.id && Number(w.pid || 0) === target.pid;
        })[0];
    }
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
    function tile(window, output, direction, done, accepted) {
        if (!window.resizeable && !window.fullScreen) {
            if (accepted) accepted();
            done(); return;
        }
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
        var target = identity(window);
        restoreFloating(target, window, function(window) {
            send(window, output);
            window.frameGeometry = copy(rect);
            awaitPlacement(target, placement({horizontal:false, vertical:false}, window, output, rect), done, accepted);
        }, done, rect);
    }
    function matches(window, match) {
        return !window.deleted && !window.dock && !window.desktopWindow &&
            (String(window.resourceClass).toLowerCase() === match || String(window.desktopFileName).toLowerCase() === match);
    }
    function moveRelative(window, from, to) {
        var rect = relative(copy(window.frameGeometry), area(from), area(to));
        send(window, to);
        window.frameGeometry = rect;
        return rect;
    }
    function pullApp(binding, all, holdPointer, selected, previous, state, configuration, done) {
        var current = previous;
        var candidates = windows().filter(function (w) { return matches(w, binding.appMatch.toLowerCase()); });
        var window = selected || (candidates.indexOf(current) >= 0 ? current : candidates[candidates.length - 1]);
        if (selected && candidates.indexOf(selected) < 0) throw new Error("The selected window no longer matches this app.");
        if (!window) { done("No matching app window is open."); return; }
        var wasActive = window === current;
        if (!wasActive && current) previousWindows[binding.shortcut] = identity(current);
        var mainIndex = configuration.mainMonitor ? Math.min(configuration.mainMonitor - 1, all.length - 1) : 0;
        // The origin output is the default; an explicit setting is stable across focus changes.
        if (!configuration.mainMonitor) {
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
            tile(window, main, direction, done, function() { focus(window); });
            return;
        }
        if (from !== main) {
            var rect = moveRelative(window, from || main, main);
            focus(window); centerPointer(main);
            awaitPlacement(identity(window), placement(state, window, main, rect), done);
            return;
        }
        if (wasActive && binding.mainMonitorAction === "focus-last") {
            var previous = previousWindows[binding.shortcut] && live(previousWindows[binding.shortcut]);
            if (previous) focus(previous);
            done();
            return;
        }
        if (wasActive && all.length > 1) {
            var burnerIndex = Math.min((configuration.burnerMonitor || 2) - 1, all.length - 1);
            if (burnerIndex === mainIndex) burnerIndex = (mainIndex + 1) % all.length;
            var burner = all[burnerIndex];
            if (binding.burnerLayout === "tile-left" || binding.burnerLayout === "tile-right") {
                tile(window, burner, binding.burnerLayout, done, function() { focus(window); });
                return;
            }
            else if (binding.burnerLayout === "fullscreen") {
                window.fullScreen = false;
                send(window, burner);
                window.setMaximize(true, true);
                state = {horizontal:true, vertical:true, fullscreen:false};
            } else { var rect = moveRelative(window, main, burner); }
            focus(window);
            awaitPlacement(identity(window), placement(state, window, burner, rect), done);
            return;
        }
        focus(window);
        if (!wasActive) centerPointer(main);
        done();
    }
    function finishWait(wait, error, window, state) {
        if (stateWait !== wait) return;
        stateTimer.stop(); stateWait = null;
        if (error || !window) {
            wait.done.diagnostic = {expected:wait.expected, observed:wait.observed || null, pendingReply:wait.pending};
            wait.done(error); return;
        }
        try { wait.callback(window, state); }
        catch (error) { wait.done(String(error)); }
    }
    function pollState() {
        var wait = stateWait;
        if (!wait) return;
        if (!live(wait.target)) { finishWait(wait, "The selected window closed or changed identity."); return; }
        if (Date.now() >= wait.done.deadline) { finishWait(wait, "KWin did not confirm the requested window state or geometry within 1.8 seconds."); return; }
        if (wait.pending) return;
        wait.pending = true;
        // This established D-Bus API exposes actual acknowledged maximize
        // state; scripting windows do not expose readable maximize flags.
        try {
            callDBus("org.kde.KWin", "/KWin", "org.kde.KWin", "getWindowInfo", wait.target.id, function(info) {
                if (stateWait !== wait) return; // Ignore a late reply after timeout.
                wait.pending = false;
                try {
                    if (Date.now() >= wait.done.deadline) { finishWait(wait, "KWin did not confirm the requested window state or geometry within 1.8 seconds."); return; }
                    var window = live(wait.target);
                    if (!window) { finishWait(wait, "The selected window closed or changed identity."); return; }
                    if (!info || !info.uuid || ![info.maximizeHorizontal, info.maximizeVertical].every(function(flag) {
                        return typeof flag === "boolean" || (typeof flag === "number" && isFinite(flag));
                    })) throw new Error("KWin did not return the window's maximize state.");
                    var state = {horizontal:!!info.maximizeHorizontal, vertical:!!info.maximizeVertical};
                    var output = outputFor(window, screens());
                    wait.observed = {horizontal:state.horizontal, vertical:state.vertical,
                        fullscreen:!!window.fullScreen, output:output ? output.name : null, rect:copy(window.frameGeometry)};
                    if (wait.matches(window, state)) finishWait(wait, null, window, state);
                } catch (error) { finishWait(wait, String(error)); }
            });
        } catch (error) { finishWait(wait, String(error)); }
    }
    stateTimer.timeout.connect(pollState);
    function awaitState(target, matches, callback, done, expected) {
        stateWait = {target:target, matches:matches, callback:callback, done:done, pending:false,
            expected:expected || {phase:"initial-state-query"}};
        stateTimer.start(); pollState();
    }
    function withWindowState(target, callback, done) {
        awaitState(target, function() { return true; }, callback, done);
    }
    function restoreFloating(target, window, callback, done, desiredRect) {
        window.fullScreen = false;
        window.setMaximize(false, false);
        // A same-size Wayland restore may need a resize configure before its
        // state transition commits. Use only an already-known destination.
        if (desiredRect) window.frameGeometry = copy(desiredRect);
        // Wayland clients can commit their own restore rectangle after the
        // setter returns. Reapply our authoritative rectangle after it commits.
        awaitState(target, function(window, state) {
            return !window.fullScreen && !state.horizontal && !state.vertical;
        }, callback, done, {phase:"unmaximize", horizontal:false, vertical:false, fullscreen:false});
    }
    function placement(state, window, output, rect) {
        var fullscreen = state.fullscreen === undefined ? !!window.fullScreen : state.fullscreen;
        var expected = {horizontal:state.horizontal, vertical:state.vertical, fullscreen:fullscreen, output:output.name};
        if (fullscreen) expected.rect = copy(output.geometry);
        else if (rect || state.horizontal || state.vertical) {
            expected.rect = copy(rect || window.frameGeometry);
            var work = area(output);
            if (state.horizontal) { expected.rect.x = work.x; expected.rect.width = work.width; }
            if (state.vertical) { expected.rect.y = work.y; expected.rect.height = work.height; }
            if (!rect) expected.axes = (state.horizontal ? ["x","width"] : []).concat(state.vertical ? ["y","height"] : []);
        }
        return expected;
    }
    function awaitPlacement(target, expected, done, accepted) {
        awaitState(target, function(window, state) {
            var output = outputFor(window, screens());
            return state.horizontal === expected.horizontal && state.vertical === expected.vertical
                && !!window.fullScreen === expected.fullscreen && (!expected.output || (output && output.name === expected.output))
                && (!expected.rect || (expected.axes || ["x","y","width","height"]).every(function(key) {
                    return Math.abs(window.frameGeometry[key] - expected.rect[key]) <= 1;
                }));
        }, function() { if (accepted) accepted(); done(); }, done, expected);
    }
    function applyGeometry(job, done) {
        var all = screens();
        savedMaximize = savedMaximize.filter(function(entry) { return !!live(entry.target); });
        if (!all.length) { done(); return; }
        if (job.action === "restore-workspace") {
            var existing = live(job.target);
            if (!existing) { done("The selected window closed or changed identity."); return; }
            var saved = job.placement;
            var output = all.filter(function(o) { return o.name === saved.monitorName; })[0] || all[Math.min(Math.max(0, saved.monitor - 1), all.length - 1)];
            var requested = relative(saved.rect, saved.workArea, area(output));
            var state = {horizontal:saved.maximizedHorizontal, vertical:saved.maximizedVertical, fullscreen:saved.fullscreen};
            job.result = requested;
            existing.minimized = false;
            function placed() {
                existing.setMaximize(state.vertical, state.horizontal);
                existing.fullScreen = saved.fullscreen;
                awaitPlacement(job.target, placement(state, existing, output, requested), done, function() { existing.minimized = saved.minimized; });
            }
            if (state.horizontal && state.vertical && !saved.fullscreen) {
                existing.fullScreen = false; send(existing, output); placed();
            } else restoreFloating(job.target, existing, function(window) {
                send(window, output); window.frameGeometry = copy(requested); placed();
            }, done, requested);
            return;
        }
        if (job.action === "pull") {
            while (history.length) {
                var previous = history.pop();
                var existing = live(previous.target);
                if (!existing) continue;
                var output = all.filter(function(s) { return s.name === previous.output; })[0] || outputFor(existing, all) || all[0];
                existing.minimized = false;
                if (previous.horizontal && previous.vertical && !previous.fullscreen) {
                    // A maximized history entry needs only its output and state.
                    // Restoring through a full-area floating rectangle can stall
                    // Wayland unmaximize and replace the client's restore size.
                    existing.fullScreen = false;
                    send(existing, output);
                    existing.setMaximize(true, true);
                    awaitPlacement(previous.target, placement(previous, existing, output), done, function() {
                        focus(existing); centerPointer(primary(screens()));
                    });
                    return;
                }
                restoreFloating(previous.target, existing, function(existing) {
                    send(existing, output);
                    existing.frameGeometry = relative(previous.rect, previous.area, area(output));
                    existing.setMaximize(previous.vertical, previous.horizontal);
                    existing.fullScreen = previous.fullscreen;
                    focus(existing);
                    awaitPlacement(previous.target, placement(previous, existing, output,
                        relative(previous.rect, previous.area, area(output))), done, function() { centerPointer(primary(screens())); });
                }, done, relative(previous.rect, previous.area, area(output)));
                return;
            }
            done(); return;
        }
        if (job.action === "pull-app") {
            var previous = job.previous ? live(job.previous) : null;
            var selected = job.selected ? live(job.selected) : null;
            if (job.selected && !selected) { done("The selected window closed or changed identity."); return; }
            var candidates = windows().filter(function(w) { return matches(w, job.binding.appMatch.toLowerCase()); });
            var selected = selected || (candidates.indexOf(previous) >= 0 ? previous : candidates[candidates.length - 1]);
            if (!selected) { done("No matching app window is open."); return; }
            var target = identity(selected);
            withWindowState(target, function(window, state) {
                pullApp(job.binding, screens(), job.pointer, window,
                    job.previous ? live(job.previous) || null : null, state, job.settings, done);
            }, done);
            return;
        }
        var window = live(job.target);
        if (!window || window.dock || window.desktopWindow) { done(); return; }
        if (job.action === "close-window") { window.closeWindow(); done(); return; }
        var current = all.indexOf(outputFor(window, all));
        if (current < 0) { done(); return; }
        if (job.action.indexOf("tile-") === 0) {
            tile(window, all[current], job.action, done);
            return;
        }
        if (job.action === "toggle-maximize") {
            withWindowState(job.target, function(window, state) {
                window.minimized = false;
                window.fullScreen = false;
                if (state.horizontal && state.vertical) {
                    var saved = savedMaximize.filter(function(entry) {
                        return entry.target.id === job.target.id && entry.target.pid === job.target.pid;
                    })[0];
                    // No saved rectangle means a normal compositor restore.
                    // Keep our saved entry after restoration, like AHK's Saved.
                    restoreFloating(job.target, window, function(window) {
                        if (saved) {
                            var originalOutput = screens().filter(function(output) { return output.name === saved.output; })[0];
                            if (originalOutput) send(window, originalOutput);
                            window.frameGeometry = copy(saved.rect);
                        }
                        awaitPlacement(job.target, {horizontal:false, vertical:false, fullscreen:false,
                            output:originalOutput ? originalOutput.name : null, rect:saved ? saved.rect : null}, done);
                    }, done, saved ? saved.rect : null);
                } else {
                    var output = outputFor(window, screens());
                    savedMaximize = savedMaximize.filter(function(entry) { return entry.target.id !== job.target.id; });
                    savedMaximize.push({target:job.target, rect:copy(window.frameGeometry), output:output ? output.name : ""});
                    window.setMaximize(true, true);
                    awaitPlacement(job.target, placement({horizontal:true, vertical:true, fullscreen:false}, window, output), done);
                }
            }, done);
            return;
        }
        if (!window.moveableAcrossScreens) { done(); return; }
        withWindowState(job.target, function(window, state) {
            var all = screens();
            var current = all.indexOf(outputFor(window, all));
            if (current < 0 || !window.moveableAcrossScreens) { done(); return; }
            var next = (current + (job.action.indexOf("push-left") === 0 ? all.length-1 : 1)) % all.length;
            var original = copy(window.frameGeometry);
            var source = area(all[current]);
            if (history.length >= 100) history.shift();
            history.push({target:job.target, rect:original, output:all[current].name, area:copy(source),
                horizontal:state.horizontal, vertical:state.vertical, fullscreen:!!window.fullScreen});
            send(window, all[next]);
            // Sending preserves maximize/fullscreen state. Only floating
            // placement needs explicit scaling across outputs.
            if (!state.horizontal && !state.vertical && !window.fullScreen) {
                window.frameGeometry = relative(original, source, area(all[next]));
            }
            var expectedRect = !state.horizontal && !state.vertical ? relative(original, source, area(all[next])) : null;
            awaitPlacement(job.target, placement(state, window, all[next], expectedRect), done, function() {
                callDBus(WARP_APP.service, "/Control", "com.windowwarp.Control", "ArmRetile", WARP_APP.token,
                    JSON.stringify({id:job.target.id, pid:job.target.pid, generation:job.generation}), String(Date.now()));
                if (job.action === "push-left-center" || job.action === "push-right-center") centerPointer(all[next]);
            });
        }, done);
    }
    function nextGeometry() {
        if (geometryBusy || !geometryQueue.length) return;
        geometryBusy = true;
        var job = geometryQueue.shift();
        activeJob = job;
        var finished = false;
        var done = function(error, cancelled) {
            if (finished) return;
            finished = true;
            if (stateWait && stateWait.done === done) { stateTimer.stop(); stateWait = null; }
            try {
                if (error && !cancelled && done.diagnostic) print("Window Warp: " + String(error) + "; geometry " + JSON.stringify({action:job.action,
                    expected:done.diagnostic.expected, observed:done.diagnostic.observed, pendingReply:done.diagnostic.pendingReply}));
                if (job.completion) job.completion(error || null, job.result, !!cancelled);
                else if (error && !cancelled && !done.diagnostic) print("Window Warp: " + String(error));
            } finally { activeJob = null; geometryBusy = false; nextGeometry(); }
        };
        job.cancel = function() { done("Shortcut action cancelled after pause or configuration change.", true); };
        done.deadline = job.deadline;
        if (job.generation !== undefined && job.generation !== inputGeneration) { job.cancel(); return; }
        if (Date.now() >= done.deadline) { done("Window action expired while waiting for an earlier operation."); return; }
        try { applyGeometry(job, done); }
        catch (error) { done(String(error)); }
    }
    function queueGeometry(action, window, extra) {
        // Serialize these shortcuts across the asynchronous state query so a
        // quick push/pull or two toggles cannot overtake the earlier action.
        var job = {action:action, target:window ? identity(window) : null, deadline:Date.now() + 1800};
        if (extra) Object.keys(extra).forEach(function(key) { job[key] = extra[key]; });
        geometryQueue.push(job);
        nextGeometry();
    }
    function run(binding, overrides, holdPointer, selected, previous, completion, invocation) {
        if (binding.windowsMatch && (binding.action === "pull-app" || binding.action === "focus-app")) {
            throw new Error("Windows window-match rules cannot run on KDE. Adapt the binding to a KDE app identifier first.");
        }
        if (["toggle-pause", "open-editor", "open-workspaces", "update-workspace"].indexOf(binding.action) >= 0) {
            callDBus(WARP_APP.service, "/Control", "com.windowwarp.Control", "Action", WARP_APP.token, binding.action);
            return;
        }
        var all = screens();
        if (!all.length) { if (completion) completion("No connected output is available."); return; }
        var window = invocation ? (invocation.window ? live(invocation.window) : null) : active();
        var extra = {completion:completion};
        if (invocation) {
            extra.generation = invocation.generation;
            extra.deadline = invocation.deadline || invocation.at + 1800;
            previous = invocation.previous ? live(invocation.previous) || null : null;
            if (invocation.generation !== inputGeneration || Date.now() >= extra.deadline) {
                if (completion) completion("Shortcut action expired or was cancelled.", null, true);
                return;
            }
        }
        if (overrides) settings = overrides;
        if (binding.action === "pull-app") {
            if (selected && !matches(selected, binding.appMatch.toLowerCase())) throw new Error("The selected window no longer matches this app.");
            extra.binding=binding; extra.settings=settings; extra.pointer=holdPointer;
            extra.selected=selected ? identity(selected) : null;
            var prior=invocation ? previous : (previous || window);
            extra.previous=prior ? identity(prior) : null;
            queueGeometry(binding.action, null, extra);
            return;
        }
        if (binding.action === "focus-app") {
            var match = binding.appMatch.toLowerCase();
            var candidates = windows().filter(function (w) {
                return matches(w, match);
            });
            // Stable order lets repeated presses cycle through every instance.
            candidates.sort(function (a, b) { return String(a.internalId).localeCompare(String(b.internalId)); });
            if (candidates.length) focus(candidates[(candidates.indexOf(window) + 1) % candidates.length]);
            if (completion) completion(candidates.length ? null : "No matching app window is open.");
            else if (!candidates.length) print("Window Warp: no open window for " + binding.appMatch);
            return;
        }
        if (binding.action === "pull") { queueGeometry(binding.action, null, extra); return; }
        if (!window || window.deleted || window.dock || window.desktopWindow) { if(completion) completion("The captured window is no longer available."); return; }
        queueGeometry(binding.action, window, extra);
    }
    function configureSession(generation) {
        inputGeneration = generation;
        var cancelled = geometryQueue.filter(function(job) { return job.generation !== undefined; });
        geometryQueue = geometryQueue.filter(function(job) { return job.generation === undefined; });
        cancelled.forEach(function(job) { if (job.completion) job.completion("Shortcut action cancelled after pause or configuration change.", null, true); });
        if (activeJob && activeJob.generation !== undefined) activeJob.cancel();
    }
    return {windows: windows, screens: screens, area: area, outputFor: outputFor, focus: focus,
        send: send, relative: relative, copy: copy, tile: tile, run: run, active: active,
        configureSession: configureSession,
        restore: function(window, saved, completion, deadline) { queueGeometry("restore-workspace", window,
            {placement:saved, completion:completion, deadline:deadline || Date.now() + 1800}); }};
})();
