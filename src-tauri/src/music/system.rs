//! What other apps are playing, through Windows' media sessions (the same ones the volume flyout
//! shows). No account or API key: any app that reports to Windows works, Spotify and browsers
//! among them.

use super::{data_url, SystemAction, SystemPlayback};
use std::time::{SystemTime, UNIX_EPOCH};
use windows::core::{Result as WinResult, HSTRING};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

/// Seconds between 1601, where Windows' clock starts, and 1970.
const FILETIME_TO_UNIX_SECS: f64 = 11_644_473_600.0;
const TICKS_PER_SEC: f64 = 10_000_000.0;

/// WinRT needs an apartment on the calling thread, which the command pool doesn't have; its own
/// short-lived thread leaves the pool's threads as they were.
fn on_com_thread<T: Send + 'static>(
    work: impl FnOnce() -> WinResult<T> + Send + 'static,
) -> Result<T, String> {
    std::thread::spawn(move || {
        // SAFETY: paired with the CoUninitialize below, on this same thread.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let out = work();
        // SAFETY: this thread's apartment, opened above; nothing from it outlives `work`.
        unsafe { CoUninitialize() };
        out
    })
    .join()
    .map_err(|_| "The media session thread panicked.".to_string())?
    .map_err(|e| format!("Couldn't read the media sessions: {e}"))
}

/// A session of Nyxs' own webviews: YouTube Music in the built-in browser, or the player's own
/// `<audio>`, which the frontend tells apart by its title.
fn is_in_app(app_id: &str) -> bool {
    let id = app_id.to_lowercase();
    ["msedgewebview2", "nyxs"]
        .iter()
        .any(|own| id.contains(own))
}

fn app_id_of(session: &Session) -> String {
    session
        .SourceAppUserModelId()
        .map(|id| id.to_string())
        .unwrap_or_default()
}

fn is_playing(session: &Session) -> bool {
    session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .is_ok_and(|status| status == Status::Playing)
}

/// Another app that is playing, then Nyxs' own webviews if they are, since one of those may be
/// the player's `<audio>`; with nothing playing, the one Windows considers current.
fn pick_session(manager: &Manager) -> WinResult<Option<Session>> {
    let sessions: Vec<Session> = manager.GetSessions()?.into_iter().collect();
    let playing = || sessions.iter().filter(|s| is_playing(s));
    if let Some(session) = playing()
        .find(|s| !is_in_app(&app_id_of(s)))
        .or_else(|| playing().next())
    {
        return Ok(Some(session.clone()));
    }
    if let Ok(current) = manager.GetCurrentSession() {
        return Ok(Some(current));
    }
    Ok(sessions.first().cloned())
}

fn current_session() -> WinResult<Option<Session>> {
    let manager = Manager::RequestAsync()?.join()?;
    pick_session(&manager)
}

fn text(value: WinResult<HSTRING>) -> Option<String> {
    value
        .ok()
        .map(|v| v.to_string().trim().to_string())
        .filter(|v| !v.is_empty())
}

fn now_ticks() -> f64 {
    let since_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    (since_unix + FILETIME_TO_UNIX_SECS) * TICKS_PER_SEC
}

/// Apps report their position only now and then, so while playing it moves on from the last
/// report by the time gone since. A clock going backwards doesn't rewind it, and it never passes
/// the end.
fn live_position(
    position: f64,
    duration: f64,
    reported_at_ticks: f64,
    now_ticks: f64,
    playing: bool,
) -> f64 {
    let elapsed = if playing {
        ((now_ticks - reported_at_ticks) / TICKS_PER_SEC).max(0.0)
    } else {
        0.0
    };
    let live = position + elapsed;
    if duration > 0.0 {
        live.min(duration)
    } else {
        live
    }
}

