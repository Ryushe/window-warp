//! A temporary, movable preview used to edit a workspace's saved rectangle.
use crate::geometry::Rect;
use serde::Serialize;
use std::sync::{mpsc, LazyLock, Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    rect: Rect,
    work_area: Rect,
    monitor: usize,
}

static PENDING: LazyLock<Mutex<Option<mpsc::Sender<Option<Placement>>>>> =
    LazyLock::new(|| Mutex::new(None));

fn send(result: Option<Placement>) {
    if let Ok(mut pending) = PENDING.lock() {
        if let Some(sender) = pending.take() {
            let _ = sender.send(result);
        }
    }
}

pub fn cancel() {
    send(None);
}

#[tauri::command]
pub async fn choose_position(app: AppHandle, rect: Rect) -> Result<Option<Placement>, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, rect);
        return Err("Visual position selection is currently available on Windows.".into());
    }
    #[cfg(windows)]
    {
        if rect.width < 1 || rect.height < 1 {
            return Err("Enter a valid window size first.".into());
        }
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = PENDING.lock().map_err(|e| e.to_string())?;
            if pending.is_some() {
                return Err("Finish choosing the current window position first.".into());
            }
            *pending = Some(sender);
        }
        let show = || -> Result<(), String> {
            let window = match app.get_webview_window("position") {
                Some(window) => window,
                None => {
                    let mut builder = WebviewWindowBuilder::new(
                        &app,
                        "position",
                        WebviewUrl::App("position.html".into()),
                    )
                    .title("Set window position")
                    .visible(false)
                    .transparent(true)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .resizable(true)
                    .min_inner_size(280.0, 180.0);
                    // WebView2 requires all windows sharing its environment to
                    // use the same browser arguments as the main window.
                    if let Some(args) = app
                        .config()
                        .app
                        .windows
                        .iter()
                        .find(|w| w.label == "main")
                        .and_then(|w| w.additional_browser_args.as_deref())
                    {
                        builder = builder.additional_browser_args(args);
                    }
                    builder.build().map_err(|e| e.to_string())?
                }
            };
            window
                .set_position(tauri::PhysicalPosition::new(rect.x, rect.y))
                .map_err(|e| e.to_string())?;
            window
                .set_size(tauri::PhysicalSize::new(
                    rect.width.max(280) as u32,
                    rect.height.max(180) as u32,
                ))
                .map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            // The preview remains usable by mouse if Windows declines focus.
            let _ = window.set_focus();
            Ok(())
        };
        if let Err(error) = show() {
            cancel();
            return Err(format!("Could not open the position preview: {error}"));
        }
        tauri::async_runtime::spawn_blocking(move || {
            receiver
                .recv()
                .map_err(|_| "Position preview closed unexpectedly.".to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

#[tauri::command]
pub fn finish_position(window: WebviewWindow, apply: bool) -> Result<(), String> {
    if window.label() != "position" {
        return Err("The position preview is not open.".into());
    }
    let result = if apply {
        let position = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let current = window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("The preview is not on an available monitor.")?;
        let area = current.work_area();
        let work_area = Rect {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width as i32,
            height: area.size.height as i32,
        };
        let mut monitors = window.available_monitors().map_err(|e| e.to_string())?;
        monitors.sort_by_key(|m| (m.work_area().position.x, m.work_area().position.y));
        let monitor = monitors
            .iter()
            .position(|m| m.position() == current.position())
            .ok_or("The preview monitor is no longer available.")?
            + 1;
        Some(Placement {
            rect: Rect {
                x: position.x,
                y: position.y,
                width: size.width as i32,
                height: size.height as i32,
            },
            work_area,
            monitor,
        })
    } else {
        None
    };
    window.hide().map_err(|e| e.to_string())?;
    send(result);
    Ok(())
}
