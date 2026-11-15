//! Embedded pages of other sites in a website's webview (WebView2 only): payment fields, video
//! players, captchas, which the page's own bridge can't read (the browser keeps their documents
//! from it).
//!
//! Nyxs reaches each such frame straight from the browser: WebView2 tells it about every frame
//! (`FrameCreated`, and `ChildFrameCreated` for the ones inside them) and runs scripts in one
//! (`ICoreWebView2Frame2::ExecuteScript`), answering to Nyxs alone. No message goes between the
//! page and the frame, so the page around a frame can neither ask its bridge for anything nor
//! read what it answers. A frame's bridge (agent/preview_agent.js in frame mode) answers no
//! messages, posts none, leaves the console alone and keeps its functions under a name Nyxs
//! picks, off the window's usual names; it goes in only when the agent reads or acts there.
//!
//! The snapshot of the page lists each frame of another site on the line of its `<iframe>`;
//! Nyxs reads the frame and puts its content there, with refs of its own (`f12:e5`, the frame
//! WebView2 calls 12). Which frame is which `<iframe>` is told from the frame's name, address and
//! size (`match_slots`). An action on such a ref runs in that frame. Clicks go as real input at
//! the point the page around the frame gives for it, only when nothing covers the frame there;
//! typed text and keys never do, since they go to whatever has the focus when they arrive, which
//! that page could take: in a frame the bridge types with its own events.

// The matching and merging are plain logic, tested on every OS, but only WebView2 calls them.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};

/// Where a bridge command runs: the tab's page, or one of its frames by WebView2's id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Page,
    Frame(u32),
}

/// A ref as the agent passes it: "e5" is in the page, "f12:e5" in frame 12.
pub fn split_ref(raw: &str) -> (Target, String) {
    let raw = raw.trim().trim_start_matches("ref=");
    if let Some((frame, inner)) = raw.split_once(':') {
        if let Some(id) = frame.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
            return (Target::Frame(id), inner.to_string());
        }
    }
    (Target::Page, raw.to_string())
}

/// Where a command goes from the refs it names (its `ref`, and each field's of `fill_form`),
/// with the refs as that bridge knows them. All of them must be in the same document.
pub fn route(args: &Value) -> Result<(Target, Value), String> {
    let mut out = args.clone();
    let mut target: Option<Target> = None;
    let mut take = |v: &mut Value| -> Result<(), String> {
        let Some(raw) = v.as_str() else { return Ok(()) };
        let (t, inner) = split_ref(raw);
        match target {
            Some(seen) if seen != t => {
                return Err("Those refs are in different documents (the page and an embedded page, or two embedded pages): act on one at a time.".into())
            }
            _ => target = Some(t),
        }
        *v = Value::String(inner);
        Ok(())
    };
    if let Some(r) = out.get_mut("ref") {
        take(r)?;
    }
    if let Some(fields) = out.get_mut("fields").and_then(Value::as_array_mut) {
        for f in fields {
            if let Some(r) = f.get_mut("ref") {
                take(r)?;
            }
        }
    }
    Ok((target.unwrap_or(Target::Page), out))
}

/// A frame of another site as the bridge of the document around it lists it (`frameSlot` in
/// preview_agent.js): a ref to its `<iframe>` (kept from the agent), the iframe's name, address
/// and inner size, and for a snapshot the line it is on and how deep.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Slot {
    #[serde(rename = "ref")]
    pub slot_ref: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub src: String,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
    #[serde(default)]
    pub line: Option<usize>,
    #[serde(default)]
    pub depth: usize,
}

/// A frame of the webview, as WebView2 and the frame itself tell it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FrameInfo {
    pub id: u32,
    /// The frame it is in, or None for one in the page.
    pub parent: Option<u32>,
    /// Its `<iframe>`'s name, as WebView2 saw it.
    pub name: String,
    pub url: String,
    pub width: f64,
    pub height: f64,
}

/// What a frame says about itself. `location` can't be replaced by the page; the sizes can, and
/// only help to tell frames apart.
pub const PROBE_JS: &str = "({url: location.href, width: innerWidth, height: innerHeight})";

