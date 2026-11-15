//! The plans the built-in models present in plan mode (WritePlan). They are the app's state, so
//! they live in the project's data folder, one per session, not as a `plan.md` in the project.

use std::path::PathBuf;

/// Where `session`'s plan is kept. The session id goes into a file name, so anything but letters,
/// digits, `-` and `_` becomes `_`: no id can reach outside the folder.
fn plan_path(workspace: &str, session: &str) -> Option<PathBuf> {
    let name: String = session
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if name.is_empty() {
        return None;
    }
    crate::project_paths::project_feature_dir(workspace, "plans")
        .map(|d| d.join(format!("{name}.md")))
}

/// Saves `content` as `session`'s plan, replacing the one before, and returns its path. Sync so
/// two plans of the same session land in the order they were written.
#[tauri::command]
pub fn plan_write(workspace: String, session: String, content: String) -> Result<String, String> {
    let path = plan_path(&workspace, &session)
        .ok_or_else(|| format!("No folder for the plans of {workspace}"))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    }
    crate::agent::text_io::write_atomic(&path, content.as_bytes())
        .map_err(|e| format!("Couldn't save the plan to {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project of its own under the tests' projects root, removed even when a test fails.
    struct TestProject(String);

    impl TestProject {
        fn new(name: &str) -> Self {
            std::env::set_var(
                "NYXS_PROJECTS_ROOT",
                std::env::temp_dir().join("nyxs-test-projects"),
            );
            TestProject(
                std::env::temp_dir()
                    .join(format!("nyxs-plans-test-{name}"))
                    .to_string_lossy()
                    .into_owned(),
            )
        }
    }

    impl Drop for TestProject {
        fn drop(&mut self) {
            if let Some(dir) = crate::project_paths::project_data_dir(&self.0) {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    #[test]
    fn saves_each_sessions_plan_outside_the_project() {
        let ws = TestProject::new("save");
        let a = plan_write(ws.0.clone(), "chat-a".into(), "1. First".into()).unwrap();
        let b = plan_write(ws.0.clone(), "chat-b".into(), "1. Other".into()).unwrap();
        assert_ne!(a, b);
        let data = crate::project_paths::project_feature_dir(&ws.0, "plans").unwrap();
        assert!(PathBuf::from(&a).starts_with(&data), "{a}");
        assert!(!PathBuf::from(&a).starts_with(&ws.0), "{a}");
        // A new plan of the same session replaces the old one.
        plan_write(ws.0.clone(), "chat-a".into(), "1. Revised".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "1. Revised");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "1. Other");
    }

    #[test]
    fn a_session_id_cant_reach_outside_the_plans_folder() {
        let ws = TestProject::new("escape");
        let path = plan_write(ws.0.clone(), "../../evil".into(), "x".into()).unwrap();
        let data = crate::project_paths::project_feature_dir(&ws.0, "plans").unwrap();
        assert_eq!(PathBuf::from(&path).parent(), Some(data.as_path()));
        assert!(plan_write(ws.0.clone(), String::new(), "x".into()).is_err());
    }
}
