"""Owned Win32 windows, key delivery and conflicting registration for native tests."""
import argparse
import ctypes as c
from ctypes import wintypes as w
import json
import os
import queue
from pathlib import Path
import subprocess
import sys
import threading
import time
import winreg

parser = argparse.ArgumentParser()
parser.add_argument("--marker", required=True)
parser.add_argument("--app-pid", type=int, default=0)
parser.add_argument("--standalone", action="store_true")
parser.add_argument("--lifetime", type=int, default=180)
parser.add_argument("--windows", type=int, default=2)
args = parser.parse_args()
if not 1 <= args.lifetime <= 1200:
    raise ValueError("Fixture lifetime must be between 1 and 1200 seconds")
if not 1 <= args.windows <= 3:
    raise ValueError("Fixture supports one to three owned windows")
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
user.IsIconic.argtypes = [w.HWND]
user.IsZoomed.argtypes = [w.HWND]
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
user.IsChild.argtypes = [w.HWND, w.HWND]
user.PostMessageW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]
user.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, c.c_int]
user.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, c.c_int]
user.GetMenuItemCount.argtypes = [w.HMENU]
user.GetMenuItemID.argtypes = [w.HMENU, c.c_int]
user.GetMenuItemID.restype = w.UINT
user.GetMenuStringW.argtypes = [w.HMENU, w.UINT, w.LPWSTR, c.c_int, w.UINT]
user.GetMenuState.argtypes = [w.HMENU, w.UINT, w.UINT]
user.GetMenuState.restype = w.UINT
user.SendMessageTimeoutW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM, w.UINT, w.UINT, c.POINTER(c.c_size_t)]
user.SendMessageTimeoutW.restype = LRESULT
kernel.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)]
kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
kernel.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
shell = c.WinDLL("shell32", use_last_error=True)
shell.CommandLineToArgvW.argtypes = [w.LPCWSTR, c.POINTER(c.c_int)]
shell.CommandLineToArgvW.restype = c.POINTER(w.LPWSTR)
kernel.LocalFree.argtypes = [c.c_void_p]
kernel.LocalFree.restype = c.c_void_p

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


def process_times(handle):
    times = [w.FILETIME() for _ in range(4)]
    if not kernel.GetProcessTimes(handle, *(c.byref(t) for t in times)):
        raise c.WinError(c.get_last_error())
    return filetime(times[0]), filetime(times[1])


def process_image(handle):
    size = w.DWORD(32768)
    text = c.create_unicode_buffer(size.value)
    if not kernel.QueryFullProcessImageNameW(handle, 0, text, c.byref(size)):
        raise c.WinError(c.get_last_error())
    return os.path.normcase(os.path.realpath(text.value))


def process_tree():
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == w.HANDLE(-1).value:
        raise c.WinError(c.get_last_error())
    rows = []
    try:
        entry = PROCESSENTRY32(dwSize=c.sizeof(PROCESSENTRY32))
        more = kernel.Process32FirstW(snapshot, c.byref(entry))
        if not more:
            raise c.WinError(c.get_last_error())
        while more:
            rows.append((entry.th32ProcessID, entry.th32ParentProcessID))
            more = kernel.Process32NextW(snapshot, c.byref(entry))
        return rows
    finally:
        kernel.CloseHandle(snapshot)


def command_arguments(command):
    count = c.c_int()
    values = shell.CommandLineToArgvW(command, c.byref(count))
    if not values:
        raise c.WinError(c.get_last_error())
    try:
        return [values[index] for index in range(count.value)]
    finally:
        kernel.LocalFree(c.cast(values, c.c_void_p))


