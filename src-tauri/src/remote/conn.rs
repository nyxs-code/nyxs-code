//! One SSH connection to a machine, with the helper running at the other end: requests go
//! out as JSON lines and each answer is matched back by its id; process output and change
//! notices arrive as events and go to whoever registered for them.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::ssh;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub version: String,
    pub protocol: u32,
    /// `linux`, `macos` or `windows`.
    pub os: String,
    pub arch: String,
    /// The user's home folder there, with forward slashes.
    pub home: String,
    pub shell: String,
    pub hostname: String,
    pub user: String,
}

#[derive(Debug, Clone)]
pub struct RemoteError {
    pub kind: String,
    pub message: String,
}

impl RemoteError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        RemoteError {
            kind: kind.into(),
            message: message.into(),
        }
    }

    pub fn is_not_found(&self) -> bool {
        self.kind == "notFound"
    }
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<RemoteError> for String {
    fn from(e: RemoteError) -> String {
        e.message
    }
}

pub enum ProcEvent {
    Out { stderr: bool, data: Vec<u8> },
    Exit { code: Option<i32> },
}

type Reply = Result<Value, RemoteError>;
type ProcHandler = Box<dyn FnMut(ProcEvent) + Send>;
type WatchHandler = Arc<dyn Fn() + Send + Sync>;

pub struct Conn {
    pub info: HostInfo,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Reply>>>>,
    procs: Arc<Mutex<HashMap<String, ProcHandler>>>,
    watches: Arc<Mutex<HashMap<String, WatchHandler>>>,
    next: AtomicU64,
    alive: Arc<AtomicBool>,
}

/// Why a start failed: the helper isn't there (install it and try again) or the connection
/// itself failed (tell the user).
pub enum StartError {
    NoHelper(String),
    Ssh(String),
}

fn last_lines(buf: &Mutex<VecDeque<String>>) -> String {
    buf.lock()
        .map(|b| b.iter().cloned().collect::<Vec<_>>().join("\n"))
        .unwrap_or_default()
}

