//! What a Claude Code run is started with: the request from the page and the CLI arguments
//! built from it, each value checked before it reaches the command line.

use crate::agent::*;
use serde::Deserialize;

const PERMISSION_MODES: [&str; 5] = ["plan", "acceptEdits", "auto", "manual", "dontAsk"];
pub(super) const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeRunRequest {
    pub(super) run_id: String,
    pub(super) cwd: Option<String>,
    pub(super) model: Option<String>,
    pub(super) resume: Option<String>,
    /// With `resume`: the session's last message uuid the chat still has. The resumed history
    /// stops there, and the run goes on in a new session (`--fork-session`), so a chat that was
    /// edited, rewound or forked doesn't carry on from turns it no longer shows.
    #[serde(default)]
    pub(super) resume_at: Option<String>,
    pub(super) permission_mode: Option<String>,
    pub(super) effort: Option<String>,
    #[serde(default)]
    pub(super) no_tools: bool,
    #[serde(default)]
    pub(super) ephemeral: bool,
    /// MCP servers Nyxs itself hosts: the CLI reaches them with `mcp_message` control requests.
    #[serde(default)]
    pub(super) sdk_mcp_servers: Vec<String>,
    /// Nyxs' own instructions on top of Claude Code's (e.g. how to draw previews in the chat).
    #[serde(default)]
    pub(super) append_system_prompt: Option<String>,
    /// The session's own variables (a saved environment's), on top of Nyxs' environment.
    #[serde(default)]
    pub(super) env: std::collections::HashMap<String, String>,
    /// The most agentic turns (`--max-turns`) the process may take: headless `--max-steps`.
    #[serde(default)]
    pub(super) max_turns: Option<u32>,
    /// The user hasn't trusted the folder's own config (settingsRuntime.ts): the CLI then loads
    /// only the user's settings, not the repo's `.claude/settings*.json` (hooks, env, allow rules,
    /// helper commands) nor its `.mcp.json` servers, which print mode would run without asking.
    #[serde(default)]
    pub(super) untrusted_project: bool,
}

fn is_cli_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._[]:".contains(c))
}

fn is_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// For a folder whose config isn't trusted: the user's settings only, and only the MCP servers
/// passed with `--mcp-config` (Nyxs' own), not the repo's `.mcp.json` ones.
fn untrusted_project_args() -> [String; 3] {
    [
        "--setting-sources".into(),
        "user".into(),
        "--strict-mcp-config".into(),
    ]
}

