import { useEffect, useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { accountKey } from "@/lib/accountScope";
import { desktopOs } from "@/lib/desktopOs";
import { invoke } from "@/lib/ipc";
import { openInBuiltInBrowser } from "@/lib/openExternal";
import {
  closeYoutubeHost,
  readYoutube,
  youtubeHostOpen,
  youtubeNext,
  youtubePause,
  youtubePlay,
  youtubePlaySong,
  youtubePrevious,
  youtubeResume,
  youtubeSearch,
  youtubeSetMuted,
  youtubeSetVolume,
  type YoutubePlayback,
  type YoutubeResult,
} from "./youtubeMusic";

// One player for the whole window, outside React: the music has to keep going while panels open
// and close and chats change. Three sources feed it: songs from a folder, played by an <audio>
// here; YouTube Music, played by its own site in a webview out of sight (youtubeMusic.ts); and on
// Windows whatever other apps report to the system, which the app reads and controls but doesn't
// play itself.

export interface MusicTrack {
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number;
}

export interface SystemPlayback {
  appId: string;
  /** It plays inside Nyxs: the built-in browser, or the `<audio>` of this very player. */
  inApp: boolean;
  title: string;
  artist: string | null;
  album: string | null;
  playing: boolean;
  position: number;
  duration: number;
  canToggle: boolean;
  canNext: boolean;
  canPrevious: boolean;
}

export interface MusicState {
  folder: string | null;
  tracks: MusicTrack[];
  truncated: boolean;
  scanning: boolean;
  scanFailed: boolean;
  /** The song loaded in the `<audio>`, or -1. */
  index: number;
  localPlaying: boolean;
  localPosition: number;
  localDuration: number;
  playFailed: boolean;
  volume: number;
  muted: boolean;
  systemEnabled: boolean;
  system: SystemPlayback | null;
  /** The user connected YouTube Music in Settings. */
  youtubeConnected: boolean;
  /** Its page, while it is open. */
  youtube: YoutubePlayback | null;
  cover: string | null;
}

/** What the title bar shows, whichever source it comes from. */
export interface NowPlaying {
  source: "local" | "youtube" | "system";
  key: string;
  /** A picture the source already has an address for; the others are read when the song changes. */
  cover: string | null;
  /** Nyxs sets the volume and position of its own sources; Windows doesn't let it do so for another app. */
  adjustable: boolean;
  title: string;
  artist: string | null;
  /** The other app it plays in, when it isn't Nyxs. */
  appId: string | null;
  playing: boolean;
  position: number;
  duration: number;
  canToggle: boolean;
  canNext: boolean;
  canPrevious: boolean;
}

const PREFS_KEY = "nyxs.music";
const YOUTUBE_MUSIC_URL = "https://music.youtube.com/";
const SYSTEM_POLL_MS = 1500;
const YOUTUBE_POLL_MS = 1000;
/** Between two songs a source reports nothing for a moment: the player keeps showing the last
 *  one that long, so skipping a song doesn't make it vanish and come back. */
const SONG_GAP_MS = 6000;
/** After the user moves the volume, a read of the page may still carry the old one. */
const VOLUME_SETTLE_MS = 1500;
/** Unmuting something left at zero would still be silent. */
const UNMUTE_VOLUME = 0.5;
/** Past this, "previous" goes back to the start of the song instead of the song before. */
const RESTART_AFTER_SECS = 3;

const INITIAL: MusicState = {
  folder: null,
  tracks: [],
  truncated: false,
  scanning: false,
  scanFailed: false,
  index: -1,
  localPlaying: false,
  localPosition: 0,
  localDuration: 0,
  playFailed: false,
  volume: 0.8,
  muted: false,
  systemEnabled: false,
  system: null,
  youtubeConnected: false,
  youtube: null,
  cover: null,
};

/** Reading another app's music only happens on Windows, where it reports to the system. */
export function systemMusicSupported(): boolean {
  return desktopOs() === "windows";
}

/** "1:24", or "1:02:05" for something long. */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The player's own `<audio>` and its YouTube Music page also report to Windows: those are not
 *  another source. */
function otherSource(s: MusicState): SystemPlayback | null {
  const system = s.systemEnabled ? s.system : null;
  if (!system) return null;
  if (!system.inApp) return system;
  return system.title === s.tracks[s.index]?.title || system.title === s.youtube?.title ? null : system;
}

/** The source to show: what is sounding, and if nothing is, what is loaded here. */
export function nowPlaying(s: MusicState): NowPlaying | null {
  const local = s.tracks[s.index];
  const youtube = s.youtube?.loaded && s.youtube.title ? s.youtube : null;
  const system = otherSource(s);
  const youtubeFirst = youtube?.playing && !s.localPlaying;
  if (youtube && (youtubeFirst || (!local && !system?.playing))) {
    return {
      source: "youtube",
      key: `youtube:${youtube.title}|${youtube.artist ?? ""}`,
      cover: youtube.cover,
      adjustable: true,
      title: youtube.title ?? "",
      artist: youtube.artist,
      appId: null,
      playing: youtube.playing,
      position: youtube.position,
      duration: youtube.duration,
      canToggle: true,
      canNext: true,
      canPrevious: true,
    };
  }
  if (local && (s.localPlaying || !system?.playing)) {
    return {
      source: "local",
      key: `local:${local.path}`,
      cover: null,
      adjustable: true,
      title: local.title,
      artist: local.artist,
      appId: null,
      playing: s.localPlaying,
      position: s.localPosition,
      duration: s.localDuration || local.duration,
      canToggle: true,
      canNext: s.index < s.tracks.length - 1,
      canPrevious: true,
    };
  }
  if (!system) return null;
  return {
    source: "system",
    key: `system:${system.appId}|${system.title}|${system.artist ?? ""}`,
    cover: null,
    adjustable: false,
    title: system.title,
    artist: system.artist,
    appId: system.inApp ? null : system.appId,
    playing: system.playing,
    position: system.position,
    duration: system.duration,
    canToggle: system.canToggle,
    canNext: system.canNext,
    canPrevious: system.canPrevious,
  };
}

let state: MusicState = INITIAL;
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
let prefsLoaded = false;
let hostOpen = false;
let systemSeenAt = 0;
let youtubeSeenAt = 0;
let volumeSending = false;
let volumeChangedAt = 0;
let playSeq = 0;
let coverKey: string | null = null;
let coverSeq = 0;

function refreshCover() {
  const now = nowPlaying(state);
  const key = now?.key ?? null;
  if (key === coverKey) return;
  coverKey = key;
  const seq = ++coverSeq;
  patch({ cover: now?.cover ?? null });
  if (!now || now.cover) return;
  // The site names its picture a moment after the song starts: the next read brings it.
  if (now.source === "youtube") return;
  const local = now.source === "local" ? state.tracks[state.index] : null;
  const asked = local ? invoke<string | null>("music_track_cover", { path: local.path }) : invoke<string | null>("music_system_cover");
  void asked.then(
    (cover) => { if (seq === coverSeq) patch({ cover }); },
    () => {},
  );
}

function patch(p: Partial<MusicState>) {
  state = { ...state, ...p };
  for (const l of listeners) l();
  refreshCover();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function savePrefs() {
  const { folder, volume, muted, systemEnabled, youtubeConnected } = state;
  try {
    localStorage.setItem(accountKey(PREFS_KEY), JSON.stringify({ folder, volume, muted, systemEnabled, youtubeConnected }));
  } catch { /* storage full or denied: the choices just last this session */ }
}

function loadPrefs() {
  if (prefsLoaded) return;
  prefsLoaded = true;
  try {
    const p = JSON.parse(localStorage.getItem(accountKey(PREFS_KEY)) ?? "null") as { folder?: unknown; volume?: unknown; muted?: unknown; systemEnabled?: unknown; youtubeConnected?: unknown } | null;
    if (!p) return;
    patch({
      folder: typeof p.folder === "string" ? p.folder : null,
      volume: typeof p.volume === "number" && p.volume >= 0 && p.volume <= 1 ? p.volume : INITIAL.volume,
      muted: p.muted === true,
      systemEnabled: p.systemEnabled === true && systemMusicSupported(),
      youtubeConnected: p.youtubeConnected === true,
    });
  } catch { /* unreadable: starts with the defaults, and the next change rewrites it */ }
}

/** Windows' media keys and flyout show this song, and the title tells its session from the rest. */
function describeToSystem(track: MusicTrack) {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist ?? "", album: track.album ?? "" });
}

