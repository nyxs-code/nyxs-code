use super::*;

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

pub(crate) struct DecodedText {
    pub text: String,
    pub note: Option<&'static str>,
}

pub(crate) fn decode_for_read(bytes: &[u8]) -> Option<DecodedText> {
    if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
        return Some(DecodedText {
            text: decode_utf16(rest, u16::from_le_bytes),
            note: Some("UTF-16 LE"),
        });
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFE\xFF") {
        return Some(DecodedText {
            text: decode_utf16(rest, u16::from_be_bytes),
            note: Some("UTF-16 BE"),
        });
    }
    let body = bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes);
    if body.contains(&0) {
        return None;
    }
    match std::str::from_utf8(body) {
        Ok(s) => Some(DecodedText {
            text: s.to_string(),
            note: None,
        }),
        Err(_) => Some(DecodedText {
            text: body.iter().map(|&b| b as char).collect(),
            note: Some("Latin-1 (not valid UTF-8)"),
        }),
    }
}

fn decode_utf16(bytes: &[u8], read: fn([u8; 2]) -> u16) -> String {
    let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|c| read(*c)).collect();
    String::from_utf16_lossy(&units)
}

pub(crate) struct TextFile {
    pub text: String,
    pub bom: bool,
    pub crlf: bool,
}

pub(crate) fn detect_crlf(text: &str) -> bool {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    crlf > lf
}

pub(crate) fn load_for_edit(path: &str) -> Result<TextFile, String> {
    let bytes = super::vfs::read(path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    if bytes.starts_with(b"\xFF\xFE") || bytes.starts_with(b"\xFE\xFF") {
        return Err(format!(
            "{path} is UTF-16: it can't be edited without converting it. Convert it to UTF-8 with Bash if the user approves."
        ));
    }
    let bom = bytes.starts_with(UTF8_BOM);
    let body = if bom {
        bytes[UTF8_BOM.len()..].to_vec()
    } else {
        bytes
    };
    let text = String::from_utf8(body).map_err(|_| {
        format!(
            "{path} isn't UTF-8 (probably Latin-1/Windows-1252): editing it as text would corrupt it. Convert it to UTF-8 with Bash if the user approves."
        )
    })?;
    let crlf = detect_crlf(&text);
    Ok(TextFile { text, bom, crlf })
}

pub(crate) fn match_eol(s: &str, crlf: bool) -> String {
    let lf = s.replace("\r\n", "\n");
    if crlf {
        lf.replace('\n', "\r\n")
    } else {
        lf
    }
}

pub(crate) fn save_text(path: &str, text: &str, bom: bool) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if bom {
        bytes.extend_from_slice(UTF8_BOM);
    }
    bytes.extend_from_slice(text.as_bytes());
    super::vfs::write_atomic(path, &bytes).map_err(|e| format!("Couldn't write {path}: {e}"))
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let target = resolve_file(path);
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return fs::write(path, bytes);
    };
    let tmp = dir.join(format!(
        ".{}.nyxs-{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let staged = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        if let Ok(meta) = fs::metadata(&target) {
            let _ = fs::set_permissions(&tmp, meta.permissions());
        }
        rename_retrying(&tmp, &target)
    })();
    if staged.is_err() {
        let _ = fs::remove_file(&tmp);
        return fs::write(&target, bytes);
    }
    Ok(())
}

/// On Windows a file another process has open for a moment (an antivirus scan, the search
/// indexer, a reader in this app) can't be replaced: the rename fails with "Access denied" and
/// the session wasn't saved. A few short tries get past it.
fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 0u64;
    loop {
        match fs::rename(from, to) {
            Err(e) if attempt < 4 && e.kind() == std::io::ErrorKind::PermissionDenied => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(25 * attempt));
            }
            other => return other,
        }
    }
}

pub(crate) fn mtime_ms(path: &str) -> Option<u64> {
    super::vfs::metadata(path)
        .ok()
        .filter(|m| m.is_file)
        .map(|m| m.mtime)
}

/// A file's lock, held from reading it to writing it back, so two writes to the same file
/// (parallel tool calls, two sessions of this app) go one after the other instead of the later
/// one undoing the earlier. Writes to different files don't wait for each other. Another
/// process (Claude Code, an editor) isn't covered: the mtime check catches it.
pub(crate) fn edit_lock(path: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // Locks no caller holds any more go, so the map doesn't keep every file ever written.
    locks.retain(|_, lock| Arc::strong_count(lock) > 1);
    locks.entry(edit_key(path)).or_default().clone()
}

/// The same file however the path is written: made absolute, through `..` and links as far
/// as it exists, `\` as `/`, and case-insensitive on Windows. A remote path is kept as is.
pub(crate) fn edit_key(path: &str) -> String {
    if crate::remote::is_remote(path) {
        return path.to_string();
    }
    let given = Path::new(path);
    let abs = if given.is_absolute() {
        given.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|d| d.join(given))
            .unwrap_or_else(|_| given.to_path_buf())
    };
    let key = resolve_file(&abs).to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    }
}

