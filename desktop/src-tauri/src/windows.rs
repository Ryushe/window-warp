use crate::{
    config::{Binding, Config, Settings},
    geometry::{relative, Rect},
};
use std::{
    collections::HashMap,
    ptr::null_mut,
    sync::{LazyLock, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use windows_sys::core::BOOL;
use windows_sys::Win32::{
    Foundation::*, Graphics::Gdi::*, System::Threading::*, UI::WindowsAndMessaging::*,
};
#[path = "windows_gestures.rs"]
mod gestures;
#[path = "windows_reserved.rs"]
mod reserved;

#[derive(Clone, Copy)]
struct Placement {
    hwnd: usize,
    pid: u32,
    rect: Rect,
    maximized: bool,
}
static ACTION_SHORTCUTS: Mutex<Vec<Shortcut>> = Mutex::new(Vec::new());
static PAUSE_SHORTCUTS: Mutex<Vec<Shortcut>> = Mutex::new(Vec::new());
static HISTORY: Mutex<Vec<Placement>> = Mutex::new(Vec::new());
static PREVIOUS: LazyLock<Mutex<HashMap<String, (usize, u32)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static MAXIMIZE_RESTORE: LazyLock<Mutex<HashMap<usize, (u32, Rect)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static RESTORE_PROPERTY: LazyLock<Vec<u16>> = LazyLock::new(|| {
    format!("WindowWarp.RestoreRect.{}\0", std::process::id())
        .encode_utf16()
        .collect()
});

unsafe fn restore_identity(hwnd: HWND, expected_pid: u32) -> bool {
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    // Windows removes properties on destruction. PID alone would not detect a
    // recycled HWND in the same process between two maximize shortcuts.
    pid == expected_pid && GetPropW(hwnd, RESTORE_PROPERTY.as_ptr()) as usize == 1
}

unsafe fn toggle_maximize(hwnd: HWND) -> Result<(), String> {
    let mut saved = MAXIMIZE_RESTORE.lock().map_err(|e| e.to_string())?;
    saved.retain(|id, (pid, _)| restore_identity(*id as HWND, *pid));
    if IsZoomed(hwnd) != 0 {
        ShowWindow(hwnd, SW_RESTORE);
        if let Some((_, target)) = saved.get(&(hwnd as usize)) {
            place(hwnd, *target, false)?;
        }
    } else {
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        let target = window_rect(hwnd)?;
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if SetPropW(hwnd, RESTORE_PROPERTY.as_ptr(), 1usize as HANDLE) == 0 {
            return Err(error("Cannot remember window restore geometry"));
        }
        saved.insert(hwnd as usize, (pid, target));
        ShowWindow(hwnd, SW_MAXIMIZE);
    }
    Ok(())
}

fn error(message: &str) -> String {
    format!("{message}: {}", std::io::Error::last_os_error())
}
fn rect(value: RECT) -> Rect {
    Rect {
        x: value.left,
        y: value.top,
        width: value.right - value.left,
        height: value.bottom - value.top,
    }
}
unsafe fn window_rect(hwnd: HWND) -> Result<Rect, String> {
    let mut r = RECT::default();
    if GetWindowRect(hwnd, &mut r) == 0 {
        return Err(error("Cannot read window position"));
    }
    Ok(rect(r))
}
unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _: HDC,
    _: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if GetMonitorInfoW(monitor, &mut info) != 0 {
        (*(data as *mut Vec<(usize, Rect)>)).push((monitor as usize, rect(info.rcWork)));
    }
    1
}
unsafe fn monitors() -> Result<Vec<(usize, Rect)>, String> {
    let mut result: Vec<(usize, Rect)> = Vec::new();
    if EnumDisplayMonitors(
        null_mut(),
        std::ptr::null(),
        Some(collect_monitor),
        &mut result as *mut _ as LPARAM,
    ) == 0
    {
        return Err(error("Cannot list monitors"));
    }
    result.sort_by_key(|(_, r)| (r.x, r.y));
    if result.is_empty() {
        return Err("No monitors available.".into());
    }
    Ok(result)
}
unsafe fn place(hwnd: HWND, target: Rect, maximized: bool) -> Result<(), String> {
    if IsIconic(hwnd) != 0 || IsZoomed(hwnd) != 0 {
        ShowWindow(hwnd, SW_RESTORE);
    }
    if SetWindowPos(
        hwnd,
        null_mut(),
        target.x,
        target.y,
        target.width,
        target.height,
        SWP_NOZORDER | SWP_NOACTIVATE,
    ) == 0
    {
        return Err(error("Cannot move window"));
    }
    if maximized {
        ShowWindow(hwnd, SW_MAXIMIZE);
    }
    Ok(())
}
unsafe fn focus(hwnd: HWND) -> Result<(), String> {
    if IsIconic(hwnd) != 0 {
        ShowWindow(hwnd, SW_RESTORE);
    }
    if SetForegroundWindow(hwnd) == 0 {
        return Err("Windows prevented focus from changing. Try the shortcut again from a normal, non-administrator app.".into());
    }
    Ok(())
}
unsafe fn center_pointer(area: Rect) -> Result<(), String> {
    let x = (f64::from(area.x) + f64::from(area.width) / 2.0).round() as i32;
    let y = (f64::from(area.y) + f64::from(area.height) / 2.0).round() as i32;
    if SetCursorPos(x, y) == 0 {
        return Err(error("Cannot center the pointer"));
    }
    Ok(())
}
unsafe extern "system" fn collect_window(hwnd: HWND, data: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd) != 0 {
        (*(data as *mut Vec<usize>)).push(hwnd as usize);
    }
    1
}
#[cfg(test)]
unsafe fn executable(hwnd: HWND) -> Option<String> {
    Some(executable_path(hwnd)?.rsplit('\\').next()?.to_lowercase())
}
unsafe fn executable_path(hwnd: HWND) -> Option<String> {
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if process.is_null() {
        return None;
    }
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size);
    CloseHandle(process);
    if ok == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..size as usize]))
}

unsafe fn monitor_name(handle: usize) -> String {
    let mut info: MONITORINFOEXW = std::mem::zeroed();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(handle as HMONITOR, &mut info.monitorInfo) == 0 {
        return String::new();
    }
    let length = info
        .szDevice
        .iter()
        .position(|c| *c == 0)
        .unwrap_or(info.szDevice.len());
    String::from_utf16_lossy(&info.szDevice[..length])
}

