//! Other vendors' coding agents driven like Claude Code: the user's own Grok CLI (xAI) or
//! Antigravity CLI (Google) runs as a child process with its own sign-in, and Nyxs speaks its
//! machine protocol over stdin/stdout. Each turn is one process; the protocol itself (ACP for
//! Grok, stream-json for Antigravity) is handled by the page.

use super::claude_code::open_terminal;
use super::cli_process::{
    await_readers, run_cwd, spawn_exit_waiter, spawn_line_reader, spawn_remote_cli,
    spawn_stdin_writer, spawn_tied, CliChild, StreamCapture, EXIT_DRAIN_GRACE,
};
use super::*;
use crate::error::CmdError;
use serde::Deserialize;
use tauri::ipc::Channel;

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

#[cfg(target_os = "windows")]
const PATH_SEPARATOR: char = ';';
#[cfg(not(target_os = "windows"))]
const PATH_SEPARATOR: char = ':';

#[derive(Clone, Copy, PartialEq, Eq)]
enum Cli {
    Grok,
    Antigravity,
    Cursor,
    Codex,
    DeepSeek,
    Devin,
    OpenCode,
}

impl Cli {
    fn parse(id: &str) -> Result<Cli, String> {
        match id {
            "grok" => Ok(Cli::Grok),
            "antigravity" => Ok(Cli::Antigravity),
            "cursor" => Ok(Cli::Cursor),
            "codex" => Ok(Cli::Codex),
            "deepseek" => Ok(Cli::DeepSeek),
            "devin" => Ok(Cli::Devin),
            "opencode" => Ok(Cli::OpenCode),
            _ => Err(format!("Unknown CLI: {id}")),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Cli::Grok => "grok",
            Cli::Antigravity => "antigravity",
            Cli::Cursor => "cursor",
            Cli::Codex => "codex",
            Cli::DeepSeek => "deepseek",
            Cli::Devin => "devin",
            Cli::OpenCode => "opencode",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Cli::Grok => "Grok CLI",
            Cli::Antigravity => "Antigravity CLI",
            Cli::Cursor => "Cursor CLI",
            Cli::Codex => "Codex CLI",
            Cli::DeepSeek => "DeepSeek Harness",
            Cli::Devin => "Devin",
            Cli::OpenCode => "OpenCode",
        }
    }

    fn binary_names(self) -> &'static [&'static str] {
        #[cfg(target_os = "windows")]
        return match self {
            Cli::Grok => &["grok.exe", "grok.cmd"],
            Cli::Antigravity => &["agy.exe", "agy.cmd"],
            // Only `cursor-agent`: its `agent` alias would clash with the agent.exe Grok installs.
            Cli::Cursor => &["cursor-agent.exe", "cursor-agent.cmd"],
            Cli::Codex => &["codex.exe", "codex.cmd"],
            Cli::DeepSeek => &["dsh.exe", "dsh.cmd"],
            Cli::Devin => &["devin.exe", "devin.cmd"],
            Cli::OpenCode => &["opencode.exe", "opencode.cmd"],
        };
        #[cfg(not(target_os = "windows"))]
        return match self {
            Cli::Grok => &["grok"],
            Cli::Antigravity => &["agy"],
            Cli::Cursor => &["cursor-agent"],
            Cli::Codex => &["codex"],
            Cli::DeepSeek => &["dsh"],
            Cli::Devin => &["devin"],
            Cli::OpenCode => &["opencode"],
        };
    }

    /// Where the official installers put the binary, for when the app's PATH doesn't have it
    /// yet (installed after Nyxs started, or a PATH change a new terminal would only pick up).
    fn known_dirs(self) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = Vec::new();
        let home = home_dir().ok();
        match self {
            Cli::Grok => {
                if let Ok(dir) = std::env::var("GROK_BIN_DIR") {
                    dirs.push(PathBuf::from(dir));
                }
                if let Some(home) = &home {
                    dirs.push(home.join(".grok").join("bin"));
                }
            }
            Cli::Antigravity => {
                #[cfg(target_os = "windows")]
                {
                    if let Ok(local) = std::env::var("LOCALAPPDATA") {
                        dirs.push(PathBuf::from(&local).join("agy").join("bin"));
                        dirs.push(PathBuf::from(&local).join("Antigravity"));
                    }
                }
            }
            Cli::Cursor => {
                #[cfg(target_os = "windows")]
                {
                    if let Ok(local) = std::env::var("LOCALAPPDATA") {
                        dirs.push(PathBuf::from(local).join("cursor-agent"));
                    }
                }
            }
            // npm's global folder (%APPDATA%\npm) and ~/.local/bin are looked in for every CLI.
            Cli::DeepSeek => {}
            // Its installer links ~/.local/bin/devin, looked in for every CLI.
            Cli::Devin => {}
            Cli::OpenCode => {
                if let Some(home) = &home {
                    dirs.push(home.join(".opencode").join("bin"));
                    dirs.push(home.join(".bun").join("bin"));
                }
            }
            Cli::Codex => {
                #[cfg(target_os = "windows")]
                {
                    if let Ok(local) = std::env::var("LOCALAPPDATA") {
                        dirs.push(
                            PathBuf::from(local)
                                .join("Microsoft")
                                .join("WinGet")
                                .join("Links"),
                        );
                    }
                }
            }
        }
        if let Some(home) = &home {
            dirs.push(home.join(".local").join("bin"));
        }
        #[cfg(target_os = "windows")]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                dirs.push(PathBuf::from(appdata).join("npm"));
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            dirs.push(PathBuf::from("/opt/homebrew/bin"));
            dirs.push(PathBuf::from("/usr/local/bin"));
        }
        dirs
    }

    fn locate(self) -> Option<PathBuf> {
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
            .chain(self.known_dirs())
            .flat_map(|dir| self.binary_names().iter().map(move |name| dir.join(name)))
            .find(|candidate| candidate.is_file())
    }

    /// Grok and Cursor have their own login command; Antigravity signs in the first time it opens.
    fn login_args(self) -> &'static str {
        match self {
            Cli::Grok | Cli::Cursor | Cli::Codex => "login",
            Cli::Antigravity => "",
            // DeepSeek Harness runs on the user's DeepSeek API key, which Nyxs hands it: its
            // own web settings are only for whoever wants to set the key there instead.
            Cli::DeepSeek => "web",
            // Devin signs in to its account; OpenCode to one model provider at a time.
            Cli::Devin | Cli::OpenCode => "auth login",
        }
    }

    /// What lists the CLI's models: Devin's catalog as JSON, `<cli> models` for the rest.
    fn models_args(self) -> &'static [&'static str] {
        match self {
            Cli::Devin => &["models", "list", "--format", "json"],
            _ => &["models"],
        }
    }
}

