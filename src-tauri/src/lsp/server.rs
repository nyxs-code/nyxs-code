use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::discovery::resolve;
use super::protocol::{
    error_envelope, notify_envelope, path_to_uri, request_envelope, response_envelope, Diagnostic,
    Incoming,
};
use super::transport::{drain_to_log, read_message, write_message};

type PendingMap = Arc<Mutex<HashMap<i64, Sender<Result<Value, String>>>>>;
/// Each file's latest diagnostics, by `doc_key` (one entry per file however a server spells its
/// URI), with the URI as the server last published it.
type DiagnosticsMap = Arc<Mutex<HashMap<String, (String, Vec<Diagnostic>)>>>;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(not(test))]
const INIT_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(test)]
const INIT_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone, PartialEq)]
pub enum ServerState {
    Starting,
    Ready,
    Crashed(String),
}

impl ServerState {
    pub fn as_str(&self) -> &str {
        match self {
            ServerState::Starting => "starting",
            ServerState::Ready => "ready",
            ServerState::Crashed(_) => "crashed",
        }
    }
}

/// The server's process: here, or on the remote machine of an `ssh://` workspace.
enum LspChild {
    Local(Child),
    Remote(crate::remote::procs::RemoteHandle),
}

pub struct LspServer {
    pub language: String,
    pub binary: String,
    pub workspace: String,
    /// The machine an `ssh://` workspace is on: its server sees that machine's paths, so URIs
    /// are translated on the way in and out.
    remote: Option<crate::remote::RemotePath>,
    child: Mutex<LspChild>,
    stdin: Mutex<Box<dyn Write + Send>>,
    next_id: AtomicI64,
    pending: PendingMap,
    diagnostics: DiagnosticsMap,
    publish_signal: Arc<(Mutex<u64>, Condvar)>,
    /// How many times the server published each file's diagnostics, and that count when the
    /// app last changed the file: a later count means they're about the current text. Keyed
    /// by `doc_key`, since a server may spell a URI its own way (`file:///e%3A/…`).
    published: Mutex<HashMap<String, u64>>,
    changed: Mutex<HashMap<String, u64>>,
    open_docs: Mutex<HashMap<String, i32>>,
    state: Arc<Mutex<ServerState>>,
}

impl LspServer {
    pub fn spawn(workspace: &str, language: &str) -> Result<Arc<LspServer>, String> {
        if let Some(r) = crate::remote::parse(workspace) {
            return Self::spawn_remote(workspace, language, r);
        }
        let resolved = resolve(language).ok_or_else(|| format!("LSP_NOT_INSTALLED:{language}"))?;
        match Self::spawn_local(workspace, language, &resolved) {
            // A PATH copy that won't start (npm's shim for another shell, a half-removed
            // install) mustn't stand in for the server for good: skip it, and try what's left
            // (another PATH copy, the managed one, or installing it).
            Err(e) if resolved.source == "path" => {
                log::warn!(
                    "LSP: {} didn't start ({e}); not using it again",
                    resolved.program.display()
                );
                super::discovery::mark_unusable(&resolved.program);
                Self::spawn(workspace, language)
            }
            other => other,
        }
    }

