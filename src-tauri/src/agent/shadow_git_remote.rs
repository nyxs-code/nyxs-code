//! The shadow snapshots of a remote project (`ssh://`): the same bare repository as locally,
//! kept on the machine in the project's data folder there (`~/.nyxs/projects/<project>/
//! snapshots`), with git run on the machine. Same commands and results as `shadow_git.rs`.

use std::collections::HashSet;

use crate::remote::git::run;
use crate::remote::{fs as rfs, RemotePath};

use super::{
    changed_files, has_tree, join_nul, safe_relative, shadow_lock, split_nul, take_snapshot,
    ShadowRepo, CHANGED_ARGS, DEFAULT_EXCLUDES, LARGE_LIST, LITERAL,
};

fn at(ws: &RemotePath, path: &str) -> RemotePath {
    RemotePath {
        host: ws.host.clone(),
        path: path.to_string(),
    }
}

fn join(dir: &str, rel: &str) -> String {
    format!(
        "{}/{}",
        dir.trim_end_matches('/'),
        rel.trim_start_matches('/')
    )
}

/// git with the shadow repository as its git dir and the project as its work tree, as `run` in
/// `shadow_git.rs`; stdout as bytes.
fn git(ws: &RemotePath, dir: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    git_input(ws, dir, args, None)
}

fn git_input(
    ws: &RemotePath,
    dir: &str,
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let mut full = vec![
        "--git-dir",
        dir,
        "--work-tree",
        ws.path.as_str(),
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.safecrlf=false",
        "-c",
        "core.quotepath=false",
    ];
    full.extend_from_slice(args);
    let res = run(&ws.host, Some(&ws.path), &full, stdin, None)?;
    if res.code == 0 {
        Ok(res.stdout)
    } else {
        Err(res.stderr.trim().to_string())
    }
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

/// As `ensure_repo`: the shadow repository on the machine, made the first time.
fn ensure_repo(ws: &RemotePath) -> Result<String, String> {
    let uri = crate::project_paths::project_feature_dir_str(&ws.uri(), "snapshots")
        .ok_or_else(|| format!("Couldn't find Nyxs' folder on {}", ws.host))?;
    let dir = crate::remote::parse(&uri)
        .map(|r| r.path)
        .ok_or_else(|| format!("Couldn't find Nyxs' folder on {}", ws.host))?;
    if rfs::stat(&at(ws, &join(&dir, "HEAD")))
        .ok()
        .flatten()
        .is_some_and(|s| s.is_file)
    {
        return Ok(dir);
    }
    rfs::mkdir(&at(ws, &dir))
        .map_err(|e| format!("couldn't create the snapshots repository: {}", e.message))?;
    let init = run(
        &ws.host,
        None,
        &["init", "--bare", "--quiet", &dir],
        None,
        None,
    )?;
    if init.code != 0 {
        return Err(init.stderr.trim().to_string());
    }
    for (key, value) in [
        ("core.longpaths", "true"),
        ("feature.manyFiles", "true"),
        ("core.untrackedCache", "true"),
        ("gc.auto", "0"),
    ] {
        let _ = git(ws, &dir, &["config", key, value]);
    }
    let _ = rfs::write(
        &at(ws, &join(&dir, "info/exclude")),
        DEFAULT_EXCLUDES.as_bytes(),
    );
    let real_objects = join(&ws.path, ".git/objects");
    if rfs::stat(&at(ws, &real_objects))
        .ok()
        .flatten()
        .is_some_and(|s| s.is_dir)
    {
        let _ = rfs::write(
            &at(ws, &join(&dir, "objects/info/alternates")),
            format!("{real_objects}\n").as_bytes(),
        );
    }
    Ok(dir)
}

struct RemoteRepo<'a> {
    ws: &'a RemotePath,
    dir: String,
}

impl RemoteRepo<'_> {
    /// One `find` on the machine for the lot, rather than a round trip per file.
    fn larger_than_unix(&self, files: &[String], limit: u64) -> HashSet<String> {
        let mut found = HashSet::new();
        let size = format!("+{limit}c");
        for chunk in files.chunks(500) {
            // `./` so a name starting with `-` or `!` isn't read as an option.
            let argv: Vec<String> = std::iter::once("find".to_string())
                .chain(chunk.iter().map(|f| format!("./{f}")))
                .chain(
                    ["-prune", "-type", "f", "-size", &size, "-print0"]
                        .iter()
                        .map(|s| s.to_string()),
                )
                .collect();
            // A file gone since it was listed makes find exit 1; the rest is still printed.
            if let Ok(res) = crate::remote::procs::exec_bytes(
                &self.ws.host,
                &argv,
                Some(&self.ws.path),
                None,
                None,
            ) {
                found.extend(
                    split_nul(&res.stdout)
                        .into_iter()
                        .map(|f| f.strip_prefix("./").map(str::to_string).unwrap_or(f)),
                );
            }
        }
        found
    }

    /// Without `find` (a Windows machine): one listing per folder holding a candidate.
    fn larger_than_by_folder(&self, files: &[String], limit: u64) -> HashSet<String> {
        let mut by_dir: std::collections::BTreeMap<&str, Vec<&str>> = Default::default();
        for f in files {
            let (parent, name) = f.rsplit_once('/').unwrap_or(("", f.as_str()));
            by_dir.entry(parent).or_default().push(name);
        }
        let mut found = HashSet::new();
        for (parent, names) in by_dir {
            let path = if parent.is_empty() {
                self.ws.path.clone()
            } else {
                join(&self.ws.path, parent)
            };
            let Ok(entries) = rfs::list_dir(&at(self.ws, &path)) else {
                continue;
            };
            for e in entries {
                if !e.is_dir && e.size > limit && names.contains(&e.name.as_str()) {
                    found.insert(if parent.is_empty() {
                        e.name
                    } else {
                        format!("{parent}/{}", e.name)
                    });
                }
            }
        }
        found
    }
}

