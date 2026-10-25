"""Run against an existing KDE session. Only temporary fixture windows are moved."""
import json
import os
from pathlib import Path
import sys
import tempfile
import subprocess
from PyQt5.QtCore import QObject, QTimer, Qt, pyqtSlot, Q_CLASSINFO
from PyQt5.QtDBus import QDBusConnection, QDBusMessage
from PyQt5.QtWidgets import QApplication, QWidget, QLabel, QVBoxLayout

app = QApplication(sys.argv)
if "--radial" in sys.argv:
    app.setApplicationName("WindowWarpRadialSmoke")
    app.setDesktopFileName("com.windowwarp.radial-smoke")
    radial_windows = []
    for index in range(9):
        window = QWidget()
        window.setWindowTitle(f"WARP-RADIAL-{index}")
        window.resize(400, 300)
        window.show()
        radial_windows.append(window)
    QTimer.singleShot(120000, app.quit)
    sys.exit(app.exec_())
if len(sys.argv) > 1 and sys.argv[1] in ["--other", "--workspace", "--workspace-single", "--hold"]:
    if os.environ.get("WARP_LAUNCH_LOG"):
        Path(os.environ["WARP_LAUNCH_LOG"]).write_text(json.dumps({"args": sys.argv[1:], "cwd": os.getcwd()}))
    app.setApplicationName("WindowWarpOtherSmoke")
    app.setDesktopFileName("com.windowwarp.hold-smoke" if sys.argv[1] == "--hold" else "com.windowwarp.other-smoke")
    class InputWindow(QWidget):
        def keyPressEvent(self, event):
            if os.environ.get("WARP_INPUT_LOG"):
                with Path(os.environ["WARP_INPUT_LOG"]).open("a") as output:
                    output.write(json.dumps({"key":event.key(),"text":event.text()})+"\n")
            super().keyPressEvent(event)
    other_window = InputWindow()
    if sys.argv[1] == "--other":
        other_window.setAttribute(Qt.WA_ShowWithoutActivating)
    other_window.setWindowTitle("WARP-TEST-C")
    other_window.resize(400, 300)
    other_window.show()
    if sys.argv[1] == "--workspace":
        second_window = QWidget()
        second_window.setWindowTitle("WARP-TEST-D")
        second_window.resize(450, 320)
        second_window.show()
    if sys.argv[1].startswith("--workspace") or sys.argv[1] in ["--hold", "--other"]:
        # A native fixture can outlive its caller if setup or a test fails.
        QTimer.singleShot(60000, app.quit)
    sys.exit(app.exec_())

app.setApplicationName("WindowWarpSmoke")
fixture_app_id = "com.windowwarp.smoke." + str(os.getpid())
app.setDesktopFileName(fixture_app_id)
bus = QDBusConnection.sessionBus()
service = "com.windowwarp.Smoke"
script_name = "window-warp-live-test"
result = {"passed": False, "error": "No result received"}
loaded_by_test = False
other_process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--other"])
fixtures = []
for name in ["WARP-TEST-A", "WARP-TEST-B"]:
    window = QWidget()
    window.setAttribute(Qt.WA_ShowWithoutActivating)
    window.setWindowTitle(name)
    window.resize(640, 400)
    layout = QVBoxLayout(window)
    layout.addWidget(QLabel("Window Warp — temporary KDE integration test\n" + name))
    window.show()
    fixtures.append(window)


def call(path, method, *args, interface="org.kde.kwin.Scripting"):
    message = QDBusMessage.createMethodCall("org.kde.KWin", path, interface, method)
    message.setArguments(list(args))
    reply = bus.call(message)
    if reply.type() == QDBusMessage.ErrorMessage:
        raise RuntimeError(reply.errorMessage())
    return reply.arguments()[0] if reply.arguments() else None


class Receiver(QObject):
    Q_CLASSINFO("D-Bus Interface", "com.windowwarp.Smoke")
    @pyqtSlot(str)
    def report(self, payload):
        global result
        result = json.loads(payload)
        result["qtPlatform"] = app.platformName()
        QTimer.singleShot(200, app.quit)


class PointerReceiver(QObject):
    Q_CLASSINFO("D-Bus Interface", "com.windowwarp.Control")
    @pyqtSlot(str, str)
    def CenterPointer(self, token, point):
        result.setdefault("pointerRequests", []).append(json.loads(point))
    @pyqtSlot(str, str, str)
    def ArmRetile(self, token, window, pushed_at):
        result.setdefault("retileRequests", []).append({"window":json.loads(window),"pushedAt":int(pushed_at)})

