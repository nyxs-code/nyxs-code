import { getBrowserPrefs, cookieProfile } from "@/lib/browserPrefs";
import { invoke } from "@/lib/ipc";

// YouTube Music has no API to play from another app. It plays as the real site with the user's
// own account (the browser's cookies), in a native webview placed off the window: never seen, but
// visible to the page, which would otherwise hold its media back as a background tab. Everything
// here reads the site's page, so a redesign of the site is what can break it.

/** MUSIC_TAB in src-tauri/src/music/mod.rs. */
const TAB = "music-youtube";
const ORIGIN = "https://music.youtube.com";
const HOME = `${ORIGIN}/`;
const OFF_WINDOW = { x: -4000, y: -4000, width: 1280, height: 800 };
const POLL_MS = 500;
const RESULTS_WAIT_MS = 12_000;
const START_WAIT_MS = 12_000;

export interface YoutubePlayback {
  title: string | null;
  artist: string | null;
  cover: string | null;
  signedIn: boolean;
  /** A song is loaded in the page. */
  loaded: boolean;
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
}

/** Reads the page. Scripts are synchronous: the webview's script call doesn't wait for promises.
 *  Volume goes through the site's player: it keeps its own, so writing to the <video> directly
 *  leaves the two disagreeing and the sound jumping between them. */
export const READ_SCRIPT = `(() => {
  const v = document.querySelector("video");
  const p = document.querySelector("#movie_player");
  const api = !!(p && p.getVolume);
  const m = navigator.mediaSession && navigator.mediaSession.metadata;
  const art = m && m.artwork && m.artwork.length ? m.artwork[m.artwork.length - 1].src : null;
  return {
    title: m ? m.title : null,
    artist: m ? m.artist : null,
    cover: art,
    signedIn: !document.querySelector("a.sign-in-link"),
    loaded: !!(v && v.src),
    playing: !!(v && !v.paused && !v.ended),
    position: v ? v.currentTime : 0,
    duration: v && isFinite(v.duration) ? v.duration : 0,
    volume: api ? p.getVolume() / 100 : v ? v.volume : 1,
    muted: api ? p.isMuted() : !!(v && v.muted),
  };
})()`;

export function volumeScript(volume: number): string {
  const level = Math.min(1, Math.max(0, Number(volume) || 0));
  return `(() => { const p = document.querySelector("#movie_player"); if (p && p.setVolume) { p.setVolume(${Math.round(level * 100)}); return true; } const v = document.querySelector("video"); if (v) v.volume = ${level}; return !!v; })()`;
}

export function muteScript(muted: boolean): string {
  return `(() => { const p = document.querySelector("#movie_player"); if (p && p.mute) { ${muted ? "p.mute()" : "p.unMute()"}; return true; } const v = document.querySelector("video"); if (v) v.muted = ${muted}; return !!v; })()`;
}

/** The first song or video in the results, skipping artists and albums, which have no such link. */
export const FIRST_RESULT_SCRIPT = `(() => {
  const a = document.querySelector("ytmusic-search-page a[href*='watch?v='], ytmusic-section-list-renderer a[href*='watch?v=']");
  return a ? a.getAttribute("href") : null;
})()`;

const clickScript = (selectors: string) => `(() => { const b = document.querySelector(${JSON.stringify(selectors)}); if (b) b.click(); return !!b; })()`;
const videoScript = (body: string) => `(() => { const v = document.querySelector("video"); if (!v) return false; ${body}; return true; })()`;

const NEXT_SCRIPT = clickScript(".ytmusicPlayerControlsNextButton button, ytmusic-player-bar .next-button");
const PREVIOUS_SCRIPT = clickScript(".ytmusicPlayerControlsPreviousButton button, ytmusic-player-bar .previous-button");
const PLAY_SCRIPT = videoScript("v.play()");
const PAUSE_SCRIPT = videoScript("v.pause()");

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The address of a song from a link in the results; only the id comes from the page. */
export function watchUrl(href: string | null | undefined): string | null {
  const id = href && /[?&]v=([\w-]+)/.exec(href)?.[1];
  return id ? `${ORIGIN}/watch?v=${id}` : null;
}

export function searchUrl(query: string): string {
  return `${ORIGIN}/search?q=${encodeURIComponent(query)}`;
}

/** The cookies of the built-in browser, where the user is signed in. Its private mode keeps none. */
function profile(): string {
  const mode = getBrowserPrefs().cookies;
  return cookieProfile(mode === "private" ? "shared" : mode, null);
}

function openAt(url: string): Promise<void> {
  return invoke("preview_open", { tab: TAB, url, ...OFF_WINDOW, profile: profile(), hidden: false, nav: 0 });
}

async function run<T>(script: string): Promise<T | null> {
  const raw = await invoke<string>("music_page_run", { script });
  // The webview answers with JSON; a page still loading can answer nothing.
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const youtubeHostOpen = (): Promise<void> => openAt(HOME);
export const closeYoutubeHost = (): Promise<void> => invoke("preview_close", { tab: TAB });
export const readYoutube = (): Promise<YoutubePlayback | null> => run<YoutubePlayback>(READ_SCRIPT).catch(() => null);
export const youtubeResume = (): Promise<unknown> => run(PLAY_SCRIPT).catch(() => null);
export const youtubePause = (): Promise<unknown> => run(PAUSE_SCRIPT).catch(() => null);
export const youtubeNext = (): Promise<unknown> => run(NEXT_SCRIPT).catch(() => null);
export const youtubePrevious = (): Promise<unknown> => run(PREVIOUS_SCRIPT).catch(() => null);
export const youtubeSetVolume = (volume: number): Promise<unknown> => run(volumeScript(volume)).catch(() => null);
export const youtubeSetMuted = (muted: boolean): Promise<unknown> => run(muteScript(muted)).catch(() => null);

async function waitFor<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => null);
    if (value) return value;
    if (Date.now() >= until) return null;
    await delay(POLL_MS);
  }
}

