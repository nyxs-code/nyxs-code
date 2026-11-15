//! What the OS must allow before the Computer tool can work, for Settings to show and request.
//! On macOS computer use needs Accessibility (to read windows' controls, post input and catch
//! the user's Esc) and Screen Recording (to take screenshots); Windows needs neither.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerPermissions {
    /// "windows", "macos" or "linux".
    pub platform: &'static str,
    /// Whether the Computer tool works on this OS at all.
    pub supported: bool,
    pub accessibility: bool,
    pub screen_recording: bool,
}

/// Which permissions the Computer tool has right now. Only checks: it never shows a prompt.
#[tauri::command]
pub fn computer_permissions() -> ComputerPermissions {
    imp::permissions()
}

/// Asks for one permission ("accessibility" or "screenRecording"): shows the system prompt and
/// opens its pane in System Settings, where the user switches Nyxs on. A no-op off macOS.
#[tauri::command]
pub fn computer_request_permission(kind: String) -> Result<(), String> {
    match kind.as_str() {
        "accessibility" | "screenRecording" => imp::request(&kind),
        other => Err(format!("Unknown computer-use permission: {other}")),
    }
}

/// Refuses computer use where the OS can't do it: macOS older than 14, with a reason the agent
/// can pass on. Every Computer command checks this first.
pub fn ensure_supported() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if !imp::os_supported() {
        return Err("Computer use needs macOS 14 (Sonoma) or later. Tell the user it can't work on this Mac.".into());
    }
    Ok(())
}

#[cfg(windows)]
mod imp {
    pub fn permissions() -> super::ComputerPermissions {
        super::ComputerPermissions {
            platform: "windows",
            supported: true,
            accessibility: true,
            screen_recording: true,
        }
    }

    pub fn request(_kind: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    pub fn permissions() -> super::ComputerPermissions {
        super::ComputerPermissions {
            platform: "linux",
            supported: false,
            accessibility: false,
            screen_recording: false,
        }
    }

    pub fn request(_kind: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2_application_services::{
        kAXTrustedCheckOptionPrompt, AXIsProcessTrusted, AXIsProcessTrustedWithOptions,
    };
    use objc2_core_foundation::{kCFBooleanTrue, CFBoolean, CFDictionary, CFString};
    use objc2_core_graphics::{CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess};
    use objc2_foundation::{NSOperatingSystemVersion, NSProcessInfo};

    /// Screenshots go through ScreenCaptureKit's SCScreenshotManager, which only exists from
    /// macOS 14. The webview can't tell (WKWebView always reports 10_15_7), so this is the check.
    pub fn os_supported() -> bool {
        NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(NSOperatingSystemVersion {
            majorVersion: 14,
            minorVersion: 0,
            patchVersion: 0,
        })
    }

    pub fn permissions() -> super::ComputerPermissions {
        super::ComputerPermissions {
            platform: "macos",
            supported: os_supported(),
            accessibility: unsafe { AXIsProcessTrusted() },
            screen_recording: CGPreflightScreenCaptureAccess(),
        }
    }

    pub fn request(kind: &str) -> Result<(), String> {
        let pane = if kind == "accessibility" {
            // Registers Nyxs in the Accessibility list and shows the system's prompt once.
            let key: &CFString = unsafe { kAXTrustedCheckOptionPrompt };
            if let Some(yes) = unsafe { kCFBooleanTrue } {
                let options = CFDictionary::<CFString, CFBoolean>::from_slices(&[key], &[yes]);
                unsafe { AXIsProcessTrustedWithOptions(Some(options.as_opaque())) };
            }
            "Privacy_Accessibility"
        } else {
            // Adds Nyxs to the Screen Recording list; the grant only takes effect after a
            // relaunch, which macOS offers itself.
            CGRequestScreenCaptureAccess();
            "Privacy_ScreenCapture"
        };
        // The prompt alone is easy to dismiss: open the pane so the switch is right there.
        std::process::Command::new("open")
            .arg(format!(
                "x-apple.systempreferences:com.apple.preference.security?{pane}"
            ))
            .spawn()
            .map(|mut child| {
                // Reaped off this thread so the finished `open` doesn't linger as a zombie.
                std::thread::spawn(move || child.wait());
            })
            .map_err(|e| format!("Couldn't open System Settings: {e}"))
    }
}
