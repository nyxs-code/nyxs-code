//! Managing video projects from the picker: delete (to the OS trash), rename, duplicate, reveal.

use std::fs;
use std::path::{Path, PathBuf};

use super::project::{self, VideoProjectInfo};
use super::{export, player};

/// Whether `dir` is the project's own folder under `videos/` (not an adopted project elsewhere,
/// which is the user's code and never moved or trashed by Nyxs).
fn under_videos(workspace: &str, slug: &str, dir: &Path) -> bool {
    PathBuf::from(workspace)
        .join(project::VIDEOS_DIR)
        .join(slug)
        == dir
}

fn remove_cache(workspace: &str, slug: &str) {
    if let Ok(cache) = project::cache_dir(workspace, slug) {
        if let Err(e) = fs::remove_dir_all(&cache) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::info!("video: couldn't remove {}: {e}", cache.display());
            }
        }
    }
}

/// A project under `videos/` goes to the OS trash (recoverable); an adopted Remotion project is
/// only forgotten (its folder stays as it is). Its player stops and its cache goes.
pub fn delete(workspace: &str, slug: &str) -> Result<(), String> {
    let dir = project::project_dir(workspace, slug)?;
    player::kill(workspace, slug)?;
    if under_videos(workspace, slug, &dir) {
        trash::delete(&dir).map_err(|e| {
            format!(
                "Couldn't move {} to the trash: {e}. Close anything using its files and try again.",
                dir.display()
            )
        })?;
    } else {
        let list: Vec<project::Adopted> = project::read_adopted(workspace)
            .into_iter()
            .filter(|a| a.slug != slug)
            .collect();
        project::write_adopted(workspace, &list)?;
    }
    remove_cache(workspace, slug);
    Ok(())
}

/// Sets the display name and, for a project under `videos/`, moves its folder to the name's
/// slug when that one is free (else the folder keeps its slug). The cache follows the folder.
pub fn rename(workspace: &str, slug: &str, name: &str) -> Result<VideoProjectInfo, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A project needs a name.".into());
    }
    let dir = project::project_dir(workspace, slug)?;
    if !under_videos(workspace, slug, &dir) {
        return Err("Adopted Remotion projects keep their own folder name.".into());
    }
    project::write_name(&dir, name)?;
    let root = PathBuf::from(workspace).join(project::VIDEOS_DIR);
    let wanted = project::slugify(name);
    let free = project::free_slug(workspace, &root, name);
    if wanted == slug || free != wanted {
        return Ok(project::project_info(workspace, slug, &dir));
    }
    // The player holds files open (and is keyed by the folder): it restarts on the new one.
    player::kill(workspace, slug)?;
    let new_dir = root.join(&wanted);
    if let Err(e) = fs::rename(&dir, &new_dir) {
        log::info!("video: kept the folder of {slug}: {e}");
        return Ok(project::project_info(workspace, slug, &dir));
    }
    if let (Ok(old), Ok(new)) = (
        project::cache_dir(workspace, slug),
        project::cache_dir(workspace, &wanted),
    ) {
        if old.exists() && fs::rename(&old, &new).is_err() {
            remove_cache(workspace, slug);
        }
    }
    Ok(project::project_info(workspace, &wanted, &new_dir))
}

/// Copies a light project (data, scenes, media; not out/) under a new name.
pub fn duplicate(
    workspace: &str,
    slug: &str,
    name: Option<&str>,
) -> Result<VideoProjectInfo, String> {
    let dir = project::project_dir(workspace, slug)?;
    if !project::is_light(&dir) {
        return Err(
            "Only Nyxs projects can be duplicated; convert an old one to the light layout first."
                .into(),
        );
    }
    let current = project::project_info(workspace, slug, &dir).name;
    let name = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{current} (copy)"));
    let root = PathBuf::from(workspace).join(project::VIDEOS_DIR);
    let new_slug = project::free_slug(workspace, &root, &name);
    let new_dir = root.join(&new_slug);
    export::copy_tree(&dir, &new_dir, &["out", "node_modules"])
        .map_err(|e| format!("Couldn't copy the project: {e}"))?;
    project::write_name(&new_dir, &name)?;
    Ok(project::project_info(workspace, &new_slug, &new_dir))
}

