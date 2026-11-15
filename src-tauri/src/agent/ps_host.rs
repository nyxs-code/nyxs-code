use super::*;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};

const HOST_SCRIPT: &str = r#"
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding = $utf8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'
$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'
if ($env:NYXS_HOST_PIPE) {
  $nyxsStream = New-Object System.IO.Pipes.NamedPipeClientStream('.', $env:NYXS_HOST_PIPE, [System.IO.Pipes.PipeDirection]::InOut)
  $nyxsStream.Connect(20000)
} else {
  $nyxsClient = New-Object System.Net.Sockets.TcpClient('127.0.0.1', [int]$env:NYXS_HOST_PORT)
  $nyxsStream = $nyxsClient.GetStream()
}
$nyxsReader = New-Object System.IO.StreamReader($nyxsStream, $utf8)
$nyxsWriter = New-Object System.IO.StreamWriter($nyxsStream, $utf8)
$nyxsWriter.AutoFlush = $true
$nyxsWriter.WriteLine($env:NYXS_HOST_TOKEN)
Remove-Item env:NYXS_HOST_TOKEN, env:NYXS_HOST_PORT, env:NYXS_HOST_PIPE -ErrorAction SilentlyContinue
function Read-NyxsText([int]$n) {
  $buf = New-Object char[] $n
  $got = 0
  while ($got -lt $n) {
    $r = $nyxsReader.Read($buf, $got, $n - $got)
    if ($r -le 0) { throw 'host connection closed' }
    $got += $r
  }
  [string]::new($buf)
}
$nyxsBaseEnv = @{}
Get-ChildItem env: | ForEach-Object { $nyxsBaseEnv[$_.Name] = $_.Value }
while ($true) {
  # A reset connection throws instead of returning $null; carrying on would re-run the last command forever.
  try { $nyxsLine = $nyxsReader.ReadLine() } catch { break }
  if ($null -eq $nyxsLine) { break }
  # Header "tag<TAB>cwd length<TAB>command length", then both texts back to back.
  $nyxsParts = $nyxsLine.Split("`t")
  $nyxsTag = $nyxsParts[0]
  try {
    $nyxsCwd = Read-NyxsText ([int]$nyxsParts[1])
    $nyxsCmd = Read-NyxsText ([int]$nyxsParts[2])
  } catch { break }
  foreach ($n in @(Get-ChildItem env: | ForEach-Object Name)) {
    if (-not $nyxsBaseEnv.ContainsKey($n)) { Remove-Item -LiteralPath "env:$n" -ErrorAction SilentlyContinue }
  }
  foreach ($k in $nyxsBaseEnv.Keys) {
    if ([Environment]::GetEnvironmentVariable($k) -cne $nyxsBaseEnv[$k]) { [Environment]::SetEnvironmentVariable($k, $nyxsBaseEnv[$k]) }
  }
  $env:Path = ((@($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join ';') -split ';' | Where-Object { $_ } | Select-Object -Unique) -join ';'
  $global:LASTEXITCODE = 0
  $global:NyxsLastOk = $false
  $nyxsOk = $true
  try {
    Set-Location -LiteralPath $nyxsCwd -ErrorAction Stop
    [Environment]::CurrentDirectory = (Get-Location -PSProvider FileSystem).ProviderPath
    & ([scriptblock]::Create($nyxsCmd + "`n" + '$global:NyxsLastOk = $?')) | Out-Default
    $nyxsOk = $global:NyxsLastOk
  } catch {
    [Console]::Error.WriteLine(($_ | Out-String).TrimEnd())
    $nyxsOk = $false
  }
  $nyxsCode = if ($nyxsOk) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }
  [Console]::Out.Write("`n" + [char]0x1e + "NYXS_DONE_" + $nyxsTag + "_" + $nyxsCode + "`n")
  [Console]::Out.Flush()
  [Console]::Error.Write("`n" + [char]0x1e + "NYXS_DONE_" + $nyxsTag + "`n")
  [Console]::Error.Flush()
}
"#;

const MAX_IDLE: usize = 2;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

enum Chunk {
    Out(Vec<u8>),
    Err(Vec<u8>),
    OutEof,
    ErrEof,
}

/// The connection a host gets its commands through: a named pipe only this user can open (see
/// host_pipe.rs), or a localhost socket where a pipe couldn't be made.
enum Conn {
    Pipe(fs::File),
    Tcp(TcpStream),
}

