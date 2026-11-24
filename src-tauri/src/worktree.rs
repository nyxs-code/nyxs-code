use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

// A remote project's worktrees (`ssh://`), on its machine.
#[path = "worktree_remote.rs"]
mod remote;

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

/// Held around every `git worktree …` this process runs. Git doesn't guard its worktree records
/// against itself: an `add` or `prune` reads every `.git/worktrees/*/commondir`, so parallel
/// agents starting at once failed on the folder another `add` had only half written. Only the
/// git call waits; seeding the new tree still runs in parallel.
static WORKTREE_GIT: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn worktree_git_lock() -> std::sync::MutexGuard<'static, ()> {
    WORKTREE_GIT.lock().unwrap_or_else(|e| e.into_inner())
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let _serial = (args.first() == Some(&"worktree")).then(worktree_git_lock);
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| format!("Couldn't run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!(
                "git {} failed (exit code {:?})",
                args.join(" "),
                out.status.code()
            )
        } else {
            stderr
        })
    }
}

fn git_raw(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| format!("Couldn't run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            stderr
        })
    }
}

/// Exit code and raw stdout: file contents aren't always UTF-8, and `merge-file` reports conflicts
/// through its exit code.
fn git_bytes(cwd: &Path, args: &[&str]) -> Result<(i32, Vec<u8>), String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| format!("Couldn't run git: {e}"))?;
    Ok((out.status.code().unwrap_or(-1), out.stdout))
}

/// A file name nobody else is using: parallel sub-agents create and merge back at the same time,
/// and another Nyxs may have the same project open.
fn unique_name(stem: &str, ext: &str) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{stem}-{}-{ms}-{n}.{ext}", std::process::id())
}

fn data_dir(workspace: &Path) -> Result<PathBuf, String> {
    let ws = workspace.to_string_lossy();
    let dir = crate::project_paths::project_data_dir(ws.as_ref())
        .unwrap_or_else(|| workspace.join(".nyxs"));
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {dir:?}: {e}"))?;
    Ok(dir)
}

/// The repository root: patches and `--full-name` paths are relative to it, not to a workspace
/// opened on a subfolder.
fn repo_root(workspace: &Path) -> PathBuf {
    git(workspace, &["rev-parse", "--show-toplevel"])
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace.to_path_buf())
}

#[cfg(test)]
fn git_with_config(cwd: &Path, config: &[&str], args: &[&str]) -> Result<String, String> {
    let mut full: Vec<&str> = Vec::with_capacity(config.len() * 2 + args.len());
    for c in config {
        full.push("-c");
        full.push(c);
    }
    full.extend_from_slice(args);
    git(cwd, &full)
}

fn sanitize_id(id: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "wt".to_string()
    } else {
        trimmed.to_string()
    }
}

fn worktree_path(workspace: &str, id: &str, location: Option<&str>) -> PathBuf {
    let project = crate::project_paths::encode_project_path(workspace);
    if let Some(base) = location.map(str::trim).filter(|s| !s.is_empty()) {
        let base_path =
            if let Some(rest) = base.strip_prefix("~/").or_else(|| base.strip_prefix("~\\")) {
                crate::project_paths::home_dir()
                    .map(|h| h.join(rest))
                    .unwrap_or_else(|| PathBuf::from(base))
            } else {
                PathBuf::from(base)
            };
        return base_path.join(&project).join(sanitize_id(id));
    }

    if let Some(home) = crate::project_paths::home_dir() {
        return home
            .join(".nyxs")
            .join("worktree")
            .join(&project)
            .join(sanitize_id(id));
    }

    Path::new(workspace)
        .join(".nyxs")
        .join("worktree")
        .join(sanitize_id(id))
}

/// The linked worktrees in `git worktree list --porcelain`, without the main working tree (always
/// listed first): that one is never Nyxs' to rebuild or clean up.
fn linked_worktrees(porcelain: &str) -> impl Iterator<Item = &str> {
    porcelain
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .skip(1)
}

