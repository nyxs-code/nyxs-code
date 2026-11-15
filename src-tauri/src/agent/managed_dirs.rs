//! Copying and deleting the folders Nyxs manages for plugins and skills, without a shell.
//!
//! Plugin and skill installs used to build `Copy-Item`/`rm -rf` command lines out of paths that
//! partly come from downloaded catalogs. These commands take the paths as data and only act
//! strictly below the folders that hold installed plugins and skills.

use super::scope::{confine, resolve_path};
use super::*;
use std::io;
use std::path::Component;

/// Folders under the home directory whose contents these commands may replace or delete.
const HOME_ROOTS: [&[&str]; 3] = [
    &[".nyxs", "plugins"],
    &[".nyxs", "skills"],
    &[".nyxs", "skill-install-cache"],
];

/// How many symlinked folders deep a copy follows before giving up (a link to an ancestor
/// would otherwise recurse forever).
const MAX_LINK_DEPTH: usize = 32;

fn lexically_safe(path: &str) -> Result<&Path, String> {
    if crate::remote::is_remote(path) {
        return Err(format!(
            "{path} is on another machine; plugin folders are local."
        ));
    }
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("{path} isn't an absolute path."));
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("{path} contains '..'."));
    }
    Ok(p)
}

/// Where `p` really is. With `follow_leaf` false the last component isn't followed, so a symlink
/// there is judged (and later removed) as the link itself.
fn resolved(p: &Path, follow_leaf: bool) -> Option<PathBuf> {
    if follow_leaf {
        return resolve_path(p);
    }
    let (parent, name) = (p.parent()?, p.file_name()?);
    Some(resolve_path(parent)?.join(name))
}

/// A project's own skills: `<project>/.nyxs/skills/<something>`. The project folder itself
/// isn't known here (installs can happen with no agent turn, so no scope is registered).
fn is_project_skill_path(p: &Path) -> bool {
    let names: Vec<&std::ffi::OsStr> = p
        .components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n),
            _ => None,
        })
        .collect();
    names.windows(3).any(|w| {
        w[0].to_string_lossy().eq_ignore_ascii_case(".nyxs")
            && w[1].to_string_lossy().eq_ignore_ascii_case("skills")
    })
}

/// Checks that `path` lies strictly inside one of the managed folders and returns where it
/// really is.
fn managed_target(path: &str, home: &Path, follow_leaf: bool) -> Result<PathBuf, String> {
    let p = lexically_safe(path)?;
    let target = resolved(p, follow_leaf)
        .ok_or_else(|| format!("Couldn't resolve {path} (broken symlink?)."))?;
    let under_home = HOME_ROOTS.iter().any(|segs| {
        let root = segs.iter().fold(home.to_path_buf(), |acc, s| acc.join(s));
        resolve_path(&root)
            .map(|r| target != r && target.starts_with(&r))
            .unwrap_or(false)
    });
    if under_home || is_project_skill_path(&target) {
        Ok(target)
    } else {
        Err(format!(
            "{path} isn't inside the plugin or skill folders Nyxs manages."
        ))
    }
}

fn copy_tree(root: &Path, src: &Path, dst: &Path, depth: usize) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        // The install is a snapshot of the content; history stays in the cache checkout.
        if name == ".git" {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            // Links are only followed while they stay inside what is being copied, so a repo
            // can't pull e.g. ~/.ssh into an install through a symlink.
            let Ok(real) = fs::canonicalize(&from) else {
                continue;
            };
            if !real.starts_with(root) {
                continue;
            }
            if real.is_dir() {
                if depth >= MAX_LINK_DEPTH {
                    continue;
                }
                copy_tree(root, &real, &to, depth + 1)?;
            } else {
                fs::copy(&real, &to)?;
            }
        } else if kind.is_dir() {
            copy_tree(root, &from, &to, depth)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Git marks its object files read-only, which makes `remove_dir_all` fail on Windows.
#[cfg(windows)]
fn clear_readonly(dir: &Path) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            clear_readonly(&entry.path())?;
        }
        let meta = entry.metadata()?;
        let mut perms = meta.permissions();
        if perms.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            fs::set_permissions(entry.path(), perms)?;
        }
    }
    Ok(())
}

