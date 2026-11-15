//! The shared video runtime: Remotion, React, esbuild, the engine, the player and the render
//! script, installed ONCE per app version under `~/.nyxs/video-runtime/<version>/` and used by
//! every video project (which hold only their data). `READY` is written last: a folder without
//! it is an install that didn't finish.

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use super::env;

const READY: &str = "READY";
/// The player bundle was pre-built in this runtime, so a server starts in moments.
const PREBUILT: &str = "PLAYER_PREBUILT";
const PREBUILD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const BROWSER_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Never part of the runtime's identity nor copied: an install someone ran in the template.
const SKIP: &[&str] = &["node_modules", ".git", "out", ".cache"];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub installed: bool,
    pub version: String,
    pub path: String,
    pub installing: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    stage: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

/// What `READY` holds: which dependencies that node_modules was installed from, so a runtime
/// that only changes engine sources can take over the previous one's node_modules.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyInfo {
    deps_hash: String,
}

static INSTALLING: AtomicBool = AtomicBool::new(false);

/// One install at a time: a second caller waits here and then finds `READY`.
fn install_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

pub fn root() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("NYXS_VIDEO_RUNTIME_ROOT").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    crate::project_paths::home_dir()
        .map(|h| h.join(".nyxs").join("video-runtime"))
        .ok_or_else(|| "Couldn't find the home folder for the video runtime.".to_string())
}

/// Every file of the template, sorted, relative with `/`.
fn template_files(dir: &Path) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let name = e.file_name();
            if SKIP.iter().any(|s| name == *s) {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else if let Ok(rel) = p.strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

fn hex(bytes: &[u8], len: usize) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        .chars()
        .take(len)
        .collect()
}

/// What the runtime runs: the rest of the template (examples/, standalone/) is content that
/// mustn't force a new runtime when it changes.
fn is_runtime_file(rel: &str) -> bool {
    rel == "package.json" || rel.starts_with("nyxs/") || rel.starts_with("entry/")
}

/// The runtime's identity: path and content of package.json, nyxs/** and entry/**. CRLF is
/// folded to LF so a git checkout with other line endings gives the same version.
pub fn version_of(template: &Path) -> String {
    let mut h = Sha256::new();
    for rel in template_files(template)
        .into_iter()
        .filter(|r| is_runtime_file(r))
    {
        h.update(rel.as_bytes());
        h.update([0]);
        if let Ok(bytes) = fs::read(template.join(&rel)) {
            h.update(normalize_eol(&bytes));
        }
        h.update([0]);
    }
    hex(&h.finalize(), 16)
}

/// The dependencies' identity: package.json alone.
pub fn deps_hash_of(template: &Path) -> String {
    let bytes = fs::read(template.join("package.json")).unwrap_or_default();
    hex(&Sha256::digest(normalize_eol(&bytes)), 16)
}

fn normalize_eol(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// The template's version, computed once per app run (the template doesn't change under a
/// running release; in development a restart picks up edits).
fn version_cell() -> &'static Mutex<Option<(PathBuf, String)>> {
    static V: OnceLock<Mutex<Option<(PathBuf, String)>>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(None))
}

/// Whether this app's runtime is installed, for code without an AppHandle. Before anything
/// computed the version, the newest finished runtime stands in for it.
pub fn known_ready() -> bool {
    let version = version_cell()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|(_, v)| v.clone());
    match (version, root()) {
        (Some(v), Ok(root)) => root.join(v).join(READY).is_file(),
        _ => any_ready_dir().is_some(),
    }
}

fn current(app: &AppHandle) -> Result<(PathBuf, String), String> {
    let mut g = version_cell().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(v) = g.as_ref() {
        return Ok(v.clone());
    }
    let template = env::template_dir(app)?;
    let v = (template.clone(), version_of(&template));
    *g = Some(v.clone());
    Ok(v)
}

