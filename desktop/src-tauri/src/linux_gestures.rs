//! KGlobalAccel owns key state on Wayland. Its signals provide press/release;
//! the KWin callback supplies the pointer before asynchronous dispatch can move it.
use crate::{
    config::{Binding, Config, Settings},
    gesture::{Action, Press},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Point {
    x: i32,
    y: i32,
}
enum Event {
    Key {
        id: String,
        pressed: bool,
        at: Instant,
    },
    Pointer {
        id: String,
        point: Point,
    },
    Configure(Option<Config>, mpsc::SyncSender<Result<(), String>>),
    Failed(String),
    Stop,
}
struct Running {
    sender: mpsc::Sender<Event>,
    alive: Arc<AtomicBool>,
    connection: zbus::blocking::Connection,
    reader: JoinHandle<()>,
    worker: JoinHandle<()>,
}
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

/// Called only by the authenticated local KWin endpoint, not the editor.
pub fn pointer(id: &str, payload: &str) {
    let Ok(point) = serde_json::from_str::<Point>(payload) else {
        return;
    };
    if let Ok(running) = RUNNING.lock() {
        if let Some(running) = running.as_ref() {
            let _ = running.sender.send(Event::Pointer {
                id: id.into(),
                point,
            });
        }
    }
}

pub fn stop() -> Result<(), String> {
    let running = RUNNING.lock().map_err(|e| e.to_string())?.take();
    if let Some(running) = running {
        running.alive.store(false, Ordering::SeqCst);
        let _ = running.sender.send(Event::Stop);
        let closed = running.connection.close().map_err(|e| e.to_string());
        let reader = running
            .reader
            .join()
            .map_err(|_| "KDE key listener stopped unexpectedly.");
        let worker = running
            .worker
            .join()
            .map_err(|_| "KDE hold worker stopped unexpectedly.");
        closed?;
        reader?;
        worker?;
    }
    Ok(())
}

/// Hook names are derived from canonical shortcut bytes, not config row indices.
/// The same physical chord therefore keeps its cancellation guard across edits.
fn script_name(shortcut: &str) -> String {
    format!(
        "window-warp-gesture-{}",
        shortcut
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}
pub(crate) fn owns_script(name: &str) -> bool {
    name.strip_prefix("window-warp-gesture-")
        .is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix.len() % 2 == 0
                && suffix.bytes().all(|b| b.is_ascii_hexdigit())
        })
}

pub fn start(app: &AppHandle, config: &Config) -> Result<(), String> {
    let failed = RUNNING
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .is_some_and(|r| r.reader.is_finished() || r.worker.is_finished());
    if failed {
        stop()?;
    }
    let sender = {
        let mut current = RUNNING.lock().map_err(|e| e.to_string())?;
        if current.is_none() {
            *current = Some(new_running(app)?);
        }
        current.as_ref().unwrap().sender.clone()
    };
    configure(&sender, Some(config.clone()))
}

