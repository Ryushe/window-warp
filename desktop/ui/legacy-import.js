/* Read-only conversion of the original AutoHotkey INIs into review drafts. */
(() => {
    const shared = {
        "wm.move-left":"push-left", "wm.move-right":"push-right", "wm.pull-recent":"pull",
        "wm.move-left-center":"push-left-center", "wm.move-right-center":"push-right-center",
        "wm.open-builder":"open-editor", "wm.open-opener":"open-workspaces",
        "wm.update-workspace":"update-workspace", "wm.toggle-suspend":"toggle-pause",
        "fullscreen.toggle":"toggle-maximize", "kill.close-active":"close-window"
    };
    function decode(buffer) {
        const bytes = new Uint8Array(buffer);
        if (bytes.length > 16 * 1024 * 1024) throw new Error("Choose an INI file smaller than 16 MiB.");
        if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder("utf-16le", {fatal:true}).decode(bytes);
        if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder("utf-16be", {fatal:true}).decode(bytes);
        try { return new TextDecoder("utf-8", {fatal:true}).decode(bytes); }
        catch { return new TextDecoder("windows-1252").decode(bytes); }
    }
    function ini(text) {
        const sections = new Map();
        let current;
        for (const [index, source] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
            const line = source.trim();
            if (!line || line.startsWith(";")) continue;
            const header = /^\[([^\]]+)\]$/.exec(line);
            if (header) {
                const name = header[1].toLowerCase();
                if (sections.has(name)) throw new Error(`Repeated section ${header[1]} on line ${index + 1}.`);
                current = new Map(); sections.set(name, current); continue;
            }
            const equal = line.indexOf("=");
            if (!current || equal < 1) throw new Error(`Expected an INI key on line ${index + 1}.`);
            const key = line.slice(0, equal).trim().toLowerCase();
            if (current.has(key)) throw new Error(`Repeated key ${key} on line ${index + 1}.`);
            let value = line.slice(equal + 1).trim();
            if (value.length >= 2 && ['"', "'"].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1, -1);
            current.set(key, value);
        }
        return sections;
    }
    function shortcut(value) {
        const mods = [];
        const names = {"#":"Super", "^":"Ctrl", "!":"Alt", "+":"Shift"};
        let index = 0;
        while (names[value[index]]) {
            const name = names[value[index++]];
            if (mods.includes(name)) throw new Error("Repeated shortcut modifier.");
            mods.push(name);
        }
        const key = value.slice(index);
        if (!mods.length || !key || !/^(?:[a-z0-9;,.'`/\\=\[\]-]|F(?:[1-9]|1\d|2[0-4])|Left|Right|Up|Down|Space|Tab|Enter|Return|Esc|Escape|Backspace|Delete|Del|Insert|Ins|Home|End|PgUp|PgDn|PageUp|PageDown)$/i.test(key)) {
            throw new Error(`Shortcut “${value}” needs manual conversion; side-specific, pass-through, wildcard and custom AHK combinations are not supported.`);
        }
        const aliases = {pgup:"PageUp", pgdn:"PageDown", del:"Delete", ins:"Insert"};
        return ["Ctrl", "Alt", "Shift", "Super"].filter(m => mods.includes(m)).concat(aliases[key.toLowerCase()] || key).join("+");
    }
    function integer(value, field, min, max) {
        if (!/^-?\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${field}: ${value || "missing"}.`);
        return Number(value);
    }
    function preview(text, {name = "INI", platform = "windows", monitors = [], uuid = () => crypto.randomUUID()} = {}) {
        const sections = ini(text);
        const entries = [];
        const section = key => sections.get(key.toLowerCase());
        const read = (s, key, fallback = "") => s?.get(key.toLowerCase()) ?? fallback;
        const raw = s => [...(s || [])].map(([k,v]) => `${k}=${v}`).join("\n");
        const add = (kind, label, source, convert) => {
            const entry = {kind, label, source:`${name} · ${source}`, raw:raw(section(source)), notes:[], problems:[], value:null};
            if (kind === "workspace") for (const [key, value] of sections) {
                if (key.startsWith(source + "item")) entry.raw += `\n[${key}]\n${raw(value)}`;
            }
            try { entry.value = convert(entry); } catch (error) { entry.problems.push(String(error.message || error)); }
            entries.push(entry);
        };
        const appSections = [...sections.keys()].filter(s => /^app\d+$/.test(s));
        const hotkeySections = [...sections.keys()].filter(s => /^hotkey\d+$/.test(s));
        const profileSections = [...sections.keys()].filter(s => /^profile\d+$/.test(s));
        const families = [appSections, hotkeySections, profileSections].filter(a => a.length);
        if (families.length > 1) throw new Error("This file mixes app, shared shortcut and workspace sections. Choose the original separate INI files.");
        if (families.length) {
            const count = integer(read(section("meta"), "count"), "Meta count", 0, 100);
            const prefix = appSections.length ? "app" : hotkeySections.length ? "hotkey" : "profile";
            const expected = Array.from({length:count}, (_,i) => prefix + (i + 1));
            if (families[0].length !== count || expected.some(s => !section(s))) throw new Error("Meta count does not match the numbered sections. Repair the file before importing.");
            for (const source of expected) {
                const s = section(source);
                if (prefix === "profile") {
                    add("workspace", read(s,"name",source), source, entry => {
                        const count = integer(read(s,"itemCount"), "workspace item count", 1, 100);
                        const items = [];
                        for (let i = 1; i <= count; i++) {
                            const itemSection = `${source}item${i}`;
                            const item = section(itemSection);
                            if (!item) throw new Error(`Missing ${itemSection}.`);
                            items.push(workspaceItem(item, read, monitors, entry.notes));
                        }
                        if (platform !== "windows") entry.notes.push("This remains a Windows workspace. Adapt its platform, app identifiers, launch commands and terminal/browser paths before using it on Linux.");
                        return {id:uuid(), name:read(s,"name",source), platform:"windows", items};
                    });
                } else {
                    add("binding", read(s, prefix === "app" ? "label" : "action", source), source, entry => {
                        const hotkey = read(s,"hotkey");
                        const key = shortcut(hotkey || read(s,"disabledHotkey"));
                        const match = read(s,"match");
                        let appMatch = "", action;
                        if (prefix === "app") {
                            const exe = /^ahk_exe\s+(.+)$/i.exec(match);
                            if (!exe || /\bahk_(?:exe|class|pid|id|group)\b/i.test(exe[1])) throw new Error(`App match “${match}” needs manual conversion to an executable or KDE app identifier.`);
                            appMatch = exe[1]; action = "pull-app";
                            if (platform !== "windows") entry.notes.push(`Disabled for Linux review: replace Windows executable “${appMatch}” with the KDE resource class or desktop ID, then enable it.`);
                        } else {
                            const id = read(s,"id").toLowerCase();
                            action = Object.hasOwn(shared, id) ? shared[id] : null;
                            if (!action) throw new Error(`Shared action “${read(s,"id") || read(s,"action")}” is not supported yet. Its original settings are retained here for manual review.`);
                        }
                        return {label:entry.label, shortcut:key, action, appMatch,
                            enabled:Boolean(hotkey) && (prefix !== "app" || platform === "windows"),
                            mainMonitorAction:read(s,"mainMonitorAction") || "burner", burnerLayout:read(s,"burnerLayout") || "float"};
                    });
                }
            }
        }
        if (section("settings")) {
            add("settings", "Hold settings", "settings", entry => {
                const s = section("settings"), settings = {};
                if (s.has("holddelayms")) {
                    const delay = integer(read(s,"holdDelayMs"), "hold delay", -2147483648, 2147483647);
                    settings.holdDelayMs = Math.max(100, Math.min(5000, delay));
                    if (delay !== settings.holdDelayMs) entry.notes.push(`Hold delay clamped to ${settings.holdDelayMs} ms, as in the original app.`);
                }
                if (s.has("holdtileenabled")) settings.holdTileEnabled = integer(read(s,"holdTileEnabled"), "hold enabled", -2147483648, 2147483647) !== 0;
                if (s.has("holdmode")) {
                    settings.holdMode = read(s,"holdMode").toLowerCase() === "radial" ? "radial" : "tile";
                    if (!["radial","tile"].includes(read(s,"holdMode").toLowerCase())) entry.notes.push("Unknown hold mode uses mouse tiling, as in the original app.");
                }
                if (!Object.keys(settings).length) throw new Error("No recognized hold settings in this section.");
                return settings;
            });
        }
        if (!entries.length) throw new Error("No app shortcuts, shared hotkeys, hold settings or workspaces found in this file.");
        return entries;
    }
    function workspaceItem(s, read, monitors, notes) {
        const get = (key, fallback) => read(s,key,fallback);
        const appId = get("processName");
        if (!appId) throw new Error("A workspace window is missing processName.");
        const monitor = integer(get("monitorIndex","1"), "monitor index", 1, 100);
        const rect = {x:integer(get("x"),"x",-100000,100000), y:integer(get("y"),"y",-100000,100000), width:integer(get("w"),"width",1,100000), height:integer(get("h"),"height",1,100000)};
        const area = monitors[monitor - 1] || monitors[0];
        if (!area) throw new Error("No monitor work area is available. Open the app in a desktop session and select the file again.");
        const state = integer(get("state","0"),"window state",-1,1);
        const note = `The INI has no source work area. Review the imported coordinates and monitor ${monitor}; its reference area uses ${monitors[monitor-1] ? "the current display" : "the first current display because the saved monitor is absent"}.`;
        const item = {label:get("label") || get("title") || appId,
            window:{id:"",pid:0,title:get("title"),appId,desktopId:"",path:get("path"),rect,workArea:{...area},monitor,monitorName:"",maximizedHorizontal:state===1,maximizedVertical:state===1,fullscreen:false,minimized:state===-1,active:false},
            launch:{kind:"executable",program:get("path"),args:[],workingDirectory:"",newWindow:false},captureNote:note};
        if (!notes.includes("Review window placement: old INIs omit the original monitor work areas.")) notes.push("Review window placement: old INIs omit the original monitor work areas.");
        if (/windowsterminal\.exe$/i.test(appId) || get("launchKind") === "windows-terminal") {
            let kind = (get("shellKind") || get("terminalShell")).toLowerCase().replace(/\.exe$/, "");
            let distro = get("wslDistro");
            const legacy = get("terminalCommand");
            const wsl = /wsl\.exe\s+-d\s+"([^"]+)"/i.exec(legacy);
            if (wsl) { kind="wsl"; distro=wsl[1]; }
            else if (/^wsl\.exe$/i.test(legacy.trim())) kind="wsl";
            else if (/powershell\.exe/i.test(legacy)) kind="powershell";
            else if (/pwsh\.exe/i.test(legacy)) kind="pwsh";
            else if (/cmd\.exe/i.test(legacy)) kind="cmd";
            let profileName = get("profileName");
            if (!kind) {
                const title = get("title").trim();
                const shells = {"windows powershell":"powershell", "administrator: windows powershell":"powershell", "powershell":"pwsh", "powershell 7":"pwsh", "pwsh":"pwsh", "command prompt":"cmd", "cmd":"cmd", "cmd.exe":"cmd"};
                kind = Object.hasOwn(shells,title.toLowerCase()) ? shells[title.toLowerCase()] : "";
                const distribution = /^(Ubuntu|Debian|Kali|Arch|openSUSE|Fedora|Alpine)(?:[\s-].*)?$/i.exec(title);
                if (distribution) { kind="wsl"; distro ||= distribution[1]; profileName ||= title; }
                if (!kind && /^[^@]+@[^:]+:.*$/.test(title)) {
                    kind="wsl";
                    item.captureNote += ` Review the WSL distribution for prompt “${get("promptIdentity") || title}”; it cannot be resolved from the INI alone.`;
                }
            }
            if (legacy) item.captureNote += " Legacy terminal commands are converted to a fresh shell; commands inside the shell are not replayed. Original: " + legacy;
            const shell = {wsl:"wsl.exe",powershell:"powershell.exe",pwsh:"pwsh.exe",cmd:"cmd.exe"}[kind] || "";
            if (!shell) item.captureNote += ` Choose the shell/profile manually. Legacy shell: ${kind || "unspecified"}; prompt: ${get("promptIdentity") || "unspecified"}.`;
            item.terminal = {kind:"windows-terminal",profileName,profilePath:"",shell,shellArgs:[],wslDistro:shell==="wsl.exe"?distro:"",wslUser:"",workingDirectory:""};
            if (distro && shell !== "wsl.exe") item.captureNote += " Review saved WSL distribution: " + distro;
            item.launch.program="wt.exe";
        } else if (/firefox\.exe$/i.test(appId) || get("browserKind") === "firefox") {
            const count = integer(get("browserUrlCount","0"),"browser URL count",0,1000);
            const tabs = Array.from({length:count},(_,i)=>({url:get("browserUrl"+(i+1)),title:""}));
            if (count || get("browserProfilePath") || get("browserProfileName")) item.browser = {profilePath:get("browserProfilePath"),profileName:get("browserProfileName"),tabs,activeTab:Math.max(1,integer(get("browserActiveTab","1"),"active tab",0,1000))};
        }
        if (!item.terminal && !item.browser && (get("launchKind") === "packaged-app" || /\\WindowsApps\\/i.test(get("path")))) {
            item.launch.kind = "packaged-app";
            item.launch.program = "";
            item.captureNote += " The INI did not save an activation ID. Windows will try its registered package family during review; unresolved entries need recapture or an AUMID. The original executable path is preserved above.";
        }
        return item;
    }
    window.WindowWarpImport = {decode, preview, shortcut};
})();
