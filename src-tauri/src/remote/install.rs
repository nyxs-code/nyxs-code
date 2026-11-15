//! Putting the helper on a machine: find out its system and processor, pick the matching
//! `nyxs-remote` that ships with Nyxs and copy it to `~/.nyxs-remote/<version>-<hash>/`. Each
//! build gets its own folder, so two PCs with different Nyxs versions can use the same machine.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::conn::RemoteError;
use super::ssh;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Target {
    /// `linux`, `macos` or `windows`.
    pub os: String,
    /// `x86_64` or `aarch64`.
    pub arch: String,
}

impl Target {
    fn file_name(&self) -> String {
        format!(
            "nyxs-remote-{}-{}{}",
            self.os,
            self.arch,
            if self.os == "windows" { ".exe" } else { "" }
        )
    }
}

fn targets_file() -> PathBuf {
    let home =
        std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    PathBuf::from(home)
        .join(".nyxs")
        .join("remote")
        .join("targets.json")
}

fn targets() -> &'static Mutex<HashMap<String, Target>> {
    static T: OnceLock<Mutex<HashMap<String, Target>>> = OnceLock::new();
    T.get_or_init(|| {
        let map = std::fs::read_to_string(targets_file())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Mutex::new(map)
    })
}

/// What the machine was the last time: lets a connection start the helper straight away.
pub fn known_target(host: &str) -> Option<Target> {
    targets().lock().unwrap().get(host).cloned()
}

fn remember_target(host: &str, t: &Target) {
    let mut map = targets().lock().unwrap();
    map.insert(host.to_string(), t.clone());
    let path = targets_file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(&*map) {
        let _ = std::fs::write(path, json);
    }
}

fn normalize_arch(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" | "x64" => Some("x86_64"),
        "aarch64" | "arm64" | "armv8l" => Some("aarch64"),
        _ => None,
    }
}

/// Reads what `echo %OS%:%PROCESSOR_ARCHITECTURE% & uname -sm` printed: cmd expands the first
/// half (Windows), a Unix shell runs `uname`.
fn parse_probe(out: &str) -> Option<Target> {
    for line in out.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Windows_NT:") {
            let arch = rest.split_whitespace().next().unwrap_or("");
            return normalize_arch(arch).map(|a| Target {
                os: "windows".into(),
                arch: a.into(),
            });
        }
    }
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        let (Some(sys), Some(arch)) = (parts.next(), parts.next()) else {
            continue;
        };
        let os = match sys {
            "Linux" => "linux",
            "Darwin" => "macos",
            _ => continue,
        };
        if let Some(a) = normalize_arch(arch) {
            return Some(Target {
                os: os.into(),
                arch: a.into(),
            });
        }
    }
    // PowerShell as the SSH shell on Windows: neither half above works there.
    for line in out.lines() {
        if let Some(a) = normalize_arch(line) {
            return Some(Target {
                os: "windows".into(),
                arch: a.into(),
            });
        }
    }
    None
}

fn run_ssh(
    host: &str,
    remote: &str,
    stdin: Option<&[u8]>,
) -> Result<(String, String, bool), RemoteError> {
    let mut child = ssh::command(host, remote)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            RemoteError::new(
                "ssh",
                format!("Couldn't start ssh: {e}. Is OpenSSH installed?"),
            )
        })?;
    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let data = data.to_vec();
        std::thread::spawn(move || {
            let _ = pipe.write_all(&data);
        });
    }
    let out = child
        .wait_with_output()
        .map_err(|e| RemoteError::new("ssh", e.to_string()))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
        out.status.success(),
    ))
}

fn probe(host: &str) -> Result<Target, RemoteError> {
    let (out, err, _) = run_ssh(host, "echo %OS%:%PROCESSOR_ARCHITECTURE% & uname -sm", None)?;
    if let Some(t) = parse_probe(&out) {
        return Ok(t);
    }
    if let Some(why) = ssh::explain_failure(&err) {
        return Err(RemoteError::new("ssh", why));
    }
    let (out2, err2, _) = run_ssh(host, "$env:PROCESSOR_ARCHITECTURE", None)?;
    parse_probe(&format!("{out}\n{out2}")).ok_or_else(|| {
        RemoteError::new(
            "unsupported",
            format!(
                "Nyxs couldn't tell which system the machine runs. It supports Linux, macOS and Windows on x86_64 or ARM64.\n{}",
                format!("{out}{err}{err2}").trim()
            ),
        )
    })
}

/// Where the helpers for every system are: bundled with the app, or in the source tree while
/// developing (`npm run remote:build` fills `src-tauri/remote/dist`).
fn helper_binary(t: &Target) -> Result<PathBuf, RemoteError> {
    let name = t.file_name();
    let mut candidates: Vec<PathBuf> = Vec::new();
    // First while developing: the resource folder holds a copy from whenever the app last built,
    // which can lag behind what `npm run remote:build` just made.
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("remote")
                .join("dist")
                .join(&name),
        );
    }
    if let Some(app) = super::app() {
        if let Ok(res) = app.path().resource_dir() {
            candidates.push(res.join("remote").join("dist").join(&name));
            candidates.push(res.join("remote-helpers").join(&name));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("remote-helpers").join(&name));
        }
    }
    candidates.into_iter().find(|p| p.is_file()).ok_or_else(|| {
        RemoteError::new(
            "unsupported",
            format!(
                "This copy of Nyxs has no helper for {} on {}.",
                match t.os.as_str() {
                    "windows" => "Windows",
                    "macos" => "macOS",
                    _ => "Linux",
                },
                t.arch
            ),
        )
    })
}

