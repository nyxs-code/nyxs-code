use super::*;
use crate::error::CmdError;
use std::net::TcpStream;

/// A port reserved for an OAuth callback, and when, so one whose wait never came is closed.
struct Reserved {
    listener: TcpListener,
    at: Instant,
}

static OAUTH_LISTENERS: OnceLock<Mutex<HashMap<u16, Reserved>>> = OnceLock::new();
fn oauth_listeners() -> &'static Mutex<HashMap<u16, Reserved>> {
    OAUTH_LISTENERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Longer than any wait (5 minutes): a reservation this old lost its `oauth_wait`.
const STALE_RESERVATION: Duration = Duration::from_secs(15 * 60);
/// How long a connection may take to send its request line before it's dropped, so one that
/// sends nothing can't hold the callback up.
const READ_TIMEOUT: Duration = Duration::from_secs(3);

#[tauri::command]
pub fn oauth_reserve() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let mut listeners = oauth_listeners().lock().unwrap_or_else(|e| e.into_inner());
    listeners.retain(|_, r| r.at.elapsed() < STALE_RESERVATION);
    listeners.insert(
        port,
        Reserved {
            listener,
            at: Instant::now(),
        },
    );
    Ok(port)
}

/// What the browser tab shows once it is back, in the app's language (the frontend knows it),
/// with the service that was connected next to Nyxs.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallbackPage {
    connected_title: String,
    connected_text: String,
    failed_title: String,
    failed_text: String,
    /// The service's logo as SVG markup. It is shown through an `<img>`, where SVG can't run
    /// anything.
    #[serde(default)]
    service_icon: Option<String>,
    /// Shown on the service's tile, in `service_color`, when it has no logo.
    #[serde(default)]
    service_initial: Option<String>,
    #[serde(default)]
    service_color: Option<String>,
}

impl Default for CallbackPage {
    fn default() -> Self {
        Self {
            connected_title: "Connected".into(),
            connected_text: "You can close this tab and go back to the app.".into(),
            failed_title: "Couldn't connect".into(),
            failed_text: "Go back to the app to see what happened and try again.".into(),
            service_icon: None,
            service_initial: None,
            service_color: None,
        }
    }
}

/// Waits for the browser to come back to the reserved port and returns the callback's query.
/// With `state`, only a callback carrying that same `state` counts. A connection that isn't the
/// callback (no query, another `state`, nothing sent) is answered and ignored, and the wait goes
/// on. The port is closed when this returns; a `timeout_ms` of 0 just closes it. `page` is what
/// the tab shows, in English when it isn't given.
#[tauri::command]
pub async fn oauth_wait(
    port: u16,
    timeout_ms: u64,
    state: Option<String>,
    page: Option<CallbackPage>,
) -> Result<String, CmdError> {
    tauri::async_runtime::spawn_blocking(move || oauth_wait_blocking(port, timeout_ms, state, page))
        .await
        .map_err(|e| e.to_string())?
}

fn oauth_wait_blocking(
    port: u16,
    timeout_ms: u64,
    state: Option<String>,
    page: Option<CallbackPage>,
) -> Result<String, CmdError> {
    let page = page.unwrap_or_default();
    let Reserved { listener, .. } = oauth_listeners()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&port)
        .ok_or_else(|| format!("OAuth port {port} wasn't reserved"))?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    // The browser came back to the callback with nothing on it: said so if nothing better comes.
    let mut bare_callback = false;
    loop {
        match listener.accept() {
            Ok((stream, _)) => match answer(stream, state.as_deref(), &page) {
                Answer::Callback(query) => return Ok(query),
                Answer::Bare => bare_callback = true,
                Answer::Other => {}
            },
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(if bare_callback {
                        CmdError::oauth_no_params()
                    } else {
                        CmdError::oauth_timed_out()
                    });
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(e.to_string().into()),
        }
    }
}

enum Answer {
    /// The callback, with its query.
    Callback(String),
    /// `/callback` with no query.
    Bare,
    /// Anything else: a probe, another flow's callback, a connection that sent nothing.
    Other,
}

/// Reads one connection's request and answers it.
fn answer(mut stream: TcpStream, state: Option<&str>, texts: &CallbackPage) -> Answer {
    // On Windows an accepted socket inherits the listener's non-blocking mode, and a read
    // would fail before the browser has sent anything.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    // Read the whole request, headers included: closing with any of it unread makes the OS
    // reset the connection, and the browser then retries on a port that is already closed.
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 64 * 1024 {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let req = String::from_utf8_lossy(&buf);
    let target = req
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .nth(1)
        .unwrap_or("");
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let param = |name: &str| {
        query.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (k == name).then_some(v)
        })
    };
    let is_callback = !query.is_empty() && state.is_none_or(|s| param("state") == Some(s));
    if !is_callback {
        respond(&mut stream, "404 Not Found", "");
        let path = target.split('?').next().unwrap_or("");
        return if query.is_empty() && path == "/callback" {
            Answer::Bare
        } else {
            Answer::Other
        };
    }
    let body = page(texts, param("error").is_none());
    respond(&mut stream, "200 OK", &body);
    Answer::Callback(query.to_string())
}

