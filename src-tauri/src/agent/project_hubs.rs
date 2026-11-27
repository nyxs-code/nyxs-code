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
}
