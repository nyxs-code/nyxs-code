use serde::Serialize;

#[derive(Serialize, Default)]
pub struct DeviceInfo {
    platform: String,
    os: String,
    os_version: String,
    os_build: String,
    arch: String,
    hwid: String,
    cpu: String,
    cpu_cores: String,
    total_memory: String,
    hostname: String,
}

#[tauri::command(async)]
pub fn device_info() -> DeviceInfo {
    let mut d = DeviceInfo {
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        ..Default::default()
    };
    if let Ok(n) = std::thread::available_parallelism() {
        d.cpu_cores = n.get().to_string();
    }

    #[cfg(windows)]
    windows_info(&mut d);
    #[cfg(target_os = "macos")]
    macos_info(&mut d);
    #[cfg(target_os = "linux")]
    linux_info(&mut d);

    d.hwid = hash_machine_id(&d.hwid);
    d
}

/// What leaves the machine instead of its id (MachineGuid, IOPlatformUUID, machine-id): a hash
/// salted with the app's own string. It still tells one machine from another, but it can't be
/// matched with what other software sends, nor turned back into the id.
fn hash_machine_id(id: &str) -> String {
    use sha2::{Digest, Sha256};
    if id.is_empty() {
        return String::new();
    }
    let mut h = Sha256::new();
    h.update(b"com.nyxs.desktop/device-id/v1:");
    h.update(id.as_bytes());
    format!("{:x}", h.finalize())
}

#[cfg_attr(
    not(any(windows, target_os = "macos", target_os = "linux")),
    allow(dead_code)
)]
fn human_gb(bytes: u64) -> String {
    if bytes == 0 {
        return String::new();
    }
    let gb = (bytes as f64) / (1024.0 * 1024.0 * 1024.0);
    format!("{} GB", gb.round() as u64)
}

#[cfg(windows)]
fn windows_info(d: &mut DeviceInfo) {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);

    if let Ok(cv) = hklm.open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion") {
        let product: String = cv.get_value("ProductName").unwrap_or_default();
        let display: String = cv.get_value("DisplayVersion").unwrap_or_default();
        let build: String = cv.get_value("CurrentBuildNumber").unwrap_or_default();
        let ubr: u32 = cv.get_value("UBR").unwrap_or(0);
        let build_num: u32 = build.parse().unwrap_or(0);

        let mut name = product;
        if build_num >= 22000 {
            name = name.replacen("Windows 10", "Windows 11", 1);
        }
        if !display.is_empty() {
            name = format!("{name} ({display})");
        }
        d.os = name;
        d.os_build = if ubr > 0 {
            format!("{build}.{ubr}")
        } else {
            build.clone()
        };
        d.os_version = if ubr > 0 {
            format!("10.0.{build}.{ubr}")
        } else {
            format!("10.0.{build}")
        };
    }

    if let Ok(crypto) = hklm.open_subkey(r"SOFTWARE\Microsoft\Cryptography") {
        if let Ok(guid) = crypto.get_value::<String, _>("MachineGuid") {
            d.hwid = guid;
        }
    }

    if let Ok(cpu) = hklm.open_subkey(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") {
        if let Ok(name) = cpu.get_value::<String, _>("ProcessorNameString") {
            d.cpu = name.trim().to_string();
        }
    }

    let mem = windows_total_memory();
    if mem > 0 {
        d.total_memory = human_gb(mem);
    }

    if let Ok(h) = std::env::var("COMPUTERNAME") {
        d.hostname = h;
    }
}