pub fn snapshot(_: &AppHandle) -> Result<Vec<crate::workspaces::WindowInfo>, String> {
    unsafe { snapshot_native(true) }
}
pub fn snapshot_for_binding(
    _: &AppHandle,
    binding: &Binding,
) -> Result<Vec<crate::workspaces::WindowInfo>, String> {
    let explicit = binding.windows_match.is_some();
    unsafe { snapshot_native_matching(!explicit, explicit) }
}
unsafe fn snapshot_native(exclude_own: bool) -> Result<Vec<crate::workspaces::WindowInfo>, String> {
    snapshot_native_matching(exclude_own, false)
}
unsafe fn snapshot_native_matching(
    exclude_own: bool,
    explicit_match: bool,
) -> Result<Vec<crate::workspaces::WindowInfo>, String> {
    use crate::workspaces::WindowInfo;
    unsafe {
        let all = monitors()?;
        let mut handles: Vec<usize> = Vec::new();
        EnumWindows(Some(collect_window), &mut handles as *mut _ as LPARAM);
        let mut result = Vec::new();
        for handle in handles {
            let hwnd = handle as HWND;
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if (exclude_own && pid == std::process::id())
                || (!explicit_match
                    && (hwnd == GetShellWindow()
                        || hwnd == GetDesktopWindow()
                        || !GetWindow(hwnd, GW_OWNER).is_null()
                        || GetWindowTextLengthW(hwnd) == 0
                        || GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW as isize != 0))
            {
                continue;
            }
            let mut cloaked = 0u32;
            windows_sys::Win32::Graphics::Dwm::DwmGetWindowAttribute(
                hwnd,
                windows_sys::Win32::Graphics::Dwm::DWMWA_CLOAKED as u32,
                &mut cloaked as *mut _ as *mut _,
                4,
            );
            if !explicit_match && cloaked != 0 {
                continue;
            }
            let path = match executable_path(hwnd) {
                Some(path) => path,
                None if explicit_match => String::new(),
                None => continue,
            };
            let Some(app_id) = path.rsplit('\\').next().map(|s| s.to_lowercase()) else {
                continue;
            };
            let mut buffer = vec![0u16; (GetWindowTextLengthW(hwnd) + 1).max(1) as usize];
            let length =
                GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32).max(0) as usize;
            let title = String::from_utf16_lossy(&buffer[..length]);
            let mut class_buffer = [0u16; 256];
            let class_length =
                GetClassNameW(hwnd, class_buffer.as_mut_ptr(), class_buffer.len() as i32).max(0)
                    as usize;
            let class_name = String::from_utf16_lossy(&class_buffer[..class_length]);
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) as usize;
            let index = all.iter().position(|(id, _)| *id == monitor).unwrap_or(0);
            let Ok(geometry) = window_rect(hwnd) else {
                continue;
            };
            if geometry.width <= 0 || geometry.height <= 0 {
                continue;
            }
            let maximized = IsZoomed(hwnd) != 0;
            result.push(WindowInfo {
                id: handle.to_string(),
                pid,
                title,
                class_name,
                app_id,
                desktop_id: crate::windows_apps::identity(hwnd),
                path,
                rect: geometry,
                work_area: all[index].1,
                monitor: index + 1,
                monitor_name: monitor_name(monitor),
                maximized_horizontal: maximized,
                maximized_vertical: maximized,
                fullscreen: false,
                minimized: IsIconic(hwnd) != 0,
                active: hwnd == GetForegroundWindow(),
            });
        }
        Ok(result)
    }
}

pub fn restore_window(
    _: &AppHandle,
    current: &crate::workspaces::WindowInfo,
    saved: &crate::workspaces::WindowInfo,
) -> Result<(), String> {
    unsafe { restore_native(current, saved) }
}
pub fn raise_window(hwnd: isize) {
    unsafe {
        let hwnd = hwnd as HWND;
        let foreground = GetForegroundWindow();
        let target_thread = GetWindowThreadProcessId(hwnd, null_mut());
        let foreground_thread = GetWindowThreadProcessId(foreground, null_mut());
        let attached = foreground_thread != 0
            && foreground_thread != target_thread
            && AttachThreadInput(foreground_thread, target_thread, 1) != 0;
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
        if attached {
            AttachThreadInput(foreground_thread, target_thread, 0);
        }
    }
}
pub fn capture_super_held() -> bool {
    reserved::capture_super_held()
}
pub fn super_key_down() -> bool {
    // The hook's own key state. GetAsyncKeyState stays up after a swallowed Win.
    reserved::super_down()
}
pub fn capture_active() -> bool {
    reserved::capturing()
}
pub fn mouse_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON};
    unsafe {
        [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON]
            .into_iter()
            .any(|key| GetAsyncKeyState(i32::from(key)) < 0)
    }
}
pub fn editor_foreground() -> Option<String> {
    reserved::editor_hwnd().map(|hwnd| hwnd.to_string())
}
pub fn focus_captured(_: &AppHandle, id: &str, pid: u32) -> Result<(), String> {
    unsafe {
        let hwnd = id.parse::<usize>().map_err(|_| "Invalid window ID.")? as HWND;
        let mut actual = 0;
        GetWindowThreadProcessId(hwnd, &mut actual);
        if IsWindow(hwnd) == 0 || actual != pid {
            return Ok(());
        }
        focus(hwnd)
    }
}
pub fn focus_window(_: &AppHandle, current: &crate::workspaces::WindowInfo) -> Result<(), String> {
    unsafe {
        let hwnd = current
            .id
            .parse::<usize>()
            .map_err(|_| "Invalid window ID.")? as HWND;
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if IsWindow(hwnd) == 0 || pid != current.pid {
            return Err("The selected window has closed or changed identity.".into());
        }
        focus(hwnd)
    }
}
unsafe fn restore_native(
    current: &crate::workspaces::WindowInfo,
    saved: &crate::workspaces::WindowInfo,
) -> Result<(), String> {
    unsafe {
        let hwnd = current
            .id
            .parse::<usize>()
            .map_err(|_| "Invalid window ID.")? as HWND;
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if IsWindow(hwnd) == 0 || pid != current.pid {
            return Err("The selected window has closed or changed identity.".into());
        }
        let all = monitors()?;
        let target = all
            .iter()
            .find(|(id, _)| {
                !saved.monitor_name.is_empty() && monitor_name(*id) == saved.monitor_name
            })
            .unwrap_or(&all[saved.monitor.saturating_sub(1).min(all.len() - 1)])
            .1;
        place(
            hwnd,
            relative(saved.rect, saved.work_area, target),
            saved.maximized_horizontal && saved.maximized_vertical,
        )?;
        if saved.minimized {
            ShowWindow(hwnd, SW_MINIMIZE);
        }
        Ok(())
    }
}

fn tile_rect(area: Rect, direction: &str) -> Rect {
    match direction {
        "tile-up" => Rect {
            height: area.height / 2,
            ..area
        },
        "tile-down" => Rect {
            y: area.y + area.height / 2,
            height: area.height - area.height / 2,
            ..area
        },
        "tile-right" => Rect {
            x: area.x + area.width / 2,
            width: area.width - area.width / 2,
            ..area
        },
        _ => Rect {
            width: area.width / 2,
            ..area
        },
    }
}

pub fn pointer(_: &AppHandle) -> Result<crate::radial::Point, String> {
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) } == 0 {
        return Err(error("Cannot read pointer position"));
    }
    Ok(crate::radial::Point {
        x: point.x,
        y: point.y,
    })
}
pub fn pointer_area(_: &AppHandle, point: crate::radial::Point) -> Result<Rect, String> {
    unsafe {
        let monitor = MonitorFromPoint(
            POINT {
                x: point.x,
                y: point.y,
            },
            MONITOR_DEFAULTTONEAREST,
        ) as usize;
        monitors()?
            .into_iter()
            .find(|(id, _)| *id == monitor)
            .map(|(_, area)| area)
            .ok_or_else(|| "The pointer's monitor is no longer connected.".into())
    }
}
pub fn show_radial(app: &AppHandle, bounds: Rect) -> Result<(), String> {
    let window = app
        .get_webview_window("radial")
        .ok_or("The window picker is unavailable.")?;
    window
        .set_size(tauri::PhysicalSize::new(
            bounds.width as u32,
            bounds.height as u32,
        ))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    // The picker tracks the cursor. Taking focus grabs the mouse and makes
    // Windows drop the key-up, so the menu never closes or chooses.
    let _ = window.set_focusable(false);
    window.show().map_err(|e| e.to_string())
}

unsafe fn pull_app(
    binding: &Binding,
    settings: &Settings,
    hold_pointer: Option<POINT>,
) -> Result<(), String> {
    pull_app_target(binding, settings, hold_pointer, None, None)
}

