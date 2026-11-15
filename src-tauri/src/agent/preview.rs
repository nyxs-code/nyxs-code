use super::*;
use crate::error::CmdError;

#[tauri::command]
pub fn agent_open_external(url: String) -> Result<(), CmdError> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(CmdError::only_http_urls());
    }
    let res = if cfg!(target_os = "windows") {
        Command::new("rundll32").args(["url,OpenURL", &url]).spawn()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(&url).spawn()
    } else {
        Command::new("xdg-open").arg(&url).spawn()
    };
    res.map(|_| ()).map_err(CmdError::browser_open_failed)
}

#[tauri::command]
pub fn agent_open_path(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("The path is empty.".into());
    }
    if crate::remote::is_remote(&path) {
        return Err(
            "This file is on another machine: open it with the editor (Open in VS Code).".into(),
        );
    }
    if runs_when_opened(&path) {
        return Err(
            "Nyxs doesn't open programs or scripts: reveal it in the folder instead.".into(),
        );
    }
    let res = if cfg!(target_os = "windows") {
        let win_path = path.replace('/', "\\");
        Command::new("explorer").arg(&win_path).spawn()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(&path).spawn()
    } else {
        Command::new("xdg-open").arg(&path).spawn()
    };
    res.map(|_| ())
        .map_err(|e| format!("Couldn't open the path: {e}"))
}

/// Files the system would run instead of showing. A path in a reply opens with one click, and the
/// model (or a page it read) chooses that path. A folder only runs as a macOS `.app` bundle: a
/// project folder named `chart.js` still opens.
fn runs_when_opened(path: &str) -> bool {
    const RUNNABLE: &[&str] = &[
        "exe", "com", "scr", "pif", "msi", "msp", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js",
        "jse", "wsf", "wsh", "hta", "cpl", "lnk", "url", "reg", "jar", "app", "command", "tool",
        "pkg", "sh", "desktop", "appimage",
    ];
    let p = std::path::Path::new(path.trim_end_matches(['/', '\\']));
    let Some(ext) = p
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
    else {
        return false;
    };
    if p.is_dir() {
        return ext == "app";
    }
    RUNNABLE.contains(&ext.as_str())
}

/// Shows a file selected in the system's file manager (Explorer, Finder), or opens its folder
/// where selecting isn't possible.
#[tauri::command]
pub fn agent_reveal_path(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("The path is empty.".into());
    }
    if crate::remote::is_remote(&path) {
        return Err(
            "This file is on another machine: open it with the editor (Open in VS Code).".into(),
        );
    }
    let res = if cfg!(target_os = "windows") {
        // One argument "/select,<path>": Explorer reads it whole, quotes and all.
        let mut cmd = Command::new("explorer");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.raw_arg(format!("/select,\"{}\"", path.replace('/', "\\")));
        }
        cmd.spawn()
    } else if cfg!(target_os = "macos") {
        Command::new("open").args(["-R", &path]).spawn()
    } else {
        let dir = Path::new(&path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        Command::new("xdg-open").arg(dir).spawn()
    };
    res.map(|_| ())
        .map_err(|e| format!("Couldn't show the file: {e}"))
}

/// Code editors a file in the chat can be opened in: `id` for agent_open_in_editor, and its name.
#[derive(Serialize)]
pub struct Editor {
    id: &'static str,
    name: &'static str,
}

const EDITORS: [(&str, &str); 3] = [("vscode", "VS Code"), ("cursor", "Cursor"), ("zed", "Zed")];

/// Where an editor is installed, when it is.
fn editor_exe(id: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let programs = std::env::var_os("ProgramFiles").map(PathBuf::from);
        let candidates: Vec<PathBuf> = match id {
            "vscode" => [
                local
                    .as_ref()
                    .map(|l| l.join(r"Programs\Microsoft VS Code\Code.exe")),
                programs
                    .as_ref()
                    .map(|p| p.join(r"Microsoft VS Code\Code.exe")),
            ]
            .into_iter()
            .flatten()
            .collect(),
            "cursor" => [local
                .as_ref()
                .map(|l| l.join(r"Programs\cursor\Cursor.exe"))]
            .into_iter()
            .flatten()
            .collect(),
            "zed" => [
                local.as_ref().map(|l| l.join(r"Programs\Zed\Zed.exe")),
                programs.as_ref().map(|p| p.join(r"Zed\Zed.exe")),
            ]
            .into_iter()
            .flatten()
            .collect(),
            _ => Vec::new(),
        };
        candidates.into_iter().find(|p| p.is_file())
    }
    #[cfg(not(windows))]
    {
        let bin = match id {
            "vscode" => "code",
            "cursor" => "cursor",
            "zed" => "zed",
            _ => return None,
        };
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|d| d.join(bin))
                .find(|p| p.is_file())
        })
    }
}

/// The editors installed on this machine, for the menu of a file path in the chat.
#[tauri::command(async)]
pub fn agent_editors() -> Vec<Editor> {
    EDITORS
        .iter()
        .filter(|(id, _)| editor_exe(id).is_some())
        .map(|&(id, name)| Editor { id, name })
        .collect()
}

/// Opens a file in a code editor, at `line` when given.
#[tauri::command]
pub fn agent_open_in_editor(editor: String, path: String, line: Option<u32>) -> Result<(), String> {
    let exe = editor_exe(&editor).ok_or_else(|| format!("{editor} isn't installed."))?;
    // A remote file opens in the editor's own SSH remote (VS Code / Cursor Remote-SSH).
    if let Some(r) = crate::remote::parse(&path) {
        if editor == "zed" {
            return Err("Zed can't open files on another machine from here.".into());
        }
        let target = match line {
            Some(l) if l > 0 => format!("{}:{l}", r.path),
            _ => r.path.clone(),
        };
        return Command::new(exe)
            .arg("--remote")
            .arg(format!("ssh-remote+{}", r.host))
            .arg("-g")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Couldn't open {editor}: {e}"));
    }
    let target = match line {
        Some(l) if l > 0 => format!("{path}:{l}"),
        _ => path,
    };
    let mut cmd = Command::new(exe);
    // VS Code and Cursor only read ":line" after -g; Zed reads it as is.
    if editor != "zed" {
        cmd.arg("-g");
    }
    cmd.arg(target);
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open {editor}: {e}"))
}

