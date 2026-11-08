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
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub class_name: String,
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

// Transient compositor state; unlike WindowInfo, these identities are not
// written into a saved workspace and are rechecked whenever tabs are updated.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualDesktop {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatedWindow {
    pub window: WindowInfo,
    pub desktops: Vec<VirtualDesktop>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    pub current: Option<VirtualDesktop>,
    pub windows: Vec<LocatedWindow>,
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

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SavedBrowserMode {
    Replace,
    Append,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedBrowserTarget {
    pub index: usize,
    pub expected: WorkspaceItem,
    pub mode: SavedBrowserMode,
}

/// Keep the saved profile identity while accepting tabs only from the same
/// identified open browser. An empty snapshot must never erase saved tabs.
pub fn refreshed_saved_browser(
    saved: &crate::firefox::Browser,
    current: &crate::firefox::Browser,
) -> Option<crate::firefox::Browser> {
    if saved.kind != current.kind
        || current.tabs.is_empty()
        || (!saved.profile_path.is_empty()
            && (current.profile_path.is_empty()
                || !crate::browser_bridge::same_path(&saved.profile_path, &current.profile_path)))
        || (saved.profile_path.is_empty()
            && !saved.profile_name.is_empty()
            && saved.profile_name != current.profile_name)
    {
        return None;
    }
    let mut refreshed = saved.clone();
    refreshed.tabs = current.tabs.clone();
    refreshed.active_tab = current.active_tab;
    refreshed.validate().ok()?;
    Some(refreshed)
}

/// Copy a saved browser into a workspace, or update one explicitly reviewed
/// browser. Only tabs change when updating an existing window.
pub fn apply_saved_browser(
    workspace: &mut Workspace,
    saved_item: &WorkspaceItem,
    target: Option<SavedBrowserTarget>,
) -> Result<(), String> {
    let source = saved_item
        .browser
        .as_ref()
        .ok_or("This saved browser has no tabs.")?;
    source.validate()?;
    let Some(target) = target else {
        workspace.items.push(saved_item.clone());
        return Ok(());
    };
    let item = workspace
        .items
        .get_mut(target.index)
        .ok_or("This workspace changed. Reopen the browser chooser.")?;
    if serde_json::to_value(&*item).map_err(|e| e.to_string())?
        != serde_json::to_value(&target.expected).map_err(|e| e.to_string())?
    {
        return Err(
            "This workspace changed. Reopen the browser chooser to review its tabs.".into(),
        );
    }
    use crate::firefox::{Browser, BrowserKind};
    let kind = item
        .browser
        .as_ref()
        .map(|browser| browser.kind)
        .or_else(|| {
            [BrowserKind::Firefox, BrowserKind::Chromium]
                .into_iter()
                .find(|kind| crate::browser_bridge::is_browser_kind(item, *kind))
        })
        .ok_or("This window is no longer a browser.")?;
    let mut updated = item.browser.clone().unwrap_or(Browser {
        kind,
        active_tab: 1,
        ..Default::default()
    });
    match target.mode {
        SavedBrowserMode::Replace => {
            updated.tabs = source.tabs.clone();
            updated.active_tab = source.active_tab;
        }
        SavedBrowserMode::Append => {
            let selected = updated
                .tabs
                .get(updated.active_tab.saturating_sub(1))
                .or_else(|| source.tabs.get(source.active_tab.saturating_sub(1)))
                .map(|tab| tab.url.clone());
            let mut seen = HashSet::new();
            updated.tabs = updated
                .tabs
                .iter()
                .chain(&source.tabs)
                .filter(|tab| seen.insert(tab.url.clone()))
                .cloned()
                .collect();
            updated.active_tab = selected
                .and_then(|url| updated.tabs.iter().position(|tab| tab.url == url))
                .map_or(1, |index| index + 1);
        }
    }
    updated.validate()?;
    item.browser = Some(updated);
    item.capture_note.clear();
    Ok(())
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
                    || w.class_name.len() > 1024
                    || w.class_name.contains('\0')
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
    load_store(app, "workspaces.json")
}

pub(crate) fn load_saved_browsers(app: &AppHandle) -> Result<WorkspaceStore, String> {
    load_store(app, "saved-browsers.json")
}

pub(crate) fn edit_saved_browser(
    store: &mut WorkspaceStore,
    expected: &Workspace,
    name: String,
    tabs: Vec<crate::firefox::Tab>,
    active_tab: usize,
) -> Result<(), String> {
    let mut updated = store.clone();
    let profile = updated
        .profiles
        .iter_mut()
        .find(|profile| profile.id == expected.id)
        .ok_or("This saved browser no longer exists.")?;
    if serde_json::to_value(&*profile).map_err(|error| error.to_string())?
        != serde_json::to_value(expected).map_err(|error| error.to_string())?
    {
        return Err("This saved browser changed. Reopen it to keep the latest tabs.".into());
    }
    let [item] = profile.items.as_mut_slice() else {
        return Err("This saved browser cannot be edited.".into());
    };
    let browser = item
        .browser
        .as_mut()
        .ok_or("This saved browser cannot be edited.")?;
    profile.name = name.trim().to_string();
    browser.tabs = tabs;
    browser.active_tab = active_tab;
    updated.validate()?;
    *store = updated;
    Ok(())
}

fn load_store(app: &AppHandle, filename: &str) -> Result<WorkspaceStore, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join(filename);
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
    save_store(app, "workspaces.json", store)
}

