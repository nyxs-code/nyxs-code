use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::agent::text_io::write_atomic;

const CHUNK_LINES: usize = 50;
const CHUNK_OVERLAP: usize = 10;
const DEFAULT_MAX_FILE_BYTES: u64 = 1_500_000;

const IGNORED_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "bmp", "avif", "mp4", "mov", "webm", "mp3",
    "wav", "ogg", "flac", "zip", "gz", "tar", "rar", "7z", "exe", "dll", "so", "dylib", "bin",
    "pdf", "woff", "woff2", "ttf", "otf", "eot", "lock", "map",
];

fn has_ignored_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IGNORED_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn fnv1a(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub hash: String,
    /// Empty for a `known` chunk: only new text has to cross to the app to be embedded.
    pub text: String,
    /// Its vector is already in the index (for the same embeddings model).
    pub known: bool,
}

/// Where a chunk is now, so the index can follow a file that moved or a text found in two.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChunkRef {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
/// A new vector, by the hash of its text: where that text is comes with `current` (rag_store).
pub struct StoredInput {
    pub hash: String,
    pub vector: Vec<f32>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IndexEntry {
    path: String,
    start_line: usize,
    end_line: usize,
    hash: String,
    vector: Vec<f32>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Index {
    model: String,
    dim: usize,
    entries: Vec<IndexEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub score: f32,
    pub snippet: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub chunks: usize,
    pub files: usize,
    pub model: String,
    pub dim: usize,
    pub exists: bool,
}

fn index_path(workspace: &str) -> PathBuf {
    if let Some(dir) = crate::project_paths::project_feature_dir(workspace, "rag") {
        return dir.join("index.json");
    }
    Path::new(workspace)
        .join(".nyxs")
        .join("rag")
        .join("index.json")
}

/// Parsed indexes kept in memory, keyed by file and checked against its size and mtime, so a
/// search doesn't re-read and re-parse every vector. A file changed by someone else (another
/// Nyxs window) no longer matches and is read again.
struct Cached {
    len: u64,
    modified: Option<SystemTime>,
    index: Arc<Index>,
}

static CACHE: OnceLock<Mutex<HashMap<PathBuf, Cached>>> = OnceLock::new();

fn cache() -> std::sync::MutexGuard<'static, HashMap<PathBuf, Cached>> {
    CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn file_stamp(p: &Path) -> Option<(u64, Option<SystemTime>)> {
    let meta = fs::metadata(p).ok()?;
    Some((meta.len(), meta.modified().ok()))
}

fn load_index(workspace: &str) -> Arc<Index> {
    let p = index_path(workspace);
    let Some((len, modified)) = file_stamp(&p) else {
        cache().remove(&p);
        return Arc::new(Index::default());
    };
    if let Some(c) = cache().get(&p) {
        if c.len == len && c.modified == modified {
            return c.index.clone();
        }
    }
    let index = match fs::read_to_string(&p).map(|s| serde_json::from_str::<Index>(&s)) {
        Ok(Ok(idx)) => idx,
        Ok(Err(e)) => {
            // A damaged index is moved aside instead of being silently replaced: it counts as
            // empty, so the next indexing rebuilds it, and the bad file stays for inspection.
            let aside = p.with_extension("json.corrupt");
            let _ = fs::rename(&p, &aside);
            eprintln!(
                "[rag] damaged index at {}: {e}; moved to {}",
                p.display(),
                aside.display()
            );
            cache().remove(&p);
            return Arc::new(Index::default());
        }
        Err(_) => return Arc::new(Index::default()),
    };
    let index = Arc::new(index);
    cache().insert(
        p,
        Cached {
            len,
            modified,
            index: index.clone(),
        },
    );
    index
}

fn save_index(workspace: &str, idx: Index) -> Result<Arc<Index>, String> {
    let p = index_path(workspace);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {parent:?}: {e}"))?;
    }
    let json =
        serde_json::to_string(&idx).map_err(|e| format!("Couldn't serialize the index: {e}"))?;
    write_atomic(&p, json.as_bytes()).map_err(|e| format!("Couldn't write the index: {e}"))?;
    let index = Arc::new(idx);
    match file_stamp(&p) {
        Some((len, modified)) => {
            cache().insert(
                p,
                Cached {
                    len,
                    modified,
                    index: index.clone(),
                },
            );
        }
        None => {
            cache().remove(&p);
        }
    }
    Ok(index)
}

fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
    v
}

