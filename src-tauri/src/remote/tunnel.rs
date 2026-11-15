//! Port forwarding for dev servers on a remote machine: `localhost:<port>` on this PC reaches
//! `localhost:<port>` there, so the built-in browser opens a remote dev server as if it ran
//! here. The same port number is kept when it is free here, so URLs a server prints work as is.

use std::collections::HashMap;
use std::io::Read;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::conn::RemoteError;
use super::ssh;

struct Tunnel {
    child: Child,
    local: u16,
}

fn tunnels() -> &'static Mutex<HashMap<(String, u16), Tunnel>> {
    static T: OnceLock<Mutex<HashMap<(String, u16), Tunnel>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

/// Free on `127.0.0.1` and on `[::1]`: the browser opens `localhost`, which may be either, and
/// a dev server of this PC on the other one would answer instead of the tunnel.
fn port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok() && ipv6_free(port)
}

/// A PC without IPv6 has nothing listening there.
fn ipv6_free(port: u16) -> bool {
    match TcpListener::bind(("::1", port)) {
        Ok(_) => true,
        Err(e) => e.kind() != std::io::ErrorKind::AddrInUse,
    }
}

fn free_port() -> Option<u16> {
    (0..20).find_map(|_| {
        TcpListener::bind(("127.0.0.1", 0))
            .ok()
            .and_then(|l| l.local_addr().ok())
            .map(|a| a.port())
            .filter(|p| ipv6_free(*p))
    })
}

fn answers(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

/// One lock per tunnel being opened: two `forward`s for the same port at once (two tabs, a
/// reload) wait for each other, and the second finds the first's tunnel instead of opening another.
type Gates = HashMap<(String, u16), Arc<Mutex<()>>>;

fn opening(key: &(String, u16)) -> Arc<Mutex<()>> {
    static O: OnceLock<Mutex<Gates>> = OnceLock::new();
    let mut map = O.get_or_init(Default::default).lock().unwrap();
    map.retain(|_, lock| Arc::strong_count(lock) > 1);
    map.entry(key.clone()).or_default().clone()
}

/// Keeps `tunnel` for `key` and gives its local port. When a live one is already there, that
/// one stays and the new ssh is ended: dropping it would leave it running, untracked.
fn keep(key: (String, u16), mut tunnel: Tunnel) -> u16 {
    let mut map = tunnels().lock().unwrap();
    if let Some(t) = map.get_mut(&key) {
        if matches!(t.child.try_wait(), Ok(None)) {
            let _ = tunnel.child.kill();
            let _ = tunnel.child.wait();
            return t.local;
        }
    }
    let local = tunnel.local;
    map.insert(key, tunnel);
    local
}

/// The local port that reaches `remote_port` on `host`, opening the tunnel if needed.
pub fn forward(host: &str, remote_port: u16) -> Result<u16, RemoteError> {
    if !super::uri::valid_host(host) {
        return Err(RemoteError::new(
            "badHost",
            format!("{host} isn't a machine name ssh can take."),
        ));
    }
    let key = (host.to_string(), remote_port);
    let gate = opening(&key);
    let _opening = gate.lock().unwrap_or_else(|e| e.into_inner());
    {
        let mut map = tunnels().lock().unwrap();
        if let Some(t) = map.get_mut(&key) {
            if matches!(t.child.try_wait(), Ok(None)) {
                return Ok(t.local);
            }
            map.remove(&key);
        }
    }
    let local = if port_free(remote_port) {
        remote_port
    } else {
        free_port().ok_or_else(|| RemoteError::new("io", "No free local port for the tunnel."))?
    };
    let mut child = ssh::forward_command(host, local, remote_port)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| RemoteError::new("ssh", format!("Couldn't start ssh: {e}")))?;
    // Ready once the local end listens: ssh binds it right after logging in. The 20 s don't
    // count the time the user spends on a password dialog for this machine (askpass.rs).
    let mut waited = Duration::ZERO;
    let mut last = Instant::now();
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            let mut err = String::new();
            if let Some(mut s) = child.stderr.take() {
                let _ = s.read_to_string(&mut err);
            }
            return Err(RemoteError::new(
                "ssh",
                ssh::explain_failure(&err).unwrap_or_else(|| {
                    format!("The tunnel to port {remote_port} closed: {}", err.trim())
                }),
            ));
        }
        if !port_free(local) || answers(local) {
            break;
        }
        let now = Instant::now();
        if !super::askpass::busy(host) {
            waited += now - last;
        }
        last = now;
        if waited > Duration::from_secs(20) {
            let _ = child.kill();
            return Err(RemoteError::new(
                "timeout",
                format!("The tunnel to port {remote_port} didn't open in time."),
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // Drain ssh's stderr so it never blocks on a full pipe.
    if let Some(mut s) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut sink = Vec::new();
            let _ = s.read_to_end(&mut sink);
        });
    }
    Ok(keep(key, Tunnel { child, local }))
}

