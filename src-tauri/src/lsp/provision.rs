use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};

use super::discovery::{spec_for, Launch};

pub type Report<'a> = dyn Fn(&str, u64, u64, &str) + 'a;

const NODE_VERSION: &str = "v22.22.3";

fn root_cell() -> &'static Mutex<Option<PathBuf>> {
    static C: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

pub fn set_managed_root(path: PathBuf) {
    if let Ok(mut g) = root_cell().lock() {
        *g = Some(path);
    }
}

pub fn managed_root() -> PathBuf {
    if let Ok(g) = root_cell().lock() {
        if let Some(p) = g.clone() {
            return p;
        }
    }
    std::env::temp_dir().join("nyxs").join("lsp")
}

pub fn managed_node_dir() -> PathBuf {
    managed_root().join("node")
}

pub fn managed_servers_dir() -> PathBuf {
    managed_root().join("servers")
}

pub fn managed_bin_dir() -> PathBuf {
    managed_root().join("bin")
}

pub fn managed_node_program() -> Option<PathBuf> {
    node_program_at(&managed_root())
}

/// The Node under `root`, unless an install of it there was cut short (its marker is left).
fn node_program_at(root: &Path) -> Option<PathBuf> {
    if root.join(NODE_INSTALLING).exists() {
        return None;
    }
    let dir = root.join("node");
    let p = if cfg!(windows) {
        dir.join("node.exe")
    } else {
        dir.join("bin").join("node")
    };
    p.is_file().then_some(p)
}

/// Left in the managed root while Node is being put in place, removed once it's complete.
const NODE_INSTALLING: &str = ".node-installing";

fn package_marker(servers: &Path, package: &str) -> PathBuf {
    servers.join(format!(".installing-{package}"))
}

/// Whether npm finished installing `package` under `servers`: its folder is there and no
/// install of it was cut short (npm's folder appears long before it's complete).
pub fn node_package_installed(servers: &Path, package: &str) -> bool {
    servers.join("node_modules").join(package).is_dir()
        && !package_marker(servers, package).exists()
}

/// Installs one at a time: two at once (the first Edit of two languages, a retry) wrote the
/// same download and extraction folders.
fn install_lock() -> &'static Mutex<()> {
    static L: Mutex<()> = Mutex::new(());
    &L
}

/// Writes `dest` through `write` on a `.partial` file renamed over it at the end, so a cut
/// install never leaves a file that counts as installed.
fn place_atomically(
    dest: &Path,
    write: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let partial = dest.with_file_name(format!("{name}.partial"));
    let _ = fs::remove_file(&partial);
    let result = write(&partial).and_then(|()| {
        fs::rename(&partial, dest).map_err(|e| format!("Couldn't put {dest:?} in place: {e}"))
    });
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

fn managed_npm_cli() -> PathBuf {
    let dir = managed_node_dir();
    if cfg!(windows) {
        dir.join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js")
    } else {
        dir.join("lib")
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js")
    }
}

enum Archive {
    Gz,
    Zip,
    TarGz,
}

fn node_target() -> Option<(&'static str, Archive)> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return None,
    };
    match std::env::consts::OS {
        "windows" => Some((leak(format!("win-{arch}")), Archive::Zip)),
        "linux" => Some((leak(format!("linux-{arch}")), Archive::TarGz)),
        "macos" => Some((leak(format!("darwin-{arch}")), Archive::TarGz)),
        _ => None,
    }
}

fn node_url() -> Option<(String, Archive)> {
    let (target, archive) = node_target()?;
    let ext = match archive {
        Archive::Zip => "zip",
        _ => "tar.gz",
    };
    let url = format!("https://nodejs.org/dist/{NODE_VERSION}/node-{NODE_VERSION}-{target}.{ext}");
    Some((url, archive))
}

