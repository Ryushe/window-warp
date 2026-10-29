use crate::config::Config;
use std::{
    collections::HashMap,
    fs,
    process::Command,
    sync::{mpsc, LazyLock, Mutex},
};

static SCRIPT_READY: LazyLock<Mutex<HashMap<String, mpsc::SyncSender<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
struct ScriptTicket(String);
impl Drop for ScriptTicket {
    fn drop(&mut self) {
        if let Ok(mut pending) = SCRIPT_READY.lock() {
            pending.remove(&self.0);
        }
    }
}
pub(crate) fn script_ready(ticket: &str) {
    if let Ok(mut pending) = SCRIPT_READY.lock() {
        if let Some(reply) = pending.remove(ticket) {
            let _ = reply.send(());
        }
    }
}

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

pub fn editor_foreground() -> Option<String> {
    None
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
pub fn snapshot_for_binding(
    app: &AppHandle,
    binding: &crate::config::Binding,
) -> Result<Vec<crate::workspaces::WindowInfo>, String> {
    if binding.windows_match.is_some() && binding.app_matches.is_empty() {
        return Err("Windows window-match rules cannot run on KDE. Adapt the binding to a KDE app identifier first.".into());
    }
    snapshot(app)
}
pub fn restore_window(
    app: &AppHandle,
    current: &crate::workspaces::WindowInfo,
    saved: &crate::workspaces::WindowInfo,
) -> Result<(), String> {
    let command = serde_json::json!({"kind":"restore", "window":{"id": current.id, "pid":current.pid}, "placement":saved});
    // Wayland clients acknowledge geometry asynchronously. In particular,
    // Firefox's unmaximize acknowledgement can supersede the first resize.
    // Verify the requested state and normal floating placement, retrying after
    // the transition; there is no polling while the app is idle.
    for _ in 0..3 {
        let requested: crate::geometry::Rect =
            serde_json::from_value(crate::linux_control::request(app, command.clone())?)
                .map_err(|e| format!("Invalid KWin placement response: {e}"))?;
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(40));
            let windows = snapshot(app)?;
            let actual = windows
                .iter()
                .find(|w| w.id == current.id && w.pid == current.pid)
                .ok_or("The selected window closed while restoring its placement.")?;
            let state_matches = actual.maximized_horizontal == saved.maximized_horizontal
                && actual.maximized_vertical == saved.maximized_vertical
                && actual.fullscreen == saved.fullscreen
                && actual.minimized == saved.minimized;
            let floating = !saved.maximized_horizontal
                && !saved.maximized_vertical
                && !saved.fullscreen
                && !saved.minimized;
            if state_matches && (!floating || actual.rect == requested) {
                return Ok(());
            }
        }
    }
    Err("The app did not accept the saved window size or state. It may enforce a minimum size or have changed its layout.".into())
}
pub fn focus_captured(app: &AppHandle, id: &str, pid: u32) -> Result<(), String> {
    crate::linux_control::request(
        app,
        serde_json::json!({"kind":"focus", "window":{"id":id,"pid":pid}}),
    )?;
    Ok(())
}
pub fn focus_window(app: &AppHandle, window: &crate::workspaces::WindowInfo) -> Result<(), String> {
    crate::linux_control::request(
        app,
        serde_json::json!({"kind":"focus", "window":{"id":window.id,"pid":window.pid}}),
    )?;
    Ok(())
}