impl Write for Conn {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Conn::Pipe(f) => f.write(buf),
            Conn::Tcp(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Conn::Pipe(f) => f.flush(),
            Conn::Tcp(s) => s.flush(),
        }
    }
}

impl Conn {
    /// Ends the connection, so the host reads the end of its input and exits.
    fn close(&self) {
        match self {
            Conn::Pipe(f) => super::host_pipe::close(f),
            Conn::Tcp(s) => {
                let _ = s.shutdown(std::net::Shutdown::Both);
            }
        }
    }
}

pub(crate) struct Host {
    id: u64,
    child: Arc<Mutex<Child>>,
    stream: Conn,
    rx: Receiver<Chunk>,
    seq: u64,
}

impl Drop for Host {
    fn drop(&mut self) {
        self.stream.close();
        if let Ok(mut map) = registry().lock() {
            map.remove(&self.id);
        }
    }
}

pub(crate) enum HostOutcome {
    Done(i32),
    Exited(i32),
    TimedOut,
    Cancelled,
}

pub(crate) struct HostRun {
    pub captured: super::shell::Captured,
    pub outcome: HostOutcome,
}

fn idle() -> &'static Mutex<Vec<Host>> {
    static IDLE: OnceLock<Mutex<Vec<Host>>> = OnceLock::new();
    IDLE.get_or_init(|| Mutex::new(Vec::new()))
}

fn registry() -> &'static Mutex<HashMap<u64, Arc<Mutex<Child>>>> {
    static ALL: OnceLock<Mutex<HashMap<u64, Arc<Mutex<Child>>>>> = OnceLock::new();
    ALL.get_or_init(|| Mutex::new(HashMap::new()))
}

static HOST_SEQ: AtomicU64 = AtomicU64::new(1);
static WARMING: AtomicUsize = AtomicUsize::new(0);

fn random_token() -> String {
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i);
        h.write_u128(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// Host scripts of other versions (or other install paths) untouched for this long are deleted
/// when the host first starts. PowerShell reads a script and closes it, so a lock can't tell
/// whether another open Nyxs still uses one: each instance bumps its own script's mtime when it
/// starts and rewrites it if it's gone, so an instance open for days only loses its file until
/// its next host starts.
const STALE_SCRIPT_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Where this build's host script lives and what it holds: the name carries a hash of the
/// content, so each version and each executable path gets its own file.
fn script_location() -> Result<(PathBuf, String), String> {
    use sha2::{Digest, Sha256};
    let text = format!(
        "\u{feff}{}{}{HOST_SCRIPT}",
        super::job::start_detached(),
        super::job::START_PROCESS_HIDDEN
    );
    let hash: String = Sha256::digest(text.as_bytes())[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let dir = crate::project_paths::home_dir()
        .ok_or("host: no home directory")?
        .join(".nyxs")
        .join("shell");
    Ok((dir.join(format!("nyxs-host-{hash}.ps1")), text))
}

fn write_script(path: &Path, text: &str) -> Result<(), String> {
    if fs::read_to_string(path).ok().as_deref() == Some(text) {
        return Ok(());
    }
    let dir = path.parent().ok_or("host: script has no folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("host: {e}"))?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("nyxs-host");
    let tmp = dir.join(format!("{stem}.{}.tmp", std::process::id()));
    fs::write(&tmp, text).map_err(|e| format!("host: {e}"))?;
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
        if fs::read_to_string(path).ok().as_deref() != Some(text) {
            return Err(format!("host: could not write {}", path.display()));
        }
    }
    Ok(())
}

/// Deletes the host scripts (and leftover temporary files) in `dir` other than `keep` that
/// haven't been modified for `max_age`. A file that can't be deleted is left for next time.
fn prune_old_scripts(dir: &Path, keep: &Path, max_age: Duration, now: SystemTime) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path == keep
            || !name.starts_with("nyxs-host-")
            || !(name.ends_with(".ps1") || name.ends_with(".tmp"))
        {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age >= max_age);
        if old && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn host_script() -> Result<&'static PathBuf, String> {
    static SCRIPT: OnceLock<(PathBuf, String)> = OnceLock::new();
    static CHECKED: AtomicBool = AtomicBool::new(false);
    let (path, text) = match SCRIPT.get() {
        Some(s) => s,
        None => {
            let s = script_location()?;
            SCRIPT.get_or_init(|| s)
        }
    };
    if !CHECKED.swap(true, Ordering::AcqRel) {
        if let Err(e) = write_script(path, text) {
            CHECKED.store(false, Ordering::Release);
            return Err(e);
        }
        // Marks the script as in use, so another instance's start-up doesn't take it for stale.
        let _ = fs::File::options()
            .write(true)
            .open(path)
            .and_then(|f| f.set_modified(SystemTime::now()));
        let (dir, keep) = (path.parent().map(Path::to_path_buf), path.clone());
        std::thread::spawn(move || {
            if let Some(dir) = dir {
                prune_old_scripts(&dir, &keep, STALE_SCRIPT_AGE, SystemTime::now());
            }
        });
    } else if !path.exists() {
        // Another instance deleted it while this one stayed open.
        write_script(path, text)?;
    }
    Ok(path)
}

fn request(tag: &str, cwd: &str, command: &str) -> String {
    format!(
        "{tag}\t{}\t{}\n{cwd}{command}",
        cwd.encode_utf16().count(),
        command.encode_utf16().count()
    )
}

fn pump<R: Read + Send + 'static>(reader: R, tx: mpsc::Sender<Chunk>, out: bool) {
    std::thread::spawn(move || {
        let mut buf = BufReader::new(reader);
        loop {
            let mut line = Vec::new();
            match buf.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let chunk = if out {
                        Chunk::Out(line)
                    } else {
                        Chunk::Err(line)
                    };
                    if tx.send(chunk).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = tx.send(if out { Chunk::OutEof } else { Chunk::ErrEof });
    });
}

fn accept_host(
    listener: &TcpListener,
    token: &str,
    child: &Arc<Mutex<Child>>,
) -> Result<TcpStream, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("host: {e}"))?;
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut line = String::new();
                let ok = stream
                    .try_clone()
                    .ok()
                    .map(|s| BufReader::new(s).read_line(&mut line).is_ok())
                    .unwrap_or(false);
                if ok && line.trim_end() == token {
                    let _ = stream.set_read_timeout(None);
                    return Ok(stream);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if let Ok(Some(_)) = child.lock().unwrap_or_else(|e| e.into_inner()).try_wait() {
                    return Err("host: PowerShell exited before connecting".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("host: {e}")),
        }
    }
    Err("host: PowerShell didn't connect in time".into())
}