fn path_text(path: &str, windows: bool) -> String {
    let s = path.replace('\\', "/");
    let s = s.trim_end_matches('/');
    if windows {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// Whether `path` is one of the linked worktrees git lists, as a whole entry: a substring match
/// took `sub-1` for `sub-10`. Both sides are compared as text, so `path` must already be written
/// the way git prints it (canonical); on Windows the case doesn't count.
fn lists_worktree(porcelain: &str, path: &str, windows: bool) -> bool {
    let want = path_text(path, windows);
    linked_worktrees(porcelain).any(|p| path_text(p, windows) == want)
}

/// A local path as `git worktree list` prints it: canonical (junctions and links resolved, the
/// real case), with forward slashes. Of a path that doesn't exist yet, its deepest existing folder
/// is resolved and the rest appended.
fn path_key(path: &Path) -> String {
    let mut base = path.to_path_buf();
    let mut rest = Vec::new();
    let real = loop {
        if let Ok(real) = fs::canonicalize(&base) {
            break rest.iter().rev().fold(real, |acc: PathBuf, c| acc.join(c));
        }
        match (base.file_name().map(|n| n.to_os_string()), base.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                base = parent.to_path_buf();
            }
            _ => break path.to_path_buf(),
        }
    };
    let s = real.to_string_lossy();
    let s = match s.strip_prefix(r"\\?\UNC\") {
        Some(unc) => format!(r"\\{unc}"),
        None => s.strip_prefix(r"\\?\").unwrap_or(&s).to_string(),
    };
    path_text(&s, cfg!(windows))
}

/// Whether the project's git lists the folder `path` as one of its linked worktrees.
fn is_listed_worktree(workspace: &Path, path: &Path) -> bool {
    let Ok(porcelain) = git(workspace, &["worktree", "list", "--porcelain"]) else {
        return false;
    };
    let key = path_key(path);
    let listed = linked_worktrees(&porcelain).any(|p| path_key(Path::new(p)) == key);
    listed
}

/// Deletes a leftover folder in Nyxs' worktree root that git doesn't list as a worktree. One that
/// still holds a `.git` is a checkout git didn't match (a path written another way, a lost
/// record) and may hold uncommitted work, so it is never deleted.
fn remove_leftover(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path.join(".git")).is_ok() {
        return Err(format!(
            "{} holds a git checkout (.git) that the project doesn't list as one of its worktrees, so it was left as it is. Move it or delete it by hand.",
            path.to_string_lossy()
        ));
    }
    fs::remove_dir_all(path)
        .map_err(|e| format!("Couldn't clean up {}: {e}", path.to_string_lossy()))
}

fn is_git_repo(workspace: &str) -> bool {
    git(
        Path::new(workspace),
        &["rev-parse", "--is-inside-work-tree"],
    )
    .map(|s| s == "true")
    .unwrap_or(false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub id: String,
    pub path: String,
    pub head: String,
}

#[tauri::command(async)]
pub fn worktree_supported(workspace: String) -> bool {
    if let Some(r) = crate::remote::parse(&workspace) {
        return remote::supported(&r);
    }
    is_git_repo(&workspace)
        && git(Path::new(&workspace), &["rev-parse", "--verify", "HEAD"]).is_ok()
}

/// Replays the workspace's uncommitted work (tracked changes plus untracked files) into a fresh
/// worktree and commits it as the base. A worktree straight from HEAD misses exactly the files the
/// user is working on, and the agent then can't see or extend them. Committing the snapshot also
/// means a later `git diff --cached` there holds only what the agent changed.
fn seed_worktree(workspace: &Path, wt: &Path) -> Result<(), String> {
    let diff = git_raw(workspace, &["diff", "--binary", "--no-color", "HEAD"])?;
    if !diff.trim().is_empty() {
        // One file per agent: parallel sub-agents seed at the same time, and a shared name let one
        // delete the patch while another was still applying it.
        let patch = data_dir(workspace)?.join(unique_name("worktree-seed", "patch"));
        fs::write(&patch, &diff).map_err(|e| format!("Couldn't write the initial patch: {e}"))?;
        let patch_str = patch.to_string_lossy().to_string();
        let applied = git(
            wt,
            &["apply", "--binary", "--whitespace=nowarn", &patch_str],
        );
        let _ = fs::remove_file(&patch);
        applied?;
    }

    // Untracked files appear in no diff, so copy them over: the agent has to be able to read them.
    let root = repo_root(workspace);
    let others = git_raw(
        workspace,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "--full-name",
            "-z",
        ],
    )?;
    for rel in others.split('\0').filter(|s| !s.is_empty()) {
        let from = root.join(rel);
        if !from.is_file() {
            continue;
        }
        let to = wt.join(rel);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {parent:?}: {e}"))?;
        }
        fs::copy(&from, &to).map_err(|e| format!("Couldn't copy {rel}: {e}"))?;
    }

    let _ = git(wt, &["add", "-A"]);
    // An empty snapshot is already the base commit, so only commit when there is something to record.
    if git(wt, &["diff", "--cached", "--quiet"]).is_err() {
        // The project's hooks (husky, lint-staged…) would lint the user's whole work in progress on
        // a commit that is ours and never leaves the worktree, and a failing one kept the agent from
        // starting. `.git` is a file in a worktree, so nothing can exist under it: no hooks run.
        let no_hooks = format!(
            "core.hooksPath={}",
            wt.join(".git").join("no-hooks").to_string_lossy()
        );
        git(
            wt,
            &[
                "-c",
                "user.name=Nyxs",
                "-c",
                "user.email=nyxs@local",
                "-c",
                "commit.gpgsign=false",
                "-c",
                &no_hooks,
                "commit",
                "-q",
                "--no-verify",
                "-m",
                "nyxs: workspace snapshot",
            ],
        )?;
    }
    Ok(())
}

/// Sub-agent worktrees left behind by a run that was killed (the app closed mid-task). Their ids are
/// unique per run, so nothing reuses those folders; one older than a day can't belong to a live agent.
const STALE_SUBAGENT_WORKTREE: Duration = Duration::from_secs(24 * 60 * 60);

fn prune_stale_subagent_worktrees(
    workspace: &str,
    current: &Path,
    location: &Option<String>,
    branch_prefix: &Option<String>,
) {
    let Some(root) = current.parent() else { return };
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("sub-") || path == current || !path.is_dir() {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.created().or_else(|_| m.modified()))
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > STALE_SUBAGENT_WORKTREE);
        if !stale {
            continue;
        }
        let _ = worktree_remove(
            workspace.to_string(),
            name,
            Some(true),
            location.clone(),
            branch_prefix.clone(),
        );
        if path.exists() {
            if let Err(e) = remove_leftover(&path) {
                eprintln!("[worktree] stale sub-agent worktree kept: {e}");
            }
        }
    }
}

