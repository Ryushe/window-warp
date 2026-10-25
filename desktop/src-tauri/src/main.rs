#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod app_actions;
mod config;
mod firefox;
mod geometry;
mod gesture;
#[cfg(target_os = "linux")]
mod linux_control;
#[cfg(target_os = "linux")]
mod linux_gestures;
#[cfg(target_os = "linux")]
mod linux_pointer;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod platform;
mod process_info;
mod radial;
mod retile;
mod startup;
mod terminal;
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

#[derive(Default)]
struct Runtime {
    enabled: Mutex<bool>,
    control_busy: std::sync::atomic::AtomicBool,
    control_request: Mutex<Option<serde_json::Value>>,
    shortcut_error: Mutex<Option<String>>,
    workspace_io: Mutex<()>,
    restoring: std::sync::atomic::AtomicBool,
    cancel_restore: std::sync::atomic::AtomicBool,
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
    let enabled = runtime.enabled.lock().map_err(|e| e.to_string())?;
    if *enabled {
        return Err("Pause shortcuts before editing settings.".into());
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
        platform::configure_pause(app, &config)?;
        retile::start(app, &config)?;
        if let Err(error) = platform::enable(app, &config) {
            let _ = retile::stop();
            return Err(error);
        }
    } else {
        let retile = retile::stop();
        let native = platform::disable(&app);
        retile?;
        native?;
    }
    *current = enabled;
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
) -> Result<workspaces::WorkspaceStore, String> {
    let runtime = app.state::<Runtime>();
    let _guard = runtime.workspace_io.lock().map_err(|e| e.to_string())?;
    workspaces::save(&app, &store)?;
    Ok(store)
}
#[tauri::command]
async fn capture_workspace(app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let windows = platform::snapshot(&app)?;
        let store = workspaces::load(&app)?;
        let suggested = workspaces::best_match(&store.profiles, &windows);
        let mut profile = workspaces::capture(windows, name);
        firefox::enrich(&mut profile.items);
        terminal::enrich(&mut profile.items);
        Ok(serde_json::json!({"profile":profile, "suggestedId":suggested}))
    })
    .await
    .map_err(|e| e.to_string())?
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
#[tauri::command]
async fn restore_workspace(
    app: AppHandle,
    id: String,
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
        let store = workspaces::load(&app)?;
        let profile = store
            .profiles
            .iter()
            .find(|p| p.id == id)
            .ok_or("Workspace no longer exists.")?;
        workspaces::restore(&app, profile, &runtime.cancel_restore)
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
fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        #[cfg(windows)]
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
    }
}
fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .manage(Runtime::default());
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    #[cfg(target_os = "linux")]
    let builder = builder.manage(linux_control::ControlState::default());
    builder
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open Window Warp", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause shortcuts", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &pause, &quit])?;
            let mut rgba = vec![0u8; 32 * 32 * 4];
            for y in 0..32 {
                for x in 0..32 {
                    let offset = (y * 32 + x) * 4;
                    let mark = (6..14).contains(&x) || (18..26).contains(&x);
                    let ink = mark && (7..25).contains(&y);
                    rgba[offset..offset + 4].copy_from_slice(if ink {
                        &[185, 241, 125, 255]
                    } else {
                        &[21, 31, 27, 255]
                    });
                }
            }
            TrayIconBuilder::new()
                .icon(tauri::image::Image::new_owned(rgba, 32, 32))
                .tooltip("Window Warp")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "pause" | "quit" => {
                        let quit = event.id.as_ref() == "quit";
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(message) = set_enabled_blocking(app.clone(), false) {
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
            if std::env::args().any(|arg| arg == "--startup") {
                match set_enabled_blocking(app.handle().clone(), true) {
                    Ok(_) => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    Err(error) => eprintln!("Could not activate shortcuts at startup: {error}"),
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // A picker is dismissed when focus leaves it, including Windows'
            // Alt+Escape window cycling while an Alt-based app chord is held.
            // Such system shortcuts need not reach the webview's key handler.
            if window.label() == "radial" && matches!(event, tauri::WindowEvent::Focused(false)) {
                radial::cancel_visible();
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
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
            capture_workspace,
            get_windows,
            restore_workspace,
            cancel_workspace_restore,
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
