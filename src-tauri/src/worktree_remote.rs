//! Worktrees of a remote project (`ssh://host/path`): the same steps as the local commands in
//! `worktree.rs`, with git run on the machine (`remote::git`) and files read and written there
//! (`remote::fs`). The worktrees live on the machine, under `~/.nyxs/worktree` there.
//!
//! Two steps are done differently because each local file operation would be a trip to the
//! machine: a sub-agent's worktree is seeded with the project's whole working state through a
//! temporary index and `read-tree` (instead of a patch plus a copy of each untracked file), and
//! patches go to `git apply` on its stdin (instead of a temporary file).

use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::remote::git::{git, git_bytes, git_input, git_raw, run};
use crate::remote::{fs as rfs, RemotePath};

use super::{
    lists_worktree, parse_patch, parse_worktree_list, plan_file, sanitize_id, unique_name,
    FilePlan, WorktreeInfo, STALE_SUBAGENT_WORKTREE,
};

fn at(ws: &RemotePath, path: &str) -> RemotePath {
    RemotePath {
        host: ws.host.clone(),
        path: path.to_string(),
    }
}

fn exists(ws: &RemotePath, path: &str) -> bool {
    rfs::stat(&at(ws, path)).ok().flatten().is_some()
}

fn is_file(ws: &RemotePath, path: &str) -> bool {
    rfs::stat(&at(ws, path))
        .ok()
        .flatten()
        .is_some_and(|s| s.is_file)
}

fn join(dir: &str, rel: &str) -> String {
    format!(
        "{}/{}",
        dir.trim_end_matches('/'),
        rel.trim_start_matches('/')
    )
}

fn parent(path: &str) -> Option<&str> {
    path.trim_end_matches('/').rsplit_once('/').map(|(p, _)| p)
}

fn mkdir(ws: &RemotePath, path: &str) -> Result<(), String> {
    rfs::mkdir(&at(ws, path)).map_err(|e| format!("Couldn't create {path}: {}", e.message))
}

fn remove_all(ws: &RemotePath, path: &str) -> Result<(), String> {
    rfs::remove(&at(ws, path), true)
        .map(|_| ())
        .map_err(|e| format!("Couldn't clean up {path}: {}", e.message))
}

fn read(ws: &RemotePath, path: &str) -> Result<Option<Vec<u8>>, String> {
    match rfs::read(&at(ws, path), 64 * 1024 * 1024) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind == "notFound" => Ok(None),
        Err(e) => Err(format!("Couldn't read {path}: {}", e.message)),
    }
}

fn write(ws: &RemotePath, path: &str, bytes: &[u8]) -> Result<(), String> {
    rfs::write(&at(ws, path), bytes)
        .map(|_| ())
        .map_err(|e| format!("Couldn't write {path}: {}", e.message))
}

/// The project's data folder on the machine (`~/.nyxs/projects/<project>`), for temporary files.
fn data_dir(ws: &RemotePath) -> Result<String, String> {
    let uri = crate::project_paths::project_data_dir_str(&ws.uri())
        .ok_or_else(|| format!("Couldn't find Nyxs' folder on {}", ws.host))?;
    let dir = crate::remote::parse(&uri)
        .map(|r| r.path)
        .ok_or_else(|| format!("Couldn't find Nyxs' folder on {}", ws.host))?;
    mkdir(ws, &dir)?;
    Ok(dir)
}

fn is_git_repo(ws: &RemotePath) -> bool {
    git(&ws.host, &ws.path, &["rev-parse", "--is-inside-work-tree"]).is_ok_and(|s| s == "true")
}

fn has_head(ws: &RemotePath) -> bool {
    git(&ws.host, &ws.path, &["rev-parse", "--verify", "HEAD"]).is_ok()
}

fn repo_root(ws: &RemotePath) -> String {
    git(&ws.host, &ws.path, &["rev-parse", "--show-toplevel"]).unwrap_or_else(|_| ws.path.clone())
}

