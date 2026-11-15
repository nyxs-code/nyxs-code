//! Glob and Grep over a project, shared by the app and the remote helper (`remote/`), so a
//! search on a remote machine prints exactly what a local one does. Only std, `globset`,
//! `regex` and `crate::walk` here: the helper compiles this file on its own.

use std::time::UNIX_EPOCH;

use globset::Glob;

/// Files bigger than this are skipped by Grep (same limit as reading a file as text).
pub const GREP_MAX_FILE: u64 = 20 * 1024 * 1024;

pub enum SearchError {
    Glob { pattern: String, message: String },
    Regex { pattern: String, message: String },
}

impl SearchError {
    pub fn message(&self) -> String {
        match self {
            SearchError::Glob { pattern, message } => {
                format!("Invalid glob pattern '{pattern}': {message}")
            }
            SearchError::Regex { pattern, message } => {
                format!("Invalid regex '{pattern}': {message}")
            }
        }
    }
}

/// How a found file is shown: its full path on the machine that searched, turned into what the
/// caller wants (the remote helper prefixes `ssh://host`).
pub type Display<'a> = &'a dyn Fn(&str) -> String;

pub fn glob(pattern: &str, root: &str, display: Display) -> Result<Vec<String>, SearchError> {
    let matcher = Glob::new(pattern)
        .map_err(|e| SearchError::Glob {
            pattern: pattern.into(),
            message: e.to_string(),
        })?
        .compile_matcher();
    let match_basename = !pattern.contains('/') && !pattern.contains("**");
    let mut hits: Vec<(String, u128)> = Vec::new();
    for entry in crate::walk::project_files(root) {
        let full = entry.path();
        let rel = full.strip_prefix(root).unwrap_or(full);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let name = entry.file_name().to_string_lossy().to_string();
        let matched = matcher.is_match(&rel_str)
            || matcher.is_match(full)
            || (match_basename && matcher.is_match(&name));
        if !matched {
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        hits.push((display(&full.to_string_lossy()), mtime));
    }
    hits.sort_by_key(|h| std::cmp::Reverse(h.1));
    Ok(hits.into_iter().map(|(p, _)| p).take(1000).collect())
}

fn truncate_grep_line(s: &str) -> String {
    const MAX: usize = 400;
    if s.chars().count() > MAX {
        let t: String = s.chars().take(MAX).collect();
        format!("{t}…")
    } else {
        s.to_string()
    }
}

#[derive(Default, Clone)]
pub struct GrepOptions {
    pub pattern: String,
    pub cwd: String,
    pub glob: Option<String>,
    pub output_mode: Option<String>,
    pub case_insensitive: Option<bool>,
    pub context_lines: Option<usize>,
    pub head_limit: Option<usize>,
    pub multiline: Option<bool>,
}

pub fn grep(o: &GrepOptions, display: Display) -> Result<String, SearchError> {
    let cwd = o.cwd.as_str();
    let multiline = o.multiline.unwrap_or(false);
    let re = regex::RegexBuilder::new(&o.pattern)
        .case_insensitive(o.case_insensitive.unwrap_or(false))
        .dot_matches_new_line(multiline)
        .multi_line(multiline)
        .build()
        .map_err(|e| SearchError::Regex {
            pattern: o.pattern.clone(),
            message: e.to_string(),
        })?;

    let file_matcher = match &o.glob {
        Some(g) => Some(
            Glob::new(g)
                .map_err(|e| SearchError::Glob {
                    pattern: g.clone(),
                    message: e.to_string(),
                })?
                .compile_matcher(),
        ),
        None => None,
    };

    let mode = o
        .output_mode
        .clone()
        .unwrap_or_else(|| "files_with_matches".into());
    let ctx = o.context_lines.unwrap_or(0);
    let cap = o.head_limit.unwrap_or(500).max(1);

    let mut out_lines: Vec<String> = Vec::new();
    let mut files_with_hits: Vec<String> = Vec::new();
    let mut total_matches = 0usize;
    let mut truncated = false;

    'files: for entry in crate::walk::project_files(cwd) {
        let full = entry.path();
        if entry
            .metadata()
            .map(|m| m.len() > GREP_MAX_FILE)
            .unwrap_or(false)
        {
            continue;
        }
        if let Some(fm) = &file_matcher {
            let rel = full.strip_prefix(cwd).unwrap_or(full);
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let name = entry.file_name().to_string_lossy().to_string();
            if !(fm.is_match(&rel_str) || fm.is_match(&name)) {
                continue;
            }
        }

        let content = match std::fs::read_to_string(full) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let file_str = display(&full.to_string_lossy());

        if mode == "content" {
            let lines: Vec<&str> = content.lines().collect();

            let mut spans: Vec<(usize, usize)> = Vec::new();
            if multiline {
                for m in re.find_iter(&content) {
                    let sl = content[..m.start()].matches('\n').count();
                    let el =
                        (sl + m.as_str().matches('\n').count()).min(lines.len().saturating_sub(1));
                    spans.push((sl, el));
                }
            } else {
                for (i, l) in lines.iter().enumerate() {
                    if re.is_match(l) {
                        spans.push((i, i));
                    }
                }
            }
            if spans.is_empty() {
                continue;
            }

            let mut is_match_line = vec![false; lines.len()];
            for &(s, e) in &spans {
                for li in s..=e {
                    if li < is_match_line.len() {
                        is_match_line[li] = true;
                    }
                }
            }

            let mut last_emitted: Option<usize> = None;
            for &(s, e) in &spans {
                if total_matches >= cap {
                    truncated = true;
                    break 'files;
                }
                let win_start = s.saturating_sub(ctx);
                let win_end = (e + ctx).min(lines.len().saturating_sub(1));
                let group_start = match last_emitted {
                    Some(le) if win_start <= le + 1 => le + 1,
                    _ => {
                        if !out_lines.is_empty() {
                            out_lines.push("--".to_string());
                        }
                        win_start
                    }
                };
                if group_start <= win_end {
                    for li in group_start..=win_end {
                        let raw = lines[li];
                        let sep = if is_match_line[li] { ':' } else { '-' };
                        out_lines.push(format!(
                            "{}{}{}{}{}",
                            file_str,
                            sep,
                            li + 1,
                            sep,
                            truncate_grep_line(raw)
                        ));
                    }
                }
                last_emitted = Some(win_end.max(last_emitted.unwrap_or(win_end)));
                total_matches += 1;
            }
        } else {
            let matched = if multiline {
                re.is_match(&content)
            } else {
                content.lines().any(|l| re.is_match(l))
            };
            if matched {
                files_with_hits.push(file_str);
                if mode != "count" && files_with_hits.len() >= cap {
                    truncated = true;
                    break 'files;
                }
            }
        }
    }

    let mut result = match mode.as_str() {
        "content" => {
            if out_lines.is_empty() {
                "No matches.".to_string()
            } else {
                out_lines.join("\n")
            }
        }
        "count" => format!("{} file(s) with matches", files_with_hits.len()),
        _ => {
            if files_with_hits.is_empty() {
                "No matches.".to_string()
            } else {
                files_with_hits.join("\n")
            }
        }
    };
    if truncated {
        result.push_str(&format!(
            "\n\n[Truncated at {cap} {}. Narrow it with a more specific glob/pattern or raise head_limit.]",
            if mode == "content" { "matches" } else { "files" }
        ));
    }
    Ok(result)
}

/// The project's files relative to `root`, newest first, as the file picker lists them.
pub fn list_files(root: &str, limit: usize) -> Vec<String> {
    let mut hits: Vec<(String, u128)> = Vec::new();
    for entry in crate::walk::project_files(root) {
        let full = entry.path();
        let rel = full.strip_prefix(root).unwrap_or(full);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        hits.push((rel_str, mtime));
    }
    hits.sort_by_key(|h| std::cmp::Reverse(h.1));
    hits.into_iter().map(|(p, _)| p).take(limit).collect()
}