class FirefoxScope:
    """Only this run's explicit profiles and birth-verified descendants belong here."""
    def __init__(self, request):
        self.root = Path(request["root"]).resolve()
        expected = Path(__file__).resolve().parents[2] / "src-tauri" / "target" / "windows-validation" / args.marker
        if self.root != expected.resolve() or not self.root.is_dir():
            raise RuntimeError("Firefox output must be this marker's validation directory")
        self.program = os.path.normcase(os.path.realpath(request["program"]))
        if Path(self.program).name.lower() != "firefox.exe" or not Path(self.program).is_file():
            raise RuntimeError("Firefox executable is unavailable")
        self.profiles = [Path(value).resolve() for value in request["profiles"]]
        self.pages = [Path(value).resolve() for value in request["pages"]]
        if len(self.profiles) != 2 or len(set(self.profiles)) != 2 or len(self.pages) != 2:
            raise RuntimeError("Firefox fixture requires two distinct profiles and two pages")
        if any(p.parent != self.root or not p.is_dir() for p in self.profiles):
            raise RuntimeError("Firefox profiles must be direct children of the owned output")
        if any(p.parent != self.root or not p.is_file() or p.suffix != ".html" for p in self.pages):
            raise RuntimeError("Firefox pages must be owned local HTML files")
        self.baseline = {pid for pid, _ in process_tree()}
        self.baseline_windows = set(all_windows())
        now = w.FILETIME()
        kernel.GetSystemTimeAsFileTime(c.byref(now))
        self.started = filetime(now)
        self.processes = {}
        self.environment_profile = bool(request.get("environmentProfile", False))
        self.children = []
        self.log = (self.root / "firefox.log").open("ab")

    def remember(self, pid, profile, proof, parent=None):
        if pid in self.processes or pid in self.baseline:
            return False
        handle = kernel.OpenProcess(0x1000 | 0x100000 | 0x1, False, pid)
        if not handle:
            return False  # A launcher/content process may already have exited.
        try:
            born, _ = process_times(handle)
            image = process_image(handle)
            if born < self.started:
                return False
            if parent:
                parent_born, parent_exit = process_times(parent["handle"])
                if born < parent_born or (parent_exit and born > parent_exit):
                    return False  # A recycled parent PID is not ancestry proof.
            elif image != self.program:
                return False
            self.processes[pid] = dict(handle=handle, born=born, profile=profile, proof=proof, image=image)
            handle = None
            return True
        finally:
            if handle:
                kernel.CloseHandle(handle)

    def track_children(self):
        rows = process_tree()
        # Resolve several generations from one bounded snapshot. Retained
        # parent handles provide creation/exit times even after launcher exit.
        for _ in range(16):
            added = False
            for pid, parent_pid in rows:
                parent = self.processes.get(parent_pid)
                if parent and pid not in self.processes:
                    added |= self.remember(pid, parent["profile"], "descendant", parent)
            if not added:
                break

    def refresh(self):
        # Metadata only. Never print or retain another Firefox profile's argv.
        query = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'firefox.exe'\" -ErrorAction Stop | Select-Object ProcessId,CommandLine)"
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", query],
                                capture_output=True, timeout=6, creationflags=0x08000000)
        if result.returncode or len(result.stdout) > 4_000_000:
            raise RuntimeError("Cannot verify Firefox process/profile ownership through CIM")
        rows = json.loads(result.stdout.decode("utf-8-sig"))
        for row in rows:
            pid = int(row["ProcessId"])
            if pid in self.baseline or not row.get("CommandLine"):
                continue
            argv = command_arguments(row["CommandLine"])
            for index, value in enumerate(argv[:-1]):
                if value.lower() in ("-profile", "--profile"):
                    profile = Path(argv[index + 1]).resolve()
                    if profile in self.profiles:
                        self.remember(pid, str(profile), "exact-profile")
                    break
        self.track_children()
        for row in rows:
            record = self.processes.get(int(row["ProcessId"]))
            if record and row.get("CommandLine"):
                argv = command_arguments(row["CommandLine"])
                record["profile_argument"] = any(value.lower() in ("-profile", "--profile", "-p") for value in argv[1:])
        return self.windows()

    def launch(self, request):
        profile = self.profiles[int(request["profile"])]
        page = self.pages[int(request["page"])]
        mode = request.get("mode", "initial")
        if mode not in ("initial", "tab"):
            raise RuntimeError("Unknown Firefox launch mode")
        argv = [self.program, "--profile", str(profile)]
        environment = os.environ.copy()
        environment.pop("XRE_PROFILE_PATH", None)
        environment.pop("XRE_PROFILE_LOCAL_PATH", None)
        if mode == "initial":
            if self.environment_profile:
                argv = [self.program]
                environment.update(XRE_PROFILE_PATH=str(profile), XRE_PROFILE_LOCAL_PATH=str(profile))
            argv.extend(["--new-instance", page.as_uri()])
        else:
            argv.extend(["--new-tab", page.as_uri()])
        child = subprocess.Popen(argv, cwd=self.root, env=environment, stdin=subprocess.DEVNULL,
                                 stdout=self.log, stderr=self.log, creationflags=0x08000000)
        self.children.append(child)
        # This PID came directly from our explicit spawn; real browser roots
        # are also discovered independently by exact profile argv in refresh().
        self.remember(child.pid, str(profile), "owned-launch")
        return {"launcherPid": child.pid}

    def checked(self, hwnd):
        pid = w.DWORD()
        user.GetWindowThreadProcessId(hwnd, c.byref(pid))
        record = self.processes.get(pid.value)
        if not record or hwnd in self.baseline_windows or not user.IsWindow(hwnd):
            raise RuntimeError("Firefox window is not proven owned by this fixture")
        if kernel.WaitForSingleObject(record["handle"], 0) != 258 or process_times(record["handle"])[0] != record["born"]:
            raise RuntimeError("Firefox process closed or changed identity")
        # Opening the current PID independently checks HWND/PID reuse.
        handle = kernel.OpenProcess(0x1000, False, pid.value)
        if not handle:
            raise c.WinError(c.get_last_error())
        try:
            if process_times(handle)[0] != record["born"]:
                raise RuntimeError("Firefox window changed process identity")
        finally:
            kernel.CloseHandle(handle)
        return pid.value, record

    def windows(self):
        result = []
        for hwnd in all_windows():
            if not user.IsWindowVisible(hwnd):
                continue
            pid = w.DWORD()
            user.GetWindowThreadProcessId(hwnd, c.byref(pid))
            if pid.value not in self.processes or hwnd in self.baseline_windows:
                continue
            if kernel.WaitForSingleObject(self.processes[pid.value]["handle"], 0) == 0:
                continue
            _, record = self.checked(hwnd)
            result.append(dict(id=str(hwnd), pid=pid.value, profile=record["profile"],
                               created=str(record["born"]), proof=record["proof"],
                               profileArgument=record.get("profile_argument")))
        return result

    def cleanup(self):
        errors, terminated = [], []
        try:
            try:
                self.refresh()
            except Exception as error:
                errors.append(str(error))
            try:
                self.track_children()
                for window in self.windows():
                    hwnd = int(window["id"])
                    if not user.IsWindow(hwnd) or kernel.WaitForSingleObject(self.processes[window["pid"]]["handle"], 0) == 0:
                        continue
                    self.checked(hwnd)
                    if not user.PostMessageW(hwnd, 0x10, 0, 0):
                        errors.append("Owned Firefox window refused WM_CLOSE")
                until = time.monotonic() + 5
                while time.monotonic() < until:
                    self.track_children()
                    if all(kernel.WaitForSingleObject(record["handle"], 0) == 0 for record in self.processes.values()):
                        break
                    time.sleep(0.1)
                self.track_children()
            except Exception as error:
                errors.append("Graceful Firefox cleanup: " + str(error))
            # Exact retained handles, never taskkill /IM or an inferred process
            # tree. All data in these profiles was created by this fixture.
            for pid, record in reversed(list(self.processes.items())):
                try:
                    if kernel.WaitForSingleObject(record["handle"], 0) == 258:
                        if process_times(record["handle"])[0] != record["born"]:
                            errors.append("Owned Firefox handle changed identity")
                        elif not kernel.TerminateProcess(record["handle"], 0):
                            errors.append(f"Could not stop owned Firefox process {pid}")
                        else:
                            terminated.append(pid)
                except Exception as error:
                    errors.append(f"Owned Firefox process {pid}: {error}")
            until = time.monotonic() + 3
            while time.monotonic() < until and any(kernel.WaitForSingleObject(record["handle"], 0) == 258 for record in self.processes.values()):
                time.sleep(0.05)
            for pid, record in self.processes.items():
                if kernel.WaitForSingleObject(record["handle"], 0) != 0:
                    errors.append(f"Owned Firefox process {pid} remained running")
            return {"tracked": len(self.processes), "terminated": terminated, "errors": errors}
        finally:
            for record in self.processes.values():
                kernel.CloseHandle(record["handle"])
            self.processes.clear()
            for child in self.children:
                child.poll()
            self.log.close()


