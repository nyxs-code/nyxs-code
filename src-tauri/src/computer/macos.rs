//! The Computer tool on macOS: ScreenCaptureKit for screenshots, CGEvent for the mouse and the
//! keyboard, the window server's list for windows and Accessibility to raise one.
//!
//! Coordinates: a `Display` and every desktop point here are in global *points* (top-left origin
//! at the main display), the space CGEvent, CGWindowList and Accessibility all use, so nothing is
//! converted between them. Only the capture works in real pixels (points × the display's backing
//! scale), so text stays sharp before `fit` shrinks it.

use super::keymap::{self, CharKeys};
use super::*;
use base64::Engine;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
use objc2_application_services::{AXError, AXIsProcessTrusted, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect,
    CGSize,
};
use objc2_core_graphics::{
    kCGWindowAlpha, kCGWindowBounds, kCGWindowLayer, kCGWindowName, kCGWindowNumber,
    kCGWindowOwnerName, kCGWindowOwnerPID, CGBitmapContextCreate, CGColorSpace, CGContext,
    CGDirectDisplayID, CGDisplayBounds, CGDisplayCopyDisplayMode, CGDisplayMode, CGError, CGEvent,
    CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation,
    CGEventType, CGGetActiveDisplayList, CGImage, CGImageAlphaInfo, CGImageByteOrderInfo,
    CGInterpolationQuality, CGMainDisplayID, CGMouseButton, CGPreflightScreenCaptureAccess,
    CGRectMakeWithDictionaryRepresentation, CGScrollEventUnit, CGWindowListCopyWindowInfo,
    CGWindowListOption,
};
use objc2_foundation::{NSArray, NSError, NSOperatingSystemVersion, NSProcessInfo};
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow,
};
use std::ptr::NonNull;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::sleep;
use std::time::{Duration, Instant};

const SCREEN_PERMISSION: &str = "Nyxs needs the Screen Recording permission: System Settings › Privacy & Security › Screen Recording. Ask the user to turn it on, then try again.";
const INPUT_PERMISSION: &str = "Nyxs needs the Accessibility permission: System Settings › Privacy & Security › Accessibility. Ask the user to turn it on, then try again.";
const OWN_WINDOW: &str = "That is Nyxs' own window, where the user is chatting with you. Don't act on it: focus the app you're working in first (list_windows, then focus_window).";
const GONE: &str = "That window no longer exists; list the windows again.";
/// The title of the frames overlay.rs draws around the displays.
const FRAME_TITLE: &str = "Nyxs computer use";
/// ScreenCaptureKit answers in well under a second; past this something is stuck.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

/// Moves an Objective-C object out of a completion handler's queue. ScreenCaptureKit hands over
/// immutable results and nothing touches them on its side afterwards.
struct Sendable<T>(T);
unsafe impl<T> Send for Sendable<T> {}

fn my_pid() -> i32 {
    std::process::id() as i32
}

/// The active displays with their ids and backing scale (pixels per point), in `order_displays`
/// order.
fn display_list() -> Result<Vec<(Display, CGDirectDisplayID, f64)>, String> {
    let mut ids = [0 as CGDirectDisplayID; 32];
    let mut count = 0u32;
    let err = unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
    if err != CGError::Success || count == 0 {
        return Err("macOS reported no display.".into());
    }
    let main = CGMainDisplayID();
    let raw: Vec<(CGDirectDisplayID, CGRect)> = ids[..count as usize]
        .iter()
        .map(|&id| (id, CGDisplayBounds(id)))
        .collect();
    let ordered = order_displays(
        raw.iter()
            .map(|(id, r)| {
                (
                    r.origin.x.round() as i32,
                    r.origin.y.round() as i32,
                    r.size.width.round().max(1.0) as u32,
                    r.size.height.round().max(1.0) as u32,
                    *id == main,
                )
            })
            .collect(),
    );
    Ok(ordered
        .into_iter()
        .filter_map(|d| {
            let &(id, r) = raw.iter().find(|(_, r)| {
                r.origin.x.round() as i32 == d.x && r.origin.y.round() as i32 == d.y
            })?;
            Some((d, id, backing_scale(id, r.size.width)))
        })
        .collect())
}

fn backing_scale(id: CGDirectDisplayID, points_wide: f64) -> f64 {
    let Some(mode) = CGDisplayCopyDisplayMode(id) else {
        return 1.0;
    };
    let pixels = CGDisplayMode::pixel_width(Some(&mode)) as f64;
    if points_wide >= 1.0 && pixels >= 1.0 {
        (pixels / points_wide).clamp(1.0, 4.0)
    } else {
        1.0
    }
}

pub fn displays() -> Result<Vec<Display>, String> {
    Ok(display_list()?.into_iter().map(|(d, _, _)| d).collect())
}

fn cursor() -> Option<(i32, i32)> {
    let ev = CGEvent::new(None)?;
    let p = CGEvent::location(Some(&ev));
    Some((p.x.round() as i32, p.y.round() as i32))
}

/// Whether `r` covers display `d` exactly: how the frames are told apart when their title can't
/// be read.
fn covers_display(r: &CGRect, d: &Display) -> bool {
    (r.origin.x - d.x as f64).abs() < 2.0
        && (r.origin.y - d.y as f64).abs() < 2.0
        && (r.size.width - d.width as f64).abs() < 2.0
        && (r.size.height - d.height as f64).abs() < 2.0
}

fn is_frame(pid: i32, title: &str, layer: i64, r: &CGRect, displays: &[Display]) -> bool {
    pid == my_pid()
        && (title == FRAME_TITLE || (layer != 0 && displays.iter().any(|d| covers_display(r, d))))
}

/// Runs an asynchronous ScreenCaptureKit call and waits for its completion handler.
fn wait<T>(rx: mpsc::Receiver<Result<Sendable<T>, String>>) -> Result<T, String> {
    match rx.recv_timeout(CAPTURE_TIMEOUT) {
        Ok(r) => r.map(|s| s.0),
        Err(_) => Err("macOS didn't answer the screen capture in time.".into()),
    }
}