/// The origin of an address, or None for one that takes its parent's (about:blank, srcdoc).
fn origin_of(url: &str) -> Option<String> {
    if url.is_empty() || url.starts_with("about:") {
        return None;
    }
    tauri::Url::parse(url)
        .ok()
        .map(|u| u.origin().ascii_serialization())
}

/// Whether a document at `url` is of another site than the one around it at `parent`, so that
/// one's bridge can't read it. A page without an origin of its own (about:blank) is its
/// parent's; a data: address (an opaque origin) never is.
pub fn foreign(url: &str, parent: &str) -> bool {
    match (origin_of(url), origin_of(parent)) {
        (None, _) => false,
        (Some(a), Some(b)) => a != b || a == "null",
        (Some(_), None) => true,
    }
}

/// Which bridge lists each frame of another site: the nearest frame of another site it is in,
/// or the page. Frames of the same site as the document around them are read by that
/// document's bridge and left out.
pub fn readers(frames: &[FrameInfo], page_url: &str) -> Vec<(u32, Target)> {
    let by_id = |id: u32| frames.iter().find(|f| f.id == id);
    let is_foreign = |f: &FrameInfo| foreign(&f.url, &effective_parent(f, &by_id, page_url));
    let mut out = Vec::new();
    for f in frames {
        if !is_foreign(f) {
            continue;
        }
        let mut p = f.parent;
        let reader = loop {
            match p.and_then(by_id) {
                None => break Target::Page,
                Some(up) if is_foreign(up) => break Target::Frame(up.id),
                Some(up) => p = up.parent,
            }
        };
        out.push((f.id, reader));
    }
    out
}

/// The address of the document a frame is in: its parent's, or for a parent with none of its
/// own (about:blank) the nearest one above it, up to the page's.
fn effective_parent<'a>(
    f: &FrameInfo,
    by_id: &impl Fn(u32) -> Option<&'a FrameInfo>,
    page_url: &str,
) -> String {
    let mut p = f.parent;
    while let Some(up) = p.and_then(by_id) {
        if origin_of(&up.url).is_some() {
            return up.url.clone();
        }
        p = up.parent;
    }
    page_url.to_string()
}

/// Which of `frames` is each slot's frame (an index into `frames`), or None. A name both sides
/// agree on decides first; then one frame of the slot's site and size, then one of its size
/// alone. Each frame goes to one slot at most, and a guess two frames fit is no answer.
pub fn match_slots(slots: &[Slot], frames: &[FrameInfo]) -> Vec<Option<usize>> {
    let mut out: Vec<Option<usize>> = vec![None; slots.len()];
    let mut taken = vec![false; frames.len()];
    let same_size = |s: &Slot, f: &FrameInfo| {
        (s.width - f.width).abs() <= 1.0 && (s.height - f.height).abs() <= 1.0
    };
    let same_site = |s: &Slot, f: &FrameInfo| {
        let o = origin_of(&f.url);
        o.is_some() && o == origin_of(&s.src)
    };
    type Rule<'r> = &'r dyn Fn(&Slot, &FrameInfo) -> bool;
    let rules: [Rule; 3] = [
        &|s, f| !s.name.is_empty() && s.name == f.name,
        &|s, f| same_site(s, f) && same_size(s, f),
        &|s, f| same_size(s, f),
    ];
    for rule in rules {
        for (i, s) in slots.iter().enumerate() {
            if out[i].is_some() {
                continue;
            }
            let fits: Vec<usize> = (0..frames.len())
                .filter(|&j| !taken[j] && rule(s, &frames[j]))
                .collect();
            // Another slot this frame fits as well leaves it ambiguous.
            if let [j] = fits[..] {
                let rivals = slots
                    .iter()
                    .enumerate()
                    .filter(|(k, o)| *k != i && out[*k].is_none() && rule(o, &frames[j]))
                    .count();
                if rivals == 0 {
                    out[i] = Some(j);
                    taken[j] = true;
                }
            }
        }
    }
    out
}

/// The note the bridge puts on a frame it can't read (`FOREIGN_NOTE` in preview_agent.js).
pub const FOREIGN_NOTE: &str =
    " (another site: its content can't be read; use click_at on a screenshot)";

/// At most this many lines of one frame go in the page's snapshot.
pub const MAX_FRAME_LINES: usize = 200;

/// How long a frame's address may be where the agent reads it.
const MAX_URL_CHARS: usize = 100;

