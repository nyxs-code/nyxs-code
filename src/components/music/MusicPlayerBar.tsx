import { Music, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { formatTime, next, nowPlaying, previous, setVolume, toggle, toggleMuted, useMusic, useMusicPolling } from "@/lib/music/player";
import { MusicSearch } from "./MusicSearch";

const control = "inline-flex shrink-0 items-center justify-center w-6 h-6 rounded-[6px] text-text-200 enabled:hover:text-text-100 enabled:hover:bg-bg-200 disabled:opacity-40 transition-colors";

/** The player in the title bar: the buttons and a small display, like a music app's. Fits in the
 *  bar's height, so showing or hiding it moves nothing else. With no music it isn't there, and in
 *  a window under 640 px wide (Nyxs beside the agent using the computer) it hides: its buttons
 *  would crowd the bar's own. The empty slot still drags the window. */
export function MusicPlayerBar() {
  const t = useTranslations().music;
  const music = useMusic();
  useMusicPolling(music.systemEnabled, music.youtubeConnected);
  const now = nowPlaying(music);
  const search = (music.youtubeConnected || music.folder) && <MusicSearch />;
  // The empty part of the slot is still the bar: it moves the window.
  if (!now) {
    return (
      <div data-tauri-drag-region className="flex flex-1 min-w-0 items-center justify-end self-stretch pr-0.5">
        <span className="contents max-[639px]:hidden">{search}</span>
      </div>
    );
  }

  const progress = now.duration > 0 ? Math.min(100, (now.position / now.duration) * 100) : 0;
  const hasTimeline = now.duration > 0;

  return (
    <div data-tauri-drag-region className="flex flex-1 min-w-0 items-center justify-end gap-1 self-stretch pl-1.5 pr-0.5 max-[639px]:[&>*]:hidden">
      <button type="button" onClick={previous} disabled={!now.canPrevious} aria-label={t.previous} className={control}>
        <SkipBack className="w-3.5 h-3.5" />
      </button>
      <button type="button" onClick={toggle} disabled={!now.canToggle} aria-label={now.playing ? t.pause : t.play} className={control}>
        {now.playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
      </button>
      <button type="button" onClick={next} disabled={!now.canNext} aria-label={t.next} className={control}>
        <SkipForward className="w-3.5 h-3.5" />
      </button>
      {/* Windows doesn't let an app change another's volume. */}
      {now.adjustable && (
        <span className="flex shrink-0 items-center gap-1 pr-1">
          <button type="button" onClick={toggleMuted} aria-label={music.muted ? t.unmute : t.mute} aria-pressed={music.muted} className={control}>
            {music.muted || music.volume === 0 ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={music.muted ? 0 : music.volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            aria-label={t.volume}
            className="h-1 w-16 accent-accent max-[1099px]:hidden"
          />
        </span>
      )}
      <div className="relative flex h-[30px] min-w-0 max-w-[280px] flex-1 items-center overflow-hidden rounded-[6px] border border-bg-300 bg-bg-100 text-left">
        <span className="flex h-full w-[30px] shrink-0 items-center justify-center border-r border-bg-300 bg-bg-200 text-text-500">
          {music.cover ? <img src={music.cover} alt="" draggable={false} className="h-full w-full object-cover" /> : <Music className="w-3.5 h-3.5" />}
        </span>
        {hasTimeline && <span className="w-8 shrink-0 text-center text-[11px] leading-[13px] tabular-nums text-text-500 max-[959px]:hidden">{formatTime(now.position)}</span>}
        <span className="min-w-0 flex-1 px-1 pb-0.5 text-center">
          <span className="block truncate text-[11px] font-medium leading-[13px] text-text-100">{now.title}</span>
          {now.artist && <span className="block truncate text-[11px] leading-[13px] text-text-400">{now.artist}</span>}
        </span>
        {hasTimeline && <span className="w-9 shrink-0 text-center text-[11px] leading-[13px] tabular-nums text-text-500 max-[959px]:hidden">-{formatTime(now.duration - now.position)}</span>}
        {hasTimeline && (
          <span aria-hidden className="absolute bottom-0 left-[30px] right-0 h-0.5 bg-bg-300">
            <span className="block h-full bg-accent" style={{ width: `${progress}%` }} />
          </span>
        )}
      </div>
      {search}
    </div>
  );
}
