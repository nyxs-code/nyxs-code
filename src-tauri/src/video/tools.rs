//! The runtime's task scripts for the agent and the panel: a contact sheet and a proxy for review
//! (`nyxs/review.mjs`), a scripted browser recording (`nyxs/record.mjs`) and an original music bed
//! (`nyxs/music.mjs`). Review images and proxies go to the project's cache; recordings and music go
//! to its `media/` and come back as an [`Asset`](super::media::Asset) for the caller to add to the
//! timeline, which stays the store's to write.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::{env, media, project, runtime};

const SHEET_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const PROXY_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const RECORD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MUSIC_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Review files are looked at once and regenerated at will.
const REVIEW_KEEP: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgress {
    pub job_id: String,
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendered: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

pub type Report<'a> = &'a (dyn Fn(ToolProgress) + Sync);

struct Job {
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
}

fn jobs() -> &'static Mutex<HashMap<String, Job>> {
    static J: OnceLock<Mutex<HashMap<String, Job>>> = OnceLock::new();
    J.get_or_init(Default::default)
}

fn new_job_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("tool-{ms}-{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

/// What one script run needs.
struct Task<'a> {
    runtime: &'a Path,
    script: &'a str,
    project: &'a Path,
    workspace: &'a str,
    slug: &'a str,
    job: &'a str,
    request: Value,
    timeout: Duration,
}

/// `{"type":"progress",...}` as a [`ToolProgress`]; anything else is not progress.
pub fn parse_progress(job: &str, event: &Value) -> Option<ToolProgress> {
    if event.get("type")?.as_str()? != "progress" {
        return None;
    }
    Some(ToolProgress {
        job_id: job.to_string(),
        stage: event.get("stage")?.as_str()?.to_string(),
        progress: event
            .get("progress")
            .and_then(Value::as_f64)
            .map(|p| p.clamp(0.0, 1.0)),
        rendered: event.get("renderedFrames").and_then(Value::as_u64),
        total: event.get("totalFrames").and_then(Value::as_u64),
    })
}

/// Runs a script to its end. Its temp files (a recording's frames, Chrome's profile) live in a work
/// folder in the cache, removed afterwards even when the script is killed halfway.
fn run_task(task: Task, report: Report) -> Result<Value, String> {
    let root = project::cache_dir(task.workspace, task.slug)?.join("tools");
    let work = root.join(format!("work-{}", task.job));
    fs::create_dir_all(&work).map_err(|e| format!("Couldn't create {}: {e}", work.display()))?;
    let result = run_in(&task, &work, report);
    let _ = fs::remove_dir_all(&work);
    result
}