/// A frame's address as the agent reads it: its site and path, without the query (an ad's
/// runs to kilobytes), and cut when still long.
pub fn short_url(url: &str) -> String {
    let shown = match tauri::Url::parse(url) {
        Ok(u) if u.has_host() => {
            let more = if u.query().is_some() || u.fragment().is_some() {
                "?…"
            } else {
                ""
            };
            format!("{}{}{more}", u.origin().ascii_serialization(), u.path())
        }
        _ => url.to_string(),
    };
    if shown.chars().count() > MAX_URL_CHARS {
        shown.chars().take(MAX_URL_CHARS).collect::<String>() + "…"
    } else {
        shown
    }
}

/// A frame's refs as the agent passes them: "[ref=e5]" becomes "[ref=f12:e5]". A frame inside
/// it already has its own prefix.
pub fn prefix_refs(line: &str, id: u32) -> String {
    line.replace("[ref=e", &format!("[ref=f{id}:e"))
}

/// The outline of a frame's snapshot, without its header (URL, title, viewport), to go under
/// its `<iframe>` line `depth` levels in.
pub fn frame_body(text: &str, id: u32, depth: usize) -> Vec<String> {
    let body = text.split_once("\n\n").map(|(_, b)| b).unwrap_or(text);
    let pad = "  ".repeat(depth);
    if body.trim() == "(the page shows nothing here)" || body.trim().is_empty() {
        return vec![format!("{pad}- (nothing of it shows here)")];
    }
    let mut lines: Vec<String> = body
        .lines()
        .take(MAX_FRAME_LINES)
        .map(|l| format!("{pad}{}", prefix_refs(l, id)))
        .collect();
    if body.lines().count() > MAX_FRAME_LINES {
        lines.push(format!(
            "{pad}- ... (cut at {MAX_FRAME_LINES} lines: use find, or snapshot with a ref inside it)"
        ));
    }
    lines
}

/// The page's snapshot with each frame it could read in place: the frame's `<iframe>` line says
/// where it is, and its outline follows. `filled` holds, per slot, the frame's address and lines.
pub fn merge_snapshot(
    text: &str,
    slots: &[Slot],
    filled: &[(usize, String, Vec<String>)],
) -> String {
    let Some((head, body)) = text.split_once("\n\n") else {
        return text.to_string();
    };
    let mut lines: Vec<String> = body.lines().map(str::to_string).collect();
    // From the bottom up, so the line numbers above stay right.
    let mut order: Vec<&(usize, String, Vec<String>)> = filled.iter().collect();
    order.sort_by_key(|(slot, _, _)| std::cmp::Reverse(slots[*slot].line.unwrap_or(0)));
    for (slot, url, inner) in order {
        let Some(at) = slots[*slot].line.filter(|&l| l < lines.len()) else {
            continue;
        };
        lines[at] = match lines[at].strip_suffix(FOREIGN_NOTE) {
            Some(start) => format!("{start} (another site, {url}):"),
            None => format!("{} (another site, {url}):", lines[at]),
        };
        for (k, l) in inner.iter().enumerate() {
            lines.insert(at + 1 + k, l.clone());
        }
    }
    format!("{head}\n\n{}", lines.join("\n"))
}

/// What `find` found in one document, as its bridge answers in frame mode.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Found {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub limit: usize,
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub lines: Vec<String>,
    #[serde(default)]
    pub frames: Vec<Slot>,
}

/// Each frame's id, address and matches.
pub type FrameFinds = Vec<(u32, String, Found)>;

/// The answer to `find` across the page and the frames it read. Worded as the bridge words it
/// for a page alone.
pub fn word_find(page: &Found, frames: &[(u32, String, Found)]) -> String {
    let total = page.total + frames.iter().map(|(_, _, f)| f.total).sum::<usize>();
    let query = &page.query;
    if total == 0 {
        let also = if frames.is_empty() {
            ""
        } else {
            ", and the embedded pages of other sites"
        };
        return format!("Nothing on the page matches \"{query}\" (the whole page was searched, off-screen parts too{also}).");
    }
    let limit = page.limit.max(1);
    let mut lines: Vec<String> = page.lines.clone();
    for (id, url, f) in frames {
        lines.extend(
            f.lines
                .iter()
                .map(|l| format!("{} (in the embedded page {url})", prefix_refs(l, *id))),
        );
    }
    let shown = lines.len().min(limit);
    lines.truncate(shown);
    let head = format!(
        "{total} {} for \"{query}\":",
        if total == 1 { "match" } else { "matches" }
    );
    let mut out = vec![head];
    out.extend(lines);
    if total > shown {
        out.push(format!("... and {} more: narrow the query.", total - shown));
    }
    out.join("\n")
}

