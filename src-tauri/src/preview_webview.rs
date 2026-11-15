use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

const LABEL: &str = "preview-ext";

/// The bridge that lets the agent read and drive a page (see agent/preview_agent.js). Local
/// pages get it from the preview proxy; external sites from the webview's start-up script.
const AGENT_JS: &str = include_str!("agent/preview_agent.js");

/// The native webview that shows external sites in one browser tab, the cookie profile it was
/// built with and the address the tab last asked for. A different profile needs a new webview,
/// so each one gets a fresh label.
struct Page {
    label: String,
    profile: String,
    /// Where the page is: the address the tab asked for, then wherever the site took it.
    url: String,
    /// The tab's number for its latest navigation (see `preview_open`), sent back with every
    /// report so the tab can drop one about a page it already left.
    nav: u64,
    /// How dark the page is drawn under one of the app's dialogs (0 when none is open). The
    /// layer lives in the document, so every new one gets it again.
    dim: f64,
    /// The shadows the page draws around its holes (see `shadows_arg`), "" when it has none.
    /// They live in the document too.
    shadows: String,
    /// The last key pressed with Ctrl in the page, as WebView2 itself saw it (its virtual-key
    /// code, and when): the page's own report of an app shortcut must match it.
    #[cfg_attr(not(windows), allow(dead_code))]
    key: Option<(u32, Instant)>,
}

/// One webview per tab, so a tab in the background keeps its page alive like a real browser.
static PAGES: Mutex<Option<HashMap<String, Page>>> = Mutex::new(None);
static SEQ: Mutex<u32> = Mutex::new(0);

fn with_pages<R>(f: impl FnOnce(&mut HashMap<String, Page>) -> R) -> R {
    f(PAGES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(HashMap::new))
}

/// "private" keeps nothing; any other key is a folder of its own under the app data dir,
/// apart from the app's own storage so clearing it never touches Nyxs' settings.
const PRIVATE: &str = "private";

fn profile_key(profile: Option<String>) -> String {
    let raw = profile.unwrap_or_else(|| "shared".into());
    let key: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect();
    if key.is_empty() {
        "shared".into()
    } else {
        key
    }
}

fn profiles_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("browser"))
}

/// What pages in the browser see as `prefers-color-scheme`: "light" or "dark" from the app's
/// theme, or None to follow the system.
static SCHEME: Mutex<Option<String>> = Mutex::new(None);

/// Tauri only passes a theme to open webviews when Windows' own theme changes, so the app's
/// switch is set on the WebView2 profile directly, which repaints the page without a reload.
fn apply_scheme(wv: &tauri::Webview) {
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_13, COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO,
            COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK, COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT,
        };
        use windows_core::Interface;
        let scheme = match SCHEME.lock().unwrap_or_else(|e| e.into_inner()).as_deref() {
            Some("dark") => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK,
            Some("light") => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT,
            _ => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO,
        };
        let _ = wv.with_webview(move |pw| unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else {
                return;
            };
            let Ok(core) = core.cast::<ICoreWebView2_13>() else {
                return;
            };
            if let Ok(profile) = core.Profile() {
                let _ = profile.SetPreferredColorScheme(scheme);
            }
        });
    }
    #[cfg(not(windows))]
    let _ = wv;
}

/// Lets WebView2 offer to save the passwords typed into sites and fill them in next time, as
/// Edge does; it ships with that off. They're kept encrypted in the tab's profile folder, so
/// each cookie profile has its own. WKWebView and WebKitGTK have no password manager of their
/// own.
fn enable_password_manager(wv: &tauri::Webview) {
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
        use windows_core::Interface;
        let _ = wv.with_webview(|pw| unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else {
                return;
            };
            let Ok(settings) = core
                .Settings()
                .and_then(|s| s.cast::<ICoreWebView2Settings4>())
            else {
                return;
            };
            let _ = settings.SetIsPasswordAutosaveEnabled(true);
            let _ = settings.SetIsGeneralAutofillEnabled(true);
        });
    }
    #[cfg(not(windows))]
    let _ = wv;
}

/// Run in each open page after the scheme changes. Many sites (YouTube, Google) pick light or
/// dark only when they load, often on the server, so they never repaint on their own: when the
/// page's background still shows the old scheme a moment later, it's reloaded. Not while a video
/// or sound plays or a form holds typed text, so the switch never costs the user anything; such a
/// page picks the new scheme up on its next load.
const RESCHEME_JS: &str = r#"(() => {
  if (!/^https?:$/.test(location.protocol)) return;
  window.__nyxsRescheme = (window.__nyxsRescheme || 0) + 1;
  const run = window.__nyxsRescheme;
  setTimeout(() => {
    if (run !== window.__nyxsRescheme) return;
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const lum = (el) => {
      if (!el) return null;
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (!m || (m.length > 3 && Number(m[3]) === 0)) return null;
      return (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255;
    };
    const l = lum(document.body) ?? lum(document.documentElement) ?? 1;
    if ((l < 0.5) === dark) return;
    const playing = [...document.querySelectorAll("video, audio")].some((m) => !m.paused && !m.ended);
    const typed = [...document.querySelectorAll("textarea, input:not([type=hidden]):not([type=search])")]
      .some((e) => e.value !== e.defaultValue) ||
      [...document.querySelectorAll("[contenteditable=true]")].some((e) => e.textContent.trim());
    if (!playing && !typed) location.reload();
  }, 1500);
})()"#;

fn page_webviews(app: &AppHandle) -> Vec<tauri::Webview> {
    let labels: Vec<String> = with_pages(|pages| pages.values().map(|p| p.label.clone()).collect());
    labels.iter().filter_map(|l| app.get_webview(l)).collect()
}

#[tauri::command]
pub fn preview_set_theme(app: AppHandle, mode: Option<String>, reload: Option<bool>) {
    // Settings can keep pages that don't repaint from being reloaded.
    let reload = reload.unwrap_or(true);
    let changed = {
        let mut current = SCHEME.lock().unwrap_or_else(|e| e.into_inner());
        let changed = *current != mode;
        *current = mode.clone();
        changed
    };
    // Elsewhere the webviews follow the window's own theme; None leaves it to the system.
    #[cfg(not(windows))]
    if let Some(window) = app.get_window("main") {
        let theme = match mode.as_deref() {
            Some("dark") => Some(tauri::Theme::Dark),
            Some("light") => Some(tauri::Theme::Light),
            _ => None,
        };
        let _ = window.set_theme(theme);
    }
    for wv in page_webviews(&app) {
        apply_scheme(&wv);
        if changed {
            if reload {
                let _ = wv.eval(RESCHEME_JS);
            }
            // The dim darkens the scrollbar from the colors it measured: measure again once a
            // page that repaints by itself has taken the new scheme.
            let alpha = dim_of(wv.label());
            if alpha > 0.0 {
                let _ = wv.eval(format!(
                    "setTimeout(function () {{ var f = {DIM_JS}; f(0); f({alpha}); }}, 400);"
                ));
            }
        }
    }
    apply_to_app(&app);
}

/// Local pages (the project's dev server) show in an iframe of the app's own webview, so they
/// take its scheme: it gets the app's too. On "auto" that's the system's again, so the app's
/// own matchMedia keeps noticing when Windows switches.
fn apply_to_app(app: &AppHandle) {
    if let Some(main) = app.get_webview("main") {
        apply_scheme(&main);
    }
}

/// Windows announces theme changes (the system's mode, the accent color, sometimes unlocking
/// the session) and Tauri answers by giving every webview the system's theme, which would
/// overwrite the app's. Setting it again right after keeps the app's.
pub fn reapply_scheme(app: &AppHandle) {
    for wv in page_webviews(app) {
        apply_scheme(&wv);
    }
    apply_to_app(app);
}

