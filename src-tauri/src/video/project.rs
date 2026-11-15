//! Video projects on disk. A Nyxs project is a light folder `<workspace>/videos/<slug>/` with
//! only its data (timeline.json, scenes/, media/, out/); Remotion and the engine come from the
//! shared runtime (`runtime.rs`). An adopted Remotion project keeps its own node_modules.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::env::{self, Toolchain};

pub(super) const VIDEOS_DIR: &str = "videos";
pub(super) const TIMELINE: &str = "timeline.json";
/// A display name kept by projects of the first design.
const LEGACY_META: &str = "nyxs/project.json";
/// The display name set by renaming (`{ "name": ... }`); without it the first composition's.
pub const NAME_FILE: &str = "nyxs.json";
const INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_in_frames: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompositionInfo {
    pub id: String,
    pub name: String,
    pub width: u64,
    pub height: u64,
    pub fps: f64,
    pub duration_in_frames: u64,
    /// `"timeline"` for a composition of timeline.json, `"project"` for one an adopted
    /// Remotion project registers in its own code.
    #[serde(default = "timeline_source")]
    pub source: String,
}

fn timeline_source() -> String {
    "timeline".into()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoProjectInfo {
    pub slug: String,
    /// `"nyxs"` for a light project under `videos/`, `"remotion"` for an adopted Remotion
    /// project, `"legacy"` for one made with the first design (own node_modules and engine
    /// copy), which `video_convert_to_light` turns into a light one.
    pub kind: &'static str,
    pub path: String,
    pub name: String,
    pub compositions: Vec<CompositionInfo>,
    /// Milliseconds since the epoch: when timeline.json last changed.
    pub updated_at: u64,
    /// The last still rendered for this project (an absolute path in the app's cache).
    pub thumbnail: Option<String>,
    /// Whether it can play and render now: the shared runtime is installed (Nyxs projects), or
    /// the project's own node_modules exists (adopted ones).
    pub installed: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InstallProgress<'a> {
    slug: &'a str,
    line: &'a str,
    /// Set on the last event of an install.
    #[serde(skip_serializing_if = "Option::is_none")]
    done: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

/// A folder name for a video: lowercase ASCII letters, digits and dashes, accents folded.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        let c = fold_accent(c);
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "video".into()
    } else {
        out
    }
}

fn fold_accent(c: char) -> char {
    match c {
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ñ' => 'n',
        'ç' => 'c',
        'ß' => 's',
        other => other,
    }
}

/// A slug from the frontend or the agent names one folder under `videos/`: no separators, no
/// `..`, nothing hidden.
pub fn check_slug(slug: &str) -> Result<(), String> {
    let bad = slug.is_empty()
        || slug.starts_with('.')
        || slug.contains(['/', '\\', ':'])
        || slug.chars().any(char::is_control);
    if bad {
        Err(format!("Invalid video project name: {slug:?}"))
    } else {
        Ok(())
    }
}

pub fn check_workspace(workspace: &str) -> Result<PathBuf, String> {
    if crate::remote::is_remote(workspace) {
        return Err("Videos are only supported in local projects.".into());
    }
    let ws = PathBuf::from(workspace);
    if !ws.is_dir() {
        return Err(format!("The project folder doesn't exist: {workspace}"));
    }
    Ok(ws)
}

/// A Remotion project elsewhere in the workspace that Nyxs opened (`video_adopt_project`).
#[derive(Serialize, Deserialize, Clone)]
pub struct Adopted {
    pub slug: String,
    pub path: String,
}

fn adopted_file(workspace: &str) -> Result<PathBuf, String> {
    crate::project_paths::project_feature_dir(workspace, "video")
        .map(|d| d.join("adopted.json"))
        .ok_or_else(|| "Couldn't find the home folder for the video cache.".to_string())
}

pub fn read_adopted(workspace: &str) -> Vec<Adopted> {
    let Ok(file) = adopted_file(workspace) else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(&file) else {
        return Vec::new();
    };
    match serde_json::from_str(&text) {
        Ok(list) => list,
        Err(e) => {
            // Moved aside, not overwritten: only the list is lost, the projects are intact.
            eprintln!(
                "video: {} is not valid ({e}); starting over",
                file.display()
            );
            let _ = fs::rename(&file, file.with_extension("json.corrupt"));
            Vec::new()
        }
    }
}

