use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent::cli_process::{spawn_contained, spawn_stdin_writer};
use crate::agent::{apply_login_env, hide_console, kill_tree};

const PROTOCOL_VERSION: &str = "2025-06-18";
const START_TIMEOUT_MS: u64 = 60_000;
const REQUEST_TIMEOUT_MS: u64 = 60_000;
const STDERR_TAIL_LINES: usize = 40;
const STDERR_LINE_CHARS: usize = 2_000;
const ERROR_TAIL_LINES: usize = 8;

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StdioConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Starting,
    Ready,
    Exited,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Starting => "starting",
            Phase::Ready => "ready",
            Phase::Exited => "exited",
        }
    }
}

struct Shared {
    phase: Phase,
    error: Option<String>,
    stderr: VecDeque<String>,
    initialize: Option<Value>,
    exit_code: Option<i32>,
    stopping: bool,
}

impl Shared {
    fn tail(&self) -> String {
        let skip = self.stderr.len().saturating_sub(ERROR_TAIL_LINES);
        self.stderr
            .iter()
            .skip(skip)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn exit_text(&self, kind: &str) -> String {
        let base = if self.stopping {
            format!("{kind}: the MCP server was stopped")
        } else {
            match self.exit_code {
                Some(code) => format!("{kind}: the MCP server exited (exit code {code})"),
                None => format!("{kind}: the MCP server exited"),
            }
        };
        with_tail(base, &self.tail())
    }
}

fn with_tail(base: String, tail: &str) -> String {
    if tail.is_empty() || base.contains(tail) {
        base
    } else {
        format!("{base}\n{tail}")
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StdioStatus {
    id: String,
    command: String,
    args: Vec<String>,
    pid: u32,
    state: String,
    error: Option<String>,
    exit_code: Option<i32>,
    stderr: Vec<String>,
    started_at: u64,
    initialize: Option<Value>,
}

type Pending = Arc<Mutex<HashMap<i64, Sender<Result<Value, String>>>>>;
/// The queue of the thread that writes to the server's input (`spawn_stdin_writer`): sending
/// never blocks, so a server that stopped reading can't hold anyone who writes, stopping and
/// exiting included. Dropping it closes the input.
type Stdin = Arc<Mutex<Option<Sender<Vec<u8>>>>>;

struct StdioServer {
    id: String,
    config: StdioConfig,
    pid: u32,
    started_at: u64,
    child: Arc<Mutex<Child>>,
    stdin: Stdin,
    next_id: AtomicI64,
    pending: Pending,
    shared: Arc<Mutex<Shared>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(target_os = "windows")]
fn resolve_program(config: &StdioConfig) -> PathBuf {
    let raw = PathBuf::from(&config.command);
    if raw.extension().is_some() || raw.components().count() > 1 {
        return raw;
    }
    let path_var = config
        .env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| std::ffi::OsString::from(v))
        .or_else(|| std::env::var_os("PATH"));
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| !e.is_empty())
        .collect();
    if let Some(path_var) = path_var {
        for dir in std::env::split_paths(&path_var) {
            for ext in &exts {
                let candidate = dir.join(format!("{}{}", config.command, ext));
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    raw
}

#[cfg(not(target_os = "windows"))]
fn resolve_program(config: &StdioConfig) -> PathBuf {
    PathBuf::from(&config.command)
}

fn build_command(config: &StdioConfig) -> Command {
    let mut cmd = Command::new(resolve_program(config));
    cmd.args(&config.args);
    apply_login_env(&mut cmd);
    for (k, v) in &config.env {
        cmd.env(k, v);
    }
    if let Some(dir) = config.cwd.as_deref().filter(|d| !d.trim().is_empty()) {
        cmd.current_dir(dir);
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    hide_console(&mut cmd);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

fn push_stderr(shared: &Mutex<Shared>, line: &str) {
    let text: String = line.chars().take(STDERR_LINE_CHARS).collect();
    let mut s = lock(shared);
    if s.stderr.len() >= STDERR_TAIL_LINES {
        s.stderr.pop_front();
    }
    s.stderr.push_back(text);
}

fn write_line(stdin: &Mutex<Option<Sender<Vec<u8>>>>, message: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    line.push('\n');
    let guard = lock(stdin);
    let queue = guard
        .as_ref()
        .ok_or_else(|| "NOT_RUNNING: the MCP server's input is closed".to_string())?;
    // Fails once the writer gave up on a pipe that broke.
    queue
        .send(line.into_bytes())
        .map_err(|_| "NOT_RUNNING: couldn't write to the MCP server".to_string())
}

fn rpc_error_text(error: &Value) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown error");
    match error.get("code").and_then(Value::as_i64) {
        Some(code) => format!("{message} (code {code})"),
        None => message.to_string(),
    }
}

fn answer_server_request(method: &str, id: Value) -> Value {
    match method {
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "roots/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "roots": [] } }),
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Method not supported by client: {method}") }
        }),
    }
}

fn dispatch(message: Value, pending: &Pending, stdin: &Mutex<Option<Sender<Vec<u8>>>>) {
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id").filter(|v| !v.is_null()).cloned();
    match (method, id) {
        (Some(method), Some(id)) => {
            let _ = write_line(stdin, &answer_server_request(method, id));
        }
        (None, Some(id)) => {
            let Some(key) = id
                .as_i64()
                .or_else(|| id.as_str().and_then(|s| s.parse().ok()))
            else {
                return;
            };
            let Some(tx) = lock(pending).remove(&key) else {
                return;
            };
            let outcome = match message.get("error") {
                Some(error) => Err(rpc_error_text(error)),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = tx.send(outcome);
        }
        _ => {}
    }
}

fn read_stdout<R: Read>(stdout: R, pending: &Pending, stdin: &Stdin, shared: &Mutex<Shared>) {
    let mut reader = BufReader::new(stdout);
    let mut raw = Vec::new();
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let text = String::from_utf8_lossy(&raw);
        let line = text.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(Value::Array(batch)) => {
                for message in batch {
                    dispatch(message, pending, stdin);
                }
            }
            Ok(message) => dispatch(message, pending, stdin),
            Err(_) => push_stderr(shared, line),
        }
    }
}

fn read_stderr<R: Read>(stderr: R, label: &str, shared: &Mutex<Shared>) {
    let mut reader = BufReader::new(stderr);
    let mut raw = Vec::new();
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let text = String::from_utf8_lossy(&raw);
        let line = text.trim_end();
        if !line.trim().is_empty() {
            log::debug!("[{label}] {line}");
            push_stderr(shared, line);
        }
    }
}

fn settle_exit(
    child: &Mutex<Child>,
    shared: &Mutex<Shared>,
    pending: &Pending,
    stderr_done: &AtomicBool,
) {
    let start = Instant::now();
    while !stderr_done.load(Ordering::Acquire) && start.elapsed() < Duration::from_secs(1) {
        std::thread::sleep(Duration::from_millis(10));
    }
    let start = Instant::now();
    let code = loop {
        let mut guard = lock(child);
        match guard.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if start.elapsed() < Duration::from_secs(2) => {}
            Ok(None) => {
                kill_tree(&mut guard);
                break guard.wait().ok().and_then(|s| s.code());
            }
            Err(_) => break None,
        }
        drop(guard);
        std::thread::sleep(Duration::from_millis(20));
    };
    let message = {
        let mut s = lock(shared);
        s.phase = Phase::Exited;
        s.exit_code = code;
        let text = s.exit_text("EXITED");
        if !s.stopping && s.error.is_none() {
            s.error = Some(text.clone());
        }
        text
    };
    for (_, tx) in lock(pending).drain() {
        let _ = tx.send(Err(message.clone()));
    }
}