fn rust_analyzer_url() -> Option<(String, Archive)> {
    let arch = std::env::consts::ARCH;
    let (triple, archive) = match std::env::consts::OS {
        "windows" => (format!("{arch}-pc-windows-msvc"), Archive::Zip),
        "linux" => (format!("{arch}-unknown-linux-gnu"), Archive::Gz),
        "macos" => (format!("{arch}-apple-darwin"), Archive::Gz),
        _ => return None,
    };
    let ext = match archive {
        Archive::Zip => "zip",
        _ => "gz",
    };
    let url = format!(
        "https://github.com/rust-lang/rust-analyzer/releases/latest/download/rust-analyzer-{triple}.{ext}"
    );
    Some((url, archive))
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn download(report: &Report, url: &str, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {parent:?}: {e}"))?;
    }
    let client = reqwest::blocking::Client::builder()
        .user_agent("nyxs-lsp-provisioner")
        .build()
        .map_err(|e| format!("Couldn't create the HTTP client: {e}"))?;
    let mut resp = client
        .get(url)
        .send()
        .map_err(|e| format!("Network error downloading {url}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Download rejected ({url}): {e}"))?;

    let total = resp.content_length().unwrap_or(0);
    let mut file = File::create(dest).map_err(|e| format!("Couldn't create {dest:?}: {e}"))?;
    let mut buf = [0u8; 65536];
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    report("downloading", 0, total, "Downloading…");
    loop {
        let n = resp
            .read(&mut buf)
            .map_err(|e| format!("Couldn't read the download: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("Couldn't write {dest:?}: {e}"))?;
        received += n as u64;
        if received - last_emit >= 512 * 1024 {
            last_emit = received;
            report("downloading", received, total, "Downloading…");
        }
    }
    report("downloading", received, total, "Download complete");
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        hex.push_str(&format!("{b:02x}"));
    }
    Ok(hex)
}

fn fetch_text(url: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("nyxs-lsp-provisioner")
        .build()
        .map_err(|e| e.to_string())?;
    client
        .get(url)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .map_err(|e| e.to_string())
}

fn verify_node_checksum(file: &Path, archive_url: &str) -> Result<(), String> {
    let filename = archive_url.rsplit('/').next().unwrap_or_default();
    let sums_url = format!("https://nodejs.org/dist/{NODE_VERSION}/SHASUMS256.txt");
    check_node_sum(file, filename, fetch_text(&sums_url))
}

/// Node runs every managed server: one whose download can't be checked isn't installed.
fn check_node_sum(file: &Path, filename: &str, sums: Result<String, String>) -> Result<(), String> {
    let text = sums.map_err(|e| {
        format!("Couldn't check the Node download: its checksums didn't download ({e})")
    })?;
    let expected = text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?;
        (name == filename).then(|| hash.to_string())
    });
    let Some(expected) = expected else {
        return Err(format!(
            "Couldn't check the Node download: {filename} isn't in its checksums"
        ));
    };
    let actual = sha256_file(file)?;
    if actual.eq_ignore_ascii_case(&expected) {
        Ok(())
    } else {
        Err(format!(
            "Node checksum mismatch for {filename}: expected {expected}, got {actual}"
        ))
    }
}

fn extract_gz(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let f = File::open(src).map_err(|e| e.to_string())?;
    let mut gz = GzDecoder::new(f);
    let mut out = File::create(dest).map_err(|e| e.to_string())?;
    std::io::copy(&mut gz, &mut out).map_err(|e| format!("Couldn't decompress .gz: {e}"))?;
    Ok(())
}