pub fn write_adopted(workspace: &str, list: &[Adopted]) -> Result<(), String> {
    let file = adopted_file(workspace)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    write_json(
        &file,
        &serde_json::to_value(list).map_err(|e| e.to_string())?,
    )
}

pub fn project_dir(workspace: &str, slug: &str) -> Result<PathBuf, String> {
    check_slug(slug)?;
    let dir = check_workspace(workspace)?.join(VIDEOS_DIR).join(slug);
    if dir.join(TIMELINE).is_file() {
        return Ok(dir);
    }
    read_adopted(workspace)
        .into_iter()
        .find(|a| a.slug == slug)
        .map(|a| PathBuf::from(a.path))
        .filter(|p| p.join(TIMELINE).is_file())
        .ok_or_else(|| format!("No video project at {}", dir.display()))
}

/// The Remotion entry point of a project, relative to it: `remotion.config.*`'s
/// `setEntryPoint(...)`, else the usual places.
pub fn entry_point(dir: &Path) -> String {
    let re = regex::Regex::new(r#"setEntryPoint\(\s*["'`]([^"'`]+)["'`]"#).expect("regex");
    for config in [
        "remotion.config.ts",
        "remotion.config.js",
        "remotion.config.mjs",
    ] {
        if let Ok(text) = fs::read_to_string(dir.join(config)) {
            if let Some(c) = re.captures(&text) {
                return c[1].trim_start_matches("./").to_string();
            }
        }
    }
    [
        "src/index.ts",
        "src/index.tsx",
        "src/index.js",
        "src/index.jsx",
        "remotion/index.ts",
        "remotion/index.tsx",
        "src/remotion/index.ts",
        "src/remotion/index.tsx",
    ]
    .iter()
    .find(|p| dir.join(p).is_file())
    .unwrap_or(&"src/index.ts")
    .to_string()
}

/// Where an adopted project's own compositions are remembered (listing them needs a bundle).
pub fn own_compositions_file(workspace: &str, slug: &str) -> Result<PathBuf, String> {
    Ok(cache_dir(workspace, slug)?.join("compositions.json"))
}

/// The project's cache: `~/.nyxs/projects/<encoded>/video/<slug>/`.
pub fn cache_dir(workspace: &str, slug: &str) -> Result<PathBuf, String> {
    check_slug(slug)?;
    crate::project_paths::project_feature_dir(workspace, "video")
        .map(|d| d.join(slug))
        .ok_or_else(|| "Couldn't find the home folder for the video cache.".to_string())
}

/// The project's name file, else the first design's one.
pub fn read_name(dir: &Path) -> Option<String> {
    [dir.join(NAME_FILE), dir.join(LEGACY_META)]
        .iter()
        .filter_map(|f| fs::read_to_string(f).ok())
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .find_map(|v| v.get("name")?.as_str().map(str::to_string))
        .filter(|n| !n.trim().is_empty())
}

pub fn write_name(dir: &Path, name: &str) -> Result<(), String> {
    write_json(&dir.join(NAME_FILE), &json!({ "name": name.trim() }))
}

/// The thumbnail rendered automatically at ~10 % of the first composition.
pub fn auto_poster_path(workspace: &str, slug: &str) -> Result<PathBuf, String> {
    Ok(cache_dir(workspace, slug)?.join("poster-auto.png"))
}

pub fn poster_path(workspace: &str, slug: &str) -> Result<PathBuf, String> {
    Ok(cache_dir(workspace, slug)?.join("poster.png"))
}

pub fn read_timeline_value(dir: &Path) -> Result<Value, String> {
    let path = dir.join(TIMELINE);
    let text =
        fs::read_to_string(&path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{} is not valid JSON: {e}", path.display()))
}

fn compositions_of(timeline: &Value) -> Vec<CompositionInfo> {
    let Some(list) = timeline.get("compositions").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|c| {
            let id = c.get("id")?.as_str()?.to_string();
            Some(CompositionInfo {
                name: c
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                width: c.get("width").and_then(Value::as_u64).unwrap_or(0),
                height: c.get("height").and_then(Value::as_u64).unwrap_or(0),
                fps: c.get("fps").and_then(Value::as_f64).unwrap_or(0.0),
                duration_in_frames: c
                    .get("durationInFrames")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                id,
                source: timeline_source(),
            })
        })
        .collect()
}

pub fn project_info(workspace: &str, slug: &str, dir: &Path) -> VideoProjectInfo {
    let timeline = read_timeline_value(dir).unwrap_or(Value::Null);
    let mut compositions = compositions_of(&timeline);
    let kind = if super::convert::is_legacy(dir) {
        "legacy"
    } else if PathBuf::from(workspace).join(VIDEOS_DIR).join(slug) == dir {
        "nyxs"
    } else {
        "remotion"
    };
    if kind != "nyxs" {
        let own: Vec<CompositionInfo> = own_compositions_file(workspace, slug)
            .ok()
            .and_then(|f| fs::read_to_string(f).ok())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        for mut c in own {
            if !compositions.iter().any(|x| x.id == c.id) {
                c.source = "project".into();
                compositions.push(c);
            }
        }
    }
    let name = read_name(dir)
        .or_else(|| compositions.first().map(|c| c.name.clone()))
        .unwrap_or_else(|| slug.to_string());
    let updated_at = fs::metadata(dir.join(TIMELINE))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // The automatic poster (refreshed in the background when timeline.json changes), else the
    // last still rendered by hand.
    let thumbnail = [
        auto_poster_path(workspace, slug),
        poster_path(workspace, slug),
    ]
    .into_iter()
    .flatten()
    .find(|p| p.is_file())
    .map(|p| p.to_string_lossy().into_owned());
    VideoProjectInfo {
        slug: slug.to_string(),
        kind,
        path: dir.to_string_lossy().into_owned(),
        name,
        compositions,
        updated_at,
        thumbnail,
        installed: if is_light(dir) {
            super::runtime::known_ready()
        } else {
            dir.join("node_modules").is_dir()
        },
    }
}

/// Every folder under `videos/` with a timeline.json, and the adopted Remotion projects still
/// on disk, newest first.
pub fn list(workspace: &str) -> Result<Vec<VideoProjectInfo>, String> {
    let root = check_workspace(workspace)?.join(VIDEOS_DIR);
    let mut out: Vec<VideoProjectInfo> = fs::read_dir(&root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join(TIMELINE).is_file())
        .filter_map(|e| {
            let slug = e.file_name().to_string_lossy().into_owned();
            check_slug(&slug).ok()?;
            Some(project_info(workspace, &slug, &e.path()))
        })
        .collect();
    for a in read_adopted(workspace) {
        let dir = PathBuf::from(&a.path);
        if dir.join(TIMELINE).is_file() && !out.iter().any(|p| p.slug == a.slug) {
            out.push(project_info(workspace, &a.slug, &dir));
        }
    }
    out.sort_by_key(|p| std::cmp::Reverse(p.updated_at));
    Ok(out)
}

pub fn check_preset(p: &Preset) -> Result<(), String> {
    if !(16..=8192).contains(&p.width) || !(16..=8192).contains(&p.height) {
        return Err(format!("Invalid video size {}×{}.", p.width, p.height));
    }
    if !(p.fps > 0.0 && p.fps <= 240.0) {
        return Err(format!("Invalid frame rate {}.", p.fps));
    }
    if p.duration_in_frames == 0 {
        return Err("A video needs at least one frame.".into());
    }
    Ok(())
}

/// `template` with the preset applied to its first composition, or an empty timeline (one
/// composition, a video, a text and an audio track) like `emptyTimeline`.
pub fn initial_timeline(template: Option<Value>, name: &str, p: &Preset) -> Value {
    let fps = if p.fps.fract() == 0.0 {
        json!(p.fps as u64)
    } else {
        json!(p.fps)
    };
    let mut timeline = template
        .filter(|t| {
            t.get("compositions")
                .and_then(Value::as_array)
                .is_some_and(|c| !c.is_empty())
        })
        .unwrap_or_else(|| {
            json!({
                "version": 1,
                "compositions": [{
                    "id": "Main",
                    "name": name,
                    "width": p.width,
                    "height": p.height,
                    "fps": fps,
                    "durationInFrames": p.duration_in_frames,
                    "background": "#000000",
                    "tracks": [
                        { "id": "track-video-1", "name": "Video 1", "kind": "video", "clips": [] },
                        { "id": "track-text-1", "name": "Text 1", "kind": "text", "clips": [] },
                        { "id": "track-audio-1", "name": "Audio 1", "kind": "audio", "clips": [] }
                    ],
                    "markers": []
                }],
                "assets": []
            })
        });
    if let Some(c) = timeline
        .get_mut("compositions")
        .and_then(Value::as_array_mut)
        .and_then(|c| c.first_mut())
        .and_then(Value::as_object_mut)
    {
        c.insert("name".into(), json!(name));
        c.insert("width".into(), json!(p.width));
        c.insert("height".into(), json!(p.height));
        c.insert("fps".into(), fps);
        c.insert("durationInFrames".into(), json!(p.duration_in_frames));
    }
    timeline
}

pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    text.push('\n');
    crate::agent::text_io::write_atomic(path, text.as_bytes())
        .map_err(|e| format!("Couldn't write {}: {e}", path.display()))
}

