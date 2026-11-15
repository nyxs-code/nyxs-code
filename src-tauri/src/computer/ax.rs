//! macOS side of uia.rs: a window's controls through the Accessibility API (AXUIElement),
//! numbered the same way so the agent acts on them by number. Window ids are CGWindowIDs
//! (kCGWindowNumber); bounds are global points with the origin at the top left of the main
//! display, the space CGEvent clicks and CGWindow bounds use.

use super::*;
use objc2_application_services::{
    AXCopyMultipleAttributeOptions, AXError, AXIsProcessTrusted, AXUIElement, AXValue, AXValueType,
};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFNumber, CFRetained, CFString, CFType, CGPoint, CGSize,
};
use std::collections::{HashMap, HashSet};
use std::ptr::NonNull;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Same cut as on Windows: past it the agent should zoom in on the screenshot instead.
const MAX_ELEMENTS: usize = 400;
const MAX_DEPTH: usize = 30;

const NO_PERMISSION: &str = "Nyxs needs the Accessibility permission: System Settings › Privacy & Security › Accessibility. Ask the user to turn it on, then try again.";
const WINDOW_GONE: &str = "That window no longer exists; list the windows again.";
const ELEMENT_GONE: &str = "That element is gone: the window changed. Read its controls again.";

// UI Automation control type ids, so `describe` and `is_interactive` serve both platforms.
const BUTTON: i32 = 50000;
const CHECKBOX: i32 = 50002;
const COMBOBOX: i32 = 50003;
const EDIT: i32 = 50004;
const LINK: i32 = 50005;
const IMAGE: i32 = 50006;
const LISTITEM: i32 = 50007;
const LIST: i32 = 50008;
const MENU: i32 = 50009;
const MENUBAR: i32 = 50010;
const MENUITEM: i32 = 50011;
const PROGRESSBAR: i32 = 50012;
const RADIO: i32 = 50013;
const SCROLLBAR: i32 = 50014;
const SLIDER: i32 = 50015;
const SPINNER: i32 = 50016;
const TABS: i32 = 50018;
const TAB: i32 = 50019;
const TEXT: i32 = 50020;
const TOOLBAR: i32 = 50021;
const TOOLTIP: i32 = 50022;
const TREE: i32 = 50023;
const TREEITEM: i32 = 50024;
const CUSTOM: i32 = 50025;
const GROUP: i32 = 50026;
const THUMB: i32 = 50027;
const GRID: i32 = 50028;
const DOCUMENT: i32 = 50030;
const WINDOW: i32 = 50032;
const PANE: i32 = 50033;
const HEADER: i32 = 50034;
const TABLE: i32 = 50036;
const SEPARATOR: i32 = 50038;

/// An AX role (and subrole) as the UI Automation control type the shared helpers name.
fn kind_of(role: &str, subrole: &str) -> i32 {
    match (role, subrole) {
        ("AXRadioButton", "AXTabButton") => TAB,
        ("AXRow", "AXOutlineRow") => TREEITEM,
        (
            "AXButton" | "AXMenuButton" | "AXDisclosureTriangle" | "AXColorWell" | "AXDockItem",
            _,
        ) => BUTTON,
        ("AXCheckBox", _) => CHECKBOX,
        ("AXComboBox" | "AXPopUpButton", _) => COMBOBOX,
        ("AXTextField" | "AXTextArea" | "AXDateField" | "AXTimeField", _) => EDIT,
        ("AXLink", _) => LINK,
        ("AXImage", _) => IMAGE,
        ("AXRow", _) => LISTITEM,
        ("AXList", _) => LIST,
        ("AXMenu", _) => MENU,
        ("AXMenuBar", _) => MENUBAR,
        ("AXMenuItem" | "AXMenuBarItem", _) => MENUITEM,
        ("AXProgressIndicator" | "AXBusyIndicator" | "AXLevelIndicator", _) => PROGRESSBAR,
        ("AXRadioButton", _) => RADIO,
        ("AXScrollBar", _) => SCROLLBAR,
        ("AXSlider", _) => SLIDER,
        ("AXIncrementor" | "AXStepper", _) => SPINNER,
        ("AXTabGroup", _) => TABS,
        ("AXStaticText" | "AXCell", _) => TEXT,
        ("AXToolbar", _) => TOOLBAR,
        ("AXHelpTag", _) => TOOLTIP,
        ("AXOutline" | "AXBrowser", _) => TREE,
        ("AXGroup" | "AXRadioGroup" | "AXSplitGroup" | "AXLayoutArea" | "AXLayoutItem", _) => GROUP,
        ("AXValueIndicator", _) => THUMB,
        ("AXGrid", _) => GRID,
        ("AXWebArea", _) => DOCUMENT,
        ("AXWindow" | "AXSheet" | "AXDrawer" | "AXPopover" | "AXApplication", _) => WINDOW,
        ("AXScrollArea", _) => PANE,
        ("AXHeading", _) => HEADER,
        ("AXTable", _) => TABLE,
        ("AXSplitter", _) => SEPARATOR,
        ("", _) => 0,
        _ => CUSTOM,
    }
}