fn chunk_file(rel: &str, content: &str, out: &mut Vec<Chunk>) {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return;
    }
    let step = CHUNK_LINES.saturating_sub(CHUNK_OVERLAP).max(1);
    let mut start = 0usize;
    while start < lines.len() {
        let end = (start + CHUNK_LINES).min(lines.len());
        let text = lines[start..end].join("\n");
        if !text.trim().is_empty() {
            out.push(Chunk {
                path: rel.to_string(),
                start_line: start + 1,
                end_line: end,
                hash: fnv1a(&text),
                text,
                known: false,
            });
        }
        if end == lines.len() {
            break;
        }
        start += step;
    }
}

/// The hashes already in the index for `model`: none when the index is another model's.
fn known_hashes(workspace: &str, model: Option<&str>) -> std::collections::HashSet<String> {
    let idx = load_index(workspace);
    match model {
        Some(m) if idx.model == m => idx.entries.iter().map(|e| e.hash.clone()).collect(),
        _ => Default::default(),
    }
}

/// Marks the chunks already in the index and drops their text.
fn mark_known(chunks: &mut [Chunk], known: &std::collections::HashSet<String>) {
    for c in chunks.iter_mut().filter(|c| known.contains(&c.hash)) {
        c.known = true;
        c.text = String::new();
    }
}

/// The project's chunks as they are now. With `model`, those already in the index for it come
/// without their text (`known`): after a turn that edited two files, only those files' new text
/// crosses to the app instead of the whole project's.
#[tauri::command(async)]
pub fn rag_collect_chunks(
    workspace: String,
    max_file_bytes: Option<u64>,
    model: Option<String>,
) -> Result<Vec<Chunk>, String> {
    let known = known_hashes(&workspace, model.as_deref());
    let mut chunks = collect(&workspace, max_file_bytes, &known)?;
    mark_known(&mut chunks, &known);
    Ok(chunks)
}

fn collect(
    workspace: &str,
    max_file_bytes: Option<u64>,
    known: &std::collections::HashSet<String>,
) -> Result<Vec<Chunk>, String> {
    if let Some(r) = crate::remote::parse(workspace) {
        let max = max_file_bytes.unwrap_or(DEFAULT_MAX_FILE_BYTES);
        return remote_chunks(workspace, &r, max, known);
    }
    let root = Path::new(workspace);
    if !root.is_dir() {
        return Err(format!("The workspace doesn't exist: {workspace}"));
    }
    let max_bytes = max_file_bytes.unwrap_or(DEFAULT_MAX_FILE_BYTES);
    let mut chunks: Vec<Chunk> = Vec::new();

    for entry in crate::walk::project_files(root) {
        let path = entry.path();
        if has_ignored_ext(path) || crate::walk::is_secret_file(path) {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if meta.len() > max_bytes || meta.len() == 0 {
                continue;
            }
        }
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if looks_binary(&bytes) {
            continue;
        }
        let content = match String::from_utf8(bytes) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        chunk_file(&rel, &content, &mut chunks);
    }
    Ok(chunks)
}

/// A chunk of a remote file as kept between passes: where it is in the file and its hash.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SeenChunk {
    start_line: usize,
    end_line: usize,
    hash: String,
}

/// A remote file as this side last saw it: its modification time and size there, and its
/// chunks without their text.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct RemoteFile {
    mtime: u64,
    size: u64,
    chunks: Vec<SeenChunk>,
}

/// A remote project's files by their path on the machine.
type RemoteFiles = HashMap<String, RemoteFile>;

