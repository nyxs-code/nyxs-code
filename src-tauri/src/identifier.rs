//! The app's bundle identifier, and the move away from the one it had before.
//!
//! Up to 0.8.48 the identifier was `com.destinopositivo.codeagent`. Tauri names the app's data
//! folders after it (chats, the built-in browser's profiles, window state, logs), and so do the
//! WebView's own storage (localStorage, cookies) and the keychain service of the secrets. The
//! first launch with the new identifier moves the folders across (`migrate_folders`) and the
//! secrets follow one by one the first time each is read (`agent::settings`), so nobody starts
//! over after the update.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The published app's identifier (`tauri.conf.json`).
pub const IDENTIFIER: &str = "com.nyxs.desktop";
/// The identifier up to 0.8.48, whose folders and secrets are moved to `IDENTIFIER`.
pub const LEGACY_IDENTIFIER: &str = "com.destinopositivo.codeagent";

/// What `migrate_folders` did, logged from `setup` once the log plugin is running.
static NOTES: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn note(msg: String) {
    NOTES.lock().unwrap_or_else(|e| e.into_inner()).push(msg);
}

/// Logs what the migration did. Called from `setup`.
pub fn log_migration() {
    for msg in NOTES.lock().unwrap_or_else(|e| e.into_inner()).drain(..) {
        log::info!("{msg}");
    }
}

/// The folders Tauri, WebView2/WKWebView/WebKitGTK and the plugins put under the identifier.
fn bases() -> Vec<PathBuf> {
    let mut bases: Vec<PathBuf> = [
        dirs::data_dir(),
        dirs::data_local_dir(),
        dirs::config_dir(),
        dirs::cache_dir(),
    ]
    .into_iter()
    .flatten()
    .collect();
    // WKWebView keeps a non-sandboxed app's localStorage under ~/Library/WebKit/<id> and its
    // cookies under ~/Library/HTTPStorages/<id>; Tauri's log folder is ~/Library/Logs/<id>.
    if cfg!(target_os = "macos") {
        if let Some(home) = dirs::home_dir() {
            for sub in ["Library/WebKit", "Library/HTTPStorages", "Library/Logs"] {
                bases.push(home.join(sub));
            }
        }
    }
    bases.sort();
    bases.dedup();
    bases
}

/// Moves every data folder named after `LEGACY_IDENTIFIER` to `IDENTIFIER`. Must run before the
/// Tauri builder: the plugins and the main window's WebView open their folders while it builds.
pub fn migrate_folders() {
    if crate::test_data_dir::active() {
        return;
    }
    for base in bases() {
        move_folder(&base.join(LEGACY_IDENTIFIER), &base.join(IDENTIFIER));
    }
    #[cfg(windows)]
    {
        forget_legacy_aumid();
        mirror_install_location();
    }
}

