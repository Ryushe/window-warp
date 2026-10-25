#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod config;
mod firefox;
mod geometry;
#[cfg(target_os = "linux")]
mod linux_control;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod platform;
mod process_info;
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
fn save_config(app: AppHandle, mut config: Config) -> Result<Config, String> {
    config.validate()?;
    let runtime = app.state::<Runtime>();
    let enabled = runtime.enabled.lock().map_err(|e| e.to_string())?;
    if *enabled {
        return Err("Pause shortcuts before editing settings.".into());
    }
    let path = settings_path(&app)?;
    fs::create_dir_all(path.parent().ok_or("Invalid settings directory")?)
        .map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())?;
    Ok(config)
}
#[tauri::command]
fn set_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let runtime = app.state::<Runtime>();
    let mut current = runtime.enabled.lock().map_err(|e| e.to_string())?;
    if *current == enabled {
        return Ok(*current);
    }
    if enabled {
        platform::enable(&app, &get_config(app.clone())?)?;
    } else {
        platform::disable(&app)?;
    }
    *current = enabled;
    let _ = app.emit("warp-enabled", enabled);
    Ok(enabled)
}
#[tauri::command]
fn get_status(app: AppHandle) -> Result<serde_json::Value, String> {
    let runtime = app.state::<Runtime>();
    let enabled = *runtime.enabled.lock().map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({ "enabled": enabled, "platform": std::env::consts::OS, "settingsPath": settings_path(&app)?.display().to_string() }),
    )
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
        let _ = window.set_focus();
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
                    "pause" => {
                        if let Err(message) = set_enabled(app.clone(), false) {
                            let _ = app.emit("warp-error", message);
                            show(app);
                        }
                    }
                    "quit" => {
                        if let Err(message) = set_enabled(app.clone(), false) {
                            let _ = app.emit("warp-error", message);
                            show(app);
                        } else {
                            app.exit(0);
                        }
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
            if std::env::args().any(|arg| arg == "--startup") {
                match set_enabled(app.handle().clone(), true) {
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
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.hide().is_ok() {
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            set_enabled,
            get_status,
            get_startup,
            set_startup,
            get_workspaces,
            save_workspaces,
            capture_workspace,
            get_windows,
            restore_workspace,
            cancel_workspace_restore
        ])
        .build(tauri::generate_context!())
        .expect("Could not start Window Warp")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let _ = platform::disable(app);
                #[cfg(target_os = "linux")]
                linux_control::shutdown(app);
            }
        });
}
