//! Visual previews the agent writes in the chat (```preview blocks). The chat hands their HTML
//! here and shows it in a sandboxed iframe at `/__nyxs/mockup/<id>` on the preview protocol: a
//! page of the app itself would inherit its CSP, which blocks the mockup's inline scripts.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};

pub(crate) const MOCKUP_PATH: &str = "/__nyxs/mockup/";
/// After a mockup's id: the same page for the side panel's canvas, with the element picker and
/// the drawing layer. The chat's own iframe and the saved file don't get them.
const CANVAS_SUFFIX: &str = "/canvas";

/// Enough for every preview of a long conversation; the oldest go first.
const MAX_MOCKUPS: usize = 64;
const MAX_MOCKUP_BYTES: usize = 2 * 1024 * 1024;
/// The app's theme (colors, font as a data URL, base styles).
const MAX_THEME_BYTES: usize = 512 * 1024;

/// Runs before the page's own scripts: reports the page height so the iframe fits it, and gives
/// the page `sendPrompt(text)` (a message to the chat) and `openLink(url)`; plain http(s) links
/// go through `openLink` too, since the sandbox can't navigate or open windows. Both only post
/// right after a click or key press; the page's own code could post anyway, so the app checks
/// again that the user is in the visual (`src/lib/visualBridge.ts`).
const BRIDGE: &str = r#"<script>(function(){function post(m){m.source='nyxs-mockup';parent.postMessage(m,'*');}function byUser(){return !navigator.userActivation||navigator.userActivation.isActive;}window.sendPrompt=function(t){if(byUser())post({type:'prompt',text:String(t)});};window.openLink=function(u){if(byUser())post({type:'link',url:String(u)});};document.addEventListener('click',function(e){if(window.__nyxsPicking)return;var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;var h=a.href;if(/^https?:/i.test(h)){e.preventDefault();window.openLink(h);}},true);var last=0;function send(){var d=document.documentElement,b=document.body;var h=Math.max(d.scrollHeight,b?b.scrollHeight:0);if(h!==last){last=h;post({type:'height',height:h});}}if(window.ResizeObserver){new ResizeObserver(send).observe(document.documentElement);}window.addEventListener('load',send);document.addEventListener('DOMContentLoaded',send);setTimeout(send,50);setTimeout(send,600);})();</script>"#;

struct Mockup {
    /// What the iframe gets: the theme and the bridge first, then the page.
    page: String,
}

