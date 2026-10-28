//! The only low-level keyboard hook.
//!
//! Key-down and key-up are remembered here. Chord decisions, hold tracking,
//! and the "is Win still down" check all read this state. GetAsyncKeyState
//! misses a key after this hook swallows it, so it is not used.
//!
//! Recording swallows the whole chord, including Win, and does not run the
//! shortcut's normal action. The open-editor chord is the exception: a second
//! press closes the popup and shows the main window.

use crate::config::{Binding, Settings};
use std::{
    collections::{HashMap, HashSet},
    ptr::null_mut,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, Weak,
    },
    thread::JoinHandle,
};
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::{
    Foundation::*,
    System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

#[derive(Clone)]
pub(super) struct Armed {
    pub binding: Binding,
    pub settings: Settings,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Mods {
    ctrl: bool,
    alt: bool,
    shift: bool,
    super_key: bool,
}

struct GestureDown {
    press: super::gestures::HookPress,
    required: Mods,
    sequence: u64,
}

enum Job {
    Idle,
    Active(Vec<Armed>),
}

struct Session {
    job: Job,
    thread: Option<(u32, JoinHandle<()>)>,
    app: Option<AppHandle>,
    swallowed: HashSet<u32>,
    down: HashSet<u32>,
    /// Pull-app presses retain their own release state across queued dispatch.
    gestures: HashMap<u32, GestureDown>,
    gesture_sequence: u64,
    /// Includes released presses still queued for the main thread, so pausing
    /// can cancel those as well as presses whose keys are still down.
    gesture_cancellations: Vec<Weak<AtomicBool>>,
    actions: Arc<super::gestures::ActionSequencer>,
    capture: bool,
    /// True only while the shortcut popup is recording. The open-editor
    /// chord then closes it. Recording in the main list must keep that chord.
    popup_recording: bool,
    /// Foreground window at the moment Win went down, before Windows can
    /// move focus to the taskbar. Zero means unset.
    editor_hwnd: usize,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

// Only our synthetic menu mask is ignored. Other injected or physical events
// must still update the state, even if SendInput pumps a nested callback.
const MENU_MASK_TAG: usize = 0x5752504D;
const MENU_MASK_VK: u16 = 0xE8;

fn is_menu_mask(event: &KBDLLHOOKSTRUCT) -> bool {
    event.flags & LLKHF_INJECTED != 0 && event.dwExtraInfo == MENU_MASK_TAG
}

fn session() -> std::sync::MutexGuard<'static, Option<Session>> {
    SESSION.lock().expect("shortcut hook lock")
}

pub(super) fn set_active(app: AppHandle, armed: Vec<Armed>) -> Result<(), String> {
    let start = {
        let mut current = session();
        let slot = current.get_or_insert_with(Session::default);
        slot.app = Some(app);
        slot.job = if armed.is_empty() {
            Job::Idle
        } else {
            Job::Active(armed)
        };
        !matches!(slot.job, Job::Idle)
    };
    if start {
        ensure_thread()
    } else {
        stop_if_idle();
        Ok(())
    }
}

/// Pausing keeps the pause chord and lets every other Windows hotkey through.
pub(super) fn retain_pause() {
    {
        let mut current = session();
        let Some(slot) = current.as_mut() else {
            return;
        };
        let pause = match &slot.job {
            Job::Active(armed) => armed
                .iter()
                .filter(|item| item.binding.action == "toggle-pause")
                .cloned()
                .collect::<Vec<_>>(),
            Job::Idle => Vec::new(),
        };
        slot.capture = false;
        slot.popup_recording = false;
        slot.swallowed.clear();
        slot.down.clear();
        cancel_gestures(slot);
        slot.job = if pause.is_empty() {
            Job::Idle
        } else {
            Job::Active(pause)
        };
    }
    stop_if_idle();
}

pub(super) fn clear_active() {
    {
        let mut current = session();
        if let Some(slot) = current.as_mut() {
            if matches!(slot.job, Job::Active(_)) {
                slot.job = Job::Idle;
                slot.swallowed.clear();
                cancel_gestures(slot);
            }
        }
    }
    stop_if_idle();
}

pub(super) fn capturing() -> bool {
    session().as_ref().is_some_and(|slot| slot.capture)
}

pub(super) fn capture_super_held() -> bool {
    session()
        .as_ref()
        .is_some_and(|slot| slot.capture && mods_from(&slot.down).super_key)
}

pub(super) fn vk_down(vk: u32) -> bool {
    session()
        .as_ref()
        .is_some_and(|slot| key_is_down(&slot.down, vk))
}

pub(super) fn super_down() -> bool {
    session()
        .as_ref()
        .is_some_and(|slot| mods_from(&slot.down).super_key)
}

pub(super) fn editor_hwnd() -> Option<usize> {
    session()
        .as_ref()
        .and_then(|slot| (slot.editor_hwnd != 0).then_some(slot.editor_hwnd))
}

pub(super) fn start_recording(app: AppHandle, popup: bool) -> Result<(), String> {
    let super_held = {
        let mut current = session();
        let slot = current.get_or_insert_with(Session::default);
        slot.app = Some(app);
        if !slot.capture {
            slot.popup_recording = popup;
        } else if popup {
            slot.popup_recording = true;
        }
        slot.capture = true;
        mods_from(&slot.down).super_key
    };
    ensure_thread()?;
    // Do not reinstall the hook here. Unhooking while Win is down drops the
    // key-up, and the next press is then ignored.
    if super_held {
        suppress_start_menu();
    }
    Ok(())
}

pub(super) fn stop_recording() {
    {
        let mut current = session();
        if let Some(slot) = current.as_mut() {
            slot.capture = false;
            slot.popup_recording = false;
        }
    }
    stop_if_idle();
}

/// Test and retile entry. Production shortcuts use set_active.
#[cfg(test)]
pub(super) fn install_shared() -> Result<(), String> {
    {
        let mut current = session();
        current.get_or_insert_with(Session::default);
    }
    ensure_thread()
}

pub(super) fn uninstall_shared() -> Result<(), String> {
    {
        let mut current = session();
        if let Some(slot) = current.as_mut() {
            slot.job = Job::Idle;
            slot.capture = false;
            slot.popup_recording = false;
            slot.swallowed.clear();
            slot.down.clear();
            cancel_gestures(slot);
            slot.editor_hwnd = 0;
        }
    }
    stop_if_idle();
    Ok(())
}

impl Default for Session {
    fn default() -> Self {
        Self {
            job: Job::Idle,
            thread: None,
            app: None,
            swallowed: HashSet::new(),
            down: HashSet::new(),
            gestures: HashMap::new(),
            gesture_sequence: 0,
            gesture_cancellations: Vec::new(),
            actions: Arc::new(super::gestures::ActionSequencer::default()),
            capture: false,
            popup_recording: false,
            editor_hwnd: 0,
        }
    }
}

fn stop_if_idle() {
    let thread = {
        let mut current = session();
        let Some(slot) = current.as_mut() else {
            return;
        };
        if !matches!(slot.job, Job::Idle) || slot.capture {
            return;
        }
        let Some((id, thread)) = slot.thread.take() else {
            return;
        };
        if !thread.is_finished() {
            unsafe { PostThreadMessageW(id, WM_QUIT, 0, 0) };
        }
        thread
    };
    let _ = thread.join();
}

fn ensure_thread() -> Result<(), String> {
    if session().as_ref().is_some_and(|slot| {
        slot.thread
            .as_ref()
            .is_some_and(|(_, thread)| !thread.is_finished())
    }) {
        return Ok(());
    }
    let (ready, result) = mpsc::sync_channel(1);
    let thread = std::thread::Builder::new()
        .name("warp-key-hook".into())
        .spawn(move || unsafe {
            let mut message: MSG = std::mem::zeroed();
            PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE);
            let hook = SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(keyboard),
                GetModuleHandleW(std::ptr::null()),
                0,
            );
            if hook.is_null() {
                let _ = ready.send(Err(super::error("Cannot capture keyboard shortcuts")));
                return;
            }
            let _ = ready.send(Ok(GetCurrentThreadId()));
            while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            if !hook.is_null() {
                UnhookWindowsHookEx(hook);
            }
        })
        .map_err(|error| error.to_string())?;
    match result
        .recv()
        .map_err(|_| "Keyboard hook stopped before it started.".to_string())?
    {
        Ok(id) => {
            if let Some(slot) = session().as_mut() {
                slot.thread = Some((id, thread));
            }
            Ok(())
        }
        Err(error) => {
            let _ = thread.join();
            Err(error)
        }
    }
}

