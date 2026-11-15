//! Errors that commands send to the frontend.
//!
//! A `CmdError` reaches JavaScript as `{ code, message, params }`. The UI looks `code` up in
//! `errors` in `src/locales/*.ts` and fills its `{placeholders}` from `params`, so the user reads
//! it in their language. `message` is the English text: what the agent sees in a tool result,
//! what logs keep, and what the UI shows for a code it doesn't know.
//!
//! Every code lives here as a constructor, so this file is the list the locales must cover
//! (`src/lib/__tests__/backendErrors.test.ts` checks it). Errors only the agent reads stay plain
//! English `String`s; `?` turns them into code `other`.

use serde::Serialize;
use serde_json::{Map, Value};
use std::fmt;

#[derive(Debug, Clone, Serialize)]
pub struct CmdError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
}

impl CmdError {
    fn new(code: &'static str, message: String) -> Self {
        Self {
            code,
            message,
            params: Map::new(),
        }
    }

    fn with(mut self, key: &str, value: impl fmt::Display) -> Self {
        self.params
            .insert(key.to_string(), Value::String(value.to_string()));
        self
    }

    // ── Agent CLIs (Claude Code, Codex, Gemini…)

    pub fn cli_not_installed(name: &str) -> Self {
        Self::new("cliNotInstalled", format!("{name} isn't installed")).with("name", name)
    }

    /// Like `cli_not_installed`, for a chat that tried to use it: points to where to connect it.
    pub fn cli_not_connected(name: &str) -> Self {
        Self::new(
            "cliNotConnected",
            format!("{name} isn't installed. Connect it in Settings → Providers."),
        )
        .with("name", name)
    }

    /// A local server Nyxs didn't start still listens after being stopped.
    pub fn server_stop_failed(port: u16) -> Self {
        Self::new(
            "serverStopFailed",
            format!("The server on port {port} is still running after trying to stop it"),
        )
        .with("port", port)
    }

    /// Installing a CLI with its own installer failed.
    pub fn cli_install_failed(name: &str, detail: impl fmt::Display) -> Self {
        Self::new(
            "cliInstallFailed",
            format!("Couldn't install {name}: {detail}"),
        )
        .with("name", name)
        .with("detail", detail)
    }

    /// Switching, adding or removing one of a CLI's saved accounts failed.
    pub fn account_change_failed(name: &str, detail: impl fmt::Display) -> Self {
        Self::new(
            "accountChangeFailed",
            format!("Couldn't change the {name} account: {detail}"),
        )
        .with("name", name)
        .with("detail", detail)
    }

    pub fn cli_no_response(name: &str) -> Self {
        Self::new("cliNoResponse", format!("{name} didn't respond in time")).with("name", name)
    }

    pub fn cli_start_failed(name: &str, detail: impl fmt::Display) -> Self {
        Self::new("cliStartFailed", format!("Couldn't start {name}: {detail}"))
            .with("name", name)
            .with("detail", detail)
    }

    pub fn cli_write_failed(name: &str, detail: impl fmt::Display) -> Self {
        Self::new(
            "cliWriteFailed",
            format!("Couldn't write to {name}: {detail}"),
        )
        .with("name", name)
        .with("detail", detail)
    }

    pub fn cli_session_ended(name: &str) -> Self {
        Self::new(
            "cliSessionEnded",
            format!("The {name} session has already ended"),
        )
        .with("name", name)
    }

    pub fn cli_input_closed(name: &str) -> Self {
        Self::new("cliInputClosed", format!("{name}'s input is closed")).with("name", name)
    }

    pub fn terminal_not_found() -> Self {
        Self::new("terminalNotFound", "No terminal was found to open".into())
    }

    pub fn terminal_open_failed(detail: impl fmt::Display) -> Self {
        Self::new(
            "terminalOpenFailed",
            format!("Couldn't open the terminal: {detail}"),
        )
        .with("detail", detail)
    }

    // ── Files

    pub fn file_open_failed(path: &str, detail: impl fmt::Display) -> Self {
        Self::new("fileOpenFailed", format!("Couldn't open {path}: {detail}"))
            .with("path", path)
            .with("detail", detail)
    }

    pub fn file_read_failed(path: &str, detail: impl fmt::Display) -> Self {
        Self::new("fileReadFailed", format!("Couldn't read {path}: {detail}"))
            .with("path", path)
            .with("detail", detail)
    }

    pub fn file_is_directory(path: &str) -> Self {
        Self::new(
            "fileIsDirectory",
            format!("{path} is a folder, not a file."),
        )
        .with("path", path)
    }