/// Where a worktree goes on the machine: `~/.nyxs/worktree/<project>/<id>`, or under the
/// location from Settings when it is one that means something there (`~/…`, or an absolute
/// path of that machine's kind).
fn worktree_path(ws: &RemotePath, id: &str, location: Option<&str>) -> Result<String, String> {
    let info = crate::remote::info(&ws.host).map_err(|e| e.message)?;
    let home = info.home.trim_end_matches('/').to_string();
    let project = crate::project_paths::encode_project_path(&ws.path);
    let windows = info.os == "windows";
    let base = match location.map(str::trim).filter(|s| !s.is_empty()) {
        Some(l) if l.starts_with("~/") || l.starts_with("~\\") => {
            join(&home, &l[2..].replace('\\', "/"))
        }
        Some(l) if !windows && l.starts_with('/') => l.to_string(),
        Some(l) if windows && l.as_bytes().get(1) == Some(&b':') => l.replace('\\', "/"),
        _ => format!("{home}/.nyxs/worktree"),
    };
    Ok(join(&join(&base, &project), &sanitize_id(id)))
}

/// Whether the project's git lists the folder `path` as one of its linked worktrees, as a whole
/// entry. git prints them canonical (links resolved), which `path` may not be; git run inside the
/// folder gives its top level in that same form, when the folder is a checkout's top.
fn listed(ws: &RemotePath, path: &str) -> bool {
    let Ok(porcelain) = git(&ws.host, &ws.path, &["worktree", "list", "--porcelain"]) else {
        return false;
    };
    let windows = crate::remote::info(&ws.host).is_ok_and(|i| i.os == "windows");
    if lists_worktree(&porcelain, path, windows) {
        return true;
    }
    let Ok(out) = git(
        &ws.host,
        path,
        &["rev-parse", "--show-toplevel", "--show-prefix"],
    ) else {
        return false;
    };
    let mut lines = out.lines();
    let top = lines.next().unwrap_or("");
    let at_top = lines.next().unwrap_or("").trim().is_empty();
    at_top && !top.is_empty() && lists_worktree(&porcelain, top, windows)
}

/// As `remove_leftover`: a folder that still holds a `.git` is never deleted.
fn remove_leftover(ws: &RemotePath, path: &str) -> Result<(), String> {
    if exists(ws, &join(path, ".git")) {
        return Err(format!(
            "{path} holds a git checkout (.git) that the project doesn't list as one of its worktrees, so it was left as it is. Move it or delete it by hand."
        ));
    }
    remove_all(ws, path)
}

pub(super) fn supported(ws: &RemotePath) -> bool {
    is_git_repo(ws) && has_head(ws)
}