pub fn pointer(app: &AppHandle) -> Result<crate::radial::Point, String> {
    serde_json::from_value(crate::linux_control::request(
        app,
        serde_json::json!({"kind":"pointer"}),
    )?)
    .map_err(|e| format!("Invalid KDE pointer position: {e}"))
}
pub fn pointer_area(
    app: &AppHandle,
    point: crate::radial::Point,
) -> Result<crate::geometry::Rect, String> {
    serde_json::from_value(crate::linux_control::request(
        app,
        serde_json::json!({"kind":"pointer-area","point":point}),
    )?)
    .map_err(|e| format!("Invalid KDE pointer work area: {e}"))
}
pub fn show_radial(app: &AppHandle, bounds: crate::geometry::Rect) -> Result<(), String> {
    let window = app
        .get_webview_window("radial")
        .ok_or("The window picker is unavailable.")?;
    window.show().map_err(|e| e.to_string())?;
    for _ in 0..15 {
        if crate::linux_control::request(
            app,
            serde_json::json!({"kind":"show-radial","bounds":bounds}),
        )? == serde_json::Value::Bool(true)
        {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Err("KWin could not place the window picker.".into())
}
pub fn pull_selected(
    app: &AppHandle,
    binding: &crate::config::Binding,
    settings: &crate::config::Settings,
    selected: &crate::workspaces::WindowInfo,
    previous: Option<&crate::workspaces::WindowInfo>,
) -> Result<(), String> {
    if binding.windows_match.is_some() && binding.app_matches.is_empty() {
        return Err("Windows window-match rules cannot run on KDE. Adapt the binding to a KDE app identifier first.".into());
    }
    crate::linux_control::input_request(
        app,
        serde_json::json!({"kind":"pull-selected", "window":selected,
        "previous":previous, "binding":binding, "settings":settings}),
        None,
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
    // Leave a desktop-owned pause key alone until Warp is actually enabled.
    if !crate::linux_override::borrowing() {
        let keys: Vec<_> = pause
            .bindings
            .iter()
            .map(|binding| binding.shortcut.clone())
            .collect();
        if crate::linux_override::others_own(&keys).unwrap_or(false) {
            return unload_script("window-warp-pause-session");
        }
    }
    let source = shortcut_source(app, &pause)?;
    load_script(app, "window-warp-pause-session", "kwin-pause.js", &source)
}
pub(crate) fn shortcut_source(app: &AppHandle, config: &Config) -> Result<String, String> {
    Ok(format!(
        "var WARP_APP = {};\nvar WARP_CONFIG = {};\n{}",
        crate::linux_control::descriptor(app)?,
        serde_json::to_string(config).map_err(|e| e.to_string())?,
        include_str!("../kwin/shortcuts.js")
    ))
}
pub fn enable(app: &AppHandle, config: &Config) -> Result<(), String> {
    // Create the authenticated endpoint before the gesture worker installs hooks.
    crate::linux_control::descriptor(app)?;
    crate::linux_gestures::start(app, config)
}

#[derive(Default)]
pub struct RetileHooks;
impl RetileHooks {
    pub fn install(&mut self, app: &AppHandle, keys: &[String]) -> Result<(), String> {
        let source = format!(
            "var endpoint = {}; var keys = {}; keys.forEach(function(key) {{
                if (!registerShortcut('window-warp-retile-' + key.replace('+','-'), 'Window Warp: retile ' + key, key.replace('Super','Meta'), function() {{
                    callDBus(endpoint.service, '/Control', 'com.windowwarp.Control', 'Retile', endpoint.token, key);
                }})) throw new Error('Could not register retile ' + key);
            }});",
            crate::linux_control::descriptor(app)?, serde_json::to_string(keys).map_err(|e| e.to_string())?
        );
        load_script(app, "window-warp-retile-session", "kwin-retile.js", &source)
    }
    pub fn clear(&mut self, _: &AppHandle) -> Result<(), String> {
        unload_script("window-warp-retile-session")
    }
}
pub fn retile_window(
    app: &AppHandle,
    target: &crate::retile::Target,
    left: bool,
) -> Result<(), String> {
    crate::linux_control::input_request(app, serde_json::json!({
        "kind":"retile", "window":target, "direction":if left { "tile-left" } else { "tile-right" }
    }), None).map(|_| ())
}

pub(crate) fn enable_window_actions(app: &AppHandle, config: &Config) -> Result<(), String> {
    let mut active = config.clone();
    active.bindings.retain(|b| b.action != "toggle-pause");
    // Keep indices stable for the non-gesture action IDs.
    for binding in &mut active.bindings {
        if binding.action == "pull-app" {
            binding.enabled = false;
        }
    }
    let source = shortcut_source(app, &active)?;
    load_script(app, SCRIPT_NAME, "kwin-session.js", &source)
}