pub(crate) fn find(app: &AppHandle, tab: &str) -> Option<tauri::Webview> {
    let label = with_pages(|pages| pages.get(tab).map(|p| p.label.clone()))?;
    app.get_webview(&label)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn preview_open(
    app: AppHandle,
    tab: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    profile: Option<String>,
    hidden: Option<bool>,
    nav: Option<u64>,
) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    let profile = profile_key(profile);
    let nav = nav.unwrap_or(0);
    // A page the agent of a chat in the background opens: it loads out of sight, so it never
    // shows over the chat the user is looking at.
    let hidden = hidden.unwrap_or(false);
    claim(&tab);

    if let Some(wv) = find(&app, &tab) {
        let (same_profile, same_url) = with_pages(|pages| {
            pages
                .get(&tab)
                .map(|p| (p.profile == profile, p.url == url))
                .unwrap_or((false, false))
        });
        if same_profile {
            // Showing the tab again keeps wherever the user browsed to; only a new address
            // navigates. The page's own navigations keep `url` current, so the tab following
            // them never makes it load again.
            if !same_url {
                wv.navigate(parsed).map_err(|e| e.to_string())?;
            }
            with_pages(|pages| {
                if let Some(p) = pages.get_mut(&tab) {
                    p.url = url.clone();
                    p.nav = nav;
                }
            });
            if hidden {
                return Ok(());
            }
            place(&wv, x, y, width, height)?;
            wv.show().map_err(|e| e.to_string())?;
            return Ok(());
        }
        // The cookie setting changed: start over with the other profile.
        let _ = wv.close();
        with_pages(|pages| pages.remove(&tab));
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    let label = {
        let mut seq = SEQ.lock().unwrap_or_else(|e| e.into_inner());
        *seq += 1;
        format!("{LABEL}-{}", *seq)
    };
    // Every document starts with the agent's bridge, so console output is kept from the first
    // line and the agent can drive the site. It runs as the app's own script, outside the
    // site's CSP, and gives the site no way to reach Nyxs.
    // It starts blank and navigates once the color scheme is set: sites like Google pick light
    // or dark on the server from the first request, which would otherwise carry the window's.
    let blank = Url::parse("about:blank").map_err(|e| e.to_string())?;
    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(blank))
        // Where the DevTools protocol follows the page's requests, the bridge leaves the
        // page's fetch and XMLHttpRequest alone (see preview_cdp.rs).
        .initialization_script(format!(
            "window.__nyxsDoc = Math.random().toString(36).slice(2);
window.__nyxsNative = {};
{AGENT_JS}",
            crate::preview_cdp::AVAILABLE
        ))
        // Websites, and the user's own address bar, stay off the app's protocols: Tauri would
        // treat a page there as the app itself (see `nav_guard`).
        .on_navigation(|url| {
            let ok = crate::nav_guard::site_may_open(url);
            if !ok {
                log::warn!(
                    "blocked a browser tab from navigating to {}",
                    log_origin(url.as_str())
                );
            }
            ok
        })
        .on_new_window({
            use tauri::Emitter;
            let app = app.clone();
            let tab = tab.clone();
            move |url, features| match new_window_choice(&url, features.size().is_some()) {
                NewWindow::Popup => tauri::webview::NewWindowResponse::Allow,
                NewWindow::NewTab => {
                    // The browser's view opens it in a tab of its own (PreviewView).
                    let _ = app.emit(
                        "preview-new-tab",
                        serde_json::json!({ "tab": tab, "url": url.as_str() }),
                    );
                    tauri::webview::NewWindowResponse::Deny
                }
                NewWindow::Refuse => {
                    log::warn!(
                        "blocked a browser tab from opening a window on {}",
                        log_origin(url.as_str())
                    );
                    tauri::webview::NewWindowResponse::Deny
                }
            }
        })
        // A page that loads while a dialog is open (reloaded for the theme, or navigating on its
        // own) would come up bright beside the dimmed app.
        .on_page_load(|wv, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                // The old document's requests won't finish now.
                crate::preview_cdp::with_net(wv.label(), |net| net.new_document());
                return;
            }
            let alpha = dim_of(wv.label());
            if alpha > 0.0 {
                let _ = wv.eval(format!("{DIM_JS}({alpha});"));
            }
            let shadows = shadows_of(wv.label());
            if !shadows.is_empty() {
                let _ = wv.eval(format!("{SHADOWS_JS}({shadows});"));
            }
            // A link, a form or a redirect took the page somewhere: the tab's address follows.
            report_nav(&wv);
        });
    if profile == PRIVATE {
        builder = builder.incognito(true);
    } else {
        let dir = profiles_dir(&app)?.join(&profile);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        builder = builder.data_directory(dir);
    }
    log::info!(
        "preview_open: creating child webview ({profile}) for {} at ({x},{y}) {width}x{height}",
        log_origin(&url)
    );
    // Off the window while it is hidden, so it doesn't flash before hide() takes effect.
    let position = if hidden {
        LogicalPosition::new(-(width + 100.0), -(height + 100.0))
    } else {
        LogicalPosition::new(x, y)
    };
    let wv = window
        .add_child(builder, position, LogicalSize::new(width, height))
        .map_err(|e| {
            log::error!("preview_open add_child failed: {e}");
            e.to_string()
        })?;
    if hidden {
        let _ = wv.hide();
    }
    // Both go through the event loop in order, so the scheme is in place before the request.
    apply_scheme(&wv);
    // A private tab keeps nothing, passwords included.
    if profile != PRIVATE {
        enable_password_manager(&wv);
    }
    watch_address(&wv);
    watch_keys(&wv);
    watch_messages(&wv);
    #[cfg(windows)]
    {
        crate::preview_cdp::watch_network(&wv);
        crate::preview_frames::watch(&wv);
    }
    wv.navigate(parsed).map_err(|e| e.to_string())?;
    with_pages(|pages| {
        pages.insert(
            tab,
            Page {
                label,
                profile,
                url,
                nav,
                dim: 0.0,
                shadows: String::new(),
                key: None,
            },
        )
    });
    Ok(())
}

/// Read in the page after it moves: where it is, and what its history allows. `navigation` is
/// Chromium's Navigation API; where it's missing (WebKit) the tab keeps to its own history.
const NAV_JS: &str = "({url: location.href, length: history.length, canBack: window.navigation ? navigation.canGoBack : null, canForward: window.navigation ? navigation.canGoForward : null})";

/// What the tab hears when its page moves on its own (`preview-nav`).
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NavReport {
    tab: String,
    url: String,
    nav: u64,
    length: u32,
    can_back: Option<bool>,
    can_forward: Option<bool>,
}

/// The report for what `NAV_JS` returned, or None for a page that isn't a website (the blank
/// page a webview starts on, an error page).
fn nav_report(tab: &str, nav: u64, v: &serde_json::Value) -> Option<NavReport> {
    let url = v.get("url")?.as_str()?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return None;
    }
    Some(NavReport {
        tab: tab.to_string(),
        url: url.to_string(),
        nav,
        length: v
            .get("length")
            .and_then(|l| l.as_u64())
            .map_or(0, |l| l as u32),
        can_back: v.get("canBack").and_then(|b| b.as_bool()),
        can_forward: v.get("canForward").and_then(|b| b.as_bool()),
    })
}

/// Tells the tab where its page is now. The page is asked, rather than trusting the event's
/// address, because only the page knows its history; the answer is dropped if the tab asked
/// for another address meanwhile.
fn report_nav(wv: &tauri::Webview) {
    use tauri::Emitter;
    let label = wv.label().to_string();
    let Some((tab, nav)) = with_pages(|pages| {
        pages
            .iter()
            .find(|(_, p)| p.label == label)
            .map(|(t, p)| (t.clone(), p.nav))
    }) else {
        return;
    };
    let app = wv.app_handle().clone();
    let _ = wv.eval_with_callback(NAV_JS, move |raw| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return;
        };
        let Some(report) = nav_report(&tab, nav, &value) else {
            return;
        };
        let current = with_pages(|pages| match pages.get_mut(&tab) {
            Some(p) if p.label == label && p.nav == nav => {
                p.url = report.url.clone();
                true
            }
            _ => false,
        });
        if current {
            let _ = app.emit("preview-nav", report);
        }
    });
}

/// On Windows the page also reports what a page load never shows: a script changing the
/// address (`pushState`, a `#hash`) and a step back or forward in its history.
fn watch_address(wv: &tauri::Webview) {
    #[cfg(windows)]
    {
        use webview2_com::{HistoryChangedEventHandler, SourceChangedEventHandler};
        let label = wv.label().to_string();
        let app = wv.app_handle().clone();
        let _ = wv.with_webview(move |pw| unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else {
                return;
            };
            let report = move || {
                if let Some(wv) = app.get_webview(&label) {
                    report_nav(&wv);
                }
            };
            let on_source = report.clone();
            let mut token = Default::default();
            let _ = core.add_SourceChanged(
                &SourceChangedEventHandler::create(Box::new(move |_, _| {
                    on_source();
                    Ok(())
                })),
                &mut token,
            );
            let _ = core.add_HistoryChanged(
                &HistoryChangedEventHandler::create(Box::new(move |_, _| {
                    report();
                    Ok(())
                })),
                &mut token,
            );
        });
    }
    #[cfg(not(windows))]
    let _ = wv;
}

/// An app shortcut typed in the page, as the agent bridge reports it (see preview_agent.js).
#[cfg(any(windows, test))]
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PageKey {
    key: String,
    code: String,
    key_code: u32,
    #[serde(default)]
    shift_key: bool,
    #[serde(default)]
    ctrl_key: bool,
    #[serde(default)]
    meta_key: bool,
}

