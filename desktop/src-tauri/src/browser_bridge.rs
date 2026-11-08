//! Opt-in, loopback-only bridge for the companion browser extensions.
//! Live snapshots can update only browser windows explicitly associated with a
//! saved destination. Other snapshots stay in memory until requested.
use crate::{
    firefox::{Browser, BrowserKind, Tab},
    workspaces::{RestoreResult, WorkspaceItem},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

const MAX_REQUEST: usize = 4 * 1024 * 1024;
const MAX_HEADER: usize = 16 * 1024;
const SNAPSHOT_LIFETIME: Duration = Duration::from_secs(120);
const IDLE_EXTENSION_WAIT: Duration = Duration::from_secs(70);

// Set this at build time once Mozilla has assigned the public listing URL.
// Until then, the settings screen keeps the temporary Firefox setup available.
const FIREFOX_ADDON_URL: Option<&str> = option_env!("WINDOW_WARP_FIREFOX_ADDON_URL");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSetupOptions {
    developer: bool,
    firefox_store_available: bool,
}

#[tauri::command]
pub fn extension_setup_options() -> ExtensionSetupOptions {
    ExtensionSetupOptions {
        developer: std::env::args_os().any(|arg| arg == "--developer-extensions"),
        firefox_store_available: FIREFOX_ADDON_URL.is_some(),
    }
}

#[tauri::command]
pub fn open_firefox_addon() -> Result<(), String> {
    let url = FIREFOX_ADDON_URL.ok_or("The Firefox add-on listing is not available yet.")?;
    open_addon_url(url).map_err(|error| {
        eprintln!("Could not open Firefox Add-ons: {error}");
        "Could not open Firefox Add-ons. Please try again.".to_string()
    })
}

#[cfg(windows)]
fn open_addon_url(url: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    let wide: Vec<u16> = std::ffi::OsStr::new(url)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            std::ptr::null(),
            wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    } as isize;
    if result <= 32 {
        Err(format!("ShellExecuteW returned {result}"))
    } else {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn open_addon_url(url: &str) -> Result<(), String> {
    gio::AppInfo::launch_default_for_uri(url, None::<&gio::AppLaunchContext>)
        .map_err(|error| error.to_string())
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Config {
    enabled: bool,
    live: bool,
    live_clients: HashMap<String, bool>,
    port: u16,
    token: String,
    active: HashMap<String, Active>,
    opened: HashMap<String, Active>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Active {
    id: String,
    targets: Vec<Option<(String, u32)>>,
    saved: Vec<(String, u32, String, String)>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionWindow {
    #[serde(default)]
    id: i64,
    title: String,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<i32>,
    height: Option<i32>,
    active_tab: usize,
    tabs: Vec<Tab>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    token: String,
    action: String,
    browser: BrowserKind,
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    installation_id: String,
    #[serde(default)]
    profile_path: String,
    #[serde(default)]
    profile_name: String,
    #[serde(default)]
    windows: Vec<ExtensionWindow>,
    #[serde(default)]
    request_id: String,
    #[serde(default)]
    live: bool,
    #[serde(default)]
    explicit: bool,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    item_index: Option<usize>,
    #[serde(default)]
    window_id: Option<i64>,
    #[serde(default)]
    name: String,
    #[serde(default)]
    saved_browser_id: String,
    #[serde(default)]
    expected_revision: String,
    #[serde(default)]
    operation_id: String,
    #[serde(default)]
    make_current: Option<bool>,
    #[serde(default)]
    supports_focus: bool,
}
#[derive(Clone)]
struct Snapshot {
    client_id: String,
    browser: BrowserKind,
    profile_path: String,
    profile_name: String,
    windows: Vec<ExtensionWindow>,
    updated: Instant,
}
#[derive(Default)]
pub(crate) struct CapturedSnapshots(Vec<Snapshot>);
struct Connection {
    client_id: String,
    browser: BrowserKind,
    updated: Instant,
    supports_focus: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FocusCommand {
    id: String,
    window_id: i64,
    tab_index: usize,
    expected_urls: Vec<String>,
}
#[derive(Clone, Debug)]
struct PreparedExtension {
    installation_id: String,
    version: String,
}
#[derive(Default)]
struct State {
    config: Config,
    running: Option<Arc<AtomicBool>>,
    worker: Option<std::thread::JoinHandle<()>>,
    snapshots: Vec<Snapshot>,
    connections: Vec<Connection>,
    request_id: String,
    awaiting: HashSet<String>,
    requested: HashSet<String>,
    prepared: HashMap<String, PreparedExtension>,
    extension_update_error: Option<String>,
    live_destinations: HashMap<String, HashMap<i64, (String, String)>>,
    extension_operations: HashMap<String, (String, Option<serde_json::Value>)>,
    focus_pending: HashMap<String, Vec<FocusCommand>>,
    focus_results: HashMap<String, bool>,
}
#[derive(Default)]
pub struct Bridge {
    state: Arc<Mutex<State>>,
    snapshot_request: Mutex<()>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    enabled: bool,
    live: bool,
    pairing_code: String,
    chromium_connected: bool,
    firefox_connected: bool,
    extension_update_error: Option<String>,
}

impl Bridge {
    pub fn supports_tab_focus(&self, browser: &Browser) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state
                .running
                .as_ref()
                .is_some_and(|running| running.load(Ordering::SeqCst))
                && state.snapshots.iter().any(|snapshot| {
                    snapshot.browser == browser.kind
                        && snapshot.updated.elapsed() < SNAPSHOT_LIFETIME
                        && !browser.profile_path.is_empty()
                        && !snapshot.profile_path.is_empty()
                        && same_path(&browser.profile_path, &snapshot.profile_path)
                        && state.connections.iter().any(|connection| {
                            connection.client_id == snapshot.client_id
                                && connection.browser == browser.kind
                                && connection.supports_focus
                                && connection.updated.elapsed() < Duration::from_secs(15)
                        })
                })
        })
    }

    pub fn refresh_focus_profiles(&self, cancelled: &AtomicBool) -> bool {
        let connected = self.state.lock().ok().is_some_and(|state| {
            state
                .running
                .as_ref()
                .is_some_and(|running| running.load(Ordering::SeqCst))
                && state.connections.iter().any(|connection| {
                    connection.supports_focus
                        && connection.updated.elapsed() < Duration::from_secs(15)
                })
        });
        if !connected || cancelled.load(Ordering::Relaxed) {
            return false;
        }
        self.capture_focus_snapshots(cancelled);
        true
    }

    pub fn focus_restored_tabs(
        &self,
        app: &AppHandle,
        workspace: &crate::workspaces::Workspace,
        results: &[RestoreResult],
        cancelled: &AtomicBool,
    ) -> Vec<usize> {
        let requested: Vec<_> = workspace
            .items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                (results.get(index).is_some_and(|result| result.restored)
                    && item
                        .browser
                        .as_ref()
                        .is_some_and(|browser| browser.tabs.len() > 1))
                .then_some(index)
            })
            .collect();
        if requested.is_empty() || cancelled.load(Ordering::Relaxed) {
            return Vec::new();
        }
        let capable: HashSet<_> = self
            .state
            .lock()
            .ok()
            .map(|state| {
                state
                    .connections
                    .iter()
                    .filter(|connection| {
                        connection.supports_focus
                            && connection.updated.elapsed() < Duration::from_secs(15)
                    })
                    .map(|connection| connection.client_id.clone())
                    .collect()
            })
            .unwrap_or_default();
        if capable.is_empty() {
            return requested;
        }
        // Include competing browser windows on other virtual desktops; the
        // extension can report those windows even though restore targets only
        // the current desktop.
        let current = match crate::platform::snapshot_for_restore(app) {
            Ok(current) => current,
            Err(_) => return requested,
        };
        let snapshots = self.capture_focus_snapshots(cancelled);
        if cancelled.load(Ordering::Relaxed) {
            return Vec::new();
        }
        let plans = focus_plans(workspace, results, &current, &snapshots, &capable);
        if cancelled.load(Ordering::Relaxed) {
            return Vec::new();
        }
        let mut waiting = Vec::new();
        if let Ok(mut state) = self.state.lock() {
            for (index, client, command) in plans {
                waiting.push((index, client.clone(), command.id.clone()));
                state.focus_pending.entry(client).or_default().push(command);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(8);
        while !waiting.is_empty() && Instant::now() < deadline && !cancelled.load(Ordering::Relaxed)
        {
            let finished = self.state.lock().ok().is_none_or(|state| {
                waiting
                    .iter()
                    .all(|(_, _, id)| state.focus_results.contains_key(id))
            });
            if finished {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let mut succeeded = HashSet::new();
        if let Ok(mut state) = self.state.lock() {
            for (index, client, id) in waiting {
                if state.focus_results.remove(&id) == Some(true) {
                    succeeded.insert(index);
                }
                if let Some(commands) = state.focus_pending.get_mut(&client) {
                    commands.retain(|command| command.id != id);
                }
            }
            state
                .focus_pending
                .retain(|_, commands| !commands.is_empty());
        }
        if cancelled.load(Ordering::Relaxed) {
            return Vec::new();
        }
        requested
            .into_iter()
            .filter(|index| !succeeded.contains(index))
            .collect()
    }

    pub fn set_active(
        &self,
        app: &AppHandle,
        desktop: String,
        workspace: &crate::workspaces::Workspace,
        results: &[RestoreResult],
    ) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        state
            .config
            .active
            .retain(|_, entry| entry.id != workspace.id);
        let active = Active {
            id: workspace.id.clone(),
            targets: results.iter().map(|r| r.target.clone()).collect(),
            saved: workspace
                .items
                .iter()
                .map(|i| {
                    (
                        i.window.id.clone(),
                        i.window.pid,
                        i.window.app_id.clone(),
                        i.window.desktop_id.clone(),
                    )
                })
                .collect(),
        };
        remember_opened(&mut state.config, active.clone());
        state.config.active.insert(desktop, active);
        write_config(app, &state.config)
    }

    pub fn set_saved_browser_opened(
        &self,
        app: &AppHandle,
        workspace: &crate::workspaces::Workspace,
        results: &[RestoreResult],
    ) -> Result<(), String> {
        let active = Active {
            id: workspace.id.clone(),
            targets: results.iter().map(|result| result.target.clone()).collect(),
            saved: workspace.items.iter().map(saved_window_key).collect(),
        };
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        remember_opened(&mut state.config, active);
        write_config(app, &state.config)
    }

    // A newly captured workspace can own its still-open browser immediately.
    // Do not take a browser already owned by another opened workspace.
    pub fn link_new_captures(
        &self,
        app: &AppHandle,
        profiles: &[crate::workspaces::Workspace],
    ) -> Result<(), String> {
        if profiles.is_empty() {
            return Ok(());
        }
        let windows = crate::platform::snapshot(app)?;
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        let mut changed = false;
        for profile in profiles {
            let targets: Vec<_> = profile
                .items
                .iter()
                .map(|item| {
                    let identity = (item.window.id.clone(), item.window.pid);
                    let owned = state.config.opened.values().any(|owner| {
                        owner
                            .targets
                            .iter()
                            .flatten()
                            .any(|target| target == &identity)
                    });
                    (has_browser(std::slice::from_ref(item))
                        && !owned
                        && item.window.pid != 0
                        && windows.iter().any(|window| {
                            window.id == identity.0
                                && window.pid == identity.1
                                && window.app_id.eq_ignore_ascii_case(&item.window.app_id)
                        }))
                    .then_some(identity)
                })
                .collect();
            if targets.iter().any(Option::is_some) {
                remember_opened(
                    &mut state.config,
                    Active {
                        id: profile.id.clone(),
                        targets,
                        saved: profile.items.iter().map(saved_window_key).collect(),
                    },
                );
                changed = true;
            }
        }
        if changed {
            write_config(app, &state.config)?;
        }
        Ok(())
    }
    fn request_snapshots(&self, timeout: Duration, discover: bool) {
        self.request_snapshots_cancellable(timeout, discover, None);
    }

    fn request_snapshots_cancellable(
        &self,
        timeout: Duration,
        discover: bool,
        cancelled: Option<&AtomicBool>,
    ) {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return;
        }
        let (request_id, discovery_until) = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if !state
                .running
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::SeqCst))
            {
                return;
            }
            state.awaiting = state
                .connections
                .iter()
                .filter(|c| c.updated.elapsed() < Duration::from_secs(15))
                .map(|c| c.client_id.clone())
                .collect();
            state.snapshots.clear();
            if state.awaiting.is_empty() && !discover {
                return;
            }
            // A browser background process may wake after the request starts.
            // Give newly started clients the same explicit request, while
            // never requesting tabs merely because a client connects.
            // Keep the original short discovery window for additional browser
            // profiles; after that, return as soon as an idle client responds.
            let discovery_until = (discover && state.awaiting.is_empty())
                .then(|| Instant::now() + timeout.min(Duration::from_secs(8)));
            state.requested = state.awaiting.clone();
            state.request_id = uuid::Uuid::new_v4().simple().to_string();
            (state.request_id.clone(), discovery_until)
        };
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
            let Ok(state) = self.state.lock() else {
                return;
            };
            if state.request_id != request_id
                || !state
                    .running
                    .as_ref()
                    .is_some_and(|flag| flag.load(Ordering::SeqCst))
            {
                break;
            }
            if state.awaiting.is_empty()
                && (!discover
                    || (!state.snapshots.is_empty()
                        && discovery_until.is_none_or(|until| Instant::now() >= until)))
            {
                break;
            }
        }
        if let Ok(mut state) = self.state.lock() {
            if state.request_id == request_id {
                state.request_id.clear();
                state.awaiting.clear();
                state.requested.clear();
            }
        }
    }
    fn capture_focus_snapshots(&self, cancelled: &AtomicBool) -> CapturedSnapshots {
        let deadline = Instant::now() + Duration::from_secs(8);
        let _guard = loop {
            if cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline {
                return CapturedSnapshots::default();
            }
            match self.snapshot_request.try_lock() {
                Ok(guard) => break guard,
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return CapturedSnapshots::default();
                }
            }
        };
        let timeout = self
            .state
            .lock()
            .ok()
            .map(|state| snapshot_wait(&state, false))
            .unwrap_or(Duration::from_secs(8))
            .min(deadline.saturating_duration_since(Instant::now()));
        self.request_snapshots_cancellable(timeout, false, Some(cancelled));
        CapturedSnapshots(
            self.state
                .lock()
                .map(|state| state.snapshots.clone())
                .unwrap_or_default(),
        )
    }

    pub fn capture_snapshots(&self) -> CapturedSnapshots {
        self.capture_snapshots_with_discovery(false, false)
    }
    fn capture_snapshots_with_discovery(
        &self,
        discover: bool,
        wait_for_idle: bool,
    ) -> CapturedSnapshots {
        let Ok(_guard) = self.snapshot_request.lock() else {
            return CapturedSnapshots::default();
        };
        // Older development add-ons can sleep for up to a minute. Keep an
        // explicit request alive for them, including immediately after Warp
        // restarts, and return as soon as a snapshot arrives. A normal
        // workspace capture never waits for a sleeping extension.
        let timeout = self
            .state
            .lock()
            .ok()
            .map(|state| snapshot_wait(&state, discover && wait_for_idle))
            .unwrap_or(Duration::from_secs(8));
        self.request_snapshots(timeout, discover);
        CapturedSnapshots(
            self.state
                .lock()
                .map(|state| state.snapshots.clone())
                .unwrap_or_default(),
        )
    }
    pub fn enrich(&self, items: &mut [WorkspaceItem]) {
        let snapshots = self
            .state
            .lock()
            .map(|state| state.snapshots.clone())
            .unwrap_or_default();
        CapturedSnapshots(snapshots).enrich(items);
    }
}

fn saved_window_key(item: &WorkspaceItem) -> (String, u32, String, String) {
    (
        item.window.id.clone(),
        item.window.pid,
        item.window.app_id.clone(),
        item.window.desktop_id.clone(),
    )
}

// One live native window belongs to the most recently opened or explicitly
// linked destination. Other windows in its old workspace keep their ownership.
fn remember_opened(config: &mut Config, active: Active) {
    let claimed: HashSet<_> = active.targets.iter().flatten().cloned().collect();
    for previous in config
        .opened
        .values_mut()
        .filter(|entry| entry.id != active.id)
    {
        for target in &mut previous.targets {
            if target
                .as_ref()
                .is_some_and(|identity| claimed.contains(identity))
            {
                *target = None;
            }
        }
    }
    config.opened.insert(active.id.clone(), active);
}

fn snapshot_wait(state: &State, discover: bool) -> Duration {
    if discover
        && (!state.prepared.is_empty()
            || state
                .connections
                .iter()
                .any(|client| client.updated.elapsed() < Duration::from_secs(90)))
    {
        IDLE_EXTENSION_WAIT
    } else {
        Duration::from_secs(8)
    }
}

// Keep a desktop's explicitly opened workspace while any of its windows are
// still there. If windows move, recognize a single previously opened workspace
// on the new desktop; competing workspace identities require a fresh choice.
fn active_on_desktop<'a>(
    active: &'a HashMap<String, Active>,
    desktop: &str,
    windows: &[crate::workspaces::WindowInfo],
) -> Option<&'a Active> {
    let count = |entry: &Active| {
        entry
            .targets
            .iter()
            .flatten()
            .filter(|(id, pid)| {
                windows
                    .iter()
                    .any(|window| window.id == *id && window.pid == *pid)
            })
            .count()
    };
    if let Some(entry) = active.get(desktop).filter(|entry| count(entry) > 0) {
        return Some(entry);
    }
    let mut selected: Option<(&Active, usize)> = None;
    for entry in active.values() {
        let matches = count(entry);
        if matches == 0 {
            continue;
        }
        if selected.is_some_and(|(other, _)| other.id != entry.id) {
            return None;
        }
        if selected.is_none_or(|(_, previous)| matches > previous) {
            selected = Some((entry, matches));
        }
    }
    selected.map(|(entry, _)| entry)
}

#[tauri::command]
pub fn current_desktop_workspace(app: AppHandle) -> Result<Option<String>, String> {
    let desktop = crate::platform::current_desktop_key(&app)?;
    let windows = crate::platform::snapshot_current(&app)?;
    let bridge = app.state::<Bridge>();
    let state = bridge.state.lock().map_err(|e| e.to_string())?;
    Ok(active_on_desktop(&state.config.active, &desktop, &windows).map(|active| active.id.clone()))
}