fn ns_error(e: *mut NSError) -> String {
    match unsafe { e.as_ref() } {
        Some(e) => e.localizedDescription().to_string(),
        None => "unknown error".into(),
    }
}

fn shareable_content() -> Result<Retained<SCShareableContent>, String> {
    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
        // The handler gives the content at +0: retain it to keep it past the block.
        let got = unsafe { Retained::retain(content) };
        let _ = tx.send(match got {
            Some(c) => Ok(Sendable(c)),
            None => Err(format!(
                "macOS didn't list what can be captured: {}",
                ns_error(err)
            )),
        });
    });
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            false, true, &block,
        )
    };
    wait(rx)
}

/// Captures part of display `id` (`source` in points, relative to the display) at `px_w`×`px_h`
/// pixels, leaving out our own frames.
fn capture_image(
    id: CGDirectDisplayID,
    source: Option<CGRect>,
    px_w: u32,
    px_h: u32,
) -> Result<CFRetained<CGImage>, String> {
    let content = shareable_content()?;
    let display = unsafe { content.displays() }
        .iter()
        .find(|s| unsafe { s.displayID() } == id)
        .ok_or("That display is gone; take a screenshot again.")?;
    let all = displays().unwrap_or_default();
    // Since macOS 15 a window's sharing type no longer hides it from ScreenCaptureKit, so the
    // frames are left out by the filter. Nyxs' main window stays in, as on Windows.
    let frames: Vec<Retained<SCWindow>> = unsafe { content.windows() }
        .iter()
        .filter(|w| unsafe {
            let pid = w
                .owningApplication()
                .map(|a| a.processID())
                .unwrap_or_default();
            let title = w.title().map(|t| t.to_string()).unwrap_or_default();
            is_frame(pid, &title, w.windowLayer() as i64, &w.frame(), &all)
        })
        .collect();
    let excluded = NSArray::from_retained_slice(&frames);
    let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingWindows(
            SCContentFilter::alloc(),
            &display,
            &excluded,
        )
    };
    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth(px_w as usize);
        config.setHeight(px_h as usize);
        // The pointer is reported apart (`Shot::cursor`), as on Windows.
        config.setShowsCursor(false);
        if let Some(r) = source {
            config.setSourceRect(r);
        }
    }
    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |image: *mut CGImage, err: *mut NSError| {
        let got = NonNull::new(image).map(|p| unsafe { CFRetained::retain(p) });
        let _ = tx.send(match got {
            Some(i) => Ok(Sendable(i)),
            None => Err(format!("Couldn't capture the screen: {}", ns_error(err))),
        });
    });
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
            &filter,
            &config,
            Some(&block),
        )
    };
    wait(rx)
}

/// Draws `image` into a `w`×`h` BGRX buffer: scales it with high-quality interpolation (so
/// shrunken text stays readable) and converts whatever format it came in.
fn to_bgra(image: &CGImage, w: u32, h: u32) -> Result<Vec<u8>, String> {
    let (w, h) = (w as usize, h as usize);
    let mut buf = vec![0u8; w * h * 4];
    let space = CGColorSpace::new_device_rgb().ok_or("Couldn't create a color space.")?;
    let ctx = unsafe {
        CGBitmapContextCreate(
            buf.as_mut_ptr().cast(),
            w,
            h,
            8,
            w * 4,
            Some(&space),
            CGImageAlphaInfo::NoneSkipFirst.0 | CGImageByteOrderInfo::Order32Little.0,
        )
    }
    .ok_or("Couldn't create the screenshot's bitmap.")?;
    CGContext::set_interpolation_quality(Some(&ctx), CGInterpolationQuality::High);
    let rect = CGRect {
        origin: CGPoint { x: 0.0, y: 0.0 },
        size: CGSize {
            width: w as f64,
            height: h as f64,
        },
    };
    CGContext::draw_image(Some(&ctx), rect, Some(image));
    // The context writes into `buf`; it must be gone before the buffer is read or moved.
    drop(ctx);
    Ok(buf)
}

pub fn screenshot(index: usize, region: Option<[f64; 4]>) -> Result<Shot, String> {
    if !CGPreflightScreenCaptureAccess() {
        return Err(SCREEN_PERMISSION.into());
    }
    let sonoma = NSOperatingSystemVersion {
        majorVersion: 14,
        minorVersion: 0,
        patchVersion: 0,
    };
    if !NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(sonoma) {
        return Err("The Computer tool's screenshots need macOS 14 or later.".into());
    }
    let list = display_list()?;
    let displays: Vec<Display> = list.iter().map(|(d, _, _)| d.clone()).collect();
    let d = pick(&displays, index)?;
    let (id, scale) = (list[index].1, list[index].2);
    let px = |v: f64| ((v * scale).round() as u32).max(1);
    let (source, cap_w, cap_h, ow, oh) = match region {
        None => (
            None,
            px(d.width as f64),
            px(d.height as f64),
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
            let rect = CGRect {
                origin: CGPoint {
                    x: (ax - d.x) as f64,
                    y: (ay - d.y) as f64,
                },
                size: CGSize {
                    width: w as f64,
                    height: h as f64,
                },
            };
            let (cw, ch) = (px(w as f64), px(h as f64));
            // Sized from the region's real pixels, so a zoom shows all the detail there is.
            let (ow, oh) = fit_zoom(cw, ch);
            (Some(rect), cw, ch, ow, oh)
        }
    };
    let image = capture_image(id, source, cap_w, cap_h)?;
    let pixels = to_bgra(&image, ow, oh)?;
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

/// A key: its virtual key code, the modifier flag it sets while held (none for other
/// keys) and the flags a real press of it carries (arrows and function keys have them).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Key {
    pub code: u16,
    pub modifier: CGEventFlags,
    pub extra: CGEventFlags,
}

