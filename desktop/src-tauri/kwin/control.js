/* Private command transport for the desktop app. The dispatch action has no key. */
(function () {
    "use strict";
    var sessionConfigured = false;
    // The normal owner lives for the application session. If KWin reloads this
    // script, recover the active generation without accepting stale callbacks.
    callDBus(WARP_CONTROL.service, "/Control", "com.windowwarp.Control", "InputGeneration", WARP_CONTROL.token, function(payload) {
        if (!sessionConfigured) { Warp.configureSession(JSON.parse(payload)); sessionConfigured = true; }
    });
    function rect(value) {
        return {x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height)};
    }
    function identity(window) { return {id: String(window.internalId), pid: Number(window.pid || 0)}; }
    function reply(job, result, error, cancelled) {
        var payload = error ? {error:String(error)} : {result:result};
        if (cancelled) payload.cancelled = true;
        callDBus(WARP_CONTROL.service, "/Control", "com.windowwarp.Control", "Reply", WARP_CONTROL.token,
            String(job.id), JSON.stringify(payload));
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
        command.deadline = Math.min(job.expires, command.at ? command.at + 1800 : Date.now() + 1800);
        if (command.kind === "snapshot") { snapshot(job); return; }
        if (command.kind === "focus-editor") {
            var editor = Warp.windows().filter(function(w) {
                return !w.deleted && w.normalWindow && String(w.caption) !== "Window Warp Picker" && Number(w.pid || 0) === WARP_CONTROL.ownPid;
            })[0];
            if (editor) Warp.focus(editor);
            reply(job, !!editor);
            return;
        }
        if (command.kind === "input-session") { sessionConfigured = true; Warp.configureSession(command.generation); reply(job, true); return; }
        function completed(error, result, cancelled) { reply(job, error ? null : (result === undefined ? true : result), error, cancelled); }
        if (command.kind === "shortcut") {
            Warp.run(command.binding, command.settings, null, null, null, completed, command);
            return;
        }
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
            Warp.run(command.binding, command.settings, command.pointer, undefined, undefined, completed, command);
            return;
        }
        var window = target(command);
        if (command.kind === "pull-selected") {
            var previous = command.previous && Warp.windows().filter(function(w) {
                return !w.deleted && String(w.internalId) === command.previous.id && Number(w.pid || 0) === command.previous.pid;
            })[0];
            Warp.run(command.binding, command.settings, null, window, previous, completed, command);
            return;
        }
        if (command.kind === "restore") {
            Warp.restore(window, command.placement, completed, command.deadline);
            return;
        } else if (command.kind === "retile") {
            Warp.run({action:command.direction}, null, null, null, null, function(error,result,cancelled) {
                if (!error) Warp.focus(window);
                completed(error,result,cancelled);
            }, command);
            return;
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
