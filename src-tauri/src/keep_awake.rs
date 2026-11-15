//! "Keep the computer awake": stops the system from going to sleep while Nyxs works, until it
//! is switched off or the app quits. Nothing is saved, so every run starts with it off.

use std::sync::Mutex;

static GUARD: Mutex<Option<Guard>> = Mutex::new(None);

/// Windows: a thread of its own holds the request, since `SetThreadExecutionState` belongs to
/// the thread that set it. Dropping the sender lets that thread clear it and end.
#[cfg(windows)]
struct Guard(#[allow(dead_code)] std::sync::mpsc::Sender<()>);

#[cfg(windows)]
impl Guard {
    fn acquire() -> Result<Self, String> {
        use windows_sys::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
        };
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<bool>();
        std::thread::Builder::new()
            .name("nyxs-keep-awake".into())
            .spawn(move || {
                // SAFETY: plain Win32 calls with constant flags.
                let ok =
                    unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) } != 0;
                let _ = ready_tx.send(ok);
                if ok {
                    let _ = stop_rx.recv();
                    unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
                }
            })
            .map_err(|e| e.to_string())?;
        if ready_rx.recv().unwrap_or(false) {
            Ok(Guard(stop_tx))
        } else {
            Err("Windows didn't accept the request to stay awake.".into())
        }
    }
}

/// macOS and Linux: a helper process holds the request, and ends on its own with Nyxs.
#[cfg(not(windows))]
struct Guard(std::process::Child);

#[cfg(not(windows))]
impl Guard {
    fn acquire() -> Result<Self, String> {
        let pid = std::process::id().to_string();
        #[cfg(target_os = "macos")]
        let child = std::process::Command::new("caffeinate")
            .args(["-i", "-w", &pid])
            .spawn();
        #[cfg(not(target_os = "macos"))]
        let child = std::process::Command::new("systemd-inhibit")
            .args([
                "--what=idle:sleep",
                "--who=Nyxs",
                "--why=Keep the computer awake",
                "tail",
                "--pid",
                &pid,
                "-f",
                "/dev/null",
            ])
            .spawn();
        child
            .map(Guard)
            .map_err(|e| format!("Couldn't keep the computer awake: {e}"))
    }
}

#[cfg(not(windows))]
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Turns it on or off and returns whether it is on now.
#[tauri::command]
pub fn keep_awake_set(on: bool) -> Result<bool, String> {
    let mut guard = GUARD.lock().unwrap_or_else(|e| e.into_inner());
    if !on {
        *guard = None;
        return Ok(false);
    }
    if guard.is_none() {
        *guard = Some(Guard::acquire()?);
    }
    Ok(true)
}

#[tauri::command]
pub fn keep_awake_get() -> bool {
    GUARD.lock().unwrap_or_else(|e| e.into_inner()).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_on_and_off() {
        assert!(!keep_awake_get());
        assert_eq!(keep_awake_set(true), Ok(true));
        assert_eq!(keep_awake_set(true), Ok(true));
        assert!(keep_awake_get());
        assert_eq!(keep_awake_set(false), Ok(false));
        assert!(!keep_awake_get());
    }
}
