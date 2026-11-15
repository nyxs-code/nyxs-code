//! Processes on a remote machine: commands run to the end (`exec`) and long-lived ones
//! (`RemoteChild`) whose output streams back. A `RemoteChild` reads and writes like a local
//! `std::process::Child`, so code that drives a child's pipes works with either.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;
use serde_json::json;

use super::conn::{ProcEvent, RemoteError};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    /// The output was longer than the helper keeps: its middle was left out (marked in the text).
    #[serde(default)]
    pub clipped: bool,
}

pub struct Exec<'a> {
    pub command: Option<&'a str>,
    pub argv: Option<Vec<String>>,
    pub cwd: Option<&'a str>,
    pub env: Option<&'a HashMap<String, String>>,
    pub timeout_ms: Option<u64>,
    pub run_id: Option<&'a str>,
}

/// Run ids of remote commands in flight, so a cancel finds which machine to tell.
fn remote_runs() -> &'static Mutex<HashMap<String, String>> {
    static R: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

pub fn exec(host: &str, e: Exec) -> Result<ExecResult, RemoteError> {
    exec_with_stdin(host, e, None)
}

/// `exec` with `stdin` fed to the command (a hook's JSON input).
pub fn exec_with_stdin(
    host: &str,
    e: Exec,
    stdin: Option<&[u8]>,
) -> Result<ExecResult, RemoteError> {
    let mut req = json!({});
    if let Some(data) = stdin {
        req["stdin"] = json!(base64::engine::general_purpose::STANDARD.encode(data));
    }
    if let Some(c) = e.command {
        req["command"] = json!(c);
    }
    if let Some(a) = &e.argv {
        req["argv"] = json!(a);
    }
    if let Some(c) = e.cwd {
        req["cwd"] = json!(c);
    }
    if let Some(env) = e.env {
        req["env"] = json!(env);
    }
    if let Some(t) = e.timeout_ms {
        req["timeoutMs"] = json!(t);
    }
    if let Some(id) = e.run_id {
        req["runId"] = json!(id);
        remote_runs()
            .lock()
            .unwrap()
            .insert(id.to_string(), host.to_string());
    }
    // The helper enforces the command's own timeout; this one only catches a machine that
    // stopped answering altogether.
    let patience = e
        .timeout_ms
        .map(|t| Duration::from_millis(t) + Duration::from_secs(30));
    let res = super::call_with(host, "exec", req, patience);
    if let Some(id) = e.run_id {
        remote_runs().lock().unwrap().remove(id);
    }
    let out: ExecResult =
        serde_json::from_value(res?).map_err(|e| RemoteError::new("protocol", e.to_string()))?;
    // The text says where its middle was left out; the log says it happened at all.
    if out.clipped {
        log::warn!("{host}: a command printed more than the helper keeps; its middle was cut");
    }
    Ok(out)
}