enum Pending {
    Run(AppHandle, Armed, Option<super::gestures::HookPress>),
}

fn cancel_gestures(slot: &mut Session) {
    for cancelled in slot.gesture_cancellations.drain(..) {
        if let Some(cancelled) = cancelled.upgrade() {
            cancelled.store(true, Ordering::SeqCst);
        }
    }
    slot.gestures.clear();
    // A stale queued dispatch from before pause may never run. New presses
    // after resume must not wait for the old chain to drain.
    slot.actions = Arc::new(super::gestures::ActionSequencer::default());
}

fn remember_gesture(slot: &mut Session, vk: u32, required: Mods) -> super::gestures::HookPress {
    let press = super::gestures::HookPress::new(slot.actions.clone());
    slot.gesture_cancellations
        .retain(|item| item.strong_count() != 0);
    slot.gesture_cancellations.push(press.cancellation());
    slot.gesture_sequence = slot.gesture_sequence.wrapping_add(1);
    slot.gestures.insert(vk, GestureDown {
        press: press.clone(),
        required,
        sequence: slot.gesture_sequence,
    });
    press
}

fn release_gestures_for_key_up(slot: &mut Session, vk: u32) {
    let held = mods_from(&slot.down);
    let mut releasing: Vec<_> = slot.gestures.iter().filter_map(|(key, gesture)| {
        let required = gesture.required;
        let modifier_released = (required.ctrl && !held.ctrl)
            || (required.alt && !held.alt)
            || (required.shift && !held.shift)
            || (required.super_key && !held.super_key);
        (*key == vk || modifier_released).then_some((gesture.sequence, *key))
    }).collect();
    releasing.sort_unstable();
    for (_, key) in releasing {
        if let Some(gesture) = slot.gestures.remove(&key) {
            gesture.press.release();
        }
    }
}

