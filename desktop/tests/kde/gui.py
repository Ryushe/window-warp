"""Exercise the real Tauri editor through WebKitGTK's native WebDriver."""
import base64
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

binary = str(Path(sys.argv[1]).resolve())
driver_binary = str(Path(sys.argv[2]).resolve())
output = Path(sys.argv[3]).resolve()
output.mkdir(parents=True, exist_ok=True)
session = None


def kwin_loaded(name="window-warp-session"):
    return subprocess.check_output(["qdbus", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.isScriptLoaded", name], text=True).strip() == "true"


if kwin_loaded() or kwin_loaded("window-warp-control-session") or subprocess.run(["pgrep", "-x", "window-warp"], stdout=subprocess.DEVNULL).returncode == 0:
    raise RuntimeError("Window Warp is already active; refusing to interfere with it")

with socket.socket() as reserved:
    reserved.bind(("127.0.0.1", 0))
    port = reserved.getsockname()[1]
url = f"http://127.0.0.1:{port}"


def request(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
    return result.get("value", result)


def evaluate(source):
    return request("POST", f"/session/{session}/execute/sync", {"script": source, "args": []})


def invoke(command, args=None):
    value = request("POST", f"/session/{session}/execute/async", {
        "script": "const done=arguments[arguments.length-1]; window.__TAURI__.core.invoke(arguments[0],arguments[1]).then(result=>done({result}),error=>done({error:String(error)}));",
        "args": [command, args or {}],
    })
    if "error" in value:
        raise RuntimeError(f"{command}: {value['error']}")
    return value["result"]


def wait_for(source, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if evaluate(source):
            return
        time.sleep(0.2)
    raise AssertionError(f"Timed out: {source}; page: {evaluate('return document.body.innerText')}")


def click(selector):
    element = request("POST", f"/session/{session}/element", {"using": "css selector", "value": selector})
    element_id = element["element-6066-11e4-a52e-4f735466cecf"]
    request("POST", f"/session/{session}/element/{element_id}/click", {})


with tempfile.TemporaryDirectory(prefix="window-warp-gui-") as temporary, (output / "gui.log").open("w") as log:
    environment = os.environ.copy()
    environment.update({"TAURI_WEBVIEW_AUTOMATION": "true", "TAURI_AUTOMATION": "true", "GDK_BACKEND": "wayland", "XDG_CONFIG_HOME": temporary + "/config", "XDG_DATA_HOME": temporary + "/data", "XDG_CACHE_HOME": temporary + "/cache"})
    driver = subprocess.Popen([driver_binary, f"--port={port}", "--host=127.0.0.1"], env=environment, stdout=log, stderr=log, start_new_session=True)
    fixture = None
    launched_pids = set()
    try:
        for _ in range(50):
            try:
                request("GET", "/status")
                break
            except (OSError, RuntimeError):
                time.sleep(0.1)
        created = request("POST", "/session", {"capabilities": {"alwaysMatch": {"webkitgtk:browserOptions": {"binary": binary, "args": []}}}})
        session = created["sessionId"]
        wait_for("return document.querySelectorAll('.binding').length === 5 && !document.querySelector('#toggle').disabled")
        # Exercise the actual input listeners, save command, native registration,
        # and pause command. Test-only settings are isolated from user settings.
        evaluate("document.querySelectorAll('[data-field=shortcut]').forEach((input,i) => {input.value='Ctrl+Alt+Shift+F'+(13+i); input.dispatchEvent(new Event('input', {bubbles:true}));}); return true;")
        click("#save")
        wait_for("return document.querySelector('#message').textContent.startsWith('Saved.')")
        click("#toggle")
        wait_for("return document.querySelector('#status').classList.contains('active')")
        assert kwin_loaded(), "App reported active but no KWin script was loaded"
        evaluate("window.scrollTo(0, 0); return true;")
        screenshot = request("GET", f"/session/{session}/screenshot")
        (output / "window-warp-kde.png").write_bytes(base64.b64decode(screenshot))
        click("#toggle")
        wait_for("return document.querySelector('#status').textContent.includes('Paused')")
        assert not kwin_loaded(), "Pause did not unload the KWin script"
        settings = list(Path(temporary).glob("config/**/settings.json"))
        assert len(settings) == 1
        assert json.loads(settings[0].read_text())["bindings"][0]["shortcut"] == "Ctrl+Alt+Shift+F13"
        assert not invoke("get_startup")
        assert invoke("set_startup", {"enabled": True})
        entry = Path(temporary) / "config/autostart/com.windowwarp.desktop.desktop"
        assert "--startup" in entry.read_text()
        assert not invoke("set_startup", {"enabled": False})
        assert not entry.exists()

        # The native bridge may see other apps, but only our PID can enter the
        # test store or be restored. Never save/log unrelated window metadata.
        fixture_env = environment | {"QT_QPA_PLATFORM": "wayland"}
        fixture_script = str(Path(__file__).with_name("live.py").resolve())
        fixture = subprocess.Popen([sys.executable, fixture_script, "--workspace"], env=fixture_env, stdout=log, stderr=log)
        captured = None
        for _ in range(30):
            captured = invoke("capture_workspace", {"name": "Owned fixture"})["profile"]
            captured["items"] = [item for item in captured["items"] if item["window"]["pid"] == fixture.pid]
            if len(captured["items"]) == 2:
                break
            time.sleep(0.2)
        assert len(captured["items"]) == 2, "Native capture did not find both Qt fixtures"
        expected = {}
        for index, item in enumerate(captured["items"]):
            window = item["window"]
            area = window["workArea"]
            window.update({"rect": {"x": area["x"] + 60 + 100 * index, "y": area["y"] + 60 + 100 * index, "width": 550, "height": 360}, "maximizedHorizontal": False, "maximizedVertical": False, "fullscreen": False, "minimized": False})
            expected[window["id"]] = window["rect"]
        store = {"version": 1, "profiles": [captured]}
        assert invoke("save_workspaces", {"store": store}) == store
        assert invoke("get_workspaces") == store
        result = invoke("restore_workspace", {"id": captured["id"]})
        assert len(result) == 2 and all(item["restored"] and not item["launched"] for item in result), result
        for _ in range(30):
            current = [w for w in invoke("get_windows") if w["pid"] == fixture.pid]
            if len(current) == 2 and all(w["rect"] == expected[w["id"]] for w in current):
                break
            time.sleep(0.1)
        assert len(current) == 2 and all(w["rect"] == expected[w["id"]] for w in current), "Compositor did not apply separate saved placements"

        # Force a fresh process/window even while matching fixtures are open.
        # The program/arguments go through the real launch path, without a shell.
        new_item = json.loads(json.dumps(captured["items"][0]))
        new_item["window"]["title"] = "WARP-TEST-C"
        new_item["launch"] = {"program": sys.executable, "args": [fixture_script, "--workspace-single"], "newWindow": True, "workingDirectory": ""}
        launched = dict(captured, id="fixture-launch", name="Launch fixture", items=[new_item])
        invoke("save_workspaces", {"store": {"version": 1, "profiles": [captured, launched]}})
        before = {w["id"] for w in invoke("get_windows")}
        result = invoke("restore_workspace", {"id": launched["id"]})
        for w in invoke("get_windows"):
            if w["id"] not in before and w["appId"] == new_item["window"]["appId"]:
                command_line = Path(f"/proc/{w['pid']}/cmdline").read_bytes().split(b"\0")
                if fixture_script.encode() in command_line and b"--workspace-single" in command_line:
                    launched_pids.add(w["pid"])
        assert len(result) == 1 and result[0]["restored"] and result[0]["launched"], result
        assert len(launched_pids) == 1, "Restore did not create a separate owned process"
        current = [w for w in invoke("get_windows") if w["pid"] == fixture.pid]
        assert all(w["rect"] == expected[w["id"]] for w in current), "New-window restore reused an existing fixture"

        # Verify metadata and restoration for all compositor state variants.
        state_item = json.loads(json.dumps(captured["items"][0]))
        for horizontal, vertical, fullscreen in [(True, False, False), (True, True, False), (False, False, True), (False, False, False)]:
            state_item["window"].update({"maximizedHorizontal": horizontal, "maximizedVertical": vertical, "fullscreen": fullscreen})
            state_profile = dict(captured, id="fixture-state", items=[state_item])
            invoke("save_workspaces", {"store": {"version": 1, "profiles": [state_profile]}})
            result = invoke("restore_workspace", {"id": state_profile["id"]})
            assert result[0]["restored"], result
            desired = (horizontal, vertical, fullscreen)
            actual = None
            for _ in range(30):
                current = [w for w in invoke("get_windows") if w["id"] == state_item["window"]["id"]]
                actual = tuple(current[0][field] for field in ["maximizedHorizontal", "maximizedVertical", "fullscreen"])
                if actual == desired:
                    break
                time.sleep(0.1)
            assert actual == desired, f"Saved compositor state {desired} became {actual}"
        invoke("save_workspaces", {"store": {"version": 1, "profiles": [captured, launched]}})
        click("#show-workspaces")
        wait_for("return document.querySelectorAll('#workspace-list article').length === 2")
        assert "Owned fixture" in evaluate("return document.querySelector('#workspace-list').innerText")
        screenshot = request("GET", f"/session/{session}/screenshot")
        (output / "window-warp-workspaces-kde.png").write_bytes(base64.b64decode(screenshot))
        report = {"passed": True, "checks": ["native editor renders", "save persists settings", "enable loads KWin script", "pause unloads KWin script", "startup creates and removes isolated autostart entry", "native workspace capture", "workspace persistence", "native workspace reuse and separate placements", "workspace launch creates a new window without consuming existing ones", "per-axis maximization and fullscreen workspace restoration", "workspace browser renders saved profiles"], "screenshot": str(output / "window-warp-workspaces-kde.png")}
        (output / "gui-result.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2), flush=True)
    finally:
        for pid in launched_pids:
            try:
                command_line = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
                if fixture_script.encode() in command_line and b"--workspace-single" in command_line:
                    os.kill(pid, signal.SIGTERM)
            except (FileNotFoundError, ProcessLookupError):
                pass
        if session:
            try:
                request("DELETE", f"/session/{session}")
            except Exception:
                pass
        if fixture:
            fixture.terminate()
            fixture.wait(timeout=10)
        for name in ["window-warp-session", "window-warp-control-session"]:
            if kwin_loaded(name):
                subprocess.run(["qdbus", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", name], check=True)
        # Kill only the process group created by this test's driver.
        try:
            os.killpg(driver.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        driver.wait(timeout=10)
