//! While the agent uses the computer, Nyxs steps aside so the user can watch it work: a
//! full-screen, maximized or wide window becomes a small one in the bottom right corner of its
//! display (half its height), kept above the windows the agent opens. The frontend closes the sidebar meanwhile (the
//! `computer-control` event). When the agent lets go, the window goes back to how it was.
//!
//! The agent never acts on this window: `guard` refuses a click on it, and keys while it has
//! the focus, so it can stay in view.

use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

/// The compact window's width and its gap from the screen's edges, in logical pixels. The
/// title bar fits in it once its narrow-window rules hide the player and the history arrows.
const WIDTH: f64 = 480.0;
const MARGIN: f64 = 12.0;

/// What the window was before stepping aside.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Before {
    maximized: bool,
    fullscreen: bool,
    position: (i32, i32),
    size: (u32, u32),
    /// Whether it was moved and resized (a window already narrow stays where it is).
    moved: bool,
}

fn saved() -> &'static Mutex<Option<Before>> {
    static SAVED: OnceLock<Mutex<Option<Before>>> = OnceLock::new();
    SAVED.get_or_init(|| Mutex::new(None))
}

/// The compact window in a display's work area (physical px): position and size.
fn compact_rect(work: (i32, i32, u32, u32), scale: f64) -> ((i32, i32), (u32, u32)) {
    let (x, y, w, h) = work;
    let margin = (MARGIN * scale).round() as u32;
    let width = ((WIDTH * scale).round() as u32)
        .min(w.saturating_sub(2 * margin))
        .max(1);
    let height = (h.saturating_sub(2 * margin) / 2).max(1);
    (
        (
            x + (w - width - margin) as i32,
            y + (h - height - margin) as i32,
        ),
        (width, height),
    )
}

/// Whether a window takes too much of the screen to watch the agent beside it.
fn in_the_way(maximized: bool, fullscreen: bool, width: u32, work_width: u32) -> bool {
    maximized || fullscreen || width > work_width / 2
}

/// Steps aside, once per time the agent takes the computer. True when the window moved, so
/// the caller can let it settle before the agent's first screenshot.
pub fn step_aside(app: &AppHandle) -> bool {
    let Some(w) = app.get_webview_window("main") else {
        return false;
    };
    let mut slot = saved().lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() {
        return false;
    }
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else {
        return false;
    };
    let Some(monitor) = w.current_monitor().ok().flatten() else {
        return false;
    };
    let work = *monitor.work_area();
    let maximized = w.is_maximized().unwrap_or(false);
    let fullscreen = w.is_fullscreen().unwrap_or(false);
    let moved = in_the_way(maximized, fullscreen, size.width, work.size.width);
    *slot = Some(Before {
        maximized,
        fullscreen,
        position: (pos.x, pos.y),
        size: (size.width, size.height),
        moved,
    });
    drop(slot);
    if moved {
        if fullscreen {
            let _ = w.set_fullscreen(false);
        }
        if maximized {
            let _ = w.unmaximize();
        }
        let ((x, y), (width, height)) = compact_rect(
            (
                work.position.x,
                work.position.y,
                work.size.width,
                work.size.height,
            ),
            monitor.scale_factor(),
        );
        let _ = w.set_size(PhysicalSize::new(width, height));
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
    let _ = w.set_always_on_top(true);
    let _ = app.emit("computer-control", true);
    moved
}

/// Puts the window back as it was before the agent took the computer.
pub fn come_back(app: &AppHandle) {
    let Some(before) = saved().lock().unwrap_or_else(|e| e.into_inner()).take() else {
        return;
    };
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let _ = w.set_always_on_top(false);
    if before.moved {
        let _ = w.set_size(PhysicalSize::new(before.size.0, before.size.1));
        let _ = w.set_position(PhysicalPosition::new(before.position.0, before.position.1));
        if before.maximized {
            let _ = w.maximize();
        }
        if before.fullscreen {
            let _ = w.set_fullscreen(true);
        }
    }
    let _ = app.emit("computer-control", false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_compact_window_sits_in_the_bottom_right_corner_at_half_height() {
        // 1920x1040 work area (taskbar below) at 100 %: 480 wide, half as tall, 12 from the edges.
        assert_eq!(
            compact_rect((0, 0, 1920, 1040), 1.0),
            ((1428, 520), (480, 508))
        );
        // A second display to the left, at 150 %.
        assert_eq!(
            compact_rect((-2560, 0, 2560, 1400), 1.5),
            ((-738, 700), (720, 682))
        );
    }

    #[test]
    fn only_a_window_in_the_way_moves() {
        assert!(in_the_way(true, false, 800, 1920));
        assert!(in_the_way(false, true, 800, 1920));
        assert!(in_the_way(false, false, 1200, 1920));
        assert!(!in_the_way(false, false, 830, 1920));
    }
}