impl StdioServer {
    fn spawn(id: &str, config: StdioConfig) -> Result<Arc<StdioServer>, String> {
        // Inside the agent's job on Windows: it and what it starts (npx's node) end with Nyxs
        // even when Nyxs ends without its normal exit.
        let mut child = spawn_contained(&mut build_command(&config))
            .map_err(|e| format!("Couldn't launch \"{}\": {e}", config.command))?;
        let stdin = child.stdin.take().map(spawn_stdin_writer);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let server = Arc::new(StdioServer {
            id: id.to_string(),
            config,
            pid: child.id(),
            started_at: now_ms(),
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            next_id: AtomicI64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            shared: Arc::new(Mutex::new(Shared {
                phase: Phase::Starting,
                error: None,
                stderr: VecDeque::new(),
                initialize: None,
                exit_code: None,
                stopping: false,
            })),
        });

        let stderr_done = Arc::new(AtomicBool::new(stderr.is_none()));
        if let Some(stderr) = stderr {
            let shared = server.shared.clone();
            let done = stderr_done.clone();
            let label = format!("mcp:{id}");
            std::thread::spawn(move || {
                read_stderr(stderr, &label, &shared);
                done.store(true, Ordering::Release);
            });
        }

        let child = server.child.clone();
        let stdin = server.stdin.clone();
        let pending = server.pending.clone();
        let shared = server.shared.clone();
        std::thread::spawn(move || {
            if let Some(stdout) = stdout {
                read_stdout(stdout, &pending, &stdin, &shared);
            }
            lock(&stdin).take();
            settle_exit(&child, &shared, &pending, &stderr_done);
        });

        Ok(server)
    }

