use super::vfs;
use super::*;

/// The folder of a project's sessions, its data folder: on this PC, or on the remote machine for
/// an `ssh://` project (see `project_paths::project_data_dir_str`). A path or an `ssh://` URI.
/// The same folder as every other feature's, which `project_data_dir` moves to its new name.
pub(super) fn sessions_dir(workspace: &str) -> Result<String, String> {
    if workspace.is_empty() {
        return Err("A workspace is required for sessions".to_string());
    }
    crate::project_paths::project_data_dir_str(workspace).ok_or_else(|| {
        if crate::remote::is_remote(workspace) {
            "Couldn't reach the remote machine to read its sessions.".to_string()
        } else {
            "Couldn't find the home folder for sessions.".to_string()
        }
    })
}

fn session_jsonl(workspace: &str, session_id: &str) -> Result<String, String> {
    Ok(vfs::join(
        &sessions_dir(workspace)?,
        &format!("{}.jsonl", safe_component(session_id)),
    ))
}

pub(super) fn session_meta_path(workspace: &str, session_id: &str) -> Result<String, String> {
    Ok(vfs::join(
        &sessions_dir(workspace)?,
        &format!("{}.meta.json", safe_component(session_id)),
    ))
}

/// The folder, in a project's data folder, with one empty file per deleted session. Written
/// before the session's files are removed, so the delete holds against whatever writes the
/// session afterwards: a save already on its way, another window, another Nyxs on the same
/// project. Sessions with a mark are never listed nor written again.
const DELETED_SESSIONS: &str = ".deleted-sessions";

fn deleted_mark(workspace: &str, session_id: &str) -> Result<String, String> {
    Ok(vfs::join(
        &vfs::join(&sessions_dir(workspace)?, DELETED_SESSIONS),
        &safe_component(session_id),
    ))
}

fn is_deleted(workspace: &str, session_id: &str) -> bool {
    deleted_mark(workspace, session_id).is_ok_and(|p| vfs::exists(&p))
}

pub(super) fn file_mtime_ms(path: &Path) -> f64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn ensure_dir_of(path: &str) -> Result<(), String> {
    // A remote write makes its own folders.
    if crate::remote::is_remote(path) {
        return Ok(());
    }
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Couldn't create the sessions folder: {e}"))?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn nyxs_session_append(
    workspace: String,
    session_id: String,
    line: String,
) -> Result<(), String> {
    if is_deleted(&workspace, &session_id) {
        return Ok(());
    }
    let path = session_jsonl(&workspace, &session_id)?;
    ensure_dir_of(&path)?;
    let mut buf = line;
    buf.push('\n');
    vfs::append(&path, buf.as_bytes()).map_err(|e| format!("Couldn't write to the session: {e}"))
}

fn unchanged(path: &str, content: &str) -> bool {
    vfs::read(path).is_ok_and(|existing| existing == content.as_bytes())
}

#[cfg(test)]
mod unchanged_tests {
    use super::*;

    #[test]
    fn only_identical_content_counts_as_unchanged() {
        let path = std::env::temp_dir().join(format!(
            "nyxs-session-unchanged-{}.jsonl",
            std::process::id()
        ));
        let p = path.to_string_lossy().to_string();
        assert!(!unchanged(
            &p, "a
"
        ));
        fs::write(
            &path, "a
",
        )
        .unwrap();
        assert!(unchanged(
            &p, "a
"
        ));
        assert!(!unchanged(
            &p, "a
b
"
        ));
        let _ = fs::remove_file(&path);
    }
}

#[tauri::command(async)]
pub fn nyxs_session_write_transcript(
    workspace: String,
    session_id: String,
    content: String,
) -> Result<(), String> {
    if is_deleted(&workspace, &session_id) {
        return Ok(());
    }
    let path = session_jsonl(&workspace, &session_id)?;
    // The transcript's mtime orders Recents, so only real changes may touch it: opening a
    // session saves it again with the same content, which used to bump it to the top.
    if unchanged(&path, &content) {
        return Ok(());
    }
    ensure_dir_of(&path)?;
    vfs::write_atomic(&path, content.as_bytes())
        .map_err(|e| format!("Couldn't save the session: {e}"))
}

