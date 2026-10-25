use crate::geometry::Rect;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowInfo {
    pub id: String,
    pub pid: u32,
    pub title: String,
    pub app_id: String,
    pub desktop_id: String,
    pub path: String,
    pub rect: Rect,
    pub work_area: Rect,
    pub monitor: usize,
    pub monitor_name: String,
    pub maximized_horizontal: bool,
    pub maximized_vertical: bool,
    pub fullscreen: bool,
    pub minimized: bool,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceItem {
    pub label: String,
    pub window: WindowInfo,
    pub launch: LaunchSpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<crate::firefox::Browser>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<crate::terminal::Terminal>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub capture_note: String,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LaunchKind {
    #[default]
    Executable,
    DesktopEntry,
    PackagedApp,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct LaunchSpec {
    pub kind: LaunchKind,
    pub program: String,
    pub args: Vec<String>,
    pub working_directory: String,
    pub new_window: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub items: Vec<WorkspaceItem>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceStore {
    pub version: u32,
    pub profiles: Vec<Workspace>,
}
impl Default for WorkspaceStore {
    fn default() -> Self {
        Self {
            version: 1,
            profiles: vec![],
        }
    }
}

impl WorkspaceStore {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.profiles.len() > 100 {
            return Err(
                "Unsupported workspace format or too many workspaces (maximum 100).".into(),
            );
        }
        let mut ids = HashSet::new();
        for profile in &self.profiles {
            if profile.id.is_empty()
                || profile.id.len() > 100
                || !ids.insert(&profile.id)
                || profile.name.trim().is_empty()
                || profile.name.len() > 240
                || profile.items.len() > 100
            {
                return Err(
                    "Each workspace needs a unique ID, a name, and at most 100 windows.".into(),
                );
            }
            if !["windows", "linux"].contains(&profile.platform.as_str()) {
                return Err("Unknown workspace platform.".into());
            }
            for item in &profile.items {
                if let Some(browser) = &item.browser {
                    browser.validate()?;
                }
                if let Some(terminal) = &item.terminal {
                    terminal.validate()?;
                    if item.browser.is_some() {
                        return Err(
                            "A workspace window cannot be both a browser and a terminal.".into(),
                        );
                    }
                }
                let w = &item.window;
                for rect in [w.rect, w.work_area] {
                    if rect.width <= 0
                        || rect.height <= 0
                        || rect.width > 100_000
                        || rect.height > 100_000
                        || rect.x.unsigned_abs() > 100_000
                        || rect.y.unsigned_abs() > 100_000
                    {
                        return Err("Invalid saved window geometry.".into());
                    }
                }
                if w.app_id.is_empty()
                    || w.app_id.len() > 1024
                    || w.id.len() > 100
                    || w.title.len() > 16000
                    || w.path.len() > 32768
                    || w.desktop_id.len() > 32768
                    || w.desktop_id.contains('\0')
                    || w.monitor == 0
                    || w.monitor > 100
                    || item.label.len() > 1024
                {
                    return Err("Invalid saved window identity.".into());
                }
                let launch = &item.launch;
                if launch.program.contains('\0')
                    || launch.program.len() > 32768
                    || launch.args.len() > 1000
                    || launch
                        .args
                        .iter()
                        .any(|a| a.contains('\0') || a.len() > 32768)
                    || launch.working_directory.contains('\0')
                {
                    return Err("Invalid application launch arguments.".into());
                }
            }
        }
        Ok(())
    }
}

pub fn load(app: &AppHandle) -> Result<WorkspaceStore, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("workspaces.json");
    let store = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<WorkspaceStore>(&text).map_err(|e| {
            format!("Cannot read workspaces: {e}. The original file has been preserved.")
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => WorkspaceStore::default(),
        Err(e) => return Err(e.to_string()),
    };
    store.validate()?;
    Ok(store)
}
pub fn save(app: &AppHandle, store: &WorkspaceStore) -> Result<(), String> {
    store.validate()?;
    // Never replace an unreadable existing store through an incidental UI save.
    load(app)?;
    let directory = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let temporary = directory.join("workspaces.json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temporary, directory.join("workspaces.json")).map_err(|e| e.to_string())
}

pub fn capture(windows: Vec<WindowInfo>, name: String) -> Workspace {
    Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        platform: std::env::consts::OS.into(),
        items: windows
            .into_iter()
            .filter(|w| !w.minimized)
            .map(|window| {
                let label = window.title.clone();
                let mut launch = LaunchSpec {
                    program: window.path.clone(),
                    ..Default::default()
                };
                let mut capture_note = String::new();
                #[cfg(target_os = "linux")]
                if !window.desktop_id.is_empty() {
                    if crate::linux_apps::installed(&window.desktop_id) {
                        launch.kind = LaunchKind::DesktopEntry;
                        launch.program = window.desktop_id.clone();
                    } else {
                        capture_note = "The window's desktop entry is not installed. Review the captured executable before restoring it.".into();
                    }
                }
                #[cfg(windows)]
                if !window.desktop_id.is_empty() {
                    launch.kind = LaunchKind::PackagedApp;
                    launch.program = window.desktop_id.clone();
                } else if window.path.to_ascii_lowercase().contains("\\windowsapps\\") {
                    capture_note = "The packaged app's activation ID could not be captured. Select Windows packaged app and enter its AUMID before launching.".into();
                }
                WorkspaceItem {
                    label,
                    window,
                    launch,
                    browser: None,
                    terminal: None,
                    capture_note,
                }
            })
            .collect(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub label: String,
    pub restored: bool,
    pub launched: bool,
    pub error: Option<String>,
}

pub fn launch(spec: &LaunchSpec) -> Result<(), String> {
    use std::process::{Command, Stdio};
    if spec.program.trim().is_empty() {
        return Err(
            "No launch command is saved for this app. Edit the workspace launch command first."
                .into(),
        );
    }
    if spec.kind != LaunchKind::Executable && !spec.working_directory.is_empty() {
        return Err("Working directory applies only to executable launches. Clear it or select Executable in app launch settings.".into());
    }
    match spec.kind {
        LaunchKind::DesktopEntry => {
            #[cfg(target_os = "linux")]
            return crate::linux_apps::launch(&spec.program, &spec.args);
            #[cfg(not(target_os = "linux"))]
            return Err("Desktop entries can only be launched on Linux. Adapt the app launch settings for this operating system.".into());
        }
        LaunchKind::PackagedApp => {
            #[cfg(windows)]
            return crate::windows_apps::activate(&spec.program, &spec.args);
            #[cfg(not(windows))]
            return Err("Packaged Windows apps can only be launched on Windows. Adapt the app launch settings for this operating system.".into());
        }
        LaunchKind::Executable => {}
    }
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if !spec.working_directory.is_empty() {
        command.current_dir(&spec.working_directory);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot launch {}: {e}", spec.program))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

pub fn restore(
    app: &AppHandle,
    profile: &Workspace,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<Vec<RestoreResult>, String> {
    use std::{
        sync::atomic::Ordering,
        time::{Duration, Instant},
    };
    if profile.platform != std::env::consts::OS {
        return Err("This workspace was captured on another operating system. Import or adapt its app commands before launching it here.".into());
    }
    let mut used = HashSet::new();
    let mut browser_matcher = crate::firefox::Matcher::default();
    let terminal_capture = profile
        .items
        .iter()
        .any(|i| i.terminal.is_some())
        .then(crate::terminal::Capture::new);
    let mut results = Vec::new();
    for item in &profile.items {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        let mut launched = false;
        let result = (|| {
            let mut windows = crate::platform::snapshot(app)?;
            if let Some(terminal) = &item.terminal {
                let all = windows.clone();
                windows.retain(|w| {
                    crate::terminal::kind(w) == Some(terminal.kind)
                        && terminal_capture
                            .as_ref()
                            .is_some_and(|capture| capture.matches(w, &all, terminal))
                });
            }
            if let Some(browser) = &item.browser {
                windows.retain(|w| {
                    !crate::firefox::is_firefox(w) || browser_matcher.matches(w, browser)
                });
            }
            let existing = if item.launch.new_window {
                None
            } else {
                find_match(&item.window, &windows, &used).cloned()
            };
            let target = if let Some(window) = existing {
                window
            } else {
                // Include all preexisting browser windows, even other profiles.
                let before: HashSet<_> = crate::platform::snapshot(app)?
                    .iter()
                    .map(|w| w.id.clone())
                    .collect();
                let commands = if let Some(browser) = &item.browser {
                    browser.launch_commands(&item.launch)?
                } else if let Some(terminal) = &item.terminal {
                    vec![terminal.launch_command(&item.launch)?]
                } else {
                    vec![item.launch.clone()]
                };
                launch(&commands[0])?;
                launched = true;
                let deadline = Instant::now() + Duration::from_secs(12);
                let new_window = loop {
                    if cancelled.load(Ordering::Relaxed) {
                        return Err("Workspace restore canceled.".into());
                    }
                    let windows = crate::platform::snapshot(app)?;
                    let excluded: HashSet<_> = if item.launch.new_window
                        || item.browser.is_some()
                        || item.terminal.is_some()
                    {
                        used.union(&before).cloned().collect()
                    } else {
                        used.clone()
                    };
                    if let Some(window) = find_match(&item.window, &windows, &excluded) {
                        break window.clone();
                    }
                    if Instant::now() >= deadline {
                        return Err(
                            "The app started, but no matching window appeared within 12 seconds."
                                .into(),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(150));
                };
                // Additional tabs are sent after the new browser window exists.
                // Keep the selected tab last, matching the original app.
                for command in commands.iter().skip(1) {
                    if cancelled.load(Ordering::Relaxed) {
                        return Err("Workspace restore canceled.".into());
                    }
                    crate::platform::focus_window(app, &new_window)?;
                    launch(command)?;
                }
                new_window
            };
            used.insert(target.id.clone());
            crate::platform::restore_window(app, &target, &item.window)
        })();
        results.push(RestoreResult {
            label: item.label.clone(),
            restored: result.is_ok(),
            launched,
            error: result.err(),
        });
    }
    Ok(results)
}

/// Exact title is preferred, then app identity; a claimed window cannot serve two items.
pub fn find_match<'a>(
    saved: &WindowInfo,
    windows: &'a [WindowInfo],
    used: &HashSet<String>,
) -> Option<&'a WindowInfo> {
    windows
        .iter()
        .filter(|w| {
            !used.contains(&w.id)
                && if saved.desktop_id.is_empty() {
                    w.app_id.eq_ignore_ascii_case(&saved.app_id)
                } else {
                    w.desktop_id == saved.desktop_id
                }
        })
        .max_by_key(|w| {
            (
                w.title == saved.title,
                !saved.path.is_empty() && w.path == saved.path,
                w.active,
            )
        })
}

pub fn best_match(profiles: &[Workspace], windows: &[WindowInfo]) -> Option<String> {
    profiles
        .iter()
        .filter(|p| p.platform == std::env::consts::OS)
        .filter_map(|profile| {
            let mut used = HashSet::new();
            let mut count = 0;
            for item in &profile.items {
                if let Some(found) = find_match(&item.window, windows, &used) {
                    used.insert(found.id.clone());
                    count += 1;
                }
            }
            if count == 0 {
                None
            } else {
                Some((
                    count,
                    std::cmp::Reverse(profile.items.len().abs_diff(windows.len())),
                    profile.id.clone(),
                ))
            }
        })
        .max()
        .map(|(_, _, id)| id)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn window(id: &str, title: &str) -> WindowInfo {
        WindowInfo {
            id: id.into(),
            pid: 123,
            title: title.into(),
            app_id: "fixture".into(),
            desktop_id: String::new(),
            path: "/test/app".into(),
            rect: Rect {
                x: 20,
                y: 30,
                width: 600,
                height: 400,
            },
            work_area: Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            monitor: 1,
            monitor_name: "main".into(),
            maximized_horizontal: false,
            maximized_vertical: false,
            fullscreen: false,
            minimized: false,
            active: false,
        }
    }
    #[test]
    fn matching_prefers_title_and_never_reuses_claimed_windows() {
        let saved = window("old", "Second");
        let current = vec![window("1", "First"), window("2", "Second")];
        let mut used = HashSet::new();
        let matched = find_match(&saved, &current, &used).unwrap();
        assert_eq!(matched.id, "2");
        used.insert(matched.id.clone());
        assert_eq!(find_match(&saved, &current, &used).unwrap().id, "1");
        used.insert("1".into());
        assert!(find_match(&saved, &current, &used).is_none());
    }
    #[test]
    fn capture_excludes_minimized_windows_and_round_trips_launch_arguments() {
        let mut minimized = window("2", "Hidden");
        minimized.minimized = true;
        let mut profile = capture(vec![window("1", "One"), minimized], "Work".into());
        assert_eq!(profile.items.len(), 1);
        profile.items[0].launch.args = vec![
            "a b".into(),
            "$(not a shell)".into(),
            "-profile".into(),
            "Unicode \u{2603}".into(),
        ];
        let store = WorkspaceStore {
            version: 1,
            profiles: vec![profile],
        };
        store.validate().unwrap();
        let reread: WorkspaceStore =
            serde_json::from_slice(&serde_json::to_vec(&store).unwrap()).unwrap();
        assert_eq!(
            reread.profiles[0].items[0].launch.args,
            store.profiles[0].items[0].launch.args
        );
    }
    #[test]
    fn invalid_geometry_duplicate_ids_and_nul_arguments_are_rejected() {
        let profile = capture(vec![window("1", "One")], "Work".into());
        let mut store = WorkspaceStore {
            version: 1,
            profiles: vec![profile.clone(), profile],
        };
        assert!(store.validate().is_err());
        store.profiles.pop();
        store.profiles[0].items[0].window.rect.width = 0;
        assert!(store.validate().is_err());
        store.profiles[0].items[0].window.rect.width = 100;
        store.profiles[0].items[0]
            .launch
            .args
            .push("bad\0argument".into());
        assert!(store.validate().is_err());
    }
    #[test]
    fn update_guess_uses_instance_counts_not_just_app_presence() {
        let one = capture(vec![window("1", "One")], "One".into());
        let two = capture(vec![window("1", "One"), window("2", "Two")], "Two".into());
        let expected = two.id.clone();
        assert_eq!(
            best_match(&[one, two], &[window("new1", "One"), window("new2", "Two")]),
            Some(expected)
        );
    }
    #[test]
    fn launch_kind_defaults_for_existing_workspaces_and_round_trips() {
        let old: LaunchSpec = serde_json::from_str(
            r#"{"program":"app","args":[],"workingDirectory":"","newWindow":false}"#,
        )
        .unwrap();
        assert_eq!(old.kind, LaunchKind::Executable);
        for kind in [LaunchKind::DesktopEntry, LaunchKind::PackagedApp] {
            let spec = LaunchSpec {
                kind,
                program: "application-id".into(),
                ..Default::default()
            };
            let saved: LaunchSpec =
                serde_json::from_str(&serde_json::to_string(&spec).unwrap()).unwrap();
            assert_eq!(saved.kind, kind);
            assert_eq!(saved.program, "application-id");
            let mut invalid = spec;
            invalid.working_directory = "/tmp".into();
            assert!(launch(&invalid).unwrap_err().contains("Working directory"));
        }
    }
    #[test]
    fn desktop_identity_prevents_reusing_a_different_app_in_the_same_host() {
        let mut saved = window("old", "Same title");
        saved.desktop_id = "PackageA!App".into();
        let mut wrong = window("1", "Same title");
        wrong.desktop_id = "PackageB!App".into();
        let mut right = window("2", "New title");
        right.desktop_id = saved.desktop_id.clone();
        let windows = [wrong, right];
        assert_eq!(
            find_match(&saved, &windows, &HashSet::new()).unwrap().id,
            "2"
        );
        assert!(find_match(&saved, &windows[..1], &HashSet::new()).is_none());
    }
    #[cfg(windows)]
    #[test]
    fn capture_uses_actual_packaged_identity_instead_of_guessing_app_suffix() {
        let mut packaged = window("1", "Packaged app");
        packaged.desktop_id = "Contoso_abc!OtherApp".into();
        let profile = capture(vec![packaged], "Packages".into());
        assert_eq!(profile.items[0].launch.kind, LaunchKind::PackagedApp);
        assert_eq!(profile.items[0].launch.program, "Contoso_abc!OtherApp");
    }
    #[test]
    fn missing_launch_target_reports_error_instead_of_success() {
        let spec = LaunchSpec {
            program: "window-warp-nonexistent-fixture-executable".into(),
            ..Default::default()
        };
        assert!(launch(&spec).unwrap_err().contains("Cannot launch"));
    }
}
