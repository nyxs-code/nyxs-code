use super::fuzzy_edit;
use super::text_io::*;
use super::vfs;
use super::*;
use crate::error::CmdError;

const MAX_LINE_CHARS: usize = 2000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRange {
    pub text: String,
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: usize,
    pub encoding: Option<String>,
    pub long_lines: usize,
}

impl FileRange {
    fn notice(text: &str) -> Self {
        FileRange {
            text: text.into(),
            start_line: 0,
            end_line: 0,
            total_lines: 0,
            encoding: None,
            long_lines: 0,
        }
    }
}

#[tauri::command(async)]
pub fn agent_read_file(
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    scope: Option<String>,
) -> Result<String, String> {
    read_range(&path, offset, limit, scope.as_deref(), None).map(|r| r.text)
}

#[tauri::command(async)]
pub fn agent_read_file_range(
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    scope: Option<String>,
) -> Result<FileRange, String> {
    read_range(&path, offset, limit, scope.as_deref(), Some(MAX_LINE_CHARS))
}

/// A file read as text: the text alone, or, when asked `withEncoding`, also the encoding of one
/// that isn't UTF-8 ("UTF-16 LE", "UTF-16 BE", "Latin-1"). Writes refuse those files, so the
/// Files panel opens them read-only.
#[derive(Serialize, Debug)]
#[serde(untagged)]
pub enum ReadText {
    Plain(String),
    WithEncoding {
        text: String,
        encoding: Option<&'static str>,
    },
}

impl ReadText {
    pub fn into_text(self) -> String {
        match self {
            ReadText::Plain(text) | ReadText::WithEncoding { text, .. } => text,
        }
    }
}

#[tauri::command(async)]
pub fn agent_read_text(
    path: String,
    scope: Option<String>,
    with_encoding: Option<bool>,
) -> Result<Option<ReadText>, CmdError> {
    confine(&path, scope.as_deref())?;
    match vfs::metadata(&path) {
        Ok(m) if m.is_file && m.len <= MAX_READ_SIZE => {}
        Ok(_) => return Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(CmdError::file_open_failed(&path, e)),
    }
    let bytes = vfs::read(&path).map_err(|e| CmdError::file_read_failed(&path, e))?;
    Ok(decode_for_read(&bytes).map(|d| {
        if with_encoding.unwrap_or(false) {
            // The note's name without its explanation: "Latin-1 (not valid UTF-8)" is "Latin-1".
            let encoding = d.note.map(|n| n.split(" (").next().unwrap_or(n));
            ReadText::WithEncoding {
                text: d.text,
                encoding,
            }
        } else {
            ReadText::Plain(d.text)
        }
    }))
}

fn clip_line(line: &str, max: usize) -> Option<String> {
    let mut chars = line.char_indices();
    let (cut, _) = chars.nth(max)?;
    let rest = line[cut..].chars().count();
    Some(format!(
        "{}… [line truncated: {rest} more characters]",
        &line[..cut]
    ))
}

fn read_range(
    path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
    scope: Option<&str>,
    max_line_chars: Option<usize>,
) -> Result<FileRange, String> {
    confine(path, scope)?;
    let meta = vfs::metadata(path).map_err(|e| CmdError::file_open_failed(path, e))?;
    if meta.is_dir {
        return Err(CmdError::file_is_directory(path).into());
    }
    if meta.len > MAX_READ_SIZE {
        return Err(format!(
            "{path} is too large ({} MB; at most {} MB can be read as text). \
             Use a command-line tool (Bash) if you need to process it.",
            meta.len / (1024 * 1024),
            MAX_READ_SIZE / (1024 * 1024)
        ));
    }
    let bytes = vfs::read(path).map_err(|e| CmdError::file_read_failed(path, e))?;
    if bytes.is_empty() {
        return Ok(FileRange::notice("(the file exists but is empty)"));
    }
    let Some(decoded) = decode_for_read(&bytes) else {
        return Ok(FileRange::notice(
            "(binary file: it contains null bytes, not shown as text)",
        ));
    };
    let content = decoded.text;
    let encoding = decoded.note.map(str::to_string);

    let total_lines = content.lines().count();
    let start = offset.unwrap_or(0);
    let max = limit.unwrap_or(2000);
    let mut out = String::new();
    let mut end_line = 0usize;
    let mut long_lines = 0usize;
    for (i, line) in content.lines().enumerate().skip(start).take(max) {
        match max_line_chars.and_then(|m| clip_line(line, m)) {
            Some(clipped) => {
                long_lines += 1;
                out.push_str(&format!("{:>6}\t{}\n", i + 1, clipped));
            }
            None => out.push_str(&format!("{:>6}\t{}\n", i + 1, line)),
        }
        end_line = i + 1;
    }
    if out.is_empty() {
        return Ok(FileRange {
            text: "(no lines in the requested range)".into(),
            start_line: 0,
            end_line: 0,
            total_lines,
            encoding,
            long_lines: 0,
        });
    }
    Ok(FileRange {
        text: out,
        start_line: start + 1,
        end_line,
        total_lines,
        encoding,
        long_lines,
    })
}

