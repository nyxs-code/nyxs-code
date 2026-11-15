//! Rendering videos and stills: the runtime's `nyxs/render.mjs` drives `@remotion/renderer`
//! against a project (`--project <dir>`) and prints one JSON line per event.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::env;
use super::project;
use super::runtime;

const STILL_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Share of the overall progress given to bundling; frames and encoding get the rest.
const BUNDLE_SHARE: f64 = 0.1;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenderOpts {
    pub composition_id: String,
    pub codec: String,
    pub crf: Option<u32>,
    pub scale: Option<f64>,
    pub frame_range: Option<[u32; 2]>,
    /// Only GIFs can drop frames (Remotion's `everyNthFrame`); other codecs keep the
    /// composition's rate.
    pub fps: Option<f64>,
    pub audio_codec: Option<String>,
    pub muted: Option<bool>,
    pub output_name: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenderProgress {
    pub render_id: String,
    pub stage: &'static str,
    /// Of the whole job, bundling included.
    pub progress: f64,
    pub rendered_frames: u64,
    pub total_frames: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta_secs: Option<u64>,
    /// The ffmpeg encoder in use (`h264_nvenc`, `libx264`...), once it's known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Job {
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
}

/// Stills running now, whose bundles `clean_bundles` must leave alone.
fn stills() -> &'static Mutex<std::collections::HashSet<String>> {
    static S: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Keeps `clean_bundles` off a job's bundle while it runs outside this module (posters).
pub(super) fn mark_busy(job: &str, on: bool) {
    let mut s = stills().lock().unwrap_or_else(|e| e.into_inner());
    if on {
        s.insert(job.to_string());
    } else {
        s.remove(job);
    }
}

fn jobs() -> &'static Mutex<HashMap<String, Job>> {
    static J: OnceLock<Mutex<HashMap<String, Job>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn extension(codec: &str) -> Result<&'static str, String> {
    Ok(match codec {
        "h264" | "h265" => "mp4",
        "vp8" | "vp9" => "webm",
        "prores" => "mov",
        "gif" => "gif",
        other => return Err(format!("Unsupported codec: {other}")),
    })
}

/// `out/<name>.<ext>`, with the name reduced to a plain file name and the codec's extension.
pub fn output_path(dir: &Path, name: &str, ext: &str) -> PathBuf {
    // Split by hand: on Windows `Path` would read `a:b` as drive `a:` and file `b`.
    let base = name
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_string();
    let lower = base.to_ascii_lowercase();
    let stem = lower
        .strip_suffix(&format!(".{ext}"))
        .map(|s| base[..s.len()].to_string())
        .unwrap_or(base);
    let stem: String = stem
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let stem = stem.trim().trim_matches('.');
    let stem = if stem.is_empty() { "render" } else { stem };
    dir.join("out").join(format!("{stem}.{ext}"))
}

/// What render.mjs is asked to do, written to a JSON file it reads (no quoting to get wrong).
pub fn script_opts(
    opts: &RenderOpts,
    output: &Path,
    bundle_dir: &Path,
    comp_fps: Option<f64>,
) -> Value {
    let crf = matches!(opts.codec.as_str(), "h264" | "h265" | "vp8" | "vp9")
        .then_some(opts.crf)
        .flatten();
    let every_nth = match (opts.codec.as_str(), opts.fps, comp_fps) {
        ("gif", Some(f), Some(c)) if f > 0.0 && f < c => Some((c / f).round().max(1.0) as u32),
        _ => None,
    };
    json!({
        "compositionId": opts.composition_id,
        "codec": opts.codec,
        "crf": crf,
        "scale": opts.scale,
        "frameRange": opts.frame_range,
        "everyNthFrame": every_nth,
        "audioCodec": opts.audio_codec,
        "muted": opts.muted.unwrap_or(false),
        "output": output.to_string_lossy(),
        "bundleDir": bundle_dir.to_string_lossy(),
    })
}

