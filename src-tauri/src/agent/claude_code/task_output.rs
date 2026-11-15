//! Reading the end of a CLI's task output: a Claude Code task's output file, only inside the
//! CLI's own temp folder, or an Antigravity sub-agent's transcript, only inside its `brain`.

use crate::agent::*;

const TASK_OUTPUT_TAIL: u64 = 20_000;
/// A transcript is read for the sub-agent's recent steps, which take more room than output.
const TRANSCRIPT_TAIL: u64 = 200_000;

fn task_output_root() -> PathBuf {
    std::env::temp_dir().join("claude")
}

/// Where Antigravity CLI keeps each conversation, its sub-agents' among them
/// (`<id>/.system_generated/logs/transcript.jsonl`, seen in agy 1.4.12).
fn antigravity_brain_root() -> Option<PathBuf> {
    home_dir()
        .ok()
        .map(|h| h.join(".gemini").join("antigravity-cli").join("brain"))
}

fn read_task_output(path: &str, root: &Path) -> Option<String> {
    read_tail(path, root, TASK_OUTPUT_TAIL)
}

fn read_tail(path: &str, root: &Path, max: u64) -> Option<String> {
    let target = Path::new(path);
    if !target.is_absolute()
        || target
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    let resolved = target.canonicalize().ok()?;
    let root = root.canonicalize().ok()?;
    if !resolved.starts_with(&root) {
        return None;
    }
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(&resolved).ok()?;
    let len = file.metadata().ok()?.len();
    if len > max {
        file.seek(SeekFrom::Start(len - max)).ok()?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn claude_code_task_output(path: String) -> Option<String> {
    if let Some(text) = read_task_output(&path, &task_output_root()) {
        return Some(text);
    }
    let brain = antigravity_brain_root()?;
    if !path.ends_with("transcript.jsonl") {
        return None;
    }
    read_tail(&path, &brain, TRANSCRIPT_TAIL)
}

#[cfg(test)]
mod task_output_tests {
    use super::*;

    #[test]
    fn reads_only_inside_the_task_folder() {
        let root = std::env::temp_dir().join(format!("nyxs-cc-task-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let inside = root.join("out.output");
        std::fs::write(&inside, "line 1\nline 2\n").unwrap();
        assert_eq!(
            read_task_output(&inside.to_string_lossy(), &root).as_deref(),
            Some("line 1\nline 2\n")
        );
        let outside =
            std::env::temp_dir().join(format!("nyxs-cc-outside-{}.txt", std::process::id()));
        std::fs::write(&outside, "secret").unwrap();
        assert!(read_task_output(&outside.to_string_lossy(), &root).is_none());
        assert!(read_task_output("relative/path", &root).is_none());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
    }
}
