//! `NYXS_DATA_DIR`: runs the app against a folder of its own instead of the user's data, for the
//! native end-to-end tests (`e2e-native/`). With it set, before anything else starts:
//! - `~/.nyxs` (sessions, settings, attachments, accounts…) lives in `<dir>/home/.nyxs`, since
//!   every part of the app finds the home folder through `USERPROFILE`/`HOME`;
//! - the window's WebView2 profile (localStorage, cookies) is `<dir>/webview`, unless a WebDriver
//!   run already gave it a temporary one;
//! - Tauri's app data folders are inside `<dir>` too: on Windows the known folders (AppData)
//!   are stored as `%USERPROFILE%\AppData\...` and expanded with the process's environment, so
//!   they follow `USERPROFILE` once those folders exist; on Linux they follow the XDG variables;
//! - secrets go to `<dir>/secrets.json` instead of the OS keychain;
//! - no OS notifications and no global shortcut, which would reach the user's desktop.
//!
//! As a second guard, a build for these tests uses an identifier of its own (`e2e-native/build.mjs`):
//! `check_identifier` refuses to run a test data folder with the installed app's identifier.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub const ENV: &str = "NYXS_DATA_DIR";
/// The identifier of the published app, whose data must never be used by a test run.
const PRODUCTION_IDENTIFIER: &str = crate::identifier::IDENTIFIER;

/// The test data folder, when the app was started with one.
pub fn dir() -> Option<PathBuf> {
    std::env::var_os(ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

pub fn active() -> bool {
    dir().is_some()
}

/// Points the app's folders at the test data folder. Called first thing in `run()`, before any
/// thread starts, so every later read of these variables sees the test folder.
pub fn isolate() {
    let Some(dir) = dir() else { return };
    let home = dir.join("home");
    let webview = dir.join("webview");
    for d in [&home, &webview] {
        let _ = std::fs::create_dir_all(d);
    }
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("HOME", &home);
    // Without these folders the AppData known folders don't resolve under the new profile and
    // Tauri can't start ("unknown path"); programs that read the variables directly follow too.
    for (var, sub) in [
        ("APPDATA", ["AppData", "Roaming"]),
        ("LOCALAPPDATA", ["AppData", "Local"]),
    ] {
        let path = home.join(sub[0]).join(sub[1]);
        let _ = std::fs::create_dir_all(&path);
        if cfg!(windows) {
            std::env::set_var(var, path);
        }
    }
    // A WebDriver run already gives WebView2 a temporary profile of its own (msedgedriver sets
    // this and reads its DevToolsActivePort file there): kept as it is.
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview);
    }
    for (var, sub) in [
        ("XDG_DATA_HOME", "xdg-data"),
        ("XDG_CONFIG_HOME", "xdg-config"),
        ("XDG_CACHE_HOME", "xdg-cache"),
    ] {
        let path = dir.join(sub);
        let _ = std::fs::create_dir_all(&path);
        std::env::set_var(var, path);
    }
    eprintln!(
        "[nyxs] {ENV}: using {} instead of the user's data",
        dir.display()
    );
}

/// Stops a test run that would use the installed app's data folder (see the module notes).
pub fn check_identifier(identifier: &str) {
    if active() && cfg!(windows) && identifier == PRODUCTION_IDENTIFIER {
        eprintln!(
            "[nyxs] {ENV} needs a build with its own identifier (e2e-native/tauri.e2e.conf.json); \
             this one would share the installed app's data folder. Exiting."
        );
        std::process::exit(2);
    }
}

/// In a test run, puts the window off every monitor and only then shows it, without activating
/// it, so it never covers the user's work or takes their keyboard. The test build creates it
/// hidden (`e2e-native/build.mjs`) because tao drops a creation position that isn't on a
/// monitor and lets Windows cascade the window onto the screen. It ends up shown, not minimized
/// or hidden: WebView2 then throttles rendering and the tests stall.
pub fn move_window_off_screen<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    if !active() {
        return;
    }
    if let Some(w) = tauri::Manager::get_webview_window(app, label) {
        let _ = w.set_position(tauri::PhysicalPosition::new(-10_000, -10_000));
        show_without_focus(&w);
    }
}

/// Tauri's `show()` activates the window once it was created hidden, taking the foreground from
/// the user's app; SW_SHOWNOACTIVATE shows it and leaves the foreground where it was.
#[cfg(windows)]
fn show_without_focus<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    if let Ok(hwnd) = w.hwnd() {
        unsafe { ShowWindow(hwnd.0 as _, SW_SHOWNOACTIVATE) };
    }
}

#[cfg(not(windows))]
fn show_without_focus<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>) {
    let _ = w.show();
}

// ── Secrets ──────────────────────────────────────────────────────────────

static SECRETS: Mutex<()> = Mutex::new(());

fn secrets_path() -> Option<PathBuf> {
    dir().map(|d| d.join("secrets.json"))
}

fn read_secrets(path: &PathBuf) -> BTreeMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_secrets(path: &PathBuf, secrets: &BTreeMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_string_pretty(secrets).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("Couldn't save the secret: {e}"))
}

/// In a test run, the secret `account` from `<dir>/secrets.json`; None outside one.
pub fn secret_get(account: &str) -> Option<Result<Option<String>, String>> {
    let path = secrets_path()?;
    let _lock = SECRETS.lock().unwrap_or_else(|e| e.into_inner());
    Some(Ok(read_secrets(&path).get(account).cloned()))
}

/// In a test run, saves the secret in `<dir>/secrets.json`; None outside one.
pub fn secret_set(account: &str, secret: &str) -> Option<Result<(), String>> {
    let path = secrets_path()?;
    let _lock = SECRETS.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read_secrets(&path);
    all.insert(account.to_string(), secret.to_string());
    Some(write_secrets(&path, &all))
}

/// In a test run, removes the secret from `<dir>/secrets.json`; None outside one.
pub fn secret_delete(account: &str) -> Option<Result<(), String>> {
    let path = secrets_path()?;
    let _lock = SECRETS.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read_secrets(&path);
    all.remove(account);
    Some(write_secrets(&path, &all))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_round_trip_through_the_test_folder() {
        let dir = std::env::temp_dir().join(format!("nyxs-test-data-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secrets.json");
        let mut all = read_secrets(&path);
        assert!(all.is_empty());
        all.insert("auth:session".into(), "tok".into());
        write_secrets(&path, &all).unwrap();
        assert_eq!(
            read_secrets(&path).get("auth:session").map(String::as_str),
            Some("tok")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