unsafe extern "system" fn keyboard(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code != HC_ACTION as i32 {
        return CallNextHookEx(null_mut(), code, wp, lp);
    }
    let event = &*(lp as *const KBDLLHOOKSTRUCT);
    if is_menu_mask(event) {
        return CallNextHookEx(null_mut(), code, wp, lp);
    }
    let vk = event.vkCode;
    let up = event.flags & LLKHF_UP != 0;
    let mut current = match SESSION.lock() {
        Ok(current) => current,
        Err(_) => return CallNextHookEx(null_mut(), code, wp, lp),
    };
    let Some(slot) = current.as_mut() else {
        drop(current);
        return CallNextHookEx(null_mut(), code, wp, lp);
    };
    let super_before = mods_from(&slot.down).super_key;
    let was_down = update_key_state(&mut slot.down, vk, up);
    if !up && !was_down {
        let super_after = mods_from(&slot.down).super_key;
        let win_down = is_win(vk) && !super_before && super_after;
        if win_down || !super_after {
            slot.editor_hwnd = GetForegroundWindow() as usize;
        }
    }
    if up {
        let swallowed = slot.swallowed.remove(&vk);
        release_gestures_for_key_up(slot, vk);
        drop(current);
        super::gestures::note_release();
        return if swallowed {
            1
        } else {
            CallNextHookEx(null_mut(), code, wp, lp)
        };
    }
    if was_down {
        // A held key can repeat at any interval. Only key-up starts a new press.
        let swallowed = slot.capture || slot.swallowed.contains(&vk);
        drop(current);
        return if swallowed {
            1
        } else {
            CallNextHookEx(null_mut(), code, wp, lp)
        };
    }
    let mods = mods_from(&slot.down);
    if slot.capture && is_chord_modifier(vk) {
        slot.swallowed.insert(vk);
        return 1;
    }
    if slot.capture {
        let finished = if vk == u32::from(VK_ESCAPE) && mods == Mods::none() {
            Some(String::new())
        } else if matches!(vk, 0x08 | 0x2E) && mods == Mods::none() {
            Some("clear".to_string())
        } else {
            shortcut_from(vk, mods)
        };
        if let Some(shortcut) = finished.as_deref() {
            if slot.popup_recording {
                if let Some(hit) = open_editor(slot)
                    .filter(|hit| hit.binding.shortcut == shortcut)
                    .cloned()
                {
                    swallow_chord(slot, vk);
                    slot.capture = false;
                    slot.popup_recording = false;
                    let app = slot.app.clone();
                    drop(current);
                    if mods.super_key {
                        suppress_start_menu();
                    }
                    dispatch_hit(app, hit, None);
                    return 1;
                }
            }
        }
        if let Some(shortcut) = finished {
            // Stay in recording. One chord must not fall through to the
            // shortcut's normal action or to Windows.
            if !shortcut.is_empty() && shortcut != "clear" {
                swallow_chord(slot, vk);
            } else {
                slot.swallowed.insert(vk);
            }
            let app = slot.app.clone();
            let mask_start = mods.super_key && !shortcut.is_empty() && shortcut != "clear";
            drop(current);
            if mask_start {
                suppress_start_menu();
            }
            if let Some(app) = app {
                let _ = app.emit("shortcut-recorded", shortcut);
            }
            return 1;
        }
        if key_name(vk).is_some() {
            slot.swallowed.insert(vk);
            return 1;
        }
    }
    if let Some(name) = key_name(vk) {
        let consumed = if mods == Mods::none() {
            crate::retile::fire(name)
        } else {
            shortcut_from(vk, mods).is_some_and(|chord| crate::retile::fire(&chord))
        };
        if consumed {
            swallow_chord(slot, vk);
            let mask_start = mods.super_key;
            drop(current);
            if mask_start {
                suppress_start_menu();
            }
            return 1;
        }
    }
    let matched = match &slot.job {
        Job::Active(armed) => armed
            .iter()
            .find(|item| chord_matches(&item.binding.shortcut, vk, mods))
            .cloned(),
        Job::Idle => None,
    };
    let pending = matched.map(|hit| {
        swallow_chord(slot, vk);
        let press = if hit.binding.action == "pull-app" {
            Some(remember_gesture(slot, vk, mods))
        } else {
            None
        };
        slot.app.clone().map(|app| Pending::Run(app, hit, press))
    });
    let eat = pending.is_some();
    let pending = pending.flatten();
    let mask_start = eat && mods.super_key;
    drop(current);
    if mask_start {
        suppress_start_menu();
    }
    match pending {
        Some(Pending::Run(app, hit, press)) => {
            dispatch_hit(Some(app), hit, press);
            1
        }
        None if eat => 1,
        None => CallNextHookEx(null_mut(), code, wp, lp),
    }
}

