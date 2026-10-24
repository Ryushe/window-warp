//! On-demand commands through a KWin action with no keyboard assignment.
//! No idle polling and no shell command or arbitrary JavaScript RPC is exposed.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const SERVICE: &str = "com.windowwarp.Control";
const PATH: &str = "/Control";
pub const SCRIPT: &str = "window-warp-control-session";
const ACTION: &str = "window-warp-control-dispatch";

#[derive(Default)]
struct Mailbox {
    pending: Option<Value>,
    replies: HashMap<u64, mpsc::SyncSender<Result<Value, String>>>,
}
struct Endpoint {
    token: String,
    mailbox: Arc<Mutex<Mailbox>>,
}
#[zbus::interface(name = "com.windowwarp.Control")]
impl Endpoint {
    fn next(&self, token: &str) -> String {
        if token != self.token {
            return "null".into();
        }
        self.mailbox
            .lock()
            .ok()
            .and_then(|mut m| m.pending.take())
            .unwrap_or(Value::Null)
            .to_string()
    }
    fn reply(&self, token: &str, id: &str, payload: &str) {
        if token != self.token || payload.len() > 8_000_000 {
            return;
        }
        let Ok(id) = id.parse::<u64>() else {
            return;
        };
        if let Ok(mut mailbox) = self.mailbox.lock() {
            if let Some(sender) = mailbox.replies.remove(&id) {
                let parsed = serde_json::from_str::<Value>(payload)
                    .map_err(|e| e.to_string())
                    .and_then(|value| {
                        if let Some(error) = value.get("error").and_then(Value::as_str) {
                            Err(error.to_string())
                        } else {
                            Ok(value["result"].clone())
                        }
                    });
                let _ = sender.send(parsed);
            }
        }
    }
}

pub struct Control {
    connection: zbus::blocking::Connection,
    mailbox: Arc<Mutex<Mailbox>>,
    serial: Mutex<()>,
    sequence: AtomicU64,
}
#[derive(Default)]
pub struct ControlState(pub Mutex<Option<Arc<Control>>>);

impl Control {
    fn create(app: &AppHandle) -> Result<Self, String> {
        let mailbox = Arc::new(Mutex::new(Mailbox::default()));
        let token = uuid::Uuid::new_v4().to_string();
        let connection = zbus::blocking::connection::Builder::session()
            .map_err(|e| e.to_string())?
            .name(SERVICE)
            .map_err(|e| e.to_string())?
            .serve_at(
                PATH,
                Endpoint {
                    token: token.clone(),
                    mailbox: mailbox.clone(),
                },
            )
            .map_err(|e| e.to_string())?
            .method_timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        let source = format!(
            "var WARP_CONFIG = {{bindings: []}};\nvar WARP_CONTROL = {};\n{}\n{}",
            json!({"service": SERVICE, "token": token, "ownPid": std::process::id(), "action": ACTION}),
            include_str!("../kwin/warp.js"),
            include_str!("../kwin/control.js")
        );
        crate::platform::load_script(app, SCRIPT, "kwin-control.js", &source)?;
        Ok(Self {
            connection,
            mailbox,
            serial: Mutex::new(()),
            sequence: AtomicU64::new(1),
        })
    }

    pub fn request(&self, command: Value) -> Result<Value, String> {
        let _serial = self.serial.lock().map_err(|e| e.to_string())?;
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::sync_channel(1);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as u64;
        {
            let mut mailbox = self.mailbox.lock().map_err(|e| e.to_string())?;
            mailbox.pending = Some(json!({"id": id, "expires": now + 5000, "command": command}));
            mailbox.replies.insert(id, sender);
        }
        let result = (|| {
            let proxy = zbus::blocking::Proxy::new(
                &self.connection,
                "org.kde.kglobalaccel",
                "/component/kwin",
                "org.kde.kglobalaccel.Component",
            )
            .map_err(|e| e.to_string())?;
            proxy
                .call::<_, _, ()>("invokeShortcut", &(ACTION,))
                .map_err(|e| e.to_string())?;
            receiver.recv_timeout(Duration::from_secs(5)).map_err(|_| {
                "KWin did not complete the requested window operation. Try again.".to_string()
            })?
        })();
        let mut mailbox = self.mailbox.lock().map_err(|e| e.to_string())?;
        mailbox.pending = None;
        mailbox.replies.remove(&id);
        result
    }
}

pub fn request(app: &AppHandle, command: Value) -> Result<Value, String> {
    let state = app.state::<ControlState>();
    let control = {
        let mut current = state.0.lock().map_err(|e| e.to_string())?;
        if current.is_none() {
            *current = Some(Arc::new(Control::create(app)?));
        }
        current.as_ref().unwrap().clone()
    };
    control.request(command)
}

pub fn shutdown(app: &AppHandle) {
    let _ = crate::platform::unload_script(SCRIPT);
    if let Ok(mut state) = app.state::<ControlState>().0.lock() {
        *state = None;
    }
}
