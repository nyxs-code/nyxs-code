use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Condvar, Mutex};

// A remote project's snapshots (`ssh://`), kept and taken on its machine.
#[path = "shadow_git_remote.rs"]
mod remote;

/// The snapshots repositories in use. Parallel Bash calls snapshot at the same time; two `git add`
/// on one shadow index collide on index.lock and the loser's change goes unrecorded. One lock for
/// all of them made every session wait on the slowest: a snapshot over SSH to a slow machine
/// held up the snapshots of every local project.
static BUSY: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
static FREED: Condvar = Condvar::new();

/// Holds one snapshots repository (`key`: its folder, or its remote project) until dropped.
struct ShadowGuard(String);

impl Drop for ShadowGuard {
    fn drop(&mut self) {
        BUSY.lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
        FREED.notify_all();
    }
}

fn shadow_lock(key: &str) -> ShadowGuard {
    let mut busy = BUSY.lock().unwrap_or_else(|e| e.into_inner());
    while busy.contains(key) {
        busy = FREED.wait(busy).unwrap_or_else(|e| e.into_inner());
    }
    busy.insert(key.to_string());
    ShadowGuard(key.to_string())
}

/// The lock of a local project's snapshots repository.
fn local_lock(workspace: &str) -> ShadowGuard {
    shadow_lock(&shadow_dir(workspace).to_string_lossy())
}

const DEFAULT_EXCLUDES: &str = "node_modules/\n.venv/\nvenv/\n__pycache__/\ntarget/\ndist/\nbuild/\n.next/\n.nuxt/\n.turbo/\n.cache/\ncoverage/\n*.log\n.DS_Store\nThumbs.db\n";

/// Files over this size that neither the snapshots nor the project's own git track yet are left
/// out (as opencode does): hashing them makes a big folder's first snapshot slow, and every
/// change to one would store another full copy.
const LARGE_FILE: u64 = 2 * 1024 * 1024;
/// What a left-out file holds in a snapshot tree. Leaving it out of the tree entirely would read
/// as "the file didn't exist", and a revert would delete it once it shrank below the limit.
const LARGE_PLACEHOLDER: &[u8] = b"Nyxs: an untracked file over 2 MB, left out of the snapshot\n";
const LARGE_PLACEHOLDER_OID: &str = "afa405adeb3010e4dd5fae07628d90321fab79c8";
/// The paths that hold the placeholder in the shadow index, NUL-separated, kept next to it.
const LARGE_LIST: &str = "nyxs-large";

