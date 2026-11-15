use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::server::{LspServer, ServerState};

type Key = (String, String);

static SERVERS: OnceLock<Mutex<HashMap<Key, Arc<LspServer>>>> = OnceLock::new();
/// One lock per server being started, so a slow or stuck start (up to the 60 s `initialize`
/// timeout) holds back only calls for that same server, not every language and folder.
static STARTING: OnceLock<Mutex<HashMap<Key, Arc<Mutex<()>>>>> = OnceLock::new();
/// Servers that failed to start, and when: tried again only after `RETRY_AFTER`, instead of
/// every Edit waiting for the same failure again.
static FAILED: OnceLock<Mutex<HashMap<Key, (Instant, String)>>> = OnceLock::new();

#[cfg(not(test))]
const RETRY_AFTER: Duration = Duration::from_secs(60);
#[cfg(test)]
const RETRY_AFTER: Duration = Duration::from_millis(300);

/// A server that isn't installed yet isn't a failure to remember: installing it comes next.
const NOT_INSTALLED: &str = "LSP_NOT_INSTALLED:";

fn servers() -> &'static Mutex<HashMap<Key, Arc<LspServer>>> {
    SERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn failed() -> &'static Mutex<HashMap<Key, (Instant, String)>> {
    FAILED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn start_lock(key: &Key) -> Arc<Mutex<()>> {
    let mut locks = STARTING
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    locks.entry(key.clone()).or_default().clone()
}

fn live(key: &Key) -> Option<Arc<LspServer>> {
    let map = servers().lock().ok()?;
    map.get(key)
        .filter(|s| !matches!(s.state(), ServerState::Crashed(_)))
        .cloned()
}

fn recent_failure(key: &Key) -> Option<String> {
    let mut map = failed().lock().unwrap_or_else(|e| e.into_inner());
    match map.get(key) {
        Some((at, msg)) if at.elapsed() < RETRY_AFTER => Some(msg.clone()),
        Some(_) => {
            map.remove(key);
            None
        }
        None => None,
    }
}

pub fn ensure(workspace: &str, language: &str) -> Result<Arc<LspServer>, String> {
    let key = (workspace.to_string(), language.to_string());
    if let Some(server) = live(&key) {
        return Ok(server);
    }
    ensure_with(&key, || LspServer::spawn(workspace, language))
}

/// Starts the server for `key` with `spawn` unless another call is already starting it (then
/// waits for that one) or it failed a moment ago (then answers that failure at once).
fn ensure_with<F>(key: &Key, spawn: F) -> Result<Arc<LspServer>, String>
where
    F: FnOnce() -> Result<Arc<LspServer>, String>,
{
    if let Some(msg) = recent_failure(key) {
        return Err(msg);
    }
    let lock = start_lock(key);
    let _starting = lock.lock().unwrap_or_else(|e| e.into_inner());
    // The call that held the lock may have started it meanwhile.
    if let Some(server) = live(key) {
        return Ok(server);
    }
    if let Some(msg) = recent_failure(key) {
        return Err(msg);
    }
    let result = spawn();
    match &result {
        // Listed before the lock is let go, so a call waiting on it finds it instead of
        // starting a second one.
        Ok(server) => {
            if let Ok(mut map) = servers().lock() {
                map.insert(key.clone(), server.clone());
            }
        }
        Err(msg) if !msg.starts_with(NOT_INSTALLED) => {
            if let Ok(mut map) = failed().lock() {
                map.insert(key.clone(), (Instant::now(), msg.clone()));
            }
        }
        Err(_) => {}
    }
    result
}

/// Forgets the start failures of `language` (or of every language): after installing a server,
/// the next call should try it right away.
pub fn forget_failures(language: Option<&str>) {
    if let Ok(mut map) = failed().lock() {
        map.retain(|(_, lang), _| language.is_some_and(|l| l != lang));
    }
}

pub fn get(workspace: &str, language: &str) -> Option<Arc<LspServer>> {
    let key = (workspace.to_string(), language.to_string());
    servers().lock().ok()?.get(&key).cloned()
}

pub fn dispose_workspace(workspace: &str) -> u32 {
    let to_kill: Vec<Arc<LspServer>> = {
        let mut map = match servers().lock() {
            Ok(m) => m,
            Err(_) => return 0,
        };
        let keys: Vec<Key> = map
            .keys()
            .filter(|(ws, _)| ws == workspace)
            .cloned()
            .collect();
        keys.into_iter().filter_map(|k| map.remove(&k)).collect()
    };
    if let Ok(mut map) = failed().lock() {
        map.retain(|(ws, _), _| ws != workspace);
    }
    let n = to_kill.len() as u32;
    for server in to_kill {
        server.shutdown();
    }
    n
}

pub fn dispose_all() -> u32 {
    let to_kill: Vec<Arc<LspServer>> = {
        let mut map = match servers().lock() {
            Ok(m) => m,
            Err(_) => return 0,
        };
        map.drain().map(|(_, v)| v).collect()
    };
    forget_failures(None);
    let n = to_kill.len() as u32;
    for server in to_kill {
        server.shutdown();
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    fn key(tag: &str) -> Key {
        (format!("E:/registry-test-{tag}"), "rust".to_string())
    }

    #[test]
    fn a_failed_start_is_answered_at_once_until_it_may_be_tried_again() {
        let k = key("cooldown");
        let tries = AtomicUsize::new(0);
        let spawn = || -> Result<Arc<LspServer>, String> {
            tries.fetch_add(1, Ordering::SeqCst);
            Err("initialize timed out".into())
        };
        assert!(ensure_with(&k, spawn).is_err());
        assert_eq!(
            ensure_with(&k, spawn).err(),
            Some("initialize timed out".to_string())
        );
        assert_eq!(tries.load(Ordering::SeqCst), 1);
        std::thread::sleep(RETRY_AFTER + Duration::from_millis(50));
        assert!(ensure_with(&k, spawn).is_err());
        assert_eq!(tries.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_server_that_isnt_installed_is_tried_again_right_away() {
        let k = key("missing");
        let tries = AtomicUsize::new(0);
        let spawn = || -> Result<Arc<LspServer>, String> {
            tries.fetch_add(1, Ordering::SeqCst);
            Err(format!("{NOT_INSTALLED}rust"))
        };
        let _ = ensure_with(&k, spawn);
        let _ = ensure_with(&k, spawn);
        assert_eq!(tries.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_stuck_start_doesnt_hold_back_other_servers() {
        let (release, wait) = mpsc::channel::<()>();
        let stuck = key("stuck");
        let blocker = std::thread::spawn(move || {
            ensure_with(&stuck, || -> Result<Arc<LspServer>, String> {
                let _ = wait.recv_timeout(Duration::from_secs(5));
                Err("gave up".into())
            })
        });
        std::thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        let other = ensure_with(&key("other"), || -> Result<Arc<LspServer>, String> {
            Err(format!("{NOT_INSTALLED}rust"))
        });
        let waited = started.elapsed();
        let _ = release.send(());
        let _ = blocker.join();
        assert!(other.is_err());
        assert!(waited < Duration::from_secs(1), "waited {waited:?}");
    }
}