/// An AXUIElementRef is a plain CF reference to an object in another process; the AX API may
/// be called on it from any thread, which the snapshot cache needs.
struct Element(CFRetained<AXUIElement>);
unsafe impl Send for Element {}

/// The latest read of each window: its numbered controls.
fn snapshots() -> &'static Mutex<HashMap<i64, Vec<Element>>> {
    static S: OnceLock<Mutex<HashMap<i64, Vec<Element>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Apps whose Chromium/Electron tree was already asked for, so the wait happens once.
fn awakened() -> &'static Mutex<HashSet<i32>> {
    static S: OnceLock<Mutex<HashSet<i32>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashSet::new()))
}

fn trusted() -> Result<(), String> {
    if unsafe { AXIsProcessTrusted() } {
        Ok(())
    } else {
        Err(NO_PERMISSION.into())
    }
}

/// One attribute's value, or the AX error that kept it from us.
fn attr(el: &AXUIElement, name: &str) -> Result<CFRetained<CFType>, AXError> {
    let name = CFString::from_str(name);
    let mut out: *const CFType = std::ptr::null();
    let err = unsafe { el.copy_attribute_value(&name, NonNull::from(&mut out)) };
    if err != AXError::Success {
        return Err(err);
    }
    // Copy rule: success hands over a +1 reference, released when the CFRetained drops.
    NonNull::new(out as *mut CFType)
        .map(|p| unsafe { CFRetained::from_raw(p) })
        .ok_or(AXError::NoValue)
}

fn set_attr(el: &AXUIElement, name: &str, value: &CFType) -> AXError {
    unsafe { el.set_attribute_value(&CFString::from_str(name), value) }
}

fn string(v: &CFType) -> Option<String> {
    v.downcast_ref::<CFString>().map(|s| s.to_string())
}

fn number(v: &CFType) -> Option<f64> {
    v.downcast_ref::<CFNumber>().and_then(|n| n.as_f64())
}

fn boolean(v: &CFType) -> Option<bool> {
    v.downcast_ref::<CFBoolean>()
        .map(|b| b.as_bool())
        .or_else(|| number(v).map(|n| n != 0.0))
}

fn point(v: &CFType) -> Option<CGPoint> {
    let v = v.downcast_ref::<AXValue>()?;
    let mut p = CGPoint { x: 0.0, y: 0.0 };
    unsafe { v.value(AXValueType::CGPoint, NonNull::from(&mut p).cast()) }.then_some(p)
}

fn size(v: &CFType) -> Option<CGSize> {
    let v = v.downcast_ref::<AXValue>()?;
    let mut s = CGSize {
        width: 0.0,
        height: 0.0,
    };
    unsafe { v.value(AXValueType::CGSize, NonNull::from(&mut s).cast()) }.then_some(s)
}