fn is_empty_dir(path: &Path) -> bool {
    std::fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

/// Kept in the new folder while it holds only part of the old one, so the next start copies the
/// rest. Without it a half-done copy looks like the new version's own data and is left as is.
const MIGRATING: &str = ".migrating";

/// A file operation from one path to another, swapped in tests for one that fails.
type FsOp<'a> = &'a dyn Fn(&Path, &Path) -> std::io::Result<()>;

fn move_folder(old: &Path, new: &Path) {
    move_folder_with(old, new, &|a, b| std::fs::rename(a, b), &|a, b| {
        std::fs::copy(a, b).map(|_| ())
    });
}

fn move_folder_with(old: &Path, new: &Path, rename: FsOp, copy: FsOp) {
    let marker = new.join(MIGRATING);
    if !old.is_dir() {
        let _ = std::fs::remove_file(&marker);
        return;
    }
    if !marker.exists() {
        if new.exists() {
            // An empty folder is one something created before any data was there; anything else
            // is the new identifier's own data, which is never overwritten.
            if !is_empty_dir(new) || std::fs::remove_dir(new).is_err() {
                return;
            }
        }
        match rename(old, new) {
            Ok(()) => {
                note(format!(
                    "identifier: moved {} to {}",
                    old.display(),
                    new.display()
                ));
                return;
            }
            // A rename fails when the old version is still running and holds its files open
            // (WebView2's profile): copy what can be read, and the old folder stays for it.
            Err(e) => note(format!(
                "identifier: couldn't move {} ({e}); copying it",
                old.display()
            )),
        }
        // Marked before the first file lands, so a copy cut short by a crash is also picked up.
        let _ = std::fs::create_dir_all(new);
        let _ = std::fs::write(&marker, b"");
    }
    let (copied, missed) = copy_missing(old, new, copy);
    if missed == 0 {
        let _ = std::fs::remove_file(&marker);
        note(format!(
            "identifier: copied {copied} files from {} to {}",
            old.display(),
            new.display()
        ));
    } else {
        note(format!(
            "identifier: copied {copied} files from {} to {}; {missed} couldn't be copied and are tried again on the next start",
            old.display(),
            new.display()
        ));
    }
}

/// Copies the files of a folder tree that aren't in `to` yet: one already there was copied
/// before or saved by the new version since, and is kept. Returns how many files it copied and
/// how many it couldn't.
fn copy_missing(from: &Path, to: &Path, copy: FsOp) -> (usize, usize) {
    if std::fs::create_dir_all(to).is_err() {
        return (0, 1);
    }
    let Ok(entries) = std::fs::read_dir(from) else {
        return (0, 1);
    };
    let (mut copied, mut missed) = (0, 0);
    for entry in entries {
        let Ok(entry) = entry else {
            missed += 1;
            continue;
        };
        let src = entry.path();
        let dst = to.join(entry.file_name());
        match entry.file_type() {
            Ok(t) if t.is_dir() => {
                let (c, m) = copy_missing(&src, &dst, copy);
                copied += c;
                missed += m;
            }
            Ok(t) if t.is_file() => {
                if dst.exists() {
                    continue;
                }
                // Through a temporary name, so a copy that fails halfway never leaves a cut file
                // that the next try would take for a whole one.
                let mut tmp_name = entry.file_name();
                tmp_name.push(".nyxs-migrating");
                let tmp = to.join(tmp_name);
                if copy(&src, &tmp)
                    .and_then(|()| std::fs::rename(&tmp, &dst))
                    .is_ok()
                {
                    copied += 1;
                } else {
                    let _ = std::fs::remove_file(&tmp);
                    missed += 1;
                }
            }
            Ok(_) => {}
            Err(_) => missed += 1,
        }
    }
    (copied, missed)
}

/// Toasts register the identifier as an AppUserModelId (`agent::notify`); the old one would
/// stay behind in the registry.
#[cfg(windows)]
fn forget_legacy_aumid() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(format!(
        "Software\\Classes\\AppUserModelId\\{LEGACY_IDENTIFIER}"
    ));
}

/// Where the NSIS installer keeps the install's folder: `Software\<publisher>\Nyxs`, with the
/// publisher of `tauri.conf.json`.
#[cfg(windows)]
const INSTALL_KEY: &str = "Software\\Nyxs Code\\Nyxs";
/// The same key under the publishers of earlier versions: "destinopositivo" up to 0.8.56, and
/// "Nyxs", which those versions prepared but no release shipped.
#[cfg(windows)]
const LEGACY_INSTALL_KEYS: [(&str, &str); 2] = [
    ("Software\\destinopositivo", "Nyxs"),
    ("Software\\Nyxs", "Nyxs"),
];

