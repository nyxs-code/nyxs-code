use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Listener};

#[path = "git_state.rs"]
mod git_state;
#[cfg(not(target_os = "linux"))]
use git_state::extra_git_watches;
use git_state::{dirs_below, git_state_dirs, is_git_state, norm, rel_to, GitDirs};

/// What a watcher says: the event (`fs-change` or `git-change`) and the project folder, as the
/// app gave it, so each subscriber hears about its own project only.
type Emit = Arc<dyn Fn(&'static str, &str) + Send + Sync>;

/// One project folder's watcher: the system's file events for a folder on this PC, or the
/// helper's watch on a remote machine.
enum Watch {
    Local(#[allow(dead_code)] Arc<Mutex<RecommendedWatcher>>),
    Remote { host: String, id: String },
}

impl Watch {
    /// A local watcher stops when dropped; a remote one is told to.
    fn stop(self) {
        if let Watch::Remote { host, id } = self {
            stop_remote_watch(host, id);
        }
    }
}

/// Every folder watched, by the path the app gave. Several at once: the project on screen and
/// those of chats working in the background each have their own.
fn watches() -> &'static Mutex<HashMap<String, Watch>> {
    static WATCHES: OnceLock<Mutex<HashMap<String, Watch>>> = OnceLock::new();
    WATCHES.get_or_init(Default::default)
}

/// Folders whose changes the Files panel doesn't show.
fn is_ignored_name(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "target" | "dist" | ".next")
}

/// The ways the project folder can show up in the system's events: as the app gave it, and as
/// the system resolves it (macOS reports `/private/var/…` for `/var/…`).
fn root_forms(root: &Path) -> Vec<String> {
    let mut forms = vec![norm(root)];
    if let Ok(real) = fs::canonicalize(root) {
        let real = real.to_string_lossy();
        let real = norm(Path::new(real.strip_prefix(r"\\?\").unwrap_or(&real)));
        if !forms.contains(&real) {
            forms.push(real);
        }
    }
    forms
}

/// Whether a change at `path` is one of the project's files: inside the project and not in a
/// folder the Files panel leaves out. Only the part below the project counts, so a project
/// under `D:\dist\app` or `~/target/x` still has changes; the repository's folders outside it
/// (a linked worktree's) never do.
fn is_project_change(path: &Path, roots: &[String]) -> bool {
    let p = norm(path);
    roots.iter().any(|r| match rel_to(&p, r) {
        Some(rel) => !rel.split('/').any(is_ignored_name),
        None => p == *r,
    })
}

/// Nyxs' own state (the shadow-git snapshots live under `~/.nyxs/projects`): never watched as
/// the project's repository.
fn is_nyxs_state(path: &Path) -> bool {
    let p = norm(path);
    let roots = [
        std::env::var_os("NYXS_PROJECTS_ROOT")
            .filter(|r| !r.is_empty())
            .map(PathBuf::from),
        crate::project_paths::home_dir().map(|h| h.join(".nyxs")),
    ];
    roots.into_iter().flatten().any(|r| {
        let r = norm(&r);
        p == r || rel_to(&p, &r).is_some()
    })
}

/// The repository the project belongs to, unless it is one of Nyxs' own (`is_nyxs_state`).
fn find_git_dirs(project: &Path) -> Option<GitDirs> {
    git_state::find_git_dirs(project)
        .filter(|d| !is_nyxs_state(&d.git_dir) && !is_nyxs_state(&d.common_dir))
}

/// Emits `event` once things settle: a checkout touches many files in a burst.
fn emit_debounced(emit: Emit, rx: mpsc::Receiver<()>, event: &'static str, root: String) {
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            while rx.recv_timeout(Duration::from_millis(250)).is_ok() {}
            emit(event, &root);
        }
    });
}

/// Folders inotify isn't asked to watch: those the Files panel leaves out, and the generated
/// ones that can hold tens of thousands of folders (each costs a watch).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn skip_watching(name: &str) -> bool {
    is_ignored_name(name) || crate::walk::IGNORED_DIRS.contains(&name)
}

