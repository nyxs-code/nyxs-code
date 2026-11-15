//! Finding the Claude Code CLI, its version and login, updating it, and opening a terminal to
//! install it or sign in.

use super::probe::{ensure_fresh_login, SPAWN_REFRESH_MARGIN_MS};
use crate::agent::cli_process::{await_readers, spawn_tied, StreamCapture, EXIT_DRAIN_GRACE};
use crate::agent::*;
use crate::error::CmdError;

const ENV_STRIP: [&str; 3] = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY"];
pub(super) const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(900);

#[cfg(target_os = "windows")]
const BINARY_NAMES: [&str; 2] = ["claude.exe", "claude.cmd"];
#[cfg(not(target_os = "windows"))]
const BINARY_NAMES: [&str; 1] = ["claude"];

#[cfg(target_os = "windows")]
const PATH_SEPARATOR: char = ';';
#[cfg(not(target_os = "windows"))]
const PATH_SEPARATOR: char = ':';

fn known_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(home) = home_dir() {
        dirs.push(home.join(".local").join("bin"));
        #[cfg(not(target_os = "windows"))]
        {
            dirs.push(home.join(".claude").join("local"));
            dirs.push(home.join(".npm-global").join("bin"));
            dirs.push(home.join(".bun").join("bin"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs.push(
                PathBuf::from(local)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links"),
            );
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    }
    dirs
}

pub(crate) fn locate_claude() -> Option<PathBuf> {
    let from_path = login_path()
        .map(|p| {
            p.split(PATH_SEPARATOR)
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    from_path
        .into_iter()
        .chain(known_dirs())
        .flat_map(|dir| BINARY_NAMES.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
}

pub(super) fn base_command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    apply_login_env(&mut cmd);
    for key in ENV_STRIP {
        cmd.env_remove(key);
    }
    hide_console(&mut cmd);
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

fn run_probe(bin: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = base_command(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = spawn_tied(&mut cmd).ok()?;
    let out = StreamCapture::start(child.stdout.take()?);
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(40))
            }
            _ => {
                kill_tree(&mut child);
                let _ = child.wait();
                return None;
            }
        }
    }
    await_readers([out.reader()], EXIT_DRAIN_GRACE);
    Some(out.take())
}

/// Runs the CLI to completion and returns its output, with stderr preferred when it fails.
/// Unlike `run_probe` the timeout is the caller's, since updating downloads a new binary.
fn run_to_end(bin: &Path, args: &[&str], timeout: Duration) -> Result<String, CmdError> {
    let mut cmd = base_command(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child =
        spawn_tied(&mut cmd).map_err(|e| CmdError::cli_start_failed("Claude Code", e))?;
    let out = StreamCapture::start(child.stdout.take().ok_or("No stdout from Claude Code")?);
    let err = StreamCapture::start(child.stderr.take().ok_or("No stderr from Claude Code")?);
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(80)),
            _ => {
                kill_tree(&mut child);
                let _ = child.wait();
                return Err(CmdError::cli_no_response("Claude Code"));
            }
        }
    };
    await_readers([out.reader(), err.reader()], EXIT_DRAIN_GRACE);
    let (out, err) = (out.take(), err.take());
    if status.success() {
        Ok(out)
    } else if err.trim().is_empty() {
        Err(out.into())
    } else {
        Err(err.into())
    }
}

