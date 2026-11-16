//! Installing an agent CLI the way zeron does: its official installer runs quietly in the
//! background (no terminal window), non-interactive, with a 15-minute deadline the user can cut
//! short. Each CLI has its methods in order of preference (the vendor's script, then npm); the
//! first one this computer has the tools for is tried, then the next if it fails. Success means
//! the CLI can be found afterwards, not just that the installer exited cleanly.

use super::claude_code::locate_claude;
use super::*;
use crate::error::CmdError;
use std::sync::atomic::AtomicBool;

const INSTALL_DEADLINE: Duration = Duration::from_secs(15 * 60);
/// The installer's last lines, for the error when it fails.
const OUTPUT_TAIL_LINES: usize = 12;

// Each system builds only its own kinds: PowerShell on Windows, the rest elsewhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
enum Method {
    /// A PowerShell one-liner (Windows).
    PowerShell(&'static str),
    /// `npm install -g <package>`.
    Npm(&'static str),
    /// A `curl … | bash` one-liner (macOS, Linux).
    Shell(&'static str),
    /// `brew install --cask <cask>` (macOS).
    Brew(&'static str),
}

/// The vendors' own installers, as their install pages give them.
fn methods(cli: &str) -> Vec<Method> {
    use Method::*;
    #[cfg(target_os = "windows")]
    return match cli {
        "claude-code" => vec![PowerShell("irm https://claude.ai/install.ps1 | iex")],
        "grok" => vec![
            PowerShell("irm https://x.ai/cli/install.ps1 | iex"),
            Npm("@xai-official/grok"),
        ],
        "antigravity" => vec![PowerShell(
            "irm https://antigravity.google/cli/install.ps1 | iex",
        )],
        "cursor" => vec![PowerShell(
            "irm 'https://cursor.com/install?win32=true' | iex",
        )],
        "codex" => vec![
            PowerShell("irm https://chatgpt.com/codex/install.ps1 | iex"),
            Npm("@openai/codex"),
        ],
        "deepseek" => vec![Npm("@deepseek-ai/dsh")],
        "devin" => vec![PowerShell(
            "irm https://static.devin.ai/cli/setup.ps1 | iex",
        )],
        "opencode" => vec![Npm("opencode-ai")],
        _ => vec![],
    };
    #[cfg(not(target_os = "windows"))]
    return match cli {
        "claude-code" => vec![Shell("curl -fsSL https://claude.ai/install.sh | bash")],
        "grok" => vec![
            Shell("curl -fsSL https://x.ai/cli/install.sh | bash"),
            Npm("@xai-official/grok"),
        ],
        "antigravity" => vec![Shell(
            "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        )],
        "cursor" => vec![Shell("curl https://cursor.com/install -fsS | bash")],
        "codex" => vec![
            Shell("curl -fsSL https://chatgpt.com/codex/install.sh | sh"),
            Npm("@openai/codex"),
        ],
        "deepseek" => vec![Npm("@deepseek-ai/dsh")],
        "devin" if cfg!(target_os = "macos") => vec![
            Brew("devin-cli"),
            Shell("curl -fsSL https://cli.devin.ai/install.sh | bash"),
        ],
        "devin" => vec![Shell("curl -fsSL https://cli.devin.ai/install.sh | bash")],
        "opencode" => vec![
            Shell("curl -fsSL https://opencode.ai/install | bash"),
            Npm("opencode-ai"),
        ],
        _ => vec![],
    };
}

fn label(cli: &str) -> &'static str {
    match cli {
        "claude-code" => "Claude Code",
        other => agent_cli::agent_cli_label(other).unwrap_or("CLI"),
    }
}

fn locate(cli: &str) -> Option<PathBuf> {
    match cli {
        "claude-code" => locate_claude(),
        other => agent_cli::locate_agent_cli(other),
    }
}

/// A program on the PATH the user's shell has (the app's own may be older).
fn on_path(name: &str) -> Option<PathBuf> {
    let path = login_path()?;
    #[cfg(target_os = "windows")]
    let (sep, names) = (';', [format!("{name}.exe"), format!("{name}.cmd")]);
    #[cfg(not(target_os = "windows"))]
    let (sep, names) = (':', [name.to_string(), name.to_string()]);
    path.split(sep)
        .filter(|d| !d.trim().is_empty())
        .flat_map(|d| names.iter().map(move |n| PathBuf::from(d).join(n)))
        .find(|p| p.is_file())
}

/// Whether this computer has what the method runs on.
fn available(method: Method) -> bool {
    let has = |name: &str| on_path(name).is_some();
    match method {
        Method::PowerShell(_) => cfg!(target_os = "windows"),
        Method::Npm(_) => has("npm"),
        Method::Shell(_) => has("sh") && has("curl") && has("bash"),
        Method::Brew(_) => has("brew"),
    }
}

fn describe(method: Method) -> String {
    match method {
        Method::PowerShell(script) | Method::Shell(script) => script.to_string(),
        Method::Npm(package) => format!("npm install -g {package}"),
        Method::Brew(cask) => format!("brew install --cask {cask}"),
    }
}

fn command(method: Method) -> Command {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let script = match method {
            Method::PowerShell(script) => script.to_string(),
            // `npm.cmd`, not `npm`: that's npm.ps1, which PowerShell's default policy won't run.
            Method::Npm(package) => format!("npm.cmd install -g '{package}'"),
            Method::Shell(script) | Method::Brew(script) => script.to_string(),
        };
        let mut cmd = Command::new(powershell_exe());
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ]);
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let script = match method {
            Method::Npm(package) => format!("npm install -g {package}"),
            Method::Brew(cask) => format!("brew install --cask {cask}"),
            Method::Shell(script) | Method::PowerShell(script) => script.to_string(),
        };
        let mut cmd = Command::new("sh");
        cmd.args(["-c", &script]);
        cmd
    };
    apply_login_env(&mut cmd);
    hide_console(&mut cmd);
    // Installers that would ask something take their defaults instead of waiting for an answer
    // no one can give.
    cmd.env("CI", "1")
        .env("NONINTERACTIVE", "1")
        .env("TERM", "dumb")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

/// Keeps the installer's last lines (both streams) for its error.
fn keep_tail(
    reader: impl Read + Send + 'static,
    tail: Arc<Mutex<Vec<String>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            let mut tail = tail.lock().unwrap_or_else(|e| e.into_inner());
            tail.push(line);
            if tail.len() > OUTPUT_TAIL_LINES {
                tail.remove(0);
            }
        }
    })
}

