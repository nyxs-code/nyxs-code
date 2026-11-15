Make and edit videos with Nyxs Video: Remotion projects you drive through the video tools, which act on the live Video view (player, timeline, inspector) the user is looking at. They watch each change, every edit is one step of the undo they also have, and the editor saves. The tools are `nyxs-video` over MCP (`mcp__nyxs-video__add_clip`) or `VideoAddClip` for built-in models: this guide writes them by their short name (`add_clip`), and the rest follow the same pattern.

## The loop

1. **Plan** the video before touching anything: format, length, beats (scenes with their seconds), the message of each, the look (palette, 1–2 fonts), music. Keep it in a TodoWrite list for anything over ~3 scenes.
2. **Open**: `list_projects`, then `open_project`, or `create_project` for a new one. The Video view opens by itself. Then `snapshot`: it gives every id you need.
3. **Act** with one `apply` call for the whole layout (tracks with their clips, markers), then the single-purpose tools for details. Each says what changed, so you rarely need another snapshot. "Remove all the zooms" or "restyle the captions" is one `apply` with `where` and `set`/`unset`. `batch` runs mixed tools as one undo step.
4. **Look**: `contact_sheet` for the whole edit in one image, `screenshot` on the key frames (the middle of each scene, every transition, the first and last frame, any frame with text near an edge). You can't judge a video you haven't seen. After writing a scene, `console_logs` shows its build and runtime errors.
5. **Fix** what looks wrong (cut-off text, poor contrast, empty frames, misaligned elements) and look again.
6. **Render** with `render` only when the user asks for the file, or at the end of a "make me a video" request. It returns the output path.

Never render a full video just to check a frame: that's what `screenshot` and `contact_sheet` are for, and `proxy` checks motion.

**Don't build around the editor.** No `render.mjs` or other runtime files, no hand-written or scripted `timeline.json`, no `npm install` (Playwright, ffmpeg), no contact-sheet, recording, music or audio-analysis scripts, and no local servers to inspect media: `contact_sheet`, `record`, `music` and `audio_levels` do those. To look at audio, read `audio_levels`: `remove_silences` edits. Keep scratch files out of the project. To show the video to the user, `open_project`: there is no other editor to look for.

**Two limits to tell the user about.** `music` needs a person to listen before it counts as good: empty `warnings` only means nothing measured wrong. And `record` blocks writing requests, but it can't stop a GET that writes: don't point it at a site where visiting a link changes real data. When a `record` fails, its error may name a screenshot of the page at that moment: Read it.

## How the tools behave

- **Errors say what to do.** An unknown clip id lists the valid ones, an overlap names the clip in the way and the next free frame, a locked track says how to unlock it. Read them and adapt; nothing changed when a tool refuses. Every edit is validated against the schema below.
- **Don't edit `timeline.json` with file tools.** The editor holds the document. Use `update_clip` for anything a clip has, and `add_scene` for scene files. Scene code you change later with file tools is fine; the player rebuilds.
- **The user wins.** An edit waits for a drag they are doing. If they edited meanwhile, the tool result starts with a note: `snapshot` if it matters. If they press Stop, tools refuse until they write to you: tell them where you got to and wait. `undo` walks the same history they do, so it may take back their edit.
- **A chat that isn't on screen** works out of sight, on the same project and history; the user sees the result when they go there. `screenshot` then renders with Remotion, and `transport` and `screenshot_editor` refuse. If the user closed the panel, it stays closed until you call `open_project`.
- **Two sessions on one project** share the document and take turns, so nothing is overwritten; a note tells you when someone else changed it.
- **Plan mode** lets you read, navigate and look; edits, renders and new projects are refused.

## Editing footage the user already has

Most requests are edits of an existing file ("cut the first 5 s of demo.mov and add captions"). Then:

1. **Import**: `create_project` with `from_media: ["<path>", …]` (videos, images, audio; in order), or `open_file`. The composition takes the first video's size, fps and length, and each file becomes a clip on the video track (a video clip carries its own sound). For a Remotion project the user already has, `create_project` with `project_path` adopts it; its compositions render as they are and can be placed as `scene` clips. If the user means a project already in `videos/`, use `open_project`. To add files to an open project: `import_media`, then `add_clip` with the asset's id.
2. **Watch it** before cutting: `screenshot` at several frames spread over the whole video (start, every ~10–20 %, end), so you know what's in it: shots, talking head vs screen recording, existing text, black frames. For speech, `captions` gives you the transcript with timestamps: the fastest way to find "the part where they talk about pricing".
3. **Cut**:
   - Trim the start/end: `trim_clip` (it keeps the content in place), then `update_composition` with the new `durationInFrames`, or `set_in_out` and `trim_to_in_out`.
   - Remove a middle part: `split_clips` on each side, then `delete_clips` with `ripple: true`. For removing words or pauses, prefer the tools that do it on all tracks at once: `remove_silences` (pauses; padding 100–200 ms sounds natural, 0–60 ms is a jump-cut style) and `cut_by_transcript` (phrases, filler words, whole sentences: needs a captions clip).
   - Reorder: `move_clips`.
   - Speed: `set_speed` (0.25–4); hold a frame: `freeze_frame`.
   - Separate the sound: `detach_audio`.
   - Crop/zoom: `update_clip` with `transform.scale` > 1 and `x/y` to reframe (e.g. 16:9 → 9:16 vertical: `update_composition` to 1080×1920, video `fit: "cover"`, `keyframe` on `transform.x` to follow the subject).
4. **Add on top**: captions (`captions`, then restyle with `update_clip`), titles/lower thirds (text clips or the `LowerThird` scene), music on an audio track, a logo/end card.
5. **Music with ducking**: music volume ~0.5 where nobody speaks and ~0.12–0.2 under speech. Use the captions' timestamps to place `keyframe`s on the music clip's `volume` (frames relative to the clip, 8–12 frames to dip and to come back). Fade the music out over the last 1–2 s (`fadeOut`). Keep the original speech at 1.
6. **Check** the cuts with `screenshot` right before and after each cut, and the captions over the new timing. `transport` to play it for the user.
7. **Export** with `render` (same size and fps as the source unless asked; `h264` for sharing, `prores` if they will keep editing elsewhere).

Keep the user's media untouched: every edit is in the document, so it can always be undone.

## Project layout

```
videos/<slug>/
  timeline.json        ← THE document (schema below); the tools change it, not you
  scenes/*.tsx         ← custom React scenes (clip type "scene")
  media/**             ← imported media (assets[].src is relative to the project folder: "media/intro.mp4")
  out/                 ← renders
  tsconfig.json        ← only points editors at the runtime's types: don't edit
```

A project has NO package.json and NO node_modules. Remotion, React, the engine that draws timeline.json, the player and the renderer live in a shared **video runtime** that Nyxs installs once for every project (the first video tool call does it; progress shows on its chip). So:
- Never run `npm install`/`npx remotion …` inside a video project, and don't add a package.json to it.
- `import … from "remotion"` and `@remotion/google-fonts`, `@remotion/transitions`, `@remotion/media-utils`, `@remotion/captions` in scenes resolve from the runtime. Other npm packages aren't available: write the code yourself (or inline small helpers).
- Media: import files with `import_media` (copies into `media/`, probes duration/size/fps and adds the assets) — or create the project with `create_project` `from_media`. Remote media can be an `https://` URL in `src`.
- An adopted Remotion project (`create_project` `project_path`) is the exception: it keeps its own package.json and node_modules.

## The document's schema

