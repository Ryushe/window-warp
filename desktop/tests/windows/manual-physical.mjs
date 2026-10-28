// Manual Windows acceptance fixture. It never observes or records keyboard input.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
import {createServer} from "node:net";
import {createInterface} from "node:readline";
import {spawn} from "node:child_process";

if (process.platform !== "win32") throw new Error("Windows is required");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceSettings = process.env.WARP_MANUAL_SETTINGS_PATH ||
    path.join(process.env.APPDATA, "com.windowwarp.desktop", "settings.json");
const marker = "WARP-NATIVE-" + randomUUID();
const output = path.join(desktop, "src-tauri/target/windows-validation", marker);
const state = path.join(output, "state");
const target = path.join(desktop, "src-tauri/target/hook-e2e");
const binary = path.join(output, "window-warp-fixture.exe");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let cancelled = false, app, socket;
for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => { cancelled = true; });

async function waitFor(read, accept, description, timeout) {
    const deadline = Date.now() + timeout;
    while (!cancelled && Date.now() < deadline) {
        const value = await read();
        if (accept(value)) return value;
        await sleep(100);
    }
    throw new Error(cancelled ? "Cancelled" : `Timed out waiting for ${description}`);
}
async function waitExit(child, timeout) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise(resolve => {
        const done = exited => {
            clearTimeout(timer);
            child.removeListener("exit", onExit);
            resolve(exited);
        };
        const onExit = () => done(true);
        const timer = setTimeout(() => done(false), timeout);
        timer.unref();
        child.once("exit", onExit);
    });
}

// Reuse the native fixture's owned-process tray Quit route only during cleanup.
async function quitCandidate() {
    if (!app || app.exitCode !== null || app.signalCode !== null) return;
    if (socket?.readyState === WebSocket.OPEN) try {
        const id = 100000;
        await Promise.race([
            new Promise(resolve => {
                const onMessage = event => {
                    if (JSON.parse(event.data).id === id) {
                        socket.removeEventListener("message", onMessage);
                        resolve();
                    }
                };
                socket.addEventListener("message", onMessage);
                socket.send(JSON.stringify({id, method:"Runtime.evaluate", params:{
                    expression:"window.__TAURI__.core.invoke('set_enabled',{enabled:false})",
                    awaitPromise:true, returnByValue:true
                }}));
            }), sleep(3000)
        ]);
    } catch { /* Continue with the owned tray and process cleanup. */ }
    const helper = spawn("python", [path.join(desktop,"tests/windows/fixture.py"),
        "--marker",marker,"--app-pid",String(app.pid),"--lifetime","30","--windows","1"],
        {windowsHide:true,stdio:["pipe","pipe","ignore"]});
    let ready = false, quitReply = false;
    const lines = createInterface({input:helper.stdout});
    lines.on("line", line => {
        try {
            const message = JSON.parse(line);
            if (message.ready) { ready = true; helper.stdin.write(JSON.stringify({id:1,command:"tray_menu",action:"quit"})+"\n"); }
            else if (message.id === 1) quitReply = true;
        } catch {}
    });
    try {
        await waitExit(app, 8000);
    } finally {
        helper.stdin.end();
        if (!await waitExit(helper, 2000)) helper.kill();
        if (app.exitCode === null && app.signalCode === null) {
            // Disable was attempted above; terminate only the process we spawned.
            app.kill();
            if (!await waitExit(app, 5000)) throw new Error("Candidate process did not exit");
            console.log("Candidate required process termination during cleanup.");
        } else if (!ready || !quitReply) {
            console.log("Candidate exited before the tray cleanup completed.");
        }
    }
}