fn dispatch_hit(
    app: Option<AppHandle>,
    hit: Armed,
    press: Option<super::gestures::HookPress>,
) {
    let Some(app) = app else {
        return;
    };
    let _ = app.clone().run_on_main_thread(move || {
        if !crate::retile::fire(&hit.binding.shortcut) {
            if let Some(press) = press {
                if let Err(message) = super::gestures::press_with_hook(
                    &app,
                    &hit.binding,
                    &hit.settings,
                    Some(press),
                ) {
                    let _ = app.emit("warp-error", message);
                }
            } else {
                super::run_binding(&app, &hit.binding, &hit.settings);
            }
        }
    });
}

fn open_editor(slot: &Session) -> Option<&Armed> {
    match &slot.job {
        Job::Active(armed) => armed.iter().find(|item| item.binding.action == "open-editor"),
        _ => None,
    }
}

fn swallow_chord(slot: &mut Session, vk: u32) {
    // Only this key. A Win press that Windows already saw must still receive
    // its key-up, or the key sticks. Win presses that started during
    // recording were marked swallowed on the way down.
    slot.swallowed.insert(vk);
}

fn is_win(vk: u32) -> bool {
    matches!(vk, 0x5B | 0x5C)
}

fn is_chord_modifier(vk: u32) -> bool {
    matches!(
        vk,
        0x10 | 0x11 | 0x12 | 0xA0 | 0xA1 | 0xA2 | 0xA3 | 0xA4 | 0xA5 | 0x5B | 0x5C
    )
}

