//! On-demand commands through a KWin action with no keyboard assignment.
//! No idle polling and no shell command or arbitrary JavaScript RPC is exposed.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{mpsc, Arc, Mutex},
    thread::JoinHandle,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const SERVICE: &str = "com.windowwarp.Control";
const PATH: &str = "/Control";
pub const SCRIPT: &str = "window-warp-control-session";
const ACTION: &str = "window-warp-control-dispatch";

#[derive(Debug, PartialEq)]
enum ReplyOutcome {
    Completed(Value),
    Cancelled,
}
struct ReplyWait {
    sender: Option<mpsc::SyncSender<Result<ReplyOutcome, String>>>,
    expires: u64,
}
#[derive(Default)]
struct Mailbox {
    pending: VecDeque<Value>,
    replies: HashMap<u64, ReplyWait>,
    sequence: u64,
    generation: Option<String>,
}
impl Mailbox {
    fn pop_pending(&mut self, now: u64) -> Option<(Value, bool, bool)> {
        self.pending.pop_front().map(|job| {
            let generation = job["generation"].as_str();
            let stale = generation.is_some() && generation != self.generation.as_deref();
            let expired = job["expires"].as_u64().unwrap_or_default() <= now;
            (job, stale, expired)
        })
    }
    fn take_reply(&mut self, id: u64) -> Option<ReplyWait> {
        self.pending.retain(|job| job["id"].as_u64() != Some(id));
        self.replies.remove(&id)
    }
}
enum Dispatch {
    Invoke(u64),
    Stop,
}
struct Endpoint {
    app: AppHandle,
    token: String,
    mailbox: Arc<Mutex<Mailbox>>,
    dispatch: mpsc::Sender<Dispatch>,
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn enqueue(
    mailbox: &Arc<Mutex<Mailbox>>,
    dispatch: &mpsc::Sender<Dispatch>,
    command: Value,
    generation: Option<&str>,
    sender: Option<mpsc::SyncSender<Result<ReplyOutcome, String>>>,
) -> Result<Option<u64>, String> {
    let mut mailbox = mailbox.lock().map_err(|e| e.to_string())?;
    if generation.is_some() && mailbox.generation.as_deref() != generation {
        return Ok(None);
    }
    mailbox.sequence += 1;
    let id = mailbox.sequence;
    let expires = now_ms() + 5000;
    mailbox
        .pending
        .push_back(json!({"id":id,"expires":expires,"generation":generation,"command":command}));
    mailbox.replies.insert(id, ReplyWait { sender, expires });
    if dispatch.send(Dispatch::Invoke(id)).is_err() {
        mailbox.pending.retain(|job| job["id"].as_u64() != Some(id));
        mailbox.replies.remove(&id);
        return Err("The KDE command dispatcher stopped. Restart Window Warp.".into());
    }
    Ok(Some(id))
}
fn complete(
    app: &AppHandle,
    mailbox: &Arc<Mutex<Mailbox>>,
    id: u64,
    result: Result<Value, String>,
    cancelled: bool,
) {
    let wait = mailbox
        .lock()
        .ok()
        .and_then(|mut mailbox| mailbox.take_reply(id));
    if let Some(wait) = wait {
        if let Some(sender) = wait.sender {
            let _ = sender.send(if cancelled {
                Ok(ReplyOutcome::Cancelled)
            } else {
                result.map(ReplyOutcome::Completed)
            });
        } else if !cancelled {
            if let Err(error) = result {
                let _ = app.emit("warp-error", error);
            }
        }
    }
}
#[zbus::interface(name = "com.windowwarp.Control")]
impl Endpoint {
    fn input_generation(&self, token: &str) -> String {
        if token != self.token {
            return "null".into();
        }
        self.mailbox
            .lock()
            .map(|m| json!(m.generation).to_string())
            .unwrap_or_else(|_| "null".into())
    }
    fn shortcut(&self, token: &str, generation: &str, payload: &str) {
        if token != self.token {
            return;
        }
        let Ok(mut command) = serde_json::from_str::<Value>(payload) else {
            return;
        };
        if !command.is_object() {
            return;
        }
        command["kind"] = json!("shortcut");
        command["generation"] = json!(generation);
        if let Err(error) = enqueue(
            &self.mailbox,
            &self.dispatch,
            command,
            Some(generation),
            None,
        ) {
            if self
                .mailbox
                .lock()
                .ok()
                .is_some_and(|m| m.generation.as_deref() == Some(generation))
            {
                let _ = self.app.emit("warp-error", error);
            }
        }
    }
    fn arm_retile(&self, token: &str, window: &str, pushed_at: &str) {
        if token != self.token {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(window) else {
            return;
        };
        if value.get("generation").and_then(Value::as_str)
            != self
                .mailbox
                .lock()
                .ok()
                .and_then(|m| m.generation.clone())
                .as_deref()
        {
            return;
        }
        let Ok(target) = serde_json::from_value::<crate::retile::Target>(value) else {
            return;
        };
        let Ok(pushed_at) = pushed_at.parse::<i64>() else {
            return;
        };
        let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
            return;
        };
        let age = (now.as_millis() as i64).saturating_sub(pushed_at).max(0) as u64;
        crate::retile::arm(target, Duration::from_millis(1000u64.saturating_sub(age)));
    }
    fn retile(&self, token: &str, key: &str) -> bool {
        token == self.token && crate::retile::fire(key)
    }
    fn center_pointer(&self, token: &str, point: &str) {
        if token != self.token {
            return;
        }
        let Ok(point) = serde_json::from_str::<crate::radial::Point>(point) else {
            return;
        };
        let app = self.app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result = crate::linux_pointer::move_to(point).and_then(|_| {
                let actual = crate::platform::pointer(&app)?;
                if actual.x == point.x && actual.y == point.y {
                    Ok(())
                } else {
                    Err("KDE did not move the pointer to the requested monitor center.".to_string())
                }
            });
            if let Err(error) = result {
                let _ = app.emit("warp-error", error);
            }
        });
    }
    // The unguessable, one-use ticket acknowledges only a pending local load.
    // It grants no action or configuration authority.
    fn script_ready(&self, ticket: &str) {
        crate::platform::script_ready(ticket);
    }

    fn gesture_pointer(&self, token: &str, id: &str, pointer: &str) {
        let generation = serde_json::from_str::<Value>(pointer)
            .ok()
            .and_then(|value| value["generation"].as_str().map(str::to_owned));
        if token == self.token
            && generation.is_some()
            && self
                .mailbox
                .lock()
                .ok()
                .is_some_and(|m| m.generation == generation)
        {
            crate::linux_gestures::pointer(id, pointer);
        }
    }

    fn action(&self, token: &str, action: &str) {
        if token == self.token && crate::app_actions::is_control(action) {
            crate::app_actions::dispatch(&self.app, action);
        }
    }

    fn next(&self, token: &str) -> String {
        if token != self.token {
            return "null".into();
        }
        loop {
            let job = self
                .mailbox
                .lock()
                .ok()
                .and_then(|mut mailbox| mailbox.pop_pending(now_ms()));
            let Some((job, stale, expired)) = job else {
                return "null".into();
            };
            let id = job["id"].as_u64().unwrap_or_default();
            if stale || expired {
                complete(
                    &self.app,
                    &self.mailbox,
                    id,
                    Err("Window command expired or was cancelled.".into()),
                    stale,
                );
                continue;
            }
            return job.to_string();
        }
    }
    fn reply(&self, token: &str, id: &str, payload: &str) {
        if token != self.token || payload.len() > 8_000_000 {
            return;
        }
        let Ok(id) = id.parse::<u64>() else {
            return;
        };
        let parsed = serde_json::from_str::<Value>(payload);
        let cancelled = parsed
            .as_ref()
            .is_ok_and(|value| value["cancelled"] == true);
        let result = parsed
            .map_err(|e| format!("Invalid KWin reply: {e}"))
            .and_then(|value| {
                if let Some(error) = value["error"].as_str() {
                    Err(error.to_owned())
                } else {
                    Ok(value["result"].clone())
                }
            });
        complete(&self.app, &self.mailbox, id, result, cancelled);
    }
}