try {
    const config = JSON.parse(fs.readFileSync(sourceSettings, "utf8"));
    config.settings ||= {};
    config.settings.enableOnLaunch = true;
    fs.mkdirSync(state, {recursive:true});
    fs.writeFileSync(path.join(state,"settings.json"), JSON.stringify(config, null, 2));
    const server = createServer();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const base = JSON.parse(fs.readFileSync(path.join(desktop,"src-tauri/tauri.conf.json"),"utf8"));
    const override = {identifier:"com.windowwarp.manual."+randomUUID().replaceAll("-",""),app:{
        appDirectoriesOverride:state,
        windows:base.app.windows.map(window=>({...window,
            title:window.label === "main" ? "Window Warp - PHYSICAL TEST" : window.title,
            additionalBrowserArgs:`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`
        }))
    }};
    const env = {...process.env, CARGO_TARGET_DIR:target, CARGO_INCREMENTAL:"0", CARGO_BUILD_JOBS:"1", TAURI_CONFIG:JSON.stringify(override)};
    delete env.WARP_FIXTURE_HOOK_TRACE;
    delete env.WARP_FIXTURE_HOOK_BYPASS;
    const log = fs.openSync(path.join(output,"build.log"),"w");
    const build = spawn(path.join(process.env.USERPROFILE,".cargo/bin/cargo.exe"),
        ["rustc","--manifest-path","src-tauri/Cargo.toml","--offline","--features","tauri/custom-protocol","--","-C","debuginfo=0"],
        {cwd:desktop,env,windowsHide:true,stdio:["ignore",log,log]});
    const built = await waitExit(build,600000);
    fs.closeSync(log);
    if (!built || build.exitCode !== 0 || cancelled) {
        if (!built) build.kill();
        throw new Error("Isolated build did not complete successfully");
    }
    fs.copyFileSync(path.join(target,"debug/window-warp.exe"),binary);
    console.log(`BUILD READY: ${output}`);
    await waitFor(()=>fs.existsSync(path.join(output,"start-test")), Boolean, "start-test signal",180000);
    const appEnv = {...process.env};
    delete appEnv.WARP_FIXTURE_HOOK_TRACE;
    delete appEnv.WARP_FIXTURE_HOOK_BYPASS;
    app = spawn(binary, [], {cwd:output,env:appEnv,windowsHide:true,stdio:"ignore"});
    const page = await waitFor(async()=>{
        if (app.exitCode !== null) throw new Error("Candidate exited during startup");
        try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item=>item.type === "page" && /^https?:\/\/tauri\.localhost\/(?:index.html)?$/.test(item.url)); }
        catch { return null; }
    }, Boolean,"candidate WebView",45000);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
    let id = 0;
    const invokeStatus = () => new Promise((resolve,reject)=>{
        const requestId = ++id;
        const timer = setTimeout(()=>{socket.removeEventListener("message",onMessage);reject(new Error("Candidate status timed out"));},3000);
        const onMessage = event => {
            const message = JSON.parse(event.data);
            if (message.id !== requestId) return;
            clearTimeout(timer);
            socket.removeEventListener("message",onMessage);
            message.error ? reject(new Error("Candidate status unavailable")) : resolve(message.result?.result?.value);
        };
        socket.addEventListener("message",onMessage);
        socket.send(JSON.stringify({id:requestId,method:"Runtime.evaluate",params:{expression:"window.__TAURI__.core.invoke('get_status')",awaitPromise:true,returnByValue:true}}));
    });
    const status = await waitFor(invokeStatus, s=>s && (s.enabled || s.shortcutError), "active shortcuts",30000);
    if (!status.enabled || status.shortcutError || path.resolve(status.settingsPath).toLowerCase() !== path.join(state,"settings.json").toLowerCase()) {
        throw new Error("Candidate did not start with active isolated shortcuts");
    }
    console.log(`READY: ${status.settingsPath} (PID ${app.pid})`);
    await waitFor(()=>{
        if (app.exitCode !== null) throw new Error("Candidate exited during testing");
        return fs.existsSync(path.join(output,"stop-test"));
    }, Boolean,"stop-test signal",300000);
} catch (error) {
    console.error(error instanceof Error ? error.message : "Manual fixture failed");
    process.exitCode = 1;
} finally {
    try { await quitCandidate(); } catch { console.error("Could not confirm candidate cleanup"); process.exitCode = 1; }
    if (socket) socket.close();
    if (!app || app.exitCode !== null || app.signalCode !== null) {
        try { fs.unlinkSync(path.join(state,"settings.json")); } catch (error) { if (error.code !== "ENOENT") console.error("Could not remove isolated settings copy"); }
    }
    console.log("STOPPED");
}