function player(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  a.preload = "metadata";
  a.volume = state.volume;
  a.muted = state.muted;
  a.addEventListener("play", () => patch({ localPlaying: true }));
  a.addEventListener("pause", () => patch({ localPlaying: false }));
  a.addEventListener("timeupdate", () => patch({ localPosition: a.currentTime }));
  a.addEventListener("durationchange", () => { if (Number.isFinite(a.duration)) patch({ localDuration: a.duration }); });
  a.addEventListener("error", () => patch({ localPlaying: false, playFailed: true }));
  a.addEventListener("ended", () => {
    if (state.index < state.tracks.length - 1) void playTrack(state.index + 1);
    else patch({ localPlaying: false, localPosition: 0 });
  });
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler?.("previoustrack", () => void previous());
    navigator.mediaSession.setActionHandler?.("nexttrack", () => void next());
  }
  audio = a;
  return a;
}

/** Starts a song of the list. Each new one cancels what an earlier call was still waiting for. */
export async function playTrack(index: number): Promise<void> {
  const track = state.tracks[index];
  if (!track) return;
  const seq = ++playSeq;
  patch({ index, localPosition: 0, localDuration: track.duration, playFailed: false });
  if (state.youtube?.playing) void youtubePause();
  try {
    await invoke("music_allow_track", { path: track.path });
    if (seq !== playSeq) return;
    const a = player();
    a.src = convertFileSrc(track.path);
    describeToSystem(track);
    await a.play();
  } catch (e) {
    // Another song or a pause came first: not a failure of this one.
    if (seq !== playSeq || (e as Error).name === "AbortError") return;
    patch({ localPlaying: false, playFailed: true });
  }
}

