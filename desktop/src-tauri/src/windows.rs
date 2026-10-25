use crate::{
    config::{Binding, Config, Settings},
    geometry::{relative, Rect},
};
use std::{
    collections::HashMap,
    ptr::null_mut,
    sync::{LazyLock, Mutex},
};
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use windows_sys::core::BOOL;
use windows_sys::Win32::{
    Foundation::*, Graphics::Gdi::*, System::Threading::*, UI::WindowsAndMessaging::*,
};

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
unsafe extern "system" fn collect_window(hwnd: HWND, data: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd) != 0
        && GetWindow(hwnd, GW_OWNER).is_null()
        && GetWindowTextLengthW(hwnd) > 0
    {
        (*(data as *mut Vec<usize>)).push(hwnd as usize);
    }
    1
}
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
unsafe fn snapshot_native(exclude_own: bool) -> Result<Vec<crate::workspaces::WindowInfo>, String> {
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
                || hwnd == GetShellWindow()
                || hwnd == GetDesktopWindow()
                || GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW as isize != 0
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
            if cloaked != 0 {
                continue;
            }
            let Some(path) = executable_path(hwnd) else {
                continue;
            };
            let Some(app_id) = path.rsplit('\\').next().map(|s| s.to_lowercase()) else {
                continue;
            };
            let mut buffer = vec![0u16; (GetWindowTextLengthW(hwnd) + 1).max(1) as usize];
            let length =
                GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32).max(0) as usize;
            let title = String::from_utf16_lossy(&buffer[..length]);
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
                app_id,
                desktop_id: String::new(),
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

unsafe fn pull_app(binding: &Binding, settings: &Settings) -> Result<(), String> {
    let mut candidates: Vec<usize> = Vec::new();
    EnumWindows(Some(collect_window), &mut candidates as *mut _ as LPARAM);
    let active = GetForegroundWindow();
    let app_match = binding.app_match.to_lowercase();
    candidates.retain(|h| executable(*h as HWND).as_deref() == Some(app_match.as_str()));
    let hwnd = candidates
        .iter()
        .copied()
        .find(|h| *h == active as usize)
        .or_else(|| candidates.first().copied())
        .ok_or("No matching app window is open.")? as HWND;
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
    focus(hwnd)
}

unsafe fn execute(binding: &Binding, settings: &Settings) -> Result<(), String> {
    let action = binding.action.as_str();
    let app_match = binding.app_match.as_str();
    if action == "pull-app" {
        return pull_app(binding, settings);
    }
    if action == "focus-app" {
        let mut windows: Vec<usize> = Vec::new();
        EnumWindows(Some(collect_window), &mut windows as *mut _ as LPARAM);
        let mut matching: Vec<_> = windows
            .into_iter()
            .filter(|h| {
                executable(*h as HWND).as_deref() == Some(app_match.to_lowercase().as_str())
            })
            .collect();
        matching.sort_unstable();
        if matching.is_empty() {
            return Err(format!(
                "No open window for {app_match}. Open the app first."
            ));
        }
        let active = GetForegroundWindow() as usize;
        let next = matching
            .iter()
            .position(|h| *h == active)
            .map_or(0, |i| (i + 1) % matching.len());
        return focus(matching[next] as HWND);
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
            return focus(hwnd);
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
        ShowWindow(
            hwnd,
            if IsZoomed(hwnd) != 0 {
                SW_RESTORE
            } else {
                SW_MAXIMIZE
            },
        );
        return Ok(());
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
    if all.len() < 2 {
        return Err("Connect a second monitor to push windows.".into());
    }
    let next = if action == "push-left" {
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

pub fn configure_pause(app: &AppHandle, config: &Config) -> Result<(), String> {
    let desired: Vec<_> = parsed_bindings(config, true)?
        .into_iter()
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
    for (binding, shortcut) in bindings {
        let key = binding.shortcut.clone();
        let settings = config.settings.clone();
        if let Err(e) = app
            .global_shortcut()
            .on_shortcut(shortcut, move |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    if crate::app_actions::is_control(&binding.action) {
                        crate::app_actions::dispatch(app, &binding.action);
                    } else if let Err(message) = unsafe { execute(&binding, &settings) } {
                        let _ = app.emit("warp-error", message);
                    }
                }
            })
        {
            let keys = installed.clone();
            let cleanup = unregister_tracked(app, &mut installed, &keys);
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
    Ok(())
}
pub fn disable(app: &AppHandle) -> Result<(), String> {
    let mut installed = ACTION_SHORTCUTS.lock().map_err(|e| e.to_string())?;
    let keys = installed.clone();
    unregister_tracked(app, &mut installed, &keys)?;
    HISTORY.lock().map_err(|e| e.to_string())?.clear();
    PREVIOUS.lock().map_err(|e| e.to_string())?.clear();
    Ok(())
}
pub fn shutdown(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
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
        }
    }
}