/// The bridge's arguments for a frame's part of a snapshot or find: the same view, with its own
/// frames of other sites listed.
pub fn frame_args(args: &Value) -> Value {
    let mut a = args.clone();
    if let Some(o) = a.as_object_mut() {
        o.remove("ref");
        o.remove("selector");
        o.insert("frames".into(), json!(true));
    }
    a
}

/// Where each frame's `<iframe>` is, from the last snapshot or find that placed it: the
/// document whose bridge listed it and the `<iframe>`'s ref there, by webview and frame. A real
/// click in the frame is placed through it.
type Places = HashMap<(String, u32), (Target, String)>;
static PLACES: Mutex<Option<Places>> = Mutex::new(None);

fn with_places<R>(f: impl FnOnce(&mut Places) -> R) -> R {
    f(PLACES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(HashMap::new))
}

pub fn place_of(label: &str, frame: u32) -> Option<(Target, String)> {
    with_places(|p| p.get(&(label.to_string(), frame)).cloned())
}

fn set_place(label: &str, frame: u32, reader: Target, slot_ref: &str) {
    with_places(|p| p.insert((label.to_string(), frame), (reader, slot_ref.to_string())));
}

/// Forgets a closed webview's frames' places.
pub fn forget_places(label: &str) {
    with_places(|p| p.retain(|(l, _), _| l != label));
}

/// How deep frames inside frames of other sites are read.
const MAX_DEPTH: usize = 3;

/// The page's snapshot or find with what its frames of other sites have, or None when it has
/// none (the page's own answer is then the whole answer).
#[cfg(windows)]
pub fn read_with_frames(
    app: &tauri::AppHandle,
    tab: &str,
    cmd: &str,
    args: &Value,
    timeout: std::time::Duration,
) -> Result<Option<String>, String> {
    use std::time::Duration;
    let Some(wv) = crate::preview_webview::find(app, tab) else {
        return Ok(None);
    };
    let listed = registry::list(&wv);
    if listed.is_empty() {
        return Ok(None);
    }
    let short = Duration::from_secs(3);
    let page_url = crate::preview_webview::eval_in(app, tab, "location.href".into(), short)?
        .as_str()
        .unwrap_or("")
        .to_string();
    let infos: Vec<FrameInfo> = listed
        .into_iter()
        .filter_map(|(id, parent, name)| {
            // One that doesn't answer (still loading, or gone) is left out.
            let v = registry::eval(&wv, id, PROBE_JS.into(), short).ok()?;
            Some(FrameInfo {
                id,
                parent,
                name,
                url: v["url"].as_str()?.to_string(),
                width: v["width"].as_f64().unwrap_or(0.0),
                height: v["height"].as_f64().unwrap_or(0.0),
            })
        })
        .collect();
    let readers = readers(&infos, &page_url);
    if readers.is_empty() {
        return Ok(None);
    }
    let reader = Reader {
        app,
        tab,
        label: wv.label().to_string(),
        infos: &infos,
        readers: &readers,
        args,
        timeout,
        frame_timeout: timeout.min(Duration::from_secs(5)),
    };
    Ok(Some(match cmd {
        "find" => {
            let (page, frames) = reader.find(Target::Page, 0)?;
            word_find(&page, &frames)
        }
        _ => reader.snapshot(Target::Page, 0)?,
    }))
}

/// One snapshot or find going through the page and its frames.
#[cfg(windows)]
struct Reader<'a> {
    app: &'a tauri::AppHandle,
    tab: &'a str,
    label: String,
    infos: &'a [FrameInfo],
    readers: &'a [(u32, Target)],
    args: &'a Value,
    timeout: std::time::Duration,
    frame_timeout: std::time::Duration,
}