/** Whether an empty report from a source should be ignored, as the gap between two songs: it
 *  has been silent for less than SONG_GAP_MS since it last named one. */
function inSongGap(lastSeen: number, had: boolean): boolean {
  return had && Date.now() - lastSeen < SONG_GAP_MS;
}

/** Reads the system's state now, for the moment after a command as well as on the timer. */
async function pollSystem() {
  if (!state.systemEnabled || document.visibilityState === "hidden") return;
  const system = await invoke<SystemPlayback | null>("music_system_state").catch(() => null);
  if (!state.systemEnabled) return;
  if (system) systemSeenAt = Date.now();
  else if (inSongGap(systemSeenAt, !!state.system)) return;
  if (JSON.stringify(system) !== JSON.stringify(state.system)) patch({ system });
}

function controlSystem(action: "toggle" | "next" | "previous") {
  void invoke("music_system_control", { action })
    .catch(() => {})
    .then(() => setTimeout(() => void pollSystem(), 300));
}

/** Reads the hidden page. A song the site moved on to by itself shows up here. */
async function pollYoutube() {
  if (!state.youtubeConnected || !hostOpen) return;
  const youtube = await readYoutube();
  if (!state.youtubeConnected || !youtube) return;
  if (youtube.loaded && youtube.title) youtubeSeenAt = Date.now();
  else if (inSongGap(youtubeSeenAt, !!state.youtube?.title)) return;
  // A song opened anew takes the volume the site remembers. Not while the user is moving it:
  // this read may be older than their last change, and "correcting" it makes the sound jump.
  const settled = !volumeSending && Date.now() - volumeChangedAt > VOLUME_SETTLE_MS;
  if (youtube.loaded && settled) {
    if (Math.abs(youtube.volume - state.volume) > 0.015) void pushYoutubeVolume();
    if (youtube.muted !== state.muted) void youtubeSetMuted(state.muted);
  }
  if (JSON.stringify(youtube) !== JSON.stringify(state.youtube)) patch({ youtube });
}

function afterYoutube(command: Promise<unknown>) {
  void command.then(() => setTimeout(() => void pollYoutube(), 300));
}