/// One side of a snapshot: the shadow repository and the project, here or on a remote machine.
trait ShadowRepo {
    /// git with the shadow repository as its git dir and the project as its work tree and cwd.
    fn git(&self, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>, String>;
    /// Whether the shadow index exists yet, i.e. this isn't the first snapshot.
    fn has_index(&self) -> bool;
    /// Of these project-relative paths, the regular files over `limit` bytes.
    fn larger_than(&self, files: &[String], limit: u64) -> HashSet<String>;
    /// Of these project-relative paths, those the project's own git repository tracks.
    fn tracked_by_project(&self, files: &[String]) -> HashSet<String>;
    fn read_large_list(&self) -> Vec<String>;
    fn write_large_list(&self, files: &[String]);
}

fn split_nul(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

fn join_nul(files: &[String]) -> Vec<u8> {
    files
        .iter()
        .flat_map(|f| [f.as_bytes(), b"\0"])
        .flatten()
        .copied()
        .collect()
}

/// Of a failed `git add --all --ignore-errors`, the files it couldn't index, when files it
/// couldn't read are all that went wrong: it still indexed every other one. `None` for any other
/// failure (a lock, a broken index), which must fail the snapshot.
fn unindexed_files(stderr: &str) -> Option<Vec<String>> {
    if stderr.trim().is_empty() {
        return None;
    }
    let mut files = Vec::new();
    for line in stderr.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(rest) = line.strip_prefix("error: unable to index file ") {
            files.push(rest.trim_matches('\'').to_string());
        } else if !(line.starts_with("warning:")
            || line.starts_with("hint:")
            || line.starts_with("error: open(")
            || line.starts_with("error: read error while indexing ")
            || line.starts_with("error: short read while indexing ")
            || line == "fatal: adding files failed")
        {
            return None;
        }
    }
    Some(files)
}

/// `git add`, going on past the files it couldn't read (open in another program, no permission):
/// one such file used to fail every snapshot of the project. Returns those files.
fn add_all(
    repo: &dyn ShadowRepo,
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Result<Vec<String>, String> {
    match repo.git(args, stdin) {
        Ok(_) => Ok(Vec::new()),
        Err(e) => unindexed_files(&e).ok_or(e),
    }
}

fn take_snapshot(repo: &dyn ShadowRepo) -> Result<String, String> {
    let first = !repo.has_index();
    let listed = repo.read_large_list();
    let mut candidates =
        split_nul(&repo.git(&["ls-files", "--others", "--exclude-standard", "-z"], None)?);
    candidates.extend(listed.iter().cloned());
    let big = repo.larger_than(&candidates, LARGE_FILE);
    let mut large: Vec<String> = candidates.into_iter().filter(|f| big.contains(f)).collect();
    // Those already left out were checked then; asking again would cost a git run per snapshot.
    let unchecked: Vec<String> = large
        .iter()
        .filter(|f| !listed.contains(f))
        .cloned()
        .collect();
    if !unchecked.is_empty() {
        let tracked = repo.tracked_by_project(&unchecked);
        large.retain(|f| !tracked.contains(f));
    }
    large.sort();
    large.dedup();

    // Loose objects are one file each, and on Windows writing ten thousand of them is most of
    // a first snapshot's time. Past this threshold git streams blobs into a single pack
    // instead. Only the first time: every later snapshot would leave one more pack behind.
    let mut add: Vec<&str> = if first {
        vec!["-c", "core.bigFileThreshold=1"]
    } else {
        Vec::new()
    };
    add.extend(["add", "--all", "--ignore-errors"]);
    let unreadable = if large.is_empty() {
        add.extend(["--", "."]);
        add_all(repo, &add, None)?
    } else {
        add.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
        let specs: Vec<String> = std::iter::once(".".to_string())
            .chain(large.iter().map(|f| format!(":(exclude,literal){f}")))
            .collect();
        add_all(repo, &add, Some(&join_nul(&specs)))?
    };
    if !unreadable.is_empty() {
        eprintln!(
            "[snapshots] {} file(s) couldn't be read and were left out of this snapshot: {}",
            unreadable.len(),
            unreadable.join(", ")
        );
    }

    // A file that couldn't be read holds the placeholder too, for this snapshot only (it isn't
    // added to the list): left out, or with its previous content, a revert would delete it as
    // created or put that content back, when what it held is unknown.
    let fresh: Vec<&String> = large
        .iter()
        .filter(|f| !listed.contains(f))
        .chain(unreadable.iter())
        .collect();
    if !fresh.is_empty() {
        repo.git(&["hash-object", "-w", "--stdin"], Some(LARGE_PLACEHOLDER))?;
        let info: String = fresh
            .iter()
            .map(|f| format!("100644 {LARGE_PLACEHOLDER_OID}\t{f}\0"))
            .collect();
        repo.git(
            &["update-index", "-z", "--add", "--index-info"],
            Some(info.as_bytes()),
        )?;
    }
    if large != listed {
        repo.write_large_list(&large);
    }
    let tree = repo.git(&["write-tree"], None)?;
    Ok(String::from_utf8_lossy(&tree).trim().to_string())
}

/// The files `diff-tree --raw -z` lists, without the ones left out as too large on either side:
/// their real content was never stored, so there's nothing to read or put back.
fn changed_files(raw: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(raw);
    let mut parts = text.split('\0').filter(|s| !s.is_empty());
    let mut files = Vec::new();
    while let (Some(meta), Some(path)) = (parts.next(), parts.next()) {
        if !meta.contains(LARGE_PLACEHOLDER_OID) {
            files.push(path.to_string());
        }
    }
    files
}

const CHANGED_ARGS: [&str; 6] = [
    "diff-tree",
    "-r",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "-z",
];

fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn shadow_dir(workspace: &str) -> PathBuf {
    crate::project_paths::project_feature_dir(workspace, "snapshots")
        .unwrap_or_else(|| Path::new(workspace).join(".nyxs").join("snapshots"))
}

fn run(git_dir: &Path, workspace: &str, args: &[&str]) -> Result<String, String> {
    run_bytes(git_dir, workspace, args, None).map(|out| String::from_utf8_lossy(&out).into_owned())
}

fn run_bytes(
    git_dir: &Path,
    workspace: &str,
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("git");
    cmd.arg("--git-dir")
        .arg(git_dir)
        .arg("--work-tree")
        .arg(workspace)
        .args([
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.safecrlf=false",
            "-c",
            "core.quotepath=false",
        ])
        .args(args)
        .current_dir(workspace)
        .env("GIT_TERMINAL_PROMPT", "0");
    hide_console(&mut cmd);
    output(cmd, stdin)
}

fn output(mut cmd: Command, stdin: Option<&[u8]>) -> Result<Vec<u8>, String> {
    use std::io::Write;
    use std::process::Stdio;
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    // In the agent's job on Windows: a snapshot cut short by the app ending doesn't leave git
    // running on its own.
    let mut child = super::cli_process::spawn_contained(&mut cmd)
        .map_err(|e| format!("couldn't run git: {e}"))?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // Written from another thread so a full stdout pipe can't deadlock the two.
        let input = input.to_vec();
        std::thread::spawn(move || pipe.write_all(&input));
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("couldn't run git: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

struct LocalRepo<'a> {
    dir: PathBuf,
    workspace: &'a str,
}

impl ShadowRepo for LocalRepo<'_> {
    fn git(&self, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>, String> {
        run_bytes(&self.dir, self.workspace, args, stdin)
    }

    fn has_index(&self) -> bool {
        self.dir.join("index").is_file()
    }

    fn larger_than(&self, files: &[String], limit: u64) -> HashSet<String> {
        let root = Path::new(self.workspace);
        files
            .iter()
            .filter(|f| {
                fs::symlink_metadata(root.join(f)).is_ok_and(|m| m.is_file() && m.len() > limit)
            })
            .cloned()
            .collect()
    }

    fn tracked_by_project(&self, files: &[String]) -> HashSet<String> {
        let mut tracked = HashSet::new();
        for chunk in files.chunks(200) {
            let mut cmd = Command::new("git");
            cmd.args(["--literal-pathspecs", "ls-files", "-z", "--"])
                .args(chunk)
                .current_dir(self.workspace)
                .env("GIT_TERMINAL_PROMPT", "0");
            hide_console(&mut cmd);
            // Not a repository: it tracks nothing.
            if let Ok(out) = output(cmd, None) {
                tracked.extend(split_nul(&out));
            }
        }
        tracked
    }

    fn read_large_list(&self) -> Vec<String> {
        fs::read(self.dir.join(LARGE_LIST))
            .map(|b| split_nul(&b))
            .unwrap_or_default()
    }

    fn write_large_list(&self, files: &[String]) {
        let _ = fs::write(self.dir.join(LARGE_LIST), join_nul(files));
    }
}

/// Where the trees sessions still cite are kept from pruning: one ref per tree.
const KEEP_REFS: &str = "refs/nyxs/keep/";
/// Next to the repository: when it was last pruned.
const PRUNED_MARK: &str = "nyxs-pruned";
const PRUNE_EVERY: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
/// What git may delete when pruning: unreferenced objects older than this. A tree only an
/// in-memory chat cites (a turn still running, a chat not yet saved as a session) is safe for as
/// long, and a revert to one already gone restores nothing rather than delete.
const PRUNE_GRACE: &str = "30.days.ago";

/// The snapshot trees the sessions' metas under `root` (`~/.nyxs/projects`) cite in their shell
/// changes, all projects' at once: a worktree session's snapshots live under its worktree, while
/// its meta is under the project. A meta that's there but can't be read (another process holds it)
/// may cite any of them, so the answer is then an error and nothing is pruned. One that isn't
/// JSON cites nothing a revert could use.
fn cited_trees(root: &Path) -> Result<HashSet<String>, String> {
    let unreadable = |p: &Path, e: std::io::Error| format!("couldn't read {}: {e}", p.display());
    let mut trees = HashSet::new();
    for project in fs::read_dir(root)
        .map_err(|e| unreadable(root, e))?
        .flatten()
    {
        let dir = project.path();
        if !dir.is_dir() {
            continue;
        }
        for entry in fs::read_dir(&dir)
            .map_err(|e| unreadable(&dir, e))?
            .flatten()
        {
            let path = entry.path();
            if !path.to_string_lossy().ends_with(".meta.json") {
                continue;
            }
            let text = fs::read_to_string(&path).map_err(|e| unreadable(&path, e))?;
            let Ok(meta) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            let snapshots = meta["fileHistory"]["snapshots"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for change in snapshots
                .iter()
                .filter_map(|s| s["shellChanges"].as_array())
                .flatten()
            {
                for side in ["before", "after"] {
                    if let Some(tree) = change[side]
                        .as_str()
                        .filter(|t| t.len() >= 40 && t.chars().all(|c| c.is_ascii_hexdigit()))
                    {
                        trees.insert(tree.to_string());
                    }
                }
            }
        }
    }
    Ok(trees)
}

/// Prunes a local project's snapshots repository, which otherwise only ever grows: every tree a
/// session cites (see `cited_trees`) gets a ref, the refs of trees no longer cited go, and git
/// drops what nothing references any more, past `grace`. The shadow index keeps the latest
/// snapshot's objects.
fn prune_blocking(workspace: &str, root: &Path, grace: &str) -> Result<(), String> {
    let cited = cited_trees(root)?;
    let _guard = local_lock(workspace);
    let dir = shadow_dir(workspace);
    if !dir.join("HEAD").is_file() {
        return Ok(());
    }
    let git = |args: &[&str], stdin: Option<&[u8]>| run_bytes(&dir, workspace, args, stdin);
    let kept: HashSet<String> = String::from_utf8_lossy(&git(
        &["for-each-ref", "--format=%(refname)", KEEP_REFS],
        None,
    )?)
    .lines()
    .filter_map(|r| r.strip_prefix(KEEP_REFS).map(str::to_string))
    .collect();
    let mut updates = String::new();
    // Of the cited trees not kept yet, those this repository has (others belong to other ones).
    let fresh: Vec<&String> = cited.iter().filter(|t| !kept.contains(*t)).collect();
    if !fresh.is_empty() {
        let query: String = fresh.iter().map(|t| format!("{t}\n")).collect();
        let found = git(&["cat-file", "--batch-check"], Some(query.as_bytes()))?;
        for line in String::from_utf8_lossy(&found).lines() {
            if let Some((tree, "tree")) = line
                .split_once(' ')
                .map(|(t, rest)| (t, rest.split(' ').next().unwrap_or("")))
            {
                updates.push_str(&format!("create {KEEP_REFS}{tree} {tree}\n"));
            }
        }
    }
    for tree in kept.iter().filter(|t| !cited.contains(*t)) {
        updates.push_str(&format!("delete {KEEP_REFS}{tree}\n"));
    }
    if !updates.is_empty() {
        git(&["update-ref", "--stdin"], Some(updates.as_bytes()))?;
    }
    // One thread: it runs in the background while the user works.
    git(
        &[
            "-c",
            "pack.threads=1",
            "gc",
            "--quiet",
            &format!("--prune={grace}"),
        ],
        None,
    )?;
    Ok(())
}

/// Starts a pruning of the project's snapshots repository in the background, at most once a day.
fn prune_if_due(workspace: &str) {
    let mark = shadow_dir(workspace).join(PRUNED_MARK);
    let due = fs::metadata(&mark)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_none_or(|age| age >= PRUNE_EVERY);
    if !due {
        return;
    }
    // Marked first, so the snapshots taken meanwhile don't start another one.
    if fs::write(&mark, b"").is_err() {
        return;
    }
    let Some(root) = crate::project_paths::project_data_dir(workspace)
        .and_then(|p| p.parent().map(Path::to_path_buf))
    else {
        return;
    };
    let workspace = workspace.to_string();
    std::thread::spawn(move || {
        if let Err(e) = prune_blocking(&workspace, &root, PRUNE_GRACE) {
            eprintln!("[snapshots] not pruned: {e}");
        }
    });
}

fn ensure_repo(workspace: &str) -> Result<PathBuf, String> {
    let dir = shadow_dir(workspace);
    if dir.join("HEAD").is_file() {
        return Ok(dir);
    }
    fs::create_dir_all(&dir)
        .map_err(|e| format!("couldn't create the snapshots repository: {e}"))?;
    let mut init = Command::new("git");
    init.arg("init").arg("--bare").arg("--quiet").arg(&dir);
    hide_console(&mut init);
    let out = init
        .output()
        .map_err(|e| format!("couldn't run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    for (key, value) in [
        ("core.longpaths", "true"),
        ("feature.manyFiles", "true"),
        ("core.untrackedCache", "true"),
        ("gc.auto", "0"),
    ] {
        let _ = run(&dir, workspace, &["config", key, value]);
    }
    let info = dir.join("info");
    let _ = fs::create_dir_all(&info);
    let _ = fs::write(info.join("exclude"), DEFAULT_EXCLUDES);
    let real_objects = Path::new(workspace).join(".git").join("objects");
    if real_objects.is_dir() {
        let alternates = dir.join("objects").join("info");
        let _ = fs::create_dir_all(&alternates);
        let _ = fs::write(
            alternates.join("alternates"),
            format!("{}\n", real_objects.to_string_lossy()),
        );
    }
    Ok(dir)
}

fn safe_relative(path: &str) -> Option<&str> {
    let p = Path::new(path);
    if p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(path)
}

fn snapshot_blocking(workspace: &str) -> Result<String, String> {
    if let Some(r) = crate::remote::parse(workspace) {
        return remote::snapshot(&r);
    }
    if workspace.is_empty() || !Path::new(workspace).is_dir() {
        return Err("no working folder".into());
    }
    let _guard = local_lock(workspace);
    let dir = ensure_repo(workspace)?;
    take_snapshot(&LocalRepo { dir, workspace })
}

fn changed_blocking(workspace: &str, from: &str, to: &str) -> Result<Vec<String>, String> {
    if let Some(r) = crate::remote::parse(workspace) {
        return remote::changed(&r, from, to);
    }
    let _guard = local_lock(workspace);
    let dir = ensure_repo(workspace)?;
    let mut args = CHANGED_ARGS.to_vec();
    args.extend([from, to]);
    Ok(changed_files(&run_bytes(&dir, workspace, &args, None)?))
}

fn restore_blocking(workspace: &str, tree: &str, files: &[String]) -> Result<usize, String> {
    if let Some(r) = crate::remote::parse(workspace) {
        return remote::restore(&r, tree, files);
    }
    let _guard = local_lock(workspace);
    let dir = ensure_repo(workspace)?;
    let ls_tree = |rel: &str| {
        run(
            &dir,
            workspace,
            &[LITERAL, "ls-tree", "--name-only", tree, "--", rel],
        )
    };
    // A tree the snapshots repository doesn't have (lost, or made again) lists nothing, which
    // read as "the file didn't exist then" and deleted it from the project.
    has_tree(&|args| run(&dir, workspace, args), tree)?;
    let mut changed = 0usize;
    for file in files {
        let Some(rel) = safe_relative(file) else {
            continue;
        };
        let listed = ls_tree(rel)?;
        let target = Path::new(workspace).join(rel);
        if listed.trim().is_empty() {
            if target.is_file() && fs::remove_file(&target).is_ok() {
                changed += 1;
            }
            continue;
        }
        if run(&dir, workspace, &[LITERAL, "checkout", tree, "--", rel]).is_ok() {
            changed += 1;
        }
    }
    Ok(changed)
}

/// Paths given to git are file names, not patterns: `app/[slug]/page.tsx` also matched
/// `app/s/page.tsx`.
const LITERAL: &str = "--literal-pathspecs";

/// Fails unless `tree` is a tree the snapshots repository has.
fn has_tree(git: &dyn Fn(&[&str]) -> Result<String, String>, tree: &str) -> Result<(), String> {
    git(&["cat-file", "-e", &format!("{tree}^{{tree}}")])
        .map(|_| ())
        .map_err(|e| format!("the snapshot {tree} can't be read, so nothing was restored: {e}"))
}

/// A file's text in a snapshot tree; `None` when the tree doesn't have it.
fn read_blocking(workspace: &str, tree: &str, file: &str) -> Result<Option<String>, String> {
    if let Some(r) = crate::remote::parse(workspace) {
        return remote::read(&r, tree, file);
    }
    let rel = safe_relative(file).ok_or_else(|| format!("path outside the workspace: {file}"))?;
    let _guard = local_lock(workspace);
    let dir = ensure_repo(workspace)?;
    let listed = run(
        &dir,
        workspace,
        &[LITERAL, "ls-tree", "--name-only", tree, "--", rel],
    )?;
    if listed.trim().is_empty() {
        return Ok(None);
    }
    let spec = format!("{tree}:{}", rel.replace('\\', "/"));
    run(&dir, workspace, &["cat-file", "blob", &spec]).map(Some)
}

#[tauri::command]
pub async fn agent_shadow_read(
    workspace: String,
    tree: String,
    file: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_blocking(&workspace, &tree, &file))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_shadow_snapshot(workspace: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tree = snapshot_blocking(&workspace)?;
        // A remote project's repository is on its machine, with its sessions: not pruned from here.
        if crate::remote::parse(&workspace).is_none() {
            prune_if_due(&workspace);
        }
        Ok(tree)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_shadow_changed(
    workspace: String,
    from: String,
    to: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || changed_blocking(&workspace, &from, &to))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_shadow_restore(
    workspace: String,
    tree: String,
    files: Vec<String>,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || restore_blocking(&workspace, &tree, &files))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempWorkspace {
        path: PathBuf,
        name: String,
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
            if let Some(data) = crate::project_paths::project_data_dir(&self.name) {
                let _ = fs::remove_dir_all(data);
            }
        }
    }

    fn workspace(tag: &str) -> TempWorkspace {
        std::env::set_var(
            "NYXS_PROJECTS_ROOT",
            std::env::temp_dir().join("nyxs-test-projects"),
        );
        let path = std::env::temp_dir().join(format!(
            "nyxs-shadow-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        let name = path.to_string_lossy().to_string();
        TempWorkspace { path, name }
    }

    // Same rule as restoreShellChanges in src/lib/fileHistory.ts: a file goes
    // back to its `before` tree only if it still matches the `after` tree the
    // agent's command left.
    fn revert(ws: &str, items: &[(String, String, String)]) -> usize {
        let current = snapshot_blocking(ws).unwrap();
        let mut by_before: Vec<(String, Vec<String>)> = Vec::new();
        for (file, before, after) in items {
            if *after != current
                && changed_blocking(ws, after, &current)
                    .unwrap()
                    .contains(file)
            {
                continue;
            }
            match by_before.iter_mut().find(|(b, _)| b == before) {
                Some((_, files)) => files.push(file.clone()),
                None => by_before.push((before.clone(), vec![file.clone()])),
            }
        }
        by_before
            .iter()
            .map(|(before, files)| restore_blocking(ws, before, files).unwrap())
            .sum()
    }

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    #[test]
    fn snapshots_and_restores_files_changed_outside_the_edit_tools() {
        let tmp = workspace("restore");
        let (ws, wss) = (&tmp.path, tmp.name.as_str());
        fs::write(ws.join("keep.txt"), "original\n").unwrap();
        fs::create_dir_all(ws.join("node_modules")).unwrap();
        fs::write(ws.join("node_modules").join("big.js"), "x").unwrap();
        let before = snapshot_blocking(wss).unwrap();

        fs::write(ws.join("keep.txt"), "changed by a script\n").unwrap();
        fs::write(ws.join("new.txt"), "created\n").unwrap();
        let after = snapshot_blocking(wss).unwrap();
        assert_ne!(before, after);

        let mut changed = changed_blocking(wss, &before, &after).unwrap();
        changed.sort();
        assert_eq!(changed, vec!["keep.txt".to_string(), "new.txt".to_string()]);

        assert_eq!(
            read_blocking(wss, &before, "keep.txt").unwrap().as_deref(),
            Some("original\n")
        );
        assert_eq!(read_blocking(wss, &before, "new.txt").unwrap(), None);
        assert!(read_blocking(wss, &before, "../outside.txt").is_err());

        let restored = restore_blocking(wss, &before, &changed).unwrap();
        assert_eq!(restored, 2);
        assert_eq!(
            fs::read_to_string(ws.join("keep.txt")).unwrap(),
            "original\n"
        );
        assert!(!ws.join("new.txt").exists());
    }

    #[test]
    fn reverting_commands_keeps_concurrent_edits_by_others() {
        let tmp = workspace("revert");
        let (ws, wss) = (&tmp.path, tmp.name.as_str());
        let spaced = "carpeta con espacios/ñandú.txt";
        fs::create_dir_all(ws.join("carpeta con espacios")).unwrap();
        fs::write(ws.join("agent.txt"), b"line 1\r\nline 2\r\n").unwrap();
        fs::write(ws.join("shared.txt"), "orig\n").unwrap();
        fs::write(ws.join("other.txt"), "orig\n").unwrap();
        fs::write(ws.join(spaced), "nested\n").unwrap();
        snapshot_blocking(wss).unwrap();

        fs::write(ws.join("other.txt"), "other session, before the command\n").unwrap();

        // Command 1 edits, deletes and creates.
        let before1 = snapshot_blocking(wss).unwrap();
        fs::write(ws.join("agent.txt"), "rewritten\n").unwrap();
        fs::remove_file(ws.join(spaced)).unwrap();
        fs::create_dir_all(ws.join("gen")).unwrap();
        fs::write(ws.join("gen").join("nuevo.txt"), "generated\n").unwrap();
        fs::create_dir_all(ws.join("node_modules")).unwrap();
        fs::write(ws.join("node_modules").join("dep.js"), "x").unwrap();
        let after1 = snapshot_blocking(wss).unwrap();
        let files1 = changed_blocking(wss, &before1, &after1).unwrap();
        assert_eq!(
            sorted(files1.clone()),
            vec!["agent.txt", spaced, "gen/nuevo.txt"]
        );

        // Command 2 touches a file the user edits afterwards.
        let before2 = snapshot_blocking(wss).unwrap();
        fs::write(ws.join("shared.txt"), "agent\n").unwrap();
        let after2 = snapshot_blocking(wss).unwrap();
        let files2 = changed_blocking(wss, &before2, &after2).unwrap();
        assert_eq!(files2, vec!["shared.txt"]);

        fs::write(ws.join("shared.txt"), "user, after the command\n").unwrap();
        fs::write(ws.join("other.txt"), "other session, after the command\n").unwrap();

        // A command that changes nothing yields the same tree, so it records nothing.
        let before3 = snapshot_blocking(wss).unwrap();
        assert_eq!(before3, snapshot_blocking(wss).unwrap());

        let items: Vec<(String, String, String)> = files1
            .iter()
            .map(|f| (f.clone(), before1.clone(), after1.clone()))
            .chain(
                files2
                    .iter()
                    .map(|f| (f.clone(), before2.clone(), after2.clone())),
            )
            .collect();
        assert_eq!(revert(wss, &items), 3);

        assert_eq!(
            fs::read(ws.join("agent.txt")).unwrap(),
            b"line 1\r\nline 2\r\n"
        );
        assert_eq!(fs::read_to_string(ws.join(spaced)).unwrap(), "nested\n");
        assert!(!ws.join("gen").join("nuevo.txt").exists());
        assert_eq!(
            fs::read_to_string(ws.join("shared.txt")).unwrap(),
            "user, after the command\n"
        );
        assert_eq!(
            fs::read_to_string(ws.join("other.txt")).unwrap(),
            "other session, after the command\n"
        );
    }

    #[test]
    fn parallel_snapshots_all_succeed() {
        let tmp = workspace("parallel");
        for i in 0..200 {
            fs::write(tmp.path.join(format!("f{i}.txt")), format!("{i}\n")).unwrap();
        }
        snapshot_blocking(&tmp.name).unwrap();
        let trees: Vec<Result<String, String>> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..8)
                .map(|_| s.spawn(|| snapshot_blocking(&tmp.name)))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let first = trees[0].clone().unwrap();
        for tree in trees {
            assert_eq!(tree.unwrap(), first);
        }
    }

    fn big(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i % 251) as u8).collect()
    }

    const OVER: usize = LARGE_FILE as usize + 1;

    #[test]
    fn placeholder_oid_matches_its_content() {
        let mut cmd = Command::new("git");
        cmd.args(["hash-object", "--stdin"]);
        let out = output(cmd, Some(LARGE_PLACEHOLDER)).unwrap();
        assert_eq!(String::from_utf8_lossy(&out).trim(), LARGE_PLACEHOLDER_OID);
    }

    #[test]
    fn first_snapshot_packs_its_objects() {
        let tmp = workspace("pack");
        for i in 0..50 {
            fs::write(tmp.path.join(format!("f{i}.txt")), format!("{i}\n")).unwrap();
        }
        snapshot_blocking(&tmp.name).unwrap();
        let dir = shadow_dir(&tmp.name);
        let packs = fs::read_dir(dir.join("objects").join("pack"))
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .is_ok_and(|e| e.path().extension().is_some_and(|x| x == "pack"))
            })
            .count();
        assert_eq!(packs, 1);
        // Later snapshots write loose objects again, so packs don't pile up.
        fs::write(tmp.path.join("f0.txt"), "changed\n").unwrap();
        snapshot_blocking(&tmp.name).unwrap();
        let packs_after = fs::read_dir(dir.join("objects").join("pack"))
            .unwrap()
            .count();
        assert_eq!(packs_after, 2, "one .pack and its .idx");
    }

    #[test]
    fn large_untracked_files_are_left_out_without_being_reverted() {
        let tmp = workspace("large");
        let (ws, wss) = (&tmp.path, tmp.name.as_str());
        fs::write(ws.join("small.txt"), "a\n").unwrap();
        fs::write(ws.join("data.bin"), big(OVER)).unwrap();
        fs::write(ws.join("-odd name.bin"), big(OVER)).unwrap();
        let t0 = snapshot_blocking(wss).unwrap();
        assert_eq!(
            run(
                &shadow_dir(wss),
                wss,
                &["cat-file", "-p", &format!("{t0}:data.bin")]
            )
            .unwrap(),
            String::from_utf8_lossy(LARGE_PLACEHOLDER)
        );

        // Rewritten while still large: not seen, so nothing to revert.
        fs::write(ws.join("data.bin"), big(OVER + 10)).unwrap();
        fs::write(ws.join("small.txt"), "b\n").unwrap();
        let t1 = snapshot_blocking(wss).unwrap();
        assert_eq!(changed_blocking(wss, &t0, &t1).unwrap(), vec!["small.txt"]);

        // Shrunk below the limit: its old content was never stored, so a revert must not
        // treat it as created and delete it.
        fs::write(ws.join("data.bin"), "now small\n").unwrap();
        let t2 = snapshot_blocking(wss).unwrap();
        assert!(changed_blocking(wss, &t1, &t2).unwrap().is_empty());
        assert_eq!(
            read_blocking(wss, &t2, "data.bin").unwrap().as_deref(),
            Some("now small\n")
        );

        // A new large file appears and goes again: nothing either way.
        fs::write(ws.join("new.bin"), big(OVER)).unwrap();
        let t3 = snapshot_blocking(wss).unwrap();
        fs::remove_file(ws.join("new.bin")).unwrap();
        let t4 = snapshot_blocking(wss).unwrap();
        assert!(changed_blocking(wss, &t2, &t3).unwrap().is_empty());
        assert!(changed_blocking(wss, &t3, &t4).unwrap().is_empty());
        assert!(!LocalRepo {
            dir: shadow_dir(wss),
            workspace: wss
        }
        .read_large_list()
        .contains(&"new.bin".to_string()));
    }

    #[test]
    fn large_files_already_tracked_are_still_snapshotted() {
        let tmp = workspace("tracked");
        let (ws, wss) = (&tmp.path, tmp.name.as_str());
        // Small when the snapshots first saw it, large later.
        fs::write(ws.join("grows.db"), "tiny\n").unwrap();
        // Tracked by the project's own repository.
        fs::write(ws.join("asset.bin"), big(OVER)).unwrap();
        let git = |args: &[&str]| {
            let mut cmd = Command::new("git");
            cmd.args(args).current_dir(ws);
            output(cmd, None).unwrap()
        };
        git(&["init", "--quiet"]);
        git(&["add", "asset.bin"]);
        snapshot_blocking(wss).unwrap();

        let before = snapshot_blocking(wss).unwrap();
        fs::write(ws.join("grows.db"), big(OVER)).unwrap();
        fs::write(ws.join("asset.bin"), big(OVER + 1)).unwrap();
        let after = snapshot_blocking(wss).unwrap();
        let changed = changed_blocking(wss, &before, &after).unwrap();
        assert_eq!(sorted(changed.clone()), vec!["asset.bin", "grows.db"]);
        assert_eq!(restore_blocking(wss, &before, &changed).unwrap(), 2);
        assert_eq!(fs::read(ws.join("grows.db")).unwrap(), b"tiny\n");
        assert_eq!(fs::read(ws.join("asset.bin")).unwrap(), big(OVER));
    }

    /// Opens `path` so that nobody else can read it until the handle is dropped (on Unix, by
    /// taking its read permission away, given back on drop).
    struct Unreadable {
        #[cfg(windows)]
        _file: fs::File,
        #[cfg(unix)]
        path: PathBuf,
    }

    #[cfg(unix)]
    impl Drop for Unreadable {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o644));
        }
    }

    fn unreadable(path: &Path) -> Unreadable {
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(path)
                .unwrap();
            Unreadable { _file: file }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o000)).unwrap();
            Unreadable {
                path: path.to_path_buf(),
            }
        }
    }

    #[test]
    fn an_unreadable_file_doesnt_stop_the_snapshots() {
        let tmp = workspace("unreadable");
        let (ws, wss) = (&tmp.path, tmp.name.as_str());
        fs::write(ws.join("a.txt"), "1\n").unwrap();
        fs::write(ws.join("old.txt"), "old\n").unwrap();
        snapshot_blocking(wss).unwrap();
        fs::write(ws.join("new.txt"), "new\n").unwrap();
        let locks = [
            unreadable(&ws.join("old.txt")),
            unreadable(&ws.join("new.txt")),
        ];
        // Run as root (some containers), nothing can be made unreadable: nothing to check.
        if fs::read(ws.join("old.txt")).is_ok() {
            return;
        }

        let before = snapshot_blocking(wss).expect("the other files are still snapshotted");
        fs::write(ws.join("a.txt"), "2\n").unwrap();
        let after = snapshot_blocking(wss).unwrap();
        assert_eq!(
            changed_blocking(wss, &before, &after).unwrap(),
            vec!["a.txt"]
        );

        // Readable again: what it held while it couldn't be read is unknown, so a revert must
        // neither delete new.txt as created nor put old content back.
        drop(locks);
        let later = snapshot_blocking(wss).unwrap();
        assert!(changed_blocking(wss, &after, &later).unwrap().is_empty());
        assert_eq!(
            read_blocking(wss, &later, "new.txt").unwrap().as_deref(),
            Some("new\n")
        );
    }

    #[test]
    fn tells_per_file_add_errors_from_real_failures() {
        let stderr = "error: open(\"sub dir/locked.txt\"): Permission denied\nerror: unable to index file 'sub dir/locked.txt'\nwarning: could not open directory 'x/': Permission denied\nfatal: adding files failed\n";
        assert_eq!(
            unindexed_files(stderr),
            Some(vec!["sub dir/locked.txt".to_string()])
        );
        assert_eq!(
            unindexed_files("fatal: Unable to create '/x/index.lock': File exists."),
            None
        );
        assert_eq!(unindexed_files(""), None);
    }

    /// A folder of projects' session metas, as `~/.nyxs/projects`, citing these trees in one
    /// session's shell changes.
    fn sessions_citing(tag: &str, trees: &[(&str, &str)]) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("nyxs-shadow-sessions-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("E--some-project")).unwrap();
        let changes: Vec<serde_json::Value> = trees
            .iter()
            .map(|(before, after)| serde_json::json!({ "before": before, "after": after, "files": ["a.txt"] }))
            .collect();
        let meta = serde_json::json!({
            "title": "t",
            "fileHistory": { "snapshots": [{ "messageId": "m1", "trackedFileBackups": {}, "shellChanges": changes }], "trackedFiles": [] },
        });
        fs::write(
            root.join("E--some-project").join("s1.meta.json"),
            meta.to_string(),
        )
        .unwrap();
        root
    }

    fn has(wss: &str, tree: &str) -> bool {
        run(
            &shadow_dir(wss),
            wss,
            &["cat-file", "-e", &format!("{tree}^{{tree}}")],
        )
        .is_ok()
    }

    #[test]
    fn pruning_keeps_the_snapshots_sessions_cite_and_drops_the_rest() {
        let tmp = workspace("prune");
        let (ws, wss) = (&tmp.path, tmp.name.as_str());
        fs::write(ws.join("a.txt"), "1\n").unwrap();
        let t1 = snapshot_blocking(wss).unwrap();
        fs::write(ws.join("a.txt"), "2\n").unwrap();
        let t2 = snapshot_blocking(wss).unwrap();
        fs::write(ws.join("a.txt"), "3\n").unwrap();
        let t3 = snapshot_blocking(wss).unwrap();
        fs::write(ws.join("a.txt"), "4\n").unwrap();
        let t4 = snapshot_blocking(wss).unwrap();

        let root = sessions_citing("prune", &[(&t1, &t2)]);
        prune_blocking(wss, &root, "now").unwrap();
        assert!(
            has(wss, &t1) && has(wss, &t2),
            "a session can still revert to them"
        );
        assert!(!has(wss, &t3), "no session cites it");
        assert!(has(wss, &t4), "the latest snapshot stays");
        assert_eq!(restore_blocking(wss, &t1, &["a.txt".into()]).unwrap(), 1);
        assert_eq!(fs::read_to_string(ws.join("a.txt")).unwrap(), "1\n");

        // The session is gone: what only it cited goes at the next pruning.
        fs::remove_dir_all(&root).unwrap();
        fs::create_dir_all(&root).unwrap();
        prune_blocking(wss, &root, "now").unwrap();
        assert!(!has(wss, &t2));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_session_that_cant_be_read_stops_the_pruning() {
        let tmp = workspace("prune-unreadable");
        let (ws, wss) = (&tmp.path, tmp.name.as_str());
        fs::write(ws.join("a.txt"), "1\n").unwrap();
        let t1 = snapshot_blocking(wss).unwrap();
        fs::write(ws.join("a.txt"), "2\n").unwrap();
        snapshot_blocking(wss).unwrap();

        let root = sessions_citing("prune-unreadable", &[]);
        // It may cite t1: nothing is pruned while it can't be read.
        fs::create_dir_all(root.join("E--some-project").join("s2.meta.json")).unwrap();
        fs::write(
            root.join("E--some-project").join("s3.meta.json"),
            "{not json",
        )
        .unwrap();
        assert!(prune_blocking(wss, &root, "now").is_err());
        assert!(has(wss, &t1));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn one_project_waiting_on_its_snapshots_doesnt_hold_up_another() {
        use std::sync::mpsc;
        use std::time::Duration;
        let a = shadow_lock("nyxs-test-lock-a");
        let took = |key: &'static str| {
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let _g = shadow_lock(key);
                let _ = tx.send(());
            });
            rx
        };
        let other = took("nyxs-test-lock-b");
        assert!(
            other.recv_timeout(Duration::from_secs(5)).is_ok(),
            "another folder's snapshots go ahead"
        );
        let same = took("nyxs-test-lock-a");
        assert!(
            same.recv_timeout(Duration::from_millis(200)).is_err(),
            "the same folder's wait their turn"
        );
        drop(a);
        assert!(same.recv_timeout(Duration::from_secs(5)).is_ok());
    }

    #[test]
    fn reads_changed_files_from_raw_diff_output() {
        let raw = format!(
            ":100644 100644 {a} {b} M\0src/a.ts\0:000000 100644 {z} {p} A\0big.bin\0:100644 000000 {a} {z} D\0gone.txt\0",
            a = "1".repeat(40),
            b = "2".repeat(40),
            z = "0".repeat(40),
            p = LARGE_PLACEHOLDER_OID
        );
        assert_eq!(changed_files(raw.as_bytes()), vec!["src/a.ts", "gone.txt"]);
    }

    #[test]
    fn refuses_paths_that_escape_the_workspace() {
        assert!(safe_relative("../etc/passwd").is_none());
        assert!(safe_relative("src/../../x").is_none());
        assert!(safe_relative("src/a.ts").is_some());
    }

    #[test]
    fn a_tree_that_cant_be_read_restores_nothing() {
        let tmp = workspace("lost-tree");
        let (ws, wss) = (&tmp.path, tmp.name.as_str());
        fs::write(ws.join("keep.txt"), "original\n").unwrap();
        let before = snapshot_blocking(wss).unwrap();
        fs::write(ws.join("keep.txt"), "the user's work\n").unwrap();

        // The snapshots repository was lost and made again: the old tree is gone from it.
        fs::remove_dir_all(shadow_dir(wss)).unwrap();
        let files = vec!["keep.txt".to_string()];
        assert!(restore_blocking(wss, &before, &files).is_err());
        assert!(restore_blocking(wss, &"0".repeat(40), &files).is_err());
        assert_eq!(
            fs::read_to_string(ws.join("keep.txt")).unwrap(),
            "the user's work\n"
        );
    }

    #[test]
    fn restoring_a_path_with_brackets_restores_only_that_file() {
        let tmp = workspace("brackets");
        let (ws, wss) = (&tmp.path, tmp.name.as_str());
        fs::create_dir_all(ws.join("app").join("[slug]")).unwrap();
        fs::create_dir_all(ws.join("app").join("s")).unwrap();
        fs::write(ws.join("app/[slug]/page.tsx"), "slug v1\n").unwrap();
        fs::write(ws.join("app/s/page.tsx"), "s v1\n").unwrap();
        let before = snapshot_blocking(wss).unwrap();
        fs::write(ws.join("app/[slug]/page.tsx"), "slug v2\n").unwrap();
        fs::write(ws.join("app/s/page.tsx"), "s v2, someone else's\n").unwrap();

        let files = vec!["app/[slug]/page.tsx".to_string()];
        assert_eq!(restore_blocking(wss, &before, &files).unwrap(), 1);
        assert_eq!(
            fs::read_to_string(ws.join("app/[slug]/page.tsx")).unwrap(),
            "slug v1\n"
        );
        assert_eq!(
            fs::read_to_string(ws.join("app/s/page.tsx")).unwrap(),
            "s v2, someone else's\n",
            "`[slug]` isn't a pattern that also matches `s`"
        );
    }
}
