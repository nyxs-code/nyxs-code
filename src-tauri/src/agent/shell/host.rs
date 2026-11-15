//! Running a command on one of the pooled persistent PowerShell hosts (Windows).

use super::run::{active_runs, finish_run, RunResult};
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
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000));
    let run = crate::agent::ps_host::run(&mut host, command, &dir, timeout, &cancel, log);
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
    };
    Ok(finish_run(
        run.captured,
        code,
        timed_out,
        cancelled,
        timeout,
    ))
}
