/**
 * Typed wrappers for the Nyxs Video backend (`src-tauri/src/video/`). The contract is
 * `docs/video-editor-spec.md`; every error rejects with the backend's English message.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@/lib/ipc";
import type { Asset } from "./timelineSchema";

export interface VideoEnv {
  /** e.g. "20.11.1", or null when Node.js isn't installed. */
  node: string | null;
  npm: string | null;
  /** Node 18+ and npm are there, so a project's install brings Remotion's ffmpeg/ffprobe. */
  ffmpegViaRemotion: boolean;
}

/** The shared video runtime (Remotion, React, engine) installed once under ~/.nyxs/video-runtime/. */
export interface RuntimeStatus {
  installed: boolean;
  version: string;
  /** Absolute folder of this app's runtime (may not exist yet). */
  path: string;
  installing: boolean;
}

export interface RuntimeProgress {
  stage: "copying" | "installing" | "browser" | "player" | "done" | "error";
  line?: string;
  /** 0..1 at stage changes only; output lines come without it. */
  progress?: number;
  /** On the `error` event: what failed (same text as `line`). */
  error?: string;
}

/** The name the panel and agent sessions use. */
export type VideoRuntimeStatus = RuntimeStatus;

export interface VideoPreset {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

export interface VideoCompositionInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** "timeline": from timeline.json; "project": registered by an adopted project's own code. */
  source: "timeline" | "project";
}

export interface VideoProjectInfo {
  slug: string;
  /** "nyxs": light project under `videos/`; "remotion": an adopted Remotion project; "legacy":
   *  made with the first design (own node_modules): offer `convertToLight`. */
  kind: "nyxs" | "remotion" | "legacy";
  /** Absolute folder of the project. */
  path: string;
  name: string;
  compositions: VideoCompositionInfo[];
  /** Milliseconds since the epoch when timeline.json last changed. */
  updatedAt: number;
  /** Absolute path of the project's thumbnail (a still at ~10 % of the first composition, in the
   *  app's cache), for `convertFileSrc`. Refreshed in the background: see `onThumbnailReady`. */
  thumbnail?: string | null;
  /** False when it can't play yet: the shared runtime isn't installed (Nyxs projects) or an
   *  adopted project has no node_modules. `install()` fixes either. */
  installed: boolean;
}

export interface PlayerInfo {
  url: string;
  port: number;
}

export type VideoCodec = "h264" | "h265" | "vp8" | "vp9" | "prores" | "gif";

export interface RenderOptions {
  compositionId: string;
  codec: VideoCodec;
  crf?: number;
  scale?: number;
  /** Inclusive frame range. */
  frameRange?: [number, number];
  /** GIF only: lower frame rate (drops frames); other codecs keep the composition's fps. */
  fps?: number;
  audioCodec?: string;
  muted?: boolean;
  /** File name in the project's `out/`; the codec's extension is added. */
  outputName: string;
}

export interface RenderProgress {
  renderId: string;
  stage: "bundling" | "rendering" | "encoding" | "done" | "error" | "cancelled";
  /** 0..1 of the whole job, bundling included. */
  progress: number;
  renderedFrames: number;
  totalFrames: number;
  etaSecs?: number;
  /** The ffmpeg encoder in use (`h264_nvenc`, `libx264`...), once it's known. */
  encoder?: string;
  outputPath?: string;
  error?: string;
}

export interface InstallProgress {
  slug: string;
  line: string;
  /** Set on the last event of an install. */
  done?: boolean;
  error?: string;
}

export const checkEnv = () => invoke<VideoEnv>("video_check_env");

export const runtimeStatus = () => invoke<RuntimeStatus>("video_runtime_status");

/** Installs the shared runtime once (minutes the first time; follow it with
 *  `onRuntimeProgress`). Calls while it installs resolve when that same install ends. */
export const runtimeInstall = () => invoke<RuntimeStatus>("video_runtime_install");