export function toggle(): void {
  const now = nowPlaying(state);
  if (now?.source === "system") controlSystem("toggle");
  else if (now?.source === "youtube") afterYoutube(now.playing ? youtubePause() : youtubeResume());
  else if (now?.source === "local") {
    const a = player();
    if (!a.src) void playTrack(state.index);
    else if (a.paused) void a.play().catch(() => patch({ playFailed: true }));
    else a.pause();
  }
}

export function next(): void {
  const now = nowPlaying(state);
  if (now?.source === "system") controlSystem("next");
  else if (now?.source === "youtube") afterYoutube(youtubeNext());
  else if (now?.canNext) void playTrack(state.index + 1);
}

export function previous(): void {
  const now = nowPlaying(state);
  if (now?.source === "system") controlSystem("previous");
  else if (now?.source === "youtube") afterYoutube(youtubePrevious());
  else if (now?.source === "local") {
    if (state.localPosition > RESTART_AFTER_SECS || state.index === 0) player().currentTime = 0;
    else void playTrack(state.index - 1);
  }
}

/** A slider being dragged fires faster than the page answers: one call at a time, always with
 *  the latest value, so an older one can't land last and move the sound back. */
async function pushYoutubeVolume() {
  if (volumeSending) return;
  volumeSending = true;
  try {
    let sent: number;
    do {
      sent = state.volume;
      await youtubeSetVolume(sent);
    } while (sent !== state.volume && hostOpen);
  } finally {
    volumeSending = false;
  }
}

/** One volume for Nyxs' sources, so changing from one to the other doesn't jump. Moving it up
 *  also takes the mute off, as in any player. */
export function setVolume(volume: number): void {
  volumeChangedAt = Date.now();
  if (audio) audio.volume = volume;
  const unmute = state.muted && volume > 0;
  patch(unmute ? { volume, muted: false } : { volume });
  if (unmute) applyMuted();
  if (hostOpen) void pushYoutubeVolume();
  savePrefs();
}

function applyMuted() {
  if (audio) audio.muted = state.muted;
  if (hostOpen) void youtubeSetMuted(state.muted);
}

export function setMuted(muted: boolean): void {
  volumeChangedAt = Date.now();
  patch(!muted && state.volume === 0 ? { muted, volume: UNMUTE_VOLUME } : { muted });
  if (audio) audio.volume = state.volume;
  if (hostOpen && !muted) void pushYoutubeVolume();
  applyMuted();
  savePrefs();
}

export function toggleMuted(): void {
  setMuted(!state.muted);
}

export function setSystemEnabled(on: boolean): void {
  patch(on ? { systemEnabled: true } : { systemEnabled: false, system: null });
  savePrefs();
  if (on) void pollSystem();
}

async function openHost() {
  if (hostOpen) return;
  await youtubeHostOpen();
  hostOpen = true;
}

/** From Settings: from now on YouTube Music is a source, and its hidden page opens to see
 *  whether the browser's cookies have an account signed in. */
export async function connectYouTube(): Promise<void> {
  patch({ youtubeConnected: true });
  savePrefs();
  await openHost().catch(() => {});
  await pollYoutube();
}

export function disconnectYouTube(): void {
  const wasOpen = hostOpen;
  hostOpen = false;
  patch({ youtubeConnected: false, youtube: null });
  savePrefs();
  if (wasOpen) void closeYoutubeHost().catch(() => {});
}

/** Signing in needs the real page once: Google's form can't work out of sight. */
export function signInToYouTube(): void {
  openInBuiltInBrowser(YOUTUBE_MUSIC_URL);
}

/** Searches YouTube Music and plays the first song found; rejects with what went wrong. */
export async function playOnYouTube(query: string): Promise<YoutubePlayback> {
  playSeq += 1;
  audio?.pause();
  await openHost();
  return startedOnYouTube(await youtubePlay(query));
}

function startedOnYouTube(youtube: YoutubePlayback): YoutubePlayback {
  void pushYoutubeVolume();
  void youtubeSetMuted(state.muted);
  youtubeSeenAt = Date.now();
  patch({ youtube });
  return youtube;
}

