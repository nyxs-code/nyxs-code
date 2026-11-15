//! Stopping a local server Nyxs didn't start (a terminal, another app, an earlier run): the
//! process listening on its port is found with the system's own tools (`netstat` on Windows,
//! `lsof` elsewhere) and stopped together with what it started. Nyxs itself is never one of them.

use crate::agent::*;
use crate::error::CmdError;

const TOOL_TIMEOUT: Duration = Duration::from_secs(10);

/// A process listening on a port, for the confirmation that names it.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortListener {
    pid: u32,
    name: String,
}

/// Runs a system tool to the end (bounded) and returns what it printed.
fn tool_output(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    // Bytes, not read_to_string: system tools print in the console's code page, and on a
    // Spanish Windows netstat's headers ("Dirección local") aren't UTF-8. read_to_string then
    // failed and returned nothing, so no server was ever found and "Stop" only pretended.
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < TOOL_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(30))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    reader.join().ok()
}

// Windows only; its test runs everywhere.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
/// The PIDs listening on `port` in `netstat -ano` (Windows): "TCP 0.0.0.0:1420 0.0.0.0:0
/// LISTENING 1234", IPv6 addresses ("[::1]:1420") included.
fn netstat_listeners(text: &str, port: u16) -> Vec<u32> {
    let suffix = format!(":{port}");
    let mut pids: Vec<u32> = text
        .lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            let [proto, local, remote, state, pid] = cols.as_slice() else {
                return None;
            };
            // The state is translated on some Windows languages ("ABHÖREN"); a listening socket
            // is also the one with no remote port.
            let listening = *state == "LISTENING" || remote.ends_with(":0");
            (proto.eq_ignore_ascii_case("TCP") && local.ends_with(&suffix) && listening)
                .then(|| pid.parse().ok())
                .flatten()
        })
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

fn listener_pids(port: u16) -> Vec<u32> {
    #[cfg(target_os = "windows")]
    let pids = tool_output("netstat", &["-ano"])
        .map(|text| netstat_listeners(&text, port))
        .unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    let pids = {
        let mut pids: Vec<u32> = tool_output(
            "lsof",
            &["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"],
        )
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect();
        pids.sort_unstable();
        pids.dedup();
        pids
    };
    // Never Nyxs itself (it serves its own bridges on local ports too).
    pids.into_iter()
        .filter(|pid| *pid != std::process::id() && *pid != 0)
        .collect()
}

fn process_name(pid: u32) -> String {
    #[cfg(target_os = "windows")]
    let name = tool_output(
        "tasklist",
        &["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"],
    )
    .and_then(|out| {
        out.lines()
            .next()?
            .split("\",\"")
            .next()
            .map(|n| n.trim_matches('"').to_string())
    })
    .filter(|n| !n.is_empty() && !n.starts_with("INFO"));
    #[cfg(not(target_os = "windows"))]
    let name = tool_output("ps", &["-p", &pid.to_string(), "-o", "comm="])
        .map(|out| out.trim().rsplit('/').next().unwrap_or("").to_string())
        .filter(|n| !n.is_empty());
    name.unwrap_or_else(|| "?".into())
}

fn stop_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        // /T takes the server's own children (node under npm, cargo's app…) with it.
        let _ = tool_output("taskkill", &["/PID", &pid.to_string(), "/T", "/F"]);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let pid = pid.to_string();
        let _ = tool_output("pkill", &["-TERM", "-P", &pid]);
        let _ = tool_output("kill", &["-TERM", &pid]);
        std::thread::sleep(Duration::from_millis(1500));
        let _ = tool_output("pkill", &["-KILL", "-P", &pid]);
        let _ = tool_output("kill", &["-KILL", &pid]);
    }
}

/// Whether something on this machine still accepts connections on `port` (IPv6 too: Vite on
/// Node listens on `::1` only).
fn port_answers(port: u16) -> bool {
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
    [
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
    ]
    .iter()
    .any(|a| TcpStream::connect_timeout(a, Duration::from_millis(250)).is_ok())
}

/// Whether nothing holds `port` on loopback: IPv4 binds, and IPv6 binds too or isn't there
/// (Vite on Node listens on `::1` only, which the IPv4 bind alone wouldn't see). Binding is
/// instant, where a refused connection takes a while on Windows.
fn port_free(port: u16) -> bool {
    use std::net::{Ipv4Addr, Ipv6Addr, TcpListener};
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
        && TcpListener::bind((Ipv6Addr::LOCALHOST, port))
            .map_or_else(|e| e.kind() != std::io::ErrorKind::AddrInUse, |_| true)
}

/// The first free port after `after`, for a dev server whose own port is taken (launch.json's
/// `autoPort`).
#[tauri::command(async)]
pub fn agent_free_port(after: u16) -> Result<u16, String> {
    (after.saturating_add(1)..=after.saturating_add(200))
        .find(|p| *p >= 1024 && port_free(*p))
        .ok_or_else(|| format!("No free port near {after}."))
}

