//! Pick an existing top-level window without sending the selection click to it.
use crate::workspaces::{WindowInfo, WorkspaceItem};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

static PICKING: AtomicBool = AtomicBool::new(false);

fn item_for_window(window: WindowInfo) -> Result<WorkspaceItem, String> {
    let mut profile = crate::workspaces::capture(vec![window], String::new());
    crate::terminal::enrich(&mut profile.items);
    profile
        .items
        .pop()
        .ok_or_else(|| "Choose an open, visible app window.".into())
}

#[cfg(any(target_os = "linux", test))]
fn selected_window(
    windows: Vec<WindowInfo>,
    id: &str,
    pid: Option<u32>,
) -> Result<WindowInfo, String> {
    let mut matches = windows
        .into_iter()
        .filter(|window| window.id == id && pid.is_none_or(|pid| window.pid == pid));
    let window = matches
        .next()
        .ok_or("That window is no longer available on this desktop.")?;
    if matches.next().is_some() {
        return Err("KDE could not uniquely identify that window.".into());
    }
    Ok(window)
}

#[tauri::command]
pub async fn workspace_open_windows(app: AppHandle) -> Result<Vec<WorkspaceItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let windows = crate::platform::snapshot_current(&app)?;
        let mut profile = crate::workspaces::capture(windows, String::new());
        crate::terminal::enrich(&mut profile.items);
        Ok(profile.items)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn pick_workspace_window(app: AppHandle) -> Result<Option<WorkspaceItem>, String> {
    if PICKING.swap(true, Ordering::SeqCst) {
        return Err("Finish choosing the current window first.".into());
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            PICKING.store(false, Ordering::SeqCst);
        }
    }
    let _reset = Reset;
    let main = app
        .get_webview_window("main")
        .ok_or("The workspace editor is unavailable.")?;
    main.minimize()
        .map_err(|error| format!("Could not start window selection: {error}"))?;
    let result = tauri::async_runtime::spawn_blocking(move || pick(&app)).await;
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
    result
        .map_err(|error| error.to_string())?
        .and_then(|window| window.map(item_for_window).transpose())
}

#[cfg(target_os = "linux")]
fn pick(app: &AppHandle) -> Result<Option<WindowInfo>, String> {
    use std::collections::HashMap;
    use zbus::{
        blocking::{connection::Builder, Proxy},
        zvariant::OwnedValue,
    };
    let connection = Builder::session()
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    let kwin = Proxy::new(&connection, "org.kde.KWin", "/KWin", "org.kde.KWin")
        .map_err(|error| error.to_string())?;
    let info: HashMap<String, OwnedValue> = match kwin.call("queryWindowInfo", &()) {
        Ok(info) => info,
        Err(zbus::Error::MethodError(name, _, _))
            if name.as_str() == "org.kde.KWin.Error.UserCancel" =>
        {
            return Ok(None)
        }
        Err(error) => return Err(format!("KDE could not choose a window: {error}")),
    };
    let id = info
        .get("uuid")
        .and_then(|value| <&str>::try_from(value).ok())
        .ok_or("KDE did not identify the selected window.")?;
    let pid = info
        .get("pid")
        .and_then(|value| {
            u32::try_from(value).ok().or_else(|| {
                i32::try_from(value)
                    .ok()
                    .and_then(|pid| u32::try_from(pid).ok())
            })
        })
        .filter(|pid| *pid != 0);
    selected_window(crate::platform::snapshot_current(app)?, id, pid).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Rect;

    fn window(id: &str, pid: u32) -> WindowInfo {
        let rect = Rect {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        };
        WindowInfo {
            id: id.into(),
            pid,
            title: String::new(),
            class_name: String::new(),
            app_id: String::new(),
            desktop_id: String::new(),
            path: String::new(),
            rect,
            work_area: rect,
            monitor: 1,
            monitor_name: String::new(),
            maximized_horizontal: false,
            maximized_vertical: false,
            fullscreen: false,
            minimized: false,
            active: false,
        }
    }

    #[test]
    fn selection_uses_unique_compositor_identity_when_plasma_omits_the_pid() {
        let windows = vec![window("one", 10), window("two", 20)];
        assert_eq!(
            selected_window(windows.clone(), "two", None).unwrap().pid,
            20
        );
        assert!(selected_window(windows.clone(), "two", Some(10)).is_err());
        assert!(selected_window(vec![window("same", 1), window("same", 2)], "same", None).is_err());
    }
}