// Off the UI thread: seeding copies the working tree, which can take a moment on a big project.
#[tauri::command(async)]
pub fn worktree_create(
    workspace: String,
    id: String,
    location: Option<String>,
    branch_prefix: Option<String>,
) -> Result<String, String> {
    if let Some(r) = crate::remote::parse(&workspace) {
        return remote::create(&r, &id, location.as_deref(), branch_prefix.as_deref());
    }
    if !is_git_repo(&workspace) {
        return Err("The workspace isn't a git repository (worktrees require git).".into());
    }

    if git(Path::new(&workspace), &["rev-parse", "--verify", "HEAD"]).is_err() {
        return Err("The repository has no commits yet; can't create a worktree.".into());
    }
    let path = worktree_path(&workspace, &id, location.as_deref());
    let path_str = path.to_string_lossy().to_string();
    prune_stale_subagent_worktrees(&workspace, &path, &location, &branch_prefix);

    if path.exists() {
        // Left over from an interrupted run: rebuild it rather than hand over a stale tree. Callers
        // pass ids unique to their run, so this never takes the tree of an agent still working. The
        // path is always inside Nyxs's own worktree root, so a folder git no longer knows is ours.
        if is_listed_worktree(Path::new(&workspace), &path) {
            worktree_remove(
                workspace.clone(),
                id.clone(),
                Some(true),
                location.clone(),
                branch_prefix.clone(),
            )?;
        } else {
            remove_leftover(&path)?;
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {parent:?}: {e}"))?;
    }

    let prefix = branch_prefix.as_deref().map(str::trim).unwrap_or("");
    if !prefix.is_empty() {
        let branch = format!("{}{}", prefix, sanitize_id(&id));
        git(
            Path::new(&workspace),
            &["worktree", "add", "-b", &branch, &path_str, "HEAD"],
        )?;
    } else {
        git(
            Path::new(&workspace),
            &["worktree", "add", "--detach", &path_str, "HEAD"],
        )?;
    }

    if let Err(e) = seed_worktree(Path::new(&workspace), &path) {
        let _ = worktree_remove(
            workspace.clone(),
            id.clone(),
            Some(true),
            location.clone(),
            branch_prefix.clone(),
        );
        return Err(e);
    }
    Ok(path_str)
}

/// Copies into a fresh worktree the git-ignored files `.worktreeinclude` names (gitignore
/// patterns, like Claude Code Desktop's): `.env` and other local files a checkout lacks. Only
/// files that are both ignored and listed are copied.
fn copy_worktree_includes(workspace: &Path, wt: &Path) -> usize {
    let root = repo_root(workspace);
    let include = root.join(".worktreeinclude");
    if !include.is_file() {
        return 0;
    }
    let include_str = include.to_string_lossy().to_string();
    let listed = |extra: &[&str]| -> Vec<String> {
        let mut args = vec!["ls-files", "--others", "--ignored", "--full-name", "-z"];
        args.extend_from_slice(extra);
        git_raw(&root, &args)
            .map(|out| {
                out.split('\0')
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default()
    };
    let wanted = listed(&["--exclude-from", &include_str]);
    if wanted.is_empty() {
        return 0;
    }
    let ignored: std::collections::HashSet<String> =
        listed(&["--exclude-standard"]).into_iter().collect();
    let mut copied = 0;
    for rel in wanted.iter().filter(|r| ignored.contains(*r)) {
        let from = root.join(rel);
        let to = wt.join(rel);
        if !from.is_file() || to.exists() {
            continue;
        }
        if let Some(parent) = to.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::copy(&from, &to).is_ok() {
            copied += 1;
        }
    }
    copied
}

/// A session's own worktree (Settings' location, one folder per session) on the branch
/// `branch`, made from `base` (HEAD when none was picked in the composer) with nothing seeded:
/// the session's commits are only its own. An existing one is handed back as it is, so
/// reopening the session finds its work.
#[tauri::command(async)]
pub fn session_worktree_create(
    workspace: String,
    id: String,
    branch: String,
    location: Option<String>,
    base: Option<String>,
) -> Result<String, String> {
    if let Some(r) = crate::remote::parse(&workspace) {
        return remote::session_create(&r, &id, &branch, location.as_deref());
    }
    let ws = Path::new(&workspace);
    if !is_git_repo(&workspace) {
        return Err("The project isn't a git repository (worktrees require git).".into());
    }
    if git(ws, &["rev-parse", "--verify", "HEAD"]).is_err() {
        return Err("The repository has no commits yet; can't create a worktree.".into());
    }
    let branch = branch.trim();
    if branch.is_empty() || git(ws, &["check-ref-format", "--branch", branch]).is_err() {
        return Err(format!("\"{branch}\" isn't a valid branch name."));
    }
    let path = worktree_path(&workspace, &id, location.as_deref());
    let path_str = path.to_string_lossy().to_string();
    if path.exists() && is_listed_worktree(ws, &path) {
        return Ok(path_str);
    }
    let _ = git(ws, &["worktree", "prune"]);
    if path.exists() {
        // Nyxs's own folder that git doesn't know, left by an interrupted run.
        remove_leftover(&path)?;
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {parent:?}: {e}"))?;
    }
    let exists = git(
        ws,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok();
    if exists {
        git(ws, &["worktree", "add", &path_str, branch])?;
    } else {
        let base = match base.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
            // Only a local branch: a name git takes as an option or a revision expression is refused.
            Some(b)
                if git(
                    ws,
                    &[
                        "rev-parse",
                        "--verify",
                        "--quiet",
                        &format!("refs/heads/{b}"),
                    ],
                )
                .is_ok() =>
            {
                b.to_string()
            }
            Some(b) => return Err(format!("\"{b}\" isn't a branch of this repository.")),
            None => "HEAD".to_string(),
        };
        git(ws, &["worktree", "add", "-b", branch, &path_str, &base])?;
    }
    copy_worktree_includes(ws, &path);
    Ok(path_str)
}

/// Takes a session's worktree away and keeps its branch (it may have a PR). Without `force`,
/// git refuses when the worktree has uncommitted changes.
#[tauri::command(async)]
pub fn session_worktree_remove(
    workspace: String,
    path: String,
    force: Option<bool>,
) -> Result<(), String> {
    if let Some(r) = crate::remote::parse(&workspace) {
        return remote::session_remove(&r, &path, force.unwrap_or(false));
    }
    let ws = Path::new(&workspace);
    if Path::new(&path).exists() {
        let mut args = vec!["worktree", "remove"];
        if force.unwrap_or(false) {
            args.push("--force");
        }
        args.push(&path);
        git(ws, &args)?;
    }
    let _ = git(ws, &["worktree", "prune"]);
    Ok(())
}

#[tauri::command(async)]
pub fn worktree_remove(
    workspace: String,
    id: String,
    force: Option<bool>,
    location: Option<String>,
    branch_prefix: Option<String>,
) -> Result<(), String> {
    if let Some(r) = crate::remote::parse(&workspace) {
        return remote::remove(
            &r,
            &id,
            force.unwrap_or(false),
            location.as_deref(),
            branch_prefix.as_deref(),
        );
    }
    let path = worktree_path(&workspace, &id, location.as_deref());
    let path_str = path.to_string_lossy().to_string();
    if path.exists() {
        let mut args = vec!["worktree", "remove"];
        if force.unwrap_or(false) {
            args.push("--force");
        }
        args.push(&path_str);

        git(Path::new(&workspace), &args)?;
    }

    let _ = git(Path::new(&workspace), &["worktree", "prune"]);

    let prefix = branch_prefix.as_deref().map(str::trim).unwrap_or("");
    if !prefix.is_empty() {
        let branch = format!("{}{}", prefix, sanitize_id(&id));
        let _ = git(Path::new(&workspace), &["branch", "-D", &branch]);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn worktree_list(
    workspace: String,
    location: Option<String>,
) -> Result<Vec<WorktreeInfo>, String> {
    if let Some(r) = crate::remote::parse(&workspace) {
        return remote::list(&r, location.as_deref());
    }
    if !is_git_repo(&workspace) {
        return Ok(Vec::new());
    }
    let porcelain = git(Path::new(&workspace), &["worktree", "list", "--porcelain"])?;
    let managed_root = path_key(&worktree_path(&workspace, "", location.as_deref()));
    Ok(parse_worktree_list(
        &porcelain,
        &managed_root,
        |p| path_key(Path::new(p)),
        |p| p.to_string(),
    ))
}

/// Nyxs' own worktrees in `git worktree list --porcelain`: the ones under `managed_root`
/// (`worktree_path` with an empty id, written as `key` writes each listed path) or an older
/// `.nyxs/worktrees`, each path as `shown`.
fn parse_worktree_list(
    porcelain: &str,
    managed_root: &str,
    key: impl Fn(&str) -> String,
    shown: impl Fn(&str) -> String,
) -> Vec<WorktreeInfo> {
    // With the slash, so another project whose folder name starts the same isn't taken for this one.
    let managed_root = format!("{}/", managed_root.trim_end_matches("/wt"));
    let mut out = Vec::new();
    let mut cur_path: Option<String> = None;
    let mut cur_head = String::new();
    let flush = |path: &mut Option<String>, head: &mut String, out: &mut Vec<WorktreeInfo>| {
        if let Some(p) = path.take() {
            let norm = p.replace('\\', "/");
            if norm.contains("/.nyxs/worktrees/") || key(&p).starts_with(&managed_root) {
                let id = norm.rsplit('/').next().unwrap_or("").to_string();
                out.push(WorktreeInfo {
                    id,
                    path: shown(&p),
                    head: std::mem::take(head),
                });
            } else {
                head.clear();
            }
        }
    };
    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut cur_path, &mut cur_head, &mut out);
            cur_path = Some(p.to_string());
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            cur_head = h.to_string();
        }
    }
    flush(&mut cur_path, &mut cur_head, &mut out);
    out
}

#[tauri::command(async)]
pub fn worktree_export_patch(
    workspace: String,
    id: String,
    location: Option<String>,
) -> Result<String, String> {
    if let Some(r) = crate::remote::parse(&workspace) {
        return remote::export_patch(&r, &id, location.as_deref());
    }
    let path = worktree_path(&workspace, &id, location.as_deref());
    if !path.exists() {
        return Err(format!(
            "The worktree '{}' doesn't exist.",
            sanitize_id(&id)
        ));
    }

    git(&path, &["add", "-A"])?;

    // Unquoted paths (accents, spaces) so the caller can read the changed files off the headers, and
    // no rename detection: every file is an add, a delete or a change, which the merge can handle.
    let patch = git_raw(
        &path,
        &[
            "-c",
            "core.quotePath=false",
            "diff",
            "--cached",
            "--binary",
            "--no-renames",
        ],
    )?;

    let _ = git(&path, &["reset", "-q"]);
    Ok(patch)
}

/// One file of a sub-agent's patch, read off its header. `--binary` implies `--full-index`, so
/// `base` and `theirs` are full blob ids, all in the object store the worktree shares with the project.
struct FilePatch {
    path: String,
    base: Option<String>,
    theirs: Option<String>,
    binary: bool,
}

fn parse_patch(patch: &str) -> Result<Vec<FilePatch>, String> {
    let mut files = Vec::new();
    let mut sections: Vec<Vec<&str>> = Vec::new();
    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            sections.push(vec![line]);
        } else if let Some(cur) = sections.last_mut() {
            cur.push(line);
        }
    }
    for lines in sections {
        let rest = &lines[0]["diff --git ".len()..];
        // Without renames both sides name the same file: "a/<path> b/<path>".
        let n = rest.len().saturating_sub(5) / 2;
        let path = match (
            rest.get(..2),
            rest.get(2..2 + n),
            rest.get(2 + n..5 + n),
            rest.get(5 + n..),
        ) {
            (Some("a/"), Some(a), Some(" b/"), Some(b)) if a == b && rest.len() == 5 + 2 * n => {
                a.to_string()
            }
            _ => return Err(format!("Couldn't parse the header \"{}\"", lines[0])),
        };
        let mut ids: Option<(String, String)> = None;
        let mut binary = false;
        for l in &lines[1..] {
            if l.starts_with("@@") {
                break;
            }
            if l.starts_with("rename from") || l.starts_with("copy from") {
                return Err(format!("{path}: renamed"));
            }
            if l.starts_with("GIT binary patch") || l.starts_with("Binary files ") {
                binary = true;
            }
            if let Some(v) = l.strip_prefix("index ") {
                let range = v.split(' ').next().unwrap_or("");
                if let Some((a, b)) = range.split_once("..") {
                    ids = Some((a.to_string(), b.to_string()));
                }
            }
        }
        // Only the mode changed: there is no content to bring back.
        let Some((a, b)) = ids else { continue };
        let blob = |id: String| {
            if id.chars().all(|c| c == '0') {
                None
            } else {
                Some(id)
            }
        };
        files.push(FilePatch {
            path,
            base: blob(a),
            theirs: blob(b),
            binary,
        });
    }
    Ok(files)
}

