use super::*;

const SNIPPET_RADIUS: usize = 60;
const MAX_SNIPPETS: usize = 3;
const DEFAULT_LIMIT: usize = 50;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnippet {
    role: String,
    text: String,
    match_start: usize,
    match_len: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHit {
    workspace: String,
    session_id: String,
    meta: String,
    modified_at: f64,
    matches: usize,
    title_match: bool,
    snippets: Vec<SessionSnippet>,
}

fn fold(text: &str) -> Vec<char> {
    text.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

fn find_all(haystack: &[char], needle: &[char]) -> Vec<usize> {
    let mut hits = Vec::new();
    if needle.is_empty() || needle.len() > haystack.len() {
        return hits;
    }
    let mut i = 0;
    while i + needle.len() <= haystack.len() {
        if haystack[i..i + needle.len()] == *needle {
            hits.push(i);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    hits
}

fn snippet_around(original: &[char], at: usize, len: usize, role: &str) -> SessionSnippet {
    let start = at.saturating_sub(SNIPPET_RADIUS);
    let end = (at + len + SNIPPET_RADIUS).min(original.len());
    let mut text: String = original[start..end].iter().collect();
    let mut match_start = at - start;
    if start > 0 {
        text.insert(0, '…');
        match_start += 1;
    }
    if end < original.len() {
        text.push('…');
    }
    let text = text.replace(['\n', '\r', '\t'], " ");
    SessionSnippet {
        role: role.to_string(),
        text,
        match_start,
        match_len: len,
    }
}

fn session_title(meta: &str) -> String {
    serde_json::from_str::<serde_json::Value>(meta)
        .ok()
        .and_then(|v| v.get("title").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_default()
}

fn search_session(
    workspace: &str,
    session_id: &str,
    transcript_path: &Path,
    needle: &[char],
) -> Option<SessionSearchHit> {
    let meta =
        fs::read_to_string(session_meta_path(workspace, session_id).ok()?).unwrap_or_default();
    let title_match = !find_all(&fold(&session_title(&meta)), needle).is_empty();
    let file = fs::File::open(transcript_path).ok()?;
    let mut matches = 0;
    let mut snippets = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let role = value.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let Some(content) = value.get("content").and_then(|c| c.as_str()) else {
            continue;
        };
        let original: Vec<char> = content.chars().collect();
        let hits = find_all(&fold(content), needle);
        matches += hits.len();
        for at in hits {
            if snippets.len() >= MAX_SNIPPETS {
                break;
            }
            snippets.push(snippet_around(&original, at, needle.len(), role));
        }
    }
    if matches == 0 && !title_match {
        return None;
    }
    Some(SessionSearchHit {
        workspace: workspace.to_string(),
        session_id: session_id.to_string(),
        meta,
        modified_at: file_mtime_ms(transcript_path),
        matches,
        title_match,
        snippets,
    })
}

fn search_workspace(workspace: &str, needle: &[char], out: &mut Vec<SessionSearchHit>) {
    let Ok(dir) = sessions_dir(workspace) else {
        return;
    };
    let Ok(read) = fs::read_dir(&dir) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        let Some(id) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".jsonl"))
        else {
            continue;
        };
        if let Some(hit) = search_session(workspace, id, &path, needle) {
            out.push(hit);
        }
    }
}

#[tauri::command]
pub async fn nyxs_search_sessions(
    workspaces: Vec<String>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SessionSearchHit>, String> {
    let needle = fold(query.trim());
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    tauri::async_runtime::spawn_blocking(move || {
        let mut unique = workspaces;
        unique.sort();
        unique.dedup();
        let mut out = Vec::new();
        for ws in unique.iter().filter(|w| !w.is_empty()) {
            search_workspace(ws, &needle, &mut out);
        }
        out.sort_by(|a, b| {
            b.title_match.cmp(&a.title_match).then(
                b.modified_at
                    .partial_cmp(&a.modified_at)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
        });
        out.truncate(limit);
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_all_is_case_insensitive_and_non_overlapping() {
        let hay = fold("Hola HOLA hola");
        let needle = fold("hola");
        assert_eq!(find_all(&hay, &needle), vec![0, 5, 10]);
        assert_eq!(find_all(&fold("aaaa"), &fold("aa")), vec![0, 2]);
    }

    #[test]
    fn snippet_marks_match_and_ellipsis() {
        let text: Vec<char> = format!("{}needle{}", "x".repeat(100), "y".repeat(100))
            .chars()
            .collect();
        let s = snippet_around(&text, 100, 6, "user");
        assert!(s.text.starts_with('…'));
        assert!(s.text.ends_with('…'));
        let picked: String = s
            .text
            .chars()
            .skip(s.match_start)
            .take(s.match_len)
            .collect();
        assert_eq!(picked, "needle");
    }

    #[test]
    fn handles_multibyte_text() {
        let text: Vec<char> = "Configuración rápida añadida".chars().collect();
        let hits = find_all(&fold("Configuración rápida añadida"), &fold("RÁPIDA"));
        assert_eq!(hits, vec![14]);
        let s = snippet_around(&text, hits[0], 6, "assistant");
        let picked: String = s
            .text
            .chars()
            .skip(s.match_start)
            .take(s.match_len)
            .collect();
        assert_eq!(picked, "rápida");
    }
}
