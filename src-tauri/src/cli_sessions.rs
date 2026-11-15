//! Sessions of the Claude Code CLI (`~/.claude/projects/<project>/<id>.jsonl`), so a
//! conversation started in a terminal can continue in Nyxs, like Claude Code Desktop's /resume.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

/// The folder the CLI keeps a project's sessions in: its path with every character that isn't
/// a letter or digit turned into "-" (`D:\optimicer` → `D--optimicer`).
fn project_dir(workspace: &str) -> Option<PathBuf> {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| crate::project_paths::home_dir().map(|h| h.join(".claude")))?;
    let encoded: String = workspace
        .trim_end_matches(['\\', '/'])
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(base.join("projects").join(encoded))
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliMessage {
    role: &'static str,
    text: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CliSessionSummary {
    id: String,
    title: String,
    modified_at: u64,
    message_count: usize,
    /// "cli" for a terminal session; SDK runs (Nyxs, Desktop) say otherwise.
    entrypoint: String,
}

/// Drops what the CLI wraps around the user's words: reminders, and a slash command's tags
/// (kept as "/name args").
fn clean_user_text(raw: &str) -> String {
    let mut s = raw.to_string();
    while let (Some(a), Some(b)) = (s.find("<system-reminder>"), s.find("</system-reminder>")) {
        if b < a {
            break;
        }
        s.replace_range(a..b + "</system-reminder>".len(), "");
    }
    let tag = |s: &str, name: &str| -> Option<String> {
        let open = format!("<{name}>");
        let close = format!("</{name}>");
        let a = s.find(&open)? + open.len();
        let b = s[a..].find(&close)? + a;
        Some(s[a..b].trim().to_string())
    };
    if let Some(cmd) = tag(&s, "command-name") {
        let args = tag(&s, "command-args").unwrap_or_default();
        return format!("{cmd} {args}").trim().to_string();
    }
    if s.contains("<local-command-stdout>") || s.contains("<local-command-stderr>") {
        return String::new();
    }
    s.trim().to_string()
}

/// The conversation's text: the user's messages and the agent's replies (one per turn), without
/// sub-agents, meta entries, tool calls or tool results.
fn read_messages(path: &PathBuf) -> (Vec<CliMessage>, String, String) {
    let Ok(file) = fs::File::open(path) else {
        return (Vec::new(), String::new(), String::new());
    };
    let mut out: Vec<CliMessage> = Vec::new();
    let mut summary = String::new();
    let mut entrypoint = String::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let kind = v["type"].as_str().unwrap_or("");
        if kind == "summary" {
            if let Some(s) = v["summary"].as_str() {
                summary = s.to_string();
            }
            continue;
        }
        if (kind != "user" && kind != "assistant")
            || v["isSidechain"].as_bool() == Some(true)
            || v["isMeta"].as_bool() == Some(true)
        {
            continue;
        }
        if entrypoint.is_empty() {
            entrypoint = v["entrypoint"].as_str().unwrap_or("").to_string();
        }
        let content = &v["message"]["content"];
        let text = match content {
            Value::String(s) => s.clone(),
            Value::Array(blocks) => blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        if kind == "user" {
            let text = clean_user_text(&text);
            if !text.is_empty() {
                out.push(CliMessage { role: "user", text });
            }
        } else {
            let text = text.trim().to_string();
            if text.is_empty() {
                continue;
            }
            // A turn's reply comes in several entries (text between tool calls): one message.
            match out.last_mut() {
                Some(last) if last.role == "assistant" => {
                    last.text.push_str("\n\n");
                    last.text.push_str(&text);
                }
                _ => out.push(CliMessage {
                    role: "assistant",
                    text,
                }),
            }
        }
    }
    (out, summary, entrypoint)
}

fn mtime_ms(path: &PathBuf) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The project's CLI sessions, newest first.
#[tauri::command(async)]
pub fn claude_cli_sessions(workspace: String) -> Vec<CliSessionSummary> {
    let Some(dir) = project_dir(&workspace) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut list: Vec<CliSessionSummary> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| {
            let id = p.file_stem()?.to_string_lossy().to_string();
            let (messages, summary, entrypoint) = read_messages(&p);
            if messages.is_empty() {
                return None;
            }
            let first = messages
                .iter()
                .find(|m| m.role == "user")
                .map(|m| m.text.as_str())
                .unwrap_or("");
            let title = if summary.is_empty() {
                first.chars().take(80).collect()
            } else {
                summary
            };
            Some(CliSessionSummary {
                id,
                title,
                modified_at: mtime_ms(&p),
                message_count: messages.len(),
                entrypoint,
            })
        })
        .collect();
    list.sort_by_key(|s| std::cmp::Reverse(s.modified_at));
    list
}

/// One CLI session's conversation, to import into Nyxs.
#[tauri::command(async)]
pub fn claude_cli_session_read(workspace: String, id: String) -> Result<Vec<CliMessage>, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid session id.".into());
    }
    let dir = project_dir(&workspace).ok_or("No home folder.")?;
    let path = dir.join(format!("{id}.jsonl"));
    if !path.is_file() {
        return Err(format!("No Claude Code session {id} for this project."));
    }
    Ok(read_messages(&path).0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_cli_transcript_as_a_conversation() {
        let dir = std::env::temp_dir().join("nyxs-cli-sessions-test");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("s.jsonl");
        let lines = [
            r#"{"type":"queue-operation","operation":"enqueue"}"#,
            r#"{"type":"user","entrypoint":"cli","message":{"role":"user","content":"Fix the login\n\n<system-reminder>be brief</system-reminder>"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Looking."},{"type":"tool_use","name":"Read","input":{}}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"file"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fixed."}]}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent"}]}}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat: meta"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/review</command-name><command-args>src</command-args>"}}"#,
            r#"{"type":"summary","summary":"Login fix"}"#,
        ];
        fs::write(&path, lines.join("\n")).unwrap();
        let (messages, summary, entrypoint) = read_messages(&path);
        assert_eq!(
            messages,
            vec![
                CliMessage {
                    role: "user",
                    text: "Fix the login".into()
                },
                CliMessage {
                    role: "assistant",
                    text: "Looking.\n\nFixed.".into()
                },
                CliMessage {
                    role: "user",
                    text: "/review src".into()
                },
            ]
        );
        assert_eq!(summary, "Login fix");
        assert_eq!(entrypoint, "cli");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_the_project_folder_the_cli_uses() {
        let dir = project_dir("D:\\optimicer\\").unwrap();
        assert!(dir.ends_with("projects/D--optimicer") || dir.ends_with("projects\\D--optimicer"));
    }
}
