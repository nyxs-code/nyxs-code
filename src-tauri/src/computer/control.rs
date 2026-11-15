//! Stopping what the agent is doing with the mouse and keyboard, and letting go of what it holds.
//!
//! Each action takes a `StopToken` when it starts. Esc, the end of the turn or the idle release
//! stop every token taken before, and the long actions (typing, holding keys, dragging) look at
//! theirs between steps, so they end there instead of typing on into whatever has the focus.
//! What an action leaves pressed on purpose (a button after `left_mouse_down`, keys while a
//! `hold_key` sleeps) is recorded, and released when the control goes.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// What the agent hears when its action was cut short.
pub(crate) const STOPPED: &str = "Computer use was stopped (the user pressed Esc or the turn ended) before this action finished; the rest of it wasn't done.";

/// How often a waiting action looks for a stop.
const SLICE: Duration = Duration::from_millis(20);

/// Counts the stops: a token taken before the last one is stopped.
pub(crate) struct Stopper(AtomicU64);

impl Stopper {
    pub(crate) const fn new() -> Self {
        Self(AtomicU64::new(0))
    }

    pub(crate) fn token(&self) -> StopToken<'_> {
        StopToken {
            stopper: self,
            generation: self.0.load(Ordering::SeqCst),
        }
    }

    pub(crate) fn stop(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

static STOPPER: Stopper = Stopper::new();

/// A token for an action starting now.
pub(crate) fn token() -> StopToken<'static> {
    STOPPER.token()
}

/// Stops every action running now (Esc, the turn ended, the idle release).
pub(crate) fn stop_all() {
    STOPPER.stop();
}

#[derive(Clone, Copy)]
pub(crate) struct StopToken<'a> {
    stopper: &'a Stopper,
    generation: u64,
}