/// One event from render.mjs: `{"type":"progress"|"done"|"error", ...}`.
#[derive(Debug, PartialEq)]
pub enum ScriptEvent {
    Progress {
        stage: &'static str,
        progress: f64,
        rendered: u64,
        total: u64,
    },
    Encoder(String),
    Done(String),
    Error(String),
}

pub fn parse_script_line(line: &str) -> Option<ScriptEvent> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let num = |k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    match v.get("type")?.as_str()? {
        "progress" => {
            let stage = match v.get("stage").and_then(Value::as_str) {
                Some("bundling") => "bundling",
                Some("encoding") => "encoding",
                _ => "rendering",
            };
            Some(ScriptEvent::Progress {
                stage,
                progress: num("progress").clamp(0.0, 1.0),
                rendered: num("renderedFrames") as u64,
                total: num("totalFrames") as u64,
            })
        }
        "encoder" => Some(ScriptEvent::Encoder(
            v.get("encoder")?.as_str()?.to_string(),
        )),
        "done" => Some(ScriptEvent::Done(
            v.get("output")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        )),
        "error" => Some(ScriptEvent::Error(
            v.get("message")
                .and_then(Value::as_str)
                .unwrap_or("The render failed.")
                .to_string(),
        )),
        _ => None,
    }
}

/// Seconds left, from how long the frame stages took to reach `progress`.
pub fn eta(elapsed: Duration, progress: f64) -> Option<u64> {
    (progress > 0.02 && progress < 1.0)
        .then(|| (elapsed.as_secs_f64() * (1.0 - progress) / progress).round() as u64)
}

fn overall(stage: &str, progress: f64) -> f64 {
    let p = if stage == "bundling" {
        BUNDLE_SHARE * progress
    } else {
        BUNDLE_SHARE + (1.0 - BUNDLE_SHARE) * progress
    };
    (p * 1000.0).round() / 1000.0
}

fn composition_fps(dir: &Path, id: &str) -> Option<f64> {
    project::read_timeline_value(dir)
        .ok()?
        .get("compositions")?
        .as_array()?
        .iter()
        .find(|c| c.get("id").and_then(Value::as_str) == Some(id))?
        .get("fps")?
        .as_f64()
}

fn new_render_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("render-{ms}-{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

/// Writes render.mjs's options in the cache and builds `node <runtime>/nyxs/render.mjs
/// --project <dir> <options.json>`. A Nyxs project renders through the runtime's entry; an
/// adopted one through its own entry and packages.
fn render_command(
    app: &AppHandle,
    workspace: &str,
    slug: &str,
    dir: &Path,
    job: &str,
    request: Value,
) -> Result<std::process::Command, String> {
    let runtime = runtime::ready_dir(app)?;
    script_command(&runtime, workspace, slug, dir, job, request)
}

/// `render_command` with the runtime given.
pub(super) fn script_command(
    runtime: &Path,
    workspace: &str,
    slug: &str,
    dir: &Path,
    job: &str,
    mut request: Value,
) -> Result<std::process::Command, String> {
    let light = project::is_light(dir);
    if !light && !dir.join("node_modules").is_dir() {
        return Err(
            "This Remotion project's dependencies are not installed: install them first.".into(),
        );
    }
    request["light"] = json!(light);
    if !light {
        request["entryPoint"] = json!(project::entry_point(dir));
    }
    let script = runtime.join("nyxs").join("render.mjs");
    if !script.is_file() {
        return Err(format!(
            "The render script is missing: {}",
            script.display()
        ));
    }
    let work = project::cache_dir(workspace, slug)?.join("render");
    std::fs::create_dir_all(&work)
        .map_err(|e| format!("Couldn't create {}: {e}", work.display()))?;
    let opts_file = work.join(format!("{job}.json"));
    project::write_json(&opts_file, &request)?;
    let project_arg = dir.to_string_lossy().into_owned();
    let file = opts_file.to_string_lossy().into_owned();
    env::toolchain().node_script(runtime, &script, &["--project", &project_arg, &file])
}

/// render.mjs lowers its own priority and its children inherit that, but Chrome's GPU process
/// raises itself to above normal. A job's priority limit is the one thing it can't undo. Node
/// starts nothing before this runs, so the whole tree lands in the job.
#[cfg(windows)]
pub(super) fn keep_below_normal(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicLimitInformation,
        SetInformationJobObject, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_PRIORITY_CLASS,
    };
    use windows_sys::Win32::System::Threading::BELOW_NORMAL_PRIORITY_CLASS;
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_BASIC_LIMIT_INFORMATION = std::mem::zeroed();
        info.LimitFlags = JOB_OBJECT_LIMIT_PRIORITY_CLASS;
        info.PriorityClass = BELOW_NORMAL_PRIORITY_CLASS;
        let ok = SetInformationJobObject(
            job,
            JobObjectBasicLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_BASIC_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            CloseHandle(job);
            return 0;
        }
        job as usize
    });
    if job != 0 {
        // Outside the job it still runs, as render.mjs's own lowering left it.
        unsafe { AssignProcessToJobObject(job as HANDLE, child.as_raw_handle() as HANDLE) };
    }
}

