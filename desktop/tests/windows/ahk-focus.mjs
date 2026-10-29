// Opt-in comparison of AHK window activation; this does not install hooks or send keys.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";

if (process.platform !== "win32") throw new Error("This fixture requires Windows");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const marker = "WARP-AHK-" + randomUUID();
const output = path.join(desktop,"src-tauri/target/windows-validation",marker);
fs.mkdirSync(output,{recursive:true});
const interpreter = path.join(process.env.LOCALAPPDATA,"Programs/AutoHotkey/v2/AutoHotkey64.exe");
if (!fs.existsSync(interpreter)) throw new Error("AutoHotkey v2 interpreter is not installed at " + interpreter);
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const children = [];
const report = {passed:false, checks:[], cases:[]};

async function until(read, predicate, description, timeout=10000) {
    const deadline = Date.now()+timeout;
    let value;
    while (Date.now()<deadline) {
        value = await read();
        if (predicate(value)) return value;
        await sleep(50);
    }
    throw new Error(`Timed out: ${description}; last observed: ${JSON.stringify(value)}`);
}
function startHelper(name,count) {
    const child = spawn("python",[path.join(desktop,"tests/windows/fixture.py"),"--marker",marker+name,"--windows",String(count)],
        {windowsHide:true,stdio:["pipe","pipe","pipe"]});
    children.push(child);
    let ready, stderr="", id=0;
    const pending = new Map();
    child.stderr.on("data", chunk=>{stderr+=chunk.toString();});
    createInterface({input:child.stdout}).on("line",line=>{
        const message = JSON.parse(line);
        if (message.ready) {ready=message;return;}
        const request=pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);clearTimeout(request.timer);
        message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
    });
    const command = (name,args={}) => new Promise((resolve,reject)=>{
        const requestId=++id;
        const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(`Fixture command timed out: ${name}`));},10000);
        pending.set(requestId,{resolve,reject,timer});
        child.stdin.write(JSON.stringify({id:requestId,command:name,...args})+"\n");
    });
    return {child,command,ready:()=>{
        if (child.exitCode !== null) throw new Error(`Fixture exited: ${stderr}`);
        return ready;
    }};
}
async function runInterpreter(script,args) {
    const child=spawn(interpreter,["/ErrorStdOut",script,...args.map(String)],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    children.push(child);
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>{stdout+=chunk.toString();});
    child.stderr.on("data",chunk=>{stderr+=chunk.toString();});
    const code=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{child.kill();reject(new Error("AHK activation process timed out"));},30000);
        child.once("error",error=>{clearTimeout(timer);reject(error);});
        child.once("close",code=>{clearTimeout(timer);resolve(code);});
    });
    return {code,stdout,stderr};
}

const script = path.join(output,"focus-comparison.ahk");
fs.writeFileSync(script,[
    "#Requires AutoHotkey v2.0",
    "#NoTrayIcon",
    "#SingleInstance Off",
    "if A_Args.Length != 5",
    "    ExitApp(2)",
    "if A_Args[1] = 'no-delay'",
    "    SetWinDelay(-1)",
    "targets := [{hwnd: Integer(A_Args[2]), pid: Integer(A_Args[3])}, {hwnd: Integer(A_Args[4]), pid: Integer(A_Args[5])}]",
    "Clock() {",
    "    counter := 0",
    "    static frequency := 0",
    "    if !frequency",
    "        DllCall('QueryPerformanceFrequency', 'Int64*', &frequency)",
    "    DllCall('QueryPerformanceCounter', 'Int64*', &counter)",
    "    return counter * 1000.0 / frequency",
    "}",
    "try {",
    "    Loop 8 {",
    "        target := targets[Mod(A_Index - 1, 2) + 1]",
    "        selector := Format('ahk_id 0x{:X}', target.hwnd)",
    "        actualPid := 0",
    "        exists := DllCall('IsWindow', 'Ptr', target.hwnd, 'Int')",
    "        visible := DllCall('IsWindowVisible', 'Ptr', target.hwnd, 'Int')",
    "        DllCall('GetWindowThreadProcessId', 'Ptr', target.hwnd, 'UInt*', &actualPid, 'UInt')",
    "        matched := WinExist(selector)",
    "        if !exists || actualPid != target.pid || !visible || !matched",
    "            throw Error(Format('Target check failed: selector={1}, expectedPid={2}, actualPid={3}, exists={4}, visible={5}, ahkMatch={6}', selector, target.pid, actualPid, exists, visible, matched))",
    "        matchedPid := WinGetPID(selector)",
    "        if matchedPid != target.pid",
    "            throw Error(Format('AHK target PID mismatch: selector={1}, expectedPid={2}, matchedPid={3}', selector, target.pid, matchedPid))",
    "        started := Clock()",
    "        WinActivate(selector)",
    "        active := WinWaitActive(selector, , 0.5)",
    "        finished := Clock()",
    "        FileAppend(Format('{1},{2:.6f},{3:.6f},{4}`n', target.hwnd, started, finished, active ? 1 : 0), '*')",
    "        if !active",
    "            throw Error('Target did not become foreground')",
    "    }",
    "} catch as err {",
    "    FileAppend('ERROR: ' err.Message '`n', '*')",
    "    ExitApp(1)",
    "}",
    "ExitApp(0)",
    ""
].join("\r\n"));