firefox_scope = None
app_process_handle = None
app_process_created = None


def checked_app_window(hwnd, expected_class=None):
    global app_process_handle, app_process_created
    if app_process_handle is None:
        handle = kernel.OpenProcess(0x1000 | 0x100000, False, args.app_pid)
        if not handle:
            raise c.WinError(c.get_last_error())
        try:
            expected = Path(__file__).resolve().parents[2] / "src-tauri/target/windows-validation" / args.marker / "window-warp-fixture.exe"
            if process_image(handle) != os.path.normcase(os.path.realpath(expected)):
                raise RuntimeError("Lifecycle target is not this run's fixture executable")
            app_process_created = process_times(handle)[0]
            app_process_handle = handle
            handle = None
        finally:
            if handle:
                kernel.CloseHandle(handle)
    if kernel.WaitForSingleObject(app_process_handle, 0) != 258 or process_times(app_process_handle)[0] != app_process_created:
        raise RuntimeError("Lifecycle fixture process closed or changed identity")
    pid = w.DWORD()
    user.GetWindowThreadProcessId(hwnd, c.byref(pid))
    if not user.IsWindow(hwnd) or pid.value != args.app_pid:
        raise RuntimeError("Lifecycle window is not owned by the fixture app")
    name = c.create_unicode_buffer(256)
    if not user.GetClassNameW(hwnd, name, len(name)):
        raise c.WinError(c.get_last_error())
    if expected_class and name.value != expected_class:
        raise RuntimeError("Lifecycle window class changed")
    return name.value