pub fn start(
    app: &AppHandle,
    workspace: &str,
    slug: &str,
    opts: RenderOpts,
) -> Result<String, String> {
    let dir = project::project_dir(workspace, slug)?;
    let ext = extension(&opts.codec)?;
    if opts.composition_id.trim().is_empty() {
        return Err("No composition to render.".into());
    }
    let output = output_path(&dir, &opts.output_name, ext);
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let id = new_render_id();
    let bundle_dir = project::cache_dir(workspace, slug)?
        .join("render")
        .join(format!("bundle-{id}"));
    let request = script_opts(
        &opts,
        &output,
        &bundle_dir,
        composition_fps(&dir, &opts.composition_id),
    );
    let mut cmd = render_command(app, workspace, slug, &dir, &id, request)?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start the render: {e}"))?;
    #[cfg(windows)]
    keep_below_normal(&child);
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    let cancelled = Arc::new(AtomicBool::new(false));
    jobs().lock().unwrap_or_else(|e| e.into_inner()).insert(
        id.clone(),
        Job {
            child: child.clone(),
            cancelled: cancelled.clone(),
        },
    );

    let err_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let err_reader = stderr.map(|err| {
        let tail = err_tail.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
                t.push(line);
                let excess = t.len().saturating_sub(20);
                t.drain(..excess);
            }
        })
    });

    let app = app.clone();
    let (workspace, slug) = (workspace.to_string(), slug.to_string());
    let render_id = id.clone();
    let output_str = output.to_string_lossy().into_owned();
    std::thread::spawn(move || {
        let emit = |p: RenderProgress| {
            let _ = app.emit("video-render-progress", p);
        };
        let base = RenderProgress {
            render_id: render_id.clone(),
            stage: "bundling",
            ..Default::default()
        };
        emit(base.clone());
        let mut frames_start: Option<Instant> = None;
        let mut last = base.clone();
        let mut done_output: Option<String> = None;
        let mut script_error: Option<String> = None;
        let mut handle_event = |ev: ScriptEvent, last: &mut RenderProgress| match ev {
            ScriptEvent::Progress {
                stage,
                progress,
                rendered,
                total,
            } => {
                if stage != "bundling" && frames_start.is_none() {
                    frames_start = Some(Instant::now());
                }
                let p = RenderProgress {
                    render_id: render_id.clone(),
                    stage,
                    progress: overall(stage, progress),
                    rendered_frames: rendered,
                    total_frames: total,
                    eta_secs: frames_start.and_then(|s| eta(s.elapsed(), progress)),
                    encoder: last.encoder.clone(),
                    output_path: None,
                    error: None,
                };
                if p != *last {
                    *last = p.clone();
                    emit(p);
                }
            }
            ScriptEvent::Encoder(encoder) => {
                // A CPU retry starts the frames over: the time left is measured from here.
                frames_start = None;
                last.encoder = Some(encoder);
                emit(last.clone());
            }
            ScriptEvent::Done(out) => done_output = Some(out),
            ScriptEvent::Error(e) => script_error = Some(e),
        };
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(ev) = parse_script_line(&line) {
                    handle_event(ev, &mut last);
                }
            }
        }
        if let Some(handle) = err_reader {
            let _ = handle.join();
        }
        let code = child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .wait()
            .ok()
            .and_then(|s| s.code());
        jobs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&render_id);
        let mut end = RenderProgress {
            total_frames: last.total_frames,
            rendered_frames: last.rendered_frames,
            encoder: last.encoder.clone(),
            ..base
        };
        if cancelled.load(Ordering::SeqCst) {
            end.stage = "cancelled";
            end.progress = last.progress;
        } else if script_error.is_none() && code == Some(0) && Path::new(&output_str).is_file() {
            end.stage = "done";
            end.progress = 1.0;
            end.rendered_frames = end.total_frames;
            end.output_path = Some(done_output.filter(|o| !o.is_empty()).unwrap_or(output_str));
        } else {
            let tail = env::tail_lines(
                &err_tail
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .join("\n"),
                12,
            );
            end.stage = "error";
            end.progress = last.progress;
            end.error = Some(script_error.unwrap_or_else(|| {
                if tail.is_empty() {
                    format!(
                        "The render stopped (exit {}).",
                        code.map_or("?".into(), |c| c.to_string())
                    )
                } else {
                    tail
                }
            }));
        }
        emit(end);
        clean_bundles(&workspace, &slug);
    });
    Ok(id)
}