```ts
interface Timeline { version: 1; compositions: Composition[]; assets: Asset[] }

interface Composition {
  id: string;               // [A-Za-z0-9-], used by the tools
  name: string; width: number; height: number; fps: number;
  durationInFrames: number; background: string;   // CSS color
  tracks: Track[];          // index 0 = bottom layer, last = top layer
  markers: { id: string; frame: number; label: string; color?: string }[];
}

interface Track {
  id: string; name: string; kind: "video" | "audio" | "text" | "overlay";
  hidden?: boolean; muted?: boolean; locked?: boolean; volume?: number;  // 0..2
  clips: Clip[];            // sorted by `from`, NEVER overlapping within a track
}

interface Asset {
  id: string; kind: "video" | "image" | "audio" | "font";
  src: string;              // relative to the project folder, e.g. "media/intro.mp4"
  name: string;             // for fonts: the CSS font-family TextStyle uses
  durationInFrames?: number; fps?: number; width?: number; height?: number;
}

// Every clip:
interface ClipBase {
  id: string; from: number; durationInFrames: number; name?: string;   // whole frames
  transform?: { x: A<number>; y: A<number>; scale: A<number>; rotation: A<number>; anchor?: "center" | "top-left" };
  opacity?: A<number>;      // 0..1
  transitionIn?: { kind: "fade" | "slide" | "wipe" | "flip" | "clock-wipe" | "iris" | "none";
                   durationInFrames: number; direction?: "from-left" | "from-right" | "from-top" | "from-bottom" };
  effects?: Effect[];
}
type Clip =
  | { type: "video"; assetId; trimStart: number; playbackRate?: number; volume?: A<number>; fit?: "cover" | "contain" | "fill" }
  | { type: "image"; assetId; fit?; kenBurns?: { fromScale; toScale; fromX; toX; fromY; toY } }
  | { type: "audio"; assetId; trimStart: number; volume?: A<number>; fadeIn?: number; fadeOut?: number }
  | { type: "text"; text: string; style: TextStyle; animation?: { in?: TextAnimation; out?: TextAnimation } }
  | { type: "shape"; shape: "rect" | "circle" | "line"; fill: string; stroke?; strokeWidth?; radius?; width: number; height: number }
  | { type: "scene"; file: string; exportName: string; props?: Record<string, unknown> }
  | { type: "captions"; captions: Caption[]; style: TextStyle; mode: "line" | "word-highlight" | "karaoke"; highlightColor? };
  // (each also has the ClipBase fields)

interface TextStyle {
  fontFamily: string; fontSize: number; fontWeight: number; color: string;
  align: "left" | "center" | "right"; lineHeight?: number; letterSpacing?: number;
  background?: string; padding?: number; radius?: number; shadow?: string; stroke?: string; maxWidth?: number;
}
type TextAnimation = { kind: "fade" | "slide-up" | "slide-down" | "slide-left" | "slide-right" | "scale" | "blur" | "typewriter" | "words"; durationInFrames: number };
interface Caption { text: string; startMs: number; endMs: number; timestampMs?: number; confidence?: number }

// A<T>: a fixed value, or keyframes with frames RELATIVE to the clip start:
type A<T> = T | { keyframes: { frame: number; value: T; easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out" | "spring" }[] };

type Effect =
  | { kind: "blur"; amount: A<number> } | { kind: "brightness" | "contrast" | "saturate"; amount: A<number> }
  | { kind: "grayscale" | "sepia" | "invert"; amount: A<number> } | { kind: "hue-rotate"; degrees: A<number> }
  | { kind: "drop-shadow"; x: number; y: number; blur: number; color: string }
  | { kind: "chroma-key"; color: string; tolerance: number } | { kind: "vignette"; amount: number };
```

The document, for `add_clip` and `update_clip`, whose fields are these. Rules the validator enforces (it tells you the path of each error):
- Frames are whole numbers. `from + durationInFrames` should stay within the composition; grow `durationInFrames` of the composition when you add scenes.
- Clips on one track never overlap. To layer, use another track (higher index = on top).
- Audio clips only on audio tracks, and audio tracks only hold audio clips.
- `assetId` must exist in `assets` with a matching kind; `trimStart + durationInFrames × playbackRate` must fit inside the asset.
- `transform.x/y` place the clip's CENTER in composition pixels (unless `anchor: "top-left"`); scale 1 = natural size. A 1920×1080 frame's center is `x: 960, y: 540`.
- `transitionIn` and text `animation` durations can't exceed the clip. A transition blends with the previous clip on the SAME track, so for a crossfade put the two clips back to back on one track.
- Ids are unique: use readable ones (`"title-1"`, `"bg-music"`).
- `scene.file` is a file name inside `scenes/` (like `"Intro.tsx"`), `exportName` its named export.

Example — a 6 s 1080p title over a video, with music fading out:

