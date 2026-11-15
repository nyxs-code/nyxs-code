//! The agent's Computer tool: sees the screen and drives the mouse, the keyboard and the desktop's
//! windows, so it can use desktop apps the way a person would (as in Claude's computer use).
//!
//! Coordinates the model sends are in the space of the screenshot it saw, not the screen's: a
//! display is always shot at the same size (`fit`), so every call maps them back the same way
//! without remembering anything between calls. Windows and macOS are implemented (`imp`); other
//! systems answer "not supported".

// Without a native side the commands answer "not supported" and the shared geometry and input
// types go unused.
#![cfg_attr(
    not(any(windows, target_os = "macos")),
    allow(dead_code, unused_imports)
)]

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

mod compact;
mod control;
#[cfg(any(target_os = "macos", test))]
mod keymap;
mod overlay;
pub mod permissions;
pub mod uia;

/// The largest screenshot sent to the model. Bigger costs more tokens without helping it read
/// the screen; small text is what `zoom` is for.
const MAX_W: u32 = 1280;
const MAX_H: u32 = 800;
/// A zoomed region may be enlarged up to this much, so a small one is still legible to the model.
const MAX_ZOOM_UPSCALE: f64 = 2.0;
const JPEG_QUALITY: u8 = 75;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub index: usize,
    pub primary: bool,
    /// Where the display sits on the desktop: physical pixels on Windows, points (what CGEvent
    /// takes) on macOS.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// The size its screenshots have, the space the model's coordinates are in.
    pub shot_width: u32,
    pub shot_height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    /// The picture, base64 JPEG.
    pub data: String,
    pub width: u32,
    pub height: u32,
    pub display: Display,
    pub displays: Vec<Display>,
    /// The mouse pointer in screenshot coordinates, when it is on this display.
    pub cursor: Option<[i32; 2]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: i64,
    pub title: String,
    pub process: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub minimized: bool,
    pub focused: bool,
}

/// One thing to do with the mouse or the keyboard. Points are in screenshot coordinates of the
/// display the call names.
#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Move {
        x: f64,
        y: f64,
    },
    Click {
        x: Option<f64>,
        y: Option<f64>,
        button: Option<String>,
        count: Option<u32>,
        modifiers: Option<String>,
    },
    Down {
        x: Option<f64>,
        y: Option<f64>,
        button: Option<String>,
    },
    Up {
        x: Option<f64>,
        y: Option<f64>,
        button: Option<String>,
    },
    Drag {
        from: [f64; 2],
        to: [f64; 2],
        button: Option<String>,
    },
    /// Wheel clicks: positive `dy` scrolls down, positive `dx` right.
    Scroll {
        x: Option<f64>,
        y: Option<f64>,
        dx: i32,
        dy: i32,
        modifiers: Option<String>,
    },
    Type {
        text: String,
    },
    /// xdotool-style keys: "ctrl+s", "alt+F4", several separated by spaces ("ctrl+a Delete").
    Key {
        keys: String,
    },
    HoldKey {
        keys: String,
        ms: u64,
    },
}

impl Action {
    /// The point the action acts on, in screenshot coordinates: none for the keyboard, or a
    /// click where the mouse already is.
    pub fn point(&self) -> Option<(f64, f64)> {
        match self {
            Action::Move { x, y } => Some((*x, *y)),
            Action::Click {
                x: Some(x),
                y: Some(y),
                ..
            }
            | Action::Down {
                x: Some(x),
                y: Some(y),
                ..
            }
            | Action::Up {
                x: Some(x),
                y: Some(y),
                ..
            }
            | Action::Scroll {
                x: Some(x),
                y: Some(y),
                ..
            } => Some((*x, *y)),
            Action::Drag { to, .. } => Some((to[0], to[1])),
            _ => None,
        }
    }
}

/// The size a display's screenshots have: the whole display scaled down to fit the box,
/// never up.
pub(crate) fn fit(width: u32, height: u32) -> (u32, u32) {
    let s = (MAX_W as f64 / width as f64)
        .min(MAX_H as f64 / height as f64)
        .min(1.0);
    (
        ((width as f64 * s).round() as u32).max(1),
        ((height as f64 * s).round() as u32).max(1),
    )
}

/// The size a zoomed region of `w`×`h` physical pixels is sent at.
pub(crate) fn fit_zoom(w: u32, h: u32) -> (u32, u32) {
    let s = (MAX_W as f64 / w as f64)
        .min(MAX_H as f64 / h as f64)
        .min(MAX_ZOOM_UPSCALE);
    (
        ((w as f64 * s).round() as u32).max(1),
        ((h as f64 * s).round() as u32).max(1),
    )
}

/// A screenshot point to the desktop point under it (in the display's units).
pub(crate) fn to_screen(d: &Display, x: f64, y: f64) -> (i32, i32) {
    let sx = d.width as f64 / d.shot_width as f64;
    let sy = d.height as f64 / d.shot_height as f64;
    let px = (x.clamp(0.0, d.shot_width as f64 - 1.0) * sx).round() as i32;
    let py = (y.clamp(0.0, d.shot_height as f64 - 1.0) * sy).round() as i32;
    (
        d.x + px.min(d.width as i32 - 1),
        d.y + py.min(d.height as i32 - 1),
    )
}

/// A desktop pixel to screenshot coordinates of `d`, when it falls on that display.
pub(crate) fn to_shot(d: &Display, x: i32, y: i32) -> Option<[i32; 2]> {
    if x < d.x || y < d.y || x >= d.x + d.width as i32 || y >= d.y + d.height as i32 {
        return None;
    }
    let sx = d.shot_width as f64 / d.width as f64;
    let sy = d.shot_height as f64 / d.height as f64;
    Some([
        ((x - d.x) as f64 * sx).round() as i32,
        ((y - d.y) as f64 * sy).round() as i32,
    ])
}

