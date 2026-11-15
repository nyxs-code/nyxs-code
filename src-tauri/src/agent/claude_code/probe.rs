//! Keeping the Claude login fresh, and one-shot Claude Code processes that answer a single
//! control request (models, effort, plan usage, context).

use super::args::{args_for, run_args, run_cwd, ClaudeCodeRunRequest, EFFORTS};
use super::install::{base_command, locate_claude, PROBE_TIMEOUT};
use crate::agent::*;
use crate::error::CmdError;

const PROBE_EXIT_GRACE: Duration = Duration::from_secs(30);
const REFRESH_TIMEOUT: Duration = Duration::from_secs(60);
pub(super) const SPAWN_REFRESH_MARGIN_MS: i64 = 2 * 60 * 1000;
const KEEPALIVE_REFRESH_MARGIN_MS: i64 = 15 * 60 * 1000;

const INIT_REQUEST_ID: &str = "nyxs-models";
const LIST_MODELS_REQUEST_ID: &str = "nyxs-list-models";
const USAGE_REQUEST_ID: &str = "nyxs-usage";
const CONTEXT_REQUEST_ID: &str = "nyxs-context";
const SETTINGS_REQUEST_ID: &str = "nyxs-settings";

/// Arguments for a probe that needs nothing loaded: no tools, no MCP servers, no session.
fn bare_probe_args() -> Vec<String> {
    [
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--tools=",
        "--strict-mcp-config",
        "--no-session-persistence",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn credentials_path() -> Option<PathBuf> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir().ok().map(|h| h.join(".claude")))?;
    Some(dir.join(".credentials.json"))
}

fn login_expiry() -> Option<i64> {
    let text = fs::read_to_string(credentials_path()?).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let oauth = json.get("claudeAiOauth")?;
    let refreshable = oauth
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .is_some_and(|t| !t.is_empty());
    if !refreshable {
        return None;
    }
    oauth.get("expiresAt")?.as_i64()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn login_expires_within(margin_ms: i64) -> bool {
    login_expiry().is_some_and(|at| at - now_ms() < margin_ms)
}

static LOGIN_REFRESH: Mutex<()> = Mutex::new(());

/// Runs `f` while no refresh Nyxs starts can rotate the Claude login: switching accounts reads
/// and replaces it, and a refresh in between would leave the saved copy with a spent token.
pub(crate) fn with_login_refresh_held<T>(f: impl FnOnce() -> T) -> T {
    let _guard = LOGIN_REFRESH.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

/// Renews the Claude login in one process that is left to finish on its own, before any other
/// Claude Code process starts. Every refresh rotates the refresh token: several processes
/// refreshing at once, or one killed after the server rotated it but before it saved the new
/// one, leave a token the server rejects ("OAuth session expired and could not be refreshed")
/// and the user has to sign in again.
pub(super) fn ensure_fresh_login(margin_ms: i64) {
    if !login_expires_within(margin_ms) {
        return;
    }
    let _guard = LOGIN_REFRESH.lock().unwrap_or_else(|e| e.into_inner());
    if !login_expires_within(margin_ms) {
        return;
    }
    // Reading the plan usage needs a valid token, so the CLI refreshes it first.
    let _ = probe_once(
        USAGE_REQUEST_ID,
        serde_json::json!({ "subtype": "get_usage" }),
        bare_probe_args(),
        None,
        ProbeExit::Wait(REFRESH_TIMEOUT),
    );
}

#[tauri::command]
pub async fn claude_code_keep_login_fresh() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| ensure_fresh_login(KEEPALIVE_REFRESH_MARGIN_MS))
        .await
        .map_err(|e| e.to_string())
}

fn wait_exit(child: &mut Child, grace: Duration) {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if start.elapsed() < grace => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                kill_tree(child);
                let _ = child.wait();
                return;
            }
        }
    }
}

enum ProbeExit {
    Background,
    Wait(Duration),
}

/// Starts a throwaway Claude Code process, sends it one control request and returns the
/// inner `response` of its answer. `initialize` always goes first, as the CLI expects.
fn control_probe(
    request_id: &str,
    request: serde_json::Value,
    args: Vec<String>,
    cwd: Option<&str>,
) -> Result<serde_json::Value, CmdError> {
    ensure_fresh_login(SPAWN_REFRESH_MARGIN_MS);
    probe_once(request_id, request, args, cwd, ProbeExit::Background)
}