/// Where a host being started will connect.
enum Listen {
    Pipe(super::host_pipe::PipeServer),
    Tcp(TcpListener, u16),
}

fn listen() -> Result<Listen, String> {
    let name = format!("nyxs-host-{}-{}", std::process::id(), &random_token()[..16]);
    match super::host_pipe::create(&name) {
        Ok(pipe) => Ok(Listen::Pipe(pipe)),
        Err(e) => {
            log::warn!("host: no named pipe ({e}), using a local socket");
            let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("host: {e}"))?;
            let port = listener
                .local_addr()
                .map_err(|e| format!("host: {e}"))?
                .port();
            Ok(Listen::Tcp(listener, port))
        }
    }
}

fn spawn_host() -> Result<Host, String> {
    let listen = listen()?;
    let token = random_token();
    let script = host_script()?;
    let mut cmd = Command::new(super::shell::powershell_exe());
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
    ])
    .arg(script)
    .env("NYXS_HOST_TOKEN", &token)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    set_noninteractive_env(&mut cmd);
    match &listen {
        Listen::Pipe(pipe) => cmd.env("NYXS_HOST_PIPE", &pipe.name),
        Listen::Tcp(_, port) => cmd.env("NYXS_HOST_PORT", port.to_string()),
    };
    // Inside the agent's job from its first instruction, so whatever it starts dies with Nyxs.
    let mut child = super::job::spawn_contained(&mut cmd).map_err(|e| format!("host: {e}"))?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    if let Some(out) = child.stdout.take() {
        pump(out, tx.clone(), true);
    }
    if let Some(err) = child.stderr.take() {
        pump(err, tx, false);
    }
    let child = Arc::new(Mutex::new(child));
    let connected = match listen {
        Listen::Pipe(pipe) => {
            let alive = || {
                !matches!(
                    child.lock().unwrap_or_else(|e| e.into_inner()).try_wait(),
                    Ok(Some(_))
                )
            };
            pipe.accept(pid, &token, Instant::now() + CONNECT_TIMEOUT, alive)
                .map(Conn::Pipe)
        }
        Listen::Tcp(listener, _) => accept_host(&listener, &token, &child).map(Conn::Tcp),
    };
    let stream = match connected {
        Ok(s) => s,
        Err(e) => {
            super::shell::kill_tree(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
            return Err(e);
        }
    };
    let id = HOST_SEQ.fetch_add(1, Ordering::Relaxed);
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, child.clone());
    Ok(Host {
        id,
        child,
        stream,
        rx,
        seq: 0,
    })
}

