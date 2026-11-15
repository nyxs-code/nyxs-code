//! Shells left running in the background: their live output, listing, killing and shutdown.

use super::env::shell_command;
use crate::agent::*;
use crate::error::CmdError;
use std::sync::atomic::AtomicBool;

const MAX_BG_OUTPUT: usize = 200_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgShell {
    pub(super) id: String,
    pub(super) command: String,

    pub(super) description: String,

    /// The folder it runs in, so the browser of one project doesn't open another's server.
    pub(super) cwd: Option<String>,

    pub(super) output: String,

    pub(super) status: String,

    pub(super) code: Option<i32>,

    pub(super) started_at: u64,

    pub(super) ended_at: Option<u64>,

    #[serde(skip)]
    pub(super) dropped: usize,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BgOutputEvent {
    id: String,

    stream: String,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BgExitEvent {
    id: String,
    status: String,
    code: Option<i32>,
    ended_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgOutputResult {
    output: String,
    next_offset: usize,
    status: String,
    code: Option<i32>,
}

static BG_SHELLS: OnceLock<Mutex<HashMap<String, BgShell>>> = OnceLock::new();
/// A background shell's process: here, or on a remote machine (`ssh://` folder).
pub(super) enum BgChild {
    Local(Child),
    Remote(crate::remote::procs::RemoteHandle),
}

impl BgChild {
    fn try_wait(&mut self) -> std::io::Result<Option<Option<i32>>> {
        match self {
            BgChild::Local(c) => c.try_wait().map(|s| s.map(|s| s.code())),
            BgChild::Remote(h) => Ok(h.try_wait()),
        }
    }

    fn kill(&mut self) {
        match self {
            BgChild::Local(c) => kill_tree(c),
            BgChild::Remote(h) => h.kill(),
        }
    }
}

static BG_CHILDREN: OnceLock<Mutex<HashMap<String, Arc<Mutex<BgChild>>>>> = OnceLock::new();
static BG_COUNTER: AtomicU64 = AtomicU64::new(1);

pub(super) fn bg_shells() -> &'static Mutex<HashMap<String, BgShell>> {
    BG_SHELLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn bg_children() -> &'static Mutex<HashMap<String, Arc<Mutex<BgChild>>>> {
    BG_CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn next_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

const BG_FLUSH_EVERY: Duration = Duration::from_millis(80);

type PendingLines = Arc<Mutex<Vec<(&'static str, String)>>>;

fn group_by_stream(lines: Vec<(&'static str, String)>) -> Vec<(&'static str, String)> {
    let mut groups: Vec<(&'static str, String)> = Vec::new();
    for (stream, line) in lines {
        match groups.last_mut() {
            Some((s, text)) if *s == stream => {
                text.push('\n');
                text.push_str(&line);
            }
            _ => groups.push((stream, line)),
        }
    }
    groups
}

fn flush_pending(app: &AppHandle, id: &str, pending: &PendingLines) {
    let lines = match pending.lock() {
        Ok(mut p) => std::mem::take(&mut *p),
        Err(_) => return,
    };
    for (stream, line) in group_by_stream(lines) {
        let _ = app.emit(
            "bg-shell-output",
            BgOutputEvent {
                id: id.to_string(),
                stream: stream.into(),
                line,
            },
        );
    }
}

fn spawn_flusher(
    app: AppHandle,
    id: String,
    pending: PendingLines,
    closed: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        while !closed.load(Ordering::Acquire) {
            std::thread::sleep(BG_FLUSH_EVERY);
            flush_pending(&app, &id, &pending);
        }
        flush_pending(&app, &id, &pending);
    })
}

fn spawn_reader<R: Read + Send + 'static>(
    pending: PendingLines,
    id: String,
    stream: &'static str,
    reader: R,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = BufReader::new(reader);
        let mut raw: Vec<u8> = Vec::new();
        loop {
            raw.clear();
            match buf.read_until(b'\n', &mut raw) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&raw)
                .trim_end_matches(['\n', '\r'])
                .to_string();
            if let Ok(mut map) = bg_shells().lock() {
                if let Some(sh) = map.get_mut(&id) {
                    sh.output.push_str(&line);
                    sh.output.push('\n');
                    if sh.output.len() > MAX_BG_OUTPUT {
                        let cut = next_char_boundary(&sh.output, sh.output.len() - MAX_BG_OUTPUT);
                        sh.output.drain(..cut);
                        sh.dropped += cut;
                    }
                }
            }
            if let Ok(mut p) = pending.lock() {
                p.push((stream, line));
            }
        }
    })
}