impl Conn {
    /// Starts `helper serve` on the machine and waits for it to say it's ready.
    pub fn start(
        host: &str,
        helper_command: &str,
        protocol: u32,
        on_lost: Box<dyn Fn() + Send>,
    ) -> Result<Arc<Conn>, StartError> {
        let mut child = ssh::command(host, helper_command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                StartError::Ssh(format!("Couldn't start ssh: {e}. Is OpenSSH installed?"))
            })?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let err_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        {
            let tail = err_tail.clone();
            let host = host.to_string();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    // The helper's own notes (a watch that fell back to polling); the rest is
                    // ssh's, kept only for the error if the connection fails.
                    if line.starts_with("nyxs-remote:") {
                        log::warn!("{host}: {line}");
                    }
                    if let Ok(mut t) = tail.lock() {
                        t.push_back(line);
                        if t.len() > 30 {
                            t.pop_front();
                        }
                    }
                }
            });
        }

        // The first JSON line is the helper's `ready`. Anything a login script prints before
        // it is skipped.
        let (ready_tx, ready_rx) = mpsc::channel::<Option<Value>>();
        let pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Reply>>>> = Default::default();
        let procs: Arc<Mutex<HashMap<String, ProcHandler>>> = Default::default();
        let watches: Arc<Mutex<HashMap<String, WatchHandler>>> = Default::default();
        let alive = Arc::new(AtomicBool::new(true));
        {
            let pending = pending.clone();
            let procs = procs.clone();
            let watches = watches.clone();
            let alive = alive.clone();
            std::thread::spawn(move || {
                read_loop(stdout, ready_tx, &pending, &procs, &watches);
                alive.store(false, Ordering::Release);
                let waiting: Vec<_> = pending
                    .lock()
                    .map(|mut p| p.drain().collect())
                    .unwrap_or_default();
                for (_, tx) in waiting {
                    let _ = tx.send(Err(RemoteError::new(
                        "disconnected",
                        "The connection to the remote machine was lost.",
                    )));
                }
                let handlers: Vec<_> = procs
                    .lock()
                    .map(|mut p| p.drain().collect())
                    .unwrap_or_default();
                for (_, mut h) in handlers {
                    h(ProcEvent::Exit { code: None });
                }
                on_lost();
            });
        }

        // 45 s for the helper to start, not counting the time the user spends on a password
        // dialog for this machine (askpass.rs).
        let ready = {
            let mut waited = Duration::ZERO;
            loop {
                match ready_rx.recv_timeout(Duration::from_secs(1)) {
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if !super::askpass::busy(host) {
                            waited += Duration::from_secs(1);
                        }
                        if waited < Duration::from_secs(45) {
                            continue;
                        }
                        break Err(mpsc::RecvTimeoutError::Timeout);
                    }
                    other => break other,
                }
            }
        };
        let ready = match ready {
            Ok(Some(v)) => v,
            other => {
                let _ = child.kill();
                let _ = child.wait();
                // Give the stderr reader a moment to catch ssh's last words.
                std::thread::sleep(Duration::from_millis(150));
                let err = last_lines(&err_tail);
                if let Some(why) = ssh::explain_failure(&err) {
                    return Err(StartError::Ssh(why));
                }
                if other.is_err() {
                    return Err(StartError::Ssh(format!(
                        "The machine took too long to answer.{}",
                        if err.is_empty() {
                            String::new()
                        } else {
                            format!("\n{err}")
                        }
                    )));
                }
                return Err(StartError::NoHelper(err));
            }
        };
        let theirs = ready.get("protocol").and_then(Value::as_u64).unwrap_or(0) as u32;
        if theirs != protocol {
            let _ = child.kill();
            return Err(StartError::NoHelper(format!(
                "helper protocol {theirs}, expected {protocol}"
            )));
        }

        let mut conn = Conn {
            info: HostInfo::default(),
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending,
            procs,
            watches,
            next: AtomicU64::new(1),
            alive,
        };
        let hello = conn
            .call("hello", json!({}), Some(Duration::from_secs(20)))
            .map_err(|e| StartError::Ssh(e.message))?;
        conn.info = serde_json::from_value(hello).unwrap_or_default();
        Ok(Arc::new(conn))
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    /// Sends a request and waits for its answer. `None` waits as long as it takes (a command
    /// with its own timeout); otherwise a silent machine fails the call after `timeout`.
    pub fn call(&self, op: &str, params: Value, timeout: Option<Duration>) -> Reply {
        if !self.is_alive() {
            return Err(RemoteError::new(
                "disconnected",
                "The connection to the remote machine was lost.",
            ));
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut req = match params {
            Value::Object(m) => m,
            _ => serde_json::Map::new(),
        };
        req.insert("id".into(), json!(id));
        req.insert("op".into(), json!(op));
        let line = Value::Object(req).to_string();
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        {
            let mut stdin = self.stdin.lock().unwrap();
            if stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .is_err()
            {
                self.pending.lock().unwrap().remove(&id);
                return Err(RemoteError::new(
                    "disconnected",
                    "The connection to the remote machine was lost.",
                ));
            }
        }
        let answer = match timeout {
            Some(t) => rx.recv_timeout(t).map_err(|_| ()),
            None => rx.recv().map_err(|_| ()),
        };
        match answer {
            Ok(reply) => reply,
            Err(()) => {
                self.pending.lock().unwrap().remove(&id);
                Err(RemoteError::new(
                    "timeout",
                    format!("The remote machine didn't answer `{op}` in time."),
                ))
            }
        }
    }

    pub fn on_proc(&self, proc_id: &str, handler: ProcHandler) {
        self.procs
            .lock()
            .unwrap()
            .insert(proc_id.to_string(), handler);
    }

    pub fn drop_proc(&self, proc_id: &str) {
        self.procs.lock().unwrap().remove(proc_id);
    }

    pub fn on_watch(&self, watch_id: &str, handler: WatchHandler) {
        self.watches
            .lock()
            .unwrap()
            .insert(watch_id.to_string(), handler);
    }

    pub fn drop_watch(&self, watch_id: &str) {
        self.watches.lock().unwrap().remove(watch_id);
    }

    pub fn close(&self) {
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.close();
    }
}