/// What a page can tell the app through WebView2's page messages.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq)]
enum PageMessage {
    /// A press on the dim layer (see preview_dim.js).
    Backdrop,
    /// An app shortcut the page left alone.
    Key(PageKey),
}

/// Reads a page message. Only WebView2 delivers them here, so it exists on Windows (and for its
/// test everywhere).
#[cfg(any(windows, test))]
fn page_message(json: &str) -> Option<PageMessage> {
    let v = serde_json::from_str::<serde_json::Value>(json).ok()?;
    match v.get("nyxs")?.as_str()? {
        "backdrop" => Some(PageMessage::Backdrop),
        "key" => serde_json::from_value(v).ok().map(PageMessage::Key),
        _ => None,
    }
}

/// How long after WebView2 saw a key the page's report of it still counts. The page reports it
/// once its own handlers are done with it, a moment later.
#[cfg(any(windows, test))]
const KEY_WINDOW: Duration = Duration::from_secs(1);

/// Whether the page's report of a shortcut stands for a key the user really pressed: the last
/// key WebView2 saw with Ctrl held in that page, a moment ago. A script can post any message,
/// but not press keys, so a site can't work the app's shortcuts on its own.
#[cfg(any(windows, test))]
fn real_key(seen: Option<(u32, Instant)>, key: &PageKey, now: Instant) -> bool {
    key.ctrl_key
        && seen.is_some_and(|(vk, at)| vk == key.key_code && now.duration_since(at) <= KEY_WINDOW)
}

/// Notes each key pressed with Ctrl in the page, before the page gets it, so `watch_messages`
/// can tell a real shortcut from a message a script made up.
fn watch_keys(wv: &tauri::Webview) {
    #[cfg(windows)]
    {
        use webview2_com::AcceleratorKeyPressedEventHandler;
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
        };
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
        let label = wv.label().to_string();
        let _ = wv.with_webview(move |pw| unsafe {
            let mut token = Default::default();
            let _ = pw.controller().add_AcceleratorKeyPressed(
                &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                    let mut vk = 0u32;
                    // The page's keys arrive from WebView2's own process, so this thread's key
                    // state doesn't have them: Ctrl is read from the keyboard itself.
                    if args.KeyEventKind(&mut kind).is_err()
                        || kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                        || args.VirtualKey(&mut vk).is_err()
                        || GetAsyncKeyState(VK_CONTROL as i32) >= 0
                    {
                        return Ok(());
                    }
                    with_pages(|pages| {
                        if let Some(p) = pages.values_mut().find(|p| p.label == label) {
                            p.key = Some((vk, Instant::now()));
                        }
                    });
                    Ok(())
                })),
                &mut token,
            );
        });
    }
    #[cfg(not(windows))]
    let _ = wv;
}

/// What the page tells the app. A press on the dimmed page around one of the app's dialogs is a
/// press on the dialog's backdrop: the tab is told (`preview-backdrop`) and does what the
/// backdrop does, only while the page is dimmed, so a page can't reach the app when no dialog
/// is open. An app shortcut the page left alone (`preview-key`) is done by the app, as if typed
/// there, once `real_key` confirms the user pressed it.
fn watch_messages(wv: &tauri::Webview) {
    #[cfg(windows)]
    {
        use tauri::Emitter;
        use webview2_com::WebMessageReceivedEventHandler;
        let label = wv.label().to_string();
        let app = wv.app_handle().clone();
        let _ = wv.with_webview(move |pw| unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else {
                return;
            };
            let mut token = Default::default();
            let _ = core.add_WebMessageReceived(
                &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut raw = windows_core::PWSTR::null();
                    if args.WebMessageAsJson(&mut raw).is_err() {
                        return Ok(());
                    }
                    let json = webview2_com::take_pwstr(raw);
                    let Some(message) = page_message(&json) else {
                        return Ok(());
                    };
                    let now = Instant::now();
                    let tab = with_pages(|pages| {
                        let (tab, page) = pages.iter_mut().find(|(_, p)| p.label == label)?;
                        let allowed = match &message {
                            PageMessage::Backdrop => page.dim > 0.0,
                            // Taken, so one press is one shortcut.
                            PageMessage::Key(key) => real_key(page.key.take(), key, now),
                        };
                        allowed.then(|| tab.clone())
                    });
                    let Some(tab) = tab else { return Ok(()) };
                    let _ = match message {
                        PageMessage::Backdrop => app.emit("preview-backdrop", tab),
                        PageMessage::Key(key) => {
                            app.emit("preview-key", serde_json::json!({ "tab": tab, "key": key }))
                        }
                    };
                    Ok(())
                })),
                &mut token,
            );
        });
    }
    #[cfg(not(windows))]
    let _ = wv;
}

/// Steps the tab's page through its own history, as the browser's back and forward buttons do.
#[tauri::command]
pub async fn preview_history(app: AppHandle, tab: String, delta: i32) -> Result<(), String> {
    let wv = find(&app, &tab).ok_or("This tab has no website open.")?;
    wv.eval(format!("history.go({delta})"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn preview_set_bounds(
    app: AppHandle,
    tab: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(wv) = find(&app, &tab) {
        place(&wv, x, y, width, height)?;
        // Only answer once the main thread got here: the panel sends the next bounds after this
        // reply (previewWebview.ts), so a fast drag can't pile up moves the page then replays late.
        let (done, mut applied) = tauri::async_runtime::channel::<()>(1);
        app.run_on_main_thread(move || {
            let _ = done.try_send(());
        })
        .map_err(|e| e.to_string())?;
        let _ = applied.recv().await;
    }
    Ok(())
}

/// Moves and sizes the page in one step. Separate set_position and set_size calls leave it for a
/// moment with the new position and the old size, sticking out of its box.
fn place(wv: &tauri::Webview, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    wv.set_bounds(tauri::Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(width, height).into(),
    })
    .map_err(|e| e.to_string())
}

/// A rectangle of the app (a menu) to show through a tab's page, relative to the page's
/// top-left corner in logical pixels. Only Windows cuts them; elsewhere they're parsed and dropped.
#[derive(serde::Deserialize)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Hole {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    radius: f64,
    /// The panel's CSS `box-shadow`, which falls on the page around the hole.
    #[serde(default)]
    shadow: Option<String>,
}

/// The argument of preview_shadows.js for these holes: the ones with a shadow, and the page's
/// width in logical pixels. "" when none has one, so the page draws nothing.
#[cfg_attr(not(windows), allow(dead_code))]
fn shadows_arg(holes: &[Hole], page_width: f64) -> String {
    let boxes: Vec<_> = holes
        .iter()
        .filter_map(|h| {
            let shadow = h.shadow.as_deref().map(str::trim)?;
            (!shadow.is_empty() && shadow != "none").then(|| {
                serde_json::json!({
                    "x": h.x, "y": h.y, "width": h.width, "height": h.height,
                    "radius": h.radius, "shadow": shadow,
                })
            })
        })
        .collect();
    if boxes.is_empty() {
        return String::new();
    }
    let w = if page_width.is_finite() {
        page_width
    } else {
        0.0
    };
    serde_json::json!({ "w": w, "boxes": boxes }).to_string()
}

/// Draws the shadows of the panels shown through the page (see preview_shadows.js).
const SHADOWS_JS: &str = include_str!("preview_shadows.js");

fn shadows_of(label: &str) -> String {
    with_pages(|pages| {
        pages
            .values()
            .find(|p| p.label == label)
            .map_or_else(String::new, |p| p.shadows.clone())
    })
}

/// Cuts holes in a tab's page where the app draws its own menus. The native webview always
/// draws over the app, and hiding it for a menu meant a snapshot first: slow, and it blinked.
/// No holes restores the whole page. False where the platform can't do it, so the caller
/// falls back to hiding the page.
#[tauri::command]
pub async fn preview_set_holes(
    app: AppHandle,
    tab: String,
    holes: Vec<Hole>,
    page_width: Option<f64>,
) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let Some(wv) = find(&app, &tab) else {
            return Ok(false);
        };
        let shadows = shadows_arg(&holes, page_width.unwrap_or(0.0));
        let changed = with_pages(|pages| {
            pages.get_mut(&tab).is_some_and(|p| {
                let changed = p.shadows != shadows;
                p.shadows = shadows.clone();
                changed
            })
        });
        if changed {
            let arg = if shadows.is_empty() { "null" } else { &shadows };
            let _ = wv.eval(format!("{SHADOWS_JS}({arg});"));
        }
        let scale = wv.window().scale_factor().map_err(|e| e.to_string())?;
        wv.with_webview(move |pw| unsafe {
            // WebView2 runs inside a child window of wry's; clipping it clips the page.
            let mut hwnd = Default::default();
            if pw.controller().ParentWindow(&mut hwnd).is_ok() {
                clip_window(hwnd.0 as _, &holes, scale);
            }
        })
        .map_err(|e| e.to_string())?;
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, tab, holes, page_width);
        Ok(false)
    }
}