def owned_app_windows(class_name, visible=False):
    found = []
    for hwnd in all_windows():
        pid = w.DWORD()
        user.GetWindowThreadProcessId(hwnd, c.byref(pid))
        if pid.value != args.app_pid or (visible and not user.IsWindowVisible(hwnd)):
            continue
        if checked_app_window(hwnd) == class_name:
            found.append(hwnd)
    return found


def tray_menu(action):
    labels = {"open": "Open Window Warp", "pause": "Pause shortcuts", "enable": "Enable shortcuts", "quit": "Quit"}
    if action not in labels:
        raise RuntimeError("Unsupported fixture tray action")
    trays = owned_app_windows("tray_icon_app")
    if len(trays) != 1 or owned_app_windows("#32768", visible=True):
        raise RuntimeError("Expected one fixture tray and no existing fixture popup")
    tray = trays[0]
    checked_app_window(tray, "tray_icon_app")
    # tray-icon 0.25.1: callback 6002 + WM_RBUTTONUP invokes the real
    # TrackPopupMenu path. No Explorer HWND or notification-area click is used.
    if not user.PostMessageW(tray, 6002, 0, 0x205):
        raise c.WinError(c.get_last_error())
    try:
        deadline = time.monotonic() + 3
        while True:
            popups = owned_app_windows("#32768", visible=True)
            if popups:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("Fixture tray callback did not open an owned native menu")
            time.sleep(0.025)
        if len(popups) != 1:
            raise RuntimeError("Fixture tray opened multiple native menus")
        popup = popups[0]
        checked_app_window(popup, "#32768")
        menu = c.c_size_t()
        # MN_GETHMENU returns the displayed native menu's handle.
        if not user.SendMessageTimeoutW(popup, 0x1e1, 0, 0, 2, 1000, c.byref(menu)) or not menu.value:
            raise RuntimeError("Cannot read the owned popup menu handle")
        count = user.GetMenuItemCount(menu.value)
        if count != 3:
            raise RuntimeError(f"Unexpected fixture tray item count: {count}")
        items = []
        for position in range(count):
            label = c.create_unicode_buffer(256)
            if not user.GetMenuStringW(menu.value, position, label, len(label), 0x400):
                raise RuntimeError("Cannot read an owned tray menu label")
            item_id = user.GetMenuItemID(menu.value, position)
            state = user.GetMenuState(menu.value, position, 0x400)
            if item_id == 0xffffffff or state == 0xffffffff or state & 3:
                raise RuntimeError("Fixture tray item is unavailable")
            items.append({"label": label.value.replace("&", "").split("\t")[0], "id": item_id})
        if (items[0]["label"] != labels["open"] or items[2]["label"] != labels["quit"]
                or items[1]["label"] not in (labels["pause"], labels["enable"])):
            raise RuntimeError("Owned popup does not contain the expected fixture tray actions")
        selected = next(item for item in items if item["label"] == labels[action])
    finally:
        checked_app_window(tray, "tray_icon_app")
        if not user.PostMessageW(tray, 0x1f, 0, 0):  # WM_CANCELMODE ends this owner's menu loop.
            raise c.WinError(c.get_last_error())
    deadline = time.monotonic() + 2
    while owned_app_windows("#32768", visible=True):
        if time.monotonic() >= deadline:
            raise RuntimeError("Owned tray popup did not dismiss before menu dispatch")
        time.sleep(0.025)
    checked_app_window(tray, "tray_icon_app")
    # muda 0.20.0 resolves this observed native ID via its WM_COMMAND handler,
    # delivering the production Tauri menu event, just as menu selection does.
    if not user.PostMessageW(tray, 0x111, selected["id"], 0):
        raise c.WinError(c.get_last_error())
    return {"tray": tray, "popup": popup, "items": items, "selected": action}

