use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

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
    /// `--job`: one turn of a cloud thread (see `CloudJob`); None for a plain headless run.
    pub job: Option<CloudJob>,
    /// Why the `--job` input couldn't be used; the turn then only reports it.
    pub job_error: Option<String>,
    /// The cloud thread's saved conversation (`<work>/.nyxs/session.json`), when a turn ran before.
    pub resume: Option<String>,
    /// `<work>`, the folder that persists between a cloud thread's turns.
    pub work_dir: Option<String>,
    /// Whether `GITHUB_TOKEN` is set, so the turn can push and open a pull request.
    pub github_token: bool,
}

/// One turn of a cloud thread, as the runner sends it on stdin (docs/proyectos-nube-spec.md,
/// "Runner ↔ worker contract").
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudJob {
    pub thread_id: String,
    #[serde(default = "first_turn")]
    pub turn: u32,
    pub prompt: String,
    pub repo: CloudRepo,
    pub work_branch: String,
    #[serde(default)]
    pub model: Option<CloudModel>,
    /// Sanitized Nyxs settings: `{ providers: { <id>: { baseUrl, models, enabled… } }, nyxs? }`.
    #[serde(default)]
    pub settings: serde_json::Value,
    #[serde(default)]
    pub project_instructions: Option<String>,
    #[serde(default)]
    pub memory: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub max_steps: Option<u32>,
    /// The thread's title, for the commit and the pull request.
    #[serde(default)]
    pub title: Option<String>,
    /// Runs the whole pipeline (repo, session, events) without calling a model.
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudRepo {
    pub url: String,
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudModel {
    pub id: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

fn first_turn() -> u32 {
    1
}

/// The most steps `--max-steps` takes: past it a run is effectively unbounded anyway.
const MAX_STEPS_LIMIT: u32 = 1000;
/// Where a cloud thread's volume is mounted when `--work` doesn't say.
const DEFAULT_WORK_DIR: &str = "/work";
const WORK_ENV: &str = "NYXS_CLOUD_WORK";

static ARGS: OnceLock<Option<HeadlessArgs>> = OnceLock::new();

pub fn parse(args: &[String], cwd: &str) -> Option<HeadlessArgs> {
    parse_with(args, cwd, &read_input)
}

/// `-` is stdin, anything else a file.
fn read_input(source: &str) -> Result<String, String> {
    if source == "-" {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| format!("Couldn't read the job from stdin: {e}"))?;
        return Ok(buf);
    }
    std::fs::read_to_string(source).map_err(|e| format!("Couldn't read the job {source}: {e}"))
}

fn parse_with(
    args: &[String],
    cwd: &str,
    read: &dyn Fn(&str) -> Result<String, String>,
) -> Option<HeadlessArgs> {
    let mut prompt: Option<String> = None;
    let mut format = "text".to_string();
    let mut dir = cwd.to_string();
    let mut model = None;
    let mut permission_mode = None;
    let mut max_steps = None;
    let mut save_session = None;
    let mut job: Option<String> = None;
    let mut work: Option<String> = None;
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
            "--job" => {
                job = Some(value.unwrap_or_else(|| "-".into()));
                i += 1;
            }
            "--work" => {
                work = value.filter(|v| !v.trim().is_empty());
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    if let Some(source) = job {
        let work = work
            .or_else(|| {
                std::env::var(WORK_ENV)
                    .ok()
                    .filter(|v| !v.trim().is_empty())
            })
            .unwrap_or_else(|| DEFAULT_WORK_DIR.into());
        return Some(job_args(
            read(&source).and_then(|raw| parse_job(&raw)),
            &work,
        ));
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
        job: None,
        job_error: None,
        resume: None,
        work_dir: None,
        github_token: false,
    })
}

/// The run a cloud job asks for: JSON events, the clone in `<work>/repo` as the working folder,
/// and the conversation saved to (and resumed from) `<work>/.nyxs/session.json`.
fn job_args(job: Result<CloudJob, String>, work: &str) -> HeadlessArgs {
    let work_path = Path::new(work);
    let session = cloud_session_path(work_path);
    let resume = std::fs::read_to_string(&session)
        .ok()
        .filter(|s| !s.trim().is_empty());
    let github_token = std::env::var("GITHUB_TOKEN").is_ok_and(|t| !t.trim().is_empty());
    let (job, job_error) = match job {
        Ok(j) => (Some(j), None),
        Err(e) => (None, Some(e)),
    };
    HeadlessArgs {
        prompt: job.as_ref().map(|j| j.prompt.clone()).unwrap_or_default(),
        format: "json".into(),
        cwd: work_path.join("repo").to_string_lossy().into_owned(),
        model: job
            .as_ref()
            .and_then(|j| j.model.as_ref().map(|m| m.id.clone())),
        permission_mode: Some(
            job.as_ref()
                .and_then(|j| j.permission_mode.clone())
                .unwrap_or_else(|| "auto".into()),
        ),
        max_steps: job.as_ref().and_then(|j| j.max_steps),
        save_session: Some(session.to_string_lossy().into_owned()),
        job,
        job_error,
        resume,
        work_dir: Some(work.to_string()),
        github_token,
    }
}

fn cloud_session_path(work: &Path) -> PathBuf {
    work.join(".nyxs").join("session.json")
}

/// Reads and checks a cloud job. Whatever reaches git (URL, branches) is checked here, so a
/// malformed job can't turn into a git option or a path outside the clone.
pub fn parse_job(raw: &str) -> Result<CloudJob, String> {
    let line = raw.trim();
    if line.is_empty() {
        return Err("The job is empty".into());
    }
    let mut job: CloudJob =
        serde_json::from_str(line).map_err(|e| format!("The job isn't valid JSON: {e}"))?;
    if job.thread_id.is_empty()
        || job.thread_id.len() > 64
        || !job
            .thread_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("threadId must be 1-64 letters, digits, - or _".into());
    }
    if job.turn == 0 {
        return Err("turn starts at 1".into());
    }
    if job.prompt.trim().is_empty() {
        return Err("The job has no prompt".into());
    }
    check_repo_url(&job.repo.url)?;
    check_branch(&job.work_branch).map_err(|e| format!("workBranch: {e}"))?;
    if let Some(b) = job.repo.branch.as_deref().filter(|b| !b.trim().is_empty()) {
        check_branch(b).map_err(|e| format!("repo.branch: {e}"))?;
    } else {
        job.repo.branch = None;
    }
    let has_model = job.model.as_ref().is_some_and(|m| !m.id.trim().is_empty());
    if !has_model && !job.dry_run {
        return Err("The job names no model".into());
    }
    job.max_steps = job.max_steps.map(|n| n.clamp(1, MAX_STEPS_LIMIT));
    Ok(job)
}

/// An https URL without credentials in it (the token goes through git's credential helper), or
/// a local `file://` repository for tests.
fn check_repo_url(url: &str) -> Result<(), String> {
    let rest = if let Some(r) = url.strip_prefix("https://") {
        r
    } else if url.starts_with("file:///") {
        return Ok(());
    } else {
        return Err("repo.url must be an https:// URL".into());
    };
    let host = rest.split('/').next().unwrap_or_default();
    if host.is_empty() || host.contains('@') || rest.split('/').nth(1).is_none_or(str::is_empty) {
        return Err("repo.url must be https://host/owner/repo, without credentials".into());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("repo.url has spaces or control characters".into());
    }
    Ok(())
}

/// The parts of `git check-ref-format` a branch name from a job can break.
fn check_branch(name: &str) -> Result<(), String> {
    let ok_chars = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'));
    if name.is_empty()
        || name.len() > 200
        || !ok_chars
        || name.starts_with(['-', '/', '.'])
        || name.ends_with(['/', '.'])
        || name.ends_with(".lock")
        || name.contains("..")
        || name.contains("//")
        || name.contains("/.")
    {
        return Err(format!("{name:?} isn't a valid branch name"));
    }
    Ok(())
}

fn parsed() -> &'static Option<HeadlessArgs> {
    ARGS.get_or_init(|| {
        let argv: Vec<String> = std::env::args().collect();
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        parse(&argv, &cwd)
    })
}