#[cfg(windows)]
unsafe fn clip_window(hwnd: windows_sys::Win32::Foundation::HWND, holes: &[Hole], scale: f64) {
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF,
    };
    if holes.is_empty() {
        SetWindowRgn(hwnd, std::ptr::null_mut(), 1);
        return;
    }
    let px = |v: f64| (v * scale).round() as i32;
    let region = CreateRectRgn(0, 0, i16::MAX as i32, i16::MAX as i32);
    for h in holes {
        let d = px(h.radius * 2.0);
        let hole = CreateRoundRectRgn(
            px(h.x),
            px(h.y),
            px(h.x + h.width) + 1,
            px(h.y + h.height) + 1,
            d,
            d,
        );
        CombineRgn(region, region, hole, RGN_DIFF);
        DeleteObject(hole);
    }
    // On success the window owns the region.
    if SetWindowRgn(hwnd, region, 1) == 0 {
        DeleteObject(region);
    }
}

/// Dims the page under a dialog (see preview_dim.js); called with the alpha.
const DIM_JS: &str = include_str!("preview_dim.js");

/// Dims a tab's page by `alpha` (0 removes it) while one of the app's dialogs is open. The
/// dialog's backdrop is drawn by the app, under the native webview, so it can't darken the
/// page: a layer inside the page does it instead. It lets clicks through, like the page did.
#[tauri::command]
pub async fn preview_set_dim(app: AppHandle, tab: String, alpha: f64) -> Result<(), String> {
    if let Some(wv) = find(&app, &tab) {
        let alpha = if alpha.is_finite() {
            alpha.clamp(0.0, 0.9)
        } else {
            0.0
        };
        with_pages(|pages| {
            if let Some(p) = pages.get_mut(&tab) {
                p.dim = alpha
            }
        });
        wv.eval(format!("{DIM_JS}({alpha});"))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn dim_of(label: &str) -> f64 {
    with_pages(|pages| {
        pages
            .values()
            .find(|p| p.label == label)
            .map_or(0.0, |p| p.dim)
    })
}

/// Puts a tab's page in the background: hidden, but still loaded.
#[tauri::command]
pub async fn preview_hide(app: AppHandle, tab: String) -> Result<(), String> {
    if let Some(wv) = find(&app, &tab) {
        wv.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn preview_reload(app: AppHandle, tab: String) -> Result<(), String> {
    if let Some(wv) = find(&app, &tab) {
        wv.eval("location.reload()").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Tabs whose page is waiting, hidden, for the reloaded app to pick it up again.
static UNCLAIMED: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);
const CLAIM_WINDOW: Duration = Duration::from_secs(45);
static RELOADS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn claim(tab: &str) {
    if let Some(set) = UNCLAIMED.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        set.remove(tab);
    }
}

/// The app's page is reloading. Each tab's website is hidden rather than closed, so the
/// reloaded app shows it again exactly as it was (scroll, forms, where it was browsed to);
/// pages no tab claims within a short while are closed, as nothing could move or close them.
pub fn hide_all_for_reload(app: &AppHandle) {
    let tabs: Vec<(String, String)> = with_pages(|pages| {
        pages
            .iter()
            .map(|(tab, p)| (tab.clone(), p.label.clone()))
            .collect()
    });
    if tabs.is_empty() {
        return;
    }
    for (_, label) in &tabs {
        if let Some(wv) = app.get_webview(label) {
            let _ = wv.hide();
            // A menu that was open when the page went away leaves its hole behind.
            #[cfg(windows)]
            let _ = wv.with_webview(|pw| unsafe {
                let mut hwnd = Default::default();
                if pw.controller().ParentWindow(&mut hwnd).is_ok() {
                    clip_window(hwnd.0 as _, &[], 1.0);
                }
            });
        }
    }
    *UNCLAIMED.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(tabs.iter().map(|(tab, _)| tab.clone()).collect());
    let generation = RELOADS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLAIM_WINDOW);
        // Another reload since then started its own wait.
        if RELOADS.load(std::sync::atomic::Ordering::SeqCst) != generation {
            return;
        }
        let left = UNCLAIMED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .unwrap_or_default();
        for tab in left {
            if let Some(wv) = find(&app, &tab) {
                let _ = wv.close();
            }
            with_pages(|pages| pages.remove(&tab));
        }
    });
}

/// Tabs the reloaded app restored: their pages stay open even if not shown yet.
#[tauri::command]
pub fn preview_claim(tabs: Vec<String>) {
    for tab in tabs {
        claim(&tab);
    }
}

#[tauri::command]
pub async fn preview_close(app: AppHandle, tab: String) -> Result<(), String> {
    if let Some(wv) = find(&app, &tab) {
        crate::preview_cdp::forget(wv.label());
        #[cfg(windows)]
        crate::preview_frames::forget(&app, wv.label());
        crate::preview_frames::forget_places(wv.label());
        wv.close().map_err(|e| e.to_string())?;
    }
    with_pages(|pages| pages.remove(&tab));
    Ok(())
}

/// Runs `js` in a tab's external page and returns its value. WebView2 answers "null" when the
/// script throws (a syntax error included).
pub(crate) fn eval_in(
    app: &AppHandle,
    tab: &str,
    js: String,
    wait: Duration,
) -> Result<serde_json::Value, String> {
    let wv = find(app, tab).ok_or("This tab has no website open.")?;
    let (tx, rx) = std::sync::mpsc::channel();
    wv.eval_with_callback(js, move |out| {
        let _ = tx.send(out);
    })
    .map_err(|e| e.to_string())?;
    let raw = rx
        .recv_timeout(wait)
        .map_err(|_| "The page didn't answer.".to_string())?;
    Ok(serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null))
}

/// `call`, with the bridge installed first if this page doesn't have it yet (a webview made
/// before the bridge existed).
fn with_bridge(call: &str) -> String {
    format!("(function(){{if(typeof window.__nyxsAgentRun!=='function'){{{AGENT_JS}\n}}return {call};}})()")
}

const STATUS_JS: &str = "({doc: window.__nyxsDoc || null, url: location.href, state: document.readyState, title: document.title, icon: window.__nyxsIcon ?? null})";

/// Where a tab's website is: its document id (new on every load), address, load state, title
/// and icon (null until the bridge has read it).
#[tauri::command]
pub async fn preview_agent_status(
    app: AppHandle,
    tab: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        eval_in(&app, &tab, STATUS_JS.into(), Duration::from_secs(5))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Starts or stops the element picker in a tab's website, or takes the element the user
/// clicked (null until they do).
#[tauri::command]
pub async fn preview_pick(
    app: AppHandle,
    tab: String,
    action: String,
) -> Result<serde_json::Value, String> {
    let call = match action.as_str() {
        "start" => "window.__nyxsPickStart()",
        "stop" => "window.__nyxsPickStop()",
        "take" => "window.__nyxsPickTake()",
        _ => return Err(format!("Unknown picker action {action}")),
    };
    let js = with_bridge(call);
    tauri::async_runtime::spawn_blocking(move || eval_in(&app, &tab, js, Duration::from_secs(5)))
        .await
        .map_err(|e| e.to_string())?
}

/// Runs one command of the agent's bridge (snapshot, click, fill, press, scroll, eval,
/// console) in a tab's website and returns its answer, like the local pages' postMessage path.
#[tauri::command]
pub async fn preview_agent_run(
    app: AppHandle,
    tab: String,
    cmd: String,
    args: serde_json::Value,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(15_000).clamp(1_000, 120_000));
    tauri::async_runtime::spawn_blocking(move || run_agent(&app, &tab, &cmd, &args, timeout))
        .await
        .map_err(|e| e.to_string())?
}

fn run_agent(
    app: &AppHandle,
    tab: &str,
    cmd: &str,
    args: &serde_json::Value,
    timeout: Duration,
) -> Result<String, String> {
    use crate::preview_frames::Target;
    // A ref of an embedded page of another site ("f12:e5") runs the command in that frame.
    let (target, args) = crate::preview_frames::route(args)?;
    // The page's snapshot and find take in what its frames of other sites have.
    #[cfg(windows)]
    if target == Target::Page
        && matches!(cmd, "snapshot" | "find")
        && args.get("ref").is_none()
        && args.get("selector").is_none()
    {
        if let Some(out) = crate::preview_frames::read_with_frames(app, tab, cmd, &args, timeout)? {
            return Ok(out);
        }
    }
    let out = match run_in(app, tab, target, cmd, &args, timeout)? {
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    };
    // A frame's bridge names its elements as its own: the agent gets them with the frame's
    // prefix, as in the page's snapshot.
    Ok(match target {
        Target::Frame(id) => crate::preview_frames::prefix_refs(&out, id),
        Target::Page => out,
    })
}

