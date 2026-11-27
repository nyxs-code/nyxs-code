//! Projects ("Proyectos"): a coordinator conversation with threads, its folders, instructions
//! and memory. Machine state of the app, never inside a repo: `<app data>/project-hubs/<id>.json`
//! and `<app data>/project-hubs/<id>/MEMORY.md`. The JSON is the frontend's (`src/lib/projects`);
//! the backend only checks it is an object and keeps it whole.

use super::*;

const MAX_HUB_BYTES: usize = 1024 * 1024;
const MAX_MEMORY_BYTES: usize = 64 * 1024;
const MEMORY_FILE: &str = "MEMORY.md";

/// `~/.nyxs[/accounts/<uid>]/project-hubs`, next to `projects/`. Tests point
/// `NYXS_PROJECTS_ROOT` at a temp folder, and the hubs go under it then.
fn hubs_root() -> Result<PathBuf, String> {
    match std::env::var("NYXS_PROJECTS_ROOT") {
        Ok(p) if !p.is_empty() => Ok(PathBuf::from(p).join(".project-hubs")),
        _ => Ok(account_scoped(home_dir()?.join(".nyxs")).join("project-hubs")),
    }
}

/// A project id as a file name: only ids the app makes (letters, digits, `-`, `_`) are taken,
/// so one can never point outside the folder.
fn checked_id(id: &str) -> Result<&str, String> {
    if id.is_empty() || id.len() > 80 || safe_component(id) != id {
        return Err(format!("Invalid project id: {id}"));
    }
    Ok(id)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubList {
    /// Each project's JSON, as saved.
    hubs: Vec<String>,
    /// Files that weren't a JSON object, moved aside as `<name>.corrupt`.
    set_aside: Vec<String>,
}

fn list_in(root: &Path) -> Result<HubList, String> {
    let mut out = HubList {
        hubs: Vec::new(),
        set_aside: Vec::new(),
    };
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => {
            return Err(format!(
                "Couldn't list the projects ({}): {e}",
                root.display()
            ))
        }
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "json"))
        .collect();
    paths.sort();
    for path in paths {
        let text = fs::read_to_string(&path)
            .map_err(|e| format!("Couldn't read the project {}: {e}", path.display()))?;
        let is_object =
            serde_json::from_str::<serde_json::Value>(&text).is_ok_and(|v| v.is_object());
        if is_object {
            out.hubs.push(text);
            continue;
        }
        let aside = path.with_extension("json.corrupt");
        match fs::rename(&path, &aside) {
            Ok(()) => {
                log::warn!(
                    "project hubs: {} wasn't valid, moved to {}",
                    path.display(),
                    aside.display()
                );
                out.set_aside.push(aside.to_string_lossy().into_owned());
            }
            Err(e) => log::warn!(
                "project hubs: {} isn't valid and couldn't be moved: {e}",
                path.display()
            ),
        }
    }
    Ok(out)
}

fn save_in(root: &Path, id: &str, json: &str) -> Result<(), String> {
    let id = checked_id(id)?;
    if json.len() > MAX_HUB_BYTES {
        return Err("The project is too large to save".to_string());
    }
    let is_object = serde_json::from_str::<serde_json::Value>(json).is_ok_and(|v| v.is_object());
    if !is_object {
        return Err("A project must be a JSON object".to_string());
    }
    fs::create_dir_all(root).map_err(|e| format!("Couldn't create the projects folder: {e}"))?;
    text_io::write_atomic(&root.join(format!("{id}.json")), json.as_bytes())
        .map_err(|e| format!("Couldn't save the project: {e}"))
}

fn delete_in(root: &Path, id: &str) -> Result<(), String> {
    let id = checked_id(id)?;
    match fs::remove_file(root.join(format!("{id}.json"))) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Couldn't delete the project: {e}")),
    }
    let _ = fs::remove_dir_all(root.join(id));
    Ok(())
}

fn memory_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(root.join(checked_id(id)?).join(MEMORY_FILE))
}

fn read_memory_in(root: &Path, id: &str) -> Result<String, String> {
    let path = memory_path(root, id)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!(
            "Couldn't read the project's memory ({}): {e}",
            path.display()
        )),
    }
}

fn write_memory_in(root: &Path, id: &str, text: &str) -> Result<(), String> {
    if text.len() > MAX_MEMORY_BYTES {
        return Err("The project's memory is too long; keep it short".to_string());
    }
    let path = memory_path(root, id)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Couldn't create the project's folder: {e}"))?;
    }
    text_io::write_atomic(&path, text.as_bytes())
        .map_err(|e| format!("Couldn't save the project's memory: {e}"))
}

/// A project's context files (Contexto in the creation dialog): copies in
/// `<id>/files/`, so threads read the same thing whatever happens to the originals.
const FILES_DIR: &str = "files";
/// Text files up to this size come with their content, for the project's prompt.
const MAX_INLINE_BYTES: u64 = 32 * 1024;
const MAX_LISTED: usize = 500;
/// Copying stops past this much, so a dropped home folder doesn't fill the disk.
const MAX_COPY_BYTES: u64 = 200 * 1024 * 1024;
/// Folders that are never context: dependencies, VCS data, build output.
const SKIPPED_DIRS: [&str; 6] = [".git", "node_modules", "target", ".venv", "dist", "build"];

