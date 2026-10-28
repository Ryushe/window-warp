//! App shortcuts follow the AutoHotkey timing.
//! The chord starts on key-down. Releasing a required key finishes it: a tap pulls
//! the app, a hold opens the radial and finishes on release. Distinct shortcuts
//! track their holds independently. The hook's state, not GetAsyncKeyState,
//! determines whether a swallowed key is down.

use crate::{
    config::{Binding, Settings},
    gesture::{Action, Press},
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, LazyLock, Mutex, Weak,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::{
    Foundation::POINT,
    UI::WindowsAndMessaging::GetCursorPos,
};

struct Track {
    shortcut: String,
    released: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    hook_press: bool,
}

/// One physical key press, captured by the shared hook before dispatch can be
/// delayed by the UI thread. Each press has its own release flag, even when a
/// later press uses the same key.
#[derive(Clone)]
pub(super) struct HookPress {
    started: Instant,
    released: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    point: Option<POINT>,
    state: Arc<Mutex<PressState>>,
    actions: Arc<ActionSequencer>,
}

#[derive(Default)]
struct PressState {
    hold_committed: bool,
    release_action: Option<ActionTicket>,
}

impl HookPress {
    pub(super) fn new(actions: Arc<ActionSequencer>) -> Self {
        let started = Instant::now();
        let mut point = POINT::default();
        let point = (unsafe { GetCursorPos(&mut point) } != 0).then_some(point);
        Self {
            started,
            released: Arc::new(AtomicBool::new(false)),
            cancelled: Arc::new(AtomicBool::new(false)),
            point,
            state: Arc::new(Mutex::new(PressState::default())),
            actions,
        }
    }

    pub(super) fn release(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if self.is_released() { return; }
        if !self.is_cancelled() {
            state.release_action = Some(self.actions.commit());
        }
        self.released.store(true, Ordering::SeqCst);
    }

    fn commit_hold(&self) -> Option<ActionTicket> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.hold_committed || self.is_released() || self.is_cancelled() { return None; }
        state.hold_committed = true;
        Some(self.actions.commit())
    }

    fn take_release_action(&self) -> Option<ActionTicket> {
        self.state.lock().unwrap_or_else(|error| error.into_inner()).release_action.take()
    }

    #[cfg(test)]
    pub(super) fn release_has_predecessor(&self) -> Option<bool> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
            .release_action.as_ref().map(ActionTicket::has_previous)
    }

    pub(super) fn is_released(&self) -> bool {
        self.released.load(Ordering::SeqCst)
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub(super) fn cancellation(&self) -> Weak<AtomicBool> {
        Arc::downgrade(&self.cancelled)
    }
}

/// A later committed action waits for prior actions, never for a key that is
/// merely held. Waiting happens on workers, never on the hook or UI thread.
pub(super) struct Completion {
    done: Mutex<bool>,
    changed: Condvar,
    previous: Mutex<Option<Arc<Completion>>>,
}

impl Completion {
    fn new(previous: Option<Arc<Completion>>) -> Self {
        Self {
            done: Mutex::new(false),
            changed: Condvar::new(),
            previous: Mutex::new(previous),
        }
    }

    fn wait_one(&self) -> Option<Arc<Completion>> {
        let mut done = self.done.lock().unwrap_or_else(|error| error.into_inner());
        while !*done {
            done = self.changed.wait(done).unwrap_or_else(|error| error.into_inner());
        }
        drop(done);
        self.previous.lock().unwrap_or_else(|error| error.into_inner()).clone()
    }

    fn wait(&self) {
        // A cancelled middle dispatch can finish before its predecessor. Wait
        // for every earlier completion, so it cannot let a later press overtake.
        let mut current = self.wait_one();
        while let Some(completion) = current {
            current = completion.wait_one();
        }
    }

    fn settled(&self) -> bool {
        // Called by the hook: never wait for a worker that owns either lock.
        self.done.try_lock().is_ok_and(|done| *done)
            && self.previous.try_lock().is_ok_and(|previous| previous.is_none())
    }
}

