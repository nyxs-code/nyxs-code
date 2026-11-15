//! What `ssh` asks while connecting (a password, a key's passphrase, a yes/no question),
//! answered in a Nyxs dialog. Every ssh Nyxs starts gets `SSH_ASKPASS` (with
//! `SSH_ASKPASS_REQUIRE=force`) pointing at this computer's own helper binary, which asks back
//! over a local port with a token only that ssh knows (`askpass` in remote/src/main.rs).
//!
//! Nothing is stored unless the user ticks "remember": then the answer goes to the OS keychain,
//! like the other secrets. One connection runs ssh a few times (the probe, the helper's copy,
//! `serve`), so an answer is also kept in memory for a short while, never on disk. An ssh that
//! asks again with the same token was given a wrong answer: the kept one is dropped and the
//! user is asked, told that it was wrong.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;

/// How long an answer stays in memory for the next ssh of the same connection.
const KEPT_FOR: Duration = Duration::from_secs(120);
/// How long a dialog waits for the user before ssh is told there is no answer.
const WAIT_FOR_USER: Duration = Duration::from_secs(300);

/// A question for the user, as the dialog gets it (`ssh-askpass` event).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskpassRequest {
    pub id: u64,
    pub host: String,
    /// What ssh printed: "dev@server's password:", "Enter passphrase for key '…':".
    pub prompt: String,
    /// "password", "passphrase" or "confirm" (a yes/no question).
    pub kind: &'static str,
    /// The previous answer to this same question was wrong.
    pub retry: bool,
}

#[derive(Clone, Debug)]
pub struct Answer {
    pub value: String,
    pub remember: bool,
}

type Responder = Box<dyn Fn(&AskpassRequest) -> Option<Answer> + Send + Sync>;

struct Token {
    host: String,
    made: Instant,
    /// How many times this ssh asked each question.
    asked: HashMap<String, u32>,
}

struct Server {
    port: u16,
    tokens: Mutex<HashMap<String, Token>>,
}

#[derive(Default)]
struct State {
    /// Answers kept in memory, by host and question.
    kept: HashMap<(String, String), (Instant, String)>,
    /// Dialogs waiting for the user, by request id.
    waiting: HashMap<u64, mpsc::Sender<Option<Answer>>>,
    /// Questions open or answered lately, by host: the connection keeps waiting meanwhile.
    active: HashMap<String, (u32, Instant)>,
}

fn state() -> std::sync::MutexGuard<'static, State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn responder() -> &'static Mutex<Option<Responder>> {
    static R: OnceLock<Mutex<Option<Responder>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// Answers the questions without the app (for tests against a server with a password).
#[cfg(test)]
pub(crate) fn set_responder(r: Option<Responder>) {
    *responder().lock().unwrap_or_else(|e| e.into_inner()) = r;
}

fn random_token() -> String {
    // RandomState is seeded from the OS's random source.
    let mut out = String::new();
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(NEXT_ID.fetch_add(1, Ordering::Relaxed));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn server() -> Option<&'static Server> {
    static S: OnceLock<Option<Server>> = OnceLock::new();
    S.get_or_init(|| {
        let listener = TcpListener::bind("127.0.0.1:0").ok()?;
        let port = listener.local_addr().ok()?.port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || handle(stream));
            }
        });
        Some(Server {
            port,
            tokens: Mutex::new(HashMap::new()),
        })
    })
    .as_ref()
}

/// Lets `cmd` (an ssh, scp or tunnel to `host`) ask the user through Nyxs. False when it can't
/// (no helper binary for this computer): the caller keeps ssh from prompting at all.
pub(crate) fn configure(cmd: &mut Command, host: &str) -> bool {
    let (Some(srv), Some(exe)) = (server(), super::install::local_helper()) else {
        return false;
    };
    let token = random_token();
    {
        let mut tokens = srv.tokens.lock().unwrap_or_else(|e| e.into_inner());
        tokens.retain(|_, t| t.made.elapsed() < Duration::from_secs(3600));
        tokens.insert(
            token.clone(),
            Token {
                host: host.to_string(),
                made: Instant::now(),
                asked: HashMap::new(),
            },
        );
    }
    cmd.env("SSH_ASKPASS", exe)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("NYXS_ASKPASS_PORT", srv.port.to_string())
        .env("NYXS_ASKPASS_TOKEN", token);
    // OpenSSH before 8.4 only runs SSH_ASKPASS with a DISPLAY set.
    if std::env::var_os("DISPLAY").is_none() {
        cmd.env("DISPLAY", "nyxs:0");
    }
    true
}

