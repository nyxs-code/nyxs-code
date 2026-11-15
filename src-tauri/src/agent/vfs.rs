//! The file calls the agent's commands make, for a local path or an `ssh://` one. Each mirrors
//! its `std::fs` namesake (same results, same `io::Error` kinds), so a command written against
//! these works on a remote machine without a branch of its own.

use std::io;
use std::path::Path;

use crate::remote::{self, RemoteError, RemotePath};

#[derive(Clone, Copy, Debug)]
pub(crate) struct Meta {
    pub is_dir: bool,
    pub is_file: bool,
    pub len: u64,
    /// Milliseconds since the Unix epoch.
    pub mtime: u64,
}

fn to_io(e: RemoteError) -> io::Error {
    let kind = match e.kind.as_str() {
        "notFound" => io::ErrorKind::NotFound,
        "permissionDenied" => io::ErrorKind::PermissionDenied,
        "disconnected" | "ssh" => io::ErrorKind::NotConnected,
        "timeout" => io::ErrorKind::TimedOut,
        _ => io::ErrorKind::Other,
    };
    io::Error::new(kind, e.message)
}

fn remote(path: &str) -> Option<RemotePath> {
    remote::parse(path)
}

pub(crate) fn metadata(path: &str) -> io::Result<Meta> {
    if let Some(r) = remote(path) {
        return match remote::fs::stat(&r).map_err(to_io)? {
            Some(s) => Ok(Meta {
                is_dir: s.is_dir,
                is_file: s.is_file,
                len: s.size,
                mtime: s.mtime,
            }),
            None => Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("{path} doesn't exist"),
            )),
        };
    }
    let m = std::fs::metadata(path)?;
    Ok(Meta {
        is_dir: m.is_dir(),
        is_file: m.is_file(),
        len: m.len(),
        mtime: m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    })
}

pub(crate) fn exists(path: &str) -> bool {
    metadata(path).is_ok()
}

pub(crate) fn is_file(path: &str) -> bool {
    metadata(path).map(|m| m.is_file).unwrap_or(false)
}

pub(crate) fn is_dir(path: &str) -> bool {
    metadata(path).map(|m| m.is_dir).unwrap_or(false)
}

pub(crate) fn read(path: &str) -> io::Result<Vec<u8>> {
    if let Some(r) = remote(path) {
        return remote::fs::read(&r, 50 * 1024 * 1024).map_err(to_io);
    }
    std::fs::read(path)
}

pub(crate) fn read_to_string(path: &str) -> io::Result<String> {
    let bytes = read(path)?;
    String::from_utf8(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Replaces the file's content in one step (a temporary file renamed over it).
pub(crate) fn write_atomic(path: &str, bytes: &[u8]) -> io::Result<()> {
    if let Some(r) = remote(path) {
        return remote::fs::write(&r, bytes).map(|_| ()).map_err(to_io);
    }
    super::text_io::write_atomic(Path::new(path), bytes)
}

pub(crate) fn write(path: &str, bytes: &[u8]) -> io::Result<()> {
    if let Some(r) = remote(path) {
        return remote::fs::write(&r, bytes).map(|_| ()).map_err(to_io);
    }
    std::fs::write(path, bytes)
}

pub(crate) fn append(path: &str, bytes: &[u8]) -> io::Result<()> {
    if let Some(r) = remote(path) {
        return remote::fs::append(&r, bytes).map_err(to_io);
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    f.write_all(bytes)
}

pub(crate) fn remove_file(path: &str) -> io::Result<()> {
    if let Some(r) = remote(path) {
        return match remote::fs::remove(&r, false).map_err(to_io)? {
            true => Ok(()),
            false => Err(io::Error::new(io::ErrorKind::NotFound, path.to_string())),
        };
    }
    std::fs::remove_file(path)
}

pub(crate) struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub len: u64,
    pub mtime: u64,
}

pub(crate) fn read_dir(path: &str) -> io::Result<Vec<Entry>> {
    if let Some(r) = remote(path) {
        return Ok(remote::fs::list_dir(&r)
            .map_err(to_io)?
            .into_iter()
            .map(|e| Entry {
                name: e.name,
                is_dir: e.is_dir,
                len: e.size,
                mtime: e.mtime,
            })
            .collect());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(path)?.filter_map(|e| e.ok()) {
        let md = entry.metadata().ok();
        out.push(Entry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir: md
                .as_ref()
                .map(|m| m.is_dir())
                .unwrap_or_else(|| entry.path().is_dir()),
            len: md.as_ref().map(|m| m.len()).unwrap_or(0),
            mtime: md
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
    }
    Ok(out)
}

/// `dir` + `name` with the separator the path already uses (always `/` for `ssh://`).
pub(crate) fn join(dir: &str, name: &str) -> String {
    if remote::is_remote(dir) {
        format!(
            "{}/{}",
            dir.trim_end_matches('/'),
            name.trim_start_matches('/')
        )
    } else {
        Path::new(dir).join(name).to_string_lossy().to_string()
    }
}

/// The folder a path is in, as text, for either kind of path.
pub(crate) fn parent(path: &str) -> Option<String> {
    if let Some(r) = remote(path) {
        let cut = r.path.rfind('/')?;
        let parent = if cut == 0 { "/" } else { &r.path[..cut] };
        return Some(remote::uri::uri(&r.host, parent));
    }
    Path::new(path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().to_string())
}