pub fn status(app: &AppHandle) -> Result<RuntimeStatus, String> {
    let (_, version) = current(app)?;
    let dir = root()?.join(&version);
    Ok(RuntimeStatus {
        installed: dir.join(READY).is_file(),
        path: dir.to_string_lossy().into_owned(),
        version,
        installing: INSTALLING.load(Ordering::SeqCst),
    })
}

/// The installed runtime's folder, or an error telling the caller to install it first.
pub fn ready_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let s = status(app)?;
    if s.installed {
        Ok(PathBuf::from(s.path))
    } else {
        Err("The video runtime is not installed yet: install it first (Video view, or video_runtime_install).".into())
    }
}

/// Where to run Remotion's CLI (ffmpeg, ffprobe) for a project: an adopted project's own
/// install when it has one, else the shared runtime.
pub fn tools_for(app: &AppHandle, project: &Path) -> Result<PathBuf, String> {
    if project
        .join("node_modules")
        .join("@remotion")
        .join("cli")
        .is_dir()
    {
        return Ok(project.to_path_buf());
    }
    ready_dir(app)
}

/// The installed runtime, for code that has no AppHandle: the newest READY folder.
pub fn any_ready_dir() -> Option<PathBuf> {
    any_ready_dir_in(&root().ok()?)
}

/// The newest READY runtime under `root`.
pub fn any_ready_dir_in(root: &Path) -> Option<PathBuf> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter_map(|p| {
            let t = fs::metadata(p.join(READY))
                .and_then(|m| m.modified())
                .ok()?;
            Some((t, p))
        })
        .collect();
    found.sort();
    found.pop().map(|(_, p)| p)
}

fn emit(app: &AppHandle, stage: &str, line: Option<&str>, progress: Option<f64>) {
    let _ = app.emit(
        "video-runtime-progress",
        Progress {
            stage,
            line,
            progress,
            error: if stage == "error" { line } else { None },
        },
    );
}

/// Where install progress goes: `video-runtime-progress` events in the app, anything in tests.
pub type Report<'a> = &'a (dyn Fn(&str, Option<&str>, Option<f64>) + Sync);

/// Installs the runtime if it isn't there. Idempotent: a call while another installs waits for
/// it and returns its result (by finding `READY`).
pub fn install(app: &AppHandle) -> Result<RuntimeStatus, String> {
    let (template, _) = current(app)?;
    let report =
        |stage: &str, line: Option<&str>, progress: Option<f64>| emit(app, stage, line, progress);
    install_at(&template, &root()?, &report)?;
    status(app)
}

/// `install` for a given template and runtime root; returns the runtime's folder.
pub fn install_at(template: &Path, root: &Path, report: Report) -> Result<PathBuf, String> {
    let _one = install_lock().lock().unwrap_or_else(|e| e.into_inner());
    let version = version_of(template);
    let dir = root.join(&version);
    if dir.join(READY).is_file() {
        return Ok(dir);
    }
    INSTALLING.store(true, Ordering::SeqCst);
    let result = run_install(template, root, &dir, report);
    INSTALLING.store(false, Ordering::SeqCst);
    match result {
        Ok(()) => {
            report("done", Some("The video runtime is ready."), Some(1.0));
            clean_old(root, &version);
            Ok(dir)
        }
        Err(e) => {
            report("error", Some(&e), None);
            Err(e)
        }
    }
}