fn elements(v: &CFType) -> Vec<CFRetained<AXUIElement>> {
    let Some(arr) = v.downcast_ref::<CFArray>() else {
        return Vec::new();
    };
    let arr: &CFArray<CFType> = unsafe { arr.cast_unchecked() };
    (0..arr.len())
        .filter_map(|i| arr.get(i)?.downcast::<AXUIElement>().ok())
        .collect()
}

/// x, y, width, height in global points.
type Rect = (f64, f64, f64, f64);

fn frame_of(el: &AXUIElement) -> Option<Rect> {
    let p = point(&*attr(el, "AXPosition").ok()?)?;
    let s = size(&*attr(el, "AXSize").ok()?)?;
    Some((p.x, p.y, s.width, s.height))
}

/// What the walk reads of every element, fetched in one round trip to the app.
const ATTRS: [&str; 12] = [
    "AXRole",
    "AXSubrole",
    "AXTitle",
    "AXDescription",
    "AXValue",
    "AXEnabled",
    "AXFocused",
    "AXPosition",
    "AXSize",
    "AXChildren",
    "AXPlaceholderValue",
    "AXSelected",
];

fn read_all(el: &AXUIElement, names: &CFArray) -> Vec<Option<CFRetained<CFType>>> {
    let mut out: *const CFArray = std::ptr::null();
    let err = unsafe {
        el.copy_multiple_attribute_values(
            names,
            AXCopyMultipleAttributeOptions::empty(),
            NonNull::from(&mut out),
        )
    };
    let Some(ptr) = NonNull::new(out as *mut CFArray).filter(|_| err == AXError::Success) else {
        return Vec::new();
    };
    let arr = unsafe { CFRetained::from_raw(ptr) };
    let arr: &CFArray<CFType> = unsafe { arr.cast_unchecked() };
    (0..arr.len()).map(|i| arr.get(i)).collect()
}

struct Walk {
    lines: Vec<String>,
    elements: Vec<Element>,
    truncated: bool,
    names: CFRetained<CFArray<CFString>>,
}

/// Formats a numeric AXValue the way the agent reads it: checkboxes on or off, the rest as numbers.
fn numeric_value(kind: i32, n: f64) -> Option<String> {
    match kind {
        CHECKBOX | RADIO => Some(if n != 0.0 { "on" } else { "off" }.into()),
        SLIDER | PROGRESSBAR | SPINNER | SCROLLBAR => Some(if n.fract() == 0.0 {
            format!("{n:.0}")
        } else {
            format!("{n:.2}")
        }),
        _ => None,
    }
}