impl StopToken<'_> {
    pub(crate) fn stopped(&self) -> bool {
        self.stopper.0.load(Ordering::SeqCst) != self.generation
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        if self.stopped() {
            Err(STOPPED.into())
        } else {
            Ok(())
        }
    }

    /// Waits `d`, waking as soon as computer use stops.
    pub(crate) fn sleep(&self, d: Duration) -> Result<(), String> {
        let end = Instant::now() + d;
        loop {
            self.check()?;
            let now = Instant::now();
            if now >= end {
                return Ok(());
            }
            std::thread::sleep((end - now).min(SLICE));
        }
    }

    /// Runs the steps in order, looking for a stop before each one.
    pub(crate) fn run<T>(
        &self,
        steps: impl IntoIterator<Item = T>,
        mut each: impl FnMut(T) -> Result<(), String>,
    ) -> Result<(), String> {
        for step in steps {
            self.check()?;
            each(step)?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MouseButton {
    Left,
    Right,
    Middle,
}

impl MouseButton {
    pub(crate) fn parse(name: Option<&str>) -> Result<Self, String> {
        match name.unwrap_or("left") {
            "left" => Ok(Self::Left),
            "right" => Ok(Self::Right),
            "middle" => Ok(Self::Middle),
            other => Err(format!(
                "Unknown mouse button \"{other}\" (left, right or middle)."
            )),
        }
    }
}

/// Sends the "up" half of an input, to let go of it.
pub(crate) trait Release {
    fn button_up(&self, button: MouseButton);
    /// A key by its virtual key code (Windows) or key code (macOS).
    fn key_up(&self, code: u16);
}

/// What Nyxs pressed and hasn't released yet.
#[derive(Default, Debug, PartialEq)]
pub(crate) struct Held {
    buttons: Vec<MouseButton>,
    keys: Vec<u16>,
}

impl Held {
    pub(crate) fn press_button(&mut self, b: MouseButton) {
        if !self.buttons.contains(&b) {
            self.buttons.push(b);
        }
    }

    pub(crate) fn release_button(&mut self, b: MouseButton) {
        self.buttons.retain(|x| *x != b);
    }

    pub(crate) fn press_keys(&mut self, codes: &[u16]) {
        for c in codes {
            if !self.keys.contains(c) {
                self.keys.push(*c);
            }
        }
    }

    pub(crate) fn release_keys(&mut self, codes: &[u16]) {
        self.keys.retain(|x| !codes.contains(x));
    }

    /// Lets go of everything, keys last pressed first, and forgets it.
    pub(crate) fn let_go(&mut self, out: &dyn Release) {
        for &k in self.keys.iter().rev() {
            out.key_up(k);
        }
        for &b in &self.buttons {
            out.button_up(b);
        }
        self.keys.clear();
        self.buttons.clear();
    }
}

pub(crate) fn held() -> &'static Mutex<Held> {
    static HELD: OnceLock<Mutex<Held>> = OnceLock::new();
    HELD.get_or_init(|| Mutex::new(Held::default()))
}

/// Records that `codes` are down for the length of `hold`, so a stop in between lets go of them
/// too, and forgets them once `hold` is over (whatever it returned).
pub(crate) fn holding_keys<T>(codes: &[u16], hold: impl FnOnce() -> T) -> T {
    held()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .press_keys(codes);
    let out = hold();
    held()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .release_keys(codes);
    out
}

/// Lets go of whatever Nyxs left pressed (the control is going: Esc, the turn ended, idle).
pub(crate) fn let_go(out: &dyn Release) {
    held().lock().unwrap_or_else(|e| e.into_inner()).let_go(out);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::sync::Arc;

    #[derive(Default)]
    struct Recorder(RefCell<Vec<String>>);

    impl Release for Recorder {
        fn button_up(&self, b: MouseButton) {
            self.0.borrow_mut().push(format!("{b:?} up"));
        }
        fn key_up(&self, code: u16) {
            self.0.borrow_mut().push(format!("key {code} up"));
        }
    }

    #[test]
    fn a_stop_ends_the_steps_left() {
        let stopper = Stopper::new();
        let token = stopper.token();
        let mut sent = Vec::new();
        let r = token.run(1..=5, |n| {
            sent.push(n);
            if n == 2 {
                stopper.stop();
            }
            Ok(())
        });
        assert_eq!(r, Err(STOPPED.to_string()));
        assert_eq!(sent, vec![1, 2]);
        // An action that starts after the stop runs.
        assert!(stopper.token().run(1..=2, |_| Ok(())).is_ok());
    }

    #[test]
    fn a_wait_wakes_up_on_a_stop() {
        let stopper = Arc::new(Stopper::new());
        let other = stopper.clone();
        let started = Instant::now();
        let waker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            other.stop();
        });
        let r = stopper.token().sleep(Duration::from_secs(10));
        waker.join().unwrap();
        assert_eq!(r, Err(STOPPED.to_string()));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn lets_go_of_what_is_still_pressed() {
        let mut held = Held::default();
        held.press_button(MouseButton::Left);
        held.press_keys(&[16, 65]);
        held.press_button(MouseButton::Right);
        held.release_button(MouseButton::Right);
        let out = Recorder::default();
        held.let_go(&out);
        assert_eq!(*out.0.borrow(), vec!["key 65 up", "key 16 up", "Left up"]);
        assert_eq!(held, Held::default());
        held.let_go(&out);
        assert_eq!(out.0.borrow().len(), 3);
    }

    #[test]
    fn keys_held_for_a_while_are_forgotten_after() {
        let mut held = Held::default();
        held.press_keys(&[17, 18]);
        held.release_keys(&[17, 18]);
        assert_eq!(held, Held::default());
    }

    #[test]
    fn reads_button_names() {
        assert_eq!(MouseButton::parse(None), Ok(MouseButton::Left));
        assert_eq!(MouseButton::parse(Some("middle")), Ok(MouseButton::Middle));
        assert!(MouseButton::parse(Some("fourth")).is_err());
    }
}
