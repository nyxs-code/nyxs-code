//! Projects that start from something the user already has: video/image/audio files laid on a
//! new timeline, or a Remotion project elsewhere in the workspace that Nyxs adopts.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::media::{self, Asset};
use super::project::{self, Preset, VideoProjectInfo};

/// Used until the first video says what the composition should be.
const FALLBACK: Preset = Preset {
    width: 1920,
    height: 1080,
    fps: 30.0,
    duration_in_frames: 300,
};
const IMAGE_SECS: f64 = 3.0;
/// A video or audio file whose length couldn't be read gets this much on the timeline.
const UNKNOWN_SECS: f64 = 10.0;
/// The composition Nyxs adds to an adopted project's timeline.json.
const ADOPTED_COMPOSITION: &str = "NyxsTimeline";

fn track_id(comp: &mut Value, kind: &str, name: &str) -> String {
    let tracks = comp
        .as_object_mut()
        .map(|c| c.entry("tracks").or_insert_with(|| json!([])))
        .and_then(Value::as_array_mut);
    let Some(tracks) = tracks else {
        return String::new();
    };
    if let Some(id) = tracks
        .iter()
        .find(|t| t.get("kind").and_then(Value::as_str) == Some(kind))
        .and_then(|t| t.get("id")?.as_str())
    {
        return id.to_string();
    }
    let id = media::new_id("track");
    let track = json!({ "id": id, "name": name, "kind": kind, "clips": [] });
    // Index 0 is the bottom layer: footage goes under any text or overlay track.
    if kind == "video" {
        tracks.insert(0, track);
    } else {
        tracks.push(track);
    }
    id
}

fn push_clip(comp: &mut Value, track: &str, clip: Value) {
    if let Some(clips) = comp
        .get_mut("tracks")
        .and_then(Value::as_array_mut)
        .and_then(|ts| {
            ts.iter_mut()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(track))
        })
        .and_then(|t| t.get_mut("clips"))
        .and_then(Value::as_array_mut)
    {
        clips.push(clip);
    }
}

/// How many composition frames an asset lasts.
fn clip_frames(a: &Asset, comp_fps: f64) -> u64 {
    let secs = match a.kind {
        "image" => IMAGE_SECS,
        _ => match (a.duration_in_frames, a.fps) {
            (Some(d), Some(f)) if f > 0.0 => d as f64 / f,
            _ => UNKNOWN_SECS,
        },
    };
    ((secs * comp_fps).round() as u64).max(1)
}

