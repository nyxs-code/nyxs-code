//! Claude Code on a remote machine, set up without the user touching that machine's shell: finding
//! it there, installing or updating it with its own installer, and signing in from this PC.
//!
//! Signing in keeps the browser on this PC. `claude auth login` prints a link that ends in a page
//! with a code to paste, and also opens one that redirects to its own `localhost` port. `BROWSER`
//! hands that second link to Nyxs, and a tunnel makes the port reach the machine, so finishing in
//! the browser is enough. The code is what's left when the tunnel can't keep the port's number
//! (the redirect has to land on that exact port) or the machine is Windows.

use crate::agent::cli_process::{quote, REMOTE_CLI_PATH_POSIX, REMOTE_CLI_PATH_PS};
use crate::agent::*;
use crate::remote::procs::{self, Exec, RemoteHandle, RemoteStdin, Spawn};
use crate::remote::tunnel;

const STATUS_TIMEOUT_MS: u64 = 45_000;
const INSTALL_TIMEOUT_MS: u64 = 600_000;
const LINK_TIMEOUT: Duration = Duration::from_secs(30);
/// The link the tunnel needs comes a moment after the one printed for pasting a code.
const AUTOMATIC_LINK_GRACE: Duration = Duration::from_secs(3);
/// Longer than anyone takes to sign in; the process would otherwise wait forever.
const LOGIN_PATIENCE: Duration = Duration::from_secs(15 * 60);

const NOT_INSTALLED: &str = "NYXS_NO_CLAUDE";
const AUTOMATIC_LINK: &str = "NYXS_LOGIN_URL ";
const EXIT_DOWNLOAD_FAILED: i32 = 90;
const EXIT_NO_DOWNLOADER: i32 = 91;

const STATUS_POSIX: &str = r#"command -v claude >/dev/null 2>&1 || { echo NYXS_NO_CLAUDE; exit 0; }
claude --version
claude auth status --json
exit 0"#;
const STATUS_PS: &str = "if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { 'NYXS_NO_CLAUDE'; exit 0 }\nclaude --version\nclaude auth status --json\nexit 0";

const INSTALL_POSIX: &str = r#"f=$(mktemp) || exit 1
if command -v curl >/dev/null 2>&1; then curl -fsSL https://claude.ai/install.sh -o "$f"
elif command -v wget >/dev/null 2>&1; then wget -qO "$f" https://claude.ai/install.sh
else rm -f "$f"; exit 91; fi
if [ $? -ne 0 ]; then rm -f "$f"; exit 90; fi
bash "$f" </dev/null
c=$?
rm -f "$f"
exit $c"#;
const INSTALL_PS: &str = "try { $s = Invoke-RestMethod https://claude.ai/install.ps1 } catch { exit 90 }\nInvoke-Expression $s";

/// A throwaway `BROWSER` that saves the link it is given; the loop passes it on to stdout, since
/// whatever `claude` starts as a browser doesn't print to the pipe Nyxs reads.
const LOGIN_POSIX: &str = r#"d=$(mktemp -d) || exit 1
trap 'rm -rf "$d"' EXIT
printf '#!/bin/sh\nprintf "%%s\\n" "$1" > "$0.url"\n' > "$d/open"
chmod +x "$d/open"
( i=0
  while [ $i -lt 100 ]; do
    if [ -s "$d/open.url" ]; then printf 'NYXS_LOGIN_URL %s\n' "$(cat "$d/open.url")"; break; fi
    sleep 0.2
    i=$((i + 1))
  done ) &
w=$!
BROWSER="$d/open" claude auth login
c=$?
kill "$w" 2>/dev/null
exit $c"#;

/// What runs `script` on the machine. Through `sh`, whatever the user's login shell is.
fn on_machine(script: &str, ps: bool) -> String {
    if ps {
        format!("{REMOTE_CLI_PATH_PS}\n{script}")
    } else {
        let full = format!("{REMOTE_CLI_PATH_POSIX}\n{script}");
        format!("exec sh -c {}", quote(&full, false))
    }
}