#[cfg(windows)]
impl Reader<'_> {
    /// The frames of other sites `at`'s bridge lists.
    fn frames_in(&self, at: Target) -> Vec<FrameInfo> {
        self.readers
            .iter()
            .filter(|(_, r)| *r == at)
            .filter_map(|(id, _)| self.infos.iter().find(|f| f.id == *id).cloned())
            .collect()
    }

    fn run(&self, at: Target, cmd: &str) -> Result<Value, String> {
        let wait = if at == Target::Page {
            self.timeout
        } else {
            self.frame_timeout
        };
        crate::preview_webview::run_in(self.app, self.tab, at, cmd, &frame_args(self.args), wait)
    }

    fn snapshot(&self, at: Target, depth: usize) -> Result<String, String> {
        let v = self.run(at, "snapshot")?;
        let text = v
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let slots: Vec<Slot> =
            serde_json::from_value(v.get("frames").cloned().unwrap_or(Value::Null))
                .unwrap_or_default();
        let mine = self.frames_in(at);
        let mut filled = Vec::new();
        for (i, m) in match_slots(&slots, &mine).into_iter().enumerate() {
            let Some(j) = m else { continue };
            let f = &mine[j];
            set_place(&self.label, f.id, at, &slots[i].slot_ref);
            if depth >= MAX_DEPTH {
                continue;
            }
            match self.snapshot(Target::Frame(f.id), depth + 1) {
                Ok(inner) => filled.push((
                    i,
                    short_url(&f.url),
                    frame_body(&inner, f.id, slots[i].depth),
                )),
                Err(e) => log::warn!("couldn't read the embedded page {}: {e}", f.url),
            }
        }
        Ok(merge_snapshot(&text, &slots, &filled))
    }

    /// `at`'s matches, and those of every frame of another site in it, with each frame's id and
    /// address. Find searches the whole page, so frames it couldn't place count too.
    fn find(&self, at: Target, depth: usize) -> Result<(Found, FrameFinds), String> {
        let found: Found = serde_json::from_value(self.run(at, "find")?)
            .map_err(|_| "The page's find didn't answer as expected.".to_string())?;
        let mine = self.frames_in(at);
        for (i, m) in match_slots(&found.frames, &mine).into_iter().enumerate() {
            if let Some(j) = m {
                set_place(&self.label, mine[j].id, at, &found.frames[i].slot_ref);
            }
        }
        let mut frames = Vec::new();
        if depth < MAX_DEPTH {
            for f in &mine {
                match self.find(Target::Frame(f.id), depth + 1) {
                    Ok((own, inner)) => {
                        frames.push((f.id, short_url(&f.url), own));
                        frames.extend(inner);
                    }
                    Err(e) => log::warn!("couldn't search the embedded page {}: {e}", f.url),
                }
            }
        }
        Ok((found, frames))
    }
}

#[cfg(windows)]
pub use registry::{eval as eval_in_frame, forget, watch};

/// The frames WebView2 reported, kept on the thread that runs the webview (its COM objects live
/// there; `with_webview` and the event handlers both run on it).
#[cfg(windows)]
mod registry {
    use std::cell::RefCell;
    use std::time::Duration;