const NO_FLAGS: CGEventFlags = CGEventFlags::empty();

fn plain(code: u16) -> Key {
    Key {
        code,
        modifier: NO_FLAGS,
        extra: NO_FLAGS,
    }
}

fn modifier(code: u16, flag: CGEventFlags) -> Key {
    Key {
        code,
        modifier: flag,
        extra: NO_FLAGS,
    }
}

fn fn_key(code: u16) -> Key {
    Key {
        code,
        modifier: NO_FLAGS,
        extra: CGEventFlags::MaskSecondaryFn,
    }
}

fn arrow(code: u16) -> Key {
    Key {
        code,
        modifier: NO_FLAGS,
        extra: CGEventFlags::MaskSecondaryFn | CGEventFlags::MaskNumericPad,
    }
}

const SHIFT: u16 = 0x38;
const RETURN: u16 = 0x24;
const TAB: u16 = 0x30;

/// How long a read of the keyboard layout is trusted: the user may switch layouts while the
/// agent works.
const LAYOUT_TTL: Duration = Duration::from_secs(3);

/// Runs `f` on the app's main thread and waits for it. The Text Input Sources calls behind the
/// keyboard layout abort the app off the main thread since macOS 14.
fn on_main<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let app = super::overlay::app()?;
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .ok()?;
    rx.recv_timeout(Duration::from_secs(2)).ok()
}

mod layout_ffi {
    use std::ffi::c_void;

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        pub fn TISCopyCurrentKeyboardLayoutInputSource() -> *mut c_void;
        pub fn TISGetInputSourceProperty(source: *mut c_void, key: *const c_void) -> *const c_void;
        pub static kTISPropertyUnicodeKeyLayoutData: *const c_void;
        pub fn LMGetKbdType() -> u8;
    }

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        #[allow(clippy::too_many_arguments)]
        pub fn UCKeyTranslate(
            layout: *const c_void,
            code: u16,
            action: u16,
            modifiers: u32,
            keyboard_type: u32,
            options: u32,
            dead_key_state: *mut u32,
            max_len: usize,
            len: *mut usize,
            chars: *mut u16,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
        pub fn CFRelease(cf: *const c_void);
    }
}

/// What each key of the layout in use types, without and with shift. Main thread only.
fn read_layout() -> Option<CharKeys> {
    use layout_ffi::*;
    // UCKeyTranslate's "display" action, shift as its modifier byte (shiftKey >> 8), and dead
    // keys giving their own character instead of waiting for the next key.
    const DISPLAY: u16 = 3;
    const SHIFT_STATE: u32 = 0x02;
    const NO_DEAD_KEYS: u32 = 1;
    unsafe {
        let source = TISCopyCurrentKeyboardLayoutInputSource();
        if source.is_null() {
            return None;
        }
        let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
        let keys = (!data.is_null()).then(|| {
            let layout = CFDataGetBytePtr(data).cast::<std::ffi::c_void>();
            let kind = u32::from(LMGetKbdType());
            keymap::layout_keys(|code, shift| {
                let mut dead = 0u32;
                let mut buf = [0u16; 4];
                let mut len = 0usize;
                let status = UCKeyTranslate(
                    layout,
                    code,
                    DISPLAY,
                    if shift { SHIFT_STATE } else { 0 },
                    kind,
                    NO_DEAD_KEYS,
                    &mut dead,
                    buf.len(),
                    &mut len,
                    buf.as_mut_ptr(),
                );
                if status != 0 || len == 0 {
                    return None;
                }
                let mut chars = char::decode_utf16(buf[..len.min(buf.len())].iter().copied());
                match (chars.next(), chars.next()) {
                    (Some(Ok(c)), None) => Some(c),
                    _ => None,
                }
            })
        });
        CFRelease(source.cast_const());
        keys
    }
}

/// When the layout was last read, and what it gave.
type LayoutRead = (Instant, Option<Arc<CharKeys>>);

/// The keys for characters in the layout in use, or None (the US keys) when it can't be read.
fn active_layout() -> Option<Arc<CharKeys>> {
    static CACHE: OnceLock<Mutex<Option<LayoutRead>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((at, keys)) = cache.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < LAYOUT_TTL {
            return keys.clone();
        }
    }
    let keys = on_main(read_layout).flatten().map(Arc::new);
    *cache.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), keys.clone()));
    keys
}

