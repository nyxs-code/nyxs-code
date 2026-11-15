//! File operations on a remote machine, shaped like the `std::fs` calls the local commands
//! make, so a command can do the same work on either side.

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use super::conn::RemoteError;
use super::uri::RemotePath;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub is_dir: bool,
    pub is_file: bool,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
}

fn b64() -> &'static base64::engine::GeneralPurpose {
    &base64::engine::general_purpose::STANDARD
}

/// `None` when nothing is there.
pub fn stat(p: &RemotePath) -> Result<Option<Stat>, RemoteError> {
    let v = super::call(&p.host, "stat", json!({ "path": p.path }))?;
    if v.is_null() {
        return Ok(None);
    }
    serde_json::from_value(v)
        .map(Some)
        .map_err(|e| RemoteError::new("protocol", e.to_string()))
}

pub fn read(p: &RemotePath, max: u64) -> Result<Vec<u8>, RemoteError> {
    let v = super::call(&p.host, "read", json!({ "path": p.path, "max": max }))?;
    let data = v.get("data").and_then(Value::as_str).unwrap_or("");
    b64()
        .decode(data)
        .map_err(|e| RemoteError::new("protocol", e.to_string()))
}

/// Writes the whole file (atomically, creating its folders) and returns its new mtime.
pub fn write(p: &RemotePath, bytes: &[u8]) -> Result<u64, RemoteError> {
    let v = super::call(
        &p.host,
        "write",
        json!({ "path": p.path, "data": b64().encode(bytes) }),
    )?;
    Ok(v.get("mtime").and_then(Value::as_u64).unwrap_or(0))
}

pub fn append(p: &RemotePath, bytes: &[u8]) -> Result<(), RemoteError> {
    super::call(
        &p.host,
        "write",
        json!({ "path": p.path, "data": b64().encode(bytes), "append": true }),
    )
    .map(|_| ())
}

pub fn list_dir(p: &RemotePath) -> Result<Vec<DirEntry>, RemoteError> {
    let v = super::call(&p.host, "listDir", json!({ "path": p.path }))?;
    serde_json::from_value(v).map_err(|e| RemoteError::new("protocol", e.to_string()))
}

pub fn mkdir(p: &RemotePath) -> Result<(), RemoteError> {
    super::call(&p.host, "mkdir", json!({ "path": p.path })).map(|_| ())
}

pub fn remove(p: &RemotePath, recursive: bool) -> Result<bool, RemoteError> {
    let v = super::call(
        &p.host,
        "remove",
        json!({ "path": p.path, "recursive": recursive }),
    )?;
    Ok(v.as_bool().unwrap_or(false))
}

/// The machine's home folder as an `ssh://` place, for state Nyxs keeps there (sessions).
pub fn home(host: &str) -> Result<RemotePath, RemoteError> {
    let info = super::info(host)?;
    Ok(RemotePath {
        host: host.to_string(),
        path: info.home,
    })
}
