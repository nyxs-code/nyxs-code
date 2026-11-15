use super::*;

#[derive(Serialize)]
pub struct SkillInfo {
    name: String,
    dir: String,
    content: String,
    source: String,
}

fn scan_skills_dir(root: &str, source: &str, out: &mut Vec<SkillInfo>) {
    let entries = match super::vfs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries {
        if !entry.is_dir || entry.name.starts_with('.') {
            continue;
        }
        let dir = super::vfs::join(root, &entry.name);
        let content = match super::vfs::read_to_string(&super::vfs::join(&dir, "SKILL.md")) {
            Ok(c) => c,
            Err(_) => continue,
        };
        out.push(SkillInfo {
            name: entry.name,
            dir,
            content,
            source: source.to_string(),
        });
    }
}

const SKILL_BASE_DIRS: &[&str] = &[".nyxs", ".claude"];

#[tauri::command(async)]
pub fn agent_list_skills(workspace: Option<String>) -> Result<Vec<SkillInfo>, String> {
    let mut skills: Vec<SkillInfo> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut add_from = |dir: &str, source: &str| {
        let mut found = Vec::new();
        scan_skills_dir(dir, source, &mut found);
        for s in found {
            if seen.insert(s.name.clone()) {
                skills.push(s);
            }
        }
    };

    if let Some(ws) = &workspace {
        if !ws.is_empty() {
            for base in SKILL_BASE_DIRS {
                add_from(
                    &super::vfs::join(&super::vfs::join(ws, base), "skills"),
                    "project",
                );
            }
        }
    }

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok();
    if let Some(home) = home {
        for base in SKILL_BASE_DIRS {
            add_from(
                &Path::new(&home).join(base).join("skills").to_string_lossy(),
                "user",
            );
        }
    }

    Ok(skills)
}

#[tauri::command(async)]
pub fn agent_read_memory(workspace: String) -> Result<String, String> {
    if workspace.is_empty() {
        return Ok(String::new());
    }
    let candidates = [
        super::vfs::join(&workspace, "NYXS.md"),
        super::vfs::join(&super::vfs::join(&workspace, ".nyxs"), "NYXS.md"),
        super::vfs::join(&workspace, "AGENTS.md"),
        super::vfs::join(&workspace, "CLAUDE.md"),
    ];
    for path in candidates {
        if let Ok(content) = super::vfs::read_to_string(&path) {
            if !content.trim().is_empty() {
                return Ok(content);
            }
        }
    }
    Ok(String::new())
}

/// The memory Claude Code keeps for a project (auto-memory): its folder and the `MEMORY.md` index.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMemory {
    dir: String,
    index: String,
}

/// Claude Code names a project's folder after its path with every non-alphanumeric character
/// turned into `-` (`D:\optimicer` → `D--optimicer`).
fn claude_project_slug(workspace: &str) -> String {
    workspace
        .trim_end_matches(['\\', '/'])
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn claude_config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|h| PathBuf::from(h).join(".claude"))
}

fn claude_memory_dir(projects: &Path, workspace: &str) -> Option<PathBuf> {
    let slug = claude_project_slug(workspace);
    let exact = projects.join(&slug).join("memory");
    if exact.is_dir() {
        return Some(exact);
    }
    // Long paths are cut to 200 characters plus a hash suffix: match on the cut prefix.
    if slug.len() <= 200 {
        return None;
    }
    let prefix = &slug[..200];
    fs::read_dir(projects)
        .ok()?
        .filter_map(|e| e.ok())
        .find(|e| e.file_name().to_string_lossy().starts_with(prefix))
        .map(|e| e.path().join("memory"))
        .filter(|p| p.is_dir())
}

/// Claude Code's memory for this project, so other providers' models can follow it too.
#[tauri::command]
pub fn agent_read_claude_memory(workspace: String) -> Result<Option<ClaudeMemory>, String> {
    if workspace.is_empty() {
        return Ok(None);
    }
    let Some(config) = claude_config_dir() else {
        return Ok(None);
    };
    let Some(dir) = claude_memory_dir(&config.join("projects"), &workspace) else {
        return Ok(None);
    };
    let index = fs::read_to_string(dir.join("MEMORY.md")).unwrap_or_default();
    if index.trim().is_empty() {
        return Ok(None);
    }
    // The index only carries one line per memory: the model has to open each file with Read,
    // and the folder sits outside the workspace. Readable, never writable: these are Claude
    // Code's notes, not the other models' to edit.
    super::scope::add_read_only_root(dir.clone());
    Ok(Some(ClaudeMemory {
        dir: dir.to_string_lossy().to_string(),
        index,
    }))
}

#[tauri::command(async)]
pub fn nyxs_read_text(path: String) -> Result<String, String> {
    confine(&path, None)?;
    Ok(agent_read_text(path, None, None)
        .ok()
        .flatten()
        .map(ReadText::into_text)
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_project_slug_matches_claude_code() {
        assert_eq!(claude_project_slug(r"D:\optimicer"), "D--optimicer");
        assert_eq!(
            claude_project_slug(r"C:\Users\alice\.nyxs\x\"),
            "C--Users-alice--nyxs-x"
        );
        assert_eq!(claude_project_slug("/home/me/my_app"), "-home-me-my-app");
    }

    /// Other providers' models get the index in their prompt and must then open each memory
    /// with Read: the folder is outside the workspace, so finding it has to open it for reading
    /// (and only for reading).
    #[test]
    fn claude_memory_folder_becomes_readable_but_not_writable() {
        let base = std::env::temp_dir().join(format!("nyxs-claude-mem-{}", std::process::id()));
        let ws = base.join("ws");
        let config = base.join("claude");
        let mem = config
            .join("projects")
            .join(claude_project_slug(&ws.to_string_lossy()))
            .join("memory");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&mem).unwrap();
        fs::write(
            mem.join("MEMORY.md"),
            "- [Lang](lang.md) — reply in Spanish",
        )
        .unwrap();
        fs::write(mem.join("lang.md"), "Reply in Spanish.").unwrap();
        let note = mem.join("lang.md").to_string_lossy().to_string();

        agent_set_path_scope(
            "scope-claude-mem".into(),
            vec![ws.to_string_lossy().to_string()],
        );
        assert!(super::super::scope::confine(&note, Some("scope-claude-mem")).is_err());

        std::env::set_var("CLAUDE_CONFIG_DIR", &config);
        let found = agent_read_claude_memory(ws.to_string_lossy().to_string()).unwrap();
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert!(found.is_some_and(|m| m.index.contains("lang.md")));

        assert!(super::super::scope::confine(&note, Some("scope-claude-mem")).is_ok());
        assert!(
            super::super::scope::confine_write(&note, Some("scope-claude-mem"), false).is_err()
        );
        let _ = fs::remove_dir_all(&base);
    }
}