/// A slug free both under `videos/` and among the adopted projects.
pub fn free_slug(workspace: &str, root: &Path, name: &str) -> String {
    let adopted: Vec<String> = read_adopted(workspace)
        .into_iter()
        .map(|a| a.slug)
        .collect();
    let base = slugify(name);
    let free = |s: &str| !root.join(s).exists() && !adopted.iter().any(|a| a == s);
    if free(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|s| free(s))
        .unwrap_or(base)
}

pub fn create(
    app: &AppHandle,
    workspace: &str,
    name: &str,
    preset: Preset,
) -> Result<VideoProjectInfo, String> {
    let (slug, dir) = scaffold(app, workspace, name, preset)?;
    Ok(project_info(workspace, &slug, &dir))
}

/// Writes a light project into `videos/<slug>/`: timeline.json, scenes/, media/, a .gitignore
/// for out/ and a tsconfig.json pointing editors at the runtime. Nothing is installed.
pub fn scaffold(
    app: &AppHandle,
    workspace: &str,
    name: &str,
    preset: Preset,
) -> Result<(String, PathBuf), String> {
    check_preset(&preset)?;
    let ws = check_workspace(workspace)?;
    let root = ws.join(VIDEOS_DIR);
    fs::create_dir_all(&root).map_err(|e| format!("Couldn't create {}: {e}", root.display()))?;
    let name = name.trim();
    let name = if name.is_empty() { "Video" } else { name };
    let slug = free_slug(workspace, &root, name);
    let dir = root.join(&slug);
    for sub in ["scenes", "media"] {
        fs::create_dir_all(dir.join(sub))
            .map_err(|e| format!("Couldn't create {}: {e}", dir.join(sub).display()))?;
    }
    write_json(&dir.join(TIMELINE), &initial_timeline(None, name, &preset))?;
    crate::agent::text_io::write_atomic(&dir.join(".gitignore"), b"out/\n")
        .map_err(|e| format!("Couldn't write the .gitignore: {e}"))?;
    let runtime = PathBuf::from(super::runtime::status(app)?.path);
    write_tsconfig(&dir, &runtime)?;
    Ok((slug, dir))
}