pub fn close(host: &str, remote_port: u16) {
    if let Some(mut t) = tunnels()
        .lock()
        .unwrap()
        .remove(&(host.to_string(), remote_port))
    {
        let _ = t.child.kill();
    }
}

pub fn close_host(host: &str) {
    let mut map = tunnels().lock().unwrap();
    let keys: Vec<_> = map.keys().filter(|(h, _)| h == host).cloned().collect();
    for k in keys {
        if let Some(mut t) = map.remove(&k) {
            let _ = t.child.kill();
        }
    }
}

pub fn close_all() {
    let mut map = tunnels().lock().unwrap();
    for (_, mut t) in map.drain() {
        let _ = t.child.kill();
    }
}

/// The remote port a local tunnel port leads to, if it is one of ours.
pub fn remote_port_for(local: u16) -> Option<(String, u16)> {
    tunnels()
        .lock()
        .unwrap()
        .iter()
        .find(|(_, t)| t.local == local)
        .map(|((h, p), _)| (h.clone(), *p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_port_taken_on_ipv6_localhost_isnt_free() {
        // The browser opens `localhost`, which may be [::1]: a dev server of this PC there
        // would answer instead of the tunnel.
        let Ok(taken) = TcpListener::bind(("::1", 0)) else {
            return; // No IPv6 on this machine.
        };
        let port = taken.local_addr().unwrap().port();
        assert!(!port_free(port));
        let free = free_port().unwrap();
        assert!(port_free(free));
    }

    /// A process that stands in for `ssh -N`.
    fn stand_in() -> Child {
        let mut cmd = if cfg!(windows) {
            let mut c = std::process::Command::new("ping");
            c.args(["-n", "30", "127.0.0.1"]);
            c
        } else {
            let mut c = std::process::Command::new("sleep");
            c.arg("30");
            c
        };
        cmd.stdout(Stdio::null()).spawn().unwrap()
    }

    #[test]
    fn a_second_tunnel_to_the_same_port_doesnt_stay_alive() {
        let key = ("nyxs-tunnel-test".to_string(), 4321);
        let tunnel = |local| Tunnel {
            child: stand_in(),
            local,
        };
        assert_eq!(keep(key.clone(), tunnel(4321)), 4321);
        // Another forward that opened at the same time: the first tunnel is the one used, and
        // the second is ended (`keep` waits for it) instead of left running untracked.
        assert_eq!(keep(key.clone(), tunnel(5555)), 4321);
        {
            let mut map = tunnels().lock().unwrap();
            let kept = map.get_mut(&key).unwrap();
            assert_eq!(kept.local, 4321);
            assert!(matches!(kept.child.try_wait(), Ok(None)));
            // Once the first one has died, a new one takes its place.
            let _ = kept.child.kill();
            let _ = kept.child.wait();
        }
        assert_eq!(keep(key.clone(), tunnel(5555)), 5555);
        close(&key.0, key.1);
    }
}