fn run(method: Method, cancel: &AtomicBool) -> Result<(), String> {
    run_command(command(method), &describe(method), cancel)
}

/// Runs an installer to its end, its deadline or a cancel: `what` names it in the errors.
fn run_command(mut cmd: Command, what: &str, cancel: &AtomicBool) -> Result<(), String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("couldn't start `{what}`: {e}"))?;
    let tail = Arc::new(Mutex::new(Vec::new()));
    let readers = [
        child.stdout.take().map(|s| keep_tail(s, tail.clone())),
        child.stderr.take().map(|s| keep_tail(s, tail.clone())),
    ];
    let start = Instant::now();
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break Ok(()),
            Ok(Some(status)) => break Err(format!("`{what}` exited with {status}")),
            Ok(None) if cancel.load(Ordering::Relaxed) => {
                break Err("installation cancelled".into())
            }
            Ok(None) if start.elapsed() > INSTALL_DEADLINE => {
                break Err("installation timed out after 15 minutes".into())
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => break Err(e.to_string()),
        }
    };
    if outcome.is_err() {
        kill_tree(&mut child);
        let _ = child.wait();
    }
    // Not joined: a helper the installer left running can hold its pipes open for good, and
    // "Installing…" would never end nor let the user try again.
    super::cli_process::await_readers(
        readers.iter().flatten(),
        super::cli_process::EXIT_DRAIN_GRACE,
    );
    outcome.map_err(|reason| {
        let tail = tail.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
        if tail.is_empty() {
            reason
        } else {
            format!("{reason}\n{tail}")
        }
    })
}

/// Installs under way, by CLI: setting the flag stops one.
static INSTALLS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn installs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    INSTALLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn install_blocking(cli: &str, cancel: &AtomicBool) -> Result<(), String> {
    let usable: Vec<Method> = methods(cli).into_iter().filter(|m| available(*m)).collect();
    if usable.is_empty() {
        return Err(match methods(cli).first() {
            Some(Method::Npm(_)) => "it installs with npm, which comes with Node.js: install Node.js from https://nodejs.org and try again".into(),
            Some(_) => "this computer lacks the tools its installer needs".into(),
            None => "there is no installer for it".into(),
        });
    }
    let mut last_error = String::new();
    for method in usable {
        match run(method, cancel) {
            Ok(()) if locate(cli).is_some() => return Ok(()),
            Ok(()) => {
                last_error = format!(
                    "the installer finished, but {} wasn't found; open a new terminal or restart Nyxs so it sees the updated PATH",
                    label(cli)
                )
            }
            Err(e) if cancel.load(Ordering::Relaxed) => return Err(e),
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

/// Installs the CLI quietly with its official installer and waits for it.
#[tauri::command]
pub async fn cli_install(cli: String) -> Result<(), CmdError> {
    let name = label(&cli);
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = installs().lock().unwrap_or_else(|e| e.into_inner());
        if running.contains_key(&cli) {
            return Err(CmdError::cli_install_failed(
                name,
                "it is already being installed",
            ));
        }
        running.insert(cli.clone(), cancel.clone());
    }
    let id = cli.clone();
    let result = tauri::async_runtime::spawn_blocking(move || install_blocking(&id, &cancel))
        .await
        .map_err(|e| e.to_string());
    installs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&cli);
    result?.map_err(|e| CmdError::cli_install_failed(name, e))
}

/// Stops an install under way.
#[tauri::command]
pub fn cli_install_cancel(cli: String) {
    if let Some(flag) = installs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&cli)
    {
        flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_install_ends_when_the_installer_does_though_a_helper_keeps_its_pipes() {
        let (bin, args) = super::super::cli_process::exits_leaving_a_grandchild();
        let mut cmd = Command::new(bin);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut cmd);
        let started = Instant::now();
        assert_eq!(
            run_command(cmd, "installer", &AtomicBool::new(false)),
            Ok(())
        );
        assert!(
            started.elapsed() < super::super::cli_process::GRANDCHILD_LIMIT,
            "waited for the helper"
        );
    }

    #[test]
    fn every_cli_has_an_installer_on_this_system() {
        for cli in [
            "claude-code",
            "grok",
            "antigravity",
            "cursor",
            "codex",
            "deepseek",
            "devin",
            "opencode",
        ] {
            assert!(!methods(cli).is_empty(), "{cli} has no installer");
        }
        assert!(methods("unknown").is_empty());
    }
}