pub(crate) fn save_saved_browsers(app: &AppHandle, store: &WorkspaceStore) -> Result<(), String> {
    save_store(app, "saved-browsers.json", store)
}

fn save_store(app: &AppHandle, filename: &str, store: &WorkspaceStore) -> Result<(), String> {
    store.validate()?;
    // Never replace an unreadable existing store through an incidental UI save.
    load_store(app, filename)?;
    let directory = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let temporary = directory.join(format!("{filename}.tmp"));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temporary, directory.join(filename)).map_err(|e| e.to_string())
}

pub(crate) fn enrich_capture(app: &AppHandle, profile: &mut Workspace) -> Result<(), String> {
    let bridge = app.state::<crate::browser_bridge::Bridge>();
    let needs_browser = crate::browser_bridge::has_browser(&profile.items);
    let snapshots = std::thread::scope(|scope| {
        let snapshots = scope.spawn(|| {
            if needs_browser {
                bridge.capture_snapshots()
            } else {
                crate::browser_bridge::CapturedSnapshots::default()
            }
        });
        crate::firefox::enrich(&mut profile.items);
        crate::terminal::enrich(&mut profile.items);
        snapshots
            .join()
            .map_err(|_| "Could not capture browser tabs.".to_string())
    })?;
    snapshots.enrich(&mut profile.items);
    Ok(())
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

/// Resolve import-only launch metadata for the review draft; never saves it.
pub fn prepare_import(profile: Workspace) -> Result<Workspace, String> {
    WorkspaceStore {
        version: 1,
        profiles: vec![profile.clone()],
    }
    .validate()?;
    #[cfg(windows)]
    let mut profile = profile;
    #[cfg(windows)]
    if profile.platform == "windows" {
        for item in &mut profile.items {
            if item.launch.kind == LaunchKind::PackagedApp && item.launch.program.is_empty() {
                match crate::windows_apps::resolve_legacy_path(&item.window.path) {
                    Ok(id) => {
                        item.window.desktop_id = id.clone();
                        item.launch.program = id;
                        item.capture_note.push_str(" Registered packaged application resolved; review its activation ID below.");
                    }
                    Err(error) => {
                        item.capture_note.push_str(&format!(" Package resolution: {error} Recapture the app or enter its AUMID below."));
                    }
                }
            }
        }
    }
    Ok(profile)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub label: String,
    pub restored: bool,
    pub launched: bool,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip)]
    pub target: Option<(String, u32)>,
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
    desktop: Option<&str>,
    active_targets: &[Option<(String, u32)>],
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
    let mut focus_profiles_requested = false;
    for (index, item) in profile.items.iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        let mut launched = false;
        let mut warning = None;
        let mut target_identity = None;
        let result = (|| {
            check_restore_desktop(app, desktop)?;
            // A window on another virtual desktop does not satisfy this
            // desktop's workspace. Leave it there and open another if needed.
            let mut windows = crate::platform::snapshot_current(app)?;
            let known = if item.launch.new_window {
                None
            } else {
                active_targets
                    .get(index)
                    .and_then(Option::as_ref)
                    .and_then(|(id, pid)| {
                        windows.iter().find(|window| {
                            window.id == *id && window.pid == *pid && !used.contains(id)
                        })
                    })
                    .cloned()
            };
            if let Some(terminal) = item.terminal.as_ref().filter(|_| known.is_none()) {
                let all = windows.clone();
                windows.retain(|w| {
                    crate::terminal::kind(w) == Some(terminal.kind)
                        && terminal_capture
                            .as_ref()
                            .is_some_and(|capture| capture.matches(w, &all, terminal))
                });
            }
            if let Some(browser) = item.browser.as_ref().filter(|browser| {
                known.is_none() && browser.kind == crate::firefox::BrowserKind::Firefox
            }) {
                // A known different profile cannot satisfy this workspace. Unknown
                // profile identity stays eligible for review-compatible matching.
                windows.retain(|w| {
                    !crate::firefox::is_firefox(w) || browser_matcher.matches_new_window(w, browser)
                });
                if !item.launch.new_window && !browser.tabs.is_empty() {
                    // Enrich the complete set at once so session windows cannot be
                    // independently assigned to multiple native windows.
                    let candidates: Vec<_> = windows
                        .iter()
                        .filter(|window| {
                            find_match(&item.window, std::slice::from_ref(window), &used).is_some()
                        })
                        .cloned()
                        .collect();
                    let mut observed = capture(candidates, String::new());
                    crate::firefox::enrich(&mut observed.items);
                    app.state::<crate::browser_bridge::Bridge>()
                        .enrich(&mut observed.items);
                    let mut matches = HashSet::new();
                    let mut unknown = HashSet::new();
                    let mut original_differs = false;
                    for window in &windows {
                        if find_match(&item.window, std::slice::from_ref(window), &used).is_none() {
                            continue;
                        }
                        let mut actual = observed
                            .items
                            .iter()
                            .find(|candidate| {
                                candidate.window.id == window.id
                                    && candidate.window.pid == window.pid
                            })
                            .filter(|candidate| candidate.capture_note.is_empty())
                            .and_then(|candidate| candidate.browser.clone())
                            .filter(|candidate| {
                                candidate.kind == browser.kind && !candidate.tabs.is_empty()
                            });
                        if actual.is_none() {
                            // Other desktop windows can make a session ambiguous.
                            // Retry this window alone; Firefox's matcher still
                            // rejects ambiguous saved sessions for that window.
                            let mut single = capture(vec![window.clone()], String::new());
                            crate::firefox::enrich(&mut single.items);
                            app.state::<crate::browser_bridge::Bridge>()
                                .enrich(&mut single.items);
                            actual = single
                                .items
                                .into_iter()
                                .next()
                                .filter(|candidate| candidate.capture_note.is_empty())
                                .and_then(|candidate| candidate.browser)
                                .filter(|candidate| {
                                    candidate.kind == browser.kind && !candidate.tabs.is_empty()
                                });
                        }
                        match actual.as_ref() {
                            Some(actual)
                                if (!browser.profile_path.is_empty()
                                    && !actual.profile_path.is_empty()
                                    && !crate::browser_bridge::same_path(
                                        &browser.profile_path,
                                        &actual.profile_path,
                                    ))
                                    || (browser.profile_path.is_empty()
                                        && !browser.profile_name.is_empty()
                                        && !actual.profile_name.is_empty()
                                        && browser.profile_name != actual.profile_name) =>
                            {
                                if window.id == item.window.id && window.pid == item.window.pid {
                                    original_differs = true;
                                }
                            }
                            Some(actual) if same_browser_urls(actual, browser) => {
                                matches.insert(window.id.clone());
                            }
                            Some(_) => {
                                if window.id == item.window.id && window.pid == item.window.pid {
                                    original_differs = true;
                                }
                            }
                            None => {
                                // Do not reuse an unrelated, unidentifiable
                                // profile merely because it runs Firefox.
                                let same_window =
                                    window.id == item.window.id && window.pid == item.window.pid;
                                if same_window
                                    || (browser.profile_path.is_empty()
                                        && browser.profile_name.is_empty())
                                    || browser_matcher.profile_match(window, browser) == Some(true)
                                {
                                    unknown.insert(window.id.clone());
                                }
                            }
                        }
                    }
                    // A verified change in the original window must not be
                    // hidden by unrelated, unidentifiable Firefox windows.
                    if original_differs {
                        unknown.clear();
                    }
                    let eligible = if !matches.is_empty() {
                        &matches
                    } else {
                        &unknown
                    };
                    if matches.is_empty() && !unknown.is_empty() {
                        warning = Some("An existing Firefox window was reused, but its current tabs could not be verified. Install the optional browser extension for live tab matching.".to_string());
                    }
                    windows.retain(|w| eligible.contains(&w.id));
                }
            }
            let existing = if known.is_some() {
                known
            } else if item.launch.new_window {
                None
            } else {
                find_match(&item.window, &windows, &used).cloned()
            };
            let target = if let Some(window) = existing {
                if let Some(browser) = &item.browser {
                    if browser.kind == crate::firefox::BrowserKind::Chromium
                        && (!browser.tabs.is_empty() || !browser.profile_path.is_empty())
                    {
                        let mut observed = capture(vec![window.clone()], String::new());
                        crate::firefox::enrich(&mut observed.items);
                        app.state::<crate::browser_bridge::Bridge>()
                            .enrich(&mut observed.items);
                        let actual = observed
                            .items
                            .first()
                            .filter(|candidate| candidate.capture_note.is_empty())
                            .and_then(|candidate| candidate.browser.as_ref());
                        if browser.kind == crate::firefox::BrowserKind::Chromium
                            && !browser.profile_path.is_empty()
                            && !actual.is_some_and(|current| {
                                current.kind == browser.kind
                                    && !current.profile_path.is_empty()
                                    && crate::browser_bridge::same_path(
                                        &current.profile_path,
                                        &browser.profile_path,
                                    )
                            })
                        {
                            warning = Some("An existing browser window was reused, but its profile could not be verified.".into());
                        }
                        let matches = actual.is_some_and(|current| {
                            current.kind == browser.kind && same_browser_tabs(current, browser)
                        });
                        if !browser.tabs.is_empty() && !matches {
                            let message = if browser.kind == crate::firefox::BrowserKind::Firefox {
                                "The existing Firefox window was reused; its tabs were not changed. Review its saved URLs."
                            } else {
                                "The existing browser window was reused; its tabs were not changed. Review its saved URLs."
                            };
                            warning = Some(match warning {
                                Some(ref prior) => format!("{prior} {message}"),
                                None => message.into(),
                            });
                        }
                    }
                }
                window
            } else {
                // Include all preexisting windows, even incompatible profiles.
                let before: HashSet<_> = crate::platform::snapshot_for_restore(app)?
                    .iter()
                    .map(|w| w.id.clone())
                    .collect();
                let commands = if let Some(browser) = &item.browser {
                    let bridge = app.state::<crate::browser_bridge::Bridge>();
                    let mut preserve_order = bridge.supports_tab_focus(browser);
                    if !preserve_order
                        && !focus_profiles_requested
                        && browser.tabs.len() > 1
                        && !browser.profile_path.is_empty()
                    {
                        focus_profiles_requested = bridge.refresh_focus_profiles(cancelled);
                        preserve_order = bridge.supports_tab_focus(browser);
                    }
                    if cancelled.load(Ordering::Relaxed) {
                        return Err("Workspace restore canceled.".into());
                    }
                    browser.launch_commands(&item.launch, preserve_order)?
                } else if let Some(terminal) = &item.terminal {
                    vec![terminal.launch_command(&item.launch)?]
                } else {
                    vec![item.launch.clone()]
                };
                check_restore_desktop(app, desktop)?;
                launch(&commands[0])?;
                launched = true;
                let deadline = Instant::now() + Duration::from_secs(12);
                let new_window = loop {
                    if cancelled.load(Ordering::Relaxed) {
                        return Err("Workspace restore canceled.".into());
                    }
                    let mut windows = crate::platform::snapshot_current(app)?;
                    let excluded: HashSet<_> = if item.launch.new_window
                        || item.browser.is_some()
                        || item.terminal.is_some()
                    {
                        used.union(&before).cloned().collect()
                    } else {
                        used.clone()
                    };
                    if let Some(terminal) = &item.terminal {
                        windows =
                            crate::terminal::matching_new_windows(&windows, &excluded, terminal);
                    }
                    if let Some(browser) = item
                        .browser
                        .as_ref()
                        .filter(|browser| browser.kind == crate::firefox::BrowserKind::Firefox)
                    {
                        windows.retain(|w| {
                            !crate::firefox::is_firefox(w)
                                || browser_matcher.matches_new_window(w, browser)
                        });
                    }
                    if let Some(window) = find_match(&item.window, &windows, &excluded) {
                        break window.clone();
                    }
                    if Instant::now() >= deadline {
                        return Err(
                            "The app started, but no matching window appeared on this desktop within 12 seconds. It may already be open on another desktop."
                                .into(),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(150));
                };
                // If a launcher supplies follow-up commands, direct them to
                // the window it just created. Firefox tabs use one command.
                for command in commands.iter().skip(1) {
                    if cancelled.load(Ordering::Relaxed) {
                        return Err("Workspace restore canceled.".into());
                    }
                    crate::platform::focus_window(app, &new_window)?;
                    launch(command)?;
                }
                new_window
            };
            check_restore_desktop(app, desktop)?;
            used.insert(target.id.clone());
            crate::platform::restore_window(app, &target, &item.window)?;
            target_identity = Some((target.id, target.pid));
            Ok(())
        })();
        results.push(RestoreResult {
            label: item.label.clone(),
            restored: result.is_ok(),
            launched,
            error: result.err(),
            warning,
            target: target_identity,
        });
    }
    Ok(results)
}

