use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn set_noninteractive_env(cmd: &mut Command) {
    cmd.env("CI", "1");
    cmd.env("NEXT_TELEMETRY_DISABLED", "1");
    cmd.env("npm_config_yes", "true");
    cmd.env("NPM_CONFIG_YES", "true");
    cmd.env("ADBLOCK", "1");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("PIP_NO_INPUT", "1");
    cmd.env("DEBIAN_FRONTEND", "noninteractive");
}

fn safe_component(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "_".to_string()
    } else {
        cleaned
    }
}

const MAX_READ_SIZE: u64 = 20 * 1024 * 1024;
const MAX_WRITE_SIZE: usize = 20 * 1024 * 1024;

const IMAGE_MAX_READ_BYTES: u64 = 10 * 1024 * 1024;

static CURRENT_ACCOUNT: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn account_slot() -> &'static Mutex<Option<String>> {
    CURRENT_ACCOUNT.get_or_init(|| Mutex::new(None))
}

pub(crate) fn current_account() -> Option<String> {
    account_slot().lock().ok().and_then(|g| g.clone())
}

fn sanitize_account_id(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect()
}

fn account_scoped(base: PathBuf) -> PathBuf {
    match current_account() {
        Some(uid) => base.join("accounts").join(uid),
        None => base,
    }
}
fn home_dir() -> Result<PathBuf, String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .map_err(|_| "Couldn't determine the user's home directory".to_string())
}

mod files;
mod fuzzy_edit;
#[cfg(windows)]
mod job;
mod scope;
pub(crate) mod text_io;
#[cfg(windows)]
pub use job::detach_helper_main;
mod account;
mod agent_cli;
mod attachments;
mod claude_code;
mod cli_accounts;
mod cli_install;
pub(crate) mod cli_process;
mod file_history;
#[cfg(windows)]
mod host_pipe;
mod managed_dirs;
mod mcp_bridge;
mod mockup;
mod notify;
mod oauth;
mod output_log;
mod pdf;
mod preview;
mod project_hubs;
#[cfg(windows)]
mod ps_host;
mod review;
mod search;
pub(crate) mod search_core;
mod secret_vault;
mod session_search;
mod sessions;
mod settings;
mod shadow_git;
mod shell;
mod skills;
pub(crate) mod vfs;
mod video;
#[cfg(all(windows, test))]
mod window_watch;
mod write_eol;

pub use account::*;
pub use agent_cli::*;
pub use attachments::*;
pub use claude_code::*;
pub use cli_accounts::*;
pub use cli_install::*;
pub use file_history::*;
pub use files::*;
pub use managed_dirs::*;
pub use mcp_bridge::*;
pub use mockup::*;
pub use notify::*;
pub use oauth::*;
pub use pdf::*;
pub use preview::*;
pub use project_hubs::*;
pub use review::*;
pub use scope::*;
pub use search::*;
pub use session_search::*;
pub use sessions::*;
pub use settings::*;
pub use shadow_git::*;
pub use shell::*;
pub use skills::*;
pub use video::*;