    /// Starts the server's process, with its pipes.
    fn launch(
        workspace: &str,
        resolved: &super::discovery::ResolvedCommand,
    ) -> std::io::Result<Child> {
        let mut cmd = Command::new(&resolved.program);
        cmd.args(&resolved.args);
        if !workspace.is_empty() {
            cmd.current_dir(workspace);
        }
        if let Some(node) = super::provision::managed_node_program() {
            if let Some(node_dir) = node.parent() {
                let sep = if cfg!(windows) { ";" } else { ":" };
                let current = std::env::var("PATH").unwrap_or_default();
                cmd.env("PATH", format!("{}{}{}", node_dir.display(), sep, current));
            }
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        super::hide_console(&mut cmd);
        // Inside the agent's job on Windows: it and what it starts end with Nyxs even when
        // Nyxs ends without its normal exit.
        crate::agent::cli_process::spawn_contained(&mut cmd)
    }

    fn spawn_local(
        workspace: &str,
        language: &str,
        resolved: &super::discovery::ResolvedCommand,
    ) -> Result<Arc<LspServer>, String> {
        let bin_str = resolved.program.to_string_lossy().to_string();
        let mut child = Self::launch(workspace, resolved)
            .map_err(|e| format!("Couldn't launch the LSP server ({bin_str}): {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "The LSP server didn't expose stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "The LSP server didn't expose stdout".to_string())?;
        let stderr = child.stderr.take();
        Self::start(
            workspace,
            language,
            bin_str,
            None,
            LspChild::Local(child),
            Box::new(stdin),
            Box::new(stdout),
            stderr.map(|e| Box::new(e) as Box<dyn Read + Send>),
        )
    }

    /// On a remote machine the server must be installed there (on its PATH): Nyxs' managed
    /// downloads are for this PC.
    fn spawn_remote(
        workspace: &str,
        language: &str,
        r: crate::remote::RemotePath,
    ) -> Result<Arc<LspServer>, String> {
        let (program, args) = super::discovery::remote_command(language)
            .ok_or_else(|| format!("LSP_NOT_INSTALLED:{language}"))?;
        let info = crate::remote::info(&r.host).map_err(String::from)?;
        let command = if info.os == "windows" {
            format!("& {program} {}", args.join(" "))
        } else {
            format!(
                "command -v {program} >/dev/null 2>&1 || exit 127; exec {program} {}",
                args.join(" ")
            )
        };
        let mut child = crate::remote::procs::spawn(
            &r.host,
            crate::remote::procs::Spawn {
                command: Some(&command),
                argv: None,
                cwd: Some(&r.path),
                env: None,
                stdin: true,
                interactive: false,
            },
        )
        .map_err(String::from)?;
        let stdin = child
            .stdin
            .take()
            .ok_or("The LSP server didn't expose stdin")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("The LSP server didn't expose stdout")?;
        let stderr = child.stderr.take();
        let handle = child.handle();
        // A server that isn't installed there ends at once: say so like a missing local one.
        if let Some(Some(127)) = child.wait_timeout(Duration::from_millis(1500)) {
            return Err(format!("LSP_NOT_INSTALLED:{language}"));
        }
        Self::start(
            workspace,
            language,
            format!("{program} (on {})", r.host),
            Some(r),
            LspChild::Remote(handle),
            Box::new(stdin),
            Box::new(stdout),
            stderr.map(|e| Box::new(e) as Box<dyn Read + Send>),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn start(
        workspace: &str,
        language: &str,
        bin_str: String,
        remote: Option<crate::remote::RemotePath>,
        child: LspChild,
        stdin: Box<dyn Write + Send>,
        stdout: Box<dyn Read + Send>,
        stderr: Option<Box<dyn Read + Send>>,
    ) -> Result<Arc<LspServer>, String> {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let diagnostics: DiagnosticsMap = Arc::new(Mutex::new(HashMap::new()));
        let publish_signal: Arc<(Mutex<u64>, Condvar)> = Arc::new((Mutex::new(0), Condvar::new()));
        let state = Arc::new(Mutex::new(ServerState::Starting));

        let server = Arc::new(LspServer {
            language: language.to_string(),
            binary: bin_str,
            workspace: workspace.to_string(),
            remote,
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            next_id: AtomicI64::new(1),
            pending: pending.clone(),
            diagnostics: diagnostics.clone(),
            publish_signal: publish_signal.clone(),
            published: Mutex::new(HashMap::new()),
            changed: Mutex::new(HashMap::new()),
            open_docs: Mutex::new(HashMap::new()),
            state: state.clone(),
        });

        if let Some(err) = stderr {
            let label = format!("lsp:{language}");
            std::thread::spawn(move || drain_to_log(err, label));
        }

        spawn_reader(
            server.clone(),
            BufReader::new(stdout),
            pending,
            diagnostics,
            state,
        );

        if let Err(e) = server.initialize() {
            // Left running it would sit there unanswered for good, with its pipes open.
            server.kill();
            return Err(e);
        }

        Ok(server)
    }

    fn alloc_id(&self) -> i64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    fn send_raw(&self, payload: &Value) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "LSP stdin lock poisoned".to_string())?;
        write_message(&mut *stdin, payload)
            .map_err(|e| format!("Couldn't write to the LSP server: {e}"))
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send_raw(&notify_envelope(method, params))
    }

    fn request_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if let Ok(st) = self.state.lock() {
            if let ServerState::Crashed(ref msg) = *st {
                return Err(format!("The LSP server is down: {msg}"));
            }
        }

        let id = self.alloc_id();
        let (tx, rx) = channel::<Result<Value, String>>();
        if let Ok(mut pend) = self.pending.lock() {
            pend.insert(id, tx);
        }

        if let Err(e) = self.send_raw(&request_envelope(id, method, params)) {
            if let Ok(mut pend) = self.pending.lock() {
                pend.remove(&id);
            }
            return Err(e);
        }

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                if let Ok(mut pend) = self.pending.lock() {
                    pend.remove(&id);
                }
                Err(format!("The LSP request '{method}' timed out"))
            }
        }
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_timeout(method, params, REQUEST_TIMEOUT)
    }

