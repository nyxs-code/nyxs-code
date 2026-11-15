//! A window's controls through UI Automation, as Codex's computer use reads them: the agent
//! gets them numbered (button "Save", edit "Name" = "Ana") and acts on one by its number, which
//! hits far more reliably than coordinates read off a downscaled screenshot. The numbers belong
//! to the latest read of that window; any change to the window can make them stale.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub window_id: i64,
    pub title: String,
    /// The controls, one per line, indented by depth: `[3] button "Save"`.
    pub tree: String,
    pub count: usize,
    pub truncated: bool,
}

/// Where a control is on the desktop, in physical pixels, for a click at its center.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Bounds {
    pub fn center(&self) -> Option<(i32, i32)> {
        (self.right > self.left && self.bottom > self.top)
            .then(|| ((self.left + self.right) / 2, (self.top + self.bottom) / 2))
    }
}

/// The name UI Automation gives a control type, short and lowercase.
pub(crate) fn control_type_name(id: i32) -> &'static str {
    match id {
        50000 => "button",
        50001 => "calendar",
        50002 => "checkbox",
        50003 => "combobox",
        50004 => "edit",
        50005 => "link",
        50006 => "image",
        50007 => "listitem",
        50008 => "list",
        50009 => "menu",
        50010 => "menubar",
        50011 => "menuitem",
        50012 => "progressbar",
        50013 => "radio",
        50014 => "scrollbar",
        50015 => "slider",
        50016 => "spinner",
        50017 => "statusbar",
        50018 => "tabs",
        50019 => "tab",
        50020 => "text",
        50021 => "toolbar",
        50022 => "tooltip",
        50023 => "tree",
        50024 => "treeitem",
        50025 => "custom",
        50026 => "group",
        50027 => "thumb",
        50028 => "grid",
        50029 => "dataitem",
        50030 => "document",
        50031 => "splitbutton",
        50032 => "window",
        50033 => "pane",
        50034 => "header",
        50035 => "headeritem",
        50036 => "table",
        50037 => "titlebar",
        50038 => "separator",
        50039 => "semanticzoom",
        50040 => "appbar",
        _ => "element",
    }
}

/// Controls worth a line even without a name: the agent may want to act on them.
pub(crate) fn is_interactive(id: i32) -> bool {
    matches!(
        id,
        50000
            | 50002
            | 50003
            | 50004
            | 50005
            | 50007
            | 50011
            | 50013
            | 50015
            | 50016
            | 50019
            | 50024
            | 50029
            | 50030
            | 50031
    )
}

/// One control's line, without its number and indent.
pub(crate) fn describe(
    kind: i32,
    name: &str,
    value: Option<&str>,
    enabled: bool,
    focused: bool,
) -> String {
    let clip = |s: &str, n: usize| {
        let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
        if one_line.chars().count() > n {
            format!("{}…", one_line.chars().take(n).collect::<String>())
        } else {
            one_line
        }
    };
    let mut line = control_type_name(kind).to_string();
    if !name.trim().is_empty() {
        line.push_str(&format!(" \"{}\"", clip(name, 80)));
    }
    if let Some(v) = value.filter(|v| !v.trim().is_empty() && v.trim() != name.trim()) {
        line.push_str(&format!(" = \"{}\"", clip(v, 120)));
    }
    if !enabled {
        line.push_str(" (disabled)");
    }
    if focused {
        line.push_str(" (focused)");
    }
    line
}