fn numbered_excerpt(content: &str, spans: &[(usize, usize)]) -> String {
    const CONTEXT: usize = 3;
    const MAX_BLOCK_LINES: usize = 40;
    const MAX_BLOCKS: usize = 6;
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return String::new();
    }
    let mut ranges: Vec<(usize, usize)> = spans
        .iter()
        .filter(|(start, len)| start + len <= content.len())
        .map(|&(start, len)| {
            let first = content[..start].matches('\n').count();
            let last = first
                + content[start..start + len]
                    .trim_end_matches(['\r', '\n'])
                    .matches('\n')
                    .count();
            (
                first.saturating_sub(CONTEXT),
                (last + CONTEXT).min(lines.len() - 1),
            )
        })
        .filter(|(from, to)| from <= to)
        .collect();
    ranges.sort();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (from, to) in ranges {
        match merged.last_mut() {
            Some(last) if from <= last.1 + 1 => last.1 = last.1.max(to),
            _ => merged.push((from, to)),
        }
    }
    let mut out = String::new();
    for (n, &(from, to)) in merged.iter().enumerate() {
        if n == MAX_BLOCKS {
            out.push_str(&format!(
                "   …\t({} more edited areas)\n",
                merged.len() - MAX_BLOCKS
            ));
            break;
        }
        if n > 0 {
            out.push_str("   …\n");
        }
        let shown_to = to.min(from + MAX_BLOCK_LINES - 1);
        for (i, line) in lines.iter().enumerate().take(shown_to + 1).skip(from) {
            out.push_str(&format!("{:>6}\t{}\n", i + 1, line));
        }
        if shown_to < to {
            out.push_str(&format!("   …\t({} more lines)\n", to - shown_to));
        }
    }
    out
}

fn edit_report(summary: String, updated: &str, spans: &[(usize, usize)]) -> String {
    let excerpt = numbered_excerpt(updated, spans);
    if excerpt.is_empty() {
        summary
    } else {
        format!("{summary}\n\nThe edited area now reads:\n{excerpt}")
    }
}

/// The form of `old` to look for. Read shows lines without their `\r`, so an `old_string`
/// usually comes with `\n`: in a CRLF file its CRLF form goes first. A match that cuts a `\r\n`
/// in two (an `old_string` starting with `\n`, found right after a `\r`) is never taken while
/// another form matches: the replacement would leave a stray `\r` before it.
fn pick_old(content: &str, old: &str, crlf: bool) -> String {
    let (as_crlf, as_lf) = (match_eol(old, true), match_eol(old, false));
    let order = if crlf {
        [as_crlf, old.to_string(), as_lf]
    } else {
        [old.to_string(), as_lf, as_crlf]
    };
    let found = |s: &&String| content.contains(s.as_str());
    order
        .iter()
        .find(|s| found(s) && !splits_crlf(content, s))
        .or_else(|| order.iter().find(found))
        .cloned()
        .unwrap_or_else(|| old.to_string())
}

fn splits_crlf(content: &str, needle: &str) -> bool {
    let bytes = content.as_bytes();
    content.match_indices(needle).any(|(i, m)| {
        (m.starts_with('\n') && i > 0 && bytes[i - 1] == b'\r')
            || (m.ends_with('\r') && bytes.get(i + m.len()) == Some(&b'\n'))
    })
}

/// Whether the text replacing `content[start..end]` gets CRLF: as that span has them, else as
/// the line it sits in, else as the file. A file that mixes line endings on purpose keeps each
/// part's, and nothing outside the span changes.
fn eol_at(content: &str, start: usize, end: usize, crlf: bool) -> bool {
    let span = &content[start..end];
    if span.contains("\r\n") {
        return true;
    }
    if span.contains('\n') {
        return false;
    }
    let rest = &content[end..];
    match rest.find('\n') {
        Some(i) => end + i > 0 && content.as_bytes()[end + i - 1] == b'\r',
        None => crlf,
    }
}

struct Applied {
    content: String,
    replaced: usize,
    span: Option<(usize, usize)>,
    removed: usize,
    fuzzy: Option<&'static str>,
}