/// A key name (xdotool's, as Claude's computer use takes, or the usual ones) to its key, plus
/// shift when the layout needs it to type it ("+" is shift+= on a US keyboard). A character is
/// the key that types it in `layout` (the one in use), or on a US keyboard.
pub(super) fn key_for(name: &str, layout: Option<&CharKeys>) -> Option<(Key, bool)> {
    let lower = name.to_ascii_lowercase();
    let named = match lower.as_str() {
        "ctrl" | "control" | "ctl" | "control_l" | "ctrl_l" => {
            Some(modifier(0x3B, CGEventFlags::MaskControl))
        }
        "control_r" | "ctrl_r" => Some(modifier(0x3E, CGEventFlags::MaskControl)),
        "shift" | "shift_l" => Some(modifier(SHIFT, CGEventFlags::MaskShift)),
        "shift_r" => Some(modifier(0x3C, CGEventFlags::MaskShift)),
        "alt" | "alt_l" | "option" | "opt" => Some(modifier(0x3A, CGEventFlags::MaskAlternate)),
        "alt_r" | "altgr" | "option_r" => Some(modifier(0x3D, CGEventFlags::MaskAlternate)),
        // The model says "win"/"super" for the OS key; on a Mac that is Command.
        "cmd" | "command" | "super" | "super_l" | "meta" | "meta_l" | "win" | "windows" => {
            Some(modifier(0x37, CGEventFlags::MaskCommand))
        }
        "cmd_r" | "command_r" | "super_r" | "meta_r" => {
            Some(modifier(0x36, CGEventFlags::MaskCommand))
        }
        "enter" | "return" => Some(plain(RETURN)),
        "kp_enter" => Some(plain(0x4C)),
        "tab" => Some(plain(TAB)),
        "esc" | "escape" => Some(plain(0x35)),
        // The Mac "delete" key is BackSpace; "Delete" is the forward delete, as xdotool means it.
        "backspace" | "back_space" => Some(plain(0x33)),
        "delete" | "del" | "forwarddelete" => Some(fn_key(0x75)),
        "insert" | "ins" | "help" => Some(fn_key(0x72)),
        "space" => Some(plain(0x31)),
        "up" | "arrowup" => Some(arrow(0x7E)),
        "down" | "arrowdown" => Some(arrow(0x7D)),
        "left" | "arrowleft" => Some(arrow(0x7B)),
        "right" | "arrowright" => Some(arrow(0x7C)),
        "home" => Some(fn_key(0x73)),
        "end" => Some(fn_key(0x77)),
        "pageup" | "page_up" | "prior" | "pgup" => Some(fn_key(0x74)),
        "pagedown" | "page_down" | "next" | "pgdn" => Some(fn_key(0x79)),
        "capslock" | "caps_lock" => Some(plain(0x39)),
        "fn" | "function" => Some(plain(0x3F)),
        "volumeup" | "audiovolumeup" | "xf86audioraisevolume" => Some(plain(0x48)),
        "volumedown" | "audiovolumedown" | "xf86audiolowervolume" => Some(plain(0x49)),
        "volumemute" | "audiovolumemute" | "xf86audiomute" => Some(plain(0x4A)),
        _ => None,
    };
    if let Some(k) = named {
        return Some((k, false));
    }
    if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()) {
        // Macs have no F21–F24 keys.
        const F: [u16; 20] = [
            0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F, 0x69, 0x6B,
            0x71, 0x6A, 0x40, 0x4F, 0x50, 0x5A,
        ];
        return (1..=20)
            .contains(&n)
            .then(|| (fn_key(F[n as usize - 1]), false));
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
        "asciitilde" | "tilde" => '~',
        "bracketleft" => '[',
        "bracketright" => ']',
        "braceleft" => '{',
        "braceright" => '}',
        "bar" => '|',
        "underscore" => '_',
        "asterisk" => '*',
        "exclam" => '!',
        "at" => '@',
        "numbersign" => '#',
        "dollar" => '$',
        "percent" => '%',
        "asciicircum" => '^',
        "ampersand" => '&',
        "parenleft" => '(',
        "parenright" => ')',
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
    // A letter named on its own is the key, not the capital: "cmd+S" is cmd+s.
    keymap::char_key(ch, layout).map(|(code, shift)| (plain(code), shift))
}

/// "cmd+shift+s" to its keys in pressing order. "cmd++" is cmd and plus.
pub(super) fn parse_combo(combo: &str) -> Result<Vec<Key>, String> {
    let mut names: Vec<&str> = combo.split('+').collect();
    if combo.ends_with('+') {
        while names.last() == Some(&"") {
            names.pop();
        }
        names.push("+");
    }
    let layout = active_layout();
    let mut keys: Vec<Key> = Vec::new();
    for name in names.iter().map(|n| n.trim()) {
        if name.is_empty() {
            return Err(format!(
                "\"{combo}\" has an empty key between the plus signs."
            ));
        }
        let (key, shift) = key_for(name, layout.as_deref())
            .ok_or_else(|| format!("Unknown key \"{name}\" in \"{combo}\"."))?;
        let shift_key = modifier(SHIFT, CGEventFlags::MaskShift);
        if shift && !keys.iter().any(|k| k.modifier == CGEventFlags::MaskShift) {
            keys.push(shift_key);
        }
        if !keys.iter().any(|k| k.code == key.code) {
            keys.push(key);
        }
    }
    Ok(keys)
}

fn require_input_access() -> Result<(), String> {
    if unsafe { AXIsProcessTrusted() } {
        Ok(())
    } else {
        Err(INPUT_PERMISSION.into())
    }
}

/// Where the events come from. The HID system state makes them look like the real devices',
/// which some apps insist on.
fn source() -> Result<CFRetained<CGEventSource>, String> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .ok_or_else(|| "macOS didn't let Nyxs create input events.".to_string())
}

fn post(ev: &CFRetained<CGEvent>) {
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(ev));
}

fn key_event(
    src: &CGEventSource,
    code: u16,
    down: bool,
    flags: CGEventFlags,
) -> Result<CFRetained<CGEvent>, String> {
    let ev = CGEvent::new_keyboard_event(Some(src), code, down)
        .ok_or("macOS didn't create the key event.")?;
    // Set every time: the flags are what apps read for shortcuts, and they must not inherit a
    // modifier the user happens to be holding.
    CGEvent::set_flags(Some(&ev), flags);
    Ok(ev)
}

fn mods_of(keys: &[Key]) -> CGEventFlags {
    keys.iter().fold(NO_FLAGS, |acc, k| acc | k.modifier)
}

fn press_all(src: &CGEventSource, keys: &[Key]) -> Result<(), String> {
    let mut held = NO_FLAGS;
    for k in keys {
        held |= k.modifier;
        post(&key_event(src, k.code, true, held | k.extra)?);
    }
    Ok(())
}

fn release_all(src: &CGEventSource, keys: &[Key]) -> Result<(), String> {
    let mut held = mods_of(keys);
    for k in keys.iter().rev() {
        held &= !k.modifier;
        post(&key_event(src, k.code, false, held | k.extra)?);
    }
    Ok(())
}

fn modifiers(text: &Option<String>) -> Result<Vec<Key>, String> {
    match text.as_deref().map(str::trim) {
        None | Some("") => Ok(Vec::new()),
        Some(t) => parse_combo(t),
    }
}

