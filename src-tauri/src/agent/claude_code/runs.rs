//! The Claude Code processes the page drives: starting them, writing to their stdin, picking
//! them up again after a reload, and stopping them.

use super::args::{args_for, run_args, run_cwd, ClaudeCodeRunRequest};
use super::install::{base_command, locate_claude};
use super::probe::{ensure_fresh_login, SPAWN_REFRESH_MARGIN_MS};
use super::sink::{ClaudeCodeEvent, RunSink};
use crate::agent::cli_process::{
    spawn_exit_waiter, spawn_line_reader, spawn_remote_cli, spawn_stdin_writer, spawn_tied,
    CliChild,
};
use crate::agent::*;
use crate::error::CmdError;
use tauri::ipc::Channel;

struct ClaudeRun {
    /// Lines for the CLI's stdin, written by the run's own writer thread. Commands only queue
    /// them: they run on the app's main thread, and a write that waits for the CLI to read
    /// (its pipe is small, and a busy CLI doesn't drain it) froze the whole window.
    input: Option<std::sync::mpsc::Sender<Vec<u8>>>,
    child: Arc<Mutex<CliChild>>,
    sink: Arc<Mutex<RunSink>>,
}

/// How long a run that ended while no page was attached waits to be picked up.
const DETACHED_EXIT_KEEP: Duration = Duration::from_secs(600);

static CLAUDE_RUNS: OnceLock<Mutex<HashMap<String, ClaudeRun>>> = OnceLock::new();

fn claude_runs() -> &'static Mutex<HashMap<String, ClaudeRun>> {
    CLAUDE_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Goes up each time the app's page reloads (`claude_code_detach_all`, under the runs' lock).
static PAGE_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn page_generation() -> u64 {
    PAGE_GENERATION.load(std::sync::atomic::Ordering::SeqCst)
}

/// Adds a run that a page of `generation` asked for, unless that page has reloaded since: its
/// channel is gone and the reloaded page never learned of the run, which would then wait for
/// input until Nyxs closes (a start held up in `ensure_fresh_login` while the page reloaded).
/// Such a run is stopped instead.
fn register_run(run_id: String, run: ClaudeRun, generation: u64) -> Result<(), CmdError> {
    // Under the lock a reload takes to bump the generation: either the run is in the table
    // before the reload detaches it (and the reloaded page lists it), or it sees the reload.
    let mut runs = claude_runs().lock().unwrap_or_else(|e| e.into_inner());
    if page_generation() != generation {
        drop(runs);
        run.child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .kill_tree();
        return Err(CmdError::cli_session_ended("Claude Code"));
    }
    runs.insert(run_id, run);
    Ok(())
}

/// Logs a line of the run's output and sends it to the page if one is attached.
fn emit(sink: &Mutex<RunSink>, event: ClaudeCodeEvent) {
    sink.lock().unwrap_or_else(|e| e.into_inner()).emit(event);
}

