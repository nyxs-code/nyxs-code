//! Remote machines over SSH: a project at `ssh://host/path` lives on another computer (a VPS,
//! the PC at home), and Nyxs reads, edits, searches and runs commands there through a small
//! helper (`remote/` crate, `nyxs-remote`) that it uploads on the first connection.
//!
//! Commands that take a path check `uri::parse` first and come here for remote ones; the rest
//! of the app keeps working with local paths unchanged.

pub(crate) mod askpass;
pub mod commands;
mod conn;
pub mod fs;
pub(crate) mod git;
mod install;
pub mod node;
pub mod procs;
pub mod ssh;
pub mod tunnel;
pub mod uri;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

pub use conn::{HostInfo, RemoteError};
pub use uri::{is_remote, parse, RemotePath};

pub(crate) use conn::Conn;
use conn::StartError;

/// Bumped together with `PROTOCOL` in `remote/src/main.rs` when requests change shape.
pub const PROTOCOL: u32 = 1;

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

pub(crate) fn app() -> Option<&'static AppHandle> {
    APP.get()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub host: String,
    /// `connecting`, `installing`, `connected`, `disconnected` or `error`.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<HostInfo>,
}

fn emit_status(host: &str, state: &str, message: Option<String>, info: Option<HostInfo>) {
    if let Some(app) = app() {
        let _ = app.emit(
            "remote-status",
            StatusEvent {
                host: host.to_string(),
                state: state.to_string(),
                message,
                info,
            },
        );
    }
}

type Slot = Arc<Mutex<Option<Arc<Conn>>>>;

fn slots() -> &'static Mutex<HashMap<String, Slot>> {
    static SLOTS: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();
    SLOTS.get_or_init(Default::default)
}

fn slot(host: &str) -> Slot {
    slots()
        .lock()
        .unwrap()
        .entry(host.to_string())
        .or_default()
        .clone()
}

/// The live connection to `host`, opening it (and installing the helper there) if needed.
/// Opening takes a few seconds; every later call reuses it.
pub(crate) fn conn(host: &str) -> Result<Arc<Conn>, RemoteError> {
    // Checked before anything reaches ssh (or scp, to install the helper).
    if !uri::valid_host(host) {
        return Err(RemoteError::new(
            "badHost",
            format!("{host} isn't a machine name ssh can take."),
        ));
    }
    let slot = slot(host);
    let mut guard = slot.lock().unwrap();
    if let Some(c) = guard.as_ref() {
        if c.is_alive() {
            return Ok(c.clone());
        }
    }
    *guard = None;
    emit_status(host, "connecting", None, None);
    let c =
        open(host).inspect_err(|e| emit_status(host, "error", Some(e.message.clone()), None))?;
    emit_status(host, "connected", None, Some(c.info.clone()));
    *guard = Some(c.clone());
    Ok(c)
}

fn open(host: &str) -> Result<Arc<Conn>, RemoteError> {
    let lost_host = host.to_string();
    let on_lost = move || {
        tunnel::close_host(&lost_host);
        emit_status(&lost_host, "disconnected", None, None);
    };
    let target = install::known_target(host);
    if let Some(t) = &target {
        if let Ok(cmd) = install::helper_command(t) {
            match Conn::start(host, &cmd, PROTOCOL, Box::new(on_lost.clone())) {
                Ok(c) => return Ok(c),
                Err(StartError::Ssh(msg)) => return Err(RemoteError::new("ssh", msg)),
                Err(StartError::NoHelper(_)) => {}
            }
        }
    }
    emit_status(host, "installing", None, None);
    let t = install::install(host)?;
    let cmd = install::helper_command(&t)?;
    match Conn::start(host, &cmd, PROTOCOL, Box::new(on_lost)) {
        Ok(c) => Ok(c),
        Err(StartError::Ssh(msg)) => Err(RemoteError::new("ssh", msg)),
        Err(StartError::NoHelper(detail)) => Err(RemoteError::new(
            "helper",
            format!(
                "Nyxs' helper didn't start on the machine.{}",
                if detail.trim().is_empty() {
                    String::new()
                } else {
                    format!("\n{}", detail.trim())
                }
            ),
        )),
    }
}

