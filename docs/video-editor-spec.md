# Nyxs Video — Remotion video editor inside Nyxs

Shared contract for the sessions building this feature in parallel. Every session reads this
file first and sticks to the interfaces below. If an interface has to change, change it HERE in
the same edit and say so in your final report, so the other sessions can follow.

## Goal

A professional video editor inside Nyxs, built on Remotion. The user asks the agent for a video
("make a 30 s launch video, 1080p 60 fps"), or edits it by hand, in a new **Video** view in the
right-hand panel (next to Preview, Terminal, Files…): live player, multi-track timeline,
inspector, media bin, render to MP4/WebM/GIF/ProRes. The agent and the UI edit the same data, so
"make the second scene shorter" in the chat and dragging the clip on the timeline are the same
operation.

## Editing existing videos (first-class, not an afterthought)

Creating from scratch is only one entry point. The user must be able to EDIT what they already
have:

1. **An existing video file** (mp4, mov, webm, mkv, avi; plus images/audio alongside). "Open
   video…" in the picker, dropping a file on the Video view, "Edit in Video" in the Files panel
   context menu, or asking the agent ("edit ~/Downloads/demo.mov: cut the first 5 s and add
   captions"). This creates a project whose composition matches the source (width, height,
   fps, duration), imports the file(s) as assets and lays them on a video track in order (the
   video clip carries its own audio; "Detach audio" in the clip menu splits it to an audio
   track). Everything else — trimming, splitting, reordering, text, music, captions,
   transitions, effects, speed, crop/zoom, export — is the normal editor.
2. **A Nyxs video project** already in `<workspace>/videos/` (listed in the picker, reopens
   where it was: composition, playhead, zoom saved per project).
3. **An existing Remotion project** anywhere in the workspace (a package.json depending on
   `remotion`): "Open Remotion project" adopts it — adds `nyxs/` (player, serve, render) and a
   timeline.json if missing, without touching the user's own code. Its own compositions show
   in the composition switcher and can be previewed and rendered; they can be placed on a
   timeline as `scene` clips.

Editing helpers on footage (agent tools + clip context menu): trim to selection, split at
playhead, detach audio, speed ramp, crop/zoom (transform), remove silences (detects silent
ranges from the waveform and ripple-deletes them, threshold + padding options), cut by
transcript (captions → select words → delete those ranges), auto captions, replace audio /
add music with ducking, freeze frame, reverse (via render of the range), extract still.

Backend additions:
- `video_create_from_media(workspace, paths: Vec<String>, name: Option<String>) -> VideoProjectInfo`
- `video_adopt_project(workspace, path) -> VideoProjectInfo`
- `video_detect_silences(workspace, slug, assetId, thresholdDb, minDurationMs) -> Vec<[u32,u32]>` (frames at asset fps)
- `video_list_projects` also returns adopted Remotion projects (`kind: "nyxs" | "remotion"`).

## Architecture

**DECISION (user, overrides earlier drafts): NO `npm install` per video.** Remotion, React,
esbuild, the engine, the player and the render scripts are installed ONCE per app into a
shared, versioned **video runtime**. A video project is a light folder with only its data and
custom scenes; creating or opening one is instant.

```
~/.nyxs/video-runtime/<runtimeVersion>/     ← installed once (shared by every project)
  package.json + node_modules/              ← remotion, @remotion/*, react, react-dom, esbuild,
                                              typescript types; pinned versions
  nyxs/engine/**                            ← the generic timeline.json renderer (as built:
                                              under nyxs/, not at the runtime root)
  nyxs/serve.mjs, nyxs/player.tsx, nyxs/remotionShim.tsx, nyxs/render.mjs
  entry/index.ts, entry/Root.tsx            ← Remotion entry; imports the project via aliases
  nyxs/engine/scenes/*.tsx                  ← built-in scenes (TitleCard, LowerThird, LogoReveal)
  examples/demo/                            ← a sample light project (tests; not runtime code)
  standalone/                               ← overlay for "Export as standalone" (tsconfig.json
                                              with `@project/*` → `./*`)
  READY                                     ← written last; its absence = install incomplete

<workspace>/videos/<slug>/                  ← user content (committable), NO node_modules
  timeline.json                             ← THE document (schema below)
  scenes/*.tsx                              ← custom React scenes (clip type "scene")
  media/**                                  ← imported media (videos, images, audio, fonts)
  out/                                      ← renders (a .gitignore with `out/` is written)
  tsconfig.json                             ← only `paths` pointing at the runtime's types,
                                              so editors/LSP resolve `remotion` imports

~/.nyxs/projects/<encoded>/video/<slug>/    ← per-project cache: player bundle, Remotion
                                              bundle, thumbnails, waveforms, stills
```

- **Runtime install:** the template source lives in `src-tauri/resources/video-template/`
  (now = the runtime source, not a per-project template). On first use of the Video view (or
  first video tool call) Nyxs copies it to `~/.nyxs/video-runtime/<runtimeVersion>/` and runs
  `npm install` there ONCE, with progress in the UI (`video-runtime-progress` events), then
  writes `READY`. `runtimeVersion` = hash of the template's package.json + engine sources, so
  an app update that changes the engine installs a new runtime next to the old one (old ones
  are cleaned up after the new one is READY). Also pre-download Remotion's Chrome Headless
  Shell during this step (`npx remotion browser ensure`), so the first render doesn't stall.
- **Resolution of imports:** project scenes `import { useCurrentFrame } from "remotion"` and
  resolve it from the runtime: esbuild (player) with `nodePaths: [<runtime>/node_modules]`
  and an alias `@project` → the project folder; the Remotion bundler (render/still) with
  `webpackOverride` adding the runtime node_modules to `resolve.modules` and the same alias.
  Media: the project's `media/` is the `publicDir` (so `staticFile("media/x.mp4")` keeps
  working; asset `src` stays relative to the project folder, e.g. "media/intro.mov").
- **Player:** one `serve.mjs` process per open project, run with the runtime's node_modules,
  `--project <dir> --outdir <cache>`; same postMessage protocol.
- **Rendering:** `node <runtime>/nyxs/render.mjs --project <dir> ...` (no npx in the project).
- **Portability:** "Export as standalone Remotion project" (panel menu + backend command
  `video_export_standalone(workspace, slug, dest)`) writes a full package.json + engine + entry
  so the video also works outside Nyxs with `npm install && npx remotion studio`.
- **Adopted Remotion projects** (they already have their own package.json/node_modules) keep
  using their own node_modules; Nyxs only runs the runtime's serve/render scripts against
  their entry point. If their node_modules is missing, offer "Install dependencies" for that
  project only.
- Caches never go inside the user's project: `project_feature_dir(workspace, "video")`.
- Backend: `video_runtime_status() -> { installed: bool, version, path, installing: bool }`,
  `video_runtime_install()` (idempotent; concurrent callers await the same install),
  event `video-runtime-progress { stage: "copying"|"installing"|"browser"|"done"|"error", line?, progress? }`.
  `video_create_project` / `video_create_from_media` no longer run npm and no longer emit
  `video-install-progress`.
- TS wrappers (videoApi.ts) the panel calls: `runtimeStatus()`, `runtimeInstall()`,
  `onRuntimeProgress(cb)` (`RuntimeProgress = { stage, line?, progress?, error? }`),
  `exportStandalone(workspace, slug, dest) -> string`; `install(workspace, slug)` stays for
  adopted Remotion projects without node_modules.

## timeline.json schema (source of truth: `src/lib/video/timelineSchema.ts`)

The template keeps an identical copy at `src-tauri/resources/video-template/nyxs/engine/schema.ts`.
Both files must stay byte-identical below their header comment; a vitest test checks it.

```ts
export const TIMELINE_VERSION = 1;

export interface Timeline {
  version: 1;
  compositions: Composition[];
  /** Media the project knows about, referenced by clips through `assetId`. */
  assets: Asset[];
}

