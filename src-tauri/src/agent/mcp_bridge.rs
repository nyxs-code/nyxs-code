//! The MCP servers Nyxs hosts in its page (the built-in browser, sessions, chat questions and
//! plan review) published over HTTP on
//! 127.0.0.1, for agents that only take MCP servers by address: Grok CLI (per session, over
//! ACP) and Antigravity CLI (through `--nyxs-mcp-proxy`, see `mcp_proxy_main`). Claude Code reaches
//! them over its stdin instead.
//!
//! Each POST to `/mcp/<server>` carries one JSON-RPC message (MCP's Streamable HTTP transport,
//! answered with plain JSON). It goes to the page as a `hosted-mcp-request` event, and the page
//! answers with `hosted_mcp_reply`. Requests need the bridge's token, kept in ~/.nyxs so an
//! address saved in a CLI's config stays valid across restarts.

use super::*;
use std::net::TcpStream;
use std::sync::mpsc;

/// The first argument that makes Nyxs' executable a stdio MCP server instead of the app.
pub const MCP_PROXY_FLAG: &str = "--nyxs-mcp-proxy";
/// What a run of Antigravity started by Nyxs gets, so the proxy it spawns reaches this Nyxs
/// (and this chat) even with another Nyxs open: the bridge's port, its token, the chat.
const PORT_ENV: &str = "NYXS_MCP_PORT";
const TOKEN_ENV: &str = "NYXS_MCP_TOKEN";
const CHAT_ENV: &str = "NYXS_MCP_CHAT";
/// A question in Nyxs' card (`nyxs-chat`) waits for the user, so this is as long as a turn of
/// Antigravity's may run (`--print-timeout 60m`); Grok and agy both waited 100s for an answer.
const REPLY_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const MAX_BODY: usize = 8 * 1024 * 1024;
/// A request line or header longer than this, or more headers than `MAX_HEADERS`, ends the
/// request: nothing a CLI sends comes near, and reading on would grow without end.
const MAX_LINE: u64 = 16 * 1024;
const MAX_HEADERS: usize = 100;

struct Bridge {
    port: u16,
    token: String,
}

static BRIDGE: OnceLock<Bridge> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static WAITING: OnceLock<Mutex<HashMap<u64, mpsc::Sender<String>>>> = OnceLock::new();

fn waiting() -> &'static Mutex<HashMap<u64, mpsc::Sender<String>>> {
    WAITING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn token_file() -> Result<PathBuf, String> {
    Ok(BridgeFiles::in_dir(&home_dir()?.join(".nyxs")).token)
}

fn port_file() -> Result<PathBuf, String> {
    Ok(BridgeFiles::in_dir(&home_dir()?.join(".nyxs")).port)
}

/// Where an `agy` started outside Nyxs finds the latest Nyxs' bridge: its token and its port.
struct BridgeFiles {
    token: PathBuf,
    port: PathBuf,
}

impl BridgeFiles {
    fn in_dir(dir: &Path) -> Self {
        BridgeFiles {
            token: dir.join("mcp-bridge-token"),
            port: dir.join("mcp-bridge.json"),
        }
    }

    /// Saves this run's token and port where only this user can read them.
    fn save(&self, port: u16, token: &str) -> Result<(), String> {
        super::cli_accounts::write_private(&self.token, token.as_bytes())?;
        super::cli_accounts::write_private(
            &self.port,
            serde_json::json!({ "port": port }).to_string().as_bytes(),
        )
    }

    /// This Nyxs is closing: its files go, unless a Nyxs started later wrote its own.
    fn forget(&self, port: u16, token: &str) {
        let saved_port = fs::read_to_string(&self.port)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v["port"].as_u64());
        if saved_port == Some(u64::from(port)) {
            let _ = fs::remove_file(&self.port);
        }
        if fs::read_to_string(&self.token).is_ok_and(|t| t.trim() == token) {
            let _ = fs::remove_file(&self.token);
        }
    }
}