    fn phase(&self) -> Phase {
        lock(&self.shared).phase
    }

    fn exit_text(&self, kind: &str) -> String {
        lock(&self.shared).exit_text(kind)
    }

    fn describe(&self, base: String) -> String {
        let tail = lock(&self.shared).tail();
        with_tail(base, &tail)
    }

    fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut message = json!({ "jsonrpc": "2.0", "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        write_line(&self.stdin, &message)
    }

    fn request(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        if self.phase() == Phase::Exited {
            return Err(self.exit_text("NOT_RUNNING"));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        lock(&self.pending).insert(id, tx);
        if self.phase() == Phase::Exited {
            lock(&self.pending).remove(&id);
            return Err(self.exit_text("NOT_RUNNING"));
        }
        let mut message = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        if let Err(e) = write_line(&self.stdin, &message) {
            lock(&self.pending).remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(outcome) => outcome,
            Err(RecvTimeoutError::Timeout) => {
                lock(&self.pending).remove(&id);
                let _ = self.notify(
                    "notifications/cancelled",
                    Some(json!({ "requestId": id, "reason": "timeout" })),
                );
                Err(format!(
                    "TIMEOUT: \"{method}\" got no response after {} ms",
                    timeout.as_millis()
                ))
            }
            Err(RecvTimeoutError::Disconnected) => Err(self.exit_text("EXITED")),
        }
    }

    /// Ends the server: killed first, its input closed after, so a write stuck on a server that
    /// stopped reading ends with it instead of holding the stop.
    fn shutdown(&self) {
        lock(&self.shared).stopping = true;
        {
            let mut child = lock(&self.child);
            if matches!(child.try_wait(), Ok(None)) {
                kill_tree(&mut child);
                let _ = child.wait();
            }
        }
        lock(&self.stdin).take();
    }

    fn status(&self) -> StdioStatus {
        let s = lock(&self.shared);
        StdioStatus {
            id: self.id.clone(),
            command: self.config.command.clone(),
            args: self.config.args.clone(),
            pid: self.pid,
            state: s.phase.as_str().to_string(),
            error: s.error.clone(),
            exit_code: s.exit_code,
            stderr: s.stderr.iter().cloned().collect(),
            started_at: self.started_at,
            initialize: s.initialize.clone(),
        }
    }
}

fn servers() -> &'static Mutex<HashMap<String, Arc<StdioServer>>> {
    static SERVERS: OnceLock<Mutex<HashMap<String, Arc<StdioServer>>>> = OnceLock::new();
    SERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn gate(id: &str) -> Arc<Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    lock(GATES.get_or_init(|| Mutex::new(HashMap::new())))
        .entry(id.to_string())
        .or_default()
        .clone()
}

fn start_blocking(
    id: String,
    config: StdioConfig,
    timeout_ms: Option<u64>,
) -> Result<StdioStatus, String> {
    if config.command.trim().is_empty() {
        return Err(format!("The MCP server \"{id}\" has no command"));
    }
    let gate = gate(&id);
    let _held = lock(&gate);
    let existing = lock(servers()).get(&id).cloned();
    if let Some(server) = existing {
        if server.config == config && server.phase() == Phase::Ready {
            return Ok(server.status());
        }
        lock(servers()).remove(&id);
        server.shutdown();
    }

    let server = StdioServer::spawn(&id, config)?;
    lock(servers()).insert(id.clone(), server.clone());
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(START_TIMEOUT_MS));
    let params = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "Nyxs", "version": env!("CARGO_PKG_VERSION") }
    });
    let handshake = server
        .request("initialize", Some(params), timeout)
        .and_then(|init| {
            server
                .notify("notifications/initialized", None)
                .map(|_| init)
        });
    match handshake {
        Ok(init) => {
            let mut s = lock(&server.shared);
            s.phase = Phase::Ready;
            s.initialize = Some(init);
        }
        Err(e) => {
            let detail = server.describe(e);
            lock(&server.shared).error = Some(detail.clone());
            server.shutdown();
            return Err(detail);
        }
    }
    Ok(server.status())
}