pub(super) fn run_args(req: &ClaudeCodeRunRequest) -> Vec<String> {
    let mut args: Vec<String> = [
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        // A foreground sub-agent's messages come too, whole, with their `parent_tool_use_id`
        // (seen in 2.1.316; without it only background ones send theirs). No sub-agent sends
        // partials, so its activity still arrives a message at a time.
        "--forward-subagent-text",
        "--replay-user-messages",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if req.untrusted_project {
        args.extend(untrusted_project_args());
    }
    if req.no_tools {
        args.push("--tools=".into());
        if !req.untrusted_project {
            args.push("--strict-mcp-config".into());
        }
    } else {
        args.push("--permission-prompt-tool=stdio".into());
        let servers: serde_json::Map<String, serde_json::Value> = req
            .sdk_mcp_servers
            .iter()
            .filter(|name| is_cli_token(name))
            .map(|name| {
                (
                    name.clone(),
                    serde_json::json!({ "type": "sdk", "name": name }),
                )
            })
            .collect();
        if !servers.is_empty() {
            args.push("--mcp-config".into());
            args.push(serde_json::json!({ "mcpServers": servers }).to_string());
        }
    }
    if req.ephemeral {
        args.push("--no-session-persistence".into());
    }
    if let Some(model) = req.model.as_deref().filter(|m| is_cli_token(m)) {
        args.push(format!("--model={model}"));
    }
    if let Some(id) = req.resume.as_deref().filter(|r| is_session_id(r)) {
        args.push(format!("--resume={id}"));
        // A hidden flag of the CLI (2.1.312 has it, the Agent SDK passes it); only read in
        // print mode, which stream-json input is.
        if let Some(at) = req.resume_at.as_deref().filter(|a| is_session_id(a)) {
            args.push(format!("--resume-session-at={at}"));
            args.push("--fork-session".into());
        }
    }
    if let Some(mode) = req
        .permission_mode
        .as_deref()
        .filter(|m| PERMISSION_MODES.contains(m))
    {
        args.push(format!("--permission-mode={mode}"));
    }
    if let Some(effort) = req.effort.as_deref().filter(|e| EFFORTS.contains(e)) {
        args.push(format!("--effort={effort}"));
    }
    if let Some(n) = req.max_turns.filter(|n| (1..=1000).contains(n)) {
        args.push(format!("--max-turns={n}"));
    }
    if let Some(text) = req
        .append_system_prompt
        .as_deref()
        .filter(|t| !t.trim().is_empty() && t.len() <= MAX_APPEND_PROMPT)
    {
        args.push("--append-system-prompt".into());
        args.push(text.to_string());
    }
    args
}

/// Keep in step with APPEND_PROMPT_LIMIT in claudeCode.ts, which fits NYXS.md into what's left.
const MAX_APPEND_PROMPT: usize = 16 * 1024;

/// cmd.exe takes 8191 characters on a command line; this leaves room for the program's path.
const BATCH_COMMAND_LINE: usize = 7 * 1024;

/// An npm install runs the CLI through `claude.cmd`, and cmd.exe can't take a line break inside
/// an argument: there the appended prompt goes on one line, or into a file when the command line
/// would be too long for cmd.exe to start it.
pub(super) fn args_for(bin: &Path, args: Vec<String>) -> Vec<String> {
    let batch = bin
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if !batch {
        return args;
    }
    let args = if args.iter().map(|a| a.len() + 3).sum::<usize>() > BATCH_COMMAND_LINE {
        spill_append_prompt(args, write_prompt_file)
    } else {
        args
    };
    args.into_iter()
        .map(|a| a.replace("\r\n", " ").replace('\n', " "))
        .collect()
}

/// The appended prompt handed over as `--append-system-prompt-file` instead. If the file can't
/// be written the prompt stays inline, which is no worse than before.
fn spill_append_prompt(
    mut args: Vec<String>,
    write: impl FnOnce(&str) -> std::io::Result<PathBuf>,
) -> Vec<String> {
    let Some(i) = args.iter().position(|a| a == "--append-system-prompt") else {
        return args;
    };
    if let Some(path) = args.get(i + 1).and_then(|text| write(text).ok()) {
        args[i] = "--append-system-prompt-file".into();
        args[i + 1] = path.to_string_lossy().into_owned();
    }
    args
}

/// Without a project folder Claude Code works in `~/.nyxs/claude-code`.
pub(super) fn run_cwd(requested: Option<&str>) -> Result<PathBuf, String> {
    crate::agent::cli_process::run_cwd(requested, "claude-code")
}

/// One file per prompt text, under Claude Code's own folder in `~/.nyxs`.
fn write_prompt_file(text: &str) -> std::io::Result<PathBuf> {
    use std::hash::{Hash, Hasher};
    let dir = run_cwd(None)
        .map_err(std::io::Error::other)?
        .join("prompts");
    std::fs::create_dir_all(&dir)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    let path = dir.join(format!("append-{:016x}.md", hasher.finish()));
    if !path.exists() {
        // A CLI starting meanwhile never reads half a file.
        crate::agent::text_io::write_atomic(&path, text.as_bytes())?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(append: Option<&str>) -> ClaudeCodeRunRequest {
        serde_json::from_value(serde_json::json!({
            "runId": "r1",
            "cwd": "C:/ws",
            "appendSystemPrompt": append,
        }))
        .unwrap()
    }

    #[test]
    fn a_long_prompt_goes_to_a_file_for_claude_cmd() {
        let text = format!("# Project\n{}", "x".repeat(BATCH_COMMAND_LINE));
        let args = spill_append_prompt(run_args(&request(Some(&text))), |t| {
            assert_eq!(t, text);
            Ok(PathBuf::from("C:/p/append.md"))
        });
        let i = args
            .iter()
            .position(|a| a == "--append-system-prompt-file")
            .unwrap();
        assert_eq!(
            args[i + 1],
            PathBuf::from("C:/p/append.md").to_string_lossy()
        );
        assert!(!args.iter().any(|a| a == "--append-system-prompt"));
    }

    #[test]
    fn the_prompt_stays_inline_when_the_file_cant_be_written() {
        let args = spill_append_prompt(run_args(&request(Some("hola"))), |_| {
            Err(std::io::Error::other("read-only"))
        });
        let i = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .unwrap();
        assert_eq!(args[i + 1], "hola");
    }

    #[test]
    fn caps_its_turns_only_with_a_limit_in_range() {
        let turns = |max: serde_json::Value| {
            let req: ClaudeCodeRunRequest =
                serde_json::from_value(serde_json::json!({ "runId": "r1", "maxTurns": max }))
                    .unwrap();
            run_args(&req)
                .into_iter()
                .filter(|a| a.starts_with("--max-turns"))
                .collect::<Vec<_>>()
        };
        assert_eq!(turns(serde_json::json!(30)), ["--max-turns=30"]);
        assert!(turns(serde_json::json!(0)).is_empty());
        assert!(turns(serde_json::json!(5000)).is_empty());
        assert!(turns(serde_json::Value::Null).is_empty());
    }

    #[test]
    fn resuming_at_a_message_forks_the_session_there() {
        let at = |resume: Option<&str>, resume_at: &str| {
            let req: ClaudeCodeRunRequest = serde_json::from_value(serde_json::json!({
                "runId": "r1",
                "resume": resume,
                "resumeAt": resume_at,
            }))
            .unwrap();
            run_args(&req)
        };
        let args = at(Some("s-1"), "1493d66c-41e0-4fa2");
        assert!(args.contains(&"--resume=s-1".to_string()));
        assert!(args.contains(&"--resume-session-at=1493d66c-41e0-4fa2".to_string()));
        assert!(args.contains(&"--fork-session".to_string()));
        // Only with a session to resume, and only a uuid-like value.
        assert!(!at(None, "1493d66c")
            .iter()
            .any(|a| a.starts_with("--resume")));
        assert!(!at(Some("s-1"), "--model=x")
            .iter()
            .any(|a| a == "--fork-session"));
    }

    #[test]
    fn an_untrusted_folder_loads_only_the_users_settings_and_nyxs_mcp_servers() {
        let args = |untrusted: Option<bool>, no_tools: bool| {
            let mut json = serde_json::json!({
                "runId": "r1",
                "cwd": "C:/ws",
                "noTools": no_tools,
                "sdkMcpServers": ["nyxs-browser"],
            });
            if let Some(u) = untrusted {
                json["untrustedProject"] = u.into();
            }
            run_args(&serde_json::from_value(json).unwrap())
        };
        let count = |args: &[String], flag: &str| args.iter().filter(|a| *a == flag).count();
        let untrusted = args(Some(true), false);
        let i = untrusted
            .iter()
            .position(|a| a == "--setting-sources")
            .unwrap();
        assert_eq!(untrusted[i + 1], "user");
        assert_eq!(count(&untrusted, "--strict-mcp-config"), 1);
        // Nyxs' own servers still come in, through the flag strict mode keeps.
        let m = untrusted.iter().position(|a| a == "--mcp-config").unwrap();
        assert!(untrusted[m + 1].contains("nyxs-browser"));
        // Without tools the flag is there once, not twice.
        assert_eq!(count(&args(Some(true), true), "--strict-mcp-config"), 1);
        // A trusted folder, or a request from before the field, keeps the CLI's own loading.
        for trusted in [args(Some(false), false), args(None, false)] {
            assert!(!trusted.iter().any(|a| a == "--setting-sources"));
            assert_eq!(count(&trusted, "--strict-mcp-config"), 0);
        }
    }

    #[test]
    fn a_short_prompt_stays_inline_for_claude_cmd() {
        let args = args_for(
            Path::new("C:/npm/claude.cmd"),
            run_args(&request(Some("a\nb"))),
        );
        let i = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .unwrap();
        assert_eq!(args[i + 1], "a b");
    }
}