pub fn pull_selected(
    app: &AppHandle,
    binding: &Binding,
    settings: &Settings,
    selected: &crate::workspaces::WindowInfo,
    previous: Option<&crate::workspaces::WindowInfo>,
) -> Result<(), String> {
    let _ = app;
    unsafe { pull_app_target(binding, settings, None, Some(selected), previous) }
}
unsafe fn pull_app_target(
    binding: &Binding,
    settings: &Settings,
    hold_pointer: Option<POINT>,
    selected: Option<&crate::workspaces::WindowInfo>,
    previous: Option<&crate::workspaces::WindowInfo>,
) -> Result<(), String> {
    let active = previous
        .and_then(|w| {
            let hwnd = w.id.parse::<usize>().ok()? as HWND;
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            (IsWindow(hwnd) != 0 && pid == w.pid).then_some(hwnd)
        })
        .unwrap_or_else(|| GetForegroundWindow());
    let candidates = matching_windows(binding, Some(active))?;
    let target = if let Some(selected) = selected {
        candidates
            .iter()
            .find(|w| w.id == selected.id && w.pid == selected.pid)
            .ok_or("The selected window has closed or changed identity.")?
    } else {
        let active_id = (active as usize).to_string();
        candidates
            .iter()
            .find(|w| w.id == active_id)
            .or_else(|| candidates.first())
            .ok_or("No matching app window is open.")?
    };
    let hwnd = target
        .id
        .parse::<usize>()
        .map_err(|_| "Invalid window ID.")? as HWND;
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if IsWindow(hwnd) == 0 || pid != target.pid {
        return Err("The selected window has closed or changed identity.".into());
    }
    let was_active = hwnd == active;
    if !was_active && !active.is_null() {
        let mut pid = 0;
        GetWindowThreadProcessId(active, &mut pid);
        PREVIOUS
            .lock()
            .map_err(|e| e.to_string())?
            .insert(binding.shortcut.clone(), (active as usize, pid));
    }
    let all = monitors()?;
    let primary = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) as usize;
    let main = if settings.main_monitor == 0 {
        all.iter().position(|(id, _)| *id == primary).unwrap_or(0)
    } else {
        (settings.main_monitor - 1).min(all.len() - 1)
    };
    let current = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) as usize;
    if IsIconic(hwnd) != 0 {
        ShowWindow(hwnd, SW_RESTORE);
    }
    if let Some(point) = hold_pointer {
        let area = all[main].1;
        let direction = crate::geometry::mouse_tile_direction(area, point.x, point.y);
        place(hwnd, tile_rect(area, direction), false)?;
        return focus(hwnd);
    }
    if current == all[main].0 {
        if was_active && binding.main_monitor_action == "focus-last" {
            let previous = PREVIOUS
                .lock()
                .map_err(|e| e.to_string())?
                .get(&binding.shortcut)
                .copied();
            if let Some((old, expected_pid)) = previous {
                let old = old as HWND;
                let mut pid = 0;
                GetWindowThreadProcessId(old, &mut pid);
                if IsWindow(old) != 0 && pid == expected_pid {
                    return focus(old);
                }
            }
        } else if was_active && all.len() > 1 {
            let burner = (settings.burner_monitor - 1).min(all.len() - 1);
            let burner = if burner == main {
                (main + 1) % all.len()
            } else {
                burner
            };
            let target_area = all[burner].1;
            let old = window_rect(hwnd)?;
            let maximized = IsZoomed(hwnd) != 0;
            let (target, maximize) = match binding.burner_layout.as_str() {
                "tile-left" | "tile-right" => {
                    (tile_rect(target_area, &binding.burner_layout), false)
                }
                "fullscreen" => (target_area, true),
                _ => (relative(old, all[main].1, target_area), maximized),
            };
            place(hwnd, target, maximize)?;
        }
    } else {
        let source = all
            .iter()
            .find(|(id, _)| *id == current)
            .unwrap_or(&all[main])
            .1;
        place(
            hwnd,
            relative(window_rect(hwnd)?, source, all[main].1),
            IsZoomed(hwnd) != 0,
        )?;
    }
    focus(hwnd)?;
    if current != all[main].0 || !was_active {
        center_pointer(all[main].1)?;
    }
    Ok(())
}

unsafe fn matching_windows(
    binding: &Binding,
    previous_active: Option<HWND>,
) -> Result<Vec<crate::workspaces::WindowInfo>, String> {
    // Explicit WinTitle criteria follow the original WinGetList visible-window
    // scope, including this process and owned/untitled windows. Workspace capture
    // and legacy native app IDs retain their normal-application window filters.
    let explicit = binding.windows_match.is_some();
    let mut windows = snapshot_native_matching(!explicit, explicit)?;
    retain_matching_windows(
        &mut windows,
        binding,
        previous_active.map(|hwnd| hwnd as usize),
    );
    Ok(windows)
}

fn retain_matching_windows(
    windows: &mut Vec<crate::workspaces::WindowInfo>,
    binding: &Binding,
    previous_active: Option<usize>,
) {
    // The radial picker owns foreground focus while it is open. An active-only
    // selector still refers to the validated window active before the picker.
    if let Some(active) = previous_active {
        let active = active.to_string();
        for window in windows.iter_mut() {
            window.active = window.id == active;
        }
    }
    windows.retain(|window| crate::window_match::matches(binding, window));
}

unsafe fn execute(binding: &Binding, settings: &Settings) -> Result<(), String> {
    let action = binding.action.as_str();
    let app_match = binding.app_match.as_str();
    if action == "pull-app" {
        return pull_app(binding, settings, None);
    }
    if action == "focus-app" {
        let mut matching = matching_windows(binding, None)?;
        matching.sort_by_key(|w| w.id.parse::<usize>().unwrap_or(0));
        if matching.is_empty() {
            return Err(format!(
                "No open window for {app_match}. Open the app first."
            ));
        }
        let active = (GetForegroundWindow() as usize).to_string();
        let next = matching
            .iter()
            .position(|w| w.id == active)
            .map_or(0, |i| (i + 1) % matching.len());
        let selected = &matching[next];
        let hwnd = selected
            .id
            .parse::<usize>()
            .map_err(|_| "Invalid window ID.")? as HWND;
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if IsWindow(hwnd) == 0 || pid != selected.pid {
            return Err("The selected window has closed or changed identity.".into());
        }
        return focus(hwnd);
    }
    if action == "pull" {
        let mut history = HISTORY.lock().map_err(|e| e.to_string())?;
        while let Some(previous) = history.pop() {
            let hwnd = previous.hwnd as HWND;
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if IsWindow(hwnd) == 0 || pid != previous.pid {
                continue;
            }
            let all = monitors()?;
            let r = previous.rect;
            let center = POINT {
                x: r.x + r.width / 2,
                y: r.y + r.height / 2,
            };
            let monitor = MonitorFromPoint(center, MONITOR_DEFAULTTONEAREST) as usize;
            let area = all
                .iter()
                .find(|(id, _)| *id == monitor)
                .unwrap_or(&all[0])
                .1;
            let target = relative(r, area, area);
            if let Err(e) = place(hwnd, target, previous.maximized) {
                history.push(previous);
                return Err(e);
            }
            focus(hwnd)?;
            let primary = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) as usize;
            return center_pointer(
                all.iter()
                    .find(|(id, _)| *id == primary)
                    .unwrap_or(&all[0])
                    .1,
            );
        }
        return Err("No pushed window to bring back.".into());
    }
    let hwnd = GetForegroundWindow();
    if hwnd.is_null() || hwnd == GetShellWindow() || hwnd == GetDesktopWindow() {
        return Err("Focus an application window first.".into());
    }
    if action == "close-window" {
        if PostMessageW(hwnd, WM_CLOSE, 0, 0) == 0 {
            return Err(error("Cannot close window"));
        }
        return Ok(());
    }
    if action == "toggle-maximize" {
        return toggle_maximize(hwnd);
    }
    let all = monitors()?;
    let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) as usize;
    let index = all.iter().position(|(id, _)| *id == monitor).unwrap_or(0);
    let area = all[index].1;
    let old = window_rect(hwnd)?;
    let maximized = IsZoomed(hwnd) != 0;
    if action.starts_with("tile-") {
        return place(hwnd, tile_rect(area, action), false);
    }
    if all.len() == 1
        && matches!(
            action,
            "push-left" | "push-right" | "push-left-center" | "push-right-center"
        )
    {
        // Nowhere to move. Tile in place instead of repeating a no-op push.
        let direction = if action.starts_with("push-left") {
            "tile-left"
        } else {
            "tile-right"
        };
        place(hwnd, tile_rect(area, direction), false)?;
        if action.ends_with("-center") {
            center_pointer(area)?;
        }
        return Ok(());
    }
    let next = if action == "push-left" || action == "push-left-center" {
        (index + all.len() - 1) % all.len()
    } else {
        (index + 1) % all.len()
    };
    let target = relative(old, area, all[next].1);
    place(hwnd, target, maximized)?;
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    let mut history = HISTORY.lock().map_err(|e| e.to_string())?;
    if history.len() >= 100 {
        history.remove(0);
    }
    history.push(Placement {
        hwnd: hwnd as usize,
        pid,
        rect: old,
        maximized,
    });
    crate::retile::arm(
        crate::retile::Target {
            id: (hwnd as usize).to_string(),
            pid,
        },
        std::time::Duration::from_secs(1),
    );
    if action.ends_with("-center") {
        center_pointer(all[next].1)?;
    }
    Ok(())
}