/// Updates the CLI with its own updater, returning what it printed.
#[tauri::command]
pub async fn claude_code_update() -> Result<String, CmdError> {
    tauri::async_runtime::spawn_blocking(|| {
        let bin = locate_claude().ok_or_else(|| CmdError::cli_not_installed("Claude Code"))?;
        ensure_fresh_login(SPAWN_REFRESH_MARGIN_MS);
        run_to_end(&bin, &["update"], UPDATE_TIMEOUT)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeStatus {
    installed: bool,
    path: Option<String>,
    version: Option<String>,
    logged_in: bool,
    auth: Option<serde_json::Value>,
}

fn status_blocking() -> ClaudeCodeStatus {
    let Some(bin) = locate_claude() else {
        return ClaudeCodeStatus {
            installed: false,
            path: None,
            version: None,
            logged_in: false,
            auth: None,
        };
    };
    let version = run_probe(&bin, &["--version"])
        .and_then(|out| out.split_whitespace().next().map(str::to_string));
    let auth = run_probe(&bin, &["auth", "status", "--json"])
        .and_then(|out| serde_json::from_str::<serde_json::Value>(out.trim()).ok());
    let logged_in = auth
        .as_ref()
        .and_then(|a| a.get("loggedIn"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    ClaudeCodeStatus {
        installed: true,
        path: Some(bin.to_string_lossy().into_owned()),
        version,
        logged_in,
        auth,
    }
}

#[tauri::command]
pub async fn claude_code_status() -> Result<ClaudeCodeStatus, String> {
    tauri::async_runtime::spawn_blocking(status_blocking)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn terminal_script(action: &str, bin: Option<&Path>) -> Option<String> {
    match (action, bin) {
        ("login", Some(bin)) => {
            let quoted = bin.to_string_lossy().replace('\'', "''");
            Some(format!("& '{quoted}' auth login"))
        }
        _ => None,
    }
}

#[cfg(not(target_os = "windows"))]
fn terminal_script(action: &str, bin: Option<&Path>) -> Option<String> {
    match (action, bin) {
        ("login", Some(bin)) => {
            let quoted = bin.to_string_lossy().replace('\'', "'\\''");
            Some(format!("'{quoted}' auth login"))
        }
        _ => None,
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn open_terminal(script: &str) -> Result<(), CmdError> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoExit", "-NoLogo", "-Command", script]);
    cmd.creation_flags(CREATE_NEW_CONSOLE);
    cmd.spawn()
        .map(|_| ())
        .map_err(CmdError::terminal_open_failed)
}

#[cfg(target_os = "macos")]
pub(crate) fn open_terminal(script: &str) -> Result<(), CmdError> {
    let escaped = script.replace('\\', "\\\\").replace('"', "\\\"");
    Command::new("osascript")
        .args([
            "-e",
            &format!("tell application \"Terminal\" to do script \"{escaped}\""),
            "-e",
            "tell application \"Terminal\" to activate",
        ])
        .spawn()
        .map(|_| ())
        .map_err(CmdError::terminal_open_failed)
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn open_terminal(script: &str) -> Result<(), CmdError> {
    let full = format!("{script}; exec bash");
    let terminals: [(&str, &[&str]); 7] = [
        ("x-terminal-emulator", &["-e"]),
        ("gnome-terminal", &["--"]),
        ("konsole", &["-e"]),
        ("xfce4-terminal", &["-x"]),
        ("kitty", &[]),
        ("alacritty", &["-e"]),
        ("xterm", &["-e"]),
    ];
    for (term, prefix) in terminals {
        let mut cmd = Command::new(term);
        cmd.args(prefix).args(["bash", "-lc", &full]);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }
    Err(CmdError::terminal_not_found())
}

#[tauri::command(async)]
pub fn claude_code_open_terminal(action: String) -> Result<(), CmdError> {
    let bin = locate_claude();
    if action == "login" && bin.is_none() {
        return Err(CmdError::cli_not_installed("Claude Code"));
    }
    let script = terminal_script(&action, bin.as_deref())
        .ok_or_else(|| format!("Unknown action: {action}"))?;
    open_terminal(&script)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probing_and_updating_return_once_the_cli_exits_though_a_grandchild_keeps_its_pipes() {
        let (bin, args) = super::super::super::cli_process::exits_leaving_a_grandchild();
        let started = Instant::now();
        assert!(run_probe(&bin, &args).unwrap().contains("hi"));
        assert!(run_to_end(&bin, &args, PROBE_TIMEOUT)
            .unwrap()
            .contains("hi"));
        assert!(
            started.elapsed() < Duration::from_secs(6),
            "waited for the grandchild"
        );
    }
}
