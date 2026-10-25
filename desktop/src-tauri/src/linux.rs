use crate::config::Config;
use std::{fs, process::Command};
use tauri::{AppHandle, Manager};

const SCRIPT_NAME: &str = "window-warp-session";

pub fn focus_editor(app: &AppHandle) -> Result<(), String> {
    // Mapping a previously hidden GTK window is asynchronous. Let KWin focus
    // our own window; a background Wayland client cannot self-activate reliably.
    for _ in 0..15 {
        if crate::linux_control::request(app, serde_json::json!({"kind":"focus-editor"}))?
            == serde_json::Value::Bool(true)
        {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Err("KWin could not find the Window Warp editor to focus it. Open it from the taskbar and try again.".into())
}

pub fn snapshot(app: &AppHandle) -> Result<Vec<crate::workspaces::WindowInfo>, String> {
    let value = crate::linux_control::request(app, serde_json::json!({"kind": "snapshot"}))?;
    let mut windows: Vec<crate::workspaces::WindowInfo> =
        serde_json::from_value(value).map_err(|e| format!("Invalid KWin window metadata: {e}"))?;
    for window in &mut windows {
        if window.pid != 0 {
            if let Ok(path) = fs::read_link(format!("/proc/{}/exe", window.pid)) {
                window.path = path.to_string_lossy().to_string();
            }
        }
    }
    Ok(windows)
}
pub fn restore_window(
    app: &AppHandle,
    current: &crate::workspaces::WindowInfo,
    saved: &crate::workspaces::WindowInfo,
) -> Result<(), String> {
    let command = serde_json::json!({"kind":"restore", "window":{"id": current.id, "pid":current.pid}, "placement":saved});
    // Wayland clients acknowledge geometry asynchronously. In particular,
    // Firefox's unmaximize acknowledgement can supersede the first resize.
    // Verify normal floating placement and retry that operation after the
    // transition; there is no polling while the app is idle.
    for _ in 0..3 {
        let requested: crate::geometry::Rect =
            serde_json::from_value(crate::linux_control::request(app, command.clone())?)
                .map_err(|e| format!("Invalid KWin placement response: {e}"))?;
        if saved.maximized_horizontal
            || saved.maximized_vertical
            || saved.fullscreen
            || saved.minimized
        {
            return Ok(());
        }
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(40));
            let windows = snapshot(app)?;
            let actual = windows
                .iter()
                .find(|w| w.id == current.id && w.pid == current.pid)
                .ok_or("The selected window closed while restoring its placement.")?;
            if actual.rect == requested
                && !actual.maximized_horizontal
                && !actual.maximized_vertical
                && !actual.fullscreen
            {
                return Ok(());
            }
        }
    }
    Err("The app did not accept the saved window size. It may enforce a minimum size or have changed its layout.".into())
}
pub fn focus_window(app: &AppHandle, window: &crate::workspaces::WindowInfo) -> Result<(), String> {
    crate::linux_control::request(
        app,
        serde_json::json!({"kind":"focus", "window":{"id":window.id,"pid":window.pid}}),
    )?;
    Ok(())
}

