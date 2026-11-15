//! Nyxs Video: light video projects under `<workspace>/videos/<slug>/` (data only) played and
//! rendered through one shared runtime (`~/.nyxs/video-runtime/<version>/`), plus adopted
//! Remotion projects. The contract with the frontend is `docs/video-editor-spec.md`; the typed
//! wrappers are `src/lib/video/videoApi.ts`.

mod convert;
#[cfg(test)]
mod e2e_tests;
mod env;
mod export;
mod manage;
mod media;
mod player;
mod posters;
mod project;
mod render;
mod runtime;
mod sources;
mod tools;
#[cfg(test)]
mod tools_e2e_tests;

use tauri::AppHandle;

pub use env::VideoEnv;
pub use media::Asset;
pub use player::PlayerInfo;
pub use project::{Preset, VideoProjectInfo};
pub use render::RenderOpts;
pub use runtime::RuntimeStatus;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("The video task stopped: {e}"))?
}

#[tauri::command(async)]
pub async fn video_check_env() -> Result<VideoEnv, String> {
    blocking(|| Ok(env::check_env())).await
}

#[tauri::command(async)]
pub async fn video_runtime_status(app: AppHandle) -> Result<RuntimeStatus, String> {
    blocking(move || runtime::status(&app)).await
}

/// Installs the shared runtime once (npm install + the headless browser), with
/// `video-runtime-progress` events. Calls while it installs wait for that same install.
#[tauri::command(async)]
pub async fn video_runtime_install(app: AppHandle) -> Result<RuntimeStatus, String> {
    blocking(move || runtime::install(&app)).await
}

/// Instant: thumbnails whose timeline changed are rendered afterwards in the background and
/// announced with `video-thumbnail-ready { slug, path }`, and the most recent project's player
/// is pre-started.
#[tauri::command(async)]
pub async fn video_list_projects(
    app: AppHandle,
    workspace: String,
) -> Result<Vec<VideoProjectInfo>, String> {
    blocking(move || {
        let list = project::list(&workspace)?;
        posters::refresh(&app, &workspace, &list);
        player::warm_up(&app, &workspace, &list);
        Ok(list)
    })
    .await
}

/// Moves a project under `videos/` to the OS trash (an adopted one is only forgotten), after
/// stopping its player; its cache goes too.
#[tauri::command(async)]
pub async fn video_delete_project(workspace: String, slug: String) -> Result<(), String> {
    blocking(move || manage::delete(&workspace, &slug)).await
}

/// New display name; the folder follows it when that slug is free.
#[tauri::command(async)]
pub async fn video_rename_project(
    workspace: String,
    slug: String,
    name: String,
) -> Result<VideoProjectInfo, String> {
    blocking(move || manage::rename(&workspace, &slug, &name)).await
}

/// A copy of a light project; `name` defaults to "<name> (copy)".
#[tauri::command(async)]
pub async fn video_duplicate_project(
    workspace: String,
    slug: String,
    name: Option<String>,
) -> Result<VideoProjectInfo, String> {
    blocking(move || manage::duplicate(&workspace, &slug, name.as_deref())).await
}

#[tauri::command(async)]
pub async fn video_reveal_project(workspace: String, slug: String) -> Result<(), String> {
    blocking(move || manage::reveal(&workspace, &slug)).await
}

/// Writes a light project (no npm): instant.
#[tauri::command(async)]
pub async fn video_create_project(
    app: AppHandle,
    workspace: String,
    name: String,
    preset: Preset,
) -> Result<VideoProjectInfo, String> {
    blocking(move || project::create(&app, &workspace, &name, preset)).await
}

/// Makes a project playable: the shared runtime for a Nyxs project, `npm install` in an adopted
/// Remotion project's own folder (with `video-install-progress` events).
#[tauri::command(async)]
pub async fn video_install(
    app: AppHandle,
    workspace: String,
    slug: String,
) -> Result<VideoProjectInfo, String> {
    blocking(move || {
        let dir = project::project_dir(&workspace, &slug)?;
        if project::is_light(&dir) {
            runtime::install(&app)?;
        } else {
            project::install_own(&app, &slug, &dir)?;
        }
        Ok(project::project_info(&workspace, &slug, &dir))
    })
    .await
}

#[tauri::command(async)]
pub async fn video_player_start(
    app: AppHandle,
    workspace: String,
    slug: String,
) -> Result<PlayerInfo, String> {
    blocking(move || player::start(&app, &workspace, &slug)).await
}