/// A Nyxs project (data only) rather than a Remotion project with its own package.json.
pub fn is_light(dir: &Path) -> bool {
    !dir.join("package.json").is_file()
}

/// The folder asset `src` paths are relative to: the project itself for a Nyxs project
/// ("media/x.mp4"), `public/` for an adopted Remotion project.
pub fn media_base(dir: &Path) -> PathBuf {
    if is_light(dir) {
        dir.to_path_buf()
    } else {
        dir.join("public")
    }
}

/// The tsconfig.json of a light project: only `paths` into the runtime, so editors and the LSP
/// resolve `remotion` and React in scenes/. Paths use `/` on every system.
pub fn tsconfig(runtime: &Path) -> Value {
    let rt = runtime.to_string_lossy().replace('\\', "/");
    json!({
        "compilerOptions": {
            "target": "ES2022",
            "module": "ESNext",
            "moduleResolution": "Bundler",
            "jsx": "react-jsx",
            "strict": true,
            "skipLibCheck": true,
            "noEmit": true,
            "resolveJsonModule": true,
            "esModuleInterop": true,
            "baseUrl": ".",
            "paths": {
                "@project/*": ["./*"],
                "*": [format!("{rt}/node_modules/*"), format!("{rt}/node_modules/@types/*")]
            },
            "typeRoots": [format!("{rt}/node_modules/@types")]
        },
        "include": ["scenes/**/*", "*.json"]
    })
}