#[cfg(target_os = "macos")]
#[path = "ax.rs"]
mod imp;

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::*;
    pub fn window_state(_: i64) -> Result<WindowState, String> {
        Err("Reading windows' controls only works on Windows for now.".into())
    }
    pub fn bounds(_: i64, _: usize) -> Result<Bounds, String> {
        Err("Reading windows' controls only works on Windows for now.".into())
    }
    pub fn set_value(_: i64, _: usize, _: &str) -> Result<bool, String> {
        Err("Reading windows' controls only works on Windows for now.".into())
    }
    pub fn invoke(_: i64, _: usize) -> Result<bool, String> {
        Err("Reading windows' controls only works on Windows for now.".into())
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use windows::core::BSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        AutomationElementMode_Full, CUIAutomation, IUIAutomation, IUIAutomationCacheRequest,
        IUIAutomationElement, IUIAutomationInvokePattern, IUIAutomationValuePattern,
        TreeScope_Subtree, UIA_AutomationIdPropertyId, UIA_BoundingRectanglePropertyId,
        UIA_ControlTypePropertyId, UIA_HasKeyboardFocusPropertyId, UIA_InvokePatternId,
        UIA_IsEnabledPropertyId, UIA_IsOffscreenPropertyId, UIA_NamePropertyId, UIA_ValuePatternId,
        UIA_ValueValuePropertyId,
    };

    /// Big trees (a browser page, an IDE) are cut here: past it the agent should zoom in on
    /// the screenshot instead.
    const MAX_ELEMENTS: usize = 400;
    const MAX_DEPTH: usize = 30;

    /// UI Automation's elements live in the MTA and may be used from any of its threads.
    struct Agile(IUIAutomationElement);
    unsafe impl Send for Agile {}

    /// The latest read of each window: its numbered controls.
    fn snapshots() -> &'static Mutex<HashMap<i64, Vec<Agile>>> {
        static S: OnceLock<Mutex<HashMap<i64, Vec<Agile>>>> = OnceLock::new();
        S.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn uia() -> Result<IUIAutomation, String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("UI Automation isn't available: {e}"))
        }
    }

    fn cache_request(uia: &IUIAutomation) -> windows::core::Result<IUIAutomationCacheRequest> {
        unsafe {
            let req = uia.CreateCacheRequest()?;
            for p in [
                UIA_NamePropertyId,
                UIA_ControlTypePropertyId,
                UIA_BoundingRectanglePropertyId,
                UIA_IsEnabledPropertyId,
                UIA_IsOffscreenPropertyId,
                UIA_HasKeyboardFocusPropertyId,
                UIA_AutomationIdPropertyId,
                UIA_ValueValuePropertyId,
            ] {
                req.AddProperty(p)?;
            }
            req.AddPattern(UIA_ValuePatternId)?;
            req.SetTreeScope(TreeScope_Subtree)?;
            req.SetTreeFilter(&uia.ControlViewCondition()?)?;
            req.SetAutomationElementMode(AutomationElementMode_Full)?;
            Ok(req)
        }
    }

    struct Walk {
        lines: Vec<String>,
        elements: Vec<Agile>,
        truncated: bool,
    }

    fn cached_value(el: &IUIAutomationElement) -> Option<String> {
        unsafe {
            let p: IUIAutomationValuePattern = el.GetCachedPatternAs(UIA_ValuePatternId).ok()?;
            p.CachedValue().ok().map(|b| b.to_string())
        }
    }

    fn walk(el: &IUIAutomationElement, depth: usize, out: &mut Walk) {
        if out.elements.len() >= MAX_ELEMENTS {
            out.truncated = true;
            return;
        }
        unsafe {
            if el.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false) {
                return;
            }
            let kind = el.CachedControlType().map(|t| t.0).unwrap_or(0);
            let name = el.CachedName().map(|b| b.to_string()).unwrap_or_default();
            let value = cached_value(el);
            let shown = depth > 0
                && (!name.trim().is_empty()
                    || value.as_deref().is_some_and(|v| !v.trim().is_empty())
                    || is_interactive(kind));
            let child_depth = if shown {
                let enabled = el.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(true);
                let focused = el
                    .CachedHasKeyboardFocus()
                    .map(|b| b.as_bool())
                    .unwrap_or(false);
                let index = out.elements.len();
                out.lines.push(format!(
                    "{}[{index}] {}",
                    "  ".repeat(depth.saturating_sub(1).min(12)),
                    describe(kind, &name, value.as_deref(), enabled, focused)
                ));
                out.elements.push(Agile(el.clone()));
                depth + 1
            } else {
                // A nameless pane or group adds nothing; its children take its place.
                depth.max(1)
            };
            if depth >= MAX_DEPTH {
                return;
            }
            let Ok(children) = el.GetCachedChildren() else {
                return;
            };
            let n = children.Length().unwrap_or(0);
            for i in 0..n {
                if let Ok(child) = children.GetElement(i) {
                    walk(&child, child_depth, out);
                }
            }
        }
    }

    fn title_of(hwnd: HWND) -> String {
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            let mut buf = vec![0u16; len.max(0) as usize + 1];
            let n = GetWindowTextW(hwnd, &mut buf);
            String::from_utf16_lossy(&buf[..n.max(0) as usize])
        }
    }

    pub fn window_state(window: i64) -> Result<WindowState, String> {
        let uia = uia()?;
        let hwnd = HWND(window as *mut _);
        let root = unsafe { uia.ElementFromHandle(hwnd) }
            .map_err(|_| "That window no longer exists; list the windows again.".to_string())?;
        let req = cache_request(&uia).map_err(|e| e.to_string())?;
        let root = unsafe { root.BuildUpdatedCache(&req) }
            .map_err(|e| format!("Couldn't read the window's controls: {e}"))?;
        let mut out = Walk {
            lines: Vec::new(),
            elements: Vec::new(),
            truncated: false,
        };
        walk(&root, 0, &mut out);
        let count = out.elements.len();
        snapshots().lock().unwrap().insert(window, out.elements);
        Ok(WindowState {
            window_id: window,
            title: title_of(hwnd),
            tree: out.lines.join("\n"),
            count,
            truncated: out.truncated,
        })
    }

    fn element(window: i64, index: usize) -> Result<IUIAutomationElement, String> {
        let map = snapshots().lock().unwrap();
        let list = map.get(&window).ok_or(
            "Read that window's controls first (get_window_state), then use their numbers.",
        )?;
        list.get(index).map(|a| a.0.clone()).ok_or_else(|| {
            format!(
                "There is no element {index} in that window's latest read (0 to {}).",
                list.len().saturating_sub(1)
            )
        })
    }

    pub fn bounds(window: i64, index: usize) -> Result<Bounds, String> {
        let el = element(window, index)?;
        let r = unsafe { el.CurrentBoundingRectangle() }.map_err(|_| {
            "That element is gone: the window changed. Read its controls again.".to_string()
        })?;
        Ok(Bounds {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
        })
    }

    /// Sets a text field's value directly. False when the element takes no value.
    pub fn set_value(window: i64, index: usize, text: &str) -> Result<bool, String> {
        let el = element(window, index)?;
        unsafe {
            let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            else {
                return Ok(false);
            };
            if p.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(false) {
                return Err("That field is read-only.".into());
            }
            p.SetValue(&BSTR::from(text))
                .map_err(|e| format!("Couldn't set the value: {e}"))?;
        }
        Ok(true)
    }

    /// Presses a control through UI Automation, for one with no place on screen to click.
    pub fn invoke(window: i64, index: usize) -> Result<bool, String> {
        let el = element(window, index)?;
        unsafe {
            let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            else {
                return Ok(false);
            };
            p.Invoke().map_err(|e| format!("Couldn't press it: {e}"))?;
        }
        Ok(true)
    }
}

pub use imp::{bounds, invoke, set_value, window_state};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_controls_on_one_line() {
        assert_eq!(
            describe(50000, "Guardar", None, true, false),
            "button \"Guardar\""
        );
        assert_eq!(
            describe(50004, "Nombre", Some("Ana\nLópez"), true, true),
            "edit \"Nombre\" = \"Ana López\" (focused)"
        );
        assert_eq!(
            describe(50004, "", Some(""), false, false),
            "edit (disabled)"
        );
        assert_eq!(
            describe(50020, "Hola", Some("Hola"), true, false),
            "text \"Hola\""
        );
    }

    #[test]
    fn centers_only_real_boxes() {
        assert_eq!(
            Bounds {
                left: 0,
                top: 0,
                right: 10,
                bottom: 20
            }
            .center(),
            Some((5, 10))
        );
        assert_eq!(
            Bounds {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0
            }
            .center(),
            None
        );
    }
}