/// The connection only if it is already open: for status checks that must not dial.
pub(crate) fn existing(host: &str) -> Option<Arc<Conn>> {
    let slot = slots().lock().unwrap().get(host).cloned()?;
    let guard = slot.lock().unwrap();
    guard.as_ref().filter(|c| c.is_alive()).cloned()
}

/// The open connection to `host`, if any, for code outside this module that registers for
/// its events.
pub(crate) fn existing_conn(host: &str) -> Option<Arc<Conn>> {
    existing(host)
}

/// The connection to `host`, opening it if needed.
pub(crate) fn conn_for(host: &str) -> Result<Arc<Conn>, RemoteError> {
    conn(host)
}

pub(crate) fn existing_info(host: &str) -> Option<HostInfo> {
    existing(host).map(|c| c.info.clone())
}

pub fn disconnect(host: &str) {
    let slot = slots().lock().unwrap().get(host).cloned();
    if let Some(slot) = slot {
        if let Some(c) = slot.lock().unwrap().take() {
            c.close();
        }
    }
    tunnel::close_host(host);
}

pub fn shutdown_all() {
    let all: Vec<Slot> = slots().lock().unwrap().values().cloned().collect();
    for slot in all {
        if let Some(c) = slot.lock().unwrap().take() {
            c.close();
        }
    }
    tunnel::close_all();
    procs::shutdown_all();
}

/// A request to the helper on `host`, with the default 60-second patience.
pub(crate) fn call(host: &str, op: &str, params: Value) -> Result<Value, RemoteError> {
    conn(host)?.call(op, params, Some(Duration::from_secs(60)))
}

pub(crate) fn call_with(
    host: &str,
    op: &str,
    params: Value,
    timeout: Option<Duration>,
) -> Result<Value, RemoteError> {
    conn(host)?.call(op, params, timeout)
}

pub(crate) fn info(host: &str) -> Result<HostInfo, RemoteError> {
    Ok(conn(host)?.info.clone())
}

/// Against a real SSH server: `NYXS_SSH_CONFIG=<config> NYXS_REMOTE_TEST_HOST=<host>
/// cargo test remote::live -- --ignored --nocapture`. The host needs a writable home.
#[cfg(test)]
mod live {
    use crate::agent::*;

    fn host() -> Option<String> {
        std::env::var("NYXS_REMOTE_TEST_HOST")
            .ok()
            .filter(|h| !h.is_empty())
    }