pub fn args() -> Option<HeadlessArgs> {
    parsed().clone()
}

pub fn is_headless() -> bool {
    parsed().is_some()
}

fn is_cloud_job() -> bool {
    parsed()
        .as_ref()
        .is_some_and(|a| a.job.is_some() || a.job_error.is_some())
}

// ── Secrets of a cloud turn ──────────────────────────────────────────────────
//
// A container has no OS keychain. The runner passes the user's credentials as env vars for that
// one turn; reads find them there, and what the turn saves stays in memory, so no secret is
// written to the container's disk or to the thread's volume.

/// Secrets the turn saved or deleted: `None` is a deleted one, which no env var brings back.
static JOB_SECRETS: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

fn job_secrets() -> std::sync::MutexGuard<'static, HashMap<String, Option<String>>> {
    JOB_SECRETS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// The env vars a keychain entry is looked up in, first match wins. A provider key
/// (`provider:<id>` or `provider:<user>:<id>`) is `<ID>_API_KEY` (upper case, every other
/// character than a letter or digit as `_`), which for most providers is also the name their own
/// tools read, then the vendor's name where it differs. Other entries have no env var: a turn
/// only gets provider keys. The runner forwards no `NYXS_*` names, so none are used.
pub fn secret_env_names(account: &str) -> Vec<String> {
    let Some(rest) = account.strip_prefix("provider:") else {
        return Vec::new();
    };
    let id = rest.rsplit(':').next().unwrap_or(rest);
    let upper: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    let mut names = vec![format!("{upper}_API_KEY")];
    let vendor: &[&str] = match id {
        "google" => &["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
        "grok" => &["XAI_API_KEY"],
        "deepseek-cli" => &["DEEPSEEK_API_KEY"],
        "vercel" => &["AI_GATEWAY_API_KEY"],
        _ => &[],
    };
    names.extend(vendor.iter().map(|s| s.to_string()));
    names
}

fn secret_from(
    account: &str,
    saved: &HashMap<String, Option<String>>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Option<String> {
    if let Some(value) = saved.get(account) {
        return value.clone();
    }
    secret_env_names(account)
        .iter()
        .find_map(|name| env(name).filter(|v| !v.trim().is_empty()))
}

/// In a cloud turn, the secret `account` from what the turn saved or the env; None outside one.
pub fn job_secret_get(account: &str) -> Option<Result<Option<String>, String>> {
    if !is_cloud_job() {
        return None;
    }
    let saved = job_secrets();
    Some(Ok(secret_from(account, &saved, &|name: &str| {
        std::env::var(name).ok()
    })))
}

/// In a cloud turn, keeps the secret in memory for the rest of the turn; None outside one.
pub fn job_secret_set(account: &str, secret: &str) -> Option<Result<(), String>> {
    if !is_cloud_job() {
        return None;
    }
    job_secrets().insert(account.to_string(), Some(secret.to_string()));
    Some(Ok(()))
}

/// In a cloud turn, forgets the secret for the rest of the turn; None outside one.
pub fn job_secret_delete(account: &str) -> Option<Result<(), String>> {
    if !is_cloud_job() {
        return None;
    }
    job_secrets().insert(account.to_string(), None);
    Some(Ok(()))
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

/// Writes the run's transcript to the file `--save-session` named (relative to `--cwd`), or a
/// cloud turn's conversation to `<work>/.nyxs/session.json`. Only in headless mode, and only to
/// that one path: the page can't pick another.
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
        assert_eq!(a.job, None);
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

    const JOB: &str = r#"{"threadId":"th_1","turn":2,"prompt":"Add a README","repo":{"url":"https://github.com/acme/app","branch":"main"},"workBranch":"nyxs/readme-1a2b","model":{"id":"anthropic:claude-sonnet-4-5","provider":"anthropic","effort":"high"},"settings":{"providers":{}},"projectInstructions":null,"memory":"- uses pnpm","permissionMode":"auto","maxSteps":200}"#;

    #[test]
    fn a_job_runs_in_the_clone_with_json_events_and_the_thread_session() {
        let work = std::env::temp_dir().join(format!("nyxs-job-{}", std::process::id()));
        std::fs::create_dir_all(work.join(".nyxs")).unwrap();
        std::fs::write(work.join(".nyxs").join("session.json"), "{\"version\":1}").unwrap();
        let work_s = work.to_string_lossy().into_owned();
        let read = |src: &str| -> Result<String, String> {
            assert_eq!(src, "job.json");
            Ok(JOB.to_string())
        };
        let a = parse_with(
            &argv(&["nyxs", "--job", "job.json", "--work", &work_s]),
            "C:\\",
            &read,
        )
        .unwrap();
        let job = a.job.clone().unwrap();
        assert_eq!(job.thread_id, "th_1");
        assert_eq!(job.turn, 2);
        assert_eq!(job.repo.branch.as_deref(), Some("main"));
        assert_eq!(job.memory.as_deref(), Some("- uses pnpm"));
        assert_eq!(job.project_instructions, None);
        assert_eq!(a.prompt, "Add a README");
        assert_eq!(a.format, "json");
        assert_eq!(a.model.as_deref(), Some("anthropic:claude-sonnet-4-5"));
        assert_eq!(a.permission_mode.as_deref(), Some("auto"));
        assert_eq!(a.max_steps, Some(200));
        assert_eq!(Path::new(&a.cwd), work.join("repo"));
        assert_eq!(
            a.save_session.as_deref().map(Path::new),
            Some(work.join(".nyxs").join("session.json").as_path())
        );
        assert_eq!(a.resume.as_deref(), Some("{\"version\":1}"));
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn a_bad_job_still_starts_the_turn_to_report_why() {
        let read = |_: &str| -> Result<String, String> { Ok("{not json".to_string()) };
        let a = parse_with(&argv(&["nyxs", "--job", "-"]), "C:\\", &read).unwrap();
        assert!(a.job.is_none());
        assert!(a.job_error.unwrap().contains("valid JSON"));
        assert_eq!(a.format, "json");
        let failed = |_: &str| -> Result<String, String> { Err("no such file".to_string()) };
        let a = parse_with(&argv(&["nyxs", "--job", "x.json"]), "C:\\", &failed).unwrap();
        assert_eq!(a.job_error.as_deref(), Some("no such file"));
    }

    #[test]
    fn job_fields_that_reach_git_are_checked() {
        let with = |key: &str, value: serde_json::Value| {
            let mut v: serde_json::Value = serde_json::from_str(JOB).unwrap();
            let (obj, k) = match key.split_once('.') {
                Some((a, b)) => (v.get_mut(a).unwrap(), b),
                None => (&mut v, key),
            };
            obj[k] = value;
            parse_job(&v.to_string())
        };
        assert!(parse_job(JOB).is_ok());
        assert!(with("threadId", "../x".into()).is_err());
        assert!(with("turn", 0.into()).is_err());
        assert!(with("prompt", "  ".into()).is_err());
        for url in [
            "http://github.com/a/b",
            "https://user:tok@github.com/a/b",
            "https://github.com",
            "--upload-pack=x",
            "ssh://git@github.com/a/b",
        ] {
            assert!(with("repo.url", url.into()).is_err(), "{url}");
        }
        assert!(with("repo.url", "file:///tmp/repo".into()).is_ok());
        for b in ["-x", "a..b", "a b", "x.lock", "/a", "a/", "a/.b", ""] {
            assert!(with("workBranch", b.into()).is_err(), "{b:?}");
        }
        assert!(with("repo.branch", "--orphan".into()).is_err());
        assert_eq!(with("repo.branch", "".into()).unwrap().repo.branch, None);
        assert!(with("model", serde_json::Value::Null).is_err());
        let mut dry: serde_json::Value = serde_json::from_str(JOB).unwrap();
        dry["model"] = serde_json::Value::Null;
        dry["dryRun"] = true.into();
        assert!(parse_job(&dry.to_string()).is_ok());
        assert_eq!(with("maxSteps", 5000.into()).unwrap().max_steps, Some(1000));
        assert!(parse_job("").is_err());
    }

    #[test]
    fn provider_keys_come_from_their_env_vars() {
        assert_eq!(
            secret_env_names("provider:anthropic"),
            ["ANTHROPIC_API_KEY"]
        );
        assert_eq!(
            secret_env_names("provider:u-123:minimax-anthropic"),
            ["MINIMAX_ANTHROPIC_API_KEY"]
        );
        assert_eq!(
            secret_env_names("provider:google"),
            [
                "GOOGLE_API_KEY",
                "GEMINI_API_KEY",
                "GOOGLE_GENERATIVE_AI_API_KEY"
            ]
        );
        assert!(secret_env_names("auth:session").is_empty());
        let env: HashMap<&str, &str> = [
            ("ANTHROPIC_API_KEY", "key-a"),
            ("GEMINI_API_KEY", "key-g"),
            ("OPENAI_API_KEY", "key-o"),
            ("GROQ_API_KEY", "  "),
        ]
        .into_iter()
        .collect();
        let env = |k: &str| env.get(k).map(|v| v.to_string());
        let mut saved = HashMap::new();
        assert_eq!(
            secret_from("provider:anthropic", &saved, &env).as_deref(),
            Some("key-a")
        );
        assert_eq!(
            secret_from("provider:u1:google", &saved, &env).as_deref(),
            Some("key-g")
        );
        assert_eq!(secret_from("auth:session", &saved, &env), None);
        assert_eq!(secret_from("provider:groq", &saved, &env), None);
        // What the turn saves or deletes wins over the env, and stays in memory.
        saved.insert("provider:anthropic".to_string(), Some("saved".to_string()));
        saved.insert("provider:openai".to_string(), None);
        assert_eq!(
            secret_from("provider:anthropic", &saved, &env).as_deref(),
            Some("saved")
        );
        assert_eq!(secret_from("provider:openai", &saved, &env), None);
    }
}