fn read_state(session: &Session) -> WinResult<Option<SystemPlayback>> {
    let props = session.TryGetMediaPropertiesAsync()?.join()?;
    // An app between songs has a session with nothing to show yet.
    let Some(title) = text(props.Title()) else {
        return Ok(None);
    };
    let info = session.GetPlaybackInfo()?;
    let controls = info.Controls()?;
    let playing = info.PlaybackStatus()? == Status::Playing;
    let timeline = session.GetTimelineProperties()?;
    let start = timeline.StartTime()?.Duration as f64;
    let duration = (timeline.EndTime()?.Duration as f64 - start).max(0.0) / TICKS_PER_SEC;
    let position = (timeline.Position()?.Duration as f64 - start).max(0.0) / TICKS_PER_SEC;
    let reported_at = timeline.LastUpdatedTime()?.UniversalTime as f64;
    let app_id = app_id_of(session);
    Ok(Some(SystemPlayback {
        in_app: is_in_app(&app_id),
        app_id,
        title,
        artist: text(props.Artist()),
        album: text(props.AlbumTitle()),
        playing,
        position: live_position(position, duration, reported_at, now_ticks(), playing),
        duration,
        can_toggle: controls.IsPlayPauseToggleEnabled()?,
        can_next: controls.IsNextEnabled()?,
        can_previous: controls.IsPreviousEnabled()?,
    }))
}

pub(super) fn state() -> Result<Option<SystemPlayback>, String> {
    on_com_thread(|| match current_session()? {
        Some(session) => read_state(&session),
        None => Ok(None),
    })
}

fn read_cover(session: &Session) -> WinResult<Option<String>> {
    let props = session.TryGetMediaPropertiesAsync()?.join()?;
    // Most apps have one; for those that don't, the call fails or gives nothing.
    let Ok(thumbnail) = props.Thumbnail() else {
        return Ok(None);
    };
    let stream = thumbnail.OpenReadAsync()?.join()?;
    let size = stream.Size()?;
    if size == 0 || size > super::MAX_COVER_BYTES as u64 {
        return Ok(None);
    }
    let mime = stream.ContentType()?.to_string();
    let reader = DataReader::CreateDataReader(&stream)?;
    let loaded = reader.LoadAsync(size as u32)?.join()?;
    let mut bytes = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut bytes)?;
    Ok(data_url(&mime, &bytes))
}

pub(super) fn cover() -> Result<Option<String>, String> {
    on_com_thread(|| match current_session()? {
        Some(session) => read_cover(&session),
        None => Ok(None),
    })
}

pub(super) fn control(action: SystemAction) -> Result<(), String> {
    on_com_thread(move || {
        let Some(session) = current_session()? else {
            return Ok(());
        };
        let call = match action {
            SystemAction::Toggle => session.TryTogglePlayPauseAsync()?,
            SystemAction::Next => session.TrySkipNextAsync()?,
            SystemAction::Previous => session.TrySkipPreviousAsync()?,
        };
        call.join().map(|_| ())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nyxs_own_sessions_are_told_from_other_apps() {
        assert!(is_in_app("msedgewebview2.exe"));
        assert!(is_in_app("com.nyxs.desktop"));
        assert!(!is_in_app("Spotify.exe"));
        assert!(!is_in_app("MSEdge"));
    }

    #[test]
    fn the_position_moves_on_only_while_playing() {
        let at = 1_000.0 * TICKS_PER_SEC;
        let later = 1_010.0 * TICKS_PER_SEC;
        assert_eq!(live_position(30.0, 200.0, at, later, true), 40.0);
        assert_eq!(live_position(30.0, 200.0, at, later, false), 30.0);
    }

    #[test]
    fn the_position_stays_within_the_song_and_the_clock() {
        let at = 1_000.0 * TICKS_PER_SEC;
        assert_eq!(
            live_position(195.0, 200.0, at, 1_010.0 * TICKS_PER_SEC, true),
            200.0
        );
        assert_eq!(
            live_position(30.0, 200.0, at, 990.0 * TICKS_PER_SEC, true),
            30.0
        );
        // An app with no timeline has no end to stop at.
        assert_eq!(
            live_position(0.0, 0.0, at, 1_005.0 * TICKS_PER_SEC, true),
            5.0
        );
    }

    /// Windows answers on any machine, with or without music; this reads whatever is there.
    #[test]
    fn asking_windows_works_with_or_without_music() {
        assert!(state().is_ok());
    }
}
