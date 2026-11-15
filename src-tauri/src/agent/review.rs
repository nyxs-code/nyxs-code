use super::vfs;
use super::*;

const REVIEW_MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewText {
    exists: bool,
    text: Option<String>,
}

fn review_state_file(workspace: &str, session_id: &str) -> String {
    let dir = crate::project_paths::project_feature_dir_str(workspace, "review")
        .unwrap_or_else(|| vfs::join(&vfs::join(workspace, ".nyxs"), "review"));
    vfs::join(&dir, &format!("{}.json", safe_component(session_id)))
}

fn ensure_parent(path: &str) -> Result<(), String> {
    if crate::remote::is_remote(path) {
        return Ok(());
    }
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Couldn't create the folder for {path}: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn agent_review_read(path: String) -> Result<ReviewText, String> {
    confine(&path, None)?;
    let Ok(meta) = vfs::metadata(&path) else {
        return Ok(ReviewText {
            exists: false,
            text: None,
        });
    };
    if !meta.is_file {
        return Err(format!("{path} isn't a file"));
    }
    if meta.len > REVIEW_MAX_BYTES {
        return Ok(ReviewText {
            exists: true,
            text: None,
        });
    }
    let bytes = vfs::read(&path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    let text = if bytes.contains(&0) {
        None
    } else {
        String::from_utf8(bytes).ok()
    };
    Ok(ReviewText { exists: true, text })
}

#[tauri::command(async)]
pub fn agent_review_write(path: String, content: Option<String>) -> Result<(), String> {
    confine(&path, None)?;
    match content {
        None => {
            if vfs::is_file(&path) {
                vfs::remove_file(&path).map_err(|e| format!("Couldn't delete {path}: {e}"))?;
            }
            Ok(())
        }
        Some(text) => {
            ensure_parent(&path)?;
            vfs::write(&path, text.as_bytes()).map_err(|e| format!("Couldn't write {path}: {e}"))
        }
    }
}

#[tauri::command(async)]
pub fn agent_review_save(
    workspace: String,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let file = review_state_file(&workspace, &session_id);
    if data.is_empty() {
        if vfs::is_file(&file) {
            vfs::remove_file(&file).map_err(|e| format!("Couldn't delete the review: {e}"))?;
        }
        return Ok(());
    }
    ensure_parent(&file)?;
    vfs::write(&file, data.as_bytes()).map_err(|e| format!("Couldn't save the review: {e}"))
}

#[tauri::command(async)]
pub fn agent_review_load(workspace: String, session_id: String) -> Result<Option<String>, String> {
    let file = review_state_file(&workspace, &session_id);
    if !vfs::is_file(&file) {
        return Ok(None);
    }
    vfs::read_to_string(&file)
        .map(Some)
        .map_err(|e| format!("Couldn't read the review: {e}"))
}