export const listProjects = (workspace: string) => invoke<VideoProjectInfo[]>("video_list_projects", { workspace });

/** Writes a light project (timeline.json, scenes/, media/): instant, no npm. */
export const createProject = (workspace: string, name: string, preset: VideoPreset) =>
  invoke<VideoProjectInfo>("video_create_project", { workspace, name, preset });

/** A new project from existing files, sized after the first video, the files on its tracks. */
export const createFromMedia = (workspace: string, paths: string[], name?: string) =>
  invoke<VideoProjectInfo>("video_create_from_media", { workspace, paths, name: name ?? null });

/** Opens a Remotion project from the workspace (writes a timeline.json if missing; its code and
 *  node_modules are left as they are). */
export const adoptProject = (workspace: string, path: string) =>
  invoke<VideoProjectInfo>("video_adopt_project", { workspace, path });

/** Makes a project playable: installs the shared runtime (Nyxs projects, `onRuntimeProgress`)
 *  or runs `npm install` in an adopted project (`onInstallProgress`). Rejects with the output. */
export const install = (workspace: string, slug: string) =>
  invoke<VideoProjectInfo>("video_install", { workspace, slug });

export const playerStart = (workspace: string, slug: string) => invoke<PlayerInfo>("video_player_start", { workspace, slug });

/** The panel let go of the project: its server stays warm for the next open. */
export const playerStop = (workspace: string, slug: string) => invoke<void>("video_player_stop", { workspace, slug });

/** Really stops the project's server, for a Retry: the next `playerStart` gets a new one. */
export const playerKill = (workspace: string, slug: string) => invoke<void>("video_player_kill", { workspace, slug });

export const readTimeline = (workspace: string, slug: string) => invoke<string>("video_read_timeline", { workspace, slug });

/** Atomic write; text that isn't JSON is refused. */
export const writeTimeline = (workspace: string, slug: string, json: string) =>
  invoke<void>("video_write_timeline", { workspace, slug, json });

/** Copies the files into the project's `media/` (`public/media/` in an adopted project) and
 *  returns their assets; adding them to the timeline
 *  is up to the caller. */
export const importMedia = (workspace: string, slug: string, paths: string[]) =>
  invoke<Asset[]>("video_import_media", { workspace, slug, paths });

/** A file directly in a project's media folder, registered in the timeline or not. */
export interface MediaFile {
  /** What an asset's `src` would be: "media/x.mp4". */
  src: string;
  path: string;
  size: number;
}

export const listMedia = (workspace: string, slug: string) => invoke<MediaFile[]>("video_list_media", { workspace, slug });

/** Cached JPEG paths (one for an image), spread over the asset's length. */
export const thumbnails = (workspace: string, slug: string, assetId: string, count: number) =>
  invoke<string[]>("video_thumbnails", { workspace, slug, assetId, count });

/** Cached peaks, 0 (silence) to 1 (full scale). */
export const waveform = (workspace: string, slug: string, assetId: string, buckets: number) =>
  invoke<number[]>("video_waveform", { workspace, slug, assetId, buckets });

/** Silent stretches as `[start, end)` frame ranges at the asset's own fps. */
export const detectSilences = (workspace: string, slug: string, assetId: string, thresholdDb: number, minDurationMs: number) =>
  invoke<[number, number][]>("video_detect_silences", { workspace, slug, assetId, thresholdDb, minDurationMs });

/** Path of a 16 kHz mono 16-bit WAV of the asset's audio between the two times (cached). */
export const extractAudio = (workspace: string, slug: string, assetId: string, startMs?: number, endMs?: number) =>
  invoke<string>("video_extract_audio", { workspace, slug, assetId, startMs: startMs ?? null, endMs: endMs ?? null });

/** Path of a full-size PNG of the asset itself (not the composition) at `timeSecs` (cached). */
export const assetFrame = (workspace: string, slug: string, assetId: string, timeSecs: number) =>
  invoke<string>("video_asset_frame", { workspace, slug, assetId, timeSecs });