pub(crate) fn make_display(
    index: usize,
    primary: bool,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Display {
    let (shot_width, shot_height) = fit(width, height);
    Display {
        index,
        primary,
        x,
        y,
        width,
        height,
        shot_width,
        shot_height,
    }
}

/// Primary first, then left to right and top to bottom, so display 0 is always the main one.
pub(crate) fn order_displays(mut list: Vec<(i32, i32, u32, u32, bool)>) -> Vec<Display> {
    list.sort_by_key(|&(x, y, _, _, primary)| (!primary, x, y));
    list.into_iter()
        .enumerate()
        .map(|(i, (x, y, w, h, primary))| make_display(i, primary, x, y, w, h))
        .collect()
}

fn pick(displays: &[Display], index: usize) -> Result<Display, String> {
    displays.get(index).cloned().ok_or_else(|| {
        format!(
            "There is no display {index}: this computer has {} (0 to {}).",
            displays.len(),
            displays.len().saturating_sub(1)
        )
    })
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// The whole display, or with `region` ([x1, y1, x2, y2] in its screenshot coordinates) that
/// part of it at a higher resolution. `chat` is the session asking, for the lock.
#[tauri::command]
pub async fn computer_screenshot(
    app: AppHandle,
    chat: Option<String>,
    display: Option<usize>,
    region: Option<[f64; 4]>,
) -> Result<Shot, String> {
    blocking(move || {
        overlay::begin(&app, chat.as_deref())?;
        imp::screenshot(display.unwrap_or(0), region)
    })
    .await
}

#[tauri::command]
pub async fn computer_act(
    app: AppHandle,
    chat: Option<String>,
    display: Option<usize>,
    action: Action,
) -> Result<(), String> {
    blocking(move || {
        overlay::begin(&app, chat.as_deref())?;
        let index = display.unwrap_or(0);
        // The frame's glow gathers where the agent acts.
        if let Some((x, y)) = action.point() {
            if let Some(d) = imp::displays()
                .ok()
                .and_then(|ds| ds.into_iter().find(|d| d.index == index))
            {
                overlay::point(
                    &app,
                    index,
                    x / d.shot_width.max(1) as f64,
                    y / d.shot_height.max(1) as f64,
                );
            }
        }
        let token = control::token();
        imp::guard(index, &action)?;
        imp::act(index, action, &token)
    })
    .await
}

#[tauri::command]
pub async fn computer_windows(
    app: AppHandle,
    chat: Option<String>,
) -> Result<Vec<WindowInfo>, String> {
    blocking(move || {
        overlay::begin(&app, chat.as_deref())?;
        imp::windows()
    })
    .await
}

#[tauri::command]
pub async fn computer_focus(app: AppHandle, chat: Option<String>, id: i64) -> Result<(), String> {
    blocking(move || {
        overlay::begin(&app, chat.as_deref())?;
        imp::guard_window(id)?;
        imp::focus(id)
    })
    .await
}

/// A window's controls, numbered for `computer_element`.
#[tauri::command]
pub async fn computer_window_state(
    app: AppHandle,
    chat: Option<String>,
    id: i64,
) -> Result<uia::WindowState, String> {
    blocking(move || {
        overlay::begin(&app, chat.as_deref())?;
        imp::guard_window(id)?;
        uia::window_state(id)
    })
    .await
}

/// Acts on control `index` of window `window`'s latest read: "click", "double_click",
/// "right_click" or "set_value" (with `text`). Answers what it did.
#[tauri::command]
pub async fn computer_element(
    app: AppHandle,
    chat: Option<String>,
    window: i64,
    index: usize,
    action: String,
    text: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        overlay::begin(&app, chat.as_deref())?;
        let token = control::token();
        imp::guard_window(window)?;
        act_on_element(&Desktop { token: &token }, window, index, &action, text)
    })
    .await
}

/// What acting on a window's control needs from the desktop, so the decisions in
/// `act_on_element` can be tested without touching the real one.
pub(crate) trait ElementDesk {
    fn focus(&self, window: i64) -> Result<(), String>;
    /// The control's center on the desktop, when it has a place on screen.
    fn center(&self, window: i64, index: usize) -> Result<Option<(i32, i32)>, String>;
    /// Whether a click at desktop point (x, y) lands on `window` or a popup of its own (an
    /// open menu), and not on another window covering it.
    fn lands_on(&self, window: i64, x: i32, y: i32) -> bool;
    fn click(&self, x: i32, y: i32, button: &str, count: u32) -> Result<(), String>;
    fn invoke(&self, window: i64, index: usize) -> Result<bool, String>;
    fn set_value(&self, window: i64, index: usize, text: &str) -> Result<bool, String>;
    /// Selects what the focused field holds and types `text` over it.
    fn type_over(&self, text: String) -> Result<(), String>;
}

struct Desktop<'a> {
    token: &'a control::StopToken<'a>,
}

impl ElementDesk for Desktop<'_> {
    fn focus(&self, window: i64) -> Result<(), String> {
        imp::focus(window)
    }
    fn center(&self, window: i64, index: usize) -> Result<Option<(i32, i32)>, String> {
        Ok(uia::bounds(window, index)?.center())
    }
    fn lands_on(&self, window: i64, x: i32, y: i32) -> bool {
        imp::lands_on(window, x, y)
    }
    fn click(&self, x: i32, y: i32, button: &str, count: u32) -> Result<(), String> {
        imp::click_screen(x, y, button, count)
    }
    fn invoke(&self, window: i64, index: usize) -> Result<bool, String> {
        uia::invoke(window, index)
    }
    fn set_value(&self, window: i64, index: usize, text: &str) -> Result<bool, String> {
        uia::set_value(window, index, text)
    }
    fn type_over(&self, text: String) -> Result<(), String> {
        let select_all = if cfg!(target_os = "macos") {
            "cmd+a"
        } else {
            "ctrl+a"
        };
        imp::act(
            0,
            Action::Key {
                keys: select_all.into(),
            },
            self.token,
        )?;
        imp::act(0, Action::Type { text }, self.token)
    }
}