struct CompletionGuard(Arc<Completion>);

impl Drop for CompletionGuard {
    fn drop(&mut self) {
        let mut done = self.0.done.lock().unwrap_or_else(|error| error.into_inner());
        *done = true;
        self.0.changed.notify_all();
    }
}

struct ActionTicket {
    _completion: CompletionGuard,
}

#[derive(Default)]
pub(super) struct ActionSequencer {
    last: Mutex<Option<Arc<Completion>>>,
}

impl ActionSequencer {
    fn commit(&self) -> ActionTicket {
        let mut last = self.last.lock().unwrap_or_else(|error| error.into_inner());
        let previous = last.take();
        let previous = previous.filter(|previous| !previous.settled());
        let completion = Arc::new(Completion::new(previous));
        *last = Some(completion.clone());
        ActionTicket { _completion: CompletionGuard(completion) }
    }
}

impl ActionTicket {
    fn wait_previous(&self) {
        let previous = self._completion.0.previous.lock()
            .unwrap_or_else(|error| error.into_inner()).clone();
        if let Some(previous) = previous {
            previous.wait();
            // The predecessor chain has completed; retaining it would grow a
            // long-lived app's state with every shortcut.
            *self._completion.0.previous.lock()
                .unwrap_or_else(|error| error.into_inner()) = None;
        }
    }

    #[cfg(test)]
    fn has_previous(&self) -> bool {
        self._completion.0.previous.lock().unwrap_or_else(|error| error.into_inner()).is_some()
    }
}