fn apply_edit(
    content: &str,
    old: &str,
    new: &str,
    replace_all: bool,
    expected_count: Option<usize>,
    crlf: bool,
) -> Result<Applied, String> {
    if old.is_empty() {
        return Err(
            "old_string is empty. To create or rewrite a file use Write; to edit, copy the exact text to replace.".into(),
        );
    }
    if old == new {
        return Err("old_string and new_string are identical: there is nothing to change.".into());
    }
    let old = pick_old(content, old, crlf);
    let count = content.matches(&old).count();
    if count == 0 {
        if !replace_all && expected_count.is_none() {
            match fuzzy_edit::locate(content, &old, new) {
                fuzzy_edit::Fuzzy::One {
                    start,
                    end,
                    replacement,
                    strategy,
                } => {
                    let replacement = match_eol(&replacement, eol_at(content, start, end, crlf));
                    return Ok(Applied {
                        content: format!("{}{}{}", &content[..start], replacement, &content[end..]),
                        replaced: 1,
                        span: Some((start, replacement.len())),
                        removed: end - start,
                        fuzzy: Some(strategy),
                    });
                }
                fuzzy_edit::Fuzzy::Many(n) => {
                    return Err(format!(
                        "old_string doesn't match exactly and there are {n} approximate matches (ambiguous). Add more unique context."
                    ));
                }
                fuzzy_edit::Fuzzy::None => {}
            }
        }
        let hint = fuzzy_edit::closest_hint(content, &old)
            .map(|h| format!(" {h}"))
            .unwrap_or_default();
        return Err(format!(
            "old_string wasn't found. Read the file and copy the exact text.{hint}"
        ));
    }
    if let Some(exp) = expected_count {
        if count != exp {
            return Err(format!(
                "old_string appears {count} times, but expected_count was {exp}. Adjust the context or expected_count."
            ));
        }
    }
    if count > 1 && !replace_all {
        return Err(format!(
            "old_string appears {count} times. Add more context to make it unique, or use replace_all."
        ));
    }
    let first = content.find(&old).unwrap_or(0);
    let new = match_eol(new, eol_at(content, first, first + old.len(), crlf));
    let span = if count == 1 {
        Some((first, new.len()))
    } else {
        None
    };
    Ok(Applied {
        content: content.replace(&old, &new),
        replaced: count,
        span,
        removed: old.len(),
        fuzzy: None,
    })
}

fn shift_spans(spans: &mut Vec<(usize, usize)>, at: usize, removed: usize, added: usize) {
    spans.retain(|&(s, l)| s + l <= at || s >= at + removed);
    for span in spans.iter_mut() {
        if span.0 >= at + removed {
            span.0 = span.0 - removed + added;
        }
    }
}

/// Biggest 3D model the Files panel opens: a viewer, not a tool for scenes of hundreds of MB.
const MODEL_MAX_READ_BYTES: u64 = 64 * 1024 * 1024;

