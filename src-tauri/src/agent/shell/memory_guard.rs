//! Stops a command the agent started when one of its processes uses far more memory than the
//! computer has, as Claude Code Desktop does: at least twice the installed memory, seen on two
//! checks in a row so a passing spike isn't cut. The user can lift it for a session; the agent
//! is told so it doesn't run the same command again as it was.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const GB: u64 = 1 << 30;
const CHECK_EVERY: Duration = Duration::from_secs(2);

/// Why a command was stopped: the memory of its largest process and the computer's, in GB.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct MemoryStop {
    pub used_gb: u64,
    pub installed_gb: u64,
}

/// Over the line: one process uses at least twice the installed memory (the rest is in swap or
/// the page file, and the whole computer is crawling).
pub(crate) fn over_line(largest: u64, installed: u64) -> bool {
    installed > 0 && largest >= installed.saturating_mul(2)
}

fn stop_of(largest: u64, installed: u64) -> MemoryStop {
    MemoryStop {
        used_gb: largest.div_ceil(GB),
        installed_gb: (installed + GB / 2) / GB,
    }
}

/// Watching stops when this is dropped (the command ended on its own).
pub struct Watch {
    done: Arc<AtomicBool>,
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.done.store(true, Ordering::Release);
    }
}

/// Watches the process `root` and everything it starts; calls `on_stop` once when the line is
/// crossed twice in a row. None where the installed memory can't be read.
pub fn watch(root: u32, on_stop: impl FnOnce(MemoryStop) + Send + 'static) -> Option<Watch> {
    #[cfg(test)]
    {
        let small = TEST_INSTALLED.load(Ordering::Acquire);
        if small > 0 {
            return Some(watch_with(root, small, Duration::from_millis(200), on_stop));
        }
    }
    let installed = installed_bytes()?;
    Some(watch_with(root, installed, CHECK_EVERY, on_stop))
}

/// A tiny "computer" for the tests of guarded runs: only those watch, so others aren't affected.
#[cfg(test)]
pub(crate) static TEST_INSTALLED: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

pub(crate) fn watch_with(
    root: u32,
    installed: u64,
    every: Duration,
    on_stop: impl FnOnce(MemoryStop) + Send + 'static,
) -> Watch {
    let done = Arc::new(AtomicBool::new(false));
    let flag = done.clone();
    std::thread::spawn(move || {
        let mut seen_over = false;
        loop {
            let start = Instant::now();
            while start.elapsed() < every {
                if flag.load(Ordering::Acquire) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100).min(every));
            }
            // The root is gone: the command ended.
            let Some(largest) = largest_in_tree(root) else {
                return;
            };
            if !over_line(largest, installed) {
                seen_over = false;
                continue;
            }
            if seen_over {
                if !flag.load(Ordering::Acquire) {
                    on_stop(stop_of(largest, installed));
                }
                return;
            }
            seen_over = true;
        }
    });
    Watch { done }
}

/// The memory of the largest process among `root` and its descendants; None when `root` is gone.
fn largest_in_tree(root: u32) -> Option<u64> {
    Some(
        tree_of(root)?
            .into_iter()
            .filter_map(footprint)
            .max()
            .unwrap_or(0),
    )
}

/// `root` and every process under it, from a list of (pid, parent pid); None without `root`.
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn tree_of(root: u32) -> Option<Vec<u32>> {
    let procs = processes();
    if !procs.iter().any(|&(pid, _)| pid == root) {
        return None;
    }
    let mut tree = vec![root];
    let mut i = 0;
    while i < tree.len() {
        let parent = tree[i];
        for &(pid, ppid) in &procs {
            if ppid == parent && pid != parent && !tree.contains(&pid) {
                tree.push(pid);
            }
        }
        i += 1;
    }
    Some(tree)
}

#[cfg(target_os = "windows")]
fn processes() -> Vec<(u32, u32)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
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
            out.push((e.th32ProcessID, e.th32ParentProcessID));
            more = Process32NextW(snap, &mut e) != 0;
        }
        CloseHandle(snap);
    }
    out
}

/// The memory the process has committed: what it holds in RAM plus what the page file keeps.
#[cfg(target_os = "windows")]
fn footprint(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut c: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
        c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = GetProcessMemoryInfo(
            h,
            &mut c as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS,
            c.cb,
        ) != 0;
        CloseHandle(h);
        ok.then_some(c.PrivateUsage as u64)
    }
}

#[cfg(target_os = "windows")]
fn installed_bytes() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut m: MEMORYSTATUSEX = std::mem::zeroed();
        m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        (GlobalMemoryStatusEx(&mut m) != 0 && m.ullTotalPhys > 0).then_some(m.ullTotalPhys)
    }
}