#[tauri::command]
pub async fn claude_code_start(
    request: ClaudeCodeRunRequest,
    on_event: Channel<ClaudeCodeEvent>,
) -> Result<(), CmdError> {
    let generation = page_generation();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_fresh_login(SPAWN_REFRESH_MARGIN_MS);
        // The page that asked reloaded while the login was renewed: nobody would drive it.
        if page_generation() != generation {
            return Err(CmdError::cli_session_ended("Claude Code"));
        }
        start_run(request, on_event, generation)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn start_run(
    request: ClaudeCodeRunRequest,
    on_event: Channel<ClaudeCodeEvent>,
    generation: u64,
) -> Result<(), CmdError> {
    let env: HashMap<String, String> = request
        .env
        .iter()
        .filter(|(k, _)| !k.is_empty() && !k.contains('='))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    type Pipe = Box<dyn Read + Send>;
    let (child, input, stdout, stderr): (CliChild, _, Pipe, Pipe) =
        if let Some(r) = request.cwd.as_deref().and_then(crate::remote::parse) {
            // A remote project: Claude Code runs on its machine (installed and signed in there).
            let mut child = spawn_remote_cli(&r, "claude", &run_args(&request), &env)
                .map_err(|e| CmdError::cli_start_failed("Claude Code", e))?;
            let input = child.stdin.take().map(spawn_stdin_writer);
            let stdout = child.stdout.take().ok_or("No stdout from Claude Code")?;
            let stderr = child.stderr.take().ok_or("No stderr from Claude Code")?;
            (
                CliChild::Remote(child.handle()),
                input,
                Box::new(stdout),
                Box::new(stderr),
            )
        } else {
            let bin = locate_claude().ok_or_else(|| CmdError::cli_not_connected("Claude Code"))?;
            let cwd = run_cwd(request.cwd.as_deref())?;
            let mut cmd = base_command(&bin);
            cmd.args(args_for(&bin, run_args(&request)))
                .current_dir(&cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .envs(&env);
            let mut child =
                spawn_tied(&mut cmd).map_err(|e| CmdError::cli_start_failed("Claude Code", e))?;
            let input = child.stdin.take().map(spawn_stdin_writer);
            let stdout = child.stdout.take().ok_or("No stdout from Claude Code")?;
            let stderr = child.stderr.take().ok_or("No stderr from Claude Code")?;
            (
                CliChild::Local(child),
                input,
                Box::new(stdout),
                Box::new(stderr),
            )
        };
    let child = Arc::new(Mutex::new(child));
    let run_id = request.run_id.clone();
    let sink = Arc::new(Mutex::new(RunSink::attached(on_event)));
    register_run(
        run_id.clone(),
        ClaudeRun {
            input,
            child: child.clone(),
            sink: sink.clone(),
        },
        generation,
    )?;

    let out_sink = sink.clone();
    let out_reader = spawn_line_reader(stdout, move |line| {
        emit(&out_sink, ClaudeCodeEvent::Stdout { line })
    });
    let err_sink = sink.clone();
    let err_reader = spawn_line_reader(stderr, move |line| {
        emit(&err_sink, ClaudeCodeEvent::Stderr { line })
    });

    spawn_exit_waiter(child, [out_reader, err_reader], move |code| {
        let attached = {
            let mut s = sink.lock().unwrap_or_else(|e| e.into_inner());
            s.exit = Some(code);
            s.emit(ClaudeCodeEvent::Exit { code });
            s.channel.is_some()
        };
        if attached {
            claude_runs()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&run_id);
            return;
        }
        // It ended while the page was reloading: kept a while so the reloaded page still learns
        // how the turn ended.
        std::thread::sleep(DETACHED_EXIT_KEEP);
        claude_runs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&run_id);
    });
    Ok(())
}

/// The app's page is reloading: its channels are gone, so output is only kept until it attaches.
pub fn claude_code_detach_all() {
    let sinks: Vec<Arc<Mutex<RunSink>>> = {
        let runs = claude_runs().lock().unwrap_or_else(|e| e.into_inner());
        PAGE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        runs.values().map(|r| r.sink.clone()).collect()
    };
    for sink in sinks {
        sink.lock().unwrap_or_else(|e| e.into_inner()).channel = None;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRunInfo {
    run_id: String,
    session_id: Option<String>,
    busy: bool,
    exited: bool,
}

/// The Claude Code processes still around, for a page that just reloaded.
#[tauri::command]
pub fn claude_code_runs() -> Vec<ClaudeRunInfo> {
    let runs: Vec<(String, Arc<Mutex<RunSink>>)> = claude_runs()
        .lock()
        .map(|runs| {
            runs.iter()
                .map(|(id, r)| (id.clone(), r.sink.clone()))
                .collect()
        })
        .unwrap_or_default();
    runs.into_iter()
        .map(|(run_id, sink)| {
            let s = sink.lock().unwrap_or_else(|e| e.into_inner());
            ClaudeRunInfo {
                run_id,
                session_id: s.session_id.clone(),
                busy: s.busy(),
                exited: s.exit.is_some(),
            }
        })
        .collect()
}

/// Sends a run's output to the reloaded page from now on, after replaying the turn in progress
/// when `replay` is set (under the same lock, so nothing is lost or reordered in between).
#[tauri::command]
pub async fn claude_code_attach(
    run_id: String,
    replay: bool,
    on_event: Channel<ClaudeCodeEvent>,
) -> Result<(), CmdError> {
    // A long turn's replay is thousands of messages: kept off the main thread.
    tauri::async_runtime::spawn_blocking(move || attach_run(run_id, replay, on_event))
        .await
        .map_err(|e| e.to_string())?
}

fn attach_run(
    run_id: String,
    replay: bool,
    on_event: Channel<ClaudeCodeEvent>,
) -> Result<(), CmdError> {
    let sink = claude_runs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&run_id)
        .map(|r| r.sink.clone())
        .ok_or_else(|| CmdError::cli_session_ended("Claude Code"))?;
    let mut s = sink.lock().unwrap_or_else(|e| e.into_inner());
    if replay {
        s.replay_to(&on_event);
    } else if let Some(code) = s.exit {
        let _ = on_event.send(ClaudeCodeEvent::Exit { code });
    }
    s.channel = Some(on_event);
    let exited = s.exit.is_some();
    drop(s);
    if exited {
        claude_runs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&run_id);
    }
    Ok(())
}