# Independent pass-through hook in the *fixture process*, modelling another
# application's listener. Store only tagged fixture input, never physical keys.
class KBDLLHOOKSTRUCT(c.Structure):
    _fields_ = [("vkCode", w.DWORD), ("scanCode", w.DWORD), ("flags", w.DWORD),
                ("time", w.DWORD), ("dwExtraInfo", c.c_size_t)]
HOOKPROC = c.WINFUNCTYPE(LRESULT, c.c_int, w.WPARAM, w.LPARAM)
user.SetWindowsHookExW.argtypes = [c.c_int, HOOKPROC, w.HINSTANCE, w.DWORD]
user.SetWindowsHookExW.restype = w.HANDLE
user.CallNextHookEx.argtypes = [w.HANDLE, c.c_int, w.WPARAM, w.LPARAM]
user.CallNextHookEx.restype = LRESULT
user.UnhookWindowsHookEx.argtypes = [w.HANDLE]
observer_events = queue.Queue()
observer_stop = threading.Event()
observer_ready = queue.Queue()
observer_thread = None

@HOOKPROC
def observe_input(code, wp, lp):
    if code == 0:
        event = c.cast(lp, c.POINTER(KBDLLHOOKSTRUCT)).contents
        if event.dwExtraInfo == 0x57525453 and event.vkCode in (0x5b, 0x42, 0x86):
            observer_events.put((int(event.vkCode), bool(event.flags & 0x80)))
    return user.CallNextHookEx(None, code, wp, lp)

def observe_worker():
    hook = user.SetWindowsHookExW(13, observe_input, kernel.GetModuleHandleW(None), 0)
    observer_ready.put(bool(hook))
    if not hook:
        return
    try:
        message = w.MSG()
        while not observer_stop.is_set():
            while user.PeekMessageW(c.byref(message), None, 0, 0, 1):
                user.TranslateMessage(c.byref(message))
                user.DispatchMessageW(c.byref(message))
            time.sleep(0.005)
    finally:
        user.UnhookWindowsHookEx(hook)

def stop_observer():
    global observer_thread
    observer_stop.set()
    if observer_thread:
        observer_thread.join(timeout=2)
        if observer_thread.is_alive():
            raise RuntimeError("Fixture input observer did not stop")
        observer_thread = None

close_fixture = {"window": None, "requests": 0, "allow": False}
hotkey_events = []
activation_events = []
activation_timings = []

@WNDPROC
def procedure(hwnd, message, wp, lp):
    if message == 0x0006 and (wp & 0xffff):
        activation_events.append(int(hwnd))
        activation_timings.append((int(hwnd), time.perf_counter() * 1000))
    if message == 0x0312:
        hotkey_events.append(int(wp))
        return 0
    if message == 0x10 and hwnd == close_fixture["window"]:
        close_fixture["requests"] += 1
        if not close_fixture["allow"]:
            return 0
    return user.DefWindowProcW(hwnd, message, wp, lp)

