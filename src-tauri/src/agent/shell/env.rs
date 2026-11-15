//! The environment commands run in: the login shell's variables on Unix, PowerShell's setup on
//! Windows, and the shell a command line is handed to.

#[cfg(not(target_os = "windows"))]
use super::capture::{capture, kill_tree};
#[cfg(target_os = "windows")]
use super::host::persistent_shell_enabled;
use crate::agent::*;

#[cfg(target_os = "windows")]
fn wrap_powershell_utf8(command: &str) -> String {
    format!(
        "$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;\
         $PSDefaultParameterValues['Out-File:Encoding']='utf8';\
         $PSDefaultParameterValues['Set-Content:Encoding']='utf8';\
         $PSDefaultParameterValues['Add-Content:Encoding']='utf8';\
         $env:Path=((@($env:Path,[Environment]::GetEnvironmentVariable('Path','Machine'),[Environment]::GetEnvironmentVariable('Path','User')) -join ';') -split ';' | Where-Object {{ $_ }} | Select-Object -Unique) -join ';';\
         {detached}{hidden}\n{command}",
        detached = crate::agent::job::start_detached(),
        hidden = crate::agent::job::START_PROCESS_HIDDEN
    )
}

#[cfg(not(target_os = "windows"))]
const LOGIN_ENV_SKIP: [&str; 10] = [
    "PWD",
    "OLDPWD",
    "SHLVL",
    "_",
    "PS1",
    "PS2",
    "PS4",
    "PROMPT_COMMAND",
    "TERM_SESSION_ID",
    "HISTFILE",
];

#[cfg(not(target_os = "windows"))]
fn login_env() -> &'static Vec<(String, String)> {
    static ENV: OnceLock<Vec<(String, String)>> = OnceLock::new();
    ENV.get_or_init(resolve_login_env)
}

#[cfg(not(target_os = "windows"))]
fn parse_env_dump(text: &str) -> Vec<(String, String)> {
    let mut vars: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        let key_end = line.find('=').filter(|&i| {
            i > 0
                && line[..i].chars().enumerate().all(|(n, c)| {
                    c == '_' || c.is_ascii_alphabetic() || (n > 0 && c.is_ascii_digit())
                })
        });
        match key_end {
            Some(i) => vars.push((line[..i].to_string(), line[i + 1..].to_string())),
            None => {
                if let Some(last) = vars.last_mut() {
                    last.1.push('\n');
                    last.1.push_str(line);
                }
            }
        }
    }
    vars.retain(|(k, _)| !k.starts_with("__") && !LOGIN_ENV_SKIP.contains(&k.as_str()));
    vars
}

#[cfg(not(target_os = "windows"))]
fn resolve_login_env() -> Vec<(String, String)> {
    use std::os::unix::process::CommandExt;
    const MARK: &str = "__NYXS_LOGIN_ENV_5b1e__";
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".into()
            } else {
                "/bin/bash".into()
            }
        });
    let mut cmd = Command::new(&shell);
    cmd.args(["-i", "-l", "-c", &format!("echo {MARK}; env; echo {MARK}")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    let Ok(mut child) = cmd.spawn() else {
        return Vec::new();
    };
    let out = capture(child.stdout.take(), None, "stdout");
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < Duration::from_secs(5) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                kill_tree(&mut child);
                let _ = child.wait();
                break;
            }
        }
    }
    out.settle();
    let text = out.text();
    let mut parts = text.split(MARK);
    let _ = parts.next();
    match parts.next() {
        Some(dump) => parse_env_dump(dump.trim_matches(|c| c == '\n' || c == '\r')),
        None => Vec::new(),
    }
}

/// Lets the PowerShells Nyxs starts run local scripts. With no policy set, Windows uses
/// Restricted, and PowerShell resolves `npm`, `npx`, `pnpm`… to their `.ps1` shims, which it
/// then refuses to run ("la ejecución de scripts está deshabilitada"): installs, dev servers
/// and the CLIs' own commands failed. Set as Nyxs' own environment, so every PowerShell it
/// starts inherits it (the agent's commands, the terminal tabs, the CLIs' tools), while
/// nothing outside Nyxs changes. RemoteSigned still wants downloaded scripts signed, and a
/// policy the organization sets (Group Policy) still wins over it. A policy the user chose
/// for their own processes is kept.
pub fn allow_local_powershell_scripts() {
    #[cfg(target_os = "windows")]
    if std::env::var_os("PSExecutionPolicyPreference").is_none() {
        std::env::set_var("PSExecutionPolicyPreference", "RemoteSigned");
    }
}

pub fn warm_shell_env() {
    #[cfg(not(target_os = "windows"))]
    std::thread::spawn(|| {
        let _ = login_env();
    });
    #[cfg(target_os = "windows")]
    if persistent_shell_enabled() {
        crate::agent::ps_host::warm();
    }
}

pub(crate) fn login_path() -> Option<String> {
    #[cfg(not(target_os = "windows"))]
    if let Some((_, v)) = login_env().iter().find(|(k, _)| k == "PATH") {
        return Some(v.clone());
    }
    std::env::var("PATH").ok()
}

pub(crate) fn apply_login_env(cmd: &mut Command) {
    #[cfg(not(target_os = "windows"))]
    for (k, v) in login_env() {
        cmd.env(k, v);
    }
    #[cfg(target_os = "windows")]
    let _ = cmd;
}

#[cfg(target_os = "windows")]
pub(crate) fn powershell_exe() -> &'static str {
    static EXE: OnceLock<String> = OnceLock::new();
    EXE.get_or_init(crate::pty::windows_shell)
}

#[tauri::command]
pub fn agent_shell_info() -> String {
    #[cfg(target_os = "windows")]
    {
        let exe = powershell_exe().to_ascii_lowercase();
        if exe.ends_with("pwsh.exe") {
            "pwsh"
        } else {
            "powershell"
        }
        .to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "bash".to_string()
    }
}

pub(super) fn shell_command(command: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new(powershell_exe());
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &wrap_powershell_utf8(command),
        ]);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new("bash");
        cmd.args(["-c", command]);
        apply_login_env(&mut cmd);
        cmd.process_group(0);
        cmd
    }
}