```json
{
  "version": 1,
  "assets": [
    { "id": "city", "kind": "video", "src": "media/city.mp4", "name": "city.mp4", "durationInFrames": 900, "fps": 30, "width": 1920, "height": 1080 },
    { "id": "music", "kind": "audio", "src": "media/music.mp3", "name": "music.mp3", "durationInFrames": 5400, "fps": 30 }
  ],
  "compositions": [{
    "id": "Main", "name": "Main", "width": 1920, "height": 1080, "fps": 30, "durationInFrames": 180, "background": "#0B0B0F",
    "markers": [],
    "tracks": [
      { "id": "v1", "name": "Video", "kind": "video", "clips": [
        { "id": "city-clip", "type": "video", "assetId": "city", "from": 0, "durationInFrames": 180, "trimStart": 60, "fit": "cover", "volume": 0,
          "transform": { "x": 960, "y": 540, "scale": { "keyframes": [{ "frame": 0, "value": 1 }, { "frame": 179, "value": 1.08, "easing": "ease-in-out" }] }, "rotation": 0 },
          "effects": [{ "kind": "vignette", "amount": 0.4 }] }
      ]},
      { "id": "t1", "name": "Titles", "kind": "text", "clips": [
        { "id": "title", "type": "text", "from": 15, "durationInFrames": 135, "text": "Built for speed",
          "style": { "fontFamily": "Inter", "fontSize": 120, "fontWeight": 800, "color": "#FFFFFF", "align": "center", "letterSpacing": -2, "shadow": "0 8px 40px rgba(0,0,0,0.5)" },
          "transform": { "x": 960, "y": 540, "scale": 1, "rotation": 0 },
          "animation": { "in": { "kind": "slide-up", "durationInFrames": 18 }, "out": { "kind": "fade", "durationInFrames": 12 } } }
      ]},
      { "id": "a1", "name": "Music", "kind": "audio", "clips": [
        { "id": "bg-music", "type": "audio", "assetId": "music", "from": 0, "durationInFrames": 180, "trimStart": 0, "volume": 0.6, "fadeIn": 15, "fadeOut": 30 }
      ]}
    ]
  }]
}
```

## Built-in clips vs a custom `scene`

Prefer built-in clips (video, image, text, shape, captions, audio) for anything they cover: the user can then edit them in the inspector, and you can't break the render with a typo. Text with in/out animations, Ken Burns stills, crossfades, keyframed position/scale/opacity and effects are all built in.