impl CapturedSnapshots {
    pub fn enrich(&self, items: &mut [WorkspaceItem]) -> Vec<usize> {
        let snapshots = &self.0;
        let mut proposals: Vec<Vec<(usize, usize)>> = vec![Vec::new(); items.len()];
        for (snapshot_index, snapshot) in snapshots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.updated.elapsed() < SNAPSHOT_LIFETIME)
        {
            for (item_index, window_index) in match_snapshot(items, snapshot) {
                proposals[item_index].push((snapshot_index, window_index));
            }
        }
        let mut matched = Vec::new();
        for (index, choices) in proposals.into_iter().enumerate() {
            if let [(snapshot_index, window_index)] = choices.as_slice() {
                if assign_browser(
                    &mut items[index],
                    &snapshots[*snapshot_index],
                    &snapshots[*snapshot_index].windows[*window_index],
                    false,
                ) {
                    matched.push(index);
                }
            }
        }
        matched
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("browser-bridge.json"))
}
fn read_config(app: &AppHandle) -> Config {
    let mut config: Config = config_path(app)
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    // Older versions remembered only the last workspace on each desktop.
    if config.opened.is_empty() {
        for active in config.active.values() {
            config.opened.insert(active.id.clone(), active.clone());
        }
    }
    config
}
fn write_config(app: &AppHandle, config: &Config) -> Result<(), String> {
    let path = config_path(app)?;
    fs::create_dir_all(
        path.parent()
            .ok_or("Missing application settings directory.")?,
    )
    .map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(config).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, bytes).map_err(|e| e.to_string())
    }
}
fn info(state: &State) -> BridgeInfo {
    let enabled = state
        .running
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::SeqCst));
    let connected = |kind| {
        enabled
            && state.connections.iter().any(|client| {
                client.browser == kind && client.updated.elapsed() < Duration::from_secs(90)
            })
    };
    BridgeInfo {
        enabled,
        live: enabled && state.config.live,
        pairing_code: if enabled {
            format!("{}:{}", state.config.port, state.config.token)
        } else {
            String::new()
        },
        chromium_connected: connected(BrowserKind::Chromium),
        firefox_connected: connected(BrowserKind::Firefox),
        extension_update_error: state.extension_update_error.clone(),
    }
}
#[tauri::command]
pub fn bridge_status(app: AppHandle) -> Result<BridgeInfo, String> {
    let bridge = app.state::<Bridge>();
    let state = bridge.state.lock().map_err(|e| e.to_string())?;
    Ok(info(&state))
}
#[tauri::command]
pub fn browser_profiles(browser: BrowserKind) -> Vec<serde_json::Value> {
    profiles(browser)
}
#[tauri::command]
pub async fn current_browser_tabs(
    app: AppHandle,
    window_id: String,
    pid: u32,
) -> Result<Option<Browser>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bridge = app.state::<Bridge>();
        let snapshots = bridge.capture_snapshots_with_discovery(true, false);
        let snapshot = crate::platform::desktop_snapshot(&app)?;
        let targets = {
            let state = bridge.state.lock().map_err(|e| e.to_string())?;
            let mut targets = HashSet::from([(window_id.clone(), pid)]);
            for active in state
                .config
                .active
                .values()
                .chain(state.config.opened.values())
            {
                for (index, _) in active
                    .saved
                    .iter()
                    .enumerate()
                    .filter(|(_, saved)| saved.0 == window_id && saved.1 == pid)
                {
                    if let Some(Some(target)) = active.targets.get(index) {
                        targets.insert(target.clone());
                    }
                }
            }
            targets
        };
        let matches: Vec<_> = snapshot
            .windows
            .iter()
            .filter(|entry| targets.contains(&(entry.window.id.clone(), entry.window.pid)))
            .collect();
        if matches.len() != 1 {
            return Ok(None);
        }
        let target = (matches[0].window.id.clone(), matches[0].window.pid);
        let mut captured = crate::workspaces::capture(
            snapshot
                .windows
                .into_iter()
                .map(|entry| entry.window)
                .collect(),
            String::new(),
        );
        snapshots.enrich(&mut captured.items);
        Ok(captured
            .items
            .into_iter()
            .find(|item| item.window.id == target.0 && item.window.pid == target.1)
            .and_then(|item| item.browser))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTabUpdate {
    index: usize,
    browser: Browser,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum TabUpdateFailure {
    ExtensionDidNotRespond,
    WindowNotMatched,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTabUpdates {
    updates: Vec<WorkspaceTabUpdate>,
    failure: Option<TabUpdateFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTabUpdate {
    store: crate::workspaces::WorkspaceStore,
    updated: usize,
    unmatched: usize,
    failure: Option<TabUpdateFailure>,
}

fn tab_update_failure(
    workspace: &crate::workspaces::Workspace,
    snapshots: &CapturedSnapshots,
) -> TabUpdateFailure {
    if snapshots.0.iter().any(|snapshot| {
        workspace
            .items
            .iter()
            .any(|item| is_browser_kind(item, snapshot.browser))
    }) {
        TabUpdateFailure::WindowNotMatched
    } else {
        TabUpdateFailure::ExtensionDidNotRespond
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocationSummary {
    id: String,
    name: String,
    current: bool,
    window_count: usize,
    browser_count: usize,
    browser_titles: Vec<String>,
    ambiguous: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLocations {
    workspace_id: String,
    locations: Vec<LocationSummary>,
    failure: Option<TabUpdateFailure>,
}
struct Location {
    summary: LocationSummary,
    targets: HashMap<usize, Vec<(String, u32)>>,
}

// Resolve remembered HWND/PID or KWin window IDs against the compositor's
// current inventory. This is deliberately based on live windows, not on the
// desktop where the workspace was last opened or where Warp is displayed.
fn locations_for_workspace(
    workspace: &crate::workspaces::Workspace,
    active: &HashMap<String, Active>,
    snapshot: &crate::workspaces::DesktopSnapshot,
) -> Vec<Location> {
    locations_for_workspace_with_saved(workspace, active, snapshot, true)
}

fn locations_for_workspace_with_saved(
    workspace: &crate::workspaces::Workspace,
    active: &HashMap<String, Active>,
    snapshot: &crate::workspaces::DesktopSnapshot,
    include_saved: bool,
) -> Vec<Location> {
    locations_for_workspace_cached(
        workspace,
        active,
        snapshot,
        include_saved,
        &mut HashMap::new(),
    )
}

fn locations_for_workspace_cached(
    workspace: &crate::workspaces::Workspace,
    active: &HashMap<String, Active>,
    snapshot: &crate::workspaces::DesktopSnapshot,
    include_saved: bool,
    firefox_paths: &mut HashMap<u32, Option<PathBuf>>,
) -> Vec<Location> {
    let mut identities: Vec<HashSet<(String, u32)>> = workspace
        .items
        .iter()
        .map(|item| {
            let mut ids = HashSet::new();
            if include_saved && !item.window.id.is_empty() && item.window.pid != 0 {
                ids.insert((item.window.id.clone(), item.window.pid));
            }
            ids
        })
        .collect();
    for entry in active.values().filter(|entry| entry.id == workspace.id) {
        for (index, item) in workspace.items.iter().enumerate() {
            if !include_saved && item.launch.new_window {
                continue;
            }
            let key = (
                item.window.id.clone(),
                item.window.pid,
                item.window.app_id.clone(),
                item.window.desktop_id.clone(),
            );
            let mut matching = entry
                .saved
                .iter()
                .enumerate()
                .filter(|(_, saved)| **saved == key);
            if let (Some((old_index, _)), None) = (matching.next(), matching.next()) {
                if let Some(Some(target)) = entry.targets.get(old_index) {
                    identities[index].insert(target.clone());
                }
            }
        }
    }
    let mut grouped: HashMap<String, Location> = HashMap::new();
    for located in &snapshot.windows {
        let identity = (located.window.id.clone(), located.window.pid);
        for (index, item) in workspace.items.iter().enumerate() {
            if !identities[index].contains(&identity)
                || !item
                    .window
                    .app_id
                    .eq_ignore_ascii_case(&located.window.app_id)
            {
                continue;
            }
            // An association can outlive an edit to the saved Firefox profile.
            // Do not reuse or offer to move a window when the owning process
            // proves it belongs to a different profile. Unknown identity keeps
            // the existing review-compatible behavior.
            if let Some(browser) = item.browser.as_ref().filter(|browser| {
                browser.kind == BrowserKind::Firefox && !browser.profile_path.is_empty()
            }) {
                if crate::firefox::is_firefox(&located.window) {
                    let path = firefox_paths.entry(located.window.pid).or_insert_with(|| {
                        crate::firefox::tracked_profile_path(located.window.pid)
                    });
                    if path.as_ref().is_some_and(|path| {
                        crate::firefox::same_tracked_profile(path, &browser.profile_path)
                            == Some(false)
                    }) {
                        continue;
                    }
                }
            }
            for desktop in &located.desktops {
                if desktop.id.is_empty() {
                    continue;
                }
                let current = snapshot
                    .current
                    .as_ref()
                    .is_some_and(|value| value.id == desktop.id);
                let name = if desktop.name.is_empty() {
                    if current {
                        "This desktop"
                    } else {
                        "Another desktop"
                    }
                    .to_string()
                } else {
                    desktop.name.clone()
                };
                let entry = grouped
                    .entry(desktop.id.clone())
                    .or_insert_with(|| Location {
                        summary: LocationSummary {
                            id: desktop.id.clone(),
                            name,
                            current,
                            window_count: 0,
                            browser_count: 0,
                            browser_titles: vec![],
                            ambiguous: false,
                        },
                        targets: HashMap::new(),
                    });
                let targets = entry.targets.entry(index).or_default();
                if !targets.contains(&identity) {
                    targets.push(identity.clone());
                    if is_browser_kind(item, BrowserKind::Firefox)
                        || is_browser_kind(item, BrowserKind::Chromium)
                    {
                        entry
                            .summary
                            .browser_titles
                            .push(located.window.title.clone());
                    }
                }
            }
        }
    }
    let mut result: Vec<_> = grouped.into_values().collect();
    for entry in &mut result {
        entry.summary.window_count = entry.targets.len();
        entry.summary.browser_count = entry
            .targets
            .keys()
            .filter(|&&index| has_browser(std::slice::from_ref(&workspace.items[index])))
            .count();
        entry.summary.ambiguous = entry.targets.iter().any(|(&index, targets)| {
            has_browser(std::slice::from_ref(&workspace.items[index])) && targets.len() > 1
        });
    }
    result.sort_by(|left, right| {
        right
            .summary
            .current
            .cmp(&left.summary.current)
            .then_with(|| left.summary.name.cmp(&right.summary.name))
            .then_with(|| left.summary.id.cmp(&right.summary.id))
    });
    result
}

fn open_workspace_state(
    app: &AppHandle,
    workspace: &crate::workspaces::Workspace,
) -> Result<(crate::workspaces::DesktopSnapshot, Vec<Location>), String> {
    let snapshot = crate::platform::desktop_snapshot(app)?;
    if snapshot.current.is_none() {
        return Err("The current desktop could not be identified.".into());
    }
    let bridge = app.state::<Bridge>();
    let active = bridge
        .state
        .lock()
        .map_err(|e| e.to_string())?
        .config
        .active
        .clone();
    let locations = locations_for_workspace_with_saved(workspace, &active, &snapshot, false);
    Ok((snapshot, locations))
}

fn saved_workspace(app: &AppHandle, id: &str) -> Result<crate::workspaces::Workspace, String> {
    crate::workspaces::load(app)?
        .profiles
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| "Workspace no longer exists.".into())
}

pub fn workspace_active_targets_here(
    app: &AppHandle,
    workspace: &crate::workspaces::Workspace,
) -> Result<Vec<Option<(String, u32)>>, String> {
    let (_, locations) = open_workspace_state(app, workspace)?;
    if locations.iter().any(|location| !location.summary.current) {
        return Err(
            "This workspace has windows on another desktop. Choose Move here or Go there.".into(),
        );
    }
    let mut result = vec![None; workspace.items.len()];
    if let Some(location) = locations.iter().find(|location| location.summary.current) {
        for (&index, targets) in &location.targets {
            if let [target] = targets.as_slice() {
                if location
                    .targets
                    .values()
                    .filter(|other| other.contains(target))
                    .count()
                    == 1
                {
                    result[index] = Some(target.clone());
                }
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn workspace_open_locations(
    app: AppHandle,
    workspace_id: String,
) -> Result<Vec<LocationSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = saved_workspace(&app, &workspace_id)?;
        let (_, locations) = open_workspace_state(&app, &workspace)?;
        Ok(locations
            .into_iter()
            .map(|location| location.summary)
            .collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn workspace_go_to_desktop(
    app: AppHandle,
    workspace_id: String,
    desktop_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = saved_workspace(&app, &workspace_id)?;
        let (_, locations) = open_workspace_state(&app, &workspace)?;
        if !locations
            .iter()
            .any(|location| location.summary.id == desktop_id)
        {
            return Err("Those workspace windows are no longer on that desktop.".into());
        }
        crate::platform::switch_to_desktop(&app, &desktop_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn move_windows_with_rollback(
    windows: &[crate::workspaces::WindowInfo],
    source: &str,
    destination: &str,
    mut check_desktop: impl FnMut() -> Result<(), String>,
    mut move_window: impl FnMut(&crate::workspaces::WindowInfo, &str) -> Result<(), String>,
) -> Result<(), String> {
    let mut attempted = Vec::new();
    for window in windows {
        attempted.push(window);
        if let Err(error) = check_desktop().and_then(|()| move_window(window, destination)) {
            let mut failed_rollback = false;
            for moved in attempted.iter().rev() {
                if move_window(moved, source).is_err() {
                    failed_rollback = true;
                }
            }
            return Err(if failed_rollback {
                format!("{error} Some windows could not be returned; check both desktops.")
            } else {
                format!("{error} The windows were returned to their original desktop.")
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn workspace_move_to_desktop(
    app: AppHandle,
    workspace_id: String,
    desktop_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = saved_workspace(&app, &workspace_id)?;
        let (snapshot, locations) = open_workspace_state(&app, &workspace)?;
        let current = snapshot
            .current
            .as_ref()
            .ok_or("The current desktop could not be identified.")?
            .id
            .clone();
        let source = locations
            .iter()
            .find(|location| location.summary.id == desktop_id && !location.summary.current)
            .ok_or("Those workspace windows are no longer on that desktop.")?;
        let identities: HashSet<_> = source.targets.values().flatten().cloned().collect();
        let windows: Vec<_> = snapshot
            .windows
            .iter()
            .filter(|entry| {
                identities.contains(&(entry.window.id.clone(), entry.window.pid))
                    && entry
                        .desktops
                        .iter()
                        .any(|desktop| desktop.id == desktop_id)
            })
            .map(|entry| entry.window.clone())
            .collect();
        if windows.len() != identities.len() || windows.is_empty() {
            return Err("The workspace windows changed. Try again.".into());
        }
        move_windows_with_rollback(
            &windows,
            &desktop_id,
            &current,
            || {
                crate::platform::current_desktop_key(&app).and_then(|id| {
                    if id != current {
                        return Err(
                            "The current desktop changed while moving the workspace.".into()
                        );
                    }
                    Ok(())
                })
            },
            |window, destination| crate::platform::move_to_desktop(&app, window, destination),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn location_tab_updates(
    workspace: &crate::workspaces::Workspace,
    location: &Location,
    desktop: &crate::workspaces::DesktopSnapshot,
    snapshots: &CapturedSnapshots,
) -> Vec<WorkspaceTabUpdate> {
    // Match browser-extension windows against every native window first. A
    // same-title window on a different desktop must remain a competitor.
    let mut observed: Vec<_> = desktop
        .windows
        .iter()
        .map(|entry| WorkspaceItem {
            label: entry.window.title.clone(),
            window: entry.window.clone(),
            launch: Default::default(),
            browser: None,
            terminal: None,
            capture_note: String::new(),
        })
        .collect();
    // Preserve the saved tabs as matching evidence for the exact native
    // target. Other desktops remain competitors, and a missing snapshot must
    // never be mistaken for a successful update of the saved tabs.
    for (&index, targets) in &location.targets {
        let [target] = targets.as_slice() else {
            continue;
        };
        if location
            .targets
            .values()
            .filter(|other| other.contains(target))
            .count()
            != 1
        {
            continue;
        }
        if let Some(candidate) = observed.iter_mut().find(|candidate| {
            (candidate.window.id.as_str(), candidate.window.pid) == (target.0.as_str(), target.1)
        }) {
            candidate.browser = workspace
                .items
                .get(index)
                .and_then(|item| item.browser.clone());
        }
    }
    let matched: HashSet<_> = snapshots.enrich(&mut observed).into_iter().collect();
    location
        .targets
        .iter()
        .filter_map(|(&index, targets)| {
            let [target] = targets.as_slice() else {
                return None;
            };
            let item = workspace.items.get(index)?;
            let (candidate_index, candidate) =
                observed.iter().enumerate().find(|(_, candidate)| {
                    (candidate.window.id.as_str(), candidate.window.pid)
                        == (target.0.as_str(), target.1)
                })?;
            if !matched.contains(&candidate_index) {
                return None;
            }
            let mut browser = candidate.browser.clone()?;
            if !is_browser_kind(item, browser.kind) || browser.tabs.is_empty() {
                return None;
            }
            if browser.kind == BrowserKind::Chromium
                && !item
                    .window
                    .app_id
                    .eq_ignore_ascii_case(&candidate.window.app_id)
            {
                return None;
            }
            if let Some(previous) = item.browser.as_ref() {
                if previous.kind != browser.kind
                    || (!previous.profile_path.is_empty()
                        && !browser.profile_path.is_empty()
                        && !same_path(&previous.profile_path, &browser.profile_path))
                {
                    return None;
                }
                if browser.profile_path.is_empty() {
                    browser.profile_path = previous.profile_path.clone();
                }
                if browser.profile_name.is_empty() {
                    browser.profile_name = previous.profile_name.clone();
                }
            }
            Some(WorkspaceTabUpdate { index, browser })
        })
        .collect()
}

fn selected_location<'a>(
    locations: &'a [Location],
    desktop_id: Option<&str>,
) -> Result<Option<&'a Location>, String> {
    if let Some(id) = desktop_id.filter(|id| !id.is_empty()) {
        return locations
            .iter()
            .find(|location| location.summary.id == id && location.summary.browser_count > 0)
            .map(Some)
            .ok_or("The browser is no longer open on that desktop. Choose a source again.".into());
    }
    let mut candidates = locations
        .iter()
        .filter(|location| location.summary.browser_count > 0);
    let first = candidates.next();
    if candidates.next().is_some() {
        return Err("Choose which desktop to update URLs from.".into());
    }
    Ok(first)
}

#[tauri::command]
pub async fn workspace_locations(
    app: AppHandle,
    profile: Option<crate::workspaces::Workspace>,
    resolve_browsers: Option<bool>,
    wait_for_idle: Option<bool>,
) -> Result<Vec<WorkspaceLocations>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = crate::platform::desktop_snapshot(&app)?;
        let bridge = app.state::<Bridge>();
        let active = bridge
            .state
            .lock()
            .map_err(|e| e.to_string())?
            .config
            .active
            .clone();
        let profiles = if let Some(profile) = profile {
            vec![profile]
        } else {
            crate::workspaces::load(&app)?.profiles
        };
        let mut result = Vec::new();
        let mut firefox_paths = HashMap::new();
        for workspace in &profiles {
            let mut locations = locations_for_workspace_cached(
                workspace,
                &active,
                &snapshot,
                true,
                &mut firefox_paths,
            );
            let mut failure = None;
            // Listing workspaces only reads native window metadata. Tab data is
            // requested on demand when an explicit update needs a fallback.
            if resolve_browsers.unwrap_or(false)
                && !locations
                    .iter()
                    .any(|location| location.summary.browser_count > 0)
            {
                let snapshots =
                    bridge.capture_snapshots_with_discovery(true, wait_for_idle.unwrap_or(false));
                locations = browser_locations(workspace, &active, &snapshot, &snapshots);
                if !locations
                    .iter()
                    .any(|location| location.summary.browser_count > 0)
                {
                    failure = Some(tab_update_failure(workspace, &snapshots));
                }
            }
            result.push(WorkspaceLocations {
                workspace_id: workspace.id.clone(),
                locations: locations
                    .into_iter()
                    .map(|location| location.summary)
                    .collect(),
                failure,
            });
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

// Prefer the restored native window, then compare profiles, tabs and titles.
// A browser window must be the unique best match in both directions.
#[cfg(test)]
fn matching_workspace_tabs(
    workspace: &crate::workspaces::Workspace,
    current: &[crate::workspaces::WindowInfo],
    snapshots: &CapturedSnapshots,
    active: Option<&Active>,
) -> Vec<WorkspaceTabUpdate> {
    matching_workspace_tabs_with_evidence(workspace, current, snapshots, active)
        .into_iter()
        .map(|(update, _, _)| update)
        .collect()
}

fn matching_workspace_tabs_with_evidence(
    workspace: &crate::workspaces::Workspace,
    current: &[crate::workspaces::WindowInfo],
    snapshots: &CapturedSnapshots,
    active: Option<&Active>,
) -> Vec<(WorkspaceTabUpdate, bool, (String, u32))> {
    let mut observed: Vec<_> = current
        .iter()
        .cloned()
        .map(|window| WorkspaceItem {
            label: window.title.clone(),
            window,
            launch: Default::default(),
            browser: None,
            terminal: None,
            capture_note: String::new(),
        })
        .collect();
    snapshots.enrich(&mut observed);
    let mut pairs = Vec::new();
    for (index, item) in workspace.items.iter().enumerate() {
        let key = (
            item.window.id.clone(),
            item.window.pid,
            item.window.app_id.clone(),
            item.window.desktop_id.clone(),
        );
        let target = active
            .filter(|active| active.id == workspace.id)
            .and_then(|active| {
                (active.saved.get(index) == Some(&key))
                    .then(|| active.targets.get(index))
                    .flatten()
            })
            .and_then(|target| target.as_ref())
            .cloned()
            .unwrap_or_else(|| (item.window.id.clone(), item.window.pid));
        for (observed_index, candidate) in observed.iter().enumerate() {
            let Some(browser) = candidate.browser.as_ref() else {
                continue;
            };
            if !is_browser_kind(item, browser.kind) || browser.tabs.is_empty() {
                continue;
            }
            if browser.kind == BrowserKind::Chromium
                && !item
                    .window
                    .app_id
                    .eq_ignore_ascii_case(&candidate.window.app_id)
            {
                continue;
            }
            let previous = item.browser.as_ref();
            if previous.is_some_and(|old| {
                old.kind != browser.kind
                    || (!old.profile_path.is_empty()
                        && !browser.profile_path.is_empty()
                        && !same_path(&old.profile_path, &browser.profile_path))
            }) {
                continue;
            }
            let exact = !target.0.is_empty()
                && (target.0.as_str(), target.1)
                    == (candidate.window.id.as_str(), candidate.window.pid);
            let overlap = previous
                .map(|old| {
                    browser
                        .tabs
                        .iter()
                        .filter(|tab| old.tabs.iter().any(|saved| saved.url == tab.url))
                        .count()
                })
                .unwrap_or(0);
            if !exact
                && overlap == 0
                && previous.is_some_and(|old| {
                    !old.profile_path.is_empty() && browser.profile_path.is_empty()
                })
            {
                continue;
            }
            let title = item
                .window
                .title
                .eq_ignore_ascii_case(&candidate.window.title);
            pairs.push((index, observed_index, (exact, overlap, title)));
        }
    }
    pairs
        .iter()
        .filter_map(|&(index, observed_index, score)| {
            let item_best = pairs
                .iter()
                .filter(|&&(other, _, candidate)| other == index && candidate >= score)
                .count()
                == 1;
            let window_best = pairs
                .iter()
                .filter(|&&(_, other, candidate)| other == observed_index && candidate >= score)
                .count()
                == 1;
            if !item_best || !window_best {
                return None;
            }
            let mut browser = observed[observed_index].browser.clone()?;
            if let Some(previous) = workspace.items[index].browser.as_ref() {
                if browser.profile_path.is_empty() {
                    browser.profile_path = previous.profile_path.clone();
                }
                if browser.profile_name.is_empty() {
                    browser.profile_name = previous.profile_name.clone();
                }
            }
            Some((
                WorkspaceTabUpdate { index, browser },
                score.0,
                (
                    observed[observed_index].window.id.clone(),
                    observed[observed_index].window.pid,
                ),
            ))
        })
        .collect()
}

// A newly saved workspace has no restored-desktop association yet. Only infer
// it when there is one clear match: the original native window, or at least two
// distinct saved web URLs. Leave competing workspaces and weak matches for the
// user to choose, and never update other, weakly matched windows as a side effect.
fn infer_workspace_tabs(
    workspaces: &[crate::workspaces::Workspace],
    current: &[crate::workspaces::WindowInfo],
    snapshots: &CapturedSnapshots,
    platform: &str,
) -> Option<(usize, Vec<WorkspaceTabUpdate>)> {
    let mut matches = Vec::new();
    for (workspace_index, workspace) in workspaces
        .iter()
        .enumerate()
        .filter(|(_, workspace)| workspace.platform == platform)
    {
        let mut exact = false;
        let updates: Vec<_> =
            matching_workspace_tabs_with_evidence(workspace, current, snapshots, None)
                .into_iter()
                .filter_map(|(update, same_window, _)| {
                    let saved = workspace.items[update.index].browser.as_ref();
                    let overlap: HashSet<_> = update
                        .browser
                        .tabs
                        .iter()
                        .map(|tab| tab.url.as_str())
                        .filter(|url| {
                            (url.starts_with("https://") || url.starts_with("http://"))
                                && saved.is_some_and(|browser| {
                                    browser.tabs.iter().any(|tab| tab.url == *url)
                                })
                        })
                        .collect();
                    if !same_window && overlap.len() < 2 {
                        return None;
                    }
                    exact |= same_window;
                    Some(update)
                })
                .collect();
        if !updates.is_empty() {
            matches.push((workspace_index, exact, updates));
        }
    }
    let exact_count = matches.iter().filter(|(_, exact, _)| *exact).count();
    if exact_count == 1 {
        let (index, _, updates) = matches.into_iter().find(|(_, exact, _)| *exact)?;
        return Some((index, updates));
    }
    if exact_count > 1 || matches.len() != 1 {
        return None;
    }
    let (index, _, updates) = matches.pop()?;
    Some((index, updates))
}

fn browser_locations(
    workspace: &crate::workspaces::Workspace,
    active: &HashMap<String, Active>,
    desktop: &crate::workspaces::DesktopSnapshot,
    snapshots: &CapturedSnapshots,
) -> Vec<Location> {
    let locations = locations_for_workspace(workspace, active, desktop);
    if locations
        .iter()
        .any(|location| location.summary.browser_count > 0)
    {
        return locations;
    }
    let all: Vec<_> = desktop
        .windows
        .iter()
        .map(|entry| entry.window.clone())
        .collect();
    let mut targets = vec![None; workspace.items.len()];
    for (update, exact, target) in
        matching_workspace_tabs_with_evidence(workspace, &all, snapshots, None)
    {
        let saved = workspace.items[update.index].browser.as_ref();
        let overlap: HashSet<_> = update
            .browser
            .tabs
            .iter()
            .map(|tab| tab.url.as_str())
            .filter(|url| {
                (url.starts_with("https://") || url.starts_with("http://"))
                    && saved.is_some_and(|browser| browser.tabs.iter().any(|tab| tab.url == *url))
            })
            .collect();
        if exact || overlap.len() >= 2 {
            targets[update.index] = Some(target);
        }
    }
    if targets.iter().all(Option::is_none) {
        return locations;
    }
    let saved = workspace
        .items
        .iter()
        .map(|item| {
            (
                item.window.id.clone(),
                item.window.pid,
                item.window.app_id.clone(),
                item.window.desktop_id.clone(),
            )
        })
        .collect();
    let inferred = Active {
        id: workspace.id.clone(),
        targets,
        saved,
    };
    let inferred_active = HashMap::from([("inferred".to_string(), inferred)]);
    locations_for_workspace(workspace, &inferred_active, desktop)
}

#[tauri::command]
pub async fn current_workspace_tabs(
    app: AppHandle,
    profile: crate::workspaces::Workspace,
    desktop_id: Option<String>,
) -> Result<WorkspaceTabUpdates, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bridge = app.state::<Bridge>();
        let snapshots = bridge.capture_snapshots_with_discovery(true, false);
        let desktop = crate::platform::desktop_snapshot(&app)?;
        let active = bridge
            .state
            .lock()
            .map_err(|e| e.to_string())?
            .config
            .active
            .clone();
        let locations = browser_locations(&profile, &active, &desktop, &snapshots);
        let updates = if let Some(location) = selected_location(&locations, desktop_id.as_deref())?
        {
            location_tab_updates(&profile, location, &desktop, &snapshots)
        } else {
            Vec::new()
        };
        let failure = updates
            .is_empty()
            .then(|| tab_update_failure(&profile, &snapshots));
        Ok(WorkspaceTabUpdates { updates, failure })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn update_saved_workspace_tabs(
    app: AppHandle,
    workspace_id: String,
    desktop_id: Option<String>,
) -> Result<SavedTabUpdate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bridge = app.state::<Bridge>();
        let snapshots = bridge.capture_snapshots_with_discovery(true, true);
        let desktop = crate::platform::desktop_snapshot(&app)?;
        let active = bridge
            .state
            .lock()
            .map_err(|e| e.to_string())?
            .config
            .active
            .clone();
        let runtime = app.state::<crate::Runtime>();
        let _guard = runtime
            .workspace_io
            .lock()
            .map_err(|error| error.to_string())?;
        let mut store = crate::workspaces::load(&app)?;
        let workspace = store
            .profiles
            .iter_mut()
            .find(|profile| profile.id == workspace_id)
            .ok_or("This workspace no longer exists.")?;
        let total = workspace
            .items
            .iter()
            .filter(|item| has_browser(std::slice::from_ref(item)))
            .count();
        let locations = browser_locations(workspace, &active, &desktop, &snapshots);
        let updates = if let Some(location) = selected_location(&locations, desktop_id.as_deref())?
        {
            location_tab_updates(workspace, location, &desktop, &snapshots)
        } else {
            Vec::new()
        };
        let updated = updates.len();
        let failure = (updated == 0).then(|| tab_update_failure(workspace, &snapshots));
        for update in updates {
            let item = &mut workspace.items[update.index];
            item.browser = Some(update.browser);
            item.capture_note.clear();
        }
        if updated > 0 {
            crate::workspaces::save(&app, &store)?;
        }
        Ok(SavedTabUpdate {
            store,
            updated,
            unmatched: total.saturating_sub(updated),
            failure,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub fn set_bridge_enabled(app: AppHandle, enabled: bool) -> Result<BridgeInfo, String> {
    if enabled {
        start(&app)?;
    } else {
        let bridge = app.state::<Bridge>();
        let worker = {
            let mut state = bridge.state.lock().map_err(|e| e.to_string())?;
            if let Some(stop) = state.running.take() {
                stop.store(false, Ordering::SeqCst);
            }
            state.snapshots.clear();
            state.connections.clear();
            state.live_destinations.clear();
            state.request_id.clear();
            state.awaiting.clear();
            state.requested.clear();
            state.config.enabled = false;
            state.config.live = false;
            state.config.live_clients.clear();
            write_config(&app, &state.config)?;
            state.worker.take()
        };
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }
    bridge_status(app)
}
#[tauri::command]
pub fn set_bridge_live(app: AppHandle, live: bool) -> Result<BridgeInfo, String> {
    if live {
        start(&app)?;
    }
    let bridge = app.state::<Bridge>();
    {
        let mut state = bridge.state.lock().map_err(|e| e.to_string())?;
        state.config.live = live;
        state.config.live_clients.clear();
        if !live {
            state.snapshots.clear();
            state.live_destinations.clear();
        }
        write_config(&app, &state.config)?;
    }
    bridge_status(app)
}
pub fn restore_enabled(app: &AppHandle) -> Result<(), String> {
    let config = read_config(app);
    app.state::<Bridge>()
        .state
        .lock()
        .map_err(|e| e.to_string())?
        .config = config.clone();
    if config.enabled {
        start(app)?;
    }
    Ok(())
}
fn start(app: &AppHandle) -> Result<(), String> {
    let bridge = app.state::<Bridge>();
    let mut state = bridge.state.lock().map_err(|e| e.to_string())?;
    if state
        .running
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::SeqCst))
    {
        return Ok(());
    }
    let mut config = read_config(app);
    if config.token.len() != 32 || !config.token.bytes().all(|b| b.is_ascii_hexdigit()) {
        config.token = uuid::Uuid::new_v4().simple().to_string();
    }
    let listener = match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port)) {
        Ok(listener) => listener,
        Err(_) if config.port != 0 => {
            // A changed port requires re-pairing; rotate the old code so it
            // cannot authorize requests to the new listener.
            config.token = uuid::Uuid::new_v4().simple().to_string();
            TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .map_err(|_| "Could not start the local browser connection.".to_string())?
        }
        Err(_) => return Err("Could not start the local browser connection.".into()),
    };
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    config.port = listener.local_addr().map_err(|e| e.to_string())?.port();
    config.enabled = true;
    write_config(app, &config)?;
    let running = Arc::new(AtomicBool::new(true));
    state.config = config.clone();
    state.running = Some(running.clone());
    let app = app.clone();
    state.worker = Some(std::thread::spawn(move || {
        while running.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => serve(stream, &app, &config.token, &running),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100))
                }
                Err(_) => break,
            }
        }
        running.store(false, Ordering::SeqCst);
    }));
    Ok(())
}

fn extension_manifest(browser: &str) -> Result<&'static str, String> {
    Ok(match browser {
        "firefox" => include_str!("../../browser-extension/firefox-manifest.json"),
        "chromium" => include_str!("../../browser-extension/chromium-manifest.json"),
        _ => return Err("Choose Firefox or Chromium.".into()),
    })
}
fn version_parts(version: &str) -> Option<[u16; 4]> {
    let mut result = [0; 4];
    let parts: Vec<_> = version.split('.').collect();
    if parts.is_empty() || parts.len() > result.len() {
        return None;
    }
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        result[index] = part.parse().ok()?;
    }
    Some(result)
}
fn sync_extension(
    path: &Path,
    browser: &str,
    force: bool,
) -> Result<Option<PreparedExtension>, String> {
    let manifest = extension_manifest(browser)?;
    let current: serde_json::Value = serde_json::from_str(manifest).map_err(|e| e.to_string())?;
    let version = current["version"]
        .as_str()
        .ok_or("Extension version is missing.")?;
    let current_parts = version_parts(version).ok_or("Extension version is invalid.")?;
    let mut write_assets = force;
    if !force {
        let existing = match fs::read(path.join("manifest.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let existing: serde_json::Value =
            serde_json::from_slice(&existing).map_err(|e| e.to_string())?;
        if existing["name"].as_str() != Some("Window Warp") {
            return Ok(None);
        }
        let old = existing["version"]
            .as_str()
            .and_then(version_parts)
            .ok_or("Prepared extension version is invalid.")?;
        if old > current_parts {
            return Ok(None);
        }
        write_assets = old < current_parts
            || [
                "background.js",
                "popup.html",
                "popup.css",
                "popup.js",
                "icon.png",
            ]
            .iter()
            .any(|name| !path.join(name).is_file());
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let marker_path = path.join("warp-managed.json");
    let installation_id = fs::read(&marker_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value["id"].as_str().map(str::to_owned))
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let marker = serde_json::to_vec(&serde_json::json!({"id":installation_id}))
        .map_err(|e| e.to_string())?;
    if fs::read(&marker_path).ok().as_deref() != Some(marker.as_slice()) {
        fs::write(&marker_path, marker).map_err(|e| e.to_string())?;
    }
    if write_assets {
        for (name, contents) in [
            (
                "background.js",
                include_str!("../../browser-extension/common/background.js"),
            ),
            (
                "popup.html",
                include_str!("../../browser-extension/common/popup.html"),
            ),
            (
                "popup.css",
                include_str!("../../browser-extension/common/popup.css"),
            ),
            (
                "popup.js",
                include_str!("../../browser-extension/common/popup.js"),
            ),
        ] {
            fs::write(path.join(name), contents).map_err(|e| e.to_string())?;
        }
        fs::write(
            path.join("icon.png"),
            include_bytes!("../../browser-extension/common/icon.png"),
        )
        .map_err(|e| e.to_string())?;
        // Publish the new version only after its files are ready.
        fs::write(path.join("manifest.json"), manifest).map_err(|e| e.to_string())?;
    }
    Ok(Some(PreparedExtension {
        installation_id,
        version: version.to_string(),
    }))
}
fn extension_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("browser-extensions"))
}
pub fn refresh_prepared_extensions(app: &AppHandle) -> Result<(), String> {
    let root = extension_root(app)?;
    let mut prepared = HashMap::new();
    let mut errors = Vec::new();
    for browser in ["chromium", "firefox"] {
        match sync_extension(&root.join(browser), browser, false) {
            Ok(Some(value)) => {
                prepared.insert(browser.to_string(), value);
            }
            Ok(None) => {}
            Err(error) => errors.push(format!("{browser}: {error}")),
        }
    }
    let bridge = app.state::<Bridge>();
    let mut state = bridge.state.lock().map_err(|e| e.to_string())?;
    state.prepared = prepared;
    state.extension_update_error = (!errors.is_empty()).then(|| {
        "Could not update an extension automatically. Prepare it again in Settings.".to_string()
    });
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
#[tauri::command]
pub fn prepare_extension(app: AppHandle, browser: String) -> Result<String, String> {
    let path = extension_root(&app)?.join(&browser);
    let result = sync_extension(&path, &browser, true);
    let bridge = app.state::<Bridge>();
    let mut state = bridge.state.lock().map_err(|e| e.to_string())?;
    match result {
        Ok(Some(prepared)) => {
            state.prepared.insert(browser, prepared);
            state.extension_update_error = None;
        }
        Ok(None) => return Err("Could not prepare the extension.".into()),
        Err(error) => {
            state.prepared.remove(&browser);
            return Err(error);
        }
    }
    Ok(path.to_string_lossy().into_owned())
}

fn serve(mut stream: TcpStream, app: &AppHandle, token: &str, running: &AtomicBool) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let (origin, response) = match read_request(&mut stream) {
        Ok((origin, body)) => {
            let result = serde_json::from_slice::<Request>(&body)
                .map_err(|_| "Invalid browser request.".to_string())
                .and_then(|request| {
                    if request.token != token || !running.load(Ordering::SeqCst) {
                        return Err(
                            "The browser connection is off or the pairing code is wrong.".into(),
                        );
                    }
                    handle(app, request, running)
                });
            (
                origin,
                result.unwrap_or_else(|error| serde_json::json!({"error":error})),
            )
        }
        Err(error) => (None, serde_json::json!({"error":error})),
    };
    let body = serde_json::to_vec(&response).unwrap_or_default();
    let cors = origin
        .map(|value| format!("Access-Control-Allow-Origin: {value}\r\n"))
        .unwrap_or_default();
    let header = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{cors}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(&body);
}
fn read_request(stream: &mut TcpStream) -> Result<(Option<String>, Vec<u8>), String> {
    let mut data = Vec::new();
    let mut buffer = [0u8; 4096];
    let end = loop {
        let count = stream
            .read(&mut buffer)
            .map_err(|_| "Cannot read browser request.")?;
        if count == 0 {
            return Err("Incomplete browser request.".into());
        }
        data.extend_from_slice(&buffer[..count]);
        if let Some(index) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break index + 4;
        }
        if data.len() > MAX_HEADER {
            return Err("Browser request headers are too large.".into());
        }
    };
    let header = std::str::from_utf8(&data[..end]).map_err(|_| "Invalid browser request.")?;
    if end > MAX_HEADER {
        return Err("Browser request headers are too large.".into());
    }
    if !header.starts_with("POST /bridge HTTP/1.") {
        return Err("Unsupported browser request.".into());
    }
    let mut length = None;
    let mut origin = None;
    for line in header.lines().skip(1) {
        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim();
            if key.eq_ignore_ascii_case("content-length") {
                if length.is_some() {
                    return Err("Invalid browser request length.".into());
                }
                length = Some(
                    value
                        .parse::<usize>()
                        .map_err(|_| "Invalid browser request length.")?,
                );
            }
            if key.eq_ignore_ascii_case("origin") {
                let allowed = value
                    .strip_prefix("chrome-extension://")
                    .or_else(|| value.strip_prefix("moz-extension://"));
                if !allowed.is_some_and(|id| {
                    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                }) {
                    return Err("Browser connection origin is not an extension.".into());
                }
                origin = Some(value.to_string());
            }
        }
    }
    if origin.is_none() {
        return Err("Browser connection origin is missing.".into());
    }
    let length = length.ok_or("Browser request length is missing.")?;
    if length > MAX_REQUEST {
        return Err("Browser request is too large.".into());
    }
    while data.len() - end < length {
        let count = stream
            .read(&mut buffer)
            .map_err(|_| "Cannot read browser request.")?;
        if count == 0 {
            return Err("Incomplete browser request.".into());
        }
        data.extend_from_slice(&buffer[..count]);
    }
    Ok((origin, data[end..end + length].to_vec()))
}

fn capture_extension_window(
    app: &AppHandle,
    request: &Request,
    client_id: &str,
) -> Result<(crate::workspaces::Workspace, (String, u32)), String> {
    let name = request.name.trim();
    if name.is_empty() || name.len() > 240 {
        return Err("Give the saved browser a name (up to 240 characters).".into());
    }
    let window_id = request
        .window_id
        .ok_or("Choose a browser window to save.")?;
    let snapshot = Snapshot {
        client_id: client_id.to_string(),
        browser: request.browser,
        profile_path: request.profile_path.clone(),
        profile_name: request.profile_name.clone(),
        windows: request.windows.clone(),
        updated: Instant::now(),
    };
    let mut profile = crate::workspaces::capture(crate::platform::snapshot(app)?, name.to_string());
    let matches: Vec<_> = match_snapshot(&profile.items, &snapshot)
        .into_iter()
        .filter(|(_, index)| snapshot.windows[*index].id == window_id)
        .collect();
    let [(native_index, extension_index)] = matches.as_slice() else {
        return Err("Could not uniquely identify that browser window. Try again with the browser focused, or create a workspace in Window Warp.".into());
    };
    let mut item = profile.items[*native_index].clone();
    if !assign_browser(
        &mut item,
        &snapshot,
        &snapshot.windows[*extension_index],
        false,
    ) {
        return Err(
            "Could not save these browser tabs. Check the selected browser profile and try again."
                .into(),
        );
    }
    let target = (item.window.id.clone(), item.window.pid);
    profile.items = vec![item];
    Ok((profile, target))
}

fn save_browser_from_extension(
    app: &AppHandle,
    request: &Request,
    client_id: &str,
) -> Result<serde_json::Value, String> {
    let (mut profile, target) = capture_extension_window(app, request, client_id)?;
    let window_id = request
        .window_id
        .ok_or("Choose a browser window to save.")?;
    // A standalone restore should open its own window rather than take over a
    // browser that already belongs to another workspace.
    profile.items[0].launch.new_window = true;
    let runtime = app.state::<crate::Runtime>();
    let _guard = runtime.workspace_io.lock().map_err(|e| e.to_string())?;
    let mut saved_browsers = crate::workspaces::load_saved_browsers(app)?;
    let replace_index = if request.saved_browser_id.is_empty() {
        None
    } else {
        Some(
            saved_browsers
                .profiles
                .iter()
                .position(|p| p.id == request.saved_browser_id)
                .ok_or("That saved browser no longer exists. Choose another one.")?,
        )
    };
    if let Some(index) = replace_index {
        check_revision(&saved_browsers.profiles[index], &request.expected_revision)?;
        profile.id = saved_browsers.profiles[index].id.clone();
    }
    let workspaces = crate::workspaces::load(app)?;
    let bridge = app.state::<Bridge>();
    let mut state = bridge.state.lock().map_err(|e| e.to_string())?;
    let existing = state
        .config
        .opened
        .values()
        .find(|owner| {
            owner
                .targets
                .iter()
                .flatten()
                .any(|identity| identity == &target)
                && workspaces
                    .profiles
                    .iter()
                    .chain(saved_browsers.profiles.iter())
                    .any(|p| p.id == owner.id)
        })
        .and_then(|owner| {
            workspaces
                .profiles
                .iter()
                .chain(saved_browsers.profiles.iter())
                .find(|p| p.id == owner.id)
                .map(|p| (p.id.clone(), p.name.clone()))
        });
    let mut destination = existing.clone();
    let link_config = if request.make_current != Some(false)
        && !(request.make_current != Some(true)
            && existing.as_ref().is_some_and(|owner| owner.0 != profile.id))
    {
        let mut config = state.config.clone();
        remember_opened(
            &mut config,
            Active {
                id: profile.id.clone(),
                targets: vec![Some(target)],
                saved: vec![saved_window_key(&profile.items[0])],
            },
        );
        Some(config)
    } else {
        None
    };
    let profile_id = profile.id.clone();
    let profile_name = profile.name.clone();
    if let Some(index) = replace_index {
        saved_browsers.profiles[index] = profile;
    } else {
        saved_browsers.profiles.push(profile);
    }
    crate::workspaces::save_saved_browsers(app, &saved_browsers)?;
    if replace_index.is_some() {
        for destinations in state.live_destinations.values_mut() {
            destinations.retain(|_, (id, _)| id != &profile_id);
        }
        if destination
            .as_ref()
            .is_some_and(|owner| owner.0 == profile_id)
        {
            destination = Some((profile_id.clone(), profile_name.clone()));
        }
    }
    let mut warning = None;
    if let Some(config) = link_config {
        if write_config(app, &config).is_ok() {
            state.config = config;
            destination = Some((profile_id, profile_name));
        } else {
            warning = Some("Saved the browser, but could not link it as the current sync destination. Choose it again from the destination menu.");
        }
    }
    if let Some(destination) = &destination {
        state
            .live_destinations
            .entry(client_id.to_string())
            .or_default()
            .insert(window_id, destination.clone());
    } else if let Some(destinations) = state.live_destinations.get_mut(client_id) {
        destinations.remove(&window_id);
    }
    drop(state);
    let _ = app.emit("warp-saved-browsers-updated", ());
    Ok(
        serde_json::json!({"saved":true,"destination":destination.map(|value| value.1),"warning":warning}),
    )
}

fn revision<T: Serialize>(value: &T) -> Result<String, String> {
    use std::hash::{Hash, Hasher};
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hash);
    Ok(format!("{:016x}", hash.finish()))
}

fn check_revision<T: Serialize>(value: &T, expected: &str) -> Result<(), String> {
    if !expected.is_empty() && revision(value)? != expected {
        return Err("The saved tabs changed. Reopen the chooser and review them again.".into());
    }
    Ok(())
}

fn require_revision<T: Serialize>(value: &T, expected: &str) -> Result<(), String> {
    if expected.is_empty() {
        return Err("Reopen the chooser to review the latest saved tabs.".into());
    }
    check_revision(value, expected)
}

fn save_workspace_from_extension(
    app: &AppHandle,
    request: &Request,
    client_id: &str,
) -> Result<serde_json::Value, String> {
    let (profile, target) = capture_extension_window(app, request, client_id)?;
    let runtime = app.state::<crate::Runtime>();
    let _guard = runtime
        .workspace_io
        .lock()
        .map_err(|error| error.to_string())?;
    let mut store = crate::workspaces::load(app)?;
    store.profiles.push(profile.clone());
    crate::workspaces::save(app, &store)?;
    let bridge = app.state::<Bridge>();
    let linked = if request.make_current == Some(true) {
        (|| -> Result<(), String> {
            let mut state = bridge.state.lock().map_err(|error| error.to_string())?;
            let mut config = state.config.clone();
            remember_opened(
                &mut config,
                Active {
                    id: profile.id.clone(),
                    targets: vec![Some(target)],
                    saved: vec![saved_window_key(&profile.items[0])],
                },
            );
            write_config(app, &config)?;
            state.config = config;
            if let Some(window_id) = request.window_id {
                state
                    .live_destinations
                    .entry(client_id.to_string())
                    .or_default()
                    .insert(window_id, (profile.id.clone(), profile.name.clone()));
            }
            Ok(())
        })()
    } else if request.make_current.is_none() {
        bridge.link_new_captures(app, std::slice::from_ref(&profile))
    } else {
        Ok(())
    };
    let _ = app.emit("warp-browser-updated", profile.id.clone());
    Ok(
        serde_json::json!({"saved":true,"name":profile.name,"warning":linked.err().map(|_| "Workspace saved, but its browser could not be linked. Open it in Window Warp to link it.")}),
    )
}

fn selected_extension_window(request: &Request) -> Result<&ExtensionWindow, String> {
    let id = request.window_id.ok_or("Choose a browser window first.")?;
    request
        .windows
        .iter()
        .find(|window| window.id == id && !window.tabs.is_empty())
        .ok_or_else(|| "That browser window is no longer available. Choose it again.".into())
}

fn replace_target_tabs(
    item: &mut WorkspaceItem,
    request: &Request,
    window: &ExtensionWindow,
) -> Result<(), String> {
    if !is_browser_kind(item, request.browser)
        || item
            .browser
            .as_ref()
            .is_some_and(|browser| browser.kind != request.browser)
    {
        return Err("Choose a matching browser window.".into());
    }
    require_revision(&*item, &request.expected_revision)?;
    let mut browser = item
        .browser
        .clone()
        .unwrap_or_else(|| browser_from(request, window, None));
    browser.tabs = window.tabs.clone();
    browser.active_tab = window.active_tab;
    browser.validate()?;
    item.browser = Some(browser);
    item.capture_note.clear();
    Ok(())
}

fn replace_tabs_elsewhere(app: &AppHandle, request: &Request) -> Result<serde_json::Value, String> {
    let window = selected_extension_window(request)?;
    let runtime = app.state::<crate::Runtime>();
    let _guard = runtime
        .workspace_io
        .lock()
        .map_err(|error| error.to_string())?;
    let standalone = !request.saved_browser_id.is_empty();
    let mut store = if standalone {
        crate::workspaces::load_saved_browsers(app)?
    } else {
        crate::workspaces::load(app)?
    };
    let id = if standalone {
        &request.saved_browser_id
    } else {
        &request.workspace_id
    };
    let profile = store
        .profiles
        .iter_mut()
        .find(|profile| &profile.id == id)
        .ok_or("That saved destination no longer exists. Choose it again.")?;
    let name = profile.name.clone();
    let index = if standalone {
        0
    } else {
        request
            .item_index
            .ok_or("Choose a browser window in the workspace.")?
    };
    let item = profile
        .items
        .get_mut(index)
        .ok_or("The workspace changed. Choose its browser window again.")?;
    replace_target_tabs(item, request, window)?;
    if standalone {
        crate::workspaces::save_saved_browsers(app, &store)?;
        let _ = app.emit("warp-saved-browsers-updated", ());
    } else {
        crate::workspaces::save(app, &store)?;
        let _ = app.emit("warp-browser-updated", id.to_string());
    }
    let bridge = app.state::<Bridge>();
    let state = bridge.state.lock().map_err(|error| error.to_string())?;
    let live_elsewhere = state.live_destinations.iter().any(|(client, windows)| {
        client_live(&state, client)
            && windows.iter().any(|(window, (owner, _))| {
                owner == id && !(client == &request.client_id && Some(*window) == request.window_id)
            })
    });
    Ok(
        serde_json::json!({"updated":1,"destination":name,"warning":live_elsewhere.then_some("Another browser has live updates for this destination and may change its tabs again.")}),
    )
}

fn link_current_from_extension(
    app: &AppHandle,
    request: &Request,
    client_id: &str,
) -> Result<serde_json::Value, String> {
    let window = selected_extension_window(request)?;
    let snapshot = Snapshot {
        client_id: client_id.to_string(),
        browser: request.browser,
        profile_path: request.profile_path.clone(),
        profile_name: request.profile_name.clone(),
        windows: request.windows.clone(),
        updated: Instant::now(),
    };
    let observed = crate::workspaces::capture(crate::platform::snapshot(app)?, String::new());
    let matches: Vec<_> = match_snapshot(&observed.items, &snapshot)
        .into_iter()
        .filter(|(_, extension)| snapshot.windows[*extension].id == window.id)
        .collect();
    let [(native_index, _)] = matches.as_slice() else {
        return Err(
            "Could not uniquely identify this browser window. Try again with it focused.".into(),
        );
    };
    let native = &observed.items[*native_index].window;
    let runtime = app.state::<crate::Runtime>();
    let _guard = runtime
        .workspace_io
        .lock()
        .map_err(|error| error.to_string())?;
    let standalone = !request.saved_browser_id.is_empty();
    let store = if standalone {
        crate::workspaces::load_saved_browsers(app)?
    } else {
        crate::workspaces::load(app)?
    };
    let id = if standalone {
        &request.saved_browser_id
    } else {
        &request.workspace_id
    };
    let profile = store
        .profiles
        .iter()
        .find(|profile| &profile.id == id)
        .ok_or("That saved destination no longer exists. Choose it again.")?;
    let index = if standalone {
        0
    } else {
        request
            .item_index
            .ok_or("Choose a browser window in the workspace.")?
    };
    let item = profile
        .items
        .get(index)
        .ok_or("The workspace changed. Choose its browser window again.")?;
    require_revision(item, &request.expected_revision)?;
    if !is_browser_kind(item, request.browser) {
        return Err("Choose a matching browser window.".into());
    }
    if item.browser.as_ref().is_some_and(|browser| {
        !browser.profile_path.is_empty()
            && !snapshot.profile_path.is_empty()
            && !same_path(&browser.profile_path, &snapshot.profile_path)
    }) {
        return Err(
            "That saved browser uses a different profile. Choose a matching destination.".into(),
        );
    }
    let mut check = item.clone();
    check.window = native.clone();
    if !assign_browser(&mut check, &snapshot, window, false) {
        return Err("This browser profile does not match the saved destination.".into());
    }
    let bridge = app.state::<Bridge>();
    let mut state = bridge.state.lock().map_err(|error| error.to_string())?;
    let previous = state.config.opened.get(&profile.id);
    let saved: Vec<_> = profile.items.iter().map(saved_window_key).collect();
    let mut targets: Vec<_> = saved
        .iter()
        .map(|key| {
            let previous = previous?;
            let mut matches = previous
                .saved
                .iter()
                .enumerate()
                .filter(|(_, old)| *old == key);
            let (Some((position, _)), None) = (matches.next(), matches.next()) else {
                return None;
            };
            previous.targets.get(position).cloned().flatten()
        })
        .collect();
    targets[index] = Some((native.id.clone(), native.pid));
    let mut config = state.config.clone();
    remember_opened(
        &mut config,
        Active {
            id: profile.id.clone(),
            targets,
            saved,
        },
    );
    write_config(app, &config)?;
    state.config = config;
    state
        .live_destinations
        .entry(client_id.to_string())
        .or_default()
        .insert(window.id, (profile.id.clone(), profile.name.clone()));
    Ok(serde_json::json!({"linked":true,"destination":profile.name}))
}

fn open_from_extension(
    app: &AppHandle,
    request: &Request,
    client_id: &str,
) -> Result<serde_json::Value, String> {
    let saved_browser = request.action == "open-saved-browser";
    let id = if saved_browser {
        &request.saved_browser_id
    } else {
        &request.workspace_id
    };
    let store = if saved_browser {
        crate::workspaces::load_saved_browsers(app)?
    } else {
        crate::workspaces::load(app)?
    };
    let profile = store
        .profiles
        .iter()
        .find(|profile| &profile.id == id)
        .ok_or("That saved destination no longer exists.")?;
    if saved_browser
        && (profile.items.len() != 1 || !is_browser_kind(&profile.items[0], request.browser))
    {
        return Err("Choose a saved browser for this extension.".into());
    }
    let operation = uuid::Uuid::new_v4().simple().to_string();
    {
        let bridge = app.state::<Bridge>();
        let mut state = bridge.state.lock().map_err(|error| error.to_string())?;
        if state
            .extension_operations
            .get(client_id)
            .is_some_and(|(_, result)| result.is_none())
        {
            return Err("A browser or workspace is already opening. Wait for it to finish.".into());
        }
        if !state.extension_operations.contains_key(client_id)
            && state.extension_operations.len() >= 16
        {
            if let Some(finished) = state
                .extension_operations
                .iter()
                .find_map(|(client, (_, result))| result.is_some().then(|| client.clone()))
            {
                state.extension_operations.remove(&finished);
            } else {
                return Err("Too many browser operations are active. Try again shortly.".into());
            }
        }
        state
            .extension_operations
            .insert(client_id.to_string(), (operation.clone(), None));
    }
    let app = app.clone();
    let id = id.clone();
    let client = client_id.to_string();
    let operation_for_thread = operation.clone();
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            tauri::async_runtime::block_on(crate::restore_destination(
                app.clone(),
                id,
                saved_browser,
                saved_browser,
            ))
        }));
        let result = match result {
            Ok(Ok(results)) => {
                let opened = results.iter().filter(|result| result.restored).count();
                let failed = results.iter().filter(|result| !result.restored).count();
                if opened == 0 {
                    serde_json::json!({"done":true,"error":results.iter().find_map(|result| result.error.clone()).unwrap_or_else(|| "Nothing was opened. Check the saved destination in Window Warp.".into())})
                } else {
                    let warning = results.iter().find_map(|result| result.warning.clone());
                    serde_json::json!({"done":true,"opened":opened,"failed":failed,"warning":warning})
                }
            }
            Ok(Err(error)) => serde_json::json!({"done":true,"error":error}),
            Err(_) => {
                serde_json::json!({"done":true,"error":"Opening stopped unexpectedly. Check Window Warp and try again."})
            }
        };
        if let Ok(mut state) = app.state::<Bridge>().state.lock() {
            if let Some((id, stored)) = state.extension_operations.get_mut(&client) {
                if id == &operation_for_thread {
                    *stored = Some(result);
                }
            }
        }
    });
    Ok(serde_json::json!({"operationId":operation}))
}

fn handle(
    app: &AppHandle,
    request: Request,
    running: &AtomicBool,
) -> Result<serde_json::Value, String> {
    if ![
        "poll",
        "status",
        "snapshot",
        "update",
        "disconnect",
        "set-live",
        "save-browser",
        "save-workspace",
        "sync-current",
        "update-elsewhere",
        "link-current",
        "get-saved-tabs",
        "rename-saved-browser",
        "open-saved-browser",
        "open-workspace",
        "operation-status",
        "create-workspace",
        "open-workspaces",
        "focus-result",
    ]
    .contains(&request.action.as_str())
    {
        return Err("Unsupported browser action.".into());
    }
    if request.profile_path.len() > 32768
        || request.profile_name.len() > 1000
        || request.windows.len() > 100
        || request.expected_revision.len() > 100
        || request.operation_id.len() > 100
    {
        return Err("Browser snapshot is too large.".into());
    }
    let bridge = app.state::<Bridge>();
    let client_id = if request.client_id.is_empty() {
        format!("{:?}:{}", request.browser, request.profile_path)
    } else {
        request.client_id.clone()
    };
    if client_id.len() > 200 {
        return Err("Invalid browser connection identity.".into());
    }
    {
        let mut state = bridge.state.lock().map_err(|e| e.to_string())?;
        if !running.load(Ordering::SeqCst) {
            return Err("The browser connection is off.".into());
        }
        state
            .connections
            .retain(|old| old.client_id != client_id && old.updated.elapsed() < SNAPSHOT_LIFETIME);
        if request.action == "disconnect" {
            state.snapshots.retain(|old| old.client_id != client_id);
            state.awaiting.remove(&client_id);
            if let Some(commands) = state.focus_pending.remove(&client_id) {
                for command in commands {
                    state.focus_results.insert(command.id, false);
                }
            }
            state.config.live_clients.insert(client_id.clone(), false);
            state.live_destinations.remove(&client_id);
            state.extension_operations.remove(&client_id);
            write_config(app, &state.config)?;
            return Ok(serde_json::json!({"disconnected":true}));
        }
        state.connections.push(Connection {
            client_id: client_id.clone(),
            browser: request.browser,
            updated: Instant::now(),
            supports_focus: request.supports_focus,
        });
        if request.action == "focus-result" {
            record_focus_result(
                &mut state,
                &client_id,
                &request.request_id,
                request.name == "ok",
            )?;
            return Ok(serde_json::json!({"received":true}));
        }
        if request.action == "set-live" {
            state
                .config
                .live_clients
                .insert(client_id.clone(), request.live);
            if !request.live {
                state.snapshots.retain(|old| old.client_id != client_id);
            }
            write_config(app, &state.config)?;
            return Ok(serde_json::json!({"live":request.live}));
        }
        if request.action == "poll" {
            let request_id = pending_snapshot_request(&mut state, &client_id);
            let focus = state
                .focus_pending
                .get(&client_id)
                .cloned()
                .unwrap_or_default();
            return Ok(
                serde_json::json!({"live":client_live(&state, &client_id),"requestId":request_id,"extensionVersion":update_version(&state, &request),"focusCommands":focus}),
            );
        }
        if request.action == "operation-status" {
            let (id, result) = state
                .extension_operations
                .get(&client_id)
                .ok_or("That browser operation is no longer available.")?;
            if id != &request.operation_id {
                return Err("That browser operation is no longer available.".into());
            }
            return Ok(result
                .clone()
                .unwrap_or_else(|| serde_json::json!({"done":false})));
        }
    }
    if request.action == "create-workspace" {
        crate::app_actions::dispatch(app, "update-workspace");
        return Ok(serde_json::json!({"opened":true}));
    }
    if request.action == "open-workspaces" {
        crate::app_actions::show_workspaces(app)?;
        return Ok(serde_json::json!({"opened":true}));
    }
    if request.action == "open-workspace" || request.action == "open-saved-browser" {
        return open_from_extension(app, &request, &client_id);
    }
    if request.action == "get-saved-tabs" || request.action == "rename-saved-browser" {
        let runtime = app.state::<crate::Runtime>();
        let _guard = runtime
            .workspace_io
            .lock()
            .map_err(|error| error.to_string())?;
        let mut store = crate::workspaces::load_saved_browsers(app)?;
        let profile = store
            .profiles
            .iter_mut()
            .find(|profile| profile.id == request.saved_browser_id)
            .ok_or("That saved browser no longer exists.")?;
        let [item] = profile.items.as_slice() else {
            return Err("That saved browser cannot be opened.".into());
        };
        let browser = item
            .browser
            .as_ref()
            .filter(|browser| browser.kind == request.browser)
            .ok_or("Choose a saved browser for this extension.")?;
        if request.action == "get-saved-tabs" {
            return Ok(
                serde_json::json!({"tabs":browser.tabs,"activeTab":browser.active_tab,"name":profile.name}),
            );
        }
        require_revision(&*profile, &request.expected_revision)?;
        let name = request.name.trim();
        if name.is_empty() || name.len() > 240 {
            return Err("Give the saved browser a name (up to 240 characters).".into());
        }
        profile.name = name.to_string();
        crate::workspaces::save_saved_browsers(app, &store)?;
        let _ = app.emit("warp-saved-browsers-updated", ());
        return Ok(serde_json::json!({"renamed":true}));
    }
    if request.action != "status" {
        for window in &request.windows {
            if window.title.len() > 16000 {
                return Err("Browser window title is too long.".into());
            }
            browser_from(&request, window, None).validate()?;
        }
        let mut state = bridge.state.lock().map_err(|e| e.to_string())?;
        if !running.load(Ordering::SeqCst) {
            return Err("The browser connection is off.".into());
        }
        if request.action == "snapshot" && !accepts_snapshot(&state, &request, &client_id) {
            return Err("Live tab sharing is off. Request tabs from Window Warp instead.".into());
        }
        state.snapshots.retain(|old| old.client_id != client_id);
        state
            .snapshots
            .retain(|old| old.updated.elapsed() < SNAPSHOT_LIFETIME);
        if state.snapshots.len() >= 8 {
            return Err(
                "Too many browser profiles are connected. Turn off an unused extension profile."
                    .into(),
            );
        }
        state.snapshots.push(Snapshot {
            client_id: client_id.clone(),
            browser: request.browser,
            profile_path: request.profile_path.clone(),
            profile_name: request.profile_name.clone(),
            windows: request.windows.clone(),
            updated: Instant::now(),
        });
        if request.request_id == state.request_id {
            state.awaiting.remove(&client_id);
        }
    }
    if request.action == "save-browser" {
        return save_browser_from_extension(app, &request, &client_id);
    }
    if request.action == "save-workspace" {
        return save_workspace_from_extension(app, &request, &client_id);
    }
    if request.action == "sync-current" {
        return sync_current_from_extension(app, &request, &client_id);
    }
    if request.action == "update-elsewhere" {
        return replace_tabs_elsewhere(app, &request);
    }
    if request.action == "link-current" {
        return link_current_from_extension(app, &request, &client_id);
    }
    if request.action == "snapshot" {
        if request.live {
            let snapshot = Snapshot {
                client_id: client_id.clone(),
                browser: request.browser,
                profile_path: request.profile_path.clone(),
                profile_name: request.profile_name.clone(),
                windows: request.windows.clone(),
                updated: Instant::now(),
            };
            let destinations = save_live_snapshot(app, &snapshot)?;
            let visible: HashMap<_, _> = destinations
                .iter()
                .map(|(id, (_, name))| (*id, name.clone()))
                .collect();
            bridge
                .state
                .lock()
                .map_err(|e| e.to_string())?
                .live_destinations
                .insert(client_id, destinations);
            return Ok(serde_json::json!({"received":true,"destinations":visible}));
        }
        return Ok(serde_json::json!({"received":true}));
    }
    let desktop = crate::platform::current_desktop_key(app).ok();
    let (current, windows_available) = match crate::platform::snapshot_current(app) {
        Ok(windows) => (windows, true),
        Err(_) if request.action == "status" => (Vec::new(), false),
        Err(error) => return Err(error),
    };
    let (active, live, extension_version, destination, has_owners) = {
        let state = bridge.state.lock().map_err(|e| e.to_string())?;
        (
            desktop
                .and_then(|key| active_on_desktop(&state.config.active, &key, &current).cloned()),
            client_live(&state, &client_id),
            update_version(&state, &request).map(str::to_owned),
            request.window_id.and_then(|id| {
                state
                    .live_destinations
                    .get(&client_id)
                    .and_then(|windows| windows.get(&id))
                    .cloned()
            }),
            state
                .config
                .opened
                .values()
                .any(|owner| owner.targets.iter().any(Option::is_some)),
        )
    };
    let mut storage_error = None;
    let store = match crate::workspaces::load(app) {
        Ok(store) => store,
        Err(_) if request.action == "status" => {
            storage_error =
                Some("Saved workspaces could not be read. Open Window Warp to review them.");
            crate::workspaces::WorkspaceStore::default()
        }
        Err(error) => return Err(error),
    };
    let saved_browsers = if request.action == "status" {
        match crate::workspaces::load_saved_browsers(app) {
            Ok(store) => Some(store),
            Err(_) => {
                storage_error =
                    Some("Saved browsers could not be read. Open Window Warp to review them.");
                None
            }
        }
    } else {
        None
    };
    let destination = destination.and_then(|(id, _)| {
        store
            .profiles
            .iter()
            .chain(
                saved_browsers
                    .iter()
                    .flat_map(|store| store.profiles.iter()),
            )
            .find(|profile| profile.id == id)
            .map(|profile| profile.name.clone())
    });
    let workspace = active
        .as_ref()
        .and_then(|active| store.profiles.iter().find(|p| p.id == active.id));
    if request.action == "update" {
        let runtime = app.state::<crate::Runtime>();
        let _guard = runtime.workspace_io.lock().map_err(|e| e.to_string())?;
        if !running.load(Ordering::SeqCst) {
            return Err("The browser connection is off.".into());
        }
        let mut store = crate::workspaces::load(app)?;
        let manual = !request.workspace_id.is_empty()
            || request.item_index.is_some()
            || request.window_id.is_some();
        if manual
            && (request.workspace_id.is_empty()
                || request.item_index.is_none()
                || request.window_id.is_none())
        {
            return Err("Choose a workspace and browser window below.".into());
        }
        let snapshot = Snapshot {
            client_id,
            browser: request.browser,
            profile_path: request.profile_path,
            profile_name: request.profile_name,
            windows: request.windows,
            updated: Instant::now(),
        };
        let active_exists = active
            .as_ref()
            .is_some_and(|active| store.profiles.iter().any(|profile| profile.id == active.id));
        if !manual && !active_exists {
            let snapshots = CapturedSnapshots(vec![snapshot.clone()]);
            let (index, updates) =
                infer_workspace_tabs(&store.profiles, &current, &snapshots, std::env::consts::OS)
                    .ok_or("No unique matching workspace. Choose a window below.")?;
            let workspace = &mut store.profiles[index];
            let eligible = workspace
                .items
                .iter()
                .filter(|item| is_browser_kind(item, snapshot.browser))
                .count();
            let updated = updates.len();
            for update in updates {
                let item = &mut workspace.items[update.index];
                item.browser = Some(update.browser);
                item.capture_note.clear();
            }
            let (workspace_id, name) = (workspace.id.clone(), workspace.name.clone());
            crate::workspaces::save(app, &store)?;
            let _ = app.emit("warp-browser-updated", workspace_id);
            return Ok(
                serde_json::json!({"updated":updated,"unmatched":eligible.saturating_sub(updated),"workspace":name}),
            );
        }
        let chosen_id = if manual {
            request.workspace_id.clone()
        } else {
            active
                .as_ref()
                .map(|a| a.id.clone())
                .ok_or("Choose a workspace and browser window below.")?
        };
        let workspace = store
            .profiles
            .iter_mut()
            .find(|p| p.id == chosen_id)
            .ok_or("The selected workspace no longer exists.")?;
        let name = workspace.name.clone();
        if let (Some(index), Some(window_id)) = (request.item_index, request.window_id) {
            let item = workspace
                .items
                .get_mut(index)
                .ok_or("Choose a window in the workspace.")?;
            let window = snapshot
                .windows
                .iter()
                .find(|window| window.id == window_id)
                .ok_or("That browser window is no longer open. Choose it again.")?;
            if !is_browser_kind(item, snapshot.browser) {
                return Err("Choose a matching browser window in the workspace.".into());
            }
            let observed =
                crate::workspaces::capture(crate::platform::snapshot(app)?, String::new());
            let native = match_snapshot(&observed.items, &snapshot)
                .into_iter()
                .find(|(_, candidate)| snapshot.windows[*candidate].id == window_id)
                .map(|(candidate, _)| &observed.items[candidate].window);
            let mut chosen = item.clone();
            if let Some(native) = native {
                chosen.window = native.clone();
            } else {
                chosen.window.pid = 0;
            }
            if !assign_browser(&mut chosen, &snapshot, window, true) {
                return Err("These tabs cannot be saved to this workspace.".into());
            }
            item.browser = chosen.browser;
            item.capture_note.clear();
            crate::workspaces::save(app, &store)?;
            let _ = app.emit("warp-browser-updated", chosen_id.clone());
            return Ok(serde_json::json!({"updated":1,"unmatched":0,"workspace":name}));
        }
        let active = active
            .as_ref()
            .filter(|a| a.id == chosen_id)
            .ok_or("Choose the browser window to update below.")?;
        let mut candidates = workspace.items.clone();
        for (index, item) in candidates.iter_mut().enumerate() {
            let same_saved = active.saved.get(index).is_some_and(|key| {
                key == &(
                    item.window.id.clone(),
                    item.window.pid,
                    item.window.app_id.clone(),
                    item.window.desktop_id.clone(),
                )
            });
            if let (true, Some(Some((id, pid)))) = (same_saved, active.targets.get(index)) {
                if let Some(window) = current.iter().find(|w| &w.id == id && &w.pid == pid) {
                    item.window = window.clone();
                } else {
                    item.window.id.clear();
                }
            } else {
                item.window.id.clear();
            }
        }
        let eligible = candidates
            .iter()
            .filter(|item| {
                app_is_browser(item, snapshot.browser)
                    && item.browser.as_ref().is_none_or(|browser| {
                        browser.kind != snapshot.browser
                            || browser.profile_path.is_empty()
                            || snapshot.profile_path.is_empty()
                            || same_path(&browser.profile_path, &snapshot.profile_path)
                    })
            })
            .count();
        let matched = apply_snapshot(&mut candidates, &snapshot);
        let mut updated = 0;
        for index in matched {
            if let Some(browser) = candidates[index].browser.take() {
                workspace.items[index].browser = Some(browser);
                workspace.items[index].capture_note.clear();
                updated += 1;
            }
        }
        if updated == 0 {
            return Err("No window matched automatically. Choose a window below.".into());
        }
        crate::workspaces::save(app, &store)?;
        let _ = app.emit("warp-browser-updated", active.id.clone());
        return Ok(
            serde_json::json!({"updated":updated,"unmatched":eligible.saturating_sub(updated),"workspace":name}),
        );
    }
    let choices: Vec<_> = store
        .profiles
        .iter()
        .map(|workspace| {
            let items: Vec<_> = workspace
                .items
                .iter()
                .enumerate()
                .filter(|(_, item)| is_browser_kind(item, request.browser))
                .map(|(index, item)| serde_json::json!({"index":index,"label":item.label,"revision":revision(item).unwrap_or_default()}))
                .collect();
            serde_json::json!({"id":workspace.id,"name":workspace.name,"items":items,"windowCount":workspace.items.len()})
        })
        .collect();
    let saved_choices: Vec<_> = saved_browsers
        .into_iter()
        .flat_map(|store| store.profiles)
        .filter_map(|profile| {
            let [item] = profile.items.as_slice() else { return None; };
            let browser = item.browser.as_ref().filter(|browser| browser.kind == request.browser)?;
            Some(serde_json::json!({"id":profile.id,"name":profile.name,"tabCount":browser.tabs.len(),"revision":revision(&profile).unwrap_or_default(),"itemRevision":revision(item).unwrap_or_default()}))
        })
        .collect();
    Ok(
        serde_json::json!({"workspace":workspace.map(|p| &p.name), "destination":destination, "hasOwners":has_owners, "profiles":profiles(request.browser), "workspaces":choices, "savedBrowsers":saved_choices, "live":live, "extensionVersion":extension_version, "storageError":storage_error, "windowsAvailable":windows_available}),
    )
}

fn update_version<'a>(state: &'a State, request: &Request) -> Option<&'a str> {
    let browser = if request.browser == BrowserKind::Firefox {
        "firefox"
    } else {
        "chromium"
    };
    state
        .prepared
        .get(browser)
        .filter(|prepared| {
            !request.installation_id.is_empty()
                && prepared.installation_id == request.installation_id
        })
        .map(|prepared| prepared.version.as_str())
}
fn client_live(state: &State, client_id: &str) -> bool {
    state
        .config
        .live_clients
        .get(client_id)
        .copied()
        .unwrap_or(state.config.live)
}
fn record_focus_result(
    state: &mut State,
    client_id: &str,
    id: &str,
    success: bool,
) -> Result<(), String> {
    let command = state
        .focus_pending
        .get_mut(client_id)
        .and_then(|commands| {
            commands
                .iter()
                .position(|command| command.id == id)
                .map(|index| commands.remove(index))
        })
        .ok_or("The browser tab request has expired.")?;
    state.focus_results.insert(command.id, success);
    Ok(())
}
fn pending_snapshot_request(state: &mut State, client_id: &str) -> String {
    if state.request_id.is_empty() {
        return String::new();
    }
    if state.requested.insert(client_id.to_string()) {
        state.awaiting.insert(client_id.to_string());
    }
    if state.awaiting.contains(client_id) {
        state.request_id.clone()
    } else {
        String::new()
    }
}
fn accepts_snapshot(state: &State, request: &Request, client_id: &str) -> bool {
    request.explicit
        || (request.live && client_live(state, client_id))
        || (!request.request_id.is_empty()
            && request.request_id == state.request_id
            && state.awaiting.contains(client_id))
}
fn browser_from(
    request: &Request,
    window: &ExtensionWindow,
    previous: Option<&Browser>,
) -> Browser {
    Browser {
        kind: request.browser,
        profile_path: if request.profile_path.is_empty() {
            previous
                .filter(|p| p.kind == request.browser)
                .map(|p| p.profile_path.clone())
                .unwrap_or_default()
        } else {
            request.profile_path.clone()
        },
        profile_name: if request.profile_name.is_empty() {
            previous
                .filter(|p| p.kind == request.browser)
                .map(|p| p.profile_name.clone())
                .unwrap_or_default()
        } else {
            request.profile_name.clone()
        },
        tabs: window.tabs.clone(),
        active_tab: window.active_tab,
    }
}
fn app_is_browser(item: &WorkspaceItem, kind: BrowserKind) -> bool {
    !item.window.id.is_empty() && is_browser_kind(item, kind)
}
pub(crate) fn is_browser_kind(item: &WorkspaceItem, kind: BrowserKind) -> bool {
    if kind == BrowserKind::Firefox {
        return crate::firefox::is_firefox(&item.window);
    }
    let name = item.window.app_id.to_ascii_lowercase();
    [
        "chrome",
        "chromium",
        "msedge",
        "brave",
        "vivaldi",
        "opera",
        "google-chrome",
        "google-chrome-stable",
        "chromium-browser",
        "microsoft-edge",
        "microsoft-edge-stable",
        "brave-browser",
    ]
    .iter()
    .any(|prefix| {
        name == *prefix
            || name == format!("{prefix}.exe")
            || name == format!("{prefix}.desktop")
            || name.contains(&format!(".{prefix}."))
    })
}
pub(crate) fn has_browser(items: &[WorkspaceItem]) -> bool {
    items.iter().any(|item| {
        is_browser_kind(item, BrowserKind::Firefox) || is_browser_kind(item, BrowserKind::Chromium)
    })
}
fn title_matches(native: &str, title: &str) -> bool {
    if title.trim().is_empty() {
        return false;
    }
    let native = native.to_lowercase();
    let title = title.to_lowercase();
    if native == title
        || [" — ", " – ", " - "]
            .iter()
            .any(|separator| native.starts_with(&format!("{title}{separator}")))
    {
        return true;
    }
    // Edge can insert "and N more page(s)" before its profile/browser suffix.
    let Some(rest) = native
        .strip_prefix(&title)
        .and_then(|rest| rest.strip_prefix(" and "))
    else {
        return false;
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return false;
    }
    let Some(rest) = rest[digits..].strip_prefix(" more page") else {
        return false;
    };
    let rest = rest.strip_prefix('s').unwrap_or(rest);
    rest.is_empty()
        || [" — ", " – ", " - "]
            .iter()
            .any(|separator| rest.starts_with(separator))
}
fn match_snapshot(items: &[WorkspaceItem], snapshot: &Snapshot) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if !app_is_browser(item, snapshot.browser)
            || item.browser.as_ref().is_some_and(|existing| {
                existing.kind == snapshot.browser
                    && !existing.profile_path.is_empty()
                    && !snapshot.profile_path.is_empty()
                    && !same_path(&existing.profile_path, &snapshot.profile_path)
            })
        {
            continue;
        }
        for (window_index, window) in snapshot.windows.iter().enumerate() {
            if !title_matches(&item.window.title, &window.title) {
                continue;
            }
            let overlap = item
                .browser
                .as_ref()
                .map(|browser| {
                    window
                        .tabs
                        .iter()
                        .filter(|tab| browser.tabs.iter().any(|saved| saved.url == tab.url))
                        .count()
                })
                .unwrap_or(0);
            let rect = item.window.rect;
            let distance = window
                .x
                .zip(window.y)
                .zip(window.width.zip(window.height))
                .map(|((x, y), (width, height))| {
                    (i64::from(rect.x) - i64::from(x)).abs()
                        + (i64::from(rect.y) - i64::from(y)).abs()
                        + (i64::from(rect.width) - i64::from(width)).abs()
                        + (i64::from(rect.height) - i64::from(height)).abs()
                });
            let proximity = distance
                .filter(|distance| *distance <= 128)
                .map(|distance| 129 - distance)
                .unwrap_or(0);
            pairs.push((index, window_index, (overlap, proximity)));
        }
    }
    pairs
        .iter()
        .filter_map(|&(index, window, score)| {
            let item_best = pairs
                .iter()
                .filter(|&&(other, _, candidate)| other == index && candidate >= score)
                .count()
                == 1;
            let window_best = pairs
                .iter()
                .filter(|&&(_, other, candidate)| other == window && candidate >= score)
                .count()
                == 1;
            (item_best && window_best).then_some((index, window))
        })
        .collect()
}
// Browser and native geometry can use different DPI coordinate systems.
// Focus only when the active title identifies exactly one window on both sides.
fn match_focus_snapshot(items: &[WorkspaceItem], snapshot: &Snapshot) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if !app_is_browser(item, snapshot.browser) {
            continue;
        }
        for (window_index, window) in snapshot.windows.iter().enumerate() {
            if title_matches(&item.window.title, &window.title) {
                pairs.push((index, window_index));
            }
        }
    }
    pairs
        .iter()
        .filter_map(|&(index, window)| {
            let item_unique = pairs.iter().filter(|&&(other, _)| other == index).count() == 1;
            let window_unique = pairs.iter().filter(|&&(_, other)| other == window).count() == 1;
            (item_unique && window_unique).then_some((index, window))
        })
        .collect()
}

