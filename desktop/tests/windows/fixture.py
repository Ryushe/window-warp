"""Owned Win32 windows, key delivery and conflicting registration for native tests."""
import argparse
import ctypes as c
from ctypes import wintypes as w
import json
import os
import queue
import sys
import threading
import time
import winreg

parser = argparse.ArgumentParser()
parser.add_argument("--marker", required=True)
parser.add_argument("--app-pid", type=int, default=0)
parser.add_argument("--standalone", action="store_true")
args = parser.parse_args()
user = c.WinDLL("user32", use_last_error=True)
kernel = c.WinDLL("kernel32", use_last_error=True)
# Match Tauri's per-monitor pixel coordinates when placing windows or the pointer.
user.SetProcessDpiAwarenessContext.argtypes = [c.c_void_p]
if not user.SetProcessDpiAwarenessContext(c.c_void_p(-4)):
    raise c.WinError(c.get_last_error())
LRESULT = c.c_ssize_t
WNDPROC = c.WINFUNCTYPE(LRESULT, w.HWND, w.UINT, w.WPARAM, w.LPARAM)

class WNDCLASS(c.Structure):
    _fields_ = [("style", w.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", c.c_int),
                ("cbWndExtra", c.c_int), ("hInstance", w.HINSTANCE), ("hIcon", w.HICON),
                ("hCursor", w.HANDLE), ("hbrBackground", w.HBRUSH),
                ("lpszMenuName", w.LPCWSTR), ("lpszClassName", w.LPCWSTR)]

class KEYBDINPUT(c.Structure):
    _fields_ = [("wVk", w.WORD), ("wScan", w.WORD), ("dwFlags", w.DWORD),
                ("time", w.DWORD), ("dwExtraInfo", c.c_size_t)]

class MOUSEINPUT(c.Structure):
    _fields_ = [("dx", w.LONG), ("dy", w.LONG), ("mouseData", w.DWORD),
                ("dwFlags", w.DWORD), ("time", w.DWORD), ("dwExtraInfo", c.c_size_t)]

class INPUTUNION(c.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]

class INPUT(c.Structure):
    _anonymous_ = ("data",)
    _fields_ = [("type", w.DWORD), ("data", INPUTUNION)]

user.DefWindowProcW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]
user.DefWindowProcW.restype = LRESULT
user.RegisterClassW.argtypes = [c.POINTER(WNDCLASS)]
user.CreateWindowExW.argtypes = [w.DWORD, w.LPCWSTR, w.LPCWSTR, w.DWORD, c.c_int,
                               c.c_int, c.c_int, c.c_int, w.HWND, w.HMENU, w.HINSTANCE, c.c_void_p]
user.CreateWindowExW.restype = w.HWND
user.ShowWindow.argtypes = [w.HWND, c.c_int]
user.SetForegroundWindow.argtypes = [w.HWND]
user.GetForegroundWindow.restype = w.HWND
ENUMWINDOWS = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
user.EnumWindows.argtypes = [ENUMWINDOWS, w.LPARAM]
user.IsWindowVisible.argtypes = [w.HWND]
user.GetWindowRect.argtypes = [w.HWND, c.POINTER(w.RECT)]
user.SetWindowPos.argtypes = [w.HWND, w.HWND, c.c_int, c.c_int, c.c_int, c.c_int, w.UINT]
user.GetCursorPos.argtypes = [c.POINTER(w.POINT)]
user.SetCursorPos.argtypes = [c.c_int, c.c_int]
user.GetWindowThreadProcessId.argtypes = [w.HWND, c.POINTER(w.DWORD)]
user.RegisterHotKey.argtypes = [w.HWND, c.c_int, w.UINT, w.UINT]
user.UnregisterHotKey.argtypes = [w.HWND, c.c_int]
user.DestroyWindow.argtypes = [w.HWND]
user.SendInput.argtypes = [w.UINT, c.POINTER(INPUT), c.c_int]
user.GetAsyncKeyState.argtypes = [c.c_int]
user.GetAsyncKeyState.restype = w.SHORT
user.PeekMessageW.argtypes = [c.POINTER(w.MSG), w.HWND, w.UINT, w.UINT, w.UINT]
user.TranslateMessage.argtypes = [c.POINTER(w.MSG)]
user.DispatchMessageW.argtypes = [c.POINTER(w.MSG)]
user.DispatchMessageW.restype = LRESULT
kernel.GetModuleHandleW.argtypes = [w.LPCWSTR]
kernel.GetModuleHandleW.restype = w.HMODULE

@WNDPROC
def procedure(hwnd, message, wp, lp):
    return user.DefWindowProcW(hwnd, message, wp, lp)

instance = kernel.GetModuleHandleW(None)
class_name = "WindowWarpFixture-" + args.marker
window_class = WNDCLASS(lpfnWndProc=procedure, hInstance=instance,
                        hbrBackground=6, lpszClassName=class_name)
if not user.RegisterClassW(c.byref(window_class)):
    raise c.WinError(c.get_last_error())
windows = []
for index in range(1 if args.standalone else 2):
    hwnd = user.CreateWindowExW(0, class_name, f"{args.marker}-{index}", 0x10CF0000,
                                150 + index * 80, 120 + index * 80, 500, 320,
                                None, None, instance, None)
    if not hwnd:
        raise c.WinError(c.get_last_error())
    windows.append(hwnd)
print(json.dumps({"ready": True, "pid": os.getpid(), "windows": windows, "executable": sys.executable}), flush=True)

