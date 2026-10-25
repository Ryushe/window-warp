//! Application-level shortcuts, separate from per-platform window operations.
use serde_json::json;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

pub fn is_control(action: &str) -> bool {
    matches!(
        action,
        "toggle-pause" | "open-editor" | "open-workspaces" | "update-workspace"
    )
}

pub fn dispatch(app: &AppHandle, action: &str) {
    if !is_control(action) {
        return;
    }
    let runtime = app.state::<crate::Runtime>();
    let needs_capture_slot = action != "toggle-pause";
    if needs_capture_slot && runtime.control_busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let action = action.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        struct Reset<'a>(Option<&'a std::sync::atomic::AtomicBool>);
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                if let Some(busy) = self.0 {
                    busy.store(false, Ordering::SeqCst);
                }
            }
        }
        let runtime = app.state::<crate::Runtime>();
        let _reset = Reset(needs_capture_slot.then_some(&runtime.control_busy));
        if let Err(error) = run(&app, &action) {
            let _ = app.emit("warp-error", error);
            crate::show(&app);
        }
    });
}

fn run(app: &AppHandle, action: &str) -> Result<(), String> {
    if action == "toggle-pause" {
        crate::toggle_enabled(app)?;
        return Ok(());
    }
    if !*app
        .state::<crate::Runtime>()
        .enabled
        .lock()
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let request = match action {
        "open-editor" => {
            // Capture before the editor steals focus, then pause to allow editing.
            let active = crate::platform::snapshot(app)?
                .into_iter()
                .find(|w| w.active);
            crate::set_enabled_blocking(app.clone(), false)?;
            json!({"action":action, "window":active})
        }
        "open-workspaces" => json!({"action":action}),
        "update-workspace" => {
            let windows = crate::platform::snapshot(app)?;
            let store = crate::workspaces::load(app)?;
            let suggested = crate::workspaces::best_match(&store.profiles, &windows);
            let mut profile = crate::workspaces::capture(windows, "New workspace".into());
            crate::firefox::enrich(&mut profile.items);
            crate::terminal::enrich(&mut profile.items);
            json!({"action":action, "capture":{"profile":profile,"suggestedId":suggested}})
        }
        _ => return Err("Unknown application shortcut.".into()),
    };
    *app.state::<crate::Runtime>()
        .control_request
        .lock()
        .map_err(|e| e.to_string())? = Some(request);
    crate::show(app);
    app.emit("warp-control", ()).map_err(|e| e.to_string())?;
    Ok(())
}
