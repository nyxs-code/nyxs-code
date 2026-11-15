//! Nyxs' logs for support, like Claude Code Desktop's Help › Troubleshooting › Save logs: the
//! log files (the backend's and the interface's errors) zipped together with a note of the
//! version and system.

use std::fs;
use std::io::Write;
use std::path::Path;

use tauri::{AppHandle, Manager};

/// The interface's errors (uncaught exceptions, failed promises) in the same log as the
/// backend's, under the `webview` target, so a saved zip shows both.
#[tauri::command]
pub fn nyxs_log_frontend(level: String, message: String) {
    let message: String = message.chars().take(4000).collect();
    match level.as_str() {
        "error" => log::error!(target: "webview", "{message}"),
        "warn" => log::warn!(target: "webview", "{message}"),
        _ => log::info!(target: "webview", "{message}"),
    }
}

/// Takes out of a log what support doesn't need and the user wouldn't hand over: query strings
/// and fragments of addresses (codes, magic links), bearer tokens, `…key=` values, and the
/// user's home folder (it carries their name), written as `~`.
fn redact(text: &str, home: Option<&Path>) -> String {
    use std::sync::OnceLock;
    static QUERY: OnceLock<regex::Regex> = OnceLock::new();
    static BEARER: OnceLock<regex::Regex> = OnceLock::new();
    static KEY: OnceLock<regex::Regex> = OnceLock::new();
    let query = QUERY.get_or_init(|| {
        regex::Regex::new(r#"(\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s?#"'<>]*)[?#][^\s"'<>]*"#)
            .expect("valid regex")
    });
    let bearer =
        BEARER.get_or_init(|| regex::Regex::new(r"(?i)\bbearer\s+[^\s,;]+").expect("valid regex"));
    let key = KEY.get_or_init(|| {
        regex::Regex::new(r#"(?i)\b([a-z0-9_-]*key)=[^\s&"',;]+"#).expect("valid regex")
    });
    let mut out = query.replace_all(text, "$1?…").into_owned();
    out = bearer.replace_all(&out, "Bearer …").into_owned();
    out = key.replace_all(&out, "$1=…").into_owned();
    if let Some(home) = home.map(|h| h.to_string_lossy()).filter(|h| h.len() > 1) {
        // Either slash, and any case on Windows, as paths come from many sources; and the
        // whole last name only (`/home/ana` isn't the start of `/home/anabel`).
        let parts: Vec<String> = home
            .trim_end_matches(['/', '\\'])
            .split(['/', '\\'])
            .map(regex::escape)
            .collect();
        let flags = if cfg!(windows) { "(?i)" } else { "" };
        let pattern = format!(r"{flags}{}\b", parts.join(r"[\\/]"));
        if let Ok(re) = regex::Regex::new(&pattern) {
            out = re.replace_all(&out, "~").into_owned();
        }
    }
    out
}

fn add_file(zip: &mut zip::ZipWriter<fs::File>, name: &str, path: &Path) -> Result<(), String> {
    let raw = fs::read(path).map_err(|e| format!("Couldn't read {name}: {e}"))?;
    let bytes = redact(&String::from_utf8_lossy(&raw), dirs::home_dir().as_deref()).into_bytes();
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file(name, opts).map_err(|e| e.to_string())?;
    zip.write_all(&bytes).map_err(|e| e.to_string())
}

/// Writes the zip at `dest` and returns how many log files went in.
#[tauri::command(async)]
pub fn nyxs_export_logs(app: AppHandle, dest: String) -> Result<usize, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let file = fs::File::create(&dest).map_err(|e| format!("Couldn't create {dest}: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if add_file(&mut zip, &format!("logs/{name}"), &path).is_ok() {
                count += 1;
            }
        }
    }
    let info = app.package_info();
    let note = format!(
        "{} {}\nOS: {} {}\nLog folder: {}\nSaved: {} (unix seconds)\n",
        info.name,
        info.version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        dir.display(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    );
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("system.txt", opts)
        .map_err(|e| e.to_string())?;
    let note = redact(&note, dirs::home_dir().as_deref());
    zip.write_all(note.as_bytes()).map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_saved_log_carries_no_secrets_nor_the_users_folder() {
        let home = if cfg!(windows) {
            r"C:\Users\ana"
        } else {
            "/home/ana"
        };
        let log = format!(
            "[info] open https://app.example.com/callback?code=abc123&state=x#frag done\n\
             [warn] HTTP 401 Authorization: Bearer sk-live-9f8e7d\n\
             [error] request failed: key=AIzaSyXYZ and api_key=zzz&next=1\n\
             [error] Error: boom\n    at {home}{sep}project{sep}src{sep}a.ts:3\n\
             [info] plain http://localhost:1420/ stays\n",
            sep = std::path::MAIN_SEPARATOR
        );
        let out = redact(&log, Some(Path::new(home)));
        for secret in [
            "abc123",
            "state=x",
            "frag",
            "sk-live-9f8e7d",
            "AIzaSyXYZ",
            "zzz",
            home,
        ] {
            assert!(!out.contains(secret), "{secret} left in:\n{out}");
        }
        assert!(out.contains("https://app.example.com/callback?…"), "{out}");
        assert!(out.contains("Bearer …"), "{out}");
        assert!(out.contains("key=…") && out.contains("api_key=…"), "{out}");
        assert!(
            out.contains(&format!("~{0}project{0}src", std::path::MAIN_SEPARATOR)),
            "{out}"
        );
        assert!(out.contains("http://localhost:1420/ stays"), "{out}");
        let other = format!("{home}bel{}x", std::path::MAIN_SEPARATOR);
        assert_eq!(redact(&other, Some(Path::new(home))), other);
    }
}