Ready-made scenes to reuse or copy before writing your own (look in the project's `scenes/` with ListDir; they come with new projects):
- `TitleCard.tsx` / `TitleCard` — props `title`, `subtitle`, `accent`, `background`, `color`.
- `LowerThird.tsx` / `LowerThird` — name + role strap: `name`, `role`, `accent`, `side` ("left" | "right").
- `LogoReveal.tsx` / `LogoReveal` — `text` (wordmark), `logo` (a path like "media/logo.png"), `color`, `background`.

Text and caption `fontFamily` can be any Google Fonts family name ("Inter", "Montserrat", "Playfair Display"): the engine loads it. A `font` asset's `name` works too.

Write a `scene` with `add_scene` (React in `scenes/<Name>.tsx`) when the visual can't be built from those: animated charts and counters, kinetic typography with per-letter motion, logo reveals, UI mockups, particle/geometric backgrounds, maps, code walkthroughs, anything data-driven. Put the values the user may want to change in `props` (text, colors, numbers) so they show up as a form in the inspector.

```tsx
// scenes/StatCounter.tsx
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";

const { fontFamily } = loadFont();

export const StatCounter: React.FC<{ value: number; label: string; color?: string }> = ({ value, label, color = "#7C5CFF" }) => {
  const frame = useCurrentFrame();            // frame RELATIVE to the clip start
  const { fps, width } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 200 } });
  const shown = Math.round(interpolate(frame, [0, 1.2 * fps], [0, value], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) }));
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontFamily }}>
      <div style={{ fontSize: width * 0.12, fontWeight: 800, color, transform: `scale(${0.8 + 0.2 * pop})` }}>{shown.toLocaleString()}</div>
      <div style={{ fontSize: width * 0.03, color: "#fff", opacity: interpolate(frame, [10, 25], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>{label}</div>
    </AbsoluteFill>
  );
};
```

Clip: `{ "id": "stat", "type": "scene", "file": "StatCounter.tsx", "exportName": "StatCounter", "props": { "value": 12000, "label": "teams" }, "from": 90, "durationInFrames": 90 }`.

## Remotion rules (break these and the render flickers or differs from the preview)

- All motion comes from `useCurrentFrame()`: `interpolate(frame, [in], [out], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })` and `spring({ frame, fps, config })`. Frames are relative to the clip.
- NO CSS animations/transitions, no `setTimeout`/`setInterval`/`requestAnimationFrame`, no `Date.now()`, no state that changes over time. Each frame is rendered in isolation, possibly out of order and in parallel.
- Randomness: `random("seed-" + i)` from `remotion` (deterministic), never `Math.random()`.
- Media in scenes: `staticFile("media/x.png")` (the project folder is the public dir, so the path is the asset's `src`) with `<Img>`, `<OffthreadVideo>` (or `<Video>`), `<Audio>` from `remotion` — never a plain `<img>` (it may not be loaded when the frame is captured).
- Fonts: `loadFont()` from `@remotion/google-fonts/<Family>` at module level, or a `font` asset. Only the runtime's packages are available (see Project layout): no `npm i`.
- Use `useVideoConfig()` for width/height/fps instead of hard-coding, so a scene works in 16:9 and 9:16.
- Data fetching: `delayRender()`/`continueRender()` around it, or better, put the data in `props`.
- A scene renders transparent unless it paints a background (`AbsoluteFill style={{ background }}`), so it can sit over video.

## Making it look professional

- **Format**: 16:9 1920×1080 for YouTube/web/presentations; 9:16 1080×1920 for Reels/TikTok/Shorts; 1:1 or 4:5 for feeds. 30 fps by default, 60 for UI/screen motion, 24 for a film look.
- **Safe areas**: keep text inside the central 90% (title-safe). On 9:16 keep it out of the top 12% and the bottom 20% (app UI covers them) and away from the right edge (buttons).
- **Typography**: one display font + one text font at most. Scale on 1080p: headline 96–160 px, subhead 48–64, body/labels 32–40, captions 48–64 (9:16: headline 110–150, captions 60–80). Bold weights (700–900) and tight letter-spacing (−1 to −3 px) for headlines. At most ~7 words on screen at once; one idea per scene.
- **Contrast**: text over footage needs a shadow, a stroke, a dark gradient or a solid plate behind it. Check it in a still.
- **Pacing**: a scene 2–4 s (fast social cuts 1–2 s); a text needs ~0.3 s per word + 1 s to be read. Animations in 10–20 frames at 30 fps, outs shorter than ins. Cut on the beat of the music when there is music. Hook in the first 1–2 s on social formats.
- **Motion**: ease everything (`spring` with high damping, or ease-in-out keyframes); keep a slow push-in (scale 1 → 1.05–1.1) on still shots so nothing is dead; one moving focal point at a time; consistent transition style across the video (don't mix five kinds).
- **Audio**: music at 0.3–0.6 under voice; duck it with volume keyframes around speech (−10 to −15 dB ≈ 0.3–0.2 of the level), fade in 0.5 s and out 1–2 s at the end; end on a musical phrase when possible.
- **Color**: a palette of 2–3 colors plus neutrals, used consistently; the brand color for emphasis only.
- **Ending**: hold the last frame (logo, call to action) for 1.5–3 s.

## Captions

`captions` transcribes a video/audio clip's speech and adds a captions clip over it (word-level tokens, times in ms relative to the captions clip). Use mode `"word-highlight"` or `"karaoke"` for social, `"line"` for interviews/tutorials. Restyle it with `update_clip` afterwards (`style`, `transform`, `highlightColor`). If the transcript has errors, fix the `text` of the tokens in `captions`; keep the times.

## Tools

- Read: `guide`, `snapshot`, `find`, `contact_sheet`, `screenshot`, `screenshot_editor`, `audio_levels`, `console_logs`.
- Navigate: `list_projects`, `open_project`, `create_project`, `open_file`, `set_view` (composition, panels, zooms).
- Transport: `transport` (play, pause, loop, rate, volume, mute), `seek` (frame, timecode, step), `set_in_out`, `wait_for_frame`.
- Bulk: `apply`.
- Clips: `add_clip`, `update_clip`, `move_clips`, `trim_clip`, `split_clips`, `duplicate_clips`, `delete_clips`, `select`.
- The rest of the timeline: `track`, `marker`, `keyframe`, `set_transition`, `effect`, `update_composition`, `undo`, `redo`.
- Footage: `import_media`, `record`, `music`, `add_scene`, `detach_audio`, `freeze_frame`, `set_speed`, `trim_to_in_out`, `remove_silences`, `cut_by_transcript`, `captions`.
- Export: `proxy`, `render`, `render_status`, `still`, `export_standalone`. The first call that needs it installs the shared runtime once (a few minutes).
- `batch`: several of them in one call, one undo step.
