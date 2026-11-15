use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::provision::{
    managed_bin_dir, managed_node_program, managed_servers_dir, node_package_installed,
};

pub enum Launch {
    Native {
        names: &'static [&'static str],
    },
    Node {
        npm_packages: &'static [&'static str],
        bin_package: &'static str,
        bin_name: &'static str,
    },
}

pub struct ServerSpec {
    pub language: &'static str,
    pub launch: Launch,
    pub args: &'static [&'static str],
}

pub const SERVER_SPECS: &[ServerSpec] = &[
    ServerSpec {
        language: "typescript",
        launch: Launch::Node {
            npm_packages: &["typescript-language-server", "typescript"],
            bin_package: "typescript-language-server",
            bin_name: "typescript-language-server",
        },
        args: &["--stdio"],
    },
    ServerSpec {
        language: "javascript",
        launch: Launch::Node {
            npm_packages: &["typescript-language-server", "typescript"],
            bin_package: "typescript-language-server",
            bin_name: "typescript-language-server",
        },
        args: &["--stdio"],
    },
    ServerSpec {
        language: "rust",
        launch: Launch::Native {
            names: &["rust-analyzer"],
        },
        args: &[],
    },
    ServerSpec {
        language: "python",
        launch: Launch::Node {
            npm_packages: &["pyright"],
            bin_package: "pyright",
            bin_name: "pyright-langserver",
        },
        args: &["--stdio"],
    },
    ServerSpec {
        language: "json",
        launch: Launch::Node {
            npm_packages: &["vscode-langservers-extracted"],
            bin_package: "vscode-langservers-extracted",
            bin_name: "vscode-json-language-server",
        },
        args: &["--stdio"],
    },
    ServerSpec {
        language: "html",
        launch: Launch::Node {
            npm_packages: &["vscode-langservers-extracted"],
            bin_package: "vscode-langservers-extracted",
            bin_name: "vscode-html-language-server",
        },
        args: &["--stdio"],
    },
    ServerSpec {
        language: "css",
        launch: Launch::Node {
            npm_packages: &["vscode-langservers-extracted"],
            bin_package: "vscode-langservers-extracted",
            bin_name: "vscode-css-language-server",
        },
        args: &["--stdio"],
    },
    ServerSpec {
        language: "scss",
        launch: Launch::Node {
            npm_packages: &["vscode-langservers-extracted"],
            bin_package: "vscode-langservers-extracted",
            bin_name: "vscode-css-language-server",
        },
        args: &["--stdio"],
    },
    ServerSpec {
        language: "less",
        launch: Launch::Node {
            npm_packages: &["vscode-langservers-extracted"],
            bin_package: "vscode-langservers-extracted",
            bin_name: "vscode-css-language-server",
        },
        args: &["--stdio"],
    },
    ServerSpec {
        language: "yaml",
        launch: Launch::Node {
            npm_packages: &["yaml-language-server"],
            bin_package: "yaml-language-server",
            bin_name: "yaml-language-server",
        },
        args: &["--stdio"],
    },
    ServerSpec {
        language: "bash",
        launch: Launch::Node {
            npm_packages: &["bash-language-server"],
            bin_package: "bash-language-server",
            bin_name: "bash-language-server",
        },
        args: &["start"],
    },
];

pub fn spec_for(language: &str) -> Option<&'static ServerSpec> {
    SERVER_SPECS.iter().find(|s| s.language == language)
}

/// The program and arguments to start a language's server on a remote machine, where it has
/// to be on the PATH (`npm i -g typescript-language-server typescript`, `rustup component add
/// rust-analyzer`...).
pub fn remote_command(language: &str) -> Option<(String, Vec<String>)> {
    let spec = spec_for(language)?;
    let program = match &spec.launch {
        Launch::Native { names } => names.first()?.to_string(),
        Launch::Node { bin_name, .. } => bin_name.to_string(),
    };
    Some((program, spec.args.iter().map(|a| a.to_string()).collect()))
}

pub struct ResolvedCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub source: &'static str,
}