/// Sizes the first composition after the first video (else the first image), adds the assets
/// and lays them end to end: videos and images on the video track, audio on the audio track.
pub fn lay_out_media(mut timeline: Value, assets: &[Asset]) -> Value {
    if let Some(list) = timeline.get_mut("assets").and_then(Value::as_array_mut) {
        for a in assets {
            list.push(serde_json::to_value(a).unwrap_or(Value::Null));
        }
    }
    // A project made from footage holds only that footage: the template's demo compositions,
    // clips and markers would overlap it (clips laid from frame 0 onto a demo track).
    if let Some(comps) = timeline
        .get_mut("compositions")
        .and_then(Value::as_array_mut)
    {
        comps.truncate(1);
    }
    let Some(comp) = timeline
        .get_mut("compositions")
        .and_then(Value::as_array_mut)
        .and_then(|c| c.first_mut())
    else {
        return timeline;
    };
    if let Some(tracks) = comp.get_mut("tracks").and_then(Value::as_array_mut) {
        for t in tracks.iter_mut() {
            t["clips"] = json!([]);
        }
    }
    comp["markers"] = json!([]);
    let source = assets
        .iter()
        .find(|a| a.kind == "video" && a.width.is_some())
        .or_else(|| {
            assets
                .iter()
                .find(|a| a.kind == "image" && a.width.is_some())
        });
    if let Some(s) = source {
        comp["width"] = json!(s.width);
        comp["height"] = json!(s.height);
        if let Some(f) = s.fps.filter(|_| s.kind == "video") {
            comp["fps"] = if f.fract() == 0.0 {
                json!(f as u64)
            } else {
                json!(f)
            };
        }
    }
    let fps = comp
        .get("fps")
        .and_then(Value::as_f64)
        .unwrap_or(FALLBACK.fps);
    let video_track = track_id(comp, "video", "Video 1");
    let audio_track = if assets.iter().any(|a| a.kind == "audio") {
        track_id(comp, "audio", "Audio 1")
    } else {
        String::new()
    };
    let (mut video_end, mut audio_end) = (0u64, 0u64);
    for a in assets {
        let frames = clip_frames(a, fps);
        let base = json!({
            "id": media::new_id("clip"),
            "name": a.name,
            "assetId": a.id,
            "durationInFrames": frames,
        });
        let (track, from, extra) = match a.kind {
            "video" => (
                &video_track,
                &mut video_end,
                json!({ "type": "video", "trimStart": 0, "fit": "contain" }),
            ),
            "image" => (
                &video_track,
                &mut video_end,
                json!({ "type": "image", "fit": "contain" }),
            ),
            "audio" => (
                &audio_track,
                &mut audio_end,
                json!({ "type": "audio", "trimStart": 0 }),
            ),
            _ => continue,
        };
        let mut clip = base;
        if let (Some(c), Some(e)) = (clip.as_object_mut(), extra.as_object()) {
            c.extend(e.clone());
            c.insert("from".into(), json!(*from));
        }
        *from += frames;
        push_clip(comp, track, clip);
    }
    let end = video_end.max(audio_end);
    if end > 0 {
        comp["durationInFrames"] = json!(end);
    }
    timeline
}