export interface ToolProgress {
  jobId: string;
  /** "bundling" | "rendering" | "encoding". */
  stage: string;
  /** 0..1 of the current stage. */
  progress?: number;
  rendered?: number;
  total?: number;
}

export interface SheetFrame {
  frame: number;
  timecode: string;
  timeSecs: number;
  /** Names of the visible clips at this frame (compositions only). */
  clips?: string;
}

export interface ContactSheetRequest {
  /** A composition (the first one when neither this nor `assetId` is given)… */
  compositionId?: string;
  /** …or a video asset of the project, read directly from its file. */
  assetId?: string;
  /** Evenly spaced frames, default 12, at most 100. Ignored when `frames` is given. */
  count?: number;
  frames?: number[];
  /** Inclusive; the frames are spread over it instead of the whole source. */
  frameRange?: [number, number];
  columns?: number;
  thumbWidth?: number;
}

export interface ContactSheetResult {
  /** A JPEG in the project's cache. */
  path: string;
  width: number;
  height: number;
  columns: number;
  frames: SheetFrame[];
  /** Null for assets, which need no bundle. */
  bundleReused: boolean | null;
  elapsedMs: number;
}

/**
 * One labeled image of N frames, from disk: unsaved edits in the store don't show, so save first.
 * `jobId` names the task for `onToolProgress` and `cancelTool`.
 */
export const contactSheet = (workspace: string, slug: string, request: ContactSheetRequest, jobId?: string) =>
  invoke<ContactSheetResult>("video_contact_sheet", { workspace, slug, request, jobId: jobId ?? null });

export interface ProxyRequest {
  compositionId?: string;
  /** Inclusive; the whole composition by default. */
  frameRange?: [number, number];
  /** Output height, default 360. */
  height?: number;
  /** Target rate, default 12: the nearest whole division of the composition's rate. */
  fps?: number;
  /** With the composition's audio, which takes a second pass. Default false. */
  audio?: boolean;
}

export interface ProxyResult {
  /** An MP4 in the project's cache. */
  path: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  frameRange: [number, number];
  bundleReused: boolean;
  bundleMs: number;
  elapsedMs: number;
}

/** A small review clip, from disk like `contactSheet`. Timeline edits reuse the bundle. */
export const proxy = (workspace: string, slug: string, request: ProxyRequest, jobId?: string) =>
  invoke<ProxyResult>("video_proxy", { workspace, slug, request, jobId: jobId ?? null });

/** Elements are found by `selector` (CSS) or visible `text`, `nth` picks among several matches. */
export type RecordStep = { label?: string; timeoutMs?: number } & (
  | { type: "goto"; url: string; settleMs?: number }
  | { type: "click" | "hover"; selector?: string; text?: string; nth?: number; moveMs?: number }
  | { type: "type"; text: string; selector?: string; nth?: number; delayMs?: number }
  /** e.g. "Enter", "Control+A". */
  | { type: "press"; key: string }
  | { type: "scroll"; y?: number; x?: number; selector?: string; text?: string; nth?: number; durationMs?: number }
  | { type: "wait"; ms?: number; selector?: string; text?: string }
  | { type: "eval"; js: string }
  /** Only adds an entry to the result's `events`. */
  | { type: "mark" }
);