fn run_install(template: &Path, root: &Path, dir: &Path, report: Report) -> Result<(), String> {
    report("copying", Some("Copying the video engine…"), Some(0.0));
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    copy_template(template, dir).map_err(|e| format!("Couldn't copy the video engine: {e}"))?;

    let deps = deps_hash_of(template);
    let modules = dir.join("node_modules");
    if !modules.is_dir() {
        if let Some(prev) = runtime_with_deps(root, dir, &deps) {
            // Only the engine changed: take over the previous runtime's install.
            report(
                "installing",
                Some("Reusing the installed packages…"),
                Some(0.5),
            );
            if fs::rename(prev.join("node_modules"), &modules).is_err() {
                log::warn!("video: couldn't move node_modules from {}", prev.display());
            }
        }
    }
    let tc = env::toolchain();
    if !modules.join("remotion").is_dir() {
        let mut cmd = tc.command(tc.npm()?, dir);
        cmd.args(["install", "--no-audit", "--no-fund", "--loglevel=http"]);
        run_streamed(cmd, "installing", INSTALL_TIMEOUT, report)
            .map_err(|e| format!("npm install failed: {e}"))?;
    }
    let cli = modules
        .join("@remotion")
        .join("cli")
        .join("remotion-cli.js");
    if !cli.is_file() {
        return Err("npm install finished without @remotion/cli.".into());
    }
    report(
        "browser",
        Some("Downloading the headless browser for rendering…"),
        Some(0.8),
    );
    let mut cmd = tc.command(tc.node()?, dir);
    cmd.arg(&cli).args(["browser", "ensure"]);
    run_streamed(cmd, "browser", BROWSER_TIMEOUT, report)
        .map_err(|e| format!("Couldn't download the headless browser: {e}"))?;

    report("player", Some("Preparing the video player…"), Some(0.95));
    // Only makes the first open faster: a failure doesn't fail the install.
    if let Err(e) = prebuild(dir, report) {
        log::warn!("video: couldn't pre-build the player: {e}");
    }

    let ready = serde_json::to_vec(&ReadyInfo { deps_hash: deps }).map_err(|e| e.to_string())?;
    crate::agent::text_io::write_atomic(&dir.join(READY), &ready)
        .map_err(|e| format!("Couldn't write {}: {e}", dir.join(READY).display()))
}

/// Pre-builds the shared player bundle (`serve.mjs --prebuild`) and leaves the marker.
fn prebuild(runtime: &Path, report: Report) -> Result<(), String> {
    let tc = env::toolchain();
    let serve = runtime.join("nyxs").join("serve.mjs");
    let cmd = tc.node_script(runtime, &serve, &["--prebuild"])?;
    run_streamed(cmd, "player", PREBUILD_TIMEOUT, report)?;
    crate::agent::text_io::write_atomic(&runtime.join(PREBUILT), b"")
        .map_err(|e| format!("Couldn't write the marker: {e}"))
}

/// For a runtime installed before pre-building existed: builds once in the background, without
/// holding up the start that asked (`serve.mjs` builds what it needs meanwhile). One attempt per
/// runtime and app run, so a failure isn't retried on every open.
pub fn prebuild_in_background(runtime: &Path) {
    static TRIED: OnceLock<Mutex<std::collections::HashSet<PathBuf>>> = OnceLock::new();
    if runtime.join(PREBUILT).is_file() {
        return;
    }
    let first = TRIED
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(runtime.to_path_buf());
    if !first {
        return;
    }
    let runtime = runtime.to_path_buf();
    std::thread::spawn(move || {
        if let Err(e) = prebuild(&runtime, &|_, _, _| {}) {
            log::info!("video: couldn't pre-build the player: {e}");
        }
    });
}

/// Copies the template over `dir`, replacing what's there (a half-finished earlier attempt).
fn copy_template(from: &Path, to: &Path) -> std::io::Result<()> {
    for rel in template_files(from) {
        let target = to.join(&rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(from.join(&rel), &target)?;
    }
    Ok(())
}

/// A finished runtime other than `dir` whose node_modules came from the same package.json.
fn runtime_with_deps(root: &Path, dir: &Path, deps: &str) -> Option<PathBuf> {
    fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p != dir && p.join("node_modules").is_dir())
        .find(|p| {
            fs::read_to_string(p.join(READY))
                .ok()
                .and_then(|t| serde_json::from_str::<ReadyInfo>(&t).ok())
                .is_some_and(|r| r.deps_hash == deps)
        })
}

/// Removes every runtime but `keep`, once `keep` is ready. Files still open (a player from the
/// old one) make a removal fail; it's retried after the next install.
fn clean_old(root: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        if e.file_name() != keep && e.path().is_dir() {
            if let Err(err) = fs::remove_dir_all(e.path()) {
                log::info!(
                    "video: couldn't remove old runtime {}: {err}",
                    e.path().display()
                );
            }
        }
    }
}

