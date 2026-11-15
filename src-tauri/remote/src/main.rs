//! nyxs-remote: the half of Nyxs that runs on a remote machine. Nyxs starts it over SSH
//! (`ssh host ~/.nyxs-remote/<version>/nyxs-remote serve`) and sends it one JSON request per
//! line on stdin; each answer is one JSON line on stdout with the same `id`. Long-lived
//! processes (background commands, language servers, the terminal-less CLIs) stream their
//! output back as event lines (`{"ev": ...}`) that carry no `id`.
//!
//! It holds no state of its own between connections: when SSH drops, stdin closes, the
//! helper stops every process it started and exits.

#[path = "../../src/git_state.rs"]
mod git_state;
#[path = "../../src/agent/search_core.rs"]
mod search_core;
#[path = "../../src/walk.rs"]
mod walk;

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use base64::Engine;
use serde_json::{json, Value};

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Protocol revision: the app refuses a helper whose revision differs and uploads its own.
const PROTOCOL: u32 = 1;
const MAX_READ: u64 = 50 * 1024 * 1024;
const MAX_CAPTURE: usize = 30 * 1024 * 1024;

fn b64() -> &'static base64::engine::GeneralPurpose {
    &base64::engine::general_purpose::STANDARD
}

fn out() -> &'static Mutex<std::io::Stdout> {
    static OUT: OnceLock<Mutex<std::io::Stdout>> = OnceLock::new();
    OUT.get_or_init(|| Mutex::new(std::io::stdout()))
}

/// What `send` sent, when the helper runs as a test: there is no app reading its stdout.
fn sent() -> &'static Mutex<Vec<Value>> {
    static SENT: OnceLock<Mutex<Vec<Value>>> = OnceLock::new();
    SENT.get_or_init(Default::default)
}

fn send(v: &Value) {
    if cfg!(test) {
        sent().lock().unwrap().push(v.clone());
        return;
    }
    let line = v.to_string();
    if let Ok(mut o) = out().lock() {
        let _ = o.write_all(line.as_bytes());
        let _ = o.write_all(b"\n");
        let _ = o.flush();
    }
}

struct Failure {
    kind: &'static str,
    message: String,
}

type Answer = Result<Value, Failure>;

fn fail(kind: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        kind,
        message: message.into(),
    }
}

fn io_fail(path: &str, e: std::io::Error) -> Failure {
    let kind = match e.kind() {
        std::io::ErrorKind::NotFound => "notFound",
        std::io::ErrorKind::PermissionDenied => "permissionDenied",
        _ => "io",
    };
    fail(kind, format!("{path}: {e}"))
}

fn s<'a>(req: &'a Value, key: &str) -> Result<&'a str, Failure> {
    req.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| fail("badRequest", format!("missing `{key}`")))
}

fn opt_s<'a>(req: &'a Value, key: &str) -> Option<&'a str> {
    req.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
}

fn u(req: &Value, key: &str) -> Option<u64> {
    req.get(key).and_then(Value::as_u64)
}

fn b(req: &Value, key: &str) -> bool {
    req.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn mtime(m: &fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `ssh://host` + the path with forward slashes, so a Windows `C:\a` reads `ssh://host/C:/a`.
fn display_with(prefix: &str) -> impl Fn(&str) -> String + '_ {
    move |p: &str| {
        let p = p.replace('\\', "/");
        if prefix.is_empty() {
            p
        } else if p.starts_with('/') {
            format!("{prefix}{p}")
        } else {
            format!("{prefix}/{p}")
        }
    }
}

fn os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn home() -> String {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default()
}

fn hostname() -> String {
    if let Ok(h) = std::env::var("COMPUTERNAME") {
        return h;
    }
    fs::read_to_string("/etc/hostname")
        .map(|h| h.trim().to_string())
        .unwrap_or_default()
}

/// The shell commands run in: the user's login shell on Unix (so nvm, pyenv and the PATH of
/// their profile apply, as in their own terminal), Windows PowerShell on Windows.
fn shell_program() -> (String, Vec<String>) {
    if cfg!(windows) {
        (
            "powershell.exe".into(),
            vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-Command".into(),
            ],
        )
    } else {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty() && Path::new(s).exists())
            .unwrap_or_else(|| "/bin/sh".into());
        (shell, vec!["-lc".into()])
    }
}

fn shell_label() -> String {
    let (program, _) = shell_program();
    Path::new(&program)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(program)
}

fn wrap_command(command: &str) -> String {
    if cfg!(windows) {
        // Without this PowerShell writes its output in the OEM code page and accents arrive broken.
        format!("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;{command}")
    } else {
        // Where Nyxs and the installers it runs put programs. After the login shell read the
        // user's profile, which can reset PATH; last, so what the user installed comes first.
        format!("export PATH=\"$PATH:$HOME/.local/bin\"; {command}")
    }
}

fn build_command(req: &Value) -> Result<Command, Failure> {
    let mut cmd = if let Some(argv) = req.get("argv").and_then(Value::as_array) {
        let argv: Vec<String> = argv
            .iter()
            .filter_map(|a| a.as_str().map(str::to_string))
            .collect();
        let (program, rest) = argv
            .split_first()
            .ok_or_else(|| fail("badRequest", "empty argv"))?;
        let mut c = Command::new(program);
        c.args(rest);
        c
    } else {
        let command = s(req, "command")?;
        let (program, args) = shell_program();
        let mut c = Command::new(program);
        c.args(args).arg(wrap_command(command));
        c
    };
    if let Some(cwd) = opt_s(req, "cwd") {
        if !Path::new(cwd).is_dir() {
            return Err(fail("notFound", format!("The folder {cwd} doesn't exist")));
        }
        cmd.current_dir(cwd);
    }
    if let Some(env) = req.get("env").and_then(Value::as_object) {
        for (k, v) in env {
            if let Some(v) = v.as_str() {
                cmd.env(k, v);
            }
        }
    }
    // The same non-interactive defaults Nyxs gives local commands: no prompt can hang a turn.
    for (k, v) in [
        ("CI", "1"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("NEXT_TELEMETRY_DISABLED", "1"),
        ("npm_config_yes", "true"),
        ("PIP_NO_INPUT", "1"),
        ("DEBIAN_FRONTEND", "noninteractive"),
    ] {
        if req.get("interactive").and_then(Value::as_bool) != Some(true) {
            cmd.env(k, v);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    Ok(cmd)
}

/// Kills the process `pid` and everything it started (its process group, which
/// `build_command` makes its own; its tree on Windows).
fn kill_pid_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn kill_tree(child: &mut Child) {
    kill_pid_tree(child.id());
    let _ = child.kill();
}

/// The commands `exec` is running, with their run id and pid, so a closed connection ends them
/// too: each runs in its own process group, which nothing else would stop.
/// Each running command by a number of its own: its run id and pid.
type ExecChildren = HashMap<u64, (Option<String>, u32)>;

fn exec_children() -> &'static Mutex<ExecChildren> {
    static EXECS: OnceLock<Mutex<ExecChildren>> = OnceLock::new();
    EXECS.get_or_init(Default::default)
}

/// Kills the running commands whose run id `which` picks.
fn kill_execs(which: &dyn Fn(Option<&str>) -> bool) {
    let pids: Vec<u32> = exec_children()
        .lock()
        .unwrap()
        .values()
        .filter(|(run, _)| which(run.as_deref()))
        .map(|(_, pid)| *pid)
        .collect();
    for pid in pids {
        kill_pid_tree(pid);
    }
}

fn runs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    RUNS.get_or_init(Default::default)
}

/// How long a command's output readers get once it has exited. A process it left running in
/// the background (`server &`) keeps the pipes open, and the answer would otherwise wait for
/// that one to end, as long as the command's timeout. The same wait the app gives its own.
const READER_GRACE: Duration = Duration::from_millis(1500);

/// A command's output as kept: its first and last bytes, and how many in between were dropped.
struct CaptureBuf {
    head: Vec<u8>,
    tail: Vec<u8>,
    head_max: usize,
    tail_max: usize,
    omitted: usize,
}

impl CaptureBuf {
    fn new(head_max: usize, tail_max: usize) -> Self {
        CaptureBuf {
            head: Vec::new(),
            tail: Vec::new(),
            head_max,
            tail_max,
            omitted: 0,
        }
    }

    fn push(&mut self, data: &[u8]) {
        let room = self
            .head_max
            .saturating_sub(self.head.len())
            .min(data.len());
        self.head.extend_from_slice(&data[..room]);
        self.tail.extend_from_slice(&data[room..]);
        if self.tail.len() > self.tail_max {
            let cut = self.tail.len() - self.tail_max;
            self.tail.drain(..cut);
            self.omitted += cut;
        }
    }

    fn clipped(&self) -> bool {
        self.omitted > 0
    }

    /// Every byte kept, in order, for output that must arrive whole (a file from git).
    fn bytes(&self) -> Vec<u8> {
        [self.head.as_slice(), self.tail.as_slice()].concat()
    }

    fn text(&self) -> String {
        if self.omitted == 0 {
            return String::from_utf8_lossy(&self.bytes()).into_owned();
        }
        format!(
            "{}\n… [{} bytes of output omitted] …\n{}",
            String::from_utf8_lossy(&self.head),
            self.omitted,
            String::from_utf8_lossy(&self.tail)
        )
    }
}

/// A reader of one of a command's pipes: what it kept, and whether the pipe has closed.
struct Captured {
    buf: Arc<Mutex<CaptureBuf>>,
    done: Arc<AtomicBool>,
}

fn capture<R: Read + Send + 'static>(mut r: R) -> Captured {
    let buf = Arc::new(Mutex::new(CaptureBuf::new(
        MAX_CAPTURE / 2,
        MAX_CAPTURE / 2,
    )));
    let done = Arc::new(AtomicBool::new(false));
    let (b, d) = (buf.clone(), done.clone());
    std::thread::spawn(move || {
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => b.lock().unwrap().push(&chunk[..n]),
            }
        }
        d.store(true, Ordering::Release);
    });
    Captured { buf, done }
}