#[tauri::command(async)]
pub fn agent_run_background(
    app: AppHandle,
    command: String,
    cwd: Option<String>,
    description: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<BgShell, CmdError> {
    if let Some(r) = cwd.as_deref().and_then(crate::remote::parse) {
        let mut child = crate::remote::procs::spawn(
            &r.host,
            crate::remote::procs::Spawn {
                command: Some(&command),
                argv: None,
                cwd: Some(&r.path),
                env: env.as_ref(),
                stdin: false,
                interactive: false,
            },
        )
        .map_err(|e| CmdError::from(e.message))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        return Ok(track_background(
            app,
            command,
            cwd,
            description,
            BgChild::Remote(child.handle()),
            stdout,
            stderr,
        ));
    }
    let mut cmd = shell_command(&command);
    if let Some(dir) = &cwd {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }
    set_noninteractive_env(&mut cmd);
    // A dev server's own variables (launch.json's `env`, the PORT it was moved to).
    for (k, v) in env.unwrap_or_default() {
        if !k.is_empty() && !k.contains('=') {
            cmd.env(k, v);
        }
    }
    hide_console(&mut cmd);

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    // On Windows it starts already inside the agent's job, so nothing it starts escapes it.
    #[cfg(target_os = "windows")]
    let spawned = crate::agent::job::spawn_contained(&mut cmd);
    #[cfg(not(target_os = "windows"))]
    let spawned = cmd.spawn();
    let mut child = spawned.map_err(CmdError::command_start_failed)?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    Ok(track_background(
        app,
        command,
        cwd,
        description,
        BgChild::Local(child),
        stdout,
        stderr,
    ))
}

/// Records a started background shell and follows its output and end, wherever it runs.
fn track_background<O, E>(
    app: AppHandle,
    command: String,
    cwd: Option<String>,
    description: Option<String>,
    child: BgChild,
    stdout: Option<O>,
    stderr: Option<E>,
) -> BgShell
where
    O: Read + Send + 'static,
    E: Read + Send + 'static,
{
    let id = format!("bash_{}", BG_COUNTER.fetch_add(1, Ordering::Relaxed));
    let info = BgShell {
        id: id.clone(),
        command: command.clone(),
        description: description.unwrap_or_default(),
        cwd: cwd.filter(|d| !d.is_empty()),
        output: String::new(),
        status: "running".into(),
        code: None,
        started_at: now_ms(),
        ended_at: None,
        dropped: 0,
    };
    bg_shells()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), info.clone());
    bg_children()
        .lock()
        .unwrap()
        .insert(id.clone(), Arc::new(Mutex::new(child)));

    let pending: PendingLines = Arc::new(Mutex::new(Vec::new()));
    let closed = Arc::new(AtomicBool::new(false));
    let flusher = spawn_flusher(app.clone(), id.clone(), pending.clone(), closed.clone());
    let out_handle = stdout.map(|s| spawn_reader(pending.clone(), id.clone(), "stdout", s));
    let err_handle = stderr.map(|s| spawn_reader(pending.clone(), id.clone(), "stderr", s));

    let waiter_app = app.clone();
    let waiter_id = id.clone();
    std::thread::spawn(move || {
        if let Some(h) = out_handle {
            let _ = h.join();
        }
        if let Some(h) = err_handle {
            let _ = h.join();
        }
        closed.store(true, Ordering::Release);
        let _ = flusher.join();

        let code = loop {
            let arc = bg_children()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&waiter_id)
                .cloned();
            let Some(arc) = arc else { break None };
            let status = {
                let mut child = arc.lock().unwrap_or_else(|e| e.into_inner());
                child.try_wait()
            };
            match status {
                Ok(Some(code)) => break code,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break None,
            }
        };

        let mut final_status = String::from("done");
        let ended_at = now_ms();
        if let Ok(mut map) = bg_shells().lock() {
            if let Some(sh) = map.get_mut(&waiter_id) {
                if sh.status != "killed" {
                    sh.status = "done".into();
                }
                sh.code = code;
                sh.ended_at = Some(ended_at);
                final_status = sh.status.clone();
            }
        }
        bg_children()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&waiter_id);
        let _ = waiter_app.emit(
            "bg-shell-exit",
            BgExitEvent {
                id: waiter_id.clone(),
                status: final_status,
                code,
                ended_at,
            },
        );
    });

    info
}

