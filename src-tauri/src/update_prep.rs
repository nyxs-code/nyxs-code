//! Clears the way for an update's installer.
//!
//! On Windows the updater ends the app with `std::process::exit` right after starting the NSIS
//! installer, so `RunEvent::Exit`, which stops everything the app started, never runs. Anything
//! still alive keeps files open and the installer fails with "the app is running": above all
//! extra copies of `Nyxs.exe` (the MCP proxy, `--nyxs-mcp-proxy`, that agent CLIs start, even
//! ones opened outside Nyxs, since their MCP config is global). The frontend calls
//! `nyxs_prepare_update` between downloading the update and installing it.

/// How long stopping the language servers may hold the exit.
const LSP_SHUTDOWN_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// Stops every process the app started, as quitting does.
pub fn shutdown_children() {
    crate::mcp_host::shutdown_all();
    crate::agent::claude_code_shutdown_all();
    crate::agent::agent_cli_shutdown_all();
    crate::agent::bg_shutdown_all();
    crate::pty::term_shutdown_all();
    crate::remote::shutdown_all();
    crate::video::shutdown_all();
    // Last, on a thread of its own and with a bound: each language server first gets a polite
    // `shutdown` (up to 2 s, one after another). What's left still ends with Nyxs on Windows
    // (it runs in the agent's job), and elsewhere leaves when its input closes.
    let lsp = std::thread::spawn(crate::lsp::shutdown_all);
    let started = std::time::Instant::now();
    while !lsp.is_finished() && started.elapsed() < LSP_SHUTDOWN_WAIT {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// The update's installer failed after `nyxs_prepare_update` stopped the app's processes; the
/// app stays open and starts each one again when it is next used.
#[tauri::command]
pub fn nyxs_update_install_failed(error: String) {
    log::warn!(
        "update: the installer failed after the app's processes were stopped ({error}); \
         the app stays open and starts them again as they are used"
    );
}

#[tauri::command(async)]
pub fn nyxs_prepare_update() {
    log::info!("update: stopping the app's processes before the installer runs");
    shutdown_children();
    #[cfg(windows)]
    {
        let killed = windows::kill_install_dir_processes();
        if killed > 0 {
            log::info!("update: ended {killed} processes running from the install folder");
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::path::{Path, PathBuf};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE,
    };

    fn all_pids() -> Vec<u32> {
        let mut out = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return out;
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut more = Process32FirstW(snap, &mut e) != 0;
            while more {
                out.push(e.th32ProcessID);
                more = Process32NextW(snap, &mut e) != 0;
            }
            CloseHandle(snap);
        }
        out
    }

    fn image_path(pid: u32) -> Option<PathBuf> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut buf = vec![0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
            CloseHandle(h);
            (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
        }
    }

    /// Windows paths compare without case.
    fn is_inside(path: &Path, dir: &Path) -> bool {
        let path = path.to_string_lossy().to_lowercase();
        let dir = dir.to_string_lossy().to_lowercase();
        let dir = dir.trim_end_matches('\\');
        path.len() > dir.len() + 1 && path.starts_with(dir) && path.as_bytes()[dir.len()] == b'\\'
    }

    fn kill(pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid);
            if h.is_null() {
                return false;
            }
            let ok = TerminateProcess(h, 1) != 0;
            // The installer starts right after: the files must be closed by then.
            if ok {
                WaitForSingleObject(h, 2_000);
            }
            CloseHandle(h);
            ok
        }
    }

    /// Ends every other copy of the app's executable and, when the app runs from the folder the
    /// installer made (it holds `uninstall.exe`), every other process running from that folder.
    /// An exe started from anywhere else (Downloads, a build folder) only takes its own copies:
    /// the programs next to it aren't the app's. Returns how many it ended.
    pub fn kill_install_dir_processes() -> usize {
        let Ok(exe) = std::env::current_exe() else {
            return 0;
        };
        let Some(dir) = exe.parent().map(Path::to_path_buf) else {
            return 0;
        };
        let installed = dir.join("uninstall.exe").is_file();
        let exe = exe.to_string_lossy().to_lowercase();
        let me = std::process::id();
        all_pids()
            .into_iter()
            .filter(|&pid| pid != me && pid != 0)
            .filter(|&pid| {
                image_path(pid).is_some_and(|p| {
                    p.to_string_lossy().to_lowercase() == exe || (installed && is_inside(&p, &dir))
                })
            })
            .filter(|&pid| kill(pid))
            .count()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn is_inside_matches_the_folder_only() {
            let dir = Path::new(r"C:\Users\me\AppData\Local\Nyxs");
            assert!(is_inside(
                Path::new(r"C:\Users\me\AppData\Local\Nyxs\Nyxs.exe"),
                dir
            ));
            assert!(is_inside(
                Path::new(r"c:\users\ME\appdata\local\nyxs\Nyxs.exe"),
                dir
            ));
            assert!(!is_inside(
                Path::new(r"C:\Users\me\AppData\Local\Nyxs2\x.exe"),
                dir
            ));
            assert!(!is_inside(dir, dir));
        }
    }
}