/// A 3D model's bytes (glb, gltf, stl, obj) for the Files panel's 3D view, as base64.
#[tauri::command(async)]
pub fn agent_read_model(path: String, scope: Option<String>) -> Result<String, CmdError> {
    use base64::Engine;
    confine(&path, scope.as_deref())?;
    let lower = path.to_lowercase();
    if ![".glb", ".gltf", ".stl", ".obj"]
        .iter()
        .any(|e| lower.ends_with(e))
    {
        return Err(
            format!("Not a 3D model this view opens: {path} (glb, gltf, stl or obj).").into(),
        );
    }
    let meta = vfs::metadata(&path).map_err(|e| CmdError::file_open_failed(&path, e))?;
    if meta.is_dir {
        return Err(CmdError::file_is_directory(&path));
    }
    if meta.len > MODEL_MAX_READ_BYTES {
        return Err(format!(
            "The model is larger than {} MB, too large to preview.",
            MODEL_MAX_READ_BYTES / (1024 * 1024)
        )
        .into());
    }
    let bytes = vfs::read(&path).map_err(|e| CmdError::file_read_failed(&path, e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRead {
    pub base64: String,
    pub media_type: String,
    pub size: u64,
}

#[tauri::command(async)]
pub fn agent_read_image(path: String, scope: Option<String>) -> Result<ImageRead, CmdError> {
    use base64::Engine;
    confine(&path, scope.as_deref())?;
    let lower = path.to_lowercase();
    let media_type = if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else {
        return Err(
            format!("Unsupported image format: {path} (use png, jpg, webp, gif or bmp).").into(),
        );
    };
    let meta = vfs::metadata(&path).map_err(|e| CmdError::file_open_failed(&path, e))?;
    if meta.is_dir {
        return Err(CmdError::file_is_directory(&path));
    }
    let size = meta.len;
    if size == 0 {
        return Err(CmdError::image_empty(&path));
    }
    if size > IMAGE_MAX_READ_BYTES {
        return Err(CmdError::image_too_large(
            IMAGE_MAX_READ_BYTES / (1024 * 1024),
        ));
    }
    let bytes = vfs::read(&path).map_err(|e| CmdError::file_read_failed(&path, e))?;
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(ImageRead {
        base64,
        media_type: media_type.to_string(),
        size,
    })
}

#[tauri::command(async)]
pub fn agent_file_mtime(path: String) -> Option<u64> {
    mtime_ms(&path)
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{bytes} B")
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

fn line_diff_counts(old: &str, new: &str) -> (usize, usize) {
    let mut counts: HashMap<&str, i64> = HashMap::new();
    for l in old.lines() {
        *counts.entry(l).or_insert(0) += 1;
    }
    for l in new.lines() {
        *counts.entry(l).or_insert(0) -= 1;
    }
    let mut removed = 0usize;
    let mut added = 0usize;
    for c in counts.values() {
        if *c > 0 {
            removed += *c as usize;
        } else if *c < 0 {
            added += (-*c) as usize;
        }
    }
    (added, removed)
}

#[tauri::command(async)]
pub fn agent_write_file(
    path: String,
    content: String,
    scope: Option<String>,
    allow_config: Option<bool>,
    expected_mtime: Option<u64>,
) -> Result<String, String> {
    confine_write(&path, scope.as_deref(), allow_config.unwrap_or(false))?;
    if content.len() > MAX_WRITE_SIZE {
        return Err(format!(
            "Content too large ({} MB; at most {} MB).",
            content.len() / (1024 * 1024),
            MAX_WRITE_SIZE / (1024 * 1024)
        ));
    }
    let lock = edit_lock(&path);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    check_unchanged(&path, expected_mtime)?;
    // A file that can't be read back as UTF-8 (UTF-16, Latin-1) would be rewritten as UTF-8 with
    // LF: refused, with why, like an edit.
    let old = if vfs::is_file(&path) {
        Some(load_for_edit(&path)?)
    } else {
        None
    };
    // A remote write makes its own folders on the machine.
    if !crate::remote::is_remote(&path) {
        if let Some(parent) = Path::new(&path).parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Couldn't create the folder for {path}: {e}"))?;
            }
        }
    }
    let (content, bom, summary) = match &old {
        Some(o) => {
            let content = super::write_eol::with_old_eols(&o.text, &content, o.crlf);
            let (added, removed) = line_diff_counts(&o.text, &content);
            let eol = if o.crlf {
                ", CRLF line endings kept"
            } else {
                ""
            };
            (content, o.bom, format!(" (+{added} −{removed} lines{eol})"))
        }
        None => (content, false, " (new file)".to_string()),
    };
    save_text(&path, &content, bom)?;
    Ok(format!(
        "OK: wrote {} bytes to {path}{summary}",
        content.len()
    ))
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn agent_edit_file(
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
    scope: Option<String>,
    expected_count: Option<usize>,
    allow_config: Option<bool>,
    expected_mtime: Option<u64>,
) -> Result<String, String> {
    confine_write(&path, scope.as_deref(), allow_config.unwrap_or(false))?;
    let lock = edit_lock(&path);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    check_unchanged(&path, expected_mtime)?;
    let file = load_for_edit(&path)?;
    let applied = apply_edit(
        &file.text,
        &old_string,
        &new_string,
        replace_all.unwrap_or(false),
        expected_count,
        file.crlf,
    )
    .map_err(|e| format!("{e} ({path}; nothing was applied)"))?;
    save_text(&path, &applied.content, file.bom)?;
    let fuzzy = applied
        .fuzzy
        .map(|why| format!(" (approximate match: {why}; check the edited area)"))
        .unwrap_or_default();
    let summary = format!("OK: {} replacement(s) in {path}{fuzzy}", applied.replaced);
    let spans: Vec<(usize, usize)> = applied.span.into_iter().collect();
    Ok(edit_report(summary, &applied.content, &spans))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOp {
    pub(crate) old_string: String,
    pub(crate) new_string: String,
    pub(crate) replace_all: Option<bool>,
}

#[tauri::command(async)]
pub fn agent_multi_edit(
    path: String,
    edits: Vec<EditOp>,
    scope: Option<String>,
    allow_config: Option<bool>,
    expected_mtime: Option<u64>,
) -> Result<String, String> {
    confine_write(&path, scope.as_deref(), allow_config.unwrap_or(false))?;
    if edits.is_empty() {
        return Err("No edits were given.".into());
    }
    let lock = edit_lock(&path);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    check_unchanged(&path, expected_mtime)?;
    let file = load_for_edit(&path)?;
    let mut content = file.text;
    let mut total = 0usize;
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for (idx, e) in edits.iter().enumerate() {
        let applied = apply_edit(
            &content,
            &e.old_string,
            &e.new_string,
            e.replace_all.unwrap_or(false),
            None,
            file.crlf,
        )
        .map_err(|err| format!("Edit #{}: {err} No change was applied.", idx + 1))?;
        match applied.span {
            Some((start, len)) => {
                shift_spans(&mut spans, start, applied.removed, len);
                spans.push((start, len));
            }
            None => spans.clear(),
        }
        content = applied.content;
        total += applied.replaced;
    }
    save_text(&path, &content, file.bom)?;
    let summary = format!(
        "OK: {} edit(s), {total} replacement(s) in {path}",
        edits.len()
    );
    Ok(edit_report(summary, &content, &spans))
}

/// Deletes one file for the agent (`apply_patch`'s `*** Delete File:`), within the same scope
/// and config protection as its writes, and only if it hasn't changed since the agent saw it.
#[tauri::command(async)]
pub fn agent_delete_file(
    path: String,
    scope: Option<String>,
    allow_config: Option<bool>,
    expected_mtime: Option<u64>,
) -> Result<String, String> {
    confine_write(&path, scope.as_deref(), allow_config.unwrap_or(false))?;
    if vfs::is_dir(&path) {
        return Err(format!(
            "{path} is a folder, not a file; nothing was deleted."
        ));
    }
    let lock = edit_lock(&path);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    check_unchanged(&path, expected_mtime)?;
    vfs::remove_file(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("{path} doesn't exist; nothing was deleted."),
        _ => format!("Couldn't delete {path}: {e}"),
    })?;
    Ok(format!("OK: deleted {path}"))
}

#[tauri::command(async)]
pub fn agent_path_exists(path: String) -> bool {
    confine(&path, None).is_ok() && vfs::exists(&path)
}

#[tauri::command(async)]
pub fn path_is_dir(path: String) -> bool {
    !path.is_empty() && vfs::is_dir(&path)
}

#[tauri::command(async)]
pub fn agent_list_dir(path: String, scope: Option<String>) -> Result<Vec<String>, CmdError> {
    confine(&path, scope.as_deref())?;
    let entries = vfs::read_dir(&path).map_err(|e| CmdError::list_dir_failed(&path, e))?;
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<(String, u64)> = Vec::new();
    for entry in entries {
        if entry.is_dir {
            dirs.push(format!("{}/", entry.name));
        } else {
            files.push((entry.name, entry.len));
        }
    }
    dirs.sort();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = Vec::with_capacity(dirs.len() + files.len());
    out.extend(dirs);
    for (name, size) in files {
        out.push(format!("{name}  ({})", human_size(size)));
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn agent_list_files(workspace: String) -> Result<Vec<String>, String> {
    if workspace.is_empty() {
        return Ok(Vec::new());
    }
    confine(&workspace, None)?;
    if let Some(r) = crate::remote::parse(&workspace) {
        let v = crate::remote::call(
            &r.host,
            "listFiles",
            serde_json::json!({ "root": r.path, "limit": 5000 }),
        )?;
        return Ok(serde_json::from_value(v).unwrap_or_default());
    }
    Ok(super::search_core::list_files(&workspace, 5000))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        dir: PathBuf,
        scope: String,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nyxs-files-{tag}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            let scope = format!("files-test-{tag}");
            set_scope_roots(&scope, &[dir.to_string_lossy().to_string()]);
            Fixture { dir, scope }
        }

        fn file(&self, name: &str, body: &str) -> String {
            let p = self.dir.join(name);
            fs::write(&p, body).unwrap();
            p.to_string_lossy().to_string()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn read_range_reports_position_in_file() {
        let fx = Fixture::new("range");
        let path = fx.file("a.txt", "one\ntwo\nthree\nfour\nfive\n");
        let r = agent_read_file_range(path, Some(1), Some(2), Some(fx.scope.clone())).unwrap();
        assert_eq!((r.start_line, r.end_line, r.total_lines), (2, 3, 5));
        assert_eq!(r.text, "     2\ttwo\n     3\tthree\n");
    }

    #[test]
    fn deletes_a_file_in_scope_and_says_why_when_it_cannot() {
        let fx = Fixture::new("delete");
        let path = fx.file("gone.txt", "x");
        let scope = Some(fx.scope.clone());
        let stale = agent_delete_file(path.clone(), scope.clone(), None, Some(1)).unwrap_err();
        assert!(Path::new(&path).exists(), "{stale}");
        assert!(agent_delete_file(path.clone(), scope.clone(), None, None)
            .unwrap()
            .starts_with("OK: deleted"));
        assert!(!Path::new(&path).exists());
        let again = agent_delete_file(path, scope.clone(), None, None).unwrap_err();
        assert!(again.contains("doesn't exist"), "{again}");
        let folder =
            agent_delete_file(fx.dir.to_string_lossy().to_string(), scope, None, None).unwrap_err();
        assert!(folder.contains("is a folder"), "{folder}");
    }

    #[test]
    fn read_range_past_the_end_still_reports_total() {
        let fx = Fixture::new("past");
        let path = fx.file("a.txt", "one\ntwo\n");
        let r = agent_read_file_range(path, Some(10), None, Some(fx.scope.clone())).unwrap();
        assert_eq!((r.end_line, r.total_lines), (0, 2));
    }

    #[test]
    fn path_exists_checks_metadata_only_inside_allowed_roots() {
        let fx = Fixture::new("exists");
        let file = fx.file("a.txt", "x");
        assert!(agent_path_exists(file));
        assert!(agent_path_exists(fx.dir.to_string_lossy().to_string()));
        assert!(!agent_path_exists(
            fx.dir.join("missing").to_string_lossy().to_string()
        ));
        let outside = std::env::temp_dir().to_string_lossy().to_string();
        assert!(!agent_path_exists(outside));
    }

    #[test]
    fn read_range_clips_long_lines_and_reports_encoding() {
        let fx = Fixture::new("long");
        let long = "x".repeat(MAX_LINE_CHARS + 50);
        let path = fx.dir.join("a.txt");
        let mut bytes = b"caf\xE9\n".to_vec();
        bytes.extend_from_slice(long.as_bytes());
        fs::write(&path, &bytes).unwrap();
        let path = path.to_string_lossy().to_string();
        let r = agent_read_file_range(path.clone(), None, None, Some(fx.scope.clone())).unwrap();
        assert_eq!(r.long_lines, 1);
        assert!(r.text.contains("café"));
        assert!(r.text.contains("[line truncated: 50 more characters]"));
        assert!(r.encoding.unwrap().contains("Latin-1"));
        assert!(!agent_read_file(path, None, None, Some(fx.scope.clone()))
            .unwrap()
            .contains("recortada"));
    }

    fn edit(fx: &Fixture, path: &str, old: &str, new: &str, all: bool) -> Result<String, String> {
        agent_edit_file(
            path.into(),
            old.into(),
            new.into(),
            Some(all),
            Some(fx.scope.clone()),
            None,
            None,
            None,
        )
    }

    #[test]
    fn edit_shows_the_edited_lines_with_numbers() {
        let fx = Fixture::new("edit");
        let body: String = (1..=20).map(|i| format!("line {i}\n")).collect();
        let path = fx.file("a.txt", &body);
        let out = edit(&fx, &path, "line 10\n", "line ten\nline ten bis\n", false).unwrap();
        assert!(out.contains("    10\tline ten\n"), "{out}");
        assert!(out.contains("    11\tline ten bis\n"), "{out}");
        assert!(out.contains("     7\tline 7\n"), "{out}");
        assert!(!out.contains("\tline 3\n"), "{out}");
    }

    #[test]
    fn replace_all_with_many_hits_skips_the_excerpt() {
        let fx = Fixture::new("all");
        let path = fx.file("a.txt", "x\nx\nx\n");
        let out = edit(&fx, &path, "x", "y", true).unwrap();
        assert_eq!(out.lines().count(), 1, "{out}");
    }

    #[test]
    fn excerpt_is_capped_for_large_replacements() {
        let body: String = (1..=200).map(|i| format!("l{i}\n")).collect();
        let out = numbered_excerpt(&body, &[(0, body.len())]);
        assert_eq!(out.lines().count(), 41);
        assert!(out.ends_with("more lines)\n"));
    }

    #[test]
    fn edits_keep_crlf_and_bom() {
        let fx = Fixture::new("crlf");
        let path = fx.file("a.txt", "\u{feff}fn a() {\r\n    1\r\n}\r\n");
        edit(
            &fx,
            &path,
            "fn a() {\n    1\n}",
            "fn a() {\n    2\n    3\n}",
            false,
        )
        .unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(
            bytes,
            "\u{feff}fn a() {\r\n    2\r\n    3\r\n}\r\n".as_bytes()
        );
        agent_write_file(
            path.clone(),
            "x\ny\n".into(),
            Some(fx.scope.clone()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), "\u{feff}x\r\ny\r\n".as_bytes());
    }

    /// `name` in a CRLF file `body` (written with `\n`, sent to disk with `\r\n`) edited from
    /// `old` to `new`; the bytes on disk after it.
    fn crlf_edit(fx: &Fixture, name: &str, body: &str, old: &str, new: &str) -> String {
        let path = fx.file(name, &body.replace('\n', "\r\n"));
        edit(fx, &path, old, new, false).unwrap();
        fs::read_to_string(&path).unwrap()
    }

    #[test]
    fn crlf_edits_never_leave_a_stray_cr() {
        let fx = Fixture::new("stray-cr");
        let body = "- **A.** uno.\n- **B.** dos.\n\n## Git\n";
        let crlf = |s: &str| s.replace('\n', "\r\n");
        // old starts at the edge of a line: its `\n` was found inside the `\r\n` before it.
        let out = crlf_edit(
            &fx,
            "1.md",
            body,
            "\n- **B.** dos.",
            "\n- **B.** dos.\n- **C.** tres.",
        );
        assert_eq!(
            out,
            crlf("- **A.** uno.\n- **B.** dos.\n- **C.** tres.\n\n## Git\n")
        );
        // The same right before a blank line, with the new text already in CRLF.
        let out = crlf_edit(
            &fx,
            "2.md",
            body,
            "\n## Git",
            "\r\n- **C.** tres.\r\n## Git",
        );
        assert_eq!(
            out,
            crlf("- **A.** uno.\n- **B.** dos.\n\n- **C.** tres.\n## Git\n")
        );
        // old and new in LF; new mixing both.
        let out = crlf_edit(
            &fx,
            "3.md",
            body,
            "- **B.** dos.\n",
            "- **B.** dos.\r\n- **C.** tres.\n",
        );
        assert_eq!(
            out,
            crlf("- **A.** uno.\n- **B.** dos.\n- **C.** tres.\n\n## Git\n")
        );
        // At the very start and the very end of the file.
        let out = crlf_edit(
            &fx,
            "4.md",
            body,
            "- **A.** uno.\n",
            "# Título\n- **A.** uno.\n",
        );
        assert_eq!(
            out,
            crlf("# Título\n- **A.** uno.\n- **B.** dos.\n\n## Git\n")
        );
        let out = crlf_edit(&fx, "5.md", body, "## Git\n", "## Git\n\nNada.\n");
        assert_eq!(
            out,
            crlf("- **A.** uno.\n- **B.** dos.\n\n## Git\n\nNada.\n")
        );
        for name in ["1.md", "2.md", "3.md", "4.md", "5.md"] {
            let text = fs::read_to_string(fx.dir.join(name)).unwrap();
            assert!(
                !text.contains("\r\r") && !text.replace("\r\n", "").contains(['\r', '\n']),
                "{name}: {text:?}"
            );
        }
    }

    #[test]
    fn lf_and_mixed_files_keep_their_line_endings() {
        let fx = Fixture::new("eol-kept");
        let lf = fx.file("lf.txt", "a\nb\nc\n");
        edit(&fx, &lf, "b\n", "b\r\nb2\r\n", false).unwrap();
        assert_eq!(fs::read_to_string(&lf).unwrap(), "a\nb\nb2\nc\n");
        // CRLF lines with an LF heredoc on purpose: each part keeps its own.
        let mixed = fx.file("mixed.sh", "x\r\ncat <<EOF\nlf 1\nlf 2\nEOF\r\ny\r\n");
        edit(&fx, &mixed, "lf 1\nlf 2\n", "lf 1\nlf 1b\nlf 2\n", false).unwrap();
        edit(&fx, &mixed, "y", "y\nz", false).unwrap();
        assert_eq!(
            fs::read_to_string(&mixed).unwrap(),
            "x\r\ncat <<EOF\nlf 1\nlf 1b\nlf 2\nEOF\r\ny\r\nz\r\n"
        );
        // Mostly LF with one CRLF line: an edit inside it keeps the CRLF.
        let lf_mostly = fx.file("m2.txt", "a\nb\nwin\r\nline\r\nc\nd\n");
        edit(&fx, &lf_mostly, "\nline", "\nline\nmore", false).unwrap();
        assert_eq!(
            fs::read_to_string(&lf_mostly).unwrap(),
            "a\nb\nwin\r\nline\r\nmore\r\nc\nd\n"
        );
    }

    #[test]
    fn multi_edit_and_write_keep_crlf_without_stray_cr() {
        let fx = Fixture::new("multi-crlf");
        let path = fx.file("a.md", "uno\r\ndos\r\n\r\ntres\r\n");
        agent_multi_edit(
            path.clone(),
            vec![
                EditOp {
                    old_string: "\ndos".into(),
                    new_string: "\ndos\ndos bis".into(),
                    replace_all: None,
                },
                EditOp {
                    old_string: "\ntres\n".into(),
                    new_string: "\r\ntres\r\ncuatro\n".into(),
                    replace_all: None,
                },
            ],
            Some(fx.scope.clone()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "uno\r\ndos\r\ndos bis\r\n\r\ntres\r\ncuatro\r\n"
        );
        agent_write_file(
            path.clone(),
            "nuevo\r\ntexto\nfin\n".into(),
            Some(fx.scope.clone()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "nuevo\r\ntexto\r\nfin\r\n"
        );
    }

    #[test]
    fn write_over_a_mixed_file_keeps_the_endings_of_unchanged_lines() {
        let fx = Fixture::new("write-mixed");
        let path = fx.file(
            "run.sh",
            "x
cat <<EOF
lf 1
EOF
y
",
        );
        agent_write_file(
            path.clone(),
            "x
cat <<EOF
lf 1
lf 2
EOF
y changed
"
            .into(),
            Some(fx.scope.clone()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "x
cat <<EOF
lf 1
lf 2
EOF
y changed
"
        );
    }

    #[test]
    fn parallel_edits_to_one_file_all_land() {
        let fx = Fixture::new("parallel");
        let body: String = (0..12).map(|i| format!("line {i:02}\r\n")).collect();
        let path = fx.file("a.txt", &body);
        let handles: Vec<_> = (0..12)
            .map(|i| {
                // The same file however the path is written.
                let path = if i % 2 == 0 {
                    path.clone()
                } else {
                    path.replace('\\', "/")
                };
                #[cfg(windows)]
                let path = if i % 3 == 0 {
                    path.to_uppercase()
                } else {
                    path
                };
                let scope = fx.scope.clone();
                std::thread::spawn(move || {
                    agent_edit_file(
                        path,
                        format!("line {i:02}\n"),
                        format!("LINE {i:02}\n"),
                        None,
                        Some(scope),
                        None,
                        None,
                        None,
                    )
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap().unwrap();
        }
        let expected: String = (0..12).map(|i| format!("LINE {i:02}\r\n")).collect();
        assert_eq!(fs::read_to_string(&path).unwrap(), expected);
    }

    #[test]
    fn rejects_pointless_and_empty_edits() {
        let fx = Fixture::new("noop");
        let path = fx.file("a.txt", "abc\n");
        assert!(edit(&fx, &path, "abc", "abc", false)
            .unwrap_err()
            .contains("identical"));
        assert!(edit(&fx, &path, "", "z", false)
            .unwrap_err()
            .contains("empty"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "abc\n");
    }

    #[test]
    fn refuses_to_edit_files_that_are_not_utf8() {
        let fx = Fixture::new("latin");
        let path = fx.dir.join("a.txt");
        fs::write(&path, b"caf\xE9\n").unwrap();
        let path = path.to_string_lossy().to_string();
        assert!(edit(&fx, &path, "caf", "cafe", false)
            .unwrap_err()
            .contains("isn't UTF-8"));
        assert_eq!(fs::read(&path).unwrap(), b"caf\xE9\n");
    }

    #[test]
    fn read_text_names_an_encoding_it_cant_edit() {
        let fx = Fixture::new("read-enc");
        let scope = || Some(fx.scope.clone());
        let read = |p: &Path| match agent_read_text(
            p.to_string_lossy().to_string(),
            scope(),
            Some(true),
        ) {
            Ok(Some(ReadText::WithEncoding { text, encoding })) => (text, encoding),
            _ => panic!("no text with its encoding for {}", p.display()),
        };
        let le: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("hola".encode_utf16().flat_map(|u| u.to_le_bytes()))
            .collect();
        let be: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain("hola".encode_utf16().flat_map(|u| u.to_be_bytes()))
            .collect();
        for (name, bytes, label) in [
            ("le.txt", le, Some("UTF-16 LE")),
            ("be.txt", be, Some("UTF-16 BE")),
            ("latin.txt", b"caf\xE9".to_vec(), Some("Latin-1")),
            ("bom.txt", b"\xEF\xBB\xBFhola".to_vec(), None),
        ] {
            let p = fx.dir.join(name);
            fs::write(&p, bytes).unwrap();
            let (text, encoding) = read(&p);
            assert!(text == "hola" || text == "café", "{name}: {text}");
            assert_eq!(encoding, label, "{name}");
        }
        // Without asking, it's the text alone, as every other caller expects.
        let plain = fx.file("plain.txt", "hola");
        assert!(matches!(
            agent_read_text(plain, scope(), None),
            Ok(Some(ReadText::Plain(t))) if t == "hola"
        ));
    }

    #[test]
    fn write_never_converts_a_file_it_cant_edit_as_text() {
        let fx = Fixture::new("write-enc");
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("hola\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()))
            .collect();
        let wide = fx.dir.join("wide.txt");
        fs::write(&wide, &utf16).unwrap();
        let latin = fx.dir.join("latin.txt");
        fs::write(&latin, b"caf\xE9\r\n").unwrap();
        let write = |p: &Path| {
            agent_write_file(
                p.to_string_lossy().to_string(),
                "hola mundo\n".into(),
                Some(fx.scope.clone()),
                None,
                None,
            )
        };
        let err = write(&wide).unwrap_err();
        assert!(err.contains("UTF-16"), "{err}");
        assert_eq!(fs::read(&wide).unwrap(), utf16);
        let err = write(&latin).unwrap_err();
        assert!(err.contains("isn't UTF-8"), "{err}");
        assert_eq!(fs::read(&latin).unwrap(), b"caf\xE9\r\n");
        // A new file is still written.
        assert!(write(&fx.dir.join("new.txt"))
            .unwrap()
            .contains("(new file)"));
    }

    #[test]
    fn stale_mtime_blocks_the_write() {
        let fx = Fixture::new("stale");
        let path = fx.file("a.txt", "abc\n");
        let now = mtime_ms(&path).unwrap();
        let err = agent_edit_file(
            path.clone(),
            "abc".into(),
            "xyz".into(),
            None,
            Some(fx.scope.clone()),
            None,
            None,
            Some(now - 5000),
        )
        .unwrap_err();
        assert!(err.contains("changed on disk"), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "abc\n");
        agent_edit_file(
            path.clone(),
            "abc".into(),
            "xyz".into(),
            None,
            Some(fx.scope.clone()),
            None,
            None,
            Some(now),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "xyz\n");
    }

    #[test]
    fn multi_edit_shows_every_edited_zone() {
        let fx = Fixture::new("multi");
        let body: String = (1..=60).map(|i| format!("line {i}\n")).collect();
        let path = fx.file("a.txt", &body);
        let edits = vec![
            EditOp {
                old_string: "line 5\n".into(),
                new_string: "five\nfive bis\n".into(),
                replace_all: None,
            },
            EditOp {
                old_string: "line 50\n".into(),
                new_string: "fifty\n".into(),
                replace_all: None,
            },
        ];
        let out = agent_multi_edit(path, edits, Some(fx.scope.clone()), None, None).unwrap();
        assert!(out.contains("     5\tfive\n"), "{out}");
        assert!(out.contains("     6\tfive bis\n"), "{out}");
        assert!(out.contains("    51\tfifty\n"), "{out}");
        assert!(out.contains("   …\n"), "{out}");
        assert!(!out.contains("\tline 25\n"), "{out}");
    }
}