/// Whether a question for `host` is open, or was answered in the last 45 s: a connection
/// waiting for its helper keeps waiting while the user types.
pub(crate) fn busy(host: &str) -> bool {
    state()
        .active
        .get(host)
        .is_some_and(|(open, at)| *open > 0 || at.elapsed() < Duration::from_secs(45))
}

fn handle(stream: TcpStream) {
    let mut line = String::new();
    let Ok(reader) = stream.try_clone() else {
        return;
    };
    if BufReader::new(reader).read_line(&mut line).is_err() {
        return;
    }
    let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
    let token = v.get("token").and_then(Value::as_str).unwrap_or("");
    let prompt = v
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let confirm = v.get("confirm").and_then(Value::as_bool).unwrap_or(false);
    // Only an ssh Nyxs started knows a token.
    let Some((host, times)) = server().and_then(|srv| {
        let mut tokens = srv.tokens.lock().unwrap_or_else(|e| e.into_inner());
        let t = tokens.get_mut(token)?;
        let n = t.asked.entry(prompt.clone()).or_insert(0);
        *n += 1;
        Some((t.host.clone(), *n))
    }) else {
        let mut stream = stream;
        let _ = stream.write_all(b"{}\n");
        return;
    };
    let answer = resolve(&host, &prompt, confirm, times > 1);
    let reply = match answer {
        Some(a) => json!({ "answer": a }),
        None => json!({}),
    };
    let mut stream = stream;
    let _ = stream.write_all(format!("{reply}\n").as_bytes());
}

fn kind_of(prompt: &str, confirm: bool) -> &'static str {
    if confirm {
        "confirm"
    } else if prompt.to_lowercase().contains("passphrase") {
        "passphrase"
    } else {
        "password"
    }
}

fn keychain_account(host: &str, prompt: &str) -> String {
    format!("ssh:{host}:{prompt}")
}

fn keychain_get(account: &str) -> Option<String> {
    let app = super::app()?;
    crate::agent::nyxs_secret_get(app.clone(), account.to_string())
        .ok()
        .flatten()
}

fn keychain_set(account: &str, value: &str) {
    if let Some(app) = super::app() {
        let _ = crate::agent::nyxs_secret_set(app.clone(), account.to_string(), value.to_string());
    }
}

fn keychain_delete(account: &str) {
    if let Some(app) = super::app() {
        let _ = crate::agent::nyxs_secret_delete(app.clone(), account.to_string());
    }
}

/// The answer to `prompt` from `host`: kept, remembered, or asked. `retry`: this ssh already
/// got an answer to it, which was wrong.
fn resolve(host: &str, prompt: &str, confirm: bool, retry: bool) -> Option<String> {
    let kind = kind_of(prompt, confirm);
    let key = (host.to_string(), prompt.to_string());
    let account = keychain_account(host, prompt);
    if kind != "confirm" {
        if retry {
            state().kept.remove(&key);
            keychain_delete(&account);
        } else {
            let kept = state()
                .kept
                .get(&key)
                .filter(|(at, _)| at.elapsed() < KEPT_FOR)
                .map(|(_, v)| v.clone());
            if let Some(v) = kept.or_else(|| keychain_get(&account)) {
                return Some(v);
            }
        }
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let req = AskpassRequest {
        id,
        host: host.to_string(),
        prompt: prompt.to_string(),
        kind,
        retry,
    };
    let answer = ask(&req)?;
    if kind != "confirm" {
        state()
            .kept
            .insert(key, (Instant::now(), answer.value.clone()));
        if answer.remember {
            keychain_set(&account, &answer.value);
        }
    }
    Some(answer.value)
}

fn mark(host: &str, open: bool) {
    let mut s = state();
    let entry = s
        .active
        .entry(host.to_string())
        .or_insert((0, Instant::now()));
    if open {
        entry.0 += 1;
    } else {
        entry.0 = entry.0.saturating_sub(1);
    }
    entry.1 = Instant::now();
}

fn ask(req: &AskpassRequest) -> Option<Answer> {
    if let Some(r) = responder()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        return r(req);
    }
    let app = super::app()?;
    let (tx, rx) = mpsc::channel();
    state().waiting.insert(req.id, tx);
    mark(&req.host, true);
    let answer = if app.emit("ssh-askpass", req).is_ok() {
        rx.recv_timeout(WAIT_FOR_USER).ok().flatten()
    } else {
        None
    };
    state().waiting.remove(&req.id);
    mark(&req.host, false);
    if answer.is_none() {
        // A dialog still open (the wait ran out) closes.
        let _ = app.emit("ssh-askpass-closed", req.id);
    }
    answer
}

