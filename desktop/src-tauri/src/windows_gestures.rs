//! Poll only while an app shortcut is held. The shortcut plugin's release event
//! observes the main key only; we also need modifier-first release and cancellation.
use crate::{
    config::{Binding, Settings},
    gesture::{Action, Press},
};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::{
    Foundation::POINT,
    UI::{Input::KeyboardAndMouse::GetAsyncKeyState, WindowsAndMessaging::GetCursorPos},
};

#[derive(Default)]
struct Sessions {
    enabled: bool,
    sequence: u64,
    active: HashMap<String, u64>,
}
static SESSIONS: LazyLock<Mutex<Sessions>> = LazyLock::new(|| Mutex::new(Sessions::default()));

pub fn enable() -> Result<(), String> {
    SESSIONS.lock().map_err(|e| e.to_string())?.enabled = true;
    Ok(())
}

pub fn cancel() -> Result<(), String> {
    let mut sessions = SESSIONS.lock().map_err(|e| e.to_string())?;
    sessions.enabled = false;
    sessions.active.clear();
    Ok(())
}

struct Chord {
    keys: Vec<i32>,
    super_key: bool,
}
impl Chord {
    fn parse(shortcut: &str) -> Result<Self, String> {
        let mut parts: Vec<_> = shortcut.split('+').collect();
        let key = parts.pop().ok_or("Missing shortcut key.")?;
        let vk = match key {
            "Left" => 0x25,
            "Up" => 0x26,
            "Right" => 0x27,
            "Down" => 0x28,
            "Space" => 0x20,
            "Tab" => 0x09,
            "Enter" => 0x0D,
            "Escape" => 0x1B,
            "Backspace" => 0x08,
            "Delete" => 0x2E,
            "Insert" => 0x2D,
            "Home" => 0x24,
            "End" => 0x23,
            "PageUp" => 0x21,
            "PageDown" => 0x22,
            "Semicolon" => 0xBA,
            "Quote" => 0xDE,
            "Backquote" => 0xC0,
            "Comma" => 0xBC,
            "Period" => 0xBE,
            "Slash" => 0xBF,
            "Backslash" => 0xDC,
            "Minus" => 0xBD,
            "Equal" => 0xBB,
            "BracketLeft" => 0xDB,
            "BracketRight" => 0xDD,
            _ if key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric() => {
                key.as_bytes()[0] as i32
            }
            _ => key
                .strip_prefix('F')
                .and_then(|n| n.parse::<i32>().ok())
                .filter(|n| (1..=24).contains(n))
                .map(|n| 0x70 + n - 1)
                .ok_or_else(|| format!("Cannot observe shortcut key {key}."))?,
        };
        let mut keys = vec![vk];
        for (name, code) in [("Ctrl", 0x11), ("Alt", 0x12), ("Shift", 0x10)] {
            if parts.contains(&name) {
                keys.push(code);
            }
        }
        Ok(Self {
            keys,
            super_key: parts.contains(&"Super"),
        })
    }
    fn down(&self) -> bool {
        let down = |key| unsafe { GetAsyncKeyState(key) < 0 };
        self.keys.iter().all(|key| down(*key)) && (!self.super_key || down(0x5B) || down(0x5C))
    }
}

pub fn press(app: &AppHandle, binding: &Binding, settings: &Settings) -> Result<(), String> {
    let chord = Chord::parse(&binding.shortcut)?;
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) } == 0 {
        return Err(super::error(
            "Cannot read the pointer position for the app shortcut",
        ));
    }
    let mut sessions = SESSIONS.lock().map_err(|e| e.to_string())?;
    if !sessions.enabled || sessions.active.contains_key(&binding.shortcut) {
        return Ok(());
    }
    sessions.sequence = sessions.sequence.wrapping_add(1);
    let id = sessions.sequence;
    sessions.active.insert(binding.shortcut.clone(), id);
    let started = Instant::now();
    let (app, binding, settings) = (app.clone(), binding.clone(), settings.clone());
    let key = binding.shortcut.clone();
    let result = std::thread::Builder::new()
        .name("app-shortcut-hold".into())
        .spawn(move || {
            let mut press = Press::new(settings.hold_delay_ms, settings.hold_tile_enabled);
            let mut picker: Option<crate::radial::Picker> = None;
            loop {
                // Serialize the final validity check and native action with cancel.
                // An old worker can never act on a newly enabled session with the same key.
                let outcome = (|| -> Result<bool, String> {
                    let mut sessions = SESSIONS.lock().map_err(|e| e.to_string())?;
                    if !sessions.enabled || sessions.active.get(&binding.shortcut) != Some(&id) {
                        return Ok(true);
                    }
                    let action = press.advance(started.elapsed(), chord.down());
                    let result = match action {
                        Some(Action::Tap) => unsafe { super::execute(&binding, &settings) },
                        Some(Action::Hold) => (|| {
                            if settings.hold_mode == "radial" {
                                picker = crate::radial::Picker::open(
                                    &app,
                                    &binding,
                                    crate::radial::Point {
                                        x: point.x,
                                        y: point.y,
                                    },
                                )?;
                                if picker.is_some() {
                                    return Ok(());
                                }
                            }
                            unsafe { super::pull_app(&binding, &settings, Some(point)) }
                        })(),
                        None => Ok(()),
                    };
                    let result = result.and_then(|_| {
                        if let Some(active) = picker.as_ref() {
                            if unsafe { GetAsyncKeyState(0x1B) < 0 } || !active.update()? {
                                picker = None;
                            } else if press.finished() {
                                picker.take().unwrap().release(&binding, &settings)?;
                            }
                        }
                        Ok(())
                    });
                    if press.finished() || result.is_err() {
                        sessions.active.remove(&binding.shortcut);
                    }
                    result.map(|_| press.finished())
                })();
                match outcome {
                    Ok(true) => break,
                    Ok(false) => std::thread::sleep(Duration::from_millis(25)),
                    Err(message) => {
                        let _ = app.emit("warp-error", message);
                        break;
                    }
                }
            }
        });
    if let Err(error) = result {
        sessions.active.remove(&key);
        return Err(format!("Cannot start app shortcut hold tracking: {error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chord_observes_required_modifiers_and_supported_key_codes() {
        let chord = Chord::parse("Ctrl+Alt+Shift+Super+Semicolon").unwrap();
        assert_eq!(chord.keys, [0xBA, 0x11, 0x12, 0x10]);
        assert!(chord.super_key);
        assert_eq!(Chord::parse("Ctrl+F24").unwrap().keys, [0x87, 0x11]);
        assert_eq!(Chord::parse("Super+J").unwrap().keys, [0x4A]);
        assert!(Chord::parse("Ctrl+F25").is_err());
    }
}