try {
    const local = startHelper("-local",2), peer = startHelper("-peer",1);
    const own = await until(local.ready,Boolean,"local owned windows");
    const other = await until(peer.ready,Boolean,"peer process owned window");
    assert.notEqual(own.pid,other.pid,"targets must belong to distinct processes");
    const expected = Array.from({length:4},()=>[own.windows[0],other.windows[0]]).flat();
    for (const mode of ["default","no-delay"]) {
        // Startup may hide an initial window. Bring both owned targets into
        // view before restoring the common source-foreground starting point.
        await local.command("focus",{window:own.windows[0]});
        await peer.command("focus",{window:other.windows[0]});
        await local.command("focus",{window:own.windows[1]});
        await local.command("activation_events");
        await peer.command("activation_events");
        const result = await runInterpreter(script,[mode,own.windows[0],own.pid,other.windows[0],other.pid]);
        const [localEvents,peerEvents] = await Promise.all([local.command("timed_activation_events"),peer.command("timed_activation_events")]);
        const events=[...localEvents,...peerEvents].sort((a,b)=>a[1]-b[1]);
        // Callback timestamps from separate message loops can arrive out of
        // foreground order. Preserve raw events and report consecutive
        // same-HWND notifications without treating them as proof of order.
        const transitions=[], duplicates=[];
        for (const event of events) {
            if (transitions.at(-1)?.[0] === event[0]) duplicates.push(event);
            else transitions.push(event);
        }
        const calls=result.stdout.trim().split(/\r?\n/).filter(line=>/^\d+,/.test(line)).map(line=>line.split(",").map(Number));
        const callbackOrderConsistent = transitions.length === expected.length && transitions.every(([hwnd],index)=>hwnd === expected[index]);
        const recorded={mode,processExit:result.code,stdout:result.stdout,stderr:result.stderr,source:own.windows[1],
            targetA:{window:own.windows[0],pid:own.pid},targetB:{window:other.windows[0],pid:other.pid},expected,events,transitions,duplicates,calls,
            callbackOrderEvidence:callbackOrderConsistent ? "consistent but asynchronous" : "ambiguous",
            callDurationMs:calls.map(([,started,finished])=>finished-started)};
        report.cases.push(recorded);
        assert.equal(result.code,0,`AHK ${mode} activation process failed: ${result.stderr || result.stdout}`);
        assert.equal(calls.length,expected.length,`AHK ${mode} should report each activation request`);
        assert.deepEqual(calls.map(([hwnd])=>hwnd),expected,`AHK ${mode} should request every target in order`);
        assert.ok(calls.every(call=>call.length===4 && call.every(Number.isFinite) && call[2]>=call[1] && call[3]===1),
            `AHK ${mode} should observe every requested target foreground`);
        report.checks.push(`AHK ${mode} requests and confirms alternating fixture-owned targets`);
    }
    report.passed=true;
} catch (error) {
    report.error=String(error.stack || error);
} finally {
    for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        if (child.stdin) child.stdin.end();
        await Promise.race([new Promise(resolve=>child.once("exit",resolve)),sleep(3000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    fs.writeFileSync(path.join(output,"result.json"),JSON.stringify(report,null,2));
    console.log(JSON.stringify({...report,output},null,2));
}
if (!report.passed) process.exitCode=1;