fn is_windows(host: &str) -> Result<bool, String> {
    Ok(crate::remote::info(host).map_err(String::from)?.os == "windows")
}

fn run(host: &str, script: &str, ps: bool, timeout_ms: u64) -> Result<procs::ExecResult, String> {
    let command = on_machine(script, ps);
    procs::exec(
        host,
        Exec {
            command: Some(&command),
            argv: None,
            cwd: None,
            env: None,
            timeout_ms: Some(timeout_ms),
            run_id: None,
        },
    )
    .map_err(String::from)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteClaudeStatus {
    installed: bool,
    version: Option<String>,
    /// `None` when the CLI couldn't say: the turn goes ahead and reports what it finds.
    logged_in: Option<bool>,
}

/// Reads the status script's output. A login shell's profile can print anything around it.
fn parse_status(stdout: &str) -> RemoteClaudeStatus {
    if stdout.lines().any(|l| l.trim() == NOT_INSTALLED) {
        return RemoteClaudeStatus {
            installed: false,
            version: None,
            logged_in: None,
        };
    }
    let version = stdout.lines().find_map(|l| {
        let first = l.split_whitespace().next()?;
        let numeric = first.split('.').count() >= 3
            && first
                .split('.')
                .all(|p| p.chars().all(|c| c.is_ascii_digit()));
        numeric.then(|| first.to_string())
    });
    let logged_in = stdout
        .find('{')
        .and_then(|at| {
            serde_json::from_str::<serde_json::Value>(
                stdout[at..].trim_end_matches(|c: char| c != '}'),
            )
            .ok()
        })
        .and_then(|v| v.get("loggedIn").and_then(serde_json::Value::as_bool));
    RemoteClaudeStatus {
        installed: true,
        version,
        logged_in,
    }
}

#[tauri::command]
pub async fn claude_code_remote_status(host: String) -> Result<RemoteClaudeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ps = is_windows(&host)?;
        let script = if ps { STATUS_PS } else { STATUS_POSIX };
        Ok(parse_status(
            &run(&host, script, ps, STATUS_TIMEOUT_MS)?.stdout,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteClaudeOutcome {
    ok: bool,
    /// Why it failed, for the message the interface picks: `download`, `noDownloader` or `other`.
    reason: Option<&'static str>,
    detail: String,
}

/// The last lines of what a failed command printed: the part that says what went wrong.
fn output_tail(stdout: &str, stderr: &str) -> String {
    let text = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    lines[lines.len().saturating_sub(3)..].join("\n")
}

fn outcome_of(res: &procs::ExecResult) -> RemoteClaudeOutcome {
    let ok = res.code == Some(0) && !res.timed_out;
    RemoteClaudeOutcome {
        ok,
        reason: (!ok).then_some(match res.code {
            Some(EXIT_DOWNLOAD_FAILED) => "download",
            Some(EXIT_NO_DOWNLOADER) => "noDownloader",
            _ => "other",
        }),
        detail: if ok {
            String::new()
        } else if res.timed_out {
            "Timed out.".to_string()
        } else {
            output_tail(&res.stdout, &res.stderr)
        },
    }
}

#[tauri::command]
pub async fn claude_code_remote_install(host: String) -> Result<RemoteClaudeOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ps = is_windows(&host)?;
        let script = if ps { INSTALL_PS } else { INSTALL_POSIX };
        Ok(outcome_of(&run(&host, script, ps, INSTALL_TIMEOUT_MS)?))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_code_remote_update(host: String) -> Result<RemoteClaudeOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ps = is_windows(&host)?;
        Ok(outcome_of(&run(
            &host,
            "claude update",
            ps,
            INSTALL_TIMEOUT_MS,
        )?))
    })
    .await
    .map_err(|e| e.to_string())?
}