/// This computer's own helper, which ssh runs as its SSH_ASKPASS (see `askpass.rs`).
pub(crate) fn local_helper() -> Option<PathBuf> {
    static LOCAL: OnceLock<Option<PathBuf>> = OnceLock::new();
    LOCAL
        .get_or_init(|| {
            let os = match std::env::consts::OS {
                "windows" | "macos" | "linux" => std::env::consts::OS,
                _ => return None,
            };
            let arch = match std::env::consts::ARCH {
                "x86_64" | "aarch64" => std::env::consts::ARCH,
                _ => return None,
            };
            helper_binary(&Target {
                os: os.into(),
                arch: arch.into(),
            })
            .ok()
        })
        .clone()
}

fn helper_dir_name(binary: &PathBuf) -> Result<String, RemoteError> {
    static HASHES: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();
    let cache = HASHES.get_or_init(Default::default);
    if let Some(h) = cache.lock().unwrap().get(binary) {
        return Ok(h.clone());
    }
    let bytes = std::fs::read(binary)
        .map_err(|e| RemoteError::new("io", format!("Couldn't read {}: {e}", binary.display())))?;
    let digest = Sha256::digest(&bytes);
    let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    let name = format!("{}-{hex}", env!("CARGO_PKG_VERSION"));
    cache.lock().unwrap().insert(binary.clone(), name.clone());
    Ok(name)
}

/// The command `ssh` runs to start the helper. sshd starts it in the user's home folder.
pub fn helper_command(t: &Target) -> Result<String, RemoteError> {
    let dir = helper_dir_name(&helper_binary(t)?)?;
    Ok(if t.os == "windows" {
        format!(r".\.nyxs-remote\{dir}\nyxs-remote.exe serve")
    } else {
        format!("\"$HOME/.nyxs-remote/{dir}/nyxs-remote\" serve")
    })
}

pub fn install(host: &str) -> Result<Target, RemoteError> {
    let t = probe(host)?;
    let binary = helper_binary(&t)?;
    let dir = helper_dir_name(&binary)?;
    let bytes = std::fs::read(&binary)
        .map_err(|e| RemoteError::new("io", format!("Couldn't read {}: {e}", binary.display())))?;
    if t.os == "windows" {
        let _ = run_ssh(host, &format!(r"mkdir .nyxs-remote\{dir}"), None)?;
        let out = ssh::scp_command(
            host,
            &binary,
            &format!(".nyxs-remote/{dir}/nyxs-remote.exe"),
        )
        .stdin(Stdio::null())
        .output()
        .map_err(|e| RemoteError::new("ssh", format!("Couldn't start scp: {e}")))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).to_string();
            return Err(RemoteError::new(
                "install",
                ssh::explain_failure(&err).unwrap_or_else(|| {
                    format!("Couldn't copy Nyxs' helper to the machine: {}", err.trim())
                }),
            ));
        }
    } else {
        let base = format!("\"$HOME/.nyxs-remote/{dir}\"");
        let script = format!(
            "mkdir -p {base} && cat > {base}/nyxs-remote.part && chmod +x {base}/nyxs-remote.part && mv -f {base}/nyxs-remote.part {base}/nyxs-remote"
        );
        let (_, err, ok) = run_ssh(host, &script, Some(&bytes))?;
        if !ok {
            return Err(RemoteError::new(
                "install",
                ssh::explain_failure(&err).unwrap_or_else(|| {
                    format!("Couldn't copy Nyxs' helper to the machine: {}", err.trim())
                }),
            ));
        }
    }
    remove_old_helpers(host, &t, &dir);
    remember_target(host, &t);
    Ok(t)
}

/// Deletes the helpers other builds of Nyxs left there. Safe with several PCs on different
/// versions: one whose folder is gone installs it again on its next connection, and a helper
/// running from a deleted file keeps running (Windows refuses to delete it, which is ignored).
fn remove_old_helpers(host: &str, t: &Target, keep: &str) {
    let script = if t.os == "windows" {
        format!(
            r#"for /d %d in (.nyxs-remote\*) do @if /i not "%~nxd"=="{keep}" rd /s /q "%d" 2>nul"#
        )
    } else {
        format!(
            "find \"$HOME/.nyxs-remote\" -mindepth 1 -maxdepth 1 -type d ! -name '{keep}' -exec rm -rf {{}} + 2>/dev/null; true"
        )
    };
    let _ = run_ssh(host, &script, None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_probe_from_each_shell() {
        let linux = parse_probe("%OS%:%PROCESSOR_ARCHITECTURE%\nLinux x86_64\n").unwrap();
        assert_eq!(
            (linux.os.as_str(), linux.arch.as_str()),
            ("linux", "x86_64")
        );
        let mac = parse_probe("%OS%:%PROCESSOR_ARCHITECTURE%\nDarwin arm64\n").unwrap();
        assert_eq!((mac.os.as_str(), mac.arch.as_str()), ("macos", "aarch64"));
        let cmd = parse_probe("Windows_NT:AMD64 \r\n").unwrap();
        assert_eq!((cmd.os.as_str(), cmd.arch.as_str()), ("windows", "x86_64"));
        let ps = parse_probe("%OS%:%PROCESSOR_ARCHITECTURE%\nARM64\r\n").unwrap();
        assert_eq!((ps.os.as_str(), ps.arch.as_str()), ("windows", "aarch64"));
        assert!(parse_probe("FreeBSD amd64").is_none());
    }
}