instance = kernel.GetModuleHandleW(None)
class_name = "WindowWarpFixture-" + args.marker
window_class = WNDCLASS(lpfnWndProc=procedure, hInstance=instance,
                        hbrBackground=6, lpszClassName=class_name)
if not user.RegisterClassW(c.byref(window_class)):
    raise c.WinError(c.get_last_error())
windows = []
for index in range(1 if args.standalone else args.windows):
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
    events = [INPUT(type=1, ki=KEYBDINPUT(wVk=key, dwFlags=2 if release else 0, dwExtraInfo=0x57525453)) for key in keys]
    inputs = (INPUT * len(events))(*events)
    if user.SendInput(len(inputs), inputs, c.sizeof(INPUT)) != len(inputs):
        raise c.WinError(c.get_last_error())

def switch_burst_worker(request, allowed_windows):
    held = []
    release_times = []
    error = None
    try:
        def down(key):
            held.append(key)
            send_keys([key])
        def up(key):
            send_keys([key], release=True)
            held.remove(key)
        if user.GetForegroundWindow() not in allowed_windows:
            raise RuntimeError("Foreground left the owned switch fixture; no chords sent")
        if not request.get("release_win"):
            down(0x5b)
        for index, key in enumerate([0x85, 0x86] * 4):
            if user.GetForegroundWindow() not in allowed_windows:
                raise RuntimeError("Foreground left the owned switch fixture; no further chords sent")
            if request.get("release_win"):
                down(0x5b)
            down(key)
            release_times.append(time.perf_counter() * 1000)
            up(key)
            if request.get("release_win"):
                up(0x5b)
            if index < 7 and request.get("spacing_ms"):
                time.sleep(request["spacing_ms"] / 1000)
        if not request.get("release_win"):
            up(0x5b)
    except Exception as caught:
        error = str(caught)
    finally:
        if held:
            try:
                send_keys(list(reversed(held)), release=True)
            except Exception as caught:
                error = f"{error or 'Input cleanup failed'}: {caught}"
    print(json.dumps({"id": request["id"], **({"error": error} if error else {"result": release_times})}), flush=True)

def owned(hwnd):
    pid = w.DWORD()
    user.GetWindowThreadProcessId(hwnd, c.byref(pid))
    if pid.value not in (os.getpid(), args.app_pid):
        if firefox_scope is None:
            raise RuntimeError("Refusing to interact with an unowned window")
        firefox_scope.checked(hwnd)