fn prewarm() {
    if WARMING.fetch_add(1, Ordering::AcqRel) > 0 {
        WARMING.fetch_sub(1, Ordering::AcqRel);
        return;
    }
    std::thread::spawn(|| {
        if let Ok(host) = spawn_host() {
            release(host);
        }
        WARMING.fetch_sub(1, Ordering::AcqRel);
    });
}

pub(crate) fn warm() {
    let empty = idle().lock().map(|v| v.is_empty()).unwrap_or(false);
    if empty {
        prewarm();
    }
}

pub(crate) fn acquire() -> Result<Host, String> {
    let popped = idle().lock().ok().and_then(|mut v| v.pop());
    let host = match popped {
        Some(h) => h,
        None => spawn_host()?,
    };
    warm();
    Ok(host)
}

pub(crate) fn release(host: Host) {
    if let Ok(mut v) = idle().lock() {
        if v.len() < MAX_IDLE {
            v.push(host);
        }
    }
}

/// Closes the pooled hosts' connections so they exit on their own, after any host
/// still warming up has joined the pool.
#[cfg(test)]
pub(crate) fn close_idle() {
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    while WARMING.load(Ordering::Acquire) > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let hosts = idle()
        .lock()
        .map(|mut v| std::mem::take(&mut *v))
        .unwrap_or_default();
    drop(hosts);
}

pub(crate) fn kill_host(host: Host) {
    super::shell::kill_tree(&mut host.child.lock().unwrap_or_else(|e| e.into_inner()));
}

pub(crate) fn shutdown_all() {
    if let Ok(mut v) = idle().lock() {
        v.clear();
    }
    let children: Vec<Arc<Mutex<Child>>> = match registry().lock() {
        Ok(map) => map.values().cloned().collect(),
        Err(_) => return,
    };
    for child in children {
        if let Ok(mut c) = child.lock() {
            super::shell::kill_tree(&mut c);
        }
    }
}

struct Side {
    buf: super::shell::CaptureBuf,
    pending: Option<Vec<u8>>,
    done: bool,
    eof: bool,
}

impl Side {
    fn new(log: Option<&super::output_log::LogRequest>, stream: &str) -> Self {
        Side {
            buf: super::shell::CaptureBuf::logged(log, stream),
            pending: None,
            done: false,
            eof: false,
        }
    }

    fn line(&mut self, line: Vec<u8>) {
        if let Some(prev) = self.pending.replace(line) {
            self.buf.push(&prev);
        }
    }

    fn finish(&mut self, strip_injected_newline: bool) {
        if let Some(mut last) = self.pending.take() {
            if strip_injected_newline && last.last() == Some(&b'\n') {
                last.pop();
            }
            self.buf.push(&last);
        }
    }
}