/// The texts come from the app, but go into HTML: they are written as text, never as markup.
/// `{` is written as an entity too, so a text can't look like one of the page's placeholders.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('{', "&#123;")
}

const PAGE: &str = include_str!("oauth_page.html");
const NYXS_LOGO: &[u8] = include_bytes!("../../../public/logo.png");
/// Inter, the app's font, so the page looks the same without it installed (OFL-1.1, from
/// @fontsource-variable/inter).
const INTER: &[u8] = include_bytes!("../../assets/inter-latin-wght-normal.woff2");

const CHECK: &str = r##"<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#1a3d29" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>"##;
const CROSS: &str = r##"<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#4a1a14" stroke-width="3.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>"##;

/// Nyxs and the connected service side by side, joined by a line with the outcome in the middle.
fn page(texts: &CallbackPage, connected: bool) -> String {
    use base64::Engine as _;
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let nyxs = format!(
        r#"<div class="tile"><img class="nyxs" alt="" src="data:image/png;base64,{}"></div>"#,
        b64(NYXS_LOGO)
    );
    let badge = format!(
        r#"<div class="badge">{}</div>"#,
        if connected { CHECK } else { CROSS }
    );
    let service = match (&texts.service_icon, &texts.service_initial) {
        (Some(svg), _) if !svg.trim().is_empty() => Some(format!(
            r#"<img class="service" alt="" src="data:image/svg+xml;base64,{}">"#,
            b64(svg.as_bytes())
        )),
        (_, Some(initial)) if !initial.trim().is_empty() => {
            let letter: String = initial.trim().chars().take(1).collect();
            Some(format!(
                r#"<span style="color:{}">{}</span>"#,
                safe_color(texts.service_color.as_deref()),
                escape(&letter.to_uppercase())
            ))
        }
        _ => None,
    };
    let icons = match service {
        Some(service) => format!(
            r#"<div class="icons">{nyxs}<div class="line">{badge}</div><div class="tile">{service}</div></div>"#
        ),
        // Nothing to show for the service: Nyxs alone, with the outcome on its corner.
        None => format!(r#"<div class="icons"><div class="solo">{nyxs}{badge}</div></div>"#),
    };
    let (title, text) = if connected {
        (&texts.connected_title, &texts.connected_text)
    } else {
        (&texts.failed_title, &texts.failed_text)
    };
    PAGE.replace("{{FONT}}", &b64(INTER))
        .replace("{{STATE}}", if connected { "connected" } else { "failed" })
        .replace("{{ICONS}}", &icons)
        .replace("{{TITLE}}", &escape(title))
        .replace("{{TEXT}}", &escape(text))
}

/// A hex colour from the app, or the muted text colour when it isn't one.
fn safe_color(color: Option<&str>) -> &str {
    match color {
        Some(c)
            if c.len() <= 9
                && c.starts_with('#')
                && c.len() > 1
                && c[1..].chars().all(|ch| ch.is_ascii_hexdigit()) =>
        {
            c
        }
        _ => "#8a8a88",
    }
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
    // Close gracefully: send our FIN, then take whatever the browser still sends (a body, a
    // late packet) until it closes too, so nothing unread is left to turn the close into a reset.
    let _ = stream.shutdown(std::net::Shutdown::Write);
    // Bounded, so a peer that keeps sending can't hold the wait up.
    let until = Instant::now() + Duration::from_secs(1);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let mut sink = [0u8; 4096];
    while Instant::now() < until && matches!(stream.read(&mut sink), Ok(n) if n > 0) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sends a request to the callback port and returns the answer.
    fn visit(port: u16, target: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    /// Whether the port's listener was released, which closes it. Connecting to the port can't
    /// tell: tests run in parallel, and another one may already have been given the freed port.
    fn released(port: u16) -> bool {
        !oauth_listeners()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&port)
    }

    fn wait_in_background(
        port: u16,
        state: Option<&str>,
    ) -> std::thread::JoinHandle<Result<String, CmdError>> {
        let state = state.map(str::to_string);
        std::thread::spawn(move || oauth_wait_blocking(port, 20_000, state, None))
    }

    #[test]
    fn only_the_callback_with_its_state_counts() {
        let port = oauth_reserve().unwrap();
        let wait = wait_in_background(port, Some("s3cret"));
        // A probe, a connection that sends nothing, and another flow's callback are ignored.
        assert!(visit(port, "/favicon.ico").starts_with("HTTP/1.1 404"));
        let silent = TcpStream::connect(("127.0.0.1", port)).unwrap();
        assert!(visit(port, "/callback?token=evil&state=other").starts_with("HTTP/1.1 404"));
        let ok = visit(port, "/callback?token=good&state=s3cret");
        assert!(ok.contains("Connected"), "{ok}");
        drop(silent);
        assert_eq!(wait.join().unwrap().unwrap(), "token=good&state=s3cret");
        // The port is closed once the callback came.
        assert!(released(port));
    }

    #[test]
    fn an_error_isnt_answered_as_connected() {
        let port = oauth_reserve().unwrap();
        let wait = wait_in_background(port, None);
        let page = visit(port, "/callback?error=access_denied");
        assert!(page.contains("Couldn't connect"), "{page}");
        assert!(!page.contains("Connected"));
        assert_eq!(wait.join().unwrap().unwrap(), "error=access_denied");
    }

    #[test]
    fn the_page_speaks_the_apps_language_and_escapes_its_texts() {
        let port = oauth_reserve().unwrap();
        let page = CallbackPage {
            connected_title: "Conectado".into(),
            connected_text: "Puedes cerrar esta pestaña y volver a la app.".into(),
            failed_title: "No se pudo conectar".into(),
            failed_text: "Vuelve a la app <b>& prueba</b> otra vez.".into(),
            ..CallbackPage::default()
        };
        let wait = std::thread::spawn(move || oauth_wait_blocking(port, 20_000, None, Some(page)));
        let answer = visit(port, "/callback?error=access_denied");
        assert!(answer.contains("No se pudo conectar"), "{answer}");
        assert!(
            answer.contains("Vuelve a la app &lt;b&gt;&amp; prueba&lt;/b&gt; otra vez."),
            "{answer}"
        );
        assert!(!answer.contains("Couldn't connect"));
        wait.join().unwrap().unwrap();

        let port = oauth_reserve().unwrap();
        let wait = std::thread::spawn(move || oauth_wait_blocking(port, 20_000, None, None));
        assert!(visit(port, "/callback?code=1").contains("Connected"));
        wait.join().unwrap().unwrap();
    }

    #[test]
    fn a_callback_with_nothing_on_it_is_named_when_the_wait_ends() {
        let port = oauth_reserve().unwrap();
        let wait = std::thread::spawn(move || oauth_wait_blocking(port, 1_000, None, None));
        assert!(visit(port, "/callback").starts_with("HTTP/1.1 404"));
        assert_eq!(wait.join().unwrap().unwrap_err().code, "oauthNoParams");
    }

    /// A browser sends the callback with kilobytes of headers. Closing the socket with them
    /// unread resets the connection, the browser retries on the port that is already closed
    /// and shows "connection refused" although sign-in worked.
    #[test]
    fn a_browser_with_many_headers_gets_the_page_not_a_reset() {
        let port = oauth_reserve().unwrap();
        let wait = wait_in_background(port, None);
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let headers: String = (0..60)
            .map(|i| format!("X-Header-{i}: {}\r\n", "v".repeat(100)))
            .collect();
        write!(
            s,
            "GET /callback?token=t HTTP/1.1\r\nHost: 127.0.0.1\r\n{headers}\r\n"
        )
        .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out)
            .expect("the answer arrives whole, not reset");
        assert!(out.contains("Connected"), "{out}");
        assert_eq!(wait.join().unwrap().unwrap(), "token=t");
    }

    #[test]
    fn the_page_shows_nyxs_next_to_the_service() {
        use base64::Engine as _;
        let svg = r#"<svg viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>"#;
        let with_icon = CallbackPage {
            connected_title: "Gmail conectado a Nyxs {{TEXT}}".into(),
            service_icon: Some(svg.into()),
            ..CallbackPage::default()
        };
        let html = page(&with_icon, true);
        let encoded = base64::engine::general_purpose::STANDARD.encode(svg);
        assert!(html.contains(&format!("data:image/svg+xml;base64,{encoded}")));
        assert!(html.contains(r#"<body class="connected">"#));
        assert!(html.contains("Gmail conectado a Nyxs &#123;&#123;TEXT}}"));
        assert!(!html.contains("{{"), "a placeholder was left unfilled");
        assert!(html.contains(r#"<div class="line"><div class="badge"><svg"#));

        // No logo: the initial, in the service's colour; a colour that isn't hex isn't used.
        let initial = CallbackPage {
            service_initial: Some("acme".into()),
            service_color: Some("red;background:url(x)".into()),
            ..CallbackPage::default()
        };
        let html = page(&initial, false);
        assert!(html.contains(r#"<span style="color:#8a8a88">A</span>"#));
        assert!(html.contains(r#"<body class="failed">"#));
        let colored = CallbackPage {
            service_initial: Some("acme".into()),
            service_color: Some("#5e6ad2".into()),
            ..CallbackPage::default()
        };
        assert!(page(&colored, true).contains(r#"<span style="color:#5e6ad2">A</span>"#));

        // Nothing about the service: Nyxs alone.
        let html = page(&CallbackPage::default(), true);
        assert!(html.contains(r#"<div class="solo">"#));
        assert!(!html.contains(r#"class="line""#));
    }

    #[test]
    fn a_zero_wait_closes_a_reserved_port() {
        let port = oauth_reserve().unwrap();
        assert!(!released(port));
        assert!(oauth_wait_blocking(port, 0, None, None).is_err());
        assert!(released(port));
    }
}
