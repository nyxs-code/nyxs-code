//! git on a remote machine, for the code that runs it here with `Command::new("git")`
//! (worktrees, shadow snapshots): the same arguments, run there through the helper, with the
//! same results and error messages as the local helpers in `worktree.rs`.

use std::collections::HashMap;

use super::procs::{exec_bytes, BytesResult};

/// `git <args>` on `host`, in `cwd`, with `stdin` fed to it.
pub(crate) fn run(
    host: &str,
    cwd: Option<&str>,
    args: &[&str],
    stdin: Option<&[u8]>,
    env: Option<&HashMap<String, String>>,
) -> Result<BytesResult, String> {
    let argv: Vec<String> = std::iter::once("git")
        .chain(args.iter().copied())
        .map(str::to_string)
        .collect();
    exec_bytes(host, &argv, cwd, env, stdin).map_err(|e| format!("Couldn't run git: {}", e.message))
}

fn with_dir<'a>(cwd: &'a str, args: &[&'a str]) -> Vec<&'a str> {
    let mut full = vec!["-C", cwd];
    full.extend_from_slice(args);
    full
}

fn failure(args: &[&str], res: &BytesResult) -> String {
    let stderr = res.stderr.trim();
    if stderr.is_empty() {
        format!(
            "git {} failed (exit code {:?})",
            args.join(" "),
            Some(res.code)
        )
    } else {
        stderr.to_string()
    }
}

/// `git -C <cwd> <args>`: its output trimmed, or what it printed on failure.
pub(crate) fn git(host: &str, cwd: &str, args: &[&str]) -> Result<String, String> {
    git_raw(host, cwd, args).map(|s| s.trim().to_string())
}

/// `git -C <cwd> <args>`: its whole output.
pub(crate) fn git_raw(host: &str, cwd: &str, args: &[&str]) -> Result<String, String> {
    let res = run(host, None, &with_dir(cwd, args), None, None)?;
    if res.code == 0 {
        Ok(String::from_utf8_lossy(&res.stdout).into_owned())
    } else {
        Err(failure(args, &res))
    }
}

/// `git -C <cwd> <args>` with `stdin`: its exit code and output as bytes, whatever the code.
pub(crate) fn git_bytes(
    host: &str,
    cwd: &str,
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Result<(i32, Vec<u8>), String> {
    let res = run(host, None, &with_dir(cwd, args), stdin, None)?;
    Ok((res.code, res.stdout))
}

/// `git -C <cwd> <args>` with `stdin`, failing with git's message.
pub(crate) fn git_input(
    host: &str,
    cwd: &str,
    args: &[&str],
    stdin: &[u8],
) -> Result<String, String> {
    let res = run(host, None, &with_dir(cwd, args), Some(stdin), None)?;
    if res.code == 0 {
        Ok(String::from_utf8_lossy(&res.stdout).trim().to_string())
    } else {
        Err(failure(args, &res))
    }
}
