//! The KWin companion joins actual shortcut activation with physical key lifetime.
use crate::{
    config::{Binding, Config, Settings},
    gesture::Action,
    linux_physical::{qt_shortcut, Cycle},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
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
#[derive(Clone, Deserialize)]
struct Capture {
    x: i32,
    y: i32,
    previous: Option<crate::retile::Target>,
    at: u64,
}
enum Event {
    Physical {
        id: String,
        generation: String,
        cycle: u64,
        phase: Phase,
    },
    Configure(Option<Config>, mpsc::SyncSender<Result<(), String>>),
    Failed(String),
    Stop,
}
enum Phase {
    Down(Capture),
    Up,
    Cancel,
}
struct Running {
    sender: mpsc::Sender<Event>,
    alive: Arc<AtomicBool>,
    connection: zbus::blocking::Connection,
    reader: JoinHandle<()>,
    worker: JoinHandle<()>,
}
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

/// Called only by the authenticated, ordered companion endpoint.
pub fn physical_key(generation: &str, id: &str, phase: &str, cycle: u64, payload: &str) {
    let phase = match phase {
        "down" if payload.len() <= 4096 => serde_json::from_str::<Capture>(payload)
            .ok()
            .map(Phase::Down),
        "up" => Some(Phase::Up),
        "cancel" => Some(Phase::Cancel),
        _ => None,
    };
    if let Ok(running) = RUNNING.lock() {
        if let Some(running) = running.as_ref() {
            let event = match phase {
                Some(phase) if cycle > 0 => Event::Physical { id:id.into(), generation:generation.into(), cycle, phase },
                _ => Event::Failed("The KDE physical-key companion sent an invalid event. Install the matching companion package.".into()),
            };
            let _ = running.sender.send(event);
        }
    }
}
// Old scripts cannot establish a physical cycle during registration replacement.
pub fn pointer(_: &str, _: &str) {}

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
        .sender("org.freedesktop.DBus")
        .map_err(|e| e.to_string())?
        .path("/org/freedesktop/DBus")
        .map_err(|e| e.to_string())?
        .interface("org.freedesktop.DBus")
        .map_err(|e| e.to_string())?
        .member("NameOwnerChanged")
        .map_err(|e| e.to_string())?
        .arg(0, crate::linux_control::COMPANION_SERVICE)
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
                match message.body().deserialize::<(String, String, String)>() {
                    Ok((service, old_owner, _)) if service == crate::linux_control::COMPANION_SERVICE && !old_owner.is_empty() => {
                        let _ = events.send(Event::Failed("The KDE physical-key companion stopped. Shortcuts were paused; enable them again after restoring the matching companion.".into()));
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
    generation: String,
}
struct Slot {
    spec: Desired,
    pending: BTreeMap<u64, Pending>,
    // Callbacks use one native connection and ordered endpoint dispatch. A down
    // with a retired cycle ID is a duplicate, never a new physical press.
    last_cycle: u64,
}
struct Pending {
    cycle: Cycle<Capture>,
    picker: Option<crate::radial::Picker>,
    picker_next: Option<Instant>,
}
impl Pending {
    fn deadline(&self) -> Option<Instant> {
        self.cycle
            .deadline()
            .into_iter()
            .chain(self.picker_next)
            .min()
    }
}

struct Controller {
    desired: Option<Config>,
    slots: HashMap<String, Slot>,
}
impl Controller {
    fn configure(&mut self, app: &AppHandle, config: Option<Config>) -> Result<(), String> {
        // The companion owns base-key-up guards across generations. Rust may
        // discard old cycles immediately, including any visible picker.
        for slot in self.slots.values_mut() {
            slot.pending.clear();
        }
        let session = crate::linux_control::configure_session(app, config.is_some());
        self.desired = config;
        if self.desired.is_none() {
            let reconcile = self.reconcile(app);
            let disable = crate::platform::disable_window_actions();
            return combined([session, reconcile, disable]);
        }
        let result = session.and_then(|_| {
            let bindings: Vec<_> = self.desired.as_ref().unwrap().bindings.iter()
                .filter(|b| b.enabled && b.action == "pull-app")
                .map(|b| serde_json::json!({"id":script_name(&b.shortcut), "shortcut":qt_shortcut(&b.shortcut)}))
                .collect();
            crate::linux_control::configure_physical(app, serde_json::json!(bindings))?;
            self.reconcile(app)?;
            crate::platform::enable_window_actions(app, self.desired.as_ref().unwrap())
        });
        if let Err(error) = result {
            self.desired = None;
            let cancel = crate::linux_control::configure_session(app, false);
            let reconcile = self.reconcile(app);
            let disable = crate::platform::disable_window_actions();
            return combined([Err(error), cancel, reconcile, disable]);
        }
        Ok(())
    }
    fn reconcile(&mut self, app: &AppHandle) -> Result<(), String> {
        let generation = if self.desired.is_some() {
            crate::linux_control::descriptor(app)?["generation"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        } else {
            String::new()
        };
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
                                generation: generation.clone(),
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let obsolete: Vec<_> = self
            .slots
            .iter()
            .filter(|(id, slot)| desired.get(*id) != Some(&slot.spec))
            .map(|(id, _)| id.clone())
            .collect();
        let mut errors = Vec::new();
        for id in obsolete {
            match crate::platform::unload_script(&id) {
                Ok(()) => {
                    self.slots.remove(&id);
                }
                Err(error) => errors.push(error),
            }
        }
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
        for (id, spec) in desired {
            if self.slots.contains_key(&id) {
                continue;
            }
            let config = Config {
                version: 1,
                bindings: vec![spec.binding.clone()],
                settings: spec.settings.clone(),
            };
            let source = format!(
                "var WARP_HOLD_IDS = [true];\nvar WARP_HOLD_NATIVE_IDS = {};\n{}",
                serde_json::json!([id]),
                crate::platform::shortcut_source(app, &config)?
            );
            crate::platform::load_script(app, &id, &format!("{id}.js"), &source)?;
            self.slots.insert(
                id,
                Slot {
                    spec,
                    pending: BTreeMap::new(),
                    last_cycle: 0,
                },
            );
        }
        Ok(())
    }
    fn finish(&mut self, app: &AppHandle) {
        self.desired = None;
        if let Err(error) = crate::linux_control::configure_session(app, false) {
            let _ = app.emit("warp-error", error);
        }
        for (id, _) in self.slots.drain() {
            if let Err(error) = crate::platform::unload_script(&id) {
                let _ = app.emit("warp-error", error);
            }
        }
        if let Err(error) = crate::platform::disable_window_actions() {
            let _ = app.emit("warp-error", error);
        }
    }
    fn physical(&mut self, id: &str, generation: &str, number: u64, phase: Phase) {
        let Some(slot) = self
            .slots
            .get_mut(id)
            .filter(|s| s.spec.generation == generation)
        else {
            return;
        };
        if self.desired.is_none() {
            return;
        }
        match phase {
            Phase::Down(capture) => {
                if number <= slot.last_cycle {
                    return;
                }
                slot.last_cycle = number;
                let now = Instant::now();
                let wall = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let age = Duration::from_millis(wall.saturating_sub(capture.at));
                let started = now.checked_sub(age).unwrap_or(now);
                let mut cycle = Cycle::new(
                    slot.spec.settings.hold_delay_ms,
                    slot.spec.settings.hold_tile_enabled,
                    started,
                    capture,
                );
                if crate::retile::fire(&slot.spec.binding.shortcut) {
                    cycle.cancel();
                }
                slot.pending.insert(
                    number,
                    Pending {
                        cycle,
                        picker: None,
                        picker_next: None,
                    },
                );
            }
            Phase::Up | Phase::Cancel => {
                if let Some(p) = slot.pending.get_mut(&number) {
                    let cancelled = matches!(phase, Phase::Cancel);
                    p.cycle.release(cancelled);
                    if cancelled {
                        p.picker = None;
                        p.picker_next = None;
                    }
                }
            }
        }
    }
    fn next_pending(&self, now: Instant) -> Option<(String, u64)> {
        self.slots
            .iter()
            .flat_map(|(id, slot)| {
                slot.pending.iter().filter_map(move |(number, p)| {
                    p.deadline()
                        .filter(|deadline| *deadline <= now)
                        .map(|deadline| (deadline, id.clone(), *number))
                })
            })
            .min_by_key(|(deadline, _, _)| *deadline)
            .map(|(_, id, number)| (id, number))
    }
    fn advance(&mut self, app: &AppHandle) -> Result<(), String> {
        for slot in self.slots.values_mut() {
            if !crate::linux_control::generation_active(app, &slot.spec.generation) {
                slot.pending.clear();
            } else {
                slot.pending.retain(|_, p| !p.cycle.finished());
            }
        }
        let Some((id, number)) = self.next_pending(Instant::now()) else {
            return Ok(());
        };
        let slot = self.slots.get_mut(&id).unwrap();
        let p = slot.pending.get_mut(&number).unwrap();
        // At most one action/picker operation may block per turn. The outer
        // loop drains physical releases before advancing any other due cycle.
        if let Some(action) = p.cycle.advance(Instant::now()) {
            let held = action == Action::Hold;
            let capture = p.cycle.capture();
            let pointer = held.then_some(Point {
                x: capture.x,
                y: capture.y,
            });
            let result = (|| -> Result<(), String> {
                if held && slot.spec.settings.hold_mode == "radial" {
                    p.picker = crate::radial::Picker::open_for_window(
                        app,
                        &slot.spec.binding,
                        crate::radial::Point {
                            x: capture.x,
                            y: capture.y,
                        },
                        capture.previous.as_ref(),
                    )?;
                    if p.picker.is_some() {
                        p.picker_next = Some(Instant::now() + Duration::from_millis(25));
                        return Ok(());
                    }
                }
                crate::linux_control::input_request(
                    app,
                    serde_json::json!({
                        "kind":"app-pull", "binding":slot.spec.binding, "settings":slot.spec.settings,
                        "pointer":pointer, "previous":capture.previous, "window":capture.previous
                    }),
                    Some(&slot.spec.generation),
                )?;
                Ok(())
            })();
            if let Err(error) = result {
                let _ = app.emit("warp-error", error);
                p.cycle.cancel();
                p.picker = None;
                p.picker_next = None;
            }
        } else if let Some(picker) = p.picker.as_ref() {
            if !picker.update()? {
                p.picker = None;
                p.picker_next = None;
            } else if p.cycle.released() {
                p.picker
                    .take()
                    .unwrap()
                    .release(&slot.spec.binding, &slot.spec.settings)?;
                p.picker_next = None;
            } else {
                p.picker_next = Some(Instant::now() + Duration::from_millis(25));
            }
        }
        if p.cycle.finished() {
            slot.pending.remove(&number);
        }
        Ok(())
    }
}
fn combined<const N: usize>(results: [Result<(), String>; N]) -> Result<(), String> {
    let errors: Vec<_> = results.into_iter().filter_map(Result::err).collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
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
            .flat_map(|s| s.pending.values())
            .filter_map(Pending::deadline)
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
                    if state.desired.as_ref().is_some_and(|config| {
                        config
                            .bindings
                            .iter()
                            .any(|b| b.enabled && b.action == "pull-app")
                    }) {
                        state.finish(app);
                        report_failure(app, message);
                    }
                }
                Event::Physical {
                    id,
                    generation,
                    cycle,
                    phase,
                } => state.physical(&id, &generation, cycle, phase),
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
    fn cycle_controller() -> (Controller, String) {
        let mut config = Config::default();
        config.bindings.truncate(1);
        config.bindings[0].action = "pull-app".into();
        let id = script_name(&config.bindings[0].shortcut);
        let slot = Slot {
            spec: Desired {
                binding: config.bindings[0].clone(),
                settings: config.settings.clone(),
                generation: "current".into(),
            },
            pending: BTreeMap::new(),
            last_cycle: 0,
        };
        (
            Controller {
                desired: Some(config),
                slots: HashMap::from([(id.clone(), slot)]),
            },
            id,
        )
    }
    fn accepted(x: i32) -> Phase {
        Phase::Down(Capture {
            x,
            y: 0,
            previous: None,
            at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
        })
    }
    #[test]
    fn rapid_same_chord_cycles_keep_capture_and_release_identity() {
        let (mut state, id) = cycle_controller();
        state.physical(&id, "current", 1, accepted(1));
        state.physical(&id, "current", 1, Phase::Up);
        state.physical(&id, "current", 2, accepted(2));
        state.physical(&id, "current", 1, accepted(99));
        state.physical(&id, "current", 1, Phase::Up);
        let slot = state.slots.get_mut(&id).unwrap();
        assert_eq!(slot.pending.len(), 2);
        assert_eq!(slot.pending[&1].cycle.capture().x, 1);
        assert_eq!(slot.pending[&2].cycle.capture().x, 2);
        assert!(slot.pending[&1].cycle.released());
        assert!(!slot.pending[&2].cycle.released());
        assert_eq!(
            slot.pending
                .get_mut(&1)
                .unwrap()
                .cycle
                .advance(Instant::now() + Duration::from_secs(1)),
            Some(Action::Tap)
        );
        slot.pending.remove(&1);
        state.physical(&id, "current", 1, accepted(99));
        assert!(!state.slots[&id].pending.contains_key(&1));
    }
    #[test]
    fn stale_generation_and_cancel_cannot_trigger_a_reassigned_cycle() {
        let (mut state, id) = cycle_controller();
        state.physical(&id, "previous", 1, accepted(1));
        assert!(state.slots[&id].pending.is_empty());
        state.physical(&id, "current", 2, accepted(2));
        state.physical(&id, "previous", 2, Phase::Up);
        assert!(!state.slots[&id].pending[&2].cycle.released());
        state.physical(&id, "current", 2, Phase::Cancel);
        let pending = state
            .slots
            .get_mut(&id)
            .unwrap()
            .pending
            .get_mut(&2)
            .unwrap();
        assert_eq!(
            pending
                .cycle
                .advance(Instant::now() + Duration::from_secs(1)),
            None
        );
        assert!(pending.cycle.finished());
    }
    #[test]
    fn release_queued_during_another_action_is_applied_before_the_next_due_cycle() {
        let (mut state, first) = cycle_controller();
        let mut spec = state.slots[&first].spec.clone();
        spec.binding.shortcut = "Ctrl+Alt+K".into();
        let second = script_name(&spec.binding.shortcut);
        state.slots.insert(
            second.clone(),
            Slot {
                spec,
                pending: BTreeMap::new(),
                last_cycle: 0,
            },
        );
        let mut down = match accepted(1) {
            Phase::Down(capture) => capture,
            _ => unreachable!(),
        };
        down.at -= 600;
        state.physical(&first, "current", 1, Phase::Down(down));
        assert_eq!(state.next_pending(Instant::now()), Some((first.clone(), 1)));
        assert_eq!(
            state
                .slots
                .get_mut(&first)
                .unwrap()
                .pending
                .get_mut(&1)
                .unwrap()
                .cycle
                .advance(Instant::now()),
            Some(Action::Hold)
        );
        // The first operation blocks while these events queue. The run loop
        // drains this batch before selecting another action, regardless of age.
        let mut delayed = match accepted(2) {
            Phase::Down(capture) => capture,
            _ => unreachable!(),
        };
        delayed.at -= 6000;
        for phase in [Phase::Down(delayed), Phase::Up] {
            state.physical(&second, "current", 2, phase);
        }
        assert_eq!(
            state.next_pending(Instant::now()),
            Some((second.clone(), 2))
        );
        assert_eq!(
            state
                .slots
                .get_mut(&second)
                .unwrap()
                .pending
                .get_mut(&2)
                .unwrap()
                .cycle
                .advance(Instant::now()),
            Some(Action::Tap)
        );
        assert!(!state.slots[&first].pending[&1].cycle.released());
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
    #[test]
    fn companion_shortcuts_use_the_registration_portable_text_spelling() {
        assert_eq!(qt_shortcut("Ctrl+Alt+Shift+J"), "Ctrl+Alt+Shift+J");
        for (canonical, qt) in [
            ("Super+Enter", "Meta+Return"),
            ("Super+BracketLeft", "Meta+["),
            ("Ctrl+PageDown", "Ctrl+PgDown"),
            ("Alt+Backslash", "Alt+\\"),
            ("Super+Equal", "Meta+="),
        ] {
            assert_eq!(qt_shortcut(canonical), qt);
        }
    }
}
