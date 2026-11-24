//! Waiting for a dev server started in a background shell to accept connections.

use super::background::{bg_shells, next_char_boundary};
use crate::agent::*;
use crate::error::CmdError;

/// Waits until a dev server accepts connections at `url` and returns the address to open.
/// Only the port is checked: a first page can take long to compile, and the browser shows
/// that itself. With `shell_id` it gives up as soon as that shell exits, and follows the local
/// address the server printed if it moved to another port. `timeout_ms` 0 checks once.
#[tauri::command]
pub async fn agent_wait_for_server(
    url: String,
    shell_id: Option<String>,
    timeout_ms: Option<u64>,
    cwd: Option<String>,
) -> Result<String, CmdError> {
    tauri::async_runtime::spawn_blocking(move || {
        // A server on a remote machine (its shell or the project runs there) is waited for
        // there, and the address returned is the local end of a tunnel to it.
        let shell_cwd = shell_id.as_deref().and_then(|id| {
            bg_shells()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(id)
                .and_then(|sh| sh.cwd.clone())
        });
        let host = cwd
            .or(shell_cwd)
            .as_deref()
            .and_then(crate::remote::parse)
            .map(|r| r.host);
        match host {
            Some(host) => {
                wait_for_remote_server(&host, &url, shell_id.as_deref(), timeout_ms.unwrap_or(0))
            }
            None => wait_for_server(&url, shell_id.as_deref(), timeout_ms.unwrap_or(0)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Loopback names are probed on both IPv4 and IPv6: Vite on Node listens on `::1` only, and
/// on Windows a refused connection takes ~2 s, so each address gets its own short timeout.
fn server_addrs(url: &tauri::Url) -> Vec<std::net::SocketAddr> {
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
    let Some(port) = url.port_or_known_default() else {
        return Vec::new();
    };
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host == "0.0.0.0" {
        return vec![
            SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
            SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        ];
    }
    (host.as_str(), port)
        .to_socket_addrs()
        .map(|a| a.collect())
        .unwrap_or_default()
}

fn accepts_connections(addrs: &[std::net::SocketAddr]) -> bool {
    addrs
        .iter()
        .any(|a| std::net::TcpStream::connect_timeout(a, Duration::from_millis(250)).is_ok())
}

fn strip_ansi(text: &str) -> String {
    static ANSI: OnceLock<regex::Regex> = OnceLock::new();
    ANSI.get_or_init(|| regex::Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").unwrap())
        .replace_all(text, "")
        .into_owned()
}

/// Local addresses a server announced in its output ("Local: http://localhost:5175/").
fn printed_local_urls(output: &str) -> Vec<String> {
    static URL: OnceLock<regex::Regex> = OnceLock::new();
    let re = URL.get_or_init(|| {
        regex::Regex::new(r#"https?://(?:localhost|127\.0\.0\.1|\[::1\]):\d+[^\s"'<>]*"#).unwrap()
    });
    let mut urls: Vec<String> = Vec::new();
    for m in re.find_iter(&strip_ansi(output)) {
        let u = m
            .as_str()
            .trim_end_matches(['.', ',', ')', ';'])
            .to_string();
        if !urls.contains(&u) {
            urls.push(u);
        }
    }
    urls
}

/// The printed addresses the wait may follow instead of the one it was given: those on a line
/// where a server announces itself (`Local:`, `ready`), and any printed after the output says
/// the expected port is taken (the server moved). Any other address in the output may be
/// another program's (`concurrently "api" "vite"`), and the tab would open that one.
fn followable_urls(output: &str, expected_port: Option<u16>) -> Vec<String> {
    static ANNOUNCE: OnceLock<regex::Regex> = OnceLock::new();
    let announce = ANNOUNCE.get_or_init(|| regex::Regex::new(r"(?i)\blocal\b|\bready\b").unwrap());
    let busy = expected_port.and_then(|p| {
        regex::Regex::new(&format!(
            r"(?i)port\D{{0,3}}{p}\b.*\b(?:in use|busy|taken|unavailable)|EADDRINUSE.*:{p}\b|already running on port {p}\b"
        ))
        .ok()
    });
    let mut moved = false;
    let mut urls: Vec<String> = Vec::new();
    for line in strip_ansi(output).lines() {
        if busy.as_ref().is_some_and(|re| re.is_match(line)) {
            moved = true;
        }
        if !moved && !announce.is_match(line) {
            continue;
        }
        for u in printed_local_urls(line) {
            if !urls.contains(&u) {
                urls.push(u);
            }
        }
    }
    urls
}

fn output_tail(output: &str, lines: usize) -> String {
    let plain = strip_ansi(output);
    let kept: Vec<&str> = plain.lines().filter(|l| !l.trim().is_empty()).collect();
    kept[kept.len().saturating_sub(lines)..].join("\n")
}

fn wait_for_server(url: &str, shell_id: Option<&str>, timeout_ms: u64) -> Result<String, CmdError> {
    wait_with(url, shell_id, timeout_ms, &|u| {
        accepts_connections(&server_addrs(u))
    })
    .map(|(u, _)| u)
}

fn remote_listens(host: &str, url: &tauri::Url) -> bool {
    let Some(port) = url.port_or_known_default() else {
        return false;
    };
    crate::remote::call(host, "tcp", serde_json::json!({ "port": port }))
        .ok()
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn wait_for_remote_server(
    host: &str,
    url: &str,
    shell_id: Option<&str>,
    timeout_ms: u64,
) -> Result<String, CmdError> {
    let (found, parsed) = wait_with(url, shell_id, timeout_ms, &|u| remote_listens(host, u))?;
    let Some(port) = parsed.port_or_known_default() else {
        return Ok(found);
    };
    let local =
        crate::remote::tunnel::forward(host, port).map_err(|e| CmdError::from(e.message))?;
    let mut local_url = parsed.clone();
    let _ = local_url.set_host(Some("localhost"));
    let _ = local_url.set_port(Some(local));
    Ok(local_url.to_string())
}

fn wait_with(
    url: &str,
    shell_id: Option<&str>,
    timeout_ms: u64,
    listens: &dyn Fn(&tauri::Url) -> bool,
) -> Result<(String, tauri::Url), CmdError> {
    let target = tauri::Url::parse(url).map_err(|e| CmdError::invalid_url(url, e))?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.min(600_000));
    loop {
        if listens(&target) {
            return Ok((url.to_string(), target));
        }
        if let Some(id) = shell_id {
            let (status, code, output) = {
                let map = bg_shells().lock().unwrap_or_else(|e| e.into_inner());
                match map.get(id) {
                    Some(sh) => {
                        let from = next_char_boundary(
                            &sh.output,
                            sh.output.len().saturating_sub(32 * 1024),
                        );
                        (sh.status.clone(), sh.code, sh.output[from..].to_string())
                    }
                    None => ("done".to_string(), None, String::new()),
                }
            };
            for printed in followable_urls(&output, target.port_or_known_default()) {
                let Ok(p) = tauri::Url::parse(&printed) else {
                    continue;
                };
                if p.port_or_known_default() != target.port_or_known_default() && listens(&p) {
                    return Ok((printed, p));
                }
            }
            if status != "running" {
                let tail = output_tail(&output, 12);
                let tail = if tail.is_empty() {
                    String::new()
                } else {
                    format!("\n\n{tail}")
                };
                return Err(CmdError::server_exited(url, code, &tail));
            }
        }
        if Instant::now() >= deadline {
            return Err(CmdError::server_timeout(url, timeout_ms / 1000));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[cfg(test)]
mod tests {
    use super::super::background::BgShell;
    use super::*;

    fn fake_shell(id: &str, status: &str, code: Option<i32>, output: &str) {
        bg_shells()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id.into(),
                BgShell {
                    id: id.into(),
                    command: "dev".into(),
                    description: String::new(),
                    cwd: None,
                    output: output.into(),
                    status: status.into(),
                    code,
                    started_at: 0,
                    ended_at: None,
                    memory_stop: None,
                    dropped: 0,
                },
            );
    }

    #[test]
    fn a_server_listening_only_on_ipv6_loopback_counts_as_up() {
        let Ok(listener) = TcpListener::bind("[::1]:0") else {
            return;
        };
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://localhost:{port}");
        let start = Instant::now();
        assert_eq!(
            wait_for_server(&url, None, 0).map_err(String::from),
            Ok(url.clone())
        );
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn waiting_stops_with_the_output_when_the_server_exits() {
        let free = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        fake_shell(
            "test-wait-exit",
            "done",
            Some(1),
            "\x1b[31merror\x1b[39m when starting dev server:\nError: Port 5174 is already in use\n",
        );
        let start = Instant::now();
        let err = wait_for_server(
            &format!("http://localhost:{free}"),
            Some("test-wait-exit"),
            60_000,
        )
        .unwrap_err()
        .to_string();
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "waited for a dead server"
        );
        assert!(err.contains("(exit code 1)"), "{err}");
        assert!(err.contains("Port 5174 is already in use"), "{err}");
        assert!(!err.contains('\x1b'), "{err}");
        bg_shells()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove("test-wait-exit");
    }

    #[test]
    fn follows_the_port_the_server_printed() {
        let free = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let moved = listener.local_addr().unwrap().port();
        fake_shell(
            "test-wait-moved",
            "running",
            None,
            &format!("Port {free} is in use, trying another one...\n  \u{279c}  Local:   \x1b[36mhttp://localhost:\x1b[1m{moved}\x1b[22m/\x1b[39m\n"),
        );
        let got = wait_for_server(
            &format!("http://localhost:{free}"),
            Some("test-wait-moved"),
            5_000,
        )
        .map_err(String::from);
        assert_eq!(got, Ok(format!("http://localhost:{moved}/")));
        bg_shells()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove("test-wait-moved");
    }

    #[test]
    fn follows_only_a_server_announcing_itself_or_moving_off_a_busy_port() {
        let vite_moved = "Port 5173 is in use, trying another one...\n  \u{279c}  Local:   http://localhost:5174/\n";
        assert_eq!(
            followable_urls(vite_moved, Some(5173)),
            ["http://localhost:5174/"]
        );
        let next = "ready - started server on 0.0.0.0:3001, url: http://localhost:3001\n";
        assert_eq!(followable_urls(next, Some(3000)), ["http://localhost:3001"]);
        // `concurrently "api" "vite"`: the API's address isn't the page being waited for.
        let both = "[0] API listening at http://localhost:4000\n[1] Port 9999 is in use\n[1] VITE v5.2 building...\n";
        assert!(followable_urls(both, Some(5173)).is_empty());
        // Busy, but the address printed before it isn't the one that moved.
        let before = "[0] API at http://localhost:4000\n[1] Port 5173 is in use, trying another one...\n[1] http://localhost:5174/\n";
        assert_eq!(
            followable_urls(before, Some(5173)),
            ["http://localhost:5174/"]
        );
    }

    #[test]
    fn waiting_doesnt_wander_to_another_server_in_the_output() {
        let free = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let api = TcpListener::bind("127.0.0.1:0").unwrap();
        let api_port = api.local_addr().unwrap().port();
        fake_shell(
            "test-wait-api",
            "running",
            None,
            &format!("[0] API listening at http://localhost:{api_port}\n[1] VITE v5.2 starting\n"),
        );
        let got = wait_for_server(
            &format!("http://localhost:{free}"),
            Some("test-wait-api"),
            600,
        );
        assert!(got.is_err(), "{:?}", got.map_err(String::from));
        bg_shells()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove("test-wait-api");
    }

    #[test]
    fn a_single_check_fails_fast_when_nothing_listens() {
        let free = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let start = Instant::now();
        assert!(wait_for_server(&format!("http://localhost:{free}"), None, 0).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
