//! Media of a video project: importing files into `public/media/`, probing them, and the
//! thumbnails and waveforms the timeline draws (cached outside the project).

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use super::env::{self, Toolchain};
use super::project;
use super::runtime;

const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
const FFMPEG_TIMEOUT: Duration = Duration::from_secs(180);
/// Thumbnails are drawn in timeline rows; this height keeps them sharp on a 2× screen.
const THUMB_HEIGHT: u32 = 96;
/// Sample rate for waveforms: plenty for peaks and 4× less data than 16 kHz.
const WAVE_RATE: u32 = 4000;
/// Audio assets have no frame rate of their own; their duration is counted at this one.
const AUDIO_FPS: f64 = 30.0;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub kind: &'static str,
    pub src: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_in_frames: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
}

pub fn media_kind(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "mp4" | "m4v" | "mov" | "webm" | "mkv" | "avi" | "ogv" | "mpeg" | "mpg" | "3gp" => "video",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "bmp" | "svg" => "image",
        "mp3" | "wav" | "m4a" | "aac" | "ogg" | "oga" | "flac" | "opus" => "audio",
        "ttf" | "otf" | "woff" | "woff2" => "font",
        _ => return None,
    })
}

/// A file name safe for a URL path: letters, digits, `-`, `_`, `.`; spaces become dashes.
pub fn safe_file_name(name: &str) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut s: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-');
    let s = if s.is_empty() { "media" } else { s };
    format!("{s}{}", ext.to_ascii_lowercase())
}

/// `name.ext`, or `name-2.ext`, `name-3.ext`… when that file exists in `dir`.
pub fn dedupe_file(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| format!("{stem}-{n}{ext}"))
        .find(|n| !dir.join(n).exists())
        .unwrap_or_else(|| name.to_string())
}

pub fn new_id(prefix: &str) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let mut h = DefaultHasher::new();
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
        .hash(&mut h);
    SEQ.fetch_add(1, Ordering::Relaxed).hash(&mut h);
    std::process::id().hash(&mut h);
    format!("{prefix}-{}", to_base36(h.finish()))
}

fn to_base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    for _ in 0..8 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// `30000/1001` → 29.97; `0/0` → None.
pub fn parse_rate(r: &str) -> Option<f64> {
    let (n, d) = r.split_once('/').unwrap_or((r, "1"));
    let (n, d) = (n.trim().parse::<f64>().ok()?, d.trim().parse::<f64>().ok()?);
    (n > 0.0 && d > 0.0).then(|| ((n / d) * 1000.0).round() / 1000.0)
}

#[derive(Default, Debug, PartialEq)]
pub struct Probe {
    pub duration_secs: Option<f64>,
    pub fps: Option<f64>,
    pub width: Option<u64>,
    pub height: Option<u64>,
}

/// What ffprobe's `-print_format json -show_format -show_streams` says about a file.
pub fn parse_probe(json: &Value) -> Probe {
    let streams = json
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let video = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("video"));
    let num = |v: Option<&Value>| -> Option<f64> {
        let v = v?;
        v.as_f64().or_else(|| v.as_str()?.parse().ok())
    };
    let duration_secs = num(json.get("format").and_then(|f| f.get("duration")))
        .or_else(|| streams.iter().find_map(|s| num(s.get("duration"))))
        .filter(|d| *d > 0.0);
    Probe {
        duration_secs,
        fps: video.and_then(|v| {
            ["avg_frame_rate", "r_frame_rate"]
                .iter()
                .find_map(|k| parse_rate(v.get(*k)?.as_str()?))
        }),
        width: video.and_then(|v| v.get("width")?.as_u64()),
        height: video.and_then(|v| v.get("height")?.as_u64()),
    }
}

pub(super) fn probe(tc: &Toolchain, dir: &Path, file: &Path) -> Result<Probe, String> {
    let args: Vec<String> = [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([file.to_string_lossy().into_owned()])
    .collect();
    let out = env::run_capture(tc.remotion(dir, &args)?, PROBE_TIMEOUT)?;
    if !out.ok() {
        return Err(format!(
            "ffprobe failed for {}: {}",
            file.display(),
            out.tail()
        ));
    }
    let json: Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("ffprobe gave no JSON for {}: {e}", file.display()))?;
    Ok(parse_probe(&json))
}

