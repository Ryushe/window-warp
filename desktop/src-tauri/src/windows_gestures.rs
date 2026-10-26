//! App shortcuts follow the AutoHotkey timing.
//! The chord starts on key-down. Releasing its letter finishes it: a tap pulls
//! the app, a hold opens the radial and finishes on release. Starting a
//! different shortcut while one is still held cancels that hold so the new
//! one can take over. The hook's own key state is the clock; we do not ask
//! Windows whether a swallowed key is down.

use crate::{
    config::{Binding, Settings},
    gesture::{Action, Press},
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::{
    Foundation::POINT,
    UI::WindowsAndMessaging::GetCursorPos,
};

struct Track {
    id: u64,
    shortcut: String,
    released: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
}

struct Sessions {
    enabled: bool,
    sequence: u64,
    current: Option<Track>,
}
impl Default for Sessions {
    fn default() -> Self {
        Self {
            enabled: false,
            sequence: 0,
            current: None,
        }
    }
}
static SESSIONS: LazyLock<Mutex<Sessions>> = LazyLock::new(|| Mutex::new(Sessions::default()));

pub fn enable() -> Result<(), String> {
    SESSIONS.lock().map_err(|e| e.to_string())?.enabled = true;
    Ok(())
}

pub fn cancel() -> Result<(), String> {
    let mut sessions = SESSIONS.lock().map_err(|e| e.to_string())?;
    sessions.enabled = false;
    if let Some(track) = sessions.current.take() {
        track.cancelled.store(true, Ordering::SeqCst);
        track.released.store(true, Ordering::SeqCst);
    }
    Ok(())
}

struct Chord {
    keys: Vec<i32>,
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
        Ok(Self { keys: vec![vk] })
    }

    /// The letter (or function key) only. Win can flicker after Windows sees
    /// it; the letter the user is still holding is what keeps a radial open.
    fn letter_down(&self) -> bool {
        self.keys
            .iter()
            .all(|key| super::reserved::vk_down(*key as u32))
    }
}

/// A second press of a chord that is still held is auto-repeat.
/// After its letter goes up, the next shortcut is a new tap.
fn blocks_repeat(same_chord: bool, letter_still_down: bool) -> bool {
    same_chord && letter_still_down
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
    if !sessions.enabled {
        return Ok(());
    }
    if let Some(current) = sessions.current.as_ref() {
        let same = current.shortcut == binding.shortcut;
        let still = !current.released.load(Ordering::SeqCst) && chord.letter_down();
        if blocks_repeat(same, still) {
            return Ok(());
        }
        if !same && !current.released.load(Ordering::SeqCst) {
            // The user started a different shortcut before releasing this one.
            current.cancelled.store(true, Ordering::SeqCst);
            current.released.store(true, Ordering::SeqCst);
        }
    }
    // The letter was already released before this reached the worker.
    // That is a tap. Do not arm a hold.
    if !chord.letter_down() {
        sessions.current = None;
        drop(sessions);
        return unsafe { super::execute(binding, settings) };
    }
    sessions.sequence = sessions.sequence.wrapping_add(1);
    let id = sessions.sequence;
    let released = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    sessions.current = Some(Track {
        id,
        shortcut: binding.shortcut.clone(),
        released: released.clone(),
        cancelled: cancelled.clone(),
    });
    let started = Instant::now();
    let (app, binding, settings) = (app.clone(), binding.clone(), settings.clone());
    let result = std::thread::Builder::new()
        .name("app-shortcut-hold".into())
        .spawn(move || {
            let mut timing = Press::new(settings.hold_delay_ms, settings.hold_tile_enabled);
            let mut held = false;
            let mut picker: Option<crate::radial::Picker> = None;
            loop {
                if cancelled.load(Ordering::SeqCst) {
                    let _ = picker.take();
                    break;
                }
                if released.load(Ordering::SeqCst) || !chord.letter_down() {
                    if !released.load(Ordering::SeqCst) {
                        released.store(true, Ordering::SeqCst);
                    }
                    finish(&app, id, &binding, &settings, held, picker.take());
                    break;
                }
                if !held {
                    if let Some(Action::Hold) =
                        timing.advance(started.elapsed(), true)
                    {
                        held = true;
                        if settings.hold_mode == "radial" {
                            match crate::radial::Picker::open(
                                &app,
                                &binding,
                                crate::radial::Point {
                                    x: point.x,
                                    y: point.y,
                                },
                            ) {
                                Ok(Some(opened)) => picker = Some(opened),
                                Ok(None) => {
                                    if let Err(message) =
                                        unsafe { super::pull_app(&binding, &settings, Some(point)) }
                                    {
                                        let _ = app.emit("warp-error", message);
                                    }
                                }
                                Err(message) => {
                                    let _ = app.emit("warp-error", message);
                                }
                            }
                        } else if let Err(message) =
                            unsafe { super::pull_app(&binding, &settings, Some(point)) }
                        {
                            let _ = app.emit("warp-error", message);
                        }
                    }
                } else if let Some(active) = picker.as_ref() {
                    let escape = super::reserved::vk_down(0x1B);
                    match active.update() {
                        Ok(true) if !escape => {}
                        _ => picker = None,
                    }
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        });
    if let Err(error) = result {
        if sessions
            .current
            .as_ref()
            .is_some_and(|track| track.id == id)
        {
            sessions.current = None;
        }
        return Err(format!("Cannot start app shortcut hold tracking: {error}"));
    }
    Ok(())
}

fn finish(
    app: &AppHandle,
    id: u64,
    binding: &Binding,
    settings: &Settings,
    held: bool,
    picker: Option<crate::radial::Picker>,
) {
    if let Ok(mut sessions) = SESSIONS.lock() {
        if sessions.current.as_ref().is_some_and(|track| track.id == id) {
            sessions.current = None;
        }
    }
    if held {
        if let Some(picker) = picker {
            if let Err(message) = picker.release(binding, settings) {
                let _ = app.emit("warp-error", message);
            }
        }
        return;
    }
    if let Err(message) = unsafe { super::execute(binding, settings) } {
        let _ = app.emit("warp-error", message);
    }
}

/// The hook calls this on every key-up, after it has forgotten that key.
pub(super) fn note_release() {
    let Some((shortcut, released)) = SESSIONS.lock().ok().and_then(|sessions| {
        sessions.current.as_ref().map(|track| {
            (track.shortcut.clone(), track.released.clone())
        })
    }) else {
        return;
    };
    let Ok(chord) = Chord::parse(&shortcut) else {
        return;
    };
    if !chord.letter_down() {
        released.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chord_observes_required_modifiers_and_supported_key_codes() {
        let chord = Chord::parse("Ctrl+Alt+Shift+Super+Semicolon").unwrap();
        assert_eq!(chord.keys, [0xBA]);
        assert_eq!(Chord::parse("Ctrl+F24").unwrap().keys, [0x87]);
        assert_eq!(Chord::parse("Super+J").unwrap().keys, [0x4A]);
        assert!(Chord::parse("Ctrl+F25").is_err());
    }

    #[test]
    fn a_new_shortcut_is_allowed_as_soon_as_the_letter_is_up() {
        assert!(blocks_repeat(true, true), "holding the same key is one gesture");
        assert!(!blocks_repeat(true, false), "release then tap again");
        assert!(!blocks_repeat(false, true), "a different shortcut takes over");
    }
}