/// Writes the tsconfig.json, or points an existing generated one at a newer runtime. One the
/// user wrote themselves (no `video-runtime` path in it) is left alone.
pub fn write_tsconfig(dir: &Path, runtime: &Path) -> Result<(), String> {
    let file = dir.join("tsconfig.json");
    let wanted = tsconfig(runtime);
    if let Ok(text) = fs::read_to_string(&file) {
        let current: Option<Value> = serde_json::from_str(&text).ok();
        if current.as_ref() == Some(&wanted) || !text.contains("video-runtime") {
            return Ok(());
        }
    }
    write_json(&file, &wanted)
}

/// `npm install` in an adopted Remotion project (Nyxs projects use the shared runtime), each
/// output line sent as a `video-install-progress` event.
pub fn install_own(app: &AppHandle, slug: &str, dir: &Path) -> Result<(), String> {
    let result = run_install(app, slug, dir);
    let (line, error) = match &result {
        Ok(()) => ("Dependencies installed.".to_string(), None),
        Err(e) => (e.clone(), Some(e.as_str())),
    };
    let _ = app.emit(
        "video-install-progress",
        InstallProgress {
            slug,
            line: &line,
            done: Some(true),
            error,
        },
    );
    result
}

fn run_install(app: &AppHandle, slug: &str, dir: &Path) -> Result<(), String> {
    let tc: Toolchain = env::toolchain();
    let mut cmd = tc.command(tc.npm()?, dir);
    cmd.args(["install", "--no-audit", "--no-fund", "--loglevel=http"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start npm install: {e}"))?;
    let tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let pipes: Vec<Box<dyn std::io::Read + Send>> = [
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    let readers: Vec<_> = pipes
        .into_iter()
        .map(|pipe| {
            let app = app.clone();
            let slug = slug.to_string();
            let tail = tail.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    let line = line.trim_end();
                    if line.is_empty() {
                        continue;
                    }
                    {
                        let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
                        t.push(line.to_string());
                        let excess = t.len().saturating_sub(12);
                        t.drain(..excess);
                    }
                    let _ = app.emit(
                        "video-install-progress",
                        InstallProgress {
                            slug: &slug,
                            line,
                            done: None,
                            error: None,
                        },
                    );
                }
            })
        })
        .collect();
    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s.code(),
            Ok(None) if start.elapsed() > INSTALL_TIMEOUT => {
                env::kill_tree(&mut child);
                return Err("npm install took more than 20 minutes and was stopped.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("Couldn't wait for npm install: {e}")),
        }
    };
    for r in readers {
        let _ = r.join();
    }
    if code == Some(0) {
        Ok(())
    } else {
        let tail = tail.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
        Err(format!(
            "npm install failed (exit {}):\n{tail}",
            code.map_or("?".into(), |c| c.to_string())
        ))
    }
}

pub fn read_timeline(dir: &Path) -> Result<String, String> {
    let path = dir.join(TIMELINE);
    fs::read_to_string(&path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))
}

/// Writes timeline.json atomically. Text that isn't JSON is refused: a broken document would
/// stop the player and the renders.
pub fn write_timeline(dir: &Path, json_text: &str) -> Result<(), String> {
    serde_json::from_str::<Value>(json_text)
        .map_err(|e| format!("The timeline is not valid JSON: {e}"))?;
    let path = dir.join(TIMELINE);
    crate::agent::text_io::write_atomic(&path, json_text.as_bytes())
        .map_err(|e| format!("Couldn't write {}: {e}", path.display()))
}