/// Returns false only before the first activation (startup crash cleanup).
pub fn pause() -> Result<bool, String> {
    let sender = RUNNING
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|r| r.sender.clone());
    if let Some(sender) = sender {
        configure(&sender, None)?;
        Ok(true)
    } else {
        Ok(false)
    }
}
fn configure(sender: &mpsc::Sender<Event>, config: Option<Config>) -> Result<(), String> {
    let (reply, result) = mpsc::sync_channel(1);
    sender
        .send(Event::Configure(config, reply))
        .map_err(|_| "KDE gesture worker stopped.")?;
    result
        .recv()
        .map_err(|_| "KDE gesture worker stopped before activation completed.")?
}
fn new_running(app: &AppHandle) -> Result<Running, String> {
    let connection = zbus::blocking::connection::Builder::session()
        .map_err(|e| e.to_string())?
        .method_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender("org.kde.kglobalaccel")
        .map_err(|e| e.to_string())?
        .path("/component/kwin")
        .map_err(|e| e.to_string())?
        .interface("org.kde.kglobalaccel.Component")
        .map_err(|e| e.to_string())?
        .build();
    let messages = zbus::blocking::MessageIterator::for_match_rule(rule, &connection, Some(256))
        .map_err(|e| e.to_string())?;
    let (sender, receiver) = mpsc::channel();
    let alive = Arc::new(AtomicBool::new(true));
    let worker_app = app.clone();
    let worker = std::thread::Builder::new()
        .name("kde-hold-actions".into())
        .spawn(move || run(&worker_app, receiver))
        .map_err(|e| e.to_string())?;
    let (events, reader_alive) = (sender.clone(), alive.clone());
    let reader = std::thread::Builder::new()
        .name("kde-shortcut-signals".into())
        .spawn(move || {
            for message in messages {
                if !reader_alive.load(Ordering::SeqCst) {
                    return;
                }
                let message = match message {
                    Ok(message) => message,
                    Err(error) => {
                        let _ = events.send(Event::Failed(format!(
                            "KDE shortcut connection failed: {error}"
                        )));
                        return;
                    }
                };
                let pressed = match message.header().member().map(|m| m.as_str()) {
                    Some("globalShortcutPressed") => true,
                    Some("globalShortcutReleased") => false,
                    _ => continue,
                };
                match message.body().deserialize::<(String, String, i64)>() {
                    Ok((component, native_id, _)) if component == "kwin" => {
                        if !owns_script(&native_id) {
                            continue;
                        }
                        let _ = events.send(Event::Key {
                            id: native_id,
                            pressed,
                            at: Instant::now(),
                        });
                    }
                    Ok(_) => {}
                    Err(error) => {
                        let _ = events.send(Event::Failed(format!(
                            "Cannot read KDE shortcut event: {error}"
                        )));
                        return;
                    }
                }
            }
            if reader_alive.load(Ordering::SeqCst) {
                let _ = events.send(Event::Failed("KDE shortcut connection closed.".into()));
            }
        });
    let reader = match reader {
        Ok(reader) => reader,
        Err(error) => {
            alive.store(false, Ordering::SeqCst);
            let _ = sender.send(Event::Stop);
            let _ = worker.join();
            return Err(format!("Cannot start KDE key listener: {error}"));
        }
    };
    Ok(Running {
        sender,
        alive,
        connection,
        reader,
        worker,
    })
}