pub fn cancel(render_id: &str) -> Result<(), String> {
    let job = jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(render_id)
        .map(|j| (j.child.clone(), j.cancelled.clone()));
    let Some((child, cancelled)) = job else {
        return Ok(());
    };
    cancelled.store(true, Ordering::SeqCst);
    // The waiting thread only takes this lock after the output ends, which the kill causes.
    crate::agent::kill_tree(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
    Ok(())
}

pub fn shutdown_all() {
    let all: Vec<(Arc<Mutex<Child>>, Arc<AtomicBool>)> = jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .map(|j| (j.child.clone(), j.cancelled.clone()))
        .collect();
    for (child, cancelled) in all {
        cancelled.store(true, Ordering::SeqCst);
        crate::agent::kill_tree(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
    }
}

/// Renders one frame to PNG: into `out/<name>.png` when a name is given, else into the cache
/// (which also becomes the project's thumbnail in the list).
pub fn still(
    app: &AppHandle,
    workspace: &str,
    slug: &str,
    composition_id: &str,
    frame: u32,
    output_name: Option<&str>,
) -> Result<String, String> {
    let dir = project::project_dir(workspace, slug)?;
    let cache = project::cache_dir(workspace, slug)?;
    let output = match output_name.filter(|n| !n.trim().is_empty()) {
        Some(name) => output_path(&dir, name, "png"),
        None => {
            let safe: String = composition_id
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            cache.join("stills").join(format!("{safe}-{frame}.png"))
        }
    };
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let _ = std::fs::remove_file(&output);
    let job = new_render_id().replace("render", "still");
    let request = json!({
        "still": true,
        "compositionId": composition_id,
        "frame": frame,
        "output": output.to_string_lossy(),
        "bundleDir": cache.join("render").join(format!("bundle-{job}")).to_string_lossy(),
    });
    let cmd = render_command(app, workspace, slug, &dir, &job, request)?;
    stills()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(job.clone());
    let out = env::run_capture(cmd, STILL_TIMEOUT);
    stills()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&job);
    clean_bundles(workspace, slug);
    let out = out?;
    let script_error =
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(|l| match parse_script_line(l) {
                Some(ScriptEvent::Error(e)) => Some(e),
                _ => None,
            });
    if let Some(e) = script_error {
        return Err(format!("The still failed: {e}"));
    }
    if !out.ok() || !output.is_file() {
        return Err(format!("The still failed: {}", out.tail()));
    }
    let _ = std::fs::copy(&output, project::poster_path(workspace, slug)?);
    Ok(output.to_string_lossy().into_owned())
}

/// The compositions a project's own code registers, read through a bundle by render.mjs.
pub fn list_compositions(
    app: &AppHandle,
    workspace: &str,
    slug: &str,
    dir: &Path,
) -> Result<Vec<project::CompositionInfo>, String> {
    let job = new_render_id().replace("render", "list");
    let cache = project::cache_dir(workspace, slug)?;
    let request = json!({
        "list": true,
        "bundleDir": cache.join("render").join(format!("bundle-{job}")).to_string_lossy(),
    });
    let cmd = render_command(app, workspace, slug, dir, &job, request)?;
    stills()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(job.clone());
    let out = env::run_capture(cmd, STILL_TIMEOUT);
    stills()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&job);
    clean_bundles(workspace, slug);
    let out = out?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        if let Some(ScriptEvent::Error(e)) = parse_script_line(line) {
            return Err(format!("Couldn't list the compositions: {e}"));
        }
        if let Some(list) = parse_compositions_line(line) {
            return Ok(list);
        }
    }
    Err(format!("Couldn't list the compositions: {}", out.tail()))
}