#[derive(Default)]
struct Store {
    pages: HashMap<String, Mockup>,
    order: VecDeque<String>,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

/// The same HTML under the same theme always gets the same id, so a chat shown again reuses it.
fn mockup_id(html: &str, theme_css: &str) -> String {
    let mut h = DefaultHasher::new();
    html.hash(&mut h);
    theme_css.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// A bare fragment (no `<html>`/`<body>`) is wrapped in a minimal page.
fn as_page(html: &str) -> String {
    let lower = html.trim_start().to_ascii_lowercase();
    if lower.starts_with("<!doctype") || lower.starts_with("<html") {
        html.to_string()
    } else {
        format!("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body>{html}</body></html>")
    }
}

/// Right after the opening tag named `tag`, if the page has one.
fn after_open_tag(page: &str, tag: &str) -> Option<usize> {
    let lower = page.to_ascii_lowercase();
    let open = format!("<{tag}");
    lower
        .match_indices(&open)
        .find(|(i, _)| {
            matches!(
                lower.as_bytes().get(i + open.len()),
                Some(b'>' | b' ' | b'\t' | b'\n' | b'\r')
            )
        })
        .and_then(|(i, _)| lower[i..].find('>').map(|end| i + end + 1))
}

/// The theme goes before the page's own styles, so anything the page sets wins, and the bridge
/// before its scripts.
fn with_theme(page: &str, theme_css: &str) -> String {
    let style = if theme_css.trim().is_empty() {
        String::new()
    } else {
        format!(
            "<style id=\"nyxs-theme\">{}</style>",
            theme_css.replace("</style", "<\\/style")
        )
    };
    let style = format!("{style}{BRIDGE}");
    match after_open_tag(page, "head").or_else(|| after_open_tag(page, "html")) {
        Some(at) => format!("{}{}{}", &page[..at], style, &page[at..]),
        None => format!("{style}{page}"),
    }
}

pub(crate) fn put_mockup(html: &str, theme_css: &str) -> Result<String, String> {
    if html.len() > MAX_MOCKUP_BYTES || theme_css.len() > MAX_THEME_BYTES {
        return Err("The preview is too large.".into());
    }
    let id = mockup_id(html, theme_css);
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    if !s.pages.contains_key(&id) {
        let page = with_theme(&as_page(html), theme_css);
        s.pages.insert(id.clone(), Mockup { page });
        s.order.push_back(id.clone());
        while s.order.len() > MAX_MOCKUPS {
            if let Some(old) = s.order.pop_front() {
                s.pages.remove(&old);
            }
        }
    }
    Ok(id)
}

/// A stored page with what the canvas needs: the agent bridge (it has the drawing layer and
/// describes picked elements) right after our own, and the picker at the end, like a preview page.
fn canvas_page(page: &str) -> String {
    let script = format!(
        "{BRIDGE}<script>{}</script>",
        super::preview::PREVIEW_AGENT_JS
    );
    let mut out = page.replacen(BRIDGE, &script, 1);
    let picker = super::preview::PREVIEW_PICKER_JS;
    match out.rfind("</body>") {
        Some(at) => out.insert_str(at, picker),
        None => out.push_str(picker),
    }
    out
}

/// The page for `/__nyxs/mockup/<id>` or `/__nyxs/mockup/<id>/canvas`, if that's the path asked
/// for and the page is known.
pub(crate) fn mockup_page(path: &str) -> Option<Option<String>> {
    let rest = path.strip_prefix(MOCKUP_PATH)?.trim_end_matches('/');
    let (id, canvas) = match rest.strip_suffix(CANVAS_SUFFIX) {
        Some(id) => (id, true),
        None => (rest, false),
    };
    Some(
        store()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pages
            .get(id)
            .map(|m| {
                if canvas {
                    canvas_page(&m.page)
                } else {
                    m.page.clone()
                }
            }),
    )
}

#[tauri::command]
pub fn preview_mockup_put(html: String, theme_css: Option<String>) -> Result<String, String> {
    put_mockup(&html, theme_css.as_deref().unwrap_or(""))
}

/// Saves a mockup as a standalone page, with the theme it was shown in, where the user chose.
#[tauri::command]
pub fn preview_mockup_save(id: String, path: String) -> Result<(), String> {
    let page = {
        let s = store().lock().unwrap_or_else(|e| e.into_inner());
        let m = s
            .pages
            .get(&id)
            .ok_or("That preview is no longer available.")?;
        m.page.replace(BRIDGE, "")
    };
    std::fs::write(&path, page).map_err(|e| format!("Couldn't save {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page_of(id: &str) -> String {
        mockup_page(&format!("{MOCKUP_PATH}{id}")).unwrap().unwrap()
    }

    #[test]
    fn serves_a_stored_mockup_with_the_bridge_first() {
        let id = put_mockup("<div class=\"card\">Hola</div>", "").unwrap();
        let page = page_of(&id);
        assert!(page.starts_with("<!doctype html>"));
        assert!(page.contains("<div class=\"card\">Hola</div>"));
        let bridge = page.find("sendPrompt").unwrap();
        assert!(bridge < page.find("<body>").unwrap());
    }

    #[test]
    fn puts_the_theme_before_the_page_styles() {
        let html = "<!DOCTYPE html><html><head><style>body{color:red}</style></head><body><p>a</p></body></html>";
        let id = put_mockup(html, ":root{--nyxs-text:#111}").unwrap();
        let page = page_of(&id);
        let theme = page.find("--nyxs-text:#111").unwrap();
        assert!(theme > page.find("<head>").unwrap());
        assert!(theme < page.find("body{color:red}").unwrap());
        assert_eq!(put_mockup(html, ":root{--nyxs-text:#111}").unwrap(), id);
        assert_ne!(put_mockup(html, ":root{--nyxs-text:#eee}").unwrap(), id);
    }

    #[test]
    fn theme_text_cannot_close_its_style_tag() {
        let id = put_mockup("<p>x</p>", "a{}</style><script>alert(1)</script>").unwrap();
        assert!(!page_of(&id).contains("</style><script>alert(1)"));
    }

    #[test]
    fn other_paths_and_unknown_ids_are_not_mockups() {
        assert!(mockup_page("/index.html").is_none());
        assert_eq!(mockup_page(&format!("{MOCKUP_PATH}0000")), Some(None));
        assert_eq!(
            mockup_page(&format!("{MOCKUP_PATH}0000{CANVAS_SUFFIX}")),
            Some(None)
        );
    }

    #[test]
    fn only_the_canvas_page_gets_the_picker_and_the_drawing_layer() {
        let id = put_mockup("<p>lienzo</p>", "").unwrap();
        let chat = page_of(&id);
        assert!(!chat.contains("nyxs-pick-start"));
        assert!(!chat.contains("__nyxsDescribe"));

        let canvas = page_of(&format!("{id}{CANVAS_SUFFIX}"));
        assert!(canvas.contains("<p>lienzo</p>"));
        // The drawing layer loads before the page's scripts, the picker after its content.
        assert!(canvas.find("__nyxsDescribe").unwrap() < canvas.find("<body>").unwrap());
        assert!(canvas.find("nyxs-pick-start").unwrap() > canvas.find("<p>lienzo</p>").unwrap());
    }

    #[test]
    fn saving_leaves_out_the_canvas_tools() {
        let id = put_mockup("<p>guardar</p>", "").unwrap();
        let dir = std::env::temp_dir().join(format!("nyxs-mockup-save-{id}.html"));
        preview_mockup_save(id, dir.to_string_lossy().into_owned()).unwrap();
        let saved = std::fs::read_to_string(&dir).unwrap();
        let _ = std::fs::remove_file(&dir);
        assert!(saved.contains("<p>guardar</p>"));
        assert!(!saved.contains("sendPrompt"));
        assert!(!saved.contains("nyxs-pick-start"));
    }

    #[test]
    fn refuses_huge_pages() {
        assert!(put_mockup(&"x".repeat(MAX_MOCKUP_BYTES + 1), "").is_err());
    }
}