pub(super) const PREVIEW_PICKER_JS: &str = r#"<script>(function(){
  var hl,last;
  function sel(el){var t=el.tagName.toLowerCase();var id=el.id?'#'+el.id:'';var c=(typeof el.className==='string'&&el.className.trim())?'.'+el.className.trim().split(/\s+/).slice(0,3).join('.'):'';return t+id+c;}
  function path(el){var p=[],c=el;while(c&&c.tagName&&c.tagName.toLowerCase()!=='body'&&p.length<6){p.unshift(sel(c));c=c.parentElement;}return p.join(' > ');}
  function ids(){return window.__nyxsPickIds||(window.__nyxsPickIds={n:0,doc:Date.now().toString(36)+Math.random().toString(36).slice(2,6),map:typeof WeakMap==='function'?new WeakMap():null});}
  function uid(el){var m=ids();if(!m.map)return '';var k=m.map.get(el);if(!k){k=m.doc+'-'+(++m.n);m.map.set(el,k);}return k;}
  function box(){if(hl)return;hl=document.createElement('div');hl.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;background:rgba(42,120,214,.18);outline:2px solid #2a78d6;border-radius:2px;';document.body.appendChild(hl);}
  function move(e){var t=e.target;if(!t||t===hl)return;last=t;var r=t.getBoundingClientRect();box();hl.style.left=r.left+'px';hl.style.top=r.top+'px';hl.style.width=r.width+'px';hl.style.height=r.height+'px';}
  function click(e){e.preventDefault();e.stopPropagation();var el=last||e.target;if(el){var d;if(window.__nyxsDescribe){d=window.__nyxsDescribe(el);}else{var text=(el.textContent||'').replace(/\s+/g,' ').trim().slice(0,140);var html=el.outerHTML.replace(/\s+/g,' ').trim();if(html.length>700)html=html.slice(0,700)+'\u2026';d={selector:sel(el),uid:uid(el),path:path(el),text:text,html:html};}d.source='nyxs-pick';parent.postMessage(d,'*');}stop();}
  function start(){window.__nyxsPicking=true;document.addEventListener('mousemove',move,true);document.addEventListener('click',click,true);if(document.body)document.body.style.cursor='crosshair';}
  function stop(){window.__nyxsPicking=false;document.removeEventListener('mousemove',move,true);document.removeEventListener('click',click,true);if(hl){hl.remove();hl=null;}if(document.body)document.body.style.cursor='';}
  window.addEventListener('message',function(e){if(!e.data)return;if(e.data.type==='nyxs-pick-start')start();else if(e.data.type==='nyxs-pick-stop')stop();});
})();</script>"#;

/// What a preview site serves: a folder of HTML files. Dev servers open at their real origin in
/// the browser's own webview instead.
#[derive(Clone, Debug, PartialEq)]
enum Site {
    Root(PathBuf),
    /// A folder of a remote project (`ssh://host/path`), read through the machine's helper.
    RemoteRoot(String),
}

/// Every site, by the port of its address. Each site gets its own port on the preview host
/// (`nyxspreview.localhost:<port>`), so a tab in the background keeps reaching its own folder
/// whatever the tab in front opens. A port and not a path prefix, because pages ask for
/// `/assets/x.js` from the root; and not a subdomain, because WebView2 only hands Tauri the
/// addresses that start with `nyxspreview.`, and the CSP's `frame-src` can name
/// `nyxspreview.localhost:*` but not `nyxspreview.*.localhost`. Storage is per port; cookies
/// ignore the port, so the agent bridge (`preview_agent.js`) puts it in the names of the ones
/// a page sets.
#[derive(Default)]
struct Sites {
    /// The sites opened this run, which the proxy serves.
    by_port: HashMap<u16, Site>,
    /// What every port ever given out stands for (see `site_key`), this run's and earlier
    /// ones', kept in `file` so a site keeps its port and "Clear browsing data" reaches them all.
    keys: HashMap<u16, String>,
    file: Option<PathBuf>,
}

fn sites() -> std::sync::MutexGuard<'static, Sites> {
    static SITES: OnceLock<Mutex<Sites>> = OnceLock::new();
    SITES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Where the ports given to sites are kept: the app's data folder, next to the websites'
/// cookie profiles, since they all name storage in the app's own webview (not a project's).
fn sites_file(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("preview-sites.json"))
}

/// Reads the kept ports the first time; a missing or broken file is no ports yet.
fn load_sites(sites: &mut Sites, file: Option<PathBuf>) {
    if sites.file.is_some() {
        return;
    }
    let Some(file) = file else { return };
    if let Some(kept) = fs::read_to_string(&file)
        .ok()
        .and_then(|raw| serde_json::from_str::<HashMap<u16, String>>(&raw).ok())
    {
        for (port, key) in kept {
            sites.keys.entry(port).or_insert(key);
        }
    }
    sites.file = Some(file);
}

fn save_sites(sites: &Sites) {
    let Some(file) = &sites.file else { return };
    if let Ok(raw) = serde_json::to_string(&sites.keys) {
        let _ = fs::write(file, raw);
    }
}

/// Ports for sites: above every port Chromium refuses to load (the highest is 10080).
const SITE_PORTS: std::ops::Range<u64> = 20000..60000;