/// Waits for every reader to reach the end of its pipe, for `READER_GRACE` at most.
fn settle(readers: &[&Arc<AtomicBool>]) {
    let start = Instant::now();
    while !readers.iter().all(|d| d.load(Ordering::Acquire)) && start.elapsed() < READER_GRACE {
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Runs a command to the end (or its timeout, or a `cancel`) and returns everything it printed.
fn exec(req: &Value) -> Answer {
    let mut cmd = build_command(req)?;
    let timeout = u(req, "timeoutMs").map(Duration::from_millis);
    let run_id = opt_s(req, "runId").map(str::to_string);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let stdin_data = req
        .get("stdin")
        .and_then(Value::as_str)
        .map(|d| b64().decode(d).unwrap_or_default());
    cmd.stdin(if stdin_data.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let mut child = cmd
        .spawn()
        .map_err(|e| fail("spawnFailed", format!("Couldn't start the command: {e}")))?;
    if let (Some(data), Some(mut stdin)) = (stdin_data, child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
        });
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(id) = &run_id {
        runs().lock().unwrap().insert(id.clone(), cancelled.clone());
    }
    static NEXT_EXEC: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let exec_key = NEXT_EXEC.fetch_add(1, Ordering::Relaxed);
    exec_children()
        .lock()
        .unwrap()
        .insert(exec_key, (run_id.clone(), child.id()));
    let so = capture(child.stdout.take().unwrap());
    let se = capture(child.stderr.take().unwrap());
    let started = Instant::now();
    let mut timed_out = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(_) => break None,
        }
        if cancelled.load(Ordering::Relaxed) {
            kill_tree(&mut child);
            let _ = child.wait();
            break None;
        }
        if timeout.is_some_and(|t| started.elapsed() >= t) {
            timed_out = true;
            kill_tree(&mut child);
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    // Gone before its pid can go to another process.
    exec_children().lock().unwrap().remove(&exec_key);
    if let Some(id) = &run_id {
        runs().lock().unwrap().remove(id);
    }
    settle(&[&so.done, &se.done]);
    let (stdout, stderr) = (so.buf.lock().unwrap(), se.buf.lock().unwrap());
    let mut out = json!({
        "stdout": stdout.text(),
        "stderr": stderr.text(),
        "code": code,
        "timedOut": timed_out,
        "cancelled": cancelled.load(Ordering::Relaxed),
        "clipped": stdout.clipped() || stderr.clipped(),
        "elapsedMs": started.elapsed().as_millis() as u64,
    });
    // `binary`: the output byte for byte (a file's content from git), not as text.
    if b(req, "binary") {
        out["stdout"] = json!("");
        out["stdoutB64"] = json!(b64().encode(stdout.bytes()));
    }
    Ok(out)
}

/// Started by `ssh` as its SSH_ASKPASS on the user's own computer (never on a remote
/// machine): asks Nyxs for what ssh prompts for (`prompt`: a password, a key's passphrase, or
/// a yes/no question) over the local port Nyxs gave it, prints the answer for ssh and exits.
/// Exits 1 when the user cancels, which ssh takes as no answer.
fn askpass(port: &str) -> i32 {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let ask = || -> std::io::Result<Option<String>> {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port.parse().unwrap_or(0)))?;
        let req = json!({
            "token": std::env::var("NYXS_ASKPASS_TOKEN").unwrap_or_default(),
            "prompt": prompt,
            "confirm": std::env::var("SSH_ASKPASS_PROMPT").is_ok_and(|p| p == "confirm"),
        });
        stream.write_all(format!("{req}\n").as_bytes())?;
        let mut line = String::new();
        std::io::BufReader::new(stream).read_line(&mut line)?;
        let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        Ok(v.get("answer").and_then(Value::as_str).map(str::to_string))
    };
    match ask() {
        Ok(Some(answer)) => {
            println!("{answer}");
            0
        }
        _ => 1,
    }
}

/// A long-lived process. Its stdin has a lock of its own: a write that blocks on a full pipe
/// (a process that stopped reading) must not keep `kill` from reaching the process.
struct Proc {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
}

fn procs() -> &'static Mutex<HashMap<String, Arc<Proc>>> {
    static PROCS: OnceLock<Mutex<HashMap<String, Arc<Proc>>>> = OnceLock::new();
    PROCS.get_or_init(Default::default)
}

/// Sends what the process prints as `out` events; the flag says when its pipe has closed.
fn stream<R: Read + Send + 'static>(id: String, name: &'static str, mut r: R) -> Arc<AtomicBool> {
    let done = Arc::new(AtomicBool::new(false));
    let d = done.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 32 * 1024];
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => send(&json!({
                    "ev": "out",
                    "proc": id,
                    "stream": name,
                    "data": b64().encode(&chunk[..n]),
                })),
            }
        }
        d.store(true, Ordering::Release);
    });
    done
}