fn base_command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    apply_login_env(&mut cmd);
    hide_console(&mut cmd);
    // Antigravity checks for updates every 15 minutes in a detached process that has no
    // console, so on Windows the `agy --version` it runs got a new one: a terminal window
    // popped up on start-up and on switching provider. Nyxs runs `agy update` itself instead
    // (keep_antigravity_updated), on every system so the two never update at once. Only
    // "true" turns it off; "1" doesn't.
    cmd.env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

/// Runs the CLI to completion within `timeout` and returns its stdout, or what it printed on
/// stderr when it failed.
fn run_capture(bin: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let (ok, out, err) = run_streams(bin, args, timeout)?;
    if ok {
        Ok(out)
    } else if err.trim().is_empty() {
        Err(out)
    } else {
        Err(err)
    }
}

/// What a sign-in check printed, on either stream and whatever its exit code: Codex says
/// "Logged in using ChatGPT" on stderr.
fn sign_in_text(bin: &Path, args: &[&str]) -> String {
    match run_streams(bin, args, PROBE_TIMEOUT) {
        Ok((_, out, err)) => format!("{out}\n{err}").to_ascii_lowercase(),
        Err(_) => String::new(),
    }
}

/// Runs the CLI to completion within `timeout`: whether it succeeded, its stdout and its stderr.
fn run_streams(
    bin: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(bool, String, String), String> {
    let mut cmd = base_command(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_tied(&mut cmd).map_err(|e| e.to_string())?;
    let out = StreamCapture::start(child.stdout.take().ok_or("No stdout")?);
    let err = StreamCapture::start(child.stderr.take().ok_or("No stderr")?);
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                kill_tree(&mut child);
                let _ = child.wait();
                return Err("Didn't respond in time".to_string());
            }
        }
    };
    await_readers([out.reader(), err.reader()], EXIT_DRAIN_GRACE);
    Ok((status.success(), out.take(), err.take()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliStatus {
    installed: bool,
    path: Option<String>,
    version: Option<String>,
    /// None when the CLI has no way to tell without starting a session (Grok).
    logged_in: Option<bool>,
    /// Who is signed in, read from the CLI's own files (never its secrets).
    account: Option<CliAccountInfo>,
}

/// The signed-in account as the CLI keeps it on disk: what the settings show for it.
#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliAccountInfo {
    email: Option<String>,
    name: Option<String>,
    plan: Option<String>,
}

impl CliAccountInfo {
    fn known(self) -> Option<Self> {
        (self.email.is_some() || self.name.is_some()).then_some(self)
    }
}

fn json_str(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var(var)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// "SUBSCRIPTION_TIER_SUPER_GROK_HEAVY" or "plus" as a plan name: "Super Grok Heavy", "Plus".
pub(super) fn plan_words(raw: &str) -> Option<String> {
    let stem = raw
        .strip_prefix("SUBSCRIPTION_TIER_")
        .or_else(|| raw.strip_prefix("TIER_"))
        .unwrap_or(raw);
    if matches!(
        stem.to_ascii_lowercase().as_str(),
        "" | "none" | "free" | "unspecified" | "unknown"
    ) {
        return None;
    }
    let words: Vec<String> = stem
        .split(['_', '-', ' '])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            chars
                .next()
                .map(|c| {
                    c.to_uppercase()
                        .chain(chars.flat_map(char::to_lowercase))
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect();
    (!words.is_empty()).then(|| words.join(" ").replace("Super Grok", "SuperGrok"))
}

/// Grok's sign-in (`$GROK_HOME/auth.json`, default `~/.grok`): one entry per issuer, the
/// x.ai one preferred.
fn grok_auth_entry() -> Option<serde_json::Value> {
    let home = env_dir("GROK_HOME").or_else(|| home_dir().ok().map(|h| h.join(".grok")))?;
    let auth = read_json(&home.join("auth.json"))?;
    auth.as_object()?
        .iter()
        .filter(|(_, e)| json_str(e, "key").is_some())
        .max_by_key(|(map_key, e)| {
            let issuer = json_str(e, "oidc_issuer").unwrap_or_else(|| (*map_key).clone());
            (
                issuer.starts_with("https://auth.x.ai"),
                json_str(e, "email").is_some(),
            )
        })
        .map(|(_, e)| e.clone())
}

fn grok_account() -> Option<CliAccountInfo> {
    let entry = grok_auth_entry()?;
    let name = [
        json_str(&entry, "first_name"),
        json_str(&entry, "last_name"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    CliAccountInfo {
        email: json_str(&entry, "email"),
        name: (!name.is_empty()).then_some(name),
        plan: json_str(&entry, "subscription_tier").and_then(|t| plan_words(&t)),
    }
    .known()
}

/// Antigravity keeps no identity next to its token, but its log says who signed in
/// ("OAuth: authenticated successfully as …"): the newest log that says it.
fn antigravity_account() -> Option<CliAccountInfo> {
    let dir = home_dir().ok()?.join(".gemini").join("antigravity-cli");
    let mut logs: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(dir.join("log"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .chain(std::iter::once(dir.join("cli.log")))
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();
    logs.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    let email = logs.into_iter().take(10).find_map(|(_, path)| {
        signed_in_email(&String::from_utf8_lossy(&std::fs::read(path).ok()?))
    })?;
    CliAccountInfo {
        email: Some(email),
        ..Default::default()
    }
    .known()
}

fn signed_in_email(log: &str) -> Option<String> {
    log.lines()
        .rev()
        .find_map(|l| l.split("authenticated successfully as ").nth(1))
        .map(|rest| rest.split_whitespace().next().unwrap_or("").to_string())
        .filter(|email| email.contains('@'))
}

/// Codex's ChatGPT sign-in (`$CODEX_HOME/auth.json`, default `~/.codex`): the identity and
/// plan are claims of its `id_token`. An API-key sign-in has none.
fn codex_account() -> Option<CliAccountInfo> {
    use base64::Engine;
    let home = env_dir("CODEX_HOME").or_else(|| home_dir().ok().map(|h| h.join(".codex")))?;
    let auth = read_json(&home.join("auth.json"))?;
    let token = auth.get("tokens")?.get("id_token")?.as_str()?;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.split('.').nth(1)?.trim_end_matches('='))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    CliAccountInfo {
        email: json_str(&claims, "email"),
        name: json_str(&claims, "name"),
        plan: claims
            .get("https://api.openai.com/auth")
            .and_then(|a| json_str(a, "chatgpt_plan_type"))
            .and_then(|p| plan_words(&p)),
    }
    .known()
}

/// Where an XDG data folder is (`$XDG_DATA_HOME`, default `~/.local/share`), which Devin and
/// OpenCode use on every system.
fn xdg_data_home() -> Option<PathBuf> {
    env_dir("XDG_DATA_HOME").or_else(|| home_dir().ok().map(|h| h.join(".local").join("share")))
}

/// Devin keeps its key in `credentials.toml` (`windsurf_api_key`, or `devin_api_key`); older
/// versions kept it in the system's app-data folder.
fn devin_signed_in() -> bool {
    let mut files: Vec<PathBuf> = xdg_data_home()
        .map(|d| d.join("devin").join("credentials.toml"))
        .into_iter()
        .collect();
    if let Some(appdata) = env_dir("APPDATA") {
        files.push(appdata.join("devin").join("credentials.toml"));
    }
    if let Ok(home) = home_dir() {
        files.push(
            home.join("Library")
                .join("Application Support")
                .join("devin")
                .join("credentials.toml"),
        );
    }
    files
        .iter()
        .filter_map(|f| std::fs::read_to_string(f).ok())
        .any(|text| devin_has_key(&text))
}

fn devin_has_key(toml: &str) -> bool {
    toml.lines().any(|line| {
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        matches!(key.trim(), "windsurf_api_key" | "devin_api_key")
            && !value.trim().trim_matches(['"', '\'']).is_empty()
    })
}

/// OpenCode signs in to one model provider at a time (`auth.json`, one entry per provider):
/// those are its "account". Without any it may still run on keys in the environment, so that
/// isn't called signed out.
fn opencode_sign_in() -> (Option<bool>, Option<CliAccountInfo>) {
    let Some(auth) = xdg_data_home()
        .and_then(|d| read_json(&d.join("opencode").join("auth.json")))
        .and_then(|v| v.as_object().cloned())
        .filter(|m| !m.is_empty())
    else {
        return (None, None);
    };
    let providers = auth.keys().cloned().collect::<Vec<_>>().join(" · ");
    (
        Some(true),
        CliAccountInfo {
            name: Some(providers),
            ..Default::default()
        }
        .known(),
    )
}

/// `cursor-agent status` names the account: "Logged in as ada@example.com".
fn cursor_account(status_text: &str) -> Option<CliAccountInfo> {
    let rest = status_text.split("logged in as ").nth(1)?;
    let who = rest
        .split_whitespace()
        .next()?
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '@' && c != '.');
    CliAccountInfo {
        email: who.contains('@').then(|| who.to_string()),
        name: (!who.contains('@') && !who.is_empty()).then(|| who.to_string()),
        plan: None,
    }
    .known()
}

/// Antigravity lists the account's models only once signed in: without a session it prints
/// nothing at all (its log says "You are not logged into Antigravity").
fn antigravity_logged_in(bin: &Path) -> Option<bool> {
    run_capture(bin, &["models"], PROBE_TIMEOUT)
        .ok()
        .map(|out| !out.trim().is_empty())
}

/// Grok's model list starts by saying who is signed in ("You are logged in with grok.com.").
fn grok_logged_in(bin: &Path) -> Option<bool> {
    let out = sign_in_text(bin, &["models"]);
    grok_login_state(&out)
}

fn grok_login_state(out: &str) -> Option<bool> {
    if out.contains("not logged in") || out.contains("not signed in") || out.contains("grok login")
    {
        Some(false)
    } else if out.contains("logged in") || out.contains("signed in") {
        Some(true)
    } else {
        None
    }
}

/// `cursor-agent status` says whether it's signed in ("Logged in as …" or "Not logged in"),
/// and as whom.
fn cursor_sign_in(bin: &Path) -> (Option<bool>, Option<CliAccountInfo>) {
    let out = sign_in_text(bin, &["status"]);
    (cursor_login_state(&out), cursor_account(&out))
}

/// `codex login status` says "Logged in using ChatGPT" (or an API key), or "Not logged in".
fn codex_logged_in(bin: &Path) -> Option<bool> {
    let out = sign_in_text(bin, &["login", "status"]);
    cursor_login_state(&out)
}

fn cursor_login_state(out: &str) -> Option<bool> {
    if out.contains("not logged in")
        || out.contains("not authenticated")
        || out.contains("logged out")
        || out.contains("agent login")
    {
        Some(false)
    } else if out.contains("logged in") || out.contains("authenticated") {
        Some(true)
    } else {
        None
    }
}

/// The version number alone: Grok prints "grok 1.0.70 (f50904eaee6c) [stable]".
fn version_of(out: &str) -> Option<String> {
    let line = out.lines().map(str::trim).find(|l| !l.is_empty())?;
    let number = line.split_whitespace().find(|w| {
        w.trim_start_matches('v')
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit())
            && w.contains('.')
    });
    Some(
        number
            .map(|w| w.trim_start_matches('v').to_string())
            .unwrap_or_else(|| line.to_string()),
    )
}

/// Antigravity's own updater is off in the processes Nyxs starts (see base_command), so Nyxs
/// runs `agy update` now and then, at most every 6 hours, in the background and with no window:
/// it updates in place, on Windows its helpers share its hidden console, and on macOS and
/// Linux it runs in its own process group with no terminal (base_command).
fn keep_antigravity_updated(bin: &Path) {
    const ANTIGRAVITY_UPDATE_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
    const ANTIGRAVITY_UPDATE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    if !update_due(&LAST, ANTIGRAVITY_UPDATE_EVERY) {
        return;
    }
    let bin = bin.to_path_buf();
    std::thread::spawn(move || {
        let _ = run_capture(&bin, &["update"], ANTIGRAVITY_UPDATE_TIMEOUT);
    });
}

/// Whether `every` has passed since the last time this said yes (and it says yes the first time).
fn update_due(last: &Mutex<Option<Instant>>, every: Duration) -> bool {
    let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
    if last.is_some_and(|at| at.elapsed() < every) {
        return false;
    }
    *last = Some(Instant::now());
    true
}

/// Whether the CLI is installed, where, its version, and whether it's signed in where that
/// can be told.
#[tauri::command]
pub async fn agent_cli_status(cli: String) -> Result<AgentCliStatus, String> {
    let cli = Cli::parse(&cli)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(bin) = cli.locate() else {
            return AgentCliStatus {
                installed: false,
                path: None,
                version: None,
                logged_in: None,
                account: None,
            };
        };
        if cli == Cli::Antigravity {
            keep_antigravity_updated(&bin);
        }
        let version = run_capture(&bin, &["--version"], PROBE_TIMEOUT)
            .ok()
            .and_then(|out| version_of(&out));
        let (logged_in, account) = match cli {
            Cli::Antigravity => (antigravity_logged_in(&bin), antigravity_account()),
            Cli::Grok => (grok_logged_in(&bin), grok_account()),
            Cli::Cursor => cursor_sign_in(&bin),
            Cli::Codex => (codex_logged_in(&bin), codex_account()),
            // It has no session: it runs on the API key Nyxs passes it.
            Cli::DeepSeek => (None, None),
            Cli::Devin => (Some(devin_signed_in()), None),
            Cli::OpenCode => opencode_sign_in(),
        };
        AgentCliStatus {
            installed: true,
            path: Some(bin.to_string_lossy().into_owned()),
            version,
            logged_in,
            // A signed-out CLI's files may still name the account it had.
            account: account.filter(|_| logged_in != Some(false)),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// An agent CLI's name ("grok" → "Grok CLI"), for the installer's messages.
pub(super) fn agent_cli_label(name: &str) -> Option<&'static str> {
    Cli::parse(name).ok().map(Cli::label)
}

/// Where an agent CLI is installed ("grok", "codex"…), for the account sign-ins.
pub(super) fn locate_agent_cli(name: &str) -> Option<PathBuf> {
    Cli::parse(name).ok()?.locate()
}

/// What `<cli> models` prints, for the page to read the model list from.
#[tauri::command]
pub async fn agent_cli_models(cli: String) -> Result<String, String> {
    let cli = Cli::parse(&cli)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bin = cli
            .locate()
            .ok_or_else(|| CmdError::cli_not_installed(cli.label()))?;
        if cli == Cli::Antigravity {
            keep_antigravity_updated(&bin);
        }
        run_capture(&bin, cli.models_args(), PROBE_TIMEOUT)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What Grok CLI's own `/usage` reads: the billing period and the share of it used.
const GROK_USAGE_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

/// The account's plan limits as JSON, where they can be read without a model call:
/// Antigravity answers its `/usage` command in print mode at once, without a conversation;
/// Grok's billing is asked with the CLI's own sign-in, as its `/usage` does.
#[tauri::command]
pub async fn agent_cli_usage(cli: String) -> Result<String, String> {
    let cli = Cli::parse(&cli)?;
    tauri::async_runtime::spawn_blocking(move || match cli {
        Cli::Antigravity => {
            let bin = cli
                .locate()
                .ok_or_else(|| CmdError::cli_not_installed(cli.label()))?;
            run_capture(
                &bin,
                &["-p", "/usage", "--output-format", "json"],
                PROBE_TIMEOUT,
            )
        }
        Cli::Grok => grok_usage(),
        _ => Err(format!("{} doesn't report plan limits", cli.label())),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn grok_usage() -> Result<String, String> {
    let key = grok_auth_entry()
        .and_then(|e| json_str(&e, "key"))
        .ok_or("Grok CLI isn't signed in")?;
    let client = reqwest::blocking::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(GROK_USAGE_URL)
        .bearer_auth(key)
        .header("X-XAI-Token-Auth", "xai-grok-cli")
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Grok usage request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Grok usage answered {}", resp.status()));
    }
    resp.text().map_err(|e| e.to_string())
}

/// Adds (or, with `remove`, takes out) an MCP server of Nyxs' in the CLI's own config. Only
/// Antigravity needs it: it takes MCP servers from its config alone, while Grok gets them per
/// session. The entry runs Nyxs' executable as a stdio proxy (`mcp_proxy_main`) rather than
/// naming the bridge's address, as that config is global: each run is told in its environment
/// which Nyxs and chat it belongs to. `agy mcp add` updates an entry of the same name.
#[tauri::command]
pub async fn agent_cli_register_mcp(cli: String, name: String, remove: bool) -> Result<(), String> {
    let cli = Cli::parse(&cli)?;
    if cli != Cli::Antigravity {
        return Err(format!(
            "{} gets its MCP servers with each session",
            cli.label()
        ));
    }
    let valid_name = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid_name {
        return Err(format!("Invalid server name: {name}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bin = cli
            .locate()
            .ok_or_else(|| CmdError::cli_not_installed(cli.label()))?;
        if remove {
            // Not there (never added, or removed by hand) is fine.
            let _ = run_capture(&bin, &["mcp", "remove", &name], PROBE_TIMEOUT);
            return Ok(());
        }
        let (exe, args) = mcp_proxy_command(&name).ok_or("Couldn't find Nyxs' executable")?;
        let exe = exe.to_string_lossy().into_owned();
        // Checked on every turn: another Nyxs (an installed one next to a dev build) may have
        // pointed the same global entry at its own executable since. Either one would do, but
        // a dev build's may be mid-rebuild.
        if antigravity_mcp_runs(&name, &exe, &args) {
            return Ok(());
        }
        // `--` because the proxy's own flag starts with a dash.
        let mut add = vec!["mcp", "add", "--type", "stdio", &name, "--", &exe];
        add.extend(args.iter().map(String::as_str));
        run_capture(&bin, &add, PROBE_TIMEOUT).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether Antigravity's MCP config (`~/.gemini/config/mcp_config.json`, written by `agy mcp`)
/// already has `name` enabled, running `exe` with `args`. Anything unreadable counts as no.
fn antigravity_mcp_runs(name: &str, exe: &str, args: &[String]) -> bool {
    let Ok(home) = home_dir() else { return false };
    let Ok(text) =
        std::fs::read_to_string(home.join(".gemini").join("config").join("mcp_config.json"))
    else {
        return false;
    };
    mcp_config_runs(&text, name, exe, args)
}

fn mcp_config_runs(config: &str, name: &str, exe: &str, args: &[String]) -> bool {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(config) else {
        return false;
    };
    let entry = &json["mcpServers"][name];
    let same_exe = entry["command"].as_str().is_some_and(|c| {
        if cfg!(windows) {
            c.eq_ignore_ascii_case(exe)
        } else {
            c == exe
        }
    });
    let same_args = entry["args"].as_array().is_some_and(|a| {
        a.len() == args.len() && a.iter().zip(args).all(|(x, y)| x.as_str() == Some(y))
    });
    // An entry from before the proxy (an address at the bridge) is replaced.
    same_exe
        && same_args
        && entry.get("serverUrl").is_none()
        && entry.get("url").is_none()
        && entry["disabled"].as_bool() != Some(true)
}

/// The user's own `permissions` in Antigravity's settings
/// (`~/.gemini/antigravity-cli/settings.json`). `agy --settings` replaces that key for the run
/// (seen with 1.4.x: a rule of the user's stopped applying), so a turn of Nyxs sends them along
/// with its own rules. None when there are none or the file can't be read.
#[tauri::command(async)]
pub fn agent_cli_antigravity_permissions() -> Option<serde_json::Value> {
    let home = home_dir().ok()?;
    let path = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("settings.json");
    permissions_of(&std::fs::read_to_string(path).ok()?)
}

fn permissions_of(settings: &str) -> Option<serde_json::Value> {
    let json = serde_json::from_str::<serde_json::Value>(settings).ok()?;
    json.get("permissions").filter(|p| p.is_object()).cloned()
}

/// Opens a terminal that installs the CLI or signs in to it.
#[tauri::command(async)]
pub fn agent_cli_open_terminal(cli: String, action: String) -> Result<(), CmdError> {
    let cli = Cli::parse(&cli)?;
    let script = match action.as_str() {
        "login" => {
            let bin = cli
                .locate()
                .ok_or_else(|| CmdError::cli_not_installed(cli.label()))?;
            #[cfg(target_os = "windows")]
            let quoted = format!("& '{}'", bin.to_string_lossy().replace('\'', "''"));
            #[cfg(not(target_os = "windows"))]
            let quoted = format!("'{}'", bin.to_string_lossy().replace('\'', "'\\''"));
            format!("{quoted} {}", cli.login_args())
                .trim_end()
                .to_string()
        }
        _ => return Err(format!("Unknown action: {action}").into()),
    };
    open_terminal(&script)
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentCliEvent {
    Stdout { line: String },
    Stderr { line: String },
    Exit { code: Option<i32> },
}

struct AgentCliRun {
    /// Lines for the CLI's stdin, written by the run's own thread so a CLI that is slow to
    /// read never blocks the app's main thread.
    input: Option<std::sync::mpsc::Sender<Vec<u8>>>,
    child: Arc<Mutex<CliChild>>,
    /// Where its output goes: the page's channel, none while the page reloads.
    channel: Arc<Mutex<Option<Channel<AgentCliEvent>>>>,
    /// Kept between turns (an ACP agent the chat goes on prompting), so a reload detaches it
    /// rather than killing it.
    keep_alive: bool,
}

/// How long a kept-alive run waits for a reloaded page to pick it up before it's stopped.
const DETACHED_KEEP: Duration = Duration::from_secs(20 * 60);

fn send_event(channel: &Mutex<Option<Channel<AgentCliEvent>>>, event: AgentCliEvent) {
    if let Some(c) = channel.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        let _ = c.send(event);
    }
}

static RUNS: OnceLock<Mutex<HashMap<String, AgentCliRun>>> = OnceLock::new();

fn runs() -> &'static Mutex<HashMap<String, AgentCliRun>> {
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliRunRequest {
    run_id: String,
    cli: String,
    /// The CLI's arguments, each one as is: no shell sits in between.
    args: Vec<String>,
    cwd: Option<String>,
    /// Extra environment for this run (DeepSeek Harness's `DEEPSEEK_API_KEY`).
    #[serde(default)]
    env: HashMap<String, String>,
    /// The page keeps the process between turns (see `AgentCliRun::keep_alive`).
    #[serde(default)]
    keep_alive: bool,
}

/// Only plain variable names, and a handful of them.
fn run_env(env: &HashMap<String, String>) -> Result<Vec<(&String, &String)>, String> {
    if env.len() > 8 {
        return Err("Too many environment variables".into());
    }
    env.iter()
        .map(|(k, v)| {
            let valid = !k.is_empty()
                && k.len() <= 64
                && k.chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
            if valid {
                Ok((k, v))
            } else {
                Err(format!("Invalid environment variable: {k}"))
            }
        })
        .collect()
}

/// Starts the CLI and returns the folder it works in (the protocol needs it as an absolute path).
#[tauri::command]
pub async fn agent_cli_start(
    request: AgentCliRunRequest,
    on_event: Channel<AgentCliEvent>,
) -> Result<String, CmdError> {
    tauri::async_runtime::spawn_blocking(move || start_run(request, on_event))
        .await
        .map_err(|e| e.to_string())?
}

fn start_run(
    request: AgentCliRunRequest,
    on_event: Channel<AgentCliEvent>,
) -> Result<String, CmdError> {
    let cli = Cli::parse(&request.cli)?;
    let env: HashMap<String, String> = run_env(&request.env)?
        .into_iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    type Pipe = Box<dyn Read + Send>;
    let (child, input, stdout, stderr, cwd): (CliChild, _, Pipe, Pipe, String) =
        if let Some(r) = request.cwd.as_deref().and_then(crate::remote::parse) {
            // A remote project: the CLI runs on its machine (installed and signed in there),
            // found by its plain name on that machine's PATH.
            let program = cli.binary_names()[0]
                .trim_end_matches(".exe")
                .trim_end_matches(".cmd");
            let mut child = spawn_remote_cli(&r, program, &request.args, &env)
                .map_err(|e| CmdError::cli_start_failed(cli.label(), e))?;
            let input = child.stdin.take().map(spawn_stdin_writer);
            let stdout = child.stdout.take().ok_or("No stdout")?;
            let stderr = child.stderr.take().ok_or("No stderr")?;
            (
                CliChild::Remote(child.handle()),
                input,
                Box::new(stdout),
                Box::new(stderr),
                r.uri(),
            )
        } else {
            let bin = cli
                .locate()
                .ok_or_else(|| CmdError::cli_not_connected(cli.label()))?;
            let cwd = run_cwd(request.cwd.as_deref(), cli.id())?;
            let mut cmd = base_command(&bin);
            cmd.envs(&env);
            cmd.args(&request.args)
                .current_dir(&cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut child =
                spawn_tied(&mut cmd).map_err(|e| CmdError::cli_start_failed(cli.label(), e))?;
            let input = child.stdin.take().map(spawn_stdin_writer);
            let stdout = child.stdout.take().ok_or("No stdout")?;
            let stderr = child.stderr.take().ok_or("No stderr")?;
            (
                CliChild::Local(child),
                input,
                Box::new(stdout),
                Box::new(stderr),
                cwd.to_string_lossy().into_owned(),
            )
        };
    let child = Arc::new(Mutex::new(child));
    let run_id = request.run_id.clone();
    let channel = Arc::new(Mutex::new(Some(on_event)));
    runs().lock().unwrap_or_else(|e| e.into_inner()).insert(
        run_id.clone(),
        AgentCliRun {
            input,
            child: child.clone(),
            channel: channel.clone(),
            keep_alive: request.keep_alive,
        },
    );

    let out_channel = channel.clone();
    let out_reader = spawn_line_reader(stdout, move |line| {
        send_event(&out_channel, AgentCliEvent::Stdout { line });
    });
    let err_channel = channel.clone();
    let err_reader = spawn_line_reader(stderr, move |line| {
        send_event(&err_channel, AgentCliEvent::Stderr { line });
    });

    spawn_exit_waiter(child, [out_reader, err_reader], move |code| {
        send_event(&channel, AgentCliEvent::Exit { code });
        runs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&run_id);
    });
    Ok(cwd)
}

/// The kept-alive runs still going, for a page that just reloaded.
#[tauri::command]
pub fn agent_cli_runs() -> Vec<String> {
    runs()
        .lock()
        .map(|runs| {
            runs.iter()
                .filter(|(_, r)| r.keep_alive)
                .map(|(id, _)| id.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Sends a kept-alive run's output to this page from now on (after a reload).
#[tauri::command]
pub fn agent_cli_attach(run_id: String, on_event: Channel<AgentCliEvent>) -> Result<(), CmdError> {
    let runs = runs().lock().unwrap_or_else(|e| e.into_inner());
    let run = runs
        .get(&run_id)
        .filter(|r| r.keep_alive)
        .ok_or_else(|| CmdError::cli_session_ended("CLI"))?;
    *run.channel.lock().unwrap_or_else(|e| e.into_inner()) = Some(on_event);
    Ok(())
}

#[tauri::command]
pub fn agent_cli_send(run_id: String, line: String) -> Result<(), CmdError> {
    let runs = runs().lock().unwrap_or_else(|e| e.into_inner());
    let run = runs
        .get(&run_id)
        .ok_or_else(|| CmdError::cli_session_ended("CLI"))?;
    let input = run
        .input
        .as_ref()
        .ok_or_else(|| CmdError::cli_input_closed("CLI"))?;
    let mut payload = line.into_bytes();
    if payload.last() != Some(&b'\n') {
        payload.push(b'\n');
    }
    input
        .send(payload)
        .map_err(|_| CmdError::cli_input_closed("CLI"))
}

#[tauri::command]
pub fn agent_cli_close_input(run_id: String) {
    if let Some(run) = runs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(&run_id)
    {
        run.input = None;
    }
}

/// Kills a run's process tree in the background: `taskkill` takes its time, and this command
/// runs on the app's main thread.
#[tauri::command]
pub fn agent_cli_kill(run_id: String) -> bool {
    let child = runs()
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

/// The page is reloading. A run in the middle of a turn belongs to that turn, which the reloaded
/// page starts again, so it's stopped. A kept-alive one only loses its channel until the page
/// attaches it again (`agent_cli_attach`); one nobody picks up is stopped after `DETACHED_KEEP`.
pub fn agent_cli_detach_all() {
    let (kill, kept): (Vec<_>, Vec<_>) = runs()
        .lock()
        .map(|mut runs| {
            let mut kill = Vec::new();
            let mut kept = Vec::new();
            for (id, r) in runs.iter_mut() {
                if r.keep_alive {
                    *r.channel.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    kept.push(id.clone());
                } else {
                    r.input = None;
                    kill.push(r.child.clone());
                }
            }
            (kill, kept)
        })
        .unwrap_or_default();
    for child in kill {
        if let Ok(mut c) = child.lock() {
            c.kill_tree();
        }
    }
    if kept.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(DETACHED_KEEP);
        for id in still_detached(&kept) {
            agent_cli_kill(id);
        }
    });
}

/// Which of these runs no page has attached since.
fn still_detached(ids: &[String]) -> Vec<String> {
    let runs = runs().lock().unwrap_or_else(|e| e.into_inner());
    ids.iter()
        .filter(|id| {
            runs.get(*id).is_some_and(|r| {
                r.channel
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .is_none()
            })
        })
        .cloned()
        .collect()
}

/// The app is closing: no CLI is left running behind it.
pub fn agent_cli_shutdown_all() {
    let children: Vec<Arc<Mutex<CliChild>>> = runs()
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
    for child in children {
        if let Ok(mut c) = child.lock() {
            c.kill_tree();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_probe_returns_once_the_cli_exits_though_a_grandchild_keeps_its_pipes() {
        let (bin, args) = super::super::cli_process::exits_leaving_a_grandchild();
        let started = Instant::now();
        let (ok, out, _) = run_streams(&bin, &args, PROBE_TIMEOUT).unwrap();
        assert!(
            started.elapsed() < super::super::cli_process::GRANDCHILD_LIMIT,
            "waited for the grandchild"
        );
        assert!(ok);
        assert!(out.contains("hi"));
    }

    #[test]
    fn reads_who_signed_in_from_antigravity_s_log() {
        let log = "I1026 10:27:40.826635 1 server_oauth.go:224] applyAuthResult: email=a@b.com, authMethod=consumer\n\
                   I1026 10:27:40.827155 1 server_oauth.go:229] OAuth: authenticated successfully as ada@example.com\n\
                   I1026 10:27:41.518697 231 quota_manager.go:45] doRefreshQuota: starting reload";
        assert_eq!(signed_in_email(log).as_deref(), Some("ada@example.com"));
        assert_eq!(
            signed_in_email("doRefreshQuota: skipped (not logged in)"),
            None
        );
    }

    #[test]
    fn sees_devin_s_saved_key() {
        assert!(devin_has_key(
            "api_server_url = \"https://server.codeium.com\"\nwindsurf_api_key = \"sk-1\"\n"
        ));
        assert!(devin_has_key("devin_api_key='k'"));
        assert!(!devin_has_key("windsurf_api_key = \"\"\n"));
        assert!(!devin_has_key("api_server_url = \"x\""));
    }

    #[test]
    fn names_plans_and_cursor_accounts() {
        assert_eq!(
            plan_words("SUBSCRIPTION_TIER_SUPER_GROK_HEAVY").as_deref(),
            Some("SuperGrok Heavy")
        );
        assert_eq!(plan_words("plus").as_deref(), Some("Plus"));
        assert_eq!(plan_words("SUBSCRIPTION_TIER_FREE"), None);
        let account = cursor_account("\n✓ logged in as ada@example.com\n").unwrap();
        assert_eq!(account.email.as_deref(), Some("ada@example.com"));
        assert_eq!(cursor_account("not logged in"), None);
    }

    #[test]
    fn reads_the_user_s_antigravity_permissions() {
        let settings = r#"{"trustedWorkspaces":["C:\\w"],"permissions":{"allow":["mcp(probe/*)"],"deny":["run_command(rm)"]}}"#;
        assert_eq!(
            permissions_of(settings),
            Some(serde_json::json!({"allow":["mcp(probe/*)"],"deny":["run_command(rm)"]}))
        );
        assert_eq!(permissions_of(r#"{"trustedWorkspaces":[]}"#), None);
        assert_eq!(permissions_of(r#"{"permissions":["x"]}"#), None);
        assert_eq!(permissions_of("not json"), None);
    }

    #[test]
    fn updates_antigravity_at_most_once_per_interval() {
        let last = Mutex::new(None);
        assert!(update_due(&last, Duration::from_secs(3600)));
        assert!(!update_due(&last, Duration::from_secs(3600)));
        *last.lock().unwrap() = Instant::now().checked_sub(Duration::from_secs(3601));
        assert!(update_due(&last, Duration::from_secs(3600)));
    }

    #[test]
    fn sees_whether_the_antigravity_entry_runs_this_nyxs() {
        // As `agy mcp add --type stdio` writes it.
        let config = r#"{"mcpServers":{"nyxs-browser":{"args":["--nyxs-mcp-proxy","nyxs-browser"],"command":"C:\\Nyxs\\app.exe","disabled":false}}}"#;
        let args = mcp_proxy_args("nyxs-browser");
        assert!(mcp_config_runs(
            config,
            "nyxs-browser",
            r"C:\Nyxs\app.exe",
            &args
        ));
        // Another Nyxs took the entry.
        assert!(!mcp_config_runs(
            config,
            "nyxs-browser",
            r"D:\dev\app.exe",
            &args
        ));
        assert!(!mcp_config_runs(
            config,
            "nyxs-browser",
            r"C:\Nyxs\app.exe",
            &mcp_proxy_args("nyxs-chat")
        ));
        assert!(!mcp_config_runs(
            &config.replace("false", "true"),
            "nyxs-browser",
            r"C:\Nyxs\app.exe",
            &args
        ));
        // The address an older Nyxs saved is replaced.
        let old = r#"{"mcpServers":{"nyxs-browser":{"disabled":false,"headers":{"Authorization":"Bearer abc"},"serverUrl":"http://127.0.0.1:47823/mcp/nyxs-browser"}}}"#;
        assert!(!mcp_config_runs(
            old,
            "nyxs-browser",
            r"C:\Nyxs\app.exe",
            &args
        ));
        assert!(!mcp_config_runs(
            "{}",
            "nyxs-browser",
            r"C:\Nyxs\app.exe",
            &args
        ));
        assert!(!mcp_config_runs(
            "not json",
            "nyxs-browser",
            r"C:\Nyxs\app.exe",
            &args
        ));
    }

    #[test]
    fn knows_only_the_supported_clis() {
        assert!(Cli::parse("grok").is_ok());
        assert!(Cli::parse("antigravity").is_ok());
        assert!(Cli::parse("claude").is_err());
    }

    #[test]
    fn reads_grok_sign_in_from_its_model_list() {
        let signed_in = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n";
        assert_eq!(
            grok_login_state(&signed_in.to_ascii_lowercase()),
            Some(true)
        );
        assert_eq!(
            grok_login_state("you are not logged in. run `grok login` to sign in."),
            Some(false)
        );
        assert_eq!(grok_login_state("available models:\n  * grok-4.7"), None);
    }

    #[test]
    fn reads_cursor_sign_in_from_its_status() {
        assert_eq!(
            cursor_login_state("✓ logged in as someone@example.com"),
            Some(true)
        );
        assert_eq!(
            cursor_login_state("not logged in. run `cursor-agent login` to sign in."),
            Some(false)
        );
        assert_eq!(cursor_login_state(""), None);
        // `codex login status`, which prints it on stderr.
        assert_eq!(
            cursor_login_state("\nlogged in using chatgpt\n"),
            Some(true)
        );
        assert_eq!(cursor_login_state("not logged in\n"), Some(false));
    }

    #[test]
    fn takes_only_plain_environment_names() {
        let ok: HashMap<String, String> =
            [("DEEPSEEK_API_KEY".to_string(), "sk".to_string())].into();
        assert!(run_env(&ok).is_ok());
        let bad: HashMap<String, String> = [("PATH;x".to_string(), "".to_string())].into();
        assert!(run_env(&bad).is_err());
    }

    #[test]
    fn keeps_only_the_version_number() {
        assert_eq!(
            version_of("grok 1.0.70 (f50904eaee6c) [stable]\n").as_deref(),
            Some("1.0.70")
        );
        assert_eq!(version_of("1.4.7\n").as_deref(), Some("1.4.7"));
        assert_eq!(version_of("v2.0.1").as_deref(), Some("2.0.1"));
    }

    #[test]
    fn looks_where_the_official_installers_put_the_binary() {
        let grok = Cli::Grok.known_dirs();
        assert!(grok
            .iter()
            .any(|d| d.ends_with(Path::new(".grok").join("bin"))));
        #[cfg(target_os = "windows")]
        assert!(Cli::Antigravity
            .known_dirs()
            .iter()
            .any(|d| d.ends_with(Path::new("agy").join("bin"))));
        #[cfg(not(target_os = "windows"))]
        assert!(Cli::Antigravity
            .known_dirs()
            .iter()
            .any(|d| d.ends_with(Path::new(".local").join("bin"))));
    }
}