struct Login {
    handle: RemoteHandle,
    stdin: Mutex<Option<RemoteStdin>>,
    readers: Mutex<Vec<std::thread::JoinHandle<()>>>,
    output: Arc<Mutex<String>>,
    /// The machine's port behind the tunnel the browser comes back through.
    tunneled_port: Option<u16>,
}

static LOGINS: OnceLock<Mutex<HashMap<String, Arc<Login>>>> = OnceLock::new();

fn logins() -> &'static Mutex<HashMap<String, Arc<Login>>> {
    LOGINS.get_or_init(Default::default)
}

fn close_login(host: &str, login: &Login) {
    login.handle.kill();
    if let Some(port) = login.tunneled_port {
        tunnel::close(host, port);
    }
}

fn collect<R: Read + Send + 'static>(
    mut pipe: R,
    output: Arc<Mutex<String>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = pipe.read(&mut buf) {
            if n == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&buf[..n]);
            output
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push_str(&text);
        }
    })
}

/// Only Anthropic's own sign-in pages are opened: this link comes from another machine, and the
/// user's browser is about to go there on Nyxs' word.
fn is_sign_in_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split('/').next().unwrap_or("");
    let clean = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    clean
        && ["claude.com", "claude.ai", "anthropic.com"]
            .iter()
            .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// The links in what `claude auth login` printed so far: (the one with its `localhost` redirect,
/// the one that ends in a code to paste).
fn login_links(output: &str) -> (Option<String>, Option<String>) {
    let mut automatic = None;
    let mut manual = None;
    for line in output.lines() {
        // Not at the line's start: it usually lands after the prompt, which ends without a newline.
        if let Some((_, url)) = line.split_once(AUTOMATIC_LINK) {
            automatic = Some(url.trim().to_string());
        } else if let Some((_, url)) = line.split_once("visit: ") {
            manual = Some(url.trim().to_string());
        }
    }
    (
        automatic.filter(|u| is_sign_in_url(u)),
        manual.filter(|u| is_sign_in_url(u)),
    )
}

