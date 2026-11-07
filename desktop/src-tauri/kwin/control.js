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
    function desktop(value) {
        if (typeof value === "number") return value > 0 ? {id:"kde-number:" + value, name:"Desktop " + value} : null;
        if (typeof value === "string") return value ? {id:value, name:""} : null;
        if (!value) return null;
        var id = String(value.id || "");
        return id ? {id:id, name:String(value.name || "")} : null;
    }
    function currentDesktop() {
        var current = desktop(workspace.currentDesktop);
        if (current && typeof workspace.currentDesktop === "number" && workspace.currentVirtualDesktop && workspace.currentVirtualDesktop.name)
            current.name = String(workspace.currentVirtualDesktop.name);
        return current;
    }
    function windowDesktops(window, current) {
        if (window.onAllDesktops) return current ? [current] : [];
        var values = Array.prototype.slice.call(window.desktops || []);
        if (typeof workspace.currentDesktop === "number") {
            values = values.map(function(value) {
                var number = typeof value === "object" ? Number(value.x11DesktopNumber || 0) : Number(value);
                if (number <= 0) return null;
                return {id:"kde-number:" + number, name:typeof value === "object" && value.name ? String(value.name) : "Desktop " + number};
            }).filter(function(value) { return value !== null; });
            if (!values.length && Number(window.desktop) > 0) values = [desktop(Number(window.desktop))];
            return values;
        }
        return values.map(desktop).filter(function(value) { return value !== null; });
    }
    function reply(job, result, error, cancelled) {
        var payload = error ? {error:String(error)} : {result:result};
        if (cancelled) payload.cancelled = true;
        callDBus(WARP_CONTROL.service, "/Control", "com.windowwarp.Control", "Reply", WARP_CONTROL.token,
            String(job.id), JSON.stringify(payload));
    }
    function snapshot(job, located) {
        var outputs = Warp.screens();
        var current = located ? currentDesktop() : null;
        var candidates = Warp.windows().filter(function(w) {
            return !w.deleted && !w.dock && !w.desktopWindow && !w.skipTaskbar &&
                (w.normalWindow || w.dialog) && String(w.caption || "") !== "" &&
                Number(w.pid || 0) !== WARP_CONTROL.ownPid && String(w.desktopFileName) !== "com.windowwarp.desktop";
        });
        var result = [];
        var pending = candidates.length;
        if (!pending) { reply(job, located ? {current:current, windows:[]} : []); return; }
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
                result[index] = item && located ? {window:item, desktops:windowDesktops(w, current)} : item;
                if (--pending === 0) {
                    var windows = result.filter(function(item) { return item !== null; });
                    reply(job, located ? {current:current, windows:windows} : windows);
                }
            });
        });
    }
    function target(command) {
        var found = Warp.windows().filter(function(w) { return !w.deleted && String(w.internalId) === command.window.id && Number(w.pid || 0) === command.window.pid; })[0];
        if (!found) throw new Error("The selected window has closed or changed identity.");
        return found;
    }
    function findDesktop(id) {
        if (typeof workspace.currentDesktop === "number") {
            var match = /^kde-number:(\d+)$/.exec(id);
            var number = match ? Number(match[1]) : 0;
            if (!number || number > workspace.desktops) throw new Error("That desktop is no longer available.");
            return number;
        }
        var found = Array.prototype.slice.call(workspace.desktops || []).filter(function(value) { return String(value.id) === id; })[0];
        if (!found) throw new Error("That desktop is no longer available.");
        return found;
    }
    function execute(job) {
        if (Date.now() > job.expires) { reply(job, null, "Window command expired before it could run."); return; }
        var command = job.command;
        command.deadline = Math.min(job.expires, command.at ? command.at + 1800 : Date.now() + 1800);
        if (command.kind === "snapshot" || command.kind === "desktop-snapshot") { snapshot(job, command.kind === "desktop-snapshot"); return; }
        if (command.kind === "monitors") {
            var monitors = Warp.screens();
            var primary = monitors.filter(function(output) { return output.geometry.x === 0 && output.geometry.y === 0; })[0] || monitors[0];
            reply(job, monitors.map(function(output, index) {
                return {id:String(output.name || output.id || index), geometry:rect(output.geometry), primary:output === primary,
                    stable:"activeWindow" in workspace};
            }));
            return;
        }
        if (command.kind === "desktop-context") { reply(job, currentDesktop()); return; }
        if (command.kind === "switch-desktop") { workspace.currentDesktop = findDesktop(command.desktop); reply(job, true); return; }
        if (command.kind === "focus-editor") {
            var editor = Warp.windows().filter(function(w) {
                return !w.deleted && w.normalWindow && String(w.caption) !== "Window Warp Picker" && Number(w.pid || 0) === WARP_CONTROL.ownPid;
            })[0];
            if (editor) {
                // Follow the user instead of switching back to the desktop
                // where the editor was last visible.
                if (!editor.onAllDesktops) {
                    if (typeof workspace.currentDesktop === "number") editor.desktop = workspace.currentDesktop;
                    else editor.desktops = [workspace.currentDesktop];
                }
                Warp.focus(editor, true);
            }
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
        if (command.kind === "move-desktop") {
            if (!window.onAllDesktops) {
                var destination = findDesktop(command.desktop);
                if (typeof destination === "number") window.desktop = destination;
                else window.desktops = [destination];
            }
            reply(job, true);
            return;
        }
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