/// Runs a command to the end, sending each output line as progress of `stage`.
fn run_streamed(
    mut cmd: std::process::Command,
    stage: &str,
    timeout: Duration,
    report: Report,
) -> Result<(), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("couldn't start {:?}: {e}", cmd.get_program()))?;
    let tail = Mutex::new(Vec::<String>::new());
    let pipes: Vec<Box<dyn Read + Send>> = [
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    let start = Instant::now();
    // Scoped threads: the readers borrow `report` and `tail`, and all end with the pipes.
    let code = std::thread::scope(|scope| {
        for pipe in pipes {
            let tail = &tail;
            scope.spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    let line = line.trim_end();
                    if line.is_empty() {
                        continue;
                    }
                    {
                        let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
                        t.push(line.to_string());
                        let excess = t.len().saturating_sub(12);
                        t.drain(..excess);
                    }
                    report(stage, Some(line), None);
                }
            });
        }
        loop {
            match child.try_wait() {
                Ok(Some(s)) => break Ok(s.code()),
                Ok(None) if start.elapsed() > timeout => {
                    env::kill_tree(&mut child);
                    break Err(format!(
                        "it took more than {} minutes and was stopped",
                        timeout.as_secs() / 60
                    ));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(e) => break Err(format!("couldn't wait for it: {e}")),
            }
        }
    })?;
    if code == Some(0) {
        Ok(())
    } else {
        let tail = tail.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
        Err(format!(
            "exit {}:\n{tail}",
            code.map_or("?".into(), |c| c.to_string())
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nyxs-video-rt-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn versions_follow_the_sources_not_the_install() {
        let t = temp("version");
        fs::write(t.join("package.json"), "{\"a\":1}\n").unwrap();
        fs::create_dir_all(t.join("nyxs/engine")).unwrap();
        fs::write(t.join("nyxs/engine/x.ts"), "export const x = 1;\n").unwrap();
        let v1 = version_of(&t);
        let d1 = deps_hash_of(&t);
        fs::create_dir_all(t.join("node_modules/react")).unwrap();
        fs::write(t.join("node_modules/react/index.js"), "x").unwrap();
        assert_eq!(
            version_of(&t),
            v1,
            "node_modules must not change the version"
        );
        fs::write(t.join("nyxs/engine/x.ts"), "export const x = 1;\r\n").unwrap();
        assert_eq!(
            version_of(&t),
            v1,
            "line endings must not change the version"
        );
        fs::write(t.join("nyxs/engine/x.ts"), "export const x = 2;\n").unwrap();
        assert_ne!(version_of(&t), v1);
        assert_eq!(deps_hash_of(&t), d1, "engine edits keep the dependencies");
        let v2 = version_of(&t);
        fs::create_dir_all(t.join("examples/demo")).unwrap();
        fs::write(t.join("examples/demo/timeline.json"), "{}").unwrap();
        assert_eq!(version_of(&t), v2, "examples are not runtime code");
        assert_eq!(v1.len(), 16);
        let _ = fs::remove_dir_all(&t);
    }

    #[test]
    fn finds_a_runtime_to_reuse_and_cleans_old_ones() {
        let root = temp("reuse");
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(old.join("node_modules")).unwrap();
        fs::create_dir_all(&new).unwrap();
        let ready = serde_json::to_string(&ReadyInfo {
            deps_hash: "abc".into(),
        })
        .unwrap();
        fs::write(old.join(READY), ready).unwrap();
        assert_eq!(runtime_with_deps(&root, &new, "abc"), Some(old.clone()));
        assert_eq!(runtime_with_deps(&root, &new, "zzz"), None);
        copy_template(&old, &new).unwrap();
        clean_old(&root, "new");
        assert!(!old.exists() && new.exists());
        let _ = fs::remove_dir_all(&root);
    }
}