/// Acts on control `index` of `window`: "click", "double_click", "right_click" or "set_value".
/// The mouse and keyboard go to whatever is in front, so they are only used once the window has
/// come forward and the control's center is really on it; what goes through UI Automation or
/// Accessibility (pressing, setting a value) needs neither.
pub(crate) fn act_on_element(
    desk: &impl ElementDesk,
    window: i64,
    index: usize,
    action: &str,
    text: Option<String>,
) -> Result<String, String> {
    let focused = desk.focus(window);
    let center = desk.center(window, index)?;
    let click = |x: i32, y: i32, button: &str, count: u32| -> Result<(), String> {
        focused.clone()?;
        if !desk.lands_on(window, x, y) {
            return Err(format!("Element {index} is covered by another window, so it wasn't clicked. Bring its window to the front (focus_window) or close what covers it, then read the window again."));
        }
        desk.click(x, y, button, count)
    };
    match action {
        "click" | "double_click" | "right_click" => {
            let (button, count) = match action {
                "double_click" => ("left", 2),
                "right_click" => ("right", 1),
                _ => ("left", 1),
            };
            if let Some((x, y)) = center {
                click(x, y, button, count)?;
                return Ok(format!("Clicked element {index}."));
            }
            if action == "click" && desk.invoke(window, index)? {
                let api = if cfg!(target_os = "macos") {
                    "Accessibility"
                } else {
                    "UI Automation"
                };
                return Ok(format!(
                    "Element {index} has no place on screen, so it was pressed through {api}."
                ));
            }
            Err(format!(
                "Element {index} isn't on screen: scroll it into view and read the window again."
            ))
        }
        "set_value" => {
            let text = text.unwrap_or_default();
            if desk.set_value(window, index, &text)? {
                return Ok(format!("Set element {index} to the text."));
            }
            // No value to set (many custom fields): click it, select what's there, type.
            let (x, y) = center.ok_or(format!(
                "Element {index} isn't on screen and takes no value."
            ))?;
            click(x, y, "left", 1)?;
            desk.type_over(text)?;
            Ok(format!("Element {index} takes no value directly, so it was clicked and the text typed over its content."))
        }
        other => Err(format!(
            "Unknown element action \"{other}\" (click, double_click, right_click or set_value)."
        )),
    }
}

/// The frame's label in the app's language.
#[tauri::command]
pub fn computer_set_label(label: String) {
    overlay::set_label(label);
}

