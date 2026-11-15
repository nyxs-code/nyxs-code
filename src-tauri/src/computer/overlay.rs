//! What the user sees and holds while the agent controls the computer: a colored frame around
//! every display with a "Nyxs is using your computer · Esc to stop" label, a global Esc that
//! stops it, and a lock so only one session drives the mouse at a time (as Claude's computer
//! use does). The frame is click-through and left out of screenshots, so the agent never sees
//! or hits it.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// With no Computer call for this long the agent is done: the frame goes and the lock frees.
/// Long enough for the model to think between steps without the frame flickering.
const IDLE_RELEASE: Duration = Duration::from_secs(25);
/// After Esc, calls still in flight from the stopped turn are refused for this long.
const STOP_GRACE: Duration = Duration::from_secs(4);
const LABEL_PREFIX: &str = "computer-overlay-";

struct Control {
    active: bool,
    /// The chat whose agent holds the computer ("" when the caller didn't say).
    owner: String,
    last: Instant,
    stopped_at: Option<Instant>,
    label: String,
    overlays: usize,
}

fn state() -> &'static Mutex<Control> {
    static STATE: OnceLock<Mutex<Control>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(Control {
            active: false,
            owner: String::new(),
            last: Instant::now(),
            stopped_at: None,
            label: "Nyxs is using your computer · Press Esc to stop".into(),
            overlays: 0,
        })
    })
}

fn app_handle() -> &'static OnceLock<AppHandle> {
    static APP: OnceLock<AppHandle> = OnceLock::new();
    &APP
}

/// The app, once computer use has started (to run something on its main thread).
#[cfg(target_os = "macos")]
pub(super) fn app() -> Option<AppHandle> {
    app_handle().get().cloned()
}

/// The frame's text in the app's language (the frontend sets it).
pub fn set_label(label: String) {
    if !label.trim().is_empty() {
        state().lock().unwrap().label = label;
    }
}

/// Takes (or keeps) the computer for `chat` before one of its actions, showing the frame.
pub fn begin(app: &AppHandle, chat: Option<&str>) -> Result<(), String> {
    super::permissions::ensure_supported()?;
    let _ = app_handle().set(app.clone());
    let chat = chat.unwrap_or("").to_string();
    let show;
    {
        let mut s = state().lock().unwrap();
        if s.stopped_at.is_some_and(|t| t.elapsed() < STOP_GRACE) {
            return Err("The user pressed Esc to stop computer use. Don't use the computer again unless they ask.".into());
        }
        if s.active && s.owner != chat && s.last.elapsed() < IDLE_RELEASE {
            return Err("Computer use is in use by another Nyxs session. Wait for it to finish, or ask the user.".into());
        }
        show = !s.active;
        s.active = true;
        s.owner = chat;
        s.last = Instant::now();
    }
    watch_idle();
    if show {
        // Nyxs steps aside so the user can watch the agent; a window that moved gets a moment
        // to settle before the agent's first screenshot.
        if super::compact::step_aside(app) {
            std::thread::sleep(Duration::from_millis(300));
        }
        show_overlays(app);
        imp::start_hook();
    }
    Ok(())
}

/// Lets the computer go for `chat` (its turn ended), or for anyone with `None`.
pub fn release(chat: Option<&str>) {
    let app = {
        let mut s = state().lock().unwrap();
        if !s.active || chat.is_some_and(|c| c != s.owner) {
            return;
        }
        s.active = false;
        s.owner.clear();
        app_handle().get().cloned()
    };
    let_go_of_input(&super::imp::Releaser);
    imp::stop_hook();
    if let Some(app) = app {
        hide_overlays(&app);
        super::compact::come_back(&app);
    }
}

/// The control is going: the action running now stops at its next step, and what Nyxs left
/// pressed (a button after `left_mouse_down`, the keys of a `hold_key`) is let go of.
fn let_go_of_input(out: &dyn super::control::Release) {
    super::control::stop_all();
    super::control::let_go(out);
}

