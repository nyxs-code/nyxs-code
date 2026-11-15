//! The DevTools protocol of a website's webview in the built-in browser (WebView2 only).
//!
//! Two things go through it. The agent's actions are dispatched as real input
//! (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`), so the page gets
//! trusted events, as from the user. And the page's requests are followed from the browser
//! (`Network.*`) instead of wrapping its `fetch` and `XMLHttpRequest`, which a site can notice.
//! The bridge in the page (agent/preview_agent.js) still finds the element, checks it can be
//! used and reports what changed; it asks for the input through `run_agent`'s polling.
//!
//! The page's console comes from the deprecated `Console` domain (`Console.messageAdded`), not
//! from `Runtime.enable`, the best-known sign of an automated browser, nor from wrapping
//! `console.log` in the page, which shows in its `toString()`. Tried against Edge 156 with the
//! usual anti-bot traps (getters on an error's `stack`, `toJSON`, proxies): `Console.enable`
//! runs no code of the page beyond what the browser runs anyway, and it hands over the messages
//! logged before it was on as well. Objects arrive as text ("[object Object]").

// The input translation and the request tracking are plain logic, tested on every OS, but only
// WebView2 calls them.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use serde_json::{json, Value};

/// One DevTools call: its method and parameters.
pub type Call = (&'static str, Value);

/// The CDP modifier bits of a key combo's modifiers ("Control+Shift+K" → Control, Shift).
fn modifier_bits(mods: &[&str]) -> u32 {
    mods.iter().fold(0, |bits, m| {
        bits | match m.to_ascii_lowercase().as_str() {
            "alt" | "option" => 1,
            "control" | "ctrl" => 2,
            "meta" | "cmd" | "command" | "super" => 4,
            "shift" => 8,
            _ => 0,
        }
    })
}

/// A key as the browser knows it: its `key`, physical `code`, Windows virtual-key code, and
/// the text it types (none for a key that types nothing).
#[derive(Debug, PartialEq)]
pub struct KeyInfo {
    pub key: String,
    pub code: String,
    pub vk: u32,
    pub text: Option<String>,
}

/// Looks up a key by the name the agent uses (Playwright's: "Enter", "ArrowDown", "a", "F5").
/// `shift` gives a letter its capital. A character with no key of its own on a US keyboard
/// still types itself.
pub fn key_info(name: &str, shift: bool) -> KeyInfo {
    let named = |key: &str, code: &str, vk: u32, text: Option<&str>| KeyInfo {
        key: key.into(),
        code: code.into(),
        vk,
        text: text.map(str::to_string),
    };
    match name {
        "Enter" | "Return" => return named("Enter", "Enter", 13, Some("\r")),
        "Tab" => return named("Tab", "Tab", 9, None),
        "Escape" | "Esc" => return named("Escape", "Escape", 27, None),
        "Backspace" => return named("Backspace", "Backspace", 8, None),
        "Delete" => return named("Delete", "Delete", 46, None),
        "ArrowLeft" | "Left" => return named("ArrowLeft", "ArrowLeft", 37, None),
        "ArrowUp" | "Up" => return named("ArrowUp", "ArrowUp", 38, None),
        "ArrowRight" | "Right" => return named("ArrowRight", "ArrowRight", 39, None),
        "ArrowDown" | "Down" => return named("ArrowDown", "ArrowDown", 40, None),
        "Home" => return named("Home", "Home", 36, None),
        "End" => return named("End", "End", 35, None),
        "PageUp" => return named("PageUp", "PageUp", 33, None),
        "PageDown" => return named("PageDown", "PageDown", 34, None),
        "Insert" => return named("Insert", "Insert", 45, None),
        "Space" | " " => return named(" ", "Space", 32, Some(" ")),
        _ => {}
    }
    if let Some(n) = name
        .strip_prefix('F')
        .and_then(|n| n.parse::<u32>().ok())
        .filter(|n| (1..=24).contains(n))
    {
        return named(name, name, 111 + n, None);
    }
    let mut chars = name.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else {
        // A name it doesn't know: sent as is, typing nothing.
        return named(name, "", 0, None);
    };
    let typed = |c: char| Some(c.to_string());
    if c.is_ascii_alphabetic() {
        let up = c.to_ascii_uppercase();
        let shown = if shift { up } else { c };
        return KeyInfo {
            key: shown.to_string(),
            code: format!("Key{up}"),
            vk: up as u32,
            text: typed(shown),
        };
    }
    if c.is_ascii_digit() {
        return KeyInfo {
            key: c.to_string(),
            code: format!("Digit{c}"),
            vk: c as u32,
            text: typed(c),
        };
    }
    let (code, vk) = match c {
        '-' | '_' => ("Minus", 189),
        '=' | '+' => ("Equal", 187),
        ',' | '<' => ("Comma", 188),
        '.' | '>' => ("Period", 190),
        '/' | '?' => ("Slash", 191),
        ';' | ':' => ("Semicolon", 186),
        '\'' | '"' => ("Quote", 222),
        '[' | '{' => ("BracketLeft", 219),
        ']' | '}' => ("BracketRight", 221),
        '\\' | '|' => ("Backslash", 220),
        '`' | '~' => ("Backquote", 192),
        _ => ("", 0),
    };
    KeyInfo {
        key: c.to_string(),
        code: code.into(),
        vk,
        text: typed(c),
    }
}

/// The DevTools calls for one input the bridge asks for:
/// - `{kind: "click", x, y}`: a left click at a point of the page's viewport, in CSS pixels
///   (what the protocol takes, so the screen's scaling doesn't enter);
/// - `{kind: "text", text}`: typing text into the focused field, as an IME would;
/// - `{kind: "key", key: "Control+Shift+K"}`: a key with its modifiers, pressed and released.
pub fn input_calls(req: &Value) -> Result<Vec<Call>, String> {
    match req.get("kind").and_then(Value::as_str) {
        Some("click") => {
            let at = |k: &str| req.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
            let (Some(x), Some(y)) = (at("x"), at("y")) else {
                return Err("A click needs x and y.".into());
            };
            let mouse = |kind: &str, buttons: u32| json!({ "type": kind, "x": x, "y": y, "button": if kind == "mouseMoved" { "none" } else { "left" }, "buttons": buttons, "clickCount": if kind == "mouseMoved" { 0 } else { 1 }, "pointerType": "mouse" });
            Ok(vec![
                ("Input.dispatchMouseEvent", mouse("mouseMoved", 0)),
                ("Input.dispatchMouseEvent", mouse("mousePressed", 1)),
                ("Input.dispatchMouseEvent", mouse("mouseReleased", 0)),
            ])
        }
        Some("text") => {
            let text = req.get("text").and_then(Value::as_str).unwrap_or("");
            Ok(vec![("Input.insertText", json!({ "text": text }))])
        }
        Some("key") => {
            let combo = req.get("key").and_then(Value::as_str).unwrap_or("");
            // "Control++" is Control and the plus key.
            let (mods, key) = match combo.strip_suffix("++") {
                Some(rest) => (rest.split('+').collect::<Vec<_>>(), "+"),
                None => {
                    let mut parts: Vec<&str> = combo.split('+').collect();
                    let key = parts.pop().unwrap_or("");
                    (parts, key)
                }
            };
            if key.is_empty() {
                return Err("Pass the key to press.".into());
            }
            let bits = modifier_bits(&mods);
            let info = key_info(key, bits & 8 != 0);
            // With Control, Alt or Meta the key is a shortcut: it types nothing.
            let text = info.text.filter(|_| bits & 7 == 0);
            let mut down = json!({
                "type": if text.is_some() { "keyDown" } else { "rawKeyDown" },
                "modifiers": bits,
                "key": info.key,
                "code": info.code,
                "windowsVirtualKeyCode": info.vk,
            });
            if let Some(t) = &text {
                down["text"] = json!(t);
                down["unmodifiedText"] = json!(t);
            }
            let up = json!({
                "type": "keyUp",
                "modifiers": bits,
                "key": info.key,
                "code": info.code,
                "windowsVirtualKeyCode": info.vk,
            });
            Ok(vec![
                ("Input.dispatchKeyEvent", down),
                ("Input.dispatchKeyEvent", up),
            ])
        }
        _ => Err("Unknown input.".into()),
    }
}

/// What the page's requests are doing, as the browser reports them. Only `fetch` and
/// `XMLHttpRequest` count, as when the bridge wrapped them: the page's own failed images and
/// scripts it already sees as `error` events.
#[derive(Default)]
pub struct NetState {
    /// Requests still running, with when they started.
    running: HashMap<String, (Instant, String)>,
    /// Failures not yet handed to the page's bridge.
    failures: Vec<String>,
    /// The page's console messages not yet handed to its bridge, as `{level, text}`.
    console: Vec<Value>,
}

/// Keeps at most this many failures waiting for the bridge.
const MAX_FAILURES: usize = 200;
/// And this many console messages, as many as the bridge keeps.
const MAX_CONSOLE: usize = 500;
/// A message longer than this is cut, as the bridge cuts its own.
const MAX_CONSOLE_CHARS: usize = 2000;

impl NetState {
    /// Takes in one `Network.*` or `Console.messageAdded` event.
    pub fn on_event(&mut self, name: &str, params: &Value, now: Instant) {
        if name == "Console.messageAdded" {
            self.on_console(&params["message"]);
            return;
        }
        let id = params
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let counted =
            |p: &Value| matches!(p.get("type").and_then(Value::as_str), Some("Fetch" | "XHR"));
        match name {
            "Network.requestWillBeSent" if counted(params) => {
                let req = &params["request"];
                let what = format!(
                    "{} {}",
                    req["method"].as_str().unwrap_or("GET"),
                    req["url"].as_str().unwrap_or("")
                );
                self.running.insert(id.to_string(), (now, what));
            }
            "Network.responseReceived" if counted(params) => {
                let status = params["response"]["status"].as_u64().unwrap_or(0);
                if status >= 400 {
                    let what = self
                        .running
                        .get(id)
                        .map(|(_, w)| w.clone())
                        .unwrap_or_else(|| {
                            params["response"]["url"].as_str().unwrap_or("").to_string()
                        });
                    self.fail(format!("{what} -> {status}"));
                }
            }
            "Network.loadingFinished" => {
                self.running.remove(id);
            }
            "Network.loadingFailed" => {
                if let Some((_, what)) = self.running.remove(id) {
                    // One the page dropped itself (a new search replacing the last) didn't fail.
                    if params["canceled"].as_bool() != Some(true) {
                        let why = params["errorText"].as_str().unwrap_or("failed");
                        self.fail(format!("{what} failed: {why}"));
                    }
                }
            }
            _ => {}
        }
    }

    /// One console message. Only the page's own `console.*` calls: the browser's notes about
    /// failed loads the bridge hears from the page's `error` events and from `Network.*`.
    fn on_console(&mut self, msg: &Value) {
        if msg["source"].as_str() != Some("console-api") {
            return;
        }
        let level = match msg["level"].as_str().unwrap_or("log") {
            "warning" => "warn",
            l @ ("log" | "info" | "error" | "debug") => l,
            _ => "log",
        };
        let mut text = msg["text"].as_str().unwrap_or("").to_string();
        if text.chars().count() > MAX_CONSOLE_CHARS {
            text = text.chars().take(MAX_CONSOLE_CHARS).collect::<String>() + "...";
        }
        if self.console.len() >= MAX_CONSOLE {
            self.console.remove(0);
        }
        self.console.push(json!({ "level": level, "text": text }));
    }

    pub fn take_console(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.console)
    }

    fn fail(&mut self, line: String) {
        if self.failures.len() >= MAX_FAILURES {
            self.failures.remove(0);
        }
        self.failures.push(line);
    }

    /// How many requests that started at `since` or later are still running.
    pub fn running_since(&self, since: Instant) -> usize {
        self.running.values().filter(|(at, _)| *at >= since).count()
    }

    pub fn take_failures(&mut self) -> Vec<String> {
        std::mem::take(&mut self.failures)
    }

    /// A new document: what the old one had running won't finish, and what it logged and its
    /// bridge never took went with it, as the bridge's own log does.
    pub fn new_document(&mut self) {
        self.running.clear();
        self.console.clear();
    }
}

