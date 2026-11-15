//! What the mod engine (src/lib/mods/) asks of the file system on a mod's behalf.

use serde::Serialize;
use std::time::UNIX_EPOCH;

/// `$.fs.stat` of a mod, in Claude Code's shape: a path that is missing (or outside what the app
/// may read) is an error, not an answer.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModStat {
    kind: &'static str,
    size: u64,
    mtime_ms: f64,
    is_link: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    real_path: Option<String>,
}

fn stat(path: &str, resolve: bool) -> Result<ModStat, String> {
    let link = std::fs::symlink_metadata(path).map_err(|e| format!("{path}: {e}"))?;
    let meta = if link.file_type().is_symlink() {
        std::fs::metadata(path).map_err(|e| format!("{path}: {e}"))?
    } else {
        link.clone()
    };
    let kind = if meta.is_dir() {
        "dir"
    } else if meta.is_file() {
        "file"
    } else {
        "other"
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_millis() as f64);
    let real_path = if resolve {
        std::fs::canonicalize(path)
            .ok()
            .map(|p| strip_verbatim(&p.to_string_lossy()))
    } else {
        None
    };
    Ok(ModStat {
        kind,
        size: meta.len(),
        mtime_ms,
        is_link: link.file_type().is_symlink(),
        real_path,
    })
}

/// `canonicalize` on Windows answers `\\?\C:\…`; mods compare it with the paths they were given.
fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    }
}

#[tauri::command(async)]
pub fn mods_fs_stat(path: String, resolve: Option<bool>) -> Result<ModStat, String> {
    crate::agent::confine(&path, None)?;
    stat(&path, resolve.unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn stat_tells_files_from_folders_and_rejects_missing_paths() {
        let dir =
            TempDir(std::env::temp_dir().join(format!("nyxs-mods-stat-{}", std::process::id())));
        std::fs::create_dir_all(&dir.0).unwrap();
        let file = dir.0.join("a.txt");
        std::fs::write(&file, "hi").unwrap();
        let f = stat(&file.to_string_lossy(), false).unwrap();
        assert_eq!((f.kind, f.size, f.real_path.is_none()), ("file", 2, true));
        let d = stat(&dir.0.to_string_lossy(), true).unwrap();
        assert_eq!(d.kind, "dir");
        assert!(!d.real_path.unwrap().starts_with(r"\\?\"));
        assert!(stat(&dir.0.join("missing").to_string_lossy(), false).is_err());
    }

    #[test]
    fn verbatim_prefixes_are_dropped() {
        assert_eq!(strip_verbatim(r"\\?\C:\x"), r"C:\x");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share"), r"\\srv\share");
        assert_eq!(strip_verbatim("/home/me"), "/home/me");
    }
}
