import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Loader2, Music, Search, X } from "lucide-react";
import { YouTubeMusicLogo } from "@/components/music/musicLogos";
import { useTranslations } from "@/lib/i18n";
import { formatTime, matchLocalTracks, playTrack, playYouTubeResult, restoreFolder, searchYouTube, useMusic } from "@/lib/music/player";
import type { YoutubeResult } from "@/lib/music/youtubeMusic";
import { cn } from "@/lib/utils";

/** Typing waits this long for a pause, so each word doesn't become a request. */
const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY = 2;
const MAX_LOCAL = 5;

/** One row of the list: a song found on YouTube Music or in the user's folder. */
type Match = { key: string; kind: "youtube"; song: YoutubeResult } | { key: string; kind: "local"; index: number };

/** The title bar's way to start a song by hand: matches appear while typing, and the song playing
 *  goes on until another is chosen. */
export function MusicSearch() {
  const t = useTranslations().music;
  const music = useMusic();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The answer of the last search that came back, for the words it asked about.
  const [found, setFound] = useState<{ query: string; songs: YoutubeResult[]; failed: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const [starting, setStarting] = useState<string | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const q = query.trim();
  const typed = q.length >= MIN_QUERY;
  const busy = starting !== null;
  const connected = music.youtubeConnected;
  const searching = typed && connected && found?.query !== q;

  useEffect(() => {
    if (open) restoreFolder();
  }, [open]);

  useEffect(() => {
    if (!open || !typed || !connected) return;
    let alive = true;
    const timer = setTimeout(() => {
      searchYouTube(q).then(
        (songs) => { if (alive) setFound({ query: q, songs, failed: false }); },
        () => { if (alive) setFound({ query: q, songs: [], failed: true }); },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, q, typed, connected]);

  useEffect(() => {
    // While a song starts it stays: opening the hidden page can take the window's focus, and a
    // failure must still have somewhere to show.
    if (!open || busy) return;
    const close = (e: Event) => {
      if (e.type === "mousedown" && rootRef.current?.contains(e.target as Node)) return;
      if (e.type === "keydown" && (e as globalThis.KeyboardEvent).key !== "Escape") return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("blur", close);
    };
  }, [open, busy]);

  // The last answer stays on screen until the next one, so the list doesn't blink at each letter.
  const songs = typed && found ? found.songs : [];
  const localIndexes = useMemo(() => (typed ? matchLocalTracks(music.tracks, q, MAX_LOCAL) : []), [music.tracks, q, typed]);
  const matches: Match[] = [
    ...songs.map((song): Match => ({ key: `youtube:${song.id}`, kind: "youtube", song })),
    ...localIndexes.map((index): Match => ({ key: `local:${index}`, kind: "local", index })),
  ];
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0));
  const nothing = typed && !searching && matches.length === 0 && !found?.failed;

  const change = (text: string) => {
    setQuery(text);
    setActive(0);
    setStartFailed(false);
  };

  const choose = async (match: Match | undefined) => {
    if (!match || busy) return;
    setStartFailed(false);
    setStarting(match.key);
    try {
      if (match.kind === "youtube") await playYouTubeResult(match.song.id);
      else await playTrack(match.index);
      change("");
      setFound(null);
      setOpen(false);
    } catch {
      setStartFailed(true);
    } finally {
      setStarting(null);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!matches.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = (activeIndex + step + matches.length) % matches.length;
      setActive(next);
      listRef.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView?.({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      void choose(matches[activeIndex]);
    }
  };

  const row = (match: Match, i: number) => {
    const track = match.kind === "local" ? music.tracks[match.index] : null;
    const cover = match.kind === "youtube" ? match.song.cover : null;
    const title = match.kind === "youtube" ? match.song.title : track?.title;
    const subtitle = match.kind === "youtube" ? match.song.subtitle : track?.artist;
    return (
      <button
        key={match.key}
        id={`${listId}-${i}`}
        type="button"
        role="option"
        data-row={i}
        aria-selected={i === activeIndex}
        disabled={busy}
        onMouseEnter={() => setActive(i)}
        onClick={() => void choose(match)}
        className={cn("flex w-full items-center gap-2.5 rounded-[6px] px-1.5 py-1 text-left", i === activeIndex && "bg-bg-200")}
      >
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-bg-300 text-text-500">
          {cover ? <img src={cover} alt="" draggable={false} referrerPolicy="no-referrer" className="h-full w-full object-cover" /> : <Music className="w-4 h-4" aria-hidden />}
          {starting === match.key && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-white">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-text-100">{title}</span>
          {subtitle && <span className="block truncate text-[12px] text-text-400">{subtitle}</span>}
        </span>
        {track && track.duration > 0 && <span className="shrink-0 text-[12px] tabular-nums text-text-500">{formatTime(track.duration)}</span>}
      </button>
    );
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t.search}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tooltip={open ? undefined : t.search}
        className={cn(
          "inline-flex items-center justify-center w-8 h-7 rounded-md transition-colors",
          open ? "bg-bg-200 text-text-100" : "text-text-300 hover:text-text-100 hover:bg-bg-200",
        )}
      >
        <Music className="w-4 h-4" />
      </button>
      {open && (
        <div data-mod-menu data-webview-hole className="absolute right-0 top-full z-[70] mt-1 w-[400px] max-w-[calc(100vw-1rem)] overflow-hidden rounded-[8px] border border-bg-300 bg-bg-100 shadow-lg">
          <div className="flex h-10 items-center gap-2 px-3">
            <Search className="w-4 h-4 shrink-0 text-text-400" aria-hidden />
            <input
              ref={inputRef}
              autoFocus
              type="text"
              role="combobox"
              value={query}
              onChange={(e) => change(e.target.value)}
              onKeyDown={onKey}
              placeholder={t.searchPlaceholder}
              aria-label={t.search}
              aria-expanded={matches.length > 0}
              aria-controls={listId}
              aria-activedescendant={matches.length ? `${listId}-${activeIndex}` : undefined}
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-text-100 outline-none placeholder:text-text-500"
            />
            {searching && <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-text-400" aria-hidden />}
            {query && (
              <button
                type="button"
                onClick={() => { change(""); inputRef.current?.focus(); }}
                aria-label={t.clear}
                className="shrink-0 rounded-[6px] p-0.5 text-text-400 hover:text-text-100 hover:bg-bg-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {typed && (
            <div ref={listRef} id={listId} role="listbox" aria-label={t.search} className="max-h-[360px] overflow-y-auto custom-scrollbar border-t border-bg-300 p-1.5">
              {songs.length > 0 && (
                <p className="flex items-center gap-1.5 px-1.5 pb-1 pt-0.5 text-[12px] text-text-400">
                  <YouTubeMusicLogo className="w-3.5 h-3.5" />
                  YouTube Music
                </p>
              )}
              {matches.map((match, i) => match.kind === "youtube" && row(match, i))}
              {localIndexes.length > 0 && (
                <p className={cn("flex items-center gap-1.5 px-1.5 pb-1 text-[12px] text-text-400", songs.length > 0 ? "pt-2" : "pt-0.5")}>
                  <Music className="w-3.5 h-3.5" aria-hidden />
                  {t.thisComputer}
                </p>
              )}
              {matches.map((match, i) => match.kind === "local" && row(match, i))}
              {nothing && <p className="px-1.5 py-1 text-[13px] text-text-400">{t.noResults}</p>}
              {found?.failed && found.query === q && <p role="alert" className="px-1.5 py-1 text-[12px] text-red-400">{t.searchFailed}</p>}
              {startFailed && <p role="alert" className="px-1.5 py-1 text-[12px] text-red-400">{t.notStarted}</p>}
              {searching && matches.length === 0 && <p className="px-1.5 py-1 text-[13px] text-text-400">{t.searching}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
