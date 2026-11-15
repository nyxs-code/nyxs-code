use super::vfs;
use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    backup_file_name: Option<String>,
}

fn fh_dir(workspace: &str, session_id: &str) -> String {
    if let Some(dir) = crate::project_paths::project_feature_dir_str(workspace, "file-history") {
        return vfs::join(&dir, &safe_component(session_id));
    }
    Path::new(workspace)
        .join(".nyxs")
        .join("file-history")
        .join(safe_component(session_id))
        .to_string_lossy()
        .to_string()
}

/// Where the backup `name` of a session is. The name comes from the frontend: anything that isn't
/// a plain file name (a separator, `..`, a drive or stream `:`) could reach outside the folder.
fn fh_backup_path(workspace: &str, session_id: &str, name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains(['/', '\\', ':', '\0']) || name.contains("..") {
        return Err(format!("Not a backup name: {name}"));
    }
    Ok(vfs::join(&fh_dir(workspace, session_id), name))
}

fn fh_backup_name(path: &str, version: u32) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    format!("{:016x}@v{version}", h.finish())
}

/// Copies a file's bytes to another place, on this PC or a remote machine (a remote project's
/// backups live on its machine, next to its sessions).
fn copy_file(from: &str, to: &str) -> std::io::Result<()> {
    let bytes = vfs::read(from)?;
    if let Some(parent) = vfs::parent(to) {
        if !crate::remote::is_remote(&parent) {
            fs::create_dir_all(&parent)?;
        }
    }
    vfs::write(to, &bytes)
}

#[tauri::command(async)]
pub fn agent_fh_backup(
    workspace: String,
    session_id: String,
    path: String,
    version: u32,
) -> Result<BackupResult, String> {
    confine(&path, None)?;
    if !vfs::is_file(&path) {
        return Ok(BackupResult {
            backup_file_name: None,
        });
    }
    let dir = fh_dir(&workspace, &session_id);
    if !crate::remote::is_remote(&dir) {
        fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create file-history: {e}"))?;
    }
    let name = fh_backup_name(&path, version);
    copy_file(&path, &vfs::join(&dir, &name))
        .map_err(|e| format!("Couldn't back up {path}: {e}"))?;
    Ok(BackupResult {
        backup_file_name: Some(name),
    })
}

#[tauri::command(async)]
pub fn agent_fh_origin_changed(
    workspace: String,
    session_id: String,
    path: String,
    backup_file_name: Option<String>,
) -> Result<bool, String> {
    let backup_path = backup_file_name
        .map(|name| fh_backup_path(&workspace, &session_id, &name))
        .transpose()?;
    confine(&path, None)?;
    let origin_exists = vfs::is_file(&path);
    let Some(backup_path) = backup_path else {
        return Ok(origin_exists);
    };
    let backup_exists = vfs::is_file(&backup_path);
    if origin_exists != backup_exists {
        return Ok(true);
    }
    if !origin_exists {
        return Ok(false);
    }
    let om = vfs::metadata(&path).map_err(|e| e.to_string())?;
    let bm = vfs::metadata(&backup_path).map_err(|e| e.to_string())?;
    if om.len != bm.len {
        return Ok(true);
    }
    let oc = vfs::read(&path).map_err(|e| e.to_string())?;
    let bc = vfs::read(&backup_path).map_err(|e| e.to_string())?;
    Ok(oc != bc)
}

/// What a file holds, to tell later whether someone changed it: `sha256:<hex>` of its bytes, or
/// `absent` when there is no file. An unreadable file gets a value no file can have, so it never
/// matches what the agent left.
pub(crate) fn content_hash(path: &str) -> String {
    if !vfs::is_file(path) {
        return "absent".into();
    }
    match vfs::read(path) {
        Ok(bytes) => hash_bytes(&bytes),
        Err(_) => "unreadable".into(),
    }
}

fn hash_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// The hash of a file as the agent left it, taken right after it wrote it (see `content_hash`).
#[tauri::command(async)]
pub fn agent_fh_hash(path: String) -> Result<String, String> {
    confine(&path, None)?;
    Ok(content_hash(&path))
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    /// The file was put back as it was in the backup.
    restored: bool,
    /// Left as it is: it no longer holds what the agent left (`expected_hash`).
    kept: bool,
    /// The file's hash after the call, so a later rewind knows this state is the session's own.
    hash: String,
}

