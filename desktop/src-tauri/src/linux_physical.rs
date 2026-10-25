//! An accepted native shortcut carries its physical cycle and capture atomically.
use crate::gesture::{Action, Press};
use std::time::{Duration, Instant};

pub struct Cycle<Capture> {
    press: Press,
    started: Instant,
    delay: Option<Duration>,
    released: bool,
    cancelled: bool,
    held: bool,
    capture: Capture,
}

impl<Capture> Cycle<Capture> {
    pub fn new(delay_ms: u64, hold_enabled: bool, at: Instant, capture: Capture) -> Self {
        Self {
            press: Press::new(delay_ms, hold_enabled),
            started: at,
            delay: hold_enabled.then(|| Duration::from_millis(delay_ms)),
            released: false,
            cancelled: false,
            held: false,
            capture,
        }
    }

    pub fn release(&mut self, cancelled: bool) {
        self.released = true;
        self.cancelled |= cancelled;
    }

    pub fn cancel(&mut self) {
        self.cancelled = true;
        self.released = true;
    }

    pub fn capture(&self) -> &Capture {
        &self.capture
    }

    pub fn released(&self) -> bool {
        self.released
    }

    pub fn finished(&self) -> bool {
        self.press.finished() || (self.cancelled && self.released)
    }

    pub fn deadline(&self) -> Option<Instant> {
        if self.cancelled || self.finished() {
            None
        } else if self.released {
            Some(self.started)
        } else if !self.held {
            self.delay.map(|delay| self.started + delay)
        } else {
            None
        }
    }

    pub fn advance(&mut self, now: Instant) -> Option<Action> {
        if self.cancelled {
            return None;
        }
        let action = self
            .press
            .advance(now.saturating_duration_since(self.started), !self.released);
        self.held |= action == Some(Action::Hold);
        action
    }
}

pub fn qt_shortcut(shortcut: &str) -> String {
    shortcut
        .split('+')
        .map(|key| match key {
            "Super" => "Meta",
            "Semicolon" => ";",
            "Quote" => "'",
            "Backquote" => "`",
            "Comma" => ",",
            "Period" => ".",
            "Slash" => "/",
            "Backslash" => "\\",
            "Minus" => "-",
            "Equal" => "=",
            "BracketLeft" => "[",
            "BracketRight" => "]",
            "PageUp" => "PgUp",
            "PageDown" => "PgDown",
            "Enter" => "Return",
            other => other,
        })
        .collect::<Vec<_>>()
        .join("+")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_text_preserves_all_registration_key_aliases() {
        for (canonical, qt) in [
            ("Super", "Meta"),
            ("Semicolon", ";"),
            ("Quote", "'"),
            ("Backquote", "`"),
            ("Comma", ","),
            ("Period", "."),
            ("Slash", "/"),
            ("Backslash", "\\"),
            ("Minus", "-"),
            ("Equal", "="),
            ("BracketLeft", "["),
            ("BracketRight", "]"),
            ("PageUp", "PgUp"),
            ("PageDown", "PgDown"),
            ("Enter", "Return"),
        ] {
            assert_eq!(
                qt_shortcut(&format!("Ctrl+Alt+Shift+{canonical}")),
                format!("Ctrl+Alt+Shift+{qt}")
            );
        }
        assert_eq!(qt_shortcut("Super+J"), "Meta+J");
    }
    #[test]
    fn release_before_a_delayed_tick_stays_a_single_tap() {
        let now = Instant::now();
        let mut cycle = Cycle::new(100, true, now, "original capture");
        cycle.release(false);
        assert_eq!(
            cycle.advance(now + Duration::from_secs(1)),
            Some(Action::Tap)
        );
        cycle.release(false);
        assert_eq!(cycle.advance(now + Duration::from_secs(2)), None);
        assert_eq!(cycle.capture(), &"original capture");
        assert!(cycle.finished());
    }
    #[test]
    fn independent_overlap_does_not_release_or_repeat_another_cycle() {
        let now = Instant::now();
        let mut held = Cycle::new(100, true, now, "A");
        let mut tapped = Cycle::new(100, true, now + Duration::from_millis(10), "B");
        tapped.release(false);
        assert_eq!(
            tapped.advance(now + Duration::from_millis(20)),
            Some(Action::Tap)
        );
        assert_eq!(held.advance(now + Duration::from_millis(20)), None);
        assert_eq!(
            held.advance(now + Duration::from_millis(100)),
            Some(Action::Hold)
        );
        assert_eq!(held.deadline(), None);
        held.release(false);
        assert_eq!(held.advance(now + Duration::from_millis(150)), None);
        assert!(held.finished());
    }
    #[test]
    fn cancelled_cycles_and_disabled_holds_have_no_idle_polling() {
        let now = Instant::now();
        let mut cycle = Cycle::new(100, true, now, ());
        cycle.cancel();
        assert_eq!(cycle.advance(now + Duration::from_secs(10)), None);
        assert_eq!(cycle.deadline(), None);
        assert!(cycle.finished());
        let mut tap_only = Cycle::new(100, false, now, ());
        assert_eq!(tap_only.deadline(), None);
        tap_only.release(true);
        assert_eq!(tap_only.advance(now), None);
    }
}