/// Keeps a custom install folder across the publisher change: copies it under the new
/// publisher until an installer of the new one has written it (the installer hook covers an
/// update that comes first), then drops the old keys, which no uninstaller removes anymore.
#[cfg(windows)]
fn mirror_install_location() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let folder = |key: &RegKey| {
        key.get_value::<String, _>("")
            .ok()
            .filter(|d| !d.is_empty())
    };
    let current = hkcu.open_subkey(INSTALL_KEY).ok().and_then(|k| folder(&k));
    if current.is_none() {
        let old = LEGACY_INSTALL_KEYS.iter().find_map(|(parent, name)| {
            let key = hkcu.open_subkey(format!("{parent}\\{name}")).ok()?;
            folder(&key)
        });
        if let (Some(dir), Ok((new, _))) = (old, hkcu.create_subkey(INSTALL_KEY)) {
            let _ = new.set_value("", &dir);
        }
        return;
    }
    for (parent, name) in LEGACY_INSTALL_KEYS {
        if let Ok(p) = hkcu.open_subkey_with_flags(parent, winreg::enums::KEY_ALL_ACCESS) {
            let _ = p.delete_subkey_all(name);
            // Only when nothing else lives there: `delete_subkey` refuses a key with subkeys.
            if p.enum_keys().next().is_none() && p.enum_values().next().is_none() {
                drop(p);
                let _ = hkcu.delete_subkey(parent);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nyxs-ident-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn moves_the_legacy_folder() {
        let base = temp("move");
        let old = base.join(LEGACY_IDENTIFIER);
        std::fs::create_dir_all(old.join("browser")).unwrap();
        std::fs::write(old.join("browser/cookies"), "c").unwrap();
        move_folder(&old, &base.join(IDENTIFIER));
        assert!(!old.exists());
        assert_eq!(
            std::fs::read_to_string(base.join(IDENTIFIER).join("browser/cookies")).unwrap(),
            "c"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn replaces_an_empty_new_folder() {
        let base = temp("empty");
        let old = base.join(LEGACY_IDENTIFIER);
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("chats.json"), "[]").unwrap();
        std::fs::create_dir_all(base.join(IDENTIFIER)).unwrap();
        move_folder(&old, &base.join(IDENTIFIER));
        assert!(base.join(IDENTIFIER).join("chats.json").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn never_overwrites_the_new_folder() {
        let base = temp("keep");
        let old = base.join(LEGACY_IDENTIFIER);
        let new = base.join(IDENTIFIER);
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("chats.json"), "old").unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("chats.json"), "new").unwrap();
        move_folder(&old, &new);
        assert_eq!(
            std::fs::read_to_string(new.join("chats.json")).unwrap(),
            "new"
        );
        assert!(old.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    fn read(path: PathBuf) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn a_copy_cut_short_goes_on_at_the_next_start() {
        let base = temp("partial");
        let old = base.join(LEGACY_IDENTIFIER);
        let new = base.join(IDENTIFIER);
        std::fs::create_dir_all(old.join("EBWebView/Default")).unwrap();
        std::fs::write(old.join("chats.json"), "old chats").unwrap();
        std::fs::write(old.join("EBWebView/Default/Cookies"), "cookies").unwrap();
        std::fs::write(old.join("EBWebView/Default/Local State"), "state").unwrap();
        // The old version is still open: the folder can't be moved and its cookies can't be read.
        let busy = |_: &Path, _: &Path| Err(std::io::Error::other("in use"));
        let locked = |a: &Path, b: &Path| {
            if a.ends_with("Cookies") {
                Err(std::io::Error::other("locked"))
            } else {
                std::fs::copy(a, b).map(|_| ())
            }
        };
        move_folder_with(&old, &new, &busy, &locked);
        assert_eq!(read(new.join("chats.json")), "old chats");
        assert!(!new.join("EBWebView/Default/Cookies").exists());
        // The new version ran meanwhile and saved its own chats.
        std::fs::write(new.join("chats.json"), "new chats").unwrap();
        let free = |a: &Path, b: &Path| std::fs::copy(a, b).map(|_| ());
        move_folder_with(&old, &new, &busy, &free);
        assert_eq!(read(new.join("EBWebView/Default/Cookies")), "cookies");
        assert_eq!(read(new.join("chats.json")), "new chats");
        assert!(!new.join(MIGRATING).exists());
        // Done: later starts leave both folders alone.
        std::fs::write(old.join("late"), "x").unwrap();
        move_folder_with(&old, &new, &busy, &free);
        assert!(!new.join("late").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_missing_copies_the_tree() {
        let base = temp("copy");
        std::fs::create_dir_all(base.join("a/b")).unwrap();
        std::fs::write(base.join("a/one"), "1").unwrap();
        std::fs::write(base.join("a/b/two"), "2").unwrap();
        let copy = |a: &Path, b: &Path| std::fs::copy(a, b).map(|_| ());
        assert_eq!(
            copy_missing(&base.join("a"), &base.join("z"), &copy),
            (2, 0)
        );
        assert_eq!(std::fs::read_to_string(base.join("z/b/two")).unwrap(), "2");
        let _ = std::fs::remove_dir_all(&base);
    }
}