/// A new token for each run of the bridge, never one saved by an earlier run: a token left
/// behind (Nyxs closed or crashed) is worth nothing to whoever finds it.
fn new_token() -> String {
    // RandomState is keyed from the OS's random source on every new instance.
    use std::hash::{BuildHasher, Hasher};
    (0..4)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(i);
            h.write_u128(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0),
            );
            format!("{:016x}", h.finish())
        })
        .collect()
}

#[derive(Serialize)]
pub struct McpBridgeInfo {
    port: u16,
    token: String,
}

/// Starts the bridge the first time (later calls only report it) and returns its address.
#[tauri::command]
pub fn mcp_bridge_start(app: AppHandle) -> Result<McpBridgeInfo, String> {
    if let Some(b) = BRIDGE.get() {
        return Ok(McpBridgeInfo {
            port: b.port,
            token: b.token.clone(),
        });
    }
    let token = new_token();
    // Any free port: Antigravity's config names no address (see mcp_proxy_main).
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Couldn't open the MCP bridge: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // Another call may have won the race: its bridge is the one in use.
    if BRIDGE
        .set(Bridge {
            port,
            token: token.clone(),
        })
        .is_err()
    {
        let b = BRIDGE.get().expect("set");
        return Ok(McpBridgeInfo {
            port: b.port,
            token: b.token.clone(),
        });
    }
    // For an `agy` started outside Nyxs, which has no NYXS_MCP_PORT: the latest Nyxs to start.
    // They go when the main window closes, so an `agy` run with Nyxs closed sends no token.
    if let Ok(home) = home_dir() {
        let files = BridgeFiles::in_dir(&home.join(".nyxs"));
        if let Err(e) = files.save(port, &token) {
            log::warn!("MCP bridge: {e}");
        }
        use tauri::Manager;
        // `get_window`: `get_webview_window` is `None` while the built-in browser is open.
        if let Some(main) = app.get_window("main") {
            let token = token.clone();
            main.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    files.forget(port, &token);
                }
            });
        }
    }
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                let _ = serve(stream, &app, &token);
            });
        }
    });
    Ok(McpBridgeInfo {
        port,
        token: BRIDGE.get().expect("set").token.clone(),
    })
}

/// The main page started loading again: the requests it had were lost with the old page and
/// will never be answered. Dropping their waits answers each with an error now, so the CLI's
/// call fails at once instead of after an hour.
pub fn drop_pending_requests() {
    waiting().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// The page's answer to a request it got as a `hosted-mcp-request` event.
#[tauri::command]
pub fn hosted_mcp_reply(id: u64, response: String) {
    if let Some(tx) = waiting()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id)
    {
        let _ = tx.send(response);
    }
}

#[derive(Clone, Serialize)]
struct HostedMcpRequest {
    id: u64,
    server: String,
    message: String,
}

struct Request {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
}

/// One line, or None when it's longer than `MAX_LINE` or can't be read.
fn read_line_capped(reader: &mut impl BufRead, out: &mut String) -> Option<usize> {
    let n = reader.by_ref().take(MAX_LINE).read_line(out).ok()?;
    if n as u64 == MAX_LINE && !out.ends_with('\n') {
        return None;
    }
    Some(n)
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    read_line_capped(&mut reader, &mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut length = 0usize;
    let mut authorization = None;
    for count in 0.. {
        if count == MAX_HEADERS {
            return None;
        }
        let mut header = String::new();
        if read_line_capped(&mut reader, &mut header)? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':')?;
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => length = value.parse().ok()?,
            "authorization" => authorization = Some(value.to_string()),
            _ => {}
        }
    }
    if length > MAX_BODY {
        return None;
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        path,
        authorization,
        body,
    })
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

fn rpc_error(id: &serde_json::Value, message: &str) -> String {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": message } }).to_string()
}