fn focus_plans(
    workspace: &crate::workspaces::Workspace,
    results: &[RestoreResult],
    current: &[crate::workspaces::WindowInfo],
    snapshots: &CapturedSnapshots,
    capable: &HashSet<String>,
) -> Vec<(usize, String, FocusCommand)> {
    let mut observed: Vec<_> = current
        .iter()
        .cloned()
        .map(|window| WorkspaceItem {
            label: window.title.clone(),
            window,
            launch: Default::default(),
            browser: None,
            terminal: None,
            capture_note: String::new(),
        })
        .collect();
    let mut owners = vec![None; current.len()];
    let mut ambiguous = HashSet::new();
    for (index, item) in workspace.items.iter().enumerate() {
        let Some(browser) = item
            .browser
            .as_ref()
            .filter(|browser| browser.tabs.len() > 1)
        else {
            continue;
        };
        let Some((id, pid)) = results
            .get(index)
            .filter(|result| result.restored)
            .and_then(|result| result.target.as_ref())
        else {
            continue;
        };
        let Some(found) = current
            .iter()
            .position(|window| &window.id == id && &window.pid == pid)
        else {
            continue;
        };
        if owners[found].replace(index).is_some() {
            ambiguous.insert(found);
        }
        observed[found].browser = Some(browser.clone());
    }
    let mut candidates: HashMap<usize, Vec<(&Snapshot, &ExtensionWindow)>> = HashMap::new();
    for snapshot in snapshots
        .0
        .iter()
        .filter(|snapshot| capable.contains(&snapshot.client_id))
    {
        for (native, extension) in match_focus_snapshot(&observed, snapshot) {
            let Some(index) = owners[native].filter(|_| !ambiguous.contains(&native)) else {
                continue;
            };
            let browser = workspace.items[index].browser.as_ref().unwrap();
            let profile_matches = if !browser.profile_path.is_empty() {
                if !snapshot.profile_path.is_empty() {
                    same_path(&browser.profile_path, &snapshot.profile_path)
                } else if browser.kind == BrowserKind::Firefox {
                    crate::firefox::profile_for_pid(current[native].pid)
                        .is_some_and(|(path, _)| same_path(&browser.profile_path, &path))
                } else {
                    false
                }
            } else if !browser.profile_name.is_empty() {
                !snapshot.profile_name.is_empty() && browser.profile_name == snapshot.profile_name
            } else {
                true
            };
            if profile_matches {
                candidates
                    .entry(index)
                    .or_default()
                    .push((snapshot, &snapshot.windows[extension]));
            }
        }
    }
    candidates
        .into_iter()
        .filter_map(|(index, matches)| {
            if matches.len() != 1 {
                return None;
            }
            let (snapshot, window) = matches[0];
            let browser = workspace.items[index].browser.as_ref()?;
            let selected = browser.tabs.get(browser.active_tab.saturating_sub(1))?;
            let matching: Vec<_> = window
                .tabs
                .iter()
                .enumerate()
                .filter_map(|(index, tab)| (tab.url == selected.url).then_some(index))
                .collect();
            let tab_index = if matching.len() == 1 {
                matching[0]
            } else if matching.len() > 1
                && browser.tabs.len() == window.tabs.len()
                && browser
                    .tabs
                    .iter()
                    .zip(&window.tabs)
                    .all(|(a, b)| a.url == b.url)
            {
                browser.active_tab - 1
            } else {
                return None;
            };
            Some((
                index,
                snapshot.client_id.clone(),
                FocusCommand {
                    id: uuid::Uuid::new_v4().simple().to_string(),
                    window_id: window.id,
                    tab_index,
                    expected_urls: window.tabs.iter().map(|tab| tab.url.clone()).collect(),
                },
            ))
        })
        .collect()
}
fn assign_browser(
    item: &mut WorkspaceItem,
    snapshot: &Snapshot,
    window: &ExtensionWindow,
    allow_profile_change: bool,
) -> bool {
    let request = Request {
        token: String::new(),
        action: String::new(),
        browser: snapshot.browser,
        client_id: String::new(),
        installation_id: String::new(),
        profile_path: snapshot.profile_path.clone(),
        profile_name: snapshot.profile_name.clone(),
        windows: vec![],
        request_id: String::new(),
        live: false,
        explicit: false,
        workspace_id: String::new(),
        item_index: None,
        window_id: None,
        name: String::new(),
        saved_browser_id: String::new(),
        expected_revision: String::new(),
        operation_id: String::new(),
        make_current: None,
        supports_focus: false,
    };
    let mut browser = browser_from(&request, window, item.browser.as_ref());
    if snapshot.browser == BrowserKind::Firefox {
        if let Some((path, name)) = crate::firefox::profile_for_pid(item.window.pid) {
            if !snapshot.profile_path.is_empty() && !same_path(&snapshot.profile_path, &path) {
                return false;
            }
            if !allow_profile_change
                && item.browser.as_ref().is_some_and(|previous| {
                    !previous.profile_path.is_empty() && !same_path(&previous.profile_path, &path)
                })
            {
                return false;
            }
            if !name.is_empty()
                || (!browser.profile_path.is_empty() && !same_path(&browser.profile_path, &path))
            {
                browser.profile_name = name;
            }
            browser.profile_path = path;
        }
    }
    if browser.validate().is_err() {
        return false;
    }
    item.browser = Some(browser);
    item.capture_note.clear();
    true
}
fn apply_snapshot(items: &mut [WorkspaceItem], snapshot: &Snapshot) -> Vec<usize> {
    match_snapshot(items, snapshot)
        .into_iter()
        .filter_map(|(index, window)| {
            assign_browser(
                &mut items[index],
                snapshot,
                &snapshot.windows[window],
                false,
            )
            .then_some(index)
        })
        .collect()
}