fn read_loop<R: Read>(
    stdout: R,
    ready_tx: mpsc::Sender<Option<Value>>,
    pending: &Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    procs: &Mutex<HashMap<String, ProcHandler>>,
    watches: &Mutex<HashMap<String, WatchHandler>>,
) {
    let mut ready_tx = Some(ready_tx);
    let mut reader = BufReader::with_capacity(256 * 1024, stdout);
    let mut raw = Vec::new();
    loop {
        raw.clear();
        // Bytes, not text: a login script's greeting in another encoding is just a line to
        // skip, where `lines()` took it for the end of the connection.
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&raw);
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(id) = v.get("id").and_then(Value::as_u64) {
            let tx = pending.lock().unwrap().remove(&id);
            if let Some(tx) = tx {
                let reply = match v.get("err").and_then(Value::as_str) {
                    Some(msg) => Err(RemoteError::new(
                        v.get("kind").and_then(Value::as_str).unwrap_or("error"),
                        msg,
                    )),
                    None => Ok(v.get("ok").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(reply);
            }
            continue;
        }
        match v.get("ev").and_then(Value::as_str) {
            Some("ready") => {
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(Some(v));
                }
            }
            Some("out") => {
                let Some(id) = v.get("proc").and_then(Value::as_str) else {
                    continue;
                };
                let data = v
                    .get("data")
                    .and_then(Value::as_str)
                    .and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
                    .unwrap_or_default();
                let stderr = v.get("stream").and_then(Value::as_str) == Some("stderr");
                if let Some(h) = procs.lock().unwrap().get_mut(id) {
                    h(ProcEvent::Out { stderr, data });
                }
            }
            Some("exit") => {
                let Some(id) = v.get("proc").and_then(Value::as_str) else {
                    continue;
                };
                let code = v.get("code").and_then(Value::as_i64).map(|c| c as i32);
                let handler = procs.lock().unwrap().remove(id);
                if let Some(mut h) = handler {
                    h(ProcEvent::Exit { code });
                }
            }
            Some("changed") => {
                let Some(id) = v.get("watch").and_then(Value::as_str) else {
                    continue;
                };
                let h = watches.lock().unwrap().get(id).cloned();
                if let Some(h) = h {
                    h();
                }
            }
            _ => {}
        }
    }
    if let Some(tx) = ready_tx.take() {
        let _ = tx.send(None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_that_isnt_utf8_doesnt_end_the_connection() {
        // A login script greeting in Latin-1 before the helper starts, then its answers.
        let mut wire = b"Bienvenido a la m\xe1quina\n".to_vec();
        wire.extend_from_slice(b"{\"ev\":\"ready\",\"protocol\":1}\n");
        wire.extend_from_slice(b"{\"id\":7,\"ok\":\"caf\xe9\"}\n");
        wire.extend_from_slice(b"{\"id\":8,\"ok\":42}\n");
        let (ready_tx, ready_rx) = mpsc::channel();
        let pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>> = Default::default();
        let (tx7, rx7) = mpsc::channel();
        let (tx8, rx8) = mpsc::channel();
        pending.lock().unwrap().insert(7, tx7);
        pending.lock().unwrap().insert(8, tx8);
        read_loop(
            std::io::Cursor::new(wire),
            ready_tx,
            &pending,
            &Default::default(),
            &Default::default(),
        );
        assert!(ready_rx.recv().unwrap().is_some());
        // A reply with a stray byte still arrives, with the byte replaced.
        assert_eq!(rx7.recv().unwrap().unwrap(), json!("caf\u{fffd}"));
        assert_eq!(rx8.recv().unwrap().unwrap(), json!(42));
    }
}