fn parsed_bindings(config: &Config, pause: bool) -> Result<Vec<(Binding, Shortcut)>, String> {
    config
        .bindings
        .iter()
        .filter(|b| b.enabled && (b.action == "toggle-pause") == pause)
        .map(|b| {
            Ok((
                b.clone(),
                b.shortcut
                    .parse()
                    .map_err(|e| format!("Invalid shortcut {}: {e}", b.shortcut))?,
            ))
        })
        .collect()
}

fn unregister_tracked(
    app: &AppHandle,
    tracked: &mut Vec<Shortcut>,
    keys: &[Shortcut],
) -> Result<(), String> {
    let mut errors = Vec::new();
    for key in keys {
        match app.global_shortcut().unregister(*key) {
            Ok(()) => tracked.retain(|registered| registered != key),
            Err(error) => errors.push(format!("{key:?}: {error}")),
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[path = "windows_retile.rs"]
mod retile_hooks;
pub use retile_hooks::RetileHooks;
pub fn retile_window(
    _: &AppHandle,
    target: &crate::retile::Target,
    left: bool,
) -> Result<(), String> {
    let hwnd = target
        .id
        .parse::<usize>()
        .map_err(|_| "Invalid pushed window identity.")? as HWND;
    unsafe {
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if IsWindow(hwnd) == 0 || pid != target.pid {
            return Err("The pushed window closed before it could be tiled.".into());
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) as usize;
        let all = monitors()?;
        let area = all
            .iter()
            .find(|(id, _)| *id == monitor)
            .ok_or("The window's monitor disconnected.")?
            .1;
        focus(hwnd)?;
        place(
            hwnd,
            tile_rect(area, if left { "tile-left" } else { "tile-right" }),
            false,
        )
    }
}

pub(super) fn run_binding(app: &AppHandle, binding: &Binding, settings: &Settings) {
    if crate::app_actions::is_control(&binding.action) {
        crate::app_actions::dispatch(app, &binding.action);
    } else if binding.action == "pull-app" {
        if let Err(message) = gestures::press(app, binding, settings) {
            let _ = app.emit("warp-error", message);
        }
    } else if let Err(message) = unsafe { execute(binding, settings) } {
        let _ = app.emit("warp-error", message);
    }
}

pub fn configure_pause(app: &AppHandle, config: &Config) -> Result<(), String> {
    // Super chords belong to Windows until shortcuts are enabled. Registering
    // them here fails and would also steal keys such as Win+; while paused.
    let desired: Vec<_> = parsed_bindings(config, true)?
        .into_iter()
        .filter(|(binding, _)| !reserved::is_super(&binding.shortcut))
        .map(|(_, key)| key)
        .collect();
    let mut current = PAUSE_SHORTCUTS.lock().map_err(|e| e.to_string())?;
    let additions: Vec<_> = desired
        .iter()
        .filter(|key| !current.contains(key))
        .copied()
        .collect();
    let mut added = Vec::new();
    for key in additions {
        if let Err(error) = app.global_shortcut().on_shortcut(key, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                crate::app_actions::dispatch(app, "toggle-pause");
            }
        }) {
            let cleanup = unregister_tracked(app, &mut current, &added);
            return Err(format!(
                "Cannot register the pause shortcut {key:?}: {error}.{}",
                cleanup
                    .err()
                    .map(|e| format!(" Cleanup also failed: {e}"))
                    .unwrap_or_default()
            ));
        }
        current.push(key);
        added.push(key);
    }
    let removed: Vec<_> = current
        .iter()
        .filter(|key| !desired.contains(key))
        .copied()
        .collect();
    unregister_tracked(app, &mut current, &removed)
}

pub fn enable(app: &AppHandle, config: &Config) -> Result<(), String> {
    // Validate the whole batch before installing any window-action hooks.
    let bindings = parsed_bindings(config, false)?;
    let mut installed = ACTION_SHORTCUTS.lock().map_err(|e| e.to_string())?;
    let mut hooked = Vec::new();
    for (binding, _) in parsed_bindings(config, true)? {
        if reserved::is_super(&binding.shortcut) {
            hooked.push(reserved::Armed {
                settings: config.settings.clone(),
                binding,
            });
        }
    }
    for (binding, shortcut) in bindings {
        if reserved::is_super(&binding.shortcut) {
            hooked.push(reserved::Armed {
                settings: config.settings.clone(),
                binding,
            });
            continue;
        }
        let key = binding.shortcut.clone();
        let settings = config.settings.clone();
        if let Err(e) = app
            .global_shortcut()
            .on_shortcut(shortcut, move |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    if crate::retile::fire(&binding.shortcut) {
                        return;
                    }
                    run_binding(app, &binding, &settings);
                }
            })
        {
            let keys = installed.clone();
            let cleanup = unregister_tracked(app, &mut installed, &keys);
            reserved::clear_active();
            return Err(format!(
                "Cannot register {key}. It may be used by Windows or another app: {e}{}",
                cleanup
                    .err()
                    .map(|e| format!("; cleanup failed: {e}"))
                    .unwrap_or_default()
            ));
        }
        installed.push(shortcut);
    }
    drop(installed);
    reserved::stop_recording();
    if let Err(error) = reserved::set_active(app.clone(), hooked) {
        let mut installed = ACTION_SHORTCUTS.lock().map_err(|e| e.to_string())?;
        let keys = installed.clone();
        let _ = unregister_tracked(app, &mut installed, &keys);
        return Err(error);
    }
    gestures::enable()
}
pub fn disable(app: &AppHandle) -> Result<(), String> {
    gestures::cancel()?;
    // The pause chord stays installed so Super+pause can turn shortcuts back on.
    // Every other Windows hotkey is released.
    reserved::retain_pause();
    let mut installed = ACTION_SHORTCUTS.lock().map_err(|e| e.to_string())?;
    let keys = installed.clone();
    unregister_tracked(app, &mut installed, &keys)?;
    // Pausing cancels transient input, not the user's movement/focus history.
    // These process-local caches also survive configuration re-registration.
    // The pause key stays only when Windows does not already own it.
    Ok(())
}
pub fn start_recording(app: AppHandle, popup: bool) -> Result<(), String> {
    reserved::start_recording(app, popup)
}
pub fn stop_recording() {
    reserved::stop_recording();
}
pub fn shutdown(app: &AppHandle) {
    let _ = gestures::cancel();
    reserved::clear_active();
    reserved::stop_recording();
    let _ = app.global_shortcut().unregister_all();
    if let Ok(mut saved) = MAXIMIZE_RESTORE.lock() {
        for (id, (pid, _)) in saved.drain() {
            unsafe {
                if restore_identity(id as HWND, pid) {
                    RemovePropW(id as HWND, RESTORE_PROPERTY.as_ptr());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct OwnedTerminals(Vec<crate::workspaces::WindowInfo>);
    impl Drop for OwnedTerminals {
        fn drop(&mut self) {
            for window in &self.0 {
                unsafe {
                    let hwnd = window.id.parse::<usize>().unwrap() as HWND;
                    let mut pid = 0;
                    GetWindowThreadProcessId(hwnd, &mut pid);
                    if pid == window.pid {
                        PostMessageW(hwnd, WM_CLOSE, 0, 0);
                    }
                }
            }
        }
    }

    #[test]
    #[ignore = "opens and closes two owned Windows Terminal fixture windows"]
    fn native_terminal_capture_and_new_window_launch() {
        use crate::{terminal, workspaces};
        use std::{
            collections::HashSet,
            time::{Duration, Instant},
        };
        let before: HashSet<_> = unsafe { snapshot_native(true).unwrap() }
            .into_iter()
            .map(|w| w.id)
            .collect();
        let mut owned = OwnedTerminals(Vec::new());
        let status = std::process::Command::new("wt.exe")
            .args([
                "-w",
                "new",
                "new-tab",
                "--title",
                "Command Prompt",
                "--suppressApplicationTitle",
                "cmd.exe",
            ])
            .status()
            .unwrap();
        assert!(status.success());
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let windows = unsafe { snapshot_native(true).unwrap() };
            if let Some(window) = windows.into_iter().find(|w| {
                !before.contains(&w.id)
                    && w.title == "Command Prompt"
                    && terminal::kind(w) == Some(terminal::Kind::WindowsTerminal)
            }) {
                owned.0.push(window);
                break;
            }
            assert!(Instant::now() < deadline, "Owned terminal did not open");
            std::thread::sleep(Duration::from_millis(100));
        }
        let mut profile = workspaces::capture(owned.0.clone(), "Terminal fixture".into());
        terminal::enrich(&mut profile.items);
        let item = &profile.items[0];
        assert!(item.capture_note.is_empty(), "{}", item.capture_note);
        let mut terminal = item.terminal.clone().unwrap();
        assert_eq!(terminal.shell, "cmd.exe");
        let marker = format!("Window Warp terminal {}", uuid::Uuid::new_v4());
        terminal.shell_args = vec!["/k".into(), format!("title {marker}")];
        workspaces::launch(&terminal.launch_command(&item.launch).unwrap()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let windows = unsafe { snapshot_native(true).unwrap() };
            if let Some(window) = windows.into_iter().find(|w| {
                !before.contains(&w.id)
                    && w.title == marker
                    && terminal::kind(w) == Some(terminal::Kind::WindowsTerminal)
            }) {
                assert_ne!(window.id, owned.0[0].id);
                owned.0.push(window);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Restored terminal did not open with its own shell arguments"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    #[ignore = "requires WARP_TEST_WSL_DISTRO; opens and closes owned WSL Terminal windows"]
    fn native_wsl_capture_and_directory_restore() {
        use crate::{terminal, workspaces, wsl};
        use std::{
            collections::HashSet,
            time::{Duration, Instant},
        };
        let distro = std::env::var("WARP_TEST_WSL_DISTRO").expect("Choose a fixture distribution");
        let discovery = wsl::Discovery::default();
        assert!(discovery.installed().unwrap().contains(&distro));
        let identity = discovery.identity(&distro).unwrap();
        assert_eq!(
            discovery
                .resolve_prompt(
                    &format!("{}@{}:~", identity.user, identity.host),
                    std::slice::from_ref(&distro)
                )
                .unwrap(),
            Some(distro.clone())
        );
        let before: HashSet<_> = unsafe { snapshot_native(true).unwrap() }
            .into_iter()
            .map(|w| w.id)
            .collect();
        let marker = format!("{distro} - Window Warp {}", uuid::Uuid::new_v4());
        let mut owned = OwnedTerminals(Vec::new());
        assert!(std::process::Command::new("wt.exe")
            .args([
                "-w",
                "new",
                "new-tab",
                "--title",
                &marker,
                "--suppressApplicationTitle",
                "wsl.exe",
                "--distribution",
                &distro,
                "--exec",
                "/bin/sh",
                "-c",
                "sleep 60"
            ])
            .status()
            .unwrap()
            .success());
        let wait = |title: &str| {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                if let Some(window) =
                    unsafe { snapshot_native(true).unwrap() }
                        .into_iter()
                        .find(|w| {
                            !before.contains(&w.id)
                                && w.title == title
                                && terminal::kind(w) == Some(terminal::Kind::WindowsTerminal)
                        })
                {
                    return window;
                }
                assert!(
                    Instant::now() < deadline,
                    "Owned WSL terminal did not show expected title: {title}"
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        };
        owned.0.push(wait(&marker));
        let mut profile = workspaces::capture(owned.0.clone(), "WSL fixture".into());
        terminal::enrich(&mut profile.items);
        let item = &profile.items[0];
        assert!(item.capture_note.is_empty(), "{}", item.capture_note);
        let mut terminal = item.terminal.clone().unwrap();
        assert_eq!(terminal.shell, "wsl.exe");
        assert_eq!(terminal.wsl_distro, distro);
        assert!(
            terminal.shell_args.is_empty(),
            "Do not replay the captured command"
        );
        terminal.working_directory = "/tmp".into();
        let restored = format!("Window Warp WSL {}", uuid::Uuid::new_v4());
        terminal.shell_args = vec![
            "--exec".into(),
            "/bin/sh".into(),
            "-c".into(),
            format!("printf '\\033]0;{restored}:%s\\007' \"$PWD\"; sleep 60"),
        ];
        workspaces::launch(&terminal.launch_command(&item.launch).unwrap()).unwrap();
        owned.0.push(wait(&format!("{restored}:/tmp")));
        assert_ne!(owned.0[0].id, owned.0[1].id);
    }

    // The portable-Terminal fixture must never terminate a Terminal process:
    // Windows Terminal can host several windows in the same process.
    struct OwnedPortableTerminal {
        window: crate::workspaces::WindowInfo,
        process: HANDLE,
        created: u64,
        property: Vec<u16>,
    }

    impl OwnedPortableTerminal {
        unsafe fn creation(process: HANDLE) -> Result<u64, String> {
            let mut times: [FILETIME; 4] = std::mem::zeroed();
            if GetProcessTimes(
                process,
                &mut times[0],
                &mut times[1],
                &mut times[2],
                &mut times[3],
            ) == 0
            {
                return Err(error("Cannot verify fixture process creation"));
            }
            Ok((u64::from(times[0].dwHighDateTime) << 32) | u64::from(times[0].dwLowDateTime))
        }

        fn claim(window: crate::workspaces::WindowInfo, marker: &str) -> Result<Self, String> {
            let hwnd = window.id.parse::<usize>().map_err(|e| e.to_string())? as HWND;
            unsafe {
                let process = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    window.pid,
                );
                if process.is_null() {
                    return Err(error("Cannot retain fixture Terminal identity"));
                }
                let created = match Self::creation(process) {
                    Ok(value) => value,
                    Err(message) => {
                        CloseHandle(process);
                        return Err(message);
                    }
                };
                let property: Vec<u16> = format!("WindowWarp.Native.{marker}\0")
                    .encode_utf16()
                    .collect();
                let mut pid = 0;
                GetWindowThreadProcessId(hwnd, &mut pid);
                if pid != window.pid || SetPropW(hwnd, property.as_ptr(), 1usize as HANDLE) == 0 {
                    CloseHandle(process);
                    return Err(error("Cannot mark owned fixture Terminal window"));
                }
                Ok(Self {
                    window,
                    process,
                    created,
                    property,
                })
            }
        }

        fn current(&self) -> bool {
            unsafe {
                let hwnd = self.window.id.parse::<usize>().unwrap() as HWND;
                let mut pid = 0;
                GetWindowThreadProcessId(hwnd, &mut pid);
                pid == self.window.pid
                    && GetPropW(hwnd, self.property.as_ptr()) as usize == 1
                    && WaitForSingleObject(self.process, 0) == WAIT_TIMEOUT
                    && Self::creation(self.process).ok() == Some(self.created)
            }
        }

        fn close(&self) -> Result<(), String> {
            if !self.current() {
                return Ok(());
            }
            unsafe {
                if PostMessageW(
                    self.window.id.parse::<usize>().unwrap() as HWND,
                    WM_CLOSE,
                    0,
                    0,
                ) == 0
                {
                    return Err(error("Cannot close owned portable Terminal window"));
                }
            }
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while self.current() {
                if std::time::Instant::now() >= deadline {
                    return Err(format!("Owned Terminal did not close: {}", self.window.id));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Ok(())
        }
    }

    impl Drop for OwnedPortableTerminal {
        fn drop(&mut self) {
            if let Err(message) = self.close() {
                eprintln!("Fixture cleanup: {message}");
            }
            unsafe {
                if self.current() {
                    RemovePropW(
                        self.window.id.parse::<usize>().unwrap() as HWND,
                        self.property.as_ptr(),
                    );
                }
                CloseHandle(self.process);
            }
        }
    }

    #[test]
    #[ignore = "requires isolated portable WARP_TEST_TERMINAL_BINARY and WARP_TEST_TERMINAL_PROFILE"]
    fn native_powershell_profile_and_directory_restore() {
        use crate::{terminal, workspaces};
        use std::{
            collections::HashSet,
            path::{Path, PathBuf},
            time::{Duration, Instant},
        };
        #[derive(serde::Deserialize)]
        struct Receipt {
            pid: u32,
            directory: String,
            profile: String,
        }
        let binary = PathBuf::from(
            std::env::var("WARP_TEST_TERMINAL_BINARY")
                .expect("Choose the isolated portable Terminal executable"),
        );
        assert!(binary.is_absolute() && binary.is_file());
        let portable = binary.parent().unwrap();
        assert!(
            portable.join(".portable").is_file(),
            "Requires isolated portable Terminal"
        );
        assert!(portable.join("settings/settings.json").is_file());
        let profile_name = std::env::var("WARP_TEST_TERMINAL_PROFILE")
            .expect("Choose an existing fixture profile");
        assert!(!profile_name.trim().is_empty());
        let settings: serde_json::Value = serde_json::from_slice(
            &std::fs::read(portable.join("settings/settings.json")).unwrap(),
        )
        .expect("The isolated fixture settings must be JSON");
        let matching_profiles: Vec<_> = settings["profiles"]["list"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|profile| profile["name"].as_str() == Some(&profile_name))
            .collect();
        assert_eq!(
            matching_profiles.len(),
            1,
            "Fixture profile name must identify one configured profile"
        );
        let expected_profile = matching_profiles[0]["guid"]
            .as_str()
            .expect("Fixture profile needs a GUID")
            .to_owned();
        let same_profile = |actual: &str| {
            actual
                .trim_matches(['{', '}'])
                .eq_ignore_ascii_case(expected_profile.trim_matches(['{', '}']))
        };
        let mut shells = vec![PathBuf::from(std::env::var("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe")];
        if let Ok(pwsh) = std::env::var("WARP_TEST_PWSH_PATH") {
            shells.push(PathBuf::from(pwsh));
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/windows-validation")
            .join(format!("terminal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
        let same_path = |left: &Path, right: &Path| {
            std::fs::canonicalize(left).unwrap() == std::fs::canonicalize(right).unwrap()
        };
        for shell in shells {
            assert!(
                shell.is_absolute() && shell.is_file(),
                "Explicit shell must exist"
            );
            let shell_name = shell.file_name().unwrap().to_str().unwrap().to_lowercase();
            assert!(["powershell.exe", "pwsh.exe"].contains(&shell_name.as_str()));
            let directory = root.join(format!("{shell_name} directory with spaces"));
            std::fs::create_dir(&directory).unwrap();
            let before: HashSet<_> = unsafe { snapshot_native(true).unwrap() }
                .into_iter()
                .map(|w| w.id)
                .collect();
            let startup = |marker: &str, receipt: &Path| {
                vec![
                "-NoLogo".into(), "-NoProfile".into(), "-NonInteractive".into(), "-NoExit".into(), "-Command".into(),
                format!("& {{ [IO.File]::WriteAllText({}, (@{{pid=$PID;directory=$PWD.Path;profile=$env:WT_PROFILE_ID}} | ConvertTo-Json -Compress)); $Host.UI.RawUI.WindowTitle={} }} *> {}", quote(&receipt.to_string_lossy()), quote(marker), quote(&receipt.with_extension("log").to_string_lossy()))
            ]
            };
            let fixture_title = |mut command: workspaces::LaunchSpec, marker: &str| {
                command.args.splice(
                    3..3,
                    [
                        "--title".into(),
                        marker.into(),
                        "--suppressApplicationTitle".into(),
                    ],
                );
                command
            };
            let wait_owned = |marker: &str, receipt: &Path, command: &workspaces::LaunchSpec| {
                let deadline = Instant::now() + Duration::from_secs(20);
                let mut owned: Option<OwnedPortableTerminal> = None;
                loop {
                    // The Terminal-owned UUID title exists independently of
                    // shell startup. Claim it before validating any receipt so
                    // failed startup/proof assertions still close this window.
                    if owned.is_none() {
                        if let Some(window) = unsafe { snapshot_native(true).unwrap() }
                            .into_iter()
                            .find(|w| {
                                !before.contains(&w.id)
                                    && w.title == marker
                                    && terminal::kind(w) == Some(terminal::Kind::WindowsTerminal)
                                    && std::fs::canonicalize(&w.path).ok()
                                        == Some(std::fs::canonicalize(&binary).unwrap())
                            })
                        {
                            owned = Some(OwnedPortableTerminal::claim(window, marker).unwrap());
                        }
                    }
                    let (proof, receipt_status) = match std::fs::read_to_string(receipt) {
                        Ok(text) => match serde_json::from_str::<Receipt>(&text) {
                            Ok(value) => (Some(value), "valid receipt".to_owned()),
                            Err(error) => (
                                None,
                                format!("receipt JSON invalid ({} bytes): {error}", text.len()),
                            ),
                        },
                        Err(error) => (None, format!("receipt read failed: {error}")),
                    };
                    if let Some(window) = owned.as_ref().map(|guard| &guard.window) {
                        if let Some(proof) = proof {
                            let processes = crate::process_info::snapshot().unwrap();
                            let child = processes
                                .iter()
                                .find(|p| p.pid == proof.pid)
                                .expect("Fixture shell receipt PID must still exist");
                            assert!(child.name.eq_ignore_ascii_case(&shell_name));
                            assert!(
                                child.args.iter().any(|arg| arg.contains(marker)
                                    && arg.contains(&receipt.to_string_lossy().to_string())),
                                "Shell argv must contain this exact fixture marker and receipt"
                            );
                            let mut ancestor = child.parent;
                            for _ in 0..32 {
                                if ancestor == window.pid {
                                    break;
                                }
                                ancestor = processes
                                    .iter()
                                    .find(|p| p.pid == ancestor)
                                    .map(|p| p.parent)
                                    .unwrap_or(0);
                            }
                            assert_eq!(
                                ancestor, window.pid,
                                "Receipt shell must belong to the marked Terminal window process"
                            );
                            return (owned.take().unwrap(), proof);
                        }
                    }
                    if Instant::now() >= deadline {
                        for process in crate::process_info::snapshot().unwrap_or_default() {
                            if process.name.eq_ignore_ascii_case(&shell_name)
                                && process.args.iter().any(|arg| {
                                    arg.contains(marker)
                                        && arg.contains(&receipt.to_string_lossy().to_string())
                                })
                            {
                                eprintln!("Fixture shell argv: {:?}", process.args);
                            }
                        }
                    }
                    assert!(
                        Instant::now() < deadline,
                        "Owned Terminal startup failed; marker={marker}, window_claimed={}, window_still_owned={}, receipt={}, status={receipt_status}, fixture_launch={}",
                        owned.is_some(),
                        owned.as_ref().is_some_and(|window| window.current()),
                        receipt.display(),
                        serde_json::to_string(command).unwrap()
                    );
                    std::thread::sleep(Duration::from_millis(100));
                }
            };
            let marker = format!("Warp-PS-{}", uuid::Uuid::new_v4());
            let receipt = directory.join("initial.json");
            let initial = terminal::Terminal {
                profile_name: profile_name.clone(),
                shell: shell.to_string_lossy().into_owned(),
                shell_args: startup(&marker, &receipt),
                working_directory: directory.to_string_lossy().into_owned(),
                ..Default::default()
            };
            let base = workspaces::LaunchSpec {
                program: binary.to_string_lossy().into_owned(),
                ..Default::default()
            };
            let command = fixture_title(initial.launch_command(&base).unwrap(), &marker);
            workspaces::launch(&command).unwrap();
            let (first, proof) = wait_owned(&marker, &receipt, &command);
            assert!(same_path(Path::new(&proof.directory), &directory));
            assert!(
                same_profile(&proof.profile),
                "Initial shell must actually use the configured fixture profile GUID"
            );
            let windows = unsafe { snapshot_native(true).unwrap() };
            let mut captured =
                workspaces::capture(windows.clone(), "Owned PowerShell fixture".into());
            terminal::enrich(&mut captured.items);
            // Enrichment needs every same-process window, but diagnostics and
            // assertions retain only the window proven owned above.
            captured.items.retain(|item| {
                item.window.id == first.window.id && item.window.pid == first.window.pid
            });
            assert_eq!(captured.items.len(), 1);
            let item = &captured.items[0];
            assert!(item.capture_note.is_empty(), "{}", item.capture_note);
            assert!(
                Path::new(&item.launch.program).is_absolute()
                    && same_path(Path::new(&item.launch.program), &binary),
                "Captured launcher must resolve to the isolated portable Terminal before restoring: {}",
                item.launch.program
            );
            let mut saved = item.terminal.clone().unwrap();
            assert!(
                same_path(Path::new(&saved.shell), &shell),
                "Capture must preserve the explicit PowerShell executable path"
            );
            assert!(
                saved.shell_args.is_empty(),
                "Capture must not replay startup commands"
            );
            assert_eq!(saved.profile_name, profile_name);
            assert!(same_path(Path::new(&saved.working_directory), &directory));
            assert!(terminal::Capture::new().matches(&first.window, &windows, &saved));
            let restored_marker = format!("Warp-PS-{}", uuid::Uuid::new_v4());
            let restored_receipt = directory.join("restored.json");
            saved.shell_args = startup(&restored_marker, &restored_receipt);
            // Deliberately use the captured launcher unchanged: portable
            // capture must not silently route restoration to the user's wt.exe.
            let command = fixture_title(
                saved.launch_command(&item.launch).unwrap(),
                &restored_marker,
            );
            workspaces::launch(&command).unwrap();
            let (second, proof) = wait_owned(&restored_marker, &restored_receipt, &command);
            assert_ne!(first.window.id, second.window.id);
            assert!(same_path(Path::new(&second.window.path), &binary));
            assert!(same_path(Path::new(&proof.directory), &directory));
            assert!(
                same_profile(&proof.profile),
                "Restored shell must actually use the configured fixture profile GUID"
            );
            let excluded: HashSet<_> = windows.iter().map(|window| window.id.clone()).collect();
            let current = unsafe { snapshot_native(true).unwrap() };
            let matching = terminal::matching_new_windows(&current, &excluded, &saved);
            assert!(
                matching
                    .iter()
                    .any(|window| window.id == second.window.id && window.pid == second.window.pid),
                "Fresh native terminal identity must admit the newly restored owned window"
            );
            assert!(
                !matching.iter().any(|window| window.id == first.window.id),
                "The preexisting owned terminal must stay excluded"
            );
            let incompatible = terminal::Terminal {
                shell: "cmd.exe".into(),
                ..saved.clone()
            };
            assert!(
                !terminal::matching_new_windows(&current, &excluded, &incompatible)
                    .iter()
                    .any(|window| window.id == second.window.id),
                "The native PowerShell window must not satisfy a different saved shell"
            );
            second.close().unwrap();
            first.close().unwrap();
            eprintln!("Portable Terminal {shell_name}: capture, profile, directory, compatibility, new-window restore and fresh identity filtering passed; {}", directory.display());
        }
    }

    #[test]
    fn recorded_punctuation_and_navigation_keys_parse_natively() {
        for key in [
            ";",
            "'",
            "`",
            ",",
            ".",
            "/",
            "\\",
            "-",
            "=",
            "[",
            "]",
            "Enter",
            "Escape",
            "PageUp",
            "PageDown",
            "Home",
            "End",
            "Backspace",
            "Delete",
            "Insert",
        ] {
            let mut config = Config::default();
            config.bindings.truncate(1);
            config.bindings[0].shortcut = format!("Super+{key}");
            config.validate().unwrap();
            assert!(
                config.bindings[0].shortcut.parse::<Shortcut>().is_ok(),
                "{}",
                config.bindings[0].shortcut
            );
        }
    }

    #[test]
    fn vertical_tiles_cover_the_work_area_at_negative_origins() {
        let area = Rect {
            x: -1081,
            y: -193,
            width: 1081,
            height: 1921,
        };
        let top = tile_rect(area, "tile-up");
        let bottom = tile_rect(area, "tile-down");
        assert_eq!(top.y + top.height, bottom.y);
        assert_eq!(top.height + bottom.height, area.height);
        assert_eq!(bottom.x, area.x);
        assert_eq!(bottom.width, area.width);
    }

    #[test]
    #[ignore = "owned visible selector fixtures; requires WARP_TEST_WINDOWS_MATCH=1"]
    fn native_window_selectors_capture_class_and_widen_explicit_scope() {
        use crate::window_match::WindowsMatch;
        assert_eq!(std::env::var("WARP_TEST_WINDOWS_MATCH").as_deref(), Ok("1"));
        struct OwnedWindow(HWND);
        impl Drop for OwnedWindow {
            fn drop(&mut self) {
                unsafe { DestroyWindow(self.0) };
            }
        }
        unsafe {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let title: Vec<u16> = "Window Warp Selector CaseSensitive\0"
                .encode_utf16()
                .collect();
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW,
                120,
                120,
                400,
                300,
                null_mut(),
                null_mut(),
                null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null(), "{}", error("Create selector fixture"));
            let _owned = OwnedWindow(hwnd);
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let id = (hwnd as usize).to_string();
            let captured = snapshot_native(false)
                .unwrap()
                .into_iter()
                .find(|w| w.id == id)
                .expect("Named fixture must be captured");
            assert!(captured.class_name.eq_ignore_ascii_case("STATIC"));
            let mut binding = Config::default().bindings.remove(0);
            binding.app_match.clear();
            binding.windows_match = Some(WindowsMatch {
                packaged_app_id: String::new(),
                title_contains: "Selector CaseSensitive".into(),
                class_name: captured.class_name.clone(),
                executable: captured.path.clone(),
                process_id: Some(captured.pid),
                window_id: Some(id.clone()),
                active_only: false,
            });
            assert!(crate::window_match::matches(&binding, &captured));
            assert!(
                matching_windows(&binding, None)
                    .unwrap()
                    .iter()
                    .any(|w| w.id == id),
                "Explicit WinTitle rules must not exclude their own process's visible target"
            );
            binding.windows_match.as_mut().unwrap().title_contains =
                "selector casesensitive".into();
            assert!(!crate::window_match::matches(&binding, &captured));
            binding
                .windows_match
                .as_mut()
                .unwrap()
                .title_contains
                .clear();
            binding.windows_match.as_mut().unwrap().process_id = Some(captured.pid.wrapping_add(1));
            assert!(!crate::window_match::matches(&binding, &captured));
            binding.windows_match.as_mut().unwrap().process_id = Some(captured.pid);
            binding.windows_match.as_mut().unwrap().window_id = Some("1".into());
            assert!(!crate::window_match::matches(&binding, &captured));
            binding.windows_match.as_mut().unwrap().window_id = Some(id.clone());
            binding.windows_match.as_mut().unwrap().active_only = true;
            let mut picker_snapshot = captured.clone();
            picker_snapshot.active = false;
            let mut during_picker = vec![picker_snapshot];
            retain_matching_windows(&mut during_picker, &binding, Some(hwnd as usize));
            assert_eq!(
                during_picker.len(),
                1,
                "Active-only selection uses pre-picker identity"
            );
            let mut wrong_active = vec![captured.clone()];
            retain_matching_windows(&mut wrong_active, &binding, Some(1));
            assert!(wrong_active.is_empty());

            let tool = CreateWindowExW(
                WS_EX_TOOLWINDOW,
                class.as_ptr(),
                std::ptr::null(),
                WS_OVERLAPPEDWINDOW,
                180,
                180,
                300,
                220,
                hwnd,
                null_mut(),
                null_mut(),
                std::ptr::null(),
            );
            assert!(
                !tool.is_null(),
                "{}",
                error("Create untitled owned tool fixture")
            );
            let _tool = OwnedWindow(tool);
            ShowWindow(tool, SW_SHOWNOACTIVATE);
            let tool_id = (tool as usize).to_string();
            assert!(!snapshot_native(false)
                .unwrap()
                .iter()
                .any(|w| w.id == tool_id));
            let explicit = snapshot_native_matching(false, true)
                .unwrap()
                .into_iter()
                .find(|w| w.id == tool_id)
                .expect("Explicit selectors include untitled owned tool windows");
            assert_eq!(explicit.title, "");
            assert_eq!(explicit.class_name, captured.class_name);
            binding.windows_match = Some(WindowsMatch {
                class_name: explicit.class_name.clone(),
                process_id: Some(explicit.pid),
                window_id: Some(tool_id.clone()),
                ..Default::default()
            });
            assert!(crate::window_match::matches(&binding, &explicit));
            assert!(
                !snapshot_native_matching(true, true)
                    .unwrap()
                    .iter()
                    .any(|w| w.id == tool_id),
                "Production selectors continue to exclude the application's own windows"
            );
            ShowWindow(tool, SW_HIDE);
            assert!(
                !snapshot_native_matching(false, true)
                    .unwrap()
                    .iter()
                    .any(|w| w.id == tool_id),
                "Explicit selectors still exclude hidden windows"
            );
        }
    }

    #[test]
    fn native_positioning_and_process_lookup_on_an_owned_window() {
        // A hidden fixture keeps this test away from the user's windows.
        struct OwnedWindow(HWND);
        impl Drop for OwnedWindow {
            fn drop(&mut self) {
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }
        unsafe {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_OVERLAPPEDWINDOW,
                100,
                100,
                400,
                300,
                null_mut(),
                null_mut(),
                null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null(), "{}", error("Create fixture"));
            let _owned = OwnedWindow(hwnd);
            let target = Rect {
                x: 140,
                y: 160,
                width: 600,
                height: 450,
            };
            place(hwnd, target, false).unwrap();
            assert_eq!(window_rect(hwnd).unwrap(), target);
            assert!(executable(hwnd).unwrap().ends_with(".exe"));
            assert!(!monitors().unwrap().is_empty());

            // Exercise the actual enumeration/restore boundary using only our
            // own fixture. Production capture excludes the settings process.
            let title: Vec<u16> = "Window Warp workspace fixture\0".encode_utf16().collect();
            SetWindowTextW(hwnd, title.as_ptr());
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let id = (hwnd as usize).to_string();
            let captured = snapshot_native(false)
                .unwrap()
                .into_iter()
                .find(|w| w.id == id)
                .expect("Visible fixture must be captured");
            assert_eq!(captured.title, "Window Warp workspace fixture");
            assert_eq!(captured.pid, std::process::id());
            assert_eq!(captured.rect, target);
            assert!(!captured.monitor_name.is_empty());
            assert!(!snapshot_native(true).unwrap().iter().any(|w| w.id == id));
            let mut saved = captured.clone();
            saved.rect = Rect {
                x: captured.work_area.x + 40,
                y: captured.work_area.y + 50,
                width: 500,
                height: 350,
            };
            restore_native(&captured, &saved).unwrap();
            assert_eq!(window_rect(hwnd).unwrap(), saved.rect);
            saved.maximized_horizontal = true;
            saved.maximized_vertical = true;
            restore_native(&captured, &saved).unwrap();
            assert_ne!(IsZoomed(hwnd), 0);
            saved.maximized_horizontal = false;
            saved.maximized_vertical = false;
            saved.minimized = true;
            restore_native(&captured, &saved).unwrap();
            assert_ne!(IsIconic(hwnd), 0);
            saved.minimized = false;
            restore_native(&captured, &saved).unwrap();
            assert_eq!(window_rect(hwnd).unwrap(), saved.rect);
            let mut stale = captured.clone();
            stale.pid = captured.pid.wrapping_add(1);
            assert!(restore_native(&stale, &saved)
                .unwrap_err()
                .contains("changed identity"));

            place(hwnd, target, false).unwrap();
            toggle_maximize(hwnd).unwrap();
            assert_ne!(IsZoomed(hwnd), 0);
            place(hwnd, saved.rect, true).unwrap();
            toggle_maximize(hwnd).unwrap();
            assert_eq!(window_rect(hwnd).unwrap(), target);
            // Like fullscreen.ahk, retaining the last saved rectangle also
            // handles a later native maximize without overwriting the cache.
            place(hwnd, saved.rect, true).unwrap();
            toggle_maximize(hwnd).unwrap();
            assert_eq!(window_rect(hwnd).unwrap(), target);

            // Missing per-window lifetime marker invalidates the map entry,
            // even if a replacement window has the same HWND and process ID.
            RemovePropW(hwnd, RESTORE_PROPERTY.as_ptr());
            place(hwnd, saved.rect, true).unwrap();
            toggle_maximize(hwnd).unwrap();
            assert_eq!(window_rect(hwnd).unwrap(), saved.rect);
            assert!(!MAXIMIZE_RESTORE
                .lock()
                .unwrap()
                .contains_key(&(hwnd as usize)));
        }
    }
}