struct Button {
    down: CGEventType,
    up: CGEventType,
    dragged: CGEventType,
    button: CGMouseButton,
}

fn button_of(b: control::MouseButton) -> Button {
    match b {
        control::MouseButton::Left => Button {
            down: CGEventType::LeftMouseDown,
            up: CGEventType::LeftMouseUp,
            dragged: CGEventType::LeftMouseDragged,
            button: CGMouseButton::Left,
        },
        control::MouseButton::Right => Button {
            down: CGEventType::RightMouseDown,
            up: CGEventType::RightMouseUp,
            dragged: CGEventType::RightMouseDragged,
            button: CGMouseButton::Right,
        },
        control::MouseButton::Middle => Button {
            down: CGEventType::OtherMouseDown,
            up: CGEventType::OtherMouseUp,
            dragged: CGEventType::OtherMouseDragged,
            button: CGMouseButton::Center,
        },
    }
}

fn button(name: &str) -> Result<Button, String> {
    Ok(button_of(control::MouseButton::parse(Some(name))?))
}

fn buttons(name: &Option<String>) -> Result<Button, String> {
    button(name.as_deref().unwrap_or("left"))
}

/// Lets go of what Nyxs left pressed when the control goes.
pub struct Releaser;

impl control::Release for Releaser {
    fn button_up(&self, b: control::MouseButton) {
        let (Ok(src), Ok(at)) = (source(), here()) else {
            return;
        };
        let b = button_of(b);
        if let Ok(ev) = mouse_event(&src, b.up, at, b.button, NO_FLAGS) {
            post(&ev);
        }
    }

    fn key_up(&self, code: u16) {
        let Ok(src) = source() else {
            return;
        };
        if let Ok(ev) = key_event(&src, code, false, NO_FLAGS) {
            post(&ev);
        }
    }
}

fn point(x: i32, y: i32) -> CGPoint {
    CGPoint {
        x: x as f64,
        y: y as f64,
    }
}

fn mouse_event(
    src: &CGEventSource,
    kind: CGEventType,
    at: CGPoint,
    b: CGMouseButton,
    flags: CGEventFlags,
) -> Result<CFRetained<CGEvent>, String> {
    let ev = CGEvent::new_mouse_event(Some(src), kind, at, b)
        .ok_or("macOS didn't create the mouse event.")?;
    if !flags.is_empty() {
        CGEvent::set_flags(Some(&ev), flags);
    }
    Ok(ev)
}

/// The pointer's move to `at`: a drag when a button is held (a plain move there would end the
/// drag in most apps).
fn move_event(src: &CGEventSource, at: CGPoint) -> Result<(), String> {
    let held = [
        (CGMouseButton::Left, CGEventType::LeftMouseDragged),
        (CGMouseButton::Right, CGEventType::RightMouseDragged),
        (CGMouseButton::Center, CGEventType::OtherMouseDragged),
    ]
    .into_iter()
    .find(|(b, _)| CGEventSource::button_state(CGEventSourceStateID::HIDSystemState, *b));
    let (b, kind) = held.unwrap_or((CGMouseButton::Left, CGEventType::MouseMoved));
    post(&mouse_event(src, kind, at, b, NO_FLAGS)?);
    Ok(())
}

fn move_to_point(src: &CGEventSource, x: i32, y: i32) -> Result<(), String> {
    move_event(src, point(x, y))?;
    // A moment for apps that track hover to see the pointer arrive.
    sleep(Duration::from_millis(30));
    Ok(())
}

fn move_to(src: &CGEventSource, d: &Display, x: f64, y: f64) -> Result<(), String> {
    let (sx, sy) = to_screen(d, x, y);
    move_to_point(src, sx, sy)
}

fn maybe_move(
    src: &CGEventSource,
    d: &Display,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    match (x, y) {
        (Some(x), Some(y)) => move_to(src, d, x, y),
        (None, None) => Ok(()),
        _ => Err("Give both x and y, or neither to act where the pointer is.".into()),
    }
}

fn here() -> Result<CGPoint, String> {
    let (x, y) = cursor().ok_or("Couldn't read the pointer's position.")?;
    Ok(point(x, y))
}

/// Clicks `count` times where the pointer is. The click count field is what makes macOS see a
/// double or triple click; the events alone would be separate single clicks.
fn click_here(
    src: &CGEventSource,
    b: &Button,
    count: u32,
    flags: CGEventFlags,
) -> Result<(), String> {
    let at = here()?;
    for n in 1..=count.clamp(1, 3) {
        let down = mouse_event(src, b.down, at, b.button, flags)?;
        let up = mouse_event(src, b.up, at, b.button, flags)?;
        CGEvent::set_integer_value_field(Some(&down), CGEventField::MouseEventClickState, n as i64);
        CGEvent::set_integer_value_field(Some(&up), CGEventField::MouseEventClickState, n as i64);
        post(&down);
        post(&up);
    }
    Ok(())
}

/// Types text as Unicode, one character per key event: apps that read only the first unit of an
/// event (some Electron and terminal ones) would otherwise drop characters. Newlines and tabs go
/// as their keys, so editors handle them as presses.
fn type_text(src: &CGEventSource, text: &str, token: &control::StopToken) -> Result<(), String> {
    // A stop (Esc, the turn ended) ends it between characters instead of typing on into
    // whatever has the focus.
    token.run(text.chars().enumerate(), |(i, ch)| {
        match ch {
            '\r' => return Ok(()),
            '\n' | '\t' => {
                let code = if ch == '\n' { RETURN } else { TAB };
                post(&key_event(src, code, true, NO_FLAGS)?);
                post(&key_event(src, code, false, NO_FLAGS)?);
            }
            _ => {
                let mut buf = [0u16; 2];
                let units = ch.encode_utf16(&mut buf);
                for down in [true, false] {
                    let ev = key_event(src, 0, down, NO_FLAGS)?;
                    unsafe {
                        CGEvent::keyboard_set_unicode_string(
                            Some(&ev),
                            units.len() as _,
                            units.as_ptr(),
                        )
                    };
                    post(&ev);
                }
            }
        }
        // A pause every few characters: apps that handle each key slowly (editors with
        // autocomplete, Electron) otherwise drop or reorder them.
        if i % 20 == 19 {
            token.sleep(Duration::from_millis(15))?;
        }
        Ok(())
    })
}