/// On macOS each process's children are asked for: no snapshot of the whole system is needed.
#[cfg(target_os = "macos")]
fn tree_of(root: u32) -> Option<Vec<u32>> {
    fn children(pid: u32) -> Vec<u32> {
        let mut buf = vec![0 as libc::pid_t; 4096];
        let n = unsafe {
            libc::proc_listchildpids(
                pid as libc::pid_t,
                buf.as_mut_ptr() as *mut libc::c_void,
                (buf.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int,
            )
        };
        if n <= 0 {
            return Vec::new();
        }
        // A count of pids; the unused part of the buffer stays 0 and is dropped either way.
        buf.truncate((n as usize).min(4096));
        buf.into_iter()
            .filter(|&p| p > 0)
            .map(|p| p as u32)
            .collect()
    }
    footprint(root)?;
    let mut tree = vec![root];
    let mut i = 0;
    while i < tree.len() {
        for child in children(tree[i]) {
            if !tree.contains(&child) {
                tree.push(child);
            }
        }
        i += 1;
    }
    Some(tree)
}

#[cfg(target_os = "macos")]
fn footprint(pid: u32) -> Option<u64> {
    let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
    let r = unsafe {
        libc::proc_pid_rusage(
            pid as libc::c_int,
            libc::RUSAGE_INFO_V2,
            &mut info as *mut libc::rusage_info_v2 as *mut libc::rusage_info_t,
        )
    };
    (r == 0).then_some(info.ri_phys_footprint)
}

#[cfg(target_os = "macos")]
fn installed_bytes() -> Option<u64> {
    let mut size: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    let r = unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            &mut size as *mut u64 as *mut libc::c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    (r == 0 && size > 0).then_some(size)
}

#[cfg(target_os = "linux")]
fn processes() -> Vec<(u32, u32)> {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    dir.filter_map(|e| {
        let pid: u32 = e.ok()?.file_name().to_str()?.parse().ok()?;
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // The name sits in parentheses and may hold spaces: the fields after it are safe.
        let rest = &stat[stat.rfind(')')? + 1..];
        let ppid = rest.split_whitespace().nth(1)?.parse().ok()?;
        Some((pid, ppid))
    })
    .collect()
}

/// What the process holds in RAM plus what it has in swap.
#[cfg(target_os = "linux")]
fn footprint(pid: u32) -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let kb = |key: &str| -> u64 {
        status
            .lines()
            .find_map(|l| l.strip_prefix(key))
            .and_then(|v| v.split_whitespace().next()?.parse().ok())
            .unwrap_or(0)
    };
    Some((kb("VmRSS:") + kb("VmSwap:")) * 1024)
}

#[cfg(target_os = "linux")]
fn installed_bytes() -> Option<u64> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb: u64 = info
        .lines()
        .find_map(|l| l.strip_prefix("MemTotal:"))?
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    Some(kb * 1024)
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn tree_of(_root: u32) -> Option<Vec<u32>> {
    None
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn footprint(_pid: u32) -> Option<u64> {
    None
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn installed_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::sync::Mutex;

    #[test]
    fn the_line_is_twice_the_installed_memory() {
        assert!(!over_line(31 * GB, 16 * GB));
        assert!(over_line(32 * GB, 16 * GB));
        assert!(!over_line(GB, 0));
        assert_eq!(
            stop_of(33 * GB + 1, 16 * GB - 3),
            MemoryStop {
                used_gb: 34,
                installed_gb: 16
            }
        );
    }

    #[test]
    fn this_computer_reports_its_memory_and_this_process() {
        assert!(installed_bytes().unwrap_or(0) > GB / 2);
        assert!(footprint(std::process::id()).unwrap_or(0) > 0);
    }

    fn sleeper() -> std::process::Child {
        #[cfg(target_os = "windows")]
        let mut c = Command::new("powershell");
        #[cfg(target_os = "windows")]
        c.args(["-NoProfile", "-Command", "Start-Sleep 30"]);
        #[cfg(not(target_os = "windows"))]
        let mut c = Command::new("sleep");
        #[cfg(not(target_os = "windows"))]
        c.arg("30");
        c.stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[test]
    fn a_command_over_the_line_is_reported_after_two_checks() {
        let mut child = sleeper();
        let hit = Arc::new(Mutex::new(None));
        let seen = hit.clone();
        // A "computer" of 1 KB: any real process is far over twice that.
        let _w = watch_with(child.id(), 1024, Duration::from_millis(200), move |s| {
            *seen.lock().unwrap() = Some((s, Instant::now()));
        });
        let start = Instant::now();
        while hit.lock().unwrap().is_none() && start.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
        let (stop, at) = hit.lock().unwrap().take().expect("never reported");
        assert!(stop.used_gb >= 1);
        // Two checks 200 ms apart, never on the first one.
        assert!(at.duration_since(start) >= Duration::from_millis(350));
    }

    #[test]
    fn a_command_under_the_line_or_already_ended_is_left_alone() {
        let mut child = sleeper();
        let hit = Arc::new(AtomicBool::new(false));
        let seen = hit.clone();
        let w = watch_with(child.id(), 1 << 50, Duration::from_millis(100), move |_| {
            seen.store(true, Ordering::Release);
        });
        std::thread::sleep(Duration::from_millis(600));
        drop(w);
        let _ = child.kill();
        let _ = child.wait();
        assert!(!hit.load(Ordering::Acquire));
        assert_eq!(largest_in_tree(child.id()), None);
    }
}