fn hub_dir_in(root: &Path, id: &str) -> Result<PathBuf, String> {
    let dir = root.join(checked_id(id)?);
    fs::create_dir_all(dir.join(FILES_DIR))
        .map_err(|e| format!("Couldn't create the project's folder: {e}"))?;
    Ok(dir)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubFile {
    /// Its path under the files folder, with `/`.
    rel: String,
    size: u64,
    /// Its text, for a small UTF-8 file.
    text: Option<String>,
}

fn list_files_in(root: &Path, id: &str) -> Result<Vec<HubFile>, String> {
    let base = root.join(checked_id(id)?).join(FILES_DIR);
    let mut out = Vec::new();
    let mut stack = vec![base.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(path);
                continue;
            }
            if !kind.is_file() || out.len() >= MAX_LISTED {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let text = (size <= MAX_INLINE_BYTES)
                .then(|| fs::read(&path).ok())
                .flatten()
                .filter(|b| !b.contains(&0))
                .and_then(|b| String::from_utf8(b).ok());
            let rel = path
                .strip_prefix(&base)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            out.push(HubFile { rel, size, text });
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

/// `name`, or `name (2)`, `name (3)`… when it's taken in `dir`.
fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

fn copy_tree(from: &Path, to: &Path, budget: &mut u64) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.is_file() {
        if meta.len() > *budget {
            return Err(std::io::Error::other("the files are too large"));
        }
        *budget -= meta.len();
        fs::copy(from, to)?;
        return Ok(());
    }
    if !meta.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)?.flatten() {
        let name = entry.file_name();
        if SKIPPED_DIRS.iter().any(|s| name == *s) {
            continue;
        }
        copy_tree(&entry.path(), &to.join(&name), budget)?;
    }
    Ok(())
}

/// Copies files and folders into the project's files. Returns the names they got there.
fn add_files_in(root: &Path, id: &str, paths: &[String]) -> Result<Vec<String>, String> {
    let dir = hub_dir_in(root, id)?.join(FILES_DIR);
    let mut budget = MAX_COPY_BYTES;
    let mut added = Vec::new();
    for p in paths {
        let from = PathBuf::from(p);
        let Some(name) = from.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let to = free_name(&dir, &name);
        if let Err(e) = copy_tree(&from, &to, &mut budget) {
            let _ = fs::remove_dir_all(&to);
            let _ = fs::remove_file(&to);
            return Err(format!("Couldn't copy {p} into the project: {e}"));
        }
        added.push(
            to.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or(name),
        );
    }
    Ok(added)
}

/// Removes one of the project's files or folders, by its path under the files folder.
fn remove_file_in(root: &Path, id: &str, rel: &str) -> Result<(), String> {
    let rel = rel.trim_matches(|c| c == '/' || c == '\\');
    // Only plain names: a drive (`C:`), a root or `..` would make `join` leave the folder.
    let plain = |part: &str| {
        let mut parts = Path::new(part).components();
        matches!(
            (parts.next(), parts.next()),
            (Some(std::path::Component::Normal(_)), None)
        )
    };
    let bad = rel.is_empty() || !rel.split(['/', '\\']).all(plain);
    if bad {
        return Err(format!("Invalid project file: {rel}"));
    }
    let base = root.join(checked_id(id)?).join(FILES_DIR);
    let path = base.join(rel);
    if !path.starts_with(&base) {
        return Err(format!("Invalid project file: {rel}"));
    }
    let gone = if path.is_dir() {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    };
    match gone {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Couldn't remove {rel}: {e}")),
    }
}

/// The project's own folder (made if missing): its memory and files live there, and the
/// coordinator works in it when the project has no folder on this computer.
#[tauri::command(async)]
pub fn nyxs_project_hub_dir(id: String) -> Result<String, String> {
    Ok(hub_dir_in(&hubs_root()?, &id)?
        .to_string_lossy()
        .into_owned())
}

#[tauri::command(async)]
pub fn nyxs_project_hub_files(id: String) -> Result<Vec<HubFile>, String> {
    list_files_in(&hubs_root()?, &id)
}

#[tauri::command(async)]
pub fn nyxs_project_hub_add_files(id: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    add_files_in(&hubs_root()?, &id, &paths)
}

#[tauri::command(async)]
pub fn nyxs_project_hub_remove_file(id: String, rel: String) -> Result<(), String> {
    remove_file_in(&hubs_root()?, &id, &rel)
}

#[tauri::command(async)]
pub fn nyxs_project_hubs_list() -> Result<HubList, String> {
    list_in(&hubs_root()?)
}

#[tauri::command(async)]
pub fn nyxs_project_hubs_save(id: String, json: String) -> Result<(), String> {
    save_in(&hubs_root()?, &id, &json)
}

#[tauri::command(async)]
pub fn nyxs_project_hubs_delete(id: String) -> Result<(), String> {
    delete_in(&hubs_root()?, &id)
}

#[tauri::command(async)]
pub fn nyxs_project_hub_memory_read(id: String) -> Result<String, String> {
    read_memory_in(&hubs_root()?, &id)
}

#[tauri::command(async)]
pub fn nyxs_project_hub_memory_write(id: String, text: String) -> Result<(), String> {
    write_memory_in(&hubs_root()?, &id, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hubs folder of its own in the temp folder, removed even when the test fails.
    struct Root(PathBuf);

    impl Root {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("nyxs-project-hubs-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            Root(dir)
        }
    }

    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn saves_lists_and_deletes_a_project_with_its_memory() {
        let root = Root::new("cycle");
        assert_eq!(list_in(&root.0).unwrap().hubs, Vec::<String>::new());
        save_in(&root.0, "p-1", r#"{"id":"p-1","name":"App"}"#).unwrap();
        write_memory_in(&root.0, "p-1", "- uses pnpm\n").unwrap();
        assert_eq!(
            list_in(&root.0).unwrap().hubs,
            vec![r#"{"id":"p-1","name":"App"}"#.to_string()]
        );
        assert_eq!(read_memory_in(&root.0, "p-1").unwrap(), "- uses pnpm\n");
        assert_eq!(read_memory_in(&root.0, "none").unwrap(), "");
        delete_in(&root.0, "p-1").unwrap();
        assert!(list_in(&root.0).unwrap().hubs.is_empty());
        assert_eq!(read_memory_in(&root.0, "p-1").unwrap(), "");
        // Deleting again is fine.
        delete_in(&root.0, "p-1").unwrap();
    }

    #[test]
    fn refuses_ids_that_leave_the_folder_and_json_that_isnt_an_object() {
        let root = Root::new("checks");
        for bad in ["", "../x", "a/b", r"a\b", "a.b"] {
            assert!(save_in(&root.0, bad, "{}").is_err(), "{bad}");
            assert!(write_memory_in(&root.0, bad, "x").is_err(), "{bad}");
        }
        assert!(save_in(&root.0, "p", "[1]").is_err());
        assert!(save_in(&root.0, "p", "not json").is_err());
        assert!(write_memory_in(&root.0, "p", &"x".repeat(MAX_MEMORY_BYTES + 1)).is_err());
    }

    #[test]
    fn a_broken_file_is_moved_aside_not_dropped() {
        let root = Root::new("corrupt");
        save_in(&root.0, "good", r#"{"id":"good"}"#).unwrap();
        fs::write(root.0.join("bad.json"), "{ half").unwrap();
        let list = list_in(&root.0).unwrap();
        assert_eq!(list.hubs, vec![r#"{"id":"good"}"#.to_string()]);
        assert_eq!(list.set_aside.len(), 1);
        assert!(root.0.join("bad.json.corrupt").is_file());
        assert!(!root.0.join("bad.json").exists());
    }

    #[test]
    fn context_files_are_copied_listed_and_removed() {
        let root = Root::new("files");
        let src = root.0.join("src");
        fs::create_dir_all(src.join("docs").join("node_modules")).unwrap();
        fs::write(src.join("brief.md"), "# Brief\n").unwrap();
        fs::write(src.join("docs").join("api.txt"), "GET /x").unwrap();
        fs::write(src.join("docs").join("logo.bin"), [0u8, 1, 2]).unwrap();
        fs::write(src.join("docs").join("node_modules").join("dep.js"), "x").unwrap();
        let p = |x: &Path| x.to_string_lossy().into_owned();
        let added = add_files_in(
            &root.0,
            "p",
            &[p(&src.join("brief.md")), p(&src.join("docs"))],
        )
        .unwrap();
        assert_eq!(added, vec!["brief.md", "docs"]);
        // The same name again gets a name of its own.
        let again = add_files_in(&root.0, "p", &[p(&src.join("brief.md"))]).unwrap();
        assert_eq!(again, vec!["brief (2).md"]);
        let listed = list_files_in(&root.0, "p").unwrap();
        let rels: Vec<&str> = listed.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(
            rels,
            vec!["brief (2).md", "brief.md", "docs/api.txt", "docs/logo.bin"]
        );
        assert_eq!(listed[1].text.as_deref(), Some("# Brief\n"));
        assert_eq!(listed[3].text, None);
        assert!(remove_file_in(&root.0, "p", "../p.json").is_err());
        for bad in ["docs/../..", "docs/./x", ""] {
            assert!(remove_file_in(&root.0, "p", bad).is_err(), "{bad}");
        }
        // A drive would replace the folder in `join` on Windows.
        #[cfg(windows)]
        for bad in ["C:", "C:/Users", r"C:\Users\x"] {
            assert!(remove_file_in(&root.0, "p", bad).is_err(), "{bad}");
        }
        remove_file_in(&root.0, "p", "docs").unwrap();
        remove_file_in(&root.0, "p", "brief (2).md").unwrap();
        let rels: Vec<String> = list_files_in(&root.0, "p")
            .unwrap()
            .into_iter()
            .map(|f| f.rel)
            .collect();
        assert_eq!(rels, vec!["brief.md"]);
    }
}