/// The folders to watch one by one where each costs a watch from the user's inotify limit
/// (`fs.inotify.max_user_watches`, Linux): the project's, without `node_modules`, `target` and
/// the like; and the repository's state (its top folders, logs and refs), not its objects.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_watch_dirs(root: &Path, git: Option<&GitDirs>) -> Vec<PathBuf> {
    let mut dirs = dirs_below(root, &skip_watching);
    if let Some(g) = git {
        dirs.extend(git_state_dirs(g));
    }
    dirs.retain(|d| d.is_dir());
    dirs.sort();
    dirs.dedup();
    dirs
}

#[cfg(target_os = "linux")]
fn watch_one(w: &mut RecommendedWatcher, dir: &Path) -> Result<(), String> {
    let out_of_watches = |e: &notify::Error| match &e.kind {
        notify::ErrorKind::MaxFilesWatch => true,
        notify::ErrorKind::Io(io) => io.raw_os_error() == Some(libc::ENOSPC),
        _ => false,
    };
    match w.watch(dir, RecursiveMode::NonRecursive) {
        Err(e) if out_of_watches(&e) => Err(format!(
            "inotify is out of watches ({e}): fs.inotify.max_user_watches is too low for this project"
        )),
        // A folder that disappears while being added is fine.
        _ => Ok(()),
    }
}

/// One watch per folder (see `linux_watch_dirs`), the project's own first: a folder that's gone
/// or can't be read is an error, not a watcher that never says anything.
#[cfg(target_os = "linux")]
fn add_watches(
    w: &mut RecommendedWatcher,
    root: &Path,
    git: Option<&GitDirs>,
) -> Result<(), String> {
    w.watch(root, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch failed: {e}"))?;
    for dir in linux_watch_dirs(root, git) {
        watch_one(w, &dir)?;
    }
    Ok(())
}

/// One recursive watch, which costs the same whatever the project's size, plus the git folders
/// outside it.
#[cfg(not(target_os = "linux"))]
fn add_watches(
    w: &mut RecommendedWatcher,
    root: &Path,
    git: Option<&GitDirs>,
) -> Result<(), String> {
    w.watch(root, RecursiveMode::Recursive)
        .map_err(|e| format!("watch failed: {e}"))?;
    if let Some(dirs) = git {
        for dir in extra_git_watches(root, dirs) {
            if let Err(e) = w.watch(&dir, RecursiveMode::Recursive) {
                log::warn!("couldn't watch {}: {e}", dir.display());
            }
        }
    }
    Ok(())
}

/// Linux: a folder that appears (made there or renamed into place) gets its watches. Ends with
/// the watcher, whose callback holds the other end of `rx`.
#[cfg(target_os = "linux")]
fn watch_new_dirs(
    watcher: std::sync::Weak<Mutex<RecommendedWatcher>>,
    rx: mpsc::Receiver<PathBuf>,
    roots: Vec<String>,
    git: Option<GitDirs>,
) {
    std::thread::spawn(move || {
        let refs = git.as_ref().map(|g| norm(&g.common_dir.join("refs")));
        while let Ok(p) = rx.recv() {
            if !p.is_dir() {
                continue;
            }
            let in_refs = refs
                .as_ref()
                .is_some_and(|r| rel_to(&norm(&p), r).is_some());
            let skipped = p
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(skip_watching);
            let dirs = if in_refs {
                dirs_below(&p, &|_| false)
            } else if is_project_change(&p, &roots) && !skipped {
                dirs_below(&p, &skip_watching)
            } else {
                continue;
            };
            let Some(w) = watcher.upgrade() else { return };
            let mut w = w.lock().unwrap_or_else(|e| e.into_inner());
            for d in dirs {
                if let Err(e) = watch_one(&mut w, &d) {
                    log::warn!("{e}");
                    break;
                }
            }
        }
    });
}

fn start_local_watch(path: &str, emit: Emit) -> Result<Watch, String> {
    let root = Path::new(path);
    let roots = root_forms(root);
    let (tx, rx) = mpsc::channel::<()>();
    let (git_tx, git_rx) = mpsc::channel::<()>();
    // Changes to the repository's state (commits, checkouts, pulls, stashes, also made in an
    // outside terminal) get their own event: the Files panel doesn't care about `.git`.
    let git_dirs = find_git_dirs(root);
    let watched_git = git_dirs.clone();
    let event_roots = roots.clone();
    let (dir_tx, dir_rx) = mpsc::channel::<PathBuf>();

    let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        let ev = match res {
            Ok(ev) => ev,
            Err(e) => {
                log::warn!("file watcher: {e}");
                return;
            }
        };
        if ev.paths.iter().any(|p| is_project_change(p, &event_roots)) {
            let _ = tx.send(());
        }
        if let Some(dirs) = &watched_git {
            if ev.paths.iter().any(|p| is_git_state(p, dirs)) {
                let _ = git_tx.send(());
            }
        }
        if cfg!(target_os = "linux")
            && matches!(
                ev.kind,
                notify::EventKind::Create(_)
                    | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
            )
        {
            for p in ev.paths {
                let _ = dir_tx.send(p);
            }
        }
    })
    .map_err(|e| format!("watcher init failed: {e}"))?;
    let watcher = Arc::new(Mutex::new(watcher));
    add_watches(
        &mut watcher.lock().unwrap_or_else(|e| e.into_inner()),
        root,
        git_dirs.as_ref(),
    )?;
    #[cfg(target_os = "linux")]
    watch_new_dirs(Arc::downgrade(&watcher), dir_rx, roots, git_dirs);
    #[cfg(not(target_os = "linux"))]
    drop((dir_rx, roots));

    emit_debounced(emit.clone(), rx, "fs-change", path.to_string());
    emit_debounced(emit, git_rx, "git-change", path.to_string());
    Ok(Watch::Local(watcher))
}