/// A session's turn ended: its hold on the computer and the frame go.
#[tauri::command]
pub fn computer_release(chat: Option<String>) {
    overlay::release(Some(chat.as_deref().unwrap_or("")));
}

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod imp;

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::*;

    const UNSUPPORTED: &str = "The Computer tool only works on Windows and macOS for now.";

    pub fn displays() -> Result<Vec<Display>, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn screenshot(_: usize, _: Option<[f64; 4]>) -> Result<Shot, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn act(_: usize, _: Action, _: &control::StopToken) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub struct Releaser;
    impl control::Release for Releaser {
        fn button_up(&self, _: control::MouseButton) {}
        fn key_up(&self, _: u16) {}
    }
    pub fn guard(_: usize, _: &Action) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn guard_window(_: i64) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn click_screen(_: i32, _: i32, _: &str, _: u32) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn windows() -> Result<Vec<WindowInfo>, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn focus(_: i64) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn lands_on(_: i64, _: i32, _: i32) -> bool {
        false
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use base64::Engine;
    use std::mem::{size_of, zeroed};
    use std::ptr::{null, null_mut};
    use std::thread::sleep;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, POINT, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors,
        GetDC, GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject, SetBrushOrgEx,
        SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, HALFTONE, HDC, HMONITOR, MONITORINFO, SRCCOPY,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetAncestor, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindow,
        GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SetCursorPos,
        SetForegroundWindow, ShowWindow, GA_ROOTOWNER, GWL_EXSTYLE, GW_OWNER, MONITORINFOF_PRIMARY,
        SM_SWAPBUTTON, SW_RESTORE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
    };

    const BLOCKED: &str = "Windows didn't take the input. A window running as administrator ignores input from Nyxs unless Nyxs runs as administrator too, and the lock screen or a UAC prompt takes none.";

    unsafe extern "system" fn on_monitor(m: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let list = &mut *(data as *mut Vec<(i32, i32, u32, u32, bool)>);
        let mut info: MONITORINFO = zeroed();
        info.cbSize = size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(m, &mut info) != 0 {
            let r = info.rcMonitor;
            list.push((
                r.left,
                r.top,
                (r.right - r.left) as u32,
                (r.bottom - r.top) as u32,
                info.dwFlags & MONITORINFOF_PRIMARY != 0,
            ));
        }
        1
    }

    pub fn displays() -> Result<Vec<Display>, String> {
        let mut list: Vec<(i32, i32, u32, u32, bool)> = Vec::new();
        unsafe {
            EnumDisplayMonitors(
                null_mut(),
                null(),
                Some(on_monitor),
                &mut list as *mut _ as LPARAM,
            )
        };
        if list.is_empty() {
            return Err("Windows reported no display.".into());
        }
        Ok(order_displays(list))
    }

    /// Copies a desktop rectangle into a `out_w`×`out_h` BGRA buffer, scaled with HALFTONE so
    /// shrunken text stays readable.
    fn capture(x: i32, y: i32, w: i32, h: i32, out_w: i32, out_h: i32) -> Result<Vec<u8>, String> {
        unsafe {
            let screen = GetDC(null_mut());
            if screen.is_null() {
                return Err("Couldn't open the screen to capture it.".into());
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, out_w, out_h);
            let old = SelectObject(mem, bmp);
            SetStretchBltMode(mem, HALFTONE);
            SetBrushOrgEx(mem, 0, 0, null_mut());
            // CAPTUREBLT takes layered windows (menus, tooltips, many modern apps) along.
            let ok = StretchBlt(
                mem,
                0,
                0,
                out_w,
                out_h,
                screen,
                x,
                y,
                w,
                h,
                SRCCOPY | CAPTUREBLT,
            );
            SelectObject(mem, old);
            let mut info: BITMAPINFO = zeroed();
            info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = out_w;
            info.bmiHeader.biHeight = -out_h;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB;
            let mut buf = vec![0u8; out_w as usize * out_h as usize * 4];
            let lines = if ok != 0 {
                GetDIBits(
                    mem,
                    bmp,
                    0,
                    out_h as u32,
                    buf.as_mut_ptr().cast(),
                    &mut info,
                    DIB_RGB_COLORS,
                )
            } else {
                0
            };
            DeleteObject(bmp);
            DeleteDC(mem);
            ReleaseDC(null_mut(), screen);
            if lines == 0 {
                return Err(
                    "Windows didn't let Nyxs capture the screen (it may be locked).".into(),
                );
            }
            Ok(buf)
        }
    }

    fn cursor() -> Option<(i32, i32)> {
        let mut p = POINT { x: 0, y: 0 };
        (unsafe { GetCursorPos(&mut p) } != 0).then_some((p.x, p.y))
    }

    pub fn screenshot(index: usize, region: Option<[f64; 4]>) -> Result<Shot, String> {
        let displays = displays()?;
        let d = pick(&displays, index)?;
        let (sx, sy, sw, sh, ow, oh) = match region {
            None => (
                d.x,
                d.y,
                d.width as i32,
                d.height as i32,
                d.shot_width,
                d.shot_height,
            ),
            Some([x1, y1, x2, y2]) => {
                let (ax, ay) = to_screen(&d, x1.min(x2), y1.min(y2));
                let (bx, by) = to_screen(&d, x1.max(x2), y1.max(y2));
                let (w, h) = ((bx - ax).max(1), (by - ay).max(1));
                if w < 4 || h < 4 {
                    return Err("The zoom region is too small: give two opposite corners at least a few pixels apart.".into());
                }
                let (ow, oh) = fit_zoom(w as u32, h as u32);
                (ax, ay, w, h, ow, oh)
            }
        };
        let pixels = capture(sx, sy, sw, sh, ow as i32, oh as i32)?;
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, JPEG_QUALITY)
            .encode(&pixels, ow as u16, oh as u16, jpeg_encoder::ColorType::Bgra)
            .map_err(|e| format!("Couldn't encode the screenshot: {e}"))?;
        let cursor = if region.is_none() {
            cursor().and_then(|(x, y)| to_shot(&d, x, y))
        } else {
            None
        };
        Ok(Shot {
            data: base64::engine::general_purpose::STANDARD.encode(jpeg),
            width: ow,
            height: oh,
            display: d,
            displays,
            cursor,
        })
    }

    fn send(inputs: &[INPUT]) -> Result<(), String> {
        if inputs.is_empty() {
            return Ok(());
        }
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                size_of::<INPUT>() as i32,
            )
        };
        if sent as usize != inputs.len() {
            return Err(BLOCKED.into());
        }
        Ok(())
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: data as _,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn is_extended(vk: u16) -> bool {
        matches!(
            vk,
            VK_RCONTROL
                | VK_RMENU
                | VK_INSERT
                | VK_DELETE
                | VK_HOME
                | VK_END
                | VK_PRIOR
                | VK_NEXT
                | VK_LEFT
                | VK_RIGHT
                | VK_UP
                | VK_DOWN
                | VK_LWIN
                | VK_RWIN
                | VK_APPS
                | VK_DIVIDE
                | VK_NUMLOCK
                | VK_SNAPSHOT
        )
    }

    fn key(vk: u16, up: bool) -> INPUT {
        // The scan code too: some apps (games, remote desktops) read it instead of the virtual key.
        let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
        let mut flags = if up { KEYEVENTF_KEYUP } else { 0 };
        if is_extended(vk) {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn unicode(unit: u16, up: bool) -> INPUT {
        let flags = KEYEVENTF_UNICODE | if up { KEYEVENTF_KEYUP } else { 0 };
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: 0,
                    wScan: unit,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// A key name (xdotool's, as Claude's computer use takes, or the usual ones) to its virtual
    /// key, plus the modifiers the layout needs to type it ("+" is shift+= on a US keyboard).
    pub(super) fn vk_for(name: &str) -> Option<(u16, Vec<u16>)> {
        let lower = name.to_ascii_lowercase();
        let named = match lower.as_str() {
            "ctrl" | "control" | "ctl" | "control_l" | "ctrl_l" => VK_CONTROL,
            "control_r" | "ctrl_r" => VK_RCONTROL,
            "shift" | "shift_l" => VK_SHIFT,
            "shift_r" => VK_RSHIFT,
            "alt" | "alt_l" | "option" => VK_MENU,
            "alt_r" | "altgr" => VK_RMENU,
            "win" | "windows" | "super" | "super_l" | "meta" | "cmd" | "command" => VK_LWIN,
            "super_r" => VK_RWIN,
            "enter" | "return" | "kp_enter" => VK_RETURN,
            "tab" => VK_TAB,
            "esc" | "escape" => VK_ESCAPE,
            "backspace" | "back_space" => VK_BACK,
            "delete" | "del" => VK_DELETE,
            "insert" | "ins" => VK_INSERT,
            "space" => VK_SPACE,
            "up" | "arrowup" => VK_UP,
            "down" | "arrowdown" => VK_DOWN,
            "left" | "arrowleft" => VK_LEFT,
            "right" | "arrowright" => VK_RIGHT,
            "home" => VK_HOME,
            "end" => VK_END,
            "pageup" | "page_up" | "prior" | "pgup" => VK_PRIOR,
            "pagedown" | "page_down" | "next" | "pgdn" => VK_NEXT,
            "capslock" | "caps_lock" => VK_CAPITAL,
            "numlock" | "num_lock" => VK_NUMLOCK,
            "printscreen" | "print" | "prtsc" => VK_SNAPSHOT,
            "pause" => VK_PAUSE,
            "apps" | "contextmenu" | "context_menu" => VK_APPS,
            "volumeup" | "audiovolumeup" | "xf86audioraisevolume" => VK_VOLUME_UP,
            "volumedown" | "audiovolumedown" | "xf86audiolowervolume" => VK_VOLUME_DOWN,
            "volumemute" | "audiovolumemute" | "xf86audiomute" => VK_VOLUME_MUTE,
            _ => 0,
        };
        if named != 0 {
            return Some((named, Vec::new()));
        }
        if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()) {
            if (1..=24).contains(&n) {
                return Some((VK_F1 + n - 1, Vec::new()));
            }
        }
        let ch = match lower.as_str() {
            "plus" => '+',
            "minus" => '-',
            "equal" => '=',
            "comma" => ',',
            "period" => '.',
            "slash" => '/',
            "backslash" => '\\',
            "semicolon" => ';',
            "colon" => ':',
            "apostrophe" | "quoteright" => '\'',
            "quotedbl" => '"',
            "grave" | "quoteleft" => '`',
            "bracketleft" => '[',
            "bracketright" => ']',
            "underscore" => '_',
            "asterisk" => '*',
            "exclam" => '!',
            "at" => '@',
            "numbersign" => '#',
            "dollar" => '$',
            "percent" => '%',
            "ampersand" => '&',
            "question" => '?',
            "less" => '<',
            "greater" => '>',
            _ => {
                let mut chars = name.chars();
                match (chars.next(), chars.next()) {
                    (Some(c), None) => c,
                    _ => return None,
                }
            }
        };
        let mut buf = [0u16; 2];
        let units = ch.encode_utf16(&mut buf);
        if units.len() != 1 {
            return None;
        }
        let scan = unsafe { VkKeyScanW(units[0]) };
        if scan == -1 {
            return None;
        }
        let vk = (scan as u16) & 0xff;
        let state = ((scan as u16) >> 8) & 0xff;
        // A letter named on its own is the key, not the capital: "ctrl+S" is ctrl+s.
        let mut mods = Vec::new();
        if state & 1 != 0 && !ch.is_ascii_alphabetic() {
            mods.push(VK_SHIFT);
        }
        if state & 2 != 0 {
            mods.push(VK_CONTROL);
        }
        if state & 4 != 0 {
            mods.push(VK_MENU);
        }
        Some((vk, mods))
    }

    /// "ctrl+shift+s" to its keys in pressing order. "ctrl++" is ctrl and plus.
    pub(super) fn parse_combo(combo: &str) -> Result<Vec<u16>, String> {
        let mut names: Vec<&str> = combo.split('+').collect();
        if combo.ends_with('+') {
            while names.last() == Some(&"") {
                names.pop();
            }
            names.push("+");
        }
        let mut keys: Vec<u16> = Vec::new();
        for name in names.iter().map(|n| n.trim()) {
            if name.is_empty() {
                return Err(format!(
                    "\"{combo}\" has an empty key between the plus signs."
                ));
            }
            let (vk, mods) =
                vk_for(name).ok_or_else(|| format!("Unknown key \"{name}\" in \"{combo}\"."))?;
            for m in mods {
                if !keys.contains(&m) {
                    keys.push(m);
                }
            }
            if !keys.contains(&vk) {
                keys.push(vk);
            }
        }
        Ok(keys)
    }

    fn press_all(keys: &[u16]) -> Vec<INPUT> {
        keys.iter().map(|&k| key(k, false)).collect()
    }

    fn release_all(keys: &[u16]) -> Vec<INPUT> {
        keys.iter().rev().map(|&k| key(k, true)).collect()
    }

    fn modifiers(text: &Option<String>) -> Result<Vec<u16>, String> {
        match text.as_deref().map(str::trim) {
            None | Some("") => Ok(Vec::new()),
            Some(t) => parse_combo(t),
        }
    }

    /// A button's down and up flags. With the buttons swapped in Windows, the primary button
    /// is the physical right one.
    fn flags_of(b: control::MouseButton) -> (MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
        let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
        let left = (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP);
        let right = (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP);
        match b {
            control::MouseButton::Left if swapped => right,
            control::MouseButton::Left => left,
            control::MouseButton::Right if swapped => left,
            control::MouseButton::Right => right,
            control::MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        }
    }

    fn buttons(name: &Option<String>) -> Result<(MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS), String> {
        Ok(flags_of(control::MouseButton::parse(name.as_deref())?))
    }

    /// Lets go of what Nyxs left pressed when the control goes.
    pub struct Releaser;

    impl control::Release for Releaser {
        fn button_up(&self, b: control::MouseButton) {
            let _ = send(&[mouse(flags_of(b).1, 0)]);
        }
        fn key_up(&self, code: u16) {
            let _ = send(&[key(code, true)]);
        }
    }

    fn move_to(d: &Display, x: f64, y: f64) -> Result<(), String> {
        let (sx, sy) = to_screen(d, x, y);
        if unsafe { SetCursorPos(sx, sy) } == 0 {
            return Err(BLOCKED.into());
        }
        // A tiny real move after the jump, so apps that track hover see the pointer arrive.
        send(&[mouse(MOUSEEVENTF_MOVE, 0)])?;
        sleep(Duration::from_millis(30));
        Ok(())
    }

    fn maybe_move(d: &Display, x: Option<f64>, y: Option<f64>) -> Result<(), String> {
        match (x, y) {
            (Some(x), Some(y)) => move_to(d, x, y),
            (None, None) => Ok(()),
            _ => Err("Give both x and y, or neither to act where the pointer is.".into()),
        }
    }

    fn type_text(text: &str, token: &control::StopToken) -> Result<(), String> {
        let mut batches: Vec<Vec<INPUT>> = Vec::new();
        let mut batch: Vec<INPUT> = Vec::new();
        for ch in text.chars() {
            match ch {
                '\r' => continue,
                '\n' => batch.extend([key(VK_RETURN, false), key(VK_RETURN, true)]),
                '\t' => batch.extend([key(VK_TAB, false), key(VK_TAB, true)]),
                _ => {
                    let mut buf = [0u16; 2];
                    for &u in ch.encode_utf16(&mut buf).iter() {
                        batch.extend([unicode(u, false), unicode(u, true)]);
                    }
                }
            }
            // Small batches with a pause between them: apps that handle each key slowly
            // (editors with autocomplete, Electron) otherwise drop or reorder characters.
            if batch.len() >= 40 {
                batches.push(std::mem::take(&mut batch));
            }
        }
        batches.push(batch);
        // A stop (Esc, the turn ended) ends it between batches instead of typing on into
        // whatever has the focus.
        token.run(batches.iter().enumerate(), |(i, b)| {
            if i > 0 {
                token.sleep(Duration::from_millis(15))?;
            }
            send(b)
        })
    }

    pub fn act(index: usize, action: Action, token: &control::StopToken) -> Result<(), String> {
        let needs_display = matches!(
            action,
            Action::Move { .. }
                | Action::Click { .. }
                | Action::Down { .. }
                | Action::Up { .. }
                | Action::Drag { .. }
                | Action::Scroll { .. }
        );
        let d = if needs_display {
            Some(pick(&displays()?, index)?)
        } else {
            None
        };
        let d = d.as_ref();
        match action {
            Action::Move { x, y } => move_to(d.unwrap(), x, y),
            Action::Click {
                x,
                y,
                button,
                count,
                modifiers: mods,
            } => {
                maybe_move(d.unwrap(), x, y)?;
                let (down, up) = buttons(&button)?;
                let held = modifiers(&mods)?;
                let mut seq = press_all(&held);
                for _ in 0..count.unwrap_or(1).clamp(1, 3) {
                    seq.extend([mouse(down, 0), mouse(up, 0)]);
                }
                seq.extend(release_all(&held));
                send(&seq)
            }
            Action::Down { x, y, button } => {
                maybe_move(d.unwrap(), x, y)?;
                let b = control::MouseButton::parse(button.as_deref())?;
                send(&[mouse(flags_of(b).0, 0)])?;
                // Held until its up, or until the control goes.
                control::held()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .press_button(b);
                Ok(())
            }
            Action::Up { x, y, button } => {
                maybe_move(d.unwrap(), x, y)?;
                let b = control::MouseButton::parse(button.as_deref())?;
                control::held()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .release_button(b);
                send(&[mouse(flags_of(b).1, 0)])
            }
            Action::Drag { from, to, button } => {
                let d = d.unwrap();
                let (down, up) = buttons(&button)?;
                move_to(d, from[0], from[1])?;
                send(&[mouse(down, 0)])?;
                // In steps: a jump straight to the end doesn't start a drag in most apps.
                const STEPS: u32 = 12;
                let moved = token
                    .run(1..=STEPS, |i| {
                        let t = i as f64 / STEPS as f64;
                        let (sx, sy) = to_screen(
                            d,
                            from[0] + (to[0] - from[0]) * t,
                            from[1] + (to[1] - from[1]) * t,
                        );
                        unsafe { SetCursorPos(sx, sy) };
                        send(&[mouse(MOUSEEVENTF_MOVE, 0)])?;
                        token.sleep(Duration::from_millis(15))
                    })
                    .and_then(|_| token.sleep(Duration::from_millis(50)));
                // Released however the drag went: a stop or an error must not leave it pressed.
                let released = send(&[mouse(up, 0)]);
                moved.and(released)
            }
            Action::Scroll {
                x,
                y,
                dx,
                dy,
                modifiers: mods,
            } => {
                maybe_move(d.unwrap(), x, y)?;
                let held = modifiers(&mods)?;
                let mut seq = press_all(&held);
                for _ in 0..dy.unsigned_abs().min(50) {
                    seq.push(mouse(MOUSEEVENTF_WHEEL, if dy > 0 { -120 } else { 120 }));
                }
                for _ in 0..dx.unsigned_abs().min(50) {
                    seq.push(mouse(MOUSEEVENTF_HWHEEL, if dx > 0 { 120 } else { -120 }));
                }
                seq.extend(release_all(&held));
                send(&seq)
            }
            Action::Type { text } => type_text(&text, token),
            Action::Key { keys } => token.run(keys.split_whitespace(), |combo| {
                let k = parse_combo(combo)?;
                let mut seq = press_all(&k);
                seq.extend(release_all(&k));
                send(&seq)?;
                sleep(Duration::from_millis(40));
                Ok(())
            }),
            Action::HoldKey { keys, ms } => {
                let k = parse_combo(keys.trim())?;
                send(&press_all(&k))?;
                let waited = control::holding_keys(&k, || {
                    token.sleep(Duration::from_millis(ms.min(10_000)))
                });
                // Released however the wait ended.
                let released = send(&release_all(&k));
                waited.and(released)
            }
        }
    }

    fn window_text(h: HWND) -> String {
        unsafe {
            let len = GetWindowTextLengthW(h);
            if len <= 0 {
                return String::new();
            }
            let mut buf = vec![0u16; len as usize + 1];
            let n = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
            String::from_utf16_lossy(&buf[..n.max(0) as usize])
        }
    }

    fn process_name(pid: u32) -> String {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return String::new();
            }
            let mut buf = vec![0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
            CloseHandle(h);
            if ok == 0 {
                return String::new();
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string()
        }
    }

    unsafe extern "system" fn on_window(h: HWND, data: LPARAM) -> BOOL {
        let list = &mut *(data as *mut Vec<HWND>);
        if IsWindowVisible(h) == 0 || !GetWindow(h, GW_OWNER).is_null() {
            return 1;
        }
        if GetWindowLongW(h, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW != 0 {
            return 1;
        }
        // Store apps and windows on other virtual desktops are "visible" but cloaked.
        let mut cloaked: u32 = 0;
        DwmGetWindowAttribute(
            h,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast(),
            size_of::<u32>() as u32,
        );
        if cloaked != 0 {
            return 1;
        }
        list.push(h);
        1
    }

    /// The desktop's top-level app windows, front to back.
    pub fn windows() -> Result<Vec<WindowInfo>, String> {
        let mut handles: Vec<HWND> = Vec::new();
        unsafe { EnumWindows(Some(on_window), &mut handles as *mut _ as LPARAM) };
        let fg = unsafe { GetForegroundWindow() };
        let mut out = Vec::new();
        for h in handles {
            let title = window_text(h);
            if title.trim().is_empty() {
                continue;
            }
            let mut r: RECT = unsafe { zeroed() };
            unsafe { GetWindowRect(h, &mut r) };
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(h, &mut pid) };
            out.push(WindowInfo {
                id: h as i64,
                title,
                process: process_name(pid),
                x: r.left,
                y: r.top,
                width: r.right - r.left,
                height: r.bottom - r.top,
                minimized: unsafe { IsIconic(h) } != 0,
                focused: h == fg,
            });
        }
        Ok(out)
    }

    const OWN_WINDOW: &str = "That is Nyxs' own window, where the user is chatting with you. Don't act on it: focus the app you're working in first (list_windows, then focus_window).";

    fn pid_of(h: HWND) -> u32 {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, &mut pid) };
        pid
    }

    /// The process owning the window a click at desktop point (x, y) would land on.
    fn pid_at(x: i32, y: i32) -> Option<u32> {
        window_at(x, y).map(pid_of)
    }

    /// The window an owned popup (a menu, a dropdown) belongs to; a window owned by none is its
    /// own.
    fn root_owner(h: HWND) -> HWND {
        let root = unsafe { GetAncestor(h, GA_ROOTOWNER) };
        if root.is_null() {
            h
        } else {
            root
        }
    }

    pub fn lands_on(window: i64, x: i32, y: i32) -> bool {
        window_at(x, y).is_some_and(|h| root_owner(h) == root_owner(window as HWND))
    }

    /// The top-level window a click at desktop point (x, y) would land on: the top visible
    /// window there, past click-through ones (the frame is one).
    fn window_at(x: i32, y: i32) -> Option<HWND> {
        struct Probe {
            x: i32,
            y: i32,
            hit: Option<HWND>,
        }
        unsafe extern "system" fn on_window(h: HWND, data: LPARAM) -> BOOL {
            let p = &mut *(data as *mut Probe);
            if IsWindowVisible(h) == 0 || IsIconic(h) != 0 {
                return 1;
            }
            if GetWindowLongW(h, GWL_EXSTYLE) as u32 & WS_EX_TRANSPARENT != 0 {
                return 1;
            }
            let mut cloaked: u32 = 0;
            DwmGetWindowAttribute(
                h,
                DWMWA_CLOAKED as u32,
                (&mut cloaked as *mut u32).cast(),
                size_of::<u32>() as u32,
            );
            if cloaked != 0 {
                return 1;
            }
            let mut r: RECT = zeroed();
            GetWindowRect(h, &mut r);
            if p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom {
                p.hit = Some(h);
                return 0;
            }
            1
        }
        let mut probe = Probe { x, y, hit: None };
        unsafe { EnumWindows(Some(on_window), &mut probe as *mut _ as LPARAM) };
        probe.hit
    }

    /// Refuses an action that would land on Nyxs itself: a click on its window, or keys while
    /// it has the focus (they would go into the user's chat box).
    pub fn guard(index: usize, action: &Action) -> Result<(), String> {
        let me = std::process::id();
        let point = |x: Option<f64>, y: Option<f64>| -> Result<(i32, i32), String> {
            match (x, y) {
                (Some(x), Some(y)) => Ok(to_screen(&pick(&displays()?, index)?, x, y)),
                _ => cursor().ok_or_else(|| "Couldn't read the pointer's position.".to_string()),
            }
        };
        let points = match action {
            Action::Click { x, y, .. }
            | Action::Down { x, y, .. }
            | Action::Scroll { x, y, .. } => vec![point(*x, *y)?],
            Action::Drag { from, to, .. } => vec![
                point(Some(from[0]), Some(from[1]))?,
                point(Some(to[0]), Some(to[1]))?,
            ],
            Action::Type { .. } | Action::Key { .. } | Action::HoldKey { .. } => {
                let fg = unsafe { GetForegroundWindow() };
                if !fg.is_null() && pid_of(fg) == me {
                    return Err(OWN_WINDOW.into());
                }
                Vec::new()
            }
            Action::Move { .. } | Action::Up { .. } => Vec::new(),
        };
        if points.into_iter().any(|(x, y)| pid_at(x, y) == Some(me)) {
            return Err(OWN_WINDOW.into());
        }
        Ok(())
    }

    pub fn guard_window(id: i64) -> Result<(), String> {
        let h = id as HWND;
        if unsafe { IsWindow(h) } == 0 {
            return Err("That window no longer exists; list the windows again.".into());
        }
        if pid_of(h) == std::process::id() {
            return Err(OWN_WINDOW.into());
        }
        Ok(())
    }

    /// Clicks at a desktop point in physical pixels (an element's center).
    pub fn click_screen(x: i32, y: i32, button: &str, count: u32) -> Result<(), String> {
        if pid_at(x, y) == Some(std::process::id()) {
            return Err("Nyxs' own window covers that element. Focus its app first.".into());
        }
        if unsafe { SetCursorPos(x, y) } == 0 {
            return Err(BLOCKED.into());
        }
        send(&[mouse(MOUSEEVENTF_MOVE, 0)])?;
        sleep(Duration::from_millis(30));
        let (down, up) = buttons(&Some(button.to_string()))?;
        let mut seq = Vec::new();
        for _ in 0..count.clamp(1, 3) {
            seq.extend([mouse(down, 0), mouse(up, 0)]);
        }
        send(&seq)
    }

    pub fn focus(id: i64) -> Result<(), String> {
        let h = id as HWND;
        unsafe {
            if IsWindow(h) == 0 {
                return Err("That window no longer exists; list the windows again.".into());
            }
            if IsIconic(h) != 0 {
                ShowWindow(h, SW_RESTORE);
            }
            SetForegroundWindow(h);
            sleep(Duration::from_millis(120));
            if GetForegroundWindow() != h {
                // Windows only lets the app that last got input hand focus over; a tap of Alt
                // from us counts as that input.
                send(&[key(VK_MENU, false), key(VK_MENU, true)])?;
                SetForegroundWindow(h);
                sleep(Duration::from_millis(120));
            }
            if GetForegroundWindow() != h {
                return Err("Windows didn't bring that window to the front. Click on it in a screenshot instead.".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_point_an_action_acts_on_is_where_the_frame_glows() {
        let click: Action = serde_json::from_str(r#"{"kind":"click","x":10,"y":20}"#).unwrap();
        assert_eq!(click.point(), Some((10.0, 20.0)));
        let drag: Action =
            serde_json::from_str(r#"{"kind":"drag","from":[1,2],"to":[30,40]}"#).unwrap();
        assert_eq!(drag.point(), Some((30.0, 40.0)));
        let here: Action = serde_json::from_str(r#"{"kind":"click"}"#).unwrap();
        assert_eq!(here.point(), None);
        let typing: Action = serde_json::from_str(r#"{"kind":"type","text":"hi"}"#).unwrap();
        assert_eq!(typing.point(), None);
    }

    #[test]
    fn fits_screens_in_the_box_without_enlarging() {
        assert_eq!(fit(1920, 1080), (1280, 720));
        assert_eq!(fit(2560, 1600), (1280, 800));
        assert_eq!(fit(3840, 2160), (1280, 720));
        assert_eq!(fit(1024, 768), (1024, 768));
        assert_eq!(fit(1080, 1920), (450, 800));
    }

    #[test]
    fn zoom_enlarges_small_regions_up_to_twice() {
        assert_eq!(fit_zoom(200, 100), (400, 200));
        assert_eq!(fit_zoom(1920, 1080), (1280, 720));
    }

    #[test]
    fn maps_points_between_screenshot_and_screen() {
        let d = make_display(1, false, 1920, -200, 3840, 2160);
        assert_eq!((d.shot_width, d.shot_height), (1280, 720));
        assert_eq!(to_screen(&d, 0.0, 0.0), (1920, -200));
        assert_eq!(to_screen(&d, 640.0, 360.0), (1920 + 1920, -200 + 1080));
        assert_eq!(to_screen(&d, 5000.0, 5000.0), (1920 + 3837, -200 + 2157));
        assert_eq!(to_shot(&d, 1920 + 1920, -200 + 1080), Some([640, 360]));
        assert_eq!(to_shot(&d, 0, 0), None);
    }

    #[test]
    fn puts_the_primary_display_first() {
        let list = order_displays(vec![
            (-1920, 0, 1920, 1080, false),
            (1920, 0, 1920, 1080, false),
            (0, 0, 2560, 1440, true),
        ]);
        assert_eq!(
            list.iter().map(|d| d.x).collect::<Vec<_>>(),
            vec![0, -1920, 1920]
        );
        assert_eq!(
            list.iter().map(|d| d.index).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert!(list[0].primary);
    }

    /// A desktop where the window may fail to come forward and another window may cover the
    /// control; it records what was done to it.
    struct FakeDesk {
        focus: Result<(), String>,
        center: Option<(i32, i32)>,
        covered: bool,
        takes_value: bool,
        log: std::cell::RefCell<Vec<String>>,
    }

    impl FakeDesk {
        fn new() -> Self {
            Self {
                focus: Ok(()),
                center: Some((100, 200)),
                covered: false,
                takes_value: false,
                log: Default::default(),
            }
        }
        fn did(&self) -> Vec<String> {
            self.log.borrow().clone()
        }
    }

    impl ElementDesk for FakeDesk {
        fn focus(&self, _: i64) -> Result<(), String> {
            self.focus.clone()
        }
        fn center(&self, _: i64, _: usize) -> Result<Option<(i32, i32)>, String> {
            Ok(self.center)
        }
        fn lands_on(&self, _: i64, _: i32, _: i32) -> bool {
            !self.covered
        }
        fn click(&self, x: i32, y: i32, button: &str, count: u32) -> Result<(), String> {
            self.log
                .borrow_mut()
                .push(format!("click {button} x{count} at {x},{y}"));
            Ok(())
        }
        fn invoke(&self, _: i64, index: usize) -> Result<bool, String> {
            self.log.borrow_mut().push(format!("invoke {index}"));
            Ok(true)
        }
        fn set_value(&self, _: i64, index: usize, text: &str) -> Result<bool, String> {
            if self.takes_value {
                self.log.borrow_mut().push(format!("set {index} to {text}"));
            }
            Ok(self.takes_value)
        }
        fn type_over(&self, text: String) -> Result<(), String> {
            self.log.borrow_mut().push(format!("type {text}"));
            Ok(())
        }
    }

    #[test]
    fn clicks_a_control_whose_window_came_forward() {
        let desk = FakeDesk::new();
        assert_eq!(
            act_on_element(&desk, 1, 4, "double_click", None),
            Ok("Clicked element 4.".into())
        );
        assert_eq!(desk.did(), vec!["click left x2 at 100,200"]);
    }

    #[test]
    fn doesnt_click_when_the_window_wont_come_forward() {
        let mut desk = FakeDesk::new();
        desk.focus = Err("Windows didn't bring that window to the front.".into());
        assert_eq!(
            act_on_element(&desk, 1, 4, "click", None),
            Err("Windows didn't bring that window to the front.".into())
        );
        assert!(desk.did().is_empty());
    }

    #[test]
    fn doesnt_click_a_control_another_window_covers() {
        let mut desk = FakeDesk::new();
        desk.covered = true;
        let err = act_on_element(&desk, 1, 4, "click", None).unwrap_err();
        assert!(err.contains("covered by another window"), "{err}");
        let err = act_on_element(&desk, 1, 4, "set_value", Some("hi".into())).unwrap_err();
        assert!(err.contains("covered by another window"), "{err}");
        assert!(desk.did().is_empty());
    }

    #[test]
    fn what_needs_no_mouse_works_without_the_focus() {
        let mut desk = FakeDesk::new();
        desk.focus = Err("no focus".into());
        desk.center = None;
        assert!(act_on_element(&desk, 1, 4, "click", None)
            .unwrap()
            .contains("pressed through"));
        desk.takes_value = true;
        assert_eq!(
            act_on_element(&desk, 1, 4, "set_value", Some("hi".into())),
            Ok("Set element 4 to the text.".into())
        );
        assert_eq!(desk.did(), vec!["invoke 4", "set 4 to hi"]);
    }

    #[test]
    fn types_over_a_field_that_takes_no_value() {
        let desk = FakeDesk::new();
        assert!(act_on_element(&desk, 1, 4, "set_value", Some("hi".into()))
            .unwrap()
            .contains("typed over"));
        assert_eq!(desk.did(), vec!["click left x1 at 100,200", "type hi"]);
    }

    #[cfg(windows)]
    #[test]
    fn parses_key_combos() {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            VK_CONTROL, VK_F4, VK_MENU, VK_RETURN, VK_SHIFT,
        };
        assert_eq!(
            imp::parse_combo("ctrl+shift+s").unwrap(),
            vec![VK_CONTROL, VK_SHIFT, b'S' as u16]
        );
        assert_eq!(
            imp::parse_combo("ctrl+S").unwrap(),
            vec![VK_CONTROL, b'S' as u16]
        );
        assert_eq!(imp::parse_combo("alt+F4").unwrap(), vec![VK_MENU, VK_F4]);
        assert_eq!(imp::parse_combo("Return").unwrap(), vec![VK_RETURN]);
        assert!(imp::parse_combo("ctrl++")
            .unwrap()
            .starts_with(&[VK_CONTROL]));
        assert!(imp::parse_combo("ctrl+nokey").is_err());
    }
}

#[cfg(all(test, windows))]
mod live {
    /// Takes a real screenshot and lists the windows: `cargo test --lib computer::live -- --ignored`.
    #[test]
    #[ignore]
    fn captures_the_screen_and_lists_windows() {
        use base64::Engine;
        let shot = super::imp::screenshot(0, None).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&shot.data)
            .unwrap();
        let out = std::env::temp_dir().join("nyxs-computer-shot.jpg");
        std::fs::write(&out, bytes).unwrap();
        println!(
            "{}x{} {:?} cursor {:?} -> {}",
            shot.width,
            shot.height,
            shot.display,
            shot.cursor,
            out.display()
        );
        // Moves the pointer to the screenshot's center and back, checking where it lands.
        let back = shot.cursor;
        let (cx, cy) = (
            shot.display.shot_width as f64 / 2.0,
            shot.display.shot_height as f64 / 2.0,
        );
        let token = super::control::token();
        super::imp::act(0, super::Action::Move { x: cx, y: cy }, &token).unwrap();
        let moved = super::imp::screenshot(0, None).unwrap().cursor.unwrap();
        assert!(
            (moved[0] - cx as i32).abs() <= 1 && (moved[1] - cy as i32).abs() <= 1,
            "{moved:?}"
        );
        if let Some([x, y]) = back {
            super::imp::act(
                0,
                super::Action::Move {
                    x: x as f64,
                    y: y as f64,
                },
                &token,
            )
            .unwrap();
        }
        if let Some(w) = super::imp::windows()
            .unwrap()
            .into_iter()
            .find(|w| w.process != "app.exe" && !w.minimized)
        {
            let t = std::time::Instant::now();
            let state = super::uia::window_state(w.id).unwrap();
            println!(
                "UIA {} ({} elements, {:?}, truncated {}):",
                state.title,
                state.count,
                t.elapsed(),
                state.truncated
            );
            for line in state.tree.lines().take(25) {
                println!("  {line}");
            }
        }
        for w in super::imp::windows().unwrap().iter().take(8) {
            println!("{} [{}] {}", w.id, w.process, w.title);
        }
    }
}
