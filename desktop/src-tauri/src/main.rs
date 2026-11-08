#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod app_actions;
mod browser_bridge;
mod config;
mod firefox;
mod firefox_profile_lock;
mod geometry;
mod gesture;
#[cfg(target_os = "linux")]
mod linux_apps;
#[cfg(target_os = "linux")]
mod linux_control;
#[cfg(target_os = "linux")]
mod linux_gestures;
#[cfg(target_os = "linux")]
mod linux_override;
#[cfg(any(target_os = "linux", test))]
mod linux_physical;
#[cfg(target_os = "linux")]
mod linux_pointer;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod platform;
mod position_picker;
mod process_info;
mod radial;
mod retile;
mod startup;
mod terminal;
mod window_match;
mod window_picker;
#[cfg(windows)]
mod windows_apps;
mod workspaces;
#[cfg(any(windows, test))]
mod wsl;

use config::Config;
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

static QUICK_ARMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static QUICK_FOCUS_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn advance_quick_focus_epoch() -> u64 {
    QUICK_FOCUS_EPOCH
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        .wrapping_add(1)
}

fn restore_after_failed_quick_hide(
    open: &std::sync::atomic::AtomicBool,
    expected: u64,
    current: u64,
) -> bool {
    use std::sync::atomic::Ordering;
    expected == current
        && open
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
}

#[cfg(any(windows, test))]
fn keep_quick_on_blur(super_down: bool, recording: bool, mouse_down: bool) -> bool {
    // A click outside must win over an in-progress Win chord. Losing focus
    // without a mouse click while recording can be Windows releasing Win.
    !mouse_down && (super_down || recording)
}

#[cfg(any(windows, test))]
fn quick_watch_current(expected: u64, current: u64, open: bool, focused: bool) -> bool {
    expected == current && open && !focused
}

