use std::io::{Read, Write};
use std::sync::OnceLock;

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessArgs {
    pub prompt: String,
    pub format: String,
    pub cwd: String,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    /// `--max-steps`: the most model steps (tool rounds) the run may take, 1 to 1000.
    pub max_steps: Option<u32>,
    /// `--save-session <file>`: where the run's transcript goes as JSON, for evals.
    pub save_session: Option<String>,
}

/// The most steps `--max-steps` takes: past it a run is effectively unbounded anyway.
const MAX_STEPS_LIMIT: u32 = 1000;

static ARGS: OnceLock<Option<HeadlessArgs>> = OnceLock::new();

pub fn parse(args: &[String], cwd: &str) -> Option<HeadlessArgs> {
    let mut prompt: Option<String> = None;
    let mut format = "text".to_string();
    let mut dir = cwd.to_string();
    let mut model = None;
    let mut permission_mode = None;
    let mut max_steps = None;
    let mut save_session = None;
    let mut i = 1;
    while i < args.len() {
        let a = args[i].as_str();
        let value = args.get(i + 1).cloned();
        match a {
            "-p" | "--prompt" => {
                prompt = Some(value.unwrap_or_default());
                i += 1;
            }
            "--format" | "--output-format" => {
                format = value.unwrap_or_else(|| "text".into());
                i += 1;
            }
            "--cwd" => {
                dir = value.unwrap_or(dir);
                i += 1;
            }
            "--model" => {
                model = value;
                i += 1;
            }
            "--permission-mode" => {
                permission_mode = value;
                i += 1;
            }
            "--max-steps" => {
                // Anything else than a whole number in range is ignored (the default applies).
                max_steps = value
                    .and_then(|v| v.trim().parse::<u32>().ok())
                    .filter(|n| (1..=MAX_STEPS_LIMIT).contains(n));
                i += 1;
            }
            "--save-session" => {
                save_session = value.filter(|v| !v.trim().is_empty());
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    let mut prompt = prompt?;
    if prompt == "-" {
        let mut buf = String::new();
        let _ = std::io::stdin().read_to_string(&mut buf);
        prompt = buf;
    }
    if format != "json" {
        format = "text".into();
    }
    Some(HeadlessArgs {
        prompt,
        format,
        cwd: dir,
        model,
        permission_mode,
        max_steps,
        save_session,
    })
}

pub fn args() -> Option<HeadlessArgs> {
    ARGS.get_or_init(|| {
        let argv: Vec<String> = std::env::args().collect();
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        parse(&argv, &cwd)
    })
    .clone()
}

pub fn is_headless() -> bool {
    args().is_some()
}

#[cfg(windows)]
fn attach_console() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        use windows_sys::Win32::System::Console::{
            AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE,
        };
        let handle = GetStdHandle(STD_OUTPUT_HANDLE);
        if handle.is_null() {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    });
}

#[cfg(not(windows))]
fn attach_console() {}

#[tauri::command]
pub fn nyxs_headless_args() -> Option<HeadlessArgs> {
    args()
}

#[tauri::command]
pub fn nyxs_headless_write(text: String, stderr: Option<bool>) {
    if !is_headless() {
        return;
    }
    attach_console();
    if stderr.unwrap_or(false) {
        let mut err = std::io::stderr();
        let _ = err.write_all(text.as_bytes());
        let _ = err.flush();
    } else {
        let mut out = std::io::stdout();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }
}

/// Writes the run's transcript to the file `--save-session` named (relative to `--cwd`). Only
/// in headless mode, and only to that one path: the page can't pick another.
#[tauri::command(async)]
pub fn nyxs_headless_save_session(json: String) -> Result<String, String> {
    let args = args().ok_or("Not in headless mode")?;
    let target = args.save_session.ok_or("No --save-session was given")?;
    let path = session_path(&args.cwd, &target);
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    crate::agent::text_io::write_atomic(&path, json.as_bytes())
        .map_err(|e| format!("Couldn't save the session to {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

fn session_path(cwd: &str, target: &str) -> std::path::PathBuf {
    let p = std::path::Path::new(target);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::path::Path::new(cwd).join(p)
    }
}

#[tauri::command]
pub fn nyxs_headless_exit(app: tauri::AppHandle, code: i32) {
    if is_headless() {
        app.exit(code);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_prompt_and_options() {
        let a = parse(
            &argv(&[
                "nyxs",
                "-p",
                "fix the build",
                "--format",
                "json",
                "--cwd",
                "E:\\ws",
                "--model",
                "anthropic:claude",
            ]),
            "C:\\",
        )
        .unwrap();
        assert_eq!(a.prompt, "fix the build");
        assert_eq!(a.format, "json");
        assert_eq!(a.cwd, "E:\\ws");
        assert_eq!(a.model.as_deref(), Some("anthropic:claude"));
    }

    #[test]
    fn takes_a_step_limit_and_a_session_file() {
        let a = parse(
            &argv(&[
                "nyxs",
                "-p",
                "x",
                "--max-steps",
                "25",
                "--save-session",
                "out/run.json",
            ]),
            "C:\\",
        )
        .unwrap();
        assert_eq!(a.max_steps, Some(25));
        assert_eq!(a.save_session.as_deref(), Some("out/run.json"));
        for bad in ["0", "-3", "abc", "5000"] {
            let a = parse(&argv(&["nyxs", "-p", "x", "--max-steps", bad]), "C:\\").unwrap();
            assert_eq!(a.max_steps, None, "{bad}");
        }
        assert_eq!(
            parse(&argv(&["nyxs", "-p", "x"]), "C:\\")
                .unwrap()
                .save_session,
            None
        );
    }

    #[test]
    fn a_relative_session_file_goes_under_the_working_folder() {
        let cwd = std::env::temp_dir();
        let abs = cwd.join("elsewhere").join("run.json");
        assert_eq!(
            session_path(&cwd.to_string_lossy(), "out/run.json"),
            cwd.join("out/run.json")
        );
        assert_eq!(session_path("ignored", &abs.to_string_lossy()), abs);
    }

    #[test]
    fn without_a_prompt_the_app_starts_normally() {
        assert!(parse(&argv(&["nyxs"]), "C:\\").is_none());
        assert!(parse(&argv(&["nyxs", "nyxs://open"]), "C:\\").is_none());
    }

    #[test]
    fn unknown_formats_fall_back_to_text() {
        let a = parse(
            &argv(&["nyxs", "--prompt", "hi", "--format", "yaml"]),
            "D:\\x",
        )
        .unwrap();
        assert_eq!(a.format, "text");
        assert_eq!(a.cwd, "D:\\x");
    }
}