// Resolve extension windows against the complete native inventory before
// updating any destination. A native target with multiple owners, a changed
// saved item, or an ambiguous browser match is left untouched.
fn apply_live_snapshot(
    workspaces: &mut crate::workspaces::WorkspaceStore,
    saved_browsers: &mut crate::workspaces::WorkspaceStore,
    opened: &HashMap<String, Active>,
    windows: &[crate::workspaces::WindowInfo],
    snapshot: &Snapshot,
) -> (Vec<String>, Vec<String>, HashMap<i64, (String, String)>) {
    apply_owned_snapshot(workspaces, saved_browsers, opened, windows, snapshot, None)
}

fn apply_owned_snapshot(
    workspaces: &mut crate::workspaces::WorkspaceStore,
    saved_browsers: &mut crate::workspaces::WorkspaceStore,
    opened: &HashMap<String, Active>,
    windows: &[crate::workspaces::WindowInfo],
    snapshot: &Snapshot,
    only_window: Option<i64>,
) -> (Vec<String>, Vec<String>, HashMap<i64, (String, String)>) {
    let mut claims: HashMap<(String, u32), Vec<(String, usize, bool)>> = HashMap::new();
    for owner in opened.values() {
        let destination = workspaces
            .profiles
            .iter()
            .find(|p| p.id == owner.id)
            .map(|profile| (profile, false))
            .or_else(|| {
                saved_browsers
                    .profiles
                    .iter()
                    .find(|p| p.id == owner.id)
                    .map(|profile| (profile, true))
            });
        let Some((profile, saved_browser)) = destination else {
            continue;
        };
        for (index, item) in profile.items.iter().enumerate() {
            let key = saved_window_key(item);
            let mut matching = owner
                .saved
                .iter()
                .enumerate()
                .filter(|(_, old)| **old == key);
            let (Some((old_index, _)), None) = (matching.next(), matching.next()) else {
                continue;
            };
            let Some(Some(target)) = owner.targets.get(old_index) else {
                continue;
            };
            if !is_browser_kind(item, snapshot.browser)
                || !windows.iter().any(|window| {
                    window.id == target.0
                        && window.pid == target.1
                        && window.app_id.eq_ignore_ascii_case(&item.window.app_id)
                })
            {
                continue;
            }
            claims.entry(target.clone()).or_default().push((
                profile.id.clone(),
                index,
                saved_browser,
            ));
        }
    }
    let mut observed: Vec<_> = windows
        .iter()
        .map(|window| WorkspaceItem {
            label: window.title.clone(),
            window: window.clone(),
            launch: Default::default(),
            browser: None,
            terminal: None,
            capture_note: String::new(),
        })
        .collect();
    for candidate in &mut observed {
        let identity = (candidate.window.id.clone(), candidate.window.pid);
        let Some([(id, index, saved_browser)]) = claims.get(&identity).map(Vec::as_slice) else {
            continue;
        };
        let store = if *saved_browser {
            &*saved_browsers
        } else {
            &*workspaces
        };
        candidate.browser = store
            .profiles
            .iter()
            .find(|p| &p.id == id)
            .and_then(|p| p.items.get(*index))
            .and_then(|item| item.browser.clone());
    }
    let mut changed_workspaces = HashSet::new();
    let mut changed_browsers = HashSet::new();
    let mut destinations = HashMap::new();
    for (native_index, extension_index) in match_snapshot(&observed, snapshot) {
        if only_window.is_some_and(|id| snapshot.windows[extension_index].id != id) {
            continue;
        }
        let candidate = &mut observed[native_index];
        let identity = (candidate.window.id.clone(), candidate.window.pid);
        let Some([(id, index, saved_browser)]) = claims.get(&identity).map(Vec::as_slice) else {
            continue;
        };
        let store = if *saved_browser {
            &mut *saved_browsers
        } else {
            &mut *workspaces
        };
        let Some(profile) = store.profiles.iter_mut().find(|p| &p.id == id) else {
            continue;
        };
        let Some(item) = profile.items.get_mut(*index) else {
            continue;
        };
        if !assign_browser(
            candidate,
            snapshot,
            &snapshot.windows[extension_index],
            false,
        ) {
            continue;
        }
        let Some(browser) = candidate.browser.take() else {
            continue;
        };
        if browser.tabs.is_empty() {
            continue;
        }
        destinations.insert(
            snapshot.windows[extension_index].id,
            (profile.id.clone(), profile.name.clone()),
        );
        if item.browser.as_ref() != Some(&browser) {
            item.browser = Some(browser);
            item.capture_note.clear();
            if *saved_browser {
                changed_browsers.insert(id.clone());
            } else {
                changed_workspaces.insert(id.clone());
            }
        }
    }
    (
        changed_workspaces.into_iter().collect(),
        changed_browsers.into_iter().collect(),
        destinations,
    )
}