#[cfg(windows)]
fn pick(app: &AppHandle) -> Result<Option<WindowInfo>, String> {
    use std::{
        cell::Cell,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::*,
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            Input::KeyboardAndMouse::{SetFocus, VK_ESCAPE},
            WindowsAndMessaging::*,
        },
    };
    thread_local! {
        static SELECTED: Cell<Option<usize>> = const { Cell::new(None) };
        static CLICKED: Cell<Option<(i32, i32)>> = const { Cell::new(None) };
    }
    unsafe extern "system" fn procedure(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_PAINT => {
                let mut paint = PAINTSTRUCT::default();
                let dc = unsafe { BeginPaint(hwnd, &mut paint) };
                let font =
                    unsafe { CreateFontW(-26, 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 0, 0, null()) };
                let old = if font.is_null() {
                    null_mut()
                } else {
                    unsafe { SelectObject(dc, font as _) }
                };
                unsafe {
                    SetBkMode(dc, TRANSPARENT as i32);
                    SetTextColor(dc, 0x00ff_ffff);
                }
                let text: Vec<u16> =
                    "Click an app window to add it  ·  Esc or right-click to cancel"
                        .encode_utf16()
                        .collect();
                let mut rect = RECT {
                    left: 30,
                    top: 30,
                    right: 1000,
                    bottom: 90,
                };
                unsafe {
                    DrawTextW(
                        dc,
                        text.as_ptr(),
                        text.len() as i32,
                        &mut rect,
                        DT_LEFT | DT_SINGLELINE,
                    );
                }
                if !old.is_null() {
                    unsafe {
                        SelectObject(dc, old);
                    }
                }
                if !font.is_null() {
                    unsafe {
                        DeleteObject(font as _);
                    }
                }
                unsafe {
                    EndPaint(hwnd, &paint);
                }
                0
            }
            WM_LBUTTONDOWN => {
                let mut point = POINT::default();
                unsafe {
                    GetCursorPos(&mut point);
                }
                CLICKED.with(|clicked| clicked.set(Some((point.x, point.y))));
                0
            }
            WM_LBUTTONUP => {
                let Some((x, y)) = CLICKED.with(|clicked| clicked.take()) else {
                    return 0;
                };
                let point = POINT { x, y };
                unsafe {
                    ShowWindow(hwnd, SW_HIDE);
                }
                let under = unsafe { WindowFromPoint(point) };
                let root = if under.is_null() {
                    under
                } else {
                    unsafe { GetAncestor(under, GA_ROOTOWNER) }
                };
                SELECTED.with(|selected| selected.set(Some(root as usize)));
                unsafe {
                    DestroyWindow(hwnd);
                }
                0
            }
            WM_RBUTTONUP | WM_TIMER => {
                unsafe {
                    DestroyWindow(hwnd);
                }
                0
            }
            WM_KEYDOWN if wparam == VK_ESCAPE as usize => {
                unsafe {
                    DestroyWindow(hwnd);
                }
                0
            }
            WM_CLOSE => {
                unsafe {
                    DestroyWindow(hwnd);
                }
                0
            }
            WM_DESTROY => {
                unsafe {
                    PostQuitMessage(0);
                }
                0
            }
            _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        }
    }
    let selected = unsafe {
        SELECTED.with(|value| value.set(None));
        CLICKED.with(|value| value.set(None));
        let instance = GetModuleHandleW(null());
        let class: Vec<u16> = format!("WindowWarpPick{}\0", uuid::Uuid::new_v4().simple())
            .encode_utf16()
            .collect();
        let window_class = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(procedure),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: null_mut(),
            hCursor: LoadCursorW(null_mut(), IDC_CROSS),
            hbrBackground: GetStockObject(BLACK_BRUSH) as _,
            lpszMenuName: null(),
            lpszClassName: class.as_ptr(),
        };
        if RegisterClassW(&window_class) == 0 {
            return Err("Could not start the window picker.".into());
        }
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
            class.as_ptr(),
            null(),
            WS_POPUP,
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
            null_mut(),
            null_mut(),
            instance,
            null(),
        );
        if hwnd.is_null() {
            UnregisterClassW(class.as_ptr(), instance);
            return Err("Could not open the window picker.".into());
        }
        SetLayeredWindowAttributes(hwnd, 0, 100, LWA_ALPHA);
        SetTimer(hwnd, 1, 120_000, None);
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        SetFocus(hwnd);
        let mut message = MSG::default();
        while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        UnregisterClassW(class.as_ptr(), instance);
        SELECTED.with(|value| value.get())
    };
    let Some(handle) = selected else {
        return Ok(None);
    };
    let id = handle.to_string();
    let window = crate::platform::snapshot_current(app)?
        .into_iter()
        .find(|window| window.id == id);
    window
        .map(Some)
        .ok_or_else(|| "Choose an open app window on this desktop.".into())
}
