//! Running the system's OpenSSH client: the one in System32 on Windows (Git's own `ssh` may come
//! first in PATH and reads another config), `ssh` from PATH elsewhere. Connections use the
//! user's keys or agent, as `ssh <host>` in their own terminal; when the machine wants a
//! password (or a key a passphrase), ssh asks through a Nyxs dialog (see `askpass.rs`).

use std::path::PathBuf;
use std::process::Command;

pub fn ssh_exe() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(root) = std::env::var("SystemRoot") {
            let p = PathBuf::from(root).join(r"System32\OpenSSH\ssh.exe");
            if p.is_file() {
                return p;
            }
        }
    }
    PathBuf::from("ssh")
}

pub fn scp_exe() -> PathBuf {
    let ssh = ssh_exe();
    match ssh.parent().filter(|p| !p.as_os_str().is_empty()) {
        Some(dir) => dir.join(if cfg!(windows) { "scp.exe" } else { "scp" }),
        None => PathBuf::from("scp"),
    }
}

/// `user@server:2222` → (`user@server`, Some(2222)). An alias or plain host has no port. An
/// IPv6 address in brackets (`user@[::1]:2222`, `[fe80::1]`) goes to ssh without them.
pub fn split_port(host: &str) -> (String, Option<u16>) {
    let (user, rest) = match host.rsplit_once('@') {
        Some((u, r)) => (Some(u), r),
        None => (None, host),
    };
    let with_user = |h: &str| match user {
        Some(u) => format!("{u}@{h}"),
        None => h.to_string(),
    };
    if let Some((addr, after)) = rest.strip_prefix('[').and_then(|r| r.split_once(']')) {
        let port = after.strip_prefix(':').and_then(|p| p.parse::<u16>().ok());
        if after.is_empty() || port.is_some() {
            return (with_user(addr), port);
        }
    }
    if let Some((h, p)) = rest.rsplit_once(':') {
        // A bare IPv6 address has colons of its own and no port.
        if let Ok(port) = p.parse::<u16>() {
            if !h.is_empty() && !h.contains(':') {
                return (with_user(h), Some(port));
            }
        }
    }
    (host.to_string(), None)
}

fn common_options(cmd: &mut Command, host: &str) {
    // Another ssh_config instead of ~/.ssh/config: for tests against a throwaway server.
    if let Ok(config) = std::env::var("NYXS_SSH_CONFIG") {
        if !config.is_empty() {
            cmd.arg("-F").arg(config);
        }
    }
    // A password or a key's passphrase is asked in a Nyxs dialog (askpass.rs). Without a
    // helper on this computer to ask through, ssh must not prompt: it would wait for nothing.
    let asks = super::askpass::configure(cmd, host);
    cmd.args([
        "-o",
        if asks {
            "BatchMode=no"
        } else {
            "BatchMode=yes"
        },
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
    ]);
}

pub fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// `ssh -T <host> <remote command>`, ready for its stdio to be set.
pub fn command(host: &str, remote: &str) -> Command {
    let (dest, port) = split_port(host);
    let mut cmd = Command::new(ssh_exe());
    cmd.arg("-T");
    common_options(&mut cmd, host);
    if let Some(port) = port {
        cmd.arg("-p").arg(port.to_string());
    }
    // `--`: whatever the host says, ssh never reads it as an option.
    cmd.arg("--").arg(dest).arg(remote);
    hide_window(&mut cmd);
    cmd
}

/// The argv of a terminal on the machine: `ssh -tt` (a real terminal over there) that opens the
/// user's shell in `path`.
pub fn terminal_argv(host: &str, path: &str, os: &str) -> Vec<String> {
    let (dest, port) = split_port(host);
    let mut argv = vec![ssh_exe().to_string_lossy().to_string(), "-tt".to_string()];
    if let Ok(config) = std::env::var("NYXS_SSH_CONFIG") {
        if !config.is_empty() {
            argv.push("-F".into());
            argv.push(config);
        }
    }
    for o in [
        "StrictHostKeyChecking=accept-new",
        "ConnectTimeout=15",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=4",
    ] {
        argv.push("-o".into());
        argv.push(o.into());
    }
    if let Some(port) = port {
        argv.push("-p".into());
        argv.push(port.to_string());
    }
    argv.push("--".into());
    argv.push(dest);
    argv.push(if os == "windows" {
        // cmd is OpenSSH's usual shell on Windows; `cd /d` also changes drive.
        format!(
            "cd /d \"{}\" && powershell -NoLogo",
            path.replace('/', "\\")
        )
    } else {
        format!(
            "cd '{}' 2>/dev/null; exec \"${{SHELL:-/bin/sh}}\" -l",
            path.replace('\'', "'\\''")
        )
    });
    argv
}

/// `ssh -N -L 127.0.0.1:<local>:localhost:<remote> <host>`: forwards a local port to a port on
/// the remote machine, for the browser to open a dev server running there.
pub fn forward_command(host: &str, local: u16, remote: u16) -> Command {
    let (dest, port) = split_port(host);
    let mut cmd = Command::new(ssh_exe());
    cmd.arg("-N");
    common_options(&mut cmd, host);
    cmd.args(["-o", "ExitOnForwardFailure=yes"]);
    if let Some(port) = port {
        cmd.arg("-p").arg(port.to_string());
    }
    cmd.arg("-L")
        .arg(format!("127.0.0.1:{local}:localhost:{remote}"))
        .arg("--")
        .arg(dest);
    hide_window(&mut cmd);
    cmd
}