pub struct Control {
    token: String,
    connection: zbus::blocking::Connection,
    mailbox: Arc<Mutex<Mailbox>>,
    dispatch: mpsc::Sender<Dispatch>,
    worker: Mutex<Option<JoinHandle<()>>>,
}
#[derive(Default)]
pub struct ControlState(pub Mutex<Option<Arc<Control>>>);

fn dispatch_loop(
    app: AppHandle,
    connection: zbus::blocking::Connection,
    mailbox: Arc<Mutex<Mailbox>>,
    receiver: mpsc::Receiver<Dispatch>,
) {
    loop {
        let now = now_ms();
        let expired: Vec<_> = mailbox
            .lock()
            .map(|m| {
                m.replies
                    .iter()
                    .filter(|(_, w)| w.expires <= now)
                    .map(|(id, _)| *id)
                    .collect()
            })
            .unwrap_or_default();
        for id in expired {
            complete(
                &app,
                &mailbox,
                id,
                Err("KWin did not complete the requested window operation. Try again.".into()),
                false,
            );
        }
        let timeout = mailbox.lock().ok().and_then(|m| {
            m.replies
                .values()
                .map(|w| w.expires.saturating_sub(now_ms()))
                .min()
        });
        let event = match timeout {
            Some(ms) => receiver.recv_timeout(Duration::from_millis(ms)),
            None => receiver
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        match event {
            Ok(Dispatch::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Ok(Dispatch::Invoke(id)) => {
                if !mailbox
                    .lock()
                    .ok()
                    .is_some_and(|m| m.replies.contains_key(&id))
                {
                    continue;
                }
                let result = (|| {
                    let proxy = zbus::blocking::Proxy::new(
                        &connection,
                        "org.kde.kglobalaccel",
                        "/component/kwin",
                        "org.kde.kglobalaccel.Component",
                    )
                    .map_err(|e| e.to_string())?;
                    proxy
                        .call::<_, _, ()>("invokeShortcut", &(ACTION,))
                        .map_err(|e| e.to_string())
                })();
                if let Err(error) = result {
                    complete(
                        &app,
                        &mailbox,
                        id,
                        Err(format!(
                            "Could not dispatch the KWin window command: {error}"
                        )),
                        false,
                    );
                }
            }
        }
    }
    let ids: Vec<_> = mailbox
        .lock()
        .map(|m| m.replies.keys().copied().collect())
        .unwrap_or_default();
    for id in ids {
        complete(
            &app,
            &mailbox,
            id,
            Err("KDE command dispatcher stopped.".into()),
            true,
        );
    }
}
impl Control {
    fn create(app: &AppHandle) -> Result<Self, String> {
        let mailbox = Arc::new(Mutex::new(Mailbox::default()));
        let token = uuid::Uuid::new_v4().to_string();
        let (dispatch, receiver) = mpsc::channel();
        let connection = zbus::blocking::connection::Builder::session()
            .map_err(|e| e.to_string())?
            .name(SERVICE)
            .map_err(|e| e.to_string())?
            .serve_at(
                PATH,
                Endpoint {
                    app: app.clone(),
                    token: token.clone(),
                    mailbox: mailbox.clone(),
                    dispatch: dispatch.clone(),
                },
            )
            .map_err(|e| e.to_string())?
            .method_timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        let source=format!("var WARP_CONFIG = {{bindings: []}};\nvar WARP_CONTROL = {};\nvar WARP_APP = WARP_CONTROL;\n{}\n{}",
            json!({"service":SERVICE,"token":token,"ownPid":std::process::id(),"action":ACTION}),include_str!("../kwin/warp.js"),include_str!("../kwin/control.js"));
        crate::platform::load_script(app, SCRIPT, "kwin-control.js", &source)?;
        let (worker_app, worker_connection, worker_mailbox) =
            (app.clone(), connection.clone(), mailbox.clone());
        let worker = match std::thread::Builder::new()
            .name("kde-command-dispatch".into())
            .spawn(move || dispatch_loop(worker_app, worker_connection, worker_mailbox, receiver))
        {
            Ok(worker) => worker,
            Err(error) => {
                let cleanup = crate::platform::unload_script(SCRIPT);
                return Err(format!(
                    "Could not start KDE command dispatcher: {error}{}",
                    cleanup
                        .err()
                        .map(|e| format!("; cleanup: {e}"))
                        .unwrap_or_default()
                ));
            }
        };
        Ok(Self {
            token,
            connection,
            mailbox,
            dispatch,
            worker: Mutex::new(Some(worker)),
        })
    }
    fn request_scoped(
        &self,
        command: Value,
        generation: Option<&str>,
    ) -> Result<ReplyOutcome, String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        let Some(id) = enqueue(
            &self.mailbox,
            &self.dispatch,
            command,
            generation,
            Some(sender),
        )?
        else {
            return Ok(ReplyOutcome::Cancelled);
        };
        let result = receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_else(|_| {
                Err("KWin did not complete the requested window operation. Try again.".into())
            });
        if let Ok(mut mailbox) = self.mailbox.lock() {
            mailbox.pending.retain(|job| job["id"].as_u64() != Some(id));
            mailbox.replies.remove(&id);
        }
        result
    }
    pub fn request(&self, command: Value) -> Result<Value, String> {
        match self.request_scoped(command, None)? {
            ReplyOutcome::Completed(value) => Ok(value),
            ReplyOutcome::Cancelled => Err("Window operation was cancelled.".into()),
        }
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        let _ = self.dispatch.send(Dispatch::Stop);
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
        let _ = self.connection.clone().close();
    }
}

fn control(app: &AppHandle) -> Result<Arc<Control>, String> {
    let state = app.state::<ControlState>();
    let control = {
        let mut current = state.0.lock().map_err(|e| e.to_string())?;
        if current.is_none() {
            *current = Some(Arc::new(Control::create(app)?));
        }
        current.as_ref().unwrap().clone()
    };
    Ok(control)
}
pub fn descriptor(app: &AppHandle) -> Result<Value, String> {
    let control = control(app)?;
    let generation = control
        .mailbox
        .lock()
        .map_err(|e| e.to_string())?
        .generation
        .clone();
    Ok(json!({"service":SERVICE, "token":control.token, "generation":generation}))
}
pub fn request(app: &AppHandle, command: Value) -> Result<Value, String> {
    control(app)?.request(command)
}

pub fn configure_session(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let control = control(app)?;
    let generation = if enabled {
        Some(uuid::Uuid::new_v4().to_string())
    } else {
        None
    };
    control
        .mailbox
        .lock()
        .map_err(|e| e.to_string())?
        .generation = generation.clone();
    control.request(json!({"kind":"input-session","generation":generation}))?;
    Ok(())
}
pub fn input_request(
    app: &AppHandle,
    mut command: Value,
    generation: Option<&str>,
) -> Result<Value, String> {
    let control = control(app)?;
    let current = control
        .mailbox
        .lock()
        .map_err(|e| e.to_string())?
        .generation
        .clone();
    let Some(generation) = generation.or(current.as_deref()) else {
        return Ok(Value::Null);
    };
    command["generation"] = json!(generation);
    if command.get("at").is_none() {
        command["at"] = json!(now_ms());
    }
    match control.request_scoped(command, Some(generation))? {
        ReplyOutcome::Completed(value) => Ok(value),
        ReplyOutcome::Cancelled => Ok(Value::Null),
    }
}

pub fn shutdown(app: &AppHandle) {
    let _ = crate::platform::unload_script(SCRIPT);
    if let Ok(mut state) = app.state::<ControlState>().0.lock() {
        *state = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fifo_dispatch_correlates_out_of_order_replies_and_discards_duplicate_reply() {
        let mailbox = Arc::new(Mutex::new(Mailbox::default()));
        let (dispatch, events) = mpsc::channel();
        let (first, first_result) = mpsc::sync_channel(1);
        let (second, second_result) = mpsc::sync_channel(1);
        let first_id = enqueue(
            &mailbox,
            &dispatch,
            json!({"kind":"snapshot"}),
            None,
            Some(first),
        )
        .unwrap()
        .unwrap();
        let second_id = enqueue(
            &mailbox,
            &dispatch,
            json!({"kind":"pointer"}),
            None,
            Some(second),
        )
        .unwrap()
        .unwrap();
        assert!(matches!(events.recv().unwrap(),Dispatch::Invoke(id) if id==first_id));
        assert!(matches!(events.recv().unwrap(),Dispatch::Invoke(id) if id==second_id));
        let mut mailbox = mailbox.lock().unwrap();
        let (first_job, stale, expired) = mailbox.pop_pending(now_ms()).unwrap();
        assert_eq!(first_job["command"]["kind"], "snapshot");
        assert!(!stale && !expired);
        assert_eq!(
            mailbox.pop_pending(now_ms()).unwrap().0["command"]["kind"],
            "pointer"
        );
        mailbox
            .take_reply(second_id)
            .unwrap()
            .sender
            .unwrap()
            .send(Ok(ReplyOutcome::Completed(json!("second"))))
            .unwrap();
        mailbox
            .take_reply(first_id)
            .unwrap()
            .sender
            .unwrap()
            .send(Ok(ReplyOutcome::Completed(json!("first"))))
            .unwrap();
        assert_eq!(
            first_result.recv().unwrap().unwrap(),
            ReplyOutcome::Completed(json!("first"))
        );
        assert_eq!(
            second_result.recv().unwrap().unwrap(),
            ReplyOutcome::Completed(json!("second"))
        );
        assert!(mailbox.take_reply(first_id).is_none());
    }
    #[test]
    fn generation_change_rejects_old_input_without_invalidating_control_requests() {
        let mailbox = Arc::new(Mutex::new(Mailbox {
            generation: Some("old".into()),
            ..Default::default()
        }));
        let (dispatch, _events) = mpsc::channel();
        enqueue(
            &mailbox,
            &dispatch,
            json!({"kind":"shortcut"}),
            Some("old"),
            None,
        )
        .unwrap();
        enqueue(&mailbox, &dispatch, json!({"kind":"snapshot"}), None, None).unwrap();
        mailbox.lock().unwrap().generation = Some("new".into());
        assert!(enqueue(
            &mailbox,
            &dispatch,
            json!({"kind":"shortcut"}),
            Some("old"),
            None
        )
        .unwrap()
        .is_none());
        let mut mailbox = mailbox.lock().unwrap();
        assert!(mailbox.pop_pending(now_ms()).unwrap().1);
        assert!(!mailbox.pop_pending(now_ms()).unwrap().1);
        assert!(mailbox.pending.is_empty());
    }
    #[test]
    fn request_expiry_starts_at_enqueue_and_dispatch_failure_cleans_mailbox() {
        let mailbox = Arc::new(Mutex::new(Mailbox::default()));
        let (dispatch, events) = mpsc::channel();
        let start = now_ms();
        let id = enqueue(&mailbox, &dispatch, json!({"kind":"snapshot"}), None, None)
            .unwrap()
            .unwrap();
        let mut locked = mailbox.lock().unwrap();
        let expires = locked.replies[&id].expires;
        assert!(expires >= start + 5000 && expires <= now_ms() + 5000);
        assert!(locked.pop_pending(expires).unwrap().2);
        locked.take_reply(id);
        drop(locked);
        drop(events);
        assert!(enqueue(&mailbox, &dispatch, json!({"kind":"pointer"}), None, None).is_err());
        let locked = mailbox.lock().unwrap();
        assert!(locked.pending.is_empty() && locked.replies.is_empty());
    }
}