fn scroll(src: &CGEventSource, dx: i32, dy: i32, flags: CGEventFlags) -> Result<(), String> {
    // Line units, one event per wheel click. Wheel 1 is vertical (positive = up), wheel 2
    // horizontal (positive = left), the opposite of the action's signs.
    let mut steps: Vec<(i32, i32)> = Vec::new();
    steps.extend((0..dy.unsigned_abs().min(50)).map(|_| (-dy.signum(), 0)));
    steps.extend((0..dx.unsigned_abs().min(50)).map(|_| (0, -dx.signum())));
    for (v, h) in steps {
        let ev = CGEvent::new_scroll_wheel_event2(Some(src), CGScrollEventUnit::Line, 2, v, h, 0)
            .ok_or("macOS didn't create the scroll event.")?;
        if !flags.is_empty() {
            CGEvent::set_flags(Some(&ev), flags);
        }
        post(&ev);
        sleep(Duration::from_millis(5));
    }
    Ok(())
}

pub fn act(index: usize, action: Action, token: &control::StopToken) -> Result<(), String> {
    require_input_access()?;
    let src = source()?;
    let src = &*src;
    let display = || pick(&displays()?, index);
    match action {
        Action::Move { x, y } => move_to(src, &display()?, x, y),
        Action::Click {
            x,
            y,
            button,
            count,
            modifiers: mods,
        } => {
            maybe_move(src, &display()?, x, y)?;
            let b = buttons(&button)?;
            let held = modifiers(&mods)?;
            press_all(src, &held)?;
            let clicked = click_here(src, &b, count.unwrap_or(1), mods_of(&held));
            release_all(src, &held)?;
            clicked
        }
        Action::Down { x, y, button } => {
            maybe_move(src, &display()?, x, y)?;
            let which = control::MouseButton::parse(button.as_deref())?;
            let b = button_of(which);
            post(&mouse_event(src, b.down, here()?, b.button, NO_FLAGS)?);
            // Held until its up, or until the control goes.
            control::held()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .press_button(which);
            Ok(())
        }
        Action::Up { x, y, button } => {
            maybe_move(src, &display()?, x, y)?;
            let which = control::MouseButton::parse(button.as_deref())?;
            let b = button_of(which);
            control::held()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .release_button(which);
            post(&mouse_event(src, b.up, here()?, b.button, NO_FLAGS)?);
            Ok(())
        }
        Action::Drag { from, to, button } => {
            let d = display()?;
            let b = buttons(&button)?;
            move_to(src, &d, from[0], from[1])?;
            let (fx, fy) = to_screen(&d, from[0], from[1]);
            post(&mouse_event(
                src,
                b.down,
                point(fx, fy),
                b.button,
                NO_FLAGS,
            )?);
            // In steps: a jump straight to the end doesn't start a drag in most apps.
            const STEPS: u32 = 12;
            let mut last = point(fx, fy);
            let moved = token
                .run(1..=STEPS, |i| {
                    let t = i as f64 / STEPS as f64;
                    let (sx, sy) = to_screen(
                        &d,
                        from[0] + (to[0] - from[0]) * t,
                        from[1] + (to[1] - from[1]) * t,
                    );
                    last = point(sx, sy);
                    post(&mouse_event(src, b.dragged, last, b.button, NO_FLAGS)?);
                    token.sleep(Duration::from_millis(15))
                })
                .and_then(|_| token.sleep(Duration::from_millis(50)));
            // Released however the drag went: a stop or an error must not leave it pressed.
            let released = mouse_event(src, b.up, last, b.button, NO_FLAGS).map(|ev| post(&ev));
            moved.and(released)
        }
        Action::Scroll {
            x,
            y,
            dx,
            dy,
            modifiers: mods,
        } => {
            maybe_move(src, &display()?, x, y)?;
            let held = modifiers(&mods)?;
            press_all(src, &held)?;
            let scrolled = scroll(src, dx, dy, mods_of(&held));
            release_all(src, &held)?;
            scrolled
        }
        Action::Type { text } => type_text(src, &text, token),
        Action::Key { keys } => token.run(keys.split_whitespace(), |combo| {
            let k = parse_combo(combo)?;
            press_all(src, &k)?;
            release_all(src, &k)?;
            sleep(Duration::from_millis(40));
            Ok(())
        }),
        Action::HoldKey { keys, ms } => {
            let k = parse_combo(keys.trim())?;
            press_all(src, &k)?;
            let codes: Vec<u16> = k.iter().map(|key| key.code).collect();
            let waited = control::holding_keys(&codes, || {
                token.sleep(Duration::from_millis(ms.min(10_000)))
            });
            // Released however the wait ended.
            let released = release_all(src, &k);
            waited.and(released)
        }
    }
}

/// One entry of the window server's list.
pub(crate) struct Win {
    pub(crate) id: i64,
    pub(crate) pid: i32,
    layer: i64,
    alpha: f64,
    title: String,
    owner: String,
    bounds: CGRect,
}

