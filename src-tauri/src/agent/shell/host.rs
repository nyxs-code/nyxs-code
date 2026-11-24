//! Running a command on one of the pooled persistent PowerShell hosts (Windows).

use super::run::{active_runs, finish_run, AgentOpts, MemoryWatch, RunResult};
use crate::agent::output_log::LogRequest;
use crate::agent::*;
use std::sync::atomic::AtomicBool;

#[cfg(target_os = "windows")]
pub(super) fn persistent_shell_enabled() -> bool {
    std::env::var("NYXS_PERSISTENT_SHELL")
        .map(|v| v != "0")
        .unwrap_or(true)
}

#[cfg(target_os = "windows")]
pub(super) fn run_on_host(
    mut host: crate::agent::ps_host::Host,
    command: &str,
    cwd: Option<&str>,
    timeout_ms: Option<u64>,
    run_id: Option<String>,
    log: Option<&LogRequest>,
    opts: AgentOpts,
) -> Result<RunResult, String> {
    use crate::agent::ps_host::HostOutcome;
    let dir = match cwd.filter(|d| !d.is_empty()) {
        Some(d) => d.to_string(),
        None => std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".into()),
    };
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(id) = &run_id {
        active_runs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), cancel.clone());
    }
    // A host runs one command at a time: its process tree is that command's.
    let memory = MemoryWatch::start(opts.memory_guard, host.pid(), &cancel);
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000));
    let to_background = opts.to_background.as_ref().map(|t| (&*t.flag, true));
    let run = crate::agent::ps_host::run(
        &mut host,
        command,
        &dir,
        timeout,
        &cancel,
        log,
        to_background,
    );
    let memory_stop = memory.finish();
    if let Some(id) = &run_id {
        active_runs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }
    let run = match run {
        Ok(r) => r,
        Err(e) => {
            crate::agent::ps_host::kill_host(host);
            return Err(e);
        }
    };
    let (code, timed_out, cancelled) = match run.outcome {
        HostOutcome::Done(code) => {
            crate::agent::ps_host::release(host);
            (code, false, false)
        }
        HostOutcome::Exited(code) => (code, false, false),
        HostOutcome::TimedOut => {
            crate::agent::ps_host::kill_host(host);
            (-1, true, false)
        }
        HostOutcome::Cancelled => {
            crate::agent::ps_host::kill_host(host);
            (-1, false, true)
        }
        HostOutcome::Moved(by_timeout) => {
            let info = opts.to_background.expect("only a movable run moves").info;
            return Ok(follow_in_background(
                host,
                run.captured,
                info,
                opts.memory_guard,
                by_timeout,
            ));
        }
    };
    Ok(finish_run(
        run.captured,
        code,
        timed_out,
        cancelled && memory_stop.is_none(),
        timeout,
        memory_stop,
    ))
}

/// A command moved to the background in the middle of a host's run: the host stays its own (out
/// of the pool) while a thread reads the rest into a background shell; at the end it goes back
/// to the pool, or is killed if the shell was.
#[cfg(target_os = "windows")]
fn follow_in_background(
    mut host: crate::agent::ps_host::Host,
    captured: super::run::Captured,
    info: super::background::BgInfo,
    memory_guard: bool,
    by_timeout: bool,
) -> RunResult {
    use super::background::{adopt, BgChild};
    use crate::agent::ps_host::{follow, kill_host, release, HostOutcome};
    let stop = Arc::new(AtomicBool::new(false));
    let ended = Arc::new(Mutex::new(None));
    let root = host.pid();
    let adoption = adopt(
        info,
        BgChild::Host {
            stop: stop.clone(),
            ended: ended.clone(),
        },
        memory_guard.then_some(root),
    );
    adoption.prepend(&format!("{}{}", captured.stdout, captured.stderr));
    let mut out_feed = adoption.feed("stdout");
    let mut err_feed = adoption.feed("stderr");
    let done = Arc::new(AtomicBool::new(false));
    let finished = done.clone();
    std::thread::spawn(move || {
        let outcome = follow(
            &mut host,
            &mut |line| out_feed.line(line),
            &mut |line| err_feed.line(line),
            &stop,
        );
        let code = match outcome {
            HostOutcome::Done(code) => {
                release(host);
                Some(code)
            }
            HostOutcome::Exited(code) => Some(code),
            _ => {
                kill_host(host);
                None
            }
        };
        *ended.lock().unwrap_or_else(|e| e.into_inner()) = Some(code);
        finished.store(true, Ordering::Release);
    });
    let shell_id = adoption.id.clone();
    adoption.finish_when(move || {
        while !done.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    super::run::moved_result(captured.stdout, captured.stderr, shell_id, by_timeout)
}
