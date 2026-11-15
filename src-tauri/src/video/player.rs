//! The in-app player: one `node <runtime>/nyxs/serve.mjs` per project (esbuild watch + a static
//! server on 127.0.0.1). Starting one is what makes opening a project slow, so they stay warm:
//! closing a project only marks its server idle, at most `MAX_SERVERS` keep running, idle ones
//! stop after `IDLE_TTL`, and all of them die with the app.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

use super::env;
use super::project;
use super::runtime;

/// serve.mjs says its port right after node starts, before any build; this only covers a machine
/// so busy that node itself is slow to start.
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// Servers kept running, counting the ones in use (those are never stopped to make room).
const MAX_SERVERS: usize = 2;
const IDLE_TTL: Duration = Duration::from_secs(10 * 60);
const SWEEP_EVERY: Duration = Duration::from_secs(30);

struct Server {
    child: Child,
    port: u16,
    /// Since when no panel uses it; `None` while one does.
    idle_since: Option<Instant>,
    /// Held open for `--watch-stdin`: if Nyxs dies without cleaning up, the pipe closes and the
    /// server exits on its own.
    _stdin: Option<ChildStdin>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlayerInfo {
    pub url: String,
    pub port: u16,
}

fn servers() -> &'static Mutex<HashMap<String, Server>> {
    static S: OnceLock<Mutex<HashMap<String, Server>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Starts of one project are one at a time, so two quick calls (or a warm-up and the user) share
/// one server; other projects don't wait for it.
fn start_lock(key: &str) -> Arc<Mutex<()>> {
    static L: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(key.to_string())
        .or_default()
        .clone()
}

/// Which servers to stop, given how long each has been idle (`None` = in use): the ones idle
/// past `ttl`, then the longest idle while more than `cap` would keep running.
pub fn to_evict(servers: &[(String, Option<Duration>)], cap: usize, ttl: Duration) -> Vec<String> {
    let mut idle: Vec<&(String, Option<Duration>)> =
        servers.iter().filter(|(_, i)| i.is_some()).collect();
    idle.sort_by_key(|(_, i)| std::cmp::Reverse(*i));
    let excess = servers.len().saturating_sub(cap);
    idle.iter()
        .enumerate()
        .filter(|(n, (_, i))| *n < excess || i.is_some_and(|d| d >= ttl))
        .map(|(_, (k, _))| k.clone())
        .collect()
}

/// `taskkill` takes its time and nobody needs to wait for an evicted server.
fn kill_in_background(mut s: Server) {
    std::thread::spawn(move || env::kill_tree(&mut s.child));
}

/// Forgets dead servers and stops the ones `to_evict` picks.
fn sweep() {
    let now = Instant::now();
    let evicted: Vec<Server> = {
        let mut map = servers().lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, s| matches!(s.child.try_wait(), Ok(None)));
        let slots: Vec<(String, Option<Duration>)> = map
            .iter()
            .map(|(k, s)| (k.clone(), s.idle_since.map(|t| now.duration_since(t))))
            .collect();
        to_evict(&slots, MAX_SERVERS, IDLE_TTL)
            .iter()
            .filter_map(|k| map.remove(k))
            .collect()
    };
    evicted.into_iter().for_each(kill_in_background);
}

fn start_sweeper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(SWEEP_EVERY);
            sweep();
        });
    });
}

fn info(port: u16) -> PlayerInfo {
    PlayerInfo {
        url: format!("http://127.0.0.1:{port}/"),
        port,
    }
}

/// The runtime's serve.mjs arguments. An adopted project brings its own entry and packages, with
/// the runtime's node_modules for what it lacks (esbuild, @remotion/player).
pub fn serve_args(project: &Path, outdir: &Path, runtime: &Path, light: bool) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "--project".into(),
        project.to_string_lossy().into_owned(),
        "--outdir".into(),
        outdir.to_string_lossy().into_owned(),
        "--port".into(),
        "0".into(),
        "--watch-stdin".into(),
    ];
    if !light {
        a.extend([
            "--entry".into(),
            project::entry_point(project),
            "--node-path".into(),
            runtime.join("node_modules").to_string_lossy().into_owned(),
        ]);
    }
    a
}

/// `NYXS_PLAYER_PORT=5173` → 5173.
pub fn parse_port_line(line: &str) -> Option<u16> {
    let rest = line.split("NYXS_PLAYER_PORT=").nth(1)?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok().filter(|p| *p != 0)
}