/// Kept next to the index: machine state, never in the project.
fn remote_files_path(workspace: &str) -> Option<PathBuf> {
    crate::project_paths::project_feature_dir(workspace, "rag").map(|d| d.join("remote-files.json"))
}

/// What the last pass kept. It only saves bringing files over again, so one that can't be read
/// is started over, which costs one full pass.
fn load_remote_files(workspace: &str) -> RemoteFiles {
    let Some(p) = remote_files_path(workspace) else {
        return RemoteFiles::new();
    };
    let Ok(raw) = fs::read(&p) else {
        return RemoteFiles::new();
    };
    serde_json::from_slice(&raw).unwrap_or_else(|e| {
        log::warn!("{}: {e}; the next pass reads every file", p.display());
        RemoteFiles::new()
    })
}

fn save_remote_files(workspace: &str, files: &RemoteFiles) {
    let Some(p) = remote_files_path(workspace) else {
        return;
    };
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec(files) {
        if let Err(e) = write_atomic(&p, &json) {
            log::warn!("{}: {e}", p.display());
        }
    }
}

/// The files to tell the helper the app already has: those whose every chunk has its vector.
/// One with a chunk not embedded yet comes with its text again, which that chunk still needs.
fn known_for_helper(
    files: &RemoteFiles,
    indexed: &std::collections::HashSet<String>,
) -> Vec<serde_json::Value> {
    files
        .iter()
        .filter(|(_, f)| f.chunks.iter().all(|c| indexed.contains(&c.hash)))
        .map(|(path, f)| serde_json::json!({ "path": path, "mtime": f.mtime, "size": f.size }))
        .collect()
}

/// The chunks of what the helper sent (`root` is the project's path with a trailing slash),
/// and what to keep of each file for the next pass. A file it says is `unchanged` keeps the
/// chunks `seen` has for it, without their text. A helper from before `known` sends every
/// text and no size: nothing is kept, so it is never asked to leave any out.
fn chunks_from_walk(
    files: &[serde_json::Value],
    root: &str,
    seen: &RemoteFiles,
) -> (Vec<Chunk>, RemoteFiles) {
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut next = RemoteFiles::new();
    for f in files {
        let Some(path) = f["path"].as_str() else {
            continue;
        };
        let rel = path.strip_prefix(root).unwrap_or(path);
        if f["unchanged"].as_bool() == Some(true) {
            // Only files this side offered come back unchanged; any other can't be cut here.
            let Some(prev) = seen.get(path) else {
                continue;
            };
            chunks.extend(prev.chunks.iter().map(|c| Chunk {
                path: rel.to_string(),
                start_line: c.start_line,
                end_line: c.end_line,
                hash: c.hash.clone(),
                text: String::new(),
                known: false,
            }));
            next.insert(path.to_string(), prev.clone());
            continue;
        }
        let Some(text) = f["text"].as_str() else {
            continue;
        };
        if text.is_empty() || has_ignored_ext(Path::new(path)) || looks_binary(text.as_bytes()) {
            continue;
        }
        let first = chunks.len();
        chunk_file(rel, text, &mut chunks);
        if let (Some(mtime), Some(size)) = (f["mtime"].as_u64(), f["size"].as_u64()) {
            let kept = chunks[first..]
                .iter()
                .map(|c| SeenChunk {
                    start_line: c.start_line,
                    end_line: c.end_line,
                    hash: c.hash.clone(),
                })
                .collect();
            next.insert(
                path.to_string(),
                RemoteFile {
                    mtime,
                    size,
                    chunks: kept,
                },
            );
        }
    }
    (chunks, next)
}

