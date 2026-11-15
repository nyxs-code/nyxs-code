//! Converting a project made with the first design (its own package.json, node_modules, src/
//! with a copy of the engine, public/, nyxs/) into the light layout (timeline.json, scenes/,
//! media/) that runs on the shared runtime.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::AppHandle;

use super::project::{self, VideoProjectInfo};
use super::{player, runtime};

/// Scenes every template shipped; the runtime has its own copies now.
const BUILT_IN_SCENES: &[&str] = &["TitleCard", "LowerThird", "LogoReveal"];
/// What the old layout had besides the data, moved to a backup in the cache.
const OLD_CODE: &[&str] = &[
    "src",
    "nyxs",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "public",
];

/// A Nyxs project of the first design: a package.json plus the template's `nyxs/project.json`
/// or its copy of the engine.
pub fn is_legacy(dir: &Path) -> bool {
    dir.join("package.json").is_file()
        && (dir.join("nyxs").join("project.json").is_file()
            || dir.join("src").join("engine").is_dir())
}

/// Where a file at `rel` under the old `public/` goes, relative to the project: `media/...`
/// stays as is, anything else moves under `media/`.
pub fn light_path(rel: &str) -> String {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_start_matches("./");
    if rel.starts_with("media/") {
        rel.to_string()
    } else {
        format!("media/{rel}")
    }
}

/// Points every asset `src` at its new place.
pub fn rewrite_sources(timeline: &mut Value) -> usize {
    let mut changed = 0;
    if let Some(assets) = timeline.get_mut("assets").and_then(Value::as_array_mut) {
        for a in assets {
            if let Some(src) = a.get("src").and_then(Value::as_str).map(str::to_string) {
                let new = light_path(&src);
                if new != src {
                    a["src"] = Value::String(new);
                    changed += 1;
                }
            }
        }
    }
    changed
}

fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(files_under(&p));
        } else {
            out.push(p);
        }
    }
    out
}

/// `rename`, or copy + delete when it crosses drives (the cache is often on another one).
fn move_path(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if from.is_dir() {
        for f in files_under(from) {
            let rel = f.strip_prefix(from).unwrap_or(&f);
            move_path(&f, &to.join(rel))?;
        }
        fs::remove_dir_all(from)
    } else {
        fs::copy(from, to)?;
        fs::remove_file(from)
    }
}

/// Moves the data into the light layout and the old code into `backup`.
pub fn convert_dir(dir: &Path, backup: &Path, runtime_dir: &Path) -> Result<(), String> {
    if !is_legacy(dir) {
        return Err(format!(
            "{} is not a project of the old layout.",
            dir.display()
        ));
    }
    let io = |what: &str, e: std::io::Error| format!("Couldn't {what}: {e}");
    let mut timeline = project::read_timeline_value(dir)?;

    // 1. Media: public/** → media/**.
    let public = dir.join("public");
    for f in files_under(&public) {
        let rel = f
            .strip_prefix(&public)
            .unwrap_or(&f)
            .to_string_lossy()
            .into_owned();
        if f.file_name().is_some_and(|n| n == ".gitkeep") {
            continue;
        }
        let target = dir.join(light_path(&rel));
        if !target.exists() {
            move_path(&f, &target).map_err(|e| io(&format!("move {}", f.display()), e))?;
        }
    }
    fs::create_dir_all(dir.join("media")).map_err(|e| io("create media/", e))?;

    // 2. The user's scenes: src/scenes/* except the template's own.
    let old_scenes = dir.join("src").join("scenes");
    fs::create_dir_all(dir.join("scenes")).map_err(|e| io("create scenes/", e))?;
    for f in files_under(&old_scenes) {
        let rel = f.strip_prefix(&old_scenes).unwrap_or(&f).to_path_buf();
        let stem = f
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let top_level = rel.components().count() == 1;
        if top_level && BUILT_IN_SCENES.contains(&stem.as_str()) {
            continue;
        }
        let target = dir.join("scenes").join(&rel);
        if !target.exists() {
            move_path(&f, &target).map_err(|e| io(&format!("move {}", f.display()), e))?;
        }
    }

    // 3. timeline.json with the new asset paths.
    if rewrite_sources(&mut timeline) > 0 {
        project::write_json(&dir.join(project::TIMELINE), &timeline)?;
    }

    // 4. The old code to the backup (in the app's cache), node_modules away.
    for name in OLD_CODE {
        let p = dir.join(name);
        if p.exists() {
            move_path(&p, &backup.join(name)).map_err(|e| io(&format!("back up {name}"), e))?;
        }
    }
    let modules = dir.join("node_modules");
    if modules.exists() {
        fs::remove_dir_all(&modules).map_err(|e| io("delete node_modules", e))?;
    }

    // 5. The light project's own files.
    crate::agent::text_io::write_atomic(&dir.join(".gitignore"), b"out/\n")
        .map_err(|e| io("write the .gitignore", e))?;
    project::write_json(&dir.join("tsconfig.json"), &project::tsconfig(runtime_dir))?;
    Ok(())
}