/// A blob as it would be checked out at `path` (line endings and other filters applied), so it
/// compares byte for byte with the file on disk.
fn blob_for(root: &Path, id: &str, path: &str) -> Result<Vec<u8>, String> {
    let path_arg = format!("--path={path}");
    match git_bytes(root, &["cat-file", "--filters", &path_arg, id])? {
        (0, bytes) => Ok(bytes),
        _ => Err(format!("{path}: version {id} is missing")),
    }
}

enum Merged {
    Write(PathBuf, Vec<u8>),
    Delete(PathBuf),
}

/// What merging one file of a patch takes, from its three versions (None: not there): base is
/// what the agent started from, theirs what it left, ours the project's file now.
enum FilePlan {
    /// The project already has the agent's version.
    Same,
    /// Only the agent changed it: write its version (None: delete the file).
    Take(Option<Vec<u8>>),
    /// Both changed it, in text: merge line by line.
    Merge {
        ours: Vec<u8>,
        base: Vec<u8>,
        theirs: Vec<u8>,
    },
    Conflict,
}

fn plan_file(
    binary: bool,
    ours: Option<Vec<u8>>,
    base: Option<Vec<u8>>,
    theirs: Option<Vec<u8>>,
) -> FilePlan {
    if ours == theirs {
        return FilePlan::Same;
    }
    if ours == base {
        return FilePlan::Take(theirs);
    }
    // Both sides changed it: only two text versions of the same file can be merged line by line.
    match (ours, base, theirs) {
        (Some(ours), Some(base), Some(theirs)) if !binary => FilePlan::Merge { ours, base, theirs },
        _ => FilePlan::Conflict,
    }
}