/// A remote project's chunks: the helper sends its text files (secrets already left out) and
/// they are cut the same way as local ones. The index itself stays on this PC. Files whose
/// chunks are all indexed (`indexed`) and that didn't change since come without their text.
fn remote_chunks(
    workspace: &str,
    r: &crate::remote::RemotePath,
    max_bytes: u64,
    indexed: &std::collections::HashSet<String>,
) -> Result<Vec<Chunk>, String> {
    let seen = load_remote_files(workspace);
    let files = crate::remote::call_with(
        &r.host,
        "walkText",
        serde_json::json!({
            "root": r.path,
            "maxFile": max_bytes,
            "known": known_for_helper(&seen, indexed),
        }),
        Some(std::time::Duration::from_secs(300)),
    )
    .map_err(String::from)?;
    let root = format!("{}/", r.path.trim_end_matches('/'));
    let (chunks, next) = chunks_from_walk(files.as_array().map_or(&[], |v| v), &root, &seen);
    save_remote_files(workspace, &next);
    Ok(chunks)
}

/// Rebuilds the index from `current`, the project's chunks where they are now: each gets the
/// vector of its text, new (`new_entries`) or already indexed. A chunk whose file moved keeps
/// its vector under the new path, a text in two files is found in both, and a deleted file's
/// chunks leave. A chunk with no vector yet (not embedded so far) is left for the next call.
/// Another embeddings model's vectors don't count, and the index takes the new model's size.
#[tauri::command(async)]
pub fn rag_store(
    workspace: String,
    model: String,
    new_entries: Vec<StoredInput>,
    current: Vec<ChunkRef>,
) -> Result<Stats, String> {
    let old = load_index(&workspace);
    let same_model = old.model == model;
    let mut vectors: HashMap<&str, &[f32]> = HashMap::new();
    if same_model {
        for e in &old.entries {
            vectors.entry(e.hash.as_str()).or_insert(&e.vector);
        }
    }
    let fresh: Vec<(String, Vec<f32>)> = new_entries
        .into_iter()
        .map(|e| (e.hash, normalize(e.vector)))
        .collect();
    for (hash, v) in &fresh {
        vectors.insert(hash.as_str(), v);
    }

    let mut dim = if same_model { old.dim } else { 0 };
    let mut seen = std::collections::HashSet::new();
    let mut entries = Vec::new();
    for c in current {
        let Some(v) = vectors.get(c.hash.as_str()) else {
            continue;
        };
        if !seen.insert((c.path.clone(), c.start_line)) {
            continue;
        }
        if dim == 0 {
            dim = v.len();
        }
        if v.len() != dim {
            continue;
        }
        entries.push(IndexEntry {
            path: c.path,
            start_line: c.start_line,
            end_line: c.end_line,
            hash: c.hash,
            vector: v.to_vec(),
        });
    }
    if entries.is_empty() {
        dim = 0;
    }
    let idx = save_index(
        &workspace,
        Index {
            model,
            dim,
            entries,
        },
    )?;
    stats_from(&workspace, &idx)
}

fn stats_from(workspace: &str, idx: &Index) -> Result<Stats, String> {
    let files: std::collections::HashSet<&str> =
        idx.entries.iter().map(|e| e.path.as_str()).collect();
    Ok(Stats {
        chunks: idx.entries.len(),
        files: files.len(),
        model: idx.model.clone(),
        dim: idx.dim,
        exists: index_path(workspace).exists(),
    })
}

#[tauri::command(async)]
pub fn rag_stats(workspace: String) -> Result<Stats, String> {
    let idx = load_index(&workspace);
    stats_from(&workspace, &idx)
}

