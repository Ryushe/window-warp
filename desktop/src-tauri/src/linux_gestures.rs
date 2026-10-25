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

pub fn start(app: &AppHandle, config: &Config) -> Result<Vec<Option<String>>, String> {
    stop()?;
    let generation = uuid::Uuid::new_v4();
    let ids: Vec<_> = config
        .bindings
        .iter()
        .enumerate()
        .map(|(index, binding)| {
            (binding.enabled && binding.action == "pull-app")
                .then(|| format!("window-warp-hold-{generation}-{index}"))
        })
        .collect();
    // KGlobalAccel retains key ownership for inactive action IDs. Reuse the
    // native ID across activation, while callback IDs identify this generation.
    let native_ids: HashMap<_, _> = ids
        .iter()
        .enumerate()
        .filter_map(|(index, id)| {
            id.clone().map(|id| {
                (
                    format!(
                        "window-warp-hold-{index}-{}",
                        config.bindings[index].shortcut
                    ),
                    id,
                )
            })
        })
        .collect();
    let bindings: HashMap<_, _> = ids
        .iter()
        .zip(&config.bindings)
        .filter_map(|(id, binding)| id.clone().map(|id| (id, binding.clone())))
        .collect();
    if bindings.is_empty() {
        return Ok(ids);
    }
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
    let (worker_app, settings, worker_alive) =
        (app.clone(), config.settings.clone(), alive.clone());
    let worker = std::thread::Builder::new()
        .name("kde-hold-actions".into())
        .spawn(move || run(&worker_app, bindings, settings, receiver, worker_alive))
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
                        let Some(id) = native_ids.get(&native_id) else {
                            continue;
                        };
                        let _ = events.send(Event::Key {
                            id: id.clone(),
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
    *RUNNING.lock().map_err(|e| e.to_string())? = Some(Running {
        sender,
        alive,
        connection,
        reader,
        worker,
    });
    Ok(ids)
}

struct Pending {
    press: Press,
    started: Instant,
    native_pressed: bool,
    released: bool,
    point: Option<Point>,
    held: bool,
}
impl Pending {
    fn new(settings: &Settings, at: Instant) -> Self {
        Self {
            press: Press::new(settings.hold_delay_ms, settings.hold_tile_enabled),
            started: at,
            native_pressed: false,
            released: false,
            point: None,
            held: false,
        }
    }
    fn deadline(&self, settings: &Settings) -> Option<Instant> {
        if !self.native_pressed || self.point.is_none() {
            Some(self.started + Duration::from_secs(5))
        } else if settings.hold_tile_enabled && !self.held {
            Some(self.started + Duration::from_millis(settings.hold_delay_ms))
        } else {
            None
        }
    }
}

fn run(
    app: &AppHandle,
    bindings: HashMap<String, Binding>,
    settings: Settings,
    receiver: mpsc::Receiver<Event>,
    alive: Arc<AtomicBool>,
) {
    let mut pending: HashMap<String, Pending> = HashMap::new();
    while alive.load(Ordering::SeqCst) {
        let deadline = pending.values().filter_map(|p| p.deadline(&settings)).min();
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
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        // Process already-arrived releases before a timer; never synthesize a
        // hold after the compositor has deactivated the chord.
        events.extend(receiver.try_iter());
        for event in events {
            match event {
                Event::Stop => return,
                Event::Failed(message) => {
                    let _ = app.emit("warp-error", message);
                    let app = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Err(error) = crate::set_enabled_blocking(app.clone(), false) {
                            let _ = app.emit("warp-error", error);
                        }
                        crate::show(&app);
                    });
                    return;
                }
                Event::Key { id, pressed, at } if bindings.contains_key(&id) => {
                    if pressed {
                        let p = pending
                            .entry(id)
                            .or_insert_with(|| Pending::new(&settings, at));
                        if !p.native_pressed {
                            p.native_pressed = true;
                            p.started = at;
                        }
                    } else if let Some(p) = pending.get_mut(&id) {
                        p.released = true;
                    }
                }
                Event::Pointer { id, point } if bindings.contains_key(&id) => {
                    pending
                        .entry(id)
                        .or_insert_with(|| Pending::new(&settings, Instant::now()))
                        .point
                        .get_or_insert(point);
                }
                _ => {}
            }
        }
        pending.retain(|id, p| {
            if !alive.load(Ordering::SeqCst) { return false; }
            if !p.native_pressed || p.point.is_none() {
                if p.started.elapsed() >= Duration::from_secs(5) {
                    if p.native_pressed { let _ = app.emit("warp-error", "KWin did not provide the app shortcut's pointer position. Pause and enable shortcuts to retry."); }
                    return false;
                }
                return true;
            }
            if let Some(action) = p.press.advance(p.started.elapsed(), !p.released) {
                p.held = action == Action::Hold;
                let pointer = if p.held { p.point } else { None };
                let result = crate::linux_control::request(app, serde_json::json!({
                    "kind":"app-pull", "binding":bindings[id], "settings":settings, "pointer":pointer
                }));
                if let Err(error) = result { let _ = app.emit("warp-error", error); return false; }
            }
            !p.press.finished()
        });
    }
}