export interface RecordRequest {
  steps: RecordStep[];
  /** CSS pixels and device scale; the clip is width×scale by height×scale. Default 1536×864 at 2. */
  viewport?: { width?: number; height?: number; scale?: number };
  colorScheme?: "light" | "dark";
  /** The clip's constant rate, default 60. */
  fps?: number;
  /** The file's name in `media/`. */
  name?: string;
  /** A visible pointer, default true. */
  cursor?: boolean;
  /** URL globs (`*`) or `/regex/` allowed to write. Everything else that isn't GET/HEAD/OPTIONS is
   *  answered locally and listed in the result's `blocked`. */
  allowWrites?: string[];
  /** URL globs of WebSockets to let through; others stay "connecting" forever. */
  allowWebSockets?: string[];
  /** Answers given without touching the network, before the write block. */
  routes?: { url: string; method?: string; status?: number; json?: unknown; body?: string; contentType?: string }[];
  /** Runs first in every page and frame: seed state, wrap fetch to mask data. */
  initScript?: string;
  localStorage?: Record<string, string>;
  /** The recording fails if any of these shows up on the page. */
  forbidText?: string[];
  /** Runs the steps without filming and returns a screenshot of how they end. */
  dryRun?: boolean;
  stepTimeoutMs?: number;
}

export interface RecordEvent {
  /** Seconds into the clip. */
  t: number;
  type: string;
  /** The element's box in CSS pixels, for a camera move in the editor. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  label?: string;
}

export interface RecordResult {
  path: string;
  /** Absent on a dry run. The file is in `media/`; adding it to the timeline is the caller's. */
  asset?: Asset;
  dryRun?: boolean;
  width?: number;
  height?: number;
  durationSecs?: number;
  capturedFrames?: number;
  capturedFps?: number;
  events: RecordEvent[];
  blocked: string[];
  warnings: string[];
}

export const record = (workspace: string, slug: string, request: RecordRequest, jobId?: string) =>
  invoke<RecordResult>("video_record", { workspace, slug, request, jobId: jobId ?? null });

export type MusicMood = "confident" | "uplifting" | "calm" | "tense" | "playful" | "ambient";

export interface MusicRequest {
  mood: MusicMood;
  durationSecs: number;
  /** The mood's own tempo by default. */
  bpm?: number;
  /** Seconds of the video's cuts: the tempo bends up to 3 % so they land on a beat. */
  cuts?: number[];
  /** Same seed, same piece. */
  seed?: number;
  /** Seconds of speech, for `ducking`. */
  voiceRanges?: [number, number][];
  /** The volume under a voice, default 0.25. */
  duckTo?: number;
  targetLufs?: number;
  name?: string;
}

export interface MusicResult {
  path: string;
  /** The file is in `media/`; adding it to the timeline is the caller's. */
  asset: Asset;
  mood: MusicMood;
  seed: number;
  bpm: number;
  durationSecs: number;
  sections: { name: string; startSecs: number; endSecs: number; energy: number }[];
  /** Bar lines: the clean places to cut or join the music. */
  barTimes: number[];
  finalChordSecs: number;
  /** Where each requested cut landed; `offsetSecs` isn't 0 when bending the tempo would be heard. */
  markers: { requested: number; t: number; offsetSecs: number; kind: "accent" | "cut" }[];
  /** Volume keyframes in seconds from the start of the music, to convert to clip frames. */
  ducking: { t: number; value: number }[];
  stats: {
    lufs: number;
    peakDb: number;
    rmsDb: number;
    crestDb: number;
    clippedSamples: number;
    dcOffset: number;
    stereoCorrelation: number;
    energyShare: { lowPct: number; midPct: number; highPct: number };
  };
  /** Measured problems. An empty list doesn't mean it sounds good: a person has to listen. */
  warnings: string[];
  elapsedMs: number;
}

export const music = (workspace: string, slug: string, request: MusicRequest, jobId?: string) =>
  invoke<MusicResult>("video_music", { workspace, slug, request, jobId: jobId ?? null });

/** Stops a task started with this `jobId`; its call rejects with "Cancelled.". */
export const cancelTool = (jobId: string) => invoke<void>("video_tool_cancel", { jobId });

export const onToolProgress = (cb: (p: ToolProgress) => void): Promise<UnlistenFn> =>
  listen<ToolProgress>("video-tool-progress", (e) => cb(e.payload));