/// Starts a process that outlives the request: its output arrives as `out` events and its end
/// as one `exit` event. Used for background commands, language servers and agent CLIs.
fn spawn(req: &Value) -> Answer {
    let id = s(req, "proc")?.to_string();
    let mut cmd = build_command(req)?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if b(req, "stdin") {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let mut child = cmd
        .spawn()
        .map_err(|e| fail("spawnFailed", format!("Couldn't start the command: {e}")))?;
    let pid = child.id();
    let out_done = stream(id.clone(), "stdout", child.stdout.take().unwrap());
    let err_done = stream(id.clone(), "stderr", child.stderr.take().unwrap());
    let stdin = child.stdin.take();
    let proc = Arc::new(Proc {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
    });
    procs().lock().unwrap().insert(id.clone(), proc.clone());
    std::thread::spawn(move || {
        let code = loop {
            match proc.child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {}
                Err(_) => break None,
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        // Everything the process printed goes out before `exit`: the app stops listening to
        // the process there. A child it left running with the pipes gets `READER_GRACE`.
        settle(&[&out_done, &err_done]);
        procs().lock().unwrap().remove(&id);
        send(&json!({ "ev": "exit", "proc": id, "code": code }));
    });
    Ok(json!({ "pid": pid }))
}

fn proc_stdin(req: &Value) -> Answer {
    let id = s(req, "proc")?;
    let proc = procs()
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| fail("notFound", format!("no process {id}")))?;
    let mut stdin = proc.stdin.lock().unwrap();
    if let Some(data) = opt_s(req, "data") {
        let bytes = b64()
            .decode(data)
            .map_err(|e| fail("badRequest", e.to_string()))?;
        if let Some(stdin) = stdin.as_mut() {
            stdin
                .write_all(&bytes)
                .and_then(|_| stdin.flush())
                .map_err(|e| fail("io", e.to_string()))?;
        }
    }
    if b(req, "close") {
        *stdin = None;
    }
    Ok(Value::Null)
}

fn proc_kill(req: &Value) -> Answer {
    let id = s(req, "proc")?;
    let proc = procs().lock().unwrap().get(id).cloned();
    if let Some(proc) = proc {
        kill_tree(&mut proc.child.lock().unwrap());
        return Ok(json!(true));
    }
    Ok(json!(false))
}

/// Ends everything the helper started, when the app's connection closes: the long-lived
/// processes and the commands still running.
fn kill_all() {
    let all: Vec<_> = procs().lock().unwrap().values().cloned().collect();
    for p in all {
        if let Ok(mut child) = p.child.lock() {
            kill_tree(&mut child);
        }
    }
    kill_execs(&|_| true);
}

fn stat(req: &Value) -> Answer {
    let path = s(req, "path")?;
    match fs::metadata(path) {
        Ok(m) => Ok(json!({
            "isDir": m.is_dir(),
            "isFile": m.is_file(),
            "size": m.len(),
            "mtime": mtime(&m),
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(io_fail(path, e)),
    }
}

fn read(req: &Value) -> Answer {
    let path = s(req, "path")?;
    let max = u(req, "max").unwrap_or(MAX_READ).min(MAX_READ);
    let m = fs::metadata(path).map_err(|e| io_fail(path, e))?;
    if m.is_dir() {
        return Err(fail("isDir", format!("{path} is a folder")));
    }
    if m.len() > max {
        return Err(fail(
            "tooLarge",
            format!("{path} is too large ({} bytes)", m.len()),
        ));
    }
    let bytes = fs::read(path).map_err(|e| io_fail(path, e))?;
    Ok(json!({ "data": b64().encode(&bytes), "mtime": mtime(&m) }))
}

/// Where a write is staged before it replaces the file: next to it, hidden, and its own (two
/// writes at once to the same file must not share one).
fn staging_path(target: &Path) -> std::path::PathBuf {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    target.with_file_name(format!(
        ".{name}.nyxs-{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}

fn write(req: &Value) -> Answer {
    let path = s(req, "path")?;
    let bytes = b64()
        .decode(s(req, "data")?)
        .map_err(|e| fail("badRequest", e.to_string()))?;
    let target = Path::new(path);
    if let Some(parent) = target.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|e| io_fail(path, e))?;
    }
    if b(req, "append") {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(target)
            .map_err(|e| io_fail(path, e))?;
        f.write_all(&bytes).map_err(|e| io_fail(path, e))?;
    } else if fs::symlink_metadata(target).is_ok_and(|m| m.file_type().is_symlink())
        && fs::canonicalize(target).is_err()
    {
        // A link to nothing yet: written through it, which makes the file it names.
        fs::write(target, &bytes).map_err(|e| io_fail(path, e))?;
    } else {
        // A link stays a link: the file it points to is the one replaced.
        let real = if fs::symlink_metadata(target).is_ok_and(|m| m.file_type().is_symlink()) {
            fs::canonicalize(target).map_err(|e| io_fail(path, e))?
        } else {
            target.to_path_buf()
        };
        // Written next to the file and renamed over it, so a dropped connection never leaves
        // half a file behind.
        let tmp = staging_path(&real);
        fs::write(&tmp, &bytes).map_err(|e| io_fail(path, e))?;
        // An executable script stays executable after an edit.
        if let Ok(meta) = fs::metadata(&real) {
            let _ = fs::set_permissions(&tmp, meta.permissions());
        }
        if let Err(e) = fs::rename(&tmp, &real) {
            let _ = fs::remove_file(&tmp);
            fs::write(&real, &bytes).map_err(|_| io_fail(path, e))?;
        }
    }
    let m = fs::metadata(target).map_err(|e| io_fail(path, e))?;
    Ok(json!({ "mtime": mtime(&m) }))
}

fn list_dir(req: &Value) -> Answer {
    let path = s(req, "path")?;
    let entries = fs::read_dir(path).map_err(|e| io_fail(path, e))?;
    let mut list = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        let md = entry.metadata().ok();
        let is_dir = md
            .as_ref()
            .map(|m| m.is_dir())
            .unwrap_or_else(|| entry.path().is_dir());
        list.push(json!({
            "name": name,
            "isDir": is_dir,
            "size": md.as_ref().map(|m| m.len()).unwrap_or(0),
            "mtime": md.as_ref().map(mtime).unwrap_or(0),
        }));
    }
    Ok(Value::Array(list))
}

/// The project's text files with their content, for indexing (RAG) on the app's side. `known`
/// lists the files the app already has (path, mtime, size): one that still matches comes as
/// `unchanged`, without its text, so a pass of the index doesn't bring the whole project over
/// SSH again. An app that sends no `known` gets every text, as before.
fn walk_text(req: &Value) -> Answer {
    let root = s(req, "root")?;
    let max_file = u(req, "maxFile").unwrap_or(512 * 1024);
    let max_total = u(req, "maxTotal").unwrap_or(64 * 1024 * 1024);
    let known: HashMap<&str, (u64, u64)> = req
        .get("known")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|k| Some((k["path"].as_str()?, (u(k, "mtime")?, u(k, "size")?))))
                .collect()
        })
        .unwrap_or_default();
    let mut total = 0u64;
    let mut files = Vec::new();
    for entry in walk::project_files(root) {
        let p = entry.path();
        if walk::is_secret_file(p) {
            continue;
        }
        let Ok(m) = entry.metadata() else { continue };
        if m.len() > max_file {
            continue;
        }
        let path = p.to_string_lossy().replace('\\', "/");
        let stamp = (mtime(&m), m.len());
        if known.get(path.as_str()) == Some(&stamp) {
            files.push(
                json!({ "path": path, "mtime": stamp.0, "size": stamp.1, "unchanged": true }),
            );
            continue;
        }
        let Ok(text) = fs::read_to_string(p) else {
            continue;
        };
        total += m.len();
        if total > max_total {
            break;
        }
        files.push(json!({ "path": path, "mtime": stamp.0, "size": stamp.1, "text": text }));
    }
    Ok(Value::Array(files))
}

fn tcp(req: &Value) -> Answer {
    let port = u(req, "port").unwrap_or(0) as u16;
    let timeout = Duration::from_millis(u(req, "timeoutMs").unwrap_or(400));
    let open = ["127.0.0.1", "[::1]"].iter().any(|h| {
        format!("{h}:{port}")
            .parse::<std::net::SocketAddr>()
            .ok()
            .and_then(|a| std::net::TcpStream::connect_timeout(&a, timeout).ok())
            .is_some()
    });
    Ok(json!(open))
}

/// Watches a project and sends a `changed` event when something in it moves, and one for
/// `<watch>:git` when its repository's state does (a commit, checkout or pull, also made in a
/// terminal there). It listens to the system's file events (inotify, ReadDirectoryChangesW,
/// FSEvents; see `listen`). Where they can't take the project, it compares fingerprints of the
/// project and its repository every couple of seconds instead, and says why on stderr, which
/// the app writes to its log.
fn watch(req: &Value) -> Answer {
    let id = s(req, "watch")?.to_string();
    let root = s(req, "root")?.to_string();
    let stop = Arc::new(AtomicBool::new(false));
    watches().lock().unwrap().insert(id.clone(), stop.clone());
    std::thread::spawn(move || {
        let git_id = format!("{id}:git");
        let changed = || send(&json!({ "ev": "changed", "watch": id }));
        let git_changed = || send(&json!({ "ev": "changed", "watch": git_id }));
        if let Err(why) = listen(&root, &stop, &changed, &git_changed) {
            eprintln!("nyxs-remote: watching {root} by polling every 2 s: {why}");
            poll(&root, &stop, &changed, &git_changed);
        }
    });
    Ok(Value::Null)
}

/// The file count and newest modification of the project's files, and how many entries its
/// top folder has.
fn fingerprint(root: &str) -> (u64, u64, u64) {
    let mut count = 0u64;
    let mut newest = 0u64;
    let mut dirs = 0u64;
    for e in walk::project_files(root) {
        count += 1;
        if let Ok(m) = e.metadata() {
            newest = newest.max(mtime(&m));
        }
    }
    if let Ok(rd) = fs::read_dir(root) {
        dirs = rd.count() as u64;
    }
    (count, newest, dirs)
}

/// The size and modification of each of the repository's state files: a few dozen at most,
/// and changed by every commit, checkout or pull.
fn git_fingerprint(dirs: &git_state::GitDirs) -> Vec<(String, u64, u64)> {
    let mut out = Vec::new();
    for dir in git_state::git_state_dirs(dirs) {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if !git_state::is_git_state(&p, dirs) {
                continue;
            }
            if let Some(m) = e.metadata().ok().filter(|m| m.is_file()) {
                out.push((p.to_string_lossy().into_owned(), m.len(), mtime(&m)));
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// The polling watcher: the project's `fingerprint` and its repository's every 2 s.
fn poll(root: &str, stop: &AtomicBool, changed: &dyn Fn(), git_changed: &dyn Fn()) {
    let git = git_state::find_git_dirs(Path::new(root));
    let mut last = fingerprint(root);
    let mut last_git = git.as_ref().map(git_fingerprint);
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(2000));
        let now = fingerprint(root);
        if now != last {
            last = now;
            changed();
        }
        let now_git = git.as_ref().map(git_fingerprint);
        if now_git != last_git {
            last_git = now_git;
            git_changed();
        }
    }
}

/// The folders the watcher listens to on Linux: the ones the project walk visits, so
/// `node_modules`, `target`, the other ignored folders and what `.gitignore` leaves out cost
/// no watch.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn project_dirs(root: &Path) -> Vec<std::path::PathBuf> {
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .filter_entry(|e| {
            !(e.file_type().is_some_and(|t| t.is_dir())
                && e.file_name()
                    .to_str()
                    .is_some_and(|n| walk::IGNORED_DIRS.contains(&n)))
        })
        .build()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_some_and(|t| t.is_dir()))
        .map(|e| e.into_path())
        .collect()
}