impl ShadowRepo for RemoteRepo<'_> {
    fn git(&self, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>, String> {
        git_input(self.ws, &self.dir, args, stdin)
    }

    fn has_index(&self) -> bool {
        rfs::stat(&at(self.ws, &join(&self.dir, "index")))
            .ok()
            .flatten()
            .is_some_and(|s| s.is_file)
    }

    fn larger_than(&self, files: &[String], limit: u64) -> HashSet<String> {
        if files.is_empty() {
            return HashSet::new();
        }
        let windows = crate::remote::info(&self.ws.host).is_ok_and(|i| i.os == "windows");
        if windows {
            self.larger_than_by_folder(files, limit)
        } else {
            self.larger_than_unix(files, limit)
        }
    }

    fn tracked_by_project(&self, files: &[String]) -> HashSet<String> {
        let mut tracked = HashSet::new();
        for chunk in files.chunks(200) {
            let mut args = vec!["--literal-pathspecs", "ls-files", "-z", "--"];
            args.extend(chunk.iter().map(String::as_str));
            if let Ok(res) = run(&self.ws.host, Some(&self.ws.path), &args, None, None) {
                if res.code == 0 {
                    tracked.extend(split_nul(&res.stdout));
                }
            }
        }
        tracked
    }

    fn read_large_list(&self) -> Vec<String> {
        rfs::read(&at(self.ws, &join(&self.dir, LARGE_LIST)), 64 * 1024 * 1024)
            .map(|b| split_nul(&b))
            .unwrap_or_default()
    }

    fn write_large_list(&self, files: &[String]) {
        let _ = rfs::write(&at(self.ws, &join(&self.dir, LARGE_LIST)), &join_nul(files));
    }
}

pub(super) fn snapshot(ws: &RemotePath) -> Result<String, String> {
    let _guard = shadow_lock(&ws.uri());
    let dir = ensure_repo(ws)?;
    take_snapshot(&RemoteRepo { ws, dir })
}

pub(super) fn changed(ws: &RemotePath, from: &str, to: &str) -> Result<Vec<String>, String> {
    let _guard = shadow_lock(&ws.uri());
    let dir = ensure_repo(ws)?;
    let mut args = CHANGED_ARGS.to_vec();
    args.extend([from, to]);
    Ok(changed_files(&git(ws, &dir, &args)?))
}

pub(super) fn restore(ws: &RemotePath, tree: &str, files: &[String]) -> Result<usize, String> {
    let _guard = shadow_lock(&ws.uri());
    let dir = ensure_repo(ws)?;
    // As in `restore_blocking`: a tree that can't be read restores nothing, rather than delete.
    has_tree(&|args| git(ws, &dir, args).map(text), tree)?;
    let mut changed = 0usize;
    for file in files {
        let Some(rel) = safe_relative(file) else {
            continue;
        };
        let listed = text(git(
            ws,
            &dir,
            &[LITERAL, "ls-tree", "--name-only", tree, "--", rel],
        )?);
        let target = at(ws, &join(&ws.path, rel));
        if listed.trim().is_empty() {
            let was_file = rfs::stat(&target).ok().flatten().is_some_and(|s| s.is_file);
            if was_file && rfs::remove(&target, false).unwrap_or(false) {
                changed += 1;
            }
            continue;
        }
        if git(ws, &dir, &[LITERAL, "checkout", tree, "--", rel]).is_ok() {
            changed += 1;
        }
    }
    Ok(changed)
}

pub(super) fn read(ws: &RemotePath, tree: &str, file: &str) -> Result<Option<String>, String> {
    let rel = safe_relative(file).ok_or_else(|| format!("path outside the workspace: {file}"))?;
    let _guard = shadow_lock(&ws.uri());
    let dir = ensure_repo(ws)?;
    let listed = text(git(
        ws,
        &dir,
        &[LITERAL, "ls-tree", "--name-only", tree, "--", rel],
    )?);
    if listed.trim().is_empty() {
        return Ok(None);
    }
    let spec = format!("{tree}:{}", rel.replace('\\', "/"));
    git(ws, &dir, &["cat-file", "blob", &spec]).map(|b| Some(text(b)))
}