/** A song or video found in a search. */
export interface YoutubeResult {
  id: string;
  title: string;
  /** As the site words it: "Canción • Myke Towers". */
  subtitle: string;
  cover: string | null;
}

const MAX_RESULTS = 8;
const SEARCH_POLL_MS = 100;
const SEARCH_WAIT_MS = 8000;
const PAGE_READY_WAIT_MS = 10_000;

/** Asks the site for results through the same request its own search box makes, so the page
 *  stays where it is and the song playing in it goes on. A script can't wait for the answer, so
 *  it leaves it in the page, to be read later. False until the site's config has loaded. */
export function searchScript(id: number, query: string): string {
  return `(() => {
  const cfg = window.ytcfg;
  const context = cfg && cfg.get && cfg.get("INNERTUBE_CONTEXT");
  if (!context) return false;
  const out = window.__nyxsMusicSearch = { id: ${id}, done: false, failed: false, results: [] };
  const key = cfg.get("INNERTUBE_API_KEY");
  fetch("/youtubei/v1/search?prettyPrint=false" + (key ? "&key=" + key : ""), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context, query: ${JSON.stringify(query)} }),
  }).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }).then((data) => {
    const seen = {};
    const visit = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach(visit); return; }
      const row = n.musicResponsiveListItemRenderer;
      if (row) {
        const column = (i) => ((((row.flexColumns || [])[i] || {}).musicResponsiveListItemFlexColumnRenderer || {}).text || {}).runs || [];
        const first = column(0)[0] || {};
        const id = (row.playlistItemData || {}).videoId || ((first.navigationEndpoint || {}).watchEndpoint || {}).videoId;
        const thumbs = (((row.thumbnail || {}).musicThumbnailRenderer || {}).thumbnail || {}).thumbnails || [];
        if (id && !seen[id] && out.results.length < ${MAX_RESULTS}) {
          seen[id] = true;
          out.results.push({
            id,
            title: column(0).map((x) => x.text).join(""),
            subtitle: column(1).map((x) => x.text).join(""),
            cover: thumbs.length ? thumbs[0].url : null,
          });
        }
      }
      for (const k in n) visit(n[k]);
    };
    visit(data);
  }).catch(() => { out.failed = true; }).finally(() => { out.done = true; });
  return true;
})()`;
}

export const SEARCH_READ_SCRIPT = `window.__nyxsMusicSearch || null`;

let searchSeq = 0;

/** The songs YouTube Music finds, without touching what its page is playing. A newer search makes
 *  this one resolve empty: its answer no longer matters. */
export async function youtubeSearch(query: string): Promise<YoutubeResult[]> {
  const id = ++searchSeq;
  const started = await waitFor(() => run<boolean>(searchScript(id, query)), PAGE_READY_WAIT_MS);
  if (!started) throw new YoutubeMusicError("search_failed");
  const until = Date.now() + SEARCH_WAIT_MS;
  while (Date.now() < until) {
    if (id !== searchSeq) return [];
    const page = await run<{ id: number; done: boolean; failed: boolean; results: YoutubeResult[] }>(SEARCH_READ_SCRIPT).catch(() => null);
    if (page?.id === id && page.done) {
      if (page.failed) throw new YoutubeMusicError("search_failed");
      return page.results;
    }
    await delay(SEARCH_POLL_MS);
  }
  throw new YoutubeMusicError("search_failed");
}

async function startSong(url: string): Promise<YoutubePlayback> {
  await openAt(url);
  const playing = await waitFor(async () => {
    const page = await readYoutube();
    if (page?.playing) return page;
    // The site waits for a click if the webview's autoplay policy holds it back.
    if (page?.loaded) await youtubeResume();
    return null;
  }, START_WAIT_MS);
  if (!playing) throw new YoutubeMusicError("not_started");
  return playing;
}

/** Plays a song found by `youtubeSearch`. The old one stops first, so it can't be taken for this
 *  one having started. */
export async function youtubePlaySong(id: string): Promise<YoutubePlayback> {
  const url = watchUrl(`?v=${id}`);
  if (!url) throw new YoutubeMusicError("not_started");
  await youtubePause();
  return startSong(url);
}

export class YoutubeMusicError extends Error {
  readonly code: "no_results" | "not_started" | "search_failed";
  constructor(code: "no_results" | "not_started" | "search_failed") {
    super(
      code === "no_results"
        ? "YouTube Music found nothing for that search."
        : code === "search_failed"
          ? "Couldn't search YouTube Music."
          : "The song didn't start playing in YouTube Music.",
    );
    this.code = code;
  }
}

/** Searches and plays the first song found. Resolves once it is sounding. */
export async function youtubePlay(query: string): Promise<YoutubePlayback> {
  // A song left from before stops at once, and its link can't be taken for a result.
  await youtubePause();
  await openAt(searchUrl(query));
  // The old page answers for a moment after the navigation: only a results page counts.
  const url = await waitFor(async () => {
    const onResults = await run<boolean>(`location.pathname === "/search"`);
    return onResults ? watchUrl(await run<string>(FIRST_RESULT_SCRIPT)) : null;
  }, RESULTS_WAIT_MS);
  if (!url) throw new YoutubeMusicError("no_results");
  return startSong(url);
}
