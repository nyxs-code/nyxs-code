use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    /// Keystrokes for the shell, written by the session's own thread. `term_write` runs on the
    /// app's main thread, and a write to a shell that isn't reading (a long paste while a
    /// program runs) would wait there and freeze the window.
    input: std::sync::mpsc::Sender<Vec<u8>>,
    child: Box<dyn Child + Send + Sync>,
    /// The latest output, so a terminal the app's page lost on a reload can be shown again.
    scrollback: Arc<Mutex<VecDeque<u8>>>,
}

const SCROLLBACK_BYTES: usize = 512 * 1024;

static SESSIONS: OnceLock<Mutex<HashMap<String, PtySession>>> = OnceLock::new();
static COUNTER: AtomicU64 = AtomicU64::new(1);

fn sessions() -> &'static Mutex<HashMap<String, PtySession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
struct TermOutput {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct TermExit {
    id: String,
    code: Option<u32>,
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_shell() -> String {
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("pwsh.exe");
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(pf) = std::env::var(var) {
            let candidate = std::path::Path::new(&pf).join("PowerShell\\7\\pwsh.exe");
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    "powershell.exe".into()
}

#[tauri::command(async)]
pub fn term_open(
    app: AppHandle,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(24),
            cols: cols.unwrap_or(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let remote = cwd.as_deref().and_then(crate::remote::parse);
    let mut cmd = if let Some(r) = &remote {
        // A remote project's terminal is a shell on that machine, in the project's folder.
        let info = crate::remote::info(&r.host).map_err(String::from)?;
        let argv = crate::remote::ssh::terminal_argv(&r.host, &r.path, &info.os);
        let mut c = CommandBuilder::new(&argv[0]);
        c.args(&argv[1..]);
        c
    } else {
        #[cfg(target_os = "windows")]
        let c = CommandBuilder::new(windows_shell());
        #[cfg(not(target_os = "windows"))]
        let c = {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".into());
            CommandBuilder::new(shell)
        };
        c
    };
    if remote.is_none() {
        if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
            cmd.cwd(dir);
        }
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;
    // The shell ends with Nyxs however Nyxs ends; what the user runs from it (an editor, a dev
    // server) is left as a normal exit leaves it.
    if let Some(pid) = child.process_id() {
        crate::agent::cli_process::tie_to_app(pid);
    }
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;
    let (input, keystrokes) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for data in keystrokes {
            if writer.write_all(&data).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });

    let id = format!("term_{}", COUNTER.fetch_add(1, Ordering::Relaxed));
    let scrollback = Arc::new(Mutex::new(VecDeque::new()));
    sessions().lock().unwrap_or_else(|e| e.into_inner()).insert(
        id.clone(),
        PtySession {
            master: pair.master,
            input,
            child,
            scrollback: scrollback.clone(),
        },
    );

    let reader_app = app.clone();
    let reader_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut kept) = scrollback.lock() {
                        kept.extend(&buf[..n]);
                        let excess = kept.len().saturating_sub(SCROLLBACK_BYTES);
                        kept.drain(..excess);
                    }
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = reader_app.emit(
                        "term-output",
                        TermOutput {
                            id: reader_id.clone(),
                            data,
                        },
                    );
                }
            }
        }
        let mut code = None;
        // Out of the map first, and the lock let go before waiting: the wait can take long (a
        // program that relaunched itself keeps the console), and every keystroke, resize and
        // busy check of every terminal takes this lock on the app's main thread, so holding it
        // here froze the whole window.
        let removed = sessions()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&reader_id);
        if let Some(mut sess) = removed {
            if let Ok(status) = sess.child.wait() {
                code = Some(status.exit_code());
            }
        }
        let _ = reader_app.emit(
            "term-exit",
            TermExit {
                id: reader_id,
                code,
            },
        );
    });

    Ok(id)
}

/// Picks up a terminal that is still running after the app's page reloaded: its recent output
/// (base64), or None when it has exited.
#[tauri::command]
pub fn term_attach(id: String) -> Option<String> {
    let map = sessions().lock().unwrap_or_else(|e| e.into_inner());
    let sess = map.get(&id)?;
    let kept = sess.scrollback.lock().ok()?;
    let (a, b) = kept.as_slices();
    Some(base64::engine::general_purpose::STANDARD.encode([a, b].concat()))
}

#[tauri::command]
pub fn term_write(id: String, data: String) -> Result<(), String> {
    let map = sessions().lock().unwrap_or_else(|e| e.into_inner());
    let sess = map.get(&id).ok_or("no such terminal")?;
    sess.input
        .send(data.into_bytes())
        .map_err(|_| "write failed: the terminal closed".to_string())
}