fn request_blocking(
    id: String,
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    drop(lock(&gate(&id)));
    let server = lock(servers())
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("NOT_RUNNING: the MCP server \"{id}\" isn't running"))?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(REQUEST_TIMEOUT_MS));
    server.request(&method, params, timeout)
}

fn stop_blocking(id: String) -> bool {
    let gate = gate(&id);
    let _held = lock(&gate);
    let removed = lock(servers()).remove(&id);
    match removed {
        Some(server) => {
            server.shutdown();
            true
        }
        None => false,
    }
}

#[cfg(test)]
fn list() -> Vec<StdioStatus> {
    let all: Vec<Arc<StdioServer>> = lock(servers()).values().cloned().collect();
    let mut statuses: Vec<StdioStatus> = all.iter().map(|s| s.status()).collect();
    statuses.sort_by(|a, b| a.id.cmp(&b.id));
    statuses
}

/// How long stopping every server may take, all at once: quitting stops Claude Code, the CLIs and
/// the terminals after them, within the exit's deadline.
const SHUTDOWN_ALL_WAIT: Duration = Duration::from_secs(2);

/// Stops every server, each on its own thread, so one that won't end can't hold the rest nor
/// what the app stops after them.
pub fn shutdown_all() {
    let all: Vec<Arc<StdioServer>> = lock(servers()).drain().map(|(_, s)| s).collect();
    let stopping: Vec<_> = all
        .into_iter()
        .map(|server| std::thread::spawn(move || server.shutdown()))
        .collect();
    let started = Instant::now();
    while !stopping.iter().all(|t| t.is_finished()) && started.elapsed() < SHUTDOWN_ALL_WAIT {
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[tauri::command]
pub async fn mcp_stdio_start(
    id: String,
    config: StdioConfig,
    timeout_ms: Option<u64>,
) -> Result<StdioStatus, String> {
    tauri::async_runtime::spawn_blocking(move || start_blocking(id, config, timeout_ms))
        .await
        .map_err(|e| format!("Couldn't start the MCP server: {e}"))?
}

#[tauri::command]
pub async fn mcp_stdio_request(
    id: String,
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || request_blocking(id, method, params, timeout_ms))
        .await
        .map_err(|e| format!("Couldn't talk to the MCP server: {e}"))?
}

#[tauri::command]
pub async fn mcp_stdio_stop(id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || stop_blocking(id))
        .await
        .map_err(|e| format!("Couldn't stop the MCP server: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Generous on purpose: they catch hangs, not slowness. On a fresh GitHub Windows runner the
    // first `node` launches took over 20 s (cold disk), the later ones about 5 s.
    const START_MS: u64 = 60_000;
    const CALL_MS: u64 = 30_000;

    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/mcp_echo_server.mjs"
    );

    fn echo_config() -> StdioConfig {
        StdioConfig {
            command: "node".into(),
            args: vec![FIXTURE.into()],
            env: HashMap::from([("MCP_TEST_TOKEN".to_string(), "s3cret".to_string())]),
            cwd: None,
        }
    }

    fn call(id: &str, tool: &str, timeout_ms: u64) -> Result<Value, String> {
        request_blocking(
            id.to_string(),
            "tools/call".into(),
            Some(json!({ "name": tool, "arguments": { "text": "hello" } })),
            Some(timeout_ms),
        )
    }

    fn first_text(result: &Value) -> String {
        result["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    fn status_of(id: &str) -> Option<StdioStatus> {
        list().into_iter().find(|s| s.id == id)
    }

    fn wait_until(mut check: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if check() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[cfg(target_os = "windows")]
    fn process_alive(pid: u32) -> bool {
        let mut cmd = Command::new("tasklist");
        cmd.args(["/FI", &format!("PID eq {pid}"), "/NH"]);
        hide_console(&mut cmd);
        cmd.output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }

    #[cfg(not(target_os = "windows"))]
    fn process_alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    /// A server that neither reads its input nor exits, as a stuck one does.
    fn stuck_config() -> StdioConfig {
        #[cfg(target_os = "windows")]
        let (command, args) = ("cmd.exe", vec!["/c", "ping -n 30 127.0.0.1 >nul"]);
        #[cfg(not(target_os = "windows"))]
        let (command, args) = ("sh", vec!["-c", "sleep 30"]);
        StdioConfig {
            command: command.into(),
            args: args.into_iter().map(String::from).collect(),
            env: HashMap::new(),
            cwd: None,
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_server_and_what_it_starts_end_with_the_app() {
        let server = StdioServer::spawn("test-mcp-contained", stuck_config()).unwrap();
        assert!(crate::agent::cli_process::in_agent_job(server.pid));
        server.shutdown();
    }

    #[test]
    fn stopping_a_server_that_stopped_reading_its_input_doesnt_hang() {
        let server = StdioServer::spawn("test-mcp-stuck", stuck_config()).unwrap();
        let pid = server.pid;
        // More than any pipe holds: writing it all can only end once the process is gone.
        let big = json!({ "blob": "x".repeat(4 << 20) });
        let sender = server.clone();
        std::thread::spawn(move || {
            let _ = sender.notify("notifications/message", Some(big));
        });
        std::thread::sleep(Duration::from_millis(300));
        let (tx, rx) = channel();
        let stopping = server.clone();
        std::thread::spawn(move || {
            stopping.shutdown();
            let _ = tx.send(());
        });
        assert!(
            rx.recv_timeout(Duration::from_secs(10)).is_ok(),
            "shutdown waited on the stuck write"
        );
        assert!(wait_until(|| !process_alive(pid)));
    }

    #[test]
    fn handshake_lists_and_calls_tools() {
        let id = "test-mcp-basic";
        let status = start_blocking(id.into(), echo_config(), Some(START_MS)).unwrap();
        assert_eq!(status.state, "ready");
        assert_eq!(
            status.initialize.as_ref().unwrap()["serverInfo"]["name"],
            "echo-test"
        );

        let tools = request_blocking(
            id.into(),
            "tools/list".into(),
            Some(json!({})),
            Some(CALL_MS),
        )
        .unwrap();
        let names: Vec<&str> = tools["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names.contains(&"echo"));
        assert_eq!(first_text(&call(id, "echo", CALL_MS).unwrap()), "hello");
        assert_eq!(first_text(&call(id, "env", CALL_MS).unwrap()), "s3cret");
        let unknown =
            request_blocking(id.into(), "bogus/method".into(), None, Some(CALL_MS)).unwrap_err();
        assert!(unknown.contains("-32601"), "{unknown}");

        assert!(wait_until(|| {
            let stderr = status_of(id).map(|s| s.stderr).unwrap_or_default();
            stderr.iter().any(|l| l.contains("echo-test ready"))
                && stderr.iter().any(|l| l.contains("banner"))
        }));

        assert!(stop_blocking(id.into()));
        let err = request_blocking(id.into(), "tools/list".into(), None, Some(2_000)).unwrap_err();
        assert!(err.starts_with("NOT_RUNNING"), "{err}");
    }

    #[test]
    fn start_reuses_session_and_restarts_on_config_change() {
        let id = "test-mcp-reuse";
        let first = start_blocking(id.into(), echo_config(), Some(START_MS)).unwrap();
        let again = start_blocking(id.into(), echo_config(), Some(START_MS)).unwrap();
        assert_eq!(first.pid, again.pid);

        let mut changed = echo_config();
        changed.env.insert("MCP_TEST_TOKEN".into(), "other".into());
        let restarted = start_blocking(id.into(), changed, Some(START_MS)).unwrap();
        assert_ne!(first.pid, restarted.pid);
        assert_eq!(first_text(&call(id, "env", CALL_MS).unwrap()), "other");
        assert!(stop_blocking(id.into()));
    }

    #[test]
    fn timeout_does_not_break_the_session() {
        let id = "test-mcp-timeout";
        start_blocking(id.into(), echo_config(), Some(START_MS)).unwrap();
        let err = call(id, "hang", 300).unwrap_err();
        assert!(err.starts_with("TIMEOUT"), "{err}");
        assert_eq!(first_text(&call(id, "echo", CALL_MS).unwrap()), "hello");
        assert!(stop_blocking(id.into()));
    }

    #[test]
    fn answers_requests_from_the_server() {
        let id = "test-mcp-roundtrip";
        start_blocking(id.into(), echo_config(), Some(START_MS)).unwrap();
        assert_eq!(first_text(&call(id, "roundtrip", CALL_MS).unwrap()), "pong");
        assert!(stop_blocking(id.into()));
    }

    #[test]
    fn crash_is_reported_and_start_recovers() {
        let id = "test-mcp-crash";
        let first = start_blocking(id.into(), echo_config(), Some(START_MS)).unwrap();
        let err = call(id, "crash", CALL_MS).unwrap_err();
        assert!(err.starts_with("EXITED"), "{err}");
        assert!(err.contains("boom"), "{err}");

        let status = status_of(id).unwrap();
        assert_eq!(status.state, "exited");
        assert_eq!(status.exit_code, Some(3));
        assert!(status.error.unwrap_or_default().contains("boom"));
        let after = call(id, "echo", CALL_MS).unwrap_err();
        assert!(after.starts_with("NOT_RUNNING"), "{after}");

        let again = start_blocking(id.into(), echo_config(), Some(START_MS)).unwrap();
        assert_eq!(again.state, "ready");
        assert_ne!(first.pid, again.pid);
        assert!(stop_blocking(id.into()));
    }

    #[test]
    fn stop_kills_the_whole_process_tree() {
        let id = "test-mcp-tree";
        start_blocking(id.into(), echo_config(), Some(START_MS)).unwrap();
        let grandchild: u32 = first_text(&call(id, "spawn_child", CALL_MS).unwrap())
            .parse()
            .unwrap();
        assert!(process_alive(grandchild));
        assert!(stop_blocking(id.into()));
        assert!(wait_until(|| !process_alive(grandchild)));
    }

    #[test]
    #[ignore]
    fn real_filesystem_server_via_npx() {
        let dir = std::env::temp_dir().join("nyxs-mcp-fs-test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("hello.txt"), "hello from nyxs").unwrap();
        let dir = dir.to_string_lossy().into_owned();
        let id = "test-mcp-real-fs";
        let config = StdioConfig {
            command: "npx".into(),
            args: vec![
                "-y".into(),
                "@modelcontextprotocol/server-filesystem".into(),
                dir.clone(),
            ],
            ..Default::default()
        };
        let status = start_blocking(id.into(), config, Some(180_000)).unwrap();
        assert_eq!(status.state, "ready");

        let tools = request_blocking(
            id.into(),
            "tools/list".into(),
            Some(json!({})),
            Some(30_000),
        )
        .unwrap();
        let names: Vec<&str> = tools["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names.contains(&"list_directory"), "{names:?}");

        let listing = request_blocking(
            id.into(),
            "tools/call".into(),
            Some(json!({ "name": "list_directory", "arguments": { "path": dir } })),
            Some(30_000),
        )
        .unwrap();
        assert!(first_text(&listing).contains("hello.txt"), "{listing}");
        assert!(stop_blocking(id.into()));
    }

    #[test]
    fn missing_command_fails_with_a_clear_error() {
        let config = StdioConfig {
            command: "nyxs-definitely-missing-mcp-binary".into(),
            ..Default::default()
        };
        let err = start_blocking("test-mcp-missing".into(), config, Some(5_000)).unwrap_err();
        assert!(err.contains("nyxs-definitely-missing-mcp-binary"), "{err}");
    }
}
