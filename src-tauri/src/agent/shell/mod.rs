//! The agent's shell: login environment, running commands, background shells and waiting
//! for dev servers. Everything public is re-exported here, so `agent::shell::<name>` (and
//! `agent::<name>` through `agent::*`) keeps working, including the hidden `__cmd__*` items
//! `#[tauri::command]` generates for `generate_handler!`.

mod background;
mod capture;
mod env;
#[cfg(target_os = "windows")]
mod host;
mod port_owner;
mod run;
mod server_wait;

pub use background::*;
pub(crate) use capture::*;
pub use env::*;
pub use port_owner::*;
pub use run::*;
pub use server_wait::*;

/// Fixtures shared by the tests of several submodules.
#[cfg(test)]
mod test_support {
    use std::sync::{Mutex, RwLock, RwLockReadGuard};

    #[cfg(target_os = "windows")]
    pub(super) const SLOW: &str = "Write-Output started; Start-Sleep -Seconds 30";
    #[cfg(not(target_os = "windows"))]
    pub(super) const SLOW: &str = "echo started; sleep 30";

    static HOST_USERS: Mutex<usize> = Mutex::new(0);
    /// `bg_shutdown_all` kills every host, so the test that calls it waits for exclusive use.
    pub(super) static HOSTS: RwLock<()> = RwLock::new(());

    /// Commands share pooled PowerShell hosts; the last test still using them closes the
    /// pool so none outlives the test binary.
    pub(super) struct HostUser {
        _shared: RwLockReadGuard<'static, ()>,
    }

    impl HostUser {
        pub(super) fn enter() -> Self {
            let shared = HOSTS.read().unwrap_or_else(|e| e.into_inner());
            *HOST_USERS.lock().unwrap_or_else(|e| e.into_inner()) += 1;
            HostUser { _shared: shared }
        }
    }

    impl Drop for HostUser {
        fn drop(&mut self) {
            let mut users = HOST_USERS.lock().unwrap_or_else(|e| e.into_inner());
            *users -= 1;
            #[cfg(target_os = "windows")]
            if *users == 0 {
                crate::agent::ps_host::close_idle();
            }
        }
    }
}