fn sync_current_from_extension(
    app: &AppHandle,
    request: &Request,
    client_id: &str,
) -> Result<serde_json::Value, String> {
    let window = selected_extension_window(request)?;
    let runtime = app.state::<crate::Runtime>();
    if runtime.restoring.load(Ordering::SeqCst) {
        return Err("Wait for the workspace to finish opening, then sync again.".into());
    }
    let windows = crate::platform::snapshot(app)?;
    let snapshot = Snapshot {
        client_id: client_id.to_string(),
        browser: request.browser,
        profile_path: request.profile_path.clone(),
        profile_name: request.profile_name.clone(),
        windows: request.windows.clone(),
        updated: Instant::now(),
    };
    let _guard = runtime
        .workspace_io
        .lock()
        .map_err(|error| error.to_string())?;
    if runtime.restoring.load(Ordering::SeqCst) {
        return Err("Wait for the workspace to finish opening, then sync again.".into());
    }
    let bridge = app.state::<Bridge>();
    let mut state = bridge.state.lock().map_err(|error| error.to_string())?;
    let mut workspaces = crate::workspaces::load(app)?;
    let mut saved = crate::workspaces::load_saved_browsers(app)?;
    let (changed_workspaces, changed_browsers, destinations) = apply_owned_snapshot(
        &mut workspaces,
        &mut saved,
        &state.config.opened,
        &windows,
        &snapshot,
        Some(window.id),
    );
    let destination = destinations
        .get(&window.id)
        .cloned()
        .ok_or("This window has no unique saved destination. Choose a current sync destination above, or use Sync elsewhere for a one-time update.")?;
    if !changed_workspaces.is_empty() {
        crate::workspaces::save(app, &workspaces)?;
        for id in changed_workspaces {
            let _ = app.emit("warp-browser-updated", id);
        }
    }
    if !changed_browsers.is_empty() {
        crate::workspaces::save_saved_browsers(app, &saved)?;
        let _ = app.emit("warp-saved-browsers-updated", ());
    }
    state
        .live_destinations
        .entry(client_id.to_string())
        .or_default()
        .insert(window.id, destination.clone());
    Ok(serde_json::json!({"updated":1,"destination":destination.1}))
}

