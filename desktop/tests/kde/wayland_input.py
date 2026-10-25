"""Native input for our private nested KWin only; never attaches to the user's seat.

Wire definitions follow KDE/plasma-wayland-protocols fake-input.xml (version 4).
Uses libwayland-client already required by the desktop, without a Python package.
"""
import ctypes as c
import os
from pathlib import Path


class Interface(c.Structure):
    pass


class Message(c.Structure):
    _fields_ = [("name", c.c_char_p), ("signature", c.c_char_p),
                ("types", c.POINTER(c.POINTER(Interface)))]


Interface._fields_ = [("name", c.c_char_p), ("version", c.c_int),
                     ("method_count", c.c_int), ("methods", c.POINTER(Message)),
                     ("event_count", c.c_int), ("events", c.POINTER(Message))]
GLOBAL = c.CFUNCTYPE(None, c.c_void_p, c.c_void_p, c.c_uint32, c.c_char_p, c.c_uint32)
REMOVE = c.CFUNCTYPE(None, c.c_void_p, c.c_void_p, c.c_uint32)


class Listener(c.Structure):
    _fields_ = [("global_", GLOBAL), ("remove", REMOVE)]


class Input:
    def __init__(self):
        runtime = Path(os.environ.get("XDG_RUNTIME_DIR", "")).resolve()
        if (os.environ.get("WAYLAND_DISPLAY") != "warp-test"
                or runtime.name != "runtime"
                or not runtime.parent.name.startswith("window-warp-nested.")
                or runtime.parent.parent != Path("/tmp")
                or not (runtime / "warp-test").is_socket()):
            raise RuntimeError("Native input is restricted to the owned nested KWin fixture")
        self.lib = c.CDLL("libwayland-client.so.0", use_errno=True)
        self.lib.wl_display_connect.argtypes = [c.c_char_p]
        self.lib.wl_display_connect.restype = c.c_void_p
        self.lib.wl_display_roundtrip.argtypes = [c.c_void_p]
        self.lib.wl_display_disconnect.argtypes = [c.c_void_p]
        self.lib.wl_proxy_destroy.argtypes = [c.c_void_p]
        self.lib.wl_proxy_add_listener.argtypes = [c.c_void_p, c.c_void_p, c.c_void_p]
        self.lib.wl_proxy_marshal_flags.argtypes = [c.c_void_p, c.c_uint32, c.POINTER(Interface), c.c_uint32, c.c_uint32]
        self.lib.wl_proxy_marshal_flags.restype = c.c_void_p
        self.held = []
        self.proxy = None
        self.registry = None
        self.display = self.lib.wl_display_connect(b"warp-test")
        if not self.display:
            raise RuntimeError("Cannot connect to the owned Wayland socket")
        definitions = [(b"authenticate", b"ss"), (b"pointer_motion", b"ff"),
                       (b"button", b"uu"), (b"axis", b"uf"),
                       (b"touch_down", b"2uff"), (b"touch_motion", b"2uff"),
                       (b"touch_up", b"2u"), (b"touch_cancel", b"2"),
                       (b"touch_frame", b"2"), (b"pointer_motion_absolute", b"3ff"),
                       (b"keyboard_key", b"4uu")]
        self.methods = (Message * len(definitions))(*(Message(name, signature, None) for name, signature in definitions))
        self.interface = Interface(b"org_kde_kwin_fake_input", 4, len(definitions), self.methods, 0, None)
        self.registry_interface = Interface.in_dll(self.lib, "wl_registry_interface")

        @GLOBAL
        def global_(data, registry, name, interface, version):
            if interface == self.interface.name and version >= 4:
                self.proxy = self.lib.wl_proxy_marshal_flags(registry, 0, c.byref(self.interface), 4, 0,
                    c.c_uint32(name), c.c_char_p(interface), c.c_uint32(4), c.c_void_p())

        self.listener = Listener(global_, REMOVE(lambda *_: None))
        try:
            self.registry = self.lib.wl_proxy_marshal_flags(self.display, 1, c.byref(self.registry_interface), 1, 0, c.c_void_p())
            if not self.registry or self.lib.wl_proxy_add_listener(self.registry, c.byref(self.listener), None) != 0:
                raise RuntimeError("Cannot observe the nested Wayland registry")
            self.roundtrip()
            if not self.proxy:
                raise RuntimeError("Nested KWin does not expose the required test input protocol")
            self.lib.wl_proxy_marshal_flags(self.proxy, 0, None, 4, 0,
                c.c_char_p(b"Window Warp native fixture"), c.c_char_p(b"Test keyboard delivery in an isolated compositor"))
            self.roundtrip()
        except Exception:
            self.close()
            raise

    def roundtrip(self):
        if self.lib.wl_display_roundtrip(self.display) < 0:
            raise RuntimeError("Nested Wayland connection failed")

    def key(self, code, down):
        if down and code not in self.held:
            self.held.append(code)
        self.lib.wl_proxy_marshal_flags(self.proxy, 10, None, 4, 0, c.c_uint32(code), c.c_uint32(int(down)))
        self.roundtrip()
        if not down and code in self.held:
            self.held.remove(code)

    def release(self):
        for key in reversed(self.held.copy()):
            self.key(key, False)

    def pointer(self, x, y):
        self.lib.wl_proxy_marshal_flags(self.proxy, 9, None, 4, 0, c.c_int32(round(x * 256)), c.c_int32(round(y * 256)))
        self.roundtrip()

    def close(self):
        if self.display:
            try:
                if self.proxy:
                    self.release()
            finally:
                for proxy in (self.proxy, self.registry):
                    if proxy:
                        self.lib.wl_proxy_destroy(proxy)
                self.lib.wl_display_disconnect(self.display)
                self.display = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