fn qdbus() -> Result<String, String> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    if !desktop.split(':').any(|d| d.eq_ignore_ascii_case("KDE")) {
        return Err(
            "This version supports KDE Plasma 5.27 and 6 on Linux. Log into a Plasma session first.".into(),
        );
    }
    for program in ["qdbus6", "qdbus-qt6", "/usr/lib/qt6/bin/qdbus", "qdbus"] {
        if Command::new(program)
            .arg("--version")
            .output()
            .is_ok_and(|r| r.status.success())
        {
            return Ok(program.into());
        }
    }
    Err("Qt's qdbus tool is missing. Install qdbus for Plasma 5, or your distribution's Qt 6 tools package for Plasma 6.".into())
}
fn call(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .arg("org.kde.KWin")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "KWin integration failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
pub fn configure_pause(app: &AppHandle, config: &Config) -> Result<(), String> {
    let mut pause = config.clone();
    pause
        .bindings
        .retain(|b| b.enabled && b.action == "toggle-pause");
    if pause.bindings.is_empty() {
        return unload_script("window-warp-pause-session");
    }
    let source = shortcut_source(app, &pause)?;
    load_script(app, "window-warp-pause-session", "kwin-pause.js", &source)
}
fn shortcut_source(app: &AppHandle, config: &Config) -> Result<String, String> {
    Ok(format!(
        "var WARP_APP = {};\nvar WARP_CONFIG = {};\n{}",
        crate::linux_control::descriptor(app)?,
        serde_json::to_string(config).map_err(|e| e.to_string())?,
        include_str!("../kwin/warp.js")
    ))
}
pub fn enable(app: &AppHandle, config: &Config) -> Result<(), String> {
    let mut active = config.clone();
    active.bindings.retain(|b| b.action != "toggle-pause");
    let source = shortcut_source(app, &active)?;
    let ids = crate::linux_gestures::start(app, &active)?;
    let source = format!(
        "var WARP_HOLD_IDS = {};\n{source}",
        serde_json::to_string(&ids).map_err(|e| e.to_string())?
    );
    let result = crate::linux_control::request(app, serde_json::json!({"kind":"reset-app-pulls"}))
        .and_then(|_| load_script(app, SCRIPT_NAME, "kwin-session.js", &source));
    if let Err(error) = result {
        let cleanup = crate::linux_gestures::stop();
        return Err(format!(
            "{error}{}",
            cleanup
                .err()
                .map(|e| format!("; hold cleanup failed: {e}"))
                .unwrap_or_default()
        ));
    }
    Ok(())
}
pub fn shutdown(app: &AppHandle) {
    let _ = crate::linux_gestures::stop();
    let _ = unload_script("window-warp-pause-session");
    crate::linux_control::shutdown(app);
}
pub fn load_script(
    app: &AppHandle,
    name: &str,
    filename: &str,
    source: &str,
) -> Result<(), String> {
    let program = qdbus()?;
    unload_script(name)?;
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join(filename);
    fs::write(&path, source).map_err(|e| e.to_string())?;
    let id = call(
        &program,
        &[
            "/Scripting",
            "org.kde.kwin.Scripting.loadScript",
            path.to_str().ok_or("Invalid script path")?,
            name,
        ],
    )?;
    let id: i32 = id
        .parse()
        .map_err(|_| "KWin returned an invalid script ID.")?;
    if id < 0 {
        return Err("KWin could not load the integration.".into());
    }
    // Plasma 5 and 6 expose script objects at different D-Bus paths.
    let modern_path = format!("/Scripting/Script{id}");
    let legacy_path = format!("/{id}");
    let path = if call(
        &program,
        &[
            &modern_path,
            "org.freedesktop.DBus.Introspectable.Introspect",
        ],
    )
    .is_ok_and(|xml| xml.contains("org.kde.kwin.Script"))
    {
        modern_path
    } else {
        legacy_path
    };
    let result = call(&program, &[&path, "org.kde.kwin.Script.run"]);
    if let Err(error) = result {
        let _ = unload_script(name);
        return Err(error);
    }
    Ok(())
}
pub fn disable(_: &AppHandle) -> Result<(), String> {
    crate::linux_gestures::stop()?;
    unload_script(SCRIPT_NAME)
}
pub fn unload_script(name: &str) -> Result<(), String> {
    let program = qdbus()?;
    let loaded = call(
        &program,
        &["/Scripting", "org.kde.kwin.Scripting.isScriptLoaded", name],
    )?;
    if loaded == "true" {
        let unloaded = call(
            &program,
            &["/Scripting", "org.kde.kwin.Scripting.unloadScript", name],
        )?;
        if unloaded != "true" {
            return Err("KWin could not unload the shortcuts. Try pausing again.".into());
        }
    }
    Ok(())
}