fn check_restore_desktop(app: &AppHandle, expected: Option<&str>) -> Result<(), String> {
    if let Some(expected) = expected {
        if crate::platform::current_desktop_key(app)? != expected {
            return Err("The desktop changed while opening this workspace. Return to the intended desktop and try again.".into());
        }
    }
    Ok(())
}

fn same_browser_tabs(current: &crate::firefox::Browser, saved: &crate::firefox::Browser) -> bool {
    current.tabs.len() == saved.tabs.len()
        && current
            .tabs
            .iter()
            .zip(&saved.tabs)
            .all(|(a, b)| a.url == b.url)
}

fn same_browser_urls(current: &crate::firefox::Browser, saved: &crate::firefox::Browser) -> bool {
    let mut current_urls: Vec<_> = current.tabs.iter().map(|tab| tab.url.as_str()).collect();
    let mut saved_urls: Vec<_> = saved.tabs.iter().map(|tab| tab.url.as_str()).collect();
    current_urls.sort_unstable();
    saved_urls.sort_unstable();
    current_urls == saved_urls
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
    #[test]
    fn browser_tab_matching_compares_url_multisets() {
        let tab = |url: &str| crate::firefox::Tab {
            url: url.into(),
            title: String::new(),
        };
        let saved = crate::firefox::Browser {
            tabs: vec![tab("https://example.test/a"), tab("https://example.test/b")],
            active_tab: 2,
            ..Default::default()
        };
        let mut current = saved.clone();
        assert!(same_browser_urls(&current, &saved));
        current.active_tab = 1;
        assert!(same_browser_urls(&current, &saved));
        current.active_tab = 2;
        current.tabs.swap(0, 1);
        assert!(same_browser_urls(&current, &saved));
        current.tabs[0] = tab("https://example.test/a");
        current.tabs[1] = tab("https://example.test/a");
        assert!(
            !same_browser_urls(&current, &saved),
            "duplicate counts must match"
        );
        current.tabs.pop();
        assert!(!same_browser_urls(&current, &saved));
    }
    fn window(id: &str, title: &str) -> WindowInfo {
        WindowInfo {
            id: id.into(),
            pid: 123,
            title: title.into(),
            class_name: String::new(),
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

    fn saved_browser_item(
        id: &str,
        kind: crate::firefox::BrowserKind,
        urls: &[&str],
    ) -> WorkspaceItem {
        let mut info = window(id, id);
        info.app_id = if kind == crate::firefox::BrowserKind::Firefox {
            "firefox.exe"
        } else {
            "chrome.exe"
        }
        .into();
        let mut item = capture(vec![info], "Fixture".into()).items.remove(0);
        item.browser = Some(crate::firefox::Browser {
            kind,
            profile_path: format!("{id}-profile"),
            active_tab: 1,
            tabs: urls
                .iter()
                .map(|url| crate::firefox::Tab {
                    url: (*url).into(),
                    title: String::new(),
                })
                .collect(),
            ..Default::default()
        });
        item
    }

    #[test]
    fn editing_a_saved_browser_preserves_identity_and_rejects_stale_or_invalid_edits() {
        use crate::firefox::{BrowserKind, Tab};
        let mut profile = capture(vec![], "Research".into());
        profile.items.push(saved_browser_item(
            "source",
            BrowserKind::Firefox,
            &["https://old.test/"],
        ));
        let expected = profile.clone();
        let mut store = WorkspaceStore {
            version: 1,
            profiles: vec![profile],
        };
        edit_saved_browser(
            &mut store,
            &expected,
            " Updated ".into(),
            vec![Tab {
                url: "https://new.test/".into(),
                title: "New".into(),
            }],
            1,
        )
        .unwrap();
        assert_eq!(store.profiles[0].name, "Updated");
        assert_eq!(
            store.profiles[0].items[0]
                .browser
                .as_ref()
                .unwrap()
                .profile_path,
            "source-profile"
        );
        assert_eq!(
            store.profiles[0].items[0].window.id,
            expected.items[0].window.id
        );
        let after = serde_json::to_value(&store).unwrap();
        assert!(edit_saved_browser(&mut store, &expected, "Stale".into(), vec![], 1).is_err());
        assert_eq!(serde_json::to_value(&store).unwrap(), after);
        let current = store.profiles[0].clone();
        assert!(edit_saved_browser(&mut store, &current, " ".into(), vec![], 1).is_err());
        assert_eq!(serde_json::to_value(&store).unwrap(), after);
        assert!(edit_saved_browser(
            &mut store,
            &current,
            "Valid name".into(),
            vec![Tab {
                url: "https://bad.test/\nextra".into(),
                title: String::new()
            }],
            1,
        )
        .is_err());
        assert_eq!(serde_json::to_value(&store).unwrap(), after);
    }

    #[test]
    fn replacing_saved_browser_tabs_preserves_the_target_window_and_profile() {
        use crate::firefox::BrowserKind;
        let source = saved_browser_item("source", BrowserKind::Chromium, &["https://new.test/"]);
        let target = saved_browser_item("target", BrowserKind::Firefox, &["https://old.test/"]);
        let mut workspace = capture(vec![], "Fixture".into());
        workspace.items.push(target.clone());
        apply_saved_browser(
            &mut workspace,
            &source,
            Some(SavedBrowserTarget {
                index: 0,
                expected: target.clone(),
                mode: SavedBrowserMode::Replace,
            }),
        )
        .unwrap();
        let result = &workspace.items[0];
        let browser = result.browser.as_ref().unwrap();
        assert_eq!(browser.kind, BrowserKind::Firefox);
        assert_eq!(browser.profile_path, "target-profile");
        assert_eq!(browser.tabs[0].url, "https://new.test/");
        assert_eq!(result.window.id, target.window.id);
        assert_eq!(
            serde_json::to_value(&result.launch).unwrap(),
            serde_json::to_value(&target.launch).unwrap()
        );
        assert_eq!(
            source.browser.as_ref().unwrap().tabs[0].url,
            "https://new.test/"
        );
    }

    #[test]
    fn adding_tabs_to_a_firefox_window_without_saved_tabs_uses_its_browser_kind() {
        use crate::firefox::BrowserKind;
        let source = saved_browser_item("source", BrowserKind::Chromium, &["https://new.test/"]);
        let mut target = saved_browser_item("target", BrowserKind::Firefox, &[]);
        target.window.path.clear();
        target.browser = None;
        let mut workspace = capture(vec![], "Fixture".into());
        workspace.items.push(target.clone());
        apply_saved_browser(
            &mut workspace,
            &source,
            Some(SavedBrowserTarget {
                index: 0,
                expected: target,
                mode: SavedBrowserMode::Replace,
            }),
        )
        .unwrap();
        let browser = workspace.items[0].browser.as_ref().unwrap();
        assert_eq!(browser.kind, BrowserKind::Firefox);
        assert_eq!(browser.tabs[0].url, "https://new.test/");
    }

    #[test]
    fn appending_saved_browser_tabs_deduplicates_only_identical_urls() {
        use crate::firefox::BrowserKind;
        let source = saved_browser_item(
            "source",
            BrowserKind::Chromium,
            &[
                "https://example.test/",
                "https://example.test/?q=1",
                "https://example.test/#section",
            ],
        );
        let mut target = saved_browser_item(
            "target",
            BrowserKind::Firefox,
            &[
                "https://example.test/",
                "https://example.test/",
                "http://example.test/",
            ],
        );
        target.browser.as_mut().unwrap().active_tab = 3;
        let mut workspace = capture(vec![], "Fixture".into());
        workspace.items.push(target.clone());
        apply_saved_browser(
            &mut workspace,
            &source,
            Some(SavedBrowserTarget {
                index: 0,
                expected: target,
                mode: SavedBrowserMode::Append,
            }),
        )
        .unwrap();
        let browser = workspace.items[0].browser.as_ref().unwrap();
        assert_eq!(
            browser
                .tabs
                .iter()
                .map(|tab| tab.url.as_str())
                .collect::<Vec<_>>(),
            vec![
                "https://example.test/",
                "http://example.test/",
                "https://example.test/?q=1",
                "https://example.test/#section"
            ]
        );
        assert_eq!(
            browser.active_tab, 2,
            "the existing selected tab stays selected"
        );
        assert_eq!(browser.profile_path, "target-profile");
    }

    #[test]
    fn saved_browser_update_rejects_a_target_changed_since_review() {
        use crate::firefox::BrowserKind;
        let source = saved_browser_item("source", BrowserKind::Chromium, &["https://new.test/"]);
        let target = saved_browser_item("target", BrowserKind::Firefox, &["https://old.test/"]);
        let mut workspace = capture(vec![], "Fixture".into());
        workspace.items.push(target.clone());
        workspace.items[0].browser.as_mut().unwrap().tabs[0].url = "https://live.test/".into();
        let error = apply_saved_browser(
            &mut workspace,
            &source,
            Some(SavedBrowserTarget {
                index: 0,
                expected: target,
                mode: SavedBrowserMode::Replace,
            }),
        )
        .unwrap_err();
        assert!(error.contains("changed"));
        assert_eq!(
            workspace.items[0].browser.as_ref().unwrap().tabs[0].url,
            "https://live.test/"
        );
    }

    #[test]
    fn saved_browser_refresh_requires_the_same_profile_and_nonempty_tabs() {
        use crate::firefox::BrowserKind;
        let saved = saved_browser_item("source", BrowserKind::Firefox, &["https://old.test/"])
            .browser
            .unwrap();
        let mut current = saved.clone();
        current.tabs[0].url = "https://new.test/".into();
        assert_eq!(
            refreshed_saved_browser(&saved, &current).unwrap().tabs[0].url,
            "https://new.test/"
        );
        current.profile_path = "different-profile".into();
        assert!(refreshed_saved_browser(&saved, &current).is_none());
        current.profile_path = saved.profile_path.clone();
        current.tabs.clear();
        assert!(refreshed_saved_browser(&saved, &current).is_none());
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
    fn import_preparation_preserves_explicit_launch_targets_and_rejects_invalid_profiles() {
        let mut profile = capture(vec![window("1", "One")], "Import".into());
        profile.items[0].launch.kind = LaunchKind::PackagedApp;
        profile.items[0].launch.program = "ExplicitFamily!SelectedApp".into();
        let prepared = prepare_import(profile.clone()).unwrap();
        assert_eq!(
            prepared.items[0].launch.program,
            "ExplicitFamily!SelectedApp"
        );
        assert_eq!(prepared.items[0].window.path, profile.items[0].window.path);
        profile.items[0].window.rect.width = 0;
        assert!(prepare_import(profile).unwrap_err().contains("geometry"));
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
