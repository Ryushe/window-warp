"""Owned, daemon-started org.freedesktop.Application fixture for gui.py."""
import json
import os
from pathlib import Path
import signal
import sys


if sys.argv[1] == "--exec-fallback":
    Path(sys.argv[2]).write_text(json.dumps({"pid": os.getpid(), "args": sys.argv[3:]}))
    raise SystemExit(64)

name, receipt_path, diagnostic_path = sys.argv[1:]
diagnostic = os.open(diagnostic_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.dup2(diagnostic, 1)
os.dup2(diagnostic, 2)
os.close(diagnostic)

from gi.repository import Gio, GLib
from PyQt5.QtCore import QTimer
from PyQt5.QtWidgets import QApplication, QWidget


runtime = Path(os.environ.get("XDG_RUNTIME_DIR", "")).resolve()
if (os.environ.get("WAYLAND_DISPLAY") != "warp-test"
        or runtime.name != "runtime"
        or not runtime.parent.name.startswith("window-warp-nested.")
        or runtime.parent.parent != Path("/tmp")
        or not (runtime / "warp-test").is_socket()):
    raise RuntimeError("D-Bus application fixture requires the owned nested compositor")
if not name.startswith("org.windowwarp.DBusFixture.p"):
    raise ValueError("Unexpected fixture application identity")

app = QApplication([sys.argv[0]])
app.setApplicationName(name)
app.setDesktopFileName(name)
app.setQuitOnLastWindowClosed(False)
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
path = "/" + name.replace(".", "/")
windows = []
receipt = {"pid": os.getpid(), "applicationId": name, "calls": []}


def record():
    destination = Path(receipt_path)
    pending = destination.with_suffix(".pending")
    pending.write_text(json.dumps(receipt, indent=2))
    pending.replace(destination)


def method_call(connection, sender, object_path, interface, method, parameters, invocation):
    uris = list(parameters.unpack()[0]) if method == "Open" else []
    call = {"method": method, "uris": uris}
    receipt["calls"].append(call)
    if uris == ["warp-fixture://reject"]:
        call["error"] = "org.windowwarp.Fixture.Rejected"
        record()
        invocation.return_dbus_error(call["error"], "Owned fixture deliberately rejected the URI")
        return
    window = QWidget()
    window.setWindowTitle("WARP-DBUS-" + str(len(windows) + 1))
    window.resize(420, 300)
    window.show()
    windows.append(window)
    record()
    invocation.return_value(GLib.Variant("()", ()))


xml = """<node><interface name="org.freedesktop.Application">
  <method name="Activate"><arg type="a{sv}" direction="in"/></method>
  <method name="Open"><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/></method>
</interface></node>"""
node = Gio.DBusNodeInfo.new_for_xml(xml)
registration = bus.register_object(path, node.interfaces[0], method_call, None, None)
owned = bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
    "RequestName", GLib.Variant("(su)", (name, 4)), None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
assert owned == 1, "Fixture must acquire its unique application name without replacing another owner"
record()

# GIO dispatches on the default GLib context; keep it on the Qt GUI thread.
context = GLib.MainContext.default()
timer = QTimer()
timer.timeout.connect(lambda: context.iteration(False))
timer.start(10)
for sig in [signal.SIGTERM, signal.SIGINT]:
    signal.signal(sig, lambda *_: app.quit())
QTimer.singleShot(60000, app.quit)
try:
    sys.exit(app.exec_())
finally:
    bus.unregister_object(registration)
    bus.close_sync(None)
