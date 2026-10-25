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
if any(flag in sys.argv for flag in ["--resume-held", "--reassign-native", "--companion-loss", "--radial", "--pointer", "--pointer-denied", "--retile"]) and "--hold" not in sys.argv:
    raise ValueError("Native gesture edge checks require --hold and the private compositor")
if "--pointer" in sys.argv and "--pointer-denied" in sys.argv:
    raise ValueError("Pointer authorization and refusal require separate compositor sessions")
if "--firefox-tiles" in sys.argv and "--firefox" not in sys.argv:
    raise ValueError("Firefox tile acceptance requires --firefox")
if "--firefox-no-profile-args" in sys.argv and "--firefox" not in sys.argv:
    raise ValueError("Firefox profile-lock acceptance requires --firefox")
if "--overlap" in sys.argv and "--firefox-tiles" not in sys.argv:
    raise ValueError("Overlapping shortcut acceptance requires --firefox-tiles")
if "--terminal-concurrent" in sys.argv and "--terminal" not in sys.argv:
    raise ValueError("Concurrent terminal acceptance requires --terminal")


def kwin_loaded(name="window-warp-session"):
    return subprocess.check_output(["qdbus", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.isScriptLoaded", name], text=True).strip() == "true"


if any(kwin_loaded(name) for name in ["window-warp-session", "window-warp-pause-session", "window-warp-control-session", "window-warp-retile-session"]) or subprocess.run(["pgrep", "-x", "window-warp"], stdout=subprocess.DEVNULL).returncode == 0:
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


def test_tray(driver, environment, log, report):
    """Use the app's exported native menu, scoped to this driver's app child."""
    from gi.repository import Gio, GLib
    from xml.etree import ElementTree
    from wayland_input import Input

    assert os.environ.get("WAYLAND_DISPLAY") == "warp-test", "Tray acceptance requires the private compositor"
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    def call(owner, path, interface, method, signature=None, arguments=()):
        return bus.call_sync(owner, path, interface, method,
            GLib.Variant(signature, arguments) if signature else None, None,
            Gio.DBusCallFlags.NONE, 3000, None).unpack()

    def bus_call(method, signature=None, arguments=()):
        return call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", method, signature, arguments)

    def process(pid):
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            return dict(pid=pid, parent=int(fields[1]), started=fields[19], state=fields[0])
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            return None

    driver_identity = process(driver.pid)
    assert driver_identity and driver.poll() is None

    def app_child(pid):
        identity = process(pid)
        if not identity or identity["state"] == "Z": return None
        try:
            if Path(f"/proc/{pid}/exe").resolve(strict=True) != Path(binary): return None
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            return None
        ancestor = identity
        for _ in range(32):
            if ancestor["pid"] == driver.pid:
                return identity if ancestor["started"] == driver_identity["started"] else None
            ancestor = process(ancestor["parent"])
            if not ancestor: break
        return None

    def vanished(error):
        return Gio.DBusError.get_remote_error(error) in [
            "org.freedesktop.DBus.Error.NameHasNoOwner",
            "org.freedesktop.DBus.Error.ServiceUnknown",
        ]

    names = bus_call("ListNames")[0]
    owned_connections = {}
    for owner in names:
        if not owner.startswith(":"): continue
        try:
            pid = bus_call("GetConnectionUnixProcessID", "(s)", (owner,))[0]
        except GLib.Error as error:
            if vanished(error): continue
            raise
        identity = app_child(pid)
        if identity: owned_connections[owner] = identity

    def owner_of(name):
        try:
            return name if name.startswith(":") else bus_call("GetNameOwner", "(s)", (name,))[0]
        except GLib.Error as error:
            if vanished(error): return None
            raise

    owned_names = []
    endpoints = set()
    for name in names:
        owner = owner_of(name)
        if owner not in owned_connections: continue
        owned_names.append(dict(name=name,owner=owner,pid=owned_connections[owner]["pid"]))
        if name.startswith("org.kde.StatusNotifierItem-"):
            endpoints.add((owner,"/StatusNotifierItem"))
    watcher = "org.kde.StatusNotifierWatcher"
    discovery = dict(watcherPresent=bus_call("NameHasOwner", "(s)", (watcher,))[0],ownedNames=owned_names,ownedEndpoints=[])
    discovery_path = output / "tray-discovery.json"
    discovery_path.write_text(json.dumps(discovery,indent=2))
    if discovery["watcherPresent"]:
        registered = call(watcher,"/StatusNotifierWatcher","org.freedesktop.DBus.Properties","Get",
            "(ss)",("org.kde.StatusNotifierWatcher","RegisteredStatusNotifierItems"))[0]
        for item in registered:
            name,separator,suffix = item.partition("/")
            owner = owner_of(name)
            if owner in owned_connections:
                endpoints.add((owner,"/"+suffix if separator else "/StatusNotifierItem"))
    discovery["ownedEndpoints"] = [dict(owner=owner,path=path) for owner,path in sorted(endpoints)]
    discovery_path.write_text(json.dumps(discovery,indent=2))
    # Never introspect arbitrary app-owned client connections: a connection
    # without an exported object need not dispatch incoming calls at all.
    candidates = []
    for owner,path in sorted(endpoints):
        xml = call(owner,path,"org.freedesktop.DBus.Introspectable","Introspect")[0]
        assert any(interface.get("name") == "org.kde.StatusNotifierItem"
            for interface in ElementTree.fromstring(xml).findall("interface")), "Advertised tray endpoint lacks StatusNotifierItem"
        candidates.append((owner,path,owned_connections[owner]))
    assert len(candidates) == 1, f"Expected one owned native tray item, found {len(candidates)}; discovery: {discovery}"
    owner, item_path, identity = candidates[0]
    menu_path = call(owner, item_path, "org.freedesktop.DBus.Properties", "Get", "(ss)", ("org.kde.StatusNotifierItem", "Menu"))[0]
    assert isinstance(menu_path, str) and menu_path.startswith("/")
    menu = {}

    def read_menu(node):
        if isinstance(node, GLib.Variant): node = node.unpack()
        identifier, properties, children = node
        label = properties.get("label", "").replace("_", "")
        if label:
            assert label not in menu, f"Duplicate native menu label: {label}"
            menu[label] = dict(id=identifier, enabled=properties.get("enabled", True), visible=properties.get("visible", True))
        for child in children: read_menu(child)

    def refresh_menu():
        menu.clear()
        layout = call(owner, menu_path, "com.canonical.dbusmenu", "GetLayout", "(iias)", (0, -1, ["label", "enabled", "visible"]))[1]
        read_menu(layout)

    refresh_menu()
    for label in ["Open Window Warp", "Quit"]:
        assert label in menu and menu[label]["enabled"] and menu[label]["visible"], menu
    assert ("Enable shortcuts" in menu) != ("Pause shortcuts" in menu), menu
    proof = dict(pid=identity["pid"], owner=owner, itemPath=item_path, menuPath=menu_path, menu=menu,
        host="private StatusNotifier protocol fixture; physical panel rendering not tested", checks=[])

    def record(label):
        proof["checks"].append(label)
        (output / "tray-observations.json").write_text(json.dumps(proof, indent=2))
        report["checks"].append(label)

    def current_app():
        current = process(identity["pid"])
        return current is not None and current["started"] == identity["started"] and current["state"] != "Z"

    def event(label):
        assert current_app() and bus_call("GetConnectionUnixProcessID", "(s)", (owner,))[0] == identity["pid"]
        refresh_menu()
        assert label in menu and menu[label]["enabled"] and menu[label]["visible"], menu
        call(owner, menu_path, "com.canonical.dbusmenu", "Event", "(isvu)",
            (menu[label]["id"], "clicked", GLib.Variant("s", ""), 0))

    def window_action(method):
        value = request("POST", f"/session/{session}/execute/async", {
            "script":"const done=arguments[arguments.length-1]; window.__TAURI__.window.getCurrentWindow()[arguments[0]]().then(result=>done({result}),error=>done({error:String(error)}));",
            "args":[method]})
        assert "error" not in value, value
        return value.get("result")

    def visible(wanted):
        deadline = time.monotonic()+5
        while time.monotonic()<deadline:
            if window_action("isVisible") == wanted: return
            time.sleep(0.1)
        raise AssertionError(f"Tray editor visibility did not become {wanted}")

    def close_editor():
        # Core window.close is intentionally outside the app's default IPC
        # permissions. Exercise KWin's real close request instead, after the
        # owned menu has focused this exact WebDriver window.
        event("Open Window Warp")
        deadline = time.monotonic()+5
        while time.monotonic()<deadline and not window_action("isFocused"):
            time.sleep(0.1)
        assert current_app() and window_action("isFocused"), "Owned editor must have focus before Alt+F4"
        with Input() as keys:
            keys.key(56,True)  # Alt
            keys.key(62,True)  # F4
            keys.release()
        visible(False)

    saved_config = invoke("get_config")
    script_names = ["window-warp-session", "window-warp-pause-session", "window-warp-control-session", "window-warp-retile-session"]
    script_names.extend("window-warp-gesture-"+binding["shortcut"].encode().hex()
        for binding in saved_config["bindings"] if binding["enabled"] and binding["action"] == "pull-app")
    invoke("set_enabled", {"enabled":True})
    assert kwin_loaded() and kwin_loaded("window-warp-pause-session")
    record("native StatusNotifierItem and menu belong to the owned WebDriver app process")
    event("Pause shortcuts")
    wait_for("return document.querySelector('#status').textContent.includes('Paused')")
    assert not invoke("get_status")["enabled"] and not kwin_loaded() and kwin_loaded("window-warp-pause-session")
    record("native tray Pause disables actions and retains the resume shortcut")
    event("Enable shortcuts")
    wait_for("return !document.querySelector('#status').textContent.includes('Paused')")
    assert invoke("get_status")["enabled"] and kwin_loaded()
    record("native tray Enable restores shortcuts without editing settings")
    event("Pause shortcuts")
    wait_for("return document.querySelector('#status').textContent.includes('Paused')")
    close_editor()
    assert current_app() and bus_call("NameHasOwner", "(s)", (owner,))[0]
    record("closing the editor hides it while the owned app and tray stay alive")
    second = subprocess.Popen([binary], env=environment, stdout=log, stderr=log, start_new_session=True)
    try:
        assert second.wait(timeout=10) == 0, "Second instance did not exit successfully"
    finally:
        if second.poll() is None:
            os.killpg(second.pid,signal.SIGTERM)
            second.wait(timeout=5)
    visible(True)
    assert current_app() and invoke("get_config") == saved_config
    record("a second instance exits and reopens the same editor without changing settings")
    close_editor()
    event("Open Window Warp")
    visible(True)
    assert current_app() and invoke("get_config") == saved_config
    record("native tray Open reopens the hidden editor without changing settings")
    invoke("set_enabled", {"enabled":True})
    assert kwin_loaded() and kwin_loaded("window-warp-pause-session")
    event("Quit")
    deadline = time.monotonic()+10
    while time.monotonic()<deadline:
        if not current_app() and not bus_call("NameHasOwner", "(s)", (owner,))[0]: break
        time.sleep(0.1)
    assert not current_app() and not bus_call("NameHasOwner", "(s)", (owner,))[0], "Tray Quit did not terminate the owned app gracefully"
    remaining = [name for name in script_names if kwin_loaded(name)]
    assert not remaining, f"Graceful tray exit left KWin scripts loaded before fixture cleanup: {remaining}"
    record("native tray Quit exits the owned app and releases action, pause, control and gesture scripts before fixture cleanup")
    report["tray"] = proof


def test_terminal_concurrent(environment, temporary, template, log, report):
    directory = Path(temporary) / "terminal-concurrent"
    directory.mkdir()
    started = directory / "started.json"
    release = directory / "release"
    wrapper = directory / "gated-konsole"
    original = template["items"][0]
    konsole = original["launch"]["program"]
    assert Path(konsole).is_absolute() and Path(konsole).name == "konsole", konsole
    wrapper.write_text(f'''#!{sys.executable}
import json, os, pathlib, sys, time
os.setsid()
marker = pathlib.Path({str(started)!r})
pending = marker.with_suffix('.pending')
pending.write_text(json.dumps({{"pid":os.getpid(),"birth":pathlib.Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],"args":sys.argv[1:]}}))
pending.replace(marker)
deadline = time.monotonic() + 10
while not pathlib.Path({str(release)!r}).exists():
    if time.monotonic() >= deadline: raise SystemExit("Timed out waiting for owned terminal launch release")
    time.sleep(0.025)
os.execv({konsole!r}, [{konsole!r}, *sys.argv[1:]])
''')
    wrapper.chmod(0o700)
    wrong_profile = directory / "wrong.profile"
    wrong_profile.write_text("[General]\nName=Warp Wrong Concurrent\nCommand=/bin/sh\nParent=FALLBACK/\n")
    profile = json.loads(json.dumps(template))
    profile["id"] = "terminal-concurrent"
    item = profile["items"][0]
    item["launch"].update({"program": str(wrapper), "newWindow": True})
    area = item["window"]["workArea"]
    target = {"x": area["x"] + 140, "y": area["y"] + 115, "width": 550, "height": 350}
    item["window"].update({"rect": target, "maximizedHorizontal": False, "maximizedVertical": False, "fullscreen": False, "minimized": False})
    invoke("save_workspaces", {"store": {"version": 1, "profiles": [profile]}})
    evidence = {"target": target, "passed": False}
    receipt = output / "terminal-concurrent.json"
    wrong = None
    owned = []
    alias_evidence = None
    alias_receipt = output / "terminal-selected-profile.json"
    command_evidence = None
    command_receipt = output / "terminal-command-wrapper.json"
    selected_profile = directory / "selected.profile"

    def birth(pid):
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] == "Z": raise ProcessLookupError("Owned process exited")
        return fields[19]

    def owned_capture(pid):
        capture = invoke("capture_workspace", {"name": "Concurrent terminal observation"})["profile"]
        return [i for i in capture["items"] if i["window"]["pid"] == pid]

    def observation():
        return evaluate("return window.__terminalConcurrent")

    try:
        # Returning from JS immediately leaves the real restore running, while
        # subsequent observations use the same native bridge normally.
        evaluate("window.__terminalConcurrent={pending:true};window.__TAURI__.core.invoke('restore_workspace',{id:'terminal-concurrent'}).then(result=>{window.__terminalConcurrent={result}},error=>{window.__terminalConcurrent={error:String(error)}});return true;")
        deadline = time.monotonic() + 5
        while not started.exists() and time.monotonic() < deadline: time.sleep(0.025)
        assert started.exists(), {"restore": observation(), "error": "Gated launch did not start"}
        launch = json.loads(started.read_text())
        pid = launch["pid"]
        argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        assert str(wrapper).encode() in argv and os.getpgid(pid) == pid, "Unexpected gated launch owner"
        assert birth(pid) == launch["birth"]
        owned.append((pid, launch["birth"]))
        evidence["intendedLaunch"] = launch
        wrong = subprocess.Popen([konsole, "--separate", "--profile", str(wrong_profile), "--workdir", str(directory), "-e", "/bin/sh"],
            env=environment, stdout=log, stderr=log, start_new_session=True)
        deadline = time.monotonic() + 5
        wrong_items = []
        while time.monotonic() < deadline:
            assert wrong.poll() is None, "Wrong-profile fixture exited before it could be observed"
            wrong_items = owned_capture(wrong.pid)
            if len(wrong_items) == 1 and wrong_items[0].get("terminal", {}).get("shell"): break
            time.sleep(0.05)
        assert len(wrong_items) == 1, "Owned wrong-profile Konsole did not become visible"
        candidate = wrong_items[0]
        assert candidate["terminal"]["profileName"] == "Warp Wrong Concurrent", candidate
        assert Path(candidate["terminal"]["shell"]).name != Path(item["terminal"]["shell"]).name, candidate
        evidence["wrongBeforeRelease"] = candidate
        # The intended process is still the waiting wrapper: this is a proven
        # candidate ordering, not a guess about which Konsole starts faster.
        assert str(wrapper).encode() in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        time.sleep(0.6)  # More than three 150ms production polling intervals.
        evidence["beforeRelease"] = observation()
        receipt.write_text(json.dumps(evidence, indent=2))
        release.touch()
        deadline = time.monotonic() + 8
        intended = []
        while time.monotonic() < deadline:
            intended = owned_capture(pid)
            if len(intended) == 1 and intended[0].get("terminal", {}).get("shell") and not observation().get("pending"): break
            time.sleep(0.05)
        evidence["result"] = observation()
        evidence["intendedAfter"] = intended
        wrong_after = owned_capture(wrong.pid)
        evidence["wrongAfter"] = wrong_after
        receipt.write_text(json.dumps(evidence, indent=2))
        assert evidence["beforeRelease"] == {"pending": True}, "Restore accepted the incompatible new terminal while the intended launch was gated; see terminal-concurrent.json"
        result = evidence["result"].get("result", [])
        assert len(result) == 1 and result[0]["restored"] and result[0]["launched"], evidence["result"]
        assert len(intended) == 1 and intended[0]["terminal"]["profileName"] == item["terminal"]["profileName"] and Path(intended[0]["terminal"]["shell"]).name == Path(item["terminal"]["shell"]).name, intended
        assert intended[0]["window"]["rect"] == target, intended
        assert len(wrong_after) == 1 and wrong_after[0]["window"]["rect"] == candidate["window"]["rect"] and wrong_after[0]["window"]["rect"] != target, wrong_after
        evidence["passed"] = True
        report["checks"].append("terminal launch ignores a proven incompatible new Konsole until the gated matching profile/shell appears, preserving the unrelated window placement")

        # Independent launch acceptance: the chosen profile file takes priority
        # over a stale captured name, and /bin/sh may resolve to /usr/bin/dash.
        selected_profile.write_text("[General]\nName=Warp Selected Profile\nCommand=/bin/bash\nParent=FALLBACK/\n")
        selected_dir = directory / "selected working directory"
        selected_dir.mkdir()
        selected = json.loads(json.dumps(profile))
        selected["id"] = "terminal-selected-profile"
        selected_item = selected["items"][0]
        stale_name = selected_item["terminal"]["profileName"]
        assert stale_name != "Warp Selected Profile"
        selected_item["terminal"].update({"profilePath": str(selected_profile), "shell": "/bin/sh", "shellArgs": [], "workingDirectory": str(selected_dir)})
        selected_item["window"]["rect"] = dict(target, x=target["x"] + 100, y=target["y"] + 70)
        alias_evidence = {"passed": False, "requestedTerminal": selected_item["terminal"], "target": selected_item["window"]["rect"]}
        alias_receipt.write_text(json.dumps(alias_evidence, indent=2))
        invoke("save_workspaces", {"store": {"version": 1, "profiles": [selected]}})
        started.unlink()
        # The first gate is already released; the same owned wrapper now only
        # records process identity before exec, without delaying this launch.
        alias_evidence["result"] = invoke("restore_workspace", {"id": selected["id"]})
        alias_launch = json.loads(started.read_text())
        alias_pid = alias_launch["pid"]
        assert birth(alias_pid) == alias_launch["birth"] and os.getpgid(alias_pid) == alias_pid
        alias_argv = Path(f"/proc/{alias_pid}/cmdline").read_bytes().split(b"\0")
        assert str(selected_profile).encode() in alias_argv and Path(f"/proc/{alias_pid}/exe").resolve() == Path(konsole).resolve()
        owned.append((alias_pid, alias_launch["birth"]))
        alias_evidence["launch"] = alias_launch
        selected_items = owned_capture(alias_pid)
        alias_evidence["actual"] = selected_items
        alias_receipt.write_text(json.dumps(alias_evidence, indent=2))
        selected_result = alias_evidence["result"]
        assert len(selected_result) == 1 and selected_result[0]["restored"] and selected_result[0]["launched"], selected_result
        assert len(selected_items) == 1, selected_items
        actual = selected_items[0]
        assert Path(actual["terminal"]["shell"]).samefile("/bin/sh"), actual
        assert actual["terminal"]["profileName"] == "Warp Selected Profile" and Path(actual["terminal"]["profilePath"]).samefile(selected_profile), actual
        assert actual["terminal"]["workingDirectory"] == str(selected_dir) and actual["window"]["rect"] == selected_item["window"]["rect"], actual
        alias_evidence["passed"] = True
        report["checks"].append("Konsole launch honors the selected profile file over a stale name and restores an explicit /bin/sh alias with its actual shell, directory and placement")

        # A configured shell command may intentionally exec another program.
        # Exercise that ordinary command contract without a shell-name allowlist.
        command_profile = json.loads(json.dumps(selected))
        command_profile["id"] = "terminal-command-wrapper"
        command_item = command_profile["items"][0]
        command_item["terminal"].update({"shell": "/usr/bin/env", "shellArgs": ["bash", "--noprofile", "--norc"]})
        command_item["window"]["rect"] = dict(target, x=target["x"] + 170, y=target["y"] + 95)
        command_evidence = {"passed": False, "requestedTerminal": command_item["terminal"], "target": command_item["window"]["rect"]}
        command_receipt.write_text(json.dumps(command_evidence, indent=2))
        invoke("save_workspaces", {"store": {"version": 1, "profiles": [command_profile]}})
        started.unlink()
        command_evidence["result"] = invoke("restore_workspace", {"id": command_profile["id"]})
        command_launch = json.loads(started.read_text())
        command_pid = command_launch["pid"]
        assert birth(command_pid) == command_launch["birth"] and os.getpgid(command_pid) == command_pid
        command_argv = Path(f"/proc/{command_pid}/cmdline").read_bytes().split(b"\0")
        assert str(selected_profile).encode() in command_argv and Path(f"/proc/{command_pid}/exe").resolve() == Path(konsole).resolve()
        owned.append((command_pid, command_launch["birth"]))
        command_evidence["launch"] = command_launch
        command_items = owned_capture(command_pid)
        command_evidence["actual"] = command_items
        command_receipt.write_text(json.dumps(command_evidence, indent=2))
        command_result = command_evidence["result"]
        assert len(command_result) == 1 and command_result[0]["restored"] and command_result[0]["launched"], command_result
        assert len(command_items) == 1, command_items
        actual = command_items[0]
        assert Path(actual["terminal"]["shell"]).samefile("/bin/bash"), actual
        assert actual["terminal"]["profileName"] == "Warp Selected Profile" and Path(actual["terminal"]["profilePath"]).samefile(selected_profile), actual
        assert actual["terminal"]["workingDirectory"] == str(selected_dir) and actual["window"]["rect"] == command_item["window"]["rect"], actual
        command_evidence["passed"] = True
        report["checks"].append("Konsole restores an explicit /usr/bin/env bash command after it execs bash, preserving selected profile, directory and placement")
    finally:
        receipt.write_text(json.dumps(evidence, indent=2))
        if alias_evidence is not None: alias_receipt.write_text(json.dumps(alias_evidence, indent=2))
        if command_evidence is not None: command_receipt.write_text(json.dumps(command_evidence, indent=2))
        if started.exists():
            recorded = json.loads(started.read_text())
            pid = recorded["pid"]
            try:
                argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
                recognized = str(wrapper).encode() in argv or (str(selected_profile).encode() in argv and Path(f"/proc/{pid}/exe").resolve() == Path(konsole).resolve())
                identity = (pid, recorded["birth"])
                if recognized and birth(pid) == recorded["birth"] and os.getpgid(pid) == pid and identity not in owned: owned.append(identity)
            except (FileNotFoundError, ProcessLookupError): pass
        for owner in owned:
            try:
                if birth(owner[0]) == owner[1] and os.getpgid(owner[0]) == owner[0]:
                    os.killpg(owner[0], signal.SIGTERM)
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        if birth(owner[0]) != owner[1]: break
                        time.sleep(0.05)
                    else:
                        if birth(owner[0]) == owner[1] and os.getpgid(owner[0]) == owner[0]: os.killpg(owner[0], signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError): pass
        if wrong is not None:
            try:
                if wrong.poll() is None: os.killpg(wrong.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: wrong.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(wrong.pid, signal.SIGKILL)
                wrong.wait(timeout=5)
        if observation().get("pending"): invoke("cancel_workspace_restore")
        invoke("save_workspaces", {"store": {"version": 1, "profiles": [template]}})


def test_dbus_desktop_entry(environment, template, report):
    from gi.repository import Gio, GLib

    # nested.sh starts this bus only after establishing the private XDG roots.
    data_home = Path(os.environ.get("WARP_PRIVATE_DBUS_DATA_HOME", "")).resolve()
    runtime = Path(os.environ.get("XDG_RUNTIME_DIR", "")).resolve()
    assert (runtime.parent.parent == Path("/tmp") and runtime.parent.name.startswith("window-warp-nested.")
        and runtime.name == "runtime" and data_home == runtime.parent / "data"
        and str(data_home) == os.environ.get("XDG_DATA_HOME")
        and os.environ.get("WAYLAND_DISPLAY") == "warp-test" and (runtime / "warp-test").is_socket()), "D-Bus activation requires the private nested-session bus and data root"
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    def daemon(method, signature, values):
        return bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            method, GLib.Variant(signature, values), None, Gio.DBusCallFlags.NONE, 3000, None).unpack()

    def quoted(value):
        value = str(value)
        assert not any(char in value for char in '\n\r"\\%$`'), "Unsupported fixture path quoting"
        return '"' + value + '"'

    identity = "org.windowwarp.DBusFixture.p" + str(os.getpid())
    helper = str(Path(__file__).with_name("dbus_app.py").resolve())
    receipt_file = output / "dbus-desktop-calls.json"
    diagnostic_file = output / "dbus-desktop-service.log"
    fallback_file = output / "dbus-desktop-exec-fallback.json"
    assert not any(p.exists() for p in [receipt_file, diagnostic_file, fallback_file]), "Use a fresh output directory for D-Bus activation receipts"
    assert not daemon("NameHasOwner", "(s)", (identity,))[0], "Fixture identity already has an owner"
    applications = Path(environment["XDG_DATA_HOME"]) / "applications"
    services = data_home / "dbus-1/services"
    applications.mkdir(parents=True, exist_ok=True)
    services.mkdir(parents=True, exist_ok=True)
    desktop = applications / (identity + ".desktop")
    service = services / (identity + ".service")
    assert not desktop.exists() and not service.exists(), "Refusing to overwrite a fixture registration"
    desktop.write_text('[Desktop Entry]\nType=Application\nName=Window Warp D-Bus fixture\nDBusActivatable=true\nExec='
        + ' '.join(quoted(v) for v in [sys.executable, helper, "--exec-fallback", fallback_file]) + ' %U\n')
    service.write_text('[D-BUS Service]\nName=' + identity + '\nExec=/usr/bin/env QT_QPA_PLATFORM=wayland WAYLAND_DISPLAY=warp-test '
        + ' '.join(quoted(v) for v in [sys.executable, helper, identity, receipt_file, diagnostic_file]) + '\n')
    owned = None

    def process_identity(pid):
        stat = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if stat[0] == "Z": raise ProcessLookupError("Fixture service has exited")
        argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        assert argv[1:5] == [helper.encode(), identity.encode(), str(receipt_file).encode(), str(diagnostic_file).encode()], "D-Bus owner is not this fixture service"
        return pid, stat[19]

    def calls():
        value = json.loads(receipt_file.read_text())
        assert owned is not None and value["pid"] == owned[0] and value["applicationId"] == identity, value
        assert not fallback_file.exists(), "GIO used desktop Exec fallback instead of D-Bus activation"
        return value["calls"]

    def windows():
        assert owned is not None and process_identity(owned[0]) == owned
        return [w for w in invoke("get_windows") if w["pid"] == owned[0] and w["desktopId"] == identity]

    try:
        daemon("ReloadConfig", "()", ())
        item = json.loads(json.dumps(template["items"][0]))
        item["window"].update({"id": "dbus-fixture-unstarted", "pid": 0, "appId": identity, "desktopId": identity, "title": "WARP-DBUS-1", "path": ""})
        item["launch"] = {"kind": "desktop-entry", "program": identity, "args": [], "newWindow": True, "workingDirectory": ""}
        profile = dict(template, id="dbus-desktop-launch", items=[item])
        store = {"version": 1, "profiles": [profile]}
        invoke("save_workspaces", {"store": store})
        result = invoke("restore_workspace", {"id": profile["id"]})
        assert len(result) == 1 and result[0]["restored"] and result[0]["launched"], result
        pid = daemon("GetConnectionUnixProcessID", "(s)", (identity,))[0]
        owned = process_identity(pid)
        assert calls() == [{"method": "Activate", "uris": []}], calls()
        first = windows()
        assert len(first) == 1 and first[0]["rect"] == item["window"]["rect"], first
        report["checks"].append("D-Bus desktop entry autostarts an absent owned service via Activate and restores its first visible window without Exec fallback")

        capture = invoke("capture_workspace", {"name": "D-Bus fixture"})["profile"]
        captured_items = [i for i in capture["items"] if i["window"]["pid"] == pid]
        assert len(captured_items) == 1 and captured_items[0]["launch"]["kind"] == "desktop-entry" and captured_items[0]["launch"]["program"] == identity, captured_items
        original_rect = dict(first[0]["rect"])
        item["window"] = dict(first[0])
        item["launch"]["args"] = ["https://example.test/a%20b?x=1&y=2", "file:///tmp/warp%20dbus%20document.txt"]
        item["window"]["rect"] = dict(first[0]["rect"], x=first[0]["rect"]["x"] + 90)
        invoke("save_workspaces", {"store": store})
        result = invoke("restore_workspace", {"id": profile["id"]})
        fresh = [w for w in windows() if w["id"] != first[0]["id"]]
        assert result[0]["restored"] and result[0]["launched"] and len(fresh) == 1, result
        assert calls() == [{"method": "Activate", "uris": []}, {"method": "Open", "uris": item["launch"]["args"]}], calls()
        assert fresh[0]["rect"] == item["window"]["rect"], fresh
        assert next(w for w in windows() if w["id"] == first[0]["id"])["rect"] == original_rect, "Forced-new activation moved the original window"
        report["checks"].append("D-Bus desktop identity capture and Open preserve exact URI payloads and force a distinct owned window")

        item["window"] = fresh[0]
        item["launch"]["newWindow"] = False
        invoke("save_workspaces", {"store": store})
        result = invoke("restore_workspace", {"id": profile["id"]})
        assert result[0]["restored"] and not result[0]["launched"] and len(windows()) == 2 and len(calls()) == 2, result
        report["checks"].append("D-Bus desktop entry reuse restores an existing window without another activation")

        item["launch"].update({"newWindow": True, "args": ["warp-fixture://reject"]})
        invoke("save_workspaces", {"store": store})
        result = invoke("restore_workspace", {"id": profile["id"]})
        assert not result[0]["restored"] and result[0]["error"] and len(windows()) == 2, result
        assert calls()[-1] == {"method": "Open", "uris": ["warp-fixture://reject"], "error": "org.windowwarp.Fixture.Rejected"} and len(calls()) == 3, calls()
        # GIO can acknowledge dispatch before the remote method replies. In
        # that case the real restore reports its bounded no-window failure.
        report["dbusDesktopEntry"] = {"pid": pid, "applicationId": identity, "rejectedRestore": result[0], "execFallbackUsed": False}
        report["checks"].append("a rejected D-Bus Open cannot falsely report a restored window or consume an existing one")
    finally:
        # The bus daemon owns this child, so prove exact argv and birth before
        # signalling it; never kill a name owner based on its PID alone.
        if owned is None and daemon("NameHasOwner", "(s)", (identity,))[0]:
            owned = process_identity(daemon("GetConnectionUnixProcessID", "(s)", (identity,))[0])
        if owned is not None:
            try:
                if process_identity(owned[0]) == owned:
                    os.kill(owned[0], signal.SIGTERM)
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        if process_identity(owned[0]) != owned: break
                        time.sleep(0.05)
                    else:
                        if process_identity(owned[0]) == owned: os.kill(owned[0], signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError):
                pass
        service.unlink()
        desktop.unlink()


with tempfile.TemporaryDirectory(prefix="window-warp-gui-") as temporary, (output / "gui.log").open("w") as log:
    environment = os.environ.copy()
    environment.update({"TAURI_WEBVIEW_AUTOMATION": "true", "TAURI_AUTOMATION": "true", "GDK_BACKEND": "wayland", "XDG_CONFIG_HOME": temporary + "/config", "XDG_DATA_HOME": temporary + "/data", "XDG_CACHE_HOME": temporary + "/cache"})
    if "--firefox-no-profile-args" in sys.argv:
        environment["HOME"] = temporary + "/home"
        Path(environment["HOME"]).mkdir()
    if "--desktop-entry" in sys.argv:
        # Only this disposable desktop session can discover the fixture entry.
        applications = Path(environment["XDG_DATA_HOME"]) / "applications"
        applications.mkdir(parents=True)
        desktop_launch_log = Path(temporary) / "desktop-launch.json"
        desktop_launch_dir = Path(temporary) / "desktop launch directory"
        desktop_launch_dir.mkdir()
        desktop_entry = applications / "com.windowwarp.other-smoke.desktop"
        fixture_source = Path(__file__).with_name("live.py").resolve()
        desktop_entry.write_text(f'[Desktop Entry]\nType=Application\nName=Window Warp launch fixture\nExec=/usr/bin/env QT_QPA_PLATFORM=wayland WARP_LAUNCH_LOG={desktop_launch_log} {sys.executable} "{fixture_source}" --workspace-single %U\nPath={desktop_launch_dir}\n')
    driver = subprocess.Popen([driver_binary, f"--port={port}", "--host=127.0.0.1"], env=environment, stdout=log, stderr=log, start_new_session=True)
    fixture = None
    radial_fixture = None
    hold_fixture = None
    key_monitor = None
    browser_fixture = None
    other_browser_fixture = None
    terminal_fixture = None
    terminal_launched = []
    launched_pids = set()
    tray_host = None
    try:
        if "--tray" in sys.argv:
            tray_host = subprocess.Popen([sys.executable, str(Path(__file__).with_name("tray_host.py"))],
                env=environment, stdout=log, stderr=log)
            from gi.repository import Gio, GLib
            tray_bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            deadline = time.monotonic()+5
            while time.monotonic()<deadline:
                assert tray_host.poll() is None, "Private tray protocol host exited; inspect gui.log"
                try:
                    watcher_pid = tray_bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
                        "org.freedesktop.DBus", "GetConnectionUnixProcessID",
                        GLib.Variant("(s)", ("org.kde.StatusNotifierWatcher",)), None,
                        Gio.DBusCallFlags.NONE, 1000, None).unpack()[0]
                except GLib.Error as error:
                    if Gio.DBusError.get_remote_error(error) != "org.freedesktop.DBus.Error.NameHasNoOwner": raise
                    time.sleep(0.05)
                    continue
                assert watcher_pid == tray_host.pid, "Tray watcher must belong to this fixture's helper"
                break
            else:
                raise AssertionError("Private tray protocol host did not acquire its bus name")
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
        new_item["launch"] = {"kind": "executable", "program": sys.executable, "args": [fixture_script, "--workspace-single"], "newWindow": True, "workingDirectory": ""}
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
        state_item = json.loads(json.dumps(next(item for item in captured["items"] if item["window"]["title"] == "WARP-TEST-D")))
        for horizontal, vertical, fullscreen in [(True, False, False), (True, True, False), (False, False, True), (False, False, False)]:
            state_item["window"].update({"maximizedHorizontal": horizontal, "maximizedVertical": vertical, "fullscreen": fullscreen})
            state_profile = dict(captured, id="fixture-state", items=[state_item])
            invoke("save_workspaces", {"store": {"version": 1, "profiles": [state_profile]}})
            result = invoke("restore_workspace", {"id": state_profile["id"]})
            assert result[0]["restored"], {"restore":result,"desired":(horizontal, vertical, fullscreen),"actual":[{k:w[k] for k in ["id","title","maximizedHorizontal","maximizedVertical","fullscreen"]} for w in invoke("get_windows") if w["pid"] == fixture.pid or w["pid"] in launched_pids]}
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
        if "--desktop-entry" in sys.argv:
            assert all(i["launch"]["kind"] == "desktop-entry" and i["launch"]["program"] == "com.windowwarp.other-smoke" for i in captured["items"]), captured
            desktop_item = json.loads(json.dumps(captured["items"][0]))
            desktop_item["launch"].update({"newWindow": True, "args": ["https://example.test/a%20b?x=1&y=2", "file:///tmp/warp%20document.txt"]})
            desktop_profile = dict(captured, id="desktop-launch", items=[desktop_item])
            desktop_store = {"version": 1, "profiles": [desktop_profile]}
            invoke("save_workspaces", {"store": desktop_store})
            before = {w["id"] for w in invoke("get_windows")}
            result = invoke("restore_workspace", {"id": desktop_profile["id"]})
            fresh = [w for w in invoke("get_windows") if w["id"] not in before and w["desktopId"] == "com.windowwarp.other-smoke"]
            for w in fresh:
                args = Path(f"/proc/{w['pid']}/cmdline").read_bytes().split(b"\0")
                if fixture_script.encode() in args and b"--workspace-single" in args:
                    launched_pids.add(w["pid"])
            assert len(fresh) == 1 and result[0]["restored"] and result[0]["launched"], result
            launched_data = json.loads(desktop_launch_log.read_text())
            # GIO resolves local file URIs to native paths for an entry that
            # does not opt into GIO's URI-only application metadata.
            assert launched_data == {"args": ["--workspace-single", desktop_item["launch"]["args"][0], "/tmp/warp document.txt"], "cwd": str(desktop_launch_dir)}, launched_data
            assert fresh[0]["rect"] == desktop_item["window"]["rect"]
            report["checks"].append("native KDE desktop entry capture and activation preserve URL arguments, entry working directory and saved placement")
            desktop_item["window"] = fresh[0]
            desktop_item["launch"]["newWindow"] = False
            invoke("save_workspaces", {"store": desktop_store})
            result = invoke("restore_workspace", {"id": desktop_profile["id"]})
            assert result[0]["restored"] and not result[0]["launched"], result
            report["checks"].append("desktop entry identity reuses the existing native window")
            desktop_item["launch"].update({"newWindow": True, "program": "org.windowwarp.missing-entry"})
            invoke("save_workspaces", {"store": desktop_store})
            result = invoke("restore_workspace", {"id": desktop_profile["id"]})
            assert not result[0]["restored"] and not result[0]["launched"] and "not installed" in result[0]["error"], result
            report["checks"].append("missing desktop entry reports an activation error without starting a window")
            invoke("save_workspaces", {"store": {"version": 1, "profiles": [captured, launched]}})
        if "--dbus-desktop-entry" in sys.argv:
            test_dbus_desktop_entry(environment, captured, report)
            invoke("save_workspaces", {"store": {"version": 1, "profiles": [captured, launched]}})
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
            hold_input = output / "hold-input.jsonl"
            hold_fixture = subprocess.Popen([sys.executable, fixture_script, "--hold"], env=fixture_env | {"WARP_INPUT_LOG":str(hold_input)}, stdout=log, stderr=log)
            for _ in range(30):
                hold_windows = [w for w in invoke("get_windows") if w["pid"] == hold_fixture.pid]
                if len(hold_windows) == 1:
                    break
                time.sleep(0.1)
            assert len(hold_windows) == 1, "Owned hold fixture did not map"
            state_item = json.loads(json.dumps(state_item))
            state_item["window"] = hold_windows[0]
            config = invoke("get_config")
            hold_index = len(config["bindings"]) - 1
            config["bindings"][hold_index]["appMatch"] = state_item["window"]["appId"]
            config["bindings"][5]["shortcut"] = "Ctrl+Alt+Shift+P"
            config["bindings"][1].update({"action":"focus-app", "appMatch":state_item["window"]["appId"]})
            config["bindings"][hold_index].update({"shortcut":"Ctrl+Alt+Shift+J", "mainMonitorAction":"focus-last"})
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
                if "--pointer-denied" in sys.argv:
                    keys.pointer(100,100)
                chord(36)  # J
                time.sleep(0.08)
                assert not owned()["active"], "Tap ran before release"
                keys.key(29,False)
                wait_window(lambda w:w["active"],"modifier-first release taps")
                assert owned()["rect"] == initial
                keys.release()
                report["checks"].append("Wayland key events deliver app tap on modifier-first release")

                if "--pointer" in sys.argv or "--pointer-denied" in sys.argv:
                    def read_pointer():
                        return json.loads(subprocess.check_output([sys.executable, str(Path(__file__).with_name("pointer_probe.py"))], text=True))
                    def wait_pointer(expected, label):
                        # Window placement and the app's pointer worker finish independently.
                        deadline = time.monotonic() + 5
                        samples = []
                        while time.monotonic() < deadline:
                            actual = read_pointer()
                            samples.append(actual)
                            if actual == expected:
                                return
                            time.sleep(0.1)
                        diagnostic = {"stage":label, "expected":expected, "samples":samples,
                            "message":evaluate("return document.querySelector('#message').textContent")}
                        (output / "pointer-failure.json").write_text(json.dumps(diagnostic, indent=2))
                        raise AssertionError(f"{label}: {diagnostic}")
                if "--pointer-denied" in sys.argv:
                    wait_for("return document.querySelector('#message').textContent.includes('pointer access')")
                    assert read_pointer() == {"x":100,"y":100}
                    report["checks"].append("KDE rejects undeclared pointer access, leaves cursor unchanged and shows the failure")
                if "--pointer" in sys.argv:
                    center = {"x":round(area["x"]+area["width"]/2),"y":round(area["y"]+area["height"]/2)}
                    wait_pointer(center, "App pull must center on main")
                    report["checks"].append("native Wayland app pull centers pointer with KDE desktop capability checks enabled")
                    invoke("set_enabled", {"enabled":False})
                    pointer_config = invoke("get_config")
                    saved_config = json.loads(json.dumps(pointer_config))
                    for index, action in enumerate(["push-right-center","push-left-center","pull"]):
                        pointer_config["bindings"].append({"label":action,"action":action,"shortcut":f"Ctrl+Alt+Shift+F{8+index}","enabled":True,"appMatch":""})
                    invoke("save_config", {"config":pointer_config})
                    invoke("set_enabled", {"enabled":True})
                    reset_window()
                    keys.pointer(100,100)
                    chord(66); keys.release()  # F8: real centered-push shortcut
                    moved = wait_window(lambda w:w["monitor"] != target["monitor"],"center push changes monitor")
                    expected = {"x":round(moved["workArea"]["x"]+moved["workArea"]["width"]/2),"y":round(moved["workArea"]["y"]+moved["workArea"]["height"]/2)}
                    wait_pointer(expected, "right-center push")
                    chord(68); keys.release()  # F10: history pull
                    wait_window(lambda w:w["rect"] == initial,"pull restores source placement")
                    wait_pointer(center, "history pull centers on main")
                    chord(67); keys.release()  # F9
                    wait_window(lambda w:w["monitor"] != target["monitor"],"left center push wraps")
                    wait_pointer(expected, "left-center push")
                    chord(68); keys.release()  # F10: history pull
                    wait_window(lambda w:w["rect"] == initial,"second pull restores source placement")
                    wait_pointer(center, "history pull centers on main")
                    report["checks"].append("native KDE left/right centered push and history pull move pointer to the correct monitor")
                    invoke("set_enabled", {"enabled":False})
                    invoke("save_config", {"config":saved_config})
                    invoke("set_enabled", {"enabled":True})

                if "--retile" in sys.argv:
                    invoke("set_enabled", {"enabled":False})
                    saved_config = invoke("get_config")
                    retile_config = json.loads(json.dumps(saved_config))
                    for index, action in enumerate(["push-right","push-left","pull","toggle-maximize"]):
                        retile_config["bindings"].append({"label":action,"action":action,"shortcut":f"Ctrl+Alt+Shift+F{8+index}","enabled":True,"appMatch":""})
                    retile_config["bindings"].append({"label":"Existing Super C","action":"tile-up","shortcut":"Super+C","enabled":True,"appMatch":""})
                    invoke("save_config", {"config":retile_config})
                    invoke("set_enabled", {"enabled":True})

                    def retile_keys_assigned():
                        return subprocess.check_output(["gdbus","call","--session","--dest","org.kde.kglobalaccel","--object-path","/kglobalaccel","--method","org.kde.KGlobalAccel.shortcut",json.dumps(["kwin","window-warp-retile-X","",""])],text=True)

                    def wait_retile(assigned):
                        deadline = time.monotonic()+3
                        while time.monotonic() < deadline:
                            value = retile_keys_assigned()
                            if ("88" in value) == assigned:
                                return
                            time.sleep(0.02)
                        raise AssertionError(f"Retile key reservation expected {assigned}: {value}")

                    def push_ready(key=66):
                        chord(key); keys.release()
                        wait_retile(True)
                        return owned()

                    def press_retile(key, meta=False):
                        if meta: keys.key(125,True)
                        keys.key(key,True); keys.release()

                    def pause_reload_resume():
                        chord(25); keys.release()
                        wait_for("return document.querySelector('#status').textContent.includes('Paused')")
                        invoke("save_config", {"config":retile_config})
                        chord(25); keys.release()
                        wait_for("return document.querySelector('#status').classList.contains('active')")

                    reset_window()
                    chord(87); keys.release()  # F11: maximize through the shortcut script.
                    wait_window(lambda w:w["maximizedHorizontal"] and w["maximizedVertical"],"maximize before history retention check")
                    push_ready()
                    pause_reload_resume()
                    wait_retile(False)
                    reset_window()  # Workspace restore goes through the persistent control script.
                    chord(68); keys.release()  # F10: history must still contain the maximized source.
                    wait_window(lambda w:w["maximizedHorizontal"] and w["maximizedVertical"] and w["monitor"] == target["monitor"],"history survives pause and configuration reload")
                    chord(87); keys.release()
                    wait_window(lambda w:not w["maximizedHorizontal"] and not w["maximizedVertical"] and w["rect"] == initial,"saved floating geometry survives pause and mixed action sources")
                    report["checks"].append("native KDE pause/configuration reload preserve push history and maximize geometry across shortcut and workspace-control actions")

                    invoke_shortcut("open-workspaces")
                    wait_window(lambda w:not w["active"],"editor is previous focus before retention check")
                    chord(36); time.sleep(0.08); keys.release()
                    wait_window(lambda w:w["active"],"gesture app pull remembers previous editor focus")
                    pause_reload_resume()
                    chord(36); time.sleep(0.08); keys.release()
                    wait_window(lambda w:not w["active"],"gesture focus-last survives pause and configuration reload")
                    wait_for("return document.hasFocus()")
                    report["checks"].append("native KDE gesture focus-last retains its previous target across pause and configuration reload")

                    reset_window()
                    moved = push_ready()
                    destination = moved["workArea"]
                    left = dict(destination,width=destination["width"]//2)
                    right = dict(destination,x=destination["x"]+destination["width"]//2,width=destination["width"]-destination["width"]//2)
                    invoke_shortcut("open-workspaces")
                    wait_window(lambda w:not w["active"],"change focus after push")
                    press_retile(45)  # X
                    wait_window(lambda w:w["active"] and w["rect"] == left,"X tiles the last pushed window after focus changes")
                    wait_retile(False)
                    press_retile(46)  # C cannot consume the same push twice.
                    assert owned()["rect"] == left
                    report["checks"].append("native KDE X retiles the pushed window after focus changes and consumes the temporary keys once")

                    reset_window(); push_ready()
                    press_retile(46,True)  # Existing Super+C binding is overridden for this push.
                    wait_window(lambda w:w["rect"] == right,"Super+C retiles right instead of its usual binding")
                    wait_retile(False)
                    press_retile(46,True)
                    wait_window(lambda w:w["rect"] == dict(destination,height=destination["height"]//2),"existing Super+C binding resumes after consumption")
                    report["checks"].append("native KDE Super+C temporarily overrides an existing binding and restores its normal action")

                    reset_window(); moved = push_ready()
                    keys.key(29,True); keys.key(45,True); keys.release()  # Ctrl+X is ordinary input.
                    assert owned()["rect"] == moved["rect"]
                    press_retile(45,True)
                    wait_window(lambda w:w["rect"] == left,"Super+X tiles left after an unrelated modified key")
                    wait_retile(False)
                    report["checks"].append("native KDE Super+X tiles left and Ctrl+X does not consume a pending retile")

                    reset_window(); moved = push_ready()
                    time.sleep(1.1)
                    wait_retile(False)
                    press_retile(45)
                    assert owned()["rect"] == moved["rect"]
                    report["checks"].append("native KDE retile expires and releases plain typing keys after one second")

                    reset_window(); push_ready()
                    time.sleep(0.55)
                    moved = push_ready(67)
                    time.sleep(0.55)
                    press_retile(46)
                    work = moved["workArea"]
                    expected = dict(work,x=work["x"]+work["width"]//2,width=work["width"]-work["width"]//2)
                    wait_window(lambda w:w["rect"] == expected,"second push refreshes the one-second retile deadline")
                    wait_retile(False)
                    report["checks"].append("native KDE consecutive pushes replace the pending retile and refresh its deadline")

                    reset_window(); push_ready()
                    # Fault injection stays in this private compositor. Keep the
                    # control action registered but withhold its reply, so window
                    # I/O waits for the normal production timeout without blocking
                    # KWin or its input loop. Restore the original script afterward.
                    control_source, = Path(temporary).glob("data/**/kwin-control.js")
                    stalled_source = Path(temporary) / "stalled-control.js"
                    stalled_source.write_text("registerShortcut('window-warp-control-dispatch','Window Warp: delayed fixture','',function() {});")
                    def replace_control(source):
                        subprocess.run(["qdbus","org.kde.KWin","/Scripting","org.kde.kwin.Scripting.unloadScript","window-warp-control-session"],check=True,stdout=log,stderr=log)
                        subprocess.run(["qdbus","org.kde.KWin","/Scripting","org.kde.kwin.Scripting.loadScript",str(source),"window-warp-control-session"],check=True,stdout=log,stderr=log)
                        subprocess.run(["qdbus","org.kde.KWin","/Scripting","org.kde.kwin.Scripting.start"],check=True,stdout=log,stderr=log)
                    try:
                        replace_control(stalled_source)
                        hold_input.write_text("")
                        press_retile(45)
                        wait_retile(False)  # Must complete before the five-second reply timeout.
                        press_retile(46)
                        deadline = time.monotonic()+1
                        while time.monotonic()<deadline and not any(json.loads(line)["text"].lower()=="c" for line in hold_input.read_text().splitlines()):
                            time.sleep(0.02)
                        assert any(json.loads(line)["text"].lower()=="c" for line in hold_input.read_text().splitlines()), "ordinary typing must resume while window I/O is still waiting"
                        wait_for("return document.querySelector('#message').textContent.includes('KWin did not complete')",timeout=8)
                        report["checks"].append("native KDE releases consumed retile keys before a stalled window reply and ordinary typing resumes during the wait")
                    finally:
                        replace_control(control_source)

                    reset_window(); moved = push_ready()
                    invoke("set_enabled", {"enabled":False})
                    wait_retile(False)
                    invoke("set_enabled", {"enabled":True})
                    press_retile(45)
                    assert owned()["rect"] == moved["rect"]
                    report["checks"].append("native KDE pause cancels pending retile and resume does not revive it")
                    invoke("set_enabled", {"enabled":False})
                    for binding in retile_config["bindings"]:
                        if binding["action"] == "toggle-pause": binding["shortcut"] = "Super+X"
                    invoke("save_config", {"config":retile_config})
                    invoke("set_enabled", {"enabled":True})
                    reset_window(); moved = push_ready()
                    press_retile(45,True)
                    wait_for("return document.querySelector('#status').textContent.includes('Paused')")
                    wait_retile(False)
                    assert owned()["rect"] == moved["rect"]
                    report["checks"].append("native KDE an explicitly configured pause key takes precedence over pending retile")
                    invoke("save_config", {"config":saved_config})
                    invoke("set_enabled", {"enabled":True})

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

                if "--companion-loss" in sys.argv:
                    saved_hold = dict(config["settings"])
                    config["settings"].update(holdTileEnabled=True, holdDelayMs=1000)
                    invoke("save_config", {"config":config})
                    invoke("set_enabled", {"enabled":True})
                    reset_window()
                    chord(36)
                    time.sleep(0.08)
                    subprocess.run(["qdbus", "org.kde.KWin", "/Plugins",
                        "org.kde.KWin.Plugins.UnloadPlugin", "windowwarp_companion"],
                        check=True, capture_output=True, text=True, timeout=5)
                    wait_for("return document.querySelector('#status').textContent.includes('Paused')")
                    time.sleep(1.1)
                    keys.release()
                    assert owned()["rect"] == initial, "Companion loss must cancel the pending hold"
                    assert not kwin_loaded(), "Companion loss must pause ordinary actions too"
                    invoke("set_enabled", {"enabled":True})
                    reset_window()
                    keys.pointer(area["x"]+20, area["y"]+20)
                    chord(36)
                    wait_window(lambda w:w["rect"] == dict(area,width=area["width"]//2),
                        "explicit enable reloads the companion and accepts a fresh hold")
                    keys.release()
                    invoke("set_enabled", {"enabled":False})
                    config["settings"] = saved_hold
                    invoke("save_config", {"config":config})
                    report["checks"].append("native companion loss cancels held input, pauses the app, and explicit enable restores gestures")

                if "--resume-held" in sys.argv:
                    config["settings"]["holdTileEnabled"] = True
                    config["bindings"].append(dict(config["bindings"][hold_index], shortcut="Ctrl+Alt+Shift+L", label="Unheld gesture"))
                    invoke("save_config", {"config":config})
                    invoke("set_enabled", {"enabled":True})
                    reset_window()
                    chord(36)
                    time.sleep(0.08)
                    invoke("set_enabled", {"enabled":False})
                    names = subprocess.check_output(["qdbus", "org.kde.kglobalaccel", "/component/kwin", "org.kde.kglobalaccel.Component.shortcutNames"], text=True).splitlines()
                    assert not any(name.startswith("window-warp-gesture-") for name in names), "Pause must release script registrations; the native companion retains physical guards"
                    assert not kwin_loaded(), "Pause must still unload ordinary window actions"
                    invoke("set_enabled", {"enabled":True})
                    time.sleep(1.4)
                    keys.release()
                    time.sleep(0.15)
                    assert owned()["active"] and owned()["rect"] == initial, "Resuming while the chord remains held must not restart a cancelled gesture"
                    invoke("set_enabled", {"enabled":False})
                    invoke("set_enabled", {"enabled":True})
                    reset_window()
                    keys.pointer(area["x"]+20, area["y"]+20)
                    chord(36)
                    wait_window(lambda w:w["rect"] == dict(area,width=area["width"]//2), "a fresh press after cancellation still works")
                    keys.release()
                    reset_window()
                    invoke("set_enabled", {"enabled":False})
                    report["checks"].append("KDE pause/resume cancels held input, releases script registrations, and accepts a fresh press")

                if "--radial" in sys.argv:
                    radial_fixture = subprocess.Popen([sys.executable, fixture_script, "--radial"], env=fixture_env, stdout=log, stderr=log)
                    def radial_windows():
                        return sorted([w for w in invoke("get_windows") if w["pid"] == radial_fixture.pid], key=lambda w:(w["title"].lower(),w["id"]))
                    deadline = time.monotonic() + 5
                    while len(radial_windows()) != 9 and time.monotonic() < deadline:
                        time.sleep(0.1)
                    choices = radial_windows()
                    assert len(choices) == 9, "Radial fixture must map nine owned windows"
                    config["settings"].update({"holdMode":"radial", "holdTileEnabled":True})
                    old_match = config["bindings"][hold_index]["appMatch"]
                    radial_match = choices[0]["appId"]
                    config["bindings"][hold_index]["appMatch"] = radial_match
                    config["bindings"][1]["appMatch"] = radial_match
                    invoke("save_config", {"config":config})
                    invoke("set_enabled", {"enabled":True})
                    def radial_wait(predicate, description):
                        deadline = time.monotonic()+5
                        while time.monotonic() < deadline:
                            value = invoke("radial_view")
                            if predicate(value):
                                return value
                            time.sleep(0.05)
                        raise AssertionError(f"{description}: {value}")
                    def radial_focus_first():
                        for _ in range(12):
                            if radial_windows()[0]["active"]:
                                return
                            invoke_shortcut("focus-app")
                            time.sleep(0.05)
                        raise AssertionError("Cannot focus first owned radial window")
                    cx, cy = area["x"]+640, area["y"]+360
                    radial_focus_first()
                    keys.pointer(cx,cy)
                    chord(36)
                    view = radial_wait(lambda v:v and len(v["labels"])==8,"radial opens with eight slots")
                    assert view["labels"] == [w["title"] for w in choices[:8]]
                    keys.pointer(cx+75,cy-75)
                    radial_wait(lambda v:v and v["selected"]==1,"second angular slot selected")
                    assert not radial_windows()[1]["active"], "Selection must wait for release"
                    main_handle = request("GET", f"/session/{session}/window")
                    for handle in request("GET", f"/session/{session}/window/handles"):
                        request("POST", f"/session/{session}/window", {"handle":handle})
                        if "radial.html" in request("GET", f"/session/{session}/url"):
                            image = request("GET", f"/session/{session}/screenshot")
                            (output / "window-warp-radial-kde.png").write_bytes(base64.b64decode(image))
                            break
                    request("POST", f"/session/{session}/window", {"handle":main_handle})
                    keys.release()
                    radial_wait(lambda v:v is None,"radial closes on release")
                    deadline = time.monotonic()+5
                    while not radial_windows()[1]["active"] and time.monotonic()<deadline:
                        time.sleep(0.05)
                    assert radial_windows()[1]["active"]
                    report["checks"].append("native KDE radial displays eight of nine stable windows and applies the selected slot on release")
                    radial_focus_first()
                    original_rects = [w["rect"] for w in radial_windows()]
                    keys.pointer(cx,cy); chord(36)
                    radial_wait(lambda v:v and v["selected"] is None,"radial starts in dead zone")
                    keys.release()
                    radial_wait(lambda v:v is None,"dead-zone release closes radial")
                    assert [w["rect"] for w in radial_windows()] == original_rects
                    assert not radial_windows()[1]["active"]
                    report["checks"].append("native KDE radial dead-zone release cancels without moving windows")
                    radial_focus_first()
                    keys.pointer(cx,cy); chord(36)
                    radial_wait(lambda v:v is not None,"radial opens before Escape")
                    keys.pointer(cx+75,cy-75)
                    radial_wait(lambda v:v and v["selected"]==1,"selected before Escape")
                    keys.key(1,True); keys.key(1,False)
                    radial_wait(lambda v:v is None,"native Escape closes radial")
                    keys.release()
                    assert not radial_windows()[1]["active"]
                    report["checks"].append("native KDE Escape cancels selected radial without acting on key release")
                    radial_focus_first()
                    keys.pointer(cx,cy); chord(36)
                    radial_wait(lambda v:v is not None,"radial opens before focus change")
                    invoke_shortcut("focus-app")
                    radial_wait(lambda v:v is None,"changing focus dismisses radial")
                    cancelled_windows = radial_windows()
                    keys.release()
                    time.sleep(0.15)
                    assert [(w["id"],w["active"],w["rect"]) for w in radial_windows()] == [(w["id"],w["active"],w["rect"]) for w in cancelled_windows]
                    report["checks"].append("native KDE focus loss cancels the picker before key release without a later selection")
                    radial_focus_first()
                    keys.pointer(cx,cy); chord(36)
                    radial_wait(lambda v:v is not None,"radial opens before pause")
                    invoke("set_enabled", {"enabled":False})
                    radial_wait(lambda v:v is None,"pause closes radial")
                    invoke("set_enabled", {"enabled":True})
                    time.sleep(0.8)
                    assert invoke("radial_view") is None
                    keys.release()
                    assert [w["rect"] for w in radial_windows()] == original_rects
                    report["checks"].append("native KDE pause closes radial and held input cannot reopen it after resume")
                    invoke("set_enabled", {"enabled":False})
                    config["settings"]["holdMode"] = "tile"
                    config["bindings"][hold_index]["appMatch"] = old_match
                    config["bindings"][1]["appMatch"] = old_match
                    invoke("save_config", {"config":config})
                    radial_fixture.terminate(); radial_fixture.wait(timeout=5)

                if "--reassign-native" in sys.argv:
                    def shortcut_names():
                        return set(subprocess.check_output(["qdbus", "org.kde.kglobalaccel", "/component/kwin", "org.kde.kglobalaccel.Component.shortcutNames"], text=True).splitlines())
                    foreign_shortcuts = {name for name in shortcut_names() if not name.startswith("window-warp-")}
                    invoke("set_enabled", {"enabled":True})
                    reset_window()
                    chord(36)
                    time.sleep(0.08)
                    invoke("set_enabled", {"enabled":False})
                    config["bindings"][hold_index]["shortcut"] = "Ctrl+Alt+Shift+K"
                    config["bindings"][1].update({"shortcut":"Ctrl+Alt+Shift+J", "action":"tile-left", "appMatch":""})
                    invoke("save_config", {"config":config})
                    invoke("set_enabled", {"enabled":True})
                    time.sleep(0.8)
                    assert owned()["rect"] == initial, "Editing a held chord must not revive its old or new action"
                    keys.release()
                    # Wait for the new action to own the key after guard release.
                    action_id = "window-warp-tile-left-1-Ctrl-Alt-Shift-J"
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        assigned = subprocess.check_output(["gdbus", "call", "--session", "--dest", "org.kde.kglobalaccel", "--object-path", "/kglobalaccel", "--method", "org.kde.KGlobalAccel.shortcut", json.dumps(["kwin",action_id,"",""])], text=True)
                        if re.search(r"[1-9]", assigned):
                            break
                        time.sleep(0.05)
                    else:
                        raise AssertionError({"message":"Reassigned action did not acquire the released key", "assigned":assigned, "ownedIds":sorted(name for name in shortcut_names() if name.startswith("window-warp-")), "status":invoke("get_status"), "config":invoke("get_config"), "scripts":{"main":kwin_loaded(),"pause":kwin_loaded("window-warp-pause-session")}, "page":evaluate("return document.body.innerText")})
                    chord(36)
                    keys.release()
                    wait_window(lambda w:w["rect"] == dict(area,width=area["width"]//2), "reassigned key reaches its new action")
                    invoke("set_enabled", {"enabled":False})
                    after = shortcut_names()
                    assert foreign_shortcuts <= after, "Cleanup removed another app's shortcut"
                    assert "window-warp-control-dispatch" in after
                    assert any(name.startswith("window-warp-toggle-pause-") for name in after)
                    assert not any(name.startswith(("window-warp-hold-", "window-warp-gesture-")) for name in after)
                    report["checks"].append("KDE native key ownership follows reassignment between actions without removing other shortcuts")
            evaluate("location.reload(); return true;")
            wait_for(f"return document.querySelectorAll('.binding').length === {len(config['bindings'])} && !document.querySelector('#toggle').disabled")
            evaluate("document.querySelector('#hold-delay').closest('details').open=true; document.querySelector('#hold-enabled').scrollIntoView({block:'center'}); return true;")
            screenshot = request("GET", f"/session/{session}/screenshot")
            (output / "window-warp-hold-kde.png").write_bytes(base64.b64decode(screenshot))
        if "--firefox" in sys.argv:
            # Run this option only in nested.sh's isolated compositor/session bus.
            assert os.environ.get("WAYLAND_DISPLAY") == "warp-test", "Firefox test requires the isolated compositor"
            firefox_config = invoke("get_config")
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
            no_profile_args = "--firefox-no-profile-args" in sys.argv
            other_profile = Path(temporary) / "other-firefox-profile"
            if no_profile_args:
                other_profile.mkdir()
                (other_profile / "user.js").write_text((browser_profile / "user.js").read_text())
                registry = Path(environment["HOME"]) / ".mozilla/firefox"
                registry.mkdir(parents=True)
                (registry / "profiles.ini").write_text(
                    f"[Profile0]\nName=Owned first\nIsRelative=0\nPath={browser_profile}\n"
                    f"[Profile1]\nName=Owned other\nIsRelative=0\nPath={other_profile}\n")
            # Mozilla's restart environment selects the profile without putting
            # its identity in process argv. Keep these variables off the app and
            # subsequent remote-control launches.
            initial_env = browser_env | ({"XRE_PROFILE_PATH":str(browser_profile), "XRE_PROFILE_LOCAL_PATH":str(browser_profile)} if no_profile_args else {})
            browser_fixture = subprocess.Popen(["firefox", "--new-instance", *([] if no_profile_args else ["--profile", str(browser_profile)]), urls[0]], env=initial_env, stdout=log, stderr=log, start_new_session=True)
            first_loaded = False
            for _ in range(60):
                first_loaded = any(w["pid"] == browser_fixture.pid and "Warp First Firefox fixture" in w["title"] for w in invoke("get_windows"))
                if first_loaded:
                    break
                time.sleep(0.5)
            assert first_loaded, "First owned Firefox page did not finish loading"
            subprocess.run(["firefox", "--profile", str(browser_profile), "--new-tab", urls[1]], env=browser_env, stdout=log, stderr=log, check=True, timeout=15)
            if no_profile_args:
                other_env = browser_env | {"XRE_PROFILE_PATH":str(other_profile), "XRE_PROFILE_LOCAL_PATH":str(other_profile)}
                other_browser_fixture = subprocess.Popen(["firefox", "--new-instance", urls[1]], env=other_env, stdout=log, stderr=log, start_new_session=True)
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    if any(w["pid"] == other_browser_fixture.pid and "Warp Second Firefox fixture" in w["title"] for w in invoke("get_windows")) and (other_profile / "sessionstore-backups/recovery.jsonlz4").exists():
                        break
                    assert other_browser_fixture.poll() is None, "Owned other-profile Firefox exited"
                    time.sleep(0.2)
                else:
                    diagnostic = {"error":"Concurrent no-argv Firefox profile did not write its session",
                        "pid":other_browser_fixture.pid, "windows":invoke("get_windows"),
                        "argv":Path(f"/proc/{other_browser_fixture.pid}/cmdline").read_bytes().decode().split("\0"),
                        "files":[str(p.relative_to(other_profile)) for p in other_profile.glob("*")],
                        "sessionFiles":[p.name for p in (other_profile / "sessionstore-backups").glob("*")]}
                    (output / "firefox-no-profile-args-startup.json").write_text(json.dumps(diagnostic, indent=2))
                    raise AssertionError(diagnostic)
                receipt = []
                for process, profile in [(browser_fixture,browser_profile), (other_browser_fixture,other_profile)]:
                    argv = Path(f"/proc/{process.pid}/cmdline").read_bytes().rstrip(b"\0").split(b"\0")
                    assert not any(arg.lower() in [b"--profile",b"-profile",b"-p"] or str(profile).encode() in arg for arg in argv), argv
                    receipt.append({"pid":process.pid,"profile":str(profile),"argv":[arg.decode() for arg in argv]})
                (output / "firefox-no-profile-args.json").write_text(json.dumps(receipt, indent=2))
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
            if no_profile_args:
                report["checks"].append("live profile-lock ownership captures the correct Firefox session despite concurrent identical titles and no profile arguments")
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
            if not no_profile_args:
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
            if no_profile_args:
                # A stale saved window id must not override proven profile
                # ownership even when the wrong profile has the same title.
                browser_capture["items"][0]["window"]["id"] = other_windows[0]["id"]
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
            if no_profile_args:
                report["checks"].append("no-argv Firefox profile ownership rejects a concurrent same-title window even with a stale saved window id")
                browser_capture["items"][0]["window"]["id"] = next(w["id"] for w in after if w["pid"] == browser_fixture.pid and w["rect"] == browser_capture["items"][0]["window"]["rect"])
            if "--firefox-tiles" in sys.argv:
                from wayland_input import Input
                saved_config = invoke("get_config")
                tile_config = json.loads(json.dumps(saved_config))
                tile_config["bindings"] = [dict(label=action,action=action,shortcut=f"Ctrl+Alt+Shift+F{i+1}",enabled=True,appMatch=browser_capture["items"][0]["window"]["appId"] if action == "focus-app" else "")
                    for i,action in enumerate(["focus-app","toggle-maximize","tile-left","tile-right","tile-up","tile-down","push-right"])]
                app_binding = dict(label="Browser pull",action="pull-app",shortcut="Ctrl+Alt+Shift+J",enabled=True,appMatch=browser_capture["items"][0]["window"]["appId"],mainMonitorAction="burner",burnerLayout="tile-left")
                tile_config["bindings"].append(app_binding)
                tile_config["settings"].update(mainMonitor=1,burnerMonitor=2,holdDelayMs=150,holdTileEnabled=True,holdMode="tile")
                fixture_id = browser_capture["items"][0]["window"]["id"]
                tile_profile = json.loads(json.dumps(browser_capture))
                tile_profile.update(id="browser-tile-fixture",name="Browser tile fixture")
                tile_profile["items"][0]["launch"]["newWindow"] = False
                desired = tile_profile["items"][0]["window"]
                desired.update(monitor=1,monitorName="",workArea=source_area,rect=dict(x=source_area["x"]+150,y=source_area["y"]+100,width=700,height=500))

                def browser_window():
                    return next(w for w in invoke("get_windows") if w["id"] == fixture_id and w["pid"] == browser_fixture.pid)

                def wait_browser(predicate, description):
                    deadline = time.monotonic()+5
                    while time.monotonic()<deadline:
                        current = browser_window()
                        if predicate(current): return current
                        time.sleep(0.05)
                    raise AssertionError(f"{description}: {current}")

                def configure_tiles():
                    invoke("set_enabled", {"enabled":False})
                    invoke("save_config", {"config":tile_config})
                    invoke("set_enabled", {"enabled":True})

                def prepare_browser(fullscreen, maximized=True):
                    maximized = maximized and not fullscreen
                    desired.update(maximizedHorizontal=maximized,maximizedVertical=maximized,fullscreen=fullscreen,minimized=False)
                    invoke("save_workspaces", {"store":{"version":1,"profiles":[tile_profile]}})
                    result = invoke("restore_workspace", {"id":tile_profile["id"]})
                    assert result[0]["restored"] and not result[0]["launched"], result
                    # Every match in this isolated desktop belongs to one of our
                    # two profile processes; focus cycling cannot target a user app.
                    matches = [w for w in invoke("get_windows") if w["appId"] == app_binding["appMatch"]]
                    assert all(w["pid"] in [browser_fixture.pid,other_browser_fixture.pid] for w in matches)
                    for _ in range(len(matches)+1):
                        if browser_window()["active"]: break
                        invoke_shortcut("focus-app")
                    return wait_browser(lambda w:w["active"] and w["fullscreen"] == fullscreen and (fullscreen or (w["maximizedHorizontal"] == maximized and w["maximizedVertical"] == maximized)),"prepare owned Firefox state")

                def tile_rect(area, direction):
                    result = area.copy()
                    axis,size = ("y","height") if direction in ["tile-up","tile-down"] else ("x","width")
                    half = result[size]//2
                    if direction in ["tile-right","tile-down"]:
                        result[axis] += half; result[size] -= half
                    else: result[size] = half
                    return result

                def delayed_action(action):
                    assert browser_fixture.poll() is None and os.getpgid(browser_fixture.pid) == browser_fixture.pid
                    # Stop only the process group created above for this private
                    # profile. KWin and Window Warp remain responsive. Always
                    # resume it, even when dispatch raises or an assertion fails.
                    os.killpg(browser_fixture.pid,signal.SIGSTOP)
                    try:
                        action()
                        time.sleep(0.3)
                    finally:
                        os.killpg(browser_fixture.pid,signal.SIGCONT)

                def assert_tile(expected, label):
                    wait_browser(lambda w:not w["fullscreen"] and not w["maximizedHorizontal"] and not w["maximizedVertical"] and w["rect"] == expected,label)
                    time.sleep(0.15)
                    settled = browser_window()
                    assert settled["rect"] == expected and not any(settled[k] for k in ["fullscreen","maximizedHorizontal","maximizedVertical"]), "late client configure replaced the tile or state"

                overlap_monitor = None
                try:
                    configure_tiles()
                    for fullscreen in [False,True]:
                        for direction in ["tile-left","tile-right","tile-up","tile-down"]:
                            original = prepare_browser(fullscreen)
                            delayed_action(lambda:invoke_shortcut(direction))
                            assert_tile(tile_rect(original["workArea"],direction),f"delayed Firefox {direction} from fullscreen={fullscreen}")
                    report["checks"].append("native Firefox four-way tiling survives delayed maximize and fullscreen acknowledgments")
                    prepare_browser(True)
                    delayed_action(lambda:invoke_shortcut("toggle-maximize"))
                    wait_browser(lambda w:not w["fullscreen"] and w["maximizedHorizontal"] and w["maximizedVertical"],"delayed fullscreen exit before maximize toggle")
                    report["checks"].append("native Firefox maximize toggle waits for requested fullscreen exit")
                    with Input() as keys:
                        def app_chord():
                            for code in [29,56,42,36]: keys.key(code,True)
                        original = prepare_browser(False)
                        keys.pointer(original["workArea"]["x"]+20,original["workArea"]["y"]+20)
                        delayed_action(app_chord)
                        keys.release()
                        assert_tile(tile_rect(original["workArea"],"tile-left"),"delayed Firefox held mouse tile")
                        report["checks"].append("native Firefox held mouse tile waits for delayed unmaximize")
                        for layout in ["tile-left","tile-right"]:
                            app_binding["burnerLayout"] = layout
                            tile_config["settings"]["holdTileEnabled"] = False
                            configure_tiles()
                            original = prepare_browser(False)
                            def tap():
                                app_chord(); time.sleep(0.05); keys.release()
                            delayed_action(tap)
                            moved = wait_browser(lambda w:w["monitor"] != original["monitor"],"burner changes output")
                            assert_tile(tile_rect(moved["workArea"],layout),"delayed Firefox tiled burner")
                        report["checks"].append("native Firefox left/right burner tiles survive delayed unmaximize on another output")
                        app_binding["burnerLayout"] = "fullscreen"
                        configure_tiles()
                        original = prepare_browser(True)
                        delayed_action(tap)
                        wait_browser(lambda w:w["monitor"] != original["monitor"] and not w["fullscreen"] and w["maximizedHorizontal"] and w["maximizedVertical"],"delayed fullscreen exit before maximized burner")
                        report["checks"].append("native Firefox maximized burner waits for fullscreen exit on its destination output")
                        app_binding["burnerLayout"] = "float"
                        configure_tiles()
                        for maximized in [False,True]:
                            original = prepare_browser(False,maximized)
                            delayed_action(tap)
                            moved = wait_browser(lambda w:w["monitor"] != original["monitor"] and w["active"] and not w["fullscreen"] and w["maximizedHorizontal"] == maximized and w["maximizedVertical"] == maximized,"floating burner preserves window state")
                            # This compositor uses equal-sized outputs: relative
                            # placement must preserve size and work-area offsets.
                            source,destination = original["workArea"],moved["workArea"]
                            assert (source["width"],source["height"]) == (destination["width"],destination["height"])
                            expected = dict(original["rect"],x=original["rect"]["x"]+destination["x"]-source["x"],y=original["rect"]["y"]+destination["y"]-source["y"])
                            wait_browser(lambda w:w["rect"] == expected,"floating burner preserves relative geometry")
                            delayed_action(tap)
                            wait_browser(lambda w:w["monitor"] == original["monitor"] and w["active"] and w["rect"] == original["rect"] and not w["fullscreen"] and w["maximizedHorizontal"] == maximized and w["maximizedVertical"] == maximized,"app pull returns floating burner geometry and state")
                            report["checks"].append(f"native Firefox floating burner round trip preserves geometry and maximized={maximized} on two outputs")
                        original = prepare_browser(False)
                        invoke_shortcut("push-right")
                        moved = wait_browser(lambda w:w["monitor"] != original["monitor"],"push Firefox before retile")
                        deadline = time.monotonic()+2
                        while time.monotonic()<deadline:
                            assigned = subprocess.check_output(["gdbus","call","--session","--dest","org.kde.kglobalaccel","--object-path","/kglobalaccel","--method","org.kde.KGlobalAccel.shortcut",json.dumps(["kwin","window-warp-retile-X","",""])],text=True)
                            if "88" in assigned: break
                            time.sleep(0.02)
                        else: raise AssertionError("Firefox push did not reserve the retile key")
                        def retile(): keys.key(45,True); keys.release()
                        delayed_action(retile)
                        assert_tile(tile_rect(moved["workArea"],"tile-left"),"delayed Firefox one-shot retile")
                        report["checks"].append("native Firefox one-shot X retile survives delayed unmaximize after push")
                        if "--overlap" in sys.argv:
                            # Fresh keys have no focus-last history from earlier
                            # checks. Both bindings target the same owned browser:
                            # an actual short tap leaves its geometry unchanged.
                            tile_config["bindings"].remove(app_binding)
                            tile_config["bindings"].extend(dict(app_binding, label=f"Overlap {key}",
                                shortcut=f"Ctrl+Alt+Shift+{key}", mainMonitorAction="focus-last") for key in ["K","L"])
                            tile_config["settings"].update(holdDelayMs=600,holdTileEnabled=True,holdMode="tile")
                            configure_tiles()
                            with (output / "overlap-shortcut-signals.log").open("w") as signal_log:
                                overlap_monitor = subprocess.Popen(["dbus-monitor","--session",
                                    "type='signal',interface='org.kde.kglobalaccel.Component'"], stdout=signal_log,stderr=signal_log)
                            # First prove each key can independently survive the
                            # same stopped-client delay. Signal timestamps then
                            # distinguish key registration/activation failures
                            # from the provider releasing A when B is pressed.
                            for key in [37,38]:
                                original = prepare_browser(False)
                                area = original["workArea"]
                                keys.pointer(area["x"]+20,area["y"]+area["height"]//2)
                                assert browser_fixture.poll() is None and os.getpgid(browser_fixture.pid) == browser_fixture.pid
                                os.killpg(browser_fixture.pid,signal.SIGSTOP)
                                try:
                                    for code in [29,56,42,key]: keys.key(code,True)
                                    time.sleep(1.4)
                                finally:
                                    os.killpg(browser_fixture.pid,signal.SIGCONT)
                                try:
                                    assert_tile(tile_rect(area,"tile-left"),f"solo delayed app hold evdev={key}")
                                finally:
                                    keys.release()
                                report["checks"].append(f"overlap preflight: solo evdev {key} hold tiles after delayed Firefox acknowledgment")
                            overlap_cases = []
                            # The gesture slots are a HashMap. Reverse which key
                            # blocks without reconfiguring so each slot order is
                            # exercised in this same running controller.
                            for first_key,second_key in [(37,38),(38,37)]:
                                original = prepare_browser(False)
                                area = original["workArea"]
                                assert area["width"] >= area["height"], "Overlap fixture requires a landscape output"
                                expected = tile_rect(area,"tile-left")
                                forbidden = tile_rect(area,"tile-right")
                                case = dict(firstKey=first_key,secondKey=second_key,expected=expected,forbidden=forbidden,timing={},observed=[])
                                assert browser_fixture.poll() is None and os.getpgid(browser_fixture.pid) == browser_fixture.pid
                                keys.pointer(area["x"]+20,area["y"]+area["height"]//2)
                                os.killpg(browser_fixture.pid,signal.SIGSTOP)
                                try:
                                    for code in [29,56,42]: keys.key(code,True)
                                    started = time.monotonic()
                                    keys.key(first_key,True)
                                    case["timing"]["firstDown"] = time.monotonic()-started
                                    time.sleep(max(0,started+0.45-time.monotonic()))
                                    keys.pointer(area["x"]+area["width"]-20,area["y"]+area["height"]//2)
                                    keys.key(second_key,True)
                                    case["timing"]["secondDown"] = time.monotonic()-started
                                    time.sleep(max(0,started+0.75-time.monotonic()))
                                    # Keep the first key and every modifier down.
                                    # This release must arrive while the first
                                    # action waits for Firefox's unmaximize ack.
                                    keys.key(second_key,False)
                                    case["timing"]["secondUp"] = time.monotonic()-started
                                    time.sleep(max(0,started+1.4-time.monotonic()))
                                finally:
                                    os.killpg(browser_fixture.pid,signal.SIGCONT)
                                try:
                                    case["timing"]["resumed"] = time.monotonic()-started
                                    assert 0 < case["timing"]["secondUp"]-case["timing"]["secondDown"] < 0.6, case
                                    assert case["timing"]["secondUp"] > case["timing"]["firstDown"]+0.6, case
                                    # Observe through the queued operation and
                                    # final key release; a transient second tile
                                    # is a failure even if later geometry changes.
                                    released = False
                                    deadline = time.monotonic()+2.5
                                    while time.monotonic()<deadline:
                                        current = browser_window()
                                        observation = {key:current[key] for key in ["rect","fullscreen","maximizedHorizontal","maximizedVertical"]}
                                        if not case["observed"] or case["observed"][-1] != observation:
                                            case["observed"].append(observation)
                                        if not released and time.monotonic() >= started+2.0:
                                            keys.release()
                                            released = True
                                            case["timing"]["allReleased"] = time.monotonic()-started
                                        time.sleep(0.05)
                                finally:
                                    keys.release()
                                overlap_cases.append(case)
                                (output / "firefox-overlap.json").write_text(json.dumps(overlap_cases,indent=2))
                            for case in overlap_cases:
                                assert not any(w["rect"] == case["forbidden"] for w in case["observed"]), f"Short overlapping tap became a hold tile: {case}"
                                final = case["observed"][-1]
                                assert final["rect"] == case["expected"] and not any(final[key] for key in ["fullscreen","maximizedHorizontal","maximizedVertical"]), f"First overlapping hold did not settle left: {case}"
                            report["checks"].append("overlapping distinct app chords keep short taps untiled while another hold waits for Firefox acknowledgment, in both slot orders")
                finally:
                    if overlap_monitor is not None:
                        if overlap_monitor.poll() is None: overlap_monitor.terminate()
                        try: overlap_monitor.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            overlap_monitor.kill(); overlap_monitor.wait(timeout=3)
                    if browser_fixture.poll() is None: os.killpg(browser_fixture.pid,signal.SIGCONT)
                    invoke("set_enabled", {"enabled":False})
                    invoke("save_config", {"config":saved_config})
                    invoke("save_workspaces", {"store":{"version":1,"profiles":[browser_capture]}})
            evaluate("location.reload(); return true;")
            wait_for(f"return document.querySelectorAll('.binding').length === {len(firefox_config['bindings'])} && !document.querySelector('#toggle').disabled")
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
            terminal_config = invoke("get_config")
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
            if "--terminal-concurrent" in sys.argv:
                test_terminal_concurrent(fixture_env, temporary, captured_terminal, log, report)
            evaluate("location.reload(); return true;")
            wait_for(f"return document.querySelectorAll('.binding').length === {len(terminal_config['bindings'])} && !document.querySelector('#toggle').disabled")
            click("#show-workspaces")
            wait_for("return document.querySelectorAll('#workspace-list article').length === 1")
            click('[data-action="edit"]')
            evaluate("const panel=document.querySelector('.terminal-settings'); panel.open=true; panel.scrollIntoView(); return true;")
            assert evaluate("return document.querySelector('[data-terminal=workingDirectory]').value") == str(terminal_dir)
            screenshot = request("GET", f"/session/{session}/screenshot")
            (output / "window-warp-terminal-kde.png").write_bytes(base64.b64decode(screenshot))
            report["screenshot"] = str(output / "window-warp-terminal-kde.png")
        if "--import" in sys.argv:
            invoke("set_enabled", {"enabled": False})
            wait_for("return !document.querySelector('#import-files').disabled")
            if not evaluate("return document.querySelector('#workspace-editor').hidden"):
                click("#discard-workspace")
            before_config = invoke("get_config")
            before_store = invoke("get_workspaces")
            app_ini = "[Meta]\ncount=1\n[App1]\nlabel=Imported Windows app\nhotkey=#x\nmatch=Research ahk_class WindowsClass ahk_exe app.exe"
            workspace_ini = "[Meta]\ncount=1\n[Profile1]\nid=legacy-id\nname=Imported workspace\nitemCount=1\n[Profile1Item1]\nprocessName=WindowsTerminal.exe\npath=C:\\WindowsApps\\Terminal.exe\ntitle=Development\nterminalCommand=wsl.exe -d \"Ubuntu\"\nprofileName=Dev\nx=100\ny=100\nw=600\nh=400\nmonitorIndex=1"
            encoded = [base64.b64encode(text.encode("utf-16")).decode() for text in [app_ini, workspace_ini]]
            evaluate("const transfer=new DataTransfer();" + "".join(
                f"transfer.items.add(new File([Uint8Array.from(atob({json.dumps(data)}),c=>c.charCodeAt(0))], 'fixture-{index}.ini'));"
                for index, data in enumerate(encoded)
            ) + "const input=document.querySelector('#import-files');input.files=transfer.files;document.querySelector('#legacy-import').open=true;input.dispatchEvent(new Event('change'));return true;")
            wait_for("return document.querySelectorAll('#import-results article').length===2 && !document.querySelector('#apply-import').disabled")
            assert invoke("get_config") == before_config
            assert invoke("get_workspaces") == before_store
            assert "Disabled for Linux review" in evaluate("return document.querySelector('#import-results').textContent")
            click("#apply-import")
            assert invoke("get_config") == before_config
            click("#save")
            wait_for("return document.querySelector('#message').textContent.startsWith('Saved.')")
            imported = invoke("get_config")["bindings"][-1]
            assert imported["windowsMatch"]["titleContains"] == "Research" and imported["windowsMatch"]["className"] == "WindowsClass" and not imported["enabled"]
            invalid = json.loads(json.dumps(invoke("get_config")))
            invalid["bindings"][-1]["enabled"] = True
            try:
                invoke("save_config", {"config": invalid})
                raise AssertionError("Windows selector was silently enabled on KDE")
            except RuntimeError as error:
                assert "cannot be enabled on KDE" in str(error), error
            assert not invoke("get_config")["bindings"][-1]["enabled"]
            report["checks"].append("native WebKit UTF-16 import preserves Windows app identity as a disabled Linux review draft until explicit Save")
            click("#import-results article:last-child button")
            wait_for("return !document.querySelector('#workspace-editor').hidden")
            assert invoke("get_workspaces") == before_store
            assert evaluate("return document.querySelector('#workspace-platform').value") == "windows"
            assert evaluate("return document.querySelector('[data-terminal=wslDistro]').value") == "Ubuntu"
            screenshot = request("GET", f"/session/{session}/screenshot")
            (output / "window-warp-import-kde.png").write_bytes(base64.b64decode(screenshot))
            click("#save-workspace")
            wait_for("return document.querySelector('#message').textContent==='Workspace saved.'")
            saved = invoke("get_workspaces")["profiles"][-1]
            assert saved["platform"] == "windows" and saved["id"] != "legacy-id"
            assert saved["items"][0]["terminal"]["wslDistro"] == "Ubuntu"
            report["checks"].append("native KDE imported Windows workspace preserves terminal identity, requires Save and remains platform scoped")
        if "--tray" in sys.argv:
            test_tray(driver, environment, log, report)
        (output / "gui-result.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2), flush=True)
    finally:
        if tray_host is not None:
            if tray_host.poll() is None: tray_host.terminate()
            try: tray_host.wait(timeout=5)
            except subprocess.TimeoutExpired:
                tray_host.kill(); tray_host.wait(timeout=5)
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
        if radial_fixture and radial_fixture.poll() is None:
            radial_fixture.terminate()
            radial_fixture.wait(timeout=10)
        if hold_fixture:
            hold_fixture.terminate()
            hold_fixture.wait(timeout=10)
        if fixture:
            fixture.terminate()
            fixture.wait(timeout=10)
        for name in ["window-warp-session", "window-warp-pause-session", "window-warp-control-session", "window-warp-retile-session"]:
            if kwin_loaded(name):
                subprocess.run(["qdbus", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", name], check=True)
        # Kill only the process group created by this test's driver.
        try:
            os.killpg(driver.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        driver.wait(timeout=10)
