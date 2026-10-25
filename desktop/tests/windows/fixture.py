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
user.WindowFromPoint.argtypes = [w.POINT]
user.WindowFromPoint.restype = w.HWND
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
kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
kernel.OpenProcess.restype = w.HANDLE
kernel.CloseHandle.argtypes = [w.HANDLE]
kernel.GetApplicationUserModelId.argtypes = [w.HANDLE, c.POINTER(w.UINT), w.LPWSTR]
kernel.GetApplicationUserModelId.restype = w.LONG
kernel.GetProcessTimes.argtypes = [w.HANDLE, c.POINTER(w.FILETIME), c.POINTER(w.FILETIME), c.POINTER(w.FILETIME), c.POINTER(w.FILETIME)]
kernel.GetSystemTimeAsFileTime.argtypes = [c.POINTER(w.FILETIME)]
user.EnumChildWindows.argtypes = [w.HWND, ENUMWINDOWS, w.LPARAM]
user.IsWindow.argtypes = [w.HWND]
user.PostMessageW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]

class PROCESSENTRY32(c.Structure):
    _fields_ = [("dwSize", w.DWORD), ("cntUsage", w.DWORD), ("th32ProcessID", w.DWORD),
                ("th32DefaultHeapID", c.c_size_t), ("th32ModuleID", w.DWORD),
                ("cntThreads", w.DWORD), ("th32ParentProcessID", w.DWORD),
                ("pcPriClassBase", w.LONG), ("dwFlags", w.DWORD), ("szExeFile", w.WCHAR * 260)]

kernel.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
kernel.CreateToolhelp32Snapshot.restype = w.HANDLE
kernel.Process32FirstW.argtypes = [w.HANDLE, c.POINTER(PROCESSENTRY32)]
kernel.Process32NextW.argtypes = [w.HANDLE, c.POINTER(PROCESSENTRY32)]
CALCULATOR = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"
calculator_baseline = None

def filetime(value):
    return (value.dwHighDateTime << 32) | value.dwLowDateTime

def process_identity(pid):
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        length = w.UINT()
        if kernel.GetApplicationUserModelId(handle, c.byref(length), None) != 122:
            return None
        value = c.create_unicode_buffer(length.value)
        if kernel.GetApplicationUserModelId(handle, c.byref(length), value) != 0:
            return None
        times = [w.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(c.byref(t) for t in times)):
            raise c.WinError(c.get_last_error())
        return value.value, filetime(times[0])
    finally:
        kernel.CloseHandle(handle)

def all_windows():
    found = []
    @ENUMWINDOWS
    def collect(hwnd, _):
        found.append(hwnd)
        return True
    user.EnumWindows(collect, 0)
    return found

def calculator_process(hwnd):
    pids = set()
    @ENUMWINDOWS
    def collect(child, _):
        pid = w.DWORD()
        user.GetWindowThreadProcessId(child, c.byref(pid))
        pids.add(pid.value)
        return True
    collect(hwnd, 0)
    user.EnumChildWindows(hwnd, collect, 0)
    matches = [(pid, identity[1]) for pid in pids
               if (identity := process_identity(pid)) and identity[0] == CALCULATOR]
    return matches[0] if len(matches) == 1 else None