pub fn reveal(workspace: &str, slug: &str) -> Result<(), String> {
    let dir = project::project_dir(workspace, slug)?;
    crate::agent::agent_reveal_path(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(name: &str) -> PathBuf {
        std::env::set_var(
            "NYXS_PROJECTS_ROOT",
            std::env::temp_dir().join("nyxs-test-projects"),
        );
        let ws =
            std::env::temp_dir().join(format!("nyxs-video-manage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ws);
        let dir = ws.join("videos").join("intro");
        fs::create_dir_all(dir.join("media")).unwrap();
        fs::create_dir_all(dir.join("out")).unwrap();
        fs::write(dir.join("media/a.mp4"), "v").unwrap();
        fs::write(dir.join("out/r.mp4"), "render").unwrap();
        let t = project::initial_timeline(
            None,
            "Intro",
            &project::Preset {
                width: 1920,
                height: 1080,
                fps: 30.0,
                duration_in_frames: 30,
            },
        );
        project::write_json(&dir.join(project::TIMELINE), &t).unwrap();
        ws
    }

    #[test]
    fn renames_and_duplicates() {
        let ws = workspace("rename");
        let w = ws.to_string_lossy().into_owned();
        let cache = project::cache_dir(&w, "intro").unwrap();
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("x"), "c").unwrap();

        let info = rename(&w, "intro", "Launch Teaser").unwrap();
        assert_eq!(
            (info.slug.as_str(), info.name.as_str()),
            ("launch-teaser", "Launch Teaser")
        );
        assert!(ws.join("videos/launch-teaser/media/a.mp4").is_file());
        assert!(project::cache_dir(&w, "launch-teaser")
            .unwrap()
            .join("x")
            .is_file());

        // Same slug: only the name changes.
        let info = rename(&w, "launch-teaser", "Launch  teaser!").unwrap();
        assert_eq!(
            (info.slug.as_str(), info.name.as_str()),
            ("launch-teaser", "Launch  teaser!")
        );

        let copy = duplicate(&w, "launch-teaser", Some("Launch teaser (copia)")).unwrap();
        assert_eq!(copy.slug, "launch-teaser-copia");
        assert_eq!(copy.name, "Launch teaser (copia)");
        let copied = ws.join("videos/launch-teaser-copia");
        assert!(copied.join("media/a.mp4").is_file());
        assert!(!copied.join("out").exists(), "renders aren't copied");
        let again = duplicate(&w, "launch-teaser", None).unwrap();
        assert_eq!(again.name, "Launch  teaser! (copy)");

        // A name whose slug is taken keeps the folder.
        let info = rename(&w, "launch-teaser-copy", "Launch teaser (copia)").unwrap();
        assert_eq!(info.slug, "launch-teaser-copy");
        let _ = fs::remove_dir_all(&ws);
    }

    /// Really moves a tiny project to the OS trash (it lands in the user's recycle bin), so it
    /// only runs on demand: `cargo test --lib video::manage -- --ignored`.
    #[test]
    #[ignore]
    fn deletes_to_the_trash() {
        let ws = workspace("nyxs-trash-test");
        let w = ws.to_string_lossy().into_owned();
        let cache = project::cache_dir(&w, "intro").unwrap();
        fs::create_dir_all(&cache).unwrap();
        delete(&w, "intro").unwrap();
        assert!(!ws.join("videos/intro").exists());
        assert!(!cache.exists());
        assert!(project::project_dir(&w, "intro").is_err());
        let _ = fs::remove_dir_all(&ws);
    }
}