fn remove_tree(p: &Path) -> io::Result<()> {
    let meta = match fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if meta.file_type().is_symlink() {
        return fs::remove_file(p).or_else(|_| fs::remove_dir(p));
    }
    if !meta.is_dir() {
        return fs::remove_file(p);
    }
    #[cfg(windows)]
    clear_readonly(p)?;
    fs::remove_dir_all(p)
}

fn remove_managed(path: &str, home: &Path) -> Result<String, String> {
    managed_target(path, home, false)?;
    remove_tree(Path::new(path)).map_err(|e| format!("Couldn't delete {path}: {e}"))?;
    Ok(format!("OK: deleted {path}"))
}

fn copy_managed(src: &str, dst: &str, home: &Path) -> Result<String, String> {
    let src_path = lexically_safe(src)?;
    let root = fs::canonicalize(src_path).map_err(|e| format!("Couldn't open {src}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("{src} isn't a folder."));
    }
    let target = managed_target(dst, home, true)?;
    if target.starts_with(&root) || root.starts_with(&target) {
        return Err(format!(
            "Can't copy {src} into {dst}: one is inside the other."
        ));
    }
    let dst_path = Path::new(dst);
    let parent = dst_path
        .parent()
        .ok_or_else(|| format!("{dst} has no parent folder."))?;
    let name = dst_path
        .file_name()
        .ok_or_else(|| format!("{dst} has no folder name."))?;
    fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    // Copied next to the destination first, so a failed copy leaves the previous install whole.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let staging = parent.join(format!(
        ".{}.partial-{}-{}",
        name.to_string_lossy(),
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = remove_tree(&staging);
    let result = copy_tree(&root, &root, &staging, 0)
        .and_then(|_| remove_tree(dst_path))
        .and_then(|_| fs::rename(&staging, dst_path));
    if let Err(e) = result {
        let _ = remove_tree(&staging);
        return Err(format!("Couldn't copy {src} to {dst}: {e}"));
    }
    Ok(format!("OK: copied {src} to {dst}"))
}

/// Replaces the folder `dst` with a copy of `src`'s contents (without `.git`). `dst` must be
/// inside the plugin or skill folders; `src` must be a path the app may read.
#[tauri::command(async)]
pub fn nyxs_copy_managed_dir(src: String, dst: String) -> Result<String, String> {
    confine(&src, None)?;
    copy_managed(&src, &dst, &home_dir()?)
}

/// Deletes a folder inside the plugin or skill folders. A missing folder is not an error.
#[tauri::command(async)]
pub fn nyxs_remove_managed_dir(path: String) -> Result<String, String> {
    remove_managed(&path, &home_dir()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "nyxs-managed-dirs-{tag}-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(fs::canonicalize(&dir).unwrap())
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = remove_tree(&self.0);
        }
    }

    fn write(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn copies_into_plugin_folders_without_git_and_replaces_the_old_copy() {
        let home = TempDir::new("copy");
        let src = home.path("src/plugin");
        write(&src.join("plugin.json"), "{}");
        write(&src.join("skills/a/SKILL.md"), "skill");
        write(&src.join(".git/HEAD"), "ref");
        let dst = home.path(".nyxs/plugins/cache/mp/p/1.0.0");
        write(&dst.join("stale.txt"), "old");

        copy_managed(&s(&src), &s(&dst), &home.0).unwrap();

        assert_eq!(
            fs::read_to_string(dst.join("skills/a/SKILL.md")).unwrap(),
            "skill"
        );
        assert!(dst.join("plugin.json").is_file());
        assert!(!dst.join(".git").exists());
        assert!(!dst.join("stale.txt").exists());
        let leftovers: Vec<_> = fs::read_dir(dst.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(
            leftovers.len(),
            1,
            "staging folder left behind: {leftovers:?}"
        );
    }

    #[test]
    fn names_with_shell_syntax_are_just_names() {
        let home = TempDir::new("names");
        let src = home.path("src/a$(touch pwned)'; x");
        write(&src.join("SKILL.md"), "skill");
        let dst = home.path(".nyxs/skills/a$(touch pwned)'; x");

        copy_managed(&s(&src), &s(&dst), &home.0).unwrap();
        assert!(dst.join("SKILL.md").is_file());
        assert!(!home.path("pwned").exists());
        assert!(!PathBuf::from("pwned").exists());

        remove_managed(&s(&dst), &home.0).unwrap();
        assert!(!dst.exists());
    }

    #[test]
    fn refuses_targets_outside_the_managed_folders() {
        let home = TempDir::new("outside");
        let src = home.path("src");
        write(&src.join("a.txt"), "a");
        let victim = home.path("Documents");
        write(&victim.join("keep.txt"), "keep");

        for bad in [
            s(&victim),
            s(&home.path(".nyxs")),
            s(&home.path(".nyxs/plugins")),
            s(&home.path(".nyxs/settings")),
            format!("{}/../../Documents", s(&home.path(".nyxs/plugins/x"))),
            "relative/plugins".to_string(),
        ] {
            assert!(
                copy_managed(&s(&src), &bad, &home.0).is_err(),
                "copy to {bad}"
            );
            assert!(remove_managed(&bad, &home.0).is_err(), "remove {bad}");
        }
        assert!(victim.join("keep.txt").is_file());
    }

    #[test]
    fn project_skill_folders_are_managed() {
        let home = TempDir::new("project");
        let src = home.path("cache/skill");
        write(&src.join("SKILL.md"), "skill");
        let dst = home.path("work/repo/.nyxs/skills/review");
        copy_managed(&s(&src), &s(&dst), &home.0).unwrap();
        assert!(dst.join("SKILL.md").is_file());
        assert!(copy_managed(&s(&src), &s(&home.path("work/repo/.nyxs/skills")), &home.0).is_err());
        assert!(remove_managed(&s(&home.path("work/repo/.nyxs")), &home.0).is_err());
    }

    #[test]
    fn copying_a_folder_into_itself_is_refused() {
        let home = TempDir::new("self");
        let src = home.path(".nyxs/plugins/marketplaces/m/repo");
        write(&src.join("a.txt"), "a");
        let inside = home.path(".nyxs/plugins/marketplaces/m/repo/sub");
        assert!(copy_managed(&s(&src), &s(&inside), &home.0).is_err());
    }

    #[test]
    fn removing_a_missing_folder_is_fine_and_read_only_files_go_too() {
        let home = TempDir::new("remove");
        let gone = home.path(".nyxs/skill-install-cache/nothing");
        remove_managed(&s(&gone), &home.0).unwrap();

        let dir = home.path(".nyxs/skill-install-cache/repo");
        let pack = dir.join(".git/objects/pack/p.pack");
        write(&pack, "pack");
        let mut perms = fs::metadata(&pack).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&pack, perms).unwrap();
        remove_managed(&s(&dir), &home.0).unwrap();
        assert!(!dir.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_out_of_the_source_are_not_followed() {
        let home = TempDir::new("links");
        let secret = home.path("secret");
        write(&secret.join("id_rsa"), "key");
        let src = home.path("src");
        write(&src.join("inner/a.txt"), "a");
        std::os::unix::fs::symlink(&secret, src.join("leak")).unwrap();
        std::os::unix::fs::symlink(src.join("inner"), src.join("alias")).unwrap();
        let dst = home.path(".nyxs/plugins/cache/m/p/1");

        copy_managed(&s(&src), &s(&dst), &home.0).unwrap();
        assert!(!dst.join("leak").exists());
        assert_eq!(fs::read_to_string(dst.join("alias/a.txt")).unwrap(), "a");

        // A link inside the managed folders is removed as a link; what it points to stays.
        let link = home.path(".nyxs/plugins/link");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        remove_managed(&s(&link), &home.0).unwrap();
        assert!(fs::symlink_metadata(&link).is_err());
        assert!(secret.join("id_rsa").is_file());
        assert!(copy_managed(&s(&src), &s(&home.path(".nyxs/plugins/link2/x")), &home.0).is_ok());
        std::os::unix::fs::symlink(&secret, home.path(".nyxs/plugins/out")).unwrap();
        assert!(copy_managed(&s(&src), &s(&home.path(".nyxs/plugins/out/x")), &home.0).is_err());
    }
}