fn update_key_state(down: &mut HashSet<u32>, vk: u32, up: bool) -> bool {
    if up { down.remove(&vk) } else { !down.insert(vk) }
}

fn key_is_down(down: &HashSet<u32>, vk: u32) -> bool {
    match vk {
        0x10 => down.contains(&0x10) || down.contains(&0xA0) || down.contains(&0xA1),
        0x11 => down.contains(&0x11) || down.contains(&0xA2) || down.contains(&0xA3),
        0x12 => down.contains(&0x12) || down.contains(&0xA4) || down.contains(&0xA5),
        0x5B | 0x5C => down.contains(&0x5B) || down.contains(&0x5C),
        _ => down.contains(&vk),
    }
}

fn mods_from(down: &HashSet<u32>) -> Mods {
    Mods {
        ctrl: key_is_down(down, 0x11),
        alt: key_is_down(down, 0x12),
        shift: key_is_down(down, 0x10),
        super_key: key_is_down(down, 0x5B),
    }
}

impl Mods {
    fn none() -> Self {
        Self {
            ctrl: false,
            alt: false,
            shift: false,
            super_key: false,
        }
    }
}

fn suppress_start_menu() {
    unsafe {
        let inputs = [0, KEYEVENTF_KEYUP].map(|flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: MENU_MASK_VK,
                    dwFlags: flags,
                    dwExtraInfo: MENU_MASK_TAG,
                    ..std::mem::zeroed()
                },
            },
        });
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }
}

pub(super) fn is_super(shortcut: &str) -> bool {
    shortcut.split('+').any(|part| part == "Super")
}

fn chord_matches(shortcut: &str, vk: u32, mods: Mods) -> bool {
    shortcut_from(vk, mods).is_some_and(|pressed| pressed == shortcut)
}

fn shortcut_from(vk: u32, mods: Mods) -> Option<String> {
    if !(mods.ctrl || mods.alt || mods.shift || mods.super_key) {
        return None;
    }
    let key = key_name(vk)?;
    let mut parts = Vec::new();
    if mods.ctrl {
        parts.push("Ctrl");
    }
    if mods.alt {
        parts.push("Alt");
    }
    if mods.shift {
        parts.push("Shift");
    }
    if mods.super_key {
        parts.push("Super");
    }
    parts.push(key);
    Some(parts.join("+"))
}