pub fn create_from_media(
    app: &AppHandle,
    workspace: &str,
    paths: &[String],
    name: Option<&str>,
) -> Result<VideoProjectInfo, String> {
    if paths.is_empty() {
        return Err("No files to make a video from.".into());
    }
    for p in paths {
        let path = Path::new(p);
        if !path.is_file() {
            return Err(format!("Not a file: {p}"));
        }
        media::media_kind(path).ok_or_else(|| format!("Unsupported media type: {p}"))?;
    }
    let name = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .or_else(|| {
            Path::new(&paths[0])
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "Video".into());
    let (slug, dir) = project::scaffold(app, workspace, &name, FALLBACK)?;
    // Probing needs the runtime's ffprobe. Without it the files are still imported, with the
    // fallback size and lengths.
    let assets = media::import(app, workspace, &slug, paths)?;
    let timeline = lay_out_media(project::read_timeline_value(&dir)?, &assets);
    project::write_json(&dir.join(project::TIMELINE), &timeline)?;
    Ok(project::project_info(workspace, &slug, &dir))
}

/// Whether a package.json depends on Remotion.
pub fn uses_remotion(package_json: &Value) -> bool {
    ["dependencies", "devDependencies", "peerDependencies"]
        .iter()
        .any(|k| {
            package_json
                .get(k)
                .and_then(|d| d.get("remotion"))
                .is_some()
        })
}

/// An adopted project's timeline.json: one empty composition, the size of the project's first
/// own composition when known. Its id stays clear of the project's own ones.
pub fn adopted_timeline(own: &[project::CompositionInfo]) -> Value {
    let first = own.first();
    let mut id = ADOPTED_COMPOSITION.to_string();
    while own.iter().any(|c| c.id == id) {
        id.push('2');
    }
    json!({
        "version": 1,
        "compositions": [{
            "id": id,
            "name": "Timeline",
            "width": first.map_or(FALLBACK.width as u64, |c| c.width),
            "height": first.map_or(FALLBACK.height as u64, |c| c.height),
            "fps": first.map_or(json!(30), |c| if c.fps.fract() == 0.0 { json!(c.fps as u64) } else { json!(c.fps) }),
            "durationInFrames": first.map_or(FALLBACK.duration_in_frames, |c| c.duration_in_frames),
            "background": "#000000",
            "tracks": [
                { "id": media::new_id("track"), "name": "Video 1", "kind": "video", "clips": [] },
                { "id": media::new_id("track"), "name": "Text 1", "kind": "text", "clips": [] },
                { "id": media::new_id("track"), "name": "Audio 1", "kind": "audio", "clips": [] }
            ],
            "markers": []
        }],
        "assets": []
    })
}

/// Opens a Remotion project from the workspace in Nyxs: writes a timeline.json if it has none
/// (nothing else in it changes; the runtime's player and render scripts run against its own
/// entry and node_modules) and remembers it in the video cache.
pub fn adopt(app: &AppHandle, workspace: &str, path: &str) -> Result<VideoProjectInfo, String> {
    let ws = project::check_workspace(workspace)?;
    let dir = fs::canonicalize(path).map_err(|e| format!("Couldn't open {path}: {e}"))?;
    let ws_canon = fs::canonicalize(&ws).unwrap_or(ws.clone());
    if !dir.starts_with(&ws_canon) {
        return Err(format!("{path} is outside the project folder."));
    }
    let pkg: Value = fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or_else(|| format!("{path} has no package.json."))?;
    if !uses_remotion(&pkg) {
        return Err(format!(
            "{path} is not a Remotion project (no \"remotion\" dependency)."
        ));
    }
    // Keep the path as the workspace spells it, so it matches what the frontend passes back.
    let dir = ws.join(dir.strip_prefix(&ws_canon).unwrap_or(Path::new("")));

    let videos = ws.join(project::VIDEOS_DIR);
    if dir.parent() == Some(videos.as_path()) && dir.join(project::TIMELINE).is_file() {
        let slug = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        return Ok(project::project_info(workspace, &slug, &dir));
    }
    let mut list = project::read_adopted(workspace);
    let dir_str = dir.to_string_lossy().into_owned();
    let slug = match list.iter().find(|a| same_path(&a.path, &dir_str)) {
        Some(a) => a.slug.clone(),
        None => {
            let name = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "remotion".into());
            let slug = project::free_slug(workspace, &videos, &name);
            list.push(project::Adopted {
                slug: slug.clone(),
                path: dir_str,
            });
            project::write_adopted(workspace, &list)?;
            slug
        }
    };

    let own = if dir.join("node_modules").is_dir() {
        match super::render::list_compositions(app, workspace, &slug, &dir) {
            Ok(own) => {
                if let Ok(file) = project::own_compositions_file(workspace, &slug) {
                    if let Some(parent) = file.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let _ =
                        project::write_json(&file, &serde_json::to_value(&own).unwrap_or_default());
                }
                own
            }
            Err(e) => {
                log::warn!("video: {e}");
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let timeline = dir.join(project::TIMELINE);
    if !timeline.is_file() {
        project::write_json(&timeline, &adopted_timeline(&own))?;
    }
    Ok(project::project_info(workspace, &slug, &dir))
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let p = p.replace('\\', "/");
        let p = p.trim_end_matches('/');
        if cfg!(windows) {
            p.to_lowercase()
        } else {
            p.to_string()
        }
    };
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(
        id: &str,
        kind: &'static str,
        frames: Option<u64>,
        fps: Option<f64>,
        size: Option<(u64, u64)>,
    ) -> Asset {
        Asset {
            id: id.into(),
            kind,
            src: format!("media/{id}"),
            name: id.into(),
            duration_in_frames: frames,
            fps,
            width: size.map(|s| s.0),
            height: size.map(|s| s.1),
        }
    }

    #[test]
    fn lays_media_end_to_end() {
        let tl = project::initial_timeline(None, "Demo", &FALLBACK);
        let assets = [
            asset("a", "video", Some(600), Some(60.0), Some((1080, 1920))),
            asset("b", "image", None, None, Some((800, 600))),
            asset("c", "audio", Some(90), Some(30.0), None),
            asset("d", "font", None, None, None),
        ];
        let tl = lay_out_media(tl, &assets);
        let comp = &tl["compositions"][0];
        assert_eq!(
            (
                comp["width"].clone(),
                comp["height"].clone(),
                comp["fps"].clone()
            ),
            (json!(1080), json!(1920), json!(60))
        );
        let tracks = comp["tracks"].as_array().unwrap();
        let video = tracks.iter().find(|t| t["kind"] == "video").unwrap()["clips"]
            .as_array()
            .unwrap()
            .clone();
        let audio = tracks.iter().find(|t| t["kind"] == "audio").unwrap()["clips"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(video.len(), 2);
        assert_eq!(
            (
                video[0]["from"].clone(),
                video[0]["durationInFrames"].clone()
            ),
            (json!(0), json!(600))
        );
        assert_eq!(
            (
                video[1]["type"].clone(),
                video[1]["from"].clone(),
                video[1]["durationInFrames"].clone()
            ),
            (json!("image"), json!(600), json!(180))
        );
        assert_eq!(
            (
                audio[0]["from"].clone(),
                audio[0]["durationInFrames"].clone()
            ),
            (json!(0), json!(180))
        );
        assert_eq!(comp["durationInFrames"], 780);
        assert_eq!(tl["assets"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn footage_replaces_the_template_demo() {
        // The template's timeline.json ships demo clips; footage laid from frame 0 used to land
        // on top of them (overlapping, unsorted track).
        let tl = json!({
            "version": 1,
            "assets": [],
            "compositions": [
                {
                    "id": "Main", "fps": 30, "width": 1920, "height": 1080, "durationInFrames": 240,
                    "markers": [{ "id": "m", "frame": 10, "label": "" }],
                    "tracks": [
                        { "id": "scenes", "kind": "video", "name": "Scenes", "clips": [
                            { "id": "logo", "type": "scene", "from": 0, "durationInFrames": 75 },
                            { "id": "outro", "type": "shape", "from": 165, "durationInFrames": 75 }
                        ] },
                        { "id": "text", "kind": "text", "name": "Text", "clips": [
                            { "id": "t", "type": "text", "from": 170, "durationInFrames": 70 }
                        ] }
                    ]
                },
                { "id": "Vertical", "fps": 30, "width": 1080, "height": 1920, "durationInFrames": 90, "markers": [], "tracks": [] }
            ]
        });
        let assets = [asset(
            "a",
            "video",
            Some(1890),
            Some(30.0),
            Some((1920, 1080)),
        )];
        let tl = lay_out_media(tl, &assets);
        let comps = tl["compositions"].as_array().unwrap();
        assert_eq!(comps.len(), 1);
        let comp = &comps[0];
        assert_eq!(comp["markers"], json!([]));
        let clips: Vec<&Value> = comp["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|t| t["clips"].as_array().unwrap())
            .collect();
        assert_eq!(clips.len(), 1);
        assert_eq!(
            (
                clips[0]["from"].clone(),
                clips[0]["durationInFrames"].clone()
            ),
            (json!(0), json!(1890))
        );
        assert_eq!(comp["durationInFrames"], 1890);
    }

    #[test]
    fn recognises_remotion_projects() {
        assert!(uses_remotion(
            &json!({ "dependencies": { "remotion": "4.0.0" } })
        ));
        assert!(uses_remotion(
            &json!({ "devDependencies": { "remotion": "^4" } })
        ));
        assert!(!uses_remotion(
            &json!({ "dependencies": { "react": "19" } })
        ));
    }

    #[test]
    fn keeps_the_adopted_composition_apart() {
        let own = vec![project::CompositionInfo {
            id: "NyxsTimeline".into(),
            name: "NyxsTimeline".into(),
            width: 1280,
            height: 720,
            fps: 25.0,
            duration_in_frames: 50,
            source: "project".into(),
        }];
        let t = adopted_timeline(&own);
        assert_eq!(t["compositions"][0]["id"], "NyxsTimeline2");
        assert_eq!(t["compositions"][0]["width"], 1280);
        assert_eq!(t["compositions"][0]["fps"], 25);
        assert_eq!(adopted_timeline(&[])["compositions"][0]["width"], 1920);
        assert!(same_path("C:\\a\\B\\", "c:/a/b") == cfg!(windows));
    }
}
