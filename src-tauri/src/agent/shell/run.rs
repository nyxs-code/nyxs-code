//! Running a command to completion with its output captured, a timeout and cancelling.

use super::background::{adopt, BgChild, BgInfo};
use super::capture::{capture, kill_tree, Capture};
use super::env::shell_command;
#[cfg(target_os = "windows")]
use super::host::{persistent_shell_enabled, run_on_host};
use super::memory_guard::{self, MemoryStop};
use crate::agent::output_log::LogRequest;
use crate::agent::*;
use std::sync::atomic::AtomicBool;

#[derive(Serialize)]
pub struct RunResult {
    stdout: String,
    stderr: String,
    code: i32,
    timed_out: bool,
    cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stdout_log: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stderr_log: Option<String>,
    /// Stopped because one of its processes used far more memory than the computer has.
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_stop: Option<MemoryStop>,
    /// Still running, moved to the background: what it printed so far is in stdout and stderr.
    #[serde(skip_serializing_if = "Option::is_none")]
    background: Option<Moved>,
}

/// A command moved to the background: the shell it now is, and whether its time limit moved it
/// (otherwise the user did, with Ctrl+B).
#[derive(Serialize)]
pub(super) struct Moved {
    shell_id: String,
    by_timeout: bool,
}

/// What only the agent's own commands get (the Bash tool): the memory watch, and being moved to
/// the background (by the user, or by their time limit) instead of stopped.
#[derive(Default)]
pub(super) struct AgentOpts {
    pub memory_guard: bool,
    pub to_background: Option<ToBackground>,
}

pub(super) struct ToBackground {
    /// Raised by `agent_run_to_background`.
    pub flag: Arc<AtomicBool>,
    pub info: BgInfo,
}

/// The result of a command that moved to the background.
pub(super) fn moved_result(
    stdout: String,
    stderr: String,
    shell_id: String,
    by_timeout: bool,
) -> RunResult {
    RunResult {
        stdout,
        stderr,
        code: -1,
        timed_out: false,
        cancelled: false,
        stdout_log: None,
        stderr_log: None,
        memory_stop: None,
        background: Some(Moved {
            shell_id,
            by_timeout,
        }),
    }
}

fn movable_runs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Moves a running agent command to the background (the user's Ctrl+B): it keeps running as a
/// background shell and its `agent_run` returns now. False when no such command runs.
#[tauri::command]
pub fn agent_run_to_background(run_id: String) -> bool {
    match movable_runs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&run_id)
    {
        Some(flag) => {
            flag.store(true, Ordering::Release);
            true
        }
        None => false,
    }
}

/// Watches a running command's memory (see memory_guard) and, over the line, raises `cancel` so
/// the run stops as if cancelled; `hit` then says why.
pub(super) struct MemoryWatch {
    hit: Arc<Mutex<Option<MemoryStop>>>,
    _watch: Option<memory_guard::Watch>,
}

impl MemoryWatch {
    pub(super) fn start(on: bool, root: u32, cancel: &Arc<AtomicBool>) -> Self {
        let hit = Arc::new(Mutex::new(None));
        let watch = on
            .then(|| {
                let (hit, cancel) = (hit.clone(), cancel.clone());
                memory_guard::watch(root, move |stop| {
                    *hit.lock().unwrap_or_else(|e| e.into_inner()) = Some(stop);
                    cancel.store(true, Ordering::Release);
                })
            })
            .flatten();
        MemoryWatch { hit, _watch: watch }
    }

    /// Stops watching (the command ended, and a pooled host goes on to other commands) and says
    /// whether it was stopped for its memory.
    pub(super) fn finish(self) -> Option<MemoryStop> {
        drop(self._watch);
        *self.hit.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub(super) fn active_runs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command(async)]
pub fn agent_run_cancel(run_id: String) -> bool {
    // The lock is let go before asking a remote machine, which can take up to a minute: every
    // command that starts meanwhile registers in this same map.
    let local = active_runs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&run_id)
        .cloned();
    match local {
        Some(flag) => {
            flag.store(true, Ordering::Release);
            true
        }
        None => crate::remote::procs::cancel(&run_id),
    }
}