/// `clip` is the window's frame: elements wholly outside it are scrolled away, like the ones
/// UI Automation reports offscreen. `open_menus_only` keeps the menu bar to its titles plus
/// the menu that is open, instead of every item of every menu.
fn walk(el: &AXUIElement, depth: usize, out: &mut Walk, clip: Option<Rect>, open_menus_only: bool) {
    if out.elements.len() >= MAX_ELEMENTS {
        out.truncated = true;
        return;
    }
    let v = read_all(el, out.names.as_opaque());
    let get = |i: usize| v.get(i).and_then(|x| x.as_deref());
    let role = get(0).and_then(string).unwrap_or_default();
    let subrole = get(1).and_then(string).unwrap_or_default();
    let kind = kind_of(&role, &subrole);
    let frame = get(7).and_then(point).zip(get(8).and_then(size));
    if let (Some((cx, cy, cw, ch)), Some((p, s))) = (clip, frame) {
        let outside =
            p.x >= cx + cw || p.y >= cy + ch || p.x + s.width <= cx || p.y + s.height <= cy;
        if s.width > 0.0 && s.height > 0.0 && outside {
            return;
        }
    }
    let title = get(2).and_then(string).unwrap_or_default();
    let mut name = if title.trim().is_empty() {
        get(3).and_then(string).unwrap_or_default()
    } else {
        title
    };
    let mut value = get(4).and_then(|v| string(v).or_else(|| numeric_value(kind, number(v)?)));
    // Static text keeps its words in AXValue; on Windows they are the name.
    if kind == TEXT && name.trim().is_empty() {
        name = value.take().unwrap_or_default();
    }
    if kind == EDIT && name.trim().is_empty() {
        name = get(10).and_then(string).unwrap_or_default();
    }
    let shown = depth > 0
        && (!name.trim().is_empty()
            || value.as_deref().is_some_and(|v| !v.trim().is_empty())
            || is_interactive(kind));
    let child_depth = if shown {
        let enabled = get(5).and_then(boolean).unwrap_or(true);
        let focused = get(6).and_then(boolean).unwrap_or(false);
        let index = out.elements.len();
        out.lines.push(format!(
            "{}[{index}] {}",
            "  ".repeat(depth.saturating_sub(1).min(12)),
            describe(kind, &name, value.as_deref(), enabled, focused)
        ));
        out.elements
            .push(Element(unsafe { CFRetained::retain(NonNull::from(el)) }));
        depth + 1
    } else {
        // A nameless group adds nothing; its children take its place.
        depth.max(1)
    };
    if depth >= MAX_DEPTH {
        return;
    }
    if open_menus_only && role == "AXMenuBarItem" && !get(11).and_then(boolean).unwrap_or(false) {
        return;
    }
    for child in get(9).map(elements).unwrap_or_default() {
        walk(&child, child_depth, out, clip, open_menus_only);
    }
}

/// Chromium and Electron apps (Chrome, VS Code, Slack…) build their tree only once an
/// assistive app asks. True the first time it's asked of this app.
fn wake_up(app: &AXUIElement, pid: i32) -> bool {
    let fresh = awakened()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(pid);
    if fresh {
        let _ = set_attr(app, "AXManualAccessibility", CFBoolean::new(true));
    }
    fresh
}

fn read(window: &AXUIElement) -> Walk {
    let names: Vec<CFRetained<CFString>> = ATTRS.iter().map(|a| CFString::from_str(a)).collect();
    let mut out = Walk {
        lines: Vec::new(),
        elements: Vec::new(),
        truncated: false,
        names: CFArray::from_retained_objects(&names),
    };
    walk(window, 0, &mut out, frame_of(window), false);
    out
}

pub fn window_state(window: i64) -> Result<WindowState, String> {
    trusted()?;
    let cg = crate::computer::imp::window_info(window).ok_or(WINDOW_GONE)?;
    let app = unsafe { AXUIElement::new_application(cg.pid) };
    // A hung app would otherwise stall every attribute read for the default six seconds.
    let _ = unsafe { app.set_messaging_timeout(2.0) };
    let fresh = wake_up(&app, cg.pid);
    let win = crate::computer::imp::ax_window(&app, &cg).ok_or(
        "That window has no controls Nyxs can read through Accessibility; use the screenshot.",
    )?;
    let mut out = read(&win);
    let thin = |w: &Walk| w.elements.len() <= 5;
    if fresh && thin(&out) {
        // Older Chrome only answers to the flag VoiceOver sets; then the tree takes a moment.
        let _ = set_attr(&app, "AXEnhancedUserInterface", CFBoolean::new(true));
        for _ in 0..4 {
            std::thread::sleep(Duration::from_millis(250));
            out = read(&win);
            if !thin(&out) {
                break;
            }
        }
    }
    // The menu bar belongs to the app, not the window, but it's where many commands live.
    if !out.truncated {
        if let Ok(bar) = attr(&app, "AXMenuBar") {
            if let Ok(bar) = bar.downcast::<AXUIElement>() {
                walk(&bar, 1, &mut out, None, true);
            }
        }
    }
    let title = attr(&win, "AXTitle")
        .ok()
        .and_then(|t| string(&t))
        .unwrap_or_default();
    let count = out.elements.len();
    snapshots()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(window, out.elements);
    Ok(WindowState {
        window_id: window,
        title,
        tree: out.lines.join("\n"),
        count,
        truncated: out.truncated,
    })
}