fn save_live_snapshot(
    app: &AppHandle,
    snapshot: &Snapshot,
) -> Result<HashMap<i64, (String, String)>, String> {
    let runtime = app.state::<crate::Runtime>();
    if runtime.restoring.load(Ordering::SeqCst) {
        return Ok(HashMap::new());
    }
    let bridge = app.state::<Bridge>();
    if snapshot.windows.is_empty() {
        return Ok(HashMap::new());
    }
    let windows = crate::platform::snapshot(app)?;
    let _guard = runtime.workspace_io.lock().map_err(|e| e.to_string())?;
    if runtime.restoring.load(Ordering::SeqCst) {
        return Ok(HashMap::new());
    }
    let state = bridge.state.lock().map_err(|e| e.to_string())?;
    if !client_live(&state, &snapshot.client_id) {
        return Err("Live tab sharing is off.".into());
    }
    let opened = &state.config.opened;
    if opened.is_empty() {
        return Ok(HashMap::new());
    }
    let mut workspaces = crate::workspaces::load(app)?;
    let mut saved_browsers = crate::workspaces::load_saved_browsers(app)?;
    let (changed_workspaces, changed_browsers, destinations) = apply_live_snapshot(
        &mut workspaces,
        &mut saved_browsers,
        opened,
        &windows,
        snapshot,
    );
    if !changed_workspaces.is_empty() {
        crate::workspaces::save(app, &workspaces)?;
        for id in changed_workspaces {
            let _ = app.emit("warp-browser-updated", id);
        }
    }
    if !changed_browsers.is_empty() {
        crate::workspaces::save_saved_browsers(app, &saved_browsers)?;
        let _ = app.emit("warp-saved-browsers-updated", ());
    }
    Ok(destinations)
}
pub(crate) fn same_path(left: &str, right: &str) -> bool {
    let left = fs::canonicalize(left).unwrap_or_else(|_| PathBuf::from(left));
    let right = fs::canonicalize(right).unwrap_or_else(|_| PathBuf::from(right));
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}
fn chromium_profile_name<'a>(
    profile: &'a serde_json::Value,
    entries: impl Iterator<Item = &'a serde_json::Value>,
) -> String {
    fn field<'a>(profile: &'a serde_json::Value, keys: &[&str]) -> &'a str {
        keys.iter()
            .find_map(|key| profile[*key].as_str().filter(|value| !value.is_empty()))
            .unwrap_or("")
    }
    let local = field(profile, &["enterprise_label", "name"]);
    let account = field(
        profile,
        &["gaia_given_name", "gaia_name", "oidc_identity_name"],
    );
    if account.is_empty() {
        return local.to_string();
    }
    if local.is_empty() || account.eq_ignore_ascii_case(local) {
        return account.to_string();
    }
    let default = profile["is_using_default_name"].as_bool().unwrap_or(false);
    let custom = !default || !field(profile, &["enterprise_label"]).is_empty();
    let duplicate = entries
        .filter(|other| !std::ptr::eq(*other, profile))
        .any(|other| {
            let other_account = field(
                other,
                &["gaia_given_name", "gaia_name", "oidc_identity_name"],
            );
            let other_local = field(other, &["enterprise_label", "name"]);
            other_account == account
                && (other_account.eq_ignore_ascii_case(other_local)
                    || other["is_using_default_name"].as_bool().unwrap_or(false))
        });
    if custom || duplicate {
        format!("{account} ({local})")
    } else {
        account.to_string()
    }
}
fn profiles(kind: BrowserKind) -> Vec<serde_json::Value> {
    if kind == BrowserKind::Firefox {
        return crate::firefox::profiles()
            .into_iter()
            .map(|p| serde_json::json!({"name":p.name,"path":p.path}))
            .collect();
    }
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config"))
    };
    let Some(base) = base else {
        return vec![];
    };
    let roots: &[(&str, &str)] = if cfg!(windows) {
        &[
            ("Chrome", "Google/Chrome/User Data"),
            ("Edge", "Microsoft/Edge/User Data"),
            ("Brave", "BraveSoftware/Brave-Browser/User Data"),
            ("Chromium", "Chromium/User Data"),
        ]
    } else {
        &[
            ("Chrome", "google-chrome"),
            ("Chromium", "chromium"),
            ("Edge", "microsoft-edge"),
            ("Brave", "BraveSoftware/Brave-Browser"),
        ]
    };
    let mut result = Vec::new();
    for (label, relative) in roots {
        let root = base.join(relative);
        let file = root.join("Local State");
        if fs::metadata(&file)
            .map(|m| m.len() > 4 * 1024 * 1024)
            .unwrap_or(true)
        {
            continue;
        }
        let Some(value) = fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        else {
            continue;
        };
        if let Some(entries) = value
            .pointer("/profile/info_cache")
            .and_then(|v| v.as_object())
        {
            for (directory, profile) in entries {
                let path = root.join(directory);
                if path.is_dir() {
                    let name = chromium_profile_name(profile, entries.values());
                    let name = if name.is_empty() {
                        "Unnamed profile"
                    } else {
                        &name
                    };
                    result.push(serde_json::json!({"name":format!("{label}: {name}"),"path":path}));
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        geometry::Rect,
        workspaces::{LaunchSpec, WindowInfo},
    };

    #[test]
    fn matches_edge_multi_tab_titles_without_accepting_unrelated_prefixes() {
        assert!(title_matches(
            "Research and 1 more page - Profile 1 - Microsoft Edge",
            "Research"
        ));
        assert!(title_matches(
            "Research and 12 more pages — Microsoft Edge",
            "Research"
        ));
        assert!(!title_matches(
            "Research and updates - Microsoft Edge",
            "Research"
        ));
        assert!(!title_matches(
            "Research and 2 more pageant - Microsoft Edge",
            "Research"
        ));
    }

    #[test]
    fn connection_status_only_reports_recent_snapshots_while_bridge_is_running() {
        let mut state = State::default();
        state.connections.push(Connection {
            client_id: "fixture".into(),
            browser: BrowserKind::Chromium,
            updated: Instant::now(),
            supports_focus: false,
        });
        assert!(!info(&state).chromium_connected);
        state.running = Some(Arc::new(AtomicBool::new(true)));
        assert!(info(&state).chromium_connected);
        assert!(!info(&state).firefox_connected);
        state.connections[0].updated = Instant::now() - Duration::from_secs(91);
        assert!(!info(&state).chromium_connected);
        state
            .running
            .as_ref()
            .unwrap()
            .store(false, Ordering::SeqCst);
        assert!(!info(&state).enabled);
    }

    #[test]
    fn chromium_names_match_displayed_account_and_custom_profile_names() {
        let entries = serde_json::json!([
            {"name":"Person 1", "gaia_given_name":"Alex", "is_using_default_name":true},
            {"name":"Work", "gaia_given_name":"Alex", "is_using_default_name":false},
            {"name":"Person 2", "gaia_given_name":"Sam", "is_using_default_name":true},
            {"name":"Offline"}
        ]);
        let values = entries.as_array().unwrap();
        assert_eq!(chromium_profile_name(&values[0], values.iter()), "Alex");
        assert_eq!(
            chromium_profile_name(&values[1], values.iter()),
            "Alex (Work)"
        );
        assert_eq!(chromium_profile_name(&values[2], values.iter()), "Sam");
        assert_eq!(chromium_profile_name(&values[3], values.iter()), "Offline");
        let duplicates = serde_json::json!([{"name":"Person 1","gaia_name":"Sam","is_using_default_name":true},{"name":"Person 2","gaia_name":"Sam","is_using_default_name":true}]);
        let values = duplicates.as_array().unwrap();
        assert_eq!(
            chromium_profile_name(&values[0], values.iter()),
            "Sam (Person 1)"
        );
        assert_eq!(
            chromium_profile_name(&values[1], values.iter()),
            "Sam (Person 2)"
        );
    }

    fn item(id: &str, title: &str, x: i32) -> WorkspaceItem {
        WorkspaceItem {
            label: title.into(),
            window: WindowInfo {
                id: id.into(),
                pid: 1,
                title: title.into(),
                class_name: String::new(),
                app_id: "chrome.exe".into(),
                desktop_id: String::new(),
                path: "chrome.exe".into(),
                rect: Rect {
                    x,
                    y: 0,
                    width: 800,
                    height: 600,
                },
                work_area: Rect {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
                monitor: 1,
                monitor_name: String::new(),
                maximized_horizontal: false,
                maximized_vertical: false,
                fullscreen: false,
                minimized: false,
                active: false,
            },
            launch: LaunchSpec::default(),
            browser: None,
            terminal: None,
            capture_note: String::new(),
        }
    }
    fn snapshot() -> Snapshot {
        Snapshot {
            client_id: "fixture".into(),
            browser: BrowserKind::Chromium,
            profile_path: String::new(),
            profile_name: String::new(),
            updated: Instant::now(),
            windows: vec![ExtensionWindow {
                id: 1,
                title: "Example".into(),
                x: Some(10),
                y: Some(0),
                width: Some(800),
                height: Some(600),
                active_tab: 1,
                tabs: vec![Tab {
                    url: "https://example.test/".into(),
                    title: "Example".into(),
                }],
            }],
        }
    }

    #[test]
    fn one_time_update_preserves_target_profile_and_rejects_stale_confirmation() {
        let mut target = item("saved", "Example - Google Chrome", 10);
        target.browser = Some(Browser {
            kind: BrowserKind::Chromium,
            profile_path: "target-profile".into(),
            profile_name: "Target".into(),
            tabs: vec![Tab {
                url: "https://old.test/".into(),
                title: "Old".into(),
            }],
            active_tab: 1,
        });
        let mut request: Request = serde_json::from_value(serde_json::json!({
            "token":"fixture", "action":"update-elsewhere", "browser":"chromium"
        }))
        .unwrap();
        request.profile_path = "source-profile".into();
        request.expected_revision = revision(&target).unwrap();
        let window = snapshot().windows.remove(0);
        replace_target_tabs(&mut target, &request, &window).unwrap();
        let browser = target.browser.as_ref().unwrap();
        assert_eq!(browser.profile_path, "target-profile");
        assert_eq!(browser.profile_name, "Target");
        assert_eq!(browser.tabs[0].url, "https://example.test/");
        let changed = serde_json::to_value(&target).unwrap();
        assert!(replace_target_tabs(&mut target, &request, &window).is_err());
        assert_eq!(serde_json::to_value(&target).unwrap(), changed);
        request.expected_revision.clear();
        assert!(replace_target_tabs(&mut target, &request, &window).is_err());
    }

    #[test]
    fn focus_capability_must_belong_to_the_saved_browser_profile() {
        let mut state = State {
            running: Some(Arc::new(AtomicBool::new(true))),
            ..Default::default()
        };
        state.connections.push(Connection {
            client_id: "fixture".into(),
            browser: BrowserKind::Chromium,
            updated: Instant::now(),
            supports_focus: true,
        });
        let mut live = snapshot();
        live.profile_path = "/profiles/connected".into();
        live.profile_name = "Connected".into();
        state.snapshots.push(live);
        let bridge = Bridge {
            state: Arc::new(Mutex::new(state)),
            ..Default::default()
        };
        let mut browser = Browser {
            kind: BrowserKind::Chromium,
            profile_path: "/profiles/connected".into(),
            ..Default::default()
        };
        assert!(bridge.supports_tab_focus(&browser));
        browser.profile_path = "/profiles/unpaired".into();
        assert!(!bridge.supports_tab_focus(&browser));
        browser.profile_path.clear();
        browser.profile_name = "Connected".into();
        assert!(
            !bridge.supports_tab_focus(&browser),
            "profile names can be shared"
        );
        browser.profile_name.clear();
        assert!(!bridge.supports_tab_focus(&browser));
        bridge.state.lock().unwrap().connections[0].supports_focus = false;
        browser.profile_path = "/profiles/connected".into();
        assert!(!bridge.supports_tab_focus(&browser));
    }

    #[test]
    fn focus_preflight_can_discover_a_connected_profile_after_restart() {
        let bridge = Arc::new(Bridge::default());
        {
            let mut state = bridge.state.lock().unwrap();
            state.running = Some(Arc::new(AtomicBool::new(true)));
            state.connections.push(Connection {
                client_id: "fixture".into(),
                browser: BrowserKind::Chromium,
                updated: Instant::now(),
                supports_focus: true,
            });
        }
        let browser = Browser {
            kind: BrowserKind::Chromium,
            profile_path: "/profiles/connected".into(),
            ..Default::default()
        };
        assert!(!bridge.supports_tab_focus(&browser));
        let worker_bridge = bridge.clone();
        let worker = std::thread::spawn(move || {
            worker_bridge.refresh_focus_profiles(&AtomicBool::new(false))
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut state = bridge.state.lock().unwrap();
            if !state.request_id.is_empty() {
                let mut live = snapshot();
                live.profile_path = "/profiles/connected".into();
                state.snapshots.push(live);
                state.awaiting.remove("fixture");
                break;
            }
            drop(state);
            assert!(Instant::now() < deadline, "focus preflight did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(worker.join().unwrap());
        assert!(bridge.supports_tab_focus(&browser));
        let other = Browser {
            profile_path: "/profiles/unpaired".into(),
            ..browser
        };
        assert!(!bridge.supports_tab_focus(&other));
    }

    #[test]
    fn focus_matching_uses_unique_titles_when_geometry_uses_different_dpi() {
        let target = item("target", "Example - Google Chrome", 10);
        let mut live = snapshot();
        live.windows[0].x = Some(3000);
        assert_eq!(match_focus_snapshot(&[target], &live), [(0, 0)]);
    }

    #[test]
    fn focus_matching_rejects_identical_titles_on_other_desktops() {
        let target = item("target", "Example - Google Chrome", 10);
        let other = item("other", "Example - Google Chrome", 10);
        let mut live = snapshot();
        let mut other_window = live.windows[0].clone();
        other_window.id = 2;
        live.windows.push(other_window);
        assert!(match_focus_snapshot(&[target, other], &live).is_empty());
    }

    #[test]
    fn focus_matching_does_not_assign_another_windows_saved_tabs_to_the_target() {
        let mut target = item("target", "Example - Google Chrome", 10);
        let saved_tabs = vec![
            Tab {
                url: "https://example.test/".into(),
                title: "Example".into(),
            },
            Tab {
                url: "https://second.test/".into(),
                title: "Second".into(),
            },
        ];
        target.browser = Some(Browser {
            kind: BrowserKind::Chromium,
            tabs: saved_tabs.clone(),
            active_tab: 2,
            ..Default::default()
        });
        let other = item("other", "Example - Google Chrome", 1010);
        let mut live = snapshot();
        live.windows[0].tabs = vec![Tab {
            url: "https://different.test/".into(),
            title: "Example".into(),
        }];
        let mut other_window = live.windows[0].clone();
        other_window.id = 2;
        other_window.x = Some(1010);
        other_window.tabs = saved_tabs;
        live.windows.push(other_window);
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: std::env::consts::OS.into(),
            items: vec![target.clone()],
        };
        let result = RestoreResult {
            label: "Browser".into(),
            restored: true,
            launched: false,
            error: None,
            warning: None,
            target: Some((target.window.id.clone(), target.window.pid)),
        };
        assert!(focus_plans(
            &workspace,
            &[result],
            &[target.window, other.window],
            &CapturedSnapshots(vec![live]),
            &HashSet::from(["fixture".to_string()]),
        )
        .is_empty());
    }

    #[test]
    fn cancelling_focus_snapshot_does_not_wait_for_another_request() {
        let bridge = Arc::new(Bridge::default());
        let guard = bridge.snapshot_request.lock().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_bridge = bridge.clone();
        let worker_cancelled = cancelled.clone();
        let (done, finished) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            worker_bridge.capture_focus_snapshots(&worker_cancelled);
            done.send(()).unwrap();
        });
        cancelled.store(true, Ordering::Relaxed);
        assert!(finished.recv_timeout(Duration::from_secs(2)).is_ok());
        drop(guard);
        worker.join().unwrap();
    }

    #[test]
    fn cancelling_an_active_focus_snapshot_clears_its_request() {
        let bridge = Arc::new(Bridge::default());
        {
            let mut state = bridge.state.lock().unwrap();
            state.running = Some(Arc::new(AtomicBool::new(true)));
            state.connections.push(Connection {
                client_id: "fixture".into(),
                browser: BrowserKind::Chromium,
                updated: Instant::now(),
                supports_focus: true,
            });
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_bridge = bridge.clone();
        let worker_cancelled = cancelled.clone();
        let (done, finished) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            worker_bridge.capture_focus_snapshots(&worker_cancelled);
            done.send(()).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while bridge.state.lock().unwrap().request_id.is_empty() {
            assert!(Instant::now() < deadline, "snapshot request did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        cancelled.store(true, Ordering::Relaxed);
        assert!(finished.recv_timeout(Duration::from_secs(2)).is_ok());
        worker.join().unwrap();
        assert!(bridge.state.lock().unwrap().request_id.is_empty());
    }

    #[test]
    fn focusing_a_saved_tab_requires_a_unique_matching_window_and_profile() {
        let mut saved = item("native", "Example - Google Chrome", 10);
        let tabs = vec![
            Tab {
                url: "https://example.test/".into(),
                title: "Example".into(),
            },
            Tab {
                url: "https://second.test/".into(),
                title: "Second".into(),
            },
        ];
        saved.browser = Some(Browser {
            kind: BrowserKind::Chromium,
            tabs: tabs.clone(),
            active_tab: 2,
            ..Default::default()
        });
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: std::env::consts::OS.into(),
            items: vec![saved.clone()],
        };
        let result = RestoreResult {
            label: "Browser".into(),
            restored: true,
            launched: false,
            error: None,
            warning: None,
            target: Some((saved.window.id.clone(), saved.window.pid)),
        };
        let mut live = snapshot();
        live.windows[0].tabs = tabs;
        let capable = HashSet::from(["fixture".to_string()]);
        let plans = focus_plans(
            &workspace,
            std::slice::from_ref(&result),
            std::slice::from_ref(&saved.window),
            &CapturedSnapshots(vec![live.clone()]),
            &capable,
        );
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].2.window_id, 1);
        assert_eq!(plans[0].2.tab_index, 1);
        assert_eq!(
            plans[0].2.expected_urls,
            ["https://example.test/", "https://second.test/"]
        );

        let mut other = live.clone();
        other.client_id = "other".into();
        let both = HashSet::from(["fixture".to_string(), "other".to_string()]);
        assert!(focus_plans(
            &workspace,
            std::slice::from_ref(&result),
            std::slice::from_ref(&saved.window),
            &CapturedSnapshots(vec![live.clone(), other]),
            &both
        )
        .is_empty());
        let mut wrong_profile = workspace.clone();
        wrong_profile.items[0]
            .browser
            .as_mut()
            .unwrap()
            .profile_path = "saved-profile".into();
        live.profile_path = "different-profile".into();
        assert!(focus_plans(
            &wrong_profile,
            &[result],
            &[saved.window],
            &CapturedSnapshots(vec![live]),
            &capable
        )
        .is_empty());
    }

    #[test]
    fn focus_acknowledgements_are_scoped_to_the_requested_client_and_expire() {
        let mut state = State::default();
        state.focus_pending.insert(
            "right".into(),
            vec![FocusCommand {
                id: "one".into(),
                window_id: 7,
                tab_index: 0,
                expected_urls: vec!["https://one.test/".into()],
            }],
        );
        assert!(record_focus_result(&mut state, "other", "one", true).is_err());
        assert!(!state.focus_results.contains_key("one"));
        record_focus_result(&mut state, "right", "one", true).unwrap();
        assert_eq!(state.focus_results.get("one"), Some(&true));
        assert!(record_focus_result(&mut state, "right", "one", true).is_err());
    }

    #[test]
    fn live_tabs_update_only_the_workspace_that_owns_each_open_window() {
        let old = Browser {
            kind: BrowserKind::Chromium,
            profile_path: String::new(),
            profile_name: String::new(),
            tabs: vec![Tab {
                url: "https://saved.test/".into(),
                title: "Saved".into(),
            }],
            active_tab: 1,
        };
        let mut first = item("saved-a", "First", 10);
        first.browser = Some(old.clone());
        let mut second = item("saved-b", "Second", 910);
        second.browser = Some(old.clone());
        let copy = first.clone();
        let profile = |id: &str, item: WorkspaceItem| crate::workspaces::Workspace {
            id: id.into(),
            name: id.into(),
            platform: std::env::consts::OS.into(),
            items: vec![item],
        };
        let mut workspaces = crate::workspaces::WorkspaceStore {
            version: 1,
            profiles: vec![
                profile("work", first.clone()),
                profile("home", second.clone()),
                profile("copy", copy),
            ],
        };
        let mut browsers = crate::workspaces::WorkspaceStore::default();
        let mut current_first = item("open-a", "Example", 10).window;
        let current_second = item("open-b", "Other", 910).window;
        current_first.pid = 11;
        let opened = HashMap::from([
            (
                "work".into(),
                Active {
                    id: "work".into(),
                    targets: vec![Some(("open-a".into(), 11))],
                    saved: vec![saved_window_key(&first)],
                },
            ),
            (
                "home".into(),
                Active {
                    id: "home".into(),
                    targets: vec![Some(("open-b".into(), 1))],
                    saved: vec![saved_window_key(&second)],
                },
            ),
        ]);
        let mut incoming = snapshot();
        incoming.windows[0].tabs.push(Tab {
            url: "https://new.test/".into(),
            title: "New".into(),
        });
        incoming.windows.push(ExtensionWindow {
            id: 2,
            title: "Other".into(),
            x: Some(910),
            y: Some(0),
            width: Some(800),
            height: Some(600),
            active_tab: 1,
            tabs: vec![Tab {
                url: "https://home.test/".into(),
                title: "Home".into(),
            }],
        });
        let windows = vec![current_first.clone(), current_second.clone()];
        let mut single = workspaces.clone();
        let mut single_browsers = browsers.clone();
        let (changed, _, selected) = apply_owned_snapshot(
            &mut single,
            &mut single_browsers,
            &opened,
            &windows,
            &incoming,
            Some(1),
        );
        assert_eq!(changed, vec!["work"]);
        assert_eq!(selected.len(), 1);
        assert_eq!(
            single.profiles[0].items[0]
                .browser
                .as_ref()
                .unwrap()
                .tabs
                .len(),
            2
        );
        assert_eq!(
            single.profiles[1].items[0].browser.as_ref().unwrap(),
            &old,
            "syncing one browser leaves the other owned window untouched"
        );
        let mut ambiguous = incoming.clone();
        let mut duplicate = ambiguous.windows[0].clone();
        duplicate.id = 3;
        ambiguous.windows.push(duplicate);
        let mut untouched = workspaces.clone();
        let (_, _, selected) = apply_owned_snapshot(
            &mut untouched,
            &mut single_browsers,
            &opened,
            &windows,
            &ambiguous,
            Some(1),
        );
        assert!(
            selected.is_empty(),
            "an explicit sync still rejects competing browser windows"
        );
        assert_eq!(
            untouched.profiles[0].items[0].browser.as_ref().unwrap(),
            &old
        );
        let (changed, _, destinations) =
            apply_live_snapshot(&mut workspaces, &mut browsers, &opened, &windows, &incoming);
        assert_eq!(changed.len(), 2);
        assert_eq!(
            destinations.get(&1).map(|(_, name)| name.as_str()),
            Some("work")
        );
        assert_eq!(
            destinations.get(&2).map(|(_, name)| name.as_str()),
            Some("home")
        );
        assert_eq!(
            workspaces.profiles[0].items[0]
                .browser
                .as_ref()
                .unwrap()
                .tabs
                .len(),
            2
        );
        assert_eq!(
            workspaces.profiles[1].items[0]
                .browser
                .as_ref()
                .unwrap()
                .tabs[0]
                .url,
            "https://home.test/"
        );
        assert_eq!(
            workspaces.profiles[2].items[0].browser.as_ref().unwrap(),
            &old,
            "an unopened copy stays unchanged"
        );

        incoming.windows[0].tabs.remove(1);
        apply_live_snapshot(&mut workspaces, &mut browsers, &opened, &windows, &incoming);
        assert_eq!(
            workspaces.profiles[0].items[0]
                .browser
                .as_ref()
                .unwrap()
                .tabs
                .len(),
            1,
            "closing a tab updates its owner"
        );
        incoming.windows.clear();
        apply_live_snapshot(&mut workspaces, &mut browsers, &opened, &[], &incoming);
        assert_eq!(
            workspaces.profiles[0].items[0]
                .browser
                .as_ref()
                .unwrap()
                .tabs
                .len(),
            1,
            "closing a browser retains its last tabs"
        );
    }

    #[test]
    fn live_tabs_never_guess_between_identical_windows_or_owners() {
        let first = item("saved-a", "Example", 10);
        let second = item("saved-b", "Example", 10);
        let profile = |id: &str, item: WorkspaceItem| crate::workspaces::Workspace {
            id: id.into(),
            name: id.into(),
            platform: std::env::consts::OS.into(),
            items: vec![item],
        };
        let mut store = crate::workspaces::WorkspaceStore {
            version: 1,
            profiles: vec![
                profile("first", first.clone()),
                profile("second", second.clone()),
            ],
        };
        let mut browsers = crate::workspaces::WorkspaceStore::default();
        let owners = HashMap::from([
            (
                "first".into(),
                Active {
                    id: "first".into(),
                    targets: vec![Some(("one".into(), 1))],
                    saved: vec![saved_window_key(&first)],
                },
            ),
            (
                "second".into(),
                Active {
                    id: "second".into(),
                    targets: vec![Some(("two".into(), 1))],
                    saved: vec![saved_window_key(&second)],
                },
            ),
        ]);
        let windows = vec![
            item("one", "Example", 10).window,
            item("two", "Example", 10).window,
        ];
        let (changed, _, destinations) =
            apply_live_snapshot(&mut store, &mut browsers, &owners, &windows, &snapshot());
        assert!(changed.is_empty());
        assert!(destinations.is_empty());
        assert!(store.profiles.iter().all(|p| p.items[0].browser.is_none()));
        let mut config = Config::default();
        remember_opened(&mut config, owners["first"].clone());
        let mut replacement = owners["second"].clone();
        replacement.targets[0] = Some(("one".into(), 1));
        remember_opened(&mut config, replacement);
        assert!(
            config.opened["first"].targets[0].is_none(),
            "opening a different workspace transfers that window's ownership"
        );
    }

    #[test]
    fn live_tabs_follow_reordered_items_and_independent_saved_browsers() {
        let browser = item("saved-browser", "Example", 10);
        let other = item("saved-other", "Other", 910);
        let profile = crate::workspaces::Workspace {
            id: "saved".into(),
            name: "Research".into(),
            platform: std::env::consts::OS.into(),
            items: vec![other.clone(), browser.clone()],
        };
        let owner = Active {
            id: "saved".into(),
            targets: vec![Some(("open-browser".into(), 1)), None],
            saved: vec![saved_window_key(&browser), saved_window_key(&other)],
        };
        let mut workspaces = crate::workspaces::WorkspaceStore::default();
        let mut browsers = crate::workspaces::WorkspaceStore {
            version: 1,
            profiles: vec![profile],
        };
        let (_, changed, destinations) = apply_live_snapshot(
            &mut workspaces,
            &mut browsers,
            &HashMap::from([("saved".into(), owner)]),
            &[item("open-browser", "Example", 10).window],
            &snapshot(),
        );
        assert_eq!(changed, vec!["saved"]);
        assert_eq!(
            destinations.get(&1).map(|(_, name)| name.as_str()),
            Some("Research")
        );
        assert!(browsers.profiles[0].items[0].browser.is_none());
        assert_eq!(
            browsers.profiles[0].items[1].browser.as_ref().unwrap().tabs[0].url,
            "https://example.test/"
        );
    }
    #[test]
    fn workspace_open_locations_only_use_tracked_live_windows() {
        use crate::workspaces::{DesktopSnapshot, LocatedWindow, VirtualDesktop};
        let saved = item("saved", "Captured window", 10);
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![saved.clone()],
        };
        let desktop = |id: &str| VirtualDesktop {
            id: id.into(),
            name: id.into(),
        };
        let snapshot = DesktopSnapshot {
            current: Some(desktop("here")),
            windows: vec![
                LocatedWindow {
                    window: saved.window.clone(),
                    desktops: vec![desktop("elsewhere")],
                },
                LocatedWindow {
                    window: item("opened", "Workspace window", 10).window,
                    desktops: vec![desktop("here")],
                },
            ],
        };
        assert!(
            locations_for_workspace_with_saved(&workspace, &HashMap::new(), &snapshot, false)
                .is_empty()
        );
        assert_eq!(
            locations_for_workspace(&workspace, &HashMap::new(), &snapshot)[0]
                .summary
                .id,
            "elsewhere"
        );
        let active = Active {
            id: "work".into(),
            targets: vec![Some(("opened".into(), 1))],
            saved: vec![(
                saved.window.id.clone(),
                saved.window.pid,
                saved.window.app_id.clone(),
                saved.window.desktop_id.clone(),
            )],
        };
        let associations = HashMap::from([("old-desktop".into(), active)]);
        let tracked =
            locations_for_workspace_with_saved(&workspace, &associations, &snapshot, false);
        assert_eq!(tracked.len(), 1);
        assert_eq!(tracked[0].summary.id, "here");
        assert!(tracked[0].summary.current);
        let mut forced = workspace.clone();
        forced.items[0].launch.new_window = true;
        let mut remote = snapshot.clone();
        remote.windows[1].desktops = vec![desktop("elsewhere")];
        assert!(
            locations_for_workspace_with_saved(&forced, &associations, &remote, false).is_empty(),
            "A requested new window must not be blocked by an old desktop association"
        );
        assert!(
            !locations_for_workspace(&forced, &associations, &remote).is_empty(),
            "The existing window is still available as a tab source"
        );
    }
    #[test]
    fn workspace_open_tracks_remaining_windows_after_items_are_reordered() {
        use crate::workspaces::{DesktopSnapshot, LocatedWindow, VirtualDesktop};
        let first = item("saved-one", "First", 10);
        let second = item("saved-two", "Second", 20);
        let saved = [&first, &second]
            .iter()
            .map(|item| {
                (
                    item.window.id.clone(),
                    item.window.pid,
                    item.window.app_id.clone(),
                    item.window.desktop_id.clone(),
                )
            })
            .collect();
        let active = Active {
            id: "work".into(),
            targets: vec![
                Some(("opened-one".into(), 1)),
                Some(("opened-two".into(), 1)),
            ],
            saved,
        };
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![second],
        };
        let desktop = VirtualDesktop {
            id: "remote".into(),
            name: "Desktop 2".into(),
        };
        let snapshot = DesktopSnapshot {
            current: Some(VirtualDesktop {
                id: "here".into(),
                name: "Desktop 1".into(),
            }),
            windows: vec![LocatedWindow {
                window: item("opened-two", "Second", 20).window,
                desktops: vec![desktop],
            }],
        };
        let tracked = locations_for_workspace_with_saved(
            &workspace,
            &HashMap::from([("old".into(), active)]),
            &snapshot,
            false,
        );
        assert_eq!(tracked.len(), 1);
        assert_eq!(tracked[0].targets[&0], vec![("opened-two".into(), 1)]);
    }
    #[test]
    fn a_failed_desktop_move_attempts_to_restore_every_window() {
        let windows = vec![
            item("one", "First", 10).window,
            item("two", "Second", 20).window,
            item("three", "Third", 30).window,
        ];
        let mut calls = Vec::new();
        let error = move_windows_with_rollback(
            &windows,
            "source",
            "destination",
            || Ok(()),
            |window, desktop| {
                calls.push((window.id.clone(), desktop.to_string()));
                if window.id == "two" && desktop == "destination" {
                    Err("Move failed.".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert!(error.contains("returned to their original desktop"));
        assert_eq!(
            calls,
            vec![
                ("one".into(), "destination".into()),
                ("two".into(), "destination".into()),
                ("two".into(), "source".into()),
                ("one".into(), "source".into())
            ]
        );
    }
    #[test]
    fn workspace_sources_follow_moved_windows_and_require_a_desktop_choice() {
        use crate::workspaces::{DesktopSnapshot, LocatedWindow, VirtualDesktop};
        let saved = item("saved", "Old - Google Chrome", 10);
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![saved.clone()],
        };
        let association = |target: &str| Active {
            id: "work".into(),
            targets: vec![Some((target.into(), 1))],
            saved: vec![(
                saved.window.id.clone(),
                saved.window.pid,
                saved.window.app_id.clone(),
                saved.window.desktop_id.clone(),
            )],
        };
        let active = HashMap::from([
            ("old-a".into(), association("one")),
            ("old-b".into(), association("two")),
        ]);
        let desk = |id: &str, name: &str| VirtualDesktop {
            id: id.into(),
            name: name.into(),
        };
        let first = item("one", "First - Google Chrome", 10).window;
        let second = item("two", "Second - Google Chrome", 900).window;
        let desktop = DesktopSnapshot {
            current: Some(desk("three", "Desktop 3")),
            windows: vec![
                LocatedWindow {
                    window: first.clone(),
                    desktops: vec![desk("one", "Desktop 1")],
                },
                LocatedWindow {
                    window: second.clone(),
                    desktops: vec![desk("two", "Desktop 2")],
                },
            ],
        };
        let locations = locations_for_workspace(&workspace, &active, &desktop);
        assert_eq!(locations.len(), 2);
        assert!(selected_location(&locations, None).is_err());
        assert_eq!(
            selected_location(&locations, Some("two"))
                .unwrap()
                .unwrap()
                .summary
                .name,
            "Desktop 2"
        );
        assert!(selected_location(&locations, Some("gone")).is_err());
        let mut moved = desktop.clone();
        moved.windows[0].desktops = vec![desk("three", "Desktop 3")];
        let moved_locations = locations_for_workspace(&workspace, &active, &moved);
        assert!(moved_locations
            .iter()
            .any(|location| location.summary.id == "three"));
        assert!(!moved_locations
            .iter()
            .any(|location| location.summary.id == "one"));

        let mut live = snapshot();
        live.windows[0].title = "First".into();
        live.windows[0].tabs[0].url = "https://one.test/".into();
        let mut other = live.windows[0].clone();
        other.id = 2;
        other.title = "Second".into();
        other.x = Some(900);
        other.tabs[0].url = "https://two.test/".into();
        live.windows.push(other);
        let selected = selected_location(&locations, Some("two")).unwrap().unwrap();
        let updates = location_tab_updates(
            &workspace,
            selected,
            &desktop,
            &CapturedSnapshots(vec![live]),
        );
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].browser.tabs[0].url, "https://two.test/");
    }
    #[test]
    fn desktop_update_does_not_guess_between_identical_browser_windows() {
        use crate::workspaces::{DesktopSnapshot, LocatedWindow, VirtualDesktop};
        let first = item("one", "Example - Google Chrome", 10);
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![first.clone()],
        };
        let desktop = DesktopSnapshot {
            current: None,
            windows: vec![
                LocatedWindow {
                    window: first.window.clone(),
                    desktops: vec![VirtualDesktop {
                        id: "one".into(),
                        name: "Desktop 1".into(),
                    }],
                },
                LocatedWindow {
                    window: item("two", "Example - Google Chrome", 10).window,
                    desktops: vec![VirtualDesktop {
                        id: "two".into(),
                        name: "Desktop 2".into(),
                    }],
                },
            ],
        };
        let mut live = snapshot();
        let mut second = live.windows[0].clone();
        second.id = 2;
        live.windows.push(second);
        let locations = locations_for_workspace(&workspace, &HashMap::new(), &desktop);
        let location = selected_location(&locations, Some("one")).unwrap().unwrap();
        assert!(location_tab_updates(
            &workspace,
            location,
            &desktop,
            &CapturedSnapshots(vec![live])
        )
        .is_empty());
    }
    #[test]
    fn desktop_update_uses_saved_tabs_to_distinguish_matching_windows() {
        use crate::workspaces::{DesktopSnapshot, LocatedWindow, VirtualDesktop};
        let mut first = item("one", "Example - Google Chrome", 10);
        first.browser = Some(Browser {
            kind: BrowserKind::Chromium,
            tabs: vec![
                Tab {
                    url: "https://one.test/".into(),
                    title: String::new(),
                },
                Tab {
                    url: "https://two.test/".into(),
                    title: String::new(),
                },
            ],
            active_tab: 1,
            ..Default::default()
        });
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![first.clone()],
        };
        let desktop = DesktopSnapshot {
            current: None,
            windows: vec![
                LocatedWindow {
                    window: first.window.clone(),
                    desktops: vec![VirtualDesktop {
                        id: "one".into(),
                        name: "Desktop 1".into(),
                    }],
                },
                LocatedWindow {
                    window: item("two", "Example - Google Chrome", 10).window,
                    desktops: vec![VirtualDesktop {
                        id: "two".into(),
                        name: "Desktop 2".into(),
                    }],
                },
            ],
        };
        let mut live = snapshot();
        live.windows[0].tabs = first.browser.as_ref().unwrap().tabs.clone();
        live.windows[0].tabs.push(Tab {
            url: "https://new.test/".into(),
            title: String::new(),
        });
        let mut other = live.windows[0].clone();
        other.id = 2;
        other.tabs = vec![Tab {
            url: "https://other.test/".into(),
            title: String::new(),
        }];
        live.windows.push(other);
        let locations = locations_for_workspace(&workspace, &HashMap::new(), &desktop);
        let location = selected_location(&locations, Some("one")).unwrap().unwrap();
        let updated = location_tab_updates(
            &workspace,
            location,
            &desktop,
            &CapturedSnapshots(vec![live]),
        );
        assert_eq!(updated.len(), 1);
        assert!(updated[0]
            .browser
            .tabs
            .iter()
            .any(|tab| tab.url == "https://new.test/"));
        assert!(
            location_tab_updates(
                &workspace,
                location,
                &desktop,
                &CapturedSnapshots::default()
            )
            .is_empty(),
            "saved tabs must not count as a new snapshot"
        );
    }
    #[test]
    fn desktop_update_matches_chromium_and_firefox_to_their_own_windows() {
        use crate::workspaces::{DesktopSnapshot, LocatedWindow, VirtualDesktop};
        let mut chrome = item("chrome", "Search - Google Chrome", 10);
        chrome.browser = Some(Browser {
            kind: BrowserKind::Chromium,
            profile_path: "chrome-profile".into(),
            tabs: vec![Tab {
                url: "https://chrome.test/old".into(),
                title: String::new(),
            }],
            ..Default::default()
        });
        let mut firefox = item("firefox", "Research - Mozilla Firefox", 900);
        firefox.window.app_id = "firefox.exe".into();
        firefox.window.path = "firefox.exe".into();
        firefox.browser = Some(Browser {
            kind: BrowserKind::Firefox,
            profile_path: "firefox-profile".into(),
            tabs: vec![Tab {
                url: "https://firefox.test/old".into(),
                title: String::new(),
            }],
            ..Default::default()
        });
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![chrome.clone(), firefox.clone()],
        };
        let desk = VirtualDesktop {
            id: "one".into(),
            name: "Desktop 1".into(),
        };
        let desktop = DesktopSnapshot {
            current: Some(desk.clone()),
            windows: vec![
                LocatedWindow {
                    window: chrome.window,
                    desktops: vec![desk.clone()],
                },
                LocatedWindow {
                    window: firefox.window,
                    desktops: vec![desk],
                },
            ],
        };
        let mut chrome_snapshot = snapshot();
        chrome_snapshot.profile_path = "chrome-profile".into();
        chrome_snapshot.windows[0].title = "Search".into();
        chrome_snapshot.windows[0].tabs[0].url = "https://chrome.test/new".into();
        let mut firefox_snapshot = snapshot();
        firefox_snapshot.browser = BrowserKind::Firefox;
        firefox_snapshot.profile_path = "firefox-profile".into();
        firefox_snapshot.windows[0].title = "Research".into();
        firefox_snapshot.windows[0].x = Some(900);
        firefox_snapshot.windows[0].tabs[0].url = "https://firefox.test/new".into();
        let locations = locations_for_workspace(&workspace, &HashMap::new(), &desktop);
        let location = selected_location(&locations, None).unwrap().unwrap();
        let updates = location_tab_updates(
            &workspace,
            location,
            &desktop,
            &CapturedSnapshots(vec![chrome_snapshot.clone(), firefox_snapshot.clone()]),
        );
        assert_eq!(updates.len(), 2);
        assert_eq!(
            updates
                .iter()
                .find(|update| update.index == 0)
                .unwrap()
                .browser
                .tabs[0]
                .url,
            "https://chrome.test/new"
        );
        assert_eq!(
            updates
                .iter()
                .find(|update| update.index == 1)
                .unwrap()
                .browser
                .tabs[0]
                .url,
            "https://firefox.test/new"
        );
        firefox_snapshot.profile_path = "another-firefox-profile".into();
        let updates = location_tab_updates(
            &workspace,
            location,
            &desktop,
            &CapturedSnapshots(vec![chrome_snapshot, firefox_snapshot]),
        );
        assert_eq!(updates.len(), 1);
        assert_eq!(
            updates[0].index, 0,
            "a different Firefox profile must keep its saved tabs"
        );
    }
    #[test]
    fn update_failure_distinguishes_no_response_from_an_unmatched_window() {
        let mut saved = item("firefox", "Browser - Mozilla Firefox", 10);
        saved.window.app_id = "firefox.exe".into();
        saved.window.path = "firefox.exe".into();
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![saved],
        };
        assert_eq!(
            tab_update_failure(&workspace, &CapturedSnapshots::default()),
            TabUpdateFailure::ExtensionDidNotRespond
        );
        assert_eq!(
            tab_update_failure(&workspace, &CapturedSnapshots(vec![snapshot()])),
            TabUpdateFailure::ExtensionDidNotRespond,
            "a different browser does not count as a response"
        );
        let mut firefox = snapshot();
        firefox.browser = BrowserKind::Firefox;
        assert_eq!(
            tab_update_failure(&workspace, &CapturedSnapshots(vec![firefox])),
            TabUpdateFailure::WindowNotMatched
        );
    }
    #[test]
    fn reopened_browser_can_be_found_on_another_desktop_only_with_strong_evidence() {
        use crate::workspaces::{DesktopSnapshot, LocatedWindow, VirtualDesktop};
        let mut saved = item("old", "Example - Google Chrome", 10);
        saved.browser = Some(Browser {
            kind: BrowserKind::Chromium,
            tabs: vec![
                Tab {
                    url: "https://one.test/".into(),
                    title: String::new(),
                },
                Tab {
                    url: "https://two.test/".into(),
                    title: String::new(),
                },
            ],
            active_tab: 1,
            ..Default::default()
        });
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![saved],
        };
        let desktop = DesktopSnapshot {
            current: Some(VirtualDesktop {
                id: "one".into(),
                name: "Desktop 1".into(),
            }),
            windows: vec![LocatedWindow {
                window: item("reopened", "Example - Google Chrome", 10).window,
                desktops: vec![VirtualDesktop {
                    id: "two".into(),
                    name: "Desktop 2".into(),
                }],
            }],
        };
        let mut live = snapshot();
        live.windows[0].tabs = workspace.items[0].browser.as_ref().unwrap().tabs.clone();
        let snapshots = CapturedSnapshots(vec![live.clone()]);
        let locations = browser_locations(&workspace, &HashMap::new(), &desktop, &snapshots);
        let location = selected_location(&locations, None).unwrap().unwrap();
        assert_eq!(location.summary.id, "two");
        assert_eq!(
            location_tab_updates(&workspace, location, &desktop, &snapshots).len(),
            1
        );
        live.windows[0].tabs[1].url = live.windows[0].tabs[0].url.clone();
        let weak = browser_locations(
            &workspace,
            &HashMap::new(),
            &desktop,
            &CapturedSnapshots(vec![live]),
        );
        assert!(
            selected_location(&weak, None).unwrap().is_none(),
            "one repeated URL is not enough to identify a restarted browser"
        );
    }
    #[test]
    fn workspace_associations_follow_current_desktop_and_moved_windows() {
        let association = |id: &str, window: &str| Active {
            id: id.into(),
            targets: vec![Some((window.into(), 1))],
            saved: vec![],
        };
        let entries = HashMap::from([
            ("desktop-one".into(), association("work", "one")),
            ("desktop-two".into(), association("home", "two")),
        ]);
        let one = item("one", "One - Google Chrome", 10).window;
        let two = item("two", "Two - Google Chrome", 900).window;
        assert_eq!(
            active_on_desktop(&entries, "desktop-one", &[one.clone()])
                .unwrap()
                .id,
            "work"
        );
        assert_eq!(
            active_on_desktop(&entries, "desktop-two", &[two.clone()])
                .unwrap()
                .id,
            "home"
        );
        assert_eq!(
            active_on_desktop(&entries, "desktop-three", &[one.clone()])
                .unwrap()
                .id,
            "work",
            "a moved window retains its workspace"
        );
        assert_eq!(
            active_on_desktop(&entries, "desktop-one", &[two.clone()])
                .unwrap()
                .id,
            "home",
            "a stale association does not hide the moved window"
        );
        assert!(
            active_on_desktop(&entries, "desktop-three", &[one.clone(), two.clone()]).is_none(),
            "different workspaces are ambiguous"
        );
        assert_eq!(
            active_on_desktop(&entries, "desktop-one", &[one.clone(), two])
                .unwrap()
                .id,
            "work",
            "an explicit workspace for this desktop wins"
        );
        let mut replacement = one;
        replacement.pid = 2;
        assert!(
            active_on_desktop(&entries, "desktop-one", &[replacement]).is_none(),
            "reused window IDs are not enough"
        );
        let shared = HashMap::from([
            ("desktop-one".into(), association("work", "one")),
            ("desktop-two".into(), association("work", "two")),
        ]);
        let one = item("one", "One - Google Chrome", 10).window;
        let two = item("two", "Two - Google Chrome", 900).window;
        assert_eq!(
            active_on_desktop(&shared, "desktop-one", &[one])
                .unwrap()
                .targets[0]
                .as_ref()
                .unwrap()
                .0,
            "one"
        );
        assert_eq!(
            active_on_desktop(&shared, "desktop-two", &[two])
                .unwrap()
                .targets[0]
                .as_ref()
                .unwrap()
                .0,
            "two"
        );
    }
    #[test]
    fn workspace_tab_refresh_uses_restored_targets_and_preserves_unmatched_windows() {
        let first = item("old-1", "Earlier title - Google Chrome", 10);
        let second = item("old-2", "Other - Google Chrome", 900);
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![first.clone(), second.clone()],
        };
        let restored = item("new-1", "Example - Google Chrome", 10);
        let active = Active {
            id: "work".into(),
            targets: vec![Some(("new-1".into(), 1)), None],
            saved: workspace
                .items
                .iter()
                .map(|item| {
                    (
                        item.window.id.clone(),
                        item.window.pid,
                        item.window.app_id.clone(),
                        item.window.desktop_id.clone(),
                    )
                })
                .collect(),
        };
        let updates = matching_workspace_tabs(
            &workspace,
            &[restored.window.clone()],
            &CapturedSnapshots(vec![snapshot()]),
            Some(&active),
        );
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].index, 0);
        assert_eq!(updates[0].browser.tabs[0].url, "https://example.test/");
        assert!(workspace.items[1].browser.is_none());
        assert!(matching_workspace_tabs(
            &workspace,
            &[restored.window],
            &CapturedSnapshots::default(),
            Some(&active)
        )
        .is_empty());
    }
    #[test]
    fn new_workspace_is_inferred_from_its_original_window_only_when_unique() {
        let captured = item("original", "Example - Google Chrome", 10);
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![captured.clone()],
        };
        let snapshots = CapturedSnapshots(vec![snapshot()]);
        let current = vec![captured.window.clone()];
        let (index, updates) =
            infer_workspace_tabs(&[workspace.clone()], &current, &snapshots, "windows").unwrap();
        assert_eq!(index, 0);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].browser.tabs[0].url, "https://example.test/");
        assert!(
            infer_workspace_tabs(
                &[workspace.clone(), workspace.clone()],
                &current,
                &snapshots,
                "windows"
            )
            .is_none(),
            "competing workspaces require a choice"
        );
        assert!(infer_workspace_tabs(&[workspace], &current, &snapshots, "linux").is_none());
    }
    #[test]
    fn reopened_window_needs_two_distinct_shared_web_urls() {
        let mut captured = item("old", "Example - Google Chrome", 10);
        captured.browser = Some(Browser {
            kind: BrowserKind::Chromium,
            tabs: vec![
                Tab {
                    url: "https://one.test/".into(),
                    title: String::new(),
                },
                Tab {
                    url: "https://two.test/".into(),
                    title: String::new(),
                },
            ],
            active_tab: 1,
            ..Default::default()
        });
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![captured],
        };
        let current = vec![item("new", "Example - Google Chrome", 10).window];
        let mut live = snapshot();
        live.windows[0].tabs = workspace.items[0].browser.as_ref().unwrap().tabs.clone();
        let snapshots = CapturedSnapshots(vec![live.clone()]);
        assert_eq!(
            infer_workspace_tabs(&[workspace.clone()], &current, &snapshots, "windows")
                .unwrap()
                .1
                .len(),
            1
        );
        assert!(infer_workspace_tabs(
            &[workspace.clone(), workspace.clone()],
            &current,
            &snapshots,
            "windows"
        )
        .is_none());
        live.windows[0].tabs[1].url = live.windows[0].tabs[0].url.clone();
        assert!(
            infer_workspace_tabs(
                &[workspace.clone()],
                &current,
                &CapturedSnapshots(vec![live.clone()]),
                "windows"
            )
            .is_none(),
            "duplicates are one piece of evidence"
        );
        live.profile_path = "different-profile".into();
        let mut different_profile = workspace;
        different_profile.items[0]
            .browser
            .as_mut()
            .unwrap()
            .profile_path = "saved-profile".into();
        assert!(infer_workspace_tabs(
            &[different_profile],
            &current,
            &CapturedSnapshots(vec![live]),
            "windows"
        )
        .is_none());
    }
    #[test]
    fn inferring_a_workspace_leaves_weakly_matched_windows_alone() {
        let first = item("first", "First - Google Chrome", 10);
        let second = item("old-second", "Second - Google Chrome", 900);
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![first.clone(), second],
        };
        let current = vec![
            first.window,
            item("new-second", "Second - Google Chrome", 900).window,
        ];
        let mut live = snapshot();
        live.windows[0].title = "First".into();
        let mut other = live.windows[0].clone();
        other.id = 2;
        other.title = "Second".into();
        other.x = Some(900);
        live.windows.push(other);
        let (_, updates) = infer_workspace_tabs(
            &[workspace],
            &current,
            &CapturedSnapshots(vec![live]),
            "windows",
        )
        .unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].index, 0);
    }
    #[test]
    fn workspace_tab_refresh_never_guesses_between_ambiguous_windows() {
        let one = item("1", "Example - Google Chrome", 10);
        let two = item("2", "Example - Google Chrome", 10);
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![one.clone(), two.clone()],
        };
        let current = vec![one.window, two.window];
        assert!(matching_workspace_tabs(
            &workspace,
            &current,
            &CapturedSnapshots(vec![snapshot()]),
            None
        )
        .is_empty());
    }
    #[test]
    fn workspace_tab_refresh_finds_one_reopened_browser_but_respects_its_profile() {
        let mut saved = item("old", "Before - Google Chrome", 10);
        saved.browser = Some(Browser {
            kind: BrowserKind::Chromium,
            profile_path: "work-profile".into(),
            tabs: vec![Tab {
                url: "https://old.test".into(),
                title: String::new(),
            }],
            active_tab: 1,
            ..Default::default()
        });
        let workspace = crate::workspaces::Workspace {
            id: "work".into(),
            name: "Work".into(),
            platform: "windows".into(),
            items: vec![saved],
        };
        let mut reopened = item("new", "Example - Google Chrome", 10).window;
        reopened.minimized = true;
        let mut live = snapshot();
        live.profile_path = "work-profile".into();
        let updates = matching_workspace_tabs(
            &workspace,
            &[reopened.clone()],
            &CapturedSnapshots(vec![live.clone()]),
            None,
        );
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].browser.tabs[0].url, "https://example.test/");
        live.profile_path = "other-profile".into();
        assert!(matching_workspace_tabs(
            &workspace,
            &[reopened],
            &CapturedSnapshots(vec![live]),
            None
        )
        .is_empty());
    }
    #[test]
    fn browser_windows_match_without_guessing_between_identical_titles() {
        let mut items = vec![
            item("1", "Example - Google Chrome", 10),
            item("2", "Example - Google Chrome", 900),
        ];
        let mut s = snapshot();
        assert_eq!(apply_snapshot(&mut items, &s), vec![0]);
        assert_eq!(
            items[0].browser.as_ref().unwrap().kind,
            BrowserKind::Chromium
        );
        assert!(items[1].browser.is_none());
        items[0].browser = None;
        s.windows[0].x = None;
        assert!(apply_snapshot(&mut items, &s).is_empty());
        assert!(!title_matches("Example extra - Google Chrome", "Example"));
    }
    #[test]
    fn saved_tab_overlap_breaks_ties_but_competing_windows_are_never_guessed() {
        let mut items = vec![
            item("1", "Example - Google Chrome", 10),
            item("2", "Example - Google Chrome", 10),
        ];
        items[0].browser = Some(Browser {
            kind: BrowserKind::Chromium,
            tabs: vec![Tab {
                url: "https://one.test".into(),
                title: String::new(),
            }],
            active_tab: 1,
            ..Default::default()
        });
        items[1].browser = Some(Browser {
            kind: BrowserKind::Chromium,
            tabs: vec![Tab {
                url: "https://two.test".into(),
                title: String::new(),
            }],
            active_tab: 1,
            ..Default::default()
        });
        let mut s = snapshot();
        s.windows[0].tabs[0].url = "https://two.test".into();
        assert_eq!(match_snapshot(&items, &s), vec![(1, 0)]);
        s.windows.push(s.windows[0].clone());
        assert!(
            match_snapshot(&items, &s).is_empty(),
            "two identical extension windows cannot both claim one saved window"
        );
    }
    #[test]
    fn workspace_window_prefers_the_browser_window_with_more_saved_tabs() {
        let mut items = vec![item("1", "Example - Google Chrome", 10)];
        items[0].browser = Some(Browser {
            kind: BrowserKind::Chromium,
            tabs: vec![
                Tab {
                    url: "https://one.test".into(),
                    title: String::new(),
                },
                Tab {
                    url: "https://two.test".into(),
                    title: String::new(),
                },
            ],
            active_tab: 1,
            ..Default::default()
        });
        let mut s = snapshot();
        s.windows[0].tabs = items[0].browser.as_ref().unwrap().tabs.clone();
        let mut other = s.windows[0].clone();
        other.id = 2;
        other.tabs.pop();
        s.windows.push(other);
        assert_eq!(match_snapshot(&items, &s), vec![(0, 0)]);
    }
    #[test]
    fn old_connection_config_defaults_to_no_live_sharing_and_tracks_each_desktop() {
        let mut config: Config =
            serde_json::from_str(r#"{"enabled":true,"port":1234,"token":"old"}"#).unwrap();
        assert!(!config.live);
        let active = |id: &str| Active {
            id: id.into(),
            targets: vec![],
            saved: vec![],
        };
        config.active.insert("desktop-one".into(), active("work"));
        config.active.insert("desktop-two".into(), active("home"));
        let restored: Config =
            serde_json::from_slice(&serde_json::to_vec(&config).unwrap()).unwrap();
        assert_eq!(restored.active["desktop-one"].id, "work");
        assert_eq!(restored.active["desktop-two"].id, "home");
    }
    #[test]
    fn prepared_extensions_refresh_only_owned_older_files_and_keep_their_identity() {
        let root =
            std::env::temp_dir().join(format!("warp-extension-update-{}", uuid::Uuid::new_v4()));
        let folder = root.join("chromium");
        assert!(sync_extension(&folder, "chromium", false)
            .unwrap()
            .is_none());
        assert!(!folder.exists());
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("manifest.json"),
            r#"{"name":"Window Warp","version":"0.1.0"}"#,
        )
        .unwrap();
        let first = sync_extension(&folder, "chromium", false).unwrap().unwrap();
        let expected: serde_json::Value =
            serde_json::from_str(extension_manifest("chromium").unwrap()).unwrap();
        assert_eq!(first.version, expected["version"].as_str().unwrap());
        assert!(folder.join("background.js").is_file());
        fs::write(folder.join("popup.js"), "local change").unwrap();
        let same = sync_extension(&folder, "chromium", false).unwrap().unwrap();
        assert_eq!(first.installation_id, same.installation_id);
        assert_eq!(
            fs::read_to_string(folder.join("popup.js")).unwrap(),
            "local change",
            "same-version files are not overwritten"
        );
        fs::write(
            folder.join("manifest.json"),
            r#"{"name":"Window Warp","version":"9.0"}"#,
        )
        .unwrap();
        assert!(
            sync_extension(&folder, "chromium", false)
                .unwrap()
                .is_none(),
            "a newer extension is never downgraded"
        );
        assert_eq!(
            fs::read_to_string(folder.join("popup.js")).unwrap(),
            "local change"
        );
        fs::write(
            folder.join("manifest.json"),
            r#"{"name":"Another extension","version":"0.1.0"}"#,
        )
        .unwrap();
        assert!(
            sync_extension(&folder, "chromium", false)
                .unwrap()
                .is_none(),
            "unrelated folders are not modified"
        );
        for name in [
            "manifest.json",
            "background.js",
            "popup.html",
            "popup.css",
            "popup.js",
            "icon.png",
            "warp-managed.json",
        ] {
            fs::remove_file(folder.join(name)).unwrap();
        }
        fs::remove_dir(folder).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn update_version_is_only_advertised_to_the_matching_prepared_extension() {
        let mut state = State::default();
        state.prepared.insert(
            "chromium".into(),
            PreparedExtension {
                installation_id: "owned".into(),
                version: "0.1.1".into(),
            },
        );
        let mut request: Request = serde_json::from_value(serde_json::json!({"token":"", "action":"poll", "browser":"chromium", "installationId":"owned"})).unwrap();
        assert_eq!(update_version(&state, &request), Some("0.1.1"));
        request.installation_id = "elsewhere".into();
        assert_eq!(update_version(&state, &request), None);
        request.installation_id = "owned".into();
        request.browser = BrowserKind::Firefox;
        assert_eq!(update_version(&state, &request), None);
    }
    #[test]
    fn snapshots_require_a_user_request_or_enabled_live_sharing() {
        let mut state = State::default();
        let mut request: Request = serde_json::from_value(serde_json::json!({"token":"", "action":"snapshot", "browser":"firefox", "clientId":"one", "live":true})).unwrap();
        assert!(!accepts_snapshot(&state, &request, "one"));
        state.config.live = true;
        assert!(accepts_snapshot(&state, &request, "one"));
        state.config.live = false;
        state.request_id = "requested".into();
        state.awaiting.insert("one".into());
        request.live = false;
        request.request_id = "requested".into();
        assert!(accepts_snapshot(&state, &request, "one"));
        assert!(!accepts_snapshot(&state, &request, "another"));
        state.request_id.clear();
        assert!(!accepts_snapshot(&state, &request, "one"));
        request.explicit = true;
        assert!(accepts_snapshot(&state, &request, "one"));
    }
    #[test]
    fn live_sharing_can_be_changed_for_one_browser_without_enabling_another() {
        let mut state = State::default();
        let request: Request = serde_json::from_value(
            serde_json::json!({"token":"", "action":"snapshot", "browser":"firefox", "live":true}),
        )
        .unwrap();
        state.config.live_clients.insert("one".into(), true);
        assert!(accepts_snapshot(&state, &request, "one"));
        assert!(!accepts_snapshot(&state, &request, "two"));
        state.config.live = true; // Preserve the old global opt-in until a client overrides it.
        state.config.live_clients.insert("one".into(), false);
        assert!(!accepts_snapshot(&state, &request, "one"));
        assert!(accepts_snapshot(&state, &request, "two"));
    }
    #[test]
    fn requesting_current_tabs_discards_stale_snapshots_when_no_extension_is_connected() {
        let bridge = Bridge::default();
        {
            let mut state = bridge.state.lock().unwrap();
            state.running = Some(Arc::new(AtomicBool::new(true)));
            state.snapshots.push(snapshot());
        }
        bridge.request_snapshots(Duration::from_millis(200), false);
        assert!(bridge.state.lock().unwrap().snapshots.is_empty());
    }
    #[test]
    fn explicit_saved_updates_wait_for_a_prepared_or_recent_extension() {
        let mut state = State::default();
        assert_eq!(snapshot_wait(&state, true), Duration::from_secs(8));
        state.prepared.insert(
            "firefox".into(),
            PreparedExtension {
                installation_id: "fixture".into(),
                version: "1".into(),
            },
        );
        assert_eq!(snapshot_wait(&state, true), IDLE_EXTENSION_WAIT);
        assert_eq!(
            snapshot_wait(&state, false),
            Duration::from_secs(8),
            "ordinary captures stay responsive"
        );
        state.prepared.clear();
        state.connections.push(Connection {
            client_id: "fixture".into(),
            browser: BrowserKind::Firefox,
            updated: Instant::now(),
            supports_focus: false,
        });
        assert_eq!(snapshot_wait(&state, true), IDLE_EXTENSION_WAIT);
        state.connections[0].updated = Instant::now() - Duration::from_secs(91);
        assert_eq!(snapshot_wait(&state, true), Duration::from_secs(8));
    }
    #[test]
    fn an_explicit_update_accepts_a_browser_that_wakes_after_the_request() {
        let bridge = Arc::new(Bridge::default());
        {
            let mut state = bridge.state.lock().unwrap();
            state.running = Some(Arc::new(AtomicBool::new(true)));
            state.connections.push(Connection {
                client_id: "late-browser".into(),
                browser: BrowserKind::Firefox,
                updated: Instant::now(),
                supports_focus: false,
            });
        }
        let waiting = bridge.clone();
        let (done, completed) = std::sync::mpsc::channel();
        let request = std::thread::spawn(move || {
            waiting.request_snapshots(Duration::from_secs(3), true);
            done.send(()).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        let request_id = loop {
            let mut state = bridge.state.lock().unwrap();
            if !state.request_id.is_empty() {
                break pending_snapshot_request(&mut state, "late-browser");
            }
            drop(state);
            assert!(Instant::now() < deadline, "request did not begin");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(!request_id.is_empty());
        let snapshot_request: Request = serde_json::from_value(serde_json::json!({"token":"", "action":"snapshot", "browser":"firefox", "clientId":"late-browser", "requestId":request_id})).unwrap();
        {
            let mut state = bridge.state.lock().unwrap();
            assert!(accepts_snapshot(&state, &snapshot_request, "late-browser"));
            state.snapshots.push(snapshot());
            state.awaiting.remove("late-browser");
            assert!(
                pending_snapshot_request(&mut state, "late-browser").is_empty(),
                "one browser answers only once"
            );
        }
        completed
            .recv_timeout(Duration::from_secs(1))
            .expect("return promptly after a late browser responds");
        request.join().unwrap();
        let mut state = bridge.state.lock().unwrap();
        assert_eq!(state.snapshots.len(), 1);
        assert!(
            pending_snapshot_request(&mut state, "unrequested").is_empty(),
            "no snapshot is requested at rest"
        );
    }
    #[test]
    fn discovery_allows_a_second_browser_profile_to_respond() {
        let bridge = Arc::new(Bridge::default());
        bridge.state.lock().unwrap().running = Some(Arc::new(AtomicBool::new(true)));
        let waiting = bridge.clone();
        let (done, completed) = std::sync::mpsc::channel();
        let request = std::thread::spawn(move || {
            waiting.request_snapshots(Duration::from_millis(500), true);
            done.send(()).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut state = bridge.state.lock().unwrap();
            if !state.request_id.is_empty() {
                assert!(!pending_snapshot_request(&mut state, "first").is_empty());
                state.snapshots.push(snapshot());
                state.awaiting.remove("first");
                break;
            }
            drop(state);
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            completed.recv_timeout(Duration::from_millis(100)).is_err(),
            "discovery should allow another profile to wake"
        );
        {
            let mut state = bridge.state.lock().unwrap();
            assert!(!pending_snapshot_request(&mut state, "second").is_empty());
            state.snapshots.push(snapshot());
            state.awaiting.remove("second");
        }
        completed.recv_timeout(Duration::from_secs(1)).unwrap();
        request.join().unwrap();
        assert_eq!(bridge.state.lock().unwrap().snapshots.len(), 2);
    }
    #[test]
    fn overlapping_capture_requests_keep_their_own_tab_snapshots() {
        let bridge = Arc::new(Bridge::default());
        {
            let mut state = bridge.state.lock().unwrap();
            state.running = Some(Arc::new(AtomicBool::new(true)));
            state.connections.push(Connection {
                client_id: "fixture".into(),
                browser: BrowserKind::Chromium,
                updated: Instant::now(),
                supports_focus: false,
            });
        }
        let wait_for_request = |previous: &str| {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let state = bridge.state.lock().unwrap();
                if !state.request_id.is_empty()
                    && state.request_id != previous
                    && state.awaiting.contains("fixture")
                {
                    return state.request_id.clone();
                }
                drop(state);
                assert!(Instant::now() < deadline, "browser request did not start");
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        let first_bridge = bridge.clone();
        let first = std::thread::spawn(move || first_bridge.capture_snapshots());
        let first_id = wait_for_request("");
        let second_bridge = bridge.clone();
        let second = std::thread::spawn(move || second_bridge.capture_snapshots());
        {
            let mut state = bridge.state.lock().unwrap();
            state.snapshots.push(snapshot());
            state.awaiting.remove("fixture");
        }
        let first_snapshots = first.join().unwrap();
        wait_for_request(&first_id);
        {
            let mut newer = snapshot();
            newer.windows[0].tabs[0].url = "https://newer.test/".into();
            let mut state = bridge.state.lock().unwrap();
            state.snapshots.push(newer);
            state.awaiting.remove("fixture");
        }
        let second_snapshots = second.join().unwrap();
        let mut first_item = vec![item("1", "Example - Google Chrome", 10)];
        let mut second_item = first_item.clone();
        first_snapshots.enrich(&mut first_item);
        second_snapshots.enrich(&mut second_item);
        assert_eq!(
            first_item[0].browser.as_ref().unwrap().tabs[0].url,
            "https://example.test/"
        );
        assert_eq!(
            second_item[0].browser.as_ref().unwrap().tabs[0].url,
            "https://newer.test/"
        );
    }
    #[test]
    fn recognizes_common_kde_chromium_desktop_ids() {
        for app_id in [
            "google-chrome",
            "google-chrome.desktop",
            "chromium-browser",
            "org.chromium.Chromium",
            "microsoft-edge",
            "brave-browser",
        ] {
            let mut window = item("1", "Example - Browser", 0);
            window.window.app_id = app_id.into();
            assert!(app_is_browser(&window, BrowserKind::Chromium), "{app_id}");
        }
    }
    #[test]
    fn imported_browser_without_a_window_id_can_still_be_chosen_manually() {
        let window = item("", "Browser", 0);
        assert!(is_browser_kind(&window, BrowserKind::Chromium));
        assert!(!app_is_browser(&window, BrowserKind::Chromium));
    }
    #[test]
    fn known_different_profile_is_never_overwritten() {
        let mut items = vec![item("1", "Example - Google Chrome", 10)];
        items[0].browser = Some(Browser {
            kind: BrowserKind::Chromium,
            profile_path: "/profiles/one".into(),
            active_tab: 1,
            ..Default::default()
        });
        let mut s = snapshot();
        s.profile_path = "/profiles/two".into();
        assert!(apply_snapshot(&mut items, &s).is_empty());
        assert_eq!(
            items[0].browser.as_ref().unwrap().profile_path,
            "/profiles/one"
        );
    }
    #[test]
    fn request_parser_requires_a_browser_extension_origin() {
        fn parse(origin: &str) -> Result<(Option<String>, Vec<u8>), String> {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let origin = origin.to_string();
            let worker = std::thread::spawn(move || {
                let mut stream = TcpStream::connect(address).unwrap();
                write!(
                    stream,
                    "POST /bridge HTTP/1.1\r\nOrigin: {origin}\r\nContent-Length: 2\r\n\r\n{{}}"
                )
                .unwrap();
            });
            let (mut stream, _) = listener.accept().unwrap();
            let result = read_request(&mut stream);
            worker.join().unwrap();
            result
        }
        assert!(parse("chrome-extension://abc123").is_ok());
        assert!(parse("moz-extension://abc-123").is_ok());
        assert!(parse("https://example.test").is_err());
    }
}
