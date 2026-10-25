"""Read pointer coordinates from our private nested compositor, without moving it."""
import json
import os
from pathlib import Path
import tempfile
from PyQt5.QtCore import QCoreApplication, QObject, QTimer, pyqtSlot, Q_CLASSINFO
from PyQt5.QtDBus import QDBusConnection, QDBusMessage

runtime = Path(os.environ.get("XDG_RUNTIME_DIR", "")).resolve()
if runtime.name != "runtime" or not runtime.parent.name.startswith("window-warp-nested.") or runtime.parent.parent != Path("/tmp"):
    raise RuntimeError("Pointer probe requires our private nested compositor")
app = QCoreApplication([])
bus = QDBusConnection.sessionBus()
service = f"com.windowwarp.PointerProbe.p{os.getpid()}"
name = f"window-warp-pointer-probe-{os.getpid()}"
result = None

class Receiver(QObject):
    Q_CLASSINFO("D-Bus Interface", "com.windowwarp.PointerProbe")
    @pyqtSlot(str)
    def receive(self, value):
        global result
        result = json.loads(value)
        app.quit()

receiver = Receiver()
assert bus.registerService(service) and bus.registerObject("/Probe", receiver, QDBusConnection.ExportAllSlots)

def call(method, *args):
    message = QDBusMessage.createMethodCall("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", method)
    message.setArguments(list(args))
    reply = bus.call(message)
    if reply.type() == QDBusMessage.ErrorMessage:
        raise RuntimeError(reply.errorMessage())
    return reply.arguments()[0] if reply.arguments() else None

with tempfile.TemporaryDirectory(prefix="window-warp-pointer-probe-") as folder:
    script = Path(folder) / "pointer.js"
    script.write_text(f'callDBus("{service}", "/Probe", "com.windowwarp.PointerProbe", "receive", JSON.stringify({{x:Math.round(workspace.cursorPos.x),y:Math.round(workspace.cursorPos.y)}}));')
    assert call("loadScript", str(script), name) >= 0
    try:
        call("start")
        QTimer.singleShot(3000, app.quit)
        app.exec_()
        assert result is not None, "KWin did not answer the pointer probe"
    finally:
        call("unloadScript", name)
        bus.unregisterService(service)
print(json.dumps(result))