#[tauri::command]
pub async fn agent_bg_output(
    id: String,
    after: Option<usize>,
    wait_ms: Option<u64>,
) -> Result<BgOutputResult, String> {
    tauri::async_runtime::spawn_blocking(move || agent_bg_output_blocking(id, after, wait_ms))
        .await
        .map_err(|e| format!("Couldn't read the shell's output: {e}"))?
}

fn agent_bg_output_blocking(
    id: String,
    after: Option<usize>,
    wait_ms: Option<u64>,
) -> Result<BgOutputResult, String> {
    let after = after.unwrap_or(0);
    let deadline_ms = wait_ms.unwrap_or(0).min(120_000);
    let poll_interval = std::time::Duration::from_millis(150);
    let mut waited: u64 = 0;
    loop {
        {
            let map = bg_shells().lock().unwrap_or_else(|e| e.into_inner());
            let sh = map
                .get(&id)
                .ok_or_else(|| format!("No background shell with id {id}"))?;
            let end = sh.dropped + sh.output.len();
            let has_new = end > after;
            let finished = sh.status != "running";
            if deadline_ms == 0 || has_new || finished || waited >= deadline_ms {
                let relative = after.saturating_sub(sh.dropped).min(sh.output.len());
                let start = next_char_boundary(&sh.output, relative);
                return Ok(BgOutputResult {
                    output: sh.output[start..].to_string(),
                    next_offset: end,
                    status: sh.status.clone(),
                    code: sh.code,
                });
            }
        }

        std::thread::sleep(poll_interval);
        waited += poll_interval.as_millis() as u64;
    }
}

#[tauri::command(async)]
pub fn agent_bg_kill(id: String) -> Result<String, String> {
    {
        let mut map = bg_shells().lock().unwrap_or_else(|e| e.into_inner());
        match map.get_mut(&id) {
            Some(sh) => {
                if sh.status != "running" {
                    return Ok(format!("Shell {id} is no longer running."));
                }
                sh.status = "killed".into();
            }
            None => return Err(format!("No background shell with id {id}")),
        }
    }
    if let Some(arc) = bg_children()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .cloned()
    {
        let mut child = arc.lock().unwrap_or_else(|e| e.into_inner());
        child.kill();
    }
    Ok(format!("Shell {id} terminado."))
}

pub fn bg_shutdown_all() {
    #[cfg(target_os = "windows")]
    crate::agent::ps_host::shutdown_all();
    let children: Vec<Arc<Mutex<BgChild>>> = match bg_children().lock() {
        Ok(map) => map.values().cloned().collect(),
        Err(_) => return,
    };
    for arc in children {
        if let Ok(mut child) = arc.lock() {
            child.kill();
        }
    }
}

#[tauri::command]
pub fn agent_bg_list() -> Vec<BgShell> {
    let mut shells: Vec<BgShell> = bg_shells()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect();
    shells.sort_by(|a, b| a.id.cmp(&b.id));
    shells
}

#[tauri::command]
/// Drops finished shells; with `ids`, only those (the panel shows one project's at a time).
pub fn agent_bg_clear(ids: Option<Vec<String>>) -> Vec<BgShell> {
    let mut map = bg_shells().lock().unwrap_or_else(|e| e.into_inner());
    map.retain(|id, sh| {
        sh.status == "running" || ids.as_ref().is_some_and(|ids| !ids.contains(id))
    });
    let mut shells: Vec<BgShell> = map.values().cloned().collect();
    shells.sort_by(|a, b| a.id.cmp(&b.id));
    shells
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{HOSTS, SLOW};
    use super::*;

    #[test]
    fn batched_output_keeps_order_and_stream() {
        let lines = vec![
            ("stdout", "a".to_string()),
            ("stdout", "b".to_string()),
            ("stderr", "warn".to_string()),
            ("stdout", "c".to_string()),
        ];
        assert_eq!(
            group_by_stream(lines),
            vec![
                ("stdout", "a\nb".to_string()),
                ("stderr", "warn".to_string()),
                ("stdout", "c".to_string()),
            ]
        );
    }

    #[test]
    fn shutdown_kills_background_shells() {
        let _exclusive = HOSTS.write().unwrap_or_else(|e| e.into_inner());
        let mut cmd = shell_command(SLOW);
        hide_console(&mut cmd);
        let child = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let arc = Arc::new(Mutex::new(BgChild::Local(child)));
        bg_children()
            .lock()
            .unwrap()
            .insert("test-shutdown".into(), arc.clone());
        bg_shutdown_all();
        let start = Instant::now();
        loop {
            if arc
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .try_wait()
                .unwrap()
                .is_some()
            {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "shell survived shutdown"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        bg_children()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove("test-shutdown");
    }
}