/// A command whose folder is on a remote machine runs there, through the helper.
fn run_remote(
    r: &crate::remote::RemotePath,
    command: Option<&str>,
    argv: Option<Vec<String>>,
    timeout_ms: Option<u64>,
    env: Option<&HashMap<String, String>>,
    run_id: Option<&str>,
    stdin: Option<&str>,
) -> Result<RunResult, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000));
    let res = crate::remote::procs::exec_with_stdin(
        &r.host,
        crate::remote::procs::Exec {
            command,
            argv,
            cwd: Some(&r.path),
            env,
            timeout_ms: Some(timeout.as_millis() as u64),
            run_id,
        },
        stdin.map(str::as_bytes),
    )
    .map_err(String::from)?;
    Ok(finish_run(
        Captured {
            stdout: res.stdout,
            stderr: res.stderr,
            stdout_log: None,
            stderr_log: None,
        },
        res.code.unwrap_or(-1),
        res.timed_out,
        res.cancelled,
        timeout,
        None,
    ))
}

/// `stdin` is written to the command's standard input, then closed (a hook reads its JSON
/// input there); without it the command gets none. For a command the agent started:
/// `memory_guard` stops it if it uses far more memory than the computer has (off for the app's
/// own commands and once the user allowed more for the session), and `to_background` lets it
/// move to the background, by `agent_run_to_background` with its `run_id` or at its time limit,
/// instead of being stopped there; `description` is then its title in Background tasks.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_run(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    env: Option<HashMap<String, String>>,
    run_id: Option<String>,
    log_over_bytes: Option<usize>,
    stdin: Option<String>,
    memory_guard: Option<bool>,
    to_background: Option<bool>,
    description: Option<String>,
) -> Result<RunResult, String> {
    let request = AgentRequest {
        memory_guard: memory_guard.unwrap_or(false),
        to_background: to_background.unwrap_or(false),
        description,
    };
    tauri::async_runtime::spawn_blocking(move || {
        run_command(
            command,
            cwd,
            timeout_ms,
            env,
            run_id,
            log_over_bytes,
            stdin,
            request,
        )
    })
    .await
    .map_err(|e| format!("Couldn't run the command: {e}"))?
}

/// What the agent asked for its command, before it is known where it runs.
#[derive(Default)]
struct AgentRequest {
    memory_guard: bool,
    to_background: bool,
    description: Option<String>,
}

/// `agent_run` without stdin, as most callers want it.
#[cfg(test)]
fn agent_run_blocking(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    env: Option<HashMap<String, String>>,
    run_id: Option<String>,
    log_over_bytes: Option<usize>,
) -> Result<RunResult, String> {
    run_command(
        command,
        cwd,
        timeout_ms,
        env,
        run_id,
        log_over_bytes,
        None,
        AgentRequest::default(),
    )
}

