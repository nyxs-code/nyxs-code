use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// A path as a folder name anyone can read: everything but ASCII letters, digits, `_` and `.`
/// becomes `-`. Many paths share one (`C:\w\my-app` and `C:\w\my\app`), so a project's data
/// folder adds a hash (`project_dir_name`); worktree folders keep this alone, since git knows
/// them by their path and Nyxs finds an existing one by recomputing it.
pub fn encode_project_path(cwd: &str) -> String {
    cwd.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// The path a project is known by, whichever way it was written. Decided by the path's form, not
/// by the OS Nyxs runs on, so Nyxs here and on a remote machine name its folder the same: a
/// Windows path (a drive, a share or a backslash) gets one separator and one case, as its file
/// system treats them; a POSIX one stays as it is, case included.
fn normalized_project_key(path: &str) -> String {
    let p = path.trim();
    let p = match p.strip_prefix(r"\\?\UNC\") {
        Some(share) => format!(r"\\{share}"),
        None => p.strip_prefix(r"\\?\").unwrap_or(p).to_string(),
    };
    let b = p.as_bytes();
    let windows = (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || p.contains('\\');
    if windows {
        return p.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    }
    match p.trim_end_matches('/') {
        "" if p.starts_with('/') => "/".to_string(),
        trimmed => trimmed.to_string(),
    }
}

/// FNV-1a: the same on every build and machine, unlike std's hasher.
fn stable_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// The readable part of a data folder's name keeps its end, where the project's own name is.
const READABLE_MAX: usize = 100;

/// A project's data folder name: its path readable, then a hash of it, so two projects never share
/// one and one written two ways (`E:\Proj`, `e:/proj/`) always gets the same.
fn project_dir_name(workspace: &str) -> String {
    let key = normalized_project_key(workspace);
    let readable = encode_project_path(&key);
    let readable = &readable[readable.len().saturating_sub(READABLE_MAX)..];
    format!("{readable}-{:010x}", stable_hash(&key) >> 24)
}

/// Left in an old data folder whose contents were copied to a project's new one, so another
/// project that shared it doesn't take a copy too. It holds the new folder's name.
const CLAIMED_MARK: &str = ".nyxs-moved-to";

#[derive(Debug, PartialEq)]
enum Migration {
    /// No old folder to bring over: never there, or already taken by another project.
    NothingToMove,
    /// The new folder was there already; an old one, if any, is left as it is.
    AlreadyNew,
    /// Copied whole; the old one kept and marked as this project's.
    Copied,
    /// It couldn't be copied: the old folder stays in use.
    Failed,
}

fn folder_name(dir: &Path) -> String {
    dir.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Brings a project's old data folder (named by `encode_project_path` alone) to `new`: copied
/// whole to a temporary folder that only takes the new name once complete, once: the old folder
/// is never read again after that. It isn't deleted either, as a backup. Marked with the new
/// folder's name, so another project that shared the old folder doesn't take it too: the first to
/// open it keeps it.
///
/// Until 0.8.51 what an older Nyxs went on writing in the old folder was brought over every 10
/// seconds. That re-read whole transcripts under the project's lock, slowing every session read,
/// and brought back sessions deleted in the new folder; once installs updated it had no use.
fn migrate_legacy(
    root: &Path,
    workspace: &str,
    new: &Path,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Migration {
    let legacy = root.join(encode_project_path(workspace));
    let legacy_live = legacy.is_dir() && !legacy.join(CLAIMED_MARK).exists();
    if new.exists() {
        if legacy_live {
            log::warn!(
                "project data: {} left as it is, {} is already in use",
                legacy.display(),
                new.display()
            );
        }
        return Migration::AlreadyNew;
    }
    if !legacy_live {
        return Migration::NothingToMove;
    }
    let name = folder_name(new);
    let tmp = root.join(format!("{name}.migrating"));
    let _ = std::fs::remove_dir_all(&tmp);
    let copied = copy_dir(&legacy, &tmp).and_then(|()| rename(&tmp, new));
    if let Err(e) = copied {
        let _ = std::fs::remove_dir_all(&tmp);
        // Another Nyxs brought it over a moment ago.
        if new.exists() {
            return Migration::AlreadyNew;
        }
        log::warn!(
            "project data: couldn't copy {} ({e}); still using it",
            legacy.display()
        );
        return Migration::Failed;
    }
    if let Err(e) = std::fs::write(legacy.join(CLAIMED_MARK), name.as_bytes()) {
        log::warn!(
            "project data: couldn't mark {} as copied: {e}",
            legacy.display()
        );
    }
    log::info!(
        "project data: {} copied to {} for {workspace}; the old folder is kept",
        legacy.display(),
        new.display()
    );
    Migration::Copied
}

/// `from`'s files and folders, recreated under `to`. Links and other special entries are skipped:
/// Nyxs never puts any there.
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

/// The remote folder names already picked in this run.
fn resolved() -> &'static Mutex<HashMap<String, String>> {
    static R: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// A local project's data folder as this run knows it, once worked out.
struct LocalDir {
    dir: Option<PathBuf>,
}

/// One lock per project, by projects root and workspace as written: a project's copy holds up
/// only that project, never another one's.
fn local_dirs() -> &'static Mutex<HashMap<String, std::sync::Arc<Mutex<LocalDir>>>> {
    static R: OnceLock<Mutex<HashMap<String, std::sync::Arc<Mutex<LocalDir>>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// A project's data folder under `root`, copied from its old name the first time this run asks
/// for it. When copying failed it is the old folder, still in use.
fn resolve_local_data_dir(root: &Path, workspace: &str) -> PathBuf {
    let key = format!("{}\u{0}{workspace}", root.display());
    let entry = local_dirs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(key)
        .or_insert_with(|| std::sync::Arc::new(Mutex::new(LocalDir { dir: None })))
        .clone();
    let mut local = entry.lock().unwrap_or_else(|e| e.into_inner());
    let new = root.join(project_dir_name(workspace));
    match &local.dir {
        Some(dir) => dir.clone(),
        None => {
            let dir = match migrate_legacy(root, workspace, &new, |a, b| std::fs::rename(a, b)) {
                Migration::Failed => root.join(encode_project_path(workspace)),
                _ => new,
            };
            local.dir = Some(dir.clone());
            dir
        }
    }
}

/// The data folder's name for a project on a remote machine, `exists` telling what is in its
/// projects folder (`None`: the machine couldn't say). Folders there aren't moved from here: the
/// old one stays in use while it is the only one, until Nyxs running on that machine moves it.
/// `None` when it can't be told, which keeps the old name rather than show an empty project.
fn pick_remote_name(path: &str, exists: impl Fn(&str) -> Option<bool>) -> Option<String> {
    let new = project_dir_name(path);
    let legacy = encode_project_path(path);
    if exists(&new)? {
        return Some(new);
    }
    if exists(&legacy)? && !exists(&format!("{legacy}/{CLAIMED_MARK}"))? {
        log::info!("project data: {legacy} still holds {path}'s data on its machine");
        return Some(legacy);
    }
    Some(new)
}

/// `pick_remote_name` on `host`, its projects folder at `base`, once per run.
fn remote_dir_name(host: &str, base: &str, path: &str) -> String {
    let key = format!("ssh\u{0}{host}\u{0}{base}\u{0}{path}");
    if let Some(name) = resolved()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
    {
        return name.clone();
    }
    let exists = |name: &str| {
        let at = crate::remote::RemotePath {
            host: host.to_string(),
            path: format!("{base}/{name}"),
        };
        crate::remote::fs::stat(&at).ok().map(|s| s.is_some())
    };
    match pick_remote_name(path, exists) {
        Some(name) => {
            resolved()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(key, name.clone());
            name
        }
        None => encode_project_path(path),
    }
}

/// Where a project's state lives, as text: a local folder, or for an `ssh://` project the same
/// place on its machine (`~/.nyxs/projects/<its folder name>`), where Nyxs running on that machine
/// keeps it too. That's what lets two PCs see one remote project's sessions.
pub fn project_data_dir_str(workspace: &str) -> Option<String> {
    let Some(r) = crate::remote::parse(workspace) else {
        return project_data_dir(workspace).map(|p| p.to_string_lossy().to_string());
    };
    let home = crate::remote::fs::home(&r.host).ok()?;
    let mut base = format!("{}/.nyxs", home.path.trim_end_matches('/'));
    if let Some(uid) = crate::agent::current_account() {
        base = format!("{base}/accounts/{uid}");
    }
    let projects = format!("{base}/projects");
    let name = remote_dir_name(&r.host, &projects, &r.path);
    Some(crate::remote::uri::uri(
        &r.host,
        &format!("{projects}/{name}"),
    ))
}

pub fn project_feature_dir_str(workspace: &str, feature: &str) -> Option<String> {
    project_data_dir_str(workspace).map(|d| crate::agent::vfs::join(&d, feature))
}

pub fn project_data_dir(workspace: &str) -> Option<PathBuf> {
    let root = match std::env::var("NYXS_PROJECTS_ROOT") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => {
            let mut base = home_dir()?.join(".nyxs");
            if let Some(uid) = crate::agent::current_account() {
                base = base.join("accounts").join(uid);
            }
            base.join("projects")
        }
    };
    Some(resolve_local_data_dir(&root, workspace))
}

pub fn project_feature_dir(workspace: &str, feature: &str) -> Option<PathBuf> {
    project_data_dir(workspace).map(|d| d.join(feature))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A projects root of its own in the temp folder, removed even when the test fails.
    struct Root(PathBuf);

    impl Root {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("nyxs-project-paths-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Root(dir)
        }

        /// An old-style data folder for `workspace`, with one session file in it.
        fn legacy(&self, workspace: &str, session: &str) -> PathBuf {
            let dir = self.0.join(encode_project_path(workspace));
            fs::create_dir_all(dir.join("snapshots")).unwrap();
            fs::write(dir.join(format!("{session}.jsonl")), "{}\n").unwrap();
            fs::write(dir.join("snapshots").join("HEAD"), "ref").unwrap();
            dir
        }
    }

    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn paths_that_used_to_collide_get_folders_of_their_own() {
        assert_eq!(
            encode_project_path(r"C:\w\my-app"),
            encode_project_path(r"C:\w\my\app")
        );
        assert_ne!(
            project_dir_name(r"C:\w\my-app"),
            project_dir_name(r"C:\w\my\app")
        );
        assert_ne!(
            project_dir_name("/home/u/プロジェクト"),
            project_dir_name("/home/u/テスト")
        );
        // POSIX file systems tell case apart.
        assert_ne!(
            project_dir_name("/home/u/App"),
            project_dir_name("/home/u/app")
        );
    }

    #[test]
    fn one_folder_written_two_ways_gets_one_name() {
        let name = project_dir_name(r"E:\Proj");
        for other in [
            "e:\\proj",
            "E:/Proj",
            "e:/proj/",
            r"E:\Proj\",
            r"\\?\E:\Proj",
        ] {
            assert_eq!(project_dir_name(other), name, "{other}");
        }
        assert_eq!(
            project_dir_name("/home/u/app/"),
            project_dir_name("/home/u/app")
        );
        // Still readable, and the same on any machine.
        assert!(name.starts_with("e--proj-"), "{name}");
        assert_eq!(name.len(), "e--proj-".len() + 10);
        let long = format!("/{}", "a".repeat(400));
        assert!(project_dir_name(&long).len() <= READABLE_MAX + 11);
    }

    #[test]
    fn copies_the_old_folder_to_the_new_name_and_keeps_it_marked() {
        let root = Root::new("copy");
        let ws = r"C:\w\my-app";
        let legacy = root.legacy(ws, "s1");
        let dir = resolve_local_data_dir(&root.0, ws);
        assert_eq!(dir, root.0.join(project_dir_name(ws)));
        assert!(dir.join("s1.jsonl").is_file());
        assert!(dir.join("snapshots").join("HEAD").is_file());
        // An older Nyxs still running goes on using it.
        assert!(legacy.join("s1.jsonl").is_file());
        assert!(legacy.join("snapshots").join("HEAD").is_file());
        assert_eq!(
            fs::read_to_string(legacy.join(CLAIMED_MARK)).unwrap(),
            project_dir_name(ws)
        );
        assert!(!root
            .0
            .join(format!("{}.migrating", project_dir_name(ws)))
            .exists());
    }

    #[test]
    fn after_the_copy_the_old_folder_is_never_read_again() {
        let root = Root::new("once");
        let ws = r"C:\w\once";
        let legacy = root.legacy(ws, "s1");
        let dir = resolve_local_data_dir(&root.0, ws);
        fs::remove_file(dir.join("s1.jsonl")).unwrap();
        // What an older Nyxs writes there later, and a session deleted here, stay where they are.
        fs::write(legacy.join("s2.jsonl"), "{}\n").unwrap();
        assert_eq!(resolve_local_data_dir(&root.0, ws), dir);
        assert!(!dir.join("s1.jsonl").exists());
        assert!(!dir.join("s2.jsonl").exists());
        assert!(legacy.join("s1.jsonl").is_file());
    }

    #[test]
    fn the_first_of_two_projects_that_shared_a_folder_keeps_it() {
        let root = Root::new("shared");
        let (a, b) = (r"C:\w\my-app", r"C:\w\my\app");
        root.legacy(a, "s1");
        let dir_a = resolve_local_data_dir(&root.0, a);
        let dir_b = resolve_local_data_dir(&root.0, b);
        assert_ne!(dir_a, dir_b);
        assert!(dir_a.join("s1.jsonl").is_file());
        assert!(!dir_b.join("s1.jsonl").exists());
    }

    #[test]
    fn leaves_the_old_folder_alone_when_the_new_one_exists() {
        let root = Root::new("both");
        let ws = r"D:\code\app";
        let legacy = root.legacy(ws, "old");
        let new = root.0.join(project_dir_name(ws));
        fs::create_dir_all(&new).unwrap();
        assert_eq!(
            migrate_legacy(&root.0, ws, &new, |a, b| fs::rename(a, b)),
            Migration::AlreadyNew
        );
        assert!(legacy.join("old.jsonl").is_file());
        assert!(!new.join("old.jsonl").exists());
    }

    #[test]
    fn another_project_that_shared_the_old_folder_finds_it_taken() {
        let root = Root::new("taken");
        let ws = r"D:\code\locked";
        root.legacy(ws, "s1");
        let new = root.0.join(project_dir_name(ws));
        assert_eq!(
            migrate_legacy(&root.0, ws, &new, |a, b| fs::rename(a, b)),
            Migration::Copied
        );
        let other = r"D:\code-locked";
        assert_eq!(encode_project_path(other), encode_project_path(ws));
        let other_new = root.0.join(project_dir_name(other));
        assert_eq!(
            migrate_legacy(&root.0, other, &other_new, |a, b| fs::rename(a, b)),
            Migration::NothingToMove
        );
        assert!(!other_new.exists());
    }

    #[test]
    fn keeps_using_the_old_folder_when_it_cant_be_copied() {
        let root = Root::new("stuck");
        let ws = r"D:\code\stuck";
        let legacy = root.legacy(ws, "s1");
        let new = root.0.join(project_dir_name(ws));
        let never = |_: &Path, _: &Path| Err(std::io::Error::other("in use"));
        assert_eq!(migrate_legacy(&root.0, ws, &new, never), Migration::Failed);
        assert!(!new.exists());
        assert!(!root
            .0
            .join(format!("{}.migrating", project_dir_name(ws)))
            .exists());
        assert!(legacy.join("s1.jsonl").is_file());
        assert!(!legacy.join(CLAIMED_MARK).exists());
    }

    #[test]
    fn a_remote_project_keeps_its_old_folder_until_its_machine_moves_it() {
        let path = "/home/me/app";
        let (new, legacy) = (project_dir_name(path), encode_project_path(path));
        let mark = format!("{legacy}/{CLAIMED_MARK}");
        let on = |names: Vec<&String>| {
            let names: Vec<String> = names.into_iter().cloned().collect();
            move |n: &str| Some(names.iter().any(|x| x == n))
        };
        assert_eq!(
            pick_remote_name(path, on(vec![&legacy])),
            Some(legacy.clone())
        );
        assert_eq!(
            pick_remote_name(path, on(vec![&legacy, &new])),
            Some(new.clone())
        );
        assert_eq!(pick_remote_name(path, on(vec![])), Some(new.clone()));
        assert_eq!(pick_remote_name(path, on(vec![&legacy, &mark])), Some(new));
        // A machine that doesn't answer: undecided, so the caller keeps the old name.
        assert_eq!(pick_remote_name(path, |_| None), None);
    }
}
