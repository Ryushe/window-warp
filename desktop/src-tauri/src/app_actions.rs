//! Application-level shortcuts, separate from per-platform window operations.
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Manager};

fn app_label(window: &crate::workspaces::WindowInfo) -> String {
    if !window.app_id.is_empty() {
        return window.app_id.clone();
    }
    if !window.path.is_empty() {
        return window
            .path
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(window.path.as_str())
            .to_string();
    }
    window.desktop_id.clone()
}

/// The popup and the shortcut that pulls an app must name the same binding.
pub(crate) fn app_binding_index(
    config: &crate::config::Config,
    window: &crate::workspaces::WindowInfo,
) -> Option<usize> {
    config.bindings.iter().position(|binding| {
        matches!(binding.action.as_str(), "pull-app" | "focus-app")
            && crate::window_match::matches(binding, window)
    })
}

fn focused_window(app: &AppHandle) -> Result<Option<crate::workspaces::WindowInfo>, String> {
    let windows = crate::platform::snapshot(app)?;
    if let Some(id) = crate::platform::editor_foreground() {
        if let Some(window) = windows.iter().find(|window| window.id == id).cloned() {
            return Ok(Some(window));
        }
    }
    Ok(windows.into_iter().find(|window| window.active))
}

pub fn is_control(action: &str) -> bool {
    matches!(
        action,
        "toggle-pause" | "open-editor" | "open-workspaces" | "update-workspace"
    )
}

// A second editor press can arrive while the first is still opening the
// popup. Preserve those presses until the opening operation finishes.
#[derive(Default)]
struct ControlQueue {
    editor_active: bool,
    pending_editor: usize,
}

impl ControlQueue {
    fn start(&mut self, busy: &AtomicBool, editor: bool) -> bool {
        if busy.swap(true, Ordering::SeqCst) {
            if editor && self.editor_active {
                self.pending_editor = self.pending_editor.saturating_add(1);
            }
            return false;
        }
        self.editor_active = editor;
        true
    }

    fn next_editor(&mut self) -> bool {
        if self.pending_editor == 0 {
            return false;
        }
        self.pending_editor -= 1;
        true
    }

    fn clear(&mut self, busy: &AtomicBool) {
        self.editor_active = false;
        self.pending_editor = 0;
        busy.store(false, Ordering::SeqCst);
    }
}

static CONTROL_QUEUE: Mutex<ControlQueue> = Mutex::new(ControlQueue {
    editor_active: false,
    pending_editor: 0,
});

struct ControlGuard<'a> {
    busy: &'a AtomicBool,
    armed: bool,
}

impl Drop for ControlGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            CONTROL_QUEUE
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear(self.busy);
        }
    }
}