fn key_name(vk: u32) -> Option<&'static str> {
    const DIGITS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    const LETTERS: [&str; 26] = [
        "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R",
        "S", "T", "U", "V", "W", "X", "Y", "Z",
    ];
    const FUNCTIONS: [&str; 24] = [
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14",
        "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
    ];
    if (0x30..0x3A).contains(&vk) {
        return Some(DIGITS[(vk - 0x30) as usize]);
    }
    if (u32::from(b'A')..=u32::from(b'Z')).contains(&vk) {
        return Some(LETTERS[(vk - u32::from(b'A')) as usize]);
    }
    if (0x70..0x88).contains(&vk) {
        return Some(FUNCTIONS[(vk - 0x70) as usize]);
    }
    Some(match vk {
        0x25 => "Left",
        0x26 => "Up",
        0x27 => "Right",
        0x28 => "Down",
        0x20 => "Space",
        0x09 => "Tab",
        0x0D => "Enter",
        0x1B => "Escape",
        0x08 => "Backspace",
        0x2E => "Delete",
        0x2D => "Insert",
        0x24 => "Home",
        0x23 => "End",
        0x21 => "PageUp",
        0x22 => "PageDown",
        0xBA => "Semicolon",
        0xDE => "Quote",
        0xC0 => "Backquote",
        0xBC => "Comma",
        0xBE => "Period",
        0xBF => "Slash",
        0xDC => "Backslash",
        0xBD => "Minus",
        0xBB => "Equal",
        0xDB => "BracketLeft",
        0xDD => "BracketRight",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mods(ctrl: bool, alt: bool, shift: bool, super_key: bool) -> Mods {
        Mods {
            ctrl,
            alt,
            shift,
            super_key,
        }
    }

    #[test]
    fn only_our_injected_menu_mask_is_ignored() {
        let mut event: KBDLLHOOKSTRUCT = unsafe { std::mem::zeroed() };
        event.dwExtraInfo = MENU_MASK_TAG;
        assert!(!is_menu_mask(&event), "a physical event must still be tracked");
        event.flags = LLKHF_INJECTED;
        assert!(is_menu_mask(&event));
        event.dwExtraInfo = 0;
        assert!(!is_menu_mask(&event), "other injected events must still be tracked");
    }

    #[test]
    fn recording_names_win_chords_and_keeps_modifier_chords_distinct() {
        assert_eq!(
            shortcut_from(0xBA, mods(false, false, false, true)).as_deref(),
            Some("Super+Semicolon")
        );
        assert!(chord_matches(
            "Super+Semicolon",
            0xBA,
            mods(false, false, false, true)
        ));
        assert!(!chord_matches(
            "Super+D",
            b'D' as u32,
            mods(true, false, false, true)
        ));
        assert!(chord_matches(
            "Ctrl+Super+D",
            b'D' as u32,
            mods(true, false, false, true)
        ));
        assert_eq!(shortcut_from(b'X' as u32, Mods::none()), None);
        assert!(is_super("Ctrl+Super+X"));
        assert!(!is_super("Ctrl+Alt+P"));
    }

    #[test]
    fn repeat_needs_a_key_up_before_another_press() {
        let mut down = HashSet::new();
        assert!(!update_key_state(&mut down, b'B' as u32, false));
        assert!(update_key_state(&mut down, b'B' as u32, false));
        assert!(update_key_state(&mut down, b'B' as u32, false));
        assert!(update_key_state(&mut down, b'B' as u32, true));
        assert!(!update_key_state(&mut down, b'B' as u32, false));
        assert!(!update_key_state(&mut down, 0x5B, false));
        assert!(!update_key_state(&mut down, 0x5C, false), "each Windows key has its own physical state");
    }

    #[test]
    fn pause_cancels_even_a_released_press_still_waiting_for_dispatch() {
        let mut slot = Session::default();
        let first = remember_gesture(&mut slot, b'D' as u32, Mods::none());
        slot.gestures.remove(&(b'D' as u32)).unwrap().press.release();
        let second = remember_gesture(&mut slot, b'D' as u32, Mods::none());
        assert!(!first.is_cancelled());
        assert!(!second.is_cancelled());
        let old_actions = slot.actions.clone();
        cancel_gestures(&mut slot);
        assert!(!Arc::ptr_eq(&old_actions, &slot.actions), "resume starts a fresh action queue");
        assert!(first.is_cancelled(), "a queued tap must not fire after pause/resume");
        assert!(second.is_cancelled(), "a held press must also be cancelled");
        assert!(slot.gestures.is_empty());
        let resumed = remember_gesture(&mut slot, b'D' as u32, Mods::none());
        assert!(!resumed.is_cancelled());
    }

    #[test]
    fn releasing_a_required_modifier_ends_only_its_own_chords() {
        let mut slot = Session::default();
        // Both Windows keys are held, and the first gesture requires Win only.
        slot.down.extend([0x5B, 0x5C, b'D' as u32]);
        let win_only = remember_gesture(&mut slot, b'D' as u32, mods(false, false, false, true));
        slot.down.extend([0xA2, b'F' as u32]);
        let ctrl_win = remember_gesture(&mut slot, b'F' as u32, mods(true, false, false, true));

        slot.down.remove(&0x5B);
        release_gestures_for_key_up(&mut slot, 0x5B);
        assert!(!win_only.is_released(), "the right Win key still satisfies Super");
        assert!(!ctrl_win.is_released());

        slot.down.remove(&0xA2);
        release_gestures_for_key_up(&mut slot, 0xA2);
        assert!(ctrl_win.is_released(), "releasing Ctrl finishes Ctrl+Win+F");
        assert!(!win_only.is_released(), "Win+D does not require Ctrl");
        assert!(slot.gestures.contains_key(&(b'D' as u32)));
        assert!(!slot.gestures.contains_key(&(b'F' as u32)));

        slot.down.remove(&0x5C);
        release_gestures_for_key_up(&mut slot, 0x5C);
        assert!(win_only.is_released(), "releasing the last Win key ends Win+D");
        assert!(slot.gestures.is_empty());
    }

    #[test]
    fn terminal_key_up_and_unrelated_modifier_release_are_distinct() {
        let mut slot = Session::default();
        slot.down.extend([0x5B, 0xA4, b'D' as u32]);
        let press = remember_gesture(&mut slot, b'D' as u32, mods(false, false, false, true));
        slot.down.remove(&0xA4);
        release_gestures_for_key_up(&mut slot, 0xA4);
        assert!(!press.is_released(), "an unrelated Alt release must not end Win+D");
        slot.down.remove(&(b'D' as u32));
        release_gestures_for_key_up(&mut slot, b'D' as u32);
        assert!(press.is_released());
    }

    #[test]
    fn shared_modifier_release_commits_gestures_in_press_order() {
        let mut slot = Session::default();
        slot.down.extend([0x5B, b'Z' as u32, b'A' as u32]);
        // Use keys in reverse numeric order, so ordering cannot accidentally
        // come from sorting the virtual-key codes.
        let first = remember_gesture(&mut slot, b'Z' as u32, mods(false, false, false, true));
        let second = remember_gesture(&mut slot, b'A' as u32, mods(false, false, false, true));
        slot.down.remove(&0x5B);
        release_gestures_for_key_up(&mut slot, 0x5B);
        assert_eq!(first.release_has_predecessor(), Some(false));
        assert_eq!(second.release_has_predecessor(), Some(true));
    }

    #[test]
    fn hook_state_keeps_a_swallowed_win_chord_held() {
        let mut down = HashSet::new();
        down.insert(0x5B);
        down.insert(u32::from(b'D'));
        let mods = mods_from(&down);
        assert!(mods.super_key);
        assert!(key_is_down(&down, 0x5B));
        assert!(key_is_down(&down, 0x5C));
        assert_eq!(shortcut_from(u32::from(b'D'), mods).as_deref(), Some("Super+D"));
        assert!(!key_is_down(&down, 0x11));
        down.insert(0xA2);
        assert!(key_is_down(&down, 0x11), "left Ctrl satisfies the generic Ctrl check");
        assert_eq!(
            shortcut_from(u32::from(b'D'), mods_from(&down)).as_deref(),
            Some("Ctrl+Super+D")
        );
    }
}
