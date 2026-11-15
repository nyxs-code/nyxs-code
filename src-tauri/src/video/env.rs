//! Finding Node/npm/npx and building the commands that run them: no console window on Windows,
//! its own process group elsewhere (so a kill takes the whole tree), the user's login PATH.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const PATH_SEP: char = if cfg!(windows) { ';' } else { ':' };

/// The Node tools a video project needs, with the PATH every child gets.
pub(super) struct Toolchain {
    pub path_env: Option<String>,
    pub node: Option<PathBuf>,
    pub npm: Option<PathBuf>,
    pub npx: Option<PathBuf>,
}

fn exe_names(base: &str) -> Vec<String> {
    if cfg!(windows) {
        if base == "node" {
            vec!["node.exe".into()]
        } else {
            vec![format!("{base}.cmd"), format!("{base}.exe")]
        }
    } else {
        vec![base.into()]
    }
}

/// The first `base` program found in a PATH-style list (`npm.cmd` for `npm` on Windows).
pub(super) fn find_in(path: &str, base: &str) -> Option<PathBuf> {
    for dir in path.split(PATH_SEP) {
        let dir = dir.trim().trim_matches('"');
        if dir.is_empty() {
            continue;
        }
        for name in exe_names(base) {
            let p = Path::new(dir).join(&name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// The user's Node, or the one Nyxs downloaded for its language servers when there is none on
/// the PATH (that copy ships npm and npx next to node too).
pub(super) fn toolchain() -> Toolchain {
    let mut path = crate::agent::login_path().unwrap_or_default();
    if find_in(&path, "node").is_none() {
        if let Some(dir) = crate::lsp::managed_node_program()
            .as_deref()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
        {
            path = format!("{}{PATH_SEP}{path}", dir.display());
        }
    }
    Toolchain {
        node: find_in(&path, "node"),
        npm: find_in(&path, "npm"),
        npx: find_in(&path, "npx"),
        path_env: Some(path).filter(|p| !p.is_empty()),
    }
}

impl Toolchain {
    pub fn node(&self) -> Result<&Path, String> {
        self.node
            .as_deref()
            .ok_or_else(|| "Node.js was not found: install Node.js 18 or newer.".to_string())
    }

    pub fn npm(&self) -> Result<&Path, String> {
        self.npm
            .as_deref()
            .ok_or_else(|| "npm was not found: install Node.js 18 or newer.".to_string())
    }

    /// A command for `program` in `cwd`, ready for a background run.
    pub fn command(&self, program: &Path, cwd: &Path) -> Command {
        let mut cmd = Command::new(program);
        cmd.current_dir(cwd);
        crate::agent::apply_login_env(&mut cmd);
        if let Some(p) = &self.path_env {
            cmd.env("PATH", p);
        }
        cmd.env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .env("npm_config_update_notifier", "false")
            .env("npm_config_fund", "false")
            .env("npm_config_audit", "false")
            .stdin(Stdio::null());
        crate::agent::hide_console(&mut cmd);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        cmd
    }

    /// `node <script> <args>` in `project`.
    pub fn node_script(
        &self,
        project: &Path,
        script: &Path,
        args: &[&str],
    ) -> Result<Command, String> {
        let mut cmd = self.command(self.node()?, project);
        cmd.arg(script).args(args);
        Ok(cmd)
    }

    /// The Remotion CLI installed in `project` (the shared runtime, or an adopted project's own
    /// node_modules), run from that folder. Calling its JS entry with node skips the npx and
    /// cmd.exe layers; npx is the fallback for a layout we don't know.
    pub fn remotion(&self, project: &Path, args: &[String]) -> Result<Command, String> {
        let cli = project
            .join("node_modules")
            .join("@remotion")
            .join("cli")
            .join("remotion-cli.js");
        if cli.is_file() {
            if let Some(node) = &self.node {
                let mut cmd = self.command(node, project);
                cmd.arg(cli).args(args);
                return Ok(cmd);
            }
        }
        if !project.join("node_modules").is_dir() {
            return Err(format!(
                "The video's dependencies are not installed ({}): install them first.",
                project.display()
            ));
        }
        let npx = self
            .npx
            .as_deref()
            .ok_or_else(|| "npx was not found: install Node.js 18 or newer.".to_string())?;
        let mut cmd = self.command(npx, project);
        cmd.args(["--no-install", "remotion"]).args(args);
        Ok(cmd)
    }
}

pub(super) struct Captured {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Captured {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// The last lines of stderr, for an error message.
    pub fn tail(&self) -> String {
        tail_lines(&self.stderr, 12)
    }
}

pub(super) fn tail_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Runs a command to the end, capturing its output, and kills its tree after `timeout`.
pub(super) fn run_capture(mut cmd: Command, timeout: Duration) -> Result<Captured, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start {:?}: {e}", cmd.get_program()))?;
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if start.elapsed() > timeout => {
                kill_tree(&mut child);
                return Err(format!(
                    "{:?} didn't finish in {} s.",
                    cmd.get_program(),
                    timeout.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(format!("Couldn't wait for {:?}: {e}", cmd.get_program())),
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    Ok(Captured {
        code,
        stdout,
        stderr,
    })
}

fn drain<R: Read + Send + 'static>(r: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = r {
            let _ = r.read_to_end(&mut buf);
        }
        buf
    })
}

pub(super) fn kill_tree(child: &mut Child) {
    crate::agent::kill_tree(child);
    let _ = child.wait();
}

/// `v20.11.1` → `20.11.1`.
pub(super) fn parse_version(out: &str) -> Option<String> {
    let v = out.lines().map(str::trim).find(|l| !l.is_empty())?;
    let v = v.strip_prefix('v').unwrap_or(v);
    v.chars()
        .next()
        .filter(char::is_ascii_digit)
        .map(|_| v.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoEnv {
    pub node: Option<String>,
    pub npm: Option<String>,
    /// Remotion brings its own ffmpeg/ffprobe with each project's install, so all it needs is
    /// a Node new enough to run Remotion 4 (18+) and npm to install it.
    pub ffmpeg_via_remotion: bool,
}

pub(super) fn check_env() -> VideoEnv {
    let tc = toolchain();
    let version = |p: &Option<PathBuf>| -> Option<String> {
        let p = p.as_deref()?;
        let mut cmd = tc.command(p, &std::env::temp_dir());
        cmd.arg("--version");
        let out = run_capture(cmd, Duration::from_secs(20)).ok()?;
        parse_version(&String::from_utf8_lossy(&out.stdout))
    };
    let node = version(&tc.node);
    let npm = version(&tc.npm);
    let major = node
        .as_deref()
        .and_then(|v| v.split('.').next())
        .and_then(|m| m.parse::<u32>().ok())
        .unwrap_or(0);
    VideoEnv {
        ffmpeg_via_remotion: major >= 18 && npm.is_some(),
        node,
        npm,
    }
}

/// The project template: in the source tree while developing (so edits show without a
/// rebuild), bundled with the app in a release.
pub(super) fn template_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("video-template"),
        );
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("resources").join("video-template"));
        candidates.push(res.join("video-template"));
    }
    candidates
        .into_iter()
        .find(|p| p.join("package.json").is_file())
        .ok_or_else(|| "This copy of Nyxs has no video template.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("v20.11.1\n").as_deref(), Some("20.11.1"));
        assert_eq!(parse_version("10.2.4\r\n").as_deref(), Some("10.2.4"));
        assert_eq!(parse_version("\n"), None);
        assert_eq!(parse_version("command not found"), None);
    }

    #[test]
    fn finds_programs_in_a_path_list() {
        let dir = std::env::temp_dir().join(format!("nyxs-video-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = if cfg!(windows) { "npm.cmd" } else { "npm" };
        std::fs::write(dir.join(name), b"").unwrap();
        let path = format!("{}{PATH_SEP}{}", "/nonexistent-dir", dir.display());
        assert_eq!(find_in(&path, "npm"), Some(dir.join(name)));
        assert_eq!(find_in(&path, "npx"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_the_last_lines() {
        assert_eq!(tail_lines("a\n\nb\nc\n", 2), "b\nc");
    }
}
