//! The music player's backend. Two sources need the machine: a folder of audio files the user
//! chose (their tags and covers are read here), and on Windows whatever other apps are playing
//! (`system`). The sound itself plays in the webview, in an `<audio>` on the asset protocol.

#[cfg(windows)]
mod system;

use base64::Engine;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::Accessor;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "m4a", "aac", "flac", "wav", "ogg", "oga", "opus"];
/// More than this and the list would stop being usable; the folder is read once per session.
const MAX_TRACKS: usize = 5000;
const MAX_DEPTH: usize = 8;
/// A cover travels to the webview as a data URL.
const MAX_COVER_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrack {
    path: String,
    title: String,
    artist: Option<String>,
    album: Option<String>,
    /// In seconds; 0 when the file doesn't say.
    duration: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicFolder {
    tracks: Vec<MusicTrack>,
    /// The folder had more songs than the list keeps.
    truncated: bool,
}

/// What another app is playing, as Windows reports it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPlayback {
    app_id: String,
    /// It plays inside Nyxs: the built-in browser, or the player's own `<audio>`.
    in_app: bool,
    title: String,
    artist: Option<String>,
    album: Option<String>,
    playing: bool,
    /// In seconds; both 0 for an app that doesn't report its timeline.
    position: f64,
    duration: f64,
    can_toggle: bool,
    can_next: bool,
    can_previous: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemAction {
    Toggle,
    Next,
    Previous,
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// "Artist - Title.mp3" for a file with no tags; otherwise the name is the title.
fn names_from_file(path: &Path) -> (String, Option<String>) {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    match stem.split_once(" - ") {
        Some((artist, title)) if !artist.trim().is_empty() && !title.trim().is_empty() => {
            (title.trim().to_string(), Some(artist.trim().to_string()))
        }
        _ => (stem, None),
    }
}

fn non_empty(s: Option<std::borrow::Cow<'_, str>>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// A file whose tags can't be read is still a song: it keeps the names from its file name.
fn read_track(path: &Path) -> MusicTrack {
    let (file_title, file_artist) = names_from_file(path);
    let mut track = MusicTrack {
        path: path.to_string_lossy().into_owned(),
        title: file_title,
        artist: file_artist,
        album: None,
        duration: 0.0,
    };
    let Ok(tagged) = lofty::read_from_path(path) else {
        return track;
    };
    track.duration = tagged.properties().duration().as_secs_f64();
    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        if let Some(title) = non_empty(tag.title()) {
            track.title = title;
        }
        if let Some(artist) = non_empty(tag.artist()) {
            track.artist = Some(artist);
        }
        track.album = non_empty(tag.album());
    }
    track
}

fn audio_files(root: &Path) -> (Vec<PathBuf>, bool) {
    let mut files: Vec<PathBuf> = walkdir::WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_audio(e.path()))
        .map(|e| e.into_path())
        .collect();
    // By path, so the songs of an album stay together and in the order of their file names.
    files.sort_by_key(|p| p.to_string_lossy().to_lowercase());
    let truncated = files.len() > MAX_TRACKS;
    files.truncate(MAX_TRACKS);
    (files, truncated)
}

fn scan_folder(root: &Path) -> Result<MusicFolder, String> {
    if !root.is_dir() {
        return Err(format!("Not a folder: {}", root.display()));
    }
    let (files, truncated) = audio_files(root);
    Ok(MusicFolder {
        tracks: files.iter().map(|p| read_track(p)).collect(),
        truncated,
    })
}

fn data_url(mime: &str, bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() || bytes.len() > MAX_COVER_BYTES || !mime.starts_with("image/") {
        return None;
    }
    let body = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{body}"))
}

fn track_cover(path: &Path) -> Option<String> {
    if !is_audio(path) {
        return None;
    }
    let tagged = lofty::read_from_path(path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let picture = tag.pictures().first()?;
    let mime = picture.mime_type().map_or("image/jpeg", |m| m.as_str());
    data_url(mime, picture.data())
}

/// The songs of a folder the user chose, with their tags.
#[tauri::command(async)]
pub fn music_scan_folder(path: String) -> Result<MusicFolder, String> {
    scan_folder(Path::new(&path))
}

/// Lets the player's `<audio>` read this one song: audio files only, and only the one playing,
/// so choosing a folder doesn't open everything else in it to the webview.
#[tauri::command(async)]
pub fn music_allow_track(app: AppHandle, path: String) -> Result<(), String> {
    let file = Path::new(&path);
    if !is_audio(file) || !file.is_file() {
        return Err(format!("Not an audio file: {path}"));
    }
    app.asset_protocol_scope()
        .allow_file(file)
        .map_err(|e| format!("Couldn't open {path}: {e}"))
}

/// The picture inside a song's tags, as a data URL.
#[tauri::command(async)]
pub fn music_track_cover(path: String) -> Option<String> {
    track_cover(Path::new(&path))
}

/// The tab of the webview that plays YouTube Music out of sight: `music_page_run` only reaches
/// this one, never a page the user opened in the browser.
const MUSIC_TAB: &str = "music-youtube";
const PAGE_TIMEOUT: Duration = Duration::from_secs(5);

/// Runs a script of the player's in its hidden page and answers with its result, as JSON.
#[tauri::command(async)]
pub fn music_page_run(app: AppHandle, script: String) -> Result<String, String> {
    let wv = crate::preview_webview::find(&app, MUSIC_TAB).ok_or("The music page isn't open.")?;
    let (send, receive) = std::sync::mpsc::channel();
    wv.eval_with_callback(script, move |result| {
        let _ = send.send(result);
    })
    .map_err(|e| format!("Couldn't reach the music page: {e}"))?;
    receive
        .recv_timeout(PAGE_TIMEOUT)
        .map_err(|_| "The music page didn't answer.".to_string())
}

/// What another app is playing right now, or nothing (always nothing outside Windows).
#[tauri::command(async)]
pub fn music_system_state() -> Result<Option<SystemPlayback>, String> {
    #[cfg(windows)]
    {
        system::state()
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

/// The cover Windows has for what is playing, as a data URL.
#[tauri::command(async)]
pub fn music_system_cover() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        system::cover()
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

/// Play/pause, next or previous in the app that is playing.
#[tauri::command(async)]
pub fn music_system_control(action: SystemAction) -> Result<(), String> {
    #[cfg(windows)]
    {
        system::control(action)
    }
    #[cfg(not(windows))]
    {
        let _ = action;
        Err("Controlling other apps' music is only available on Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A temp folder that goes away even when the test fails.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("nyxs-music-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn only_audio_files_count() {
        assert!(is_audio(Path::new("a/b.MP3")));
        assert!(is_audio(Path::new("c.flac")));
        assert!(!is_audio(Path::new("notas.txt")));
        assert!(!is_audio(Path::new("sin-extension")));
    }

    #[test]
    fn a_file_name_gives_the_artist_and_title() {
        assert_eq!(
            names_from_file(Path::new("x/Sesiones lo-fi - Noche en calma.mp3")),
            (
                "Noche en calma".to_string(),
                Some("Sesiones lo-fi".to_string())
            )
        );
        assert_eq!(
            names_from_file(Path::new("x/Noche.mp3")),
            ("Noche".to_string(), None)
        );
        assert_eq!(
            names_from_file(Path::new("x/ - Noche.mp3")),
            (" - Noche".to_string(), None)
        );
    }

    #[test]
    fn a_folder_lists_its_songs_in_order_even_with_unreadable_tags() {
        let dir = TempDir::new("scan");
        fs::create_dir_all(dir.0.join("Disco")).unwrap();
        fs::write(dir.0.join("Disco").join("02 - Dos.mp3"), b"no es audio").unwrap();
        fs::write(dir.0.join("Disco").join("01 - Uno.mp3"), b"no es audio").unwrap();
        fs::write(dir.0.join("portada.jpg"), b"x").unwrap();

        let folder = scan_folder(&dir.0).unwrap();
        assert!(!folder.truncated);
        let titles: Vec<&str> = folder.tracks.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles, ["Uno", "Dos"]);
        assert_eq!(folder.tracks[0].duration, 0.0);
    }

    #[test]
    fn scanning_what_is_not_a_folder_fails() {
        let dir = TempDir::new("missing");
        assert!(scan_folder(&dir.0.join("no-existe")).is_err());
    }

    #[test]
    fn a_cover_needs_an_image_of_a_reasonable_size() {
        assert_eq!(
            data_url("image/png", b"ab").as_deref(),
            Some("data:image/png;base64,YWI=")
        );
        assert_eq!(data_url("text/html", b"ab"), None);
        assert_eq!(data_url("image/png", b""), None);
        assert_eq!(data_url("image/png", &vec![0; MAX_COVER_BYTES + 1]), None);
    }

    #[test]
    fn only_audio_files_have_a_cover() {
        assert_eq!(track_cover(Path::new("secreto.txt")), None);
    }
}