/// The helper sends a project's file changes under the watch's id and its repository's ones
/// under this one.
fn git_watch_id(id: &str) -> String {
    format!("{id}:git")
}

fn stop_remote_watch(host: String, id: String) {
    std::thread::spawn(move || {
        if let Some(c) = crate::remote::existing_conn(&host) {
            c.drop_watch(&id);
            c.drop_watch(&git_watch_id(&id));
            let _ = c.call(
                "unwatch",
                serde_json::json!({ "watch": id }),
                Some(Duration::from_secs(5)),
            );
        }
    });
}

/// A remote project: the helper on its machine watches it and says when it changed.
fn start_remote_watch(
    emit: Emit,
    path: &str,
    r: crate::remote::RemotePath,
) -> Result<Watch, String> {
    let conn = crate::remote::conn_for(&r.host).map_err(String::from)?;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = format!(
        "w{}",
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    for (watch_id, event) in [(id.clone(), "fs-change"), (git_watch_id(&id), "git-change")] {
        let (emit, root) = (emit.clone(), path.to_string());
        conn.on_watch(&watch_id, Arc::new(move || emit(event, &root)));
    }
    if let Err(e) = conn.call(
        "watch",
        serde_json::json!({ "watch": id, "root": r.path }),
        Some(Duration::from_secs(20)),
    ) {
        conn.drop_watch(&id);
        conn.drop_watch(&git_watch_id(&id));
        return Err(String::from(e));
    }
    Ok(Watch::Remote { host: r.host, id })
}

/// The machine a `remote-status` event says just connected.
fn connected_host(payload: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    if v.get("state")?.as_str()? != "connected" {
        return None;
    }
    v.get("host")?.as_str().map(str::to_string)
}

/// After a machine connects again (a suspend, a dropped network), its helper is a new one that
/// knows none of the old watches, and they'd stay silent: each is made again on the new
/// connection. One that the app stopped in the meantime is left stopped.
fn rearm_remote_watches(host: &str, emit: Emit) {
    let stale: Vec<(String, String)> = watches()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter_map(|(root, w)| match w {
            Watch::Remote { host: h, id } if h == host => Some((root.clone(), id.clone())),
            _ => None,
        })
        .collect();
    for (root, old_id) in stale {
        let Some(r) = crate::remote::parse(&root) else {
            continue;
        };
        match start_remote_watch(emit.clone(), &root, r) {
            Ok(new) => {
                let mut map = watches().lock().unwrap_or_else(|e| e.into_inner());
                let still =
                    matches!(map.get(&root), Some(Watch::Remote { id, .. }) if *id == old_id);
                if still {
                    // The old watch's helper is gone with its connection: nothing to tell it.
                    map.insert(root, new);
                } else {
                    drop(map);
                    new.stop();
                }
            }
            Err(e) => log::warn!("couldn't watch {root} again after reconnecting: {e}"),
        }
    }
}

fn listen_for_reconnects(app: &AppHandle, emit: Emit) {
    static LISTENING: OnceLock<()> = OnceLock::new();
    if LISTENING.set(()).is_err() {
        return;
    }
    app.listen_any("remote-status", move |event| {
        let Some(host) = connected_host(event.payload()) else {
            return;
        };
        // The event comes while the connection is still being stored: wait for it elsewhere.
        let emit = emit.clone();
        std::thread::spawn(move || rearm_remote_watches(&host, emit));
    });
}

/// Watches the project folder `path` (on this PC or `ssh://`), alongside any other already
/// watched. Started again for the same folder (the app retrying), the old watch is replaced.
#[tauri::command(async)]
pub fn fs_watch_start(app: AppHandle, path: String) -> Result<(), String> {
    let emit: Emit = {
        let app = app.clone();
        Arc::new(move |event, root| {
            let _ = app.emit(event, root);
        })
    };
    listen_for_reconnects(&app, emit.clone());
    let old = watches()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&path);
    if let Some(old) = old {
        old.stop();
    }
    let watch = match crate::remote::parse(&path) {
        Some(r) => start_remote_watch(emit, &path, r)?,
        None => start_local_watch(&path, emit)?,
    };
    let old = watches()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path, watch);
    if let Some(old) = old {
        old.stop();
    }
    Ok(())
}