pub fn scp_command(host: &str, local: &std::path::Path, remote: &str) -> Command {
    let (dest, port) = split_port(host);
    let mut cmd = Command::new(scp_exe());
    cmd.arg("-q");
    common_options(&mut cmd, host);
    if let Some(port) = port {
        cmd.arg("-P").arg(port.to_string());
    }
    cmd.arg("--").arg(local).arg(format!("{dest}:{remote}"));
    hide_window(&mut cmd);
    cmd
}

/// The `Host` aliases in ~/.ssh/config (without wildcards), for the "Add a machine" list.
pub fn config_hosts() -> Vec<String> {
    let home =
        std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    let path = std::env::var("NYXS_SSH_CONFIG")
        .ok()
        .filter(|c| !c.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home).join(".ssh").join("config"));
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    parse_config_hosts(&text)
}

fn parse_config_hosts(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else { continue };
        if !key.eq_ignore_ascii_case("host") {
            continue;
        }
        // The first name of each `Host` line: the others are usually its IP written again.
        if let Some(name) = parts.next() {
            if !name.contains(['*', '?', '!']) && !out.iter().any(|h| h == name) {
                out.push(name.to_string());
            }
        }
    }
    out
}

/// What went wrong, in words for the user, from what `ssh` printed.
pub fn explain_failure(stderr: &str) -> Option<String> {
    let s = stderr.to_lowercase();
    if s.contains("permission denied") {
        Some("SSH rejected the login: the password or key wasn't accepted. Check the password, or copy your public key to the machine (ssh-copy-id, or add it to ~/.ssh/authorized_keys there), and try again.".into())
    } else if s.contains("could not resolve hostname") {
        Some(
            "The machine's name couldn't be found. Check the host or its entry in ~/.ssh/config."
                .into(),
        )
    } else if s.contains("connection refused") {
        Some("The machine refused the connection: its SSH server isn't running or listens on another port.".into())
    } else if s.contains("timed out")
        || s.contains("no route to host")
        || s.contains("network is unreachable")
    {
        Some("The machine didn't answer. Check that it is on and reachable (VPN or Tailscale up, if it needs one).".into())
    } else if s.contains("host key verification failed")
        || s.contains("remote host identification has changed")
    {
        Some("The machine's SSH key changed since the last connection. If you expected it, remove its line from ~/.ssh/known_hosts and connect again.".into())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_split_off_the_host() {
        assert_eq!(split_port("me@vps:2222"), ("me@vps".into(), Some(2222)));
        assert_eq!(split_port("casa"), ("casa".into(), None));
        assert_eq!(split_port("[::1]:22"), ("::1".into(), Some(22)));
    }

    #[test]
    fn ipv6_addresses_keep_their_user_and_port() {
        assert_eq!(split_port("me@[::1]:2222"), ("me@::1".into(), Some(2222)));
        assert_eq!(split_port("me@[fe80::1]"), ("me@fe80::1".into(), None));
        assert_eq!(split_port("[fe80::1]"), ("fe80::1".into(), None));
        assert_eq!(split_port("fe80::1"), ("fe80::1".into(), None));
    }

    fn args(cmd: &Command) -> Vec<String> {
        cmd.get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    /// The destination comes right after `--`, so ssh never reads it as an option.
    fn dest_after_dashes(argv: &[String], dest: &str) {
        let at = argv.iter().position(|a| a == dest).expect(dest);
        assert_eq!(argv[at - 1], "--", "{argv:?}");
    }

    #[test]
    fn the_destination_is_never_read_as_an_option() {
        dest_after_dashes(
            &args(&command("me@vps:2222", "nyxs-remote serve")),
            "me@vps",
        );
        dest_after_dashes(&args(&forward_command("vps", 5173, 5173)), "vps");
        dest_after_dashes(&terminal_argv("vps", "/home/me", "linux"), "vps");
        let scp = args(&scp_command(
            "vps",
            std::path::Path::new("a.bin"),
            "/tmp/a.bin",
        ));
        dest_after_dashes(&scp, "a.bin");
        assert_eq!(scp.last().unwrap(), "vps:/tmp/a.bin");
    }

    #[test]
    fn a_bad_host_never_reaches_ssh() {
        let Err(err) = super::super::conn_for("-oProxyCommand=nyxs-not-a-command") else {
            panic!("connected");
        };
        assert_eq!(err.kind, "badHost");
        let err = super::super::tunnel::forward("bad host", 5173).unwrap_err();
        assert_eq!(err.kind, "badHost");
    }
    #[test]
    fn lists_concrete_config_hosts() {
        let hosts = parse_config_hosts(
            "Host *\n  User x\nHost vps 10.0.0.2\n  HostName 10.0.0.2\nhost casa\nHost *.corp\n",
        );
        assert_eq!(hosts, vec!["vps".to_string(), "casa".to_string()]);
    }
}