/// On the machine a tunnel leads to: who listens on its port there, as `pid name` lines.
fn remote_listeners(host: &str, port: u16) -> Vec<PortListener> {
    let windows = crate::remote::info(host)
        .map(|i| i.os == "windows")
        .unwrap_or(false);
    let command = if windows {
        format!("Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object {{ $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; \"$($_.OwningProcess) $($p.ProcessName)\" }} | Sort-Object -Unique")
    } else {
        format!("for pid in $(lsof -t -nP -iTCP:{port} -sTCP:LISTEN 2>/dev/null || fuser {port}/tcp 2>/dev/null); do echo \"$pid $(ps -o comm= -p $pid)\"; done | sort -u")
    };
    let Ok(res) = crate::remote::procs::exec(
        host,
        crate::remote::procs::Exec {
            command: Some(&command),
            argv: None,
            cwd: None,
            env: None,
            timeout_ms: Some(15_000),
            run_id: None,
        },
    ) else {
        return Vec::new();
    };
    res.stdout
        .lines()
        .filter_map(|l| {
            let (pid, name) = l.trim().split_once(' ').unwrap_or((l.trim(), ""));
            Some(PortListener {
                pid: pid.parse().ok()?,
                name: name.trim().to_string(),
            })
        })
        .collect()
}

fn stop_remote_port(host: &str, port: u16) -> Result<(), CmdError> {
    let windows = crate::remote::info(host)
        .map(|i| i.os == "windows")
        .unwrap_or(false);
    let command = if windows {
        format!("Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }}")
    } else {
        format!("pids=$(lsof -t -nP -iTCP:{port} -sTCP:LISTEN 2>/dev/null); [ -n \"$pids\" ] && kill $pids; fuser -k {port}/tcp >/dev/null 2>&1; sleep 0.5; true")
    };
    let _ = crate::remote::procs::exec(
        host,
        crate::remote::procs::Exec {
            command: Some(&command),
            argv: None,
            cwd: None,
            env: None,
            timeout_ms: Some(15_000),
            run_id: None,
        },
    );
    let still = crate::remote::call(host, "tcp", serde_json::json!({ "port": port }))
        .ok()
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if still {
        return Err(CmdError::server_stop_failed(port));
    }
    crate::remote::tunnel::close(host, port);
    Ok(())
}

/// Who is listening on a local port, for the page to name before stopping it. A port that is
/// one of Nyxs' tunnels names who listens on the remote machine's end.
#[tauri::command]
pub async fn agent_port_listeners(port: u16) -> Result<Vec<PortListener>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some((host, remote)) = crate::remote::tunnel::remote_port_for(port) {
            return remote_listeners(&host, remote);
        }
        listener_pids(port)
            .into_iter()
            .map(|pid| PortListener {
                pid,
                name: process_name(pid),
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Stops whatever listens on a local port (and what it started). Errs when something still
/// listens afterwards.
#[tauri::command]
pub async fn agent_stop_port(port: u16) -> Result<(), CmdError> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some((host, remote)) = crate::remote::tunnel::remote_port_for(port) {
            return stop_remote_port(&host, remote);
        }
        let pids = listener_pids(port);
        for pid in &pids {
            stop_pid(*pid);
        }
        // The port itself has the last word: whoever listens may not show up in the list (it
        // couldn't be read, or it's Nyxs' own), and then saying "stopped" would be a lie.
        if !listener_pids(port).is_empty() || port_answers(port) {
            return Err(CmdError::server_stop_failed(port));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_listeners_of_a_port_from_netstat() {
        let text = "\nActive Connections\n\n  Proto  Local Address          Foreign Address        State           PID\n  TCP    0.0.0.0:1420           0.0.0.0:0              LISTENING       4242\n  TCP    127.0.0.1:1420         127.0.0.1:55000        ESTABLISHED     4242\n  TCP    [::1]:1420             [::]:0                 LISTENING       4242\n  TCP    0.0.0.0:14200          0.0.0.0:0              LISTENING       7\n  UDP    0.0.0.0:1420           *:*                                    9\n";
        assert_eq!(netstat_listeners(text, 1420), vec![4242]);
        assert!(netstat_listeners(text, 3000).is_empty());
    }

    #[test]
    fn a_free_port_skips_the_taken_one() {
        // A port outside Windows' reserved dynamic ranges, where the search can step past it.
        let (taken, port) = (21000..22000)
            .find_map(|p| {
                std::net::TcpListener::bind(("127.0.0.1", p))
                    .ok()
                    .map(|l| (l, p))
            })
            .unwrap();
        let _held = taken;
        let free = agent_free_port(port - 1).unwrap();
        assert_ne!(free, port);
        assert!(free > port - 1);
        assert!(std::net::TcpListener::bind(("127.0.0.1", free)).is_ok());
    }

    #[test]
    fn reads_a_translated_netstat() {
        let text = "\nAktive Verbindungen\n\n  Proto  Lokale Adresse         Remoteadresse          Status           PID\n  TCP    [::1]:1420             [::]:0                 ABHÖREN          30568\n  TCP    [::1]:1420             [::1]:55000            HERGESTELLT      30568\n";
        assert_eq!(netstat_listeners(text, 1420), vec![30568]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn finds_a_real_listener_whatever_the_console_language() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Nyxs never lists itself, and this test is the listening process.
        let raw = tool_output("netstat", &["-ano"]).unwrap_or_default();
        assert!(
            netstat_listeners(&raw, port).contains(&std::process::id()),
            "netstat output wasn't read (empty: {})",
            raw.is_empty()
        );
    }
}