    fn initialize(&self) -> Result<(), String> {
        let root_uri = self.to_server_uri(&self.workspace);
        let params = json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
            "capabilities": {
                "textDocument": {
                    "synchronization": { "didSave": true, "dynamicRegistration": false },
                    "publishDiagnostics": { "relatedInformation": true },
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "definition": { "linkSupport": false },
                    "references": {},
                    "documentSymbol": { "hierarchicalDocumentSymbolSupport": true }
                },
                "workspace": { "configuration": true, "workspaceFolders": true }
            }
        });

        self.request_timeout("initialize", params, INIT_TIMEOUT)?;
        self.notify("initialized", json!({}))?;

        if let Ok(mut st) = self.state.lock() {
            *st = ServerState::Ready;
        }
        Ok(())
    }

    pub fn did_open(&self, uri: &str, language_id: &str, version: i32, text: &str) {
        self.mark_changed(uri);
        let _ = self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": language_id,
                    "version": version,
                    "text": text
                }
            }),
        );
        if let Ok(mut docs) = self.open_docs.lock() {
            docs.insert(uri.to_string(), version);
        }
    }

    pub fn did_change(&self, uri: &str, language_id: &str, text: &str) {
        let known = self.open_docs.lock().ok().and_then(|d| d.get(uri).copied());
        match known {
            Some(prev) => {
                let version = prev + 1;
                self.mark_changed(uri);
                let _ = self.notify(
                    "textDocument/didChange",
                    json!({
                        "textDocument": { "uri": uri, "version": version },
                        "contentChanges": [{ "text": text }]
                    }),
                );
                if let Ok(mut docs) = self.open_docs.lock() {
                    docs.insert(uri.to_string(), version);
                }
            }
            None => self.did_open(uri, language_id, 1, text),
        }
    }

    /// Tells the server the file on disk now holds what it was sent (rust-analyzer only runs
    /// `cargo check` on a save).
    pub fn did_save(&self, uri: &str) {
        let _ = self.notify(
            "textDocument/didSave",
            json!({ "textDocument": { "uri": uri } }),
        );
    }

    fn mark_changed(&self, uri: &str) {
        let key = doc_key(uri);
        let now = self
            .published
            .lock()
            .ok()
            .and_then(|p| p.get(&key).copied())
            .unwrap_or(0);
        if let Ok(mut changed) = self.changed.lock() {
            changed.insert(key, now);
        }
    }

    fn note_publish(&self, uri: &str) {
        if let Ok(mut p) = self.published.lock() {
            *p.entry(doc_key(uri)).or_insert(0) += 1;
        }
        let (lock, cvar) = &*self.publish_signal;
        if let Ok(mut seq) = lock.lock() {
            *seq = seq.wrapping_add(1);
            cvar.notify_all();
        }
    }

    fn publishes_since_change(&self, key: &str) -> u64 {
        let now = self
            .published
            .lock()
            .ok()
            .and_then(|p| p.get(key).copied())
            .unwrap_or(0);
        let then = self
            .changed
            .lock()
            .ok()
            .and_then(|c| c.get(key).copied())
            .unwrap_or(0);
        now.saturating_sub(then)
    }

    /// Waits for the server to publish `uri`'s diagnostics after its last change, then for
    /// `settle` without another publish of it (a server may send a quick pass, then the full
    /// one). False when none came in `timeout`: what's stored is from before the change, or
    /// there's nothing, and neither says the file is clean.
    pub fn wait_for_file(&self, uri: &str, timeout: Duration, settle: Duration) -> bool {
        let key = doc_key(uri);
        let deadline = Instant::now() + timeout;
        let (lock, cvar) = &*self.publish_signal;
        let Ok(mut guard) = lock.lock() else {
            return false;
        };
        let mut seen = 0;
        let mut quiet_until: Option<Instant> = None;
        loop {
            let count = self.publishes_since_change(&key);
            let now = Instant::now();
            if count > seen {
                seen = count;
                quiet_until = Some(now + settle);
            }
            let until = match quiet_until {
                Some(q) if now >= q => return true,
                Some(q) => q.min(deadline),
                None => deadline,
            };
            if now >= deadline {
                return seen > 0;
            }
            match cvar.wait_timeout(guard, until - now) {
                Ok((g, _)) => guard = g,
                Err(_) => return false,
            }
        }
    }

    /// The stored diagnostics of `uri`, however the server spelled it.
    pub fn diagnostics_for(&self, uri: &str) -> HashMap<String, Vec<Diagnostic>> {
        self.get_diagnostics(Some(uri))
    }

    pub fn publish_seq(&self) -> u64 {
        let (lock, _) = &*self.publish_signal;
        lock.lock().map(|s| *s).unwrap_or(0)
    }

    pub fn wait_for_publish(&self, baseline: u64, timeout: Duration) {
        let (lock, cvar) = &*self.publish_signal;
        let mut guard = match lock.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let start = Instant::now();
        while *guard <= baseline {
            let elapsed = start.elapsed();
            if elapsed >= timeout {
                break;
            }
            match cvar.wait_timeout(guard, timeout - elapsed) {
                Ok((g, res)) => {
                    guard = g;
                    if res.timed_out() {
                        break;
                    }
                }
                Err(_) => return,
            }
        }
    }

    pub fn get_diagnostics(&self, uri: Option<&str>) -> HashMap<String, Vec<Diagnostic>> {
        let diag = match self.diagnostics.lock() {
            Ok(d) => d,
            Err(_) => return HashMap::new(),
        };
        let picked: HashMap<String, Vec<Diagnostic>> = match uri {
            Some(u) => diag
                .get(&doc_key(u))
                .map(|(published, list)| (published.clone(), list.clone()))
                .into_iter()
                .collect(),
            None => diag.values().cloned().collect(),
        };
        if self.remote.is_none() {
            return picked;
        }
        picked
            .into_iter()
            .map(|(k, v)| (self.app_uri(&k), v))
            .collect()
    }

    /// The URI the server knows a file by: `ssh://host/p` becomes `file:///p` on its machine.
    pub fn to_server_uri(&self, uri_or_path: &str) -> String {
        if uri_or_path.starts_with("file://") {
            return uri_or_path.to_string();
        }
        match crate::remote::parse(uri_or_path) {
            Some(r) => path_to_uri(&r.path),
            None => path_to_uri(uri_or_path),
        }
    }

    /// A URI from the server, as the app names that file (`ssh://` for a remote workspace).
    pub fn app_uri(&self, uri: &str) -> String {
        match &self.remote {
            Some(r) if uri.starts_with("file://") => {
                let path = super::protocol::uri_to_remote_path(uri);
                crate::remote::uri::uri(&r.host, &path)
            }
            _ => uri.to_string(),
        }
    }

    /// Every `uri`/`targetUri` in a server's answer, renamed with `app_uri`.
    pub fn app_uris(&self, mut v: Value) -> Value {
        if self.remote.is_some() {
            self.rename_uris(&mut v);
        }
        v
    }

    fn rename_uris(&self, v: &mut Value) {
        match v {
            Value::Object(map) => {
                for (k, val) in map.iter_mut() {
                    if matches!(k.as_str(), "uri" | "targetUri") {
                        if let Value::String(s) = val {
                            *s = self.app_uri(s);
                            continue;
                        }
                    }
                    self.rename_uris(val);
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|i| self.rename_uris(i)),
            _ => {}
        }
    }

    pub fn state(&self) -> ServerState {
        self.state
            .lock()
            .map(|s| s.clone())
            .unwrap_or(ServerState::Crashed("state lock poisoned".to_string()))
    }

    pub fn state_error(&self) -> Option<String> {
        match self.state() {
            ServerState::Crashed(msg) => Some(msg),
            _ => None,
        }
    }

    pub fn shutdown(&self) {
        let _ = self.request_timeout("shutdown", Value::Null, Duration::from_secs(2));
        let _ = self.notify("exit", Value::Null);
        self.kill();
    }

    /// Ends the process (and, on Windows, what it started), after a moment to exit on its own.
    fn kill(&self) {
        if let Ok(mut guard) = self.child.lock() {
            let child = match &mut *guard {
                LspChild::Remote(h) => {
                    h.kill();
                    return;
                }
                LspChild::Local(c) => c,
            };
            for _ in 0..20 {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            #[cfg(windows)]
            {
                let pid = child.id().to_string();
                let mut tk = Command::new("taskkill");
                tk.args(["/PID", &pid, "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                super::hide_console(&mut tk);
                let _ = tk.status();
            }
            let _ = child.kill();
            // Reaped, or on Unix it stays a zombie: still listed, and `kill -0` still finds it.
            let _ = child.wait();
        }
    }
}

fn spawn_reader(
    server: Arc<LspServer>,
    mut reader: BufReader<Box<dyn Read + Send>>,
    pending: PendingMap,
    diagnostics: DiagnosticsMap,
    state: Arc<Mutex<ServerState>>,
) {
    std::thread::spawn(move || loop {
        match read_message(&mut reader) {
            Ok(Some(Value::Null)) => continue,
            Ok(Some(value)) => {
                let Some(incoming) = Incoming::classify(value) else {
                    continue;
                };
                match incoming {
                    Incoming::Response { id, result } => {
                        if let Ok(mut pend) = pending.lock() {
                            if let Some(tx) = pend.remove(&id) {
                                let _ = tx.send(result);
                            }
                        }
                    }
                    Incoming::Notification { method, params } => {
                        if method == "textDocument/publishDiagnostics" {
                            handle_publish_diagnostics(&diagnostics, &params);
                            if let Some(uri) = params.get("uri").and_then(|u| u.as_str()) {
                                server.note_publish(uri);
                            }
                        }
                    }
                    Incoming::ServerRequest { id, method, .. } => {
                        let reply = server_request_reply(id, &method);
                        let _ = server.send_raw(&reply);
                    }
                }
            }
            Ok(None) | Err(_) => {
                if let Ok(mut st) = state.lock() {
                    *st = ServerState::Crashed("the LSP process exited".to_string());
                }
                if let Ok(mut pend) = pending.lock() {
                    for (_, tx) in pend.drain() {
                        let _ = tx.send(Err("the LSP server exited".to_string()));
                    }
                }
                break;
            }
        }
    });
}

/// One spelling per file for comparing URIs: decoded, without `file://`, and lowercase for a
/// Windows path (`file:///e%3A/a.ts` and `file:///E:/a.ts` are the same file).
fn doc_key(uri: &str) -> String {
    let path = super::protocol::uri_to_remote_path(uri);
    let b = path.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        path.to_lowercase()
    } else {
        path
    }
}

fn handle_publish_diagnostics(store: &DiagnosticsMap, params: &Value) {
    let Some(uri) = params.get("uri").and_then(|u| u.as_str()) else {
        return;
    };
    let list: Vec<Diagnostic> = params
        .get("diagnostics")
        .and_then(|d| d.as_array())
        .map(|arr| arr.iter().filter_map(Diagnostic::from_value).collect())
        .unwrap_or_default();
    if let Ok(mut map) = store.lock() {
        map.insert(doc_key(uri), (uri.to_string(), list));
    }
}

fn server_request_reply(id: Value, method: &str) -> Value {
    match method {
        "workspace/configuration" => response_envelope(id, json!([null])),
        "client/registerCapability"
        | "client/unregisterCapability"
        | "window/workDoneProgress/create"
        | "workspace/semanticTokens/refresh"
        | "workspace/diagnostic/refresh"
        | "workspace/codeLens/refresh" => response_envelope(id, Value::Null),
        "window/showMessageRequest" => response_envelope(id, Value::Null),
        _ => error_envelope(id, -32601, "method not implemented by the client"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A process that reads nothing and answers nothing, like a server stuck before
    /// `initialize` returns.
    fn silent_process() -> Child {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "ping -n 30 127.0.0.1 >nul"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "sleep 30"]);
            c
        };
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        super::super::hide_console(&mut cmd);
        cmd.spawn().unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn a_server_and_what_it_starts_end_with_the_app() {
        let resolved = super::super::discovery::ResolvedCommand {
            program: "cmd".into(),
            args: vec!["/C".into(), "ping -n 30 127.0.0.1 >nul".into()],
            source: "path",
        };
        let mut child = LspServer::launch("", &resolved).unwrap();
        assert!(crate::agent::cli_process::in_agent_job(child.id()));
        let _ = child.kill();
        let _ = child.wait();
    }

    fn alive(pid: u32) -> bool {
        if cfg!(windows) {
            let mut c = Command::new("tasklist");
            c.args(["/FI", &format!("PID eq {pid}"), "/NH"]);
            super::super::hide_console(&mut c);
            let out = c.output().unwrap();
            String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
        } else {
            Command::new("kill")
                .args(["-0", &pid.to_string()])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        }
    }

    /// A server on a local socket that answers `initialize` and then does what the test says.
    fn fake_server() -> (
        Arc<LspServer>,
        std::net::TcpStream,
        BufReader<std::net::TcpStream>,
    ) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let ours = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (theirs, _) = listener.accept().unwrap();
        let mut their_out = theirs.try_clone().unwrap();
        let mut their_in = BufReader::new(theirs);
        let answer = std::thread::spawn(move || {
            let init = read_message(&mut their_in).unwrap().unwrap();
            write_message(
                &mut their_out,
                &response_envelope(init["id"].clone(), json!({ "capabilities": {} })),
            )
            .unwrap();
            let initialized = read_message(&mut their_in).unwrap().unwrap();
            assert_eq!(initialized["method"], "initialized");
            (their_out, their_in)
        });
        let child = silent_process();
        let server = LspServer::start(
            "E:/proj",
            "typescript",
            "fake".into(),
            None,
            LspChild::Local(child),
            Box::new(ours.try_clone().unwrap()),
            Box::new(ours),
            None,
        )
        .unwrap();
        let (out, inp) = answer.join().unwrap();
        (server, out, inp)
    }

    fn publish(out: &mut std::net::TcpStream, uri: &str, messages: &[&str]) {
        let diags: Vec<Value> = messages
            .iter()
            .map(|m| json!({ "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } }, "severity": 1, "message": m }))
            .collect();
        write_message(
            out,
            &notify_envelope(
                "textDocument/publishDiagnostics",
                json!({ "uri": uri, "diagnostics": diags }),
            ),
        )
        .unwrap();
    }

    #[test]
    fn waits_for_the_edited_files_own_fresh_diagnostics() {
        let (server, mut out, mut inp) = fake_server();
        let uri = "file:///E:/proj/src/a.ts";
        // Diagnostics from before the edit.
        publish(&mut out, uri, &["old error"]);
        std::thread::sleep(Duration::from_millis(100));
        server.did_change(uri, "typescript", "const a = 1;");
        let short = Duration::from_millis(300);
        let settle = Duration::from_millis(50);
        assert!(
            !server.wait_for_file(uri, short, settle),
            "stale diagnostics counted as fresh"
        );
        // Another file's publish isn't this one's.
        publish(&mut out, "file:///E:/proj/src/b.ts", &[]);
        assert!(!server.wait_for_file(uri, short, settle));
        // The server's own spelling of the same file.
        publish(&mut out, "file:///e%3A/proj/src/a.ts", &["new error"]);
        assert!(server.wait_for_file(uri, Duration::from_secs(2), settle));
        let found = server.diagnostics_for(uri);
        let messages: Vec<&str> = found
            .values()
            .flatten()
            .map(|d| d.message.as_str())
            .collect();
        assert_eq!(messages, ["new error"]);

        server.did_save(uri);
        let mut methods = Vec::new();
        while let Ok(Some(msg)) = read_message(&mut inp) {
            let method = msg["method"].as_str().unwrap_or_default().to_string();
            let done = method == "textDocument/didSave";
            methods.push(method);
            if done {
                assert_eq!(msg["params"]["textDocument"]["uri"], uri);
                break;
            }
        }
        assert_eq!(
            methods.last().map(String::as_str),
            Some("textDocument/didSave")
        );
        server.kill();
    }

    #[test]
    fn a_server_that_never_initializes_is_killed() {
        let mut child = silent_process();
        let pid = child.id();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let started = LspServer::start(
            "",
            "rust",
            "silent".into(),
            None,
            LspChild::Local(child),
            Box::new(stdin),
            Box::new(stdout),
            None,
        );
        assert!(started.is_err());
        let gone = (0..40).any(|_| {
            std::thread::sleep(Duration::from_millis(50));
            !alive(pid)
        });
        assert!(gone, "the process {pid} was left running");
    }
}