#[allow(clippy::too_many_arguments)]
fn run_command(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    env: Option<HashMap<String, String>>,
    run_id: Option<String>,
    log_over_bytes: Option<usize>,
    stdin: Option<String>,
    request: AgentRequest,
) -> Result<RunResult, String> {
    if let Some(r) = cwd.as_deref().and_then(crate::remote::parse) {
        return run_remote(
            &r,
            Some(&command),
            None,
            timeout_ms,
            env.as_ref(),
            run_id.as_deref(),
            stdin.as_deref(),
        );
    }
    // Movable only with an id to move it by, and with no input being written to it.
    let movable = request.to_background && stdin.is_none();
    let movable_id = run_id.clone().filter(|_| movable);
    let to_background = movable_id.as_ref().map(|id| {
        let flag = Arc::new(AtomicBool::new(false));
        movable_runs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), flag.clone());
        ToBackground {
            flag,
            info: BgInfo {
                command: command.clone(),
                cwd: cwd.clone(),
                description: request.description,
            },
        }
    });
    let opts = AgentOpts {
        memory_guard: request.memory_guard,
        to_background,
    };
    let result = run_local(
        command,
        cwd,
        timeout_ms,
        env,
        run_id,
        log_over_bytes,
        stdin,
        opts,
    );
    if let Some(id) = movable_id {
        movable_runs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn run_local(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    env: Option<HashMap<String, String>>,
    run_id: Option<String>,
    log_over_bytes: Option<usize>,
    stdin: Option<String>,
    opts: AgentOpts,
) -> Result<RunResult, String> {
    let log = LogRequest::new(log_over_bytes);
    // The persistent host has one stdin for every command it runs: one that brings its own runs
    // in a shell of its own.
    #[cfg(target_os = "windows")]
    if env.is_none() && stdin.is_none() && persistent_shell_enabled() {
        if let Ok(host) = crate::agent::ps_host::acquire() {
            return run_on_host(
                host,
                &command,
                cwd.as_deref(),
                timeout_ms,
                run_id,
                log.as_ref(),
                opts,
            );
        }
    }
    // Without it PowerShell reads the input in the console's code page: a script reading its
    // stdin would get UTF-8 text garbled. Programs it starts get the bytes as they are.
    #[cfg(target_os = "windows")]
    let command = if stdin.is_some() {
        format!("[Console]::InputEncoding=[System.Text.Encoding]::UTF8\n{command}")
    } else {
        command
    };
    let mut cmd = shell_command(&command);
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    set_noninteractive_env(&mut cmd);
    if let Some(vars) = env {
        for (k, v) in vars {
            cmd.env(k, v);
        }
    }
    hide_console(&mut cmd);
    run_to_completion(cmd, timeout_ms, run_id, log.as_ref(), stdin, opts)
}

const EXEC_ALLOWED: [&str; 2] = ["git", "gh"];

fn exec_direct(
    program: &str,
    args: &[String],
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    gh_token: Option<String>,
) -> Result<RunResult, String> {
    if !EXEC_ALLOWED.contains(&program) {
        return Err(format!("Running \"{program}\" directly isn't allowed."));
    }
    if let Some(r) = cwd.as_deref().and_then(crate::remote::parse) {
        let mut env: HashMap<String, String> = [
            ("GIT_PAGER", "cat"),
            ("GH_PAGER", "cat"),
            ("GH_PROMPT_DISABLED", "1"),
            ("GH_NO_UPDATE_NOTIFIER", "1"),
            ("NO_COLOR", "1"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        if let Some(token) = gh_token.filter(|t| program == "gh" && !t.trim().is_empty()) {
            env.insert("GH_TOKEN".into(), token.trim().to_string());
        }
        let argv = std::iter::once(program.to_string())
            .chain(args.iter().cloned())
            .collect();
        return run_remote(
            &r,
            None,
            Some(argv),
            timeout_ms.or(Some(30_000)),
            Some(&env),
            None,
            None,
        );
    }
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    apply_login_env(&mut cmd);
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    set_noninteractive_env(&mut cmd);
    cmd.env("GIT_PAGER", "cat")
        .env("GH_PAGER", "cat")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1");
    // Another of the user's gh accounts, for a repo the active one can't see; only this process gets it.
    if let Some(token) = gh_token.filter(|t| program == "gh" && !t.trim().is_empty()) {
        cmd.env("GH_TOKEN", token.trim());
    }
    hide_console(&mut cmd);
    run_to_completion(
        cmd,
        timeout_ms.or(Some(30_000)),
        None,
        None,
        None,
        AgentOpts::default(),
    )
}

#[tauri::command]
pub async fn agent_git(
    args: Vec<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<RunResult, String> {
    tauri::async_runtime::spawn_blocking(move || exec_direct("git", &args, cwd, timeout_ms, None))
        .await
        .map_err(|e| format!("Couldn't run git: {e}"))?
}

#[tauri::command]
pub async fn agent_exec(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    gh_token: Option<String>,
) -> Result<RunResult, String> {
    let name = program.clone();
    tauri::async_runtime::spawn_blocking(move || {
        exec_direct(&program, &args, cwd, timeout_ms, gh_token)
    })
    .await
    .map_err(|e| format!("Couldn't run {name}: {e}"))?
}

/// A command running in a process of its own goes on as a background shell: its readers now
/// write there, after what it printed so far, which is also what `agent_run` returns.
fn move_to_background(
    child: Child,
    out: Capture,
    err: Capture,
    info: BgInfo,
    memory_guard: bool,
    by_timeout: bool,
) -> RunResult {
    let root = child.id();
    let adoption = adopt(info, BgChild::Local(child), memory_guard.then_some(root));
    let mut out_feed = adoption.feed("stdout");
    let mut err_feed = adoption.feed("stderr");
    out.hand_over(Box::new(move |d| out_feed.feed(d)));
    err.hand_over(Box::new(move |d| err_feed.feed(d)));
    // Handed over first: nothing read since is in these, and nothing in these is fed again.
    let (stdout, stderr) = (out.text(), err.text());
    adoption.prepend(&format!("{stdout}{stderr}"));
    let shell_id = adoption.id.clone();
    let (out_done, err_done) = (out.done_flag(), err.done_flag());
    adoption.finish_when(move || {
        while !(out_done.load(Ordering::Acquire) && err_done.load(Ordering::Acquire)) {
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    moved_result(stdout, stderr, shell_id, by_timeout)
}

fn run_to_completion(
    mut cmd: Command,
    timeout_ms: Option<u64>,
    run_id: Option<String>,
    log: Option<&LogRequest>,
    stdin: Option<String>,
    opts: AgentOpts,
) -> Result<RunResult, String> {
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    // On Windows it starts already inside the agent's job, so nothing it starts escapes it.
    #[cfg(target_os = "windows")]
    let spawned = crate::agent::job::spawn_contained(&mut cmd);
    #[cfg(not(target_os = "windows"))]
    let spawned = cmd.spawn();
    let mut child = spawned.map_err(|e| format!("Couldn't start the command: {e}"))?;
    let out = capture(child.stdout.take(), log, "stdout");
    let err = capture(child.stderr.take(), log, "stderr");
    // From a thread of its own: an input bigger than the pipe would block until the command
    // reads it, and one that never reads must still time out. Dropping the pipe closes it.
    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = pipe.write_all(data.as_bytes());
        });
    }

    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(id) = &run_id {
        active_runs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), cancel.clone());
    }
    let memory = MemoryWatch::start(opts.memory_guard, child.id(), &cancel);
    let forget_run = || {
        if let Some(id) = &run_id {
            active_runs()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(id);
        }
    };

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000));
    let start = Instant::now();
    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {}
            Err(_) => break None,
        }
        if cancel.load(Ordering::Acquire) {
            cancelled = true;
        } else if start.elapsed() >= timeout {
            timed_out = true;
        }
        if !cancelled {
            if let Some(to) = &opts.to_background {
                let asked = to.flag.load(Ordering::Acquire);
                if asked || timed_out {
                    forget_run();
                    memory.finish();
                    let info = opts.to_background.unwrap().info;
                    return Ok(move_to_background(
                        child,
                        out,
                        err,
                        info,
                        opts.memory_guard,
                        !asked,
                    ));
                }
            }
        }
        if cancelled || timed_out {
            kill_tree(&mut child);
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    forget_run();

    out.settle();
    err.settle();
    let memory_stop = memory.finish();
    Ok(finish_run(
        Captured {
            stdout: out.text(),
            stderr: err.text(),
            stdout_log: out.finish_log(),
            stderr_log: err.finish_log(),
        },
        status.and_then(|s| s.code()).unwrap_or(-1),
        timed_out,
        cancelled && memory_stop.is_none(),
        timeout,
        memory_stop,
    ))
}