    use serde_json::Value;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Frame, ICoreWebView2Frame2, ICoreWebView2Frame5, ICoreWebView2Frame7,
        ICoreWebView2_4,
    };
    use webview2_com::{
        ExecuteScriptCompletedHandler, FrameChildFrameCreatedEventHandler,
        FrameCreatedEventHandler, FrameDestroyedEventHandler,
    };
    use windows_core::{Interface, HSTRING};

    struct Entry {
        label: String,
        id: u32,
        parent: Option<u32>,
        frame: ICoreWebView2Frame2,
    }

    thread_local! {
        static FRAMES: RefCell<Vec<Entry>> = const { RefCell::new(Vec::new()) };
    }

    /// Starts keeping the webview's frames.
    pub fn watch(wv: &tauri::Webview) {
        let label = wv.label().to_string();
        let _ = wv.with_webview(move |pw| unsafe {
            let Ok(core) = pw
                .controller()
                .CoreWebView2()
                .and_then(|c| c.cast::<ICoreWebView2_4>())
            else {
                return;
            };
            let mut token = Default::default();
            let _ = core.add_FrameCreated(
                &FrameCreatedEventHandler::create(Box::new(move |_, args| {
                    if let Some(frame) = args.and_then(|a| a.Frame().ok()) {
                        track(&label, frame, None);
                    }
                    Ok(())
                })),
                &mut token,
            );
        });
    }

    fn track(label: &str, frame: ICoreWebView2Frame, parent: Option<u32>) {
        unsafe {
            let (Ok(f2), Ok(f5)) = (
                frame.cast::<ICoreWebView2Frame2>(),
                frame.cast::<ICoreWebView2Frame5>(),
            ) else {
                return;
            };
            let mut id = 0u32;
            if f5.FrameId(&mut id).is_err() {
                return;
            }
            FRAMES.with(|f| {
                f.borrow_mut().push(Entry {
                    label: label.to_string(),
                    id,
                    parent,
                    frame: f2,
                })
            });
            let gone = label.to_string();
            let mut token = Default::default();
            let _ = frame.add_Destroyed(
                &FrameDestroyedEventHandler::create(Box::new(move |_, _| {
                    FRAMES.with(|f| f.borrow_mut().retain(|e| !(e.label == gone && e.id == id)));
                    Ok(())
                })),
                &mut token,
            );
            if let Ok(f7) = frame.cast::<ICoreWebView2Frame7>() {
                let inside = label.to_string();
                let _ = f7.add_FrameCreated(
                    &FrameChildFrameCreatedEventHandler::create(Box::new(move |_, args| {
                        if let Some(child) = args.and_then(|a| a.Frame().ok()) {
                            track(&inside, child, Some(id));
                        }
                        Ok(())
                    })),
                    &mut token,
                );
            }
        }
    }

    /// The webview's frames: each one's id, the frame it is in and its `<iframe>`'s name.
    pub fn list(wv: &tauri::Webview) -> Vec<(u32, Option<u32>, String)> {
        let label = wv.label().to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        let sent = wv.with_webview(move |_| {
            let all = FRAMES.with(|f| {
                f.borrow()
                    .iter()
                    .filter(|e| e.label == label)
                    .map(|e| (e.id, e.parent, e.frame.clone()))
                    .collect::<Vec<_>>()
            });
            let named = all
                .into_iter()
                .map(|(id, parent, frame)| {
                    let mut raw = windows_core::PWSTR::null();
                    let name = match unsafe { frame.Name(&mut raw) } {
                        Ok(()) => webview2_com::take_pwstr(raw),
                        Err(_) => String::new(),
                    };
                    (id, parent, name)
                })
                .collect::<Vec<_>>();
            let _ = tx.send(named);
        });
        if sent.is_err() {
            return Vec::new();
        }
        rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default()
    }

    /// Runs `js` in one frame and returns its value, like `eval_in` for the page.
    pub fn eval(wv: &tauri::Webview, id: u32, js: String, wait: Duration) -> Result<Value, String> {
        let label = wv.label().to_string();
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        wv.with_webview(move |_| unsafe {
            let frame = FRAMES.with(|f| {
                f.borrow()
                    .iter()
                    .find(|e| e.label == label && e.id == id)
                    .map(|e| e.frame.clone())
            });
            let Some(frame) = frame else {
                let _ = tx.send(Err(
                    "That embedded page is gone. Take a new snapshot.".into()
                ));
                return;
            };
            let done = tx.clone();
            let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, json| {
                let _ = done.send(result.map(|()| json).map_err(|e| e.to_string()));
                Ok(())
            }));
            if let Err(e) = frame.ExecuteScript(&HSTRING::from(js), &handler) {
                let _ = tx.send(Err(e.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;
        let json = rx
            .recv_timeout(wait)
            .map_err(|_| "The embedded page didn't answer.".to_string())??;
        Ok(serde_json::from_str(&json).unwrap_or(Value::Null))
    }

    /// Lets go of a closed webview's frames.
    pub fn forget(app: &tauri::AppHandle, label: &str) {
        let label = label.to_string();
        let _ = app.run_on_main_thread(move || {
            FRAMES.with(|f| f.borrow_mut().retain(|e| e.label != label));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ref_names_its_frame() {
        assert_eq!(split_ref("e5"), (Target::Page, "e5".into()));
        assert_eq!(split_ref("f12:e5"), (Target::Frame(12), "e5".into()));
        assert_eq!(split_ref("ref=f3:e1"), (Target::Frame(3), "e1".into()));
        // Not a frame's prefix: the bridge says it doesn't know it.
        assert_eq!(split_ref("x:e1"), (Target::Page, "x:e1".into()));
    }

    #[test]
    fn a_command_goes_where_its_refs_are() {
        let (t, a) = route(&json!({ "ref": "f2:e7", "value": "4242" })).unwrap();
        assert_eq!(t, Target::Frame(2));
        assert_eq!(a, json!({ "ref": "e7", "value": "4242" }));

        let (t, a) = route(&json!({ "fields": [{ "ref": "f2:e1", "value": "a" }, { "ref": "f2:e2", "value": "b" }] })).unwrap();
        assert_eq!(t, Target::Frame(2));
        assert_eq!(a["fields"][1]["ref"], "e2");

        assert_eq!(route(&json!({ "query": "pay" })).unwrap().0, Target::Page);
        assert!(
            route(&json!({ "fields": [{ "ref": "e1" }, { "ref": "f2:e2" }] }))
                .unwrap_err()
                .contains("different documents")
        );
    }

    fn frame(id: u32, parent: Option<u32>, url: &str) -> FrameInfo {
        FrameInfo {
            id,
            parent,
            url: url.into(),
            ..Default::default()
        }
    }

    #[test]
    fn only_frames_of_another_site_are_read_by_the_document_around_them() {
        let page = "https://shop.example/checkout";
        let frames = [
            frame(1, None, "https://js.stripe.com/v3/elements"),
            frame(2, None, "https://shop.example/widget"),
            frame(3, Some(2), "https://www.youtube.com/embed/x"),
            frame(4, Some(1), "https://js.stripe.com/v3/inner"),
            frame(5, Some(1), "https://hooks.stripe.com/3ds"),
            frame(6, None, "about:blank"),
            frame(7, Some(6), "https://ads.example.net/a"),
        ];
        assert_eq!(
            readers(&frames, page),
            [
                (1, Target::Page),
                // Inside a frame of the page's own site: the page's bridge lists it.
                (3, Target::Page),
                (5, Target::Frame(1)),
                (7, Target::Page),
            ]
        );
        assert!(foreign("data:text/html,x", page));
        assert!(!foreign("about:srcdoc", page));
    }

    fn slot(name: &str, src: &str, w: f64, h: f64) -> Slot {
        Slot {
            slot_ref: format!("e{}", w as u32),
            name: name.into(),
            src: src.into(),
            width: w,
            height: h,
            ..Default::default()
        }
    }

    #[test]
    fn tells_each_frame_by_its_name_then_its_site_and_size() {
        let frames = [
            FrameInfo {
                id: 1,
                name: "__privateStripeFrame1".into(),
                url: "https://js.stripe.com/a".into(),
                width: 300.0,
                height: 40.0,
                ..Default::default()
            },
            FrameInfo {
                id: 2,
                name: "".into(),
                url: "https://www.youtube.com/embed/x".into(),
                width: 560.0,
                height: 315.0,
                ..Default::default()
            },
            FrameInfo {
                id: 3,
                name: "".into(),
                url: "https://ads.example.net/1".into(),
                width: 300.0,
                height: 250.0,
                ..Default::default()
            },
            FrameInfo {
                id: 4,
                name: "".into(),
                url: "https://ads.example.net/2".into(),
                width: 300.0,
                height: 250.0,
                ..Default::default()
            },
        ];
        let slots = [
            slot(
                "__privateStripeFrame1",
                "https://js.stripe.com/a",
                300.0,
                40.0,
            ),
            // A redirect took it elsewhere: its size still tells it.
            slot("", "https://youtu.be/x", 560.0, 315.0),
            // Two of the same site and size: no guess.
            slot("", "https://ads.example.net/1", 300.0, 250.0),
            slot("", "https://ads.example.net/2", 300.0, 250.0),
        ];
        assert_eq!(match_slots(&slots, &frames), [Some(0), Some(1), None, None]);
    }

    #[test]
    fn puts_a_frames_outline_under_its_iframe_line_with_its_own_refs() {
        let page = format!(
            "URL: https://shop.example/\nTitle: Pay\nViewport: 800x600, scrolled 0 of 0px\n\n- heading \"Pay\" [level=1] [ref=e1]\n- form \"Card\":\n  - iframe \"Secure card field\"{FOREIGN_NOTE}\n- button \"Pay now\" [ref=e2]"
        );
        let slots = [Slot {
            slot_ref: "e3".into(),
            line: Some(2),
            depth: 2,
            ..Default::default()
        }];
        let frame = "URL: https://js.stripe.com/a\nTitle: \nViewport: 300x40, scrolled 0 of 0px\n\n- textbox \"Card number\" [ref=e1]\n- textbox \"MM / YY\" [ref=e2]";
        let inner = frame_body(frame, 7, 2);
        let merged = merge_snapshot(
            &page,
            &slots,
            &[(0, "https://js.stripe.com/a".into(), inner)],
        );
        assert_eq!(
            merged.split_once("\n\n").unwrap().1,
            "- heading \"Pay\" [level=1] [ref=e1]\n- form \"Card\":\n  - iframe \"Secure card field\" (another site, https://js.stripe.com/a):\n    - textbox \"Card number\" [ref=f7:e1]\n    - textbox \"MM / YY\" [ref=f7:e2]\n- button \"Pay now\" [ref=e2]"
        );
        // A frame unread keeps its note.
        assert_eq!(merge_snapshot(&page, &slots, &[]), page);
        assert_eq!(
            frame_body("URL: x\n\n(the page shows nothing here)", 7, 1),
            ["  - (nothing of it shows here)"]
        );
        // A frame inside it keeps its own prefix.
        assert_eq!(
            prefix_refs("- link [ref=e3] [ref=f9:e1]", 7),
            "- link [ref=f7:e3] [ref=f9:e1]"
        );
    }

    #[test]
    fn a_frames_address_is_short_for_the_agent() {
        assert_eq!(
            short_url("https://www.youtube.com/embed/tgbNymZ7vqY"),
            "https://www.youtube.com/embed/tgbNymZ7vqY"
        );
        assert_eq!(
            short_url(
                "https://ad.doubleclick.net/ddm/adi/N95;sz=300x250?ord=rl8ppj&click=https%3A"
            ),
            "https://ad.doubleclick.net/ddm/adi/N95;sz=300x250?…"
        );
        let long = format!("https://a.example/{}", "x".repeat(200));
        assert_eq!(short_url(&long).chars().count(), MAX_URL_CHARS + 1);
        assert_eq!(short_url("about:blank"), "about:blank");
    }

    #[test]
    fn a_long_frame_is_cut() {
        let body: Vec<String> = (0..MAX_FRAME_LINES + 5)
            .map(|i| format!("- text: {i}"))
            .collect();
        let lines = frame_body(&format!("URL: x\n\n{}", body.join("\n")), 1, 0);
        assert_eq!(lines.len(), MAX_FRAME_LINES + 1);
        assert!(lines.last().unwrap().contains("cut at"));
    }

    #[test]
    fn find_counts_the_matches_of_every_document() {
        let page = Found {
            query: "card".into(),
            limit: 2,
            total: 1,
            lines: vec!["- heading \"Card\" [ref=e4]".into()],
            frames: vec![],
        };
        let stripe = Found {
            total: 2,
            lines: vec![
                "- textbox \"Card number\" [ref=e1]".into(),
                "- text: \"Card\" [ref=e2]".into(),
            ],
            ..Default::default()
        };
        assert_eq!(
            word_find(&page, &[(7, "https://js.stripe.com/a".into(), stripe)]),
            "3 matches for \"card\":\n- heading \"Card\" [ref=e4]\n- textbox \"Card number\" [ref=f7:e1] (in the embedded page https://js.stripe.com/a)\n... and 1 more: narrow the query."
        );
        let none = Found {
            query: "zz".into(),
            limit: 20,
            ..Default::default()
        };
        assert!(word_find(&none, &[(7, "u".into(), Found::default())])
            .contains("embedded pages of other sites"));
        assert!(!word_find(&none, &[]).contains("embedded"));
    }

    #[test]
    fn a_frame_reads_the_same_view_with_its_own_frames_listed() {
        assert_eq!(
            frame_args(&json!({ "area": "page", "ref": "e3" })),
            json!({ "area": "page", "frames": true })
        );
    }
}