/// The files of `root` that `ls-files` lists with `extra`, relative to the repository.
fn ls_files(ws: &RemotePath, root: &str, extra: &[&str]) -> Vec<String> {
    let mut args = vec!["ls-files", "--others", "--ignored", "--full-name", "-z"];
    args.extend_from_slice(extra);
    git_raw(&ws.host, root, &args)
        .map(|out| {
            out.split('\0')
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// As `copy_worktree_includes`: the git-ignored files `.worktreeinclude` names, copied over.
fn copy_worktree_includes(ws: &RemotePath, wt: &str) -> usize {
    let root = repo_root(ws);
    let include = join(&root, ".worktreeinclude");
    if !is_file(ws, &include) {
        return 0;
    }
    let wanted = ls_files(ws, &root, &["--exclude-from", &include]);
    if wanted.is_empty() {
        return 0;
    }
    let ignored: HashSet<String> = ls_files(ws, &root, &["--exclude-standard"])
        .into_iter()
        .collect();
    let mut copied = 0;
    for rel in wanted.iter().filter(|r| ignored.contains(*r)) {
        let to = join(wt, rel);
        if exists(ws, &to) {
            continue;
        }
        if let Ok(Some(bytes)) = read(ws, &join(&root, rel)) {
            if write(ws, &to, &bytes).is_ok() {
                copied += 1;
            }
        }
    }
    copied
}

pub(super) fn session_create(
    ws: &RemotePath,
    id: &str,
    branch: &str,
    location: Option<&str>,
) -> Result<String, String> {
    let (host, dir) = (ws.host.as_str(), ws.path.as_str());
    if !is_git_repo(ws) {
        return Err("The project isn't a git repository (worktrees require git).".into());
    }
    if !has_head(ws) {
        return Err("The repository has no commits yet; can't create a worktree.".into());
    }
    let branch = branch.trim();
    if branch.is_empty() || git(host, dir, &["check-ref-format", "--branch", branch]).is_err() {
        return Err(format!("\"{branch}\" isn't a valid branch name."));
    }
    let path = worktree_path(ws, id, location)?;
    let uri = at(ws, &path).uri();
    if listed(ws, &path) && exists(ws, &path) {
        return Ok(uri);
    }
    let _ = git(host, dir, &["worktree", "prune"]);
    if exists(ws, &path) {
        // Nyxs's own folder that git doesn't know, left by an interrupted run.
        remove_leftover(ws, &path)?;
    }
    if let Some(p) = parent(&path) {
        mkdir(ws, p)?;
    }
    let exists_branch = git(
        host,
        dir,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok();
    if exists_branch {
        git(host, dir, &["worktree", "add", &path, branch])?;
    } else {
        git(host, dir, &["worktree", "add", "-b", branch, &path, "HEAD"])?;
    }
    copy_worktree_includes(ws, &path);
    Ok(uri)
}

pub(super) fn session_remove(ws: &RemotePath, path: &str, force: bool) -> Result<(), String> {
    let path = crate::remote::parse(path).map_or_else(|| path.to_string(), |r| r.path);
    if exists(ws, &path) {
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&path);
        git(&ws.host, &ws.path, &args)?;
    }
    let _ = git(&ws.host, &ws.path, &["worktree", "prune"]);
    Ok(())
}

pub(super) fn remove(
    ws: &RemotePath,
    id: &str,
    force: bool,
    location: Option<&str>,
    branch_prefix: Option<&str>,
) -> Result<(), String> {
    let path = worktree_path(ws, id, location)?;
    if exists(ws, &path) {
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&path);
        git(&ws.host, &ws.path, &args)?;
    }
    let _ = git(&ws.host, &ws.path, &["worktree", "prune"]);
    let prefix = branch_prefix.map(str::trim).unwrap_or("");
    if !prefix.is_empty() {
        let branch = format!("{}{}", prefix, sanitize_id(id));
        let _ = git(&ws.host, &ws.path, &["branch", "-D", &branch]);
    }
    Ok(())
}

pub(super) fn list(ws: &RemotePath, location: Option<&str>) -> Result<Vec<WorktreeInfo>, String> {
    if !is_git_repo(ws) {
        return Ok(Vec::new());
    }
    let porcelain = git(&ws.host, &ws.path, &["worktree", "list", "--porcelain"])?;
    let managed_root = worktree_path(ws, "", location)?;
    Ok(parse_worktree_list(
        &porcelain,
        &managed_root,
        |p| p.replace('\\', "/"),
        |p| at(ws, p).uri(),
    ))
}

/// As `prune_stale_subagent_worktrees`: sub-agent worktrees a killed run left behind.
fn prune_stale(
    ws: &RemotePath,
    current: &str,
    location: Option<&str>,
    branch_prefix: Option<&str>,
) {
    let Some(root) = parent(current) else { return };
    let Ok(entries) = rfs::list_dir(&at(ws, root)) else {
        return;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    for e in entries {
        let path = join(root, &e.name);
        if !e.name.starts_with("sub-") || path == current || !e.is_dir {
            continue;
        }
        let age = Duration::from_millis(now.saturating_sub(e.mtime));
        if age <= STALE_SUBAGENT_WORKTREE {
            continue;
        }
        let _ = remove(ws, &e.name, true, location, branch_prefix);
        if exists(ws, &path) {
            if let Err(e) = remove_leftover(ws, &path) {
                eprintln!("[worktree] stale sub-agent worktree kept: {e}");
            }
        }
    }
}

/// The project's whole working state (tracked changes, deletions and untracked files that
/// aren't ignored) as a tree, through an index of its own: the project's index isn't touched.
fn working_tree(ws: &RemotePath) -> Result<String, String> {
    let index = join(&data_dir(ws)?, &unique_name("worktree-seed", "index"));
    let env = HashMap::from([("GIT_INDEX_FILE".to_string(), index.clone())]);
    let step = |args: &[&str]| -> Result<String, String> {
        let mut full = vec!["-C", ws.path.as_str()];
        full.extend_from_slice(args);
        let res = run(&ws.host, None, &full, None, Some(&env))?;
        if res.code == 0 {
            Ok(String::from_utf8_lossy(&res.stdout).trim().to_string())
        } else {
            Err(res.stderr.trim().to_string())
        }
    };
    let tree = step(&["read-tree", "HEAD"])
        .and_then(|_| step(&["add", "-A"]))
        .and_then(|_| step(&["write-tree"]));
    let _ = rfs::remove(&at(ws, &index), false);
    tree
}

/// As `seed_worktree`: the fresh worktree gets the project's uncommitted work, committed as its
/// base, so the agent's patch later holds only what the agent did.
fn seed(ws: &RemotePath, wt: &str) -> Result<(), String> {
    let host = ws.host.as_str();
    let tree = working_tree(ws)?;
    git(host, wt, &["read-tree", "-u", "--reset", &tree])?;
    let _ = git(host, wt, &["add", "-A"]);
    if git(host, wt, &["diff", "--cached", "--quiet"]).is_err() {
        // No hooks: see `seed_worktree`.
        let no_hooks = format!("core.hooksPath={}", join(&join(wt, ".git"), "no-hooks"));
        git(
            host,
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

pub(super) fn create(
    ws: &RemotePath,
    id: &str,
    location: Option<&str>,
    branch_prefix: Option<&str>,
) -> Result<String, String> {
    let (host, dir) = (ws.host.as_str(), ws.path.as_str());
    if !is_git_repo(ws) {
        return Err("The workspace isn't a git repository (worktrees require git).".into());
    }
    if !has_head(ws) {
        return Err("The repository has no commits yet; can't create a worktree.".into());
    }
    let path = worktree_path(ws, id, location)?;
    prune_stale(ws, &path, location, branch_prefix);
    if exists(ws, &path) {
        if listed(ws, &path) {
            remove(ws, id, true, location, branch_prefix)?;
        } else {
            remove_leftover(ws, &path)?;
        }
    }
    if let Some(p) = parent(&path) {
        mkdir(ws, p)?;
    }
    let prefix = branch_prefix.map(str::trim).unwrap_or("");
    if !prefix.is_empty() {
        let branch = format!("{}{}", prefix, sanitize_id(id));
        git(
            host,
            dir,
            &["worktree", "add", "-b", &branch, &path, "HEAD"],
        )?;
    } else {
        git(host, dir, &["worktree", "add", "--detach", &path, "HEAD"])?;
    }
    if let Err(e) = seed(ws, &path) {
        let _ = remove(ws, id, true, location, branch_prefix);
        return Err(e);
    }
    Ok(at(ws, &path).uri())
}

pub(super) fn export_patch(
    ws: &RemotePath,
    id: &str,
    location: Option<&str>,
) -> Result<String, String> {
    let path = worktree_path(ws, id, location)?;
    if !exists(ws, &path) {
        return Err(format!("The worktree '{}' doesn't exist.", sanitize_id(id)));
    }
    let host = ws.host.as_str();
    git(host, &path, &["add", "-A"])?;
    let patch = git_raw(
        host,
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
    let _ = git(host, &path, &["reset", "-q"]);
    Ok(patch)
}

enum Merged {
    Write(String, Vec<u8>),
    Delete(String),
}

fn blob_for(ws: &RemotePath, root: &str, id: &str, path: &str) -> Result<Vec<u8>, String> {
    let path_arg = format!("--path={path}");
    match git_bytes(
        &ws.host,
        root,
        &["cat-file", "--filters", &path_arg, id],
        None,
    )? {
        (0, bytes) => Ok(bytes),
        _ => Err(format!("{path}: version {id} is missing")),
    }
}

/// As `merge_patch`, with the files on the machine and the three-way merges run there.
fn merge_patch(ws: &RemotePath, root: &str, dir: &str, patch: &str) -> Result<Vec<Merged>, String> {
    let conflict = |path: &str| {
        format!("{path}: the project changed on those same lines while the agent was running")
    };
    let mut out = Vec::new();
    for f in parse_patch(patch)? {
        let target = join(root, &f.path);
        let ours = read(ws, &target)?;
        let base = f
            .base
            .as_deref()
            .map(|id| blob_for(ws, root, id, &f.path))
            .transpose()?;
        let theirs = f
            .theirs
            .as_deref()
            .map(|id| blob_for(ws, root, id, &f.path))
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
        let sides: Vec<String> = ["ours", "base", "theirs"]
            .iter()
            .map(|s| join(dir, &format!("{s}-{stem}")))
            .collect();
        let merged = (|| {
            for (p, bytes) in sides.iter().zip([&ours, &base, &theirs]) {
                write(ws, p, bytes)
                    .map_err(|e| format!("Couldn't prepare the merge of {}: {e}", f.path))?;
            }
            git_bytes(
                &ws.host,
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
                    &sides[0],
                    &sides[1],
                    &sides[2],
                ],
                None,
            )
        })();
        for p in &sides {
            let _ = rfs::remove(&at(ws, p), false);
        }
        match merged? {
            (0, bytes) => out.push(Merged::Write(target, bytes)),
            _ => return Err(conflict(&f.path)),
        }
    }
    Ok(out)
}

/// As `apply_patch`, on the machine.
pub(super) fn apply_patch(ws: &RemotePath, patch: &str, dry_run: bool) -> Result<(), String> {
    if patch.trim().is_empty() {
        return Ok(());
    }
    if !is_git_repo(ws) {
        return Err("The workspace isn't a git repository.".into());
    }
    let root = repo_root(ws);
    let dir = data_dir(ws)?;
    let patch = if patch.ends_with('\n') {
        patch.to_string()
    } else {
        format!("{patch}\n")
    };
    let host = ws.host.as_str();
    let plan = if git_input(
        host,
        &root,
        &["apply", "--check", "--whitespace=nowarn", "-"],
        patch.as_bytes(),
    )
    .is_ok()
    {
        Ok(None)
    } else {
        merge_patch(ws, &root, &dir, &patch).map(Some)
    };
    match plan {
        Ok(_) if dry_run => Ok(()),
        Ok(None) => git_input(
            host,
            &root,
            &["apply", "--whitespace=nowarn", "-"],
            patch.as_bytes(),
        )
        .map(|_| ()),
        Ok(Some(merged)) => {
            for m in merged {
                let res = match m {
                    Merged::Write(p, bytes) => write(ws, &p, &bytes),
                    Merged::Delete(p) => rfs::remove(&at(ws, &p), false)
                        .map(|_| ())
                        .map_err(|e| format!("Couldn't delete {p}: {}", e.message)),
                };
                if let Err(e) = res {
                    return Err(format!(
                        "the sub-agent's patch was only partly applied: {e}"
                    ));
                }
            }
            Ok(())
        }
        Err(reason) => {
            let kept = join(&dir, &unique_name("apply-failed", "patch"));
            let _ = write(ws, &kept, patch.as_bytes());
            Err(format!(
                "The sub-agent's patch couldn't be applied ({reason}). The project was left as it was; the patch is saved at {} for manual review.",
                at(ws, &kept).uri()
            ))
        }
    }
}