def begin_calculator():
    global calculator_baseline
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == w.HANDLE(-1).value:
        raise c.WinError(c.get_last_error())
    pids = set()
    busy = False
    try:
        entry = PROCESSENTRY32(dwSize=c.sizeof(PROCESSENTRY32))
        more = kernel.Process32FirstW(snapshot, c.byref(entry))
        if not more:
            raise c.WinError(c.get_last_error())
        while more:
            pids.add(entry.th32ProcessID)
            identity = process_identity(entry.th32ProcessID)
            busy |= entry.szExeFile.lower() in ("calculator.exe", "calculatorapp.exe", "calc.exe") or bool(identity and identity[0] == CALCULATOR)
            more = kernel.Process32NextW(snapshot, c.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    handles = set(all_windows())
    busy |= any(calculator_process(hwnd) for hwnd in handles)
    if busy:
        return False
    now = w.FILETIME()
    kernel.GetSystemTimeAsFileTime(c.byref(now))
    calculator_baseline = (pids, handles, filetime(now))
    return True

def cleanup_calculator():
    global calculator_baseline
    if calculator_baseline is None:
        return 0
    pids, handles, started = calculator_baseline
    closed = []
    for hwnd in all_windows():
        if not user.IsWindowVisible(hwnd):
            continue
        identity = calculator_process(hwnd)
        if hwnd in handles or not identity or identity[0] in pids or identity[1] < started:
            continue
        # Recheck the exact HWND and process creation time immediately before
        # WM_CLOSE. No process-name termination or preexisting window is allowed.
        if calculator_process(hwnd) != identity:
            raise RuntimeError("Calculator identity changed before fixture cleanup")
        if not user.PostMessageW(hwnd, 0x10, 0, 0):
            raise c.WinError(c.get_last_error())
        closed.append((hwnd, identity))
    until = time.monotonic() + 5
    while any(user.IsWindow(hwnd) and calculator_process(hwnd) == identity for hwnd, identity in closed):
        if time.monotonic() >= until:
            raise RuntimeError("Owned Calculator window did not close after WM_CLOSE")
        time.sleep(0.05)
    calculator_baseline = None
    return len(closed)

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
            elif command == "calculator_begin":
                result = begin_calculator()
            elif command == "calculator_cleanup":
                result = cleanup_calculator()
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
            elif command == "pointer_position":
                point = w.POINT()
                if not user.GetCursorPos(c.byref(point)):
                    raise c.WinError(c.get_last_error())
                result = {"x": point.x, "y": point.y}
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
            elif command == "foreground_state":
                pid = w.DWORD()
                hwnd = user.GetForegroundWindow()
                user.GetWindowThreadProcessId(hwnd, c.byref(pid))
                result = {"window": hwnd, "pid": pid.value}
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
            elif command in ("focus", "press", "plain_press", "hold_start", "place"):
                hwnd = int(request.get("window", windows[0]))
                owned(hwnd)
                user.ShowWindow(hwnd, 9)
                if command == "place":
                    rect = request["rect"]
                    if not user.SetWindowPos(hwnd, None, rect["x"], rect["y"], rect["width"], rect["height"], 0x14):
                        raise c.WinError(c.get_last_error())
                focus_deadline = time.monotonic() + 1.5
                while user.GetForegroundWindow() != hwnd and time.monotonic() < focus_deadline:
                    user.SetForegroundWindow(hwnd)
                    while user.PeekMessageW(c.byref(message), None, 0, 0, 1):
                        user.TranslateMessage(c.byref(message))
                        user.DispatchMessageW(c.byref(message))
                    time.sleep(0.05)
                if user.GetForegroundWindow() != hwnd and not held_keys:
                    # Windows can deny programmatic activation. Click only the
                    # verified title bar of our own temporary window, then undo
                    # its temporary topmost flag. Never send keys to another app.
                    point = w.POINT()
                    user.GetCursorPos(c.byref(point))
                    if original_pointer is None:
                        original_pointer = (point.x, point.y)
                    rect = w.RECT()
                    click_point = None
                    try:
                        if not user.SetWindowPos(hwnd, w.HWND(-1), 0, 0, 0, 0, 0x13):
                            raise c.WinError(c.get_last_error())
                        if not user.GetWindowRect(hwnd, c.byref(rect)):
                            raise c.WinError(c.get_last_error())
                        click_point = w.POINT(rect.left+80, rect.top+14)
                        if user.WindowFromPoint(click_point) != hwnd:
                            raise RuntimeError("Owned title bar is covered; no click sent")
                        if not user.SetCursorPos(click_point.x, click_point.y):
                            raise c.WinError(c.get_last_error())
                        last_pointer = (click_point.x, click_point.y)
                        clicks = (INPUT * 2)(INPUT(type=0, mi=MOUSEINPUT(dwFlags=2)), INPUT(type=0, mi=MOUSEINPUT(dwFlags=4)))
                        if user.SendInput(2, clicks, c.sizeof(INPUT)) != 2:
                            raise c.WinError(c.get_last_error())
                        focus_deadline = time.monotonic()+1.5
                        while user.GetForegroundWindow() != hwnd and time.monotonic()<focus_deadline:
                            while user.PeekMessageW(c.byref(message), None, 0, 0, 1):
                                user.TranslateMessage(c.byref(message))
                                user.DispatchMessageW(c.byref(message))
                            time.sleep(0.02)
                    finally:
                        user.SetWindowPos(hwnd, w.HWND(-2), 0, 0, 0, 0, 0x13)
                        current_pointer = w.POINT()
                        if click_point is not None and user.GetCursorPos(c.byref(current_pointer)) and (current_pointer.x,current_pointer.y) == (click_point.x,click_point.y):
                            user.SetCursorPos(point.x,point.y)
                            last_pointer = (point.x,point.y)
                if user.GetForegroundWindow() != hwnd:
                    raise RuntimeError(f"Owned fixture could not take focus for {command}; no keys sent (requested={hwnd}, foreground={user.GetForegroundWindow()})")
                if command in ("press", "plain_press", "hold_start"):
                    if any(user.GetAsyncKeyState(key) & 0x8000 for key in (0x10, 0x11, 0x12, 0x5B, 0x5C)):
                        raise RuntimeError("A modifier is already held; no keys sent")
                    if command == "plain_press":
                        if request["key"] not in (88,67):
                            raise RuntimeError("Only X/C are supported by the retile fixture")
                        keys = ([0x5B] if request.get("meta",False) else []) + [request["key"]]
                    else:
                        keys = [0x11, 0x12, 0x10, request["key"]]
                    held_keys = keys.copy()
                    send_keys(keys)
                    if command in ("press", "plain_press"):
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
    if calculator_baseline is not None:
        cleanup_calculator()