#[derive(Clone, PartialEq)]
struct Desired {
    binding: Binding,
    settings: Settings,
}
struct Slot {
    spec: Desired,
    callback: String,
    pending: Option<Pending>,
}
struct Pending {
    press: Press,
    started: Instant,
    native_pressed: bool,
    released: bool,
    point: Option<Point>,
    held: bool,
    cancelled: bool,
}
impl Pending {
    fn new(settings: &Settings, at: Instant, cancelled: bool) -> Self {
        Self {
            press: Press::new(settings.hold_delay_ms, settings.hold_tile_enabled),
            started: at,
            native_pressed: false,
            released: false,
            point: None,
            held: false,
            cancelled,
        }
    }
    fn deadline(&self, settings: &Settings) -> Option<Instant> {
        if self.cancelled && self.native_pressed {
            return None;
        }
        if !self.native_pressed || self.point.is_none() {
            Some(self.started + Duration::from_secs(5))
        } else if settings.hold_tile_enabled && !self.held {
            Some(self.started + Duration::from_millis(settings.hold_delay_ms))
        } else {
            None
        }
    }
    fn action(&mut self) -> Option<Action> {
        if self.cancelled {
            None
        } else {
            self.press.advance(self.started.elapsed(), !self.released)
        }
    }
}
struct Controller {
    desired: Option<Config>,
    slots: HashMap<String, Slot>,
}
impl Controller {
    fn configure(&mut self, app: &AppHandle, config: Option<Config>) -> Result<(), String> {
        // Cancel before any native hook is removed. Already-held hooks remain
        // installed solely to observe release, including across a later resume.
        for slot in self.slots.values_mut() {
            if let Some(pending) = &mut slot.pending {
                pending.cancelled = true;
            }
        }
        self.desired = config;
        let result = (|| {
            self.reconcile(app)?;
            if let Some(config) = &self.desired {
                crate::linux_control::request(app, serde_json::json!({"kind":"reset-app-pulls"}))?;
                crate::platform::enable_window_actions(app, config)
            } else {
                crate::platform::disable_window_actions()
            }
        })();
        if let Err(error) = result {
            self.desired = None;
            let cleanup = self
                .reconcile(app)
                .and_then(|_| crate::platform::disable_window_actions());
            return Err(format!(
                "{error}{}",
                cleanup
                    .err()
                    .map(|e| format!("; cleanup: {e}"))
                    .unwrap_or_default()
            ));
        }
        Ok(())
    }
    fn reconcile(&mut self, app: &AppHandle) -> Result<(), String> {
        let desired: HashMap<_, _> = self
            .desired
            .as_ref()
            .map(|config| {
                config
                    .bindings
                    .iter()
                    .filter(|b| b.enabled && b.action == "pull-app")
                    .map(|b| {
                        (
                            script_name(&b.shortcut),
                            Desired {
                                binding: b.clone(),
                                settings: config.settings.clone(),
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let obsolete: Vec<_> = self
            .slots
            .iter()
            .filter(|(id, slot)| slot.pending.is_none() && desired.get(*id) != Some(&slot.spec))
            .map(|(id, _)| id.clone())
            .collect();
        for id in obsolete {
            crate::platform::unload_script(&id)?;
            self.slots.remove(&id);
        }
        for (id, spec) in desired {
            if self.slots.contains_key(&id) {
                continue;
            }
            let callback = uuid::Uuid::new_v4().to_string();
            let config = Config {
                version: 1,
                bindings: vec![spec.binding.clone()],
                settings: spec.settings.clone(),
            };
            let source = format!(
                "var WARP_HOLD_IDS = {};\nvar WARP_HOLD_NATIVE_IDS = {};\n{}",
                serde_json::json!([callback]),
                serde_json::json!([id]),
                crate::platform::shortcut_source(app, &config)?
            );
            crate::platform::load_script(app, &id, &format!("{id}.js"), &source)?;
            self.slots.insert(
                id,
                Slot {
                    spec,
                    callback,
                    pending: None,
                },
            );
        }
        Ok(())
    }
    fn finish(&mut self, app: &AppHandle) {
        self.desired = None;
        for (id, _) in self.slots.drain() {
            if let Err(error) = crate::platform::unload_script(&id) {
                let _ = app.emit("warp-error", error);
            }
        }
        if let Err(error) = crate::platform::disable_window_actions() {
            let _ = app.emit("warp-error", error);
        }
    }
    fn advance(&mut self, app: &AppHandle) -> Result<(), String> {
        let mut released_guards = Vec::new();
        for (id, slot) in &mut self.slots {
            let Some(p) = slot.pending.as_mut() else {
                continue;
            };
            if p.cancelled && p.released {
                slot.pending = None;
                released_guards.push(id.clone());
                continue;
            }
            if p.cancelled && p.native_pressed {
                continue;
            }
            if !p.native_pressed || p.point.is_none() {
                if p.started.elapsed() >= Duration::from_secs(5) {
                    if p.native_pressed {
                        let _ = app.emit("warp-error", "KWin did not provide the app shortcut's pointer position. Pause and enable shortcuts to retry.");
                    }
                    slot.pending = None;
                    released_guards.push(id.clone());
                }
                continue;
            }
            if let Some(action) = p.action() {
                p.held = action == Action::Hold;
                let pointer = if p.held { p.point } else { None };
                if let Err(error) = crate::linux_control::request(
                    app,
                    serde_json::json!({
                        "kind":"app-pull", "binding":slot.spec.binding, "settings":slot.spec.settings, "pointer":pointer
                    }),
                ) {
                    let _ = app.emit("warp-error", error);
                    p.cancelled = true;
                }
            }
            if p.press.finished() {
                slot.pending = None;
            }
        }
        if !released_guards.is_empty() {
            self.reconcile(app)?;
            // An edit can assign a guarded chord to a non-gesture action.
            // Re-register those actions after the old chord releases its key.
            if let Some(config) = &self.desired {
                let reassigned: Vec<_> = config
                    .bindings
                    .iter()
                    .filter(|b| {
                        b.enabled
                            && b.action != "pull-app"
                            && released_guards.contains(&script_name(&b.shortcut))
                    })
                    .collect();
                if reassigned.iter().any(|b| b.action == "toggle-pause") {
                    crate::platform::configure_pause(app, config)?;
                }
                if reassigned.iter().any(|b| b.action != "toggle-pause") {
                    crate::platform::enable_window_actions(app, config)?;
                }
            }
        }
        Ok(())
    }
}
fn report_failure(app: &AppHandle, message: String) {
    let _ = app.emit("warp-error", message);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = crate::set_enabled_blocking(app.clone(), false) {
            let _ = app.emit("warp-error", error);
        }
        crate::show(&app);
    });
}
fn run(app: &AppHandle, receiver: mpsc::Receiver<Event>) {
    let mut state = Controller {
        desired: None,
        slots: HashMap::new(),
    };
    loop {
        let deadline = state
            .slots
            .values()
            .filter_map(|s| {
                s.pending
                    .as_ref()
                    .and_then(|p| p.deadline(&s.spec.settings))
            })
            .min();
        let received = match deadline {
            Some(deadline) => {
                receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            }
            None => receiver
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        let mut events = Vec::new();
        match received {
            Ok(event) => events.push(event),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                state.finish(app);
                return;
            }
        }
        events.extend(receiver.try_iter());
        for event in events {
            match event {
                Event::Stop => {
                    state.finish(app);
                    return;
                }
                Event::Configure(config, reply) => {
                    let _ = reply.send(state.configure(app, config));
                }
                Event::Failed(message) => {
                    state.finish(app);
                    report_failure(app, message);
                }
                Event::Key { id, pressed, at } => {
                    if let Some(slot) = state.slots.get_mut(&id) {
                        if pressed {
                            let p = slot.pending.get_or_insert_with(|| {
                                Pending::new(&slot.spec.settings, at, state.desired.is_none())
                            });
                            if !p.native_pressed {
                                p.native_pressed = true;
                                p.started = at;
                            }
                        } else if let Some(p) = slot.pending.as_mut() {
                            p.released = true;
                        }
                    }
                }
                Event::Pointer { id, point } => {
                    if let Some(slot) = state.slots.values_mut().find(|s| s.callback == id) {
                        slot.pending
                            .get_or_insert_with(|| {
                                Pending::new(
                                    &slot.spec.settings,
                                    Instant::now(),
                                    state.desired.is_none(),
                                )
                            })
                            .point
                            .get_or_insert(point);
                    }
                }
            }
        }
        if let Err(error) = state.advance(app) {
            state.finish(app);
            report_failure(app, error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_survives_deadline_and_has_no_action_on_release() {
        let mut p = Pending::new(
            &Settings::default(),
            Instant::now() - Duration::from_secs(10),
            true,
        );
        p.native_pressed = true;
        p.point = Some(Point { x: 1, y: 2 });
        assert!(p.deadline(&Settings::default()).is_none());
        assert_eq!(p.action(), None);
        p.released = true;
        assert_eq!(p.action(), None);
    }
    #[test]
    fn hook_identity_tracks_the_chord_and_cannot_name_an_unrelated_script() {
        assert_eq!(script_name("Ctrl+J"), script_name("Ctrl+J"));
        assert_ne!(script_name("Ctrl+J"), script_name("Ctrl+K"));
        assert!(owns_script(&script_name("Super+BracketLeft")));
        for foreign in [
            "window-warp-session",
            "window-warp-gesture-",
            "window-warp-gesture-../file",
            "window-warp-gesture-0",
        ] {
            assert!(!owns_script(foreign));
        }
    }
}