/// Constant-time, so the token can't be guessed a character at a time.
fn same_token(given: &str, token: &str) -> bool {
    given.len() == token.len()
        && given
            .bytes()
            .zip(token.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

fn serve(mut stream: TcpStream, app: &AppHandle, token: &str) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let Some(req) = read_request(&mut stream) else {
        return respond(&mut stream, "400 Bad Request", "{}");
    };
    let authorized = req
        .authorization
        .as_deref()
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|given| same_token(given.trim(), token));
    if !authorized {
        return respond(&mut stream, "401 Unauthorized", "{}");
    }
    let Some(server) = req
        .path
        .split('?')
        .next()
        .and_then(|p| p.strip_prefix("/mcp/"))
        .filter(|s| !s.is_empty())
    else {
        return respond(&mut stream, "404 Not Found", "{}");
    };
    match req.method.as_str() {
        "POST" => {}
        // Ending a session: nothing is kept per session.
        "DELETE" => return respond(&mut stream, "200 OK", "{}"),
        // No server-to-client stream: everything is answered on its own POST.
        _ => return respond(&mut stream, "405 Method Not Allowed", "{}"),
    }
    let message: serde_json::Value = match serde_json::from_slice(&req.body) {
        Ok(v) => v,
        Err(_) => return respond(&mut stream, "400 Bad Request", "{}"),
    };
    // Notifications and responses need no answer.
    let id = message
        .get("id")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    if id.is_null() || message.get("method").is_none() {
        return respond(&mut stream, "202 Accepted", "");
    }

    let request_id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    waiting()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request_id, tx);
    let event = HostedMcpRequest {
        id: request_id,
        server: server.to_string(),
        message: message.to_string(),
    };
    if app.emit_to("main", "hosted-mcp-request", event).is_err() {
        waiting()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&request_id);
        return respond(
            &mut stream,
            "200 OK",
            &rpc_error(&id, "Nyxs isn't available"),
        );
    }
    let body = reply_or_error(rx, request_id, &id, REPLY_TIMEOUT);
    respond(&mut stream, "200 OK", &body)
}

/// The page's answer, or the error the CLI gets when the page went away or never answered.
fn reply_or_error(
    rx: mpsc::Receiver<String>,
    request_id: u64,
    id: &serde_json::Value,
    timeout: Duration,
) -> String {
    match rx.recv_timeout(timeout) {
        Ok(body) => body,
        Err(mpsc::RecvTimeoutError::Disconnected) => rpc_error(
            id,
            "Nyxs reloaded before answering this call. Call the tool again.",
        ),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            waiting()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id);
            rpc_error(id, "Nyxs didn't respond in time")
        }
    }
}

/// The command a CLI's config runs for one of Nyxs' servers: this executable with
/// `--nyxs-mcp-proxy <server>`. An AppImage runs from a mount that is gone once it quits, so
/// the image itself is named.
pub fn mcp_proxy_command(server: &str) -> Option<(PathBuf, Vec<String>)> {
    #[cfg(target_os = "linux")]
    if let Some(image) = std::env::var_os("APPIMAGE").filter(|p| !p.is_empty()) {
        return Some((PathBuf::from(image), mcp_proxy_args(server)));
    }
    Some((std::env::current_exe().ok()?, mcp_proxy_args(server)))
}

pub fn mcp_proxy_args(server: &str) -> Vec<String> {
    vec![MCP_PROXY_FLAG.to_string(), server.to_string()]
}

struct ProxyTarget {
    port: u16,
    token: String,
    path: String,
}

/// Where the proxy sends `server`'s messages: the Nyxs that started this `agy` (its port, token
/// and chat come in the environment), else the latest Nyxs to open its bridge.
fn proxy_target(server: &str, env: impl Fn(&str) -> Option<String>) -> Option<ProxyTarget> {
    let given = env(PORT_ENV).and_then(|p| p.trim().parse::<u16>().ok());
    let port = match given {
        Some(port) => port,
        None => {
            let saved: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(port_file().ok()?).ok()?).ok()?;
            u16::try_from(saved["port"].as_u64()?).ok()?
        }
    };
    let token = match env(TOKEN_ENV).filter(|t| !t.is_empty()) {
        Some(token) => token,
        None => fs::read_to_string(token_file().ok()?)
            .ok()?
            .trim()
            .to_string(),
    };
    let mut path = format!("/mcp/{server}");
    // Another Nyxs' chat means nothing to the one in the port file.
    if given.is_some() {
        if let Some(chat) = env(CHAT_ENV).filter(|c| !c.is_empty()) {
            path.push('/');
            path.push_str(&percent_encode(&chat));
        }
    }
    Some(ProxyTarget { port, token, path })
}