/** Starts a render and resolves with its id at once; follow it with `onRenderProgress`. */
export const render = (workspace: string, slug: string, opts: RenderOptions) =>
  invoke<string>("video_render", { workspace, slug, opts });

export const renderCancel = (renderId: string) => invoke<void>("video_render_cancel", { renderId });

/** Renders one frame to PNG: into the cache (and the project's thumbnail), or into
 *  `out/<outputName>.png` when a name is given. Resolves with the absolute path. */
export const still = (workspace: string, slug: string, compositionId: string, frame: number, outputName?: string) =>
  invoke<string>("video_still", { workspace, slug, compositionId, frame, outputName: outputName ?? null });

/** Moves a project under `videos/` to the OS trash (an adopted Remotion project is only removed
 *  from the list; its folder stays). Stops its player and clears its cache. */
export const deleteProject = (workspace: string, slug: string) =>
  invoke<void>("video_delete_project", { workspace, slug });

/** Sets the display name; the folder (and so `slug`) follows it when that slug is free. Use the
 *  returned info's `slug` from then on. */
export const renameProject = (workspace: string, slug: string, name: string) =>
  invoke<VideoProjectInfo>("video_rename_project", { workspace, slug, name });

/** Copies a light project (not its renders) under a new slug. Pass the localized name, e.g.
 *  "Intro (copia)"; without it the backend uses "<name> (copy)". */
export const duplicateProject = (workspace: string, slug: string, name?: string) =>
  invoke<VideoProjectInfo>("video_duplicate_project", { workspace, slug, name: name ?? null });

/** Shows the project's folder in the OS file manager. */
export const revealProject = (workspace: string, slug: string) =>
  invoke<void>("video_reveal_project", { workspace, slug });

/** Turns a "legacy" project into the light layout (data kept, its node_modules and engine copy
 *  removed; the old code is backed up in the app's cache). Resolves with the updated info. */
export const convertToLight = (workspace: string, slug: string) =>
  invoke<VideoProjectInfo>("video_convert_to_light", { workspace, slug });

/** Copies a Nyxs project plus the engine into `dest` (an empty or new folder) so it runs
 *  outside Nyxs with `npm install && npx remotion studio`. Resolves with `dest`. */
export const exportStandalone = (workspace: string, slug: string, dest: string) =>
  invoke<string>("video_export_standalone", { workspace, slug, dest });

/** Shows the file in the OS file manager. */
export const openOutput = (path: string) => invoke<void>("video_open_output", { path });

/** Saves a file dropped from the OS (which has no path in the WebView) in the video cache and
 *  resolves with the copy's path, ready for `importMedia` / `createFromMedia`. */
export async function stageFile(workspace: string, file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invoke<string>("video_stage_file", bytes, {
    headers: { "x-workspace": encodeURIComponent(workspace), "x-name": encodeURIComponent(file.name) },
  });
}

export const onRuntimeProgress = (cb: (p: RuntimeProgress) => void): Promise<UnlistenFn> =>
  listen<RuntimeProgress>("video-runtime-progress", (e) => cb(e.payload));

/** `npm install` output of an adopted Remotion project (`install()`). */
export const onInstallProgress = (cb: (p: InstallProgress) => void): Promise<UnlistenFn> =>
  listen<InstallProgress>("video-install-progress", (e) => cb(e.payload));

export interface ThumbnailReady {
  slug: string;
  /** Absolute path of the new thumbnail (in the app's cache), for `convertFileSrc`. */
  path: string;
}

/** A project's automatic thumbnail was (re)rendered after `listProjects` found it stale. */
export const onThumbnailReady = (cb: (p: ThumbnailReady) => void): Promise<UnlistenFn> =>
  listen<ThumbnailReady>("video-thumbnail-ready", (e) => cb(e.payload));

export const onRenderProgress = (cb: (p: RenderProgress) => void): Promise<UnlistenFn> =>
  listen<RenderProgress>("video-render-progress", (e) => cb(e.payload));