/// The user pressed Esc: stop now and tell the frontend whose turn to end.
fn on_escape() {
    let owner = {
        let mut s = state().lock().unwrap();
        if !s.active {
            return;
        }
        s.stopped_at = Some(Instant::now());
        s.owner.clone()
    };
    release(None);
    if let Some(app) = app_handle().get() {
        let _ = app.emit("computer-stop", owner);
    }
}

fn watch_idle() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(1));
            let idle = {
                let s = state().lock().unwrap();
                s.active && s.last.elapsed() >= IDLE_RELEASE
            };
            if idle {
                release(None);
            }
        });
    });
}

fn overlay_url(label: &str) -> WebviewUrl {
    let mut encoded = String::new();
    for b in label.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*b as char)
            }
            _ => encoded.push_str(&format!("%{b:02X}")),
        }
    }
    WebviewUrl::App(format!("computer-overlay.html?label={encoded}").into())
}

fn show_overlays(app: &AppHandle) {
    let displays = match super::imp::displays() {
        Ok(d) => d,
        Err(_) => return,
    };
    let (label, before) = {
        let s = state().lock().unwrap();
        (s.label.clone(), s.overlays)
    };
    for d in &displays {
        let name = format!("{LABEL_PREFIX}{}", d.index);
        let window = match app.get_webview_window(&name) {
            Some(w) => w,
            None => {
                let built = WebviewWindowBuilder::new(app, &name, overlay_url(&label))
                    .title("Nyxs computer use")
                    .decorations(false)
                    .transparent(true)
                    .shadow(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .resizable(false)
                    .focused(false)
                    .visible(false)
                    .build();
                match built {
                    Ok(w) => w,
                    Err(err) => {
                        log::warn!("couldn't create the computer-use frame: {err}");
                        continue;
                    }
                }
            }
        };
        let _ = window.set_ignore_cursor_events(true);
        // The label may have changed language since the frame was built.
        if let Ok(text) = serde_json::to_string(&label) {
            let _ = window.eval(format!(
                "window.nyxsSetLabel && window.nyxsSetLabel({text})"
            ));
        }
        #[cfg(windows)]
        if let Ok(hwnd) = window.hwnd() {
            imp::place(hwnd.0 as isize, d.x, d.y, d.width as i32, d.height as i32);
        }
        #[cfg(target_os = "macos")]
        imp::place(&window, d.index, d.x, d.y, d.width, d.height);
        // Fades in (a frame built just now fades in on load by itself).
        let _ = window.eval("window.nyxsShow && window.nyxsShow()");
    }
    // A display unplugged since last time: its frame stays hidden.
    for i in displays.len()..before {
        if let Some(w) = app.get_webview_window(&format!("{LABEL_PREFIX}{i}")) {
            hide_frame(&w, false);
        }
    }
    state().lock().unwrap().overlays = displays.len().max(before);
}

/// Hides a frame the way it was shown, through the OS: it was shown behind Tauri's back (so it
/// wouldn't take focus), and Tauri, still thinking it hidden, makes `hide()` a no-op.
/// `only_if_idle` keeps it when the agent took the computer again before the hide lands (macOS
/// hides asynchronously on the main thread).
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn hide_frame(w: &tauri::WebviewWindow, only_if_idle: bool) {
    #[cfg(windows)]
    if let Ok(hwnd) = w.hwnd() {
        imp::hide(hwnd.0 as isize);
        return;
    }
    #[cfg(target_os = "macos")]
    imp::hide(w, only_if_idle);
    #[cfg(not(target_os = "macos"))]
    let _ = w.hide();
}

/// Where the agent acts, for the frame's glow to gather there: a point of display `index` as
/// fractions of its width and height. The other displays' frames let their glow go.
pub fn point(app: &AppHandle, index: usize, fx: f64, fy: f64) {
    let count = state().lock().unwrap_or_else(|e| e.into_inner()).overlays;
    for i in 0..count {
        if let Some(w) = app.get_webview_window(&format!("{LABEL_PREFIX}{i}")) {
            let js = if i == index {
                format!("window.nyxsPointer && window.nyxsPointer({fx:.4}, {fy:.4})")
            } else {
                "window.nyxsPointer && window.nyxsPointer(null)".to_string()
            };
            let _ = w.eval(js);
        }
    }
}

/// How long the frames take to fade out before the windows go (the page's transition).
const FADE_OUT: Duration = Duration::from_millis(600);

/// Fades the frames out, then hides their windows, unless the agent took the computer again
/// meanwhile (then they are already fading back in).
fn hide_overlays(app: &AppHandle) {
    let count = state().lock().unwrap().overlays;
    for i in 0..count {
        if let Some(w) = app.get_webview_window(&format!("{LABEL_PREFIX}{i}")) {
            let _ = w.eval("window.nyxsHide && window.nyxsHide()");
        }
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FADE_OUT);
        if state().lock().unwrap().active {
            return;
        }
        for i in 0..count {
            if let Some(w) = app.get_webview_window(&format!("{LABEL_PREFIX}{i}")) {
                hide_frame(&w, true);
            }
        }
    });
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    pub fn start_hook() {}
    pub fn stop_hook() {}
}

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::Cell;
    use std::ffi::c_void;
    use std::ptr::{null, null_mut, NonNull};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSScreen, NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior,
        NSWindowSharingType,
    };
    use objc2_core_foundation::{
        kCFRunLoopCommonModes, kCFRunLoopDefaultMode, CFMachPort, CFRetained, CFRunLoop, CGRect,
    };
    use objc2_core_graphics::{
        CGEvent, CGEventField, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventTapProxy, CGEventType,
    };
    use tauri::WebviewWindow;

    /// kVK_Escape: a virtual key code, the same on every keyboard layout.
    const KEY_ESCAPE: i64 = 53;

    /// The tap thread's run loop and its stop flag. `CFRunLoopStop` may be called from any
    /// thread; nothing else of the loop is touched off its own thread.
    struct Hook {
        run_loop: CFRetained<CFRunLoop>,
        stop: Arc<AtomicBool>,
    }
    unsafe impl Send for Hook {}

    fn hook() -> &'static Mutex<Option<Hook>> {
        static H: Mutex<Option<Hook>> = Mutex::new(None);
        &H
    }

    thread_local! {
        /// The tap of the thread the callback runs on, to turn it back on after a timeout.
        static TAP: Cell<*const CFMachPort> = const { Cell::new(null()) };
    }

    unsafe extern "C-unwind" fn on_event(
        _proxy: CGEventTapProxy,
        kind: CGEventType,
        event: NonNull<CGEvent>,
        _info: *mut c_void,
    ) -> *mut CGEvent {
        // macOS turns off a tap whose callback was slow once; without this Esc would stop
        // working for the rest of the session.
        if kind == CGEventType::TapDisabledByTimeout {
            let tap = TAP.with(|t| t.get());
            if !tap.is_null() {
                CGEvent::tap_enable(&*tap, true);
            }
            return event.as_ptr();
        }
        if kind != CGEventType::KeyDown && kind != CGEventType::KeyUp {
            return event.as_ptr();
        }
        let ev = event.as_ref();
        if CGEvent::integer_value_field(Some(ev), CGEventField::KeyboardEventKeycode) != KEY_ESCAPE
        {
            return event.as_ptr();
        }
        // Only the user's own Esc: the agent's key action posts events from this process,
        // while the keyboard's come with pid 0.
        let pid = CGEvent::integer_value_field(Some(ev), CGEventField::EventSourceUnixProcessID);
        if pid == std::process::id() as i64 {
            return event.as_ptr();
        }
        if kind == CGEventType::KeyDown {
            std::thread::spawn(super::on_escape);
        }
        // Swallowed, down and up: the app under the agent never sees it.
        null_mut()
    }

    pub fn start_hook() {
        let mut slot = hook().lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel::<Option<Hook>>();
        std::thread::spawn(move || {
            let mask = (1u64 << CGEventType::KeyDown.0) | (1u64 << CGEventType::KeyUp.0);
            let tap = unsafe {
                CGEvent::tap_create(
                    CGEventTapLocation::SessionEventTap,
                    CGEventTapPlacement::HeadInsertEventTap,
                    CGEventTapOptions::Default,
                    mask,
                    Some(on_event),
                    null_mut(),
                )
            };
            // Null without the Accessibility (or Input Monitoring) permission: the frame still
            // shows, only Esc doesn't stop it.
            let Some(tap) = tap else {
                log::warn!("computer use: couldn't create the Esc event tap (no Accessibility permission?)");
                let _ = tx.send(None);
                return;
            };
            let (Some(source), Some(run_loop)) = (
                CFMachPort::new_run_loop_source(None, Some(&tap), 0),
                CFRunLoop::current(),
            ) else {
                tap.invalidate();
                let _ = tx.send(None);
                return;
            };
            TAP.with(|t| t.set(&*tap));
            let modes = unsafe { kCFRunLoopCommonModes };
            run_loop.add_source(Some(&source), modes);
            CGEvent::tap_enable(&tap, true);
            let stop = Arc::new(AtomicBool::new(false));
            let _ = tx.send(Some(Hook {
                run_loop: run_loop.clone(),
                stop: stop.clone(),
            }));
            // Runs in slices rather than one CFRunLoopRun: a stop that lands before the loop
            // starts running would otherwise be lost and leave the tap on for good.
            let default_mode = unsafe { kCFRunLoopDefaultMode };
            while !stop.load(Ordering::SeqCst) {
                CFRunLoop::run_in_mode(default_mode, 1.0, false);
            }
            CGEvent::tap_enable(&tap, false);
            run_loop.remove_source(Some(&source), modes);
            tap.invalidate();
            TAP.with(|t| t.set(null()));
        });
        *slot = rx.recv().ok().flatten();
    }

    pub fn stop_hook() {
        if let Some(h) = hook().lock().unwrap_or_else(|e| e.into_inner()).take() {
            h.stop.store(true, Ordering::SeqCst);
            h.run_loop.stop();
        }
    }

    /// The AppKit frame (points, bottom-left origin) of the screen a `Display` describes.
    /// Matches the rect whether the display came in pixels or in points (top-left origin, as
    /// CoreGraphics reports it), and falls back to the same index in `NSScreen.screens`.
    fn screen_frame(
        mtm: MainThreadMarker,
        index: usize,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
    ) -> Option<CGRect> {
        let screens = NSScreen::screens(mtm);
        let primary_h = screens.firstObject()?.frame().size.height;
        let near = |a: f64, b: f64| (a - b).abs() < 1.5;
        let (x, y, w, h) = (x as f64, y as f64, w as f64, h as f64);
        for s in screens.iter() {
            let f = s.frame();
            let top = primary_h - (f.origin.y + f.size.height);
            for scale in [1.0, s.backingScaleFactor()] {
                if near(f.origin.x * scale, x)
                    && near(top * scale, y)
                    && near(f.size.width * scale, w)
                    && near(f.size.height * scale, h)
                {
                    return Some(f);
                }
            }
        }
        (index < screens.count()).then(|| screens.objectAtIndex(index).frame())
    }

    /// Puts a frame over its display above everything, on every Space and over full-screen
    /// apps, click-through and left out of screenshots, without activating Nyxs.
    pub fn place(window: &WebviewWindow, index: usize, x: i32, y: i32, w: u32, h: u32) {
        // Asked here, off the main thread: Tauri answers it from the event loop.
        let Ok(ptr) = window.ns_window() else { return };
        let ptr = ptr as usize;
        // Async on purpose: this runs on a worker, and waiting on the main thread from here
        // could deadlock with a main thread waiting on us.
        let _ = window.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            if ptr == 0 {
                return;
            }
            // The frames are never closed, so their NSWindow outlives this call.
            let ns = unsafe { &*(ptr as *const NSWindow) };
            if let Some(frame) = screen_frame(mtm, index, x, y, w, h) {
                ns.setFrame_display(frame, true);
            }
            ns.setLevel(NSScreenSaverWindowLevel);
            ns.setIgnoresMouseEvents(true);
            ns.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::IgnoresCycle,
            );
            ns.setSharingType(NSWindowSharingType::None);
            // Cmd+H on Nyxs mustn't take the frame away while the agent works.
            ns.setCanHide(false);
            ns.orderFrontRegardless();
        });
    }

    pub fn hide(window: &WebviewWindow, only_if_idle: bool) {
        let Ok(ptr) = window.ns_window() else { return };
        let ptr = ptr as usize;
        let _ = window.run_on_main_thread(move || {
            if ptr == 0 {
                return;
            }
            // The agent took the computer again since this was queued: the `place` queued
            // after it shows the frame, so don't take it away.
            if only_if_idle
                && super::state()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .active
            {
                return;
            }
            let ns = unsafe { &*(ptr as *const NSWindow) };
            ns.orderOut(None);
        });
    }
}