/// Where a document's bridge functions are: on the page's window, or in a frame of another
/// site under the name Nyxs gave them there (see preview_frames.rs).
fn bridge_obj(target: crate::preview_frames::Target) -> String {
    match target {
        crate::preview_frames::Target::Page => "window".into(),
        crate::preview_frames::Target::Frame(_) => {
            format!("window[{}]", serde_json::json!(frame_key()))
        }
    }
}

/// The name of a frame's bridge on its window, one per run of the app. Not a secret (the
/// frame's own scripts can list it): it only keeps off the names a site would look for.
fn frame_key() -> &'static str {
    static KEY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    KEY.get_or_init(|| {
        use std::hash::{BuildHasher, Hasher};
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        format!("_{:x}", h.finish())
    })
}

/// Runs `js` in the tab's page or in one of its frames.
pub(crate) fn eval_target(
    app: &AppHandle,
    tab: &str,
    target: crate::preview_frames::Target,
    js: String,
    wait: Duration,
) -> Result<serde_json::Value, String> {
    match target {
        crate::preview_frames::Target::Page => eval_in(app, tab, js, wait),
        #[cfg(windows)]
        crate::preview_frames::Target::Frame(id) => {
            let wv = find(app, tab).ok_or("This tab has no website open.")?;
            crate::preview_frames::eval_in_frame(&wv, id, js, wait)
        }
        #[cfg(not(windows))]
        crate::preview_frames::Target::Frame(_) => {
            let _ = (js, wait);
            Err("Embedded pages of other sites are only read on Windows.".into())
        }
    }
}

/// Runs one bridge command in the tab's page or in one of its frames and returns its answer.
pub(crate) fn run_in(
    app: &AppHandle,
    tab: &str,
    target: crate::preview_frames::Target,
    cmd: &str,
    args: &serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    use crate::preview_frames::Target;
    static NEXT: Mutex<u64> = Mutex::new(0);
    let id = {
        let mut n = NEXT.lock().unwrap_or_else(|e| e.into_inner());
        *n += 1;
        serde_json::json!(format!("nyxs-{}", *n)).to_string()
    };
    let short = Duration::from_secs(5);
    let obj = bridge_obj(target);
    let has = |func: &str| format!("({obj} && typeof {obj}.{func}==='function')");
    // The page normally has the bridge from its start-up script, so the call goes alone; only a
    // page without it gets the whole bridge sent along. A frame gets it the first time.
    let started = |call: String, func: &str| -> Result<bool, String> {
        let direct = format!("{} ? {call} : 'missing'", has(func));
        match eval_target(app, tab, target, direct, short)?.as_str() {
            Some("missing") => {
                let install = match target {
                    Target::Page => with_bridge(&call),
                    Target::Frame(_) => format!(
                        "(function(){{if(!{}){{window.__nyxsFrame={};{AGENT_JS}\n}}return {call};}})()",
                        has("__nyxsAgentRun"),
                        serde_json::json!(frame_key())
                    ),
                };
                eval_target(app, tab, target, install, short).map(|v| v.as_str() == Some("started"))
            }
            other => Ok(other == Some("started")),
        }
    };
    // Where actions go through the DevTools protocol, the bridge asks for real input and hears
    // about the page's requests and console from here (see preview_cdp.rs): what started since
    // this command and is still running, for its wait, and what it hasn't been told of.
    let label = find(app, tab)
        .map(|wv| wv.label().to_string())
        .unwrap_or_default();
    let since = Instant::now();
    let host = || match target {
        Target::Page => host_state(&label, since),
        Target::Frame(frame) => frame_host(&label, frame),
    };
    let ok = if cmd == "eval" {
        // The code goes in this script itself, not through eval(), so the site's CSP allows it.
        // An expression first ("document.title"), then statements with a return.
        let code = args
            .get("expression")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let run =
            |body: String| format!("{obj}.__nyxsAgentRunFn({id}, async function(){{ {body}\n }})");
        started(run(format!("return ({code}\n);")), "__nyxsAgentRunFn")?
            || started(run(code.to_string()), "__nyxsAgentRunFn")?
    } else {
        started(
            format!(
                "{obj}.__nyxsAgentRun({id}, {}, {}, {})",
                serde_json::json!(cmd),
                args,
                host()
            ),
            "__nyxsAgentRun",
        )?
    };
    if !ok {
        return Err(if cmd == "eval" {
            "The code didn't run: it has a syntax error.".into()
        } else {
            "The page didn't take the command.".into()
        });
    }

    let deadline = Instant::now() + timeout;
    // Most commands finish within a few milliseconds (a snapshot) or once the page settles
    // (an action, ~100 ms), so ask soon and then less often.
    let mut wait = Duration::from_millis(8);
    loop {
        std::thread::sleep(wait);
        wait = (wait * 2).min(Duration::from_millis(80));
        let take = format!(
            "{} ? {obj}.__nyxsAgentTake({id}, {}) : {{missing: true, url: location.href}}",
            has("__nyxsAgentTake"),
            host()
        );
        // A page that is navigating doesn't answer for a moment; keep asking.
        if let Ok(v) = eval_target(app, tab, target, take, short) {
            // The bridge has the element ready and asks for the click or the keys: they go in
            // as real input, and it carries on (with its own events if this failed).
            if let Some(input) = v.get("input").filter(|i| i.is_object()) {
                let done = match target {
                    Target::Page => dispatch_input(app, tab, input),
                    Target::Frame(frame) => frame_input(app, tab, &label, frame, input),
                };
                if let Err(e) = &done {
                    log::warn!("preview input through DevTools failed: {e}");
                }
                let js = format!(
                    "{obj} && {obj}.__nyxsAgentInputDone && {obj}.__nyxsAgentInputDone({id}, {})",
                    done.is_ok()
                );
                let _ = eval_target(app, tab, target, js, short);
                wait = Duration::from_millis(8);
                continue;
            }
            if v.get("missing").and_then(|m| m.as_bool()) == Some(true) {
                let url = v["url"].as_str().unwrap_or("").to_string();
                if target != Target::Page {
                    return Ok(format!("Done. The embedded page navigated to {url}.").into());
                }
                let url = wait_loaded(app, tab, deadline).unwrap_or(url);
                return Ok(format!("Done. The page navigated to {url}.").into());
            }
            if v.get("pending").is_none() && v.is_object() {
                if v.get("ok").and_then(|o| o.as_bool()) == Some(true) {
                    return Ok(v["result"].clone());
                }
                return Err(v["error"]
                    .as_str()
                    .unwrap_or("The command failed.")
                    .to_string());
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "The page didn't answer within {} s. It may be busy.",
                timeout.as_secs()
            ));
        }
    }
}

/// What a frame's bridge is told with each call: it may ask for real clicks once Nyxs knows
/// where its `<iframe>` is, never for keys (see preview_frames.rs). The page's requests and
/// console are the page's, not the frame's.
fn frame_host(label: &str, frame: u32) -> String {
    serde_json::json!({
        "trusted": crate::preview_cdp::AVAILABLE
            && crate::preview_frames::place_of(label, frame).is_some(),
        "keys": false,
        "inflight": 0,
        "net": [],
    })
    .to_string()
}

/// A real input a frame's bridge asks for. Only a click, at the point of the page the
/// documents around the frame give for it (none when the point is outside the frame or
/// something covers the frame there). Text and keys would go to whatever has the focus when
/// they arrive, which the page around the frame could have taken: the bridge types itself.
fn frame_input(
    app: &AppHandle,
    tab: &str,
    label: &str,
    frame: u32,
    input: &serde_json::Value,
) -> Result<(), String> {
    use crate::preview_frames::Target;
    if input.get("kind").and_then(|k| k.as_str()) != Some("click") {
        return Err("Keys and typed text don't go into an embedded page as real input.".into());
    }
    let coord = |k: &str| {
        input
            .get(k)
            .and_then(|v| v.as_f64())
            .filter(|v| v.is_finite())
    };
    let (Some(mut x), Some(mut y)) = (coord("x"), coord("y")) else {
        return Err("A click needs x and y.".into());
    };
    let mut at = Target::Frame(frame);
    // A frame inside a frame of another site is placed in that one first, then up to the page.
    for _ in 0..8 {
        let Target::Frame(f) = at else {
            return dispatch_input(
                app,
                tab,
                &serde_json::json!({ "kind": "click", "x": x, "y": y }),
            );
        };
        let (reader, slot) = crate::preview_frames::place_of(label, f)
            .ok_or("Nyxs doesn't know where this embedded page is yet: take a snapshot first.")?;
        let obj = bridge_obj(reader);
        let js = format!(
            "({obj} && typeof {obj}.__nyxsFramePoint==='function') ? {obj}.__nyxsFramePoint({}, {x}, {y}) : null",
            serde_json::json!(slot)
        );
        let p = eval_target(app, tab, reader, js, Duration::from_secs(5))?;
        let (Some(px), Some(py)) = (p["x"].as_f64(), p["y"].as_f64()) else {
            return Err(
                "The point isn't on the embedded page there: it's outside it or covered.".into(),
            );
        };
        (x, y, at) = (px, py, reader);
    }
    Err("The embedded page is nested too deep.".into())
}