struct Sessions {
    enabled: bool,
    sequence: u64,
    current: HashMap<u64, Track>,
}
impl Default for Sessions {
    fn default() -> Self {
        Self {
            enabled: false,
            sequence: 0,
            current: HashMap::new(),
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
    for (_, track) in sessions.current.drain() {
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

fn blocks_press(
    current: &Track,
    same_chord: bool,
    incoming: Option<&HookPress>,
    legacy_letter_down: impl FnOnce() -> bool,
) -> bool {
    let still = !current.released.load(Ordering::SeqCst);
    if let Some(incoming) = incoming {
        current.hook_press && Arc::ptr_eq(&current.released, &incoming.released) && still
    } else {
        blocks_repeat(same_chord, still && legacy_letter_down())
    }
}

fn released_before_dispatch(
    incoming: Option<&HookPress>,
    legacy_letter_down: impl FnOnce() -> bool,
) -> bool {
    incoming.map_or_else(|| !legacy_letter_down(), HookPress::is_released)
}

fn run_unless_cancelled<T>(cancelled: &AtomicBool, action: impl FnOnce() -> T) -> Option<T> {
    if cancelled.load(Ordering::SeqCst) {
        None
    } else {
        Some(action())
    }
}

fn can_begin_hold(cancelled: &AtomicBool, released: &AtomicBool) -> bool {
    !cancelled.load(Ordering::SeqCst) && !released.load(Ordering::SeqCst)
}

fn can_run_committed_hold(radial: bool, cancelled: &AtomicBool, released: &AtomicBool) -> bool {
    !cancelled.load(Ordering::SeqCst) && (!radial || !released.load(Ordering::SeqCst))
}

pub fn press(app: &AppHandle, binding: &Binding, settings: &Settings) -> Result<(), String> {
    press_with_hook(app, binding, settings, None)
}

pub(super) fn press_with_hook(
    app: &AppHandle,
    binding: &Binding,
    settings: &Settings,
    hook_dispatch: Option<HookPress>,
) -> Result<(), String> {
    let hook_press = hook_dispatch.as_ref();
    if hook_press.is_some_and(HookPress::is_cancelled) {
        return Ok(());
    }
    let chord = Chord::parse(&binding.shortcut)?;
    let point = if let Some(point) = hook_press.and_then(|press| press.point) {
        point
    } else {
        let mut point = POINT::default();
        if unsafe { GetCursorPos(&mut point) } == 0 {
            return Err(super::error("Cannot read the pointer position for the app shortcut"));
        }
        point
    };
    let mut sessions = SESSIONS.lock().map_err(|e| e.to_string())?;
    if !sessions.enabled || hook_press.is_some_and(HookPress::is_cancelled) {
        return Ok(());
    }
    for current in sessions.current.values() {
        let same = current.shortcut == binding.shortcut;
        if blocks_press(current, same, hook_press, || chord.letter_down()) {
            return Ok(());
        }
    }
    // The letter was already released before this reached the worker.
    // That is a tap. Do not arm a hold.
    if released_before_dispatch(hook_press, || chord.letter_down()) {
        drop(sessions);
        if let Some(dispatch) = hook_dispatch {
            let (app, binding, settings) = (app.clone(), binding.clone(), settings.clone());
            return std::thread::Builder::new()
                .name("app-shortcut-tap".into())
                .spawn(move || {
                    let ticket = dispatch.take_release_action();
                    if let Some(ticket) = ticket.as_ref() { ticket.wait_previous(); }
                    if let Some(Err(message)) = run_unless_cancelled(&dispatch.cancelled, || unsafe {
                        super::execute_hook_pull(&binding, &settings)
                    }) {
                        let _ = app.emit("warp-error", message);
                    }
                })
                .map(|_| ())
                .map_err(|error| format!("Cannot start app shortcut tap: {error}"));
        }
        return unsafe { super::execute(binding, settings) };
    }
    sessions.sequence = sessions.sequence.wrapping_add(1);
    let id = sessions.sequence;
    let started = hook_press.map_or_else(Instant::now, |press| press.started);
    let tracked_by_hook = hook_press.is_some();
    let released = hook_press.map_or_else(
        || Arc::new(AtomicBool::new(false)),
        |press| press.released.clone(),
    );
    let cancelled = hook_press.map_or_else(
        || Arc::new(AtomicBool::new(false)),
        |press| press.cancelled.clone(),
    );
    sessions.current.insert(id, Track {
        shortcut: binding.shortcut.clone(),
        released: released.clone(),
        cancelled: cancelled.clone(),
        hook_press: tracked_by_hook,
    });
    let (app, binding, settings) = (app.clone(), binding.clone(), settings.clone());
    let result = std::thread::Builder::new()
        .name("app-shortcut-hold".into())
        .spawn(move || {
            let hook_press = hook_dispatch;
            let mut timing = Press::new(settings.hold_delay_ms, settings.hold_tile_enabled);
            let mut held = false;
            let mut picker: Option<crate::radial::Picker> = None;
            loop {
                if cancelled.load(Ordering::SeqCst) {
                    let _ = picker.take();
                    break;
                }
                if released.load(Ordering::SeqCst) || (!tracked_by_hook && !chord.letter_down()) {
                    if !released.load(Ordering::SeqCst) {
                        released.store(true, Ordering::SeqCst);
                    }
                    let ticket = hook_press.as_ref().and_then(HookPress::take_release_action);
                    if let Some(ticket) = ticket.as_ref() { ticket.wait_previous(); }
                    finish(&app, id, &binding, &settings, held, picker.take(), tracked_by_hook, &cancelled);
                    break;
                }
                if !held {
                    if let Some(Action::Hold) =
                        timing.advance(started.elapsed(), true)
                    {
                        // A release or pause may have arrived after the loop's
                        // first check but before the hold threshold fired.
                        if !can_begin_hold(&cancelled, &released) {
                            continue;
                        }
                        let ticket = if let Some(press) = hook_press.as_ref() {
                            match press.commit_hold() {
                                Some(ticket) => Some(ticket),
                                None => continue,
                            }
                        } else { None };
                        // The hold has crossed its threshold while the chord
                        // was down. A release while waiting for an earlier
                        // action must not turn this gesture into a tap.
                        held = true;
                        if let Some(ticket) = ticket.as_ref() { ticket.wait_previous(); }
                        // Tile holds remain valid after release. A radial that
                        // could not open until after release has no selection
                        // to apply, so do not display it late or run a tap.
                        if !can_run_committed_hold(settings.hold_mode == "radial", &cancelled, &released) {
                            continue;
                        }
                        if settings.hold_mode == "radial" {
                            match run_unless_cancelled(&cancelled, || {
                                crate::radial::Picker::open(
                                    &app,
                                    &binding,
                                    crate::radial::Point { x: point.x, y: point.y },
                                )
                            }) {
                                None => break,
                                Some(Ok(Some(opened))) => picker = Some(opened),
                                Some(Ok(None)) => {
                                    if let Some(Err(message)) = run_unless_cancelled(&cancelled, || unsafe {
                                        super::pull_app(&binding, &settings, Some(point))
                                    }) {
                                        let _ = app.emit("warp-error", message);
                                    }
                                }
                                Some(Err(message)) => {
                                    let _ = app.emit("warp-error", message);
                                }
                            }
                        } else if let Some(Err(message)) = run_unless_cancelled(&cancelled, || unsafe {
                            super::pull_app(&binding, &settings, Some(point))
                        }) {
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
        sessions.current.remove(&id);
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
    tracked_by_hook: bool,
    cancelled: &AtomicBool,
) {
    if let Ok(mut sessions) = SESSIONS.lock() {
        sessions.current.remove(&id);
    }
    if held {
        if let Some(picker) = picker {
            if let Some(Err(message)) = run_unless_cancelled(cancelled, || picker.release(binding, settings)) {
                let _ = app.emit("warp-error", message);
            }
        }
        return;
    }
    let result = run_unless_cancelled(cancelled, || if tracked_by_hook {
        unsafe { super::execute_hook_pull(binding, settings) }
    } else {
        unsafe { super::execute(binding, settings) }
    });
    if let Some(Err(message)) = result {
        let _ = app.emit("warp-error", message);
    }
}

/// The hook calls this on every key-up, after it has forgotten that key.
pub(super) fn note_release() {
    let Some(tracks) = SESSIONS.lock().ok().map(|sessions| {
        sessions.current.values().filter(|track| !track.hook_press)
            .map(|track| (track.shortcut.clone(), track.released.clone()))
            .collect::<Vec<_>>()
    }) else { return; };
    for (shortcut, released) in tracks {
        if Chord::parse(&shortcut).is_ok_and(|chord| !chord.letter_down()) {
            released.store(true, Ordering::SeqCst);
        }
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
    fn queued_taps_keep_their_own_release_and_down_time() {
        let actions = Arc::new(ActionSequencer::default());
        let mut first = HookPress::new(actions.clone());
        first.started = Instant::now() - Duration::from_millis(500);
        first.release();
        let second = HookPress::new(actions);
        assert!(released_before_dispatch(Some(&first), || true));
        assert!(!released_before_dispatch(Some(&second), || false));
        assert!(first.started.elapsed() >= Duration::from_millis(500));
        let previous = Track { shortcut: "Super+D".into(), released: first.released.clone(), cancelled: first.cancelled.clone(), hook_press: true };
        assert!(!blocks_press(&previous, true, Some(&second), || true));
        second.release();
        assert!(released_before_dispatch(Some(&second), || true));
    }

    #[test]
    fn only_the_same_live_hook_press_is_a_repeat() {
        let actions = Arc::new(ActionSequencer::default());
        let press = HookPress::new(actions.clone());
        let other = HookPress::new(actions);
        let current = Track { shortcut: "Super+D".into(), released: press.released.clone(), cancelled: press.cancelled.clone(), hook_press: true };
        assert!(blocks_press(&current, true, Some(&press), || false));
        assert!(!blocks_press(&current, true, Some(&other), || true));
    }

    #[test]
    fn overlapping_tap_commits_before_unreleased_hold() {
        let actions = Arc::new(ActionSequencer::default());
        let held_a = HookPress::new(actions.clone());
        let tap_b = HookPress::new(actions);
        tap_b.release();
        let b_action = tap_b.take_release_action().unwrap();
        assert!(!b_action.has_previous(), "a merely held key must not queue an action");
        b_action.wait_previous();
        assert!(!held_a.is_released());
        drop(b_action);
        let a_action = held_a.commit_hold().expect("B's tap must not cancel A's hold");
        a_action.wait_previous();
        assert!(!held_a.is_cancelled());
    }

    #[test]
    fn rapid_releases_commit_actions_in_key_up_order() {
        let actions = Arc::new(ActionSequencer::default());
        let first = HookPress::new(actions.clone());
        let second = HookPress::new(actions);
        first.release();
        second.release();
        let first_action = first.take_release_action().unwrap();
        let second_action = second.take_release_action().unwrap();
        let (events, received) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            second_action.wait_previous();
            events.send("second").unwrap();
        });
        assert!(received.recv_timeout(Duration::from_millis(50)).is_err());
        drop(first_action);
        assert_eq!(received.recv_timeout(Duration::from_secs(2)).unwrap(), "second");
        worker.join().unwrap();
    }

    #[test]
    fn dropped_middle_action_cannot_let_a_later_action_overtake() {
        let actions = ActionSequencer::default();
        let first = actions.commit();
        let middle = actions.commit();
        drop(middle);
        let last = actions.commit();
        let (started, received) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || { last.wait_previous(); started.send(()).unwrap(); });
        assert!(received.recv_timeout(Duration::from_millis(50)).is_err());
        drop(first);
        received.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn completed_chain_is_pruned_for_the_next_action() {
        let actions = ActionSequencer::default();
        drop(actions.commit());
        assert!(!actions.commit().has_previous());
    }

    #[test]
    fn modifier_first_release_cannot_fire_a_late_hold() {
        let press = HookPress::new(Arc::new(ActionSequencer::default()));
        let mut timing = Press::new(100, true);
        press.release();
        assert_eq!(timing.advance(Duration::from_millis(150), true), Some(Action::Hold));
        assert!(!can_begin_hold(&press.cancelled, &press.released));
        assert!(press.commit_hold().is_none());
        assert!(released_before_dispatch(Some(&press), || true));
    }

    #[test]
    fn committed_hold_released_while_waiting_preserves_tile_and_cancels_late_radial() {
        for (radial, cancelled, should_run) in [
            (false, false, true),
            (true, false, false),
            (false, true, false),
            (true, true, false),
        ] {
            let actions = Arc::new(ActionSequencer::default());
            let earlier = actions.commit();
            let press = HookPress::new(actions);
            let hold = press.commit_hold().expect("hold crosses threshold before release");
            let worker_press = press.clone();
            let (ready, seen_ready) = std::sync::mpsc::channel();
            let (result, observed) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                ready.send(()).unwrap();
                hold.wait_previous();
                result.send(can_run_committed_hold(radial, &worker_press.cancelled, &worker_press.released)).unwrap();
            });
            seen_ready.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(observed.recv_timeout(Duration::from_millis(50)).is_err(), "hold waits for earlier action");
            press.release();
            if cancelled { press.cancelled.store(true, Ordering::SeqCst); }
            drop(earlier);
            assert_eq!(observed.recv_timeout(Duration::from_secs(2)).unwrap(), should_run, "radial={radial}, cancelled={cancelled}");
            worker.join().unwrap();
        }
    }

    #[test]
    fn cancellation_after_a_release_check_still_blocks_the_action() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = cancelled.clone();
        let (ready, seen_ready) = std::sync::mpsc::channel();
        let (resume, wait_resume) = std::sync::mpsc::channel();
        let (result, observed) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            assert!(!worker_cancelled.load(Ordering::SeqCst));
            ready.send(()).unwrap();
            wait_resume.recv().unwrap();
            result.send(run_unless_cancelled(&worker_cancelled, || "action ran")).unwrap();
        });
        seen_ready.recv_timeout(Duration::from_secs(2)).unwrap();
        cancelled.store(true, Ordering::SeqCst);
        resume.send(()).unwrap();
        assert_eq!(observed.recv_timeout(Duration::from_secs(2)).unwrap(), None);
        worker.join().unwrap();
    }
}
