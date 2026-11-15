use super::*;

#[tauri::command]
pub fn nyxs_set_account(account: Option<String>) {
    let v = account
        .map(|s| sanitize_account_id(&s))
        .filter(|s| !s.is_empty());
    if let Ok(mut g) = account_slot().lock() {
        *g = v;
    }
}

fn adopt_move(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() || dst.exists() {
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    fs::rename(src, dst)
        .map_err(|e| format!("Couldn't move {} to {}: {e}", src.display(), dst.display()))?;
    Ok(())
}

#[tauri::command]
pub fn nyxs_adopt_account_data(app: AppHandle, account: String) -> Result<(), String> {
    let uid = sanitize_account_id(&account);
    if uid.is_empty() {
        return Err("account is empty".into());
    }

    if let Ok(data_dir) = app.path().app_data_dir() {
        let dest = data_dir.join("accounts").join(&uid);
        adopt_move(&data_dir.join("chats.json"), &dest.join("chats.json"))?;
    }

    let nyxs = home_dir()?.join(".nyxs");
    let dest = nyxs.join("accounts").join(&uid);
    adopt_move(&nyxs.join("projects"), &dest.join("projects"))?;
    adopt_move(&nyxs.join("nyxs.json"), &dest.join("nyxs.json"))?;
    adopt_move(
        &nyxs.join("usage-stats.json"),
        &dest.join("usage-stats.json"),
    )?;
    Ok(())
}

fn chats_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Couldn't get the data directory: {e}"))?;
    let dir = account_scoped(dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the data directory: {e}"))?;
    Ok(dir.join("chats.json"))
}

/// The chat commands run on worker threads, so the main thread doesn't stop for a big chat's
/// JSON. They used to run one after another on it; this lock keeps two of them from writing (or
/// a load from setting a corrupt file aside) at the same time. The order of a chat's own saves
/// is kept by the app, which sends the next one only after the previous one answered.
fn chat_files_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command(async)]
pub fn nyxs_load_chats(app: AppHandle) -> Result<String, String> {
    let _lock = chat_files_lock();
    read_chat_json(&chats_file(&app)?)
}

/// A saved chat file's JSON, or `""` when there's none. A file that's there but can't be read
/// is an error, not `""`: the app would take it for empty and save over it. One that reads but
/// isn't JSON is set aside as `.corrupt` (so its content survives) and then counts as none.
fn read_chat_json(path: &Path) -> Result<String, String> {
    load_chat_json(path).map(|(text, _)| text)
}

/// [`read_chat_json`], also saying where a corrupt file was moved.
fn load_chat_json(path: &Path) -> Result<(String, Option<PathBuf>), String> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((String::new(), None)),
        Err(e) => return Err(format!("Couldn't read {}: {e}", path.display())),
    };
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim_start_matches('\u{feff}');
    if text.trim().is_empty() || serde_json::from_str::<serde_json::Value>(text).is_ok() {
        return Ok((text.to_string(), None));
    }
    let aside = corrupt_path(path);
    fs::rename(path, &aside).map_err(|e| {
        format!(
            "{} isn't valid JSON and couldn't be set aside: {e}",
            path.display()
        )
    })?;
    eprintln!(
        "[chats] {} isn't valid JSON; moved it to {}",
        path.display(),
        aside.display()
    );
    Ok((String::new(), Some(aside)))
}