/// The panel let go of the project: its server stays warm for a while (see `player.rs`).
#[tauri::command(async)]
pub async fn video_player_stop(workspace: String, slug: String) -> Result<(), String> {
    blocking(move || player::release(&workspace, &slug)).await
}

/// Really stops the server, for a Retry: the next start gets a new one.
#[tauri::command(async)]
pub async fn video_player_kill(workspace: String, slug: String) -> Result<(), String> {
    blocking(move || player::kill(&workspace, &slug)).await
}

/// The page is reloading (Ctrl+R): see `player::mark_all_idle`.
pub fn player_mark_all_idle() {
    player::mark_all_idle();
}

#[tauri::command(async)]
pub async fn video_read_timeline(workspace: String, slug: String) -> Result<String, String> {
    blocking(move || project::read_timeline(&project::project_dir(&workspace, &slug)?)).await
}

/// Synchronous on purpose: debounced saves run one after another on the main thread, so an
/// older document can never land after a newer one.
#[tauri::command]
pub fn video_write_timeline(workspace: String, slug: String, json: String) -> Result<(), String> {
    project::write_timeline(&project::project_dir(&workspace, &slug)?, &json)
}

#[tauri::command(async)]
pub async fn video_import_media(
    app: AppHandle,
    workspace: String,
    slug: String,
    paths: Vec<String>,
) -> Result<Vec<Asset>, String> {
    blocking(move || media::import(&app, &workspace, &slug, &paths)).await
}

/// The files in the project's media folder, registered in the timeline or not.
#[tauri::command(async)]
pub async fn video_list_media(
    workspace: String,
    slug: String,
) -> Result<Vec<media::MediaFile>, String> {
    blocking(move || Ok(media::list_files(&project::project_dir(&workspace, &slug)?))).await
}

#[tauri::command(async)]
pub async fn video_thumbnails(
    app: AppHandle,
    workspace: String,
    slug: String,
    asset_id: String,
    count: u32,
) -> Result<Vec<String>, String> {
    blocking(move || media::thumbnails(&app, &workspace, &slug, &asset_id, count)).await
}

#[tauri::command(async)]
pub async fn video_waveform(
    app: AppHandle,
    workspace: String,
    slug: String,
    asset_id: String,
    buckets: u32,
) -> Result<Vec<f32>, String> {
    blocking(move || media::waveform(&app, &workspace, &slug, &asset_id, buckets)).await
}

/// Starts a render and returns its id at once; progress comes as `video-render-progress`.
#[tauri::command(async)]
pub async fn video_render(
    app: AppHandle,
    workspace: String,
    slug: String,
    opts: RenderOpts,
) -> Result<String, String> {
    blocking(move || render::start(&app, &workspace, &slug, opts)).await
}

/// Off the main thread: killing a process tree takes `taskkill` a moment.
#[tauri::command(async)]
pub async fn video_render_cancel(render_id: String) -> Result<(), String> {
    blocking(move || render::cancel(&render_id)).await
}

#[tauri::command(async)]
pub async fn video_still(
    app: AppHandle,
    workspace: String,
    slug: String,
    composition_id: String,
    frame: u32,
    output_name: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        render::still(
            &app,
            &workspace,
            &slug,
            &composition_id,
            frame,
            output_name.as_deref(),
        )
    })
    .await
}

#[tauri::command(async)]
pub async fn video_open_output(path: String) -> Result<(), String> {
    crate::agent::agent_reveal_path(path)
}

/// Turns a project of the first design (own node_modules, engine copy) into a light one; the old
/// code goes to a backup in the cache.
#[tauri::command(async)]
pub async fn video_convert_to_light(
    app: AppHandle,
    workspace: String,
    slug: String,
) -> Result<VideoProjectInfo, String> {
    blocking(move || convert::convert(&app, &workspace, &slug)).await
}

/// Copies a Nyxs project with the runtime's sources into `dest`, so it runs outside Nyxs.
#[tauri::command(async)]
pub async fn video_export_standalone(
    app: AppHandle,
    workspace: String,
    slug: String,
    dest: String,
) -> Result<String, String> {
    blocking(move || export::export_standalone(&app, &workspace, &slug, &dest)).await
}

/// A new project from existing files: sized after the first video, the files on its tracks.
#[tauri::command(async)]
pub async fn video_create_from_media(
    app: AppHandle,
    workspace: String,
    paths: Vec<String>,
    name: Option<String>,
) -> Result<VideoProjectInfo, String> {
    blocking(move || sources::create_from_media(&app, &workspace, &paths, name.as_deref())).await
}