/// As `encodeURIComponent`, which the page undoes (`splitServer` in mcpBridge.ts).
fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// One message to the bridge and its answer: None for a notification (202) or anything that
/// needs no reply, an error to give the CLI when the bridge can't be reached.
fn forward(target: Option<&ProxyTarget>, line: &str) -> Option<String> {
    let message: serde_json::Value = serde_json::from_str(line).ok()?;
    let id = message
        .get("id")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let wants_reply = !id.is_null() && message.get("method").is_some();
    let fail = |why: &str| wants_reply.then(|| rpc_error(&id, why));
    let Some(target) = target else {
        return fail("Nyxs isn't running");
    };
    match post(target, line) {
        Ok((200, body)) if !body.trim().is_empty() => {
            // One message per line on stdio: compact whatever came back.
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) => Some(v.to_string()),
                Err(_) => fail("Nyxs answered something that isn't JSON"),
            }
        }
        Ok((200 | 202, _)) => None,
        Ok((401, _)) => fail("Nyxs refused the bridge token"),
        Ok((status, _)) => fail(&format!("Nyxs answered {status}")),
        Err(e) => fail(&format!("Couldn't reach Nyxs: {e}")),
    }
}

fn post(target: &ProxyTarget, body: &str) -> std::io::Result<(u16, String)> {
    let mut stream = TcpStream::connect(("127.0.0.1", target.port))?;
    // A question waits for the user as long as the bridge does.
    stream.set_read_timeout(Some(REPLY_TIMEOUT + Duration::from_secs(60)))?;
    // HTTP/1.0 so the answer can't come chunked.
    let head = format!(
        "POST {} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        target.path,
        target.port,
        target.token,
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let status = line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| std::io::Error::other("bad response"))?;
    let mut length = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header.trim_end().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value
                    .trim()
                    .parse::<usize>()
                    .ok()
                    .filter(|n| *n <= MAX_BODY);
            }
        }
    }
    // By its length rather than up to the close: on Windows a close may come as a reset that
    // would take the answer with it.
    let mut body = Vec::new();
    match length {
        Some(n) => {
            body.resize(n, 0);
            reader.read_exact(&mut body)?;
        }
        None => {
            reader.read_to_end(&mut body)?;
        }
    }
    Ok((status, String::from_utf8_lossy(&body).into_owned()))
}