/** The matches for what the user is typing, leaving the song that is playing alone. */
export async function searchYouTube(query: string): Promise<YoutubeResult[]> {
  await openHost();
  return youtubeSearch(query);
}

/** Plays one of the results of `searchYouTube`. */
export async function playYouTubeResult(id: string): Promise<YoutubePlayback> {
  playSeq += 1;
  audio?.pause();
  await openHost();
  return startedOnYouTube(await youtubePlaySong(id));
}

/** The songs of the folder that fit a search, as indexes in the list: all its words in the title,
 *  artist or album, accents and case aside. */
export function matchLocalTracks(tracks: MusicTrack[], query: string, limit = Infinity): number[] {
  const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const words = fold(query).split(/\s+/).filter(Boolean);
  const found: number[] = [];
  if (!words.length) return found;
  for (let i = 0; i < tracks.length && found.length < limit; i++) {
    const t = tracks[i];
    const text = fold(`${t.title} ${t.artist ?? ""} ${t.album ?? ""}`);
    if (words.every((w) => text.includes(w))) found.push(i);
  }
  return found;
}

export function findLocalTrack(tracks: MusicTrack[], query: string): number {
  return matchLocalTracks(tracks, query, 1)[0] ?? -1;
}

/** Stops whatever Nyxs is playing or controlling, for the tool. */
export function pause(): void {
  const now = nowPlaying(state);
  if (now?.playing) toggle();
}

/** Goes on with whatever is paused, for the tool. */
export function resume(): void {
  const now = nowPlaying(state);
  if (now && !now.playing) toggle();
}

export const getMusicState = (): MusicState => state;

/** Waits for the folder of the last session, so the tool can search it right after a start. */
export async function ensureLibrary(): Promise<void> {
  loadPrefs();
  if (state.folder && !state.tracks.length && !state.scanning && !state.scanFailed) await scan(state.folder);
}

async function scan(folder: string) {
  patch({ folder, scanning: true, scanFailed: false });
  try {
    const found = await invoke<{ tracks: MusicTrack[]; truncated: boolean }>("music_scan_folder", { path: folder });
    if (state.folder === folder) patch({ tracks: found.tracks, truncated: found.truncated, scanning: false });
  } catch {
    if (state.folder === folder) patch({ tracks: [], truncated: false, scanning: false, scanFailed: true });
  }
}

/** A new folder replaces the list, so the song from the old one stops. */
export async function chooseFolder(folder: string): Promise<void> {
  playSeq += 1;
  audio?.pause();
  audio?.removeAttribute("src");
  patch({ index: -1, localPlaying: false, localPosition: 0, localDuration: 0, playFailed: false });
  await scan(folder);
  savePrefs();
}

/** The folder of the last session is read again when the panel first needs it. */
export function restoreFolder(): void {
  if (state.folder && !state.tracks.length && !state.scanning && !state.scanFailed) void scan(state.folder);
}

export function useMusic(): MusicState {
  useEffect(loadPrefs, []);
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Follows the sources Nyxs doesn't hear about by itself, while they're on. Mounted once, by the
 *  title bar's player. */
export function useMusicPolling(systemEnabled: boolean, youtubeConnected: boolean): void {
  useEffect(() => {
    if (!systemEnabled) return;
    void pollSystem();
    const id = setInterval(() => void pollSystem(), SYSTEM_POLL_MS);
    return () => clearInterval(id);
  }, [systemEnabled]);
  useEffect(() => {
    if (!youtubeConnected) return;
    const id = setInterval(() => void pollYoutube(), YOUTUBE_POLL_MS);
    return () => clearInterval(id);
  }, [youtubeConnected]);
}

/** Test hook: the state, and a clean slate between cases. */
export const __musicForTests = {
  get: () => state,
  patch,
  pollSystem,
  pollYoutube,
  reset: () => {
    state = INITIAL;
    audio = null;
    prefsLoaded = false;
    hostOpen = false;
    systemSeenAt = 0;
    youtubeSeenAt = 0;
    volumeSending = false;
    volumeChangedAt = 0;
    playSeq = 0;
    coverKey = null;
    coverSeq = 0;
  },
};