/// What a site's port stands for: what it serves and the cookie profile it was opened with
/// (the browser's "Keep cookies" setting, as for websites), so each profile keeps its own
/// storage. "private" gets a new port every run, so nothing it stored is there next time.
fn site_key(site: &Site, profile: Option<&str>) -> String {
    let profile: String = profile
        .unwrap_or("shared")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect();
    let profile = if profile == "private" {
        static RUN: OnceLock<u128> = OnceLock::new();
        let run = RUN.get_or_init(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        });
        format!("private-{run:x}")
    } else if profile.is_empty() {
        "shared".to_string()
    } else {
        profile
    };
    match site {
        Site::Root(p) => format!("{profile}|root:{}", p.display()),
        Site::RemoteRoot(uri) => format!("{profile}|root:{uri}"),
    }
}

/// The port of the site, the same one every run (a hash of its key), so its storage is still
/// there next time. A port already given to another site moves it to the next free one.
fn site_port(sites: &mut Sites, site: Site, key: String) -> u16 {
    // FNV-1a: stable across runs and Rust versions, unlike the std hasher.
    let mut h = key.bytes().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
    });
    loop {
        let port = (SITE_PORTS.start + h % (SITE_PORTS.end - SITE_PORTS.start)) as u16;
        match sites.keys.get(&port) {
            Some(other) if *other != key => h = h.wrapping_add(1),
            known => {
                let new = known.is_none();
                sites.keys.insert(port, key);
                sites.by_port.insert(port, site);
                if new {
                    save_sites(sites);
                }
                return port;
            }
        }
    }
}

/// Opens the site (see `site_port`) and gives its origin to load pages from.
fn open_site(app: &AppHandle, site: Site, profile: Option<&str>) -> String {
    let key = site_key(&site, profile);
    let mut sites = sites();
    load_sites(&mut sites, sites_file(app));
    let port = site_port(&mut sites, site, key);
    site_base(Some(port)).trim_end_matches('/').to_string()
}

/// The address of the site on `port` (the port-less one for `None`), with a trailing slash.
fn site_base(port: Option<u16>) -> String {
    match port {
        Some(p) => format!("{}:{p}/", preview_origin()),
        None => PREVIEW_BASE.to_string(),
    }
}

/// Where a project's preview settings (the server command it ran and its address) are kept:
/// with the project's other state, not in the project (see `project_paths`).
fn preview_config_file(workspace: &str) -> Option<String> {
    crate::project_paths::project_feature_dir_str(workspace, "preview")
        .map(|dir| super::vfs::join(&dir, "preview.json"))
}

/// The preview settings of a project, or None when there are none yet. The ones an earlier
/// version wrote inside the project (`.nyxs/preview.json`) move out on the way.
#[tauri::command(async)]
pub fn agent_preview_config_read(workspace: String) -> Option<String> {
    let file = preview_config_file(&workspace)?;
    if let Ok(text) = super::vfs::read_to_string(&file) {
        return Some(text);
    }
    let legacy = super::vfs::join(&super::vfs::join(&workspace, ".nyxs"), "preview.json");
    let text = super::vfs::read_to_string(&legacy).ok()?;
    if agent_preview_config_write(workspace, text.clone()).is_ok() {
        let _ = super::vfs::remove_file(&legacy);
    }
    Some(text)
}

#[tauri::command(async)]
pub fn agent_preview_config_write(workspace: String, content: String) -> Result<(), String> {
    let file =
        preview_config_file(&workspace).ok_or_else(|| format!("No data folder for {workspace}"))?;
    // A remote write makes its own folders on the machine.
    if !crate::remote::is_remote(&file) {
        if let Some(dir) = Path::new(&file).parent() {
            fs::create_dir_all(dir)
                .map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
        }
    }
    super::vfs::write_atomic(&file, content.as_bytes())
        .map_err(|e| format!("Couldn't write {file}: {e}"))
}

/// The origins of the port-less preview address and of every site ever opened, so "Clear
/// browsing data" reaches the storage of each.
#[tauri::command]
pub fn agent_preview_sites(app: AppHandle) -> Vec<String> {
    let mut sites = sites();
    load_sites(&mut sites, sites_file(&app));
    let mut ports: Vec<u16> = sites.keys.keys().copied().collect();
    ports.sort_unstable();
    std::iter::once(None)
        .chain(ports.into_iter().map(Some))
        .map(|p| site_base(p).trim_end_matches('/').to_string())
        .collect()
}

/// After "Clear browsing data": the sites not open this run have nothing stored anymore, so
/// their ports are forgotten (one opened again gets its port back from its hash).
#[tauri::command]
pub fn agent_forget_preview_sites(app: AppHandle) {
    let mut sites = sites();
    load_sites(&mut sites, sites_file(&app));
    forget_closed_sites(&mut sites);
}

fn forget_closed_sites(sites: &mut Sites) {
    let open: Vec<u16> = sites.by_port.keys().copied().collect();
    sites.keys.retain(|port, _| open.contains(port));
    save_sites(sites);
}

/// Serves the files of the folder `root` with the cookie profile `profile`; returns the site's
/// origin to load them from. Async: a remote folder is checked on its machine.
#[tauri::command(async)]
pub fn agent_set_preview_root(
    app: AppHandle,
    root: String,
    profile: Option<String>,
) -> Result<String, String> {
    confine(&root, None)?;
    // A remote project's folder: its files are read through the machine's helper.
    if crate::remote::is_remote(&root) {
        let real = super::scope::remote_real_path(&root)?;
        if !super::vfs::is_dir(&real) {
            return Err(format!("{root} isn't a folder."));
        }
        return Ok(open_site(&app, Site::RemoteRoot(real), profile.as_deref()));
    }
    let canon = fs::canonicalize(&root).map_err(|e| format!("Couldn't open {root}: {e}"))?;
    if !canon.is_dir() {
        return Err(format!("{root} isn't a folder."));
    }
    Ok(open_site(&app, Site::Root(canon), profile.as_deref()))
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn preview_mime(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        "txt" | "md" | "csv" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        _ => "application/octet-stream",
    }
}