#[cfg(windows)]
fn windows_total_memory() -> u64 {
    #[repr(C)]
    struct MemoryStatusEx {
        dw_length: u32,
        dw_memory_load: u32,
        ull_total_phys: u64,
        ull_avail_phys: u64,
        ull_total_page_file: u64,
        ull_avail_page_file: u64,
        ull_total_virtual: u64,
        ull_avail_virtual: u64,
        ull_avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }
    let mut status = MemoryStatusEx {
        dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    unsafe {
        if GlobalMemoryStatusEx(&mut status) != 0 {
            status.ull_total_phys
        } else {
            0
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_info(d: &mut DeviceInfo) {
    use std::process::Command;

    let run = |cmd: &str, args: &[&str]| -> String {
        Command::new(cmd)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };

    let name = run("sw_vers", &["-productName"]);
    let ver = run("sw_vers", &["-productVersion"]);
    d.os_build = run("sw_vers", &["-buildVersion"]);
    d.os = if name.is_empty() {
        "macOS".into()
    } else {
        format!("{name} {ver}").trim().to_string()
    };
    d.os_version = ver;

    d.cpu = run("sysctl", &["-n", "machdep.cpu.brand_string"]);
    if let Ok(bytes) = run("sysctl", &["-n", "hw.memsize"]).parse::<u64>() {
        d.total_memory = human_gb(bytes);
    }
    d.hostname = run("scutil", &["--get", "ComputerName"]);
    if d.hostname.is_empty() {
        d.hostname = run("hostname", &[]);
    }

    let ioreg = run("ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"]);
    for line in ioreg.lines() {
        if line.contains("IOPlatformUUID") {
            if let Some(rest) = line.split("= \"").nth(1) {
                if let Some(end) = rest.find('"') {
                    d.hwid = rest[..end].to_string();
                }
            }
            break;
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_info(d: &mut DeviceInfo) {
    use std::fs;
    use std::process::Command;

    if let Ok(txt) = fs::read_to_string("/etc/os-release") {
        let mut pretty = String::new();
        let mut version = String::new();
        for line in txt.lines() {
            if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
                pretty = v.trim_matches('"').to_string();
            } else if let Some(v) = line.strip_prefix("VERSION_ID=") {
                version = v.trim_matches('"').to_string();
            }
        }
        d.os = pretty;
        d.os_version = version;
    }

    if let Ok(o) = Command::new("uname").arg("-r").output() {
        if o.status.success() {
            d.os_build = String::from_utf8_lossy(&o.stdout).trim().to_string();
        }
    }

    for p in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(id) = fs::read_to_string(p) {
            let id = id.trim();
            if !id.is_empty() {
                d.hwid = id.to_string();
                break;
            }
        }
    }

    if let Ok(txt) = fs::read_to_string("/proc/cpuinfo") {
        for line in txt.lines() {
            if let Some(v) = line.strip_prefix("model name") {
                if let Some(idx) = v.find(':') {
                    d.cpu = v[idx + 1..].trim().to_string();
                    break;
                }
            }
        }
    }

    if let Ok(txt) = fs::read_to_string("/proc/meminfo") {
        for line in txt.lines() {
            if let Some(v) = line.strip_prefix("MemTotal:") {
                if let Some(kb) = v
                    .split_whitespace()
                    .next()
                    .and_then(|n| n.parse::<u64>().ok())
                {
                    d.total_memory = human_gb(kb * 1024);
                }
                break;
            }
        }
    }

    if let Ok(h) = fs::read_to_string("/etc/hostname") {
        d.hostname = h.trim().to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_a_salted_hash_of_the_machine_id_not_the_id() {
        let raw = "4c4c4544-0042-3510-8052-b4c04f4e3132";
        let id = hash_machine_id(raw);
        assert_eq!(id.len(), 64);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!id.contains("4c4c4544"));
        // The same machine keeps its id, and another gets a different one.
        assert_eq!(hash_machine_id(raw), id);
        assert_ne!(hash_machine_id("another-machine"), id);
        // A bare SHA-256 of the id would be found by anyone hashing known ids.
        use sha2::{Digest, Sha256};
        assert_ne!(id, format!("{:x}", Sha256::digest(raw.as_bytes())));
        assert_eq!(hash_machine_id(""), "");
    }
}