pub(crate) struct Captured {
    pub stdout: String,
    pub stderr: String,
    pub stdout_log: Option<String>,
    pub stderr_log: Option<String>,
}

pub(super) fn finish_run(
    captured: Captured,
    code: i32,
    timed_out: bool,
    cancelled: bool,
    timeout: Duration,
    memory_stop: Option<MemoryStop>,
) -> RunResult {
    let Captured {
        stdout,
        mut stderr,
        stdout_log,
        stderr_log,
    } = captured;
    if timed_out || cancelled || memory_stop.is_some() {
        if !stderr.is_empty() && !stderr.ends_with('\n') {
            stderr.push('\n');
        }
        stderr.push_str(&if let Some(m) = memory_stop {
            format!(
                "Command stopped by Nyxs: it was using {} GB of memory on this {} GB computer (partial output shown)",
                m.used_gb, m.installed_gb
            )
        } else if timed_out {
            format!(
                "Command stopped by the timeout after {} ms (partial output shown)",
                timeout.as_millis()
            )
        } else {
            "Command cancelled by the user (partial output shown)".to_string()
        });
    }
    RunResult {
        stdout,
        stderr,
        code,
        timed_out,
        cancelled,
        stdout_log,
        stderr_log,
        memory_stop,
        background: None,
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{HostUser, SLOW};
    use super::*;

    #[cfg(target_os = "windows")]
    const FLOOD: &str =
        "1..30000 | ForEach-Object { \"line $_ ................................\" }";
    #[cfg(not(target_os = "windows"))]
    const FLOOD: &str =
        "for i in $(seq 1 30000); do echo \"line $i ................................\"; done";

    #[test]
    fn large_output_does_not_deadlock() {
        let _hosts = HostUser::enter();
        let start = Instant::now();
        let r = agent_run_blocking(FLOOD.into(), None, Some(60_000), None, None, None).unwrap();
        assert!(!r.timed_out, "timed out after {:?}", start.elapsed());
        assert_eq!(r.code, 0);
        assert!(r.stdout.contains("line 1 "));
        assert!(r.stdout.contains("line 30000 "));
        assert!(r.stdout.contains("bytes de salida omitidos"));
    }

    #[test]
    fn long_output_is_saved_whole_to_a_log() {
        let _hosts = HostUser::enter();
        let r =
            agent_run_blocking(FLOOD.into(), None, Some(60_000), None, None, Some(10_000)).unwrap();
        assert!(r.stdout.contains("bytes de salida omitidos"));
        let path = r.stdout_log.expect("stdout log");
        let log = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            log.lines().filter(|l| l.starts_with("line ")).count(),
            30000
        );
        assert!(log.contains("line 15000 ") && !log.contains('\u{1e}'));
        assert!(r.stderr_log.is_none());
        let short = agent_run_blocking(
            "echo hi".into(),
            None,
            Some(10_000),
            None,
            None,
            Some(10_000),
        )
        .unwrap();
        assert!(short.stdout_log.is_none());
    }

    fn with_stdin(command: &str, input: &str, timeout_ms: u64) -> RunResult {
        run_command(
            command.into(),
            None,
            Some(timeout_ms),
            None,
            None,
            None,
            Some(input.to_string()),
            AgentRequest::default(),
        )
        .unwrap()
    }

    #[cfg(target_os = "windows")]
    const READ_ALL: &str = "[Console]::In.ReadToEnd()";
    #[cfg(not(target_os = "windows"))]
    const READ_ALL: &str = "cat";
    #[cfg(target_os = "windows")]
    const COUNT_INPUT: &str = "[Console]::In.ReadToEnd().Length";
    #[cfg(not(target_os = "windows"))]
    const COUNT_INPUT: &str = "cat | wc -c";
    #[cfg(target_os = "windows")]
    const NATIVE_READ: &str = "findstr .";
    #[cfg(not(target_os = "windows"))]
    const NATIVE_READ: &str = "grep .";
    #[cfg(target_os = "windows")]
    const IGNORE_INPUT: &str = "Start-Sleep 30";
    #[cfg(not(target_os = "windows"))]
    const IGNORE_INPUT: &str = "sleep 30";

    #[test]
    fn stdin_reaches_the_command_whole_and_unchanged() {
        let text = "{\"t\":\"añø ✓\"}";
        let r = with_stdin(READ_ALL, text, 60_000);
        assert_eq!(r.code, 0, "{}", r.stderr);
        assert_eq!(r.stdout.trim(), text);
        // Far past a pipe's buffer: written while the command reads, not before it starts.
        let big = format!("{{\"pad\":\"{}\"}}", "x".repeat(300_000));
        let r = with_stdin(COUNT_INPUT, &big, 60_000);
        assert_eq!(r.code, 0, "{}", r.stderr);
        assert_eq!(
            r.stdout.trim().parse::<usize>().ok(),
            Some(big.len()),
            "{:?}",
            r.stdout
        );
    }

    #[test]
    fn stdin_reaches_a_program_the_shell_starts() {
        let r = with_stdin(NATIVE_READ, "hook-input-line\n", 60_000);
        assert_eq!(r.code, 0, "{}", r.stderr);
        assert!(r.stdout.contains("hook-input-line"), "{:?}", r.stdout);
    }

    #[test]
    fn a_command_that_never_reads_its_stdin_still_times_out() {
        let r = with_stdin(IGNORE_INPUT, &"x".repeat(300_000), 3_000);
        assert!(r.timed_out);
    }

    #[test]
    fn exec_runs_allowed_programs_without_a_shell() {
        let r = exec_direct("git", &["--version".to_string()], None, None, None).unwrap();
        assert_eq!(r.code, 0, "{}", r.stderr);
        assert!(r.stdout.starts_with("git version"));
        let quoted = exec_direct(
            "git",
            &[
                "check-ref-format".into(),
                "--branch".into(),
                "fix/it's-$x".into(),
            ],
            None,
            None,
            None,
        )
        .unwrap();
        assert!(
            quoted.stdout.trim() == "fix/it's-$x" || quoted.code != 0,
            "{:?}",
            quoted.stdout
        );
        assert!(exec_direct("powershell", &[], None, None, None).is_err());
    }

    #[test]
    fn a_guarded_command_over_the_memory_line_is_stopped_and_says_why() {
        let _hosts = HostUser::enter();
        super::memory_guard::TEST_INSTALLED.store(1024, Ordering::Release);
        // On Windows without variables the command runs on a pooled host; with them, on its own.
        for env in [
            None,
            Some(HashMap::from([("NYXS_T".to_string(), "1".to_string())])),
        ] {
            let start = Instant::now();
            let r = run_command(
                SLOW.into(),
                None,
                Some(60_000),
                env,
                None,
                None,
                None,
                AgentRequest {
                    memory_guard: true,
                    ..Default::default()
                },
            )
            .unwrap();
            let m = r.memory_stop.expect("not stopped for memory");
            assert!(m.used_gb >= 1);
            assert!(!r.cancelled && !r.timed_out);
            assert!(r.stderr.contains("of memory on this"), "{}", r.stderr);
            assert!(start.elapsed() < Duration::from_secs(20));
        }
        super::memory_guard::TEST_INSTALLED.store(0, Ordering::Release);
        // Unguarded, nothing is stopped.
        let r = run_command(
            "echo hi".into(),
            None,
            Some(30_000),
            None,
            None,
            None,
            None,
            AgentRequest::default(),
        )
        .unwrap();
        assert!(r.memory_stop.is_none());
    }

    #[cfg(target_os = "windows")]
    const TWO_PARTS: &str = "Write-Output first; Start-Sleep -Seconds 3; Write-Output second";
    #[cfg(not(target_os = "windows"))]
    const TWO_PARTS: &str = "echo first; sleep 3; echo second";

    /// The background shell `id` once it ended: its status, code and output.
    fn ended_shell(id: &str) -> (String, Option<i32>, String) {
        let start = Instant::now();
        loop {
            let sh = super::super::background::bg_shells()
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .expect("no such shell");
            if sh.status != "running" {
                return (sh.status, sh.code, sh.output);
            }
            assert!(start.elapsed() < Duration::from_secs(30), "never ended");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn a_running_command_moves_to_the_background_and_goes_on_there() {
        let _hosts = HostUser::enter();
        // On Windows without variables the command runs on a pooled host; with them, on its own.
        for (n, env) in [
            None,
            Some(HashMap::from([("NYXS_T".to_string(), "1".to_string())])),
        ]
        .into_iter()
        .enumerate()
        {
            let id = format!("test-move-{n}");
            let run_id = id.clone();
            let handle = std::thread::spawn(move || {
                run_command(
                    TWO_PARTS.into(),
                    None,
                    Some(60_000),
                    env,
                    Some(run_id),
                    None,
                    None,
                    AgentRequest {
                        to_background: true,
                        description: Some("two parts".into()),
                        ..Default::default()
                    },
                )
                .unwrap()
            });
            let start = Instant::now();
            // Moved once it has printed its first part.
            std::thread::sleep(Duration::from_millis(1500));
            while !agent_run_to_background(id.clone()) {
                assert!(
                    start.elapsed() < Duration::from_secs(20),
                    "run never registered"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
            let r = handle.join().unwrap();
            let moved = r.background.expect("not moved");
            assert!(!moved.by_timeout);
            assert!(
                start.elapsed() < Duration::from_secs(3),
                "waited for the command"
            );
            let (status, code, output) = ended_shell(&moved.shell_id);
            assert_eq!((status.as_str(), code), ("done", Some(0)), "{output}");
            assert!(
                output.contains("first") && output.contains("second"),
                "{output:?}"
            );
            assert!(!agent_run_to_background(id), "still movable after it moved");
        }
    }

    #[test]
    fn a_movable_command_at_its_time_limit_goes_on_in_the_background() {
        let _hosts = HostUser::enter();
        let r = run_command(
            TWO_PARTS.into(),
            None,
            Some(1_000),
            None,
            Some("test-move-timeout".into()),
            None,
            None,
            AgentRequest {
                to_background: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!r.timed_out);
        let moved = r.background.expect("stopped instead of moved");
        assert!(moved.by_timeout);
        let (status, _, output) = ended_shell(&moved.shell_id);
        assert_eq!(status, "done");
        assert!(output.contains("second"), "{output:?}");
    }

    #[test]
    fn timeout_keeps_partial_output() {
        let _hosts = HostUser::enter();
        let r = agent_run_blocking(SLOW.into(), None, Some(3_000), None, None, None).unwrap();
        assert!(r.timed_out);
        assert!(r.stdout.contains("started"));
        assert!(r.stderr.contains("timeout"));
    }

    #[test]
    fn cancel_stops_a_running_command() {
        let _hosts = HostUser::enter();
        let id = "test-cancel-run".to_string();
        let worker_id = id.clone();
        let handle = std::thread::spawn(move || {
            agent_run_blocking(SLOW.into(), None, Some(60_000), None, Some(worker_id), None)
                .unwrap()
        });
        let start = Instant::now();
        while !agent_run_cancel(id.clone()) {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "run never registered"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        let r = handle.join().unwrap();
        assert!(r.cancelled);
        assert!(start.elapsed() < Duration::from_secs(20));
    }

    /// Generous on purpose: it catches hangs, not slowness. On a fresh GitHub Windows runner the
    /// host's first error (loading PowerShell's error formatting from a cold disk) took over 10 s.
    #[cfg(target_os = "windows")]
    const PS_MS: u64 = 60_000;

    #[cfg(target_os = "windows")]
    fn ps(command: &str) -> RunResult {
        agent_run_blocking(command.into(), None, Some(PS_MS), None, None, None).unwrap()
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn persistent_shell_reports_real_exit_codes() {
        let _hosts = HostUser::enter();
        assert_eq!(ps("Write-Output hi").code, 0);
        assert_eq!(ps("cmd /c exit 3").code, 3);
        assert_eq!(ps("Write-Output a; cmd /c exit 4").code, 4);
        assert_eq!(ps("cmd /c exit 3; Write-Output after").code, 0);
        assert_eq!(ps("Get-Item C:\\nope-nyxs-xyz").code, 1);
        assert_eq!(ps("throw 'boom'").code, 1);
        let exited = ps("Write-Output bye; exit 7");
        assert_eq!(exited.code, 7);
        assert!(exited.stdout.contains("bye"));
        assert_eq!(ps("Write-Output again").code, 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn persistent_shell_output_is_exact_and_ordered() {
        let _hosts = HostUser::enter();
        assert_eq!(ps("[Console]::Out.Write('x')").stdout, "x");
        let r = ps("Write-Output one; [Console]::Error.WriteLine('warn'); Write-Output two");
        assert!(
            r.stdout.starts_with("one") && r.stdout.trim_end().ends_with("two"),
            "{:?}",
            r.stdout
        );
        assert_eq!(r.stderr.trim(), "warn");
        let table = ps("Get-ChildItem env: | Select-Object -First 3 | Format-Table Name");
        assert!(
            table.stdout.contains("Name") && !table.stdout.contains('\u{1e}'),
            "{:?}",
            table.stdout
        );
        let err = ps("Get-Item C:\\nope-nyxs-xyz");
        assert!(
            err.stderr.contains("nope-nyxs-xyz") && !err.stderr.contains('\u{1e}'),
            "{:?}",
            err.stderr
        );
        assert!(ps("Write-Output 'añø ✓'").stdout.contains("añø ✓"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn persistent_shell_does_not_leak_state_between_commands() {
        let _hosts = HostUser::enter();
        // TEMP can be an 8.3 short path (`C:\Users\RUNNER~1\...` on GitHub's runners), which
        // `Get-Location` reports long. Canonicalizing gives the long form too.
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let dir = PathBuf::from(dir.to_string_lossy().trim_start_matches(r"\\?\"));
        let first = agent_run_blocking(
            "$env:NYXS_LEAK = '1'; $leak = 5; function leaky { 'x' }; Set-Location C:\\".into(),
            Some(dir.to_string_lossy().to_string()),
            Some(PS_MS),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(first.code, 0, "{}", first.stderr);
        let second = agent_run_blocking(
            "\"[$env:NYXS_LEAK][$leak][$(Test-Path function:leaky)][$((Get-Location).Path)]\""
                .into(),
            Some(dir.to_string_lossy().to_string()),
            Some(PS_MS),
            None,
            None,
            None,
        )
        .unwrap();
        let want = format!(
            "[][][False][{}]",
            dir.to_string_lossy().trim_end_matches('\\')
        );
        assert!(
            second.stdout.trim().eq_ignore_ascii_case(&want),
            "{:?} vs {want}",
            second.stdout
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn persistent_shell_gives_native_programs_no_stdin() {
        let _hosts = HostUser::enter();
        let r = agent_run_blocking(
            "cmd /c \"set /p x= & echo done\"".into(),
            None,
            Some(10_000),
            None,
            None,
            None,
        )
        .unwrap();
        assert!(!r.timed_out);
        assert!(r.stdout.contains("done"));
    }

    #[cfg(target_os = "windows")]
    fn detached_pid(env: Option<HashMap<String, String>>) -> u32 {
        let r = agent_run_blocking(
            "(Start-Detached powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 20' -Hidden).ProcessId".into(),
            None,
            Some(30_000),
            env,
            None,
            None,
        )
        .unwrap();
        assert_eq!(r.code, 0, "{}", r.stderr);
        r.stdout
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("{:?}", r.stdout))
    }

    #[cfg(target_os = "windows")]
    fn stop_pid(pid: u32) {
        let mut tk = Command::new("taskkill");
        tk.args(["/PID", &pid.to_string(), "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut tk);
        let _ = tk.status();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn start_detached_leaves_the_agent_job() {
        let _hosts = HostUser::enter();
        for env in [
            None,
            Some(HashMap::from([("NYXS_T".to_string(), "1".to_string())])),
        ] {
            let pid = detached_pid(env);
            let alive_outside = !crate::agent::job::in_agent_job(pid);
            stop_pid(pid);
            assert!(
                alive_outside,
                "Start-Detached launched {pid} inside the agent job"
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn a_one_off_shell_also_hides_new_consoles() {
        // With env vars the command runs in its own PowerShell, not on a host.
        let env = Some(HashMap::from([("NYXS_T".to_string(), "1".to_string())]));
        let r = agent_run_blocking(
            "\"$((Get-Command Start-Process).CommandType) $(Test-NyxsConsoleProgram cmd) $(Test-NyxsConsoleProgram explorer.exe)\"".into(),
            None,
            Some(30_000),
            env,
            None,
            None,
        )
        .unwrap();
        assert_eq!(r.stdout.trim(), "Function True False", "{}", r.stderr);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn plain_commands_run_inside_the_agent_job() {
        let _hosts = HostUser::enter();
        let env = Some(HashMap::from([("NYXS_T".to_string(), "1".to_string())]));
        let r = agent_run_blocking(
            "(Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 20' -WindowStyle Hidden -PassThru).Id".into(),
            None,
            Some(30_000),
            env,
            None,
            None,
        )
        .unwrap();
        let pid: u32 = r
            .stdout
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("{:?} {:?}", r.stdout, r.stderr));
        let inside = crate::agent::job::in_agent_job(pid);
        stop_pid(pid);
        assert!(
            inside,
            "a process started by a command escaped the agent job"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn persistent_shell_runs_commands_in_parallel_and_fast() {
        let _hosts = HostUser::enter();
        ps("Write-Output warm");
        let start = Instant::now();
        let handles: Vec<_> = (0..3)
            .map(|i| {
                std::thread::spawn(move || {
                    ps(&format!(
                        "Start-Sleep -Milliseconds 300; Write-Output job{i}"
                    ))
                })
            })
            .collect();
        for (i, h) in handles.into_iter().enumerate() {
            let r = h.join().unwrap();
            assert!(r.stdout.contains(&format!("job{i}")));
        }
        eprintln!("3 parallel commands: {:?}", start.elapsed());
        let start = Instant::now();
        ps("Write-Output quick");
        let warm = start.elapsed();
        eprintln!("warm command: {warm:?}");
        assert!(
            warm < Duration::from_millis(500),
            "warm command took {warm:?}"
        );
    }
}
