//! Where a project's repository keeps its state, and which of its files a commit, checkout or
//! pull changes. Shared by the app's file watcher (`fswatch.rs`) and the remote helper, which
//! includes this file, so both tell a repository change the same way.
#![allow(dead_code)]

use std::fs;
use std::path::{Component, Path, PathBuf};

/// The git folders behind a project. `git_dir` holds HEAD, the index and logs/HEAD; `common_dir`
/// holds the refs. They differ in a linked worktree, whose `.git` is a file pointing at
/// `<main>/.git/worktrees/<name>`.
#[derive(Debug, Clone, PartialEq)]
pub struct GitDirs {
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
}

/// Resolves `..` and `.` without touching the disk: `canonicalize` adds `\\?\` on Windows,
/// which the watcher's event paths never have.
pub fn lexical_clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// A path as comparable text: forward slashes, and on Windows case-insensitive.
pub fn norm(path: &Path) -> String {
    let s = lexical_clean(path)
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// `path` relative to `base`, when it is inside it.
pub fn rel_to(path: &str, base: &str) -> Option<String> {
    path.strip_prefix(base)
        .and_then(|r| r.strip_prefix('/'))
        .map(str::to_string)
}

/// The repository the project belongs to: its own `.git` or one in a parent folder.
pub fn find_git_dirs(project: &Path) -> Option<GitDirs> {
    for dir in project.ancestors() {
        let dot = dir.join(".git");
        let git_dir = if dot.is_dir() {
            dot
        } else if dot.is_file() {
            let text = fs::read_to_string(&dot).ok()?;
            let target = Path::new(text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim());
            dir.join(target)
        } else {
            continue;
        };
        let common_dir = fs::read_to_string(git_dir.join("commondir"))
            .ok()
            .map(|c| git_dir.join(c.trim()))
            .unwrap_or_else(|| git_dir.clone());
        return Some(GitDirs {
            git_dir: lexical_clean(&git_dir),
            common_dir: lexical_clean(&common_dir),
        });
    }
    None
}

/// The files a commit, checkout, pull, merge or stash changes: what the Git bar shows. Object
/// writes and lock files are left out, they come by the hundred and say nothing on their own.
pub fn is_git_state_file(rel: &str) -> bool {
    let rel = rel.to_ascii_lowercase();
    if rel.ends_with(".lock") {
        return false;
    }
    matches!(
        rel.as_str(),
        "head" | "index" | "packed-refs" | "fetch_head" | "orig_head" | "merge_head" | "logs/head"
    ) || rel.starts_with("refs/")
        || rel.starts_with("logs/refs/")
        || rel.starts_with("reftable/")
}

pub fn is_git_state(path: &Path, dirs: &GitDirs) -> bool {
    let p = norm(path);
    [&dirs.git_dir, &dirs.common_dir]
        .iter()
        .any(|d| rel_to(&p, &norm(d)).is_some_and(|rel| is_git_state_file(&rel)))
}

/// The git folders the project's own watch doesn't reach: those outside the project, as in a
/// linked worktree or a project that is a subfolder of the repository.
pub fn extra_git_watches(project: &Path, dirs: &GitDirs) -> Vec<PathBuf> {
    let inside = |d: &Path| {
        let (d, p) = (norm(d), norm(project));
        d == p || rel_to(&d, &p).is_some()
    };
    let git_dir_in_common = rel_to(&norm(&dirs.git_dir), &norm(&dirs.common_dir)).is_some();
    let mut out = vec![dirs.common_dir.clone()];
    if !git_dir_in_common && dirs.git_dir != dirs.common_dir {
        out.push(dirs.git_dir.clone());
    }
    out.retain(|d| !inside(d));
    out
}

/// `dir` and every folder below it, without following links; `skip` leaves a folder out with
/// everything below it.
pub fn dirs_below(dir: &Path, skip: &dyn Fn(&str) -> bool) -> Vec<PathBuf> {
    let mut out = vec![dir.to_path_buf()];
    let mut i = 0;
    while i < out.len() {
        if let Ok(entries) = fs::read_dir(&out[i]) {
            for e in entries.flatten() {
                let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
                if is_dir && !e.file_name().to_str().is_some_and(skip) {
                    out.push(e.path());
                }
            }
        }
        i += 1;
    }
    out
}

/// The folders holding the repository's state, to watch one by one where each costs an inotify
/// watch: its top folders, their logs and every refs folder, not the objects.
pub fn git_state_dirs(dirs: &GitDirs) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for d in [&dirs.git_dir, &dirs.common_dir] {
        out.push(d.clone());
        out.push(d.join("logs"));
    }
    out.extend(dirs_below(&dirs.common_dir.join("refs"), &|_| false));
    out.push(dirs.common_dir.join("reftable"));
    out.retain(|d| d.is_dir());
    out.sort();
    out.dedup();
    out
}