    #[test]
    #[ignore]
    fn files_search_and_commands_work_on_the_remote_machine() {
        let Some(host) = host() else { return };
        let info = super::info(&host).expect("connect");
        println!("connected: {info:?}");
        let root = format!("ssh://{host}{}/nyxs-live-test", info.home);
        let scope = "remote-live-test".to_string();
        crate::agent::set_scope_roots_for_tests(&scope, std::slice::from_ref(&root));
        let _ = super::procs::exec(
            &host,
            super::procs::Exec {
                command: Some(&format!("rm -rf '{}/nyxs-live-test'", info.home)),
                argv: None,
                cwd: None,
                env: None,
                timeout_ms: Some(10_000),
                run_id: None,
            },
        );

        let file = format!("{root}/src/main.ts");
        let out = agent_write_file(
            file.clone(),
            "const a = 1;\nconsole.log(a);\n".into(),
            Some(scope.clone()),
            None,
            None,
        )
        .unwrap();
        assert!(out.contains("new file"), "{out}");
        let read = agent_read_file(file.clone(), None, None, Some(scope.clone())).unwrap();
        assert!(read.contains("     1\tconst a = 1;"), "{read}");
        let mtime = agent_file_mtime(file.clone()).expect("mtime");
        let edited = agent_edit_file(
            file.clone(),
            "const a = 1;".into(),
            "const a = 2;".into(),
            None,
            Some(scope.clone()),
            None,
            None,
            Some(mtime),
        )
        .unwrap();
        assert!(edited.contains("1 replacement"), "{edited}");
        assert!(agent_path_exists(file.clone()));
        assert!(path_is_dir(format!("{root}/src")));
        let listed = agent_list_dir(root.clone(), Some(scope.clone())).unwrap();
        assert_eq!(listed, vec!["src/".to_string()]);

        let globbed =
            agent_glob("**/*.ts".into(), root.clone(), None, Some(scope.clone())).unwrap();
        assert_eq!(globbed, vec![file.clone()]);
        let grepped = agent_grep(
            "a = 2".into(),
            root.clone(),
            None,
            Some("content".into()),
            None,
            None,
            None,
            None,
            Some(scope.clone()),
        )
        .unwrap();
        assert_eq!(grepped, format!("{file}:1:const a = 2;"));
        let files = agent_list_files(root.clone()).unwrap();
        assert_eq!(files, vec!["src/main.ts".to_string()]);

        let outside = agent_read_file(
            format!("ssh://{host}/etc/passwd"),
            None,
            None,
            Some(scope.clone()),
        );
        assert!(outside.unwrap_err().contains("Access denied"));

        let ran = tauri::async_runtime::block_on(agent_run(
            "cat src/main.ts && pwd".into(),
            Some(root.clone()),
            Some(20_000),
            None,
            None,
            None,
            None,
        ))
        .unwrap();
        let v = serde_json::to_value(&ran).unwrap();
        assert!(
            v["stdout"].as_str().unwrap().contains("const a = 2;"),
            "{v}"
        );
        assert!(
            v["stdout"].as_str().unwrap().contains("/nyxs-live-test"),
            "{v}"
        );
        let git = tauri::async_runtime::block_on(agent_git(
            vec!["--version".into()],
            Some(root.clone()),
            None,
        ))
        .unwrap();
        assert!(serde_json::to_value(&git).unwrap()["stdout"]
            .as_str()
            .unwrap()
            .starts_with("git version"));

        let piped = tauri::async_runtime::block_on(agent_run(
            "cat".into(),
            Some(root.clone()),
            Some(20_000),
            None,
            None,
            None,
            Some("{\"hook\":\"añø ✓\"}".into()),
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&piped).unwrap()["stdout"],
            "{\"hook\":\"añø ✓\"}"
        );

        let timed = tauri::async_runtime::block_on(agent_run(
            "sleep 5".into(),
            Some(root.clone()),
            Some(1_000),
            None,
            None,
            None,
            None,
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&timed).unwrap()["timed_out"],
            serde_json::json!(true)
        );

        let sessions = crate::agent::nyxs_list_sessions(root.clone()).unwrap();
        assert!(sessions.is_empty());
        crate::agent::nyxs_session_append(root.clone(), "s1".into(), "{\"role\":\"user\"}".into())
            .unwrap();
        crate::agent::nyxs_session_write_meta(
            root.clone(),
            "s1".into(),
            "{\"title\":\"hola\"}".into(),
        )
        .unwrap();
        let sessions =
            serde_json::to_value(crate::agent::nyxs_list_sessions(root.clone()).unwrap()).unwrap();
        assert_eq!(sessions[0]["id"], "s1");
        assert_eq!(sessions[0]["messageCount"], 1);
        let read = serde_json::to_value(
            crate::agent::nyxs_session_read(root.clone(), "s1".into()).unwrap(),
        )
        .unwrap();
        assert_eq!(read["meta"], "{\"title\":\"hola\"}");
        crate::agent::nyxs_session_delete(root.clone(), "s1".into()).unwrap();
    }

