//! One-shot retiling after a push. Native key registration stays off the UI
//! callback thread, and no temporary keys remain reserved while idle.
use crate::config::Config;
use serde::{Deserialize, Serialize};
use std::{
    sync::{mpsc, Mutex},
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

/// Plain X/C only. Win+X and Win+C are the push shortcuts: with two or more
/// monitors they must keep moving the window, not consume this follow-up.
pub const KEYS: [&str; 2] = ["X", "C"];
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Target {
    pub id: String,
    pub pid: u32,
}
struct Pending {
    target: Target,
    deadline: Instant,
}
#[derive(Default)]
struct Selection {
    generation: u64,
    pending: Option<Pending>,
}
impl Selection {
    fn arm(&mut self, target: Target, deadline: Instant) {
        self.generation = self.generation.wrapping_add(1);
        self.pending = Some(Pending { target, deadline });
    }
    fn expire(&mut self, now: Instant) {
        if self.pending.as_ref().is_some_and(|p| now >= p.deadline) {
            self.pending = None;
        }
    }
    fn take(&mut self, key: &str, now: Instant) -> Option<(Target, bool, u64)> {
        self.expire(now);
        if !KEYS.contains(&key) {
            return None;
        }
        self.pending
            .take()
            .map(|p| (p.target, key.ends_with('X'), self.generation))
    }
}
enum Event {
    Refresh,
    Fire(Target, bool, u64),
    Stop,
}
struct Session {
    selection: Selection,
    sender: mpsc::Sender<Event>,
    pause_keys: Vec<String>,
}
static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static WORKER: Mutex<Option<JoinHandle<Result<(), String>>>> = Mutex::new(None);

pub fn start(app: &AppHandle, config: &Config) -> Result<(), String> {
    stop()?;
    let keys: Vec<_> = KEYS
        .into_iter()
        .filter(|key| {
            !config
                .bindings
                .iter()
                .any(|b| b.enabled && b.shortcut == *key)
        })
        .map(String::from)
        .collect();
    let (sender, receiver) = mpsc::channel();
    *SESSION.lock().map_err(|e| e.to_string())? = Some(Session {
        selection: Selection::default(),
        sender,
        pause_keys: config
            .bindings
            .iter()
            .filter(|b| b.enabled && b.action == "toggle-pause")
            .map(|b| b.shortcut.clone())
            .collect(),
    });
    let app = app.clone();
    let worker = std::thread::Builder::new()
        .name("push-retile".into())
        .spawn(move || {
            let result = run(&app, receiver, keys);
            if let Err(error) = &result {
                let _ = app.emit(
                    "warp-error",
                    format!("Retile cleanup failed: {error}. Pause and enable shortcuts to retry."),
                );
            }
            result
        })
        .map_err(|e| e.to_string());
    match worker {
        Ok(worker) => *WORKER.lock().map_err(|e| e.to_string())? = Some(worker),
        Err(error) => {
            cancel();
            return Err(error);
        }
    }
    Ok(())
}

pub fn arm(target: Target, remaining: Duration) {
    if remaining.is_zero() {
        return;
    }
    if let Ok(mut current) = SESSION.lock() {
        if let Some(session) = current.as_mut() {
            session.selection.arm(
                target,
                Instant::now() + remaining.min(Duration::from_secs(1)),
            );
            let _ = session.sender.send(Event::Refresh);
        }
    }
}

/// Returns true only when this physical press consumed a live retile selection.
/// Never wait for native registration here: Windows invokes us on its UI thread.
pub fn fire(key: &str) -> bool {
    if let Ok(mut current) = SESSION.lock() {
        if let Some(session) = current.as_mut() {
            if session.pause_keys.iter().any(|pause| pause == key) {
                return false;
            }
            if let Some((target, left, generation)) = session.selection.take(key, Instant::now()) {
                return session
                    .sender
                    .send(Event::Fire(target, left, generation))
                    .is_ok();
            }
        }
    }
    false
}
fn cancel() {
    if let Ok(mut current) = SESSION.lock() {
        if let Some(session) = current.take() {
            let _ = session.sender.send(Event::Stop);
        }
    }
}
pub fn stop() -> Result<(), String> {
    cancel();
    if let Some(worker) = WORKER.lock().map_err(|e| e.to_string())?.take() {
        worker
            .join()
            .map_err(|_| "Retile worker stopped unexpectedly.".to_string())??;
    }
    Ok(())
}
/// Native window operations may need the UI message loop. Process exit must not
/// wait for those calls; normal pause/tray quit waits for key cleanup via stop().
pub fn exiting() {
    cancel();
    if let Ok(mut worker) = WORKER.lock() {
        worker.take();
    }
}
fn run(app: &AppHandle, receiver: mpsc::Receiver<Event>, keys: Vec<String>) -> Result<(), String> {
    let mut hooks = crate::platform::RetileHooks::default();
    let mut installed = false;
    loop {
        let deadline = {
            let mut current = SESSION.lock().map_err(|e| e.to_string())?;
            current.as_mut().and_then(|s| {
                s.selection.expire(Instant::now());
                s.selection.pending.as_ref().map(|p| p.deadline)
            })
        };
        if deadline.is_some() && !installed {
            // Even a partial registration must be cleaned up on error/expiry.
            installed = true;
            if let Err(error) = hooks.install(app, &keys) {
                let _ = app.emit(
                    "warp-error",
                    format!("Could not enable X/C retiling: {error}"),
                );
            }
            continue; // Registration time counts toward the original deadline.
        }
        if deadline.is_none() && installed {
            hooks.clear(app)?;
            installed = false;
        }
        let received = match deadline {
            Some(deadline) => {
                receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            }
            None => receiver
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        match received {
            Ok(Event::Refresh) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Ok(Event::Fire(target, left, generation)) => {
                // A consumed chord must stop capturing typing before window I/O
                // can block on the compositor or another control request.
                hooks.clear(app)?;
                installed = false;
                let current = SESSION
                    .lock()
                    .map_err(|e| e.to_string())?
                    .as_ref()
                    .is_some_and(|s| s.selection.generation == generation);
                if current {
                    if let Err(error) = crate::platform::retile_window(app, &target, left) {
                        let _ = app.emit("warp-error", error);
                    }
                }
            }
            Ok(Event::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return hooks.clear(app),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target(id: &str) -> Target {
        Target {
            id: id.into(),
            pid: 7,
        }
    }
    #[test]
    fn only_exact_keys_consume_the_last_push_once_before_its_deadline() {
        let now = Instant::now();
        let mut selection = Selection::default();
        selection.arm(target("first"), now + Duration::from_secs(1));
        selection.arm(target("last"), now + Duration::from_secs(1));
        for key in [
            "Ctrl+X",
            "Alt+C",
            "Shift+X",
            "Ctrl+Super+C",
            "Super+X",
            "Super+C",
        ] {
            assert!(selection.take(key, now).is_none());
        }
        assert_eq!(
            selection.take("C", now).map(|(t, l, _)| (t, l)),
            Some((target("last"), false))
        );
        assert!(selection.take("X", now).is_none());
        selection.arm(target("expired"), now + Duration::from_secs(1));
        assert!(selection.take("X", now + Duration::from_secs(1)).is_none());
        assert!(selection.pending.is_none());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "opens an owned edit window and sends X/C and Super+X/C; requires WARP_TEST_RETILE=1"]
    fn native_windows_retile_capture_and_release() {
        use std::ptr::null_mut;
        use windows_sys::Win32::{
            Foundation::*,
            UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
        };
        assert_eq!(std::env::var("WARP_TEST_RETILE").as_deref(), Ok("1"));
        struct Cleanup(HWND);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                cancel();
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }
        unsafe fn pump() {
            let mut message: MSG = std::mem::zeroed();
            while PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        unsafe fn send(key: u16, meta: bool) {
            let mut keys = Vec::new();
            if meta {
                keys.push((VK_LWIN, 0));
            }
            keys.push((key, 0));
            keys.push((key, KEYEVENTF_KEYUP));
            if meta {
                keys.push((VK_LWIN, KEYEVENTF_KEYUP));
            }
            let inputs: Vec<_> = keys
                .into_iter()
                .map(|(key, flags)| INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: key,
                            dwFlags: flags,
                            ..std::mem::zeroed()
                        },
                    },
                })
                .collect();
            assert_eq!(
                SendInput(
                    inputs.len() as u32,
                    inputs.as_ptr(),
                    std::mem::size_of::<INPUT>() as i32
                ),
                inputs.len() as u32
            );
        }
        unsafe {
            let class: Vec<u16> = "EDIT\0".encode_utf16().collect();
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                120,
                120,
                400,
                250,
                null_mut(),
                null_mut(),
                null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null());
            let _cleanup = Cleanup(hwnd);
            SetForegroundWindow(hwnd);
            SetFocus(hwnd);
            pump();
            assert_eq!(GetForegroundWindow(), hwnd);
            let (sender, receiver) = mpsc::channel();
            *SESSION.lock().unwrap() = Some(Session {
                selection: Selection::default(),
                sender,
                pause_keys: vec![],
            });
            let mut hooks = crate::platform::RetileHooks::default();
            hooks.install_native().unwrap();
            for (key, meta) in [(88, false), (67, false)] {
                assert_eq!(
                    GetForegroundWindow(),
                    hwnd,
                    "retile must not open Start or a reserved Windows menu"
                );
                arm(
                    Target {
                        id: (hwnd as usize).to_string(),
                        pid: std::process::id(),
                    },
                    Duration::from_secs(1),
                );
                send(key, meta);
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    pump();
                    if let Ok(Event::Fire(target, left, _)) = receiver.try_recv() {
                        assert_eq!(target.id, (hwnd as usize).to_string());
                        assert_eq!(left, key == 88);
                        break;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "native key was not consumed: {meta} {key}"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                for _ in 0..5 {
                    pump();
                    std::thread::sleep(Duration::from_millis(10));
                }
                assert_eq!(
                    GetWindowTextLengthW(hwnd),
                    0,
                    "consumed key must not type into the target"
                );
            }
            hooks.stop().unwrap();
            cancel();
            send(88, false);
            let deadline = Instant::now() + Duration::from_secs(2);
            while GetWindowTextLengthW(hwnd) == 0 && Instant::now() < deadline {
                pump();
                std::thread::sleep(Duration::from_millis(10));
            }
            let mut text = [0u16; 8];
            GetWindowTextW(hwnd, text.as_mut_ptr(), text.len() as i32);
            assert!(
                matches!(text[0], 120 | 88),
                "typing must work after the hook is removed"
            );
        }
    }
}