export interface Composition {
  id: string;                 // Remotion composition id, [A-Za-z0-9-]
  name: string;
  width: number;              // e.g. 1920
  height: number;             // e.g. 1080
  fps: number;                // e.g. 60
  durationInFrames: number;
  background: string;         // CSS color
  tracks: Track[];            // index 0 = bottom layer, last = top layer
  markers: Marker[];
}

export interface Marker { id: string; frame: number; label: string; color?: string }

export type TrackKind = "video" | "audio" | "text" | "overlay";
export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  hidden?: boolean;
  muted?: boolean;
  locked?: boolean;
  volume?: number;            // 0..2, audio/video tracks
  clips: Clip[];              // sorted by `from`, never overlapping within a track
}

export interface Asset {
  id: string;
  kind: "video" | "image" | "audio" | "font";
  /** Path relative to the project's public/ folder, e.g. "media/intro.mov". */
  src: string;
  name: string;
  durationInFrames?: number;  // at the asset's own fps, for video/audio
  fps?: number;
  width?: number;
  height?: number;
}

interface ClipBase {
  id: string;
  from: number;               // start frame on the composition
  durationInFrames: number;
  name?: string;
  transform?: Transform;
  opacity?: Animatable<number>;
  /** Transition INTO this clip from the previous clip on the same track. */
  transitionIn?: Transition;
  effects?: Effect[];
}

export type Clip = VideoClip | ImageClip | AudioClip | TextClip | ShapeClip | SceneClip | CaptionsClip;

export interface VideoClip extends ClipBase {
  type: "video"; assetId: string;
  trimStart: number;          // frames skipped at the start of the asset
  playbackRate?: number;      // 0.25..4
  volume?: Animatable<number>;
  fit?: "cover" | "contain" | "fill";
}
export interface ImageClip extends ClipBase {
  type: "image"; assetId: string; fit?: "cover" | "contain" | "fill";
  kenBurns?: { fromScale: number; toScale: number; fromX: number; toX: number; fromY: number; toY: number };
}
export interface AudioClip extends ClipBase {
  type: "audio"; assetId: string; trimStart: number;
  volume?: Animatable<number>; fadeIn?: number; fadeOut?: number;  // frames
}
export interface TextClip extends ClipBase {
  type: "text"; text: string; style: TextStyle;
  animation?: { in?: TextAnimation; out?: TextAnimation };
}
export interface ShapeClip extends ClipBase {
  type: "shape"; shape: "rect" | "circle" | "line"; fill: string; stroke?: string;
  strokeWidth?: number; radius?: number; width: number; height: number;
}
/** A custom React component from the project's scenes/<file>.tsx (or a built-in scene), exported by name. */
export interface SceneClip extends ClipBase {
  type: "scene"; file: string; exportName: string; props?: Record<string, unknown>;
}
export interface CaptionsClip extends ClipBase {
  type: "captions"; captions: Caption[]; style: TextStyle;
  mode: "line" | "word-highlight" | "karaoke"; highlightColor?: string;
}
export interface Caption { text: string; startMs: number; endMs: number; timestampMs?: number; confidence?: number }

export interface TextStyle {
  fontFamily: string; fontSize: number; fontWeight: number; color: string;
  align: "left" | "center" | "right"; lineHeight?: number; letterSpacing?: number;
  background?: string; padding?: number; radius?: number; shadow?: string; stroke?: string;
  maxWidth?: number;
}
export type TextAnimation =
  | { kind: "fade" | "slide-up" | "slide-down" | "slide-left" | "slide-right" | "scale" | "blur" | "typewriter" | "words" ; durationInFrames: number };

/** Position in px from the composition's top-left, of the clip's center; scale 1 = natural size. */
export interface Transform {
  x: Animatable<number>; y: Animatable<number>;
  scale: Animatable<number>; rotation: Animatable<number>;   // degrees
  anchor?: "center" | "top-left";
}

/** A fixed value, or keyframes with frames RELATIVE to the clip start. */
export type Animatable<T> = T | { keyframes: Keyframe<T>[] };
export interface Keyframe<T> { frame: number; value: T; easing?: Easing }
export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "spring";

export interface Transition {
  kind: "fade" | "slide" | "wipe" | "flip" | "clock-wipe" | "iris" | "none";
  durationInFrames: number;
  direction?: "from-left" | "from-right" | "from-top" | "from-bottom";
}

export type Effect =
  | { kind: "blur"; amount: Animatable<number> }
  | { kind: "brightness" | "contrast" | "saturate"; amount: Animatable<number> }
  | { kind: "grayscale" | "sepia" | "invert"; amount: Animatable<number> }
  | { kind: "hue-rotate"; degrees: Animatable<number> }
  | { kind: "drop-shadow"; x: number; y: number; blur: number; color: string }
  | { kind: "chroma-key"; color: string; tolerance: number }
  | { kind: "vignette"; amount: number };