deadline = time.monotonic() + args.lifetime
next_firefox_scan = 0
switch_worker = None
try:
    while time.monotonic() < deadline:
        if firefox_scope is not None and time.monotonic() >= next_firefox_scan:
            firefox_scope.track_children()
            next_firefox_scan = time.monotonic() + 1
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
            if command == "observe_start":
                if observer_thread is not None:
                    raise RuntimeError("Fixture input observer is already running")
                observer_stop.clear()
                while not observer_events.empty(): observer_events.get_nowait()
                observer_thread = threading.Thread(target=observe_worker, daemon=True)
                observer_thread.start()
                if not observer_ready.get(timeout=3):
                    raise RuntimeError("Cannot start fixture input observer")
            elif command == "observe_stop":
                stop_observer()
            elif command == "observe_events":
                result = []
                while not observer_events.empty(): result.append(observer_events.get_nowait())
            elif command == "app_window":
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
            elif command in ("app_state", "app_close"):
                hwnd = int(request["window"])
                app_class_name = checked_app_window(hwnd)
                title = c.create_unicode_buffer(256)
                user.GetWindowTextW(hwnd, title, len(title))
                if title.value != args.marker:
                    raise RuntimeError("Lifecycle operation requires the fixture's exact main-window title")
                if command == "app_close" and not user.PostMessageW(hwnd, 0x10, 0, 0):
                    raise c.WinError(c.get_last_error())
                result = {"window": hwnd, "pid": args.app_pid, "className": app_class_name,
                          "visible": bool(user.IsWindowVisible(hwnd)), "foreground": user.GetForegroundWindow() == hwnd}
            elif command == "fixture_window_state":
                hwnd = int(request["window"])
                checked_app_window(hwnd)
                result = {"visible": bool(user.IsWindowVisible(hwnd)), "foreground": user.GetForegroundWindow() == hwnd}
            elif command == "tray_menu":
                result = tray_menu(request["action"])
            elif command == "calculator_begin":
                result = begin_calculator()
            elif command == "calculator_cleanup":
                result = cleanup_calculator()
            elif command == "firefox_begin":
                if firefox_scope is not None:
                    raise RuntimeError("Firefox fixture already exists")
                firefox_scope = FirefoxScope(request)
            elif command == "firefox_launch":
                if firefox_scope is None:
                    raise RuntimeError("Firefox fixture has not been initialized")
                result = firefox_scope.launch(request)
            elif command == "firefox_refresh":
                if firefox_scope is None:
                    raise RuntimeError("Firefox fixture has not been initialized")
                result = firefox_scope.refresh()
            elif command == "firefox_windows":
                if firefox_scope is None:
                    raise RuntimeError("Firefox fixture has not been initialized")
                firefox_scope.track_children()
                result = firefox_scope.windows()
            elif command == "firefox_place_background":
                if firefox_scope is None:
                    raise RuntimeError("Firefox fixture has not been initialized")
                hwnd = int(request["window"])
                firefox_scope.checked(hwnd)
                if user.IsIconic(hwnd) or user.IsZoomed(hwnd):
                    raise RuntimeError("Background placement requires an owned floating Firefox window")
                rect = request["rect"]
                if not user.SetWindowPos(hwnd, None, rect["x"], rect["y"], rect["width"], rect["height"], 0x14):
                    raise c.WinError(c.get_last_error())
            elif command == "firefox_cleanup":
                if firefox_scope is None:
                    result = {"tracked": 0, "terminated": [], "errors": []}
                else:
                    scope, firefox_scope = firefox_scope, None
                    result = scope.cleanup()
            elif command == "close_fixture":
                if close_fixture["window"] is not None:
                    raise RuntimeError("Close fixture already exists")
                hwnd = user.CreateWindowExW(0, class_name, args.marker + "-close", 0x10CF0000,
                                            160, 130, 500, 320, None, None, instance, None)
                if not hwnd:
                    raise c.WinError(c.get_last_error())
                windows.append(hwnd)
                close_fixture["window"] = hwnd
                result = hwnd
            elif command == "close_status":
                if "allow" in request:
                    close_fixture["allow"] = bool(request["allow"])
                result = {"requests": close_fixture["requests"],
                          "exists": bool(user.IsWindow(close_fixture["window"]))}
            elif command == "minimize":
                hwnd = int(request.get("window", windows[0]))
                owned(hwnd)
                user.ShowWindow(hwnd, 6)
            elif command == "startup_value":
                try:
                    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
                        result = winreg.QueryValueEx(key, "WindowWarp")[0]
                except FileNotFoundError:
                    result = None
            elif command == "reserve":
                key = request["key"]
                modifiers = 0x4008 if request.get("meta") else 0x4007
                if not user.RegisterHotKey(windows[0], key, modifiers, key):
                    raise c.WinError(c.get_last_error())
                reserved.add(key)
            elif command == "release":
                key = request["key"]
                if not user.UnregisterHotKey(windows[0], key):
                    raise c.WinError(c.get_last_error())
                reserved.discard(key)
            elif command == "hotkey_events":
                result = list(hotkey_events)
            elif command == "activation_events":
                result = list(activation_events)
                activation_events.clear()
                activation_timings.clear()
            elif command == "timed_activation_events":
                result = list(activation_timings)
                activation_events.clear()
                activation_timings.clear()
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
                    held_modifiers = all(modifier in held_keys for modifier in [0x11, 0x12, 0x10])
                    safe_super_overlap = 0x5b in held_keys and 0x85 in held_keys and key == 0x86
                    if (not held_modifiers and not safe_super_overlap) or key in held_keys:
                        raise RuntimeError("Tap requires fixture-held modifiers and a fresh allowed key")
                    send_keys([key])
                    send_keys([key], release=True)
            elif command in ("focus", "press", "plain_press", "hold_start", "burst", "switch_burst", "place"):
                hwnd = int(request.get("window", windows[0]))
                owned(hwnd)
                # Activating or typing into a maximized window must preserve
                # that state, otherwise the helper masks toggle/push defects.
                if command == "place" or not user.IsZoomed(hwnd):
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
                        hit = user.WindowFromPoint(click_point)
                        if hit != hwnd and not user.IsChild(hwnd, hit):
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
                if command in ("press", "plain_press", "hold_start", "burst", "switch_burst"):
                    if any(user.GetAsyncKeyState(key) & 0x8000 for key in (0x10, 0x11, 0x12, 0x5B, 0x5C)):
                        raise RuntimeError("A modifier is already held; no keys sent")
                    if command == "switch_burst":
                        if switch_worker is not None and switch_worker.is_alive():
                            raise RuntimeError("A switch burst is already running")
                        if request.get("spacing_ms", 0) not in (0, 80):
                            raise RuntimeError("Switch fixture supports only zero or 80 ms spacing")
                        peer = int(request["peer_window"])
                        pid = w.DWORD()
                        user.GetWindowThreadProcessId(peer, c.byref(pid))
                        title = c.create_unicode_buffer(512)
                        user.GetWindowTextW(peer, title, len(title))
                        if pid.value != request["peer_pid"] or not title.value.startswith(args.marker):
                            raise RuntimeError("The peer target is not the named fixture window")
                        # Keep both fixture windows' message loops running while
                        # input is injected, so WM_ACTIVATE timing is meaningful.
                        switch_worker = threading.Thread(target=switch_burst_worker,
                            args=(request.copy(), set(windows) | {peer}), daemon=True)
                        switch_worker.start()
                        continue
                    elif command == "burst":
                        if request["key"] != 0x85:
                            raise RuntimeError("Burst is limited to the fixture's F22 shortcut")
                        sequence = [(0x5b,False),(0x85,False),(0x85,True),(0x85,False),(0x85,True),(0x5b,True)]
                        events = (INPUT * len(sequence))(*(INPUT(type=1, ki=KEYBDINPUT(wVk=key, dwFlags=2 if up else 0, dwExtraInfo=0x57525453)) for key,up in sequence))
                        held_keys = [0x5b, 0x85]
                        if user.SendInput(len(events), events, c.sizeof(INPUT)) != len(events):
                            raise c.WinError(c.get_last_error())
                        held_keys = []
                    elif command == "plain_press":
                        if request["key"] not in (66,88,67,13,0x85):
                            raise RuntimeError("Only B/X/C, Enter and F22 are supported by the fixture")
                        if request["key"] == 13:
                            checked_app_window(hwnd)
                        keys = ([0x5B] if request.get("meta",False) else []) + [request["key"]]
                    elif request.get("meta") and command == "hold_start":
                        keys = [0x5B, request["key"]]
                    else:
                        keys = [0x11, 0x12, 0x10, request["key"]]
                    if command == "burst":
                        print(json.dumps({"id": request["id"], "result": True}), flush=True)
                        continue
                    held_keys = keys.copy()
                    gap = min(max(float(request.get("gap_ms", 0)), 0), 50) / 1000
                    def transmit(sequence, release=False):
                        if not gap:
                            send_keys(sequence, release=release)
                        else:
                            for item in sequence:
                                send_keys([item], release=release)
                                time.sleep(gap)
                    transmit(keys)
                    if command in ("press", "plain_press"):
                        transmit(list(reversed(keys)), release=True)
                        held_keys = []
            else:
                raise RuntimeError("Unknown fixture command")
            print(json.dumps({"id": request["id"], "result": result}), flush=True)
        except Exception as error:
            print(json.dumps({"id": request["id"], "error": str(error)}), flush=True)
finally:
    if switch_worker is not None:
        switch_worker.join(timeout=3)
    stop_observer()
    if app_process_handle is not None:
        kernel.CloseHandle(app_process_handle)
    if firefox_scope is not None:
        try:
            receipt = firefox_scope.cleanup()
            if receipt["errors"]:
                print("Firefox cleanup: " + json.dumps(receipt), file=sys.stderr, flush=True)
        except Exception as error:
            print("Firefox cleanup failed: " + str(error), file=sys.stderr, flush=True)
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
