use super::*;

/// Sent to the app when a notification is clicked, with the session it was about.
#[cfg(windows)]
const NOTIFICATION_OPEN_EVENT: &str = "notification-open";

/// Clicking a notification brings Nyxs to the front and opens its session, like Claude Code
/// Desktop. Only while Nyxs runs: Windows calls back into this process.
#[cfg(windows)]
fn on_click(app: AppHandle, chat_id: Option<String>) {
    if let Some(window) = app.get_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(id) = chat_id.filter(|id| !id.is_empty()) {
        let _ = app.emit(NOTIFICATION_OPEN_EVENT, id);
    }
}

#[cfg(windows)]
#[tauri::command]
pub fn nyxs_notify(
    app: AppHandle,
    title: String,
    body: String,
    chat_id: Option<String>,
) -> Result<bool, String> {
    // A test run (NYXS_DATA_DIR) doesn't show toasts on the user's desktop or register the app
    // in their registry.
    if crate::test_data_dir::active() {
        return Ok(false);
    }
    use tauri_winrt_notification::Toast;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let aumid = app.config().identifier.clone();

    // Named after its content: when the logo changes a new file is written, and Windows,
    // which caches the icon by path, can't keep showing the old one.
    let icon_path = {
        use std::hash::{Hash, Hasher};
        let bytes: &[u8] = include_bytes!("../../icons/128x128.png");
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        bytes.hash(&mut hasher);
        let name = format!("nyxs-icon-{:016x}.png", hasher.finish());
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Couldn't get the data directory: {e}"))?;
        let _ = fs::create_dir_all(&dir);
        let p = dir.join(&name);
        if !p.exists() {
            fs::write(&p, bytes).map_err(|e| format!("Couldn't write the icon: {e}"))?;
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let old = entry.file_name().to_string_lossy().to_string();
                    if old.starts_with("nyxs-icon") && old.ends_with(".png") && old != name {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
        p
    };

    if let Ok((key, _)) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(format!("Software\\Classes\\AppUserModelId\\{aumid}"))
    {
        let _ = key.set_value("DisplayName", &"Nyxs");
        let _ = key.set_value("IconUri", &icon_path.to_string_lossy().to_string());
    }

    let click_app = app.clone();
    Toast::new(&aumid)
        .title(&title)
        .text1(&body)
        .on_activated(move |_| {
            on_click(click_app.clone(), chat_id.clone());
            Ok(())
        })
        .show()
        .map_err(|e| format!("Couldn't show the notification: {e}"))?;
    Ok(true)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn nyxs_notify(
    _app: AppHandle,
    _title: String,
    _body: String,
    _chat_id: Option<String>,
) -> Result<bool, String> {
    Ok(false)
}
