"""Exercise the production KWin desktop bridge in a private compositor."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from PyQt5.QtCore import QObject, QTimer, Q_CLASSINFO, pyqtSlot
from PyQt5.QtDBus import QDBusConnection, QDBusMessage
from PyQt5.QtWidgets import QApplication, QWidget

app = QApplication(sys.argv)
editor = QWidget()
editor.setWindowTitle("Window Warp desktop test")
editor.resize(400, 300)
editor.show()
other = subprocess.Popen([sys.executable, str(Path(__file__).with_name("live.py")), "--workspace-single"])
bus = QDBusConnection.sessionBus()
service = "com.windowwarp.DesktopsSmoke"
result = {"passed": False, "error": "No result received"}
loaded = False


class Receiver(QObject):
    Q_CLASSINFO("D-Bus Interface", "com.windowwarp.DesktopsSmoke")

    @pyqtSlot(str)
    def report(self, payload):
        global result
        result = json.loads(payload)
        QTimer.singleShot(100, app.quit)


receiver = Receiver()
if not bus.registerService(service) or not bus.registerObject("/Smoke", receiver, QDBusConnection.ExportAllSlots):
    raise RuntimeError("Cannot register the private test receiver")


def call(path, method, *args, interface="org.kde.kwin.Scripting"):
    message = QDBusMessage.createMethodCall("org.kde.KWin", path, interface, method)
    message.setArguments(list(args))
    reply = bus.call(message)
    if reply.type() == QDBusMessage.ErrorMessage:
        raise RuntimeError(reply.errorMessage())
    return reply.arguments()[0] if reply.arguments() else None


source = Path(sys.argv[1])
prefix = "var WARP_CONFIG = {bindings:[]};\nvar WARP_CONTROL = " + json.dumps(
    {"service": service, "token": "fixture", "ownPid": os.getpid(), "action": "desktop-test"}
) + ";\nvar WARP_APP = WARP_CONTROL;\nvar TEST_OTHER_PID = " + str(other.pid) + ";\n"
script = prefix + (source / "warp.js").read_text()
script += "\nvar desktopDispatch; var testJob; var testReply; var realCallDBus = callDBus;\n"
script += "(function(registerShortcut, callDBus) {\n" + (source / "control.js").read_text() + "\n})"
script += "(function(id, label, key, callback) { desktopDispatch = callback; return true; }, "
script += "function(service, path, iface, method) { var args = Array.prototype.slice.call(arguments, 4); "
script += "if (method === 'InputGeneration') args[args.length-1](JSON.stringify('fixture')); "
script += "else if (method === 'Next') args[args.length-1](JSON.stringify(testJob)); "
script += "else if (method === 'Reply') testReply = JSON.parse(args[2]); "
script += "else realCallDBus.apply(null, arguments); });\n"
script += Path(__file__).with_name("desktops.js").read_text()
temporary = tempfile.TemporaryDirectory(prefix="window-warp-desktop-test-")
script_path = Path(temporary.name) / "test.js"
script_path.write_text(script)
script_name = "window-warp-desktop-test"


def start():
    global loaded
    try:
        if call("/Scripting", "isScriptLoaded", script_name):
            raise RuntimeError("The private test script already exists")
        script_id = call("/Scripting", "loadScript", str(script_path), script_name)
        if script_id < 0:
            raise RuntimeError("KWin rejected the test script")
        loaded = True
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
QTimer.singleShot(25000, app.quit)
try:
    app.exec_()
finally:
    if loaded:
        call("/Scripting", "unloadScript", script_name)
        result["scriptUnloaded"] = not call("/Scripting", "isScriptLoaded", script_name)
        result["passed"] = result.get("passed", False) and result["scriptUnloaded"]
    editor.close()
    temporary.cleanup()
    bus.unregisterService(service)
    if other.poll() is None:
        other.terminate()
    other.wait(timeout=5)
print(json.dumps(result, indent=2), flush=True)
if not result.get("passed"):
    sys.exit(1)