static NET: Mutex<Option<HashMap<String, NetState>>> = Mutex::new(None);

/// The network state of the webview `label`.
pub fn with_net<R>(label: &str, f: impl FnOnce(&mut NetState) -> R) -> R {
    let mut all = NET.lock().unwrap_or_else(|e| e.into_inner());
    f(all
        .get_or_insert_with(HashMap::new)
        .entry(label.to_string())
        .or_default())
}

/// Forgets a closed webview's network state.
pub fn forget(label: &str) {
    if let Some(all) = NET.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        all.remove(label);
    }
}

/// Whether the webview's actions and requests go through the DevTools protocol.
pub const AVAILABLE: bool = cfg!(windows);

/// Calls one DevTools method in the webview and waits for its answer.
#[cfg(windows)]
pub fn call(
    wv: &tauri::Webview,
    method: &str,
    params: &Value,
    timeout: std::time::Duration,
) -> Result<Value, String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::HSTRING;
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let method = HSTRING::from(method);
    let params = HSTRING::from(params.to_string());
    wv.with_webview(move |pw| unsafe {
        let done = tx.clone();
        let handler =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                let _ = done.send(result.map(|()| json).map_err(|e| e.to_string()));
                Ok(())
            }));
        let started = pw
            .controller()
            .CoreWebView2()
            .and_then(|core| core.CallDevToolsProtocolMethod(&method, &params, &handler));
        if let Err(e) = started {
            let _ = tx.send(Err(e.to_string()));
        }
    })
    .map_err(|e| e.to_string())?;
    let json = rx
        .recv_timeout(timeout)
        .map_err(|_| "The browser didn't answer in time.".to_string())??;
    Ok(serde_json::from_str(&json).unwrap_or(Value::Null))
}