#[tauri::command(async)]
pub async fn video_adopt_project(
    app: AppHandle,
    workspace: String,
    path: String,
) -> Result<VideoProjectInfo, String> {
    blocking(move || sources::adopt(&app, &workspace, &path)).await
}

#[tauri::command(async)]
pub async fn video_detect_silences(
    app: AppHandle,
    workspace: String,
    slug: String,
    asset_id: String,
    threshold_db: f64,
    min_duration_ms: u64,
) -> Result<Vec<[u32; 2]>, String> {
    blocking(move || {
        media::detect_silences(
            &app,
            &workspace,
            &slug,
            &asset_id,
            threshold_db,
            min_duration_ms,
        )
    })
    .await
}

#[tauri::command(async)]
pub async fn video_extract_audio(
    app: AppHandle,
    workspace: String,
    slug: String,
    asset_id: String,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
) -> Result<String, String> {
    blocking(move || media::extract_audio(&app, &workspace, &slug, &asset_id, start_ms, end_ms))
        .await
}

#[tauri::command(async)]
pub async fn video_asset_frame(
    app: AppHandle,
    workspace: String,
    slug: String,
    asset_id: String,
    time_secs: f64,
) -> Result<String, String> {
    blocking(move || media::asset_frame(&app, &workspace, &slug, &asset_id, time_secs)).await
}

/// `%E2%82%AC` → `€`. Header values are ASCII, so the panel percent-encodes paths and names.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The bytes of a file dropped from the OS, sent as a raw body with `x-workspace` and
/// `x-name` headers (no JSON: a video is hundreds of MB). Returns the path of the copy.
#[tauri::command]
pub async fn video_stage_file(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("video_stage_file expects the file's bytes as a raw body.".into());
    };
    let header = |k: &str| {
        request
            .headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(percent_decode)
            .ok_or_else(|| format!("video_stage_file is missing the {k} header."))
    };
    let workspace = header("x-workspace")?;
    let name = header("x-name")?;
    let bytes = bytes.clone();
    blocking(move || media::stage_file(&workspace, &name, &bytes)).await
}

/// N frames of a composition or a media asset as one labeled image in the cache.
#[tauri::command(async)]
pub async fn video_contact_sheet(
    app: AppHandle,
    workspace: String,
    slug: String,
    request: serde_json::Value,
    job_id: Option<String>,
) -> Result<serde_json::Value, String> {
    blocking(move || {
        tools::run(
            &app,
            tools::Kind::ContactSheet,
            &workspace,
            &slug,
            request,
            job_id,
        )
    })
    .await
}

/// A small, low-fps review clip of a frame range, in the cache.
#[tauri::command(async)]
pub async fn video_proxy(
    app: AppHandle,
    workspace: String,
    slug: String,
    request: serde_json::Value,
    job_id: Option<String>,
) -> Result<serde_json::Value, String> {
    blocking(move || tools::run(&app, tools::Kind::Proxy, &workspace, &slug, request, job_id)).await
}

/// Films a web page through scripted steps into `media/`; read-only unless writes are allowed.
#[tauri::command(async)]
pub async fn video_record(
    app: AppHandle,
    workspace: String,
    slug: String,
    request: serde_json::Value,
    job_id: Option<String>,
) -> Result<serde_json::Value, String> {
    blocking(move || {
        tools::run(
            &app,
            tools::Kind::Record,
            &workspace,
            &slug,
            request,
            job_id,
        )
    })
    .await
}

/// Writes an original music bed into `media/`.
#[tauri::command(async)]
pub async fn video_music(
    app: AppHandle,
    workspace: String,
    slug: String,
    request: serde_json::Value,
    job_id: Option<String>,
) -> Result<serde_json::Value, String> {
    blocking(move || tools::run(&app, tools::Kind::Music, &workspace, &slug, request, job_id)).await
}

#[tauri::command]
pub fn video_tool_cancel(job_id: String) {
    // Killing a process tree can block for a moment: never on the main thread.
    std::thread::spawn(move || tools::cancel(&job_id));
}

/// Kills every player server, render and task: called when the app quits.
pub fn shutdown_all() {
    player::shutdown_all();
    render::shutdown_all();
    tools::shutdown_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_encoded_headers() {
        assert_eq!(percent_decode("D%3A%5Cwork%5Csite"), r"D:\work\site");
        assert_eq!(
            percent_decode("canci%C3%B3n%20final.mp4"),
            "canción final.mp4"
        );
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
    }
}