pub(crate) fn disable_window_actions() -> Result<(), String> {
    unload_script(SCRIPT_NAME)
}

pub fn shutdown(app: &AppHandle) {
    let _ = crate::linux_gestures::stop();
    let _ = unload_script("window-warp-retile-session");
    let _ = unload_script("window-warp-pause-session");
    let _ = crate::linux_override::restore();
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
    let ticket = ScriptTicket(uuid::Uuid::new_v4().to_string());
    let (reply, ready) = mpsc::sync_channel(1);
    SCRIPT_READY
        .lock()
        .map_err(|e| e.to_string())?
        .insert(ticket.0.clone(), reply);
    let source = format!("{source}\ncallDBus(\"com.windowwarp.Control\", \"/Control\", \"com.windowwarp.Control\", \"ScriptReady\", {});", serde_json::to_string(&ticket.0).map_err(|e| e.to_string())?);
    fs::write(&path, source).map_err(|e| e.to_string())?;
    // Plasma 5 assigns IDs from its current script count. Removing an earlier
    // script can leave another object at the ID returned by the next load.
    let previous_paths = call(&program, &[])?;
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
    let occupied = previous_paths.lines().any(|line| line.trim() == path);
    let result = if occupied {
        // The per-object endpoint belongs to an older script. KWin's supported
        // startup entry point starts loaded scripts without relying on that ID.
        call(&program, &["/Scripting", "org.kde.kwin.Scripting.start"])
    } else {
        call(&program, &[&path, "org.kde.kwin.Script.run"])
    }
    .and_then(|_| {
        ready
            .recv_timeout(std::time::Duration::from_secs(5))
            .map(|_| String::new())
            .map_err(|_| {
                format!("KWin did not finish starting {name}. Its shortcuts remain paused.")
            })
    });
    if let Err(error) = result {
        let _ = unload_script(name);
        return Err(error);
    }
    Ok(())
}
pub fn disable(_: &AppHandle) -> Result<(), String> {
    let retile = unload_script("window-warp-retile-session");
    let gestures = crate::linux_gestures::pause();
    let failures: Vec<_> = retile
        .err()
        .into_iter()
        .chain(gestures.as_ref().err().cloned())
        .collect();
    if !failures.is_empty() {
        let _ = end_activation();
        return Err(failures.join("; "));
    }
    if gestures.unwrap_or(false) {
        return end_activation();
    }
    disable_window_actions()?;
    // No worker exists during startup; reclaim hooks left by a previous crash.
    for id in shortcut_names()?
        .into_iter()
        .filter(|id| crate::linux_gestures::owns_script(id))
    {
        unload_script(&id)?;
    }
    end_activation()
}
fn end_activation() -> Result<(), String> {
    if crate::linux_override::takes_pause() {
        let _ = unload_script("window-warp-pause-session");
    }
    crate::linux_override::restore()
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
    forget_script_shortcuts(name)
}

// Unloading a KWin script only marks its actions inactive. KDE keeps their
// saved key reservations, which can block our own edited/reassigned bindings.
// Remove only the action family belonging to the script we just unloaded.
fn owns_shortcut(script: &str, id: &str) -> bool {
    if crate::linux_gestures::owns_script(script) {
        return id == script;
    }
    match script {
        "window-warp-retile-session" => id.starts_with("window-warp-retile-"),
        "window-warp-pause-session" => id.starts_with("window-warp-toggle-pause-"),
        "window-warp-control-session" => id == "window-warp-control-dispatch",
        SCRIPT_NAME => [
            "hold",
            "push-left",
            "push-right",
            "pull",
            "tile-left",
            "tile-right",
            "tile-up",
            "tile-down",
            "focus-app",
            "pull-app",
            "toggle-maximize",
            "close-window",
            "open-editor",
            "open-workspaces",
            "update-workspace",
        ]
        .iter()
        .any(|action| id.starts_with(&format!("window-warp-{action}-"))),
        _ => false,
    }
}