/// `<file>.corrupt`, or a numbered name when an earlier one is already there.
fn corrupt_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let first = path.with_file_name(format!("{name}.corrupt"));
    if !first.exists() {
        return first;
    }
    (1..)
        .map(|n| path.with_file_name(format!("{name}.corrupt-{n}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

fn sanitize_chat_id(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(128)
        .collect()
}

fn chats_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Couldn't get the data directory: {e}"))?;
    let dir = account_scoped(dir).join("chats");
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the chats directory: {e}"))?;
    Ok(dir)
}

/// Flushed to disk before it replaces the old file, so a power cut can't leave it zeroed.
fn write_atomic(path: &Path, json: &str) -> Result<(), String> {
    super::text_io::write_atomic(path, json.as_bytes())
        .map_err(|e| format!("Couldn't write {}: {e}", path.display()))
}

#[tauri::command(async)]
pub fn nyxs_load_chat_index(app: AppHandle) -> Result<String, String> {
    let _lock = chat_files_lock();
    load_chat_json(&chats_dir(&app)?.join("index.json")).map(index_json)
}

/// The index as read. One that was corrupt comes back as an empty index naming where it went
/// (`setAside`), so the app can tell the user the list was moved, not lost.
fn index_json((text, aside): (String, Option<PathBuf>)) -> String {
    match aside {
        Some(aside) => serde_json::json!({
            "version": 2,
            "activeId": null,
            "chats": [],
            "setAside": aside.to_string_lossy(),
        })
        .to_string(),
        None => text,
    }
}

#[tauri::command(async)]
pub fn nyxs_save_chat_index(app: AppHandle, json: String) -> Result<(), String> {
    let _lock = chat_files_lock();
    let path = chats_dir(&app)?.join("index.json");
    write_atomic(&path, &json)
}

#[tauri::command(async)]
pub fn nyxs_load_chat(app: AppHandle, id: String) -> Result<String, String> {
    let _lock = chat_files_lock();
    let id = sanitize_chat_id(&id);
    if id.is_empty() {
        return Err("invalid chat id".into());
    }
    read_chat_json(&chats_dir(&app)?.join(format!("{id}.json")))
}

#[tauri::command(async)]
pub fn nyxs_save_chat(app: AppHandle, id: String, json: String) -> Result<(), String> {
    let _lock = chat_files_lock();
    let id = sanitize_chat_id(&id);
    if id.is_empty() {
        return Err("invalid chat id".into());
    }
    let path = chats_dir(&app)?.join(format!("{id}.json"));
    write_atomic(&path, &json)
}

#[tauri::command(async)]
pub fn nyxs_delete_chat(app: AppHandle, id: String) -> Result<(), String> {
    let _lock = chat_files_lock();
    let id = sanitize_chat_id(&id);
    if id.is_empty() {
        return Ok(());
    }
    let path = chats_dir(&app)?.join(format!("{id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Couldn't delete the chat: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nyxs-chats-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_chat_file_reads_as_empty_and_a_good_one_as_is() {
        let dir = temp_dir("ok");
        let file = dir.join("index.json");
        let missing = read_chat_json(&file);
        fs::write(&file, "\u{feff}{\"version\":2,\"chats\":[]}").unwrap();
        let good = read_chat_json(&file);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(missing, Ok(String::new()));
        assert_eq!(good, Ok("{\"version\":2,\"chats\":[]}".to_string()));
    }

    #[test]
    fn a_chat_file_that_cant_be_read_is_an_error_not_empty() {
        let dir = temp_dir("unreadable");
        // A folder where the file should be: it exists, but reading it fails.
        let file = dir.join("index.json");
        fs::create_dir_all(&file).unwrap();
        let read = read_chat_json(&file);
        let still_there = file.exists();
        let _ = fs::remove_dir_all(&dir);
        assert!(read.is_err());
        assert!(still_there);
    }

    #[test]
    fn a_corrupt_chat_file_is_set_aside_with_its_content() {
        let dir = temp_dir("corrupt");
        let file = dir.join("abc.json");
        fs::write(&file, "{\"messages\":[").unwrap();
        let first = read_chat_json(&file);
        fs::write(&file, "\0\0\0\0").unwrap();
        let second = read_chat_json(&file);
        let aside = fs::read_to_string(dir.join("abc.json.corrupt"));
        let aside_2 = fs::read(dir.join("abc.json.corrupt-1"));
        let gone = !file.exists();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(first, Ok(String::new()));
        assert_eq!(second, Ok(String::new()));
        assert_eq!(aside.unwrap(), "{\"messages\":[");
        assert_eq!(aside_2.unwrap(), b"\0\0\0\0");
        assert!(gone);
    }

    #[test]
    fn a_corrupt_index_comes_back_empty_naming_where_it_went() {
        let dir = temp_dir("index");
        let file = dir.join("index.json");
        fs::write(&file, "{\"chats\":[").unwrap();
        let read = load_chat_json(&file).map(index_json).unwrap();
        let fine = index_json(("{\"chats\":[]}".into(), None));
        let _ = fs::remove_dir_all(&dir);
        let v: serde_json::Value = serde_json::from_str(&read).unwrap();
        assert_eq!(v["chats"], serde_json::json!([]));
        assert!(v["setAside"]
            .as_str()
            .unwrap()
            .ends_with("index.json.corrupt"));
        assert_eq!(fine, "{\"chats\":[]}");
    }

    #[test]
    fn atomic_chat_write_replaces_the_file() {
        let dir = temp_dir("write");
        let file = dir.join("index.json");
        fs::write(&file, "old").unwrap();
        write_atomic(&file, "{}").unwrap();
        let content = fs::read_to_string(&file).unwrap();
        let entries = fs::read_dir(&dir).unwrap().count();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(content, "{}");
        assert_eq!(entries, 1);
    }
}