/// The file at `url_path` in the folder `root`. Each folder is served at its own site's root,
/// so the page's relative addresses and `#anchors` resolve against it without a `<base>`.
pub(crate) fn serve_preview_file(root: &Path, url_path: &str) -> (u16, String, Vec<u8>) {
    let not_found = |what: &str| {
        (
            404,
            "text/plain; charset=utf-8".to_string(),
            format!("Not found: {what}").into_bytes(),
        )
    };
    let decoded = percent_decode(url_path);
    let rel = decoded.trim_start_matches(['/', '\\']);
    let rel = if rel.is_empty() { "index.html" } else { rel };
    if rel.split(['/', '\\']).any(|seg| seg == "..")
        || Path::new(rel).is_absolute()
        || rel.contains(':')
    {
        return (
            403,
            "text/plain; charset=utf-8".to_string(),
            b"Path not allowed".to_vec(),
        );
    }
    let mut target = root.join(rel);
    if target.is_dir() {
        target = target.join("index.html");
    }
    let Ok(canon) = fs::canonicalize(&target) else {
        return not_found(rel);
    };
    if !canon.starts_with(root) {
        return (
            403,
            "text/plain; charset=utf-8".to_string(),
            b"Path outside the preview".to_vec(),
        );
    }
    let Ok(bytes) = fs::read(&canon) else {
        return not_found(rel);
    };
    let mime = preview_mime(&canon);
    if mime.starts_with("text/html") {
        let (html, ct) = inject_preview(&bytes);
        return (200, ct, html);
    }
    (200, mime.to_string(), bytes)
}

/// A file of a remote project's folder (`root`, already resolved), read through the machine's
/// helper, under the same rules as `serve_preview_file`: nothing above the folder, through `..`
/// or a symlink. `real` resolves a path on the machine; the reads are passed in for the tests.
pub(crate) fn serve_remote_preview_file(
    root: &str,
    url_path: &str,
    real: &dyn Fn(&str) -> Result<String, String>,
) -> (u16, String, Vec<u8>) {
    serve_remote_preview_with(root, url_path, real, &super::vfs::read, &super::vfs::is_dir)
}

fn serve_remote_preview_with(
    root: &str,
    url_path: &str,
    real: &dyn Fn(&str) -> Result<String, String>,
    read: &dyn Fn(&str) -> std::io::Result<Vec<u8>>,
    is_dir: &dyn Fn(&str) -> bool,
) -> (u16, String, Vec<u8>) {
    let text = |status: u16, msg: String| {
        (
            status,
            "text/plain; charset=utf-8".to_string(),
            msg.into_bytes(),
        )
    };
    let decoded = percent_decode(url_path);
    let rel = decoded.trim_start_matches(['/', '\\']);
    let rel = if rel.is_empty() { "index.html" } else { rel };
    if rel.split(['/', '\\']).any(|seg| seg == "..") || rel.contains(':') {
        return text(403, "Path not allowed".into());
    }
    let Some(root_path) = crate::remote::parse(root) else {
        return text(404, format!("Not found: {rel}"));
    };
    let mut target = format!("{}/{}", root.trim_end_matches('/'), rel.replace('\\', "/"));
    // A folder's address serves its index.html: tried only when reading the path fails.
    for first in [true, false] {
        let Ok(resolved) = real(&target) else {
            return text(404, format!("Not found: {rel}"));
        };
        if !crate::remote::parse(&resolved).is_some_and(|p| p.is_within(&root_path)) {
            return text(403, "Path outside the preview".into());
        }
        match read(&resolved) {
            Ok(bytes) => {
                let mime = preview_mime(Path::new(&resolved));
                if mime.starts_with("text/html") {
                    let (html, ct) = inject_preview(&bytes);
                    return (200, ct, html);
                }
                return (200, mime.to_string(), bytes);
            }
            Err(_) if first && is_dir(&resolved) => target = format!("{resolved}/index.html"),
            Err(_) => break,
        }
    }
    text(404, format!("Not found: {rel}"))
}

/// The preview's own address: Tauri serves custom protocols as http://<scheme>.localhost on
/// Windows and Android, and as <scheme>://localhost on macOS and Linux.
#[cfg(any(windows, target_os = "android"))]
const PREVIEW_BASE: &str = "http://nyxspreview.localhost/";
#[cfg(not(any(windows, target_os = "android")))]
const PREVIEW_BASE: &str = "nyxspreview://localhost/";

/// Lets the agent read and drive the page (see the file), and records its console from the start.
pub(super) const PREVIEW_AGENT_JS: &str = include_str!("preview_agent.js");

/// Where the opening tag `<name …>` of `lower` (a page in ASCII lowercase) ends, just past its
/// `>`. `<header>` is not `<head>`.
fn after_open_tag(lower: &[u8], name: &[u8]) -> Option<usize> {
    let mut from = 0;
    while let Some(i) = find_bytes(&lower[from..], name).map(|i| from + i) {
        if i > 0
            && lower[i - 1] == b'<'
            && matches!(
                lower.get(i + name.len()),
                Some(b'>' | b' ' | b'\t' | b'\n' | b'\r')
            )
        {
            return find_bytes(&lower[i..], b">").map(|end| i + end + 1);
        }
        from = i + 1;
    }
    None
}

fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Adds the agent bridge and the element picker to an HTML page, and the content type to serve
/// it with. The bridge goes right after `<head>` so it sees the console output of every script
/// that follows; without one after `<html>`, or after the doctype, never before it (that puts
/// the page in quirks mode). The page's bytes are kept as they are (both scripts are ASCII), so
/// a page in Latin-1 or Shift_JIS still reads in its own encoding: only UTF-8 is declared in
/// the header, and a page that isn't UTF-8 is left to its `<meta charset>`. UTF-16 (with a BOM)
/// can't take ASCII bytes, so it's turned into UTF-8.
fn inject_preview(page: &[u8]) -> (Vec<u8>, String) {
    let utf16 = page.starts_with(b"\xFF\xFE") || page.starts_with(b"\xFE\xFF");
    let converted;
    let page = if utf16 {
        converted = super::text_io::decode_for_read(page)
            .map(|d| d.text)
            .unwrap_or_default()
            .into_bytes();
        &converted[..]
    } else {
        page
    };
    let lower = page.to_ascii_lowercase();
    let bridge_at = after_open_tag(&lower, b"head")
        .or_else(|| after_open_tag(&lower, b"html"))
        .or_else(|| after_open_tag(&lower, b"!doctype"))
        .unwrap_or(0);
    let picker_at = lower
        .windows(7)
        .rposition(|w| w == b"</body>")
        .filter(|&at| at >= bridge_at)
        .unwrap_or(page.len());
    let bridge = format!("<script>{PREVIEW_AGENT_JS}</script>");
    let mut out = Vec::with_capacity(page.len() + bridge.len() + PREVIEW_PICKER_JS.len());
    out.extend_from_slice(&page[..bridge_at]);
    out.extend_from_slice(bridge.as_bytes());
    out.extend_from_slice(&page[bridge_at..picker_at]);
    out.extend_from_slice(PREVIEW_PICKER_JS.as_bytes());
    out.extend_from_slice(&page[picker_at..]);
    let ct = if utf16 || std::str::from_utf8(page).is_ok() {
        "text/html; charset=utf-8"
    } else {
        "text/html"
    };
    (out, ct.to_string())
}

type PreviewResponse = tauri::http::Response<std::borrow::Cow<'static, [u8]>>;

/// No `Access-Control-Allow-Origin`: only a page of the same site may read what its site serves.
fn plain_response(status: u16, ct: &str, body: Vec<u8>) -> PreviewResponse {
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", ct)
        .body(std::borrow::Cow::Owned(body))
        .unwrap()
}

/// The preview's origin, without the trailing slash: what the page sends as `Origin`.
fn preview_origin() -> &'static str {
    PREVIEW_BASE.trim_end_matches('/')
}

/// Whether a request of the preview protocol may be answered. The protocol reads a project's
/// files, so it answers the app's own window only (the browser's webviews show any website), and
/// within it only a page's own site or a frame being loaded: never another site's page, nor a
/// visual of the chat fetching or embedding a project's files.
fn request_allowed(webview: &str, request: &tauri::http::Request<Vec<u8>>) -> bool {
    if webview != crate::MAIN_LABEL {
        return false;
    }
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.trim().to_ascii_lowercase())
    };
    // Loading a frame (or the page's own forms and links): whoever starts it can't read a
    // document from another origin.
    if header("sec-fetch-mode").as_deref() == Some("navigate") {
        return true;
    }
    let site = header("sec-fetch-site");
    if site
        .as_deref()
        .is_some_and(|s| s != "same-origin" && s != "none")
    {
        return false;
    }
    let own = {
        let uri = request.uri();
        let scheme = uri.scheme_str().unwrap_or_default();
        let authority = uri.authority().map(|a| a.as_str()).unwrap_or_default();
        format!("{scheme}://{authority}").to_ascii_lowercase()
    };
    match header("origin").as_deref() {
        None => true,
        // WebKit sends `null` for a custom scheme's own pages, and no fetch metadata to tell them
        // apart; Chromium sends both, so a `null` there was already checked above.
        Some("null") => site.is_none() || site.as_deref() == Some("same-origin"),
        Some(origin) => origin == own,
    }
}