pub fn asset_from_probe(
    id: String,
    kind: &'static str,
    src: String,
    name: String,
    p: &Probe,
) -> Asset {
    let fps = match kind {
        "video" => p.fps,
        "audio" => Some(AUDIO_FPS),
        _ => None,
    };
    let duration_in_frames = match (kind, p.duration_secs, fps) {
        ("video" | "audio", Some(d), Some(f)) => Some((d * f).round().max(1.0) as u64),
        _ => None,
    };
    let (width, height) = if kind == "video" || kind == "image" {
        (p.width, p.height)
    } else {
        (None, None)
    };
    Asset {
        id,
        kind,
        src,
        name,
        duration_in_frames,
        fps,
        width,
        height,
    }
}

/// Copies files into `public/media/` (a file already there is used in place) and describes
/// each as an Asset. The timeline itself is left to the caller.
pub fn import(
    app: &AppHandle,
    workspace: &str,
    slug: &str,
    paths: &[String],
) -> Result<Vec<Asset>, String> {
    let dir = project::project_dir(workspace, slug)?;
    let media = project::media_base(&dir).join("media");
    fs::create_dir_all(&media).map_err(|e| format!("Couldn't create {}: {e}", media.display()))?;
    let mut sources = Vec::new();
    for p in paths {
        let path = PathBuf::from(p);
        if !path.is_file() {
            return Err(format!("Not a file: {p}"));
        }
        let kind = media_kind(&path).ok_or_else(|| format!("Unsupported media type: {p}"))?;
        sources.push((path, kind));
    }
    let media_canon = fs::canonicalize(&media).unwrap_or_else(|_| media.clone());
    let tc = env::toolchain();
    let tools = runtime::tools_for(app, &dir);
    let mut out = Vec::new();
    for (path, kind) in sources {
        let original = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "media".into());
        let inside = fs::canonicalize(&path)
            .ok()
            .and_then(|c| c.parent().map(|p| p == media_canon))
            .unwrap_or(false);
        let file_name = if inside {
            original.clone()
        } else {
            let name = dedupe_file(&media, &safe_file_name(&original));
            fs::copy(&path, media.join(&name))
                .map_err(|e| format!("Couldn't copy {}: {e}", path.display()))?;
            name
        };
        let target = media.join(&file_name);
        let probed = if kind == "font" {
            Probe::default()
        } else {
            // Without the runtime the file is still imported, just without its length and size.
            tools
                .as_ref()
                .map_err(Clone::clone)
                .and_then(|t| probe(&tc, t, &target))
                .unwrap_or_else(|e| {
                    log::warn!("video: {e}");
                    Probe::default()
                })
        };
        let display = Path::new(&original)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or(original);
        out.push(asset_from_probe(
            new_id("asset"),
            kind,
            format!("media/{file_name}"),
            display,
            &probed,
        ));
    }
    Ok(out)
}

/// A media file on disk, registered in the timeline or not.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MediaFile {
    /// Relative to the media base, as an asset's `src` would be: `media/x.mp4`.
    pub src: String,
    pub path: String,
    pub size: u64,
}