/// Stops watching the folder `path`, or every folder when none is given.
#[tauri::command]
pub fn fs_watch_stop(path: Option<String>) -> Result<(), String> {
    let stopped: Vec<Watch> = {
        let mut map = watches().lock().unwrap_or_else(|e| e.into_inner());
        match path {
            Some(p) => map.remove(&p).into_iter().collect(),
            None => map.drain().map(|(_, w)| w).collect(),
        }
    };
    for w in stopped {
        w.stop();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nyxs-fswatch-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_the_repository_from_the_project_or_a_parent() {
        let repo = temp_dir("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join("app")).unwrap();
        let expected = GitDirs {
            git_dir: repo.join(".git"),
            common_dir: repo.join(".git"),
        };
        assert_eq!(find_git_dirs(&repo), Some(expected.clone()));
        assert_eq!(find_git_dirs(&repo.join("app")), Some(expected.clone()));
        // Inside the project the main watch already sees `.git`; from a subfolder it doesn't.
        assert!(git_state::extra_git_watches(&repo, &expected).is_empty());
        assert_eq!(
            git_state::extra_git_watches(&repo.join("app"), &expected),
            [repo.join(".git")]
        );
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn follows_a_linked_worktree_to_its_git_folders() {
        let base = temp_dir("worktree");
        let main = base.join("main");
        let wt_git = main.join(".git").join("worktrees").join("feature");
        fs::create_dir_all(&wt_git).unwrap();
        fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        let wt = base.join("feature");
        fs::create_dir_all(&wt).unwrap();
        fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", wt_git.to_string_lossy().replace('\\', "/")),
        )
        .unwrap();

        let dirs = find_git_dirs(&wt).unwrap();
        assert_eq!(norm(&dirs.git_dir), norm(&wt_git));
        assert_eq!(norm(&dirs.common_dir), norm(&main.join(".git")));
        // The worktree's own folder sits inside the common one: one watch covers both.
        let extra: Vec<String> = git_state::extra_git_watches(&wt, &dirs)
            .iter()
            .map(|d| norm(d))
            .collect();
        assert_eq!(extra, [norm(&main.join(".git"))]);

        assert!(is_git_state(&wt_git.join("HEAD"), &dirs));
        assert!(is_git_state(&main.join(".git/refs/heads/feature"), &dirs));
        // Another worktree's checkout isn't this project's.
        assert!(!is_git_state(
            &main.join(".git/worktrees/other/HEAD"),
            &dirs
        ));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn only_state_files_count_as_a_git_change() {
        let git = PathBuf::from(if cfg!(windows) {
            r"C:\p\.git"
        } else {
            "/p/.git"
        });
        let dirs = GitDirs {
            git_dir: git.clone(),
            common_dir: git.clone(),
        };
        for yes in [
            "HEAD",
            "index",
            "packed-refs",
            "FETCH_HEAD",
            "ORIG_HEAD",
            "logs/HEAD",
            "refs/heads/main",
            "refs/stash",
            "logs/refs/stash",
            "reftable/tables.list",
        ] {
            assert!(is_git_state(&git.join(yes), &dirs), "{yes}");
        }
        for no in [
            "objects/ab/cdef",
            "index.lock",
            "refs/heads/main.lock",
            "config",
            "worktrees/other/HEAD",
        ] {
            assert!(!is_git_state(&git.join(no), &dirs), "{no}");
        }
        assert!(!is_git_state(
            &git.with_file_name("src").join("HEAD"),
            &dirs
        ));
    }

    #[test]
    fn nyxs_own_snapshot_repositories_are_not_the_project() {
        let home = crate::project_paths::home_dir().unwrap();
        assert!(is_nyxs_state(
            &home
                .join(".nyxs")
                .join("projects")
                .join("D--app")
                .join("snapshots")
        ));
        assert!(!is_nyxs_state(&home.join("code").join("app").join(".git")));
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} failed");
    }

    #[test]
    fn a_real_commit_and_checkout_are_seen() {
        // The real path: macOS's temp dir is a symlink (/var → /private/var) and FSEvents reports
        // the resolved one, which wouldn't match the git dirs found under the symlinked path.
        // Only there: on Windows canonicalize adds a \\?\ prefix that git doesn't need.
        let repo = temp_dir("live");
        let repo = if cfg!(target_os = "macos") {
            fs::canonicalize(&repo).unwrap()
        } else {
            repo
        };
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "one"]);
        let dirs = find_git_dirs(&repo).unwrap();
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let watched = dirs.clone();
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(ev) = res {
                for p in ev.paths.into_iter().filter(|p| is_git_state(p, &watched)) {
                    let _ = tx.send(p);
                }
            }
        })
        .unwrap();
        watcher.watch(&repo, RecursiveMode::Recursive).unwrap();
        std::thread::sleep(Duration::from_millis(200));

        for args in [
            &["commit", "-q", "--allow-empty", "-m", "two"][..],
            &["checkout", "-q", "-b", "other"][..],
        ] {
            while rx.try_recv().is_ok() {}
            git(&repo, args);
            assert!(
                rx.recv_timeout(Duration::from_secs(5)).is_ok(),
                "no git change seen for {args:?}"
            );
        }
        drop(watcher);
        let _ = fs::remove_dir_all(&repo);
    }

    /// What a watcher emits, as (event, root), into a channel.
    fn recorder() -> (Emit, mpsc::Receiver<(String, String)>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let emit: Emit = Arc::new(move |event, root| {
            let _ = tx
                .lock()
                .unwrap()
                .send((event.to_string(), root.to_string()));
        });
        (emit, rx)
    }

    /// The next file change reported, skipping any other event.
    fn next_change(rx: &mpsc::Receiver<(String, String)>, wait: Duration) -> Option<String> {
        let until = std::time::Instant::now() + wait;
        loop {
            let left = until.checked_duration_since(std::time::Instant::now())?;
            match rx.recv_timeout(left) {
                Ok((event, root)) if event == "fs-change" => return Some(root),
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
    }

    #[test]
    fn each_folder_has_its_own_watcher_and_says_which_it_is() {
        let base = temp_dir("roots");
        let base = if cfg!(target_os = "macos") {
            fs::canonicalize(&base).unwrap()
        } else {
            base
        };
        // The first project sits under a folder named like an ignored one.
        let on_screen = base.join("dist").join("app");
        let background = base.join("other");
        fs::create_dir_all(on_screen.join("src")).unwrap();
        fs::create_dir_all(&background).unwrap();
        let (a, b) = (
            on_screen.to_string_lossy().to_string(),
            background.to_string_lossy().to_string(),
        );
        let (emit, rx) = recorder();
        let watch_a = start_local_watch(&a, emit.clone()).unwrap();
        let watch_b = start_local_watch(&b, emit).unwrap();
        // macOS' FSEvents can report the folders' creation late, after the watchers start; those
        // would pass for the writes below.
        std::thread::sleep(Duration::from_millis(400));
        while rx.try_recv().is_ok() {}

        fs::write(on_screen.join("src").join("a.ts"), "x").unwrap();
        assert_eq!(
            next_change(&rx, Duration::from_secs(5)).as_deref(),
            Some(a.as_str())
        );
        fs::write(background.join("b.ts"), "x").unwrap();
        assert_eq!(
            next_change(&rx, Duration::from_secs(5)).as_deref(),
            Some(b.as_str())
        );

        // Stopping the background one leaves the one on screen watched.
        drop(watch_b);
        std::thread::sleep(Duration::from_millis(400));
        while rx.try_recv().is_ok() {}
        fs::write(background.join("b.ts"), "y").unwrap();
        fs::write(on_screen.join("src").join("a.ts"), "y").unwrap();
        assert_eq!(
            next_change(&rx, Duration::from_secs(5)).as_deref(),
            Some(a.as_str())
        );
        assert_eq!(next_change(&rx, Duration::from_millis(800)), None);
        drop(watch_a);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn only_the_part_below_the_project_decides_what_is_ignored() {
        let root = PathBuf::from(if cfg!(windows) {
            r"D:\dist\app"
        } else {
            "/home/me/target/x"
        });
        let roots = vec![norm(&root)];
        assert!(is_project_change(&root.join("src").join("a.ts"), &roots));
        assert!(is_project_change(&root, &roots));
        for ignored in ["node_modules", "target", "dist", ".next", ".git"] {
            assert!(
                !is_project_change(&root.join(ignored).join("x.js"), &roots),
                "{ignored}"
            );
        }
        // A linked worktree's git folders, outside the project.
        assert!(!is_project_change(
            &root.with_file_name("main").join("a.ts"),
            &roots
        ));
    }

    #[test]
    fn inotify_watches_skip_generated_folders_and_git_objects() {
        let p = temp_dir("plan");
        for d in [
            "src/deep",
            "node_modules/react/lib",
            "target/debug/deps",
            "build/out",
            ".git/objects/ab",
            ".git/refs/heads/feature",
            ".git/refs/tags",
            ".git/logs/refs",
        ] {
            fs::create_dir_all(p.join(d)).unwrap();
        }
        let git = find_git_dirs(&p).unwrap();
        let mut got: Vec<String> = linux_watch_dirs(&p, Some(&git))
            .iter()
            .map(|d| rel_to(&norm(d), &norm(&p)).unwrap_or_default())
            .collect();
        got.sort();
        let want = [
            "",
            ".git",
            ".git/logs",
            ".git/refs",
            ".git/refs/heads",
            ".git/refs/heads/feature",
            ".git/refs/tags",
            "src",
            "src/deep",
        ];
        assert_eq!(got, want);
        let _ = fs::remove_dir_all(&p);
    }

    #[test]
    fn a_machine_that_connects_again_is_told_apart() {
        assert_eq!(
            connected_host(r#"{"host":"vps","state":"connected","info":{}}"#).as_deref(),
            Some("vps")
        );
        for other in [
            r#"{"host":"vps","state":"disconnected"}"#,
            r#"{"host":"vps","state":"connecting"}"#,
            "not json",
        ] {
            assert_eq!(connected_host(other), None, "{other}");
        }
        assert_eq!(git_watch_id("w3"), "w3:git");
    }
}