```

Pure helpers, in the same schema module (both copies): `resolveAnimatable(value, frameInClip)`,
`validateTimeline(json): { ok: true; timeline } | { ok: false; errors: string[] }`,
`emptyTimeline(opts)`, `newId(prefix)`.

**As built (template session)** — semantics the engine implements (also as doc comments in the
schema): also exported are `applyEasing`, `isKeyframed`, `resolveTransform(transform, frameInClip,
comp)`, `defaultTransform`, `clipEnd`, `sceneModuleName` and the enum arrays (`CLIP_TYPES`,
`TRACK_KINDS`, `EASINGS`, `TRANSITION_KINDS`, `TEXT_ANIMATION_KINDS`, `EFFECT_KINDS`).
- A keyframe's `easing` shapes the segment that LEAVES it (towards the next keyframe); default
  linear. `spring` is fps-independent (~10 % overshoot, settles at the next keyframe).
- `trimStart` is in frames at the COMPOSITION fps (Remotion's `trimBefore`).
- No `transform` = centered at natural size; captions default to `y = 82 %` of the height.
  Natural size: video/image/scene = the whole composition; shape = width×height; text = its
  content (`maxWidth` wraps); captions = `maxWidth` or 90 % of the width.
- `transitionIn` plays over the FIRST `durationInFrames` of the clip. If the previous clip on
  the track ends exactly at `from`, it keeps rendering underneath as the exiting side (so a video
  needs that many extra source frames); otherwise the clip transitions in from transparent.
- Font assets: `Asset.name` is the CSS family; `TextStyle.fontFamily` matching it uses the file.
  Any other family is loaded from the Google Fonts CSS API (weight rounded to the hundred, falls
  back to the regular face; unknown families keep the fallback font), except generic/system
  families. Not `@remotion/google-fonts`' catalog: importing it adds ~1,850 modules to every
  bundle. Scenes should still use `@remotion/google-fonts/<Family>` (one module per font).
- Effect amounts: blur px; brightness/contrast/saturate multipliers (1 = unchanged);
  grayscale/sepia/invert 0..1; vignette 0..1; chroma-key tolerance 0..1 (RGB distance).
- Captions times are ms relative to the clip start; word-level captions are fine (the engine
  adds spaces and groups them into pages with `@remotion/captions`).
- `validateTimeline` errors look like
  `compositions[0].tracks[1].clips[2] (id "clip-a1"): overlaps clip "clip-b2" (frames 30-90)…`.
  It also rejects audio clips off audio tracks (and non-audio on them), unknown/mismatched
  `assetId`, a trim that runs past a known asset duration, `..`/absolute paths in `src`/`file`.
- Scenes: `file` is a name inside the project's `scenes/` with or without `.tsx` (only `.tsx`
  files load). The project's scenes win; otherwise the runtime's built-in `nyxs/engine/scenes/` (TitleCard,
  LowerThird, LogoReveal) are used, so `"file": "TitleCard"` works in every project.
- Footage: OffthreadVideo when rendering (frame-exact), an HTML5 video in the player; the clip's
  own audio plays (clip volume × track volume, track mute). The engine picks `trimBefore` or
  `startFrom` by Remotion version (renamed in 4.0.319) and has its own iris transition, so it
  also runs on older Remotion 4 releases (tested with 4.0.300).
- The DOM of each clip box carries `data-nyxs-clip-id` / `data-nyxs-track-id`; the composition
  root carries `data-nyxs-root` (the player uses them for hit testing and the selection box).

## Player protocol (iframe ⇄ Nyxs), `src/lib/video/playerProtocol.ts`

All messages are `{ source: "nyxs-video", ...}`. The iframe only accepts messages from its parent.

Nyxs → player:
- `{ type: "load", timeline: Timeline, compositionId: string }` — instant re-render, no reload
- `{ type: "play" } | { type: "pause" } | { type: "toggle" }`
- `{ type: "seek", frame: number }`
- `{ type: "setLoop", loop: boolean }`, `{ type: "setPlaybackRate", rate: number }`
- `{ type: "setVolume", volume: number }`, `{ type: "setMuted", muted: boolean }`
- `{ type: "setOverlay", safeAreas: boolean, grid: boolean, selectedClipId: string | null }`
- `{ type: "setZoom", zoom: "fit" | number }`
- ADDED (template session): `{ type: "loadProjectComposition", compositionId: string, inputProps?: object }`
  — shows one of an adopted project's own compositions (from its Root) instead of the timeline;
  the next `load` switches back to the timeline. `defaultProps` + `inputProps`, then
  `calculateMetadata` (if any) decide size, fps, duration and props, as in Remotion.

Player → Nyxs:
- `{ type: "ready", remotionVersion: string }`
- `{ type: "frame", frame: number, playing: boolean }` (throttled to animation frames)
- `{ type: "ended" }`
- `{ type: "error", message: string, stack?: string }` (scene compile/runtime errors)
- `{ type: "clipClicked", clipId: string }` (click on canvas selects the clip)
- `{ type: "transformDrag", clipId: string, transform: Transform }` (drag/resize/rotate
  handles on the canvas for the selected clip; Nyxs writes it into timeline.json)
- `{ type: "bundleRebuilt" }` (after scenes/ or the adopted project's code changed)
- ADDED (template session): `{ type: "keydown", key, code, shiftKey, ctrlKey, metaKey, altKey }`
  — every keydown inside the iframe is forwarded (Space/arrows/Home/End have their default
  prevented), so the panel's shortcuts keep working after the user clicks the canvas.
- ADDED (template session): `{ type: "projectCompositions", entry: string | null, compositions:
  ProjectCompositionInfo[], error?: string }` — once after every `ready`. `entry` is the adopted
  project's Remotion entry (null for light projects, which have none). `ProjectCompositionInfo =
  { id, width, height, fps, durationInFrames (null when only calculateMetadata gives them),
  defaultProps (null if not JSON or > 50 KB), hasCalculateMetadata, still, folder }`. The list
  comes from rendering the project's Root with a stand-in for `<Composition>`/`<Still>`/`<Folder>`
  (nyxs/remotionShim.tsx), so no user code is changed and Remotion's internals aren't used.

Player behavior, as built:
- Runs fine in `<iframe sandbox="allow-scripts">` (opaque origin, `Origin: null`): every response
  has `Access-Control-Allow-Origin: *`; the boot script swaps in in-memory `localStorage` /
  `sessionStorage` (they throw there) and restores `window.origin` (Remotion resolves media
  against it). After a rebuild the page reloads itself, keeping its state in `window.name`
  (timeline, composition or project composition, frame, playing, loop, rate, volume, overlay,
  zoom), and sends `ready` then `bundleRebuilt`. Nyxs may simply re-send `load` on every
  `ready`. Before the first `load` the page shows the project's own timeline.json.
- `load` is validated; an invalid timeline or unknown `compositionId` keeps the previous one and
  sends `error` (and shows it on the canvas). Build errors (`Build failed:\n<file:line: msg>`) and
  runtime errors (e.g. a scene without that export) show an error panel AND send `error`; the
  next good `load` / rebuild clears them.
- Clicking selects the topmost unlocked clip that actually paints at that point (transparent
  parts of full-frame scenes fall through). Dragging any clip moves it (Shift = one axis,
  snaps to the center lines, Alt = no snap); corner handles scale uniformly from the anchor
  (Shift = 5 % steps), the top handle rotates (Shift = 15°). `transformDrag` is sent once per
  animation frame while dragging and once on release, with plain numbers (the values at the
  playhead); the player shows the dragged position until the next `load` (or 1.5 s).
  `clipClicked` is only sent when the clicked clip is not already `selectedClipId`.
- `setZoom` number = scale factor (1 = 100 %); the stage scrolls when larger than the iframe.
  Safe areas = 90 % (action) and 80 % (title); grid = thirds + center cross.
- Debug hook: `window.nyxsPlayer.send(msg)` in the iframe; `window.__nyxsMessages` logs what it sent.
- `node <runtime>/nyxs/serve.mjs --project <dir>` flags: `--port <n|0>`, `--outdir <dir>` (bundle
  goes to `<dir>/player-bundle/`, wiped at start), `--host` (default 127.0.0.1), `--watch-stdin`,
  `--entry <file>` (adopted: override the entry; default `remotion.config`'s `setEntryPoint`,
  then `src/index.ts(x)` and the usual places), `--public-dir <dir>` (adopted; default
  `setPublicDir`, then `public/`), `--node-path <dir>` (extra package folders). With `--port 0`
  it tries the last session's port first (`<outdir>/last-port`). It listens and prints
  `NYXS_PLAYER_PORT=<n>` before anything else, about 100 ms after node starts; no build holds it.
- **Fast open:** `<runtime>/prebuilt/` (from `nyxs/prebuild.mjs`, same as `serve.mjs --prebuild`,
  generated, never in the template) holds the player, engine, React and Remotion, minified, served
  from `/__nyxs/core/<id>/` with immutable cache headers. A stable port makes reopens come from
  the HTTP cache, also in the sandboxed iframe. Project scenes bundle on their own
  (`/__nyxs/bundle/scenes.js`, fetched when a scene clip first mounts) with `react`, `react-dom`
  and `remotion` left to the page's import map, so there is one instance of each. No scene files =
  no esbuild at all; an unchanged project reuses last session's bundle (`player-bundle/manifest.json`:
  every input's mtime + size). If `prebuilt/` is missing or doesn't match the sources, the first
  open builds it (about 1 s) with the page waiting, not the port. Adopted projects on the runtime's
  Remotion family use the same path; those with their own matching family get a full build,
  reused the same way. `ready` is posted when React mounts; fonts, media and scenes never hold it.
  Only files a build read, or files in `scenes/`, trigger a rebuild and a page reload.
  Warm idle servers stay cheap: a native file watcher (no polling); with no page connected a
  change only marks the bundle dirty (the next page gets one rebuild), and esbuild's context is
  released after 30 s without clients.
  Routes: `/` page, `/__nyxs/bundle/*`, `/__nyxs/events` (SSE), `/__nyxs/timeline.json`,
  `/__nyxs/core/<id>/*`, `/__nyxs/status` (`{ ok, error, builds, entry, light, core, timing,
  remotion: { version, from: "project"|"runtime", project } }`), and media with HTTP Range: light project `/media/*` →
  `<project>/media/*` (nothing else in the project is served); adopted → its public dir.
- Light vs adopted = whether the project has a package.json. Light: everything resolves from the
  runtime; `@project/...` → the project folder. Adopted: its own node_modules come first, and its
  own entry is bundled (for `projectCompositions`). One copy of react/remotion/`@remotion/*`
  per bundle: the project's when it has `@remotion/player`, `/transitions`, `/captions` and
  `/google-fonts` at its `remotion` version, otherwise the runtime's for ALL code (mixing
  versions doesn't build; Remotion 4 is compatible within the major, so previews work without
  installing anything; renders still use the project's own packages via render.mjs).
- Rebuilds: a native recursive `fs.watch` on the project (not esbuild's polling watcher, which
  took up to 30 s) → `bundleRebuilt` ~0.4–0.7 s after a save. timeline.json, media/public,
  node_modules, out/ never trigger a rebuild. New scene files are picked up (the player's scene
  loader is generated from the files in `scenes/` + built-ins on every build).

## Rust backend — module `src-tauri/src/video/`, TS wrapper `src/lib/video/videoApi.ts`

Commands (all async, errors as the app's usual error type):
- `video_check_env() -> { node: Option<String>, npm: Option<String>, ffmpegViaRemotion: bool }`
- `video_list_projects(workspace) -> Vec<VideoProjectInfo>` — `{ slug, path, name, compositions, updatedAt, thumbnail? }`
- `video_create_project(workspace, name, preset: { width, height, fps, durationInFrames }) -> VideoProjectInfo`
  copies the template to `<workspace>/videos/<slug>/`, writes timeline.json, runs `npm install`
  streaming `video-install-progress` events `{ slug, line }`.
- `video_player_start(workspace, slug) -> { url, port }` / `video_player_stop(workspace, slug)`
  spawns `node nyxs/serve.mjs --port 0 --outdir <cache>`; reads the port from its stdout.
  Killed when the app quits or the project closes (no orphan node processes).
- `video_read_timeline(workspace, slug) -> String` / `video_write_timeline(workspace, slug, json)`
  (atomic write: temp file + rename). The existing fswatch `fs-change` event tells the panel
  when the agent changed timeline.json.
- `video_import_media(workspace, slug, paths: Vec<String>) -> Vec<Asset>` copies into
  `public/media/`, probes duration/size/fps (via `npx remotion ffprobe`), dedupes names.
- `video_thumbnails(workspace, slug, assetId, count) -> Vec<String>` (cached image paths) and
  `video_waveform(workspace, slug, assetId, buckets) -> Vec<f32>` (cached, 0..1 peaks).
- `video_render(workspace, slug, opts) -> renderId` with
  `opts = { compositionId, codec: "h264"|"h265"|"vp8"|"vp9"|"prores"|"gif", crf?, scale?, frameRange?: [u32,u32], fps?, audioCodec?, muted?, outputName }`
  emits `video-render-progress { renderId, stage: "bundling"|"rendering"|"encoding"|"done"|"error"|"cancelled", progress: 0..1, renderedFrames, totalFrames, etaSecs?, outputPath?, error? }`.
- `video_render_cancel(renderId)`, `video_still(workspace, slug, compositionId, frame) -> path`.
- `video_open_output(path)` reveals the file in the OS file manager.
- `video_still` writes its PNG inside the video cache (under `~/.nyxs`), so the WebView can
  show it through the asset protocol (tool-chip thumbnails) and the agent can read it.
- `video_extract_audio(workspace, slug, assetId, startMs?: u64, endMs?: u64) -> path` (added by
  the agent session for captions): a 16 kHz mono 16-bit PCM WAV of that asset's audio range,
  written in the video cache (via `npx remotion ffmpeg`). TS wrapper: `extractAudio(...)` in
  videoApi.ts. `src/lib/video/captions.ts` falls back to decoding a video asset in the WebView
  when the command is missing.

- `video_stage_file` (requested by the panel session for OS drag & drop): the main window has
  `dragDropEnabled: false` (the chat relies on HTML5 drops), so a file dropped from the OS
  reaches the WebView as a `File` with no path. The panel sends its bytes as a RAW invoke body
  (`invoke("video_stage_file", bytes: Uint8Array, { headers: { "x-workspace": encodeURIComponent(ws), "x-name": encodeURIComponent(name) } })`,
  read in Rust with `tauri::ipc::Request` → `InvokeBody::Raw`, never JSON) and gets back the
  absolute path of a copy under `project_feature_dir(workspace, "video")/incoming/`, which it
  then passes to `video_import_media` / `video_create_from_media`. TS wrapper:
  `stageFile(workspace, file: File) -> Promise<string>`. Files there may be deleted after import.

- `video_asset_frame(workspace, slug, assetId, timeSecs: f64) -> path` (requested by the panel
  session for "Freeze frame"): one exact frame of the ASSET (not the composition, which would
  bake other tracks' text into the hold) as a PNG in the video cache. TS: `assetFrame(...)`.
  Until it exists the panel falls back to `video_still` of the composition.

**As built (backend session, runtime design)** — precisions over the list above; the TS
wrappers in `videoApi.ts` mirror them (names other sessions call are unchanged):
- **Runtime** (`src-tauri/src/video/runtime.rs`): `<home>/.nyxs/video-runtime/<version>/`
  (shared by all accounts; `NYXS_VIDEO_RUNTIME_ROOT` overrides it in tests). `version` =
  sha256 of the path + content of `package.json`, `nyxs/**` and `entry/**` (CRLF folded;
  `examples/` and `standalone/` don't count), 16 hex. Export skips `examples/`.
  `video_runtime_status() -> { installed, version, path, installing }`,
  `video_runtime_install() -> RuntimeStatus` (TS `runtimeStatus`, `runtimeInstall`,
  `onRuntimeProgress`). Install = copy template → `npm install` → `remotion browser ensure` →
  `READY` (JSON with the package.json hash). If an older READY runtime has the same
  package.json, its node_modules is MOVED over instead of reinstalling (an engine-only update
  takes seconds). Old runtimes are deleted after the new one is READY. One install at a time;
  concurrent callers wait and get the same result.
- **Light project** = `timeline.json`, `scenes/`, `media/`, `.gitignore` (`out/`),
  `tsconfig.json` (paths `@project/*` → `./*` and `*` → `<runtime>/node_modules/*`, refreshed on
  `video_player_start` when the runtime changed, never if the user wrote their own). A folder
  with a `package.json` is treated as an adopted Remotion project. Asset `src` is relative to
  the project ("media/x.mp4"); in adopted projects to their `public/`.
- `VideoProjectInfo` = `{ slug, kind: "nyxs" | "remotion", path, name, compositions:
  VideoCompositionInfo[], updatedAt, thumbnail?, installed }`. `installed` = runtime READY
  (Nyxs projects) or own node_modules (adopted). `name` = first composition's name.
  `VideoCompositionInfo = { id, name, width, height, fps, durationInFrames, source: "timeline" |
  "project" }`.
- `video_install(workspace, slug)` (TS `install`): installs the runtime for a Nyxs project,
  `npm install` in the project for an adopted one (`video-install-progress { slug, line, done?,
  error? }`).
- **Player**: `node <runtime>/nyxs/serve.mjs --project <dir> --outdir <cache>/player --port 0
  --watch-stdin` (cwd = runtime); adopted projects add `--entry <their entry> --node-path
  <runtime>/node_modules`. Nyxs holds stdin, so the server dies with the app.
  **Servers stay warm**: `video_player_stop` (TS `playerStop`) only marks a server idle.
  `video_player_start` reuses a live one instantly (same URL). At most 2 keep running: a new
  one stops the longest idle, never one in use. Idle ones stop after 10 min; all die on app
  exit; an app reload marks all idle. `video_player_kill` (TS `playerKill`) really stops it, for
  Retry; rename, delete and convert kill internally. After `video_list_projects` the most
  recently edited light project's server pre-starts in the background (idle, only if fewer than
  2 run, at most once per 10 min per project). Starts lock per project, so one slow start
  doesn't hold up another.
  **Prebuild**: `node <runtime>/nyxs/serve.mjs --prebuild` runs in `video_runtime_install` after
  the browser, as `video-runtime-progress` stage `"player"` (non-fatal), leaving the marker
  `<runtime>/PLAYER_PREBUILT`. A runtime without the marker builds it once per app run in the
  background on the first start.
- **Encoder and load** (`nyxs/encoder.mjs`): one real frame through the bundled ffmpeg decides
  NVENC/VideoToolbox for h264/h265 (cached per runtime in `encoder-probe.json`; a failed probe
  expires in 1 h). CRF presets map to measured CQs; a failed hardware encode retries on the CPU
  with no visible error. Chrome keeps its default GL: `angle` reaches the GPU but changes scene
  pixels. Capped concurrency, below-normal priority (a Windows job holds Chrome's GPU process).
  The encoder in use reaches the queue through an `encoder` event.
- **Render/still/list**: `node <runtime>/nyxs/render.mjs --project <dir> <options.json>` →
  JSON lines (`progress` / `encoder` / `done` / `error` / `compositions`). render.mjs is owned by the
  backend session. Nyxs project: entry `<runtime>/entry/index.ts`, `webpackOverride` adds
  `<runtime>/node_modules` to `resolve.modules` and alias `@project` → project dir, a per-project
  webpack cache, an empty publicDir, and after bundling a junction (Windows) / symlink
  `bundle/public/media` → `<project>/media` (no copy of the footage). Adopted: their entry
  (`remotion.config` `setEntryPoint`, else the usual places), their public/, their own
  `@remotion/bundler`/`renderer` when installed. SO the runtime entry must read project data
  only via `@project/...` (`@project/timeline.json`, scenes via `@project/scenes/${name}.tsx`).
- `video_still(..., outputName?)`: with a name → `out/<name>.png`; without → cache (becomes
  the project's `thumbnail`). `video_render`: `progress` of the whole job (bundling = first
  10 %); `fps` only for GIFs; `crf` dropped for prores/gif; output `out/<name>.<ext>`.
- **Managing projects** (TS `deleteProject`, `renameProject`, `duplicateProject`,
  `revealProject`, `onThumbnailReady`):
  `video_delete_project(ws, slug)` stops the player, moves a project under `videos/` to the OS
  trash (`trash` crate; never a hard delete) — an adopted project is only removed from the list
  — and deletes its cache. `video_rename_project(ws, slug, name) -> VideoProjectInfo` writes the
  display name to `<project>/nyxs.json` `{ name }` and renames the folder (and its cache) to
  `slugify(name)` when that is free; callers must use the returned `slug`. Adopted projects
  can't be renamed. `video_duplicate_project(ws, slug, name?) -> VideoProjectInfo` copies a light
  project except `out/` (default name "<name> (copy)"; the panel passes the localized one).
  `video_reveal_project(ws, slug)`. Display name = `nyxs.json`, else the old
  `nyxs/project.json`, else the first composition's name.
- **Thumbnails**: `video_list_projects` stays instant and queues, for each playable project
  whose timeline.json (size + mtime) changed, a still at 10 % of the first composition at 0.34
  scale → `<cache>/<slug>/poster-auto.png`, one render at a time in the background, then emits
  `video-thumbnail-ready { slug, path }`. `thumbnail` = that poster, else the last manual still.
  A failed poster isn't retried until the timeline changes.
- **Legacy projects** (made before the runtime: own package.json + `nyxs/project.json` or
  `src/engine/`) list as `kind: "legacy"` and still play/render as adopted ones.
  `video_convert_to_light(workspace, slug) -> VideoProjectInfo` (TS `convertToLight`, only under
  `videos/`): stops its player; moves `public/**` to `media/**` (paths not under `media/` get
  `media/` prepended and asset `src` rewritten), `src/scenes/*` to `scenes/` except the
  template's TitleCard/LowerThird/LogoReveal (the runtime has them); moves src/, nyxs/,
  public/, package.json, package-lock.json and the old tsconfig to
  `<cache>/<slug>/legacy-backup-<unix time>/`; deletes node_modules; writes `.gitignore` and
  the light tsconfig. `out/` stays. Verified on a copy of videos/nyxs-demo-2 (renders).
- `video_export_standalone(workspace, slug, dest) -> dest` (TS `exportStandalone`): `dest`
  must be absolute and empty/new. Copies the template (minus node_modules and `standalone/`),
  the project's timeline.json and scenes/, its media/ into `public/media/`, then overlays
  `template/standalone/**` if the template has it, and writes a `remotion.config.ts` (entry +
  `@project` alias → the folder) unless the overlay brought one. package.json name = slug.
- ffmpeg/ffprobe run through `<runtime>/node_modules/@remotion/cli/remotion-cli.js` (or an
  adopted project's own). Remotion's ffmpeg is a stripped build: waveforms pipe a WAV, silence
  detection uses `-vn`.
- Never run `npm install` inside `src-tauri/resources/video-template/`: the folder is bundled
  as a resource and hashed into the runtime version.

Runtime task scripts (`nyxs/review.mjs`, `record.mjs`, `music.mjs`, run by `video/tools.rs`, same
`--project <dir> <options.json>` call and JSON-line events as render.mjs). All take
`(workspace, slug, request, jobId?)`, report through `video-tool-progress
{ jobId, stage, progress?, rendered?, total? }`, stop with `video_tool_cancel(jobId)`; request and
result types are in `videoApi.ts`:
- `video_contact_sheet`: N frames of a composition or a video asset as ONE labeled JPEG in the cache.
- `video_proxy`: a small low-fps MP4 of a frame range in the cache.
- `video_record`: films a URL through steps into `media/` with Remotion's Chrome Headless Shell over
  a CDP pipe (no Playwright). Read-only by default: non-GET requests are answered locally unless
  allowed, in every frame and worker, and WebSockets and WebRTC are stubbed. Doesn't stop a GET
  that writes.
- `video_music`: an original synthesized WAV into `media/`, plus section times, bar lines, where the
  cuts landed, ducking keyframes in seconds, and measured numbers. Nobody can verify by ear in tests.
- `video_record` and `video_music` return an `Asset` and leave timeline.json alone: the caller adds
  it through the store, like an import.
- Bundles: `nyxs/bundle.mjs` keeps them in `<cache>/bundles/<key>/`, keyed by the runtime and the
  project's code (paths, sizes, mtimes), never timeline.json or media/. A timeline edit reuses the
  bundle because the document reaches the page as `inputProps`.
- Remotion's ffmpeg has about 50 filters: no `fps`, `tile`, `drawtext`, `ebur128`. Chrome draws the
  sheet's labels, `-r` with `-fps_mode cfr` gives a constant rate, and loudness is measured in JS.

Use `project_paths::project_feature_dir(workspace, "video")` for caches. Windows: spawn
`npm.cmd`/`npx.cmd`, no console window (CREATE_NO_WINDOW), kill the whole process tree on cancel.

## Frontend layout — `src/components/video/`

- `ViewsPanel.tsx` gets a new `ViewId` `"video"` (icon `Clapperboard`), label in i18n.
- `VideoView.tsx`: project picker / "New video" (presets: 1080p 16:9, 4K, 9:16 vertical
  1080×1920, 1:1, 4:5; fps 24/25/30/60), env check with a clear message if Node is missing.
- Layout: top bar (project, composition switcher, size·fps, undo/redo, Render button) ·
  left media bin · center player · right inspector · bottom timeline. Resizable splitters,
  persisted per account like the rest of ViewsPanel.
- Player transport: play/pause (Space), frame step (←/→, Shift = 10 frames), J/K/L, Home/End,
  loop, playback rate, volume, timecode `HH:MM:SS:FF` and frame number, zoom fit/50/100/200%,
  safe areas & grid overlay toggles, fullscreen.
- Inspector: per selected clip — timing (from, duration, trim, speed), transform with
  keyframe toggles (◆ at playhead), opacity, text content + full TextStyle with font picker,
  animation in/out, transition in, effects list (add/remove/reorder), audio volume/fades,
  scene props as an auto form from JSON. Composition settings when nothing is selected.
- Media bin: import button + drag & drop from the OS, grid with thumbnails, durations, filter
  by kind, drag to the timeline to create a clip.
- Render dialog (follow the nyxs-dialogs skill): format presets (MP4 H.264, H.265, WebM,
  ProRes, GIF, PNG frame), quality, scale, range (all / in-out / markers), output name;
  render queue with progress, ETA, cancel, "Show in folder", "Open".

## Timeline editor — `src/components/video/timeline/`, state in `src/lib/video/timelineStore.ts`

- Store: the Timeline document + selection + playhead + zoom; every edit is a pure operation
  in `src/lib/video/timelineOps.ts` (unit-tested) with undo/redo (history of documents,
  coalescing drags). Saves debounced (300 ms) through `video_write_timeline`; reloads on
  `fs-change` of timeline.json when it differs from the last write (agent edits), keeping the
  selection when ids still exist.
- Ops: add/remove/move/trim (both edges)/split at playhead/duplicate/ripple delete, move
  across tracks of a compatible kind, snapping (playhead, clip edges, markers; Alt disables),
  multi-select (Shift/Ctrl, marquee), copy/paste, nudge with arrows, add/rename/reorder/
  hide/mute/lock tracks, markers (M), in/out points (I/O), keyframe add/move/delete.
- UI: ruler with timecode adapting to zoom, playhead scrub, Ctrl+wheel zoom, horizontal
  scroll, track headers (eye/mute/lock/volume), clips colored by type with name, video
  thumbnails strip, audio waveform, transition handles between clips, keyframe diamonds on
  the selected clip, context menu (split, duplicate, delete, ripple delete, properties).
- Shortcuts only when the timeline/player has focus; listed in a "?" shortcuts popover.

Store reference (`timelineStore.ts`, as built):
- State hooks: `useTimelineStore(selector)` (selector must return a stored value or a
  primitive), `useTimeline()`, `useComposition()`, `useSelection()` (`{ clipIds, trackId,
  markerId }`), `useSelectedClip()` (the clip when exactly one is selected).
- Playhead (own store, so playback never re-renders clips): `usePlayhead()`, `getPlayhead()`,
  `setPlayhead(frame, source)`, `subscribePlayhead(cb)`.
- History: `commit(next, { coalesce })`, `apply(fn, { coalesce })` — same `coalesce` key within
  1 s = one undo step (typing in the inspector); drags use `beginGesture` /
  `updateGesture(fn(base, compId))` / `endGesture` / `cancelGesture` (one step, Escape cancels).
- `timelineActions`: select/selectAll/clearSelection/selectTrack/selectMarker, setZoom,
  setSnapping, placeAsset, placeClip, deleteSelected(ripple), splitAtPlayhead,
  duplicateSelected, copy/cut/paste (at the playhead), nudge, updateClip, updateComposition,
  setTransition, addTrack/removeTrack/renameTrack/moveTrack/setTrackProps,
  toggleMarkerAtPlayhead/updateMarker/removeMarker, markIn/markOut/setInOut,
  addKeyframe(clipId, path, frameInClip?, value?)/removeKeyframes, showProperties (selects and
  fires `SHOW_CLIP_PROPERTIES_EVENT`).
- Keyframe paths (`timelineOps.AnimPath`): `transform.x|y|scale|rotation`, `opacity`, `volume`,
  `effects.<i>.amount`, `effects.<i>.degrees`; helpers `getAnimatable`, `setAnimatable`,
  `keyframeFrames(clip)`.
- Footage ops (`timelineOps.ts`, tested in `footageOps.test.ts`; store actions of the same
  name): `detachAudio(tl, compId, clipId, newTrackName?)` (refused for speed ≠ 1 or an already
  silent clip), `rippleDeleteRanges(tl, compId, clipId, ranges)` (composition frames, clamped to
  the clip; the clip and clips `inSync` with it are cut, overlapping text/captions/visuals are
  cut too, non-synced audio such as music keeps playing and only gets shorter; markers and the
  duration follow), `trimClipsToRange(tl, compId, ids, in, out)` /
  `trimCompositionToRange(tl, compId, in, out)` (store: `trimToInOut()`),
  `freezeFrame(tl, compId, clipId, frame, stillAsset, holdFrames)` (ripple insert of an image
  hold; synced audio is split too), `setClipSpeed(tl, compId, clipId, rate)` (duration and
  keyframes rescale, later clips on the track follow), `inSync(a, b)`. The clip menu offers
  detach audio, freeze frame at the playhead (2 s, via `video_still` + `video_import_media`),
  speed presets and trim to in/out. `cutRanges.ts` (all tracks, from the inspector/agent
  sessions) stays for whole-composition cuts.
- Track heights (`src/lib/video/trackHeights.ts`) are view state, never in timeline.json:
  `state.trackSize` (S/M/L toolbar toggle; choosing one drops hand-set heights) and
  `state.trackHeights` (by track id, 28..160 px; drag a header's bottom edge, double-click
  resets). `timelineActions.setTrackSize`, `setTrackHeight(id, px | null)`. Saved per project by
  `projectResume.ts` with the zoom; `timelineActions.restoreView(saved)` puts them back, and a
  restored zoom is no longer overwritten by the fit on open.
- Invariants: every op returns tracks sorted by `from` with no overlaps, transitions no longer
  than their clip and keyframe frames >= 0 (seeded fuzz test `timelineInvariants.test.ts`).
  `repairTimeline(tl)` (+ `timelineProblems(tl)`) sorts tracks and moves an overlapping clip,
  at the same frame, to another track of its kind (or a new one) — nothing is cut. The store
  runs it on every commit, and on load / outside edits a file that only fails on order or
  overlaps is repaired instead of rejected (`state.repaired`, fix saved); `timelineActions.repair()`.
- Outside edits: on `fs-change` the store re-reads timeline.json; if it differs from our recent
  writes and validates, it becomes an undoable step (deferred until a running drag ends). An
  invalid file sets `externalError` and our document is kept.

## TS module APIs the panel uses (proposed by the panel session; owners may refine, keep names)

`src/lib/video/videoApi.ts` — one async function per command, camelCase, args as an object
when more than one: `checkEnv()`, `listProjects(workspace)`, `createProject(workspace, name,
preset)`, `createFromMedia(workspace, paths, name?)`, `adoptProject(workspace, path)`,
`playerStart(workspace, slug)`, `playerStop(workspace, slug)`, `readTimeline(workspace, slug)`,
`writeTimeline(workspace, slug, json)`, `importMedia(workspace, slug, paths)`,
`thumbnails(workspace, slug, assetId, count)`, `waveform(workspace, slug, assetId, buckets)`,
`render(workspace, slug, opts)`, `renderCancel(renderId)`, `still(workspace, slug,
compositionId, frame)`, `openOutput(path)`; listeners `onInstallProgress(cb)` and
`onRenderProgress(cb)` returning `Promise<UnlistenFn>`. Exported types: `VideoEnv`,
`VideoProjectInfo`, `VideoPreset`, `RenderOptions`, `RenderProgress`.
Shared runtime (used by the agent tools and the panel): `runtimeStatus(): Promise<RuntimeStatus>`
(`{ installed, version, path, installing }`), `runtimeInstall(): Promise<RuntimeStatus>`
(resolves when READY, rejects on error), `onRuntimeProgress(cb: (p: RuntimeProgress) => void)`
with `RuntimeProgress = { stage, line?, progress? }`.

`src/lib/video/playerProtocol.ts` (as written): `ToPlayerMessage`, `FromPlayerMessage`,
`postToPlayer(iframe, msg)`, `onPlayerMessage(iframe, handler)`, `isPlayerMessage(data)`.

`src/lib/video/timelineStore.ts` (as written by the timeline session; the panel uses):
`useTimelineStore(selector)` / `getTimelineState()` (`status`, `error`, `externalError`,
`saveError`, `timeline`, `compositionId`, `selection.clipIds`, `inPoint`, `outPoint`,
`canUndo`, `canRedo`), `openTimeline(ws, slug, { compositionId })`, `closeTimeline()`, the
playhead store `usePlayhead()` / `getPlayhead()` / `setPlayhead(frame, "user" | "player")` /
`subscribePlayhead((frame, source) => …)` (the panel seeks the player only for `"user"`), and
`timelineActions` (`apply`, `undo`, `redo`, `select`, `setComposition`, `placeAsset`,
`updateClip`, `updateComposition`, `setTransition`), `SHOW_CLIP_PROPERTIES_EVENT`.
- `timelineOps.ts` exports the panel uses (as written by the timeline session):
  `updateClip(tl, compId, clipId, patch)`, `updateComposition(tl, compId, patch)`,
  `setTransitionIn(tl, compId, clipId, transition | null)`, `getComposition`, `locateClip`,
  `clipFromAsset(asset, comp, from)` + `placeClip(tl, compId, clip, trackId | null)`. Adding
  imported assets to `timeline.assets` is done by the panel with a plain `apply`
  (dedupe by id).
- Drag from the media bin to the timeline: use `src/components/video/timeline/dnd.ts` —
  `setAssetDragData(dt, assetId)` (type `application/x-nyxs-video-asset`, JSON
  `{ assetId }`) and `setClipDragData(dt, clip)` for ready-made clips (type
  `application/x-nyxs-video-clip`, JSON of a `Clip`; id and `from` are replaced on drop).
- Who drives the player: the panel listens to the player's `frame` messages and calls
  `setPlayhead`; when the playhead changes from the timeline (not from the player) the panel
  sends `seek`. The timeline only talks to the store.

## Agent integration

- A bundled skill `video` (same place and format as the app's other built-in skills): how to
  create a project, the timeline.json schema, when to use a `scene` clip (custom React) vs
  built-in clips, Remotion best practices (useCurrentFrame, interpolate, spring, no CSS
  animations, `staticFile`, fonts via @remotion/google-fonts), and to validate before saving.
- Agent tools: `src/lib/videoTools.ts` defines them once, for the built-in models
  (`src/tools/Video`, as `VideoAddClip`) and for CLI and ACP agents (the `nyxs-video` MCP server
  in `src/lib/browserMcp.ts`, as `add_clip`), like the browser's. They act on the live editor;
  `src/lib/video/videoControl.ts` has the routing (live store or headless document, per chat),
  undo, the user's priority and what happens with two agents. Older transcripts' `VideoCreate`,
  `VideoOpen` and the like only live on as chips.
- Auto captions: "Generate captions" (inspector on a video/audio clip, and an agent tool
  `VideoCaptions`) extracts the audio, sends it to the existing transcription
  (`/api/transcribe`, see the voice transcription code) with word timestamps if available, and
  inserts a `captions` clip.
- Tool chips in the chat show a thumbnail for VideoStill / VideoRender results.
- **Captions data**: `CaptionsClip.captions` are WORD-level tokens in Remotion's `Caption`
  convention (`@remotion/captions`): every token after the first starts with a space, times in
  ms RELATIVE to the captions clip's start. The engine groups tokens into lines/pages itself
  (`mode` decides how they are shown). Shared helper for the panel button and the agent tool:
  `generateCaptions({ workspace, slug, compositionId, clipId, language?, mode? })` in
  `src/lib/video/captions.ts` → writes timeline.json and returns `{ clip, words, timing }`
  (`timing: "backend" | "estimated"`). `/api/transcribe` only returns text today, so word times
  are estimated over the voiced parts of each ≤25 s chunk; if the backend ever returns
  `words: [{ word, start, end }]` (seconds) they are used as-is.
- **Opening the Video view** (VideoOpen tool, and anyone else): `src/lib/video/videoOpen.ts`
  exports `OPEN_VIDEO_EVENT = "nyxs:open-video"` and `requestVideoOpen(detail)` with
  `detail: VideoOpenRequest = { chat?: string; slug: string; compositionId?: string; frame?: number }`
  (dispatched on `window`). The panel side listens: switches that chat's right panel to the
  `"video"` view, opens the project and seeks to `frame`. A view that mounts after the event
  calls `takePendingVideoOpen(chat)` to pick up the last request.
- **Footage cuts** (agent tools `VideoRemoveSilences`, `VideoCutByTranscript`; the panel's
  "Remove silences" / "Cut by transcript" can reuse them): `src/lib/video/cutRanges.ts` (pure,
  tested) — `cutRanges(tl, compId, ranges: [startFrame, endFrame][])` splits every UNLOCKED
  track at both edges (`splitAt` from timelineOps), drops what's inside and moves everything
  after left by the same amount on all those tracks and markers (per-track `rippleDelete`
  would desync tracks with nothing in the range), shrinking the composition.
  `silencesInClip(clip, compFps, assetFps, silences, paddingFrames)` maps
  `video_detect_silences` output (asset frames) to composition ranges;
  `phraseRanges(captions, phrases)` + `captionRangesToFrames(captionsClip, fps, ranges, paddingMs)`
  turn words into ranges. The tools use `detectSilences(workspace, slug, assetId, thresholdDb,
  minDurationMs)`, `createFromMedia(workspace, paths, name?)` and `adoptProject(workspace, path)`
  from videoApi.

## Rules for every session

- Read `NYXS.md` and the skills that apply: nyxs-app-structure, nyxs-corner-radius,
  nyxs-dialogs, nyxs-tooltips, nyxs-rust-backend, nyxs-chat-code-blocks.
- All code, comments and identifiers in English. UI strings through i18n in ALL locales
  (`src/locales/*.ts` + `types.ts`), each session under its own namespace:
  `videoPanel` (panel/inspector/media/render), `videoTimeline`, `videoAgent`. Add your
  namespace at the END of the objects to keep merges with other sessions easy.
- Only touch the files your session owns (listed in its brief). Shared touch points
  (ViewsPanel.tsx, lib.rs handler list, agentTools.ts, locales) — small, surgical edits.
- Other sessions are editing the same working tree at the same time: expect half-built
  files from others; never revert or reformat code you don't own.
- Verify: `npx tsc -b` (frontend), `cargo check` in src-tauri (Rust), `npx vitest run` for
  your tests. Do NOT commit; the coordinator reviews and commits.
- Finish with a report: what is done, what is missing, interface changes, how to try it.