fn shortcut_names() -> Result<Vec<String>, String> {
    let connection = zbus::blocking::connection::Builder::session()
        .map_err(|e| e.to_string())?
        .method_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let component = zbus::blocking::Proxy::new(
        &connection,
        "org.kde.kglobalaccel",
        "/component/kwin",
        "org.kde.kglobalaccel.Component",
    )
    .map_err(|e| e.to_string())?;
    component
        .call("shortcutNames", &())
        .map_err(|e| format!("Cannot inspect KDE shortcut reservations: {e}"))
}

fn forget_script_shortcuts(script: &str) -> Result<(), String> {
    let connection = zbus::blocking::connection::Builder::session()
        .map_err(|e| e.to_string())?
        .method_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let component = zbus::blocking::Proxy::new(
        &connection,
        "org.kde.kglobalaccel",
        "/component/kwin",
        "org.kde.kglobalaccel.Component",
    )
    .map_err(|e| e.to_string())?;
    let ids: Vec<String> = component
        .call("shortcutNames", &())
        .map_err(|e| format!("Cannot inspect KDE shortcut reservations: {e}"))?;
    let registry = zbus::blocking::Proxy::new(
        &connection,
        "org.kde.kglobalaccel",
        "/kglobalaccel",
        "org.kde.KGlobalAccel",
    )
    .map_err(|e| e.to_string())?;
    for id in ids.into_iter().filter(|id| owns_shortcut(script, id)) {
        let _: bool = registry
            .call("unregister", &("kwin", id.as_str()))
            .map_err(|e| format!("Cannot release KDE shortcut {id}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod shortcut_tests {
    use super::*;

    #[test]
    fn script_completion_requires_a_live_one_use_ticket() {
        let ticket = ScriptTicket(uuid::Uuid::new_v4().to_string());
        let (reply, ready) = mpsc::sync_channel(1);
        SCRIPT_READY.lock().unwrap().insert(ticket.0.clone(), reply);
        script_ready("unknown-ticket");
        assert!(matches!(ready.try_recv(), Err(mpsc::TryRecvError::Empty)));
        script_ready(&ticket.0);
        assert!(ready.try_recv().is_ok());
        script_ready(&ticket.0);
        assert!(matches!(
            ready.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
        let expired = ScriptTicket(uuid::Uuid::new_v4().to_string());
        let name = expired.0.clone();
        let (reply, _ready) = mpsc::sync_channel(1);
        SCRIPT_READY.lock().unwrap().insert(name.clone(), reply);
        drop(expired);
        assert!(!SCRIPT_READY.lock().unwrap().contains_key(&name));
    }

    #[test]
    fn action_cleanup_preserves_pause_control_and_foreign_shortcuts() {
        for id in [
            "window-warp-hold-2-Ctrl+Alt+J",
            "window-warp-push-left-0-Ctrl-Alt-J",
            "window-warp-pull-app-9-Ctrl-Alt-J",
        ] {
            assert!(owns_shortcut(SCRIPT_NAME, id));
        }
        for id in [
            "window-warp-toggle-pause-0-Ctrl-Alt-P",
            "window-warp-control-dispatch",
            "window-warp-smoke-pull-1",
            "Window Close",
            "other-app-pull-1",
        ] {
            assert!(!owns_shortcut(SCRIPT_NAME, id));
        }
    }

    #[test]
    fn pause_and_control_cleanup_are_separate() {
        assert!(owns_shortcut(
            "window-warp-gesture-1234",
            "window-warp-gesture-1234"
        ));
        assert!(!owns_shortcut(
            "window-warp-gesture-1234",
            "window-warp-gesture-5678"
        ));
        assert!(!owns_shortcut(SCRIPT_NAME, "window-warp-gesture-1234"));
        assert!(owns_shortcut(
            "window-warp-pause-session",
            "window-warp-toggle-pause-0-Ctrl-Alt-P"
        ));
        assert!(!owns_shortcut(
            "window-warp-pause-session",
            "window-warp-pull-0-Ctrl-Alt-P"
        ));
        assert!(owns_shortcut(
            "window-warp-control-session",
            "window-warp-control-dispatch"
        ));
        assert!(!owns_shortcut(
            "unrelated-script",
            "window-warp-control-dispatch"
        ));
    }
}