/// Follows the webview's requests and console from the browser (see `NetState`): subscribes to
/// the `Network.*` and `Console.messageAdded` events and turns both domains on.
#[cfg(windows)]
pub fn watch_network(wv: &tauri::Webview) {
    use webview2_com::DevToolsProtocolEventReceivedEventHandler;
    use windows_core::HSTRING;
    let label = wv.label().to_string();
    let _ = wv.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else {
            return;
        };
        for name in [
            "Network.requestWillBeSent",
            "Network.responseReceived",
            "Network.loadingFinished",
            "Network.loadingFailed",
            "Console.messageAdded",
        ] {
            let Ok(receiver) = core.GetDevToolsProtocolEventReceiver(&HSTRING::from(name)) else {
                continue;
            };
            let label = label.clone();
            let mut token = Default::default();
            let _ = receiver.add_DevToolsProtocolEventReceived(
                &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut raw = windows_core::PWSTR::null();
                    if args.ParameterObjectAsJson(&mut raw).is_ok() {
                        let json = webview2_com::take_pwstr(raw);
                        if let Ok(params) = serde_json::from_str::<Value>(&json) {
                            with_net(&label, |net| net.on_event(name, &params, Instant::now()));
                        }
                    }
                    Ok(())
                })),
                &mut token,
            );
        }
        for method in ["Network.enable", "Console.enable"] {
            let handler = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(
                Box::new(move |result, _| {
                    // Without it the agent gets no console from the site (a future WebView2
                    // that drops the deprecated domain): worth knowing in the logs.
                    if let Err(e) = result {
                        log::warn!("{method} failed in the built-in browser: {e}");
                    }
                    Ok(())
                }),
            );
            let _ = core.CallDevToolsProtocolMethod(
                &HSTRING::from(method),
                &HSTRING::from("{}"),
                &handler,
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_click_is_a_real_press_and_release_at_the_point() {
        let calls = input_calls(&json!({ "kind": "click", "x": 120.5, "y": 40 })).unwrap();
        let kinds: Vec<_> = calls
            .iter()
            .map(|(m, p)| (*m, p["type"].as_str().unwrap()))
            .collect();
        assert_eq!(
            kinds,
            [
                ("Input.dispatchMouseEvent", "mouseMoved"),
                ("Input.dispatchMouseEvent", "mousePressed"),
                ("Input.dispatchMouseEvent", "mouseReleased"),
            ]
        );
        // CSS pixels of the viewport go through as they are: no screen scaling enters.
        assert_eq!(
            (calls[1].1["x"].as_f64(), calls[1].1["y"].as_f64()),
            (Some(120.5), Some(40.0))
        );
        assert_eq!(calls[1].1["button"], "left");
        assert_eq!(calls[1].1["clickCount"], 1);
        assert!(input_calls(&json!({ "kind": "click", "x": 1 })).is_err());
        assert!(input_calls(&json!({ "kind": "drag" })).is_err());
    }

    #[test]
    fn text_is_typed_as_one_insertion() {
        assert_eq!(
            input_calls(&json!({ "kind": "text", "text": "hola ñ" })).unwrap(),
            vec![("Input.insertText", json!({ "text": "hola ñ" }))]
        );
    }

    #[test]
    fn keys_carry_their_code_and_what_they_type() {
        let enter = input_calls(&json!({ "kind": "key", "key": "Enter" })).unwrap();
        assert_eq!(enter[0].1["type"], "keyDown");
        assert_eq!(enter[0].1["windowsVirtualKeyCode"], 13);
        assert_eq!(enter[0].1["text"], "\r");
        assert_eq!(enter[1].1["type"], "keyUp");

        let tab = input_calls(&json!({ "kind": "key", "key": "Shift+Tab" })).unwrap();
        assert_eq!(tab[0].1["type"], "rawKeyDown");
        assert_eq!(tab[0].1["modifiers"], 8);
        assert_eq!(tab[0].1["code"], "Tab");
        assert!(tab[0].1.get("text").is_none());

        // A shortcut types nothing.
        let select_all = input_calls(&json!({ "kind": "key", "key": "Control+a" })).unwrap();
        assert_eq!(select_all[0].1["modifiers"], 2);
        assert_eq!(select_all[0].1["windowsVirtualKeyCode"], 65);
        assert!(select_all[0].1.get("text").is_none());

        let plus = input_calls(&json!({ "kind": "key", "key": "Control++" })).unwrap();
        assert_eq!(plus[0].1["key"], "+");
        assert_eq!(plus[0].1["code"], "Equal");
        assert!(input_calls(&json!({ "kind": "key", "key": "" })).is_err());
    }

    #[test]
    fn looks_up_keys_by_their_names() {
        assert_eq!(
            key_info("a", true),
            KeyInfo {
                key: "A".into(),
                code: "KeyA".into(),
                vk: 65,
                text: Some("A".into())
            }
        );
        assert_eq!(key_info("7", false).code, "Digit7");
        assert_eq!(key_info("ArrowDown", false).vk, 40);
        assert_eq!(
            key_info("F5", false),
            KeyInfo {
                key: "F5".into(),
                code: "F5".into(),
                vk: 116,
                text: None
            }
        );
        assert_eq!(key_info("/", false).vk, 191);
        // No key of its own, but it still types.
        assert_eq!(key_info("ñ", false).text.as_deref(), Some("ñ"));
        assert_eq!(key_info("Hyper", false).vk, 0);
    }

    #[test]
    fn follows_the_pages_requests_and_keeps_their_failures() {
        let t0 = Instant::now();
        let mut net = NetState::default();
        let sent = |id: &str, kind: &str, url: &str| json!({ "requestId": id, "type": kind, "request": { "method": "POST", "url": url } });
        net.on_event(
            "Network.requestWillBeSent",
            &sent("1", "Fetch", "https://a.com/api"),
            t0,
        );
        net.on_event(
            "Network.requestWillBeSent",
            &sent("2", "Image", "https://a.com/x.png"),
            t0,
        );
        net.on_event(
            "Network.requestWillBeSent",
            &sent("3", "XHR", "https://a.com/slow"),
            t0 + Duration::from_millis(50),
        );
        assert_eq!(net.running_since(t0), 2);
        // Only what started since the action counts for its wait.
        assert_eq!(net.running_since(t0 + Duration::from_millis(10)), 1);

        net.on_event("Network.responseReceived", &json!({ "requestId": "1", "type": "Fetch", "response": { "status": 500, "url": "https://a.com/api" } }), t0);
        net.on_event("Network.loadingFinished", &json!({ "requestId": "1" }), t0);
        net.on_event(
            "Network.loadingFailed",
            &json!({ "requestId": "3", "type": "XHR", "errorText": "net::ERR_FAILED" }),
            t0,
        );
        assert_eq!(net.running_since(t0), 0);
        assert_eq!(
            net.take_failures(),
            [
                "POST https://a.com/api -> 500",
                "POST https://a.com/slow failed: net::ERR_FAILED"
            ]
        );
        assert!(net.take_failures().is_empty());

        // One the page dropped itself is no failure.
        net.on_event(
            "Network.requestWillBeSent",
            &sent("4", "Fetch", "https://a.com/q"),
            t0,
        );
        net.on_event(
            "Network.loadingFailed",
            &json!({ "requestId": "4", "canceled": true, "errorText": "net::ERR_ABORTED" }),
            t0,
        );
        assert!(net.take_failures().is_empty());
    }

    #[test]
    fn keeps_the_pages_console_calls_until_the_bridge_takes_them() {
        let t0 = Instant::now();
        let mut net = NetState::default();
        let msg = |source: &str, level: &str, text: &str| json!({ "message": { "source": source, "level": level, "text": text } });
        net.on_event(
            "Console.messageAdded",
            &msg("console-api", "log", "tick 1 [object Object]"),
            t0,
        );
        net.on_event(
            "Console.messageAdded",
            &msg("console-api", "warning", "careful"),
            t0,
        );
        // The browser's own note about a failed load is no console call of the page.
        net.on_event(
            "Console.messageAdded",
            &msg("network", "error", "Failed to load resource"),
            t0,
        );
        net.on_event(
            "Console.messageAdded",
            &msg("console-api", "error", &"x".repeat(MAX_CONSOLE_CHARS + 10)),
            t0,
        );
        let taken = net.take_console();
        assert_eq!(taken.len(), 3);
        assert_eq!(
            taken[0],
            json!({ "level": "log", "text": "tick 1 [object Object]" })
        );
        assert_eq!(taken[1]["level"], "warn");
        assert_eq!(
            taken[2]["text"].as_str().unwrap().chars().count(),
            MAX_CONSOLE_CHARS + 3
        );
        assert!(net.take_console().is_empty());

        for i in 0..MAX_CONSOLE + 5 {
            net.on_event(
                "Console.messageAdded",
                &msg("console-api", "log", &i.to_string()),
                t0,
            );
        }
        // A new document drops what the old one logged and nobody took.
        let kept = net.console.len();
        assert_eq!(kept, MAX_CONSOLE);
        assert_eq!(net.console[0]["text"], "5");
        net.new_document();
        assert!(net.take_console().is_empty());
    }
}