/// What the page's bridge is told with each call (see `run_in`).
fn host_state(label: &str, since: Instant) -> String {
    let (inflight, net, console) = crate::preview_cdp::with_net(label, |n| {
        (n.running_since(since), n.take_failures(), n.take_console())
    });
    serde_json::json!({
        "trusted": crate::preview_cdp::AVAILABLE,
        "inflight": inflight,
        "net": net,
        "console": console,
    })
    .to_string()
}

/// Dispatches one input the bridge asked for as real input (see `preview_cdp::input_calls`).
fn dispatch_input(app: &AppHandle, tab: &str, input: &serde_json::Value) -> Result<(), String> {
    #[cfg(windows)]
    {
        let wv = find(app, tab).ok_or("This tab has no website open.")?;
        for (method, params) in crate::preview_cdp::input_calls(input)? {
            crate::preview_cdp::call(&wv, method, &params, Duration::from_secs(5))?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, tab, input);
        Err("Real input needs WebView2.".into())
    }
}

/// Waits for the tab's new document to finish loading and returns its address.
fn wait_loaded(app: &AppHandle, tab: &str, deadline: Instant) -> Option<String> {
    loop {
        if let Ok(v) = eval_in(app, tab, STATUS_JS.into(), Duration::from_secs(5)) {
            if v["state"] == "complete" {
                return v["url"].as_str().map(str::to_string);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// What clearing a profile's folder leaves, under its WebView2 data: the saved passwords
/// (`Login Data`), autofill (`Web Data`), and `Local State`, which holds the key the passwords
/// are encrypted with. Clearing browsing data is about cookies, history and caches.
const KEPT_ON_CLEAR: &[&str] = &[
    "EBWebView/Local State",
    "EBWebView/Default/Login Data",
    "EBWebView/Default/Login Data-journal",
    "EBWebView/Default/Login Data For Account",
    "EBWebView/Default/Login Data For Account-journal",
    "EBWebView/Default/Web Data",
    "EBWebView/Default/Web Data-journal",
];

/// Empties a profile folder no tab is using, except what `KEPT_ON_CLEAR` names.
fn clear_profile_folder(dir: &std::path::Path) {
    fn walk(dir: &std::path::Path, rel: &str) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            if KEPT_ON_CLEAR.contains(&path.as_str()) {
                continue;
            }
            let holds_kept = KEPT_ON_CLEAR
                .iter()
                .any(|k| k.starts_with(&format!("{path}/")));
            if holds_kept {
                walk(&entry.path(), &path);
            } else if entry.file_type().is_ok_and(|t| t.is_dir()) {
                let _ = std::fs::remove_dir_all(entry.path());
            } else {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    walk(dir, "");
}

/// Clears an open tab's browsing data but its saved passwords and autofill, as
/// `clear_profile_folder` does for a closed profile. Only WebView2 saves passwords (see
/// `enable_password_manager`); elsewhere everything is cleared.
#[cfg(windows)]
fn clear_open_profile(wv: &tauri::Webview) -> Result<(), String> {
    use webview2_com::ClearBrowsingDataCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile2, ICoreWebView2_13, COREWEBVIEW2_BROWSING_DATA_KINDS,
        COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE,
        COREWEBVIEW2_BROWSING_DATA_KINDS_GENERAL_AUTOFILL,
        COREWEBVIEW2_BROWSING_DATA_KINDS_PASSWORD_AUTOSAVE,
    };
    use windows_core::Interface;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    wv.with_webview(move |pw| unsafe {
        let kinds = COREWEBVIEW2_BROWSING_DATA_KINDS(
            COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE.0
                & !(COREWEBVIEW2_BROWSING_DATA_KINDS_PASSWORD_AUTOSAVE.0
                    | COREWEBVIEW2_BROWSING_DATA_KINDS_GENERAL_AUTOFILL.0),
        );
        let done = tx.clone();
        let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
            let _ = done.send(result.map_err(|e| e.to_string()));
            Ok(())
        }));
        let started = pw
            .controller()
            .CoreWebView2()
            .and_then(|c| c.cast::<ICoreWebView2_13>())
            .and_then(|c| c.Profile())
            .and_then(|p| p.cast::<ICoreWebView2Profile2>())
            .and_then(|p| p.ClearBrowsingData(kinds, &handler));
        if let Err(e) = started {
            let _ = tx.send(Err(e.to_string()));
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| "Clearing the browsing data didn't finish".to_string())?
}

#[cfg(not(windows))]
fn clear_open_profile(wv: &tauri::Webview) -> Result<(), String> {
    wv.clear_all_browsing_data().map_err(|e| e.to_string())
}

/// Clears what the built-in browser kept for external sites, open tabs and profile folders not
/// in use alike. Saved passwords and autofill stay.
#[tauri::command]
pub async fn preview_clear_data(app: AppHandle) -> Result<(), String> {
    let (labels, active): (Vec<String>, Vec<String>) = with_pages(|pages| {
        pages
            .values()
            .map(|p| (p.label.clone(), p.profile.clone()))
            .unzip()
    });
    for label in labels {
        if let Some(wv) = app.get_webview(&label) {
            clear_open_profile(&wv)?;
        }
    }
    let dir = profiles_dir(&app)?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if active.contains(&name) {
                continue;
            }
            clear_profile_folder(&entry.path());
        }
    }
    Ok(())
}

/// Saves what the preview shows right now — `x/y/width/height` are the page area in the
/// window, in CSS pixels — as a PNG at `path`. `tab` names the browser tab whose website is
/// shown there (see `capture_png`).
#[tauri::command]
pub async fn preview_capture(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    path: String,
    tab: Option<String>,
) -> Result<(), String> {
    let png = capture_png(&app, x, y, width, height, tab).await?;
    std::fs::write(&path, png).map_err(|e| e.to_string())
}

/// The same picture as `preview_capture`, as base64 PNG, for the agent to look at.
#[tauri::command]
pub async fn preview_capture_png(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    tab: Option<String>,
) -> Result<String, String> {
    use base64::Engine;
    let png = capture_png(&app, x, y, width, height, tab).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

/// A rectangle in pixels. It and the two crops below only serve the WebView2 capture, but are
/// tested on every OS.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq)]
struct PixelRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

/// Where the window area `x/y/width/height` (CSS pixels, `scale` device pixels each) falls in
/// the picture of a webview placed at `view_pos` with `view_size` (device pixels, in the
/// window) whose picture is `image` pixels: the picture may be at another resolution than the
/// screen, so the rectangle is scaled to it. Clipped to the picture; None if nothing is left.
#[cfg_attr(not(windows), allow(dead_code))]
fn crop_in_view(
    (x, y, width, height): (f64, f64, f64, f64),
    scale: f64,
    view_pos: (i32, i32),
    view_size: (u32, u32),
    image: (u32, u32),
) -> Option<PixelRect> {
    if view_size.0 == 0 || view_size.1 == 0 || image.0 == 0 || image.1 == 0 {
        return None;
    }
    let rx = image.0 as f64 / view_size.0 as f64;
    let ry = image.1 as f64 / view_size.1 as f64;
    let left = ((x * scale - view_pos.0 as f64) * rx).round().max(0.0);
    let top = ((y * scale - view_pos.1 as f64) * ry).round().max(0.0);
    let right = (((x + width) * scale - view_pos.0 as f64) * rx)
        .round()
        .min(image.0 as f64);
    let bottom = (((y + height) * scale - view_pos.1 as f64) * ry)
        .round()
        .min(image.1 as f64);
    if right - left < 1.0 || bottom - top < 1.0 {
        return None;
    }
    Some(PixelRect {
        x: left as u32,
        y: top as u32,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

/// The part `rect` of an RGBA picture `width` pixels wide.
#[cfg_attr(not(windows), allow(dead_code))]
fn crop_rgba(rgba: &[u8], width: u32, rect: PixelRect) -> Vec<u8> {
    let stride = width as usize * 4;
    let mut out = Vec::with_capacity(rect.width as usize * rect.height as usize * 4);
    for row in rect.y..rect.y + rect.height {
        let start = row as usize * stride + rect.x as usize * 4;
        out.extend_from_slice(&rgba[start..start + rect.width as usize * 4]);
    }
    out
}

fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// A PNG as 8-bit RGBA, whatever its own color type.
#[cfg(any(windows, test))]
fn decode_rgba(png_bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let mut decoder = png::Decoder::new(png_bytes);
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(info.buffer_size());
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        png::ColorType::GrayscaleAlpha => buf
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        png::ColorType::Grayscale => buf.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err("Unexpected indexed PNG".into()),
    };
    Ok((rgba, info.width, info.height))
}

/// A picture of the window area `x/y/width/height` (CSS pixels). It comes from the webview
/// itself, so another window over Nyxs or a panel partly off the screen doesn't show in it:
/// the tab's own webview when `tab` has a website open, else the app's webview (a local page,
/// with the drawings the annotation bar adds to it, is an iframe there). Only WebView2 can
/// draw a webview this way here; elsewhere, and if it fails, the area is copied from the
/// screen as before.
async fn capture_png(
    app: &AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    tab: Option<String>,
) -> Result<Vec<u8>, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    if window.is_minimized().unwrap_or(false) {
        return Err("The Nyxs window is minimized, so the preview isn't on screen.".into());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    if (width * scale).round() < 1.0 || (height * scale).round() < 1.0 {
        return Err("Nothing to capture.".into());
    }
    #[cfg(windows)]
    {
        let view = tab
            .as_deref()
            .and_then(|t| find(app, t))
            .or_else(|| app.get_webview("main"));
        if let Some(view) = view {
            match capture_view(&view, (x, y, width, height), scale).await {
                Ok(png) => return Ok(png),
                Err(e) => {
                    log::warn!("preview capture from the webview failed, using the screen: {e}")
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = tab;
    let origin = window.inner_position().map_err(|e| e.to_string())?;
    let left = origin.x + (x * scale).round() as i32;
    let top = origin.y + (y * scale).round() as i32;
    let w = (width * scale).round() as i32;
    let h = (height * scale).round() as i32;
    let rgba = capture_screen(left, top, w, h)?;
    encode_png(&rgba, w as u32, h as u32)
}

/// The window area `rect` (CSS pixels) as WebView2 draws it in `view` (`CapturePreview`).
#[cfg(windows)]
async fn capture_view(
    view: &tauri::Webview,
    rect: (f64, f64, f64, f64),
    scale: f64,
) -> Result<Vec<u8>, String> {
    let pos = view.position().map_err(|e| e.to_string())?;
    let size = view.size().map_err(|e| e.to_string())?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
    view.with_webview(move |pw| {
        if let Err(e) = start_capture_preview(&pw, tx.clone()) {
            let _ = tx.send(Err(e));
        }
    })
    .map_err(|e| e.to_string())?;
    let shot = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "The webview didn't draw its picture in time.".to_string())?
    })
    .await
    .map_err(|e| e.to_string())??;
    let (rgba, iw, ih) = decode_rgba(&shot)?;
    let crop = crop_in_view(
        rect,
        scale,
        (pos.x, pos.y),
        (size.width, size.height),
        (iw, ih),
    )
    .ok_or("Nothing of the page is in that area.")?;
    encode_png(&crop_rgba(&rgba, iw, crop), crop.width, crop.height)
}

/// Asks WebView2 for a PNG of everything the webview shows; it arrives through `tx`.
#[cfg(windows)]
fn start_capture_preview(
    pw: &tauri::webview::PlatformWebview,
    tx: std::sync::mpsc::Sender<Result<Vec<u8>, String>>,
) -> Result<(), String> {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateMemStream;
    unsafe {
        let core = pw.controller().CoreWebView2().map_err(|e| e.to_string())?;
        let stream: IStream = SHCreateMemStream(None).ok_or("Couldn't make a memory stream.")?;
        let out = stream.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
            let read = result.map_err(|e| e.to_string()).and_then(|()| {
                out.Seek(0, STREAM_SEEK_SET, None)
                    .map_err(|e| e.to_string())?;
                let mut bytes = Vec::new();
                let mut chunk = vec![0u8; 64 * 1024];
                loop {
                    let mut n = 0u32;
                    let _ = out.Read(chunk.as_mut_ptr().cast(), chunk.len() as u32, Some(&mut n));
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..n as usize]);
                }
                Ok(bytes)
            });
            let _ = tx.send(read);
            Ok(())
        }));
        core.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
        .map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
fn capture_screen(left: i32, top: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, SRCCOPY,
    };
    unsafe {
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("GetDC failed".into());
        }
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp);
        let ok = BitBlt(mem, 0, 0, w, h, screen, left, top, SRCCOPY | CAPTUREBLT);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let rows = GetDIBits(
            mem,
            bmp,
            0,
            h as u32,
            buf.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(mem, old);
        DeleteObject(bmp);
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);
        if ok == 0 || rows == 0 {
            return Err("Screen capture failed".into());
        }
        // BGRA → RGBA, fully opaque.
        for px in buf.as_chunks_mut::<4>().0 {
            px.swap(0, 2);
            px[3] = 255;
        }
        Ok(buf)
    }
}