/// A three-way merge per file, entirely in memory: base is the snapshot the agent started from,
/// theirs what it left, ours the project's file now, uncommitted edits included. `git apply --3way`
/// wants the file to match the index, and on a conflict writes markers into it (its `--check`
/// passes all the same), so it can't be used on the user's project.
fn merge_patch(root: &Path, dir: &Path, patch: &str) -> Result<Vec<Merged>, String> {
    let conflict = |path: &str| {
        format!("{path}: the project changed on those same lines while the agent was running")
    };
    let mut out = Vec::new();
    for f in parse_patch(patch)? {
        let target = root.join(&f.path);
        let ours = fs::read(&target).ok();
        let base = f
            .base
            .as_deref()
            .map(|id| blob_for(root, id, &f.path))
            .transpose()?;
        let theirs = f
            .theirs
            .as_deref()
            .map(|id| blob_for(root, id, &f.path))
            .transpose()?;
        let (ours, base, theirs) = match plan_file(f.binary, ours, base, theirs) {
            FilePlan::Same => continue,
            FilePlan::Take(Some(bytes)) => {
                out.push(Merged::Write(target, bytes));
                continue;
            }
            FilePlan::Take(None) => {
                out.push(Merged::Delete(target));
                continue;
            }
            FilePlan::Conflict => return Err(conflict(&f.path)),
            FilePlan::Merge { ours, base, theirs } => (ours, base, theirs),
        };
        let stem = unique_name("merge", "tmp");
        let sides: Vec<PathBuf> = ["ours", "base", "theirs"]
            .iter()
            .map(|s| dir.join(format!("{s}-{stem}")))
            .collect();
        let merged = (|| {
            for (p, bytes) in sides.iter().zip([&ours, &base, &theirs]) {
                fs::write(p, bytes)
                    .map_err(|e| format!("Couldn't prepare the merge of {}: {e}", f.path))?;
            }
            let s: Vec<String> = sides
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            git_bytes(
                root,
                &[
                    "merge-file",
                    "-p",
                    "-L",
                    "project",
                    "-L",
                    "base",
                    "-L",
                    "agent",
                    &s[0],
                    &s[1],
                    &s[2],
                ],
            )
        })();
        for p in &sides {
            let _ = fs::remove_file(p);
        }
        match merged? {
            (0, bytes) => out.push(Merged::Write(target, bytes)),
            _ => return Err(conflict(&f.path)),
        }
    }
    Ok(out)
}

/// Brings a sub-agent's patch back into the project, all or nothing: on a conflict nothing is
/// written and the patch is kept for review. `dry_run` only checks, so the caller can record the
/// files' "before" knowing the apply will go through.
fn apply_patch(workspace: &str, patch: &str, dry_run: bool) -> Result<(), String> {
    if let Some(r) = crate::remote::parse(workspace) {
        return remote::apply_patch(&r, patch, dry_run);
    }
    if patch.trim().is_empty() {
        return Ok(());
    }
    if !is_git_repo(workspace) {
        return Err("The workspace isn't a git repository.".into());
    }
    let root = repo_root(Path::new(workspace));
    let dir = data_dir(Path::new(workspace))?;
    let tmp = dir.join(unique_name("apply", "patch"));
    let patch = if patch.ends_with('\n') {
        patch.to_string()
    } else {
        format!("{patch}\n")
    };
    fs::write(&tmp, &patch).map_err(|e| format!("Couldn't write the patch: {e}"))?;
    let tmp_str = tmp.to_string_lossy().to_string();

    // Plain apply goes by context and works over the user's uncommitted edits, the usual case. When
    // the project moved on in those spots (the user, or another agent merged first), merge per file.
    let plan = if git(
        &root,
        &["apply", "--check", "--whitespace=nowarn", &tmp_str],
    )
    .is_ok()
    {
        Ok(None)
    } else {
        merge_patch(&root, &dir, &patch).map(Some)
    };
    let written = match plan {
        Ok(_) if dry_run => Ok(()),
        Ok(None) => git(&root, &["apply", "--whitespace=nowarn", &tmp_str]).map(|_| ()),
        Ok(Some(merged)) => {
            for m in merged {
                let res = match m {
                    Merged::Write(p, bytes) => p
                        .parent()
                        .map_or(Ok(()), fs::create_dir_all)
                        .and_then(|_| fs::write(&p, bytes))
                        .map_err(|e| format!("Couldn't write {}: {e}", p.to_string_lossy())),
                    Merged::Delete(p) => fs::remove_file(&p)
                        .map_err(|e| format!("Couldn't delete {}: {e}", p.to_string_lossy())),
                };
                if let Err(e) = res {
                    let _ = fs::remove_file(&tmp);
                    return Err(format!(
                        "the sub-agent's patch was only partly applied: {e}"
                    ));
                }
            }
            Ok(())
        }
        Err(reason) => {
            // A name of its own: with several agents failing, a shared one kept only the last patch.
            let kept = dir.join(unique_name("apply-failed", "patch"));
            let _ = fs::rename(&tmp, &kept);
            return Err(format!(
                "The sub-agent's patch couldn't be applied ({reason}). The project was left as it was; the patch is saved at {} for manual review.",
                kept.to_string_lossy()
            ));
        }
    };
    let _ = fs::remove_file(&tmp);
    written
}

#[tauri::command(async)]
pub fn worktree_check_patch(workspace: String, patch: String) -> Result<(), String> {
    apply_patch(&workspace, &patch, true)
}

