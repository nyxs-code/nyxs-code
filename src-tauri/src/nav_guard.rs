//! Which addresses a webview may navigate to. Tauri counts every one of the app's own protocols
//! (`nyxspreview.localhost`, `asset.localhost`…) as the app's origin, and the app's origin may
//! call every command. A page that replaced the main window's document (a preview page running
//! `top.location = …`) would get that access, so the main window only ever loads the app itself,
//! and the browser's webviews, which show any website, never load the app's protocols.

use tauri::Url;

/// The app's own protocols: hosts `<name>.localhost` on Windows and Android, schemes
/// `<name>://` elsewhere.
const APP_PROTOCOLS: [&str; 4] = ["tauri", "asset", "ipc", "nyxspreview"];

/// Where the app's own pages come from: the dev server under `tauri dev`, the app's protocol in
/// a build.
pub(crate) fn app_url(config: &tauri::Config) -> Option<Url> {
    if tauri::is_dev() {
        return config.build.dev_url.clone();
    }
    let origin = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    Url::parse(origin).ok()
}

/// The address a `blob:` URL was made in; any other address as it is.
fn unwrap_blob(url: &Url) -> Option<Url> {
    if url.scheme() == "blob" {
        Url::parse(url.path()).ok()
    } else {
        Some(url.clone())
    }
}

/// Compared by hand: the `url` crate gives `tauri://localhost` an opaque origin that never
/// equals another.
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// The main window may load its own pages (reloads, the dev server's full reloads, a blob it
/// made) and nothing else.
pub(crate) fn main_may_open(url: &Url, app: &Url) -> bool {
    unwrap_blob(url).is_some_and(|u| same_origin(&u, app))
}

/// A browser tab may go anywhere but the app's own protocols.
pub(crate) fn site_may_open(url: &Url) -> bool {
    let Some(url) = unwrap_blob(url) else {
        return false;
    };
    let scheme = url.scheme().to_ascii_lowercase();
    if APP_PROTOCOLS.contains(&scheme.as_str()) {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let host = host.trim_end_matches('.');
    !APP_PROTOCOLS
        .iter()
        .any(|p| host.strip_suffix(".localhost") == Some(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_main_window_only_loads_the_app() {
        for app in [
            "http://localhost:1420/",
            "http://tauri.localhost/",
            "tauri://localhost/",
        ] {
            let app = url(app);
            let page = app.join("index.html?x=1#y").unwrap();
            assert!(main_may_open(&app, &app));
            assert!(main_may_open(&page, &app));
            assert!(main_may_open(&url(&format!("blob:{}abc", app)), &app));
        }
        let dev = url("http://localhost:1420/");
        for other in [
            "http://nyxspreview.localhost/",
            "http://nyxspreview.localhost:23817/index.html",
            "nyxspreview://localhost/index.html",
            "http://asset.localhost/C%3A/x.svg",
            "http://localhost:1421/",
            "https://localhost:1420/",
            "http://127.0.0.1:1420/",
            "https://example.com/",
            "blob:http://nyxspreview.localhost:23817/abc",
            "about:blank",
            "data:text/html,hi",
            "file:///C:/x.html",
        ] {
            assert!(!main_may_open(&url(other), &dev), "{other}");
        }
        assert!(!main_may_open(
            &url("http://localhost:1420/"),
            &url("http://tauri.localhost/")
        ));
    }

    #[test]
    fn browser_tabs_never_load_the_apps_protocols() {
        for blocked in [
            "http://nyxspreview.localhost/.env",
            "http://nyxspreview.localhost:23817/",
            "http://NyxsPreview.LOCALHOST/",
            "http://nyxspreview.localhost./",
            "https://tauri.localhost/",
            "http://asset.localhost/C%3A/x",
            "http://ipc.localhost/agent_run",
            "nyxspreview://localhost/",
            "tauri://localhost/",
            "asset://localhost/x",
            "ipc://localhost/x",
            "blob:http://nyxspreview.localhost:23817/abc",
        ] {
            assert!(!site_may_open(&url(blocked)), "{blocked}");
        }
        for allowed in [
            "https://example.com/",
            "http://localhost:5173/",
            "http://127.0.0.1:3000/",
            "http://myapp.localhost:3000/",
            "http://nyxspreview.example.com/",
            "about:blank",
            "blob:https://example.com/abc",
        ] {
            assert!(site_may_open(&url(allowed)), "{allowed}");
        }
    }
}