/// The dialog's answer to request `id`: the text typed (`None`: cancelled) and whether to keep
/// it in the keychain.
#[tauri::command]
pub fn ssh_askpass_answer(id: u64, value: Option<String>, remember: Option<bool>) {
    let tx = state().waiting.remove(&id);
    if let Some(tx) = tx {
        let _ = tx.send(value.map(|value| Answer {
            value,
            remember: remember.unwrap_or(false),
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plays the helper's side: asks the server over its port with `token`.
    fn ask_as_ssh(token: &str, prompt: &str) -> Option<String> {
        let port = server().unwrap().port;
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(format!("{}\n", json!({ "token": token, "prompt": prompt })).as_bytes())
            .unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        let v: Value = serde_json::from_str(&line).unwrap();
        v.get("answer").and_then(Value::as_str).map(str::to_string)
    }

    fn token_for(host: &str) -> String {
        let mut cmd = Command::new("ssh");
        // Without a helper binary for this computer the token is made all the same.
        let srv = server().unwrap();
        let token = random_token();
        srv.tokens.lock().unwrap().insert(
            token.clone(),
            Token {
                host: host.into(),
                made: Instant::now(),
                asked: HashMap::new(),
            },
        );
        let _ = configure(&mut cmd, host);
        token
    }

    #[test]
    fn asks_once_per_connection_and_again_after_a_wrong_answer() {
        let asked = std::sync::Arc::new(Mutex::new(Vec::<(String, &'static str, bool)>::new()));
        let log = asked.clone();
        set_responder(Some(Box::new(move |r| {
            log.lock()
                .unwrap()
                .push((r.prompt.clone(), r.kind, r.retry));
            Some(Answer {
                value: if r.retry { "right" } else { "wrong" }.into(),
                remember: false,
            })
        })));
        let host = "askpass-test-host";
        let prompt = "dev@askpass-test-host's password:";

        // The first ssh asks; a second one of the same connection gets the kept answer.
        assert_eq!(
            ask_as_ssh(&token_for(host), prompt).as_deref(),
            Some("wrong")
        );
        let second = token_for(host);
        assert_eq!(ask_as_ssh(&second, prompt).as_deref(), Some("wrong"));
        assert_eq!(asked.lock().unwrap().len(), 1);
        // That ssh asks again: the answer was wrong, so the user is asked, told so.
        assert_eq!(ask_as_ssh(&second, prompt).as_deref(), Some("right"));
        assert_eq!(
            asked.lock().unwrap()[1],
            (prompt.to_string(), "password", true)
        );

        assert_eq!(
            ask_as_ssh(
                &token_for(host),
                "Enter passphrase for key '/home/me/.ssh/id':"
            )
            .as_deref(),
            Some("wrong")
        );
        assert_eq!(asked.lock().unwrap()[2].1, "passphrase");

        // A token Nyxs didn't give out gets nothing.
        assert_eq!(ask_as_ssh("made-up", prompt), None);
        assert_eq!(kind_of("Allow use of key id? (yes/no)", true), "confirm");
        set_responder(None);
    }
}