commands = queue.Queue()
def read_commands():
    for line in sys.stdin:
        commands.put(json.loads(line))
    commands.put({"command": "quit", "id": 0})

if not args.standalone:
    threading.Thread(target=read_commands, daemon=True).start()
reserved = set()
held_keys = []
original_pointer = None
last_pointer = None

def send_keys(keys, release=False):
    events = [INPUT(type=1, ki=KEYBDINPUT(wVk=key, dwFlags=2 if release else 0)) for key in keys]
    inputs = (INPUT * len(events))(*events)
    if user.SendInput(len(inputs), inputs, c.sizeof(INPUT)) != len(inputs):
        raise c.WinError(c.get_last_error())

def owned(hwnd):
    pid = w.DWORD()
    user.GetWindowThreadProcessId(hwnd, c.byref(pid))
    if pid.value not in (os.getpid(), args.app_pid):
        raise RuntimeError("Refusing to interact with an unowned window")

deadline = time.monotonic() + 180
try:
    while time.monotonic() < deadline:
        message = w.MSG()
        while user.PeekMessageW(c.byref(message), None, 0, 0, 1):
            user.TranslateMessage(c.byref(message))
            user.DispatchMessageW(c.byref(message))
        try:
            request = commands.get(timeout=0.01)
        except queue.Empty:
            continue
        try:
            command = request["command"]
            if command == "quit":
                break
            result = True
            if command == "app_window":
                found = []
                @ENUMWINDOWS
                def find_window(hwnd, _):
                    pid = w.DWORD()
                    user.GetWindowThreadProcessId(hwnd, c.byref(pid))
                    if pid.value == args.app_pid and user.IsWindowVisible(hwnd):
                        rect = w.RECT()
                        if user.GetWindowRect(hwnd, c.byref(rect)) and rect.right - rect.left >= 300 and rect.bottom - rect.top >= 200:
                            found.append(hwnd)
                    return True
                user.EnumWindows(find_window, 0)
                if len(found) != 1:
                    raise RuntimeError(f"Expected one visible app-sized fixture window; found {len(found)}")
                result = found[0]
            elif command == "startup_value":
                try:
                    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
                        result = winreg.QueryValueEx(key, "WindowWarp")[0]
                except FileNotFoundError:
                    result = None
            elif command == "reserve":
                key = request["key"]
                if not user.RegisterHotKey(windows[0], key, 0x4007, key):
                    raise c.WinError(c.get_last_error())
                reserved.add(key)
            elif command == "release":
                key = request["key"]
                if not user.UnregisterHotKey(windows[0], key):
                    raise c.WinError(c.get_last_error())
                reserved.discard(key)
            elif command == "pointer":
                point = w.POINT()
                if not user.GetCursorPos(c.byref(point)):
                    raise c.WinError(c.get_last_error())
                if original_pointer is None:
                    original_pointer = (point.x, point.y)
                if not user.SetCursorPos(request["x"], request["y"]):
                    raise c.WinError(c.get_last_error())
                last_pointer = (request["x"], request["y"])
            elif command == "key_up":
                keys = request.get("keys", list(reversed(held_keys)))
                if not all(key in held_keys for key in keys):
                    raise RuntimeError("Only fixture-held keys may be released")
                send_keys(keys, release=True)
                held_keys = [key for key in held_keys if key not in keys]
            elif command in ("repeat", "held_tap"):
                owned(user.GetForegroundWindow())
                key = request["key"]
                if command == "repeat":
                    if key not in held_keys:
                        raise RuntimeError("Repeated key must already be fixture-held")
                    send_keys([key])
                else:
                    if not all(key in held_keys for key in [0x11, 0x12, 0x10]) or key in held_keys:
                        raise RuntimeError("Tap requires fixture-held modifiers and a fresh key")
                    send_keys([key])
                    send_keys([key], release=True)
            elif command in ("focus", "press", "hold_start", "place"):
                hwnd = int(request.get("window", windows[0]))
                owned(hwnd)
                user.ShowWindow(hwnd, 9)
                if command == "place":
                    rect = request["rect"]
                    if not user.SetWindowPos(hwnd, None, rect["x"], rect["y"], rect["width"], rect["height"], 0x14):
                        raise c.WinError(c.get_last_error())
                user.SetForegroundWindow(hwnd)
                if user.GetForegroundWindow() != hwnd:
                    raise RuntimeError("Owned fixture could not take focus; no keys sent")
                if command in ("press", "hold_start"):
                    if any(user.GetAsyncKeyState(key) & 0x8000 for key in (0x10, 0x11, 0x12, 0x5B, 0x5C)):
                        raise RuntimeError("A modifier is already held; no keys sent")
                    keys = [0x11, 0x12, 0x10, request["key"]]
                    held_keys = keys.copy()
                    send_keys(keys)
                    if command == "press":
                        send_keys(list(reversed(keys)), release=True)
                        held_keys = []
            else:
                raise RuntimeError("Unknown fixture command")
            print(json.dumps({"id": request["id"], "result": result}), flush=True)
        except Exception as error:
            print(json.dumps({"id": request["id"], "error": str(error)}), flush=True)
finally:
    if held_keys:
        send_keys(list(reversed(held_keys)), release=True)
    if original_pointer is not None:
        point = w.POINT()
        if user.GetCursorPos(c.byref(point)) and (point.x, point.y) == last_pointer:
            user.SetCursorPos(*original_pointer)
    for key in reserved:
        user.UnregisterHotKey(windows[0], key)
    for hwnd in windows:
        user.DestroyWindow(hwnd)