/// Whether a change at `path` is one the project walk would skip: inside an ignored folder, or
/// matched by the project's top `.gitignore` (a log a dev server keeps writing).
fn ignored_change(root: &Path, gitignore: &ignore::gitignore::Gitignore, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return true;
    };
    let in_ignored_dir = rel.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|n| walk::IGNORED_DIRS.contains(&n))
    });
    in_ignored_dir
        || gitignore
            .matched_path_or_any_parents(rel, path.is_dir())
            .is_ignore()
}

/// How long the first event of a burst waits before its `changed` goes out.
const BATCH_WAIT: Duration = Duration::from_millis(300);
/// A burst of at least this many events (ignored ones included) is rechecked once it ends,
/// where the system can drop events without saying so (see `Batch`).
const BIG_BURST: usize = 100;
/// How long without events ends a burst.
const BURST_END: Duration = Duration::from_secs(1);

/// What the watcher does after an event or a quiet moment.
#[derive(Debug, PartialEq)]
enum Tick {
    Nothing,
    /// Send `changed`.
    Changed,
    /// A big burst ended: compare the project's fingerprint with the last one.
    Recheck,
}

/// Turns file events into `changed` events. The first event that matters starts a 300 ms wait
/// and one `changed` goes out at its end, so an `npm install` or a checkout sends one every
/// 300 ms at most. An event after that starts the next wait, so the last change is always
/// followed by a `changed`. A big burst also asks for a recheck once it ends: Windows drops
/// a batch of events too big for its buffer without a word (notify sees an empty batch), and
/// a change that mattered may have been in it, among a flood of `node_modules` ones.
#[derive(Default)]
struct Batch {
    pending: Option<Instant>,
    burst: usize,
    last: Option<Instant>,
}

impl Batch {
    fn saw(&mut self, now: Instant, matters: bool) {
        self.burst += 1;
        self.last = Some(now);
        if matters {
            self.pending.get_or_insert(now);
        }
    }

    fn tick(&mut self, now: Instant) -> Tick {
        if self
            .pending
            .is_some_and(|t| now.duration_since(t) >= BATCH_WAIT)
        {
            self.pending = None;
            return Tick::Changed;
        }
        if self
            .last
            .is_some_and(|t| now.duration_since(t) >= BURST_END)
        {
            let big = self.burst >= BIG_BURST;
            self.burst = 0;
            self.last = None;
            if big {
                return Tick::Recheck;
            }
        }
        Tick::Nothing
    }
}

/// Whether an event says the project changed: not a read, and on a path the project walk
/// keeps, or a lost queue (`need_rescan`), which may hide anything.
fn event_matters(
    ev: &notify::Event,
    root: &Path,
    gitignore: &ignore::gitignore::Gitignore,
) -> bool {
    if matches!(ev.kind, notify::EventKind::Access(_)) {
        return false;
    }
    ev.need_rescan() || ev.paths.iter().any(|p| !ignored_change(root, gitignore, p))
}

/// Whether `dir` gives change events. ReadDirectoryChangesW fails at once on a file system
/// that doesn't support it (some network shares), but notify only learns that on its own
/// thread and keeps quiet, so the watch would look fine and never report anything.
#[cfg(windows)]
fn check_directory_events(dir: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED,
        FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let handle = CreateFileW(
            wide.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
            0,
        );
        if handle == INVALID_HANDLE_VALUE {
            let e = std::io::Error::last_os_error();
            return Err(format!("couldn't open the folder ({e})"));
        }
        // u32s: the buffer must be DWORD-aligned.
        let mut buf = [0u32; 256];
        let mut overlapped: OVERLAPPED = std::mem::zeroed();
        let started = ReadDirectoryChangesW(
            handle,
            buf.as_mut_ptr().cast(),
            std::mem::size_of_val(&buf) as u32,
            1,
            FILE_NOTIFY_CHANGE_FILE_NAME,
            std::ptr::null_mut(),
            &mut overlapped,
            None,
        ) != 0;
        let result = if started {
            // Waits for the cancelled read to finish, so `buf` outlives it.
            CancelIoEx(handle, &overlapped);
            let mut n = 0;
            GetOverlappedResult(handle, &overlapped, &mut n, 1);
            Ok(())
        } else {
            let e = std::io::Error::last_os_error();
            Err(format!("the folder gives no change events ({e})"))
        };
        CloseHandle(handle);
        result
    }
}

