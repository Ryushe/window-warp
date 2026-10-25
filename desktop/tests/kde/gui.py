"""Exercise the real Tauri editor through WebKitGTK's native WebDriver."""
import base64
import json
import os
import re
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
if any(flag in sys.argv for flag in ["--resume-held", "--reassign-native"]) and "--hold" not in sys.argv:
    raise ValueError("Native gesture edge checks require --hold and the private compositor")


def kwin_loaded(name="window-warp-session"):
    return subprocess.check_output(["qdbus", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.isScriptLoaded", name], text=True).strip() == "true"


if any(kwin_loaded(name) for name in ["window-warp-session", "window-warp-pause-session", "window-warp-control-session"]) or subprocess.run(["pgrep", "-x", "window-warp"], stdout=subprocess.DEVNULL).returncode == 0:
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


def invoke_shortcut(action):
    bindings = invoke("get_config")["bindings"]
    bindings = [b for b in bindings if (b["action"] == "toggle-pause") == (action == "toggle-pause")]
    if action == "toggle-pause":
        bindings = [b for b in bindings if b["enabled"]]
    index, binding = next((i, b) for i, b in enumerate(bindings) if b["action"] == action and b["enabled"])
    key = binding["shortcut"].replace("Super", "Meta")
    identifier = f"window-warp-{action}-{index}-" + re.sub("[^a-z0-9]", "-", key, flags=re.I)
    subprocess.run(["qdbus", "org.kde.kglobalaccel", "/component/kwin", "org.kde.kglobalaccel.Component.invokeShortcut", identifier], check=True)


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
    hold_fixture = None
    key_monitor = None
    browser_fixture = None
    other_browser_fixture = None
    terminal_fixture = None
    terminal_launched = []
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
        wait_for("return document.querySelectorAll('.binding').length === 9 && !document.querySelector('#toggle').disabled")
        # Exercise the actual input listeners, save command, native registration,
        # and pause command. Test-only settings are isolated from user settings.
        evaluate("document.querySelectorAll('[data-field=shortcut]').forEach((input,i) => {input.value='Ctrl+Alt+Shift+F'+(13+i); input.dispatchEvent(new Event('input', {bubbles:true}));}); return true;")
        click("#save")
        wait_for("return document.querySelector('#message').textContent.startsWith('Saved.')")
        assert kwin_loaded("window-warp-pause-session"), "Pause hook must be installed while paused"
        invoke_shortcut("toggle-pause")
        wait_for("return document.querySelector('#status').classList.contains('active')")
        invoke_shortcut("toggle-pause")
        wait_for("return document.querySelector('#status').textContent.includes('Paused')")
        assert kwin_loaded("window-warp-pause-session") and not kwin_loaded()
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
        # A conflicting key is reviewed in the UI, then saved explicitly.
        evaluate("const input=document.querySelectorAll('[data-field=shortcut]')[1]; input.value='shift+alt+control+F13'; input.dispatchEvent(new Event('input',{bubbles:true})); return true;")
        click(".binding:nth-child(2) .reassign")
        wait_for("return !document.querySelector('.binding:nth-child(2) .reassignment').hidden && !document.querySelector('.binding:nth-child(2) .confirm-reassignment').disabled")
        assert "Push window left" in evaluate("return document.querySelector('.binding:nth-child(2) .reassignment-summary').textContent")
        assert invoke("get_config")["bindings"][0]["enabled"]
        evaluate("document.querySelector('.binding:nth-child(2)').scrollIntoView({block:'center'}); return true;")
        screenshot = request("GET", f"/session/{session}/screenshot")
        (output / "window-warp-reassignment-kde.png").write_bytes(base64.b64decode(screenshot))
        click(".binding:nth-child(2) .cancel-reassignment")
        assert evaluate("return document.querySelector('[data-field=enabled]').checked")
        click(".binding:nth-child(2) .reassign")
        wait_for("return !document.querySelector('.binding:nth-child(2) .confirm-reassignment').disabled")
        click(".binding:nth-child(2) .confirm-reassignment")
        assert not evaluate("return document.querySelector('[data-field=enabled]').checked")
        assert invoke("get_config")["bindings"][0]["enabled"], "Review must not auto-save"
        click("#save")
        wait_for("return document.querySelector('#message').textContent.startsWith('Saved.')")
        reassigned = invoke("get_config")["bindings"]
        assert not reassigned[0]["enabled"] and reassigned[1]["enabled"]
        assert reassigned[0]["shortcut"] == reassigned[1]["shortcut"] == "Ctrl+Alt+Shift+F13"
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
        assert any(item["window"]["active"] for item in captured["items"]), "Owned fixture must be active for editor capture"
        invoke("set_enabled", {"enabled": True})
        invoke_shortcut("open-editor")
        wait_for("return document.querySelectorAll('.binding').length === 10 && document.querySelector('#status').textContent.includes('Paused')")
        expected_app = next(item["window"]["appId"] for item in captured["items"] if item["window"]["active"])
        assert evaluate("return document.querySelector('.binding:last-child [data-field=appMatch]').value") == expected_app
        evaluate("const input=document.querySelector('.binding:last-child [data-field=shortcut]'); input.value='Ctrl+Alt+Shift+F22'; input.dispatchEvent(new Event('input',{bubbles:true})); return true;")
        click("#save")
        wait_for("return document.querySelector('#message').textContent.startsWith('Saved.')")
        screenshot = request("GET", f"/session/{session}/screenshot")
        (output / "window-warp-current-app-kde.png").write_bytes(base64.b64decode(screenshot))
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
        report = {"passed": True, "checks": ["native editor renders", "shortcut conflict review, cancel, reassignment and explicit save", "save persists settings", "enable loads KWin script", "pause unloads KWin script", "startup creates and removes isolated autostart entry", "native workspace capture", "workspace persistence", "native workspace reuse and separate placements", "workspace launch creates a new window without consuming existing ones", "per-axis maximization and fullscreen workspace restoration", "workspace browser renders saved profiles"], "screenshot": str(output / "window-warp-workspaces-kde.png")}
        click("#show-shortcuts")
        invoke("set_enabled", {"enabled": True})
        invoke_shortcut("open-workspaces")
        wait_for("return !document.querySelector('#workspaces-page').hidden")
        before_update = invoke("get_workspaces")
        invoke_shortcut("update-workspace")
        wait_for("return !document.querySelector('#workspace-editor').hidden")
        assert evaluate("return document.querySelector('#workspace-target').value") == captured["id"]
        assert invoke("get_workspaces") == before_update, "Update hotkey must open a review draft"
        screenshot = request("GET", f"/session/{session}/screenshot")
        (output / "window-warp-update-kde.png").write_bytes(base64.b64decode(screenshot))
        click("#discard-workspace")
        invoke_shortcut("toggle-pause")
        wait_for("return document.querySelector('#status').textContent.includes('Paused')")
        assert kwin_loaded("window-warp-pause-session") and not kwin_loaded()
        report["checks"].extend(["pause shortcut resumes and pauses while retaining its registration", "editor shortcut captures the active owned app before taking focus", "workspace control shortcuts open browser and closest-match update draft"])
        if "--hold" in sys.argv:
            from wayland_input import Input
            # App pulls deliberately select a matching window. Give this check
            # its own app identity so previous workspace fixtures cannot win.
            hold_fixture = subprocess.Popen([sys.executable, fixture_script, "--hold"], env=fixture_env, stdout=log, stderr=log)
            for _ in range(30):
                hold_windows = [w for w in invoke("get_windows") if w["pid"] == hold_fixture.pid]
                if len(hold_windows) == 1:
                    break
                time.sleep(0.1)
            assert len(hold_windows) == 1, "Owned hold fixture did not map"
            state_item = json.loads(json.dumps(state_item))
            state_item["window"] = hold_windows[0]
            config = invoke("get_config")
            config["bindings"][-1]["appMatch"] = state_item["window"]["appId"]
            config["bindings"][5]["shortcut"] = "Ctrl+Alt+Shift+P"
            config["bindings"][1].update({"action":"focus-app", "appMatch":state_item["window"]["appId"]})
            config["bindings"][-1].update({"shortcut":"Ctrl+Alt+Shift+J", "mainMonitorAction":"focus-last"})
            config["settings"].update({"mainMonitor":1, "holdDelayMs":600, "holdTileEnabled":True})
            invoke("save_config", {"config":config})
            target = state_item["window"]
            target["maximizedHorizontal"] = target["maximizedVertical"] = target["fullscreen"] = target["minimized"] = False
            area = target["workArea"]
            initial = {"x":area["x"]+80,"y":area["y"]+80,"width":550,"height":360}
            target["rect"] = initial.copy()
            hold_profile = dict(captured,id="hold-fixture",name="Hold fixture",items=[state_item])
            invoke("save_workspaces", {"store":{"version":1,"profiles":[hold_profile]}})

            def owned():
                return next(w for w in invoke("get_windows") if w["id"] == target["id"] and w["pid"] == hold_fixture.pid)

            def wait_window(predicate, description):
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    current = owned()
                    if predicate(current):
                        return current
                    time.sleep(0.05)
                raise AssertionError(f"{description}: {current}; page: {evaluate('return document.body.innerText')}")

            def reset_window():
                result = invoke("restore_workspace", {"id":"hold-fixture"})
                assert result[0]["restored"], result
                # Reusing a workspace window deliberately preserves current focus.
                # Use the app's existing focus/cycle action to select the owned target.
                for _ in range(4):
                    if owned()["active"]:
                        break
                    invoke_shortcut("focus-app")
                wait_window(lambda w:w["active"] and w["rect"] == initial,"reset owned hold window")

            with Input() as keys:
                key_log = (output / "shortcut-signals.log").open("w")
                key_monitor = subprocess.Popen(["dbus-monitor", "--session", "type='signal',interface='org.kde.kglobalaccel.Component'"], stdout=key_log, stderr=key_log)
                key_log.close()
                def chord(key):
                    for code in [29,56,42,key]:
                        keys.key(code,True)

                chord(25)  # Ctrl+Alt+Shift+P; native Wayland delivery.
                keys.release()
                wait_for("return document.querySelector('#status').classList.contains('active')")
                reset_window()
                invoke_shortcut("open-workspaces")
                wait_for("return !document.querySelector('#workspaces-page').hidden")
                wait_window(lambda w:not w["active"],"editor takes focus before tap")
                chord(36)  # J
                time.sleep(0.08)
                assert not owned()["active"], "Tap ran before release"
                keys.key(29,False)
                wait_window(lambda w:w["active"],"modifier-first release taps")
                assert owned()["rect"] == initial
                keys.release()
                report["checks"].append("Wayland key events deliver app tap on modifier-first release")

                reset_window()
                keys.pointer(area["x"]+20,area["y"]+20)
                chord(36)
                time.sleep(0.08)
                keys.pointer(area["x"]+area["width"]-20,area["y"]+area["height"]-20)
                tile = dict(area,width=area["width"]//2)
                wait_window(lambda w:w["rect"] == tile,"hold uses the original pointer")
                reset_window()
                time.sleep(0.8)  # Native autorepeat must not tile again.
                assert owned()["rect"] == initial
                keys.release()
                time.sleep(0.15)
                assert owned()["active"] and owned()["rect"] == initial
                report["checks"].append("Wayland hold tiles once from key-down pointer despite native repeats")

                chord(36)
                time.sleep(0.08)
                # The app's pause command must cancel an in-flight native hold.
                invoke("set_enabled", {"enabled":False})
                time.sleep(0.7)
                keys.release()
                assert owned()["active"] and owned()["rect"] == initial
                report["checks"].append("pausing cancels a pending KDE hold without tiling or tapping")

                config["settings"]["holdTileEnabled"] = False
                invoke("save_config", {"config":config})
                invoke("set_enabled", {"enabled":True})
                reset_window()
                invoke_shortcut("open-workspaces")
                wait_window(lambda w:not w["active"],"editor takes focus before disabled hold")
                chord(36)
                time.sleep(0.8)
                assert not owned()["active"] and owned()["rect"] == initial
                keys.release()
                wait_window(lambda w:w["active"],"disabled hold taps on release")
                assert owned()["rect"] == initial
                report["checks"].append("disabled KDE hold remains a tap after a long press")
                chord(25)
                keys.release()
                wait_for("return document.querySelector('#status').textContent.includes('Paused')")
                assert kwin_loaded("window-warp-pause-session") and not kwin_loaded()
                report["checks"].append("Wayland key events resume and pause with persistent pause registration")

                if "--resume-held" in sys.argv:
                    config["settings"]["holdTileEnabled"] = True
                    invoke("save_config", {"config":config})
                    invoke("set_enabled", {"enabled":True})
                    reset_window()
                    chord(36)
                    time.sleep(0.08)
                    invoke("set_enabled", {"enabled":False})
                    invoke("set_enabled", {"enabled":True})
                    time.sleep(1.4)
                    keys.release()
                    time.sleep(0.15)
                    assert owned()["active"] and owned()["rect"] == initial, "Resuming while the chord remains held must not restart a cancelled gesture"
                    invoke("set_enabled", {"enabled":False})
                    report["checks"].append("KDE pause/resume before release does not revive a cancelled gesture")

                if "--reassign-native" in sys.argv:
                    def shortcut_names():
                        return set(subprocess.check_output(["qdbus", "org.kde.kglobalaccel", "/component/kwin", "org.kde.kglobalaccel.Component.shortcutNames"], text=True).splitlines())
                    foreign_shortcuts = {name for name in shortcut_names() if not name.startswith("window-warp-")}
                    config["bindings"][-1]["shortcut"] = "Ctrl+Alt+Shift+K"
                    config["bindings"][1].update({"shortcut":"Ctrl+Alt+Shift+J", "action":"tile-left", "appMatch":""})
                    invoke("save_config", {"config":config})
                    invoke("set_enabled", {"enabled":True})
                    chord(36)
                    keys.release()
                    wait_window(lambda w:w["rect"] == dict(area,width=area["width"]//2), "reassigned key reaches its new action")
                    invoke("set_enabled", {"enabled":False})
                    after = shortcut_names()
                    assert foreign_shortcuts <= after, "Cleanup removed another app's shortcut"
                    assert "window-warp-control-dispatch" in after
                    assert any(name.startswith("window-warp-toggle-pause-") for name in after)
                    assert not any(name.startswith("window-warp-hold-") for name in after)
                    report["checks"].append("KDE native key ownership follows reassignment between actions without removing other shortcuts")
            evaluate("location.reload(); return true;")
            wait_for("return document.querySelectorAll('.binding').length === 10 && !document.querySelector('#toggle').disabled")
            evaluate("document.querySelector('#hold-delay').closest('details').open=true; document.querySelector('#hold-enabled').scrollIntoView({block:'center'}); return true;")
            screenshot = request("GET", f"/session/{session}/screenshot")
            (output / "window-warp-hold-kde.png").write_bytes(base64.b64decode(screenshot))
        if "--firefox" in sys.argv:
            # Run this option only in nested.sh's isolated compositor/session bus.
            assert os.environ.get("WAYLAND_DISPLAY") == "warp-test", "Firefox test requires the isolated compositor"
            browser_profile = Path(temporary) / "firefox-profile"
            browser_profile.mkdir()
            preferences = {"browser.shell.checkDefaultBrowser": False, "browser.sessionstore.interval": 1000,
                           "browser.startup.homepage_override.mstone": "ignore", "browser.startup.page": 0,
                           "browser.aboutwelcome.enabled": False, "browser.newtabpage.enabled": False,
                           "browser.tabs.warnOnClose": False, "datareporting.policy.dataSubmissionEnabled": False}
            (browser_profile / "user.js").write_text("\n".join(f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in preferences.items()))
            urls = []
            for label in ["First", "Second"]:
                page = Path(temporary) / f"firefox-{label}.html"
                page.write_text(f"<!doctype html><title>Warp {label} Firefox fixture</title><p>{label} owned fixture</p>")
                urls.append(page.as_uri())
            browser_env = environment | {"MOZ_ENABLE_WAYLAND": "1"}
            browser_fixture = subprocess.Popen(["firefox", "--new-instance", "--profile", str(browser_profile), urls[0]], env=browser_env, stdout=log, stderr=log, start_new_session=True)
            first_loaded = False
            for _ in range(60):
                first_loaded = any(w["pid"] == browser_fixture.pid and "Warp First Firefox fixture" in w["title"] for w in invoke("get_windows"))
                if first_loaded:
                    break
                time.sleep(0.5)
            assert first_loaded, "First owned Firefox page did not finish loading"
            subprocess.run(["firefox", "--profile", str(browser_profile), "--new-tab", urls[1]], env=browser_env, stdout=log, stderr=log, check=True, timeout=15)
            browser_capture = None
            for _ in range(90):
                draft = invoke("capture_workspace", {"name": "Firefox fixture"})["profile"]
                draft["items"] = [item for item in draft["items"] if item["window"]["pid"] == browser_fixture.pid]
                if len(draft["items"]) == 1:
                    captured_browser = draft["items"][0].get("browser", {})
                    tabs = captured_browser.get("tabs", [])
                    if len(tabs) == 2 and all(tab["title"].startswith("Warp ") for tab in tabs):
                        active_title = tabs[captured_browser["activeTab"] - 1]["title"]
                        if active_title in draft["items"][0]["window"]["title"]:
                            browser_capture = draft
                            break
                if browser_fixture.poll() is not None:
                    raise AssertionError("Owned Firefox process exited before capture")
                time.sleep(0.5)
            assert browser_capture, {"error": "Firefox session tabs were not captured", "ownedCapture": draft["items"]}
            browser = browser_capture["items"][0]["browser"]
            assert browser["profilePath"] == str(browser_profile)
            assert {tab["url"] for tab in browser["tabs"]} == set(urls)
            assert browser["tabs"][browser["activeTab"] - 1]["title"] in browser_capture["items"][0]["window"]["title"]
            invoke("save_workspaces", {"store": {"version": 1, "profiles": [browser_capture]}})
            result = invoke("restore_workspace", {"id": browser_capture["id"]})
            assert result[0]["restored"] and not result[0]["launched"], result
            browser_capture["items"][0]["launch"]["newWindow"] = True
            invoke("save_workspaces", {"store": {"version": 1, "profiles": [browser_capture]}})
            result = invoke("restore_workspace", {"id": browser_capture["id"]})
            assert result[0]["restored"] and result[0]["launched"], result
            restored = []
            observations = []
            expected_active_url = browser["tabs"][browser["activeTab"] - 1]["url"]
            for _ in range(90):
                draft = invoke("capture_workspace", {"name": "Check browser restore"})["profile"]
                restored = [item for item in draft["items"] if item["window"]["pid"] == browser_fixture.pid and item["window"]["id"] != browser_capture["items"][0]["window"]["id"]]
                observation = [{"id": item["window"]["id"], "title": item["window"]["title"], "browser": item.get("browser"), "note": item.get("captureNote", "")} for item in restored]
                if not observations or observations[-1] != observation:
                    observations.append(observation)
                    observations = observations[-10:]
                if len(restored) == 1:
                    captured_browser = restored[0].get("browser", {})
                    tabs = captured_browser.get("tabs", [])
                    active = captured_browser.get("activeTab", 1) - 1
                    if len(tabs) == 2 and {tab["url"] for tab in tabs} == set(urls) and 0 <= active < len(tabs) and tabs[active]["url"] == expected_active_url:
                        break
                time.sleep(0.5)
            (output / "firefox-restore-observations.json").write_text(json.dumps({"expectedUrls": urls, "expectedActiveUrl": expected_active_url, "observations": observations}, indent=2))
            assert len(restored) == 1, "Profile launch did not create exactly one new browser window"
            restored_browser = restored[0]["browser"]
            assert {tab["url"] for tab in restored_browser["tabs"]} == set(urls), observations
            assert restored_browser["tabs"][restored_browser["activeTab"] - 1]["url"] == expected_active_url, observations
            report["checks"].extend(["real Firefox compressed session/profile/tab capture", "reuse existing Firefox profile window", "new Firefox window restores both URLs and selected tab"])
            # A second profile with identical titles must not be borrowed.
            other_profile = Path(temporary) / "other-firefox-profile"
            other_profile.mkdir()
            (other_profile / "user.js").write_text((browser_profile / "user.js").read_text())
            other_browser_fixture = subprocess.Popen(["firefox", "--new-instance", "--profile", str(other_profile), browser["tabs"][browser["activeTab"] - 1]["url"]], env=browser_env, stdout=log, stderr=log, start_new_session=True)
            other_windows = []
            for _ in range(60):
                other_windows = [w for w in invoke("get_windows") if w["pid"] == other_browser_fixture.pid]
                if other_windows and "Firefox fixture" in other_windows[0]["title"]:
                    break
                time.sleep(0.5)
            assert len(other_windows) == 1, "Second owned Firefox profile did not open"
            other_geometry = other_windows[0]["rect"]
            browser_capture["items"][0]["launch"]["newWindow"] = False
            browser_capture["items"][0]["window"].update({"maximizedHorizontal": False, "maximizedVertical": False, "fullscreen": False})
            source_area = browser_capture["items"][0]["window"]["workArea"]
            browser_capture["items"][0]["window"]["rect"].update({"x": source_area["x"] + 150, "y": source_area["y"] + 100, "width": 700, "height": 500})
            invoke("save_workspaces", {"store": {"version": 1, "profiles": [browser_capture]}})
            result = invoke("restore_workspace", {"id": browser_capture["id"]})
            assert result[0]["restored"] and not result[0]["launched"], result
            for _ in range(30):
                after = invoke("get_windows")
                if any(w["pid"] == browser_fixture.pid and w["rect"] == browser_capture["items"][0]["window"]["rect"] for w in after):
                    break
                time.sleep(0.1)
            assert [w for w in after if w["pid"] == other_browser_fixture.pid][0]["rect"] == other_geometry
            assert any(w["pid"] == browser_fixture.pid and w["rect"] == browser_capture["items"][0]["window"]["rect"] for w in after), {
                "expected": browser_capture["items"][0]["window"]["rect"],
                "ownedWindows": [{"rect": w["rect"], "maximizedHorizontal": w["maximizedHorizontal"], "maximizedVertical": w["maximizedVertical"]} for w in after if w["pid"] == browser_fixture.pid]}
            report["checks"].append("identical titles in another Firefox profile do not steal the restore")
            evaluate("location.reload(); return true;")
            wait_for("return document.querySelectorAll('.binding').length === 5 && !document.querySelector('#toggle').disabled")
            click("#show-workspaces")
            wait_for("return document.querySelectorAll('#workspace-list article').length === 1")
            click('[data-action="edit"]')
            evaluate("const panel=document.querySelector('.browser-settings'); panel.open=true; panel.scrollIntoView(); return true;")
            assert evaluate("return document.querySelector('[data-browser=profilePath]').value") == str(browser_profile)
            screenshot = request("GET", f"/session/{session}/screenshot")
            (output / "window-warp-firefox-kde.png").write_bytes(base64.b64decode(screenshot))
            report["screenshot"] = str(output / "window-warp-firefox-kde.png")
        if "--terminal" in sys.argv[4:]:
            assert os.environ.get("WAYLAND_DISPLAY") == "warp-test", "Terminal tests require the isolated compositor"
            terminal_dir = Path(temporary) / "terminal working directory"
            terminal_dir.mkdir()
            profile_dir = Path(environment["XDG_DATA_HOME"]) / "konsole"
            profile_dir.mkdir(parents=True, exist_ok=True)
            profile_file = profile_dir / "warp-owned.profile"
            profile_file.write_text("[General]\nName=Warp Fixture\nCommand=/bin/bash\nParent=FALLBACK/\n")
            terminal_fixture = subprocess.Popen(["konsole", "--separate", "--profile", str(profile_file), "--workdir", str(terminal_dir), "-e", "/bin/bash", "--noprofile", "--norc"], env=fixture_env, stdout=log, stderr=log, start_new_session=True)
            captured_terminal = None
            for _ in range(50):
                capture = invoke("capture_workspace", {"name": "Owned Konsole fixture"})["profile"]
                capture["items"] = [i for i in capture["items"] if i["window"]["pid"] == terminal_fixture.pid]
                if len(capture["items"]) == 1 and capture["items"][0].get("terminal", {}).get("shell"):
                    captured_terminal = capture
                    break
                time.sleep(0.2)
            assert captured_terminal, "Could not capture the owned Konsole shell"
            terminal = captured_terminal["items"][0]["terminal"]
            assert terminal["kind"] == "konsole" and Path(terminal["shell"]).name == "bash", terminal
            assert terminal["workingDirectory"] == str(terminal_dir), terminal
            assert terminal["profileName"] == "Warp Fixture", terminal
            assert terminal["profilePath"] == str(profile_file), terminal
            invoke("save_workspaces", {"store": {"version": 1, "profiles": [captured_terminal]}})
            result = invoke("restore_workspace", {"id": captured_terminal["id"]})
            assert result[0]["restored"] and not result[0]["launched"], result
            captured_terminal["items"][0]["launch"]["newWindow"] = True
            captured_terminal["items"][0]["terminal"]["shellArgs"] = ["--noprofile", "--norc"]
            before_terminal = {w["id"] for w in invoke("get_windows")}
            invoke("save_workspaces", {"store": {"version": 1, "profiles": [captured_terminal]}})
            result = invoke("restore_workspace", {"id": captured_terminal["id"]})
            # Record task-owned launches before any assertion, so failure still cleans up.
            for w in invoke("get_windows"):
                if w["id"] not in before_terminal and Path(w["path"]).name == "konsole":
                    args = Path(f'/proc/{w["pid"]}/cmdline').read_bytes().split(b"\0")
                    if str(terminal_dir).encode() in args:
                        terminal_launched.append(w["pid"])
            assert result[0]["restored"] and result[0]["launched"], result
            assert len(terminal_launched) == 1, terminal_launched
            capture = invoke("capture_workspace", {"name": "Restored Konsole"})["profile"]
            restored = [i for i in capture["items"] if i["window"]["pid"] in terminal_launched]
            assert len(restored) == 1 and restored[0]["terminal"]["workingDirectory"] == str(terminal_dir), restored
            assert restored[0]["terminal"]["profileName"] == terminal["profileName"]
            report["checks"].extend(["Konsole shell/profile/working directory capture", "Konsole reuse", "Konsole new-window launch preserves profile and directory"])
            evaluate("location.reload(); return true;")
            wait_for("return document.querySelectorAll('.binding').length === 5 && !document.querySelector('#toggle').disabled")
            click("#show-workspaces")
            wait_for("return document.querySelectorAll('#workspace-list article').length === 1")
            click('[data-action="edit"]')
            evaluate("const panel=document.querySelector('.terminal-settings'); panel.open=true; panel.scrollIntoView(); return true;")
            assert evaluate("return document.querySelector('[data-terminal=workingDirectory]').value") == str(terminal_dir)
            screenshot = request("GET", f"/session/{session}/screenshot")
            (output / "window-warp-terminal-kde.png").write_bytes(base64.b64decode(screenshot))
            report["screenshot"] = str(output / "window-warp-terminal-kde.png")
        (output / "gui-result.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2), flush=True)
    finally:
        for pid in terminal_launched:
            try:
                args = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
                if str(terminal_dir).encode() in args:
                    os.kill(pid, signal.SIGTERM)
            except (FileNotFoundError, ProcessLookupError):
                pass
        if terminal_fixture:
            terminal_fixture.terminate()
            terminal_fixture.wait(timeout=10)
        if other_browser_fixture:
            try:
                os.killpg(other_browser_fixture.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            other_browser_fixture.wait(timeout=10)
        if browser_fixture:
            try:
                os.killpg(browser_fixture.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            browser_fixture.wait(timeout=10)
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
        if key_monitor:
            key_monitor.terminate()
            key_monitor.wait(timeout=10)
        if hold_fixture:
            hold_fixture.terminate()
            hold_fixture.wait(timeout=10)
        if fixture:
            fixture.terminate()
            fixture.wait(timeout=10)
        for name in ["window-warp-session", "window-warp-pause-session", "window-warp-control-session"]:
            if kwin_loaded(name):
                subprocess.run(["qdbus", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", name], check=True)
        # Kill only the process group created by this test's driver.
        try:
            os.killpg(driver.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        driver.wait(timeout=10)