fn run_in(task: &Task, work: &Path, report: Report) -> Result<Value, String> {
    let script = task.runtime.join("nyxs").join(task.script);
    if !script.is_file() {
        return Err(format!("The script is missing: {}", script.display()));
    }
    let options = work.join("options.json");
    project::write_json(&options, &task.request)?;
    let args = [
        "--project".to_string(),
        task.project.to_string_lossy().into_owned(),
        options.to_string_lossy().into_owned(),
    ];
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut cmd = env::toolchain().node_script(task.runtime, &script, &refs)?;
    for var in ["TMP", "TEMP", "TMPDIR"] {
        cmd.env(var, work);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start {}: {e}", task.script))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    let cancelled = Arc::new(AtomicBool::new(false));
    jobs().lock().unwrap_or_else(|e| e.into_inner()).insert(
        task.job.to_string(),
        Job {
            child: child.clone(),
            cancelled: cancelled.clone(),
        },
    );

    let finished = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let (child, finished, timed_out) = (child.clone(), finished.clone(), timed_out.clone());
        let timeout = task.timeout;
        std::thread::spawn(move || {
            let start = Instant::now();
            while !finished.load(Ordering::SeqCst) {
                if start.elapsed() > timeout {
                    timed_out.store(true, Ordering::SeqCst);
                    crate::agent::kill_tree(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        })
    };
    let err_reader = stderr.map(|err| {
        std::thread::spawn(move || {
            let mut tail = Vec::new();
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                tail.push(line);
                let excess = tail.len().saturating_sub(12);
                tail.drain(..excess);
            }
            tail.join("\n")
        })
    });

    let mut done = None;
    let mut script_error = None;
    if let Some(out) = stdout {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let Ok(event) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            match event.get("type").and_then(Value::as_str) {
                Some("progress") => {
                    if let Some(p) = parse_progress(task.job, &event) {
                        report(p);
                    }
                }
                Some("done") => done = Some(event),
                Some("error") => {
                    script_error = event
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }
                _ => {}
            }
        }
    }
    let code = child
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .wait()
        .ok()
        .and_then(|s| s.code());
    finished.store(true, Ordering::SeqCst);
    let _ = watchdog.join();
    jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(task.job);
    let err_tail = err_reader.and_then(|h| h.join().ok()).unwrap_or_default();

    if cancelled.load(Ordering::SeqCst) {
        return Err("Cancelled.".into());
    }
    if timed_out.load(Ordering::SeqCst) {
        return Err(format!(
            "{} didn't finish in {} minutes and was stopped.",
            task.script,
            task.timeout.as_secs() / 60
        ));
    }
    if let Some(e) = script_error {
        return Err(e);
    }
    match done {
        Some(event) if code == Some(0) => Ok(event),
        _ => Err(format!(
            "{} stopped (exit {}): {}",
            task.script,
            code.map_or("?".into(), |c| c.to_string()),
            env::tail_lines(&err_tail, 12)
        )),
    }
}

/// Stops a running task; its call then fails with "Cancelled.".
pub fn cancel(job_id: &str) {
    let job = jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(job_id)
        .map(|j| (j.child.clone(), j.cancelled.clone()));
    if let Some((child, cancelled)) = job {
        cancelled.store(true, Ordering::SeqCst);
        crate::agent::kill_tree(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
    }
}

pub fn shutdown_all() {
    let ids: Vec<String> = jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .keys()
        .cloned()
        .collect();
    for id in ids {
        cancel(&id);
    }
}

/// A new file in the cache's `review/`, sweeping what's older than a day on the way.
fn review_file(workspace: &str, slug: &str, job: &str, ext: &str) -> Result<PathBuf, String> {
    let dir = project::cache_dir(workspace, slug)?.join("review");
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > REVIEW_KEEP);
            if old {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    Ok(dir.join(format!("{job}.{ext}")))
}

/// The app's fields on a request: whatever the caller put under these names doesn't count.
fn with_fields(mut request: Value, fields: Value) -> Result<Value, String> {
    let map = request
        .as_object_mut()
        .ok_or("The request must be an object.")?;
    for key in [
        "output",
        "cacheRoot",
        "task",
        "light",
        "entryPoint",
        "asset",
    ] {
        map.remove(key);
    }
    if let Some(extra) = fields.as_object() {
        for (k, v) in extra {
            map.insert(k.clone(), v.clone());
        }
    }
    Ok(request)
}

/// How a light or adopted project is rendered, for the scripts that bundle it.
fn project_fields(workspace: &str, slug: &str, dir: &Path, task: &str) -> Result<Value, String> {
    let light = project::is_light(dir);
    if !light && !dir.join("node_modules").is_dir() {
        return Err(
            "This Remotion project's dependencies are not installed: install them first.".into(),
        );
    }
    let mut fields = json!({
        "task": task,
        "light": light,
        "cacheRoot": project::cache_dir(workspace, slug)?.to_string_lossy(),
    });
    if !light {
        fields["entryPoint"] = json!(project::entry_point(dir));
    }
    Ok(fields)
}

/// The first composition of a light project, when the caller didn't name one.
fn default_composition(dir: &Path) -> Option<String> {
    project::read_timeline_value(dir)
        .ok()?
        .get("compositions")?
        .as_array()?
        .first()?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

fn fill_composition(request: &mut Value, dir: &Path) -> Result<(), String> {
    let named = request
        .get("compositionId")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty());
    if !named {
        let id = default_composition(dir)
            .ok_or("Name a composition: this project's timeline has none to default to.")?;
        request["compositionId"] = json!(id);
    }
    Ok(())
}

/// The done event as the caller gets it: `path` instead of `output`, no protocol field.
fn result_of(mut event: Value) -> Value {
    if let Some(map) = event.as_object_mut() {
        map.remove("type");
        if let Some(out) = map.remove("output") {
            map.insert("path".into(), out);
        }
    }
    event
}

/// N frames of a composition (`compositionId`) or a media asset (`assetId`) as one labeled image.
pub fn contact_sheet(
    runtime: &Path,
    workspace: &str,
    slug: &str,
    job: &str,
    request: Value,
    report: Report,
) -> Result<Value, String> {
    let dir = project::project_dir(workspace, slug)?;
    let output = review_file(workspace, slug, job, "jpg")?;
    let asset_id = request
        .get("assetId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut fields = project_fields(workspace, slug, &dir, "contactSheet")?;
    fields["output"] = json!(output.to_string_lossy());
    let mut request = request;
    if let Some(id) = asset_id {
        let (asset, file) = project::find_asset(&dir, &id)?;
        if asset.get("kind").and_then(Value::as_str) != Some("video") {
            return Err(format!(
                "Asset {id:?} is not a video: a contact sheet needs frames to spread."
            ));
        }
        let tools = if dir.join("node_modules").join("@remotion").is_dir() {
            dir.clone()
        } else {
            runtime.to_path_buf()
        };
        let probed = media::probe(&env::toolchain(), &tools, &file)?;
        let duration = probed
            .duration_secs
            .ok_or_else(|| format!("Couldn't read how long {} is.", file.display()))?;
        fields["asset"] = json!({
            "file": file.to_string_lossy(),
            "fps": probed.fps.unwrap_or(30.0),
            "durationSecs": duration,
            "width": probed.width,
            "height": probed.height,
        });
    } else {
        fill_composition(&mut request, &dir)?;
    }
    let request = with_fields(request, fields)?;
    let event = run_task(
        Task {
            runtime,
            script: "review.mjs",
            project: &dir,
            workspace,
            slug,
            job,
            request,
            timeout: SHEET_TIMEOUT,
        },
        report,
    )?;
    Ok(result_of(event))
}

/// A small, low-fps clip of a frame range for review; a timeline edit needs no new bundle.
pub fn proxy(
    runtime: &Path,
    workspace: &str,
    slug: &str,
    job: &str,
    request: Value,
    report: Report,
) -> Result<Value, String> {
    let dir = project::project_dir(workspace, slug)?;
    let output = review_file(workspace, slug, job, "mp4")?;
    let mut fields = project_fields(workspace, slug, &dir, "proxy")?;
    fields["output"] = json!(output.to_string_lossy());
    let mut request = request;
    fill_composition(&mut request, &dir)?;
    let request = with_fields(request, fields)?;
    let event = run_task(
        Task {
            runtime,
            script: "review.mjs",
            project: &dir,
            workspace,
            slug,
            job,
            request,
            timeout: PROXY_TIMEOUT,
        },
        report,
    )?;
    Ok(result_of(event))
}

/// `name.ext` free in the project's `media/`, from what the caller asked for.
fn media_target(
    dir: &Path,
    name: Option<&str>,
    fallback: &str,
    ext: &str,
) -> Result<PathBuf, String> {
    let media = project::media_base(dir).join("media");
    fs::create_dir_all(&media).map_err(|e| format!("Couldn't create {}: {e}", media.display()))?;
    let base = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(fallback);
    // Split by hand: on Windows `Path` would read `a:b` as drive `a:` and file `b`.
    let base = base.rsplit(['/', '\\']).next().unwrap_or(fallback);
    let stem = base
        .strip_suffix(&format!(".{ext}"))
        .unwrap_or(base)
        .to_string();
    let safe = media::safe_file_name(&format!("{stem}.{ext}"));
    Ok(media.join(media::dedupe_file(&media, &safe)))
}

/// Moves a finished file out of the work area, across volumes if it must.
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to).map_err(|e| format!("Couldn't write {}: {e}", to.display()))?;
    let _ = fs::remove_file(from);
    Ok(())
}

/// Describes a file already in `media/` as an asset, with what ffprobe says about it.
fn asset_for(runtime: &Path, file: &Path, kind: &'static str, display: &str) -> Value {
    let probed = media::probe(&env::toolchain(), runtime, file).unwrap_or_else(|e| {
        log::warn!("video: {e}");
        media::Probe::default()
    });
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let asset = media::asset_from_probe(
        media::new_id("asset"),
        kind,
        format!("media/{name}"),
        display.to_string(),
        &probed,
    );
    serde_json::to_value(asset).unwrap_or(Value::Null)
}

/// Films a web page through scripted steps into `media/`. With `dryRun` it only runs the steps and
/// returns a screenshot of how they end, to fix the script before filming.
pub fn record(
    runtime: &Path,
    workspace: &str,
    slug: &str,
    job: &str,
    request: Value,
    report: Report,
) -> Result<Value, String> {
    let dir = project::project_dir(workspace, slug)?;
    let dry = request
        .get("dryRun")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let name = request
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let tools = project::cache_dir(workspace, slug)?.join("tools");
    fs::create_dir_all(&tools).map_err(|e| format!("Couldn't create {}: {e}", tools.display()))?;
    let (staged, target) = if dry {
        (review_file(workspace, slug, job, "jpg")?, None)
    } else {
        (
            tools.join(format!("{job}.mp4")),
            Some(media_target(&dir, name.as_deref(), "recording", "mp4")?),
        )
    };
    let failure = review_file(workspace, slug, &format!("{job}-failed"), "jpg")?;
    let mut request = request;
    request["failureScreenshot"] = json!(failure.to_string_lossy());
    let request = with_fields(request, json!({ "output": staged.to_string_lossy() }))?;
    let event = run_task(
        Task {
            runtime,
            script: "record.mjs",
            project: &dir,
            workspace,
            slug,
            job,
            request,
            timeout: RECORD_TIMEOUT,
        },
        report,
    )?;
    let mut result = result_of(event);
    if let Some(target) = target {
        move_file(&staged, &target)?;
        let display = name.as_deref().unwrap_or("Recording");
        result["asset"] = asset_for(runtime, &target, "video", display);
        result["path"] = json!(target.to_string_lossy());
    }
    Ok(result)
}

/// Writes an original music bed into `media/`.
pub fn music(
    runtime: &Path,
    workspace: &str,
    slug: &str,
    job: &str,
    request: Value,
    report: Report,
) -> Result<Value, String> {
    let dir = project::project_dir(workspace, slug)?;
    let mood = request
        .get("mood")
        .and_then(Value::as_str)
        .unwrap_or("music")
        .to_string();
    let name = request
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let tools = project::cache_dir(workspace, slug)?.join("tools");
    fs::create_dir_all(&tools).map_err(|e| format!("Couldn't create {}: {e}", tools.display()))?;
    let staged = tools.join(format!("{job}.wav"));
    let target = media_target(&dir, name.as_deref(), &format!("music-{mood}"), "wav")?;
    let request = with_fields(request, json!({ "output": staged.to_string_lossy() }))?;
    let event = run_task(
        Task {
            runtime,
            script: "music.mjs",
            project: &dir,
            workspace,
            slug,
            job,
            request,
            timeout: MUSIC_TIMEOUT,
        },
        report,
    )?;
    move_file(&staged, &target)?;
    let mut result = result_of(event);
    let display = name.unwrap_or_else(|| format!("Music ({mood})"));
    result["asset"] = asset_for(runtime, &target, "audio", &display);
    result["path"] = json!(target.to_string_lossy());
    Ok(result)
}

/// Which task a command runs.
#[derive(Clone, Copy)]
pub enum Kind {
    ContactSheet,
    Proxy,
    Record,
    Music,
}

/// Runs a task for the app, with `video-tool-progress` events under `job_id`.
pub fn run(
    app: &AppHandle,
    kind: Kind,
    workspace: &str,
    slug: &str,
    request: Value,
    job_id: Option<String>,
) -> Result<Value, String> {
    let runtime = runtime::ready_dir(app)?;
    let job = job_id.unwrap_or_else(new_job_id);
    let app = app.clone();
    let report = move |p: ToolProgress| {
        let _ = app.emit("video-tool-progress", p);
    };
    let runner = match kind {
        Kind::ContactSheet => contact_sheet,
        Kind::Proxy => proxy,
        Kind::Record => record,
        Kind::Music => music,
    };
    runner(&runtime, workspace, slug, &job, request, &report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_progress_events() {
        let event = json!({"type":"progress","stage":"rendering","progress":1.4,"renderedFrames":3,"totalFrames":9});
        let p = parse_progress("j", &event).unwrap();
        assert_eq!(p.stage, "rendering");
        assert_eq!(p.progress, Some(1.0));
        assert_eq!((p.rendered, p.total), (Some(3), Some(9)));
        assert!(parse_progress("j", &json!({"type":"done"})).is_none());
    }

    #[test]
    fn callers_cant_set_the_apps_fields() {
        let out = with_fields(
            json!({"output":"C:/evil.mp4","cacheRoot":"C:/","asset":{"file":"C:/secret"},"count":4}),
            json!({"output":"C:/cache/x.jpg"}),
        )
        .unwrap();
        assert_eq!(out["output"], "C:/cache/x.jpg");
        assert_eq!(out["count"], 4);
        assert!(out.get("cacheRoot").is_none() && out.get("asset").is_none());
        assert!(with_fields(json!([1]), json!({})).is_err());
    }

    #[test]
    fn media_names_stay_inside_media() {
        let dir = std::env::temp_dir().join(format!("nyxs-video-tools-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let media = project::media_base(&dir).join("media");
        let a = media_target(&dir, Some("../../evil"), "x", "mp4").unwrap();
        assert_eq!(a, media.join("evil.mp4"));
        fs::write(&a, b"x").unwrap();
        let b = media_target(&dir, Some("evil.mp4"), "x", "mp4").unwrap();
        assert_eq!(b, media.join("evil-2.mp4"));
        let c = media_target(&dir, None, "music-calm", "wav").unwrap();
        assert_eq!(c, media.join("music-calm.wav"));
        let d = media_target(&dir, Some("a:b?"), "x", "wav").unwrap();
        assert!(d.starts_with(&media), "{d:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn results_say_path_not_output() {
        let r = result_of(json!({"type":"done","output":"C:/x.jpg","width":10}));
        assert_eq!(r, json!({"path":"C:/x.jpg","width":10}));
    }
}
