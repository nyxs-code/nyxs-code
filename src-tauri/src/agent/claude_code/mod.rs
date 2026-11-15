//! Claude Code as a provider. Everything public is re-exported here, so `agent::<name>` keeps
//! working, including the hidden `__cmd__*` items `#[tauri::command]` generates for
//! `generate_handler!`.

mod args;
mod install;
mod probe;
mod remote;
mod runs;
mod sink;
mod task_output;

pub use install::*;
pub(crate) use install::{locate_claude, open_terminal};
pub(crate) use probe::with_login_refresh_held;
pub use probe::*;
pub use remote::*;
pub use runs::*;
pub use task_output::*;