#[cfg(windows)]
mod imp {
    use std::ptr::null_mut;
    use std::sync::Mutex;

    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, GetWindowLongPtrW, PostThreadMessageW,
        SetWindowDisplayAffinity, SetWindowLongPtrW, SetWindowPos, SetWindowsHookExW, ShowWindow,
        UnhookWindowsHookEx, GWL_EXSTYLE, HC_ACTION, HWND_TOPMOST, KBDLLHOOKSTRUCT, LLKHF_INJECTED,
        MSG, SWP_NOACTIVATE, SW_HIDE, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WH_KEYBOARD_LL,
        WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    /// The thread running the keyboard hook, to end it.
    fn hook_thread() -> &'static Mutex<Option<u32>> {
        static T: Mutex<Option<u32>> = Mutex::new(None);
        &T
    }

    unsafe extern "system" fn on_key(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
            // Only the user's own Esc: the agent's key action sends injected ones.
            if kb.vkCode == VK_ESCAPE as u32 && kb.flags & LLKHF_INJECTED == 0 {
                let msg = wparam as u32;
                if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                    std::thread::spawn(super::on_escape);
                }
                // Swallowed, down and up: a page or dialog on screen can't use Esc to undo
                // anything, and the app under the agent doesn't see it either.
                return 1;
            }
        }
        CallNextHookEx(null_mut(), code, wparam, lparam)
    }

    pub fn start_hook() {
        let mut slot = hook_thread().lock().unwrap();
        if slot.is_some() {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || unsafe {
            let _ = tx.send(GetCurrentThreadId());
            let hook = SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(on_key),
                GetModuleHandleW(std::ptr::null()),
                0,
            );
            // A low-level hook runs on this thread's message loop, so it has to keep pumping.
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {}
            if !hook.is_null() {
                UnhookWindowsHookEx(hook);
            }
        });
        *slot = rx.recv().ok();
    }

    pub fn stop_hook() {
        if let Some(tid) = hook_thread().lock().unwrap().take() {
            unsafe { PostThreadMessageW(tid, WM_QUIT, 0, 0) };
        }
    }

    pub fn hide(hwnd: isize) {
        unsafe { ShowWindow(hwnd as windows_sys::Win32::Foundation::HWND, SW_HIDE) };
    }

    /// Puts a frame over its display without taking focus, kept out of every capture.
    pub fn place(hwnd: isize, x: i32, y: i32, w: i32, h: i32) {
        let hwnd = hwnd as windows_sys::Win32::Foundation::HWND;
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                ex | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) as isize,
            );
            SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE);
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::control::{self, MouseButton, Release};
    use std::cell::RefCell;

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
    fn letting_go_stops_the_running_action_and_releases_what_it_held() {
        let token = control::token();
        control::held()
            .lock()
            .unwrap()
            .press_button(MouseButton::Left);
        let out = Recorder::default();
        super::let_go_of_input(&out);
        assert!(token.stopped());
        assert!(control::token().check().is_ok());
        assert_eq!(*out.0.borrow(), vec!["Left up"]);
    }
}
