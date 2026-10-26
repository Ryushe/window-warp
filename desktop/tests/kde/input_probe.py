"""Verify native keyboard delivery and the compositor's release signal contract."""
import json
from pathlib import Path
import subprocess
import tempfile
import time
from PyQt5.QtCore import QObject, QTimer, pyqtSlot
from PyQt5.QtDBus import QDBusConnection
from PyQt5.QtWidgets import QApplication, QWidget
from wayland_input import Input

app = QApplication([])
window = QWidget()
window.setWindowTitle("WARP-INPUT-PROBE")
window.show()
events = []
started = time.monotonic()
failure = []

class Receiver(QObject):
    @pyqtSlot(str, str, 'qlonglong')
    def pressed(self, component, action, timestamp):
        if action == "window-warp-input-probe":
            events.append(["pressed", round(time.monotonic() - started, 3)])

    @pyqtSlot(str, str, 'qlonglong')
    def released(self, component, action, timestamp):
        if action == "window-warp-input-probe":
            events.append(["released", round(time.monotonic() - started, 3)])

receiver = Receiver()
bus = QDBusConnection.sessionBus()
for signal, slot in [("globalShortcutPressed", receiver.pressed), ("globalShortcutReleased", receiver.released)]:
    assert bus.connect("org.kde.kglobalaccel", "/component/kwin", "org.kde.kglobalaccel.Component", signal, slot)

def call(*args):
    return subprocess.check_output(["qdbus", "org.kde.KWin", *args], text=True).strip()

with tempfile.TemporaryDirectory(prefix="window-warp-input-") as directory, Input() as keys:
    source = Path(directory) / "probe.js"
    source.write_text('registerShortcut("window-warp-input-probe", "Window Warp input probe", "Ctrl+Alt+Shift+J", function() { print("WARP-PROBE: pressed callback"); });')
    identifier = call("/Scripting", "org.kde.kwin.Scripting.loadScript", str(source), "window-warp-input-probe")
    try:
        modern = "/Scripting/Script" + identifier
        probe = subprocess.run(["qdbus", "org.kde.KWin", modern, "org.freedesktop.DBus.Introspectable.Introspect"], capture_output=True, text=True)
        path = modern if probe.returncode == 0 and "org.kde.kwin.Script" in probe.stdout else "/" + identifier
        call(path, "org.kde.kwin.Script.run")
        def step(name, operation):
            try:
                events.append([name, round(time.monotonic() - started, 3)])
                operation()
            except Exception as error:
                failure.append(str(error))
                app.quit()
        def press():
            for key in [29, 56, 42, 36]:
                keys.key(key, True)
        QTimer.singleShot(1000, lambda: step("keys-down", press))
        QTimer.singleShot(2000, lambda: step("modifier-up", lambda: keys.key(29, False)))
        QTimer.singleShot(3000, lambda: step("remaining-up", keys.release))
        QTimer.singleShot(4000, app.quit)
        app.exec_()
    finally:
        call("/Scripting", "org.kde.kwin.Scripting.unloadScript", "window-warp-input-probe")
result = {"events": events, "errors": failure}
print(json.dumps(result, indent=2))
names = [event[0] for event in events]
modifier = names.index("modifier-up")
assert (not failure and names[0] == "keys-down" and modifier > 1
        and all(name == "pressed" for name in names[1:modifier])
        and names[modifier:] == ["modifier-up", "released", "remaining-up"]), result