/// `--nyxs-mcp-proxy <server>`: a stdio MCP server that passes each message on to the bridge.
/// Antigravity's MCP config is global, so it names this command rather than an address: each
/// run reaches the Nyxs that started it, whatever port its bridge got, and an `agy` started
/// elsewhere reaches the latest Nyxs to open.
pub fn mcp_proxy_main(server: &str) -> i32 {
    let valid = !server.is_empty()
        && server
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        eprintln!("Invalid MCP server name: {server}");
        return 2;
    }
    let target = Arc::new(proxy_target(server, |k| std::env::var(k).ok()));
    let out = Arc::new(Mutex::new(std::io::stdout()));
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let (target, out) = (target.clone(), out.clone());
        // Each on its own: a question may wait for the user while other calls go on.
        std::thread::spawn(move || {
            if let Some(reply) = forward(target.as_ref().as_ref(), &line) {
                let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
                let _ = writeln!(out, "{reply}");
                let _ = out.flush();
            }
        });
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| {
            pairs
                .iter()
                .find(|(name, _)| *name == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn sends_a_run_to_the_nyxs_and_chat_that_started_it() {
        let target = proxy_target(
            "nyxs-browser",
            env_of(&[
                ("NYXS_MCP_PORT", "50123"),
                ("NYXS_MCP_TOKEN", "abc"),
                ("NYXS_MCP_CHAT", "chat 1/ñ"),
            ]),
        )
        .expect("target");
        assert_eq!(target.port, 50123);
        assert_eq!(target.token, "abc");
        assert_eq!(target.path, "/mcp/nyxs-browser/chat%201%2F%C3%B1");
    }

    #[test]
    fn answers_requests_but_not_notifications_when_nyxs_is_gone() {
        let request = r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#;
        let reply = forward(None, request).expect("an error for a request");
        let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(reply["id"], 7);
        assert!(reply["error"]["message"].is_string());
        assert!(forward(
            None,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        )
        .is_none());
        assert!(forward(None, "not json").is_none());
    }

    #[test]
    fn passes_messages_to_the_bridge_and_compacts_the_answer() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        // In a full parallel run other tests probe local ports, so a stranger may connect here
        // and send nothing: each connection gets its own thread and a deadline, so ours is never
        // stuck behind one.
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                    let Some(req) = read_request(&mut stream) else {
                        return;
                    };
                    let reply = format!(
                        "{{\n  \"jsonrpc\": \"2.0\", \"id\": 1, \"result\": {{ \"path\": \"{}\", \"auth\": \"{}\" }}\n}}",
                        req.path,
                        req.authorization.unwrap_or_default()
                    );
                    let _ = respond(&mut stream, "200 OK", &reply);
                });
            }
        });
        let target = ProxyTarget {
            port,
            token: "tok".into(),
            path: "/mcp/nyxs-chat/c1".into(),
        };
        let reply = forward(
            Some(&target),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        )
        .expect("reply");
        assert!(!reply.contains('\n'));
        let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(reply["result"]["path"], "/mcp/nyxs-chat/c1", "{reply}");
        assert_eq!(reply["result"]["auth"], "Bearer tok");
    }

    #[test]
    fn names_this_executable_as_the_proxy() {
        let (exe, args) = mcp_proxy_command("nyxs-chat").expect("command");
        assert!(exe.is_absolute());
        assert_eq!(args, ["--nyxs-mcp-proxy", "nyxs-chat"]);
    }

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn temp(tag: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!("nyxs-bridge-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        TempDir(dir)
    }

    #[test]
    fn each_run_saves_a_new_token_only_this_user_reads() {
        let dir = temp("publish");
        let files = BridgeFiles::in_dir(&dir.0);
        fs::create_dir_all(&dir.0).unwrap();
        let token = new_token();
        assert_eq!(token.len(), 64);
        assert_ne!(new_token(), token);
        files.save(5555, &token).unwrap();
        assert_eq!(fs::read_to_string(&files.token).unwrap(), token);
        assert!(fs::read_to_string(&files.port).unwrap().contains("5555"));
        #[cfg(unix)]
        for path in [&files.token, &files.port] {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{}", path.display());
        }
    }

    #[test]
    fn closing_removes_only_its_own_files() {
        let dir = temp("forget");
        let files = BridgeFiles::in_dir(&dir.0);
        let (first, second) = (new_token(), new_token());
        files.save(1111, &first).unwrap();
        // A second Nyxs started later: the files are its now.
        files.save(2222, &second).unwrap();
        files.forget(1111, &first);
        assert!(files.port.exists() && files.token.exists());
        files.forget(2222, &second);
        assert!(!files.port.exists() && !files.token.exists());
    }

    #[test]
    fn a_reload_answers_the_requests_it_left_at_once() {
        let request_id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        waiting()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(request_id, tx);
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(50));
            drop_pending_requests();
        });
        let started = Instant::now();
        let body = reply_or_error(rx, request_id, &serde_json::json!(4), REPLY_TIMEOUT);
        assert!(started.elapsed() < Duration::from_secs(5));
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["id"], 4);
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("reloaded"));
    }

    #[test]
    fn a_request_with_an_endless_line_is_dropped() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let _ = s.write_all(b"POST /mcp/x HTTP/1.1\r\nX-Big: ");
            let _ = s.write_all(&vec![b'a'; 1024 * 1024]);
        });
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        assert!(read_request(&mut stream).is_none());
        // Closed before joining: the client is still writing its megabyte, and with macOS's small
        // socket buffers that write blocks until this end goes away.
        drop(stream);
        drop(listener);
        let _ = client.join();
    }

    #[test]
    fn compares_tokens_whole() {
        assert!(same_token("abc123", "abc123"));
        assert!(!same_token("abc124", "abc123"));
        assert!(!same_token("abc12", "abc123"));
    }
}