pub fn dispatch(app: &AppHandle, action: &str) {
    if !is_control(action) {
        return;
    }
    let runtime = app.state::<crate::Runtime>();
    let needs_capture_slot = action != "toggle-pause";
    if needs_capture_slot {
        let mut queue = CONTROL_QUEUE.lock().unwrap_or_else(|e| e.into_inner());
        if !queue.start(&runtime.control_busy, action == "open-editor") {
            return;
        }
    }
    let app = app.clone();
    let mut action = action.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<crate::Runtime>();
        let mut guard = ControlGuard {
            busy: &runtime.control_busy,
            armed: needs_capture_slot,
        };
        loop {
            if let Err(error) = run(&app, &action) {
                let _ = app.emit("warp-error", error);
                crate::show(&app);
                // A failed operation should not replay queued editor presses.
                break;
            }
            if !needs_capture_slot {
                break;
            }
            let mut queue = CONTROL_QUEUE.lock().unwrap_or_else(|e| e.into_inner());
            if queue.next_editor() {
                action = "open-editor".to_string();
            } else {
                // Disarm under the lock: a new dispatch must not have its
                // busy flag cleared by this worker's Drop implementation.
                guard.armed = false;
                queue.clear(&runtime.control_busy);
                break;
            }
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
            let window = app
                .get_webview_window("quick")
                .ok_or("The shortcut popup is unavailable.")?;
            let runtime = app.state::<crate::Runtime>();
            if runtime
                .quick_open
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                #[cfg(windows)]
                crate::platform::stop_recording();
                #[cfg(target_os = "linux")]
                {
                    let _ = crate::linux_override::set_recording(false);
                }
                crate::show(app);
                let _ = window.hide();
                if let Ok(name) = runtime.quick_app.lock() {
                    if let Some(name) = name.clone().filter(|name| !name.is_empty()) {
                        let _ = app.emit("reveal-app", name);
                    }
                }
                return Ok(());
            }
            let active = focused_window(app)?;
            let name = active.as_ref().map(app_label).filter(|name| !name.is_empty());
            if let Ok(mut saved) = app.state::<crate::Runtime>().quick_app.lock() {
                *saved = name.clone();
            }
            let config = crate::get_config(app.clone()).ok();
            let index = config.as_ref().and_then(|config| {
                active
                    .as_ref()
                    .and_then(|window| app_binding_index(config, window))
            });
            let matched = index.and_then(|index| config.as_ref().and_then(|config| config.bindings.get(index)));
            let payload = json!({
                "window": active,
                "label": matched.map(|binding| binding.label.clone()).or(name.clone()),
                "shortcut": matched.map(|binding| binding.shortcut.clone()).unwrap_or_default(),
                "bindingIndex": index,
                "mainMonitorAction": matched.map(|binding| binding.main_monitor_action.clone()),
                "burnerLayout": matched.map(|binding| binding.burner_layout.clone()),
            });
            if let Ok(mut edit) = app.state::<crate::Runtime>().quick_edit.lock() {
                *edit = Some(payload.clone());
            }
            app.state::<crate::Runtime>()
                .quick_open
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = window.center();
            window.show().map_err(|e| e.to_string())?;
            let _ = window.set_focus();
            app.emit("quick-edit", payload).map_err(|e| e.to_string())?;
            return Ok(());
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

#[cfg(test)]
mod tests {
    use super::{app_binding_index, ControlQueue};
    use crate::workspaces::WindowInfo;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn editor_presses_wait_for_the_popup_operation() {
        let busy = AtomicBool::new(false);
        let mut queue = ControlQueue::default();

        assert!(queue.start(&busy, true), "first press starts opening the popup");
        assert!(!queue.start(&busy, true), "second press must wait until opening finishes");
        assert!(!queue.start(&busy, true), "a third distinct press is also preserved");
        assert!(queue.next_editor(), "second press opens the main editor after the popup");
        assert!(queue.next_editor(), "third press runs after the second");
        assert!(!queue.next_editor());
        queue.clear(&busy);
        assert!(!busy.load(Ordering::SeqCst));
        assert!(queue.start(&busy, true), "later presses can start normally");
    }

    #[test]
    fn unrelated_busy_actions_do_not_queue_editor_presses() {
        let busy = AtomicBool::new(false);
        let mut queue = ControlQueue::default();

        assert!(queue.start(&busy, false));
        assert!(!queue.start(&busy, true));
        assert!(!queue.next_editor());
        queue.clear(&busy);
        assert!(queue.start(&busy, true));
        assert!(!queue.start(&busy, false));
        assert!(!queue.next_editor(), "other controls keep their existing busy behavior");
        queue.clear(&busy);
    }

    fn window(app_id: &str, title: &str) -> WindowInfo {
        serde_json::from_value(serde_json::json!({
            "id": "10",
            "pid": 7,
            "title": title,
            "appId": app_id,
            "desktopId": "",
            "path": format!("C:\\Apps\\{app_id}"),
            "rect": {"x":0,"y":0,"width":800,"height":600},
            "workArea": {"x":0,"y":0,"width":1920,"height":1080},
            "monitor": 1,
            "monitorName": "main",
            "maximizedHorizontal": false,
            "maximizedVertical": false,
            "fullscreen": false,
            "minimized": false,
            "active": true
        }))
        .unwrap()
    }

    #[test]
    fn popup_uses_the_same_discord_binding_the_list_shows() {
        let config = crate::config::Config::default();
        let index = app_binding_index(&config, &window("discord.exe", "Friends - Discord")).unwrap();
        let binding = &config.bindings[index];
        assert_eq!(binding.label, "Discord");
        assert_eq!(binding.shortcut, "Super+D");
        assert!(app_binding_index(&config, &window("Code.exe", "Discord notes")).is_none()
            || config.bindings[app_binding_index(&config, &window("Code.exe", "Discord notes")).unwrap()]
                .label
                == "Code");
        let code = app_binding_index(&config, &window("Code.exe", "Discord notes")).unwrap();
        assert_eq!(config.bindings[code].shortcut, "Super+F");
        assert_ne!(config.bindings[code].shortcut, "Super+D");
    }
}