/// The port of a link's `redirect_uri=http://localhost:<port>/...`.
fn callback_port(url: &str) -> Option<u16> {
    const REDIRECT: &str = "redirect_uri=http%3A%2F%2Flocalhost%3A";
    let at = url.find(REDIRECT)? + REDIRECT.len();
    let digits: String = url[at..].chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// What a login that failed said, without the prompt it printed on the same line.
fn login_failure(output: &str) -> String {
    output
        .lines()
        .rev()
        .map(|l| l.rsplit_once("> ").map_or(l, |(_, after)| after).trim())
        .find(|l| !l.is_empty() && !l.starts_with(AUTOMATIC_LINK.trim()) && !l.contains("https://"))
        .unwrap_or("")
        .trim_start_matches("Login failed: ")
        .to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLoginLinks {
    /// What to open now.
    url: String,
    /// Ends in a code to paste, also when `url` doesn't.
    manual_url: String,
    /// Coming back from the browser is enough; no code is asked for.
    automatic: bool,
}

fn start_login(host: &str) -> Result<RemoteLoginLinks, String> {
    cancel_login(host);
    let ps = is_windows(host)?;
    let command = on_machine(if ps { "claude auth login" } else { LOGIN_POSIX }, ps);
    let mut child = procs::spawn(
        host,
        Spawn {
            command: Some(&command),
            argv: None,
            cwd: None,
            env: None,
            stdin: true,
            interactive: true,
        },
    )
    .map_err(String::from)?;
    let output = Arc::new(Mutex::new(String::new()));
    let mut readers = Vec::new();
    if let Some(out) = child.stdout.take() {
        readers.push(collect(out, output.clone()));
    }
    if let Some(err) = child.stderr.take() {
        readers.push(collect(err, output.clone()));
    }
    let handle = child.handle();
    let printed = || output.lock().unwrap_or_else(|e| e.into_inner()).clone();

    let started = Instant::now();
    let mut manual_at = None;
    let (automatic, manual) = loop {
        let (automatic, manual) = login_links(&printed());
        if manual.is_some() && manual_at.is_none() {
            manual_at = Some(Instant::now());
        }
        let settled = manual_at.is_some_and(|at| ps || at.elapsed() > AUTOMATIC_LINK_GRACE);
        if automatic.is_some() && manual.is_some() || settled {
            break (automatic, manual);
        }
        if handle.try_wait().is_some() || started.elapsed() > LINK_TIMEOUT {
            handle.kill();
            return Err(login_failure(&printed()));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let Some(manual_url) = manual else {
        handle.kill();
        return Err("Claude Code printed no sign-in link.".to_string());
    };

    let tunneled = automatic
        .as_deref()
        .and_then(callback_port)
        .and_then(|port| {
            match tunnel::forward(host, port) {
                Ok(local) if local == port => Some(port),
                // Taken here: the browser would come back to the wrong port.
                Ok(_) => {
                    tunnel::close(host, port);
                    None
                }
                Err(_) => None,
            }
        });
    let url = match (&automatic, tunneled) {
        (Some(url), Some(_)) => url.clone(),
        _ => manual_url.clone(),
    };
    logins().lock().unwrap_or_else(|e| e.into_inner()).insert(
        host.to_string(),
        Arc::new(Login {
            handle,
            stdin: Mutex::new(child.stdin.take()),
            readers: Mutex::new(readers),
            output,
            tunneled_port: tunneled,
        }),
    );
    Ok(RemoteLoginLinks {
        url,
        manual_url,
        automatic: tunneled.is_some(),
    })
}

/// Starts signing in on the machine and answers with the links to open here.
#[tauri::command]
pub async fn claude_code_remote_login_start(host: String) -> Result<RemoteLoginLinks, String> {
    tauri::async_runtime::spawn_blocking(move || start_login(&host))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLoginEnd {
    ok: bool,
    /// Cancelled from here, so there is nothing to report.
    cancelled: bool,
    detail: String,
}

fn wait_login(host: &str) -> RemoteLoginEnd {
    let cancelled = RemoteLoginEnd {
        ok: false,
        cancelled: true,
        detail: String::new(),
    };
    let current = || {
        logins()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(host)
            .cloned()
    };
    let Some(login) = current() else {
        return cancelled;
    };
    let started = Instant::now();
    let code = loop {
        if !current().is_some_and(|l| Arc::ptr_eq(&l, &login)) {
            return cancelled;
        }
        if let Some(code) = login.handle.try_wait() {
            break code;
        }
        if started.elapsed() > LOGIN_PATIENCE {
            login.handle.kill();
            break None;
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    logins()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(host);
    close_login(host, &login);
    // Its pipes close with the exit, so these end now and the output is whole.
    for reader in login
        .readers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain(..)
    {
        let _ = reader.join();
    }
    let output = login.output.lock().unwrap_or_else(|e| e.into_inner());
    RemoteLoginEnd {
        ok: code == Some(0),
        cancelled: false,
        detail: if code == Some(0) {
            String::new()
        } else {
            login_failure(&output)
        },
    }
}

/// Waits until the sign-in started on the machine ends.
#[tauri::command]
pub async fn claude_code_remote_login_wait(host: String) -> Result<RemoteLoginEnd, String> {
    tauri::async_runtime::spawn_blocking(move || wait_login(&host))
        .await
        .map_err(|e| e.to_string())
}

/// Hands the sign-in the code the browser's page showed.
#[tauri::command(async)]
pub fn claude_code_remote_login_code(host: String, code: String) -> Result<(), String> {
    let code = code.trim();
    if code.is_empty() || code.contains(['\r', '\n']) {
        return Err("That isn't a sign-in code.".to_string());
    }
    let login = logins()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&host)
        .cloned()
        .ok_or("The sign-in isn't running any more.")?;
    let mut stdin = login.stdin.lock().unwrap_or_else(|e| e.into_inner());
    let pipe = stdin
        .as_mut()
        .ok_or("The sign-in isn't reading any more.")?;
    writeln!(pipe, "{code}")
        .and_then(|_| pipe.flush())
        .map_err(|e| format!("Couldn't send the code: {e}"))
}

fn cancel_login(host: &str) {
    let login = logins()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(host);
    if let Some(login) = login {
        close_login(host, &login);
    }
}

#[tauri::command(async)]
pub fn claude_code_remote_login_cancel(host: String) {
    cancel_login(&host);
}

#[cfg(test)]
mod tests {
    use super::*;

    // What 2.1.319 printed, in a login shell whose profile also greets.
    const SIGNED_OUT: &str = "Welcome to tnp\n2.1.319 (Claude Code)\n{\n  \"loggedIn\": false,\n  \"authMethod\": \"none\"\n}\nbye\n";
    const LOGIN_OUTPUT: &str = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=a\nPaste code here if prompted > NYXS_LOGIN_URL https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A35025%2Fcallback&state=a\n";

    #[test]
    fn status_reads_version_and_login_around_a_profiles_output() {
        assert_eq!(
            parse_status(SIGNED_OUT),
            RemoteClaudeStatus {
                installed: true,
                version: Some("2.1.319".into()),
                logged_in: Some(false),
            }
        );
    }

    #[test]
    fn status_without_the_cli_or_a_readable_login() {
        assert!(!parse_status("hello\nNYXS_NO_CLAUDE\n").installed);
        let unknown = parse_status("2.0.1 (Claude Code)\nunknown option --json\n");
        assert!(unknown.installed);
        assert_eq!(unknown.logged_in, None);
    }

    #[test]
    fn finds_both_links_and_the_port_to_tunnel() {
        let (automatic, manual) = login_links(LOGIN_OUTPUT);
        assert_eq!(automatic.as_deref().and_then(callback_port), Some(35025));
        let manual = manual.unwrap();
        assert!(manual.contains("platform.claude.com"));
        assert_eq!(callback_port(&manual), None);
    }

    #[test]
    fn only_anthropics_pages_are_opened() {
        assert!(is_sign_in_url("https://claude.com/cai/oauth/authorize?x=1"));
        assert!(is_sign_in_url("https://console.anthropic.com/oauth"));
        for bad in [
            "http://claude.com/x",
            "https://claude.com.evil.io/x",
            "https://evilclaude.com/x",
            "https://claude.com@evil.io/x",
            "https://evil.io?.claude.com/x",
            "file:///etc/passwd",
        ] {
            assert!(!is_sign_in_url(bad), "{bad}");
        }
        let (automatic, manual) =
            login_links("NYXS_LOGIN_URL https://evil.io/\nvisit: https://evil.io/\n");
        assert_eq!((automatic, manual), (None, None));
    }

    #[test]
    fn a_failed_login_reports_its_reason_not_the_prompt_or_links() {
        let failed = format!("{LOGIN_OUTPUT}Login failed: That code wasn't accepted.\n");
        assert_eq!(login_failure(&failed), "That code wasn't accepted.");
        assert_eq!(login_failure(LOGIN_OUTPUT), "Opening browser to sign in…");
    }

    #[test]
    fn install_failures_name_their_reason() {
        let res = |code, stderr: &str| procs::ExecResult {
            code: Some(code),
            stderr: stderr.into(),
            ..Default::default()
        };
        assert!(outcome_of(&res(0, "")).ok);
        assert_eq!(outcome_of(&res(90, "")).reason, Some("download"));
        assert_eq!(outcome_of(&res(91, "")).reason, Some("noDownloader"));
        let other = outcome_of(&res(1, "a\nb\nc\nd\n"));
        assert_eq!(
            (other.reason, other.detail.as_str()),
            (Some("other"), "b\nc\nd")
        );
    }

    /// Against a real machine that has no Claude Code, which ends up with it: `NYXS_SSH_CONFIG=<config>
    /// NYXS_REMOTE_TEST_HOST=<host> cargo test --lib claude_code::remote -- --ignored --nocapture`.
    /// It stops short of signing in: that takes a person in a browser.
    #[test]
    #[ignore]
    fn sets_up_claude_on_a_machine_and_reaches_its_sign_in_through_the_tunnel() {
        let Ok(host) = std::env::var("NYXS_REMOTE_TEST_HOST") else {
            return;
        };
        let status = |h: &str| {
            let ps = is_windows(h).unwrap();
            let script = if ps { STATUS_PS } else { STATUS_POSIX };
            parse_status(&run(h, script, ps, STATUS_TIMEOUT_MS).unwrap().stdout)
        };

        let before = status(&host);
        println!("before: {before:?}");
        if !before.installed {
            let ps = is_windows(&host).unwrap();
            let script = if ps { INSTALL_PS } else { INSTALL_POSIX };
            let outcome = outcome_of(&run(&host, script, ps, INSTALL_TIMEOUT_MS).unwrap());
            assert!(outcome.ok, "{outcome:?}");
        }
        let after = status(&host);
        println!("after: {after:?}");
        assert!(after.installed && after.version.is_some());
        assert_eq!(after.logged_in, Some(false));

        // The way a turn starts it, from a login shell whose PATH lacks ~/.local/bin.
        let remote = crate::remote::RemotePath {
            host: host.clone(),
            path: crate::remote::info(&host).unwrap().home,
        };
        let mut cli = crate::agent::cli_process::spawn_remote_cli(
            &remote,
            "claude",
            &["--version".to_string()],
            &HashMap::new(),
        )
        .unwrap();
        let mut printed = String::new();
        cli.stdout
            .take()
            .unwrap()
            .read_to_string(&mut printed)
            .unwrap();
        println!("spawned: {}", printed.trim());
        assert!(printed.contains("Claude Code"), "{printed}");

        let links = start_login(&host).unwrap();
        println!("automatic: {}", links.automatic);
        assert!(links.automatic, "the tunnel should have kept the port");
        let port = callback_port(&links.url).unwrap();
        // This PC's port answers from the machine: Claude's callback rejects what it didn't ask for.
        let mut callback = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        callback
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        write!(
            callback,
            "GET /nyxs-probe HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut answer = String::new();
        callback.read_to_string(&mut answer).unwrap();
        println!("callback: {}", answer.lines().next().unwrap_or(""));
        assert!(answer.starts_with("HTTP/1.1"), "{answer}");

        claude_code_remote_login_code(host.clone(), "not#real".into()).unwrap();
        let end = wait_login(&host);
        println!("end: ok={} detail={}", end.ok, end.detail);
        assert!(!end.ok && !end.cancelled);
        assert!(end.detail.contains("code"), "{}", end.detail);
        // ssh takes a moment to go after it's killed.
        let closes = |port: u16| {
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(5) {
                if std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            false
        };
        assert!(closes(port), "the tunnel should close with the sign-in");

        // Cancelling leaves nothing running on the machine.
        let links = start_login(&host).unwrap();
        let port = callback_port(&links.url).unwrap();
        cancel_login(&host);
        assert!(wait_login(&host).cancelled);
        std::thread::sleep(Duration::from_secs(1));
        // The brackets keep pgrep from matching the shell running this very line.
        let left = run(&host, "pgrep -fc '[a]uth login' || true", false, 10_000).unwrap();
        println!("left running: {}", left.stdout.trim());
        assert_eq!(left.stdout.trim(), "0", "{}", left.stdout);
        assert!(closes(port), "the tunnel should close when cancelled");
    }

    #[test]
    fn scripts_run_through_sh_with_the_installers_folder_on_the_path() {
        let posix = on_machine("claude update", false);
        assert!(posix.starts_with("exec sh -c '"));
        assert!(posix.contains(".local/bin"));
        assert!(on_machine("claude update", true).contains(r"\.local\bin"));
    }
}