#[tauri::command]
pub fn claude_code_send(run_id: String, line: String) -> Result<(), CmdError> {
    let runs = claude_runs().lock().unwrap_or_else(|e| e.into_inner());
    let run = runs
        .get(&run_id)
        .ok_or_else(|| CmdError::cli_session_ended("Claude Code"))?;
    // Only answers are parsed: a user message can be megabytes of images, and this runs on
    // the app's main thread.
    if line.starts_with(r#"{"type":"control_response""#) {
        if let Ok(head) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(id) = head["response"]["request_id"].as_str() {
                run.sink
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .answered
                    .insert(id.to_string());
            }
        }
    }
    let input = run
        .input
        .as_ref()
        .ok_or_else(|| CmdError::cli_input_closed("Claude Code"))?;
    let mut payload = line.into_bytes();
    if payload.last() != Some(&b'\n') {
        payload.push(b'\n');
    }
    input
        .send(payload)
        .map_err(|_| CmdError::cli_input_closed("Claude Code"))
}

#[tauri::command]
pub fn claude_code_close_input(run_id: String) {
    if let Some(run) = claude_runs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(&run_id)
    {
        run.input = None;
    }
}

const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

pub fn claude_code_shutdown_all() {
    let children: Vec<Arc<Mutex<CliChild>>> = claude_runs()
        .lock()
        .map(|mut runs| {
            runs.values_mut()
                .map(|r| {
                    r.input = None;
                    r.child.clone()
                })
                .collect()
        })
        .unwrap_or_default();
    let started = Instant::now();
    while started.elapsed() < SHUTDOWN_GRACE
        && children.iter().any(|c| {
            c.lock()
                .map(|mut c| matches!(c.try_wait(), Ok(None)))
                .unwrap_or(false)
        })
    {
        std::thread::sleep(Duration::from_millis(50));
    }
    for child in children {
        if let Ok(mut c) = child.lock() {
            c.kill_tree();
        }
    }
}

/// Kills a run's process tree in the background: `taskkill` takes its time, and this command
/// runs on the app's main thread.
#[tauri::command]
pub fn claude_code_kill(run_id: String) -> bool {
    let child = claude_runs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&run_id)
        .map(|r| r.child.clone());
    match child {
        Some(child) => {
            std::thread::spawn(move || {
                if let Ok(mut c) = child.lock() {
                    c.kill_tree();
                }
            });
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A process that waits, as Claude Code waits for its next input.
    fn waiting_process() -> ClaudeRun {
        #[cfg(target_os = "windows")]
        let mut cmd = {
            let mut cmd = Command::new("cmd.exe");
            cmd.args(["/c", "ping -n 30 127.0.0.1 >nul"]);
            cmd
        };
        #[cfg(not(target_os = "windows"))]
        let mut cmd = {
            use std::os::unix::process::CommandExt;
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "sleep 30"]).process_group(0);
            cmd
        };
        hide_console(&mut cmd);
        ClaudeRun {
            input: None,
            child: Arc::new(Mutex::new(CliChild::Local(cmd.spawn().unwrap()))),
            sink: Arc::new(Mutex::new(RunSink::default())),
        }
    }

    fn ended(child: &Mutex<CliChild>) -> bool {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            let mut c = child.lock().unwrap_or_else(|e| e.into_inner());
            if !matches!(c.try_wait(), Ok(None)) {
                return true;
            }
            drop(c);
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    // One test: the page generation is global, and a reload in a parallel test would move it.
    #[test]
    fn a_run_is_kept_for_its_page_and_stopped_when_that_page_reloaded_meanwhile() {
        let current = waiting_process();
        let kept = current.child.clone();
        assert!(register_run("test-run-current".into(), current, page_generation()).is_ok());
        assert!(claude_runs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key("test-run-current"));
        claude_runs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove("test-run-current");
        kept.lock().unwrap_or_else(|e| e.into_inner()).kill_tree();

        let asked_by = page_generation();
        claude_code_detach_all();
        let stale = waiting_process();
        let child = stale.child.clone();
        assert!(register_run("test-run-stale".into(), stale, asked_by).is_err());
        assert!(!claude_runs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key("test-run-stale"));
        assert!(ended(&child), "the orphaned run was left running");
    }
}