#[cfg(not(windows))]
fn capture_screen(_left: i32, _top: i32, _w: i32, _h: i32) -> Result<Vec<u8>, String> {
    Err("Screenshots are only available on Windows for now.".into())
}

/// The name of the system's default web browser, for "Open in …".
#[tauri::command]
pub fn default_browser_name() -> Option<String> {
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER};
        use winreg::RegKey;
        let choice = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(
                r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice",
            )
            .ok()?;
        let prog_id: String = choice.get_value("ProgId").ok()?;
        let known = [
            ("MSEdge", "Microsoft Edge"),
            ("Chrome", "Google Chrome"),
            ("Firefox", "Firefox"),
            ("Brave", "Brave"),
            ("Opera", "Opera"),
            ("Vivaldi", "Vivaldi"),
            ("Arc", "Arc"),
        ];
        if let Some((_, name)) = known.iter().find(|(p, _)| prog_id.starts_with(p)) {
            return Some((*name).to_string());
        }
        let app_name: Option<String> = RegKey::predef(HKEY_CLASSES_ROOT)
            .open_subkey(format!(r"{prog_id}\Application"))
            .ok()
            .and_then(|k| k.get_value("ApplicationName").ok());
        app_name.filter(|n| !n.is_empty() && !n.starts_with('@'))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// What a page's `window.open` or `target="_blank"` link gets in a browser tab. Without an
/// answer WebView2 drops it, so the click did nothing.
#[derive(Debug, PartialEq)]
enum NewWindow {
    /// A real popup, related to the page (`window.opener`), as sign-in and payment flows need:
    /// it closes itself when done.
    Popup,
    /// The address opens in a new tab of the browser, next to this one.
    NewTab,
    Refuse,
}

fn new_window_choice(url: &Url, sized: bool) -> NewWindow {
    if !crate::nav_guard::site_may_open(url) {
        return NewWindow::Refuse;
    }
    let blank = url.as_str() == "about:blank";
    // On Windows the popup is WebView2's own window: none of the app's protocols or scripts
    // reach it. Elsewhere it would share the tab's configuration, the app's protocols
    // included, and its later navigations wouldn't pass `on_navigation`.
    if cfg!(windows) && (sized || blank) {
        return NewWindow::Popup;
    }
    if blank {
        NewWindow::Refuse
    } else {
        NewWindow::NewTab
    }
}