/// The project's server, for a panel about to use it: the running one at once, else a new one.
pub fn start(app: &AppHandle, workspace: &str, slug: &str) -> Result<PlayerInfo, String> {
    start_server(&|| runtime::ready_dir(app), workspace, slug, false)
}

/// `warm`: nobody asked for it yet, so it starts out idle.
pub(super) fn start_server(
    runtime_dir: &dyn Fn() -> Result<PathBuf, String>,
    workspace: &str,
    slug: &str,
    warm: bool,
) -> Result<PlayerInfo, String> {
    let dir = project::project_dir(workspace, slug)?;
    let key = dir.to_string_lossy().into_owned();
    let lock = start_lock(&key);
    let _start = lock.lock().unwrap_or_else(|e| e.into_inner());
    {
        let mut map = servers().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = map.get_mut(&key) {
            if matches!(s.child.try_wait(), Ok(None)) {
                if !warm {
                    s.idle_since = None;
                }
                return Ok(info(s.port));
            }
            map.remove(&key);
        }
    }
    let runtime = runtime_dir()?;
    runtime::prebuild_in_background(&runtime);
    let light = project::is_light(&dir);
    if !light && !dir.join("node_modules").is_dir() {
        return Err(
            "This Remotion project's dependencies are not installed: install them first.".into(),
        );
    }
    let serve = runtime.join("nyxs").join("serve.mjs");
    if !serve.is_file() {
        return Err(format!("The player server is missing: {}", serve.display()));
    }
    if light {
        // Keeps the editor's imports pointing at the runtime after an app update replaced it.
        let _ = project::write_tsconfig(&dir, &runtime);
    }
    // Stable per project: serve.mjs keeps its last port here, so the URL (and the browser's HTTP
    // cache of the bundle) survives restarts.
    let outdir = project::cache_dir(workspace, slug)?.join("player");
    std::fs::create_dir_all(&outdir)
        .map_err(|e| format!("Couldn't create {}: {e}", outdir.display()))?;
    let args = serve_args(&dir, &outdir, &runtime, light);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut cmd = env::toolchain().node_script(&runtime, &serve, &args)?;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start the video player: {e}"))?;

    let (tx, rx) = mpsc::channel::<u16>();
    if let Some(out) = child.stdout.take() {
        let slug = slug.to_string();
        // Keeps reading after the port so the pipe never fills and blocks the server.
        std::thread::spawn(move || {
            let mut tx = Some(tx);
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(port) = parse_port_line(&line) {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(port);
                    }
                } else {
                    log::debug!("video player {slug}: {line}");
                }
            }
        });
    }
    let errors = Arc::new(Mutex::new(VecDeque::<String>::new()));
    if let Some(err) = child.stderr.take() {
        let errors = errors.clone();
        let slug = slug.to_string();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                log::info!("video player {slug}: {line}");
                let mut e = errors.lock().unwrap_or_else(|e| e.into_inner());
                e.push_back(line);
                if e.len() > 30 {
                    e.pop_front();
                }
            }
        });
    }

    match rx.recv_timeout(START_TIMEOUT) {
        Ok(port) => {
            servers().lock().unwrap_or_else(|e| e.into_inner()).insert(
                key,
                Server {
                    _stdin: child.stdin.take(),
                    child,
                    port,
                    idle_since: warm.then(Instant::now),
                },
            );
            sweep();
            start_sweeper();
            Ok(info(port))
        }
        Err(_) => {
            env::kill_tree(&mut child);
            let tail: Vec<String> = errors
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .cloned()
                .collect();
            Err(format!(
                "The video player didn't start:\n{}",
                env::tail_lines(&tail.join("\n"), 12)
            ))
        }
    }
}

/// The panel let go of the project: its server stays warm for the next open.
pub fn release(workspace: &str, slug: &str) -> Result<(), String> {
    project::check_slug(slug)?;
    let key = server_key(workspace, slug);
    if let Some(s) = servers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(&key)
    {
        s.idle_since.get_or_insert_with(Instant::now);
    }
    sweep();
    Ok(())
}

/// Stops the project's server now and waits for it: a Retry, or something about to move its
/// folder.
pub fn kill(workspace: &str, slug: &str) -> Result<(), String> {
    project::check_slug(slug)?;
    let key = server_key(workspace, slug);
    let lock = start_lock(&key);
    let _start = lock.lock().unwrap_or_else(|e| e.into_inner());
    let server = servers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&key);
    if let Some(mut s) = server {
        env::kill_tree(&mut s.child);
    }
    Ok(())
}