/// The window server's windows, front to back. Titles need the Screen Recording permission;
/// without it they come back empty.
fn window_list(option: CGWindowListOption, relative_to: u32) -> Vec<Win> {
    let Some(list) = CGWindowListCopyWindowInfo(option, relative_to) else {
        return Vec::new();
    };
    // SAFETY: the list holds one dictionary of string keys per window.
    let list: &CFArray<CFDictionary<CFString, CFType>> = unsafe { list.cast_unchecked() };
    let mut out = Vec::new();
    for entry in list.iter() {
        let get = |key: &CFString| entry.get(key);
        let number = |key: &CFString| {
            get(key).and_then(|v| v.downcast_ref::<CFNumber>().and_then(|n| n.as_f64()))
        };
        let text = |key: &CFString| {
            get(key)
                .and_then(|v| v.downcast_ref::<CFString>().map(|s| s.to_string()))
                .unwrap_or_default()
        };
        let (id, pid, layer, alpha, title, owner, bounds) = unsafe {
            let mut bounds = CGRect::default();
            let has_bounds = get(kCGWindowBounds)
                .and_then(|v| {
                    v.downcast_ref::<CFDictionary>()
                        .map(|d| CGRectMakeWithDictionaryRepresentation(Some(d), &mut bounds))
                })
                .unwrap_or(false);
            if !has_bounds {
                continue;
            }
            (
                number(kCGWindowNumber),
                number(kCGWindowOwnerPID),
                number(kCGWindowLayer).unwrap_or(0.0),
                number(kCGWindowAlpha).unwrap_or(1.0),
                text(kCGWindowName),
                text(kCGWindowOwnerName),
                bounds,
            )
        };
        let (Some(id), Some(pid)) = (id, pid) else {
            continue;
        };
        out.push(Win {
            id: id as i64,
            pid: pid as i32,
            layer: layer as i64,
            alpha,
            title,
            owner,
            bounds,
        });
    }
    out
}

fn on_screen() -> Vec<Win> {
    window_list(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        0,
    )
}

/// Window `id` as the window server lists it (its owner, frame and title), for this file and
/// for the Accessibility side (ax.rs). With a dead id the list can hold other windows instead,
/// so the id is checked.
pub(crate) fn window_info(id: i64) -> Option<Win> {
    let id = u32::try_from(id).ok()?;
    window_list(CGWindowListOption::OptionIncludingWindow, id)
        .into_iter()
        .find(|w| w.id == id as i64)
}

fn frontmost_pid() -> Option<i32> {
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|a| a.processIdentifier())
}

/// The desktop's app windows (layer 0), front to back. Minimized ones and those on other Spaces
/// aren't on screen, so they aren't listed.
pub fn windows() -> Result<Vec<WindowInfo>, String> {
    let displays = displays().unwrap_or_default();
    let front = frontmost_pid();
    let mut focused_given = false;
    let mut out = Vec::new();
    for w in on_screen() {
        if w.layer != 0 || w.alpha <= 0.0 || w.bounds.size.width < 2.0 || w.bounds.size.height < 2.0
        {
            continue;
        }
        if is_frame(w.pid, &w.title, w.layer, &w.bounds, &displays) {
            continue;
        }
        // The list runs front to back, so the frontmost app's first window is its focused one.
        let focused = !focused_given && Some(w.pid) == front;
        focused_given |= focused;
        out.push(WindowInfo {
            id: w.id,
            // Without Screen Recording, macOS hides window titles; the app name still helps.
            title: if w.title.trim().is_empty() {
                w.owner.clone()
            } else {
                w.title
            },
            process: w.owner,
            x: w.bounds.origin.x.round() as i32,
            y: w.bounds.origin.y.round() as i32,
            width: w.bounds.size.width.round() as i32,
            height: w.bounds.size.height.round() as i32,
            minimized: false,
            focused,
        });
    }
    Ok(out)
}

fn contains(r: &CGRect, x: i32, y: i32) -> bool {
    let (x, y) = (x as f64, y as f64);
    x >= r.origin.x
        && y >= r.origin.y
        && x < r.origin.x + r.size.width
        && y < r.origin.y + r.size.height
}

/// The window a click at desktop point (x, y) would land on: the top visible window there, past
/// our click-through frames.
fn window_at(x: i32, y: i32) -> Option<Win> {
    let displays = displays().unwrap_or_default();
    on_screen()
        .into_iter()
        .filter(|w| w.alpha > 0.0 && !is_frame(w.pid, &w.title, w.layer, &w.bounds, &displays))
        .find(|w| contains(&w.bounds, x, y))
}

/// The process owning the window a click at desktop point (x, y) would land on.
fn pid_at(x: i32, y: i32) -> Option<i32> {
    window_at(x, y).map(|w| w.pid)
}

/// Whether a click at (x, y) lands on window `id` or on a popup of its app above the normal
/// windows (an open menu, a dropdown), and not on another window covering it.
pub fn lands_on(id: i64, x: i32, y: i32) -> bool {
    let Some(target) = window_info(id) else {
        return false;
    };
    window_at(x, y).is_some_and(|hit| hit.id == id || (hit.pid == target.pid && hit.layer != 0))
}