fn probe_once(
    request_id: &str,
    request: serde_json::Value,
    args: Vec<String>,
    cwd: Option<&str>,
    exit: ProbeExit,
) -> Result<serde_json::Value, CmdError> {
    let bin = locate_claude().ok_or_else(|| CmdError::cli_not_installed("Claude Code"))?;
    let cwd = run_cwd(cwd)?;
    let mut cmd = base_command(&bin);
    cmd.args(args_for(&bin, args))
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = crate::agent::cli_process::spawn_tied(&mut cmd)
        .map_err(|e| CmdError::cli_start_failed("Claude Code", e))?;
    let mut stdin = child.stdin.take().ok_or("No stdin from Claude Code")?;
    let stdout = child.stdout.take().ok_or("No stdout from Claude Code")?;
    let init = serde_json::json!({
        "type": "control_request",
        "request_id": INIT_REQUEST_ID,
        "request": { "subtype": "initialize" },
    });
    let mut written = writeln!(stdin, "{init}");
    if request_id != INIT_REQUEST_ID {
        let wanted = serde_json::json!({ "type": "control_request", "request_id": request_id, "request": request });
        written = written.and_then(|_| writeln!(stdin, "{wanted}"));
    }
    let written = written.and_then(|_| stdin.flush());
    let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
    let wanted_id = request_id.to_string();
    // Keeps draining stdout until the process exits: closing the pipe early could break the
    // CLI while it is still saving a refreshed login.
    std::thread::spawn(move || {
        let mut answered = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if answered {
                continue;
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let response = &msg["response"];
            if msg["type"] == "control_response" && response["request_id"] == wanted_id.as_str() {
                let _ = tx.send(response["response"].clone());
                answered = true;
            }
        }
    });
    let outcome = match written {
        Ok(()) => rx
            .recv_timeout(PROBE_TIMEOUT)
            .map_err(|_| CmdError::cli_no_response("Claude Code")),
        Err(e) => Err(CmdError::cli_write_failed("Claude Code", e)),
    };
    // Closing stdin lets the CLI exit by itself; it is only killed if it doesn't within the grace.
    drop(stdin);
    match exit {
        ProbeExit::Wait(grace) => wait_exit(&mut child, grace),
        ProbeExit::Background => {
            std::thread::spawn(move || wait_exit(&mut child, PROBE_EXIT_GRACE));
        }
    }
    outcome
}

#[tauri::command]
pub async fn claude_code_initialize() -> Result<serde_json::Value, CmdError> {
    tauri::async_runtime::spawn_blocking(|| {
        control_probe(
            INIT_REQUEST_ID,
            serde_json::Value::Null,
            bare_probe_args(),
            None,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every model the signed-in account can pick, including the earlier generations the CLI
/// keeps under "More models". `initialize` only reports the current generation, so older
/// CLIs that reject `list_models` fall back to it.
#[tauri::command]
pub async fn claude_code_list_models() -> Result<serde_json::Value, CmdError> {
    tauri::async_runtime::spawn_blocking(|| {
        let listed = control_probe(
            LIST_MODELS_REQUEST_ID,
            serde_json::json!({ "subtype": "list_models" }),
            bare_probe_args(),
            None,
        );
        match listed {
            Ok(value) if value.get("models").is_some() => Ok(value),
            _ => control_probe(
                INIT_REQUEST_ID,
                serde_json::Value::Null,
                bare_probe_args(),
                None,
            ),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The effort Claude Code uses for `model` in `cwd` when Nyxs doesn't pass `--effort` (the
/// level it recommends, after user and project settings), read from its effective settings.
/// `None` when the model has no effort.
#[tauri::command]
pub async fn claude_code_default_effort(
    model: String,
    cwd: Option<String>,
    untrusted_project: Option<bool>,
) -> Result<Option<String>, CmdError> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = bare_probe_args();
        args.push(format!("--model={model}"));
        // An untrusted folder's settings don't count, as they don't for its runs; a probe would
        // otherwise start the repo's apiKeyHelper or SessionStart hooks before any message.
        if untrusted_project.unwrap_or(false) {
            args.extend(["--setting-sources".to_string(), "user".to_string()]);
        }
        let settings = control_probe(
            SETTINGS_REQUEST_ID,
            serde_json::json!({ "subtype": "get_settings" }),
            args,
            cwd.as_deref(),
        )?;
        Ok(settings
            .pointer("/applied/effort")
            .and_then(|v| v.as_str())
            .filter(|e| EFFORTS.contains(e))
            .map(str::to_string))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The signed-in account's plan usage (5-hour and weekly limits), as Claude Code reports it.
/// The CLI talks to Anthropic with its own login, so no token ever reaches this app.
#[tauri::command]
pub async fn claude_code_usage() -> Result<serde_json::Value, CmdError> {
    tauri::async_runtime::spawn_blocking(|| {
        control_probe(
            USAGE_REQUEST_ID,
            serde_json::json!({ "subtype": "get_usage" }),
            bare_probe_args(),
            None,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What a chat's context holds and the model's real window. Without `session`, a new chat's
/// before its first message (system prompt, tools, MCP, memory, skills). With it, an existing
/// chat whose process has already exited: the session is resumed read-only
/// (`--no-session-persistence`), so its messages are counted but nothing is saved or sent.
#[tauri::command]
pub async fn claude_code_context_baseline(
    model: Option<String>,
    cwd: Option<String>,
    session: Option<String>,
    untrusted_project: Option<bool>,
) -> Result<serde_json::Value, CmdError> {
    tauri::async_runtime::spawn_blocking(move || {
        let request = ClaudeCodeRunRequest {
            run_id: String::new(),
            cwd: cwd.clone(),
            model,
            resume: session,
            resume_at: None,
            permission_mode: None,
            effort: None,
            no_tools: false,
            ephemeral: true,
            // Nobody would answer their MCP handshake in a probe.
            sdk_mcp_servers: Vec::new(),
            append_system_prompt: None,
            env: Default::default(),
            max_turns: None,
            untrusted_project: untrusted_project.unwrap_or(false),
        };
        control_probe(
            CONTEXT_REQUEST_ID,
            serde_json::json!({ "subtype": "get_context_usage", "detail": "summary" }),
            run_args(&request),
            cwd.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
