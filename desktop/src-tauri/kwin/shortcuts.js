/* Registration-only scripts forward captured input to the persistent owner. */
(function () {
    "use strict";
    var modern = "activeWindow" in workspace;
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
                var current = modern ? workspace.activeWindow : workspace.activeClient;
                var target = current && !current.deleted ? {id:String(current.internalId), pid:Number(current.pid || 0)} : null;
                var capturedAt = Date.now();
                if (holdId) {
                    var pointer = workspace.cursorPos;
                    callDBus(WARP_APP.service, "/Control", "com.windowwarp.Control", "GesturePointer", WARP_APP.token, holdId,
                        JSON.stringify({x:Math.round(pointer.x), y:Math.round(pointer.y), previous:target, generation:WARP_APP.generation}));
                } else if (["toggle-pause", "open-editor", "open-workspaces", "update-workspace"].indexOf(binding.action) >= 0) {
                    callDBus(WARP_APP.service, "/Control", "com.windowwarp.Control", "Action", WARP_APP.token, binding.action);
                } else {
                    var forward = function() {
                        callDBus(WARP_APP.service, "/Control", "com.windowwarp.Control", "Shortcut", WARP_APP.token,
                            WARP_APP.generation, JSON.stringify({binding:binding, settings:WARP_CONFIG.settings,
                                window:target, previous:target, at:capturedAt}));
                    };
                    if (binding.shortcut === "Super+X" || binding.shortcut === "Super+C") {
                        callDBus(WARP_APP.service, "/Control", "com.windowwarp.Control", "Retile", WARP_APP.token, binding.shortcut,
                            function(consumed) { if (!consumed) forward(); });
                    } else forward();
                }
            } catch (error) { print("Window Warp shortcut: " + String(error)); }
        })) throw new Error("Could not register " + shortcut);
    });
})();
