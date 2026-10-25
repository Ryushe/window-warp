"""Private StatusNotifier protocol host; does not render or fabricate app menus."""
import os
from pathlib import Path
import signal

from gi.repository import Gio, GLib


runtime = Path(os.environ.get("XDG_RUNTIME_DIR", "")).resolve()
if (os.environ.get("WAYLAND_DISPLAY") != "warp-test"
        or runtime.name != "runtime"
        or not runtime.parent.name.startswith("window-warp-nested.")
        or runtime.parent.parent != Path("/tmp")
        or not (runtime / "warp-test").is_socket()):
    raise RuntimeError("Tray protocol hosting is restricted to the owned nested KWin fixture")

NAME = "org.kde.StatusNotifierWatcher"
PATH = "/StatusNotifierWatcher"
XML = """<node><interface name="org.kde.StatusNotifierWatcher">
  <method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method>
  <method name="RegisterStatusNotifierHost"><arg type="s" direction="in"/></method>
  <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
  <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
  <property name="ProtocolVersion" type="i" access="read"/>
  <signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
  <signal name="StatusNotifierItemUnregistered"><arg type="s"/></signal>
  <signal name="StatusNotifierHostRegistered"/>
  <signal name="StatusNotifierHostUnregistered"/>
</interface></node>"""
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
items = {}


def daemon(method, signature, arguments):
    return bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
        method, GLib.Variant(signature, arguments), None, Gio.DBusCallFlags.NONE, 3000, None).unpack()


def emit(name, signature=None, arguments=()):
    bus.emit_signal(None, PATH, NAME, name, GLib.Variant(signature, arguments) if signature else None)


def changed_items():
    bus.emit_signal(None, PATH, "org.freedesktop.DBus.Properties", "PropertiesChanged",
        GLib.Variant("(sa{sv}as)", (NAME, {"RegisteredStatusNotifierItems": GLib.Variant("as", list(items))}, [])))


def method_call(connection, sender, path, interface, method, parameters, invocation):
    try:
        service = parameters.unpack()[0]
        if method == "RegisterStatusNotifierItem":
            name, item_path = (sender, service) if service.startswith("/") else (service, "/StatusNotifierItem")
            owner = daemon("GetNameOwner", "(s)", (name,))[0]
            if owner != sender:
                raise ValueError("An item may register only its own bus connection")
            identifier = name + item_path
            if identifier not in items:
                items[identifier] = owner
                changed_items()
                emit("StatusNotifierItemRegistered", "(s)", (identifier,))
            invocation.return_value(GLib.Variant("()", ()))
        elif method == "RegisterStatusNotifierHost":
            # This helper already supplies protocol host presence. It does not
            # claim that a panel has painted the application's icon or menu.
            invocation.return_value(GLib.Variant("()", ()))
        else:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)
    except (GLib.Error, ValueError) as error:
        invocation.return_dbus_error("org.freedesktop.DBus.Error.InvalidArgs", str(error))


def property_get(connection, sender, path, interface, name):
    if name == "RegisteredStatusNotifierItems": return GLib.Variant("as", list(items))
    if name == "IsStatusNotifierHostRegistered": return GLib.Variant("b", True)
    if name == "ProtocolVersion": return GLib.Variant("i", 0)
    return None


def owner_changed(connection, sender, path, interface, name, parameters):
    changed, old, new = parameters.unpack()
    if new or not changed.startswith(":"): return
    removed = [identifier for identifier, owner in items.items() if owner == old]
    for identifier in removed:
        del items[identifier]
        emit("StatusNotifierItemUnregistered", "(s)", (identifier,))
    if removed: changed_items()


if daemon("NameHasOwner", "(s)", (NAME,))[0]:
    raise RuntimeError("The private session already has a StatusNotifierWatcher")
node = Gio.DBusNodeInfo.new_for_xml(XML)
registration = bus.register_object(PATH, node.interfaces[0], method_call, property_get, None)
subscription = bus.signal_subscribe("org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
    "/org/freedesktop/DBus", None, Gio.DBusSignalFlags.NONE, owner_changed)
assert daemon("RequestName", "(su)", (NAME, 4))[0] == 1, "Cannot own the private tray watcher name"


def stop():
    loop.quit()
    return GLib.SOURCE_REMOVE


for sig in [signal.SIGTERM, signal.SIGINT]:
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, stop)
try:
    emit("StatusNotifierHostRegistered")
    print("Private tray protocol host ready; no physical panel rendering", flush=True)
    loop.run()
finally:
    daemon("ReleaseName", "(s)", (NAME,))
    bus.signal_unsubscribe(subscription)
    bus.unregister_object(registration)