#[cfg(windows)]
fn watch_unfocused_quick_click(window: tauri::Window, epoch: u64) {
    use std::sync::atomic::Ordering;
    std::thread::spawn(move || {
        loop {
            let open = window
                .app_handle()
                .state::<Runtime>()
                .quick_open
                .load(Ordering::SeqCst);
            let current = QUICK_FOCUS_EPOCH.load(Ordering::SeqCst);
            if !quick_watch_current(epoch, current, open, window.is_focused().unwrap_or(true)) {
                break;
            }
            if platform::mouse_down() {
                let outside = match (
                    window.outer_position(),
                    window.outer_size(),
                    platform::pointer(window.app_handle()),
                ) {
                    (Ok(position), Ok(size), Ok(point)) => {
                        let (x, y) = (i64::from(point.x), i64::from(point.y));
                        x < i64::from(position.x)
                            || y < i64::from(position.y)
                            || x >= i64::from(position.x) + i64::from(size.width)
                            || y >= i64::from(position.y) + i64::from(size.height)
                    }
                    _ => false,
                };
                if outside
                    && QUICK_FOCUS_EPOCH.load(Ordering::SeqCst) == epoch
                    && QUICK_ARMED.swap(false, Ordering::SeqCst)
                {
                    let runtime = window.app_handle().state::<Runtime>();
                    let was_open = runtime.quick_open.swap(false, Ordering::SeqCst);
                    if was_open {
                        if window.hide().is_ok() {
                            let _ = window.app_handle().emit("quick-hidden", ());
                            platform::stop_recording();
                        } else if restore_after_failed_quick_hide(
                            &runtime.quick_open,
                            epoch,
                            QUICK_FOCUS_EPOCH.load(Ordering::SeqCst),
                        ) {
                            QUICK_ARMED.store(true, Ordering::SeqCst);
                            // Keep watching an unfocused popup after a failed
                            // hide, but avoid retrying continuously on one press.
                            while platform::mouse_down()
                                && QUICK_FOCUS_EPOCH.load(Ordering::SeqCst) == epoch
                            {
                                std::thread::sleep(std::time::Duration::from_millis(10));
                            }
                            continue;
                        }
                    }
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    });
}

#[cfg(test)]
mod quick_focus_tests {
    use super::{keep_quick_on_blur, quick_watch_current, restore_after_failed_quick_hide};
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn mouse_click_dismisses_even_during_a_super_chord_or_recording() {
        assert!(!keep_quick_on_blur(false, false, true));
        assert!(!keep_quick_on_blur(true, false, true));
        assert!(!keep_quick_on_blur(true, true, true));
    }

    #[test]
    fn win_or_recording_focus_loss_without_click_is_preserved() {
        assert!(keep_quick_on_blur(true, false, false));
        assert!(keep_quick_on_blur(false, true, false));
        assert!(!keep_quick_on_blur(false, false, false));
    }

    #[test]
    fn newer_blur_has_its_own_watcher_even_if_an_older_one_is_exiting() {
        let old_blur = 10;
        let refocused = 11;
        let new_blur = 12;
        assert!(!quick_watch_current(old_blur, refocused, true, true));
        assert!(!quick_watch_current(old_blur, new_blur, true, false));
        assert!(quick_watch_current(new_blur, new_blur, true, false));
        assert!(!quick_watch_current(new_blur, new_blur, false, false));
    }

    #[test]
    fn failed_hide_restores_open_state_only_without_a_newer_focus_transition() {
        let open = AtomicBool::new(false);
        assert!(restore_after_failed_quick_hide(&open, 10, 10));
        assert!(open.load(Ordering::SeqCst));
        open.store(false, Ordering::SeqCst);
        assert!(!restore_after_failed_quick_hide(&open, 10, 11));
        assert!(!open.load(Ordering::SeqCst));
    }
}

#[derive(Default)]
struct Runtime {
    enabled: Mutex<bool>,
    control_busy: std::sync::atomic::AtomicBool,
    control_request: Mutex<Option<serde_json::Value>>,
    shortcut_error: Mutex<Option<String>>,
    workspace_io: Mutex<()>,
    restoring: std::sync::atomic::AtomicBool,
    cancel_restore: std::sync::atomic::AtomicBool,
    quick_app: Mutex<Option<String>>,
    quick_edit: Mutex<Option<serde_json::Value>>,
    quick_open: std::sync::atomic::AtomicBool,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json"))
}
#[tauri::command]
fn get_config(app: AppHandle) -> Result<Config, String> {
    let path = settings_path(&app)?;
    let mut config: Config = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| {
            format!(
                "Cannot read {}: {e}. Your file has been preserved.",
                path.display()
            )
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config::default(),
        Err(e) => return Err(format!("Cannot read settings: {e}")),
    };
    config.validate()?;
    Ok(config)
}
#[tauri::command]
async fn save_config(app: AppHandle, config: Config) -> Result<Config, String> {
    tauri::async_runtime::spawn_blocking(move || save_config_blocking(app, config))
        .await
        .map_err(|e| e.to_string())?
}
fn save_config_blocking(app: AppHandle, mut config: Config) -> Result<Config, String> {
    config.validate()?;
    let runtime = app.state::<Runtime>();
    let mut enabled = runtime.enabled.lock().map_err(|e| e.to_string())?;
    let was_enabled = *enabled;
    if was_enabled {
        change_enabled(&app, false, &mut enabled)?;
    }
    let previous = get_config(app.clone())?;
    let path = settings_path(&app)?;
    fs::create_dir_all(path.parent().ok_or("Invalid settings directory")?)
        .map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if let Err(error) = platform::configure_pause(&app, &config) {
        let rollback = platform::configure_pause(&app, &previous);
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Could not apply the pause shortcut: {error}{}",
            rollback
                .err()
                .map(|e| format!(". Restoring the previous key also failed: {e}"))
                .unwrap_or_default()
        ));
    }
    if let Err(error) = fs::rename(&temporary, &path) {
        let rollback = platform::configure_pause(&app, &previous);
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Could not save settings: {error}{}",
            rollback
                .err()
                .map(|e| format!(". Restoring the previous pause key also failed: {e}"))
                .unwrap_or_default()
        ));
    }
    *runtime.shortcut_error.lock().map_err(|e| e.to_string())? = None;
    if was_enabled {
        if let Err(error) = change_enabled(&app, true, &mut enabled) {
            return Err(format!(
                "Saved, but the shortcuts could not be turned back on: {error}"
            ));
        }
    }
    Ok(config)
}
#[tauri::command]
fn preview_shortcut_reassignment(
    config: Config,
    index: usize,
) -> Result<config::Reassignment, String> {
    config.preview_reassignment(index)
}
#[tauri::command]
async fn set_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || set_enabled_blocking(app, enabled))
        .await
        .map_err(|e| e.to_string())?
}
fn set_enabled_blocking(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let runtime = app.state::<Runtime>();
    let mut current = runtime.enabled.lock().map_err(|e| e.to_string())?;
    change_enabled(&app, enabled, &mut current)
}
fn toggle_enabled(app: &AppHandle) -> Result<bool, String> {
    let runtime = app.state::<Runtime>();
    let mut current = runtime.enabled.lock().map_err(|e| e.to_string())?;
    let enabled = !*current;
    change_enabled(app, enabled, &mut current)
}
fn change_enabled(app: &AppHandle, enabled: bool, current: &mut bool) -> Result<bool, String> {
    if *current == enabled {
        return Ok(*current);
    }
    if enabled {
        let config = get_config(app.clone())?;
        #[cfg(target_os = "linux")]
        if let Err(error) = linux_override::begin(&config) {
            return Err(error);
        }
        let activated = (|| {
            platform::configure_pause(app, &config)?;
            retile::start(app, &config)?;
            platform::enable(app, &config)
        })();
        if let Err(error) = activated {
            let _ = retile::stop();
            let _ = platform::disable(app);
            return Err(error);
        }
    } else {
        // Cancel compositor continuations before joining workers that may be
        // waiting for those very replies. Persistent history stays in KWin.
        #[cfg(target_os = "linux")]
        let cancellation = linux_control::configure_session(app, false);
        let retile = retile::stop();
        let native = platform::disable(&app);
        #[cfg(target_os = "linux")]
        {
            let failures: Vec<_> = [cancellation, retile, native]
                .into_iter()
                .filter_map(Result::err)
                .collect();
            if !failures.is_empty() {
                return Err(failures.join("; "));
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            retile?;
            native?;
        }
    }
    *current = enabled;
    if let Some(menu) = app.try_state::<MenuItem<tauri::Wry>>() {
        if let Err(error) = menu.set_text(if enabled {
            "Pause shortcuts"
        } else {
            "Enable shortcuts"
        }) {
            eprintln!("Could not update the shortcut tray label: {error}");
        }
    }
    let _ = app.emit("warp-enabled", enabled);
    Ok(enabled)
}
#[tauri::command]
async fn get_status(app: AppHandle) -> Result<serde_json::Value, String> {
    // Registration marshals work to the UI thread while holding enabled. Never
    // wait for that mutex on the UI thread, including read-only status requests.
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<Runtime>();
        let enabled = *runtime.enabled.lock().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "enabled": enabled, "platform": std::env::consts::OS, "settingsPath": settings_path(&app)?.display().to_string(), "shortcutError": runtime.shortcut_error.lock().map_err(|e| e.to_string())?.clone() }))
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn take_control_request(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    Ok(app
        .state::<Runtime>()
        .control_request
        .lock()
        .map_err(|e| e.to_string())?
        .take())
}
#[tauri::command]
fn get_startup() -> Result<bool, String> {
    startup::enabled()
}
#[tauri::command]
fn set_startup(enabled: bool) -> Result<bool, String> {
    startup::set_enabled(enabled)?;
    startup::enabled()
}
#[tauri::command]
fn get_workspaces(app: AppHandle) -> Result<workspaces::WorkspaceStore, String> {
    workspaces::load(&app)
}
#[tauri::command]
fn save_workspaces(
    app: AppHandle,
    store: workspaces::WorkspaceStore,
    expected: Option<workspaces::WorkspaceStore>,
) -> Result<workspaces::WorkspaceStore, String> {
    let runtime = app.state::<Runtime>();
    let _guard = runtime.workspace_io.lock().map_err(|e| e.to_string())?;
    let actual = workspaces::load(&app)?;
    if let Some(expected) = expected {
        if serde_json::to_value(&actual).map_err(|e| e.to_string())?
            != serde_json::to_value(&expected).map_err(|e| e.to_string())?
        {
            return Err("Workspaces changed while you were editing. Reopen the workspace to keep the latest tabs.".into());
        }
    }
    workspaces::save(&app, &store)?;
    let added: Vec<_> = store
        .profiles
        .iter()
        .filter(|profile| !actual.profiles.iter().any(|old| old.id == profile.id))
        .cloned()
        .collect();
    if let Err(error) = app
        .state::<browser_bridge::Bridge>()
        .link_new_captures(&app, &added)
    {
        eprintln!("Could not link captured browser windows: {error}");
        let _ = app.emit("warp-error", "Workspace saved, but live browser linking failed. Open the workspace to link its browser.");
    }
    Ok(store)
}