#[tauri::command(async)]
pub fn nyxs_session_write_meta(
    workspace: String,
    session_id: String,
    json: String,
) -> Result<(), String> {
    if is_deleted(&workspace, &session_id) {
        return Ok(());
    }
    let path = session_meta_path(&workspace, &session_id)?;
    ensure_dir_of(&path)?;
    vfs::write_atomic(&path, json.as_bytes()).map_err(|e| format!("Couldn't save the session: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionData {
    transcript: String,
    meta: String,
    /// Why the files couldn't be read; both are then empty and must not be taken for the session.
    error: Option<String>,
    /// The session's folder on this PC, for the app to offer opening it when `error` is set;
    /// none for a remote project's, which can't be opened here.
    dir: Option<String>,
}

#[tauri::command(async)]
pub fn nyxs_session_read(workspace: String, session_id: String) -> Result<SessionData, String> {
    Ok(read_session_data(
        sessions_dir(&workspace)?,
        &session_jsonl(&workspace, &session_id)?,
        &session_meta_path(&workspace, &session_id)?,
    ))
}

/// Only the session's meta (`transcript` is left empty): what edits of the meta (a rename, a PR
/// link, a save) read, without sending the whole transcript over IPC.
#[tauri::command(async)]
pub fn nyxs_session_read_meta(
    workspace: String,
    session_id: String,
) -> Result<SessionData, String> {
    Ok(read_meta_data(
        sessions_dir(&workspace)?,
        &session_meta_path(&workspace, &session_id)?,
    ))
}

fn read_meta_data(dir: String, meta: &str) -> SessionData {
    let dir = (!crate::remote::is_remote(&dir)).then_some(dir);
    match read_session_file(meta) {
        Ok(meta) => SessionData {
            transcript: String::new(),
            meta,
            error: None,
            dir,
        },
        Err(e) => SessionData {
            transcript: String::new(),
            meta: String::new(),
            error: Some(e),
            dir,
        },
    }
}

fn read_session_data(dir: String, transcript: &str, meta: &str) -> SessionData {
    let dir = (!crate::remote::is_remote(&dir)).then_some(dir);
    let read = read_session_file(transcript).and_then(|t| Ok((t, read_session_file(meta)?)));
    match read {
        Ok((transcript, meta)) => SessionData {
            transcript,
            meta,
            error: None,
            dir,
        },
        Err(e) => SessionData {
            transcript: String::new(),
            meta: String::new(),
            error: Some(e),
            dir,
        },
    }
}

/// A session file's text, `""` when it doesn't exist. Any other failure (a file another process
/// holds for a moment on Windows, a dropped SSH link) is an error: read as `""`, the session
/// would open empty and its next save would replace it. Bad UTF-8 costs only the bad bytes.
fn read_session_file(path: &str) -> Result<String, String> {
    match vfs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Couldn't read the session ({path}): {e}")),
    }
}

#[cfg(test)]
mod read_tests {
    use super::*;

    #[test]
    fn reading_a_session_file_only_answers_empty_when_it_is_missing() {
        let dir = std::env::temp_dir().join(format!("nyxs-session-read-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = |name: &str| dir.join(name).to_string_lossy().to_string();
        fs::write(dir.join("bad.jsonl"), b"{\"content\":\"caf\xE9\"}\n").unwrap();
        // A folder where the file should be: it's there, but reading it fails.
        fs::create_dir_all(dir.join("locked.jsonl")).unwrap();
        let missing = read_session_file(&path("none.jsonl"));
        let lossy = read_session_file(&path("bad.jsonl"));
        let failed = read_session_file(&path("locked.jsonl"));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(missing, Ok(String::new()));
        assert_eq!(lossy, Ok("{\"content\":\"caf\u{FFFD}\"}\n".to_string()));
        assert!(failed.is_err());
    }

    #[test]
    fn an_unreadable_session_comes_back_as_an_error_with_its_folder() {
        let dir = std::env::temp_dir().join(format!("nyxs-session-data-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("s.meta.json")).unwrap();
        fs::write(dir.join("s.jsonl"), "{}\n").unwrap();
        let p = |name: &str| dir.join(name).to_string_lossy().to_string();
        let data = read_session_data(p(""), &p("s.jsonl"), &p("s.meta.json"));
        let fine = read_session_data(p(""), &p("s.jsonl"), &p("none.meta.json"));
        let _ = fs::remove_dir_all(&dir);
        assert!(data.error.is_some());
        assert_eq!((data.transcript.as_str(), data.meta.as_str()), ("", ""));
        assert_eq!(data.dir, Some(p("")));
        let remote = read_session_data("ssh://box/home/me/.nyxs/projects/r".into(), "", "");
        assert_eq!(remote.dir, None);
        assert_eq!(fine.error, None);
        assert_eq!(fine.transcript, "{}\n");
    }
}

#[cfg(test)]
mod list_tests {
    use super::*;

    #[test]
    fn a_deleted_session_is_never_written_or_listed_again() {
        std::env::set_var(
            "NYXS_PROJECTS_ROOT",
            std::env::temp_dir().join("nyxs-test-projects"),
        );
        let ws = format!(r"C:\nyxs-deleted-{}\App", std::process::id());
        let (id, keep) = ("gone-session".to_string(), "kept-session".to_string());
        nyxs_session_append(ws.clone(), id.clone(), "{}".into()).unwrap();
        nyxs_session_append(ws.clone(), keep.clone(), "{}".into()).unwrap();
        nyxs_session_delete(ws.clone(), id.clone()).unwrap();
        // A save that was on its way, another window, another Nyxs: none brings it back.
        nyxs_session_write_transcript(ws.clone(), id.clone(), "{}\n".into()).unwrap();
        nyxs_session_write_meta(ws.clone(), id.clone(), "{\"title\":\"t\"}".into()).unwrap();
        nyxs_session_append(ws.clone(), id.clone(), "{}".into()).unwrap();
        assert!(!vfs::exists(&session_jsonl(&ws, &id).unwrap()));
        // Nor a file written around the delete, which the listing removes.
        fs::write(session_jsonl(&ws, &id).unwrap(), "{}\n").unwrap();
        let ids: Vec<String> = nyxs_list_sessions(ws.clone())
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec![keep.clone()]);
        assert!(!vfs::exists(&session_jsonl(&ws, &id).unwrap()));
        let _ = fs::remove_dir_all(sessions_dir(&ws).unwrap());
    }

    #[test]
    fn an_unchanged_file_is_not_read_again() {
        let dir = std::env::temp_dir().join(format!("nyxs-session-list-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s.jsonl");
        fs::write(&file, "{}\n{}\n").unwrap();
        let p = file.to_string_lossy().to_string();
        let first = message_count(&p, 6, 1000);
        // Gone, but listed with the same size and time: the count is the one already known.
        fs::remove_file(&file).unwrap();
        let cached = message_count(&p, 6, 1000);
        let changed = message_count(&p, 9, 2000);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!((first, cached, changed), (2, 2, 0));
    }

    #[test]
    fn reading_the_meta_leaves_the_transcript_out() {
        let dir = std::env::temp_dir().join(format!("nyxs-session-meta-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("bad.meta.json")).unwrap();
        fs::write(dir.join("s.meta.json"), "{\"title\":\"t\"}").unwrap();
        let p = |name: &str| dir.join(name).to_string_lossy().to_string();
        let ok = read_meta_data(p(""), &p("s.meta.json"));
        let missing = read_meta_data(p(""), &p("none.meta.json"));
        let bad = read_meta_data(p(""), &p("bad.meta.json"));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(
            (ok.meta.as_str(), ok.transcript.as_str(), ok.error),
            ("{\"title\":\"t\"}", "", None)
        );
        assert_eq!((missing.meta.as_str(), missing.error), ("", None));
        assert!(bad.error.is_some());
        assert_eq!(bad.dir, Some(p("")));
    }
}

#[tauri::command(async)]
pub fn nyxs_session_delete(workspace: String, session_id: String) -> Result<(), String> {
    // The mark first: if it can't be written the session isn't deleted, rather than deleted
    // until the next save brings it back.
    let mark = deleted_mark(&workspace, &session_id)?;
    ensure_dir_of(&mark)?;
    vfs::write(&mark, b"").map_err(|e| format!("Couldn't delete the session: {e}"))?;
    let _ = vfs::remove_file(&session_jsonl(&workspace, &session_id)?);
    let _ = vfs::remove_file(&session_meta_path(&workspace, &session_id)?);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    id: String,
    meta: String,
    modified_at: f64,
    message_count: usize,
    git_branch: Option<String>,
}

fn git_branch_of(workspace: &str) -> Option<String> {
    let head = vfs::read_to_string(&vfs::join(&vfs::join(workspace, ".git"), "HEAD")).ok()?;
    let head = head.trim();
    head.strip_prefix("ref: refs/heads/").map(|s| s.to_string())
}

/// What a listing read of a file, by its path, with the size and modification time it had then.
/// The list is read again after every save: a file whose size and time haven't changed isn't
/// read again (a remote one is a trip over SSH, and transcripts grow large).
struct Seen<T> {
    len: u64,
    mtime: u64,
    value: T,
}

type SeenMap<T> = Mutex<HashMap<String, Seen<T>>>;

fn seen<T: Clone>(
    map: &'static OnceLock<SeenMap<T>>,
    path: &str,
    len: u64,
    mtime: u64,
    read: impl FnOnce() -> T,
) -> T {
    let map = map.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(s) = map.lock().unwrap_or_else(|e| e.into_inner()).get(path) {
        if s.len == len && s.mtime == mtime {
            return s.value.clone();
        }
    }
    let value = read();
    map.lock().unwrap_or_else(|e| e.into_inner()).insert(
        path.to_string(),
        Seen {
            len,
            mtime,
            value: value.clone(),
        },
    );
    value
}

/// A transcript's message count: one per line.
fn message_count(path: &str, len: u64, mtime: u64) -> usize {
    static COUNTS: OnceLock<SeenMap<usize>> = OnceLock::new();
    seen(&COUNTS, path, len, mtime, || {
        vfs::read(path)
            .map(|b| b.iter().filter(|&&c| c == b'\n').count())
            .unwrap_or(0)
    })
}

fn listed_meta(path: &str, len: u64, mtime: u64) -> String {
    static METAS: OnceLock<SeenMap<String>> = OnceLock::new();
    seen(&METAS, path, len, mtime, || {
        vfs::read_to_string(path).unwrap_or_default()
    })
}

#[tauri::command(async)]
pub fn nyxs_list_sessions(workspace: String) -> Result<Vec<SessionSummary>, String> {
    let dir = sessions_dir(&workspace)?;
    let mut out: Vec<SessionSummary> = Vec::new();
    let Ok(entries) = vfs::read_dir(&dir) else {
        return Ok(out);
    };
    let branch = git_branch_of(&workspace);
    let deleted: std::collections::HashSet<String> =
        vfs::read_dir(&vfs::join(&dir, DELETED_SESSIONS))
            .map(|marks| marks.into_iter().map(|m| m.name).collect())
            .unwrap_or_default();
    let metas: HashMap<&str, (u64, u64)> = entries
        .iter()
        .filter_map(|e| Some((e.name.strip_suffix(".meta.json")?, (e.len, e.mtime))))
        .collect();
    for entry in &entries {
        let Some(id) = entry.name.strip_suffix(".jsonl") else {
            continue;
        };
        let path = vfs::join(&dir, &entry.name);
        if deleted.contains(&safe_component(id)) {
            // Written after its delete (a save racing it): it goes again.
            let _ = vfs::remove_file(&path);
            let _ = vfs::remove_file(&session_meta_path(&workspace, id)?);
            continue;
        }
        let meta = match metas.get(id) {
            Some(&(len, mtime)) => listed_meta(&session_meta_path(&workspace, id)?, len, mtime),
            None => String::new(),
        };
        let message_count = message_count(&path, entry.len, entry.mtime);
        out.push(SessionSummary {
            id: id.to_string(),
            meta,
            modified_at: entry.mtime as f64,
            message_count,
            git_branch: branch.clone(),
        });
    }
    out.sort_by(|a, b| {
        b.modified_at
            .partial_cmp(&a.modified_at)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

fn projects_root() -> Result<PathBuf, String> {
    match std::env::var("NYXS_PROJECTS_ROOT") {
        Ok(p) if !p.is_empty() => Ok(PathBuf::from(p)),
        _ => Ok(account_scoped(home_dir()?.join(".nyxs")).join("projects")),
    }
}

fn newest_mtime(paths: &[PathBuf]) -> Option<SystemTime> {
    paths
        .iter()
        .filter_map(|p| fs::metadata(p).and_then(|m| m.modified()).ok())
        .max()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    sessions_deleted: usize,
    projects_scanned: usize,
}

#[tauri::command(async)]
pub fn nyxs_cleanup_old_sessions(period_days: u64) -> Result<CleanupReport, String> {
    let mut report = CleanupReport {
        sessions_deleted: 0,
        projects_scanned: 0,
    };
    if period_days == 0 {
        return Ok(report);
    }
    let cutoff = match SystemTime::now().checked_sub(Duration::from_secs(period_days * 86_400)) {
        Some(t) => t,
        None => return Ok(report),
    };
    let root = projects_root()?;
    let Ok(projects) = fs::read_dir(&root) else {
        return Ok(report);
    };
    for project in projects.flatten() {
        let pdir = project.path();
        if !pdir.is_dir() {
            continue;
        }
        report.projects_scanned += 1;
        let Ok(entries) = fs::read_dir(&pdir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(id) = name.strip_suffix(".jsonl") else {
                continue;
            };
            let meta_path = pdir.join(format!("{id}.meta.json"));
            let Some(mtime) = newest_mtime(&[path.clone(), meta_path.clone()]) else {
                continue;
            };
            if mtime >= cutoff {
                continue;
            }

            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(&meta_path);
            let _ = fs::remove_dir_all(pdir.join("file-history").join(id));
            report.sessions_deleted += 1;
        }
    }
    Ok(report)
}

#[cfg(test)]
mod dir_tests {
    use super::*;

    #[test]
    fn sessions_live_in_the_projects_data_folder_by_its_new_name() {
        std::env::set_var(
            "NYXS_PROJECTS_ROOT",
            std::env::temp_dir().join("nyxs-test-projects"),
        );
        let ws = format!(r"C:\nyxs-sessions-dir-{}\App", std::process::id());
        let dir = sessions_dir(&ws).unwrap();
        // Where the snapshots, the index and the rest go: one folder moved, not sessions left behind.
        assert_eq!(
            Some(dir.clone()),
            crate::project_paths::project_data_dir_str(&ws)
        );
        assert_eq!(sessions_dir(&ws.to_lowercase()).unwrap(), dir);
        assert!(!dir.ends_with(&crate::project_paths::encode_project_path(&ws)));
    }
}