    pub fn list_dir_failed(path: &str, detail: impl fmt::Display) -> Self {
        Self::new("listDirFailed", format!("Couldn't list {path}: {detail}"))
            .with("path", path)
            .with("detail", detail)
    }

    pub fn image_empty(path: &str) -> Self {
        Self::new("imageEmpty", format!("The image is empty: {path}")).with("path", path)
    }

    pub fn image_too_large(max_mb: u64) -> Self {
        Self::new(
            "imageTooLarge",
            format!("The image is larger than the {max_mb} MB limit."),
        )
        .with("max", max_mb)
    }

    pub fn invalid_glob(pattern: &str, detail: impl fmt::Display) -> Self {
        Self::new(
            "invalidGlob",
            format!("Invalid glob pattern '{pattern}': {detail}"),
        )
        .with("pattern", pattern)
        .with("detail", detail)
    }

    pub fn invalid_regex(pattern: &str, detail: impl fmt::Display) -> Self {
        Self::new(
            "invalidRegex",
            format!("Invalid regex '{pattern}': {detail}"),
        )
        .with("pattern", pattern)
        .with("detail", detail)
    }

    // ── Opening things outside Nyxs

    pub fn only_http_urls() -> Self {
        Self::new("onlyHttpUrls", "Only http(s) URLs are allowed.".into())
    }

    pub fn browser_open_failed(detail: impl fmt::Display) -> Self {
        Self::new(
            "browserOpenFailed",
            format!("Couldn't open the browser: {detail}"),
        )
        .with("detail", detail)
    }

    pub fn oauth_no_params() -> Self {
        Self::new(
            "oauthNoParams",
            "The OAuth callback came back without parameters".into(),
        )
    }

    pub fn oauth_timed_out() -> Self {
        Self::new("oauthTimedOut", "The OAuth sign-in timed out".into())
    }

    // ── Commands and dev servers

    pub fn command_start_failed(detail: impl fmt::Display) -> Self {
        Self::new(
            "commandStartFailed",
            format!("Couldn't start the command: {detail}"),
        )
        .with("detail", detail)
    }

    pub fn invalid_url(url: &str, detail: impl fmt::Display) -> Self {
        Self::new("invalidUrl", format!("Invalid address {url}: {detail}"))
            .with("url", url)
            .with("detail", detail)
    }

    /// `status` is the exit code, or `None` when the process was killed without one. `tail` is
    /// the end of its output, already starting with a line break (or empty).
    pub fn server_exited(url: &str, status: Option<i32>, tail: &str) -> Self {
        let code = status
            .map(|c| format!(" (exit code {c})"))
            .unwrap_or_default();
        let status = status.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
        Self::new(
            "serverExited",
            format!("The server exited{code} before answering at {url}.{tail}"),
        )
        .with("url", url)
        .with("status", status)
        .with("tail", tail)
    }

    pub fn server_timeout(url: &str, seconds: u64) -> Self {
        Self::new(
            "serverTimeout",
            format!("{url} didn't answer within {seconds} s."),
        )
        .with("url", url)
        .with("seconds", seconds)
    }
}

impl fmt::Display for CmdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<String> for CmdError {
    fn from(message: String) -> Self {
        Self::new("other", message)
    }
}

impl From<&str> for CmdError {
    fn from(message: &str) -> Self {
        Self::new("other", message.to_string())
    }
}

/// Lets agent-side code that returns `Result<_, String>` call a helper that returns a `CmdError`.
impl From<CmdError> for String {
    fn from(e: CmdError) -> Self {
        e.message
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_code_message_and_params() {
        let v = serde_json::to_value(CmdError::file_read_failed("C:/a.txt", "denied")).unwrap();
        assert_eq!(v["code"], "fileReadFailed");
        assert_eq!(v["message"], "Couldn't read C:/a.txt: denied");
        assert_eq!(v["params"]["path"], "C:/a.txt");
        assert_eq!(v["params"]["detail"], "denied");
    }

    #[test]
    fn plain_strings_become_other_without_params() {
        let v = serde_json::to_value(CmdError::from("boom")).unwrap();
        assert_eq!(v, serde_json::json!({ "code": "other", "message": "boom" }));
    }

    #[test]
    fn server_exited_without_status() {
        let e = CmdError::server_exited("http://localhost:3000", None, "");
        assert_eq!(
            e.message,
            "The server exited before answering at http://localhost:3000."
        );
        assert_eq!(e.params["status"], "?");
    }
}