/// Puts a file back as it was in its backup (`None`: it didn't exist). With `expected_hash`, only
/// if it still holds what the agent left: anything else is someone else's work and stays.
/// Holds the file's edit lock from the check to the write, as the agent's own edits do, so an
/// edit landing in between isn't overwritten, and writes atomically, so a crash leaves the file
/// whole.
fn restore_from(
    backup_path: Option<&str>,
    path: &str,
    expected_hash: Option<&str>,
) -> Result<RestoreOutcome, String> {
    let lock = super::text_io::edit_lock(path);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    let now = content_hash(path);
    if expected_hash.is_some_and(|h| h != now) {
        return Ok(RestoreOutcome {
            restored: false,
            kept: true,
            hash: now,
        });
    }
    let unchanged = |restored: bool| RestoreOutcome {
        restored,
        kept: false,
        hash: content_hash(path),
    };
    let Some(backup_path) = backup_path else {
        if vfs::is_file(path) {
            vfs::remove_file(path).map_err(|e| format!("Couldn't delete {path}: {e}"))?;
            return Ok(unchanged(true));
        }
        return Ok(unchanged(false));
    };
    if !vfs::is_file(backup_path) {
        return Err(format!("Backup not found: {backup_path}"));
    }
    let bytes = vfs::read(backup_path).map_err(|e| format!("Couldn't read the backup: {e}"))?;
    if hash_bytes(&bytes) == now {
        return Ok(unchanged(false));
    }
    // A remote write makes its own folders on the machine.
    if let Some(parent) = vfs::parent(path).filter(|p| !crate::remote::is_remote(p)) {
        fs::create_dir_all(&parent).map_err(|e| format!("Couldn't restore {path}: {e}"))?;
    }
    vfs::write_atomic(path, &bytes).map_err(|e| format!("Couldn't restore {path}: {e}"))?;
    Ok(unchanged(true))
}

/// Rewinds one file the agent edited to a backup. `expected_hash` is what the agent left it as
/// (see `agent_fh_hash`); sessions saved before 2026-10-31 have none and restore as they did.
#[tauri::command(async)]
pub fn agent_fh_restore(
    workspace: String,
    session_id: String,
    path: String,
    backup_file_name: Option<String>,
    expected_hash: Option<String>,
) -> Result<RestoreOutcome, String> {
    let backup_path = backup_file_name
        .map(|name| fh_backup_path(&workspace, &session_id, &name))
        .transpose()?;
    // A restore writes the file: only where the agent may write.
    confine_write(&path, None, false)?;
    restore_from(backup_path.as_deref(), &path, expected_hash.as_deref())
}