    #[test]
    #[ignore]
    fn a_remote_dev_server_opens_through_a_tunnel() {
        let Some(host) = host() else { return };
        let info = super::info(&host).expect("connect");
        let port = 47_000 + (std::process::id() % 1000) as u16;
        let mut child = super::procs::spawn(
            &host,
            super::procs::Spawn {
                command: Some(&format!("python3 -m http.server {port} --bind 127.0.0.1")),
                argv: None,
                cwd: Some(&info.home),
                env: None,
                stdin: false,
                interactive: false,
            },
        )
        .unwrap();
        let mut out = child.stderr.take().unwrap();
        std::thread::spawn(move || {
            let mut sink = Vec::new();
            let _ = std::io::Read::read_to_end(&mut out, &mut sink);
        });
        let started = std::time::Instant::now();
        while !super::call(&host, "tcp", serde_json::json!({ "port": port }))
            .unwrap()
            .as_bool()
            .unwrap()
        {
            assert!(started.elapsed().as_secs() < 15, "server never listened");
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        let local = super::tunnel::forward(&host, port).unwrap();
        let body = reqwest::blocking::get(format!("http://127.0.0.1:{local}/"))
            .unwrap()
            .text()
            .unwrap();
        assert!(body.contains("Directory listing"), "{body}");
        child.handle().kill();
        assert!(
            child
                .wait_timeout(std::time::Duration::from_secs(10))
                .is_some(),
            "kill didn't end it"
        );
        super::tunnel::close(&host, port);
    }

    /// Needs `typescript-language-server` on the machine's PATH.
    #[test]
    #[ignore]
    fn a_language_server_runs_on_the_remote_machine() {
        let Some(host) = host() else { return };
        let info = super::info(&host).expect("connect");
        let root = format!("ssh://{host}{}/nyxs-lsp-test", info.home);
        let file = format!("{root}/a.ts");
        super::fs::write(
            &super::parse(&file).unwrap(),
            b"const n: number = 'x';
",
        )
        .unwrap();
        super::fs::write(
            &super::parse(&format!("{root}/tsconfig.json")).unwrap(),
            b"{}",
        )
        .unwrap();
        // Like a real project, it has `typescript` in its node_modules (linked to the global one).
        super::procs::exec(
            &host,
            super::procs::Exec {
                command: Some(
                    "g=~/.local/lib/node_modules; [ -d $g/typescript ] || g=$(npm root -g); mkdir -p node_modules && ln -sfn $g/typescript node_modules/typescript",
                ),
                argv: None,
                cwd: Some(&super::parse(&root).unwrap().path),
                env: None,
                timeout_ms: Some(30_000),
                run_id: None,
            },
        )
        .unwrap();
        let status =
            crate::lsp::lsp_ensure_server(root.clone(), "typescript".into()).expect("server");
        assert_eq!(status.state, "ready");
        crate::lsp::lsp_did_open(
            root.clone(),
            "typescript".into(),
            file.clone(),
            "typescript".into(),
            1,
            "const n: number = 'x';
"
            .into(),
            None,
        )
        .unwrap();
        let diags =
            crate::lsp::lsp_diagnostics_wait(root.clone(), "typescript".into(), 15_000, None)
                .unwrap();
        let list = diags
            .get(&file)
            .unwrap_or_else(|| panic!("no diagnostics for {file}: {:?}", diags.keys()));
        assert!(
            list.iter().any(|d| d.message.contains("not assignable")),
            "{:?}",
            list.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
        let defs =
            crate::lsp::lsp_definition(root.clone(), "typescript".into(), file.clone(), 0, 6)
                .unwrap();
        assert!(defs.to_string().contains(&file), "{defs}");
        crate::lsp::lsp_dispose_workspace(root);
    }

    #[test]
    #[ignore]
    fn symlinks_the_watcher_and_html_pages_on_the_remote_machine() {
        let Some(host) = host() else { return };
        let info = super::info(&host).expect("connect");
        let dir = format!("{}/nyxs-live-links", info.home);
        let root = format!("ssh://{host}{dir}");
        let sh = |cmd: String| {
            super::procs::exec(
                &host,
                super::procs::Exec {
                    command: Some(&cmd),
                    argv: None,
                    cwd: None,
                    env: None,
                    timeout_ms: Some(10_000),
                    run_id: None,
                },
            )
            .expect("exec")
        };
        sh(format!(
            "rm -rf '{dir}' && mkdir -p '{dir}/site/css' '{dir}/node_modules' && \
             printf '<html><head></head><body>hola</body></html>' > '{dir}/site/index.html' && \
             printf 'body{{}}' > '{dir}/site/css/a.css' && ln -s /etc '{dir}/away' && \
             ln -s /etc/hostname '{dir}/site/leak' && ln -s '{dir}/missing' '{dir}/dangling'"
        ));
        let scope = "remote-live-links".to_string();
        crate::agent::set_scope_roots_for_tests(&scope, std::slice::from_ref(&root));

        // 1. A symlink out of the project is refused, as locally.
        let read = |p: &str| {
            crate::agent::agent_read_file(format!("{root}/{p}"), None, None, Some(scope.clone()))
        };
        assert!(read("site/index.html").unwrap().contains("hola"));
        assert!(read("away/passwd").unwrap_err().contains("symlink"));
        assert!(read("dangling").unwrap_err().contains("broken symlink"));
        let new_file = crate::agent::agent_write_file(
            format!("{root}/away/nyxs-escape.txt"),
            "x".into(),
            Some(scope.clone()),
            None,
            None,
        );
        assert!(new_file.unwrap_err().contains("Access denied"));

        // 2. The watcher answers within a moment (inotify), not on the 2 s poll, and not for
        //    an ignored folder.
        let conn = super::conn_for(&host).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        conn.on_watch(
            "live-w",
            std::sync::Arc::new(move || {
                let _ = tx.lock().unwrap().send(());
            }),
        );
        conn.call(
            "watch",
            serde_json::json!({ "watch": "live-w", "root": dir }),
            None,
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        sh(format!("echo x > '{dir}/node_modules/dep.js'"));
        assert!(
            rx.recv_timeout(std::time::Duration::from_millis(900))
                .is_err(),
            "ignored folder"
        );
        let t0 = std::time::Instant::now();
        sh(format!("echo x > '{dir}/site/new.txt'"));
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("a change event");
        let took = t0.elapsed();
        println!("change seen after {took:?}");
        assert!(
            took < std::time::Duration::from_millis(1500),
            "{took:?}: polling, not inotify"
        );
        let _ = conn.call("unwatch", serde_json::json!({ "watch": "live-w" }), None);

        // 3. An HTML page of the project, served from the machine for the browser.
        let site = crate::agent::remote_real_path(&format!("{root}/site")).unwrap();
        let get = |p: &str| {
            crate::agent::serve_remote_preview_file(&site, p, &crate::agent::remote_real_path)
        };
        let (status, ct, body) = get("/");
        assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
        assert!(ct.starts_with("text/html"));
        let html = String::from_utf8(body).unwrap();
        assert!(
            html.contains("hola") && html.contains("nyxs-agent-reply"),
            "{html}"
        );
        assert_eq!(get("/css/a.css").2, b"body{}");
        assert_eq!(get("/leak").0, 403);
        assert_eq!(get("/missing.html").0, 404);
        sh(format!("rm -rf '{dir}'"));
    }

    #[test]
    #[ignore]
    fn worktrees_and_snapshots_on_the_remote_machine() {
        let Some(host) = host() else { return };
        let info = super::info(&host).expect("connect");
        let dir = format!("{}/nyxs-live-wt", info.home);
        let root = format!("ssh://{host}{dir}");
        let sh = |cmd: String| {
            let r = super::procs::exec(
                &host,
                super::procs::Exec {
                    command: Some(&cmd),
                    argv: None,
                    cwd: None,
                    env: None,
                    timeout_ms: Some(30_000),
                    run_id: None,
                },
            )
            .expect("exec");
            assert_eq!(r.code, Some(0), "{cmd}: {}", r.stderr);
            r.stdout
        };
        let read = |uri: &str| String::from_utf8(crate::agent::vfs::read(uri).unwrap()).unwrap();
        let g = "git -c user.name=T -c user.email=t@t -c commit.gpgsign=false";
        sh(format!(
            "rm -rf '{dir}' ~/.nyxs/worktree && mkdir -p '{dir}' && cd '{dir}' && git init -q -b main && \
             printf 'line 1\\n' > a.txt && printf '.env\\n' > .gitignore && printf '.env\\n' > .worktreeinclude && \
             printf 'TOKEN=1\\n' > .env && git add -A && {g} commit -q -m init"
        ));

        // The session's worktree, on the machine, with the listed local file.
        assert!(crate::worktree::worktree_supported(root.clone()));
        let wt = crate::worktree::session_worktree_create(
            root.clone(),
            "session-live".into(),
            "Nyxs/live".into(),
            None,
        )
        .unwrap();
        assert!(
            wt.starts_with(&format!("ssh://{host}{}/.nyxs/worktree/", info.home)),
            "{wt}"
        );
        assert_eq!(read(&format!("{wt}/a.txt")), "line 1\n");
        assert_eq!(read(&format!("{wt}/.env")), "TOKEN=1\n");
        let wt_dir = super::parse(&wt).unwrap().path;
        assert_eq!(
            sh(format!("git -C '{wt_dir}' rev-parse --abbrev-ref HEAD")).trim(),
            "Nyxs/live"
        );
        // Reopened: the same one.
        assert_eq!(
            crate::worktree::session_worktree_create(
                root.clone(),
                "session-live".into(),
                "Nyxs/live".into(),
                None
            )
            .unwrap(),
            wt
        );
        crate::worktree::session_worktree_remove(root.clone(), wt.clone(), Some(true)).unwrap();
        assert!(!crate::agent::vfs::exists(&wt));

        // A sub-agent's worktree starts from the uncommitted work and its patch comes back.
        sh(format!(
            "cd '{dir}' && printf 'line 1\\nuncommitted\\n' > a.txt && printf 'new\\n' > new.md"
        ));
        let sub = crate::worktree::worktree_create(
            root.clone(),
            "sub-live".into(),
            None,
            Some("Nyxs".into()),
        )
        .unwrap();
        assert_eq!(read(&format!("{sub}/a.txt")), "line 1\nuncommitted\n");
        assert_eq!(read(&format!("{sub}/new.md")), "new\n");
        crate::agent::vfs::write(&format!("{sub}/agent.md"), b"from the agent\n").unwrap();
        let patch =
            crate::worktree::worktree_export_patch(root.clone(), "sub-live".into(), None).unwrap();
        assert!(
            patch.contains("agent.md") && !patch.contains("a.txt"),
            "{patch}"
        );
        crate::worktree::worktree_check_patch(root.clone(), patch.clone()).unwrap();
        crate::worktree::worktree_apply_patch(root.clone(), patch).unwrap();
        assert_eq!(read(&format!("{root}/agent.md")), "from the agent\n");
        // A conflict leaves the project as it was and keeps the patch on the machine.
        crate::agent::vfs::write(&format!("{sub}/a.txt"), b"from the agent\n").unwrap();
        let clash =
            crate::worktree::worktree_export_patch(root.clone(), "sub-live".into(), None).unwrap();
        sh(format!("cd '{dir}' && printf 'from the user\\n' > a.txt"));
        let err = crate::worktree::worktree_apply_patch(root.clone(), clash).unwrap_err();
        assert!(err.contains("saved at ssh://"), "{err}");
        assert_eq!(read(&format!("{root}/a.txt")), "from the user\n");
        crate::worktree::worktree_remove(
            root.clone(),
            "sub-live".into(),
            Some(true),
            None,
            Some("Nyxs".into()),
        )
        .unwrap();
        assert!(!crate::agent::vfs::exists(&sub));

        // Shadow snapshots: what a command changed, read back and put back.
        let snap = |ws: &str| {
            tauri::async_runtime::block_on(crate::agent::agent_shadow_snapshot(ws.into())).unwrap()
        };
        let before = snap(&root);
        sh(format!(
            "cd '{dir}' && printf 'by a script\\n' > a.txt && printf 'x\\n' > made.txt"
        ));
        let after = snap(&root);
        assert_ne!(before, after);
        let mut changed = tauri::async_runtime::block_on(crate::agent::agent_shadow_changed(
            root.clone(),
            before.clone(),
            after.clone(),
        ))
        .unwrap();
        changed.sort();
        assert_eq!(changed, vec!["a.txt".to_string(), "made.txt".to_string()]);
        let old = tauri::async_runtime::block_on(crate::agent::agent_shadow_read(
            root.clone(),
            before.clone(),
            "a.txt".into(),
        ))
        .unwrap();
        assert_eq!(old.as_deref(), Some("from the user\n"));
        let restored = tauri::async_runtime::block_on(crate::agent::agent_shadow_restore(
            root.clone(),
            before,
            changed,
        ))
        .unwrap();
        assert_eq!(restored, 2);
        assert_eq!(read(&format!("{root}/a.txt")), "from the user\n");
        assert!(!crate::agent::vfs::exists(&format!("{root}/made.txt")));
        sh(format!("rm -rf '{dir}'"));
    }

    /// `NYXS_REMOTE_PASSWORD_HOST`: a host in the ssh_config that only takes a password,
    /// `NYXS_REMOTE_PASSWORD`: that password.
    #[test]
    #[ignore]
    fn a_machine_that_takes_only_a_password() {
        let (Ok(host), Ok(password)) = (
            std::env::var("NYXS_REMOTE_PASSWORD_HOST"),
            std::env::var("NYXS_REMOTE_PASSWORD"),
        ) else {
            return;
        };
        let asked = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = asked.clone();
        super::askpass::set_responder(Some(Box::new(move |r| {
            log.lock()
                .unwrap()
                .push((r.prompt.clone(), r.kind, r.retry));
            // Wrong the first time: ssh asks again and the dialog says so.
            let value = if r.retry {
                password.clone()
            } else {
                "not-it".to_string()
            };
            Some(super::askpass::Answer {
                value,
                remember: false,
            })
        })));
        let info = super::info(&host);
        super::askpass::set_responder(None);
        let info = info.expect("connect with a password");
        println!("connected: {info:?}, asked: {:?}", asked.lock().unwrap());
        let asked = asked.lock().unwrap();
        assert!(asked[0].0.to_lowercase().contains("password"), "{asked:?}");
        assert_eq!(asked[0].1, "password");
        assert!(
            asked.iter().any(|a| a.2),
            "the wrong answer was asked again: {asked:?}"
        );
        // One question per answer: the connection's other ssh runs (probe, copy, serve) used
        // the answer kept in memory.
        assert!(asked.len() <= 3, "{asked:?}");
    }

    #[test]
    #[ignore]
    fn the_folder_picker_makes_new_folders() {
        let Some(host) = host() else { return };
        let info = super::info(&host).expect("connect");
        let home = format!("ssh://{host}{}", info.home);
        let _ = super::fs::remove(&super::parse(&format!("{home}/nyxs-made")).unwrap(), true);
        let run = |name: &str| {
            tauri::async_runtime::block_on(super::commands::remote_create_folder(
                home.clone(),
                name.into(),
            ))
        };
        assert_eq!(run("nyxs-made").unwrap(), format!("{home}/nyxs-made"));
        assert!(run("nyxs-made").unwrap_err().contains("already exists"));
        assert!(run("../x").unwrap_err().contains("valid"));
        assert!(run("..").is_err());
        let folders =
            tauri::async_runtime::block_on(super::commands::remote_list_folders(home.clone()))
                .unwrap();
        assert!(folders.contains(&"nyxs-made".to_string()));
        super::fs::remove(&super::parse(&format!("{home}/nyxs-made")).unwrap(), true).unwrap();
    }
}