#[tauri::command]
fn get_saved_browsers(app: AppHandle) -> Result<workspaces::WorkspaceStore, String> {
    workspaces::load_saved_browsers(&app)
}

#[tauri::command]
fn delete_saved_browser(app: AppHandle, id: String) -> Result<workspaces::WorkspaceStore, String> {
    let runtime = app.state::<Runtime>();
    let _guard = runtime.workspace_io.lock().map_err(|e| e.to_string())?;
    let mut store = workspaces::load_saved_browsers(&app)?;
    let index = store
        .profiles
        .iter()
        .position(|p| p.id == id)
        .ok_or("This saved browser no longer exists.")?;
    store.profiles.remove(index);
    workspaces::save_saved_browsers(&app, &store)?;
    Ok(store)
}

#[tauri::command]
fn edit_saved_browser(
    app: AppHandle,
    expected: workspaces::Workspace,
    name: String,
    tabs: Vec<firefox::Tab>,
    active_tab: usize,
) -> Result<workspaces::WorkspaceStore, String> {
    let runtime = app.state::<Runtime>();
    let _guard = runtime.workspace_io.lock().map_err(|e| e.to_string())?;
    let mut store = workspaces::load_saved_browsers(&app)?;
    workspaces::edit_saved_browser(&mut store, &expected, name, tabs, active_tab)?;
    workspaces::save_saved_browsers(&app, &store)?;
    let _ = app.emit("warp-saved-browsers-updated", ());
    Ok(store)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedBrowserRefresh {
    profile: workspaces::Workspace,
    refreshed: bool,
}

#[tauri::command]
async fn refresh_saved_browser(app: AppHandle, id: String) -> Result<SavedBrowserRefresh, String> {
    let before = {
        let runtime = app.state::<Runtime>();
        let _guard = runtime.workspace_io.lock().map_err(|e| e.to_string())?;
        workspaces::load_saved_browsers(&app)?
            .profiles
            .into_iter()
            .find(|profile| profile.id == id)
            .ok_or("This saved browser no longer exists.")?
    };
    let [original] = before.items.as_slice() else {
        return Err("This saved browser cannot be refreshed.".into());
    };
    let current = if original.window.id.is_empty() || original.window.pid == 0 {
        None
    } else {
        match browser_bridge::current_browser_tabs(
            app.clone(),
            original.window.id.clone(),
            original.window.pid,
        )
        .await
        {
            Ok(current) => current,
            Err(error) => {
                eprintln!("Could not refresh saved browser: {error}");
                None
            }
        }
    };
    let runtime = app.state::<Runtime>();
    let _guard = runtime.workspace_io.lock().map_err(|e| e.to_string())?;
    let mut store = workspaces::load_saved_browsers(&app)?;
    let profile = store
        .profiles
        .iter_mut()
        .find(|profile| profile.id == id)
        .ok_or("This saved browser no longer exists.")?;
    let [item] = profile.items.as_mut_slice() else {
        return Err("This saved browser cannot be refreshed.".into());
    };
    let unchanged = item.window.id == original.window.id
        && item.window.pid == original.window.pid
        && item.browser == original.browser;
    let refreshed = if unchanged {
        item.browser
            .as_ref()
            .zip(current.as_ref())
            .and_then(|(saved, current)| workspaces::refreshed_saved_browser(saved, current))
    } else {
        None
    };
    let was_refreshed = refreshed.is_some();
    let changed = refreshed
        .as_ref()
        .is_some_and(|browser| item.browser.as_ref() != Some(browser));
    if let Some(browser) = refreshed {
        item.browser = Some(browser);
    }
    let result = SavedBrowserRefresh {
        profile: profile.clone(),
        refreshed: was_refreshed,
    };
    if changed {
        workspaces::save_saved_browsers(&app, &store)?;
        let _ = app.emit("warp-saved-browsers-updated", ());
    }
    Ok(result)
}

#[tauri::command]
fn add_saved_browser_to_workspace(
    app: AppHandle,
    browser_id: String,
    workspace_id: String,
    expected_source: Option<firefox::Browser>,
    target: Option<workspaces::SavedBrowserTarget>,
) -> Result<workspaces::WorkspaceStore, String> {
    let runtime = app.state::<Runtime>();
    let _guard = runtime.workspace_io.lock().map_err(|e| e.to_string())?;
    let saved = workspaces::load_saved_browsers(&app)?;
    let browser = saved
        .profiles
        .iter()
        .find(|p| p.id == browser_id)
        .ok_or("This saved browser no longer exists.")?;
    let [item] = browser.items.as_slice() else {
        return Err("This saved browser cannot be added to a workspace.".into());
    };
    if expected_source
        .as_ref()
        .is_some_and(|expected| item.browser.as_ref() != Some(expected))
    {
        return Err(
            "The saved browser's tabs changed. Reopen the browser chooser to review them.".into(),
        );
    }
    let mut store = workspaces::load(&app)?;
    let workspace = store
        .profiles
        .iter_mut()
        .find(|p| p.id == workspace_id)
        .ok_or("This workspace no longer exists.")?;
    if workspace.platform != browser.platform {
        return Err("Choose a workspace from the same operating system as this browser.".into());
    }
    workspaces::apply_saved_browser(workspace, item, target)?;
    workspaces::save(&app, &store)?;
    let _ = app.emit("warp-browser-updated", workspace_id);
    Ok(store)
}
#[tauri::command]
async fn prepare_workspace_import(
    profile: workspaces::Workspace,
) -> Result<workspaces::Workspace, String> {
    tauri::async_runtime::spawn_blocking(move || workspaces::prepare_import(profile))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn firefox_profiles() -> Result<Vec<firefox::Profile>, String> {
    tauri::async_runtime::spawn_blocking(firefox::profiles)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn firefox_sessions(profile_path: String) -> Result<Vec<firefox::Browser>, String> {
    tauri::async_runtime::spawn_blocking(move || firefox::sessions_for_profile(&profile_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn capture_workspace(app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let windows = platform::snapshot(&app)?;
        let store = workspaces::load(&app)?;
        let suggested = workspaces::best_match(&store.profiles, &windows);
        let mut profile = workspaces::capture(windows, name);
        workspaces::enrich_capture(&app, &mut profile)?;
        Ok(serde_json::json!({"profile":profile, "suggestedId":suggested}))
    })
    .await
    .map_err(|e| e.to_string())?
}

// Return the window layout immediately; browser enrichment continues separately
// so the workspace editor can be used while the extension responds.
#[tauri::command]
async fn start_workspace_capture(
    app: AppHandle,
    name: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let windows = platform::snapshot(&app)?;
        let store = workspaces::load(&app)?;
        let suggested = workspaces::best_match(&store.profiles, &windows);
        let mut profile = workspaces::capture(windows, name);
        terminal::enrich(&mut profile.items);
        Ok(serde_json::json!({"profile":profile, "suggestedId":suggested}))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn enrich_workspace_capture(
    app: AppHandle,
    mut profile: workspaces::Workspace,
) -> Result<workspaces::Workspace, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workspaces::enrich_capture(&app, &mut profile)?;
        Ok(profile)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
async fn get_windows(app: AppHandle) -> Result<Vec<workspaces::WindowInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || platform::snapshot(&app))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn get_import_monitors(app: AppHandle) -> Result<Vec<geometry::Rect>, String> {
    let mut areas: Vec<_> = app
        .available_monitors()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|monitor| {
            let area = monitor.work_area();
            geometry::Rect {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width as i32,
                height: area.size.height as i32,
            }
        })
        .collect();
    areas.sort_by_key(|r| (r.x, r.y));
    Ok(areas)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MonitorOption {
    id: String,
    name: String,
    index: usize,
    primary: bool,
    stable: bool,
    source_id: String,
    geometry: geometry::Rect,
}

#[tauri::command]
async fn get_monitors(app: AppHandle) -> Result<Vec<MonitorOption>, String> {
    tauri::async_runtime::spawn_blocking(move || platform::monitor_options(&app))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
async fn restore_workspace(
    app: AppHandle,
    id: String,
) -> Result<Vec<workspaces::RestoreResult>, String> {
    restore_destination(app, id, false).await
}

#[tauri::command]
async fn restore_saved_browser(
    app: AppHandle,
    id: String,
) -> Result<Vec<workspaces::RestoreResult>, String> {
    restore_destination(app, id, true).await
}

async fn restore_destination(
    app: AppHandle,
    id: String,
    saved_browser: bool,
) -> Result<Vec<workspaces::RestoreResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::sync::atomic::Ordering;
        let runtime = app.state::<Runtime>();
        if runtime.restoring.swap(true, Ordering::SeqCst) {
            return Err("A workspace is already being restored.".into());
        }
        struct Reset<'a>(&'a std::sync::atomic::AtomicBool);
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _reset = Reset(&runtime.restoring);
        runtime.cancel_restore.store(false, Ordering::SeqCst);
        let store = if saved_browser { workspaces::load_saved_browsers(&app)? } else { workspaces::load(&app)? };
        let profile = store
            .profiles
            .iter()
            .find(|p| p.id == id)
            .ok_or("Workspace no longer exists.")?;
        let active_targets = browser_bridge::workspace_active_targets_here(&app, profile)?;
        let desktop = platform::current_desktop_key(&app).ok();
        let mut results = workspaces::restore(&app, profile, &runtime.cancel_restore, desktop.as_deref(), &active_targets)?;
        for index in app.state::<browser_bridge::Bridge>().focus_restored_tabs(&app, profile, &results, &runtime.cancel_restore) {
            if let Some(result) = results.get_mut(index) {
                let message = "Could not confirm the saved browser tab is selected. Check the browser extension or select it manually.";
                result.warning = Some(match result.warning.take() { Some(previous) => format!("{previous} {message}"), None => message.into() });
            }
        }
        if results.iter().any(|result| result.restored) {
            let remembered = desktop.ok_or_else(|| "The current desktop could not be identified.".to_string()).and_then(|desktop| {
                if platform::current_desktop_key(&app)? != desktop { return Err("The desktop changed while the workspace was opening.".into()); }
                if saved_browser {
                    app.state::<browser_bridge::Bridge>().set_saved_browser_opened(&app, profile, &results)
                } else {
                    app.state::<browser_bridge::Bridge>().set_active(&app, desktop, profile, &results)
                }
            });
            if remembered.is_err() {
                if let Some(result) = results.iter_mut().find(|result| result.restored) {
                    let message = "The workspace opened, but its desktop association could not be saved. You can choose it manually in the extension.";
                    result.warning = Some(match result.warning.take() { Some(previous) => format!("{previous} {message}"), None => message.into() });
                }
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn cancel_workspace_restore(app: AppHandle) {
    app.state::<Runtime>()
        .cancel_restore
        .store(true, std::sync::atomic::Ordering::SeqCst);
}
#[tauri::command]
fn quick_edit(app: AppHandle) -> Option<serde_json::Value> {
    app.state::<Runtime>()
        .quick_edit
        .lock()
        .ok()
        .and_then(|edit| edit.clone())
}
#[tauri::command]
fn quick_is_open(app: AppHandle) -> bool {
    app.state::<Runtime>()
        .quick_open
        .load(std::sync::atomic::Ordering::SeqCst)
}
#[tauri::command]
fn show_editor(app: AppHandle, app_match: Option<String>) {
    show(&app);
    if let Some(app_match) = app_match.filter(|name| !name.is_empty()) {
        let _ = app.emit("reveal-app", app_match);
    }
}
#[tauri::command]
fn hide_quick(app: AppHandle) -> bool {
    use std::sync::atomic::Ordering;
    let runtime = app.state::<Runtime>();
    let epoch = advance_quick_focus_epoch();
    let was_open = runtime.quick_open.swap(false, Ordering::SeqCst);
    if !was_open {
        return false;
    }
    let Some(window) = app.get_webview_window("quick") else {
        return false;
    };
    if window.hide().is_ok() {
        return true;
    }
    // An unsuccessful native hide leaves the popup visible. Restore its open
    // state unless a newer focus transition has already superseded this one.
    restore_after_failed_quick_hide(
        &runtime.quick_open,
        epoch,
        QUICK_FOCUS_EPOCH.load(Ordering::SeqCst),
    );
    false
}
#[tauri::command]
fn focus_captured(app: AppHandle, id: String, pid: u32) -> Result<(), String> {
    platform::focus_captured(&app, &id, pid)
}
#[tauri::command]
fn start_shortcut_recording(app: AppHandle, popup: Option<bool>) -> Result<(), String> {
    #[cfg(windows)]
    {
        platform::start_recording(app, popup.unwrap_or(false))
    }
    #[cfg(target_os = "linux")]
    {
        let _ = (app, popup);
        linux_override::set_recording(true)
    }
}
#[tauri::command]
fn stop_shortcut_recording(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = app;
        platform::stop_recording();
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        linux_override::set_recording(false)
    }
}
fn show(app: &AppHandle) {
    // The single-instance callback can run inside a synchronous Windows
    // message dispatch, where COM forbids outgoing calls. Leave that dispatch
    // before asking the virtual desktop manager to move our window.
    #[cfg(windows)]
    {
        let app = app.clone();
        std::thread::spawn(move || show_now(&app));
    }
    #[cfg(not(windows))]
    show_now(app);
}
fn show_now(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(windows)]
        {
            let moved = window
                .hwnd()
                .map_err(|e| e.to_string())
                .and_then(|hwnd| platform::move_own_window_to_current_desktop(hwnd.0 as isize));
            if let Err(error) = moved {
                eprintln!("{error}");
                let _ = app.emit("warp-error", error);
                return;
            }
        }
        let _ = window.unminimize();
        let _ = window.show();
        #[cfg(windows)]
        if let Ok(hwnd) = window.hwnd() {
            platform::raise_window(hwnd.0 as isize);
        }
        let _ = window.set_focus();
        #[cfg(target_os = "linux")]
        {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = platform::focus_editor(&app) {
                    let _ = app.emit("warp-error", error);
                }
            });
        }
        let _ = app.emit("warp-desktop-changed", ());
    }
}
fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .manage(Runtime::default())
        .manage(browser_bridge::Bridge::default());
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    #[cfg(target_os = "linux")]
    let builder = builder.manage(linux_control::ControlState::default());
    builder
        .setup(|app| {
            if let Err(error) = browser_bridge::refresh_prepared_extensions(app.handle()) {
                eprintln!("Extension update: {error}");
            }
            if let Err(error) = browser_bridge::restore_enabled(app.handle()) {
                eprintln!("Browser connection: {error}");
            }
            let open = MenuItem::with_id(app, "open", "Open Window Warp", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Enable shortcuts", true, None::<&str>)?;
            app.manage(pause.clone());
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &pause, &quit])?;
            let tray = TrayIconBuilder::new();
            let tray = if let Some(icon) = app.default_window_icon() {
                tray.icon(icon.clone())
            } else {
                tray
            };
            #[cfg(windows)]
            let tray = tray
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        tauri::tray::TrayIconEvent::DoubleClick {
                            button: tauri::tray::MouseButton::Left,
                            ..
                        }
                    ) {
                        show(tray.app_handle());
                    }
                });
            tray.tooltip("Window Warp")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "pause" | "quit" => {
                        let quit = event.id.as_ref() == "quit";
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            let result = if quit {
                                set_enabled_blocking(app.clone(), false)
                            } else {
                                toggle_enabled(&app)
                            };
                            if let Err(message) = result {
                                let _ = app.emit("warp-error", message);
                                show(&app);
                            } else if quit {
                                app.exit(0);
                            }
                        });
                    }
                    _ => {}
                })
                .build(app)?;
            // A previous crash can leave the KWin-side script alive.
            #[cfg(target_os = "linux")]
            {
                if let Err(error) = platform::disable(app.handle()) {
                    eprintln!("KWin startup cleanup: {error}");
                }
            }
            if let Err(error) = get_config(app.handle().clone())
                .and_then(|config| platform::configure_pause(app.handle(), &config))
            {
                eprintln!("Could not register the pause shortcut: {error}");
                *app.state::<Runtime>()
                    .shortcut_error
                    .lock()
                    .map_err(|e| e.to_string())? = Some(error);
            }
            let startup_launch = std::env::args().any(|arg| arg == "--startup");
            let enable_on_launch = get_config(app.handle().clone())
                .map(|config| config.settings.enable_on_launch)
                .unwrap_or(true);
            if startup_launch || enable_on_launch {
                match set_enabled_blocking(app.handle().clone(), true) {
                    Ok(_) => {
                        if startup_launch {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                    }
                    Err(error) => eprintln!("Could not activate shortcuts at startup: {error}"),
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Windows keeps the radial picker non-focusable so releasing Win
            // cannot discard a selection. KDE focuses it and can cancel when
            // the user moves focus elsewhere.
            #[cfg(target_os = "linux")]
            if window.label() == "radial" {
                if let tauri::WindowEvent::Focused(focused) = event {
                    radial::focus_changed(*focused);
                }
            }
            if window.label() == "quick" {
                use std::sync::atomic::Ordering;
                match event {
                    tauri::WindowEvent::Focused(true) => {
                        advance_quick_focus_epoch();
                        QUICK_ARMED.store(true, Ordering::SeqCst);
                    }
                    tauri::WindowEvent::Focused(false) => {
                        let epoch = advance_quick_focus_epoch();
                        // Win's own release moves focus to the taskbar. That is
                        // not a click outside, and it must not drop recording.
                        #[cfg(windows)]
                        let typing_win = keep_quick_on_blur(
                            platform::super_key_down(),
                            platform::capture_active(),
                            platform::mouse_down(),
                        );
                        #[cfg(not(windows))]
                        let typing_win = false;
                        if typing_win {
                            #[cfg(windows)]
                            watch_unfocused_quick_click(window.clone(), epoch);
                        } else if QUICK_ARMED.swap(false, Ordering::SeqCst) {
                            let runtime = window.app_handle().state::<Runtime>();
                            let was_open = runtime.quick_open.swap(false, Ordering::SeqCst);
                            let closed = !was_open || window.hide().is_ok();
                            if closed {
                                if was_open {
                                    let _ = window.app_handle().emit("quick-hidden", ());
                                }
                                #[cfg(windows)]
                                platform::stop_recording();
                                #[cfg(target_os = "linux")]
                                linux_override::set_recording(false);
                            } else if restore_after_failed_quick_hide(
                                &runtime.quick_open,
                                epoch,
                                QUICK_FOCUS_EPOCH.load(Ordering::SeqCst),
                            ) {
                                QUICK_ARMED.store(true, Ordering::SeqCst);
                                #[cfg(windows)]
                                watch_unfocused_quick_click(window.clone(), epoch);
                            }
                        }
                    }
                    _ => {}
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "position" {
                    position_picker::cancel();
                }
                if window.label() == "radial" {
                    radial::cancel_visible();
                }
                if window.hide().is_ok() {
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_import_monitors,
            get_monitors,
            browser_bridge::bridge_status,
            browser_bridge::extension_setup_options,
            browser_bridge::open_firefox_addon,
            browser_bridge::current_desktop_workspace,
            browser_bridge::workspace_locations,
            browser_bridge::workspace_open_locations,
            browser_bridge::workspace_go_to_desktop,
            browser_bridge::workspace_move_to_desktop,
            browser_bridge::browser_profiles,
            browser_bridge::current_browser_tabs,
            browser_bridge::current_workspace_tabs,
            browser_bridge::update_saved_workspace_tabs,
            browser_bridge::set_bridge_enabled,
            browser_bridge::set_bridge_live,
            browser_bridge::prepare_extension,
            position_picker::choose_position,
            position_picker::finish_position,
            window_picker::workspace_open_windows,
            window_picker::pick_workspace_window,
            get_config,
            save_config,
            preview_shortcut_reassignment,
            set_enabled,
            get_status,
            take_control_request,
            get_startup,
            set_startup,
            get_workspaces,
            save_workspaces,
            get_saved_browsers,
            delete_saved_browser,
            edit_saved_browser,
            refresh_saved_browser,
            add_saved_browser_to_workspace,
            restore_saved_browser,
            capture_workspace,
            start_workspace_capture,
            enrich_workspace_capture,
            firefox_profiles,
            firefox_sessions,
            prepare_workspace_import,
            get_windows,
            restore_workspace,
            cancel_workspace_restore,
            start_shortcut_recording,
            stop_shortcut_recording,
            hide_quick,
            quick_edit,
            quick_is_open,
            show_editor,
            focus_captured,
            radial::radial_view,
            radial::cancel_radial
        ])
        .build(tauri::generate_context!())
        .expect("Could not start Window Warp")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                retile::exiting();
                platform::shutdown(app);
            }
        });
}