#[tauri::command]
pub fn term_resize(id: String, rows: u16, cols: u16) -> Result<(), String> {
    let map = sessions().lock().unwrap_or_else(|e| e.into_inner());
    let sess = map.get(&id).ok_or("no such terminal")?;
    sess.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {e}"))?;
    Ok(())
}

/// Ends the shell and everything started from it. Killing only the shell would leave a dev
/// server or watcher running with no terminal, still holding its port.
fn kill_session(sess: &mut PtySession) {
    if let Some(pid) = sess.child.process_id() {
        #[cfg(target_os = "windows")]
        {
            let mut tk = std::process::Command::new("taskkill");
            tk.args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            crate::agent::hide_console(&mut tk);
            let _ = tk.status();
        }
        // portable-pty starts the shell in its own session, so the session id is the shell's pid.
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("pkill")
                .args(["-KILL", "-s", &pid.to_string()])
                .status();
        }
    }
    let _ = sess.child.kill();
}

pub fn term_shutdown_all() {
    let drained: Vec<PtySession> = match sessions().lock() {
        Ok(mut map) => map.drain().map(|(_, s)| s).collect(),
        Err(_) => return,
    };
    for mut sess in drained {
        kill_session(&mut sess);
    }
}

/// Ends a terminal in the background: `taskkill` over a whole process tree takes its time, and
/// this command runs on the app's main thread.
#[tauri::command]
pub fn term_close(id: String) -> Result<(), String> {
    let removed = sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    if let Some(mut sess) = removed {
        std::thread::spawn(move || kill_session(&mut sess));
    }
    Ok(())
}

/// The name of a program running in the terminal besides its shell (a dev server, a build…),
/// or None when the shell is idle at its prompt. Lets closing the terminal warn first. Off the
/// main thread: it walks a snapshot of every process on the machine.
#[tauri::command(async)]
pub fn term_busy(id: String) -> Option<String> {
    let pid = sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)?
        .child
        .process_id()?;
    child_process_name(pid)
}

#[cfg(target_os = "windows")]
fn child_process_name(parent: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        let mut more = Process32FirstW(snap, &mut entry) != 0;
        while more {
            if entry.th32ParentProcessID == parent {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                // ConPTY can hang a console host off the shell; that's not something the user ran.
                if !name.eq_ignore_ascii_case("conhost.exe") {
                    found = Some(name);
                    break;
                }
            }
            more = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
        found
    }
}

#[cfg(not(target_os = "windows"))]
fn child_process_name(parent: u32) -> Option<String> {
    let out = std::process::Command::new("pgrep")
        .args(["-l", "-P", &parent.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.split_once(' ').map(|(_, name)| name.trim().to_string()))
        .filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::child_process_name;

    // A shell of its own stands in for the terminal's: the test binary's own children include
    // whatever tests running in parallel have started.
    #[test]
    fn finds_a_running_child_and_nothing_once_it_is_gone() {
        #[cfg(target_os = "windows")]
        let mut shell = std::process::Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .spawn()
            .unwrap();
        #[cfg(not(target_os = "windows"))]
        let mut shell = std::process::Command::new("sh")
            .args(["-c", "sleep 30; true"])
            .spawn()
            .unwrap();
        // Generous deadlines: a full parallel test run can keep the shell from starting for
        // seconds.
        let start = std::time::Instant::now();
        let mut name = None;
        while name.is_none() && start.elapsed() < std::time::Duration::from_secs(20) {
            name = child_process_name(shell.id());
            if name.is_none() {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
        let name = name.expect("the child should be found").to_lowercase();
        assert!(
            name.starts_with("ping") || name.starts_with("sleep"),
            "{name}"
        );

        #[cfg(target_os = "windows")]
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &shell.id().to_string(), "/T", "/F"])
            .output();
        #[cfg(not(target_os = "windows"))]
        let _ = std::process::Command::new("pkill")
            .args(["-P", &shell.id().to_string()])
            .status();
        let _ = shell.kill();
        let _ = shell.wait();
        // Killing is asynchronous: the killed child stays in the process list until it is torn
        // down.
        let start = std::time::Instant::now();
        let mut left = child_process_name(shell.id());
        while left.is_some() && start.elapsed() < std::time::Duration::from_secs(20) {
            std::thread::sleep(std::time::Duration::from_millis(50));
            left = child_process_name(shell.id());
        }
        assert_eq!(left, None);
    }
}