fn element(window: i64, index: usize) -> Result<CFRetained<AXUIElement>, String> {
    trusted()?;
    let map = snapshots().lock().unwrap_or_else(|e| e.into_inner());
    let list = map
        .get(&window)
        .ok_or("Read that window's controls first (get_window_state), then use their numbers.")?;
    list.get(index).map(|e| e.0.clone()).ok_or_else(|| {
        format!(
            "There is no element {index} in that window's latest read (0 to {}).",
            list.len().saturating_sub(1)
        )
    })
}

fn gone(err: AXError) -> bool {
    err == AXError::InvalidUIElement || err == AXError::CannotComplete
}

pub fn bounds(window: i64, index: usize) -> Result<Bounds, String> {
    let el = element(window, index)?;
    let position = attr(&el, "AXPosition");
    if let Err(e) = &position {
        if gone(*e) {
            return Err(ELEMENT_GONE.into());
        }
    }
    let p = position.ok().and_then(|v| point(&v));
    let s = attr(&el, "AXSize").ok().and_then(|v| size(&v));
    // No frame (some groups, hidden menu items): an empty box, so the caller presses it instead.
    let Some((p, s)) = p.zip(s) else {
        return Ok(Bounds {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        });
    };
    Ok(Bounds {
        left: p.x.round() as i32,
        top: p.y.round() as i32,
        right: (p.x + s.width).round() as i32,
        bottom: (p.y + s.height).round() as i32,
    })
}

/// Sets a text field's value directly. False when the element takes no value.
pub fn set_value(window: i64, index: usize, text: &str) -> Result<bool, String> {
    let el = element(window, index)?;
    let name = CFString::from_static_str("AXValue");
    let mut settable: u8 = 0;
    let err = unsafe { el.is_attribute_settable(&name, NonNull::from(&mut settable)) };
    if gone(err) {
        return Err(ELEMENT_GONE.into());
    }
    if err != AXError::Success || settable == 0 {
        return Ok(false);
    }
    let err = unsafe { el.set_attribute_value(&name, &CFString::from_str(text)) };
    if err != AXError::Success {
        return Err(format!("Couldn't set the value (AX error {}).", err.0));
    }
    Ok(true)
}

/// Presses a control through Accessibility (AXPress), for one with no place on screen to click.
pub fn invoke(window: i64, index: usize) -> Result<bool, String> {
    let el = element(window, index)?;
    let err = unsafe { el.perform_action(&CFString::from_static_str("AXPress")) };
    match err {
        AXError::Success => Ok(true),
        AXError::ActionUnsupported => Ok(false),
        e if gone(e) => Err(ELEMENT_GONE.into()),
        e => Err(format!("Couldn't press it (AX error {}).", e.0)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_ax_roles_to_control_names() {
        let name = |role, subrole| control_type_name(kind_of(role, subrole));
        assert_eq!(name("AXButton", ""), "button");
        assert_eq!(name("AXTextField", "AXSearchField"), "edit");
        assert_eq!(name("AXPopUpButton", ""), "combobox");
        assert_eq!(name("AXRadioButton", "AXTabButton"), "tab");
        assert_eq!(name("AXRow", "AXOutlineRow"), "treeitem");
        assert_eq!(name("AXWebArea", ""), "document");
        assert_eq!(name("AXSomethingNew", ""), "custom");
        assert!(is_interactive(kind_of("AXMenuBarItem", "")));
        assert!(!is_interactive(kind_of("AXGroup", "")));
    }

    #[test]
    fn formats_numeric_values() {
        assert_eq!(numeric_value(CHECKBOX, 1.0).as_deref(), Some("on"));
        assert_eq!(numeric_value(SLIDER, 42.0).as_deref(), Some("42"));
        assert_eq!(numeric_value(SLIDER, 0.5).as_deref(), Some("0.50"));
        assert_eq!(numeric_value(BUTTON, 1.0), None);
    }
}