pub fn resolve(language: &str) -> Option<ResolvedCommand> {
    let spec = spec_for(language)?;
    let args: Vec<String> = spec.args.iter().map(|s| s.to_string()).collect();
    let dirs = path_dirs();

    match &spec.launch {
        Launch::Native { names } => {
            // rustup puts a `rust-analyzer` proxy on the PATH even without the component: it
            // only says so when run, so a PATH copy has to answer `--version` to count.
            if let Some(p) = usable_on_path(names, &dirs, true) {
                return Some(ResolvedCommand {
                    program: p,
                    args,
                    source: "path",
                });
            }
            for name in *names {
                let p = managed_bin_dir().join(exe_name(name));
                if p.is_file() {
                    return Some(ResolvedCommand {
                        program: p,
                        args,
                        source: "managed",
                    });
                }
            }
            None
        }
        Launch::Node {
            bin_package,
            bin_name,
            ..
        } => {
            // A Node server can't be asked for its version (`--version` would start it): a
            // PATH one that dies on starting is marked unusable instead (see mark_unusable).
            if let Some(shim) = usable_on_path(&[bin_name], &dirs, false) {
                return Some(ResolvedCommand {
                    program: shim,
                    args,
                    source: "path",
                });
            }
            let servers = managed_servers_dir();
            if !node_package_installed(&servers, bin_package) {
                return None;
            }
            let pkg_dir = servers.join("node_modules").join(bin_package);
            let entry = node_entry(&pkg_dir, bin_name)?;
            let node = node_program()?;
            let mut full = vec![entry.to_string_lossy().to_string()];
            full.extend(args);
            Some(ResolvedCommand {
                program: node,
                args: full,
                source: "managed",
            })
        }
    }
}

fn node_program() -> Option<PathBuf> {
    if let Some(n) = managed_node_program() {
        if n.is_file() {
            return Some(n);
        }
    }
    find_on_path(&["node"])
}

fn node_entry(pkg_dir: &Path, bin_name: &str) -> Option<PathBuf> {
    let pj = std::fs::read_to_string(pkg_dir.join("package.json")).ok()?;
    let v: Value = serde_json::from_str(&pj).ok()?;
    let rel = match v.get("bin")? {
        Value::String(s) => s.clone(),
        Value::Object(map) => map
            .get(bin_name)
            .or_else(|| map.values().next())
            .and_then(|x| x.as_str())
            .map(String::from)?,
        _ => return None,
    };
    let entry = pkg_dir.join(rel.trim_start_matches("./"));
    entry.is_file().then_some(entry)
}

pub struct BinaryLookup {
    pub resolved: Option<PathBuf>,
    pub source: &'static str,
    pub tried: Vec<String>,
}

pub fn lookup(language: &str) -> BinaryLookup {
    match resolve(language) {
        Some(cmd) => BinaryLookup {
            resolved: Some(cmd.program),
            source: cmd.source,
            tried: vec![],
        },
        None => BinaryLookup {
            resolved: None,
            source: "",
            tried: candidate_names(language),
        },
    }
}

fn candidate_names(language: &str) -> Vec<String> {
    match spec_for(language).map(|s| &s.launch) {
        Some(Launch::Native { names }) => names.iter().map(|s| s.to_string()).collect(),
        Some(Launch::Node { bin_name, .. }) => vec![bin_name.to_string()],
        None => vec![],
    }
}

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    candidates(names, &path_dirs()).into_iter().next()
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default()
}

/// Every file on `dirs` that runs as one of `names`, in the order a shell would pick them.
fn candidates(names: &[&str], dirs: &[PathBuf]) -> Vec<PathBuf> {
    let exts = path_exts();
    let mut out = Vec::new();
    for base in names {
        for ext in &exts {
            let fname = format!("{base}{ext}");
            for dir in dirs {
                let cand = dir.join(&fname);
                if cand.is_file() && !out.contains(&cand) {
                    out.push(cand);
                }
            }
        }
    }
    out
}

/// The first candidate that isn't known not to work; with `ask_version`, it also has to answer
/// `--version`.
fn usable_on_path(names: &[&str], dirs: &[PathBuf], ask_version: bool) -> Option<PathBuf> {
    candidates(names, dirs)
        .into_iter()
        .find(|p| !is_unusable(p) && (!ask_version || answers_version(p)))
}