/// Refuses an action that would land on Nyxs itself: a click on its window, or keys while it
/// has the focus (they would go into the user's chat box).
pub fn guard(index: usize, action: &Action) -> Result<(), String> {
    let me = my_pid();
    let point = |x: Option<f64>, y: Option<f64>| -> Result<(i32, i32), String> {
        match (x, y) {
            (Some(x), Some(y)) => Ok(to_screen(&pick(&displays()?, index)?, x, y)),
            _ => cursor().ok_or_else(|| "Couldn't read the pointer's position.".to_string()),
        }
    };
    let points = match action {
        Action::Click { x, y, .. } | Action::Down { x, y, .. } | Action::Scroll { x, y, .. } => {
            vec![point(*x, *y)?]
        }
        Action::Drag { from, to, .. } => vec![
            point(Some(from[0]), Some(from[1]))?,
            point(Some(to[0]), Some(to[1]))?,
        ],
        Action::Type { .. } | Action::Key { .. } | Action::HoldKey { .. } => {
            if frontmost_pid() == Some(me) {
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
    let w = window_info(id).ok_or(GONE)?;
    if w.pid == my_pid() {
        return Err(OWN_WINDOW.into());
    }
    Ok(())
}

/// Clicks at a desktop point in points (an element's center).
pub fn click_screen(x: i32, y: i32, button_name: &str, count: u32) -> Result<(), String> {
    if pid_at(x, y) == Some(my_pid()) {
        return Err("Nyxs' own window covers that element. Focus its app first.".into());
    }
    require_input_access()?;
    let src = source()?;
    move_to_point(&src, x, y)?;
    click_here(&src, &button(button_name)?, count, NO_FLAGS)
}

fn ax_attr(el: &AXUIElement, name: &'static str) -> Option<CFRetained<CFType>> {
    let mut out: *const CFType = std::ptr::null();
    let err = unsafe {
        el.copy_attribute_value(&CFString::from_static_str(name), NonNull::from(&mut out))
    };
    if err != AXError::Success {
        return None;
    }
    // The copy is ours (+1): adopt it so it is released.
    NonNull::new(out as *mut CFType).map(|p| unsafe { CFRetained::from_raw(p) })
}

fn ax_value<T: Default>(el: &AXUIElement, name: &'static str, kind: AXValueType) -> Option<T> {
    let v = ax_attr(el, name)?;
    let v = v.downcast_ref::<AXValue>()?;
    let mut out = T::default();
    unsafe { v.value(kind, NonNull::from(&mut out).cast()) }.then_some(out)
}

fn ax_set_true(el: &AXUIElement, name: &'static str) {
    let yes: &CFType = CFBoolean::new(true);
    let _ = unsafe { el.set_attribute_value(&CFString::from_static_str(name), yes) };
}

fn ax_set_false(el: &AXUIElement, name: &'static str) {
    let no: &CFType = CFBoolean::new(false);
    let _ = unsafe { el.set_attribute_value(&CFString::from_static_str(name), no) };
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    /// Private but long-stable (every window tool, yabai, Hammerspoon, AltTab, relies on it):
    /// the window server id behind an Accessibility window, the only exact way to match the two.
    fn _AXUIElementGetWindow(element: &AXUIElement, id: *mut u32) -> AXError;
}

/// The Accessibility window for window server window `w`: by id, else by frame (and title when
/// it can be read), else the app's only window. Shared with ax.rs.
pub(crate) fn ax_window(app: &AXUIElement, w: &Win) -> Option<CFRetained<AXUIElement>> {
    let list = ax_attr(app, "AXWindows")?;
    let list = list.downcast_ref::<CFArray>()?;
    // SAFETY: AXWindows is an array of AXUIElements.
    let list: &CFArray<AXUIElement> = unsafe { list.cast_unchecked() };
    let windows: Vec<CFRetained<AXUIElement>> = list.iter().collect();
    let by_id = windows.iter().find(|el| {
        let mut id = 0u32;
        let ok = unsafe { _AXUIElementGetWindow(el, &mut id) } == AXError::Success;
        ok && id as i64 == w.id
    });
    if let Some(el) = by_id {
        return Some(el.clone());
    }
    let by_frame = windows.iter().find(|el| {
        let pos: Option<CGPoint> = ax_value(el, "AXPosition", AXValueType::CGPoint);
        let size: Option<CGSize> = ax_value(el, "AXSize", AXValueType::CGSize);
        let same_frame = matches!((pos, size), (Some(p), Some(s))
                if (p.x - w.bounds.origin.x).abs() < 2.0
                    && (p.y - w.bounds.origin.y).abs() < 2.0
                    && (s.width - w.bounds.size.width).abs() < 2.0
                    && (s.height - w.bounds.size.height).abs() < 2.0);
        let title = ax_attr(el, "AXTitle")
            .and_then(|t| t.downcast_ref::<CFString>().map(|s| s.to_string()))
            .unwrap_or_default();
        same_frame && (w.title.is_empty() || title == w.title)
    });
    by_frame
        .or_else(|| (windows.len() == 1).then(|| &windows[0]))
        .cloned()
}

pub fn focus(id: i64) -> Result<(), String> {
    let w = window_info(id).ok_or(GONE)?;
    require_input_access()?;
    let app = NSRunningApplication::runningApplicationWithProcessIdentifier(w.pid)
        .ok_or("That window's app has quit; list the windows again.")?;
    app.activateWithOptions(NSApplicationActivationOptions::empty());
    let ax_app = unsafe { AXUIElement::new_application(w.pid) };
    // Since macOS 14 an app can only ask to be activated; Accessibility makes it frontmost
    // outright, and raises the one window among the app's.
    ax_set_true(&ax_app, "AXFrontmost");
    if let Some(win) = ax_window(&ax_app, &w) {
        ax_set_false(&win, "AXMinimized");
        let _ = unsafe { win.perform_action(&CFString::from_static_str("AXRaise")) };
        ax_set_true(&win, "AXMain");
    }
    sleep(Duration::from_millis(150));
    if frontmost_pid() != Some(w.pid) {
        return Err(
            "macOS didn't bring that window to the front. Click on it in a screenshot instead."
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_key_combos() {
        let codes = |c: &str| {
            parse_combo(c)
                .unwrap()
                .iter()
                .map(|k| k.code)
                .collect::<Vec<_>>()
        };
        assert_eq!(codes("cmd+shift+s"), vec![0x37, 0x38, 0x01]);
        assert_eq!(codes("ctrl+S"), vec![0x3B, 0x01]);
        assert_eq!(codes("super+a"), vec![0x37, 0x00]);
        assert_eq!(codes("alt+F4"), vec![0x3A, 0x76]);
        assert_eq!(codes("Return"), vec![0x24]);
        assert_eq!(codes("cmd++"), vec![0x37, 0x38, 0x18]);
        assert!(parse_combo("ctrl+nokey").is_err());
        assert!(parse_combo("F24").is_err());
    }
}