/// The real path of a file, or the path as given when it can't be resolved. Not a bare
/// `canonicalize`: on Windows that can answer with the path of the copy another write is
/// replacing, and an edit that got it took a lock of its own and undid the other one.
fn resolve_file(path: &Path) -> PathBuf {
    super::scope::resolve_path(path).unwrap_or_else(|| path.to_path_buf())
}

pub(crate) fn check_unchanged(path: &str, expected: Option<u64>) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    match mtime_ms(path) {
        Some(now) if now != expected => Err(format!(
            "{path} changed on disk since your last read (edited outside). Nothing was applied: read it again and redo the change."
        )),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf16_and_latin1_for_reading() {
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("hola\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()))
            .collect();
        let d = decode_for_read(&utf16).unwrap();
        assert_eq!((d.text.as_str(), d.note), ("hola\r\n", Some("UTF-16 LE")));
        let latin = decode_for_read(b"caf\xE9").unwrap();
        assert_eq!(latin.text, "café");
        assert!(latin.note.unwrap().contains("Latin-1"));
        assert_eq!(decode_for_read(b"\xEF\xBB\xBFabc").unwrap().text, "abc");
        assert!(decode_for_read(b"a\0b").is_none());
    }

    #[test]
    fn eol_follows_the_file() {
        assert!(detect_crlf("a\r\nb\r\nc\n"));
        assert!(!detect_crlf("a\nb\nc\r\n"));
        assert_eq!(match_eol("x\ny\r\nz", true), "x\r\ny\r\nz");
        assert_eq!(match_eol("x\r\ny", false), "x\ny");
    }

    #[test]
    fn one_lock_per_file_however_its_path_is_written() {
        let dir = std::env::temp_dir().join(format!("nyxs-edit-key-{}", std::process::id()));
        fs::create_dir_all(dir.join("sub")).unwrap();
        let file = dir.join("Notes.txt");
        fs::write(&file, "x").unwrap();
        let plain = edit_key(&file.to_string_lossy());
        let dotted = edit_key(
            &dir.join("sub")
                .join("..")
                .join("Notes.txt")
                .to_string_lossy(),
        );
        let slashed = edit_key(&file.to_string_lossy().replace('\\', "/"));
        // A file not written yet, in the same folder, by two spellings.
        let new_a = edit_key(&dir.join("new.txt").to_string_lossy());
        let new_b = edit_key(&dir.join("sub").join("..").join("new.txt").to_string_lossy());
        let cwd = std::env::current_dir().unwrap();
        let relative = edit_key("Cargo.toml");
        let absolute = edit_key(&cwd.join("Cargo.toml").to_string_lossy());
        #[cfg(windows)]
        let upper = edit_key(&file.to_string_lossy().to_uppercase());
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(plain, dotted);
        assert_eq!(plain, slashed);
        assert_eq!(new_a, new_b);
        assert_eq!(relative, absolute);
        #[cfg(windows)]
        assert_eq!(plain, upper);
        assert_ne!(plain, new_a);
        assert!(Arc::ptr_eq(
            &edit_lock("ssh://h/a"),
            &edit_lock("ssh://h/a")
        ));
    }

    #[test]
    fn the_lock_key_holds_while_another_write_replaces_the_file() {
        let dir = std::env::temp_dir().join(format!("nyxs-key-race-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, "x").unwrap();
        let path = file.to_string_lossy().to_string();
        let expected = edit_key(&path);
        let real = super::super::scope::resolve_path(&file);
        assert!(real.is_some());
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer = {
            let stop = stop.clone();
            let file = file.clone();
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let _ = write_atomic(&file, b"y");
                }
            })
        };
        // The path the scope check confines, too: a wrong one denied the edit.
        let odd = (0..20_000).find(|_| {
            edit_key(&path) != expected || super::super::scope::resolve_path(&file) != real
        });
        stop.store(true, Ordering::Relaxed);
        writer.join().unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(odd, None);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_shares_its_target_lock_and_writes_go_through_it() {
        let dir = std::env::temp_dir().join(format!("nyxs-key-link-{}", std::process::id()));
        fs::create_dir_all(dir.join("real")).unwrap();
        let file = dir.join("real").join("a.txt");
        fs::write(&file, "old").unwrap();
        let link = dir.join("link.txt");
        std::os::unix::fs::symlink("real/a.txt", &link).unwrap();
        let same = edit_key(&link.to_string_lossy()) == edit_key(&file.to_string_lossy());
        write_atomic(&link, b"new").unwrap();
        let content = fs::read_to_string(&file).unwrap();
        let still_link = fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink();
        let _ = fs::remove_dir_all(&dir);
        assert!(same);
        assert_eq!(content, "new");
        assert!(still_link);
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp_files() {
        let dir = std::env::temp_dir().join(format!("nyxs-atomic-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, "old").unwrap();
        write_atomic(&file, b"new").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        let leftovers = fs::read_dir(&dir).unwrap().count();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(leftovers, 1);
    }
}