/// The asset with `id` in timeline.json, with its file inside the project.
pub fn find_asset(dir: &Path, id: &str) -> Result<(Value, PathBuf), String> {
    let timeline = read_timeline_value(dir)?;
    let asset = timeline
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|a| {
            a.iter()
                .find(|x| x.get("id").and_then(Value::as_str) == Some(id))
        })
        .cloned()
        .ok_or_else(|| format!("No asset {id:?} in the timeline."))?;
    let src = asset
        .get("src")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Asset {id:?} has no src."))?;
    if src.split(['/', '\\']).any(|c| c == "..") {
        return Err(format!("Asset {id:?} points outside the project: {src}"));
    }
    let file = media_base(dir).join(src);
    if !file.is_file() {
        return Err(format!(
            "The file of asset {id:?} is missing: {}",
            file.display()
        ));
    }
    Ok((asset, file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies_names() {
        assert_eq!(slugify("My Launch Video!"), "my-launch-video");
        assert_eq!(slugify("  Año nuevo — Señal  "), "ano-nuevo-senal");
        assert_eq!(slugify("***"), "video");
        assert_eq!(slugify("a//b__c"), "a-b-c");
        assert!(slugify(&"x".repeat(200)).len() <= 48);
    }

    #[test]
    fn dedupes_slugs() {
        let root = std::env::temp_dir().join(format!("nyxs-video-slug-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("intro")).unwrap();
        fs::create_dir_all(root.join("intro-2")).unwrap();
        std::env::set_var(
            "NYXS_PROJECTS_ROOT",
            std::env::temp_dir().join("nyxs-test-projects"),
        );
        let ws = "Z:/nyxs-video-no-such-workspace";
        assert_eq!(free_slug(ws, &root, "Intro"), "intro-3");
        assert_eq!(free_slug(ws, &root, "Outro"), "outro");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_slugs_that_leave_the_videos_folder() {
        assert!(check_slug("intro").is_ok());
        assert!(check_slug("..").is_err());
        assert!(check_slug("a/b").is_err());
        assert!(check_slug("a\\b").is_err());
        assert!(check_slug(".hidden").is_err());
        assert!(check_slug("").is_err());
    }

    #[test]
    fn builds_the_initial_timeline() {
        let p = Preset {
            width: 1080,
            height: 1920,
            fps: 30.0,
            duration_in_frames: 900,
        };
        let t = initial_timeline(None, "Reel", &p);
        let c = &t["compositions"][0];
        assert_eq!(t["version"], 1);
        assert_eq!(c["width"], 1080);
        assert_eq!(c["fps"], 30);
        assert_eq!(c["name"], "Reel");
        assert_eq!(c["tracks"].as_array().unwrap().len(), 3);

        let tpl = json!({ "version": 1, "assets": [], "compositions": [
            { "id": "Main", "name": "x", "width": 1, "height": 1, "fps": 1, "durationInFrames": 1,
              "background": "#fff", "tracks": [], "markers": [] }
        ]});
        let t = initial_timeline(Some(tpl), "Promo", &p);
        assert_eq!(t["compositions"][0]["background"], "#fff");
        assert_eq!(t["compositions"][0]["durationInFrames"], 900);
        assert_eq!(t["compositions"][0]["name"], "Promo");
    }

    #[test]
    fn writes_a_tsconfig_that_follows_the_runtime() {
        let dir = std::env::temp_dir().join(format!("nyxs-video-tsconfig-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let rt1 = Path::new(r"C:\Users\a\.nyxs\video-runtime\aaa");
        write_tsconfig(&dir, rt1).unwrap();
        let text = fs::read_to_string(dir.join("tsconfig.json")).unwrap();
        assert!(text.contains("C:/Users/a/.nyxs/video-runtime/aaa/node_modules/*"));
        let rt2 = Path::new("/home/a/.nyxs/video-runtime/bbb");
        write_tsconfig(&dir, rt2).unwrap();
        let text = fs::read_to_string(dir.join("tsconfig.json")).unwrap();
        assert!(text.contains("/home/a/.nyxs/video-runtime/bbb/node_modules/@types"));
        fs::write(dir.join("tsconfig.json"), "{ \"compilerOptions\": {} }").unwrap();
        write_tsconfig(&dir, rt1).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("tsconfig.json")).unwrap(),
            "{ \"compilerOptions\": {} }"
        );
        assert!(is_light(&dir));
        assert_eq!(media_base(&dir), dir);
        fs::write(dir.join("package.json"), "{}").unwrap();
        assert_eq!(media_base(&dir), dir.join("public"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_the_cache_out_of_the_project() {
        // The same shared root the other modules' tests use: the variable is process-wide, so
        // every test must agree on it rather than set and restore its own.
        let root = std::env::temp_dir().join("nyxs-test-projects");
        std::env::set_var("NYXS_PROJECTS_ROOT", &root);
        let cache = cache_dir("D:/work/site", "intro").unwrap();
        assert!(cache.starts_with(&root));
        assert!(cache.ends_with(Path::new("video").join("intro")));
        assert!(cache_dir("D:/work/site", "..").is_err());
    }
}
