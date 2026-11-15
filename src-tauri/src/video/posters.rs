//! Project thumbnails for the picker: a small still at ~10 % of the first composition, rendered
//! in the background when timeline.json changed since the last one, so listing stays instant.
//! `video-thumbnail-ready { slug, path }` tells the panel when one lands.

use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::{env, project, render, runtime};

/// Small enough to render fast and to sit in a card: a third of the composition's size.
const SCALE: f64 = 0.34;
const TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Ready {
    slug: String,
    path: String,
}

struct Queue {
    jobs: VecDeque<(String, String)>,
    queued: HashSet<String>,
    running: bool,
}

fn queue() -> &'static Mutex<Queue> {
    static Q: OnceLock<Mutex<Queue>> = OnceLock::new();
    Q.get_or_init(|| {
        Mutex::new(Queue {
            jobs: VecDeque::new(),
            queued: HashSet::new(),
            running: false,
        })
    })
}

/// What the poster was made from: timeline.json's size and modification time.
pub fn timeline_key(dir: &Path) -> Option<String> {
    let m = fs::metadata(dir.join(project::TIMELINE)).ok()?;
    let t = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(format!("{}-{}", m.len(), t.as_millis()))
}

fn key_file(workspace: &str, slug: &str) -> Result<PathBuf, String> {
    Ok(project::cache_dir(workspace, slug)?.join("poster-auto.key"))
}

/// Whether the project needs a new poster.
pub fn stale(workspace: &str, slug: &str, dir: &Path) -> bool {
    let Some(key) = timeline_key(dir) else {
        return false;
    };
    key_file(workspace, slug)
        .ok()
        .and_then(|f| fs::read_to_string(f).ok())
        .is_none_or(|k| k.trim() != key)
}

/// The frame ~10 % into a composition.
pub fn poster_frame(duration_in_frames: u64) -> u64 {
    (duration_in_frames as f64 * 0.1).floor() as u64
}

/// Queues a poster for every listed project whose timeline changed. Needs the runtime (or an
/// adopted project's own install); without it nothing is queued.
pub fn refresh(app: &AppHandle, workspace: &str, projects: &[project::VideoProjectInfo]) {
    for p in projects
        .iter()
        .filter(|p| p.installed && !p.compositions.is_empty())
    {
        if stale(workspace, &p.slug, Path::new(&p.path)) {
            enqueue(app, workspace, &p.slug);
        }
    }
}

fn enqueue(app: &AppHandle, workspace: &str, slug: &str) {
    let mut q = queue().lock().unwrap_or_else(|e| e.into_inner());
    let id = format!("{workspace}\n{slug}");
    if !q.queued.insert(id) {
        return;
    }
    q.jobs.push_back((workspace.to_string(), slug.to_string()));
    if q.running {
        return;
    }
    q.running = true;
    let app = app.clone();
    // One at a time: each is a Chrome render, and the picker can list many projects.
    std::thread::spawn(move || loop {
        let next = {
            let mut q = queue().lock().unwrap_or_else(|e| e.into_inner());
            match q.jobs.pop_front() {
                Some(job) => job,
                None => {
                    q.running = false;
                    return;
                }
            }
        };
        let (ws, slug) = next;
        match make(&app, &ws, &slug) {
            Ok(path) => {
                let _ = app.emit(
                    "video-thumbnail-ready",
                    Ready {
                        slug: slug.clone(),
                        path: path.to_string_lossy().into_owned(),
                    },
                );
            }
            Err(e) => log::info!("video: no thumbnail for {slug}: {e}"),
        }
        queue()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .queued
            .remove(&format!("{ws}\n{slug}"));
    });
}

/// Renders the poster. The key is written even when it fails, so a broken timeline isn't
/// retried on every listing, only after its next change.
fn make(app: &AppHandle, workspace: &str, slug: &str) -> Result<PathBuf, String> {
    let dir = project::project_dir(workspace, slug)?;
    let key = timeline_key(&dir).ok_or("no timeline.json")?;
    let result = runtime::ready_dir(app).and_then(|rt| render_poster(&rt, workspace, slug, &dir));
    if let Ok(f) = key_file(workspace, slug) {
        if let Some(parent) = f.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(f, &key);
    }
    result
}

/// Renders the poster with the runtime's render.mjs (it loads an adopted project's own packages).
pub(super) fn render_poster(
    runtime: &Path,
    workspace: &str,
    slug: &str,
    dir: &Path,
) -> Result<PathBuf, String> {
    let timeline = project::read_timeline_value(dir)?;
    let comp = timeline
        .get("compositions")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .ok_or("no composition")?;
    let id = comp
        .get("id")
        .and_then(Value::as_str)
        .ok_or("no composition id")?;
    let frames = comp
        .get("durationInFrames")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let out = project::auto_poster_path(workspace, slug)?;
    let partial = out.with_extension("partial.png");
    let job = format!("poster-{}", std::process::id());
    let bundle = project::cache_dir(workspace, slug)?
        .join("render")
        .join(format!("bundle-{job}"));
    let request = json!({
        "still": true,
        "compositionId": id,
        "frame": poster_frame(frames),
        "scale": SCALE,
        "output": partial.to_string_lossy(),
        "bundleDir": bundle.to_string_lossy(),
    });
    let cmd = render::script_command(runtime, workspace, slug, dir, &job, request)?;
    render::mark_busy(&job, true);
    let res = env::run_capture(cmd, TIMEOUT);
    render::mark_busy(&job, false);
    let _ = fs::remove_dir_all(&bundle);
    let _ = fs::remove_dir_all(bundle.with_file_name(format!("bundle-{job}-public")));
    let res = res?;
    if !res.ok() || !partial.is_file() {
        let _ = fs::remove_file(&partial);
        return Err(res.tail());
    }
    fs::rename(&partial, &out).map_err(|e| format!("Couldn't write {}: {e}", out.display()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_frame_and_notices_changes() {
        assert_eq!(poster_frame(300), 30);
        assert_eq!(poster_frame(5), 0);
        std::env::set_var(
            "NYXS_PROJECTS_ROOT",
            std::env::temp_dir().join("nyxs-test-projects"),
        );
        let dir = std::env::temp_dir().join(format!("nyxs-video-poster-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(project::TIMELINE), "{}").unwrap();
        let ws = dir.to_string_lossy().into_owned();
        assert!(stale(&ws, "p", &dir));
        let f = key_file(&ws, "p").unwrap();
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, timeline_key(&dir).unwrap()).unwrap();
        assert!(!stale(&ws, "p", &dir));
        std::thread::sleep(Duration::from_millis(20));
        fs::write(dir.join(project::TIMELINE), "{ }").unwrap();
        assert!(stale(&ws, "p", &dir));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(project::cache_dir(&ws, "p").unwrap());
    }
}
