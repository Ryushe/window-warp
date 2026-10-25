//! Tap/hold timing, independent of the native keyboard and window APIs.
use std::time::Duration;

#[derive(Debug, PartialEq)]
pub enum Action {
    Tap,
    Hold,
}

pub struct Press {
    delay: Duration,
    hold_enabled: bool,
    held: bool,
    finished: bool,
}

impl Press {
    pub fn new(delay_ms: u64, hold_enabled: bool) -> Self {
        Self {
            delay: Duration::from_millis(delay_ms),
            hold_enabled,
            held: false,
            finished: false,
        }
    }

    /// A missing required modifier also ends the chord. Release takes priority
    /// over a late timer tick, matching the original application's behavior.
    pub fn advance(&mut self, elapsed: Duration, chord_down: bool) -> Option<Action> {
        if self.finished {
            return None;
        }
        if !chord_down {
            self.finished = true;
            return (!self.held).then_some(Action::Tap);
        }
        if self.hold_enabled && !self.held && elapsed >= self.delay {
            self.held = true;
            return Some(Action::Hold);
        }
        None
    }

    pub fn finished(&self) -> bool {
        self.finished
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    #[test]
    fn tap_waits_for_release_and_cannot_repeat() {
        let mut press = Press::new(400, true);
        assert_eq!(press.advance(ms(0), true), None);
        assert_eq!(press.advance(ms(399), true), None);
        assert_eq!(press.advance(ms(399), false), Some(Action::Tap));
        assert_eq!(press.advance(ms(500), false), None);
        assert_eq!(press.advance(ms(600), true), None);
        assert!(press.finished());
    }

    #[test]
    fn hold_fires_once_at_threshold_and_release_does_not_tap() {
        let mut press = Press::new(400, true);
        assert_eq!(press.advance(ms(400), true), Some(Action::Hold));
        assert_eq!(press.advance(ms(900), true), None);
        assert_eq!(press.advance(ms(1000), false), None);
        assert!(press.finished());
    }

    #[test]
    fn disabled_hold_still_taps_on_release_after_long_press() {
        let mut press = Press::new(100, false);
        assert_eq!(press.advance(ms(5000), true), None);
        assert_eq!(press.advance(ms(6000), false), Some(Action::Tap));
    }

    #[test]
    fn release_before_a_late_tick_does_not_invent_a_hold() {
        let mut press = Press::new(100, true);
        assert_eq!(press.advance(ms(150), false), Some(Action::Tap));
    }
}