/// Answers a request of the preview protocol made in the webview `webview`.
pub async fn proxy_preview(
    webview: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> PreviewResponse {
    use std::borrow::Cow;
    let make = plain_response;
    if !request_allowed(webview, &request) {
        return make(403, "text/plain; charset=utf-8", b"Not allowed".to_vec());
    }
    let path = request.uri().path().to_string();

    // "Clear browsing data" for the local pages: they all live under this one origin.
    if path == "/__nyxs/clear-site-data" {
        return tauri::http::Response::builder()
            .status(200)
            .header("content-type", "text/html; charset=utf-8")
            .header("clear-site-data", "\"cache\", \"cookies\", \"storage\"")
            .body(Cow::Owned(b"<!doctype html><title>ok</title>".to_vec()))
            .unwrap();
    }

    if let Some(page) = super::mockup::mockup_page(&path) {
        return match page {
            Some(html) => make(200, "text/html; charset=utf-8", html.into_bytes()),
            None => make(
                404,
                "text/plain; charset=utf-8",
                b"Preview not found".to_vec(),
            ),
        };
    }

    // The site is the one on the page's port, so a tab in the background still reaches its own.
    // The port-less address serves no folder: any page could guess it.
    let port = request.uri().port_u16();
    let site = port.and_then(|p| sites().by_port.get(&p).cloned());
    match site {
        Some(Site::Root(root)) => {
            let (status, ct, body) = serve_preview_file(&root, &path);
            make(status, &ct, body)
        }
        // Reading on the machine waits for the network: off the proxy's own thread.
        Some(Site::RemoteRoot(root)) => {
            let served = tauri::async_runtime::spawn_blocking(move || {
                serve_remote_preview_file(&root, &path, &super::scope::remote_real_path)
            })
            .await;
            match served {
                Ok((status, ct, body)) => make(status, &ct, body),
                Err(e) => make(502, "text/plain; charset=utf-8", e.to_string().into_bytes()),
            }
        }
        // A port from an earlier run: its tab opens the page again, which brings the site back.
        None => make(
            503,
            "text/plain; charset=utf-8",
            b"no preview target set".to_vec(),
        ),
    }
}

#[tauri::command]
pub async fn agent_fetch_html(url: String) -> Result<String, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http(s) URLs are allowed.".into());
    }
    // A server that accepts the connection and never answers would otherwise hang the call.
    // Certificates are checked: this fetches plugin catalogs and skills, which then run.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml,*/*")
        .send()
        .await
        .map_err(|e| format!("Couldn't connect to {url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{url} returned HTTP {}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn programs_are_never_opened_but_folders_named_like_them_are() {
        assert!(runs_when_opened(r"C:\Users\a\Downloads\setup.EXE"));
        assert!(runs_when_opened("/tmp/x/run.sh"));
        assert!(!runs_when_opened(r"C:\Users\a\notes.md"));
        assert!(!runs_when_opened("/tmp/x/README"));
        let dir = temp_root("open-dir").join("chart.js");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!runs_when_opened(&dir.to_string_lossy()));
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nyxs-preview-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(dir.join("css")).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn serves_local_files_with_the_picker_injected_into_html() {
        let root = temp_root("serve");
        fs::write(
            root.join("index.html"),
            "<html><head></head><body><script>run()</script></body></html>",
        )
        .unwrap();
        fs::write(root.join("css").join("site style.css"), "body{}").unwrap();

        let (status, ct, body) = serve_preview_file(&root, "/");
        assert_eq!(status, 200);
        assert!(ct.starts_with("text/html"));
        let html = String::from_utf8(body).unwrap();
        assert!(html.contains("<script>run()</script>"));
        assert!(html.contains("nyxs-pick"));
        assert!(!html.contains("<base"));

        let (status, ct, body) = serve_preview_file(&root, "/css/site%20style.css");
        assert_eq!(
            (status, ct.as_str(), body.as_slice()),
            (200, "text/css; charset=utf-8", b"body{}".as_slice())
        );
        assert_eq!(serve_preview_file(&root, "/missing.js").0, 404);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn agent_bridge_runs_before_the_page_scripts() {
        let (html, _) = injected(
            b"<!doctype html><HTML><Head lang=\"es\"><script>first()</script></head><body></body></html>",
        );
        let bridge = html.find("nyxs-agent-reply").unwrap();
        assert!(html.find("<Head lang=\"es\">").unwrap() < bridge);
        assert!(bridge < html.find("first()").unwrap());
        // `<header>` is not the document head.
        let (html, _) = injected(b"<body><header>x</header></body>");
        assert!(html.find("nyxs-agent-reply").unwrap() < html.find("<header>").unwrap());
    }

    fn injected(html: &[u8]) -> (String, String) {
        let (body, ct) = inject_preview(html);
        (String::from_utf8_lossy(&body).into_owned(), ct)
    }

    #[test]
    fn the_bridge_never_goes_before_the_doctype() {
        let (html, _) = injected(
            b"<!DOCTYPE html>\n<HTML lang=\"es\"><BODY><a href=\"#precios\">x</a></BODY></HTML>",
        );
        assert!(
            html.starts_with("<!DOCTYPE html>\n<HTML lang=\"es\">"),
            "{}",
            &html[..60]
        );
        assert!(html.find("nyxs-agent-reply").unwrap() < html.find("<BODY>").unwrap());
        assert!(html.find("nyxs-pick").unwrap() < html.find("</BODY>").unwrap());
        let (html, _) = injected(b"<!doctype html><p>hola");
        assert!(html.starts_with("<!doctype html><script>"));
        // Anchors and subfolders resolve against the page itself: no <base> moves them.
        assert!(!html.to_ascii_lowercase().contains("<base"));
    }

    #[test]
    fn a_page_keeps_its_encoding() {
        let latin = b"<!doctype html><html><head><meta charset=\"iso-8859-1\"></head><body>caf\xe9</body></html>";
        let (body, ct) = inject_preview(latin);
        assert!(body.windows(4).any(|w| w == b"caf\xe9"));
        assert!(!ct.contains("utf-8"), "{ct}");
        let (_, ct) = inject_preview("<html><body>café</body></html>".as_bytes());
        assert_eq!(ct, "text/html; charset=utf-8");
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain(
                "<html><body>café</body></html>"
                    .encode_utf16()
                    .flat_map(|u| u.to_le_bytes()),
            )
            .collect();
        let (html, ct) = injected(&utf16);
        assert!(html.contains("café") && html.contains("nyxs-agent-reply"));
        assert_eq!(ct, "text/html; charset=utf-8");
    }

    /// A project folder, with its state under the tests' projects root; both removed after.
    struct TestProject(PathBuf);

    impl TestProject {
        fn new(name: &str) -> Self {
            std::env::set_var(
                "NYXS_PROJECTS_ROOT",
                std::env::temp_dir().join("nyxs-test-projects"),
            );
            let dir = std::env::temp_dir()
                .join(format!("nyxs-preview-cfg-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TestProject(dir)
        }
        fn ws(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for TestProject {
        fn drop(&mut self) {
            if let Some(dir) = crate::project_paths::project_data_dir(&self.ws()) {
                let _ = fs::remove_dir_all(dir);
            }
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_preview_config_lives_outside_the_project() {
        let p = TestProject::new("save");
        assert_eq!(agent_preview_config_read(p.ws()), None);
        let cfg = r#"{"command":"npm run dev","url":"http://localhost:5173"}"#;
        agent_preview_config_write(p.ws(), cfg.into()).unwrap();
        assert_eq!(agent_preview_config_read(p.ws()).as_deref(), Some(cfg));
        assert!(!p.0.join(".nyxs").exists());
        let saved = crate::project_paths::project_feature_dir(&p.ws(), "preview").unwrap();
        assert!(saved.join("preview.json").is_file());
    }

    #[test]
    fn an_old_preview_config_moves_out_of_the_project() {
        let p = TestProject::new("migrate");
        fs::create_dir_all(p.0.join(".nyxs")).unwrap();
        fs::write(p.0.join(".nyxs/settings.json"), "{}").unwrap();
        let old = r#"{"command":"vite","url":"http://localhost:5173"}"#;
        fs::write(p.0.join(".nyxs/preview.json"), old).unwrap();
        assert_eq!(agent_preview_config_read(p.ws()).as_deref(), Some(old));
        assert!(!p.0.join(".nyxs/preview.json").exists());
        // The user's own settings next to it stay.
        assert!(p.0.join(".nyxs/settings.json").exists());
        assert_eq!(agent_preview_config_read(p.ws()).as_deref(), Some(old));
    }

    #[test]
    fn the_injected_scripts_are_plain_ascii() {
        // So they read the same in a page of any single-byte encoding.
        assert!(PREVIEW_AGENT_JS.is_ascii());
        assert!(PREVIEW_PICKER_JS.is_ascii());
    }

    #[test]
    fn refuses_to_leave_the_preview_root() {
        let root = temp_root("escape");
        let outside = root.parent().unwrap().join(format!(
            "{}-secret.txt",
            root.file_name().unwrap().to_string_lossy()
        ));
        fs::write(&outside, "secret").unwrap();
        let name = outside.file_name().unwrap().to_string_lossy().to_string();
        for path in [
            format!("/../{name}"),
            format!("/%2e%2e/{name}"),
            format!("/..%2f{name}"),
            "/C:/Windows/win.ini".to_string(),
        ] {
            let (status, _, body) = serve_preview_file(&root, &path);
            assert_eq!(status, 403, "{path}");
            assert!(!String::from_utf8_lossy(&body).contains("secret"));
        }
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&root);
    }

    fn site_request(origin: &str, path: &str) -> tauri::http::Request<Vec<u8>> {
        tauri::http::Request::builder()
            .uri(format!("{origin}{path}"))
            .body(Vec::new())
            .unwrap()
    }

    #[test]
    fn each_folder_keeps_its_own_site_while_others_open() {
        // What `agent_set_preview_root` does past its check that the folder is in the project.
        let open = |root: &Path| {
            let site = Site::Root(root.to_path_buf());
            let key = site_key(&site, None);
            let port = site_port(&mut sites(), site, key);
            site_base(Some(port)).trim_end_matches('/').to_string()
        };
        let first = temp_root("site-a");
        let second = temp_root("site-b");
        fs::write(
            first.join("index.html"),
            "<html><head></head><body>first</body></html>",
        )
        .unwrap();
        fs::write(
            second.join("index.html"),
            "<html><head></head><body>second</body></html>",
        )
        .unwrap();
        let a = open(&first);
        let b = open(&second);
        assert_ne!(a, b);
        assert!(a.starts_with(&format!("{}:", preview_origin())), "{a}");
        // Opening it again gives the same site back.
        assert_eq!(open(&first), a);
        open(&second);

        // The page of the first folder, now behind the second, still gets its own files.
        let res = tauri::async_runtime::block_on(proxy_preview("main", site_request(&a, "/")));
        let html = String::from_utf8_lossy(res.body()).into_owned();
        assert!(html.contains("first"), "{html}");
        assert!(!html.contains("<base"), "{html}");
        let res = tauri::async_runtime::block_on(proxy_preview("main", site_request(&b, "/")));
        assert!(String::from_utf8_lossy(res.body()).contains("second"));

        let res = tauri::async_runtime::block_on(proxy_preview(
            "main",
            site_request(&format!("{}:1", preview_origin()), "/"),
        ));
        assert_eq!(res.status(), 503);
        let _ = fs::remove_dir_all(&first);
        let _ = fs::remove_dir_all(&second);
    }

    /// A request for `path` on `site` with the given headers, made in the webview `webview`.
    fn ask(webview: &str, site: &str, path: &str, headers: &[(&str, &str)]) -> PreviewResponse {
        let mut req = tauri::http::Request::builder().uri(format!("{site}{path}"));
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        tauri::async_runtime::block_on(proxy_preview(webview, req.body(Vec::new()).unwrap()))
    }

    #[test]
    fn only_a_sites_own_pages_in_the_app_read_its_files() {
        let root = temp_root("who-asks");
        fs::write(root.join(".env"), "KEY=secret").unwrap();
        let site = Site::Root(root.clone());
        let key = site_key(&site, None);
        let port = site_port(&mut sites(), site, key);
        let own = site_base(Some(port)).trim_end_matches('/').to_string();
        let other = format!("{}:{}", preview_origin(), port.wrapping_add(1));
        let status = |webview: &str, site: &str, headers: &[(&str, &str)]| {
            ask(webview, site, "/.env", headers).status().as_u16()
        };

        // The page itself, and a frame the app opens on it.
        let same = [
            ("sec-fetch-site", "same-origin"),
            ("sec-fetch-mode", "cors"),
        ];
        assert_eq!(status("main", &own, &same), 200);
        let with_origin = [("origin", own.as_str()), same[0], same[1]];
        assert_eq!(status("main", &own, &with_origin), 200);
        let frame = [
            ("sec-fetch-site", "cross-site"),
            ("sec-fetch-mode", "navigate"),
        ];
        assert_eq!(status("main", &own, &frame), 200);
        // WebKit: no fetch metadata, and `null` for a custom scheme's own pages.
        assert_eq!(status("main", &own, &[]), 200);
        assert_eq!(status("main", &own, &[("origin", "null")]), 200);

        // A website in the browser's webview, whatever it claims.
        assert_eq!(status("preview-ext-1", &own, &same), 403);
        assert_eq!(status("preview-ext-1", &own, &frame), 403);
        assert_eq!(status("quick", &own, &[]), 403);
        // A visual of the chat (an opaque origin) fetching or embedding the file.
        let visual = [
            ("origin", "null"),
            ("sec-fetch-site", "cross-site"),
            ("sec-fetch-mode", "cors"),
        ];
        assert_eq!(status("main", &own, &visual), 403);
        let embed = [
            ("sec-fetch-site", "cross-site"),
            ("sec-fetch-mode", "no-cors"),
        ];
        assert_eq!(status("main", &own, &embed), 403);
        // Another site's page.
        let neighbour = [
            ("origin", other.as_str()),
            ("sec-fetch-site", "same-site"),
            ("sec-fetch-mode", "cors"),
        ];
        assert_eq!(status("main", &own, &neighbour), 403);
        assert_eq!(status("main", &own, &[("origin", other.as_str())]), 403);

        // Nobody else may read what a site serves, and the port-less address serves no folder.
        let res = ask("main", &own, "/.env", &same);
        assert!(res.headers().get("access-control-allow-origin").is_none());
        assert_eq!(status("main", preview_origin(), &[]), 503);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sites_on_the_same_port_move_aside() {
        let mut sites = Sites::default();
        let server = || Site::Root(PathBuf::from("/work/app"));
        let key = site_key(&server(), None);
        let a = site_port(&mut sites, server(), key.clone());
        assert_eq!(site_port(&mut sites, server(), key.clone()), a);
        assert!(SITE_PORTS.contains(&(a as u64)));
        // Given to something else (in an earlier run, say), the port moves to the next free one.
        sites.keys.insert(a, "shared|root:elsewhere".into());
        let moved = site_port(&mut sites, server(), key);
        assert_ne!(moved, a);
        assert_eq!(sites.by_port.get(&moved), Some(&server()));
    }

    #[test]
    fn each_cookie_profile_keeps_its_own_storage() {
        let folder = || Site::Root(PathBuf::from("/work/site"));
        let shared = site_key(&folder(), None);
        assert_eq!(shared, site_key(&folder(), Some("shared")));
        assert_ne!(shared, site_key(&folder(), Some("p-1a2b")));
        // Private: the same port all run long, and another one next run.
        let private = site_key(&folder(), Some("private"));
        assert_ne!(private, shared);
        assert_eq!(private, site_key(&folder(), Some("private")));
        assert!(private.starts_with("private-"), "{private}");
        // Nothing but a plain name gets into the key.
        assert_eq!(
            site_key(&folder(), Some("../x|y")),
            site_key(&folder(), Some("xy"))
        );
    }

    #[test]
    fn ports_are_kept_across_runs_until_cleared() {
        let dir = temp_root("sites-file");
        let file = dir.join("preview-sites.json");
        let folder = Site::Root(dir.clone());
        let key = site_key(&folder, None);

        let mut run = Sites::default();
        load_sites(&mut run, Some(file.clone()));
        let port = site_port(&mut run, folder.clone(), key.clone());
        site_port(
            &mut run,
            Site::Root(PathBuf::from("/work/old")),
            "old".into(),
        );

        // Next run: every port is known again before anything opens, so a clear reaches them.
        let mut next = Sites::default();
        load_sites(&mut next, Some(file.clone()));
        assert_eq!(next.keys.len(), 2);
        assert_eq!(next.keys.get(&port), Some(&key));
        assert_eq!(site_port(&mut next, folder, key.clone()), port);
        // After a clear only what is open this run is still remembered.
        forget_closed_sites(&mut next);
        let mut after = Sites::default();
        load_sites(&mut after, Some(file.clone()));
        assert_eq!(after.keys, HashMap::from([(port, key)]));

        fs::write(&file, "not json").unwrap();
        let mut broken = Sites::default();
        load_sites(&mut broken, Some(file));
        assert!(broken.keys.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn serves_a_remote_projects_files_through_its_machine() {
        // The machine: `site/` with an index and a stylesheet, a `docs` folder with its own
        // index, and `site/leak` a symlink to the home folder.
        let files: HashMap<&str, &str> = HashMap::from([
            (
                "/home/me/site/index.html",
                "<html><head></head><body>hola</body></html>",
            ),
            ("/home/me/site/css/a b.css", "body{}"),
            ("/home/me/site/docs/index.html", "<p>docs</p>"),
            ("/home/me/secret.txt", "top secret"),
        ]);
        let path_of = |uri: &str| crate::remote::parse(uri).unwrap().path;
        let real = |uri: &str| -> Result<String, String> {
            let p = path_of(uri).replace("/home/me/site/leak", "/home/me");
            Ok(format!("ssh://vps{p}"))
        };
        let read = |uri: &str| {
            files
                .get(path_of(uri).as_str())
                .map(|s| s.as_bytes().to_vec())
                .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))
        };
        let is_dir = |uri: &str| path_of(uri) == "/home/me/site/docs";
        let root = "ssh://vps/home/me/site";
        let get = |p: &str| serve_remote_preview_with(root, p, &real, &read, &is_dir);

        let (status, ct, body) = get("/");
        assert_eq!((status, ct.starts_with("text/html")), (200, true));
        let html = String::from_utf8(body).unwrap();
        assert!(
            html.contains("hola") && html.contains("nyxs-pick"),
            "{html}"
        );
        let (status, ct, body) = get("/css/a%20b.css");
        assert_eq!(
            (status, ct.as_str(), body.as_slice()),
            (200, "text/css; charset=utf-8", b"body{}".as_slice())
        );
        assert!(String::from_utf8(get("/docs").2).unwrap().contains("docs"));
        assert_eq!(get("/missing.js").0, 404);
        assert_eq!(get("/../secret.txt").0, 403);
        assert_eq!(
            get("/leak/secret.txt").0,
            403,
            "a symlink out of the folder"
        );
    }
}
