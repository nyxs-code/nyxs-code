use std::process::Child;
use std::sync::OnceLock;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
};

#[cfg(test)]
pub(crate) static SKIP_JOB: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

const DETACH_MARK: &str = "NYXS_DETACHED_PID=";
const DETACH_ERROR: &str = "NYXS_DETACH_ERROR=";
const DETACH_ENV: [&str; 3] = ["NYXS_DETACH_LINE", "NYXS_DETACH_DIR", "NYXS_DETACH_SHOW"];

pub(crate) fn start_detached() -> &'static str {
    static FN: OnceLock<String> = OnceLock::new();
    FN.get_or_init(|| {
        let ps_quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
        let (exe, args) = detach_helper();
        let call = std::iter::once(exe).chain(args).map(|a| ps_quote(&a)).collect::<Vec<_>>().join(" ");
        format!(
            r#"
function Start-Detached {{
  param([Parameter(Mandatory = $true, Position = 0)][string]$FilePath, [Parameter(Position = 1)][string[]]$ArgumentList = @(), [switch]$Hidden)
  $quote = {{ param($a) if ($a -match '[\s"]') {{ '"' + ($a -replace '"', '\"') + '"' }} else {{ $a }} }}
  $app = Get-Command -Name $FilePath -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($app) {{
    $line = (@($app.Source) + $ArgumentList | ForEach-Object {{ & $quote $_ }}) -join ' '
  }} else {{
    $target = Resolve-Path -LiteralPath $FilePath -ErrorAction SilentlyContinue
    $target = if ($target) {{ $target.ProviderPath }} else {{ $FilePath }}
    $line = 'explorer.exe ' + (& $quote $target)
  }}
  $env:NYXS_DETACH_LINE = $line
  $env:NYXS_DETACH_DIR = (Get-Location -PSProvider FileSystem).ProviderPath
  $env:NYXS_DETACH_SHOW = if ($Hidden) {{ '0' }} else {{ '1' }}
  try {{ $out = @(& {call} | ForEach-Object {{ "$_" }}) }}
  finally {{ Remove-Item env:NYXS_DETACH_LINE, env:NYXS_DETACH_DIR, env:NYXS_DETACH_SHOW -ErrorAction SilentlyContinue }}
  $procId = $out | Where-Object {{ $_.StartsWith('{DETACH_MARK}') }} | Select-Object -First 1
  if (-not $procId) {{
    $why = ($out | Where-Object {{ $_.StartsWith('{DETACH_ERROR}') }} | Select-Object -First 1)
    $why = if ($why) {{ $why.Substring({err_len}) }} else {{ ($out -join ' ').Trim() }}
    throw "Start-Detached: could not start ${{line}}: $why"
  }}
  [pscustomobject]@{{ ProcessId = [int]$procId.Substring({mark_len}); CommandLine = $line }}
}}
"#,
            err_len = DETACH_ERROR.len(),
            mark_len = DETACH_MARK.len(),
        )
    })
}