/// Listens to the system's file events until `stop`, and sends `changed` as `Batch` decides.
/// On Linux, one inotify watch per project folder (`project_dirs`), new folders added as they
/// appear; on Windows and macOS, one recursive watch, which costs the same whatever the
/// project's size, and the events from ignored folders are dropped here. An error says why
/// the caller should poll instead: the watch couldn't start, or inotify ran out of watches.
fn listen(
    root: &str,
    stop: &AtomicBool,
    changed: &dyn Fn(),
    git_changed: &dyn Fn(),
) -> Result<(), String> {
    use notify::{RecursiveMode, Watcher};
    use std::sync::mpsc::RecvTimeoutError;

    #[cfg(target_os = "linux")]
    fn out_of_watches(e: &notify::Error) -> bool {
        match &e.kind {
            notify::ErrorKind::MaxFilesWatch => true,
            notify::ErrorKind::Io(io) => io.raw_os_error() == Some(libc::ENOSPC),
            _ => false,
        }
    }
    // A folder that disappears while being added is fine; running out of watches isn't.
    #[cfg(target_os = "linux")]
    fn add(watcher: &mut notify::RecommendedWatcher, dir: &Path) -> Result<(), String> {
        add_git(watcher, &project_dirs(dir))
    }
    #[cfg(target_os = "linux")]
    fn add_git(
        watcher: &mut notify::RecommendedWatcher,
        dirs: &[std::path::PathBuf],
    ) -> Result<(), String> {
        for d in dirs {
            if let Err(e) = watcher.watch(d, RecursiveMode::NonRecursive) {
                if out_of_watches(&e) {
                    return Err(format!("inotify is out of watches ({e})"));
                }
            }
        }
        Ok(())
    }

    let root_path = Path::new(root);
    #[cfg(windows)]
    check_directory_events(root_path)?;
    // FSEvents reports real paths (`/private/var/…` for `/var/…`).
    #[cfg(target_os = "macos")]
    let real_root = fs::canonicalize(root_path).unwrap_or_else(|_| root_path.to_path_buf());
    #[cfg(target_os = "macos")]
    let root_path = real_root.as_path();
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |r| {
        let _ = tx.send(r);
    })
    .map_err(|e| format!("no file events ({e})"))?;
    let git = git_state::find_git_dirs(root_path);
    #[cfg(target_os = "linux")]
    {
        // The root first: a folder that's gone or can't be read has no folders to walk, and
        // would otherwise be watched by nothing at all.
        watcher
            .watch(root_path, RecursiveMode::NonRecursive)
            .map_err(|e| format!("couldn't watch the folder ({e})"))?;
        add(&mut watcher, root_path)?;
        // The project walk leaves `.git` out: its state folders get their own watches.
        if let Some(g) = &git {
            add_git(&mut watcher, &git_state::git_state_dirs(g))?;
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        watcher
            .watch(root_path, RecursiveMode::Recursive)
            .map_err(|e| format!("couldn't watch the folder ({e})"))?;
        // A repository outside the project (a linked worktree's, or the project is a subfolder).
        if let Some(g) = &git {
            for dir in git_state::extra_git_watches(root_path, g) {
                if let Err(e) = watcher.watch(&dir, RecursiveMode::Recursive) {
                    eprintln!("nyxs-remote: couldn't watch {}: {e}", dir.display());
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    let refs = git
        .as_ref()
        .map(|g| git_state::norm(&g.common_dir.join("refs")));
    let mut git_batch = Batch::default();
    let gitignore = ignore::gitignore::Gitignore::new(root_path.join(".gitignore")).0;
    // Only where events can be lost without a word (see `Batch`).
    let mut last_print = cfg!(windows).then(|| fingerprint(root));
    let mut batch = Batch::default();
    while !stop.load(Ordering::Relaxed) {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(ev)) => {
                if matches!(ev.kind, notify::EventKind::Access(_)) {
                    continue;
                }
                // A folder that appears, made here or renamed into place, gets its watches.
                #[cfg(target_os = "linux")]
                if matches!(
                    ev.kind,
                    notify::EventKind::Create(_)
                        | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                ) {
                    for p in &ev.paths {
                        let in_refs = refs
                            .as_ref()
                            .is_some_and(|r| git_state::rel_to(&git_state::norm(p), r).is_some());
                        if p.is_dir() && in_refs {
                            add_git(&mut watcher, &git_state::dirs_below(p, &|_| false))?;
                        } else if p.is_dir() && !ignored_change(root_path, &gitignore, p) {
                            add(&mut watcher, p)?;
                        }
                    }
                }
                let now = Instant::now();
                if git
                    .as_ref()
                    .is_some_and(|g| ev.paths.iter().any(|p| git_state::is_git_state(p, g)))
                {
                    git_batch.saw(now, true);
                }
                batch.saw(now, event_matters(&ev, root_path, &gitignore));
            }
            Ok(Err(_e)) =>
            {
                #[cfg(target_os = "linux")]
                if out_of_watches(&_e) {
                    return Err(format!("inotify is out of watches ({_e})"));
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err("the file events stopped".into()),
        }
        if git_batch.tick(Instant::now()) == Tick::Changed {
            git_changed();
        }
        match batch.tick(Instant::now()) {
            Tick::Nothing => {}
            Tick::Changed => changed(),
            Tick::Recheck => {
                if let Some(last) = &mut last_print {
                    let now = fingerprint(root);
                    if now != *last {
                        *last = now;
                        changed();
                    }
                }
            }
        }
    }
    Ok(())
}

/// A path as the app's `resolve_path` (agent/scope.rs) sees it: with every symlink followed,
/// or, for a path that doesn't exist yet, its nearest existing folder resolved and the rest
/// added. `None` for a broken symlink, whose target can't be checked.
fn resolve_path(p: &Path) -> Option<std::path::PathBuf> {
    if let Ok(c) = fs::canonicalize(p) {
        return Some(c);
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p;
    loop {
        if fs::symlink_metadata(cur).is_ok() {
            return None;
        }
        tail.push(cur.file_name()?.to_os_string());
        cur = cur.parent()?;
        if let Ok(mut out) = fs::canonicalize(cur) {
            for seg in tail.iter().rev() {
                out.push(seg);
            }
            return Some(out);
        }
    }
}

/// A canonical path in the form the app uses: `/` separators, no `\\?\` prefix.
fn canonical_text(p: &Path) -> String {
    let mut text = p.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        text = rest.to_string();
    }
    text.replace('\\', "/")
}

fn watches() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static W: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    W.get_or_init(Default::default)
}

fn handle(req: &Value) -> Answer {
    let op = s(req, "op")?;
    match op {
        "hello" => Ok(json!({
            "version": VERSION,
            "protocol": PROTOCOL,
            "os": os_name(),
            "arch": std::env::consts::ARCH,
            "home": home().replace('\\', "/"),
            "shell": shell_label(),
            "hostname": hostname(),
            "user": std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" }).unwrap_or_default(),
        })),
        "stat" => stat(req),
        "read" => read(req),
        "write" => write(req),
        "listDir" => list_dir(req),
        "mkdir" => {
            let path = s(req, "path")?;
            fs::create_dir_all(path).map_err(|e| io_fail(path, e))?;
            Ok(Value::Null)
        }
        "remove" => {
            let path = s(req, "path")?;
            let p = Path::new(path);
            let r = if p.is_dir() {
                if b(req, "recursive") {
                    fs::remove_dir_all(p)
                } else {
                    fs::remove_dir(p)
                }
            } else {
                fs::remove_file(p)
            };
            match r {
                Ok(()) => Ok(json!(true)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!(false)),
                Err(e) => Err(io_fail(path, e)),
            }
        }
        "rename" => {
            let from = s(req, "from")?;
            let to = s(req, "to")?;
            if let Some(parent) = Path::new(to).parent() {
                let _ = fs::create_dir_all(parent);
            }
            fs::rename(from, to).map_err(|e| io_fail(from, e))?;
            Ok(Value::Null)
        }
        "listFiles" => {
            let root = s(req, "root")?;
            let limit = u(req, "limit").unwrap_or(5000) as usize;
            Ok(json!(search_core::list_files(root, limit)))
        }
        "glob" => {
            let prefix = opt_s(req, "prefix").unwrap_or("");
            let display = display_with(prefix);
            search_core::glob(s(req, "pattern")?, s(req, "root")?, &display)
                .map(|v| json!(v))
                .map_err(|e| fail("invalidPattern", e.message()))
        }
        "grep" => {
            let prefix = opt_s(req, "prefix").unwrap_or("");
            let display = display_with(prefix);
            let o = search_core::GrepOptions {
                pattern: s(req, "pattern")?.to_string(),
                cwd: s(req, "cwd")?.to_string(),
                glob: opt_s(req, "glob").map(str::to_string),
                output_mode: opt_s(req, "outputMode").map(str::to_string),
                case_insensitive: req.get("caseInsensitive").and_then(Value::as_bool),
                context_lines: u(req, "contextLines").map(|v| v as usize),
                head_limit: u(req, "headLimit").map(|v| v as usize),
                multiline: req.get("multiline").and_then(Value::as_bool),
            };
            search_core::grep(&o, &display)
                .map(|v| json!(v))
                .map_err(|e| match e {
                    search_core::SearchError::Regex { .. } => fail("invalidRegex", e.message()),
                    search_core::SearchError::Glob { .. } => fail("invalidGlob", e.message()),
                })
        }
        "walkText" => walk_text(req),
        "exec" => exec(req),
        "cancel" => {
            let id = s(req, "runId")?;
            if let Some(flag) = runs().lock().unwrap().get(id) {
                flag.store(true, Ordering::Relaxed);
                return Ok(json!(true));
            }
            Ok(json!(false))
        }
        "spawn" => spawn(req),
        "stdin" => proc_stdin(req),
        "kill" => proc_kill(req),
        "tcp" => tcp(req),
        "watch" => watch(req),
        "unwatch" => {
            if let Some(flag) = watches().lock().unwrap().remove(s(req, "watch")?) {
                flag.store(true, Ordering::Relaxed);
            }
            Ok(Value::Null)
        }
        "realpath" => {
            let path = s(req, "path")?;
            let p = fs::canonicalize(path).map_err(|e| io_fail(path, e))?;
            Ok(json!(canonical_text(&p)))
        }
        // Several paths resolved at once for the app's scope check (see `resolve_path`): each
        // one's real place, or null for a broken symlink.
        "resolve" => {
            let paths = req
                .get("paths")
                .and_then(Value::as_array)
                .ok_or_else(|| fail("badRequest", "missing `paths`"))?;
            Ok(Value::Array(
                paths
                    .iter()
                    .map(|p| {
                        p.as_str()
                            .and_then(|p| resolve_path(Path::new(p)))
                            .map_or(Value::Null, |r| json!(canonical_text(&r)))
                    })
                    .collect(),
            ))
        }
        other => Err(fail("badRequest", format!("unknown op `{other}`"))),
    }
}

fn serve() {
    send(&json!({ "ev": "ready", "version": VERSION, "protocol": PROTOCOL }));
    let stdin = std::io::stdin();
    let mut line = String::new();
    let mut reader = stdin.lock();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Every request in its own thread: a long command never holds up a file read.
        std::thread::spawn(move || {
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            let answer = handle(&req);
            send(&match answer {
                Ok(v) => json!({ "id": id, "ok": v }),
                Err(f) => json!({ "id": id, "err": f.message, "kind": f.kind }),
            });
        });
    }
    kill_all();
}

fn main() {
    // ssh runs its SSH_ASKPASS with the prompt as the only argument, so the mode comes from
    // the environment Nyxs gave ssh.
    if let Ok(port) = std::env::var("NYXS_ASKPASS_PORT") {
        std::process::exit(askpass(&port));
    }
    let arg = std::env::args().nth(1).unwrap_or_default();
    match arg.as_str() {
        "serve" => serve(),
        "--version" | "version" => println!("nyxs-remote {VERSION} protocol {PROTOCOL}"),
        _ => {
            eprintln!("nyxs-remote {VERSION}: started by Nyxs over SSH (`nyxs-remote serve`).");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nyxs-remote-{tag}-{}-{}",
                std::process::id(),
                UNIX_EPOCH.elapsed().unwrap().as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Temp(fs::canonicalize(dir).unwrap())
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn resolves_new_paths_through_their_nearest_folder() {
        let t = Temp::new("resolve");
        fs::create_dir_all(t.0.join("src")).unwrap();
        assert_eq!(resolve_path(&t.0.join("src")), Some(t.0.join("src")));
        assert_eq!(
            resolve_path(&t.0.join("src/new/file.ts")),
            Some(t.0.join("src").join("new").join("file.ts"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_symlinks_and_refuses_broken_ones() {
        let t = Temp::new("links");
        let out = Temp::new("links-out");
        fs::write(out.0.join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(&out.0, t.0.join("away")).unwrap();
        std::os::unix::fs::symlink(out.0.join("missing"), t.0.join("dangling")).unwrap();
        assert_eq!(
            resolve_path(&t.0.join("away/secret")),
            Some(out.0.join("secret"))
        );
        // A new file under a link to outside resolves outside too.
        assert_eq!(
            resolve_path(&t.0.join("away/new.txt")),
            Some(out.0.join("new.txt"))
        );
        assert_eq!(resolve_path(&t.0.join("dangling")), None);
        let answer = handle(&json!({
            "op": "resolve",
            "paths": [t.0.join("away/secret").to_string_lossy(), t.0.join("dangling").to_string_lossy()],
        }))
        .unwrap_or_else(|f| panic!("{}", f.message));
        assert_eq!(answer, json!([canonical_text(&out.0.join("secret")), null]));
    }

    #[test]
    fn watches_the_folders_the_project_walk_visits() {
        let t = Temp::new("dirs");
        for d in ["src/lib", "node_modules/pkg", "target/debug", "logs"] {
            fs::create_dir_all(t.0.join(d)).unwrap();
        }
        fs::write(t.0.join(".gitignore"), "logs/\n*.log\n").unwrap();
        let mut dirs: Vec<String> = project_dirs(&t.0)
            .iter()
            .map(|d| canonical_text(d.strip_prefix(&t.0).unwrap()))
            .collect();
        dirs.sort();
        assert_eq!(dirs, ["", "src", "src/lib"]);

        let gi = ignore::gitignore::Gitignore::new(t.0.join(".gitignore")).0;
        assert!(!ignored_change(&t.0, &gi, &t.0.join("src/a.ts")));
        assert!(ignored_change(
            &t.0,
            &gi,
            &t.0.join("node_modules/pkg/x.js")
        ));
        assert!(ignored_change(&t.0, &gi, &t.0.join("dev.log")));
        assert!(ignored_change(&t.0, &gi, &t.0.join("logs/out.txt")));
    }

    /// `path` the way the app sends it: on Windows without the `\\?\` that canonicalize adds.
    fn plain(path: &Path) -> String {
        let s = path.to_string_lossy().to_string();
        s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
    }

    #[test]
    fn a_burst_sends_one_changed_per_wait_and_one_after_its_last_event() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut b = Batch::default();
        assert_eq!(b.tick(at(0)), Tick::Nothing);
        b.saw(at(0), true);
        b.saw(at(100), true);
        assert_eq!(b.tick(at(200)), Tick::Nothing);
        assert_eq!(b.tick(at(300)), Tick::Changed);
        assert_eq!(b.tick(at(350)), Tick::Nothing, "one per wait");
        // An event after the `changed` starts the next wait.
        b.saw(at(400), true);
        assert_eq!(b.tick(at(650)), Tick::Nothing);
        assert_eq!(b.tick(at(700)), Tick::Changed);
        // Ignored events never send anything, and a small burst asks for no recheck.
        b.saw(at(800), false);
        assert_eq!(b.tick(at(1200)), Tick::Nothing);
        assert_eq!(b.tick(at(1900)), Tick::Nothing);
        assert_eq!(b.tick(at(5000)), Tick::Nothing);
    }

    #[test]
    fn a_big_burst_is_rechecked_once_it_ends() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut b = Batch::default();
        // A flood of node_modules events, with no event that matters seen.
        for i in 0..BIG_BURST as u64 {
            b.saw(at(i), false);
        }
        let last = BIG_BURST as u64 - 1;
        assert_eq!(b.tick(at(last + 900)), Tick::Nothing, "still in the burst");
        assert_eq!(b.tick(at(last + 1000)), Tick::Recheck);
        assert_eq!(b.tick(at(last + 3000)), Tick::Nothing, "only once");
    }

    #[test]
    fn only_changes_the_project_walk_keeps_matter() {
        use notify::event::{AccessKind, CreateKind, Flag, ModifyKind, RenameMode};
        use notify::{Event, EventKind};
        let t = Temp::new("matters");
        fs::write(t.0.join(".gitignore"), "*.log\n").unwrap();
        let gi = ignore::gitignore::Gitignore::new(t.0.join(".gitignore")).0;
        let ev = |kind: EventKind, paths: &[&str]| {
            paths
                .iter()
                .fold(Event::new(kind), |e, p| e.add_path(t.0.join(p)))
        };
        let create = EventKind::Create(CreateKind::Any);
        assert!(event_matters(&ev(create, &["src/a.ts"]), &t.0, &gi));
        assert!(!event_matters(
            &ev(create, &["node_modules/x/index.js"]),
            &t.0,
            &gi
        ));
        assert!(!event_matters(&ev(create, &[".git/index"]), &t.0, &gi));
        assert!(!event_matters(&ev(create, &["dev.log"]), &t.0, &gi));
        assert!(!event_matters(
            &ev(EventKind::Access(AccessKind::Any), &["src/a.ts"]),
            &t.0,
            &gi
        ));
        // A rename out of an ignored folder into the project matters.
        let rename = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        assert!(event_matters(
            &ev(rename, &["target/out.ts", "src/out.ts"]),
            &t.0,
            &gi
        ));
        // A lost queue may hide anything.
        let lost = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert!(event_matters(&lost, &t.0, &gi));
    }

    #[test]
    fn a_folder_that_cant_be_watched_falls_back_to_polling() {
        let t = Temp::new("missing");
        let missing = plain(&t.0.join("gone"));
        let stop = AtomicBool::new(false);
        assert!(listen(&missing, &stop, &|| {}, &|| {}).is_err());
    }

    /// Starts `listen` on `root` in a thread; its `changed` events arrive on the receiver.
    fn listen_in_thread(
        root: String,
    ) -> (
        Arc<AtomicBool>,
        std::sync::mpsc::Receiver<()>,
        std::thread::JoinHandle<Result<(), String>>,
    ) {
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = Mutex::new(tx);
        let s2 = stop.clone();
        let worker = std::thread::spawn(move || {
            listen(
                &root,
                &s2,
                &|| {
                    let _ = tx.lock().unwrap().send(());
                },
                &|| {},
            )
        });
        // The watch is set up before the first change.
        std::thread::sleep(Duration::from_millis(500));
        (stop, rx, worker)
    }

    #[test]
    fn reports_project_changes_at_once_and_skips_ignored_ones() {
        let t = Temp::new("listen");
        fs::create_dir_all(t.0.join("src")).unwrap();
        fs::create_dir_all(t.0.join("node_modules")).unwrap();
        fs::write(t.0.join(".gitignore"), "*.log\n").unwrap();
        let (stop, rx, worker) = listen_in_thread(plain(&t.0));
        // Well under the 2 s poll: the batch wait plus a little.
        let quick = Duration::from_millis(1500);
        let settle = || {
            std::thread::sleep(Duration::from_millis(600));
            while rx.try_recv().is_ok() {}
        };
        let expect = |what: &str, change: &dyn Fn()| {
            settle();
            let start = Instant::now();
            change();
            assert!(rx.recv_timeout(quick).is_ok(), "no `changed` for {what}");
            eprintln!("{what}: {} ms", start.elapsed().as_millis());
        };
        let expect_none = |what: &str, change: &dyn Fn()| {
            settle();
            change();
            assert!(
                rx.recv_timeout(Duration::from_millis(1000)).is_err(),
                "`changed` for {what}"
            );
        };

        expect_none("a file in node_modules", &|| {
            fs::write(t.0.join("node_modules/x.js"), "x").unwrap()
        });
        expect_none("a file .gitignore leaves out", &|| {
            fs::write(t.0.join("dev.log"), "x").unwrap()
        });
        expect("a new file", &|| {
            fs::write(t.0.join("src/a.ts"), "a").unwrap()
        });
        expect("a modified file", &|| {
            fs::write(t.0.join("src/a.ts"), "changed").unwrap()
        });
        expect("a renamed file", &|| {
            fs::rename(t.0.join("src/a.ts"), t.0.join("src/b.ts")).unwrap()
        });
        expect("a new folder", &|| {
            fs::create_dir_all(t.0.join("src/new")).unwrap()
        });
        expect("a file in a folder created later", &|| {
            fs::write(t.0.join("src/new/c.ts"), "c").unwrap()
        });
        expect("a renamed folder", &|| {
            fs::rename(t.0.join("src/new"), t.0.join("src/moved")).unwrap()
        });
        expect("a file in a renamed folder", &|| {
            fs::write(t.0.join("src/moved/c.ts"), "c2").unwrap()
        });
        expect("a deleted file", &|| {
            fs::remove_file(t.0.join("src/b.ts")).unwrap()
        });
        expect("many new files", &|| {
            fs::create_dir_all(t.0.join("src/bulk")).unwrap();
            for i in 0..2000 {
                fs::write(t.0.join(format!("src/bulk/f{i}.ts")), "x").unwrap();
            }
        });
        expect("a deleted folder with many files", &|| {
            fs::remove_dir_all(t.0.join("src/bulk")).unwrap()
        });
        expect("a deleted folder", &|| {
            fs::remove_dir_all(t.0.join("src/moved")).unwrap()
        });

        stop.store(true, Ordering::Relaxed);
        assert_eq!(
            worker.join().unwrap(),
            Ok(()),
            "listened without falling back to polling"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_local_folder_gives_change_events() {
        let t = Temp::new("rdcw");
        assert_eq!(check_directory_events(Path::new(&plain(&t.0))), Ok(()));
        assert!(check_directory_events(&t.0.join("gone")).is_err());
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} failed");
    }

    #[test]
    fn reports_repository_changes_apart_from_file_changes() {
        let t = Temp::new("git");
        git(&t.0, &["init", "-q", "-b", "main"]);
        git(&t.0, &["commit", "-q", "--allow-empty", "-m", "one"]);
        let stop = Arc::new(AtomicBool::new(false));
        let (files_tx, files) = std::sync::mpsc::channel();
        let (repo_tx, repo) = std::sync::mpsc::channel();
        let (files_tx, repo_tx) = (Mutex::new(files_tx), Mutex::new(repo_tx));
        let (root, s2) = (plain(&t.0), stop.clone());
        let worker = std::thread::spawn(move || {
            listen(
                &root,
                &s2,
                &|| {
                    let _ = files_tx.lock().unwrap().send(());
                },
                &|| {
                    let _ = repo_tx.lock().unwrap().send(());
                },
            )
        });
        std::thread::sleep(Duration::from_millis(500));
        let settle = || {
            std::thread::sleep(Duration::from_millis(600));
            while files.try_recv().is_ok() {}
            while repo.try_recv().is_ok() {}
        };
        for args in [
            &["commit", "-q", "--allow-empty", "-m", "two"][..],
            &["checkout", "-q", "-b", "other"][..],
        ] {
            settle();
            git(&t.0, args);
            assert!(
                repo.recv_timeout(Duration::from_secs(3)).is_ok(),
                "no repository change for {args:?}"
            );
        }
        // A project file is a file change only.
        settle();
        fs::write(t.0.join("a.ts"), "a").unwrap();
        assert!(files.recv_timeout(Duration::from_secs(3)).is_ok());
        assert!(repo.recv_timeout(Duration::from_millis(800)).is_err());
        stop.store(true, Ordering::Relaxed);
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn the_polling_watcher_sees_a_commit_too() {
        let t = Temp::new("git-poll");
        git(&t.0, &["init", "-q", "-b", "main"]);
        git(&t.0, &["commit", "-q", "--allow-empty", "-m", "one"]);
        let dirs = git_state::find_git_dirs(&t.0).unwrap();
        let before = git_fingerprint(&dirs);
        fs::write(t.0.join("a.ts"), "a").unwrap();
        assert_eq!(
            git_fingerprint(&dirs),
            before,
            "a project file isn't the repository"
        );
        git(&t.0, &["commit", "-q", "--allow-empty", "-m", "two"]);
        assert_ne!(git_fingerprint(&dirs), before);
    }

    /// A command whose shell leaves something running in the background with the same pipes.
    fn leaves_a_background_process(seconds: u32) -> Value {
        if cfg!(windows) {
            json!([
                "cmd",
                "/c",
                format!("echo started & start /b ping -n {seconds} 127.0.0.1")
            ])
        } else {
            json!(["sh", "-c", format!("echo started; sleep {seconds} &")])
        }
    }

    #[test]
    fn a_command_that_leaves_something_running_returns_with_its_output() {
        let started = Instant::now();
        let out = exec(&json!({ "argv": leaves_a_background_process(15), "timeoutMs": 60_000 }))
            .unwrap_or_else(|f| panic!("{}", f.message));
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "waited {:?} for the background process",
            started.elapsed()
        );
        assert!(out["stdout"].as_str().unwrap().contains("started"), "{out}");
        assert_eq!(out["code"], 0);
        assert_eq!(out["timedOut"], false);
    }

    #[test]
    fn captured_output_keeps_its_head_and_tail() {
        let mut buf = CaptureBuf::new(3, 3);
        buf.push(b"abc");
        assert!(!buf.clipped());
        assert_eq!(buf.text(), "abc");
        buf.push(b"defgh");
        buf.push(b"ij");
        assert!(buf.clipped());
        let text = buf.text();
        assert!(text.starts_with("abc"), "{text}");
        assert!(text.ends_with("hij"), "{text}");
        assert!(text.contains("4 bytes of output omitted"), "{text}");
    }

    #[test]
    fn a_dropped_connection_ends_the_commands_still_running() {
        let argv = if cfg!(windows) {
            json!(["ping", "-n", "30", "127.0.0.1"])
        } else {
            json!(["sleep", "30"])
        };
        let run = "kill-all-test";
        let worker = std::thread::spawn(move || {
            exec(&json!({ "argv": argv, "runId": run, "timeoutMs": 60_000 }))
                .unwrap_or_else(|f| panic!("{}", f.message))
        });
        let until = Instant::now() + Duration::from_secs(5);
        while !exec_children()
            .lock()
            .unwrap()
            .values()
            .any(|(r, _)| r.as_deref() == Some(run))
        {
            assert!(Instant::now() < until, "the command never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        // What `kill_all` does for commands when the app's connection closes, for this one only:
        // other tests run commands at the same time.
        let killed = Instant::now();
        kill_execs(&|r| r == Some(run));
        let out = worker.join().unwrap();
        assert!(
            killed.elapsed() < Duration::from_secs(5),
            "{:?}",
            killed.elapsed()
        );
        assert_ne!(out["code"], 0, "{out}");
        assert!(!exec_children()
            .lock()
            .unwrap()
            .values()
            .any(|(r, _)| r.as_deref() == Some(run)));
    }

    /// Every event sent for the process `id` until its `exit`, as (stream, text), and the exit.
    fn events_until_exit(id: &str, wait: Duration) -> (String, Value) {
        let until = Instant::now() + wait;
        loop {
            let events: Vec<Value> = sent()
                .lock()
                .unwrap()
                .iter()
                .filter(|v| v["proc"] == id)
                .cloned()
                .collect();
            if let Some(i) = events.iter().position(|v| v["ev"] == "exit") {
                let out: Vec<u8> = events[..i]
                    .iter()
                    .filter(|v| v["ev"] == "out")
                    .flat_map(|v| b64().decode(v["data"].as_str().unwrap()).unwrap())
                    .collect();
                return (
                    String::from_utf8_lossy(&out).into_owned(),
                    events[i].clone(),
                );
            }
            assert!(Instant::now() < until, "no exit for {id}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn a_process_output_arrives_before_its_exit() {
        // The process ends at once; what it started prints a moment later, on the same pipe.
        let argv = if cfg!(windows) {
            json!(["cmd", "/c", "start /b ping -n 2 127.0.0.1"])
        } else {
            json!(["sh", "-c", "(sleep 0.4; echo late) & exit 0"])
        };
        spawn(&json!({ "proc": "late-output", "argv": argv }))
            .unwrap_or_else(|f| panic!("{}", f.message));
        let (out, _) = events_until_exit("late-output", Duration::from_secs(10));
        if cfg!(windows) {
            // Its header, both replies and the statistics.
            assert!(out.matches("127.0.0.1").count() >= 4, "{out}");
        } else {
            assert!(out.contains("late"), "{out}");
        }
    }

    #[test]
    fn a_process_can_be_killed_while_its_stdin_is_full() {
        // It never reads its stdin, so a big write blocks once the pipe is full.
        let argv = if cfg!(windows) {
            json!(["ping", "-n", "30", "127.0.0.1"])
        } else {
            json!(["sleep", "30"])
        };
        spawn(&json!({ "proc": "full-stdin", "argv": argv, "stdin": true }))
            .unwrap_or_else(|f| panic!("{}", f.message));
        let data = b64().encode(vec![b'x'; 16 * 1024 * 1024]);
        let writer = std::thread::spawn(move || {
            let _ = proc_stdin(&json!({ "proc": "full-stdin", "data": data }));
        });
        std::thread::sleep(Duration::from_millis(300));
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(proc_kill(&json!({ "proc": "full-stdin" })).is_ok());
        });
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)),
            Ok(true),
            "kill waited for the stdin write"
        );
        events_until_exit("full-stdin", Duration::from_secs(10));
        writer.join().unwrap();
    }

    #[test]
    fn each_write_gets_its_own_staging_file() {
        let target = Path::new("/home/me/app/a.ts");
        let (a, b) = (staging_path(target), staging_path(target));
        assert_ne!(a, b);
        assert_eq!(a.parent(), target.parent());
        assert!(a
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".a.ts.nyxs-"));
        // Two writes at once to the same file both land, whole.
        let t = Temp::new("writes");
        let path = plain(&t.0.join("a.ts"));
        let writers: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|text| {
                let path = path.clone();
                std::thread::spawn(move || {
                    write(&json!({ "path": path, "data": b64().encode(text) }))
                        .map(|_| ())
                        .map_err(|f| f.message)
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap().unwrap();
        }
        let text = fs::read_to_string(&path).unwrap();
        assert!(text == "first" || text == "second", "{text}");
        let left: Vec<_> = fs::read_dir(&t.0)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(left.len(), 1, "{left:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_write_through_a_symlink_keeps_the_link() {
        let t = Temp::new("write-link");
        fs::create_dir_all(t.0.join("real")).unwrap();
        fs::write(t.0.join("real/config.json"), "old").unwrap();
        std::os::unix::fs::symlink(t.0.join("real/config.json"), t.0.join("config.json")).unwrap();
        let link = plain(&t.0.join("config.json"));
        write(&json!({ "path": link, "data": b64().encode("new") }))
            .unwrap_or_else(|f| panic!("{}", f.message));
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(t.0.join("real/config.json")).unwrap(),
            "new"
        );
    }

    #[test]
    fn walk_text_leaves_out_the_text_of_files_the_app_already_has() {
        let t = Temp::new("walk-known");
        fs::write(t.0.join("a.ts"), "export const a = 1;\n").unwrap();
        fs::write(t.0.join("b.ts"), "export const b = 2;\n").unwrap();
        let root = plain(&t.0);
        let first = walk_text(&json!({ "root": root })).unwrap_or_else(|f| panic!("{}", f.message));
        let files = first.as_array().unwrap();
        assert_eq!(files.len(), 2);
        let entry = |name: &str| {
            files
                .iter()
                .find(|f| f["path"].as_str().unwrap().ends_with(name))
                .unwrap()
                .clone()
        };
        let (a, b) = (entry("a.ts"), entry("b.ts"));
        assert!(a["size"].as_u64().is_some(), "{a}");

        // a.ts as the app last saw it; b.ts with another size, as if it changed since.
        let known = json!([
            { "path": a["path"], "mtime": a["mtime"], "size": a["size"] },
            { "path": b["path"], "mtime": b["mtime"], "size": b["size"].as_u64().unwrap() + 1 },
        ]);
        let again = walk_text(&json!({ "root": root, "known": known }))
            .unwrap_or_else(|f| panic!("{}", f.message));
        let again = again.as_array().unwrap();
        let find = |name: &str| {
            again
                .iter()
                .find(|f| f["path"].as_str().unwrap().ends_with(name))
                .unwrap()
                .clone()
        };
        let (a2, b2) = (find("a.ts"), find("b.ts"));
        assert_eq!(a2["unchanged"], true, "{a2}");
        assert!(a2.get("text").is_none(), "{a2}");
        assert_eq!(b2["text"], "export const b = 2;\n");
        assert!(b2.get("unchanged").is_none(), "{b2}");
    }
}