#[tauri::command(async)]
pub fn worktree_apply_patch(workspace: String, patch: String) -> Result<(), String> {
    apply_patch(&workspace, &patch, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_repo(name: &str) -> PathBuf {
        std::env::set_var(
            "NYXS_PROJECTS_ROOT",
            std::env::temp_dir().join("nyxs-test-projects"),
        );
        let dir = std::env::temp_dir().join(format!("nyxs-wt-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]).unwrap();
        fs::write(dir.join("a.txt"), "line 1\n").unwrap();
        git(&dir, &["add", "-A"]).unwrap();
        git_with_config(
            &dir,
            &[
                "user.email=t@t.dev",
                "user.name=Test",
                "commit.gpgsign=false",
            ],
            &["commit", "-q", "-m", "init"],
        )
        .unwrap();
        dir
    }

    #[test]
    fn a_session_worktree_has_its_branch_and_the_listed_local_files() {
        let repo = tmp_repo("session");
        let ws = repo.to_string_lossy().to_string();
        fs::write(repo.join(".gitignore"), ".env\nsecret.key\nbuild/\n").unwrap();
        fs::write(repo.join(".worktreeinclude"), ".env\n").unwrap();
        fs::write(repo.join(".env"), "TOKEN=1\n").unwrap();
        fs::write(repo.join("secret.key"), "nope\n").unwrap();
        // Uncommitted work in the project stays out: the session starts from HEAD.
        fs::write(repo.join("a.txt"), "changed\n").unwrap();

        let path = session_worktree_create(
            ws.clone(),
            "brave-otter".into(),
            "Nyxs/brave-otter".into(),
            None,
            None,
        )
        .unwrap();
        let wt = Path::new(&path);
        assert_eq!(fs::read_to_string(wt.join(".env")).unwrap(), "TOKEN=1\n");
        assert!(
            !wt.join("secret.key").exists(),
            "only files .worktreeinclude lists are copied"
        );
        assert_eq!(
            fs::read_to_string(wt.join("a.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "line 1\n"
        );
        assert_eq!(
            git(wt, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(),
            "Nyxs/brave-otter"
        );

        // Reopening the session finds the same worktree, with its work.
        fs::write(wt.join("b.txt"), "work\n").unwrap();
        assert_eq!(
            session_worktree_create(
                ws.clone(),
                "brave-otter".into(),
                "Nyxs/brave-otter".into(),
                None,
                None
            )
            .unwrap(),
            path
        );
        assert!(wt.join("b.txt").exists());

        // Uncommitted work blocks a plain removal; forced, it goes and the branch stays.
        assert!(session_worktree_remove(ws.clone(), path.clone(), None).is_err());
        session_worktree_remove(ws.clone(), path.clone(), Some(true)).unwrap();
        assert!(!wt.exists());
        assert!(git(
            &repo,
            &["rev-parse", "--verify", "refs/heads/Nyxs/brave-otter"]
        )
        .is_ok());
        assert!(
            session_worktree_create(ws, "x".into(), "bad branch name".into(), None, None).is_err()
        );
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_session_worktree_starts_from_the_branch_picked_in_the_composer() {
        let repo = tmp_repo("session-base");
        let ws = repo.to_string_lossy().to_string();
        let loc = tmp_location("session-base");
        let location = Some(loc.to_string_lossy().to_string());
        git(&repo, &["branch", "feature"]).unwrap();
        let feature = git(&repo, &["rev-parse", "feature"]).unwrap();
        fs::write(repo.join("a.txt"), "on main\n").unwrap();
        git(
            &repo,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=Test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qam",
                "main moves on",
            ],
        )
        .unwrap();

        let path = session_worktree_create(
            ws.clone(),
            "s-base".into(),
            "Nyxs/s-base".into(),
            location.clone(),
            Some("feature".into()),
        )
        .unwrap();
        assert_eq!(
            git(Path::new(&path), &["rev-parse", "HEAD"]).unwrap(),
            feature
        );
        // Not a branch of the repository: refused, nothing made.
        let err = session_worktree_create(
            ws,
            "s-bad".into(),
            "Nyxs/s-bad".into(),
            location,
            Some("--orphan".into()),
        )
        .unwrap_err();
        assert!(err.contains("isn't a branch"), "{err}");
        let _ = fs::remove_dir_all(&loc);
        let _ = fs::remove_dir_all(&repo);
    }

    /// A folder for the test's worktrees, so they stay out of the real `~/.nyxs/worktree`.
    fn tmp_location(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nyxs-wt-loc-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `link` pointing at the folder `target`: a junction on Windows (no admin rights needed).
    fn dir_link(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            let out = Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(out.status.success(), "{out:?}");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[test]
    fn reopening_a_session_through_another_spelling_keeps_its_work() {
        let repo = tmp_repo("respell");
        let ws = repo.to_string_lossy().to_string();
        let loc = tmp_location("respell");
        let real = loc.join("real");
        fs::create_dir_all(&real).unwrap();
        let link = loc.join("link");
        dir_link(&real, &link);
        let create = |location: String| {
            session_worktree_create(
                ws.clone(),
                "otter".into(),
                "Nyxs/otter".into(),
                Some(location),
                None,
            )
        };
        let path = create(real.to_string_lossy().into()).unwrap();
        let wip = Path::new(&path).join("wip.txt");
        fs::write(&wip, "uncommitted\n").unwrap();

        // git prints its worktrees canonical: links resolved and, on Windows, the real case.
        let mut spellings = vec![link.to_string_lossy().to_string()];
        if cfg!(windows) {
            spellings.push(real.to_string_lossy().to_uppercase());
        }
        for other in spellings {
            let again = create(other.clone());
            assert!(again.is_ok(), "{other}: {again:?}");
            assert_eq!(
                fs::read_to_string(&wip).ok().as_deref(),
                Some("uncommitted\n"),
                "{other}"
            );
        }
        let _ = fs::remove_dir_all(&loc);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_checkout_git_does_not_list_is_never_deleted() {
        let repo = tmp_repo("unlisted");
        let ws = repo.to_string_lossy().to_string();
        let loc = tmp_location("unlisted");
        let location = Some(loc.to_string_lossy().to_string());
        let path = session_worktree_create(
            ws.clone(),
            "lost".into(),
            "Nyxs/lost".into(),
            location.clone(),
            None,
        )
        .unwrap();
        let wip = Path::new(&path).join("wip.txt");
        fs::write(&wip, "uncommitted\n").unwrap();
        // The project lost its record of the worktree; the folder and its work are still there.
        fs::remove_dir_all(repo.join(".git").join("worktrees").join("lost")).unwrap();

        let err = session_worktree_create(
            ws.clone(),
            "lost".into(),
            "Nyxs/lost".into(),
            location,
            None,
        )
        .unwrap_err();
        assert!(err.contains(".git"), "{err}");
        assert_eq!(fs::read_to_string(&wip).unwrap(), "uncommitted\n");
        let _ = fs::remove_dir_all(&loc);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_worktree_is_not_taken_for_another_whose_name_starts_like_it() {
        let repo = tmp_repo("prefix");
        let ws = repo.to_string_lossy().to_string();
        let loc = tmp_location("prefix");
        let location = Some(loc.to_string_lossy().to_string());
        session_worktree_create(
            ws.clone(),
            "s-10".into(),
            "Nyxs/s-10".into(),
            location.clone(),
            None,
        )
        .unwrap();
        // A leftover folder of an interrupted run, with no checkout in it.
        let leftover = worktree_path(&ws, "s-1", location.as_deref());
        fs::create_dir_all(&leftover).unwrap();
        fs::write(leftover.join("half.txt"), "x").unwrap();

        let path =
            session_worktree_create(ws.clone(), "s-1".into(), "Nyxs/s-1".into(), location, None)
                .unwrap();
        assert_eq!(
            git(Path::new(&path), &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(),
            "Nyxs/s-1"
        );
        let _ = fs::remove_dir_all(&loc);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn matches_whole_linked_worktree_entries_only() {
        let porcelain = "worktree C:/repo\nHEAD 1\nbranch refs/heads/main\n\nworktree C:/wt/proj/sub-10\nHEAD 2\ndetached\n";
        assert!(lists_worktree(porcelain, "C:/wt/proj/sub-10", false));
        assert!(lists_worktree(porcelain, r"c:\WT\proj\sub-10\", true));
        assert!(!lists_worktree(porcelain, "c:/wt/proj/sub-10", false));
        assert!(!lists_worktree(porcelain, "C:/wt/proj/sub-1", true));
        // The main working tree is never one of Nyxs' worktrees.
        assert!(!lists_worktree(porcelain, "C:/repo", true));

        let listed = parse_worktree_list(
            &format!("{porcelain}\nworktree C:/wt/proj-2/other\nHEAD 3\n"),
            "C:/wt/proj/wt",
            |p| p.to_string(),
            |p| p.to_string(),
        );
        let ids: Vec<&str> = listed.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["sub-10"],
            "another project's worktrees aren't listed"
        );
    }

    #[test]
    fn create_list_remove_roundtrip() {
        let repo = tmp_repo("roundtrip");
        let ws = repo.to_string_lossy().to_string();

        let path = worktree_create(ws.clone(), "agent-1".into(), None, None).unwrap();
        assert!(
            Path::new(&path).join("a.txt").exists(),
            "the worktree copies the tree"
        );

        let listed = worktree_list(ws.clone(), None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "agent-1");

        let path2 = worktree_create(ws.clone(), "agent-1".into(), None, None).unwrap();
        assert_eq!(path, path2);

        worktree_remove(ws.clone(), "agent-1".into(), Some(true), None, None).unwrap();
        assert!(worktree_list(ws.clone(), None).unwrap().is_empty());

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn export_and_apply_patch_round_trips_changes() {
        let repo = tmp_repo("patch");
        let ws = repo.to_string_lossy().to_string();
        let wt = worktree_create(ws.clone(), "agent-2".into(), None, None).unwrap();
        let wt_path = Path::new(&wt);

        fs::write(wt_path.join("a.txt"), "line 1\nline 2\n").unwrap();
        fs::write(wt_path.join("b.txt"), "new file\n").unwrap();

        let patch = worktree_export_patch(ws.clone(), "agent-2".into(), None).unwrap();
        assert!(patch.contains("b.txt"), "the patch includes the new file");
        assert!(
            patch.contains("line 2"),
            "the patch includes the modification"
        );

        let norm = |p: PathBuf| fs::read_to_string(p).unwrap().replace("\r\n", "\n");

        assert!(!repo.join("b.txt").exists());
        assert_eq!(norm(repo.join("a.txt")), "line 1\n");

        worktree_apply_patch(ws.clone(), patch).unwrap();
        assert!(
            repo.join("b.txt").exists(),
            "b.txt applied to the workspace"
        );
        assert_eq!(norm(repo.join("a.txt")), "line 1\nline 2\n");

        worktree_apply_patch(ws.clone(), "   ".into()).unwrap();

        worktree_remove(ws.clone(), "agent-2".into(), Some(true), None, None).unwrap();
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn worktree_starts_from_the_uncommitted_work() {
        let repo = tmp_repo("seed");
        let ws = repo.to_string_lossy().to_string();
        // What the user is working on right now is in no commit: a changed file and a new one.
        fs::write(repo.join("a.txt"), "line 1\nline 2 uncommitted\n").unwrap();
        fs::write(repo.join("new.md"), "content\n").unwrap();

        let wt = worktree_create(ws.clone(), "seed-1".into(), None, None).unwrap();
        let wt_path = Path::new(&wt);
        let norm = |p: PathBuf| fs::read_to_string(p).unwrap().replace("\r\n", "\n");
        assert_eq!(norm(wt_path.join("a.txt")), "line 1\nline 2 uncommitted\n");
        assert_eq!(norm(wt_path.join("new.md")), "content\n");

        // The agent's patch holds only what the agent did, not the snapshot it started from.
        fs::write(wt_path.join("agent.md"), "from the agent\n").unwrap();
        let patch = worktree_export_patch(ws.clone(), "seed-1".into(), None).unwrap();
        assert!(patch.contains("agent.md"));
        assert!(
            !patch.contains("a.txt"),
            "the starting state isn't the agent's work"
        );
        assert!(
            !patch.contains("new.md"),
            "neither is the new starting file"
        );

        worktree_remove(ws.clone(), "seed-1".into(), Some(true), None, None).unwrap();
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn applies_the_patch_over_unrelated_workspace_changes() {
        let repo = tmp_repo("apply-dirty");
        let ws = repo.to_string_lossy().to_string();
        fs::write(repo.join("a.txt"), "line 1\nbase\n").unwrap();

        let wt = worktree_create(ws.clone(), "ap-1".into(), None, None).unwrap();
        let wt_path = Path::new(&wt);
        fs::write(wt_path.join("a.txt"), "line 1\nagent base\n").unwrap();
        let patch = worktree_export_patch(ws.clone(), "ap-1".into(), None).unwrap();

        // The user keeps working on another file while the agent runs.
        fs::write(repo.join("other.txt"), "from the user\n").unwrap();

        worktree_apply_patch(ws.clone(), patch).unwrap();
        let norm = |p: PathBuf| fs::read_to_string(p).unwrap().replace("\r\n", "\n");
        assert_eq!(norm(repo.join("a.txt")), "line 1\nagent base\n");
        assert_eq!(
            norm(repo.join("other.txt")),
            "from the user\n",
            "unrelated files stay untouched"
        );

        worktree_remove(ws.clone(), "ap-1".into(), Some(true), None, None).unwrap();
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn refuses_a_conflicting_patch_without_touching_the_file() {
        let repo = tmp_repo("conflict");
        let ws = repo.to_string_lossy().to_string();

        let wt = worktree_create(ws.clone(), "cf-1".into(), None, None).unwrap();
        fs::write(Path::new(&wt).join("a.txt"), "from the agent\n").unwrap();
        let patch = worktree_export_patch(ws.clone(), "cf-1".into(), None).unwrap();

        // Same lines edited by the user in the meantime.
        fs::write(repo.join("a.txt"), "from the user\n").unwrap();
        let before = fs::read_to_string(repo.join("a.txt")).unwrap();

        assert!(worktree_apply_patch(ws.clone(), patch).is_err());
        assert_eq!(
            fs::read_to_string(repo.join("a.txt")).unwrap(),
            before,
            "the file isn't partly modified"
        );

        worktree_remove(ws.clone(), "cf-1".into(), Some(true), None, None).unwrap();
        let _ = fs::remove_dir_all(&repo);
    }

    fn commit_all(repo: &Path, msg: &str) {
        git(repo, &["add", "-A"]).unwrap();
        git_with_config(
            repo,
            &[
                "user.email=t@t.dev",
                "user.name=Test",
                "commit.gpgsign=false",
            ],
            &["commit", "-q", "-m", msg],
        )
        .unwrap();
    }

    fn lines(
        range: std::ops::RangeInclusive<u32>,
        edit: impl Fn(u32) -> Option<&'static str>,
    ) -> String {
        range
            .map(|i| {
                format!(
                    "{}\n",
                    edit(i).map_or_else(|| format!("line {i}"), str::to_string)
                )
            })
            .collect()
    }

    #[test]
    fn parallel_agents_all_start_from_the_uncommitted_work() {
        let repo = tmp_repo("parallel-seed");
        let ws = repo.to_string_lossy().to_string();
        fs::write(repo.join("a.txt"), "line 1\nuncommitted\n").unwrap();

        let handles: Vec<_> = (0..6)
            .map(|i| {
                let ws = ws.clone();
                // The app's default branch prefix, so each one also creates its branch at once.
                std::thread::spawn(move || {
                    worktree_create(ws, format!("par-{i}"), None, Some("Nyxs".into()))
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        for (i, r) in results.iter().enumerate() {
            let wt = r
                .as_ref()
                .unwrap_or_else(|e| panic!("agent {i} didn't start: {e}"));
            let a = fs::read_to_string(Path::new(wt).join("a.txt"))
                .unwrap()
                .replace("\r\n", "\n");
            assert_eq!(a, "line 1\nuncommitted\n");
        }

        for i in 0..6 {
            worktree_remove(
                ws.clone(),
                format!("par-{i}"),
                Some(true),
                None,
                Some("Nyxs".into()),
            )
            .unwrap();
        }
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn the_snapshot_commit_skips_the_projects_hooks() {
        let repo = tmp_repo("hooks");
        let ws = repo.to_string_lossy().to_string();
        let hooks = repo.join(".git").join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        fs::write(hooks.join("pre-commit"), "#!/bin/sh\nexit 1\n").unwrap();
        fs::write(hooks.join("commit-msg"), "#!/bin/sh\nexit 1\n").unwrap();
        fs::write(repo.join("a.txt"), "line 1\nuncommitted\n").unwrap();

        worktree_create(ws.clone(), "hk-1".into(), None, None)
            .expect("a project hook doesn't block the agent");

        worktree_remove(ws.clone(), "hk-1".into(), Some(true), None, None).unwrap();
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_conflict_after_a_commit_leaves_no_markers() {
        // `git apply --3way` passed its own --check here and then wrote conflict markers into a.txt.
        let repo = tmp_repo("conflict-committed");
        let ws = repo.to_string_lossy().to_string();

        let wt = worktree_create(ws.clone(), "cc-1".into(), None, None).unwrap();
        fs::write(Path::new(&wt).join("a.txt"), "from the agent\n").unwrap();
        let patch = worktree_export_patch(ws.clone(), "cc-1".into(), None).unwrap();

        // The user commits the same line while the agent runs: the file matches the index again.
        fs::write(repo.join("a.txt"), "from the user\n").unwrap();
        commit_all(&repo, "user");
        let before = fs::read(repo.join("a.txt")).unwrap();

        let err = worktree_check_patch(ws.clone(), patch.clone()).unwrap_err();
        assert!(err.contains("a.txt"), "{err}");
        assert!(worktree_apply_patch(ws.clone(), patch).is_err());
        assert_eq!(
            fs::read(repo.join("a.txt")).unwrap(),
            before,
            "no conflict markers"
        );
        assert_eq!(
            git(&repo, &["status", "--porcelain"]).unwrap(),
            "",
            "no half-merged files"
        );

        worktree_remove(ws.clone(), "cc-1".into(), Some(true), None, None).unwrap();
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn merges_nearby_edits_of_two_agents() {
        let repo = tmp_repo("merge-near");
        let ws = repo.to_string_lossy().to_string();
        fs::write(repo.join("a.txt"), lines(1..=8, |_| None)).unwrap();
        commit_all(&repo, "eight lines");

        // Both agents start from the same project and edit lines two apart, inside each other's context.
        let wt1 = worktree_create(ws.clone(), "mn-1".into(), None, None).unwrap();
        let wt2 = worktree_create(ws.clone(), "mn-2".into(), None, None).unwrap();
        fs::write(
            Path::new(&wt1).join("a.txt"),
            lines(1..=8, |i| (i == 3).then_some("three from agent 1")),
        )
        .unwrap();
        fs::write(
            Path::new(&wt2).join("a.txt"),
            lines(1..=8, |i| (i == 5).then_some("five from agent 2")),
        )
        .unwrap();
        let p1 = worktree_export_patch(ws.clone(), "mn-1".into(), None).unwrap();
        let p2 = worktree_export_patch(ws.clone(), "mn-2".into(), None).unwrap();

        worktree_apply_patch(ws.clone(), p1).unwrap();
        worktree_check_patch(ws.clone(), p2.clone()).unwrap();
        worktree_apply_patch(ws.clone(), p2).unwrap();
        let a = fs::read_to_string(repo.join("a.txt"))
            .unwrap()
            .replace("\r\n", "\n");
        assert_eq!(
            a,
            lines(1..=8, |i| match i {
                3 => Some("three from agent 1"),
                5 => Some("five from agent 2"),
                _ => None,
            })
        );

        worktree_remove(ws.clone(), "mn-1".into(), Some(true), None, None).unwrap();
        worktree_remove(ws.clone(), "mn-2".into(), Some(true), None, None).unwrap();
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn every_failed_patch_is_kept_apart() {
        let repo = tmp_repo("kept");
        let ws = repo.to_string_lossy().to_string();
        let mut patches = Vec::new();
        for id in ["kp-1", "kp-2"] {
            let wt = worktree_create(ws.clone(), id.into(), None, None).unwrap();
            fs::write(
                Path::new(&wt).join("a.txt"),
                format!("from the agent {id}\n"),
            )
            .unwrap();
            patches.push(worktree_export_patch(ws.clone(), id.into(), None).unwrap());
        }
        fs::write(repo.join("a.txt"), "from the user\n").unwrap();

        let saved: Vec<String> = patches
            .into_iter()
            .map(|p| {
                let err = worktree_apply_patch(ws.clone(), p).unwrap_err();
                let at = err.find("saved at ").unwrap() + "saved at ".len();
                err[at..]
                    .trim_end_matches(" for manual review.")
                    .to_string()
            })
            .collect();
        assert_ne!(saved[0], saved[1]);
        for (path, id) in saved.iter().zip(["kp-1", "kp-2"]) {
            assert!(fs::read_to_string(path)
                .unwrap()
                .contains(&format!("from the agent {id}")));
            let _ = fs::remove_file(path);
        }

        for id in ["kp-1", "kp-2"] {
            worktree_remove(ws.clone(), id.into(), Some(true), None, None).unwrap();
        }
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn create_fails_on_non_git_dir() {
        let dir = std::env::temp_dir().join("nyxs-wt-test-nogit");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ws = dir.to_string_lossy().to_string();
        assert!(worktree_create(ws, "x".into(), None, None).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_id_is_safe() {
        assert_eq!(sanitize_id("agent/../etc"), "agent-etc");
        assert_eq!(sanitize_id("  "), "wt");
        assert_eq!(sanitize_id("ok_1-2"), "ok_1-2");
    }
}
