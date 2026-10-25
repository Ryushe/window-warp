/* Private command transport for the desktop app. The dispatch action has no key. */
(function () {
    "use strict";
    function rect(value) {
        return {x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height)};
    }
    function identity(window) { return {id: String(window.internalId), pid: Number(window.pid || 0)}; }
    function reply(job, result, error) {
        callDBus(WARP_CONTROL.service, "/Control", "com.windowwarp.Control", "Reply", WARP_CONTROL.token,
            String(job.id), JSON.stringify(error ? {error: String(error)} : {result: result}));
    }
    function snapshot(job) {
        var outputs = Warp.screens();
        var candidates = Warp.windows().filter(function(w) {
            return !w.deleted && !w.dock && !w.desktopWindow && !w.skipTaskbar &&
                (w.normalWindow || w.dialog) && String(w.caption || "") !== "" &&
                Number(w.pid || 0) !== WARP_CONTROL.ownPid && String(w.desktopFileName) !== "com.windowwarp.desktop";
        });
        var result = [];
        var pending = candidates.length;
        if (!pending) { reply(job, []); return; }
        candidates.forEach(function(w, index) {
            var output = Warp.outputFor(w, outputs);
            var item = identity(w);
            item.title = String(w.caption);
            item.appId = String(w.resourceClass);
            item.desktopId = String(w.desktopFileName || "");
            item.path = "";
            item.rect = rect(w.frameGeometry);
            item.workArea = rect(Warp.area(output));
            item.monitor = outputs.indexOf(output) + 1;
            item.monitorName = output.name;
            item.minimized = !!w.minimized;
            item.fullscreen = !!w.fullScreen;
            item.active = w === Warp.active();
            callDBus("org.kde.KWin", "/KWin", "org.kde.KWin", "getWindowInfo", item.id, function(info) {
                if (!info || !info.uuid) { item = null; }
                else {
                    item.maximizedHorizontal = !!info.maximizeHorizontal;
                    item.maximizedVertical = !!info.maximizeVertical;
                }
                result[index] = item;
                if (--pending === 0) reply(job, result.filter(function(item) { return item !== null; }));
            });
        });
    }
    function target(command) {
        var found = Warp.windows().filter(function(w) { return !w.deleted && String(w.internalId) === command.window.id && Number(w.pid || 0) === command.window.pid; })[0];
        if (!found) throw new Error("The selected window has closed or changed identity.");
        return found;
    }
    function execute(job) {
        if (Date.now() > job.expires) { reply(job, null, "Window command expired before it could run."); return; }
        var command = job.command;
        if (command.kind === "snapshot") { snapshot(job); return; }
        if (command.kind === "focus-editor") {
            var editor = Warp.windows().filter(function(w) {
                return !w.deleted && w.normalWindow && String(w.caption) !== "Window Warp Picker" && Number(w.pid || 0) === WARP_CONTROL.ownPid;
            })[0];
            if (editor) Warp.focus(editor);
            reply(job, !!editor);
            return;
        }
        if (command.kind === "reset-app-pulls") { Warp.resetAppPulls(); reply(job, true); return; }
        if (command.kind === "pointer") {
            reply(job, {x:Math.round(workspace.cursorPos.x), y:Math.round(workspace.cursorPos.y)});
            return;
        }
        if (command.kind === "pointer-area") {
            var point = command.point;
            var outputs = Warp.screens();
            function distance(output) {
                var r = output.geometry;
                var dx = Math.max(r.x-point.x, 0, point.x-r.x-r.width);
                var dy = Math.max(r.y-point.y, 0, point.y-r.y-r.height);
                return dx*dx+dy*dy;
            }
            outputs.sort(function(a,b) { return distance(a)-distance(b); });
            if (!outputs.length) throw new Error("No connected output is available.");
            reply(job, rect(Warp.area(outputs[0])));
            return;
        }
        if (command.kind === "show-radial") {
            var picker = Warp.windows().filter(function(w) {
                return !w.deleted && Number(w.pid || 0) === WARP_CONTROL.ownPid && String(w.caption) === "Window Warp Picker";
            })[0];
            if (picker) { picker.keepAbove = true; picker.frameGeometry = command.bounds; Warp.focus(picker); }
            reply(job, !!picker);
            return;
        }
        if (command.kind === "app-pull") {
            Warp.run(command.binding, command.settings, command.pointer, undefined, undefined,
                function(error) { reply(job, error ? null : true, error); });
            return;
        }
        var window = target(command);
        if (command.kind === "pull-selected") {
            var previous = command.previous && Warp.windows().filter(function(w) {
                return !w.deleted && String(w.internalId) === command.previous.id && Number(w.pid || 0) === command.previous.pid;
            })[0];
            Warp.run(command.binding, command.settings, null, window, previous,
                function(error) { reply(job, error ? null : true, error); });
            return;
        }
        if (command.kind === "restore") {
            var placement = command.placement;
            var outputs = Warp.screens();
            var output = outputs.filter(function(o) { return o.name === placement.monitorName; })[0] || outputs[Math.min(Math.max(0, placement.monitor - 1), outputs.length - 1)];
            if (!output) throw new Error("No connected output is available.");
            window.minimized = false;
            window.fullScreen = false;
            window.setMaximize(false, false);
            Warp.send(window, output);
            var requested = Warp.relative(placement.rect, placement.workArea, Warp.area(output));
            window.frameGeometry = requested;
            window.setMaximize(placement.maximizedVertical, placement.maximizedHorizontal);
            window.fullScreen = placement.fullscreen;
            window.minimized = placement.minimized;
            reply(job, rect(requested));
            return;
        } else if (command.kind === "retile") {
            var output = Warp.outputFor(window, Warp.screens());
            if (!output) throw new Error("The window's monitor disconnected.");
            Warp.focus(window);
            Warp.tile(window, output, command.direction);
        } else if (command.kind === "focus") Warp.focus(window);
        else throw new Error("Unknown window command.");
        reply(job, true);
    }
    if (!registerShortcut(WARP_CONTROL.action, "Window Warp: desktop commands", "", function() {
        callDBus(WARP_CONTROL.service, "/Control", "com.windowwarp.Control", "Next", WARP_CONTROL.token, function(payload) {
            var job;
            try { job = JSON.parse(payload); if (job) execute(job); }
            catch (error) { if (job) reply(job, null, error); else print("Window Warp control: " + error); }
        });
    })) throw new Error("Could not register the Window Warp command bridge.");
})();