fn server_key(workspace: &str, slug: &str) -> String {
    // A project deleted meanwhile no longer resolves; its server still has to go.
    project::project_dir(workspace, slug)
        .unwrap_or_else(|_| {
            PathBuf::from(workspace)
                .join(project::VIDEOS_DIR)
                .join(slug)
        })
        .to_string_lossy()
        .into_owned()
}

/// The page reloaded (Ctrl+R): its panels are gone without saying so. The new page's start marks
/// what it uses again.
pub fn mark_all_idle() {
    let now = Instant::now();
    for s in servers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values_mut()
    {
        s.idle_since.get_or_insert(now);
    }
}

/// Pre-starts the most recently edited project's server after a listing, so opening it is
/// instant. It never pushes out a running server, and a project is warmed at most once per
/// `IDLE_TTL`, so listing often doesn't keep one alive for nobody.
pub fn warm_up(app: &AppHandle, workspace: &str, projects: &[project::VideoProjectInfo]) {
    static WARMED: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    let Some(p) = projects.iter().find(|p| p.installed && p.kind == "nyxs") else {
        return;
    };
    {
        let map = servers().lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= MAX_SERVERS || map.contains_key(&p.path) {
            return;
        }
    }
    {
        let mut warmed = WARMED
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if warmed.get(&p.path).is_some_and(|t| t.elapsed() < IDLE_TTL) {
            return;
        }
        warmed.insert(p.path.clone(), Instant::now());
    }
    let (app, workspace, slug) = (app.clone(), workspace.to_string(), p.slug.clone());
    std::thread::spawn(move || {
        if let Err(e) = start_server(&|| runtime::ready_dir(&app), &workspace, &slug, true) {
            log::info!("video: couldn't warm up the player of {slug}: {e}");
        }
    });
}

pub fn shutdown_all() {
    let all: Vec<Server> = servers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain()
        .map(|(_, s)| s)
        .collect();
    for mut s in all {
        env::kill_tree(&mut s.child);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_which_servers_to_stop() {
        let ttl = Duration::from_secs(600);
        let secs = |n| Some(Duration::from_secs(n));
        let s = |list: &[(&str, Option<Duration>)]| -> Vec<(String, Option<Duration>)> {
            list.iter().map(|(k, i)| (k.to_string(), *i)).collect()
        };
        // Within the cap and the time: all stay.
        assert!(to_evict(&s(&[("a", None), ("b", secs(30))]), 2, ttl).is_empty());
        // Over the cap: the longest idle goes.
        assert_eq!(
            to_evict(&s(&[("a", None), ("b", secs(30)), ("c", secs(90))]), 2, ttl),
            ["c"]
        );
        // Idle too long goes even under the cap.
        assert_eq!(to_evict(&s(&[("a", secs(601))]), 2, ttl), ["a"]);
        // In use is never stopped, even over the cap.
        assert!(to_evict(&s(&[("a", None), ("b", None), ("c", None)]), 2, ttl).is_empty());
        assert_eq!(
            to_evict(&s(&[("a", None), ("b", None), ("c", secs(1))]), 2, ttl),
            ["c"]
        );
    }

    #[test]
    fn builds_serve_arguments() {
        let a = serve_args(
            Path::new("/w/videos/intro"),
            Path::new("/c/player"),
            Path::new("/rt"),
            true,
        );
        assert_eq!(
            a[..2],
            ["--project".to_string(), "/w/videos/intro".to_string()]
        );
        assert!(a.contains(&"--watch-stdin".to_string()));
        assert!(!a.contains(&"--entry".to_string()));
        let a = serve_args(
            Path::new("/w/remotion"),
            Path::new("/c/player"),
            Path::new("/rt"),
            false,
        );
        assert!(a.contains(&"--entry".to_string()));
        assert!(a.contains(&"--node-path".to_string()));
    }

    #[test]
    fn reads_the_port_line() {
        assert_eq!(parse_port_line("NYXS_PLAYER_PORT=51234"), Some(51234));
        assert_eq!(
            parse_port_line("[serve] NYXS_PLAYER_PORT=8080\r"),
            Some(8080)
        );
        assert_eq!(parse_port_line("NYXS_PLAYER_PORT=0"), None);
        assert_eq!(parse_port_line("listening on 8080"), None);
        assert_eq!(parse_port_line("NYXS_PLAYER_PORT=99999"), None);
    }
}