fn extract_zip(src: &Path, dest_dir: &Path) -> Result<(), String> {
    let f = File::open(src).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("Invalid zip: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out_path = dest_dir.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn extract_tar_gz(src: &Path, dest_dir: &Path) -> Result<(), String> {
    let f = File::open(src).map_err(|e| e.to_string())?;
    let gz = GzDecoder::new(f);
    let mut ar = tar::Archive::new(gz);
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    ar.unpack(dest_dir)
        .map_err(|e| format!("Couldn't extract tar.gz: {e}"))?;
    Ok(())
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = fs::set_permissions(path, perms);
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

pub fn provision(language: &str, report: &Report) -> Result<(), String> {
    let spec = spec_for(language).ok_or_else(|| format!("LSP_UNSUPPORTED:{language}"))?;
    let _installing = install_lock().lock().unwrap_or_else(|e| e.into_inner());
    match &spec.launch {
        Launch::Native { names } => {
            provision_native(report, names.first().copied().unwrap_or(language))
        }
        Launch::Node {
            npm_packages,
            bin_package,
            ..
        } => provision_node_server(report, npm_packages, bin_package),
    }
}

fn provision_native(report: &Report, bin_name: &str) -> Result<(), String> {
    let dest = managed_bin_dir().join(if cfg!(windows) {
        format!("{bin_name}.exe")
    } else {
        bin_name.to_string()
    });
    if dest.is_file() {
        return Ok(());
    }
    let (url, archive) =
        rust_analyzer_url().ok_or_else(|| "Unsupported platform for rust-analyzer".to_string())?;

    let tmp = managed_root().join(".tmp");
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let dl = tmp.join("rust-analyzer-download");
    download(report, &url, &dl)?;

    report("extracting", 0, 0, "Extracting…");
    fs::create_dir_all(managed_bin_dir()).map_err(|e| e.to_string())?;
    place_atomically(&dest, |partial| {
        match archive {
            Archive::Gz => extract_gz(&dl, partial)?,
            Archive::Zip => {
                let exdir = tmp.join("ra-zip");
                let _ = fs::remove_dir_all(&exdir);
                extract_zip(&dl, &exdir)?;
                let found = find_file(&exdir, &format!("{bin_name}.exe"))
                    .ok_or_else(|| "Couldn't find rust-analyzer.exe in the zip".to_string())?;
                fs::copy(&found, partial).map_err(|e| e.to_string())?;
                let _ = fs::remove_dir_all(&exdir);
            }
            Archive::TarGz => return Err("rust-analyzer isn't distributed as tar.gz".to_string()),
        }
        make_executable(partial);
        Ok(())
    })?;
    let _ = fs::remove_file(&dl);
    Ok(())
}

fn provision_node_server(
    report: &Report,
    npm_packages: &[&str],
    bin_package: &str,
) -> Result<(), String> {
    ensure_node(report)?;

    let servers = managed_servers_dir();
    let pkg_dir = servers.join("node_modules").join(bin_package);
    if node_package_installed(&servers, bin_package) {
        return Ok(());
    }
    fs::create_dir_all(&servers).map_err(|e| e.to_string())?;
    let marker = package_marker(&servers, bin_package);
    fs::write(&marker, "").map_err(|e| format!("Couldn't start the install: {e}"))?;

    let node = managed_node_program()
        .ok_or_else(|| "Managed Node isn't available after installation".to_string())?;
    let npm_cli = managed_npm_cli();
    if !npm_cli.is_file() {
        return Err(format!("Couldn't find npm-cli.js at {npm_cli:?}"));
    }

    report("installing", 0, 0, "Installing server (npm)…");

    let mut cmd = std::process::Command::new(&node);
    cmd.arg(&npm_cli)
        .arg("install")
        .arg("--prefix")
        .arg(&servers)
        .arg("--no-audit")
        .arg("--no-fund")
        .arg("--loglevel=error")
        .args(npm_packages)
        .current_dir(&servers)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(node_dir) = node.parent() {
        prepend_path(&mut cmd, node_dir);
    }
    super::hide_console(&mut cmd);

    let out = cmd.output().map_err(|e| format!("Couldn't run npm: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "npm install failed (exit code {:?}): {}",
            out.status.code(),
            stderr.trim()
        ));
    }
    if !pkg_dir.is_dir() {
        return Err(format!(
            "npm finished but the package {bin_package} wasn't found"
        ));
    }
    fs::remove_file(&marker).map_err(|e| format!("Couldn't finish the install: {e}"))
}

fn ensure_node(report: &Report) -> Result<(), String> {
    if managed_node_program().is_some() {
        return Ok(());
    }
    let (url, archive) = node_url().ok_or_else(|| "Unsupported platform for Node".to_string())?;

    let tmp = managed_root().join(".tmp");
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let dl = tmp.join("node-download");
    download(report, &url, &dl)?;

    report("verifying", 0, 0, "Verifying integrity…");
    verify_node_checksum(&dl, &url)?;

    report("extracting", 0, 0, "Extracting Node…");
    let exdir = tmp.join("node-extract");
    let _ = fs::remove_dir_all(&exdir);
    fs::create_dir_all(&exdir).map_err(|e| e.to_string())?;
    match archive {
        Archive::Zip => extract_zip(&dl, &exdir)?,
        Archive::TarGz => extract_tar_gz(&dl, &exdir)?,
        Archive::Gz => return Err("Node isn't distributed as .gz".to_string()),
    }

    let inner = single_subdir(&exdir)
        .ok_or_else(|| "Unexpected structure in the Node archive".to_string())?;
    // From here until it's complete, a cut install leaves this marker and no usable Node.
    let marker = managed_root().join(NODE_INSTALLING);
    fs::write(&marker, "").map_err(|e| format!("Couldn't start installing Node: {e}"))?;
    let node_dir = managed_node_dir();
    let _ = fs::remove_dir_all(&node_dir);
    if let Some(parent) = node_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if fs::rename(&inner, &node_dir).is_err() {
        copy_dir_all(&inner, &node_dir)?;
    }
    make_executable(&managed_node_dir().join(if cfg!(windows) {
        "node.exe"
    } else {
        "bin/node"
    }));

    let _ = fs::remove_file(&dl);
    let _ = fs::remove_dir_all(&exdir);
    fs::remove_file(&marker).map_err(|e| format!("Couldn't finish installing Node: {e}"))?;

    managed_node_program()
        .map(|_| ())
        .ok_or_else(|| "Node isn't usable after extraction".to_string())
}

fn single_subdir(dir: &Path) -> Option<PathBuf> {
    let mut found: Option<PathBuf> = None;
    for entry in fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        if entry.file_type().ok()?.is_dir() {
            if found.is_some() {
                return None;
            }
            found = Some(entry.path());
        }
    }
    found
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(f) = find_file(&path, name) {
                return Some(f);
            }
        } else if entry.file_name().to_string_lossy() == name {
            return Some(path);
        }
    }
    None
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn prepend_path(cmd: &mut std::process::Command, dir: &Path) {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let current = std::env::var("PATH").unwrap_or_default();
    cmd.env("PATH", format!("{}{}{}", dir.display(), sep, current));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nyxs-lsp-prov-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_cut_npm_install_doesnt_count_as_installed() {
        let servers = temp_dir("npm");
        fs::create_dir_all(servers.join("node_modules").join("pyright")).unwrap();
        let legacy = node_package_installed(&servers, "pyright");
        fs::write(package_marker(&servers, "pyright"), "").unwrap();
        let cut = node_package_installed(&servers, "pyright");
        let _ = fs::remove_dir_all(&servers);
        assert!(legacy, "an install from before the marker still counts");
        assert!(!cut);
    }

    #[test]
    fn a_cut_node_install_leaves_no_usable_node() {
        let root = temp_dir("node");
        let exe = if cfg!(windows) {
            root.join("node").join("node.exe")
        } else {
            root.join("node").join("bin").join("node")
        };
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, "").unwrap();
        let complete = node_program_at(&root);
        fs::write(root.join(NODE_INSTALLING), "").unwrap();
        let cut = node_program_at(&root);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(complete, Some(exe));
        assert_eq!(cut, None);
    }

    #[test]
    fn a_failed_extraction_leaves_no_binary() {
        let dir = temp_dir("atomic");
        let dest = dir.join("rust-analyzer.exe");
        let failed = place_atomically(&dest, |partial| {
            fs::write(partial, "half").unwrap();
            Err("the archive ended early".into())
        });
        let after_fail = (
            dest.exists(),
            dir.join("rust-analyzer.exe.partial").exists(),
        );
        let ok = place_atomically(&dest, |partial| {
            fs::write(partial, "whole").map_err(|e| e.to_string())
        });
        let content = fs::read_to_string(&dest).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert!(failed.is_err());
        assert_eq!(after_fail, (false, false));
        assert!(ok.is_ok());
        assert_eq!(content, "whole");
    }

    #[test]
    fn node_isnt_installed_without_checking_its_download() {
        let dir = temp_dir("sum");
        let file = dir.join("node.zip");
        fs::write(&file, "node").unwrap();
        let sum = sha256_file(&file).unwrap();
        let name = "node-v22-win-x64.zip";
        let unreachable = check_node_sum(&file, name, Err("offline".into()));
        let unlisted = check_node_sum(&file, name, Ok(format!("{sum}  other.zip\n")));
        let wrong = check_node_sum(&file, name, Ok(format!("{}  {name}\n", "0".repeat(64))));
        let right = check_node_sum(&file, name, Ok(format!("{sum}  {name}\n")));
        let _ = fs::remove_dir_all(&dir);
        assert!(unreachable.is_err());
        assert!(unlisted.is_err());
        assert!(wrong.is_err());
        assert!(right.is_ok());
    }

    #[test]
    fn installs_run_one_at_a_time() {
        let busy = Arc::new(AtomicBool::new(false));
        let overlapped = Arc::new(AtomicBool::new(false));
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let (busy, overlapped) = (busy.clone(), overlapped.clone());
                std::thread::spawn(move || {
                    let _held = install_lock().lock().unwrap_or_else(|e| e.into_inner());
                    if busy.swap(true, Ordering::SeqCst) {
                        overlapped.store(true, Ordering::SeqCst);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    busy.store(false, Ordering::SeqCst);
                })
            })
            .collect();
        for w in workers {
            w.join().unwrap();
        }
        assert!(!overlapped.load(Ordering::SeqCst));
    }
}
