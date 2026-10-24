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
        var window = target(command);
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
