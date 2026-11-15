//! What the interface calls to manage remote machines: connect, disconnect, the hosts
//! in ~/.ssh/config and port forwarding for the browser.

use super::conn::HostInfo;

#[tauri::command]
pub fn remote_config_hosts() -> Vec<String> {
    super::ssh::config_hosts()
}

/// Opens (or reuses) the connection, installing the helper on the first one.
#[tauri::command]
pub async fn remote_connect(host: String) -> Result<HostInfo, String> {
    let host = host.trim().to_string();
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err("Write the machine as ssh takes it: an alias from ~/.ssh/config, user@server or user@server:port.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        super::conn(&host)
            .map(|c| c.info.clone())
            .map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub fn remote_disconnect(host: String) {
    super::disconnect(&host);
}

/// The local port to open for a server listening on `port` on the machine.
#[tauri::command]
pub async fn remote_forward(host: String, port: u16) -> Result<u16, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::tunnel::forward(&host, port).map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The machine's home folder as `ssh://host/...`, where the folder picker starts.
#[tauri::command]
pub async fn remote_home(host: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::fs::home(&host)
            .map(|p| p.uri())
            .map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The folders inside a remote folder, for the folder picker.
#[tauri::command]
pub async fn remote_list_folders(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = super::parse(&path).ok_or("Not a remote path")?;
        let mut dirs: Vec<String> = super::fs::list_dir(&p)
            .map_err(String::from)?
            .into_iter()
            .filter(|e| e.is_dir)
            .map(|e| e.name)
            .collect();
        dirs.sort_by_key(|d| (d.starts_with('.'), d.to_lowercase()));
        Ok(dirs)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Makes a folder `name` inside a remote folder (the folder picker's "New folder") and returns
/// its `ssh://` path. Fails if something with that name is already there.
#[tauri::command]
pub async fn remote_create_folder(parent: String, name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(format!("\"{name}\" isn't a valid folder name."));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let p = super::parse(&parent).ok_or("Not a remote path")?;
        let target = super::RemotePath {
            host: p.host.clone(),
            path: format!("{}/{name}", p.path.trim_end_matches('/')),
        };
        if super::fs::stat(&target).map_err(String::from)?.is_some() {
            return Err(format!("{name} already exists here."));
        }
        super::fs::mkdir(&target).map_err(String::from)?;
        Ok(target.uri())
    })
    .await
    .map_err(|e| e.to_string())?
}