/// Wraps `Start-Process` so a console program it starts runs hidden. Start-Process gives a
/// console program a console of its own, and that console's window shows (with Windows Terminal
/// as the default terminal, a terminal window opens) every time the agent runs one. Programs a
/// command starts directly don't need this: they share the host's console, which has no window.
/// Only a console-subsystem .exe/.com or a batch file gets `-WindowStyle Hidden`, and only when
/// the command chose no `-WindowStyle`, `-NoNewWindow` or `-Verb`; GUI programs, documents and
/// URLs open as before.
pub(crate) const START_PROCESS_HIDDEN: &str = r#"
function Test-NyxsConsoleProgram([string]$FilePath) {
  try {
    if (-not $FilePath) { return $false }
    $path = if (Test-Path -LiteralPath $FilePath -PathType Leaf) { (Resolve-Path -LiteralPath $FilePath).ProviderPath } else { Get-Command -Name $FilePath -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source }
    if (-not $path) { return $false }
    $ext = [IO.Path]::GetExtension($path).ToLowerInvariant()
    if ($ext -in '.bat', '.cmd') { return $true }
    if ($ext -notin '.exe', '.com') { return $false }
    $fs = [IO.File]::OpenRead($path)
    try {
      $br = New-Object IO.BinaryReader $fs
      if ($br.ReadUInt16() -ne 0x5A4D) { return $false }
      $fs.Position = 0x3C
      $fs.Position = $br.ReadInt32()
      if ($br.ReadUInt32() -ne 0x4550) { return $false }
      # The optional header's Subsystem field (same offset in PE32 and PE32+); 3 is the console.
      $fs.Position += 0x58
      return $br.ReadUInt16() -eq 3
    } finally { $fs.Dispose() }
  } catch { return $false }
}
& {
  $cmdlet = Get-Command -Name Microsoft.PowerShell.Management\Start-Process -CommandType Cmdlet -ErrorAction SilentlyContinue
  if (-not $cmdlet) { return }
  $meta = New-Object System.Management.Automation.CommandMetadata $cmdlet
  $proxy = [System.Management.Automation.ProxyCommand]
  $body = {
    if (-not ($PSBoundParameters.ContainsKey('WindowStyle') -or $PSBoundParameters.ContainsKey('NoNewWindow') -or $PSBoundParameters.ContainsKey('Verb')) -and (Test-NyxsConsoleProgram $FilePath)) {
      $PSBoundParameters['WindowStyle'] = 'Hidden'
    }
    Microsoft.PowerShell.Management\Start-Process @PSBoundParameters
  }
  ${function:script:Start-Process} = [scriptblock]::Create($proxy::GetCmdletBindingAttribute($meta) + "`nparam(" + $proxy::GetParamBlock($meta) + ")`n" + $body)
}
"#;

fn detach_helper() -> (String, Vec<String>) {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    #[cfg(test)]
    let args = vec![
        format!(
            "{}::tests::detach_helper",
            module_path!().split_once("::").unwrap().1
        ),
        "--exact".into(),
        "--ignored".into(),
        "--nocapture".into(),
    ];
    #[cfg(not(test))]
    let args = vec!["--nyxs-detach".into()];
    (exe, args)
}

pub fn detach_helper_main() -> i32 {
    let [line, dir, show] = DETACH_ENV.map(|k| std::env::var(k).unwrap_or_default());
    for k in DETACH_ENV {
        std::env::remove_var(k);
    }
    match spawn_detached(&line, &dir, show != "0") {
        Ok(pid) => {
            println!("{DETACH_MARK}{pid}");
            0
        }
        Err(e) => {
            println!("{DETACH_ERROR}{e}");
            1
        }
    }
}

fn spawn_detached(line: &str, dir: &str, show: bool) -> Result<u32, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_CONSOLE, CREATE_NEW_PROCESS_GROUP,
        PROCESS_INFORMATION, STARTF_USESHOWWINDOW, STARTUPINFOW,
    };
    if line.trim().is_empty() {
        return Err("empty command line".into());
    }
    let wide = |s: &str| {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let mut cmdline = wide(line);
    let dir = (!dir.is_empty()).then(|| wide(dir));
    unsafe {
        let mut si: STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = if show { 1 } else { 0 };
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessW(
            std::ptr::null(),
            cmdline.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP,
            std::ptr::null(),
            dir.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
            &si,
            &mut pi,
        );
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        Ok(pi.dwProcessId)
    }
}

/// A job that ends its processes when Nyxs ends, however it ends: its handle is never closed,
/// so Windows closes it with the process. 0 when it couldn't be made.
fn new_job(limits: u32) -> usize {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | limits;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            CloseHandle(job);
            return 0;
        }
        job as usize
    }
}

/// Shells and the helpers Nyxs owns whole: everything they start is in it too, unless started
/// to break away (Start-Detached).
fn agent_job() -> Option<HANDLE> {
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| new_job(JOB_OBJECT_LIMIT_BREAKAWAY_OK));
    (job != 0).then_some(job as HANDLE)
}

/// The agent CLIs, Claude Code and the terminals' shells: they end with Nyxs, but what they
/// start doesn't join it (a dev server, a browser an agent opened, an editor the user opened
/// from a terminal), so it is left as a normal exit leaves it.
fn tied_job() -> Option<HANDLE> {
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| new_job(JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK));
    (job != 0).then_some(job as HANDLE)
}

