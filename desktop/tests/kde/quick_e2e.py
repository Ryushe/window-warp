"""End-to-end popup and discovery checks inside the private KWin fixture."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from wayland_input import Input

binary, driver_binary, output = map(lambda value: str(Path(value).resolve()), sys.argv[1:4])
output = Path(output)
output.mkdir(parents=True, exist_ok=True)
assert os.environ.get("WAYLAND_DISPLAY") == "warp-test"
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
url = f"http://127.0.0.1:{port}"
session = None
checks = []

def request(method, path, value=None):
    data = json.dumps(value).encode() if value is not None else None
    req = urllib.request.Request(url + path, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        result = json.load(response)
    return result.get("value", result)

def evaluate(source):
    return request("POST", f"/session/{session}/execute/sync", {"script": source, "args": []})

def invoke(command, args=None):
    result = request("POST", f"/session/{session}/execute/async", {
        "script": "const done=arguments[arguments.length-1]; window.__TAURI__.core.invoke(arguments[0],arguments[1]).then(result=>done({result}),error=>done({error:String(error)}));",
        "args": [command, args or {}],
    })
    if "error" in result:
        raise RuntimeError(f"{command}: {result['error']}")
    return result["result"]

def wait(read, description, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = read()
        if value:
            return value
        time.sleep(.15)
    raise AssertionError(f"Timed out waiting for {description}")

def switch(handle):
    request("POST", f"/session/{session}/window", {"handle": handle})

def find_quick():
    for handle in request("GET", f"/session/{session}/window/handles"):
        switch(handle)
        if "quick.html" in request("GET", f"/session/{session}/url"):
            return handle
    return None

with tempfile.TemporaryDirectory(prefix="warp-quick-e2e-") as temporary, (output / "quick-gui.log").open("w") as log:
    environment = os.environ.copy()
    environment.update({"TAURI_WEBVIEW_AUTOMATION":"true", "TAURI_AUTOMATION":"true", "GDK_BACKEND":"wayland",
                        "XDG_CONFIG_HOME":temporary + "/config", "XDG_DATA_HOME":temporary + "/data", "XDG_CACHE_HOME":temporary + "/cache"})
    driver = subprocess.Popen([driver_binary, f"--port={port}", "--host=127.0.0.1"], env=environment, stdout=log, stderr=log, start_new_session=True)
    fixture = None
    report = {"passed":False, "checks":checks}
    try:
        def ready():
            try:
                return request("GET", "/status")
            except (OSError, ValueError):
                return None
        wait(ready, "WebKit driver")
        session = request("POST", "/session", {"capabilities":{"alwaysMatch":{"webkitgtk:browserOptions":{"binary":binary,"args":[]}}}})["sessionId"]
        wait(lambda: evaluate("return !!document.querySelector('#toggle') && !document.querySelector('#toggle').disabled"), "editor")
        main = request("GET", f"/session/{session}/window")
        if invoke("get_status")["enabled"]:
            invoke("set_enabled", {"enabled":False})
        config = invoke("get_config")
        config["settings"]["quickModifier"] = "Alt"
        config["bindings"] = [
            {"label":"open editor", "shortcut":"Ctrl+Alt+Shift+F19", "action":"open-editor", "enabled":True},
            {"label":"pause", "shortcut":"Ctrl+Alt+Shift+F18", "action":"toggle-pause", "enabled":True},
            {"label":"push left", "shortcut":"Alt+C", "action":"push-left", "enabled":True},
        ]
        invoke("save_config", {"config":config})
        invoke("set_enabled", {"enabled":True})
        fixture = subprocess.Popen([sys.executable, str(Path(__file__).with_name("live.py")), "--workspace"], env=environment, stdout=log, stderr=log)
        owned = wait(lambda: next((w for w in invoke("get_windows") if w["pid"] == fixture.pid and w["active"]), None), "owned active window")
        subprocess.run(["qdbus", "org.kde.kglobalaccel", "/component/kwin", "org.kde.kglobalaccel.Component.invokeShortcut", "window-warp-open-editor-0-Ctrl-Alt-Shift-F19"], check=True)
        quick = wait(find_quick, "quick popup")
        wait(lambda: evaluate("return document.querySelector('#quick-app')?.textContent"), "popup app name")
        with Input() as keys:
            keys.key(46, True); keys.key(46, False)  # C
            wait(lambda: evaluate("return document.querySelector('#quick-entry').value === 'Alt+C'"), "plain key and default modifier")
            keys.key(28, True); keys.key(28, False)  # Enter
            wait(lambda: evaluate("return !document.querySelector('#quick-conflict').hidden"), "conflict review")
        assert "push left" in evaluate("return document.querySelector('#quick-conflict-summary').textContent")
        evaluate("document.querySelector('#quick-replace').click(); return true")
        switch(main)
        saved = wait(lambda: (value if len((value := invoke('get_config'))['bindings']) == 4 else None), "replacement persisted")
        assert not saved["bindings"][2]["enabled"] and saved["bindings"][3]["shortcut"] == "Alt+C"
        checks.append("native popup plain key, Enter, conflict review and replacement persisted")
        saved["bindings"].append({"label":owned["appId"],"shortcut":"Ctrl+Alt+Shift+F24","action":"focus-app","appMatch":"unrelated-id","enabled":False})
        invoke("save_config", {"config":saved})
        evaluate("location.reload(); return true")
        wait(lambda: evaluate("return document.querySelectorAll('.binding').length === 5"), "editor reload")
        evaluate("document.querySelector('#find-apps').click(); return true")
        wait(lambda: evaluate("return document.querySelector('#find-apps-result').textContent.includes('Review and save')"), "discovery result")
        evaluate("document.querySelector('#save').click(); return true")
        found = wait(lambda: (value if (value := invoke('get_config'))['bindings'][4].get('appMatches') else None), "discovery persistence")
        assert owned["appId"].lower() in [name.lower() for name in found["bindings"][4]["appMatches"]]
        checks.append("real KDE editor discovers and saves an owned open-window identifier")
        report["passed"] = True
    except Exception as error:
        report["error"] = repr(error)
    finally:
        if session:
            try: request("DELETE", f"/session/{session}")
            except Exception: pass
        for process in [fixture, driver]:
            if process and process.poll() is None:
                if process is driver: os.killpg(driver.pid, signal.SIGTERM)
                else: process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
        (output / "quick-result.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
if not report["passed"]:
    sys.exit(1)
