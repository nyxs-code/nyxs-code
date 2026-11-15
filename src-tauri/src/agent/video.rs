//! Videos for the WatchVideo tool. The WebView seeks through a video to take its frames, so it
//! needs a local file it may open over the asset protocol; a model that watches whole videos gets
//! the file itself, base64-encoded.

use super::text_io::write_atomic;
use super::vfs;
use super::*;
use std::hash::{Hash, Hasher};

const VIDEO_TYPES: &[(&str, &str)] = &[
    ("mp4", "video/mp4"),
    ("m4v", "video/mp4"),
    ("mov", "video/quicktime"),
    ("webm", "video/webm"),
    ("mkv", "video/x-matroska"),
    ("ogv", "video/ogg"),
    ("avi", "video/x-msvideo"),
    ("3gp", "video/3gpp"),
    ("mpeg", "video/mpeg"),
    ("mpg", "video/mpeg"),
    ("wmv", "video/x-ms-wmv"),
    ("flv", "video/x-flv"),
];

fn video_media_type(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    VIDEO_TYPES
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, mime)| *mime)
}

fn video_meta(path: &str) -> Result<(vfs::Meta, &'static str), String> {
    let media_type = video_media_type(path).ok_or_else(|| {
        format!("Unsupported video format: {path} (use mp4, mov, webm, mkv, avi, ogv, 3gp, mpeg, wmv or flv).")
    })?;
    let meta = vfs::metadata(path).map_err(|e| format!("Couldn't open {path}: {e}"))?;
    if !meta.is_file {
        return Err(format!("{path} is not a file."));
    }
    if meta.len == 0 {
        return Err(format!("{path} is empty."));
    }
    Ok((meta, media_type))
}

/// The cached local copy of a remote video: named after its path, size and mtime, so an edited
/// video gets a new copy instead of the stale one.
fn cache_name(path: &str, meta: &vfs::Meta) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (path, meta.len, meta.mtime).hash(&mut h);
    let ext = path
        .rsplit('.')
        .next()
        .unwrap_or("mp4")
        .to_ascii_lowercase();
    format!("{:016x}.{ext}", h.finish())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSource {
    /// A local file the WebView may open (`convertFileSrc`): the video itself, or for an `ssh://`
    /// one a copy in the project's `video-cache`.
    pub local_path: String,
    pub size: u64,
    pub media_type: String,
}

#[tauri::command(async)]
pub fn agent_prepare_video(
    app: AppHandle,
    path: String,
    scope: Option<String>,
    workspace: Option<String>,
) -> Result<VideoSource, String> {
    confine(&path, scope.as_deref())?;
    let (meta, media_type) = video_meta(&path)?;
    let local = if crate::remote::is_remote(&path) {
        let dir = crate::project_paths::project_feature_dir(
            workspace.as_deref().unwrap_or(&path),
            "video-cache",
        )
        .ok_or("Couldn't find Nyxs' data folder for the video copy.")?;
        let copy = dir.join(cache_name(&path, &meta));
        let cached = fs::metadata(&copy)
            .map(|m| m.len() == meta.len)
            .unwrap_or(false);
        if !cached {
            let bytes = vfs::read(&path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
            fs::create_dir_all(&dir).map_err(|e| format!("Couldn't copy the video: {e}"))?;
            write_atomic(&copy, &bytes).map_err(|e| format!("Couldn't copy the video: {e}"))?;
        }
        copy
    } else {
        PathBuf::from(&path)
    };
    app.asset_protocol_scope()
        .allow_file(&local)
        .map_err(|e| format!("Couldn't open the video: {e}"))?;
    Ok(VideoSource {
        local_path: local.to_string_lossy().into_owned(),
        size: meta.len,
        media_type: media_type.to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoData {
    pub base64: String,
    pub media_type: String,
    pub size: u64,
}

/// The whole video, for a model that watches it natively. The request carries it on every step
/// that still has it, so it is read again each time instead of being kept in the session.
#[tauri::command(async)]
pub fn agent_read_video(path: String, max_bytes: u64) -> Result<VideoData, String> {
    use base64::Engine;
    confine(&path, None)?;
    let (meta, media_type) = video_meta(&path)?;
    if meta.len > max_bytes {
        return Err(format!(
            "{path} is {} MB, over the {} MB a model can be sent whole.",
            meta.len / (1024 * 1024),
            max_bytes / (1024 * 1024)
        ));
    }
    let bytes = vfs::read(&path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    Ok(VideoData {
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        media_type: media_type.to_string(),
        size: meta.len,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_video_types_by_extension() {
        assert_eq!(video_media_type("C:\\clips\\demo.MP4"), Some("video/mp4"));
        assert_eq!(
            video_media_type("/tmp/a.b/clip.mov"),
            Some("video/quicktime")
        );
        assert_eq!(
            video_media_type("ssh://box/home/u/rec.webm"),
            Some("video/webm")
        );
        assert_eq!(video_media_type("notes.txt"), None);
        assert_eq!(video_media_type("no-extension"), None);
    }

    #[test]
    fn a_changed_video_gets_a_new_cache_name() {
        let meta = |len, mtime| vfs::Meta {
            is_dir: false,
            is_file: true,
            len,
            mtime,
        };
        let a = cache_name("ssh://box/v.mp4", &meta(10, 1));
        assert_eq!(a, cache_name("ssh://box/v.mp4", &meta(10, 1)));
        assert_ne!(a, cache_name("ssh://box/v.mp4", &meta(10, 2)));
        assert_ne!(a, cache_name("ssh://box/w.mp4", &meta(10, 1)));
        assert!(a.ends_with(".mp4"));
    }
}