/// The files directly in the project's media folder that Nyxs can use, by name. Only that level:
/// `import` uses a file in place only when it sits right there.
pub fn list_files(dir: &Path) -> Vec<MediaFile> {
    let media = project::media_base(dir).join("media");
    let mut out: Vec<MediaFile> = fs::read_dir(&media)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            media_kind(&path)?;
            let meta = e.metadata().ok().filter(|m| m.is_file())?;
            Some(MediaFile {
                src: format!("media/{}", e.file_name().to_string_lossy()),
                path: path.to_string_lossy().into_owned(),
                size: meta.len(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.src.cmp(&b.src));
    out
}

/// A key that changes when the file does, so a replaced file gets new thumbnails.
fn file_key(file: &Path) -> String {
    let mut h = DefaultHasher::new();
    file.hash(&mut h);
    if let Ok(m) = fs::metadata(file) {
        m.len().hash(&mut h);
        if let Ok(t) = m.modified() {
            t.hash(&mut h);
        }
    }
    format!("{:016x}", h.finish())
}

fn safe_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn duration_secs(asset: &Value) -> Option<f64> {
    let frames = asset.get("durationInFrames")?.as_f64()?;
    let fps = asset.get("fps")?.as_f64().filter(|f| *f > 0.0)?;
    Some(frames / fps)
}

/// When to take each of `count` thumbnails: the middle of equal slices of the clip.
pub fn thumbnail_times(duration: f64, count: usize) -> Vec<f64> {
    (0..count)
        .map(|i| ((i as f64 + 0.5) * duration / count as f64 * 1000.0).round() / 1000.0)
        .collect()
}

pub fn thumbnails(
    app: &AppHandle,
    workspace: &str,
    slug: &str,
    asset_id: &str,
    count: u32,
) -> Result<Vec<String>, String> {
    let dir = project::project_dir(workspace, slug)?;
    let (asset, file) = project::find_asset(&dir, asset_id)?;
    let tools = runtime::tools_for(app, &dir)?;
    let kind = asset.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != "video" && kind != "image" {
        return Err(format!("Asset {asset_id:?} is not a video or an image."));
    }
    let count = if kind == "image" {
        1
    } else {
        count.clamp(1, 64)
    } as usize;
    let out_dir = project::cache_dir(workspace, slug)?
        .join("thumbnails")
        .join(format!("{}-{}", safe_id(asset_id), file_key(&file)))
        .join(count.to_string());
    let paths: Vec<PathBuf> = (0..count)
        .map(|i| out_dir.join(format!("{i:03}.jpg")))
        .collect();
    if paths.iter().all(|p| p.is_file()) {
        return Ok(paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect());
    }
    fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Couldn't create {}: {e}", out_dir.display()))?;
    let tc = env::toolchain();
    let duration = match duration_secs(&asset) {
        Some(d) => d,
        None if kind == "video" => probe(&tc, &tools, &file)?.duration_secs.unwrap_or(0.0),
        None => 0.0,
    };
    let times = thumbnail_times(duration, count);
    let file_arg = file.to_string_lossy().into_owned();
    for (time, path) in times.iter().zip(&paths) {
        if path.is_file() {
            continue;
        }
        let mut args: Vec<String> = vec!["ffmpeg".into(), "-v".into(), "error".into()];
        if kind == "video" {
            args.extend(["-ss".into(), format!("{time:.3}")]);
        }
        args.extend([
            "-i".into(),
            file_arg.clone(),
            "-frames:v".into(),
            "1".into(),
            "-vf".into(),
            format!("scale=-2:{THUMB_HEIGHT}"),
            "-q:v".into(),
            "5".into(),
            "-y".into(),
            path.to_string_lossy().into_owned(),
        ]);
        let out = env::run_capture(tc.remotion(&tools, &args)?, FFMPEG_TIMEOUT)?;
        if !out.ok() || !path.is_file() {
            return Err(format!(
                "ffmpeg couldn't make a thumbnail of {}: {}",
                file.display(),
                out.tail()
            ));
        }
    }
    Ok(paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

/// The 16-bit samples of a PCM WAV. ffmpeg writing to a pipe can't go back to fill in sizes, so
/// the `data` chunk runs to the end whatever its header says.
pub fn wav_samples(bytes: &[u8]) -> Vec<i16> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Vec::new();
    }
    let mut pos = 12;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        let body = pos + 8;
        if id == b"data" {
            return bytes[body..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| i16::from_le_bytes([b[0], b[1]]))
                .collect();
        }
        // Chunks are padded to an even length.
        pos = body.saturating_add(size).saturating_add(size & 1);
    }
    Vec::new()
}

/// Peak of each of `buckets` equal slices of 16-bit samples, from 0 (silence) to 1 (full scale).
pub fn peaks(samples: &[i16], buckets: usize) -> Vec<f32> {
    if buckets == 0 {
        return Vec::new();
    }
    if samples.is_empty() {
        return vec![0.0; buckets];
    }
    (0..buckets)
        .map(|b| {
            let start = b * samples.len() / buckets;
            let end = ((b + 1) * samples.len() / buckets)
                .max(start + 1)
                .min(samples.len());
            let peak = samples[start..end]
                .iter()
                .map(|s| (*s as i32).unsigned_abs())
                .max()
                .unwrap_or(0);
            ((peak as f32 / 32768.0) * 1000.0).round() / 1000.0
        })
        .collect()
}

pub fn waveform(
    app: &AppHandle,
    workspace: &str,
    slug: &str,
    asset_id: &str,
    buckets: u32,
) -> Result<Vec<f32>, String> {
    let dir = project::project_dir(workspace, slug)?;
    let (asset, file) = project::find_asset(&dir, asset_id)?;
    let tools = runtime::tools_for(app, &dir)?;
    let kind = asset.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != "video" && kind != "audio" {
        return Err(format!("Asset {asset_id:?} has no audio."));
    }
    let buckets = buckets.clamp(1, 20_000) as usize;
    let cache = project::cache_dir(workspace, slug)?
        .join("waveforms")
        .join(format!(
            "{}-{}-{buckets}.json",
            safe_id(asset_id),
            file_key(&file)
        ));
    if let Ok(text) = fs::read_to_string(&cache) {
        if let Ok(v) = serde_json::from_str::<Vec<f32>>(&text) {
            if v.len() == buckets {
                return Ok(v);
            }
        }
    }
    // Remotion's ffmpeg has no raw `s16le` muxer, so it's a WAV on stdout. No `-v error`: the
    // "does not contain any stream" line that marks a silent video is only printed above it.
    let args: Vec<String> = ["ffmpeg", "-hide_banner", "-nostats", "-i"]
        .iter()
        .map(|s| s.to_string())
        .chain([file.to_string_lossy().into_owned()])
        .chain(
            [
                "-vn",
                "-ac",
                "1",
                "-ar",
                &WAVE_RATE.to_string(),
                "-c:a",
                "pcm_s16le",
                "-f",
                "wav",
                "-",
            ]
            .iter()
            .map(|s| s.to_string()),
        )
        .collect();
    let out = env::run_capture(tc_remotion(&tools, &args)?, FFMPEG_TIMEOUT)?;
    // A video without an audio stream makes ffmpeg fail: that's a flat waveform, not an error.
    let samples: Vec<i16> = if out.ok() {
        wav_samples(&out.stdout)
    } else if out.stderr.contains("does not contain any stream")
        || out.stderr.contains("matches no streams")
    {
        Vec::new()
    } else {
        return Err(format!(
            "ffmpeg couldn't read the audio of {}: {}",
            file.display(),
            out.tail()
        ));
    };
    let result = peaks(&samples, buckets);
    if let Some(parent) = cache.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(&result) {
        let _ = crate::agent::text_io::write_atomic(&cache, text.as_bytes());
    }
    Ok(result)
}

fn tc_remotion(dir: &Path, args: &[String]) -> Result<std::process::Command, String> {
    env::toolchain().remotion(dir, args)
}

/// The asset's audio from `start_ms` to `end_ms` as 16 kHz mono 16-bit WAV, for transcription.
pub fn extract_audio(
    app: &AppHandle,
    workspace: &str,
    slug: &str,
    asset_id: &str,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
) -> Result<String, String> {
    let dir = project::project_dir(workspace, slug)?;
    let (asset, file) = project::find_asset(&dir, asset_id)?;
    let tools = runtime::tools_for(app, &dir)?;
    let kind = asset.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != "video" && kind != "audio" {
        return Err(format!("Asset {asset_id:?} has no audio."));
    }
    if let (Some(a), Some(b)) = (start_ms, end_ms) {
        if b <= a {
            return Err(format!("Empty audio range {a}-{b} ms."));
        }
    }
    let out = project::cache_dir(workspace, slug)?
        .join("audio")
        .join(format!(
            "{}-{}-{}-{}.wav",
            safe_id(asset_id),
            file_key(&file),
            start_ms.unwrap_or(0),
            end_ms.map_or("end".to_string(), |e| e.to_string())
        ));
    if out.is_file() {
        return Ok(out.to_string_lossy().into_owned());
    }
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let mut args: Vec<String> = vec!["ffmpeg".into(), "-v".into(), "error".into()];
    if let Some(a) = start_ms.filter(|a| *a > 0) {
        args.extend(["-ss".into(), format!("{:.3}", a as f64 / 1000.0)]);
    }
    args.extend(["-i".into(), file.to_string_lossy().into_owned()]);
    if let Some(b) = end_ms {
        let len = b.saturating_sub(start_ms.unwrap_or(0));
        args.extend(["-t".into(), format!("{:.3}", len as f64 / 1000.0)]);
    }
    // Written beside the target and renamed, so a stopped ffmpeg never leaves a cut-off WAV
    // that the cache would then hand out.
    let partial = out.with_extension("partial.wav");
    args.extend(
        ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y"]
            .iter()
            .map(|s| s.to_string()),
    );
    args.push(partial.to_string_lossy().into_owned());
    let res = env::run_capture(tc_remotion(&tools, &args)?, FFMPEG_TIMEOUT)?;
    if !res.ok() || !partial.is_file() {
        let _ = fs::remove_file(&partial);
        return Err(format!(
            "ffmpeg couldn't extract the audio of {}: {}",
            file.display(),
            res.tail()
        ));
    }
    fs::rename(&partial, &out).map_err(|e| format!("Couldn't write {}: {e}", out.display()))?;
    Ok(out.to_string_lossy().into_owned())
}

/// `[start, end)` ranges in seconds from ffmpeg's `silencedetect` lines on stderr. A silence
/// still open at the end runs to `duration`.
pub fn parse_silences(stderr: &str, duration: Option<f64>) -> Vec<(f64, f64)> {
    let num = |line: &str, key: &str| -> Option<f64> {
        let rest = line.split(key).nth(1)?.trim_start();
        let n: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
            .collect();
        n.parse().ok()
    };
    let mut out = Vec::new();
    let mut open: Option<f64> = None;
    for line in stderr.lines() {
        if let Some(s) = num(line, "silence_start:") {
            open = Some(s.max(0.0));
        } else if let Some(e) = num(line, "silence_end:") {
            out.push((open.take().unwrap_or(0.0), e));
        }
    }
    if let (Some(s), Some(d)) = (open, duration) {
        if d > s {
            out.push((s, d));
        }
    }
    out
}

/// Silent stretches of an asset as frame ranges `[start, end)` at the asset's own fps.
pub fn detect_silences(
    app: &AppHandle,
    workspace: &str,
    slug: &str,
    asset_id: &str,
    threshold_db: f64,
    min_duration_ms: u64,
) -> Result<Vec<[u32; 2]>, String> {
    let dir = project::project_dir(workspace, slug)?;
    let (asset, file) = project::find_asset(&dir, asset_id)?;
    let tools = runtime::tools_for(app, &dir)?;
    let kind = asset.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != "video" && kind != "audio" {
        return Err(format!("Asset {asset_id:?} has no audio."));
    }
    let fps = asset
        .get("fps")
        .and_then(Value::as_f64)
        .filter(|f| *f > 0.0)
        .unwrap_or(AUDIO_FPS);
    let threshold = threshold_db.clamp(-90.0, 0.0);
    let min = (min_duration_ms.max(50) as f64) / 1000.0;
    let args: Vec<String> = vec![
        "ffmpeg".into(),
        "-hide_banner".into(),
        "-nostats".into(),
        "-i".into(),
        file.to_string_lossy().into_owned(),
        "-vn".into(),
        "-af".into(),
        format!("silencedetect=noise={threshold}dB:d={min}"),
        "-f".into(),
        "null".into(),
        "-".into(),
    ];
    let res = env::run_capture(tc_remotion(&tools, &args)?, FFMPEG_TIMEOUT)?;
    if !res.ok() {
        if res.stderr.contains("does not contain any stream")
            || res.stderr.contains("matches no streams")
        {
            return Ok(Vec::new());
        }
        return Err(format!(
            "ffmpeg couldn't analyse the audio of {}: {}",
            file.display(),
            res.tail()
        ));
    }
    Ok(parse_silences(&res.stderr, duration_secs(&asset))
        .into_iter()
        .map(|(a, b)| [(a * fps).round() as u32, (b * fps).round() as u32])
        .filter(|[a, b]| b > a)
        .collect())
}

/// One frame of the asset itself at `time_secs`, full size, as a PNG in the cache (for "Freeze
/// frame": a still of the composition would bake the other tracks into the hold).
pub fn asset_frame(
    app: &AppHandle,
    workspace: &str,
    slug: &str,
    asset_id: &str,
    time_secs: f64,
) -> Result<String, String> {
    let dir = project::project_dir(workspace, slug)?;
    let (asset, file) = project::find_asset(&dir, asset_id)?;
    let tools = runtime::tools_for(app, &dir)?;
    let kind = asset.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != "video" && kind != "image" {
        return Err(format!("Asset {asset_id:?} is not a video or an image."));
    }
    let time = if time_secs.is_finite() {
        time_secs.max(0.0)
    } else {
        0.0
    };
    let ms = (time * 1000.0).round() as u64;
    let out = project::cache_dir(workspace, slug)?
        .join("frames")
        .join(format!(
            "{}-{}-{ms}.png",
            safe_id(asset_id),
            file_key(&file)
        ));
    if out.is_file() {
        return Ok(out.to_string_lossy().into_owned());
    }
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let partial = out.with_extension("partial.png");
    let mut args: Vec<String> = vec!["ffmpeg".into(), "-v".into(), "error".into()];
    if kind == "video" && ms > 0 {
        // `-ss` before `-i` seeks fast and, re-encoding, still lands on the exact frame.
        args.extend(["-ss".into(), format!("{:.3}", ms as f64 / 1000.0)]);
    }
    args.extend([
        "-i".into(),
        file.to_string_lossy().into_owned(),
        "-frames:v".into(),
        "1".into(),
        "-y".into(),
        partial.to_string_lossy().into_owned(),
    ]);
    let res = env::run_capture(tc_remotion(&tools, &args)?, FFMPEG_TIMEOUT)?;
    if !res.ok() || !partial.is_file() {
        let _ = fs::remove_file(&partial);
        return Err(format!(
            "ffmpeg couldn't take a frame of {} at {time:.3} s: {}",
            file.display(),
            res.tail()
        ));
    }
    fs::rename(&partial, &out).map_err(|e| format!("Couldn't write {}: {e}", out.display()))?;
    Ok(out.to_string_lossy().into_owned())
}

/// Saves the bytes of a file dropped from the OS (which reach the WebView without a path) in
/// the video cache, and returns where. Leftovers older than a day are swept on the way.
pub fn stage_file(workspace: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
    project::check_workspace(workspace)?;
    let dir = crate::project_paths::project_feature_dir(workspace, "video")
        .ok_or_else(|| "Couldn't find the home folder for the video cache.".to_string())?
        .join("incoming");
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    if let Ok(entries) = fs::read_dir(&dir) {
        let day = Duration::from_secs(24 * 3600);
        for e in entries.flatten() {
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > day);
            if old {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let file = dir.join(dedupe_file(&dir, &safe_file_name(base)));
    crate::agent::text_io::write_atomic(&file, bytes)
        .map_err(|e| format!("Couldn't write {}: {e}", file.display()))?;
    Ok(file.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_media_by_extension() {
        assert_eq!(media_kind(Path::new("a/Intro.MOV")), Some("video"));
        assert_eq!(media_kind(Path::new("logo.svg")), Some("image"));
        assert_eq!(media_kind(Path::new("song.flac")), Some("audio"));
        assert_eq!(media_kind(Path::new("Inter.woff2")), Some("font"));
        assert_eq!(media_kind(Path::new("notes.txt")), None);
        assert_eq!(media_kind(Path::new("noext")), None);
    }

    #[test]
    fn lists_only_usable_files_right_in_the_media_folder() {
        let dir = std::env::temp_dir().join(format!("nyxs-video-list-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("media/nested")).unwrap();
        fs::write(dir.join("media/b.mp4"), "video").unwrap();
        fs::write(dir.join("media/a.png"), "i").unwrap();
        fs::write(dir.join("media/notes.txt"), "no").unwrap();
        fs::write(dir.join("media/b.mp4.tmp"), "no").unwrap();
        fs::write(dir.join("media/nested/c.mp4"), "no").unwrap();
        let files = list_files(&dir);
        let seen: Vec<(&str, u64)> = files.iter().map(|f| (f.src.as_str(), f.size)).collect();
        assert_eq!(seen, [("media/a.png", 1), ("media/b.mp4", 5)]);
        assert!(Path::new(&files[1].path).is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleans_and_dedupes_file_names() {
        assert_eq!(safe_file_name("My Clip (final).MP4"), "My-Clip-final.mp4");
        assert_eq!(safe_file_name("canción.wav"), "canci-n.wav");
        assert_eq!(safe_file_name("???.png"), "media.png");
        let dir = std::env::temp_dir().join(format!("nyxs-video-media-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.mp4"), b"").unwrap();
        fs::write(dir.join("a-2.mp4"), b"").unwrap();
        assert_eq!(dedupe_file(&dir, "a.mp4"), "a-3.mp4");
        assert_eq!(dedupe_file(&dir, "b.mp4"), "b.mp4");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_ffprobe_output() {
        let j = json!({
            "streams": [
                { "codec_type": "audio", "duration": "10.0" },
                { "codec_type": "video", "width": 1920, "height": 1080,
                  "avg_frame_rate": "30000/1001", "r_frame_rate": "30/1" }
            ],
            "format": { "duration": "12.5" }
        });
        let p = parse_probe(&j);
        assert_eq!(p.duration_secs, Some(12.5));
        assert_eq!(p.fps, Some(29.97));
        assert_eq!((p.width, p.height), (Some(1920), Some(1080)));
        let a = asset_from_probe(
            "asset-1".into(),
            "video",
            "media/a.mp4".into(),
            "a".into(),
            &p,
        );
        assert_eq!(a.duration_in_frames, Some(375));

        let audio = parse_probe(
            &json!({ "streams": [{ "codec_type": "audio" }], "format": { "duration": "2" } }),
        );
        let a = asset_from_probe(
            "asset-2".into(),
            "audio",
            "media/b.mp3".into(),
            "b".into(),
            &audio,
        );
        assert_eq!(
            (a.fps, a.duration_in_frames, a.width),
            (Some(30.0), Some(60), None)
        );

        assert_eq!(parse_rate("0/0"), None);
        assert_eq!(parse_rate("25"), Some(25.0));
    }

    #[test]
    fn spreads_thumbnails_and_peaks() {
        assert_eq!(thumbnail_times(10.0, 4), vec![1.25, 3.75, 6.25, 8.75]);
        assert_eq!(peaks(&[0, 16384, -32768, 100], 2), vec![0.5, 1.0]);
        assert_eq!(peaks(&[], 3), vec![0.0, 0.0, 0.0]);
        assert_eq!(peaks(&[16384], 2), vec![0.5, 0.5]);
        assert!(peaks(&[1, 2, 3], 0).is_empty());
    }

    #[test]
    fn makes_short_unique_ids() {
        let a = new_id("asset");
        let b = new_id("asset");
        assert!(a.starts_with("asset-") && a.len() == 14);
        assert_ne!(a, b);
    }

    #[test]
    fn reads_silencedetect_output() {
        let err = "[silencedetect @ 0x1] silence_start: 1.5\n[silencedetect @ 0x1] silence_end: 3.25 | silence_duration: 1.75\nsize=N/A\n[silencedetect @ 0x1] silence_start: -0.01\n[silencedetect @ 0x1] silence_end: 0.5 | silence_duration: 0.5\n[silencedetect @ 0x1] silence_start: 9\n";
        assert_eq!(
            parse_silences(err, Some(10.0)),
            vec![(1.5, 3.25), (0.0, 0.5), (9.0, 10.0)]
        );
        assert_eq!(parse_silences(err, None).len(), 2);
        assert!(parse_silences("", Some(3.0)).is_empty());
    }

    #[test]
    fn reads_piped_wavs() {
        let mut wav = b"RIFF".to_vec();
        wav.extend(u32::MAX.to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend([0u8; 16]);
        wav.extend(b"LIST");
        wav.extend(3u32.to_le_bytes());
        wav.extend([1u8, 2, 3, 0]);
        wav.extend(b"data");
        wav.extend(u32::MAX.to_le_bytes());
        wav.extend(16384i16.to_le_bytes());
        wav.extend((-2i16).to_le_bytes());
        assert_eq!(wav_samples(&wav), vec![16384, -2]);
        assert!(wav_samples(b"not a wav").is_empty());
    }
}
