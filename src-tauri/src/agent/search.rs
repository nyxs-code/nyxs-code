use super::search_core::{self, GrepOptions, SearchError};
use super::*;
use crate::error::CmdError;

fn glob_error(e: SearchError) -> String {
    e.message()
}

fn grep_error(e: SearchError) -> CmdError {
    match e {
        SearchError::Regex { pattern, message } => CmdError::invalid_regex(&pattern, message),
        SearchError::Glob { pattern, message } => CmdError::invalid_glob(&pattern, message),
    }
}

#[tauri::command(async)]
pub fn agent_glob(
    pattern: String,
    cwd: String,
    path: Option<String>,
    scope: Option<String>,
) -> Result<Vec<String>, String> {
    let root = path
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| cwd.clone());
    confine(&root, scope.as_deref())?;
    if let Some(r) = crate::remote::parse(&root) {
        let v = crate::remote::call(
            &r.host,
            "glob",
            serde_json::json!({
                "pattern": pattern,
                "root": r.path,
                "prefix": crate::remote::uri::prefix(&r.host),
            }),
        )?;
        return Ok(serde_json::from_value(v).unwrap_or_default());
    }
    search_core::glob(&pattern, &root, &|p: &str| p.to_string()).map_err(glob_error)
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn agent_grep(
    pattern: String,
    cwd: String,
    glob: Option<String>,
    output_mode: Option<String>,
    case_insensitive: Option<bool>,
    context_lines: Option<usize>,
    head_limit: Option<usize>,
    multiline: Option<bool>,
    scope: Option<String>,
) -> Result<String, CmdError> {
    confine(&cwd, scope.as_deref())?;
    if let Some(r) = crate::remote::parse(&cwd) {
        let v = crate::remote::call(
            &r.host,
            "grep",
            serde_json::json!({
                "pattern": pattern,
                "cwd": r.path,
                "glob": glob,
                "outputMode": output_mode,
                "caseInsensitive": case_insensitive,
                "contextLines": context_lines,
                "headLimit": head_limit,
                "multiline": multiline,
                "prefix": crate::remote::uri::prefix(&r.host),
            }),
        )
        .map_err(|e| CmdError::from(e.message))?;
        return Ok(v.as_str().unwrap_or("").to_string());
    }
    let o = GrepOptions {
        pattern,
        cwd,
        glob,
        output_mode,
        case_insensitive,
        context_lines,
        head_limit,
        multiline,
    };
    search_core::grep(&o, &|p: &str| p.to_string()).map_err(grep_error)
}