/// Ties a running process to Nyxs (see `tied_job`). Best effort: one that can't join (it
/// ended, or it already sits in a job that forbids it) runs on as before.
pub(crate) fn tie_to_app(pid: u32) {
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };
    let Some(job) = tied_job() else { return };
    unsafe {
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if process.is_null() {
            return;
        }
        AssignProcessToJobObject(job, process);
        CloseHandle(process);
    }
}

/// Starts `cmd` already inside the agent's job, without a console window (as `hide_console`).
/// `contain` after `spawn` leaves a gap: a child the process starts at once (cmd running a
/// program, PowerShell's first command) could be born outside the job and outlive Nyxs. Here
/// the process starts suspended, joins the job, and only then runs its first instruction.
pub(crate) fn spawn_contained(cmd: &mut std::process::Command) -> std::io::Result<Child> {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    #[cfg(test)]
    let skip = SKIP_JOB.load(std::sync::atomic::Ordering::Relaxed);
    #[cfg(not(test))]
    let skip = false;
    let Some(job) = agent_job().filter(|_| !skip) else {
        cmd.creation_flags(CREATE_NO_WINDOW);
        return cmd.spawn();
    };
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    let mut child = cmd.spawn()?;
    // Not in the job is how it was before; it runs all the same.
    unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) };
    if let Err(e) = resume_main_thread(child.id()) {
        // Suspended forever is worse than not started.
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    Ok(child)
}

/// Lets a process created suspended run: a new process has just its main thread.
fn resume_main_thread(pid: u32) -> std::io::Result<()> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut resumed = 0;
        let mut more = Thread32First(snap, &mut entry) != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() {
                    if ResumeThread(thread) != u32::MAX {
                        resumed += 1;
                    }
                    CloseHandle(thread);
                }
            }
            more = Thread32Next(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
        if resumed == 0 {
            return Err(std::io::Error::other("couldn't resume the new process"));
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn in_agent_job(pid: u32) -> bool {
    agent_job().is_some_and(|job| in_job(job, pid))
}

#[cfg(test)]
pub(crate) fn tied_to_app(pid: u32) -> bool {
    tied_job().is_some_and(|job| in_job(job, pid))
}

/// The processes whose parent is `pid`.
#[cfg(test)]
pub(crate) fn children_of(pid: u32) -> Vec<u32> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snap, &mut e) != 0;
        while more {
            if e.th32ParentProcessID == pid {
                out.push(e.th32ProcessID);
            }
            more = Process32NextW(snap, &mut e) != 0;
        }
        CloseHandle(snap);
    }
    out
}

#[cfg(test)]
fn in_job(job: HANDLE, pid: u32) -> bool {
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut inside = 0;
        let ok = IsProcessInJob(handle, job, &mut inside);
        CloseHandle(handle);
        ok != 0 && inside != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    #[ignore = "helper process for Start-Detached"]
    fn detach_helper() {
        if std::env::var_os("NYXS_DETACH_LINE").is_none() {
            return;
        }
        std::process::exit(detach_helper_main());
    }

    fn kill_pid(pid: u32) {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_TERMINATE,
        };
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !h.is_null() {
                TerminateProcess(h, 1);
                CloseHandle(h);
            }
        }
    }

    #[test]
    fn a_child_started_at_once_is_born_inside_the_job() {
        // cmd starts ping as its very first act: with the job joined after spawn, ping could
        // be created before cmd was in it.
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = spawn_contained(&mut cmd).unwrap();
        assert!(in_agent_job(child.id()));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let kids = loop {
            let kids = children_of(child.id());
            if !kids.is_empty() || std::time::Instant::now() > deadline {
                break kids;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        assert!(!kids.is_empty(), "cmd never started ping");
        for &kid in &kids {
            assert!(
                in_agent_job(kid),
                "the child {kid} was born outside the job"
            );
            kill_pid(kid);
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn a_contained_process_runs_once_resumed() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "echo resumed"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let child = spawn_contained(&mut cmd).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "resumed");
    }
}