/// `{"type":"compositions","compositions":[{id,width,height,fps,durationInFrames}]}`.
pub fn parse_compositions_line(line: &str) -> Option<Vec<project::CompositionInfo>> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type")?.as_str()? != "compositions" {
        return None;
    }
    Some(
        v.get("compositions")?
            .as_array()?
            .iter()
            .filter_map(|c| {
                let id = c.get("id")?.as_str()?.to_string();
                Some(project::CompositionInfo {
                    name: id.clone(),
                    width: c.get("width")?.as_u64()?,
                    height: c.get("height")?.as_u64()?,
                    fps: c.get("fps")?.as_f64()?,
                    duration_in_frames: c.get("durationInFrames")?.as_u64()?,
                    source: "project".into(),
                    id,
                })
            })
            .collect(),
    )
}

/// Bundles from finished renders, which nothing reuses.
pub fn clean_bundles(workspace: &str, slug: &str) {
    let Ok(dir) = project::cache_dir(workspace, slug).map(|c| c.join("render")) else {
        return;
    };
    let mut busy: Vec<String> = jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .keys()
        .cloned()
        .collect();
    busy.extend(
        stills()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned(),
    );
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        // `bundle-<job>`, its `bundle-<job>-public` staging folder, and `<job>.json`. The
        // webpack cache next to them matches none of these and stays.
        let job = name
            .strip_prefix("bundle-")
            .map(|j| j.strip_suffix("-public").unwrap_or(j))
            .or_else(|| name.strip_suffix(".json"))
            .unwrap_or("");
        if !job.is_empty() && !busy.iter().any(|b| b == job) {
            let p = e.path();
            let _ = if p.is_dir() {
                std::fs::remove_dir_all(p)
            } else {
                std::fs::remove_file(p)
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(codec: &str) -> RenderOpts {
        RenderOpts {
            composition_id: "Main".into(),
            codec: codec.into(),
            crf: Some(18),
            scale: Some(0.5),
            frame_range: Some([0, 59]),
            fps: Some(15.0),
            audio_codec: None,
            muted: Some(true),
            output_name: "launch".into(),
        }
    }

    #[test]
    fn names_outputs() {
        let dir = Path::new("/p");
        assert_eq!(
            output_path(dir, "launch", "mp4"),
            dir.join("out").join("launch.mp4")
        );
        assert_eq!(
            output_path(dir, "Launch.MP4", "mp4"),
            dir.join("out").join("Launch.mp4")
        );
        assert_eq!(
            output_path(dir, "../../evil", "gif"),
            dir.join("out").join("evil.gif")
        );
        assert_eq!(
            output_path(dir, "  ", "webm"),
            dir.join("out").join("render.webm")
        );
        assert_eq!(
            output_path(dir, "a:b?", "mov"),
            dir.join("out").join("a-b-.mov")
        );
        assert_eq!(extension("prores").unwrap(), "mov");
        assert!(extension("mp3").is_err());
    }

    #[test]
    fn builds_script_options() {
        let v = script_opts(
            &opts("gif"),
            Path::new("/o.gif"),
            Path::new("/b"),
            Some(60.0),
        );
        assert_eq!(v["crf"], Value::Null);
        assert_eq!(v["everyNthFrame"], 4);
        assert_eq!(v["frameRange"], json!([0, 59]));
        let v = script_opts(
            &opts("h264"),
            Path::new("/o.mp4"),
            Path::new("/b"),
            Some(60.0),
        );
        assert_eq!(v["crf"], 18);
        assert_eq!(v["everyNthFrame"], Value::Null);
        assert_eq!(v["muted"], true);
    }

    #[test]
    fn parses_script_events() {
        assert_eq!(
            parse_script_line(
                r#"{"type":"progress","stage":"rendering","progress":0.5,"renderedFrames":30,"totalFrames":60}"#
            ),
            Some(ScriptEvent::Progress {
                stage: "rendering",
                progress: 0.5,
                rendered: 30,
                total: 60
            })
        );
        assert_eq!(
            parse_script_line(r#"{"type":"done","output":"C:/p/out/a.mp4"}"#),
            Some(ScriptEvent::Done("C:/p/out/a.mp4".into()))
        );
        assert_eq!(
            parse_script_line(r#"{"type":"error","message":"boom"}"#),
            Some(ScriptEvent::Error("boom".into()))
        );
        assert_eq!(
            parse_script_line(r#"{"type":"encoder","encoder":"h264_nvenc"}"#),
            Some(ScriptEvent::Encoder("h264_nvenc".into()))
        );
        assert_eq!(parse_script_line("Downloading Chrome Headless Shell"), None);
    }

    #[cfg(windows)]
    #[test]
    fn the_job_holds_a_process_that_tries_to_raise_its_priority() {
        let script = "$p = [Diagnostics.Process]::GetCurrentProcess(); \
                      $p.PriorityClass = 'AboveNormal'; $p.Refresh(); $p.PriorityClass";
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", script])
            .stdout(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        keep_below_normal(&child);
        let mut out = String::new();
        std::io::Read::read_to_string(&mut child.stdout.take().unwrap(), &mut out).unwrap();
        child.wait().unwrap();
        assert_eq!(out.trim(), "BelowNormal");
    }

    #[test]
    fn estimates_time_left() {
        assert_eq!(eta(Duration::from_secs(10), 0.5), Some(10));
        assert_eq!(eta(Duration::from_secs(10), 0.01), None);
        assert_eq!(eta(Duration::from_secs(10), 1.0), None);
        assert_eq!(overall("bundling", 0.5), 0.05);
        assert_eq!(overall("rendering", 1.0), 1.0);
    }

    #[test]
    fn parses_composition_lists() {
        let l = parse_compositions_line(
            r#"{"type":"compositions","compositions":[{"id":"Intro","width":1920,"height":1080,"fps":30,"durationInFrames":150}]}"#,
        )
        .unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(
            (l[0].id.as_str(), l[0].width, l[0].duration_in_frames),
            ("Intro", 1920, 150)
        );
        assert_eq!(l[0].source, "project");
        assert!(parse_compositions_line(r#"{"type":"done"}"#).is_none());
    }
}
