//! Test helper: records the console windows that appear on screen while some code runs, so a
//! test can tell whether a command flashed a console. conhost's own window is
//! `ConsoleWindowClass`; Windows Terminal, when it is the default terminal, opens a
//! `CASCADIA_HOSTING_WINDOW_CLASS` window (or a tab in one, which also shows that window).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetClassNameW, GetWindowThreadProcessId, PeekMessageW, TranslateMessage,
    EVENT_OBJECT_SHOW, MSG, OBJID_WINDOW, PM_REMOVE, WINEVENT_OUTOFCONTEXT,
};

const CONSOLE_CLASSES: [&str; 2] = ["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS"];

/// A console window that was shown, as "class (pid N)": the process is the one the system says
/// owns the window.
pub(crate) type Shown = String;

fn seen() -> &'static Mutex<Vec<Shown>> {
    static SEEN: OnceLock<Mutex<Vec<Shown>>> = OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(Vec::new()))
}

/// One watch at a time: the hook callback has no context pointer, so it writes to `seen()`.
fn watch_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

unsafe extern "system" fn on_show(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if hwnd.is_null() || id_object != OBJID_WINDOW || id_child != 0 {
        return;
    }
    let mut buf = [0u16; 128];
    let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
    if n <= 0 {
        return;
    }
    let class = String::from_utf16_lossy(&buf[..n as usize]);
    if !CONSOLE_CLASSES.contains(&class.as_str()) {
        return;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    seen()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(format!("{class} (pid {pid})"));
}

/// Runs `f` and returns every console window shown meanwhile, anywhere on the desktop.
pub(crate) fn console_windows_shown_during<T>(f: impl FnOnce() -> T) -> (T, Vec<Shown>) {
    let _one = watch_lock().lock().unwrap_or_else(|e| e.into_inner());
    seen().lock().unwrap_or_else(|e| e.into_inner()).clear();
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let stop2 = stop.clone();
    // Out-of-context hooks are delivered through the hooking thread's message queue.
    let pump = std::thread::spawn(move || unsafe {
        let hook = SetWinEventHook(
            EVENT_OBJECT_SHOW,
            EVENT_OBJECT_SHOW,
            std::ptr::null_mut(),
            Some(on_show),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        let _ = ready_tx.send(!hook.is_null());
        let mut msg: MSG = std::mem::zeroed();
        while !stop2.load(Ordering::Acquire) {
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        // Events raised just before the stop are still queued.
        while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if !hook.is_null() {
            UnhookWinEvent(hook);
        }
    });
    assert!(
        ready_rx.recv().unwrap_or(false),
        "couldn't hook window events"
    );
    let out = f();
    // A window shown at the very end may still be on its way to the queue.
    std::thread::sleep(Duration::from_millis(300));
    stop.store(true, Ordering::Release);
    let _ = pump.join();
    let shown = std::mem::take(&mut *seen().lock().unwrap_or_else(|e| e.into_inner()));
    (out, shown)
}