fn unusable() -> &'static Mutex<HashSet<PathBuf>> {
    static U: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    U.get_or_init(Default::default)
}

fn is_unusable(p: &Path) -> bool {
    unusable().lock().map(|u| u.contains(p)).unwrap_or(false)
}

/// A PATH server that died on starting: skipped from now on (this run), so the managed one is
/// used or installed instead.
pub fn mark_unusable(p: &Path) {
    if let Ok(mut u) = unusable().lock() {
        u.insert(p.to_path_buf());
    }
}

const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// Whether `program --version` exits cleanly within a few seconds. Asked once per path.
fn answers_version(program: &Path) -> bool {
    static SEEN: OnceLock<Mutex<HashMap<PathBuf, bool>>> = OnceLock::new();
    let seen = SEEN.get_or_init(Default::default);
    if let Some(ok) = seen.lock().ok().and_then(|s| s.get(program).copied()) {
        return ok;
    }
    let ok = run_version(program);
    if let Ok(mut s) = seen.lock() {
        s.insert(program.to_path_buf(), ok);
    }
    ok
}

fn run_version(program: &Path) -> bool {
    let mut cmd = Command::new(program);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    super::hide_console(&mut cmd);
    let Ok(mut child) = cmd.spawn() else {
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() < VERSION_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(25))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn path_exts() -> Vec<String> {
    if cfg!(windows) {
        let pathext =
            std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        // No bare name: on Windows that's npm's shim for sh (or any file without an extension),
        // which doesn't run as a program.
        let mut exts: Vec<String> = Vec::new();
        for e in pathext.split(';') {
            let e = e.trim();
            if !e.is_empty() {
                exts.push(e.to_ascii_lowercase());
            }
        }
        exts
    } else {
        vec![String::new()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nyxs-lsp-disc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A script named `name` that exits with `code` (a `.cmd` on Windows).
    fn script(dir: &Path, name: &str, code: i32) -> PathBuf {
        if cfg!(windows) {
            let p = dir.join(format!("{name}.cmd"));
            std::fs::write(&p, format!("@echo off\r\nexit /b {code}\r\n")).unwrap();
            p
        } else {
            let p = dir.join(name);
            std::fs::write(&p, format!("#!/bin/sh\nexit {code}\n")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            p
        }
    }

    #[test]
    fn a_path_binary_that_fails_its_version_check_is_skipped() {
        let broken = temp_dir("broken");
        let good = temp_dir("good");
        script(&broken, "rust-analyzer", 1);
        let working = script(&good, "rust-analyzer", 0);
        let dirs = vec![broken.clone(), good.clone()];
        let picked = usable_on_path(&["rust-analyzer"], &dirs, true);
        let only_broken = usable_on_path(&["rust-analyzer"], &dirs[..1], true);
        let _ = std::fs::remove_dir_all(&broken);
        let _ = std::fs::remove_dir_all(&good);
        assert_eq!(picked, Some(working));
        assert_eq!(only_broken, None);
    }

    #[cfg(windows)]
    #[test]
    fn a_file_without_extension_isnt_a_windows_program() {
        let dir = temp_dir("bare");
        // What npm puts next to the .cmd: a sh script Windows can't run.
        std::fs::write(dir.join("typescript-language-server"), "#!/bin/sh\n").unwrap();
        let bare = candidates(&["typescript-language-server"], std::slice::from_ref(&dir));
        let cmd = script(&dir, "typescript-language-server", 0);
        let with_cmd = candidates(&["typescript-language-server"], std::slice::from_ref(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(bare.is_empty());
        assert_eq!(with_cmd, vec![cmd]);
    }

    #[test]
    fn a_path_server_that_died_on_starting_isnt_picked_again() {
        let dir = temp_dir("died");
        let shim = script(&dir, "yaml-language-server", 0);
        let dirs = vec![dir.clone()];
        let before = usable_on_path(&["yaml-language-server"], &dirs, false);
        mark_unusable(&shim);
        let after = usable_on_path(&["yaml-language-server"], &dirs, false);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(before, Some(shim));
        assert_eq!(after, None);
    }
}