pub fn convert(app: &AppHandle, workspace: &str, slug: &str) -> Result<VideoProjectInfo, String> {
    let dir = project::project_dir(workspace, slug)?;
    if dir
        != PathBuf::from(workspace)
            .join(project::VIDEOS_DIR)
            .join(slug)
    {
        return Err("Only projects under videos/ can be converted.".into());
    }
    // Its player runs from the project's node_modules, which is about to go.
    player::kill(workspace, slug)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = project::cache_dir(workspace, slug)?.join(format!("legacy-backup-{stamp}"));
    let runtime_dir = PathBuf::from(runtime::status(app)?.path);
    convert_dir(&dir, &backup, &runtime_dir)?;
    log::info!(
        "video: converted {} (old code in {})",
        dir.display(),
        backup.display()
    );
    Ok(project::project_info(workspace, slug, &dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_old_public_paths() {
        assert_eq!(light_path("media/a.mp4"), "media/a.mp4");
        assert_eq!(light_path("logo.png"), "media/logo.png");
        assert_eq!(light_path("fonts\\Inter.woff2"), "media/fonts/Inter.woff2");
        let mut t = json!({ "assets": [{ "src": "media/a.mp4" }, { "src": "b.png" }] });
        assert_eq!(rewrite_sources(&mut t), 1);
        assert_eq!(t["assets"][1]["src"], "media/b.png");
    }

    #[test]
    fn converts_an_old_project() {
        let root = std::env::temp_dir().join(format!("nyxs-video-convert-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("demo");
        let w = |rel: &str, text: &str| {
            let p = dir.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        };
        w("package.json", "{}");
        w("package-lock.json", "{}");
        w("nyxs/project.json", "{\"name\":\"Demo\"}");
        w("src/engine/schema.ts", "x");
        w("src/scenes/TitleCard.tsx", "template");
        w("src/scenes/Mine.tsx", "mine");
        w("public/media/.gitkeep", "");
        w("public/media/clip.mp4", "video");
        w("public/logo.png", "png");
        w("node_modules/react/index.js", "x");
        w("out/old.mp4", "render");
        w(
            "timeline.json",
            r#"{"version":1,"compositions":[],"assets":[{"id":"a","src":"media/clip.mp4"},{"id":"b","src":"logo.png"}]}"#,
        );
        assert!(is_legacy(&dir));
        let backup = root.join("backup");
        convert_dir(&dir, &backup, Path::new("/rt")).unwrap();

        assert!(!is_legacy(&dir) && project::is_light(&dir));
        assert_eq!(
            fs::read_to_string(dir.join("media/clip.mp4")).unwrap(),
            "video"
        );
        assert_eq!(
            fs::read_to_string(dir.join("media/logo.png")).unwrap(),
            "png"
        );
        assert_eq!(
            fs::read_to_string(dir.join("scenes/Mine.tsx")).unwrap(),
            "mine"
        );
        assert!(!dir.join("scenes/TitleCard.tsx").exists());
        assert!(dir.join("out/old.mp4").is_file(), "renders stay");
        for gone in [
            "src",
            "nyxs",
            "public",
            "node_modules",
            "package.json",
            "package-lock.json",
        ] {
            assert!(!dir.join(gone).exists(), "{gone} should be gone");
        }
        assert_eq!(
            fs::read_to_string(backup.join("src/scenes/TitleCard.tsx")).unwrap(),
            "template"
        );
        assert!(backup.join("nyxs/project.json").is_file());
        let t = project::read_timeline_value(&dir).unwrap();
        assert_eq!(t["assets"][1]["src"], "media/logo.png");
        assert_eq!(
            fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "out/\n"
        );
        assert!(fs::read_to_string(dir.join("tsconfig.json"))
            .unwrap()
            .contains("/rt/node_modules"));
        let _ = fs::remove_dir_all(&root);
    }
}
