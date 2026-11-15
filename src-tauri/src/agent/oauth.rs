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

/// What the browser tab shows once it is back, in the app's language (the frontend knows it).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallbackPage {
    connected_title: String,
    connected_text: String,
    failed_title: String,
    failed_text: String,
}

impl Default for CallbackPage {
    fn default() -> Self {
        Self {
            connected_title: "Connected".into(),
            connected_text: "You can close this tab and go back to the app.".into(),
            failed_title: "Couldn't connect".into(),
            failed_text: "Go back to the app to see what happened and try again.".into(),
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
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.contains(&b'\n') && buf.len() < 8192 {
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
    let body = if param("error").is_some() {
        page(&escape(&texts.failed_title), &escape(&texts.failed_text))
    } else {
        page(
            &format!("{} &#10003;", escape(&texts.connected_title)),
            &escape(&texts.connected_text),
        )
    };
    respond(&mut stream, "200 OK", &body);
    Answer::Callback(query.to_string())
}

/// The texts come from the app, but go into HTML: they are written as text, never as markup.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn page(title: &str, text: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"></head><body style=\"margin:0;font-family:system-ui,sans-serif;background:#212121;color:#ececec;display:flex;align-items:center;justify-content:center;height:100vh\"><div style=\"text-align:center\"><h2 style=\"font-weight:600\">{title}</h2><p style=\"color:#b4b4b4\">{text}</p></div></body></html>"
    )
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
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
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
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

    #[test]
    fn a_zero_wait_closes_a_reserved_port() {
        let port = oauth_reserve().unwrap();
        assert!(oauth_wait_blocking(port, 0, None, None).is_err());
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }
}