pub(crate) fn run(
    host: &mut Host,
    command: &str,
    cwd: &str,
    timeout: Duration,
    cancel: &AtomicBool,
    log: Option<&super::output_log::LogRequest>,
) -> Result<HostRun, String> {
    host.seq += 1;
    let tag = format!("{}_{}", host.id, host.seq);
    host.stream
        .write_all(request(&tag, cwd, command).as_bytes())
        .map_err(|e| format!("host: {e}"))?;
    let out_marker = format!("\u{1e}NYXS_DONE_{tag}_").into_bytes();
    let err_marker = format!("\u{1e}NYXS_DONE_{tag}").into_bytes();
    let mut out = Side::new(log, "stdout");
    let mut err = Side::new(log, "stderr");
    let mut code = 0i32;
    let start = Instant::now();
    let outcome = loop {
        if cancel.load(Ordering::Acquire) {
            break HostOutcome::Cancelled;
        }
        if start.elapsed() >= timeout {
            break HostOutcome::TimedOut;
        }
        match host.rx.recv_timeout(Duration::from_millis(20)) {
            Ok(Chunk::Out(line)) => {
                if line.starts_with(&out_marker) {
                    let rest = String::from_utf8_lossy(&line[out_marker.len()..])
                        .trim()
                        .to_string();
                    code = rest.parse().unwrap_or(1);
                    out.finish(true);
                    out.done = true;
                } else {
                    out.line(line);
                }
            }
            Ok(Chunk::Err(line)) => {
                if line.starts_with(&err_marker)
                    && line[err_marker.len()..].iter().all(u8::is_ascii_whitespace)
                {
                    err.finish(true);
                    err.done = true;
                } else {
                    err.line(line);
                }
            }
            Ok(Chunk::OutEof) => out.eof = true,
            Ok(Chunk::ErrEof) => err.eof = true,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                out.eof = true;
                err.eof = true;
            }
        }
        if out.done && err.done {
            break HostOutcome::Done(code);
        }
        if out.eof && err.eof {
            let status = host
                .child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .wait()
                .ok()
                .and_then(|s| s.code());
            break HostOutcome::Exited(status.unwrap_or(-1));
        }
    };
    if !out.done {
        out.finish(false);
    }
    if !err.done {
        err.finish(false);
    }
    Ok(HostRun {
        captured: super::shell::Captured {
            stdout: out.buf.text(),
            stderr: err.buf.text(),
            stdout_log: out.buf.finish_log(),
            stderr_log: err.buf.finish_log(),
        },
        outcome,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    /// Runs in a child test process: starts a host, runs one command on it and dies
    /// without any cleanup, the way a crashed Nyxs or a finished test binary leaves it.
    #[test]
    fn prunes_only_other_stale_host_scripts() {
        let dir = std::env::temp_dir().join(format!("nyxs-host-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let day = Duration::from_secs(24 * 60 * 60);
        let now = SystemTime::now();
        let make = |name: &str, age: Duration| {
            let path = dir.join(name);
            fs::write(&path, "x").unwrap();
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(now - age)
                .unwrap();
            path
        };
        let current = make("nyxs-host-current.ps1", day * 30);
        let old = make("nyxs-host-old.ps1", day * 2);
        let old_tmp = make("nyxs-host-old.1234.tmp", day * 2);
        let other_instance = make("nyxs-host-recent.ps1", Duration::from_secs(60));
        let unrelated = make("notes.ps1", day * 30);

        assert_eq!(prune_old_scripts(&dir, &current, day, now), 2);
        assert!(current.exists(), "the current script is kept however old");
        assert!(other_instance.exists(), "a script used recently is kept");
        assert!(unrelated.exists(), "only host scripts are touched");
        assert!(!old.exists() && !old_tmp.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "helper process for the owner-death tests"]
    fn owner_helper() {
        let Ok(mode) = std::env::var("NYXS_HOST_OWNER_MODE") else {
            return;
        };
        let pid_file = std::env::var("NYXS_HOST_OWNER_PIDFILE").unwrap();
        let marker = std::env::var("NYXS_HOST_OWNER_MARKER").unwrap();
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        super::super::job::SKIP_JOB.store(mode == "idle", Ordering::Relaxed);
        let mut host = spawn_host().unwrap();
        let cancel = AtomicBool::new(false);
        let add = format!("Add-Content -LiteralPath '{marker}' -Value x");
        let first = run(
            &mut host,
            &add,
            &cwd,
            Duration::from_secs(10),
            &cancel,
            None,
        )
        .unwrap();
        assert!(
            matches!(first.outcome, HostOutcome::Done(0)),
            "{}",
            first.captured.stderr
        );
        if mode == "busy" {
            host.stream
                .write_all(request("busy", &cwd, "Start-Sleep -Seconds 60").as_bytes())
                .unwrap();
            std::thread::sleep(Duration::from_millis(500));
        }
        std::fs::write(
            &pid_file,
            host.child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .id()
                .to_string(),
        )
        .unwrap();
        std::process::exit(0);
    }

    /// Returns whether the orphaned host exited within a few seconds and how many times
    /// its one command ran.
    fn orphan_host(mode: &str) -> (bool, usize) {
        let dir =
            std::env::temp_dir().join(format!("nyxs-host-owner-{mode}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("pid");
        let marker = dir.join("runs.txt");
        let helper = format!(
            "{}::owner_helper",
            module_path!().split_once("::").unwrap().1
        );
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args([helper.as_str(), "--exact", "--ignored", "--nocapture"])
            .env("NYXS_HOST_OWNER_MODE", mode)
            .env("NYXS_HOST_OWNER_PIDFILE", &pid_file)
            .env("NYXS_HOST_OWNER_MARKER", &marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut cmd);
        cmd.status().unwrap();
        let pid: u32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let exited = unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid);
            if handle.is_null() {
                true
            } else {
                let exited = WaitForSingleObject(handle, 5_000) == WAIT_OBJECT_0;
                if !exited {
                    TerminateProcess(handle, 1);
                    WaitForSingleObject(handle, 5_000);
                }
                CloseHandle(handle);
                exited
            }
        };
        let runs = std::fs::read_to_string(&marker)
            .map(|s| s.lines().count())
            .unwrap_or(0);
        let _ = std::fs::remove_dir_all(&dir);
        (exited, runs)
    }

    /// Runs `command` on `host` and returns its stdout and the console windows shown meanwhile.
    fn run_watched(
        host: &mut Host,
        command: &str,
        cwd: &str,
    ) -> (String, Vec<super::super::window_watch::Shown>) {
        let cancel = AtomicBool::new(false);
        let (r, shown) = super::super::window_watch::console_windows_shown_during(|| {
            run(host, command, cwd, Duration::from_secs(30), &cancel, None).unwrap()
        });
        assert!(
            matches!(r.outcome, HostOutcome::Done(0)),
            "{command}: {}",
            r.captured.stderr
        );
        eprintln!("{command}: windows {shown:?}");
        (r.captured.stdout.trim().to_string(), shown)
    }

    #[test]
    fn console_programs_the_agent_starts_show_no_window() {
        let dir = std::env::temp_dir().join(format!("nyxs-console-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("x.ps1"), "Write-Output 'from x.ps1'").unwrap();
        fs::write(dir.join("x.bat"), "@exit /b 0\r\n").unwrap();
        fs::write(dir.join("notes.txt"), "x").unwrap();
        let cwd = dir.to_string_lossy().to_string();
        let mut host = spawn_host().unwrap();

        // A console program asked for by window style still gets its window. Where none shows
        // (a desktop no one is logged on to), windows can't be seen at all and the checks below
        // would prove nothing.
        let (_, shown) = run_watched(
            &mut host,
            "Start-Process -Wait cmd -ArgumentList '/c','exit' -WindowStyle Minimized",
            &cwd,
        );
        let can_see = !shown.is_empty();
        if !can_see {
            eprintln!("no console window seen even when asked for one: skipping the window checks");
        }

        // Direct children share the host's windowless console, and their output is captured.
        let quiet = [
            ("cmd /c echo hi", "hi"),
            ("powershell -NoProfile -File x.ps1", "from x.ps1"),
            ("Start-Process -Wait cmd -ArgumentList '/c','exit'", ""),
            (
                "Start-Process -Wait powershell -ArgumentList '-NoProfile','-File','x.ps1'",
                "",
            ),
            ("Start-Process -Wait .\\x.bat", ""),
            (
                "(Start-Process -Wait -PassThru cmd -ArgumentList '/c','exit 3').ExitCode",
                "3",
            ),
            (
                "Start-Process -Wait -NoNewWindow cmd -ArgumentList '/c','echo shared'",
                "shared",
            ),
        ];
        for (command, out) in quiet {
            let (stdout, shown) = run_watched(&mut host, command, &cwd);
            assert_eq!(stdout, out, "{command}");
            if can_see {
                assert!(shown.is_empty(), "{command} showed a console: {shown:?}");
            }
        }

        // GUI programs, documents and URLs keep the window style they had.
        let (stdout, _) = run_watched(
            &mut host,
            "@('cmd', 'powershell.exe', '.\\x.bat', 'x.bat', 'notepad', 'explorer.exe', 'notes.txt', 'https://example.com', 'no-such-program') | ForEach-Object { \"$_=$(Test-NyxsConsoleProgram $_)\" }",
            &cwd,
        );
        assert_eq!(
            stdout.lines().map(str::trim).collect::<Vec<_>>(),
            [
                "cmd=True",
                "powershell.exe=True",
                ".\\x.bat=True",
                "x.bat=True",
                "notepad=False",
                "explorer.exe=False",
                "notes.txt=False",
                "https://example.com=False",
                "no-such-program=False",
            ]
        );
        drop(host);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn idle_host_exits_when_its_owner_dies() {
        let (exited, runs) = orphan_host("idle");
        assert!(exited, "the host outlived its owner");
        assert_eq!(
            runs, 1,
            "the host kept re-running its last command after losing its owner"
        );
    }

    #[test]
    fn busy_host_is_killed_with_its_owner() {
        let (exited, runs) = orphan_host("busy");
        assert!(
            exited,
            "a host in the middle of a command outlived its owner"
        );
        assert_eq!(runs, 1);
    }
}