pointer_receiver = PointerReceiver()
assert bus.registerObject("/Control", pointer_receiver, QDBusConnection.ExportAllSlots)
receiver = Receiver()
if not bus.registerService(service) or not bus.registerObject("/Smoke", receiver, QDBusConnection.ExportAllSlots):
    raise RuntimeError("Cannot register test result receiver on the session bus")

source = Path(sys.argv[1]).read_text()
harness = Path(__file__).with_name("live.js").read_text()
configuration = {"settings": {"mainMonitor": 1, "burnerMonitor": 2}, "bindings": [
    {"label": "Left", "shortcut": "Ctrl+Alt+Shift+F20", "action": "tile-left"},
    {"label": "Right", "shortcut": "Ctrl+Alt+Shift+F21", "action": "tile-right"},
    {"label": "Push", "shortcut": "Ctrl+Alt+Shift+F22", "action": "push-right"},
    {"label": "Pull", "shortcut": "Ctrl+Alt+Shift+F23", "action": "pull"},
    {"label": "Focus", "shortcut": "Ctrl+Alt+Shift+F24", "action": "focus-app", "appMatch": fixture_app_id},
    {"label": "Top", "shortcut": "Ctrl+Alt+Shift+F13", "action": "tile-up"},
    {"label": "Bottom", "shortcut": "Ctrl+Alt+Shift+F14", "action": "tile-down"},
    {"label": "Maximize", "shortcut": "Ctrl+Alt+Shift+F15", "action": "toggle-maximize"},
    {"label": "App", "shortcut": "Ctrl+Alt+Shift+F16", "action": "pull-app", "appMatch": fixture_app_id, "mainMonitorAction": "burner", "burnerLayout": "tile-right"},
    {"label": "Previous", "shortcut": "Ctrl+Alt+Shift+F17", "action": "pull-app", "appMatch": fixture_app_id, "mainMonitorAction": "focus-last"},
    {"label": "Close", "shortcut": "Ctrl+Alt+Shift+F18", "action": "close-window"},
]}
script = "var WARP_CONFIG = " + json.dumps(configuration) + ";\nvar testCallbacks = {};\nvar nativeRegisterShortcut = registerShortcut;\nvar registeredTestIds = [];\n"
script += "(function(registerShortcut) {\n" + source + "\n})(function(id, label, key, callback) { function ownedCallback() { var active = 'activeWindow' in workspace ? workspace.activeWindow : workspace.activeClient; if (!active || [WARP_FIXTURE_PIDS.main,WARP_FIXTURE_PIDS.other].indexOf(Number(active.pid)) < 0) throw new Error('Fixture lost focus; refusing to dispatch against an unowned window'); callback(); } testCallbacks[label] = ownedCallback; var testId = 'window-warp-smoke-' + id; registeredTestIds.push(testId); return nativeRegisterShortcut(testId, label, key, ownedCallback); });\n"
script = "var WARP_APP = " + json.dumps({"service":service,"token":"fixture"}) + ";\n" + script
script = "var WARP_FIXTURE_PIDS = " + json.dumps({"main":os.getpid(),"other":other_process.pid}) + ";\n" + script
script += harness
temporary = tempfile.TemporaryDirectory(prefix="window-warp-live-")
script_path = Path(temporary.name) / "live.js"
script_path.write_text(script)


def start():
    global loaded_by_test
    try:
        if call("/Scripting", "isScriptLoaded", script_name):
            raise RuntimeError("A test script is already running; refusing to replace it")
        script_id = call("/Scripting", "loadScript", str(script_path), script_name)
        if script_id < 0:
            raise RuntimeError("KWin rejected the test script")
        loaded_by_test = True
        try:
            call(f"/Scripting/Script{script_id}", "run", interface="org.kde.kwin.Script")
        except RuntimeError as error:
            if "Unknown object" not in str(error) and "No such object" not in str(error):
                raise
            call(f"/{script_id}", "run", interface="org.kde.kwin.Script")
    except Exception as error:
        result["error"] = str(error)
        app.quit()


QTimer.singleShot(2000, start)
QTimer.singleShot(40000, app.quit)
try:
    app.exec_()
finally:
    try:
        if loaded_by_test:
            call("/Scripting", "unloadScript", script_name)
            result["scriptUnloaded"] = not call("/Scripting", "isScriptLoaded", script_name)
            result["passed"] = result.get("passed", False) and result["scriptUnloaded"]
    finally:
        for window in fixtures:
            window.close()
        temporary.cleanup()
        bus.unregisterService(service)
        if other_process.poll() is None:
            other_process.terminate()
        other_process.wait(timeout=5)
print(json.dumps(result, indent=2), flush=True)
if not result.get("passed"):
    sys.exit(1)