/// What a command run with `exec_bytes` left: its exit code (-1 when it had none), its output
/// byte for byte and its error output.
pub struct BytesResult {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// Runs `argv` on the machine to the end, with `stdin` fed to it, and returns its output as
/// bytes (a file's content from git, a binary patch), not as text. Output too big for the
/// helper to send whole is an error rather than a cut file.
pub fn exec_bytes(
    host: &str,
    argv: &[String],
    cwd: Option<&str>,
    env: Option<&HashMap<String, String>>,
    stdin: Option<&[u8]>,
) -> Result<BytesResult, RemoteError> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut req = json!({ "argv": argv, "binary": true, "timeoutMs": 600_000 });
    if let Some(c) = cwd {
        req["cwd"] = json!(c);
    }
    if let Some(env) = env {
        req["env"] = json!(env);
    }
    if let Some(data) = stdin {
        req["stdin"] = json!(b64.encode(data));
    }
    let v = super::call_with(host, "exec", req, Some(Duration::from_secs(630)))?;
    if v.get("clipped").and_then(serde_json::Value::as_bool) == Some(true) {
        return Err(RemoteError::new(
            "tooBig",
            format!("{} printed more than the helper can send", argv.join(" ")),
        ));
    }
    let stdout = v
        .get("stdoutB64")
        .and_then(serde_json::Value::as_str)
        .map(|s| b64.decode(s))
        .transpose()
        .map_err(|e| RemoteError::new("protocol", e.to_string()))?
        .unwrap_or_default();
    Ok(BytesResult {
        code: v
            .get("code")
            .and_then(serde_json::Value::as_i64)
            .map_or(-1, |c| c as i32),
        stdout,
        stderr: v
            .get("stderr")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

/// A request about something already running on `host`, over the open connection only. When
/// that dropped, what ran there went with the helper, and dialing again to stop it could open a
/// password dialog nobody asked for.
fn call_open(
    host: &str,
    op: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, RemoteError> {
    match super::existing(host) {
        Some(c) => c.call(op, params, Some(Duration::from_secs(60))),
        None => Err(RemoteError::new(
            "disconnected",
            "The connection to the remote machine was lost.",
        )),
    }
}

/// Stops a remote command started with a run id. False when no remote command has that id.
pub fn cancel(run_id: &str) -> bool {
    let host = remote_runs().lock().unwrap().get(run_id).cloned();
    match host {
        Some(host) => {
            let _ = call_open(&host, "cancel", json!({ "runId": run_id }));
            true
        }
        None => false,
    }
}

static NEXT_PROC: AtomicU64 = AtomicU64::new(1);

type Exit = Arc<(Mutex<Option<Option<i32>>>, Condvar)>;

pub struct RemoteChild {
    pub host: String,
    pub id: String,
    pub stdout: Option<PipeReader>,
    pub stderr: Option<PipeReader>,
    pub stdin: Option<RemoteStdin>,
    exit: Exit,
}

pub struct PipeReader {
    rx: mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}

impl Read for PipeReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.buf.len() {
            match self.rx.recv() {
                Ok(chunk) => {
                    self.buf = chunk;
                    self.pos = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

pub struct RemoteStdin {
    host: String,
    id: String,
    buf: Vec<u8>,
}

impl Write for RemoteStdin {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(data);
        if self.buf.len() >= 64 * 1024 {
            self.flush()?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let data = base64::engine::general_purpose::STANDARD.encode(&self.buf);
        self.buf.clear();
        call_open(
            &self.host,
            "stdin",
            json!({ "proc": self.id, "data": data }),
        )
        .map(|_| ())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::BrokenPipe, e.message))
    }
}

impl Drop for RemoteStdin {
    fn drop(&mut self) {
        let _ = self.flush();
        let host = self.host.clone();
        let id = self.id.clone();
        std::thread::spawn(move || {
            let _ = call_open(&host, "stdin", json!({ "proc": id, "close": true }));
        });
    }
}

pub struct Spawn<'a> {
    pub command: Option<&'a str>,
    pub argv: Option<Vec<String>>,
    pub cwd: Option<&'a str>,
    pub env: Option<&'a HashMap<String, String>>,
    pub stdin: bool,
    /// Keep the user's prompts possible (no CI=1 and friends): for agent CLIs.
    pub interactive: bool,
}

fn live() -> &'static Mutex<HashMap<String, String>> {
    static L: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    L.get_or_init(Default::default)
}

pub fn spawn(host: &str, s: Spawn) -> Result<RemoteChild, RemoteError> {
    let conn = super::conn(host)?;
    let id = format!("p{}", NEXT_PROC.fetch_add(1, Ordering::Relaxed));
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    let (err_tx, err_rx) = mpsc::channel::<Vec<u8>>();
    let exit: Exit = Arc::new((Mutex::new(None), Condvar::new()));
    {
        // Registered before the request goes out: a quick process can print and end before
        // the answer to `spawn` arrives.
        let exit = exit.clone();
        let mut out_tx = Some(out_tx);
        let mut err_tx = Some(err_tx);
        let id_done = id.clone();
        conn.on_proc(
            &id,
            Box::new(move |ev| match ev {
                ProcEvent::Out { stderr, data } => {
                    let tx = if stderr { &err_tx } else { &out_tx };
                    if let Some(tx) = tx {
                        let _ = tx.send(data);
                    }
                }
                ProcEvent::Exit { code } => {
                    out_tx = None;
                    err_tx = None;
                    live().lock().unwrap().remove(&id_done);
                    let (lock, cv) = &*exit;
                    *lock.lock().unwrap() = Some(code);
                    cv.notify_all();
                }
            }),
        );
    }
    let mut req = json!({ "proc": id, "stdin": s.stdin, "interactive": s.interactive });
    if let Some(c) = s.command {
        req["command"] = json!(c);
    }
    if let Some(a) = &s.argv {
        req["argv"] = json!(a);
    }
    if let Some(c) = s.cwd {
        req["cwd"] = json!(c);
    }
    if let Some(env) = s.env {
        req["env"] = json!(env);
    }
    let answer = conn.call("spawn", req, Some(Duration::from_secs(30)));
    if let Err(e) = answer {
        conn.drop_proc(&id);
        return Err(e);
    }
    live().lock().unwrap().insert(id.clone(), host.to_string());
    Ok(RemoteChild {
        host: host.to_string(),
        stdout: Some(PipeReader {
            rx: out_rx,
            buf: Vec::new(),
            pos: 0,
        }),
        stderr: Some(PipeReader {
            rx: err_rx,
            buf: Vec::new(),
            pos: 0,
        }),
        stdin: s.stdin.then(|| RemoteStdin {
            host: host.to_string(),
            id: id.clone(),
            buf: Vec::new(),
        }),
        id,
        exit,
    })
}

impl RemoteChild {
    pub fn wait_timeout(&self, t: Duration) -> Option<Option<i32>> {
        let (lock, cv) = &*self.exit;
        let g = lock.lock().unwrap();
        let (g, _) = cv.wait_timeout_while(g, t, |v| v.is_none()).unwrap();
        *g
    }

    /// A handle that can kill or watch this process after its pipes were taken.
    pub fn handle(&self) -> RemoteHandle {
        RemoteHandle {
            host: self.host.clone(),
            id: self.id.clone(),
            exit: self.exit.clone(),
        }
    }
}

#[derive(Clone)]
pub struct RemoteHandle {
    host: String,
    id: String,
    exit: Exit,
}

impl RemoteHandle {
    pub fn try_wait(&self) -> Option<Option<i32>> {
        *self.exit.0.lock().unwrap()
    }

    pub fn kill(&self) {
        if self.try_wait().is_some() {
            return;
        }
        let _ = call_open(&self.host, "kill", json!({ "proc": self.id }));
    }
}

pub fn shutdown_all() {
    let all: Vec<(String, String)> = live().lock().unwrap().drain().collect();
    for (id, host) in all {
        if let Some(c) = super::existing(&host) {
            let _ = c.call("kill", json!({ "proc": id }), Some(Duration::from_secs(2)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_when_the_output_was_cut() {
        let cut: ExecResult = serde_json::from_value(json!({
            "stdout": "head
… [9 bytes of output omitted] …
tail",
            "stderr": "",
            "code": 0,
            "timedOut": false,
            "cancelled": false,
            "clipped": true,
        }))
        .unwrap();
        assert!(cut.clipped);
        // A helper from before the field: nothing was cut.
        let old: ExecResult = serde_json::from_value(json!({
            "stdout": "", "stderr": "", "code": 0, "timedOut": false, "cancelled": false,
        }))
        .unwrap();
        assert!(!old.clipped);
    }

    #[test]
    fn cleaning_up_never_opens_a_connection() {
        // A machine this run never connected to (or whose connection dropped): stopping what
        // ran there must not dial it, which could open a password dialog nobody asked for.
        let host = "nyxs-cleanup-test.invalid";
        remote_runs()
            .lock()
            .unwrap()
            .insert("cleanup-run".into(), host.into());
        assert!(cancel("cleanup-run"));
        RemoteHandle {
            host: host.into(),
            id: "p-cleanup".into(),
            exit: Arc::new((Mutex::new(None), Condvar::new())),
        }
        .kill();
        let mut stdin = RemoteStdin {
            host: host.into(),
            id: "p-cleanup".into(),
            buf: Vec::new(),
        };
        let _ = stdin.write_all(b"left over");
        assert!(stdin.flush().is_err());
        drop(stdin);
        // Closing stdin happens on a thread of its own.
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            !super::super::slots().lock().unwrap().contains_key(host),
            "a cleanup tried to connect"
        );
    }
}