/// The text of a backup, for the rewind dialog's line counts. `None` when it is missing or not text.
#[tauri::command(async)]
pub fn agent_fh_read_backup(
    workspace: String,
    session_id: String,
    backup_file_name: String,
) -> Result<Option<String>, String> {
    let Ok(backup_path) = fh_backup_path(&workspace, &session_id, &backup_file_name) else {
        return Ok(None);
    };
    match vfs::read(&backup_path) {
        Ok(bytes) => Ok(String::from_utf8(bytes).ok()),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "nyxs-fh-{tag}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }

        fn file(&self, name: &str, text: &str) -> String {
            let p = self.0.join(name);
            fs::write(&p, text).unwrap();
            p.to_string_lossy().to_string()
        }
    }

    fn read(path: &str) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn hashes_content_and_tells_a_missing_file() {
        let dir = TempDir::new("hash");
        let a = dir.file("a.txt", "same");
        let b = dir.file("b.txt", "same");
        assert_eq!(content_hash(&a), content_hash(&b));
        assert!(content_hash(&a).starts_with("sha256:"));
        fs::write(&b, "other").unwrap();
        assert_ne!(content_hash(&a), content_hash(&b));
        assert_eq!(
            content_hash(&dir.0.join("none.txt").to_string_lossy()),
            "absent"
        );
    }

    #[test]
    fn restores_a_file_still_as_the_agent_left_it() {
        let dir = TempDir::new("restore");
        let backup = dir.file("backup", "before the turn");
        let file = dir.file("a.ts", "the agent's edit");
        let left = content_hash(&file);
        let out = restore_from(Some(&backup), &file, Some(&left)).unwrap();
        assert!(out.restored && !out.kept);
        assert_eq!(read(&file), "before the turn");
        assert_eq!(out.hash, content_hash(&backup));
    }

    #[test]
    fn keeps_a_file_someone_changed_after_the_agent() {
        let dir = TempDir::new("keep");
        let backup = dir.file("backup", "before the turn");
        let file = dir.file("a.ts", "the agent's edit");
        let left = content_hash(&file);
        fs::write(&file, "the agent's edit + another session's").unwrap();
        let out = restore_from(Some(&backup), &file, Some(&left)).unwrap();
        assert_eq!(
            out,
            RestoreOutcome {
                restored: false,
                kept: true,
                hash: content_hash(&file)
            }
        );
        assert_eq!(read(&file), "the agent's edit + another session's");
    }

    #[test]
    fn keeps_a_new_file_someone_changed_instead_of_deleting_it() {
        let dir = TempDir::new("new");
        let file = dir.file("new.ts", "created by the agent");
        let left = content_hash(&file);
        fs::write(&file, "created by the agent, then edited by the user").unwrap();
        assert!(restore_from(None, &file, Some(&left)).unwrap().kept);
        assert!(Path::new(&file).exists());
        fs::write(&file, "created by the agent").unwrap();
        let out = restore_from(None, &file, Some(&left)).unwrap();
        assert!(out.restored);
        assert!(!Path::new(&file).exists());
        assert_eq!(out.hash, "absent");
    }

    #[test]
    fn restores_without_a_hash_as_before_and_skips_a_file_already_back() {
        let dir = TempDir::new("legacy");
        let backup = dir.file("backup", "before");
        let file = dir.file("a.ts", "changed by anyone");
        assert!(restore_from(Some(&backup), &file, None).unwrap().restored);
        assert_eq!(read(&file), "before");
        let again = restore_from(Some(&backup), &file, None).unwrap();
        assert!(!again.restored && !again.kept);
        let missing = dir.0.join("gone").to_string_lossy().to_string();
        assert!(restore_from(Some(&missing), &file, None).is_err());
    }

    #[test]
    fn backup_names_stay_inside_the_sessions_folder() {
        let ok = fh_backup_path("C:/ws", "s1", &fh_backup_name("C:/ws/a.ts", 3)).unwrap();
        assert!(ok.ends_with("@v3"), "{ok}");
        for name in [
            "",
            "..",
            "../../secret",
            "a/b",
            "a\\b",
            "C:\\Windows\\win.ini",
            "x:stream",
            "a\0b",
        ] {
            assert!(fh_backup_path("C:/ws", "s1", name).is_err(), "{name:?}");
            let restored = agent_fh_restore(
                "C:/ws".into(),
                "s1".into(),
                "C:/ws/a.ts".into(),
                Some(name.into()),
                None,
            );
            assert!(
                restored.unwrap_err().contains("Not a backup name"),
                "{name:?}"
            );
            let changed = agent_fh_origin_changed(
                "C:/ws".into(),
                "s1".into(),
                "C:/ws/a.ts".into(),
                Some(name.into()),
            );
            assert!(
                changed.unwrap_err().contains("Not a backup name"),
                "{name:?}"
            );
            assert_eq!(
                agent_fh_read_backup("C:/ws".into(), "s1".into(), name.into()).unwrap(),
                None
            );
        }
    }

    #[test]
    fn comparing_with_a_backup_checks_the_path_first() {
        let dir = TempDir::new("origin");
        for path in [
            "relative/a.ts".to_string(),
            format!("{}/../a.ts", dir.0.join("sub").to_string_lossy()),
        ] {
            let err = agent_fh_origin_changed("ws".into(), "s1".into(), path.clone(), None);
            assert!(err.unwrap_err().contains("Access denied"), "{path}");
        }
    }

    #[test]
    fn a_restore_waits_for_an_edit_in_progress() {
        let dir = TempDir::new("lock");
        let backup = dir.file("backup", "before");
        let file = dir.file("a.ts", "the agent's edit");
        let lock = crate::agent::text_io::edit_lock(&file);
        let held = lock.lock().unwrap();
        let (b, f) = (backup.clone(), file.clone());
        let restore = std::thread::spawn(move || restore_from(Some(&b), &f, None));
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert_eq!(
            read(&file),
            "the agent's edit",
            "wrote while the file was locked"
        );
        drop(held);
        assert!(restore.join().unwrap().unwrap().restored);
        assert_eq!(read(&file), "before");
        // Written through a temporary file that doesn't stay behind.
        let left: Vec<_> = fs::read_dir(&dir.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn restores_a_file_whose_folder_was_deleted() {
        let dir = TempDir::new("folder");
        let backup = dir.file("backup", "before");
        let file = dir
            .0
            .join("gone")
            .join("a.ts")
            .to_string_lossy()
            .to_string();
        assert!(restore_from(Some(&backup), &file, None).unwrap().restored);
        assert_eq!(read(&file), "before");
    }
}