/// A tab's address as the log keeps it: its origin alone. The path, query and fragment can
/// carry sign-in codes, magic links or what the user looked at; support doesn't need them.
fn log_origin(url: &str) -> String {
    match Url::parse(url) {
        Ok(u) if u.has_host() => u.origin().ascii_serialization(),
        Ok(u) => format!("{}:", u.scheme()),
        Err(_) => "(not an address)".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clearing_a_closed_profile_keeps_its_saved_passwords() {
        let dir = std::env::temp_dir().join(format!("nyxs-clear-profile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let web = dir.join("EBWebView");
        std::fs::create_dir_all(web.join("Default/Local Storage/leveldb")).unwrap();
        std::fs::create_dir_all(web.join("Default/Cache")).unwrap();
        for f in [
            "Local State",
            "Default/Login Data",
            "Default/Login Data-journal",
            "Default/Login Data For Account",
            "Default/Web Data",
            "Default/Cookies",
            "Default/History",
            "Default/Local Storage/leveldb/000003.log",
            "Default/Cache/data_0",
        ] {
            std::fs::write(web.join(f), "x").unwrap();
        }
        clear_profile_folder(&dir);
        let left = |f: &str| web.join(f).exists();
        let kept = [
            "Local State",
            "Default/Login Data",
            "Default/Login Data-journal",
            "Default/Login Data For Account",
            "Default/Web Data",
        ];
        let gone = [
            "Default/Cookies",
            "Default/History",
            "Default/Local Storage",
            "Default/Cache",
        ];
        let result = (kept.map(left), gone.map(left));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(result, ([true; 5], [false; 4]));
    }

    #[test]
    fn a_new_window_opens_where_it_can_work() {
        let url = |s: &str| Url::parse(s).unwrap();
        // A `target="_blank"` link or a bare `window.open(url)`: a new tab.
        assert_eq!(
            new_window_choice(&url("https://example.com/terms"), false),
            NewWindow::NewTab
        );
        // A sign-in or payment popup needs `window.opener`: a real popup where it's safe.
        let popup = new_window_choice(&url("https://accounts.google.com/o/oauth2"), true);
        let blank = new_window_choice(&url("about:blank"), false);
        if cfg!(windows) {
            assert_eq!((popup, blank), (NewWindow::Popup, NewWindow::Popup));
        } else {
            assert_eq!((popup, blank), (NewWindow::NewTab, NewWindow::Refuse));
        }
        // Never the app's own protocols.
        assert_eq!(
            new_window_choice(&url("tauri://localhost/"), true),
            NewWindow::Refuse
        );
    }

    #[test]
    fn logs_a_tabs_origin_only() {
        assert_eq!(
            log_origin("https://login.example.com:8443/magic?token=abc#x"),
            "https://login.example.com:8443"
        );
        assert_eq!(log_origin("file:///C:/Users/ana/page.html"), "file:");
        assert_eq!(log_origin("data:text/html,<b>secret</b>"), "data:");
        assert_eq!(log_origin("not a url"), "(not an address)");
    }

    #[test]
    fn reports_a_website_with_its_history() {
        let v = json!({"url": "https://example.com/a?b=1#c", "length": 3, "canBack": true, "canForward": false});
        assert_eq!(
            nav_report("tab-1", 7, &v),
            Some(NavReport {
                tab: "tab-1".into(),
                url: "https://example.com/a?b=1#c".into(),
                nav: 7,
                length: 3,
                can_back: Some(true),
                can_forward: Some(false),
            })
        );
        // WebKit has no Navigation API: the history buttons are left to the tab.
        let webkit = json!({"url": "http://localhost:3000/", "length": 1, "canBack": null, "canForward": null});
        let r = nav_report("t", 1, &webkit).unwrap();
        assert_eq!((r.can_back, r.can_forward), (None, None));
        assert_eq!(
            serde_json::to_value(&r).unwrap()["canForward"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn the_page_draws_only_real_shadows_around_its_holes() {
        let hole = |shadow: Option<&str>| Hole {
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 120.0,
            radius: 8.0,
            shadow: shadow.map(str::to_string),
        };
        assert_eq!(shadows_arg(&[], 600.0), "");
        assert_eq!(
            shadows_arg(&[hole(None), hole(Some("none")), hole(Some(" "))], 600.0),
            ""
        );
        // A quote in the value stays inside the JSON string: the argument is evaluated as code.
        let shadow = r#"rgba(0, 0, 0, 0.25) 0px 25px 50px -12px, "x"); alert(1); ("#;
        let arg: serde_json::Value =
            serde_json::from_str(&shadows_arg(&[hole(None), hole(Some(shadow))], 600.0)).unwrap();
        assert_eq!(
            arg,
            json!({"w": 600.0, "boxes": [{
                "x": 10.0, "y": 20.0, "width": 300.0, "height": 120.0, "radius": 8.0, "shadow": shadow,
            }]})
        );
        let arg: serde_json::Value =
            serde_json::from_str(&shadows_arg(&[hole(Some("0 0 4px red"))], f64::NAN)).unwrap();
        assert_eq!(arg["w"], json!(0.0));
    }

    #[test]
    fn only_the_dim_layers_press_counts_as_a_backdrop_press() {
        assert_eq!(
            page_message(r#"{"nyxs":"backdrop"}"#),
            Some(PageMessage::Backdrop)
        );
        for other in [
            r#"{"nyxs":"other"}"#,
            r#""backdrop""#,
            r#"{"type":"backdrop"}"#,
            r#"{"nyxs":"key","key":"s"}"#,
            "not json",
            "",
        ] {
            assert_eq!(page_message(other), None, "{other}");
        }
    }

    fn ctrl_shift_s() -> PageKey {
        PageKey {
            key: "S".into(),
            code: "KeyS".into(),
            key_code: 0x53,
            shift_key: true,
            ctrl_key: true,
            meta_key: false,
        }
    }

    #[test]
    fn reads_a_shortcut_the_page_reports() {
        assert_eq!(
            page_message(
                r#"{"nyxs":"key","key":"S","code":"KeyS","keyCode":83,"shiftKey":true,"ctrlKey":true,"metaKey":false}"#
            ),
            Some(PageMessage::Key(ctrl_shift_s()))
        );
    }

    #[test]
    fn a_shortcut_counts_only_right_after_the_user_pressed_it() {
        let now = Instant::now();
        let key = ctrl_shift_s();
        assert!(real_key(Some((0x53, now)), &key, now));
        // A script's message with no key pressed, or after another key, or long after.
        assert!(!real_key(None, &key, now));
        assert!(!real_key(Some((0x4a, now)), &key, now));
        assert!(!real_key(Some((0x53, now)), &key, now + KEY_WINDOW * 2));
        // Without Ctrl it is no app shortcut.
        let plain = PageKey {
            ctrl_key: false,
            ..key
        };
        assert!(!real_key(Some((0x53, now)), &plain, now));
    }

    #[test]
    fn skips_pages_that_are_not_websites() {
        for url in [
            "about:blank",
            "chrome-error://chromewebdata/",
            "data:text/html,x",
        ] {
            assert_eq!(
                nav_report("t", 1, &json!({"url": url, "length": 1})),
                None,
                "{url}"
            );
        }
        assert_eq!(nav_report("t", 1, &serde_json::Value::Null), None);
    }

    #[test]
    fn crops_the_window_area_out_of_a_webviews_picture() {
        // The panel's page at (100, 50) CSS px on a 150 % screen, in the app's webview.
        let full = crop_in_view(
            (100.0, 50.0, 400.0, 300.0),
            1.5,
            (0, 0),
            (1800, 1200),
            (1800, 1200),
        );
        assert_eq!(
            full,
            Some(PixelRect {
                x: 150,
                y: 75,
                width: 600,
                height: 450
            })
        );
        // A website's own webview starts where the page does: the whole picture.
        assert_eq!(
            crop_in_view(
                (100.0, 50.0, 400.0, 300.0),
                1.5,
                (150, 75),
                (600, 450),
                (600, 450)
            ),
            Some(PixelRect {
                x: 0,
                y: 0,
                width: 600,
                height: 450
            })
        );
        // A picture at another resolution than the screen is cropped at its own.
        assert_eq!(
            crop_in_view(
                (100.0, 50.0, 400.0, 300.0),
                1.5,
                (150, 75),
                (600, 450),
                (400, 300)
            ),
            Some(PixelRect {
                x: 0,
                y: 0,
                width: 400,
                height: 300
            })
        );
        // Clipped to the picture; nothing left is no picture.
        assert_eq!(
            crop_in_view(
                (-10.0, 0.0, 30.0, 20.0),
                1.0,
                (0, 0),
                (100, 100),
                (100, 100)
            ),
            Some(PixelRect {
                x: 0,
                y: 0,
                width: 20,
                height: 20
            })
        );
        assert_eq!(
            crop_in_view(
                (200.0, 0.0, 30.0, 20.0),
                1.0,
                (0, 0),
                (100, 100),
                (100, 100)
            ),
            None
        );
        assert_eq!(
            crop_in_view((0.0, 0.0, 30.0, 20.0), 1.0, (0, 0), (0, 0), (100, 100)),
            None
        );
    }

    #[test]
    fn crops_and_reencodes_a_picture() {
        // 3x2: each pixel holds its own column and row.
        let rgba: Vec<u8> = (0..2u8)
            .flat_map(|y| (0..3u8).flat_map(move |x| [x, y, 0, 255]))
            .collect();
        let rect = PixelRect {
            x: 1,
            y: 1,
            width: 2,
            height: 1,
        };
        let part = crop_rgba(&rgba, 3, rect);
        assert_eq!(part, vec![1, 1, 0, 255, 2, 1, 0, 255]);
        let png = encode_png(&part, 2, 1).unwrap();
        assert_eq!(decode_rgba(&png).unwrap(), (part, 2, 1));

        // WebView2 may hand an RGB picture: it comes back opaque RGBA.
        let mut rgb = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut rgb, 1, 1);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .unwrap()
                .write_image_data(&[9, 8, 7])
                .unwrap();
        }
        assert_eq!(decode_rgba(&rgb).unwrap(), (vec![9, 8, 7, 255], 1, 1));
    }
}