#[cfg(test)]
fn rag_clear(workspace: String) -> Result<(), String> {
    let p = index_path(&workspace);
    cache().remove(&p);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("Couldn't delete the index: {e}"))?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn rag_search(
    workspace: String,
    vector: Vec<f32>,
    top_k: Option<usize>,
) -> Result<Vec<Hit>, String> {
    let idx = load_index(&workspace);
    if idx.entries.is_empty() {
        return Ok(Vec::new());
    }
    let q = normalize(vector);
    if q.len() != idx.dim {
        return Err(format!(
            "Query dimension ({}) ≠ index dimension ({}). Did the embeddings model change? Re-index.",
            q.len(),
            idx.dim
        ));
    }
    let k = top_k.unwrap_or(8).clamp(1, 50);
    let mut scored: Vec<(f32, &IndexEntry)> = idx
        .entries
        .iter()
        .map(|e| {
            let dot: f32 = e.vector.iter().zip(q.iter()).map(|(a, b)| a * b).sum();
            (dot, e)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(k);

    let root = Path::new(&workspace);
    let mut hits = Vec::with_capacity(scored.len());
    for (score, e) in scored {
        let snippet = read_lines(root, &e.path, e.start_line, e.end_line)
            .unwrap_or_else(|| "[couldn't read the snippet]".to_string());
        hits.push(Hit {
            path: e.path.clone(),
            start_line: e.start_line,
            end_line: e.end_line,
            score,
            snippet,
        });
    }
    Ok(hits)
}

fn read_lines(root: &Path, rel: &str, start: usize, end: usize) -> Option<String> {
    let root_text = root.to_string_lossy();
    let content = if crate::remote::is_remote(&root_text) {
        crate::agent::vfs::read_to_string(&crate::agent::vfs::join(&root_text, rel)).ok()?
    } else {
        let full = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        fs::read_to_string(&full).ok()?
    };
    let lines: Vec<&str> = content.lines().collect();
    let s = start.saturating_sub(1);
    let e = end.min(lines.len());
    if s >= e {
        return None;
    }
    Some(lines[s..e].join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashSet;

    fn tmp_ws(name: &str) -> PathBuf {
        std::env::set_var(
            "NYXS_PROJECTS_ROOT",
            std::env::temp_dir().join("nyxs-test-projects"),
        );
        let dir = std::env::temp_dir().join(format!("nyxs-rag-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn chunks_overlap_and_track_lines() {
        let content = (1..=120)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut out = Vec::new();
        chunk_file("a.rs", &content, &mut out);
        assert!(out.len() >= 2, "120 lines should produce more than 1 chunk");
        assert_eq!(out[0].start_line, 1);
        assert_eq!(out[0].end_line, CHUNK_LINES);
        assert_eq!(out[1].start_line, CHUNK_LINES - CHUNK_OVERLAP + 1);
        assert_eq!(out[0].hash, fnv1a(&out[0].text));
    }

    #[test]
    fn normalize_makes_unit_vectors() {
        let v = normalize(vec![3.0, 4.0]);
        let norm = (v[0] * v[0] + v[1] * v[1]).sqrt();
        assert!((norm - 1.0).abs() < 1e-6);
    }

    #[test]
    fn store_then_search_ranks_by_similarity() {
        let ws = tmp_ws("search");
        let ws_str = ws.to_string_lossy().to_string();
        fs::write(ws.join("auth.rs"), "fn login() {}\nfn logout() {}\n").unwrap();
        fs::write(ws.join("math.rs"), "fn add() {}\nfn sub() {}\n").unwrap();

        let entries = vec![
            StoredInput {
                hash: "h1".into(),
                vector: vec![1.0, 0.0, 0.0],
            },
            StoredInput {
                hash: "h2".into(),
                vector: vec![0.0, 1.0, 0.0],
            },
        ];
        let all = vec![at("auth.rs", 1, 2, "h1"), at("math.rs", 1, 2, "h2")];
        let stats = rag_store(ws_str.clone(), "mock:test".into(), entries, all).unwrap();
        assert_eq!(stats.chunks, 2);
        assert_eq!(stats.files, 2);
        assert_eq!(stats.dim, 3);

        let hits = rag_search(ws_str.clone(), vec![0.9, 0.1, 0.0], Some(2)).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "auth.rs");
        assert!(hits[0].score > hits[1].score);
        assert!(hits[0].snippet.contains("login"));

        let stats2 = rag_store(
            ws_str.clone(),
            "mock:test".into(),
            vec![],
            vec![at("auth.rs", 1, 2, "h1")],
        )
        .unwrap();
        assert_eq!(stats2.chunks, 1);

        rag_clear(ws_str).unwrap();
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_damaged_index_is_moved_aside_and_rebuilt() {
        let ws = tmp_ws("corrupt");
        let ws_str = ws.to_string_lossy().to_string();
        let p = index_path(&ws_str);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, "{\"model\": \"m\", \"entr").unwrap();

        assert_eq!(rag_stats(ws_str.clone()).unwrap().chunks, 0);
        assert!(!p.exists());
        let aside = p.with_extension("json.corrupt");
        assert!(aside.exists(), "the damaged index should be kept aside");

        let entries = vec![StoredInput {
            hash: "h".into(),
            vector: vec![1.0, 0.0],
        }];
        assert_eq!(
            rag_store(
                ws_str.clone(),
                "m".into(),
                entries,
                vec![at("a.rs", 1, 1, "h")]
            )
            .unwrap()
            .chunks,
            1
        );

        rag_clear(ws_str).unwrap();
        let _ = fs::remove_file(&aside);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_cached_index_is_reread_when_the_file_changes() {
        let ws = tmp_ws("cache");
        let ws_str = ws.to_string_lossy().to_string();
        let one = vec![StoredInput {
            hash: "h1".into(),
            vector: vec![1.0, 0.0],
        }];
        rag_store(
            ws_str.clone(),
            "m".into(),
            one,
            vec![at("a.rs", 1, 1, "h1")],
        )
        .unwrap();
        let first = load_index(&ws_str);
        assert!(
            Arc::ptr_eq(&first, &load_index(&ws_str)),
            "with no changes the in-memory index is reused"
        );

        // Another window rewrites the file: the size changes, so it is read again.
        let mut other = Index::clone(&first);
        other.entries.push(IndexEntry {
            path: "b.rs".into(),
            start_line: 1,
            end_line: 1,
            hash: "h2".into(),
            vector: vec![0.0, 1.0],
        });
        fs::write(index_path(&ws_str), serde_json::to_string(&other).unwrap()).unwrap();
        assert_eq!(load_index(&ws_str).entries.len(), 2);

        rag_clear(ws_str.clone()).unwrap();
        assert_eq!(load_index(&ws_str).entries.len(), 0);
        let _ = fs::remove_dir_all(&ws);
    }

    fn at(path: &str, start: usize, end: usize, hash: &str) -> ChunkRef {
        ChunkRef {
            path: path.into(),
            start_line: start,
            end_line: end,
            hash: hash.into(),
        }
    }

    fn vector(hash: &str, v: Vec<f32>) -> StoredInput {
        StoredInput {
            hash: hash.into(),
            vector: v,
        }
    }

    #[test]
    fn a_moved_file_keeps_its_vectors_under_the_new_path() {
        let ws = tmp_ws("moved");
        let ws_str = ws.to_string_lossy().to_string();
        fs::write(ws.join("new.rs"), "fn login() {}\n").unwrap();
        rag_store(
            ws_str.clone(),
            "m".into(),
            vec![vector("h1", vec![1.0, 0.0])],
            vec![at("old.rs", 1, 1, "h1")],
        )
        .unwrap();
        // old.rs became new.rs: same text, nothing to embed again.
        let stats = rag_store(
            ws_str.clone(),
            "m".into(),
            vec![],
            vec![at("new.rs", 1, 1, "h1")],
        )
        .unwrap();
        let hits = rag_search(ws_str.clone(), vec![1.0, 0.0], None).unwrap();
        rag_clear(ws_str).unwrap();
        let _ = fs::remove_dir_all(&ws);
        assert_eq!(stats.chunks, 1);
        assert_eq!(hits[0].path, "new.rs");
        assert!(hits[0].snippet.contains("login"), "{}", hits[0].snippet);
    }

    #[test]
    fn the_same_text_in_two_files_is_found_in_both() {
        let ws = tmp_ws("dup");
        let ws_str = ws.to_string_lossy().to_string();
        let stats = rag_store(
            ws_str.clone(),
            "m".into(),
            vec![vector("h1", vec![1.0, 0.0])],
            vec![at("a.rs", 1, 1, "h1"), at("b.rs", 5, 5, "h1")],
        )
        .unwrap();
        let paths: Vec<String> = load_index(&ws_str)
            .entries
            .iter()
            .map(|e| e.path.clone())
            .collect();
        rag_clear(ws_str).unwrap();
        let _ = fs::remove_dir_all(&ws);
        assert_eq!(stats.files, 2);
        assert_eq!(paths, ["a.rs", "b.rs"]);
    }

    #[test]
    fn a_deleted_files_chunks_leave_the_index() {
        let ws = tmp_ws("deleted");
        let ws_str = ws.to_string_lossy().to_string();
        rag_store(
            ws_str.clone(),
            "m".into(),
            vec![vector("h1", vec![1.0, 0.0]), vector("h2", vec![0.0, 1.0])],
            vec![at("a.rs", 1, 1, "h1"), at("gone.rs", 1, 1, "h2")],
        )
        .unwrap();
        let stats = rag_store(
            ws_str.clone(),
            "m".into(),
            vec![],
            vec![at("a.rs", 1, 1, "h1")],
        )
        .unwrap();
        rag_clear(ws_str).unwrap();
        let _ = fs::remove_dir_all(&ws);
        assert_eq!((stats.chunks, stats.files), (1, 1));
    }

    #[test]
    fn a_new_embeddings_model_starts_a_new_index_with_its_own_size() {
        let ws = tmp_ws("model");
        let ws_str = ws.to_string_lossy().to_string();
        fs::write(ws.join("a.rs"), "fn a() {}\n").unwrap();
        rag_store(
            ws_str.clone(),
            "old".into(),
            vec![vector("h1", vec![1.0, 0.0])],
            vec![at("a.rs", 1, 1, "h1")],
        )
        .unwrap();
        let stats = rag_store(
            ws_str.clone(),
            "new".into(),
            vec![vector("h1", vec![0.0, 0.0, 1.0])],
            vec![at("a.rs", 1, 1, "h1")],
        )
        .unwrap();
        let found = rag_search(ws_str.clone(), vec![0.0, 0.0, 1.0], None);
        rag_clear(ws_str).unwrap();
        let _ = fs::remove_dir_all(&ws);
        assert_eq!(
            (stats.model.as_str(), stats.dim, stats.chunks),
            ("new", 3, 1)
        );
        assert_eq!(found.unwrap().len(), 1);
    }

    #[test]
    fn collecting_leaves_out_the_text_of_chunks_already_indexed() {
        let ws = tmp_ws("known");
        let ws_str = ws.to_string_lossy().to_string();
        fs::write(ws.join("a.rs"), "fn a() {}\n").unwrap();
        fs::write(ws.join("b.rs"), "fn b() {}\n").unwrap();
        let first = rag_collect_chunks(ws_str.clone(), None, Some("m".into())).unwrap();
        assert!(first.iter().all(|c| !c.known && !c.text.is_empty()));
        let a = first.iter().find(|c| c.path == "a.rs").unwrap();
        let refs: Vec<ChunkRef> = first
            .iter()
            .map(|c| at(&c.path, c.start_line, c.end_line, &c.hash))
            .collect();
        rag_store(
            ws_str.clone(),
            "m".into(),
            vec![vector(&a.hash, vec![1.0, 0.0])],
            refs,
        )
        .unwrap();

        fs::write(ws.join("b.rs"), "fn b2() {}\n").unwrap();
        let again = rag_collect_chunks(ws_str.clone(), None, Some("m".into())).unwrap();
        let other_model = rag_collect_chunks(ws_str.clone(), None, Some("other".into())).unwrap();
        rag_clear(ws_str).unwrap();
        let _ = fs::remove_dir_all(&ws);
        let a2 = again.iter().find(|c| c.path == "a.rs").unwrap();
        let b2 = again.iter().find(|c| c.path == "b.rs").unwrap();
        assert!(
            a2.known && a2.text.is_empty(),
            "a known chunk's text crossed over"
        );
        assert!(!b2.known && b2.text.contains("b2"));
        assert!(other_model.iter().all(|c| !c.known && !c.text.is_empty()));
    }

    #[test]
    fn search_rejects_dim_mismatch() {
        let ws = tmp_ws("dim");
        let ws_str = ws.to_string_lossy().to_string();
        let entries = vec![StoredInput {
            hash: "h".into(),
            vector: vec![1.0, 0.0],
        }];
        rag_store(
            ws_str.clone(),
            "m".into(),
            entries,
            vec![at("a.rs", 1, 1, "h")],
        )
        .unwrap();
        assert!(rag_search(ws_str.clone(), vec![1.0, 0.0, 0.0], None).is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    const ROOT: &str = "/home/me/app/";

    fn text_file(name: &str, mtime: u64, text: &str) -> serde_json::Value {
        json!({ "path": format!("{ROOT}{name}"), "mtime": mtime, "size": text.len(), "text": text })
    }

    fn refs(chunks: &[Chunk]) -> Vec<(String, usize, usize, String)> {
        chunks
            .iter()
            .map(|c| (c.path.clone(), c.start_line, c.end_line, c.hash.clone()))
            .collect()
    }

    #[test]
    fn a_remote_file_that_didnt_change_isnt_sent_again() {
        let a = "export const a = 1;\n".repeat(70);
        let first = [text_file("src/a.ts", 10, &a), text_file("b.ts", 20, "b\n")];
        let (chunks, seen) = chunks_from_walk(&first, ROOT, &RemoteFiles::new());
        assert_eq!(chunks.len(), 3, "a.ts in two chunks and b.ts in one");
        assert_eq!(seen.len(), 2);

        // Nothing is offered as known while its vectors aren't in the index.
        assert!(known_for_helper(&seen, &HashSet::new()).is_empty());
        let indexed: HashSet<String> = chunks.iter().map(|c| c.hash.clone()).collect();
        let mut offered = known_for_helper(&seen, &indexed);
        offered.sort_by_key(|k| k["path"].as_str().unwrap().to_string());
        assert_eq!(
            offered,
            [
                json!({ "path": format!("{ROOT}b.ts"), "mtime": 20, "size": 2 }),
                json!({ "path": format!("{ROOT}src/a.ts"), "mtime": 10, "size": a.len() }),
            ]
        );

        // The helper says a.ts didn't change and sends b.ts's new text.
        let second = [
            json!({ "path": format!("{ROOT}src/a.ts"), "mtime": 10, "size": a.len(), "unchanged": true }),
            text_file("b.ts", 21, "b changed\n"),
        ];
        let (again, seen2) = chunks_from_walk(&second, ROOT, &seen);
        let a_before: Vec<_> = refs(&chunks)
            .into_iter()
            .filter(|c| c.0 == "src/a.ts")
            .collect();
        let a_after: Vec<_> = refs(&again)
            .into_iter()
            .filter(|c| c.0 == "src/a.ts")
            .collect();
        assert_eq!(a_after, a_before);
        assert!(again
            .iter()
            .filter(|c| c.path == "src/a.ts")
            .all(|c| c.text.is_empty()));
        let b = again.iter().find(|c| c.path == "b.ts").unwrap();
        assert_eq!(b.text, "b changed");
        assert_eq!(seen2[&format!("{ROOT}b.ts")].mtime, 21);

        // A file that is gone is forgotten.
        let (_, seen3) = chunks_from_walk(&second[..1], ROOT, &seen2);
        assert_eq!(seen3.len(), 1);
    }

    #[test]
    fn an_older_helper_still_indexes_everything() {
        // It ignores `known` and sends every text, with no size: nothing is kept to offer later.
        let old = [json!({ "path": format!("{ROOT}a.ts"), "mtime": 10, "text": "a\n" })];
        let (chunks, seen) = chunks_from_walk(&old, ROOT, &RemoteFiles::new());
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "a");
        assert!(seen.is_empty());
        // An `unchanged` for a file this side never kept can't be cut: it's skipped.
        let odd =
            [json!({ "path": format!("{ROOT}x.ts"), "mtime": 1, "size": 1, "unchanged": true })];
        assert!(chunks_from_walk(&odd, ROOT, &RemoteFiles::new())
            .0
            .is_empty());
    }
}
