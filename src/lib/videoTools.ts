import { invoke } from "@/lib/ipc";
import { reportToolProgress } from "@/lib/toolProgress";
import { toJpeg } from "@/lib/browserTools";
import { formatTimecode, parseTimecode } from "@/components/video/timecode";
import { fitZoom, HEADER_WIDTH } from "@/components/video/timeline/geometry";
import { cancelRender, getRenderJobs, isRenderActive, startRender, type RenderJob } from "@/components/video/render/renderJobs";
import { buildRenderOptions, CRF, FORMATS, type Quality, type RenderFormat } from "@/components/video/render/renderOptions";
import * as edits from "@/lib/video/agentEdits";
import { VideoToolError, type EditResult } from "@/lib/video/agentEdits";
import { captionsClipFor, insertCaptionsClip, type CaptionsMode } from "@/lib/video/captions";
import { captionRangesToFrames, cutRanges, FILLER_WORDS, phraseRanges, silencesInClip, type FrameRange } from "@/lib/video/cutRanges";
import * as ops from "@/lib/video/timelineOps";
import type { Asset, Clip, Composition, SceneClip, Timeline } from "@/lib/video/timelineSchema";
import { clipEnd, newId } from "@/lib/video/timelineSchema";
import {
  adoptProject,
  assetFrame,
  cancelTool,
  contactSheet,
  createFromMedia,
  createProject,
  detectSilences,
  exportStandalone,
  importMedia,
  listProjects,
  music,
  onRuntimeProgress,
  onToolProgress,
  proxy,
  record,
  type ContactSheetRequest,
  type MusicMood,
  type RecordRequest,
  runtimeInstall,
  runtimeStatus,
  still,
  waveform,
  type VideoProjectInfo,
} from "@/lib/video/videoApi";
import {
  boundsOf,
  logVideoEvent,
  noteSeen,
  openProjectFor,
  playerOf,
  readVideoLog,
  runEdit,
  shellOf,
  shellOnScreen,
  targetFor,
  workspaceFor,
  type VideoCallContext,
  type VideoTarget,
} from "@/lib/video/videoControl";
import { getTimelineState, timelineActions, getPlayhead, subscribePlayhead } from "@/lib/video/timelineStore";
import { VIDEO_SKILL } from "@/lib/video/videoSkill";
import type { TrackSize } from "@/lib/video/trackHeights";

// The agent's control of the video editor. One set of definitions serves the built-in models
// (src/tools/Video) and the agents with their own CLI, which reach them through the `nyxs-video`
// MCP server Nyxs hosts (src/lib/browserMcp.ts), as the browser's do. Routing, undo and who wins
// over whom are in src/lib/video/videoControl.ts.

export interface VideoToolResult {
  text: string;
  image?: { data: string; mediaType: string };
  /** A PNG the chat's chip shows (still, render). */
  thumbnail?: string;
}

export interface VideoToolDef {
  /** Short name: the MCP tool name, and "Video" + PascalCase for the built-in models. */
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  /** Changes nothing in the project, so it never needs the user's permission and works in plan mode. */
  readOnly: boolean;
  /** A picture for the model, left out for one that can't see images. */
  image?: boolean;
  run(input: Record<string, unknown>, ctx: VideoCallContext): Promise<VideoToolResult>;
}

export const VIDEO_MCP_SERVER = "nyxs-video";

/** What keeps an agent from rebuilding the editor out of scripts, as one did for 232 tool calls. */
export const VIDEO_RULES =
  "The loop is snapshot, act, contact_sheet or screenshot, fix. Lay out a whole edit with one apply call; change many clips with apply's where and set. " +
  "These tools replace scripts: don't run the runtime's render.mjs or look inside it, don't write timeline.json by hand or with Python, don't install anything (Playwright, ffmpeg), don't make your own contact sheets (contact_sheet), recordings (record), music (music) or audio analysis (audio_levels), don't start local servers to inspect media, and keep scratch files out of the project. " +
  "open_project and create_project show the project to the user: don't look for another video editor.";

type Json = Record<string, unknown>;
type Props = Record<string, unknown>;

const schema = (properties: Props, required?: string[]): VideoToolDef["inputSchema"] => ({ type: "object", properties, ...(required ? { required } : {}), additionalProperties: false });

const MAX_TEXT = 40_000;
const MAX_BATCH = 50;
const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters: use find, or pass composition/clip_id)` : text);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const FORMAT_PRESETS = {
  landscape: { width: 1920, height: 1080 },
  "4k": { width: 3840, height: 2160 },
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
} as const;

const RUNTIME_STAGES: Record<string, string> = {
  copying: "Preparing the video runtime",
  installing: "Installing the video runtime",
  browser: "Downloading the render browser",
};

/** Installs the shared video runtime (Remotion, React, the engine) once per app, with its
 *  progress on the calling tool's chip. Whatever bundles or renders needs it. */
async function ensureRuntime(toolCallId?: string): Promise<void> {
  const status = await runtimeStatus();
  if (status.installed) return;
  reportToolProgress(toolCallId, `${RUNTIME_STAGES.installing}…`);
  const unlisten = await onRuntimeProgress((p) => {
    const label = RUNTIME_STAGES[p.stage];
    if (!label) return;
    const pct = typeof p.progress === "number" ? ` ${Math.round(p.progress * 100)}%` : "";
    reportToolProgress(toolCallId, `${label}…${pct}`);
  });
  try {
    await runtimeInstall();
  } catch (e) {
    throw new VideoToolError(`Couldn't install the video runtime (first use only): ${errText(e)}. Check that Node.js is installed and the network is reachable, then try again.`);
  } finally {
    unlisten();
  }
}

const compOf = (t: VideoTarget): Composition => {
  const comp = ops.getComposition(t.timeline(), t.compositionId());
  if (!comp) throw new VideoToolError(`The project has no composition "${t.compositionId()}".`);
  return comp;
};

/** A frame from `frame` or `timecode`, or `fallback`. */
function frameArg(input: Json, comp: Composition, fallback?: number): number {
  if (typeof input.timecode === "string") {
    const f = parseTimecode(input.timecode, comp.fps);
    if (f === null) throw new VideoToolError(`"${input.timecode}" isn't a timecode: use HH:MM:SS:FF, MM:SS:FF, SS:FF, 12.5s or a frame number.`);
    return f;
  }
  if (input.frame !== undefined) {
    const f = Number(input.frame);
    if (!Number.isFinite(f) || f < 0) throw new VideoToolError(`frame must be 0 or more, got ${JSON.stringify(input.frame)}.`);
    return Math.round(f);
  }
  if (fallback === undefined) throw new VideoToolError("Pass frame or timecode.");
  return fallback;
}

function inComposition(frame: number, comp: Composition): number {
  if (frame >= comp.durationInFrames) throw new VideoToolError(`Frame ${frame} is past the end of "${comp.id}", which has frames 0 to ${comp.durationInFrames - 1}.`);
  return frame;
}

const atTime = (frame: number, fps: number) => `frame ${frame} (${formatTimecode(frame, fps)})`;

function clipLine(c: Clip): string {
  const what =
    c.type === "text" ? `"${c.text.replace(/\s+/g, " ").slice(0, 50)}"`
    : c.type === "captions" ? `${c.captions.length} words, ${c.mode}`
    : c.type === "scene" ? `${c.file}#${c.exportName}`
    : c.type === "shape" ? c.shape
    : `asset ${c.assetId}${"trimStart" in c && c.trimStart ? `, trim ${c.trimStart}` : ""}${c.type === "video" && c.playbackRate ? `, ${c.playbackRate}×` : ""}`;
  const extras = [c.name ? `name "${c.name}"` : "", c.transitionIn ? `transition ${c.transitionIn.kind}` : "", c.effects?.length ? `effects ${c.effects.map((e) => e.kind).join("+")}` : ""].filter(Boolean);
  return `${c.id} ${c.type} ${c.from}–${clipEnd(c)} ${what}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

function describeTrack(comp: Composition, i: number): string {
  const t = comp.tracks[i];
  const flags = [t.locked ? "locked" : "", t.hidden ? "hidden" : "", t.muted ? "muted" : "", t.volume !== undefined ? `volume ${t.volume}` : ""].filter(Boolean);
  const head = `Track ${t.id} "${t.name}" ${t.kind}, layer ${i}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
  return t.clips.length ? `${head}:\n${t.clips.map((c) => `  ${clipLine(c)}`).join("\n")}` : `${head}: empty`;
}

function renderLine(j: RenderJob): string {
  const pct = Math.round((j.progress ?? 0) * 100);
  return `${j.id} ${j.stage} ${pct}% ${j.label}${j.outputPath ? ` → ${j.outputPath}` : ""}${j.error ? ` error: ${j.error}` : ""}`;
}

function snapshotText(t: VideoTarget): string {
  const tl = t.timeline();
  const comp = compOf(t);
  const { inPoint, outPoint } = t.inOut();
  const lines: string[] = [];
  const onScreen = shellOnScreen(t);
  const live = shellOf(t);
  const where = t.kind === "headless"
    ? "not in the live editor: edits go straight to timeline.json, and the user doesn't see them until the project is opened"
    : onScreen ? "open in the Video view, on screen" : "open in the Video view, out of sight (the panel is closed or another chat is shown)";
  lines.push(`Project videos/${t.slug}: ${where}.`);
  lines.push(`Saved: ${t.saveError() ? `no, the last save failed: ${t.saveError()}` : t.unsaved() ? "edits pending" : "yes"}. Undo ${t.canUndo() ? "available" : "empty"}, redo ${t.canRedo() ? "available" : "empty"}.`);
  lines.push(`Compositions: ${tl.compositions.map((c) => `${c.id === comp.id ? "*" : ""}${c.id} ${c.width}×${c.height} ${c.fps}fps ${c.durationInFrames}f bg ${c.background}`).join("; ")}`);
  if (tl.assets.length) lines.push(`Assets: ${tl.assets.map((a) => `${a.id} ${a.kind} "${a.name}"${a.durationInFrames ? ` ${a.durationInFrames}f@${a.fps ?? comp.fps}` : ""}${a.width ? ` ${a.width}×${a.height}` : ""}`).join("; ")}`);
  lines.push(`Playhead ${atTime(t.playhead(), comp.fps)}. In ${inPoint ?? "–"}, out ${outPoint ?? "–"}. Selection: ${t.selection().join(", ") || "none"}.`);
  if (t.kind === "live") {
    const s = getTimelineState();
    lines.push(`Timeline zoom ${Math.round(s.zoom * 100) / 100} px/frame, snapping ${s.snapping ? "on" : "off"}, track size ${s.trackSize}.`);
    if (live) {
      const p = live.panels();
      lines.push(`Panels: media ${p.bin ? "shown" : "hidden"}, inspector ${p.inspector ? "shown" : "hidden"}.`);
    }
    try {
      const st = playerOf(t).state();
      const status = st.startError ? `failed to start: ${st.startError}` : st.ready ? (st.playing ? "playing" : "paused") : st.timedOut ? "didn't start" : "starting";
      lines.push(`Player: ${status}, loop ${st.loop ? "on" : "off"}, rate ${st.rate}, volume ${st.volume}${st.muted ? " muted" : ""}, zoom ${st.zoom}${st.sceneError ? `. Scene error: ${st.sceneError.message}` : ""}.`);
    } catch {
      lines.push("Player: not loaded.");
    }
  }
  lines.push("Tracks, top layer first (clips: id type start–end, the end frame is exclusive):");
  for (let i = comp.tracks.length - 1; i >= 0; i--) lines.push(describeTrack(comp, i));
  if (comp.markers.length) lines.push(`Markers: ${comp.markers.map((m) => `${m.id} @${m.frame}${m.label ? ` "${m.label}"` : ""}`).join("; ")}`);
  const renders = getRenderJobs().filter((j) => j.slug === t.slug && j.workspace === t.workspace);
  if (renders.length) lines.push(`Renders:\n${renders.slice(0, 6).map((j) => `  ${renderLine(j)}`).join("\n")}`);
  return clip(lines.join("\n"));
}

function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
    // A minimized window gets no frames.
    setTimeout(resolve, 100);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The window area as the app's own webview draws it (see preview_capture_png), as a JPEG. */
async function captureArea(b: { x: number; y: number; width: number; height: number }, max = 1280): Promise<{ data: string; width: number; height: number }> {
  const png = await invoke<string>("preview_capture_png", { ...b, tab: null });
  return toJpeg(png, max);
}

/** Where the composition sits inside the player's iframe: fitted and centered, or the whole
 *  iframe when the player is zoomed. */
function compositionArea(iframe: HTMLIFrameElement, comp: Composition, zoom: "fit" | number) {
  const b = boundsOf(iframe);
  if (!b) return null;
  if (zoom !== "fit") return b;
  const k = Math.min(b.width / comp.width, b.height / comp.height);
  const width = comp.width * k;
  const height = comp.height * k;
  return { x: b.x + (b.width - width) / 2, y: b.y + (b.height - height) / 2, width, height };
}

const PLAYER_WAIT_MS = 20_000;
const MIN_CAPTURE_WIDTH = 480;

/** The frame as the on-screen player shows it, or null when it can't be taken from there. */
async function capturePlayer(t: VideoTarget, comp: Composition, frame: number): Promise<VideoToolResult | null> {
  if (!shellOnScreen(t)) return null;
  const player = (() => {
    try {
      return playerOf(t);
    } catch {
      return null;
    }
  })();
  if (!player) return null;
  const until = Date.now() + PLAYER_WAIT_MS;
  while (!player.state().ready) {
    if (player.state().startError || player.state().timedOut || Date.now() > until) return null;
    await wait(100);
  }
  if (player.state().playing) player.actions().pause();
  t.setPlayhead(frame);
  // The player paints the frame after the seek; footage takes longer to decode than the rest.
  const footage = comp.tracks.some((tr) => !tr.hidden && tr.clips.some((c) => (c.type === "video" || c.type === "scene") && c.from <= frame && frame < clipEnd(c)));
  await frames(2);
  await wait(footage ? 900 : 300);
  const iframe = player.iframe();
  const area = iframe && compositionArea(iframe, comp, player.state().zoom);
  // In a narrow panel the picture is too small to judge text: the render has every pixel.
  if (!area || area.width < MIN_CAPTURE_WIDTH) return null;
  const shot = await player.cleanOverlay(() => captureArea(area));
  return {
    text: `Frame ${frame} of "${comp.id}" (${formatTimecode(frame, comp.fps)}), ${shot.width}x${shot.height}, as the live player draws it (captured from the app's webview, without the selection box).`,
    image: { data: shot.data, mediaType: "image/jpeg" },
  };
}

/** The frame rendered by Remotion, as an export would have it. */
async function renderFrame(t: VideoTarget, comp: Composition, frame: number, why: string, ctx: VideoCallContext): Promise<VideoToolResult> {
  await ensureRuntime(ctx.toolCallId);
  await t.flush();
  const path = await still(t.workspace, t.slug, comp.id, frame).catch((e: unknown) => {
    logVideoEvent(t.workspace, t.slug, { level: "error", source: "render", message: `Rendering frame ${frame} failed: ${errText(e)}` });
    throw new VideoToolError(`Rendering frame ${frame} of "${comp.id}" failed: ${errText(e)}`);
  });
  const img = await invoke<{ base64: string; mediaType: string }>("agent_read_image", { path, scope: null });
  return {
    text: `Frame ${frame} of "${comp.id}" (${formatTimecode(frame, comp.fps)}), rendered by Remotion from the saved timeline (exactly as an export has it)${why}: ${path}`,
    image: { data: img.base64, mediaType: img.mediaType },
    thumbnail: path,
  };
}

const absolute = (ctx: VideoCallContext, workspace: string, p: string) =>
  ctx.resolve ? ctx.resolve(p) : /^([A-Za-z]:[\\/]|[\\/])/.test(p) ? p : `${workspace.replace(/[\\/]+$/, "")}/${p}`;

function describeProject(p: VideoProjectInfo): string {
  const comps = p.compositions.map((c) => `${c.id} ${c.width}×${c.height} ${c.fps}fps ${c.durationInFrames}f`).join("; ");
  return `${p.slug} ("${p.name}", ${p.kind}${p.installed ? "" : ", not installed"}): ${comps || "no compositions"}`;
}

function afterOpen(t: VideoTarget, verb: string): string {
  const where = t.kind === "live" ? "It is open in the Video view." : "The chat isn't on screen (or the view couldn't open), so the agent edits it out of sight and it shows when the user opens it.";
  return `${verb} videos/${t.slug}. ${where}\n\n${snapshotText(t)}`;
}

const edit = (ctx: VideoCallContext, fn: Parameters<typeof runEdit>[1]) => runEdit(ctx, fn).then((text): VideoToolResult => ({ text }));

/** A path ready for the player, or a refusal the model understands: scenes live in one folder. */
function sceneFileName(file: unknown): string {
  const name = String(file ?? "").trim();
  if (!name || /[\\/]|\.\./.test(name)) throw new VideoToolError(`file must be a file name inside scenes/, like "TitleCard.tsx", got ${JSON.stringify(file)}.`);
  return /\.(tsx|ts|jsx|js)$/i.test(name) ? name : `${name}.tsx`;
}

/** Frames of the clip to freeze at, and the picture of its media at that moment. */
async function freezeFrame(input: Json, ctx: VideoCallContext): Promise<VideoToolResult> {
  const t = await targetFor(ctx);
  const comp = compOf(t);
  const loc = edits.requireClip(comp, input.clip_id);
  if (loc.clip.type !== "video") throw new VideoToolError(`Only a video clip can freeze; "${loc.clip.id}" is ${loc.clip.type}.`);
  const frame = frameArg(input, comp, t.playhead());
  if (frame < loc.clip.from || frame >= clipEnd(loc.clip)) throw new VideoToolError(`Frame ${frame} isn't inside "${loc.clip.id}" (${loc.clip.from}–${clipEnd(loc.clip)}). Seek there or pass a frame inside it.`);
  const rate = loc.clip.playbackRate ?? 1;
  const secs = (loc.clip.trimStart + (frame - loc.clip.from) * rate) / comp.fps;
  await ensureRuntime(ctx.toolCallId);
  const path = await assetFrame(t.workspace, t.slug, loc.clip.assetId, secs).catch(async () => {
    await t.flush();
    return still(t.workspace, t.slug, comp.id, frame, `${loc.clip.id}-hold-${frame}`);
  });
  const [image] = await importMedia(t.workspace, t.slug, [path]);
  if (!image) throw new VideoToolError("The frozen frame couldn't be imported.");
  const hold = input.hold_frames === undefined ? Math.round(comp.fps * 2) : Math.max(1, Math.round(Number(input.hold_frames)));
  return edit(ctx, (tl, compId) => {
    const r = ops.freezeFrame(tl, compId, loc.clip.id, frame, image, hold);
    if (!r.holdClipId) throw new VideoToolError(`"${loc.clip.id}" couldn't be frozen at frame ${frame}: its track may be locked, or the frame left the clip while this was running.`);
    return { timeline: r.timeline, clipIds: [loc.clip.id, r.holdClipId], select: [r.holdClipId], message: `Froze "${loc.clip.id}" at frame ${frame} for ${hold} frames (image clip ${r.holdClipId}); later clips moved right.` };
  });
}

async function removeSilences(input: Json, ctx: VideoCallContext): Promise<VideoToolResult> {
  const t = await targetFor(ctx);
  const comp = compOf(t);
  const media = comp.tracks.flatMap((tr) => (tr.locked ? [] : tr.clips)).filter((c) => c.type === "video" || c.type === "audio");
  const chosen = input.clip_id !== undefined ? edits.requireClip(comp, input.clip_id).clip : media.length === 1 ? media[0] : undefined;
  if (!chosen || (chosen.type !== "video" && chosen.type !== "audio")) {
    throw new VideoToolError(`Pick the video or audio clip with clip_id. Clips: ${media.map((c) => c.id).join(", ") || "none"}.`);
  }
  const threshold = typeof input.threshold_db === "number" ? input.threshold_db : -40;
  const minMs = typeof input.min_silence_ms === "number" ? input.min_silence_ms : 600;
  const paddingMs = typeof input.padding_ms === "number" ? input.padding_ms : 150;
  await ensureRuntime(ctx.toolCallId);
  const asset = t.timeline().assets.find((a) => a.id === chosen.assetId);
  const silences = await detectSilences(t.workspace, t.slug, chosen.assetId, threshold, minMs);
  return edit(ctx, (tl, compId) => {
    const c = edits.requireComp(tl, compId);
    const clipNow = edits.requireClip(c, chosen.id).clip;
    if (clipNow.type !== "video" && clipNow.type !== "audio") return { timeline: tl, message: "That clip is no longer video or audio." };
    const ranges = silencesInClip(clipNow, c.fps, asset?.fps || c.fps, silences as FrameRange[], Math.round((paddingMs * c.fps) / 1000));
    if (ranges.length === 0) return { timeline: tl, message: `No silences of ${minMs} ms or more under ${threshold} dB in "${chosen.id}".` };
    const { timeline, removedFrames } = cutRanges(tl, compId, ranges);
    return { timeline, message: `Removed ${ranges.length} silences (${(removedFrames / c.fps).toFixed(2)} s) on every unlocked track: frames ${ranges.map(([s, e]) => `${s}–${e}`).join(", ")} (before the cut).` };
  });
}

function cutByTranscript(input: Json, ctx: VideoCallContext): Promise<VideoToolResult> {
  const given = Array.isArray(input.phrases) ? input.phrases.map(String) : [];
  const phrases = [...given, ...(input.remove_fillers === true ? FILLER_WORDS : [])];
  if (phrases.length === 0) throw new VideoToolError("Give phrases to cut, or remove_fillers: true.");
  return edit(ctx, (tl, compId) => {
    const c = edits.requireComp(tl, compId);
    const all = c.tracks.flatMap((tr) => tr.clips).filter((x) => x.type === "captions");
    const caps = input.captions_clip_id !== undefined ? edits.requireClip(c, input.captions_clip_id).clip : all.length === 1 ? all[0] : undefined;
    if (!caps || caps.type !== "captions") {
      throw new VideoToolError(all.length === 0 ? "There are no captions to cut by: run captions on the clip first." : `Pick the captions clip with captions_clip_id: ${all.map((x) => x.id).join(", ")}.`);
    }
    const hits = phraseRanges(caps.captions, phrases, { firstOnly: input.first_only === true });
    if (hits.length === 0) return { timeline: tl, message: `None of these phrases are in the captions: ${phrases.slice(0, 12).join(", ")}.` };
    const padding = typeof input.padding_ms === "number" ? input.padding_ms : 40;
    const { timeline, removedFrames } = cutRanges(tl, compId, captionRangesToFrames(caps, c.fps, hits, padding));
    const counts = new Map<string, number>();
    for (const h of hits) counts.set(h.phrase, (counts.get(h.phrase) ?? 0) + 1);
    return { timeline, message: `Cut ${hits.length} matches (${[...counts].map(([p, n]) => `"${p}" ×${n}`).join(", ")}), ${(removedFrames / c.fps).toFixed(2)} s in total, on every unlocked track.` };
  });
}

async function addCaptions(input: Json, ctx: VideoCallContext): Promise<VideoToolResult> {
  const t = await targetFor(ctx);
  const comp = compOf(t);
  const source = edits.requireClip(comp, input.clip_id).clip;
  await ensureRuntime(ctx.toolCallId);
  reportToolProgress(ctx.toolCallId, "Transcribing…");
  const res = await captionsClipFor(t.timeline(), {
    workspace: t.workspace,
    slug: t.slug,
    compositionId: comp.id,
    clipId: source.id,
    language: typeof input.language === "string" && input.language ? input.language : "multi",
    mode: typeof input.mode === "string" ? (input.mode as CaptionsMode) : undefined,
    signal: ctx.signal,
  });
  return edit(ctx, (tl, compId) => {
    const text = res.clip.captions.map((c) => c.text).join("").trim();
    return {
      timeline: insertCaptionsClip(tl, compId, res.clip),
      clipIds: [res.clip.id],
      select: [res.clip.id],
      message: [
        `Added captions clip "${res.clip.id}" (${res.words} words, frames ${res.clip.from}–${clipEnd(res.clip)}).`,
        res.timing === "estimated" ? "Word times are estimated over the speech (the transcription gave none): check the sync with a screenshot." : "",
        `Transcript: ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`,
      ].filter(Boolean).join("\n"),
    };
  });
}

/** Waits for a render's end, whatever it comes to; null if it's still going at `until`. */
async function renderEnd(id: string, signal: AbortSignal | undefined, until: number): Promise<RenderJob | null> {
  while (Date.now() < until) {
    const job = getRenderJobs().find((j) => j.id === id);
    if (!job || !isRenderActive(job)) return job ?? null;
    if (signal?.aborted) {
      await cancelRender(id).catch(() => undefined);
      return getRenderJobs().find((j) => j.id === id) ?? null;
    }
    await wait(250);
  }
  return null;
}

const RENDER_WAIT_MS = 10 * 60_000;

let jobSeq = 0;

/** Runs a slow runtime job with its progress on the chip; stopping the turn cancels it. */
async function withJob<T>(ctx: VideoCallContext, run: (jobId: string) => Promise<T>): Promise<T> {
  const jobId = `agent-${Date.now().toString(36)}-${++jobSeq}`;
  const off = await onToolProgress((p) => {
    if (p.jobId === jobId) reportToolProgress(ctx.toolCallId, `${p.stage}${typeof p.progress === "number" ? ` ${Math.round(p.progress * 100)}%` : ""}`);
  }).catch(() => () => undefined);
  const cancel = () => void cancelTool(jobId).catch(() => undefined);
  ctx.signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await run(jobId);
  } finally {
    ctx.signal?.removeEventListener("abort", cancel);
    off();
  }
}

const addAsset = (tl: Timeline, asset: Asset): Timeline => (tl.assets.some((a) => a.id === asset.id) ? tl : { ...tl, assets: [...tl.assets, asset] });

/** The skill, whole or one section ("schema", "remotion", "footage"…). */
function guideText(topic: unknown): string {
  const body = VIDEO_SKILL.body;
  const sections = body.split(/^(?=## )/m);
  const heads = sections.slice(1).map((s) => s.slice(3, s.indexOf("\n")).trim());
  const wanted = typeof topic === "string" ? topic.trim().toLowerCase() : "";
  if (!wanted) return body;
  const hit = sections.filter((s) => s.startsWith("## ") && s.slice(0, s.indexOf("\n")).toLowerCase().includes(wanted));
  return hit.length ? hit.join("\n") : `No section about "${topic as string}". Sections: ${heads.join("; ")}.`;
}

async function startRenderTool(input: Json, ctx: VideoCallContext): Promise<VideoToolResult> {
  await ensureRuntime(ctx.toolCallId);
  const t = await targetFor(ctx);
  const comp = input.composition !== undefined ? edits.requireComp(t.timeline(), String(input.composition)) : compOf(t);
  const format = String(input.format ?? "h264") as RenderFormat;
  if (!FORMATS.includes(format) || format === "png") throw new VideoToolError(`format must be one of ${FORMATS.filter((f) => f !== "png").join(", ")} (use still for one PNG), got ${JSON.stringify(input.format)}.`);
  const quality = String(input.quality ?? "high") as Quality;
  if (!["high", "medium", "low"].includes(quality)) throw new VideoToolError(`quality must be high, medium or low, got ${JSON.stringify(input.quality)}.`);
  const { inPoint, outPoint } = t.inOut();
  let frameRange: [number, number] | null = null;
  if (Array.isArray(input.frame_range)) {
    const [a, b] = input.frame_range.map(Number);
    if (!(a >= 0 && b >= a && b < comp.durationInFrames)) throw new VideoToolError(`frame_range must be [first, last] inside 0–${comp.durationInFrames - 1}, got ${JSON.stringify(input.frame_range)}.`);
    frameRange = [Math.round(a), Math.round(b)];
  } else if (input.range === "inout") {
    if (inPoint === null && outPoint === null) throw new VideoToolError("There is no in/out range: set it with set_in_out, or pass frame_range.");
    frameRange = [inPoint ?? 0, (outPoint ?? comp.durationInFrames) - 1];
  } else if (input.range === "markers") {
    const marks = comp.markers.map((m) => m.frame).sort((a, b) => a - b);
    if (marks.length < 2) throw new VideoToolError("That takes two markers: the first and last mark the range.");
    frameRange = [marks[0], marks[marks.length - 1]];
  }
  const scale = input.scale === undefined ? 1 : Number(input.scale);
  if (!(scale >= 0.1 && scale <= 4)) throw new VideoToolError(`scale must be between 0.1 and 4, got ${JSON.stringify(input.scale)}.`);
  const outputName = typeof input.output_name === "string" && input.output_name.trim() ? input.output_name.trim() : comp.id;
  const opts = buildRenderOptions({
    format: format as Exclude<RenderFormat, "png">,
    quality,
    scale,
    range: frameRange,
    includeAudio: input.include_audio !== false,
    compositionId: comp.id,
    outputName,
    gifFps: typeof input.gif_fps === "number" ? input.gif_fps : undefined,
  });
  if (typeof input.crf === "number" && CRF[format]) opts.crf = input.crf;
  await t.flush();
  const id = await startRender(t.workspace, t.slug, `${comp.name || comp.id} · ${format}`, opts);
  const started = `Render ${id} started (${comp.id}, ${format}${frameRange ? `, frames ${frameRange[0]}–${frameRange[1]}` : ""}), in the editor's queue.`;
  if (input.wait === false) return { text: `${started} Follow it with render_status.` };
  const startedAt = Date.now();
  const progress = setInterval(() => {
    const j = getRenderJobs().find((x) => x.id === id);
    if (j && isRenderActive(j)) reportToolProgress(ctx.toolCallId, `${j.stage} ${Math.round(j.progress * 100)}%${j.etaSecs ? ` · ${j.etaSecs} s left` : ""}`);
  }, 500);
  try {
    const end = await renderEnd(id, ctx.signal, startedAt + RENDER_WAIT_MS);
    if (!end) return { text: `${started} Still running after ${RENDER_WAIT_MS / 60_000} minutes: follow it with render_status.` };
    if (end.stage === "cancelled") return { text: `Render ${id} was cancelled.` };
    if (end.stage === "error" || !end.outputPath) {
      logVideoEvent(t.workspace, t.slug, { level: "error", source: "render", message: end.error ?? "no output file" });
      throw new VideoToolError(`Render ${id} failed: ${end.error ?? "no output file"}`);
    }
    // The chip's thumbnail: a third of the way in (frame 0 is often black).
    const [a, b] = frameRange ?? [0, comp.durationInFrames - 1];
    const thumbnail = await still(t.workspace, t.slug, comp.id, Math.round(a + (b - a) / 3)).catch(() => undefined);
    return { text: `Rendered "${comp.id}" (${end.totalFrames || comp.durationInFrames} frames, ${format}) in ${Math.round((Date.now() - startedAt) / 1000)} s: ${end.outputPath}`, thumbnail };
  } finally {
    clearInterval(progress);
  }
}

export const VIDEO_TOOLS: VideoToolDef[] = [
  {
    name: "guide",
    description: "How to make videos here: the workflow, the document's schema (clip fields, tracks, keyframes, effects), scenes and Remotion's rules, design and pacing. Read it before your first edit, instead of looking inside the runtime. topic narrows it to a section: \"schema\", \"remotion\", \"footage\", \"professional\", \"captions\".",
    inputSchema: schema({ topic: { type: "string", description: "A section; the whole guide without it." } }),
    readOnly: true,
    run: async ({ topic }) => ({ text: guideText(topic) }),
  },
  {
    name: "apply",
    description:
      "Many edits in ONE call, all or nothing, one undo step: the way to lay out a whole edit or change many clips. composition: settings. tracks: [{id?, name, kind, clips: [clip...]}] creates tracks or adds to those with that id; a clip with no from follows the previous one. clips: [{track_id?, ...clip}]. markers: [{frame, label, color}]. changes: [{where, set, unset, shift, delete, ripple}], where selects by ids, type, track_id, text, from, to, animated (true or a path), has (a field). E.g. remove all zooms: {changes: [{where: {animated: \"transform.scale\"}, unset: [\"transform.scale\"]}, {where: {has: \"kenBurns\"}, unset: [\"kenBurns\"]}]}; restyle captions: {changes: [{where: {type: \"captions\"}, set: {style: {fontSize: 64}}}]}. Clip fields are in guide.",
    inputSchema: schema({
      composition: { type: "object", description: "name, width, height, fps, durationInFrames, background." },
      tracks: { type: "array", items: { type: "object" } },
      clips: { type: "array", items: { type: "object" } },
      markers: { type: "array", items: { type: "object" } },
      changes: { type: "array", items: { type: "object" } },
    }),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c, t) => edits.applyEdits(tl, c, input as edits.ApplyInput, t.playhead())),
  },
  {
    name: "snapshot",
    description:
      "Reads the open video project as text: compositions, assets, tracks and clips with their ids and frames, selection, playhead, in/out, markers, zoom, panels, player state, unsaved edits and save errors, renders. Start here; edits report what they changed, so you rarely need it again. clip_id returns one clip's full JSON.",
    inputSchema: schema({ clip_id: { type: "string", description: "Return this clip's full JSON." } }),
    readOnly: true,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      noteSeen(ctx, t);
      if (input.clip_id !== undefined) return { text: JSON.stringify(edits.requireClip(compOf(t), input.clip_id).clip, null, 2) };
      return { text: snapshotText(t) };
    },
  },
  {
    name: "find",
    description: "Finds clips of the composition by words (in their text, name, file or id), by type, by track, or by what plays in a frame range.",
    inputSchema: schema({
      query: { type: "string", description: "Words that must all appear. Case doesn't matter." },
      type: { type: "string", description: "video, image, audio, text, shape, scene or captions." },
      from: { type: "number", description: "With to: clips that play within these frames." },
      to: { type: "number", description: "End of the range, exclusive." },
      track_id: { type: "string" },
    }),
    readOnly: true,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      const comp = compOf(t);
      const words = String(input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const a = typeof input.from === "number" ? input.from : 0;
      const b = typeof input.to === "number" ? input.to : Infinity;
      const hits = comp.tracks.flatMap((tr) =>
        tr.clips
          .filter((c) => {
            if (input.type !== undefined && c.type !== input.type) return false;
            if (input.track_id !== undefined && tr.id !== input.track_id) return false;
            if (!(c.from < b && a < clipEnd(c))) return false;
            const text = JSON.stringify({ id: c.id, name: c.name, text: "text" in c ? c.text : undefined, file: "file" in c ? c.file : undefined, captions: "captions" in c ? c.captions.map((x) => x.text).join("") : undefined }).toLowerCase();
            return words.every((w) => text.includes(w));
          })
          .map((c) => `${clipLine(c)} · track ${tr.id}`),
      );
      return { text: clip(hits.length ? hits.join("\n") : `No clips match in "${comp.id}".`) };
    },
  },
  {
    name: "screenshot",
    description:
      "Shows you a frame of the composition as an image. With the editor on screen it comes from the live player (this seeks there and pauses it); otherwise, or with source \"render\", Remotion renders the frame from the saved timeline, as an export would (slower). Use it after each meaningful change.",
    inputSchema: schema({
      frame: { type: "number", description: "The frame; the playhead's by default." },
      timecode: { type: "string", description: "Or a timecode: HH:MM:SS:FF, 12.5s." },
      source: { type: "string", enum: ["player", "render"], description: "\"player\" (default) or \"render\"." },
    }),
    readOnly: true,
    image: true,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      const comp = compOf(t);
      const frame = inComposition(frameArg(input, comp, t.playhead()), comp);
      if (input.source === "render") return renderFrame(t, comp, frame, "", ctx);
      const shot = await capturePlayer(t, comp, frame).catch(() => null);
      return shot ?? renderFrame(t, comp, frame, ", since the player isn't on screen or is too small to judge", ctx);
    },
  },
  {
    name: "screenshot_editor",
    description: "Shows you the whole Video view as the user sees it (timeline, inspector, player), to check the interface. It needs the editor on screen; for the video's own picture use screenshot.",
    inputSchema: schema({}),
    readOnly: true,
    image: true,
    run: async (_input, ctx) => {
      const t = await targetFor(ctx);
      const shell = shellOnScreen(t);
      if (!shell) throw new VideoToolError("The Video view isn't on screen (the panel is closed, or the user is on another chat). Call open_project to show it; screenshot still works.");
      await frames(2);
      const area = boundsOf(shell.root());
      if (!area) throw new VideoToolError("The Video view takes no room on screen.");
      const shot = await captureArea(area, 1600);
      return { text: `The Video view of "${t.slug}", ${shot.width}x${shot.height}, captured from the app's webview.`, image: { data: shot.data, mediaType: "image/jpeg" } };
    },
  },
  {
    name: "contact_sheet",
    description: "Shows you many frames as ONE image with a timecode on each tile: the way to review a whole edit or a stretch of it (count frames spread over frame_range, or exact frames). Of the composition, saved first, or of a media file (asset_id). Much cheaper than many screenshots.",
    inputSchema: schema({
      count: { type: "number", description: "Default 12." },
      frames: { type: "array", items: { type: "number" }, description: "Exact frames, over count." },
      frame_range: { type: "array", items: { type: "number" }, description: "[first, last]." },
      columns: { type: "number" },
      thumb_width: { type: "number" },
      asset_id: { type: "string", description: "A media file instead of the composition." },
    }),
    readOnly: true,
    image: true,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      await ensureRuntime(ctx.toolCallId);
      await t.flush();
      const assetId = typeof input.asset_id === "string" ? input.asset_id : undefined;
      if (assetId) {
        const asset = t.timeline().assets.find((a) => a.id === assetId);
        if (!asset) throw new VideoToolError(`No asset "${assetId}". Assets: ${t.timeline().assets.map((a) => a.id).join(", ") || "none"}.`);
        if (asset.kind !== "video") throw new VideoToolError(`Asset "${assetId}" is a ${asset.kind}: a contact sheet only reads video assets.`);
      }
      const sheet = await withJob(ctx, (jobId) =>
        contactSheet(t.workspace, t.slug, { ...(assetId ? { assetId } : { compositionId: t.compositionId() }), count: input.count, frames: input.frames, frameRange: input.frame_range, columns: input.columns, thumbWidth: input.thumb_width } as ContactSheetRequest, jobId),
      );
      const img = await invoke<{ base64: string; mediaType: string }>("agent_read_image", { path: sheet.path, scope: null });
      return { text: `${sheet.frames.length} frames, ${sheet.width}x${sheet.height}, rendered from the saved timeline: ${sheet.frames.map((f) => `${f.frame} (${f.timecode})`).join(", ")}.`, image: { data: img.base64, mediaType: img.mediaType }, thumbnail: sheet.path };
    },
  },
  {
    name: "audio_levels",
    description: "Reads how loud a clip's media is over time, in dB per stretch, to find speech, pauses and silence before cutting. It changes nothing: use it instead of probing with remove_silences, and instead of decoding files yourself.",
    inputSchema: schema({ clip_id: { type: "string" }, asset_id: { type: "string" }, buckets: { type: "number", description: "How many stretches, default 60, at most 400." } }),
    readOnly: true,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      const assets = t.timeline().assets;
      const clip = input.clip_id !== undefined ? edits.requireClip(compOf(t), input.clip_id).clip : undefined;
      if (clip && clip.type !== "video" && clip.type !== "audio") throw new VideoToolError(`"${clip.id}" is ${clip.type}, which has no sound.`);
      const assetId = clip && "assetId" in clip ? clip.assetId : typeof input.asset_id === "string" ? input.asset_id : "";
      const asset = assets.find((a) => a.id === assetId);
      if (!asset) throw new VideoToolError(`Pass clip_id or asset_id. Assets: ${assets.map((a) => `${a.id} (${a.kind})`).join(", ") || "none"}.`);
      await ensureRuntime(ctx.toolCallId);
      const buckets = Math.max(4, Math.min(400, Math.round(Number(input.buckets) || 60)));
      const peaks = await waveform(t.workspace, t.slug, asset.id, buckets);
      const seconds = (asset.durationInFrames ?? 0) / (asset.fps || compOf(t).fps);
      const step = seconds ? seconds / peaks.length : 0;
      const levels = peaks.map((p) => (p > 0 ? Math.round(20 * Math.log10(p)) : -99));
      return { text: `Peak level of "${asset.name}" in dB, ${peaks.length} stretches${step ? ` of ${step.toFixed(2)} s from the start of the file` : ""} (-99 is silence): ${levels.join(" ")}` };
    },
  },
  {
    name: "proxy",
    description: "Renders a fast low-resolution preview of a range to the cache (not out/), to check motion and timing before a real render.",
    inputSchema: schema({ frame_range: { type: "array", items: { type: "number" } }, height: { type: "number", description: "Default 360." }, fps: { type: "number", description: "Default 12." }, audio: { type: "boolean" } }),
    readOnly: true,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      await ensureRuntime(ctx.toolCallId);
      await t.flush();
      const p = await withJob(ctx, (jobId) => proxy(t.workspace, t.slug, { compositionId: t.compositionId(), frameRange: input.frame_range as [number, number] | undefined, height: input.height as number | undefined, fps: input.fps as number | undefined, audio: input.audio as boolean | undefined }, jobId));
      return { text: `Preview ready in ${Math.round(p.elapsedMs / 100) / 10} s: ${p.path} (${p.width}x${p.height}, ${p.fps} fps, ${p.frames} frames).` };
    },
  },
  {
    name: "record",
    description:
      "Records a scripted browser session of a site or app (never by hand, and never install Playwright): steps [{type: goto, url} | {type: click|hover, selector|text} | {type: type, text, selector?} | {type: press, key} | {type: scroll, y|selector} | {type: wait, ms|selector|text} | {type: eval, js}]. The video lands in media/ as an asset; events says when each step happened, for placing cuts. Requests other than GET are blocked unless allow_writes names them; routes fakes responses. Add it to the timeline with add_clip or apply.",
    inputSchema: schema(
      {
        steps: { type: "array", items: { type: "object" } },
        viewport: { type: "object", description: "{width, height, scale}." },
        color_scheme: { type: "string", enum: ["light", "dark"] },
        name: { type: "string" },
        fps: { type: "number" },
        cursor: { type: "boolean" },
        allow_writes: { type: "array", items: { type: "string" }, description: "URL globs that may write." },
        routes: { type: "array", items: { type: "object" }, description: "[{url, method?, status?, json?|body?, contentType?}]." },
        init_script: { type: "string" },
        local_storage: { type: "object" },
        forbid_text: { type: "array", items: { type: "string" }, description: "Fails if this text ever shows." },
        dry_run: { type: "boolean", description: "Runs the steps without filming and returns a screenshot of how they end." },
      },
      ["steps"],
    ),
    readOnly: false,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      await ensureRuntime(ctx.toolCallId);
      const r = await withJob(ctx, (jobId) =>
        record(t.workspace, t.slug, { steps: input.steps, viewport: input.viewport, colorScheme: input.color_scheme, name: input.name, fps: input.fps, cursor: input.cursor, allowWrites: input.allow_writes, routes: input.routes, initScript: input.init_script, localStorage: input.local_storage, forbidText: input.forbid_text, dryRun: input.dry_run } as RecordRequest, jobId),
      );
      const asset = r.asset;
      if (!asset) return { text: `Dry run, nothing filmed. Screenshot of how the steps end: ${r.path}${r.blocked.length ? `\nBlocked requests: ${r.blocked.join(", ")}` : ""}${r.warnings.length ? `\nWarnings: ${r.warnings.join("; ")}` : ""}`, thumbnail: r.path };
      return edit(ctx, (tl) => ({
        timeline: addAsset(tl, asset),
        message: [
          `Recorded asset ${asset.id} "${asset.name}", ${(r.durationSecs ?? 0).toFixed(1)} s at ${r.capturedFps ?? "?"} fps (no clip yet; add it with add_clip or apply).`,
          r.events.length ? `Events: ${r.events.map((e) => `${e.t.toFixed(2)}s ${e.type}${e.label ? ` "${e.label}"` : ""}`).join("; ")}` : "",
          r.blocked.length ? `Blocked requests: ${r.blocked.join(", ")}` : "",
          r.warnings.length ? `Warnings: ${r.warnings.join("; ")}` : "",
        ].filter(Boolean).join("\n"),
      }));
    },
  },
  {
    name: "music",
    description: "Composes a music track for the video (never write your own synth) and puts it on an audio track from frame 0, with volume keyframes ducking under voice_ranges. mood, duration_seconds (the composition's by default), bpm, cuts: seconds to hit on the beat. Returns its bar lines for placing cuts.",
    inputSchema: schema(
      {
        mood: { type: "string", enum: ["confident", "uplifting", "calm", "tense", "playful", "ambient"] },
        duration_seconds: { type: "number" },
        bpm: { type: "number" },
        cuts: { type: "array", items: { type: "number" }, description: "Seconds of the cuts, for it to land on." },
        voice_ranges: { type: "array", items: { type: "array", items: { type: "number" } }, description: "[[start, end]] in seconds where someone speaks." },
        seed: { type: "number" },
        name: { type: "string" },
        add_markers: { type: "boolean", description: "Also mark its bar lines on the timeline." },
      },
      ["mood"],
    ),
    readOnly: false,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      const comp = compOf(t);
      await ensureRuntime(ctx.toolCallId);
      const durationSecs = typeof input.duration_seconds === "number" ? input.duration_seconds : comp.durationInFrames / comp.fps;
      const m = await withJob(ctx, (jobId) =>
        music(t.workspace, t.slug, { mood: input.mood as MusicMood, durationSecs, bpm: input.bpm as number | undefined, cuts: input.cuts as number[] | undefined, seed: input.seed as number | undefined, voiceRanges: input.voice_ranges as [number, number][] | undefined, name: input.name as string | undefined }, jobId),
      );
      return edit(ctx, (tl, c, target) => {
        const now = edits.requireComp(tl, c);
        const clipId = newId("music");
        const keyframes = m.ducking.map((k) => ({ frame: Math.round(k.t * now.fps), value: k.value })).filter((k, i, all) => i === 0 || k.frame > all[i - 1].frame);
        const withAsset = addAsset(tl, m.asset);
        const r = edits.applyEdits(withAsset, c, {
          clips: [{ id: clipId, type: "audio", assetId: m.asset.id, from: 0, trimStart: 0, ...(keyframes.length ? { volume: { keyframes } } : {}) }],
          markers: input.add_markers === true ? m.barTimes.map((v) => ({ frame: Math.round(v * now.fps), label: "bar" })) : [],
        }, target.playhead());
        return { ...r, select: [clipId], message: `Added music clip ${clipId} (asset ${m.asset.id}, ${m.bpm} bpm). Bar lines, the clean places to cut, in seconds: ${m.barTimes.slice(0, 80).map((v) => v.toFixed(2)).join(", ")}.${m.warnings.length ? ` Warnings: ${m.warnings.join("; ")}.` : ""}` };
      });
    },
  },
  {
    name: "console_logs",
    description: "Reads the player's and scenes' runtime errors, scene build errors and failed renders since the project opened. Check it after writing a scene or when a frame looks wrong. (A scene's console.log isn't forwarded.)",
    inputSchema: schema({ clear: { type: "boolean", description: "Empty the log after reading it." } }),
    readOnly: true,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      const entries = readVideoLog(t.workspace, t.slug, input.clear === true);
      if (!entries.length) return { text: t.kind === "live" ? "No errors logged." : "No errors logged. The project isn't in the live player, so only failed stills and renders show here: use screenshot with source \"render\" to check a scene." };
      return { text: clip(entries.map((e) => `${new Date(e.at).toISOString().slice(11, 19)} ${e.level} ${e.source}: ${e.message}`).join("\n")) };
    },
  },
  {
    name: "list_projects",
    description: "Lists the video projects of this folder (videos/), with their compositions.",
    inputSchema: schema({}),
    readOnly: true,
    run: async (_input, ctx) => {
      const list = await listProjects(workspaceFor(ctx));
      return { text: list.length ? list.map(describeProject).join("\n") : "No video projects yet: make one with create_project." };
    },
  },
  {
    name: "open_project",
    description:
      "Opens a project in this chat's Video view (the panel opens if it was closed) and makes it this chat's project for the other tools. In a chat that isn't on screen the view waits for the user, and edits go to the project out of sight. Returns its snapshot.",
    inputSchema: schema(
      {
        project: { type: "string", description: "The project's slug, from list_projects." },
        composition: { type: "string", description: "Composition id; the last one shown by default." },
        frame: { type: "number", description: "Frame to show." },
      },
      ["project"],
    ),
    readOnly: true,
    run: async (input, ctx) => {
      await ensureRuntime(ctx.toolCallId);
      const t = await openProjectFor(ctx, String(input.project ?? ""), {
        compositionId: typeof input.composition === "string" ? input.composition : undefined,
        frame: typeof input.frame === "number" ? input.frame : undefined,
      });
      noteSeen(ctx, t);
      return { text: afterOpen(t, "Opened") };
    },
  },
  {
    name: "create_project",
    description:
      "Creates a project and opens it: blank (name, format or width/height, fps, duration_seconds), from the user's files (from_media: videos, images, audio to edit; takes the first video's size, fps and length) or an existing Remotion project (project_path; its code stays untouched). The first call installs the shared runtime once (a few minutes).",
    inputSchema: schema({
      name: { type: "string", description: "The video's name; its folder slug comes from it. Required for a blank project." },
      from_media: { type: "array", items: { type: "string" }, description: "Files to edit, in order." },
      project_path: { type: "string", description: "Folder of a Remotion project to adopt." },
      format: { type: "string", enum: Object.keys(FORMAT_PRESETS), description: "Frame size (default landscape, 1920×1080)." },
      width: { type: "number" },
      height: { type: "number" },
      fps: { type: "number", description: "Default 30." },
      duration_seconds: { type: "number", description: "Default 10." },
    }),
    readOnly: false,
    run: async (input, ctx) => {
      const workspace = workspaceFor(ctx);
      await ensureRuntime(ctx.toolCallId);
      let info: VideoProjectInfo;
      if (typeof input.project_path === "string") info = await adoptProject(workspace, absolute(ctx, workspace, input.project_path));
      else if (Array.isArray(input.from_media) && input.from_media.length) {
        info = await createFromMedia(workspace, input.from_media.map((p) => absolute(ctx, workspace, String(p))), typeof input.name === "string" ? input.name : undefined);
      } else {
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name) throw new VideoToolError("A new blank project needs a name (or pass from_media or project_path).");
        const size = FORMAT_PRESETS[(input.format as keyof typeof FORMAT_PRESETS) ?? "landscape"] ?? FORMAT_PRESETS.landscape;
        const fps = typeof input.fps === "number" ? input.fps : 30;
        const seconds = typeof input.duration_seconds === "number" ? input.duration_seconds : 10;
        info = await createProject(workspace, name, { width: Number(input.width) || size.width, height: Number(input.height) || size.height, fps, durationInFrames: Math.max(1, Math.round(seconds * fps)) });
      }
      const t = await openProjectFor(ctx, info.slug);
      noteSeen(ctx, t);
      return { text: afterOpen(t, "Created") };
    },
  },
  {
    name: "open_file",
    description: "Opens a file in the video editor: a project's timeline.json opens that project; a video, image or audio file becomes a new project made from it (as \"Edit in Video\" does).",
    inputSchema: schema({ path: { type: "string", description: "The file." } }, ["path"]),
    readOnly: false,
    run: async ({ path }, ctx) => {
      const workspace = workspaceFor(ctx);
      const file = absolute(ctx, workspace, String(path ?? ""));
      await ensureRuntime(ctx.toolCallId);
      const inProject = /[\\/]videos[\\/]([^\\/]+)[\\/]timeline\.json$/i.exec(file);
      const slug = inProject ? inProject[1] : (await createFromMedia(workspace, [file])).slug;
      const t = await openProjectFor(ctx, slug);
      noteSeen(ctx, t);
      return { text: afterOpen(t, inProject ? "Opened" : `Created from ${file}:`) };
    },
  },
  {
    name: "set_view",
    description: "Changes how the editor looks: the composition shown, the media and inspector panels, timeline zoom, snapping, track size, the player's zoom, safe areas and grid. Never changes the video.",
    inputSchema: schema({
      composition: { type: "string", description: "Composition id to show." },
      media_panel: { type: "boolean" },
      inspector_panel: { type: "boolean" },
      timeline_zoom: { description: "Pixels per frame, or \"fit\"." },
      snapping: { type: "boolean" },
      track_size: { type: "string", enum: ["S", "M", "L"] },
      player_zoom: { description: "\"fit\", or 0.5, 1, 2." },
      safe_areas: { type: "boolean" },
      grid: { type: "boolean" },
    }),
    readOnly: true,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      if (typeof input.composition === "string") {
        edits.requireComp(t.timeline(), input.composition);
        t.setComposition(input.composition);
      }
      const shell = shellOf(t);
      const wantsEditor = ["media_panel", "inspector_panel", "timeline_zoom", "snapping", "track_size", "player_zoom", "safe_areas", "grid"].some((k) => input[k] !== undefined);
      if (wantsEditor && !shell) throw new VideoToolError("The project isn't in the Video view right now, so there is no view to change. Call open_project to show it.");
      if (shell) {
        const panels = shell.panels();
        if (typeof input.media_panel === "boolean" && input.media_panel !== panels.bin) shell.togglePanel("bin");
        if (typeof input.inspector_panel === "boolean" && input.inspector_panel !== panels.inspector) shell.togglePanel("inspector");
        if (input.timeline_zoom === "fit") timelineActions.setZoom(fitZoom(compOf(t).durationInFrames, shell.timelineWidth() - HEADER_WIDTH));
        else if (typeof input.timeline_zoom === "number") timelineActions.setZoom(input.timeline_zoom);
        if (typeof input.snapping === "boolean") timelineActions.setSnapping(input.snapping);
        if (typeof input.track_size === "string") timelineActions.setTrackSize(input.track_size as TrackSize);
        const player = input.player_zoom !== undefined || input.safe_areas !== undefined || input.grid !== undefined ? playerOf(t).actions() : null;
        if (player) {
          if (input.player_zoom === "fit" || typeof input.player_zoom === "number") player.setZoom(input.player_zoom);
          if (typeof input.safe_areas === "boolean") player.setSafeAreas(input.safe_areas);
          if (typeof input.grid === "boolean") player.setGrid(input.grid);
        }
      }
      return { text: `View updated. Composition "${t.compositionId()}"${shell ? `, timeline zoom ${Math.round(getTimelineState().zoom * 100) / 100} px/frame` : ""}.` };
    },
  },
  {
    name: "transport",
    description: "Controls playback in the live player: play or pause, and its loop, rate, volume and mute. It needs the project in the view (open_project).",
    inputSchema: schema({
      action: { type: "string", enum: ["play", "pause", "toggle"] },
      loop: { type: "boolean" },
      rate: { type: "number", description: "0.25, 0.5, 1, 1.5, 2 or 4; negative plays backwards." },
      volume: { type: "number", description: "0 to 1." },
      muted: { type: "boolean" },
    }),
    readOnly: true,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      const player = playerOf(t);
      const a = player.actions();
      if (typeof input.loop === "boolean") a.setLoop(input.loop);
      if (typeof input.rate === "number") {
        if (!input.rate || Math.abs(input.rate) > 4) throw new VideoToolError(`rate must be between -4 and 4 and not 0, got ${input.rate}.`);
        a.setRate(input.rate);
      }
      if (typeof input.volume === "number") {
        if (input.volume < 0 || input.volume > 1) throw new VideoToolError(`volume must be between 0 and 1, got ${input.volume}.`);
        a.setVolume(input.volume);
      }
      if (typeof input.muted === "boolean") a.setMuted(input.muted);
      if (input.action === "play") a.play();
      else if (input.action === "pause") a.pause();
      else if (input.action === "toggle") a.toggle();
      await wait(80);
      const st = player.state();
      return { text: `Player ${st.playing ? "playing" : "paused"} at ${atTime(getPlayhead(), compOf(t).fps)}; loop ${st.loop ? "on" : "off"}, rate ${st.rate}, volume ${st.volume}${st.muted ? " muted" : ""}.` };
    },
  },
  {
    name: "seek",
    description: "Moves the playhead to a frame or timecode, or by a number of frames (step, which also pauses). Out-of-range frames stop at the ends.",
    inputSchema: schema({
      frame: { type: "number" },
      timecode: { type: "string", description: "HH:MM:SS:FF, MM:SS:FF, SS:FF or 12.5s." },
      step: { type: "number", description: "Frames to move by, negative goes back." },
    }),
    readOnly: true,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      const comp = compOf(t);
      if (typeof input.step === "number") {
        if (t.kind === "live") {
          try {
            playerOf(t).actions().pause();
          } catch {
            // No player yet: moving the playhead is all there is to do.
          }
        }
        t.setPlayhead(t.playhead() + input.step);
      } else t.setPlayhead(frameArg(input, comp));
      return { text: `Playhead at ${atTime(t.playhead(), comp.fps)} of ${comp.durationInFrames} frames.` };
    },
  },
  {
    name: "set_in_out",
    description: "Sets or clears the in and out points (the range render's range \"inout\" and trim_to_in_out use). Frames, or null to clear.",
    inputSchema: schema({ in: { description: "In frame, or null." }, out: { description: "Out frame (exclusive), or null." } }),
    readOnly: true,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      const comp = compOf(t);
      const cur = t.inOut();
      const pick = (v: unknown, keep: number | null, name: string) => {
        if (v === undefined) return keep;
        if (v === null) return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > comp.durationInFrames) throw new VideoToolError(`${name} must be between 0 and ${comp.durationInFrames}, or null, got ${JSON.stringify(v)}.`);
        return Math.round(n);
      };
      const a = pick(input.in, cur.inPoint, "in");
      const b = pick(input.out, cur.outPoint, "out");
      if (a !== null && b !== null && a >= b) throw new VideoToolError(`in (${a}) must be before out (${b}).`);
      t.setInOut(a, b);
      return { text: `In ${a ?? "–"}, out ${b ?? "–"}.` };
    },
  },
  {
    name: "wait_for_frame",
    description: "While the player plays, waits until the playhead reaches a frame (or playback ends), to look at a moment in real time. It refuses when the player is paused before that frame.",
    inputSchema: schema({ frame: { type: "number" }, timeout_ms: { type: "number", description: "Default 30000, at most 120000." } }, ["frame"]),
    readOnly: true,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      const player = playerOf(t);
      const frame = Math.round(Number(input.frame));
      const fps = compOf(t).fps;
      if (getPlayhead() >= frame) return { text: `The playhead is already at ${atTime(getPlayhead(), fps)}.` };
      if (!player.state().playing) throw new VideoToolError(`The player is paused at frame ${getPlayhead()}, before frame ${frame}. Start it with transport {action: "play"}.`);
      const timeout = Math.min(120_000, Number(input.timeout_ms) || 30_000);
      const reached = await new Promise<string>((resolve) => {
        const finish = (text: string) => {
          clearTimeout(timer);
          clearInterval(poll);
          off();
          resolve(text);
        };
        const off = subscribePlayhead((f) => {
          if (f >= frame) finish(`Reached ${atTime(f, fps)}.`);
        });
        const timer = setTimeout(() => finish(`Timed out at ${atTime(getPlayhead(), fps)}, before frame ${frame}.`), timeout);
        const poll = setInterval(() => {
          if (!player.state().playing) finish(`Playback stopped at ${atTime(getPlayhead(), fps)}, before frame ${frame}.`);
        }, 200);
        ctx.signal?.addEventListener("abort", () => finish("Cancelled."), { once: true });
      });
      return { text: reached };
    },
  },
  {
    name: "add_clip",
    description:
      "Adds a clip. clip takes the fields of the video skill's schema; only type is required, and from defaults to the playhead, durationInFrames to the media's length or 3 s, style to a legible default. E.g. {type: \"text\", text: \"Hello\", from: 30}, {type: \"video\", assetId: \"a1\"}. Without track_id it goes on a track where it fits, or a new one; with it, an overlap is an error.",
    inputSchema: schema(
      {
        clip: { type: "object", description: "type: video, image, audio (assetId), text (text, style, animation), shape (shape, fill, width, height), captions; for a scene use add_scene." },
        track_id: { type: "string" },
        new_track_name: { type: "string", description: "The name, if it gets a new track." },
      },
      ["clip"],
    ),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c, t) => edits.addClip(tl, c, input, t.playhead())),
  },
  {
    name: "update_clip",
    description:
      "Changes a clip's fields: text, style, transform, opacity, animation, volume, fit, kenBurns, fadeIn, name, from, durationInFrames, captions, highlightColor… style, transform and animation merge with what's there; null removes a field. Any of them can be { keyframes: [...] } where the schema allows.",
    inputSchema: schema({ clip_id: { type: "string" }, patch: { type: "object", description: "The fields to change." } }, ["clip_id", "patch"]),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c) => edits.updateClip(tl, c, input)),
  },
  {
    name: "move_clips",
    description: "Moves clips in time (frame: where the earliest one lands; or delta) and/or to another track (track_id). Refuses an overlap instead of shifting anything.",
    inputSchema: schema({ clip_ids: { type: "array", items: { type: "string" } }, frame: { type: "number" }, delta: { type: "number" }, track_id: { type: "string" } }, ["clip_ids"]),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c) => edits.moveClips(tl, c, input)),
  },
  {
    name: "trim_clip",
    description: "Moves one edge of a clip to a composition frame. Trimming the start keeps the content in place (media trim, keyframes and captions follow). The error tells the limits.",
    inputSchema: schema({ clip_id: { type: "string" }, edge: { type: "string", enum: ["start", "end"] }, frame: { type: "number" } }, ["clip_id", "edge", "frame"]),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c) => edits.trimClip(tl, c, input)),
  },
  {
    name: "split_clips",
    description: "Cuts clips in two at a frame (the playhead by default): the given ones, or everything under it on unlocked tracks. Returns the new clips' ids.",
    inputSchema: schema({ clip_ids: { type: "array", items: { type: "string" } }, frame: { type: "number" }, timecode: { type: "string" } }),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c, t) => edits.splitClips(tl, c, input, frameArg(input, edits.requireComp(tl, c), t.playhead()))),
  },
  {
    name: "duplicate_clips",
    description: "Copies clips to the first free place after them on their track.",
    inputSchema: schema({ clip_ids: { type: "array", items: { type: "string" } } }, ["clip_ids"]),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c) => edits.duplicateClips(tl, c, input)),
  },
  {
    name: "delete_clips",
    description: "Deletes clips. ripple: true also moves what follows left to close the gaps.",
    inputSchema: schema({ clip_ids: { type: "array", items: { type: "string" } }, ripple: { type: "boolean" } }, ["clip_ids"]),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c) => edits.deleteClips(tl, c, input)),
  },
  {
    name: "track",
    description: "Tracks. action add (kind: video, audio, text, overlay; name, index), remove, rename (name), move (index; 0 is the bottom layer), set (hidden, muted, locked, volume, height in px; a view setting).",
    inputSchema: schema(
      {
        action: { type: "string", enum: ["add", "remove", "rename", "move", "set"] },
        track_id: { type: "string" },
        kind: { type: "string", enum: ["video", "audio", "text", "overlay"] },
        name: { type: "string" },
        index: { type: "number" },
        hidden: { type: "boolean" },
        muted: { type: "boolean" },
        locked: { type: "boolean" },
        volume: { type: "number", description: "0 to 2." },
        height: { type: "number", description: "Height in px in the timeline, for this editor only." },
      },
      ["action"],
    ),
    readOnly: false,
    run: (input, ctx) =>
      edit(ctx, (tl, c, t) => {
        const r = edits.editTrack(tl, c, input);
        if (typeof input.height === "number") {
          edits.requireTrack(edits.requireComp(tl, c), input.track_id);
          if (t.kind === "live") timelineActions.setTrackHeight(String(input.track_id), input.height);
        }
        return r;
      }),
  },
  {
    name: "marker",
    description: "Markers. action add (frame, the playhead by default; label, color), update (marker_id; frame, label, color), remove (marker_id).",
    inputSchema: schema(
      { action: { type: "string", enum: ["add", "update", "remove"] }, marker_id: { type: "string" }, frame: { type: "number" }, label: { type: "string" }, color: { type: "string" } },
      ["action"],
    ),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c, t) => edits.editMarker(tl, c, input, t.playhead())),
  },
  {
    name: "keyframe",
    description:
      "Keyframes of a clip, with frames RELATIVE to its start. action add (path: transform.x, transform.y, transform.scale, transform.rotation, opacity, volume, effects.0.amount; frame, the playhead by default; value, the current one by default; easing), move (frame, to_frame), remove (frame).",
    inputSchema: schema(
      {
        action: { type: "string", enum: ["add", "move", "remove"] },
        clip_id: { type: "string" },
        path: { type: "string" },
        frame: { type: "number" },
        to_frame: { type: "number" },
        value: { type: "number" },
        easing: { type: "string", enum: ["linear", "ease-in", "ease-out", "ease-in-out", "spring"] },
      },
      ["action", "clip_id"],
    ),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c, t) => edits.editKeyframe(tl, c, input, t.playhead())),
  },
  {
    name: "set_transition",
    description: "Sets the transition into a clip (fade, slide, wipe, flip, clock-wipe, iris), or removes it (none). It blends with the previous clip when that ends right where this one starts.",
    inputSchema: schema(
      {
        clip_id: { type: "string" },
        kind: { type: "string", enum: ["fade", "slide", "wipe", "flip", "clock-wipe", "iris", "none"] },
        durationInFrames: { type: "number", description: "Half a second by default." },
        direction: { type: "string", enum: ["from-left", "from-right", "from-top", "from-bottom"] },
      },
      ["clip_id", "kind"],
    ),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c) => edits.setTransition(tl, c, input)),
  },
  {
    name: "effect",
    description: "A clip's effects. action add (effect), update (index, effect), remove (index). effect: {kind: blur|brightness|contrast|saturate|grayscale|sepia|invert, amount}, {kind: hue-rotate, degrees}, {kind: drop-shadow, x, y, blur, color}, {kind: chroma-key, color, tolerance}, {kind: vignette, amount}.",
    inputSchema: schema(
      { action: { type: "string", enum: ["add", "update", "remove"] }, clip_id: { type: "string" }, index: { type: "number" }, effect: { type: "object" } },
      ["action", "clip_id"],
    ),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c) => edits.editEffect(tl, c, input)),
  },
  {
    name: "update_composition",
    description: "Changes the composition's settings: name, width, height, fps, durationInFrames, background.",
    inputSchema: schema({ name: { type: "string" }, width: { type: "number" }, height: { type: "number" }, fps: { type: "number" }, durationInFrames: { type: "number" }, background: { type: "string" } }),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c) => edits.updateComposition(tl, c, input)),
  },
  {
    name: "select",
    description: "Selects clips in the timeline, for the user to see (or none, with an empty list).",
    inputSchema: schema({ clip_ids: { type: "array", items: { type: "string" } } }, ["clip_ids"]),
    readOnly: true,
    run: async ({ clip_ids }, ctx) => {
      const t = await targetFor(ctx);
      const ids = Array.isArray(clip_ids) ? clip_ids.map(String) : [];
      const comp = compOf(t);
      for (const id of ids) edits.requireClip(comp, id);
      t.select(ids);
      return { text: ids.length ? `Selected ${ids.join(", ")}.` : "Selection cleared." };
    },
  },
  {
    name: "undo",
    description: "Undoes the latest step of the editor's history (the same one the user's Ctrl+Z walks, so it may be an edit of theirs: snapshot if unsure). A batch is one step.",
    inputSchema: schema({ steps: { type: "number", description: "How many; default 1." } }),
    readOnly: false,
    run: (input, ctx) => historyStep("undo", input, ctx),
  },
  {
    name: "redo",
    description: "Redoes what undo took back.",
    inputSchema: schema({ steps: { type: "number" } }),
    readOnly: false,
    run: (input, ctx) => historyStep("redo", input, ctx),
  },
  {
    name: "import_media",
    description: "Copies files (video, image, audio, font) into the project's media/, probes their length, size and fps, and adds them to the assets. Returns their ids for add_clip.",
    inputSchema: schema({ paths: { type: "array", items: { type: "string" }, description: "Files to import." } }, ["paths"]),
    readOnly: false,
    run: async ({ paths }, ctx) => {
      const list = Array.isArray(paths) ? paths.map(String) : [];
      if (!list.length) throw new VideoToolError("Pass the files in paths.");
      const t = await targetFor(ctx);
      await ensureRuntime(ctx.toolCallId);
      const assets = await importMedia(t.workspace, t.slug, list.map((p) => absolute(ctx, t.workspace, p)));
      return edit(ctx, (tl) => {
        const known = new Set(tl.assets.map((a) => a.id));
        const added = assets.filter((a) => !known.has(a.id));
        return {
          timeline: added.length ? { ...tl, assets: [...tl.assets, ...added] } : tl,
          message: `Imported (no clips yet; add them with add_clip):\n${assets.map((a) => `${a.id} ${a.kind} "${a.name}"${a.durationInFrames ? ` ${a.durationInFrames}f@${a.fps}` : ""}${a.width ? ` ${a.width}×${a.height}` : ""}`).join("\n")}`,
        };
      });
    },
  },
  {
    name: "add_scene",
    description:
      "Adds a custom React scene: writes scenes/<file> when code is given (see the video skill's Remotion rules) and puts a scene clip on the timeline. The player rebuilds by itself: look with screenshot, and read build errors with console_logs. Without code, it uses a file already in scenes/ (TitleCard.tsx, LowerThird.tsx, LogoReveal.tsx come with new projects).",
    inputSchema: schema(
      {
        file: { type: "string", description: "File name in scenes/, like \"StatCounter.tsx\"." },
        export_name: { type: "string", description: "The named export; the file's name by default." },
        code: { type: "string", description: "The file's whole source. It replaces what the file has." },
        props: { type: "object" },
        from: { type: "number", description: "The playhead by default." },
        durationInFrames: { type: "number", description: "3 s by default." },
        track_id: { type: "string" },
        name: { type: "string" },
      },
      ["file"],
    ),
    readOnly: false,
    run: async (input, ctx) => {
      const file = sceneFileName(input.file);
      const exportName = typeof input.export_name === "string" && input.export_name ? input.export_name : file.replace(/\.[^.]+$/, "");
      const t = await targetFor(ctx);
      if (typeof input.code === "string") {
        const project = (await listProjects(t.workspace)).find((p) => p.slug === t.slug);
        const path = `${(project?.path ?? `${t.workspace}/videos/${t.slug}`).replace(/\\/g, "/")}/scenes/${file}`;
        await ctx.trackEdit?.(path);
        await invoke<string>("agent_write_file", { path, content: input.code, scope: null, allowConfig: false, expectedMtime: null });
      }
      const raw: Partial<SceneClip> & { type: "scene" } = { type: "scene", file, exportName, props: (input.props as Record<string, unknown> | undefined) ?? {}, name: typeof input.name === "string" ? input.name : undefined };
      if (input.from !== undefined) raw.from = Number(input.from);
      if (input.durationInFrames !== undefined) raw.durationInFrames = Number(input.durationInFrames);
      return edit(ctx, (tl, c, target) => edits.addClip(tl, c, { clip: raw, track_id: input.track_id }, target.playhead()));
    },
  },
  {
    name: "detach_audio",
    description: "Moves a video clip's sound to an audio clip in sync with it, and silences the video clip.",
    inputSchema: schema({ clip_id: { type: "string" }, new_track_name: { type: "string" } }, ["clip_id"]),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c) => edits.detachAudio(tl, c, input)),
  },
  {
    name: "freeze_frame",
    description: "Holds one frame of a video clip (the playhead's by default): the clip is cut there, an image of that frame fills hold_frames (2 s by default), and later clips move right.",
    inputSchema: schema({ clip_id: { type: "string" }, frame: { type: "number" }, timecode: { type: "string" }, hold_frames: { type: "number" } }, ["clip_id"]),
    readOnly: false,
    run: freezeFrame,
  },
  {
    name: "set_speed",
    description: "Changes a video clip's speed (0.25 to 4). Its length follows, and later clips on its track move with it.",
    inputSchema: schema({ clip_id: { type: "string" }, rate: { type: "number" } }, ["clip_id", "rate"]),
    readOnly: false,
    run: (input, ctx) => edit(ctx, (tl, c) => edits.setSpeed(tl, c, input)),
  },
  {
    name: "trim_to_in_out",
    description: "Trims the given clips to the in/out range, or, with none given, the whole composition to it (everything is cut and moved to start at 0).",
    inputSchema: schema({ clip_ids: { type: "array", items: { type: "string" } } }),
    readOnly: false,
    run: (input, ctx) =>
      edit(ctx, (tl, c, t) => {
        const comp = edits.requireComp(tl, c);
        const { inPoint, outPoint } = t.inOut();
        if (inPoint === null && outPoint === null) throw new VideoToolError("There is no in/out range: set it with set_in_out first.");
        const a = inPoint ?? 0;
        const b = outPoint ?? comp.durationInFrames;
        const ids = Array.isArray(input.clip_ids) ? input.clip_ids.map(String) : [];
        for (const id of ids) edits.requireClip(comp, id);
        if (ids.length) return { timeline: ops.trimClipsToRange(tl, c, ids, a, b), clipIds: ids, message: `Trimmed ${ids.join(", ")} to frames ${a}–${b}.` };
        const result: EditResult = { timeline: ops.trimCompositionToRange(tl, c, a, b), message: `Trimmed "${c}" to frames ${a}–${b}, which now start at 0.` };
        t.setInOut(null, null);
        t.setPlayhead(t.playhead() - a);
        return result;
      }),
  },
  {
    name: "remove_silences",
    description: "Cuts the silent pauses of a video or audio clip out of EVERY unlocked track, closing the gaps, so captions and music stay in sync. Lower padding_ms for a tighter jump cut, raise threshold_db for a noisy room.",
    inputSchema: schema({
      clip_id: { type: "string", description: "Needed when there is more than one video or audio clip." },
      threshold_db: { type: "number", description: "Default -40." },
      min_silence_ms: { type: "number", description: "Shortest pause to cut, default 600." },
      padding_ms: { type: "number", description: "Silence kept each side, default 150." },
    }),
    readOnly: false,
    run: removeSilences,
  },
  {
    name: "cut_by_transcript",
    description: "Cuts where given words or phrases are said (and filler words, with remove_fillers), by a captions clip's word times (run captions first), on every unlocked track. Pass a whole sentence's words as one phrase to remove it.",
    inputSchema: schema({
      phrases: { type: "array", items: { type: "string" } },
      remove_fillers: { type: "boolean" },
      captions_clip_id: { type: "string" },
      first_only: { type: "boolean" },
      padding_ms: { type: "number", description: "Default 40." },
    }),
    readOnly: false,
    run: cutByTranscript,
  },
  {
    name: "captions",
    description: "Transcribes a video or audio clip's speech and adds a captions clip over it. mode: word-highlight (default), karaoke or line; language: a code like \"es\", detected by default. Returns the transcript. Restyle with update_clip.",
    inputSchema: schema({ clip_id: { type: "string" }, language: { type: "string" }, mode: { type: "string", enum: ["word-highlight", "karaoke", "line"] } }, ["clip_id"]),
    readOnly: false,
    run: addCaptions,
  },
  {
    name: "render",
    description:
      "Renders the composition to a file in out/, through the editor's queue, with the render dialog's options, and waits for it (wait: false returns at once; follow it with render_status). Only when the user wants the file: screenshots check frames for free.",
    inputSchema: schema({
      composition: { type: "string", description: "The one shown by default." },
      format: { type: "string", enum: ["h264", "h265", "webm", "prores", "gif"], description: "h264 (.mp4) by default." },
      quality: { type: "string", enum: ["high", "medium", "low"] },
      crf: { type: "number", description: "Exact quality for h264/h265/webm, over quality." },
      scale: { type: "number", description: "Resolution multiplier, 0.5 for a quick draft." },
      range: { type: "string", enum: ["all", "inout", "markers"] },
      frame_range: { type: "array", items: { type: "number" }, description: "[first, last] frame, inclusive." },
      include_audio: { type: "boolean" },
      gif_fps: { type: "number" },
      output_name: { type: "string", description: "File name in out/, without extension." },
      wait: { type: "boolean" },
    }),
    readOnly: false,
    run: startRenderTool,
  },
  {
    name: "render_status",
    description: "The renders of this project: stage, progress and output file. cancel: a render's id stops it.",
    inputSchema: schema({ cancel: { type: "string", description: "The id of a render to cancel." } }),
    readOnly: true,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      const mine = getRenderJobs().filter((j) => j.slug === t.slug && j.workspace === t.workspace);
      if (typeof input.cancel === "string") {
        if (!mine.some((j) => j.id === input.cancel)) throw new VideoToolError(`No render "${input.cancel}". Renders: ${mine.map((j) => j.id).join(", ") || "none"}.`);
        await cancelRender(input.cancel);
      }
      const now = getRenderJobs().filter((j) => j.slug === t.slug && j.workspace === t.workspace);
      return { text: now.length ? now.map(renderLine).join("\n") : "No renders in this run of the app." };
    },
  },
  {
    name: "still",
    description: "Saves one frame as out/<output_name>.png, and shows it to you.",
    inputSchema: schema({ frame: { type: "number" }, timecode: { type: "string" }, composition: { type: "string" }, output_name: { type: "string" } }, ["output_name"]),
    readOnly: false,
    run: async (input, ctx) => {
      const t = await targetFor(ctx);
      const comp = input.composition !== undefined ? edits.requireComp(t.timeline(), String(input.composition)) : compOf(t);
      const frame = inComposition(frameArg(input, comp, t.playhead()), comp);
      await ensureRuntime(ctx.toolCallId);
      await t.flush();
      const path = await still(t.workspace, t.slug, comp.id, frame, String(input.output_name));
      const img = await invoke<{ base64: string; mediaType: string }>("agent_read_image", { path, scope: null }).catch(() => null);
      return { text: `Saved frame ${frame} of "${comp.id}": ${path}`, thumbnail: path, ...(img ? { image: { data: img.base64, mediaType: img.mediaType } } : {}) };
    },
  },
  {
    name: "export_standalone",
    description: "Copies the project and the engine into a folder (new or empty), so it runs outside Nyxs with npm install && npx remotion studio.",
    inputSchema: schema({ dest: { type: "string", description: "The folder." } }, ["dest"]),
    readOnly: false,
    run: async ({ dest }, ctx) => {
      const t = await targetFor(ctx);
      await t.flush();
      const out = await exportStandalone(t.workspace, t.slug, absolute(ctx, t.workspace, String(dest ?? "")));
      return { text: `Exported to ${out}.` };
    },
  },
  {
    name: "batch",
    description:
      `Runs several video tools in a row in one call (at most ${MAX_BATCH}), as ONE undo step: the way to build a scene or make a series of cuts. It stops at the first that fails and says which; what ran before it stays, and one undo takes it all back. Returns what each said.`,
    inputSchema: schema(
      {
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: { tool: { type: "string", description: "A video tool: add_clip, update_clip, seek, screenshot…" }, input: { type: "object", description: "That tool's input." } },
            required: ["tool"],
            additionalProperties: false,
          },
        },
      },
      ["actions"],
    ),
    readOnly: false,
    run: ({ actions }, ctx) => runBatch(Array.isArray(actions) ? actions : [], ctx),
  },
];

async function historyStep(which: "undo" | "redo", input: Json, ctx: VideoCallContext): Promise<VideoToolResult> {
  const steps = Math.max(1, Math.min(50, Math.round(Number(input.steps) || 1)));
  let done = 0;
  const text = await runEdit(ctx, async (tl, _c, t) => {
    for (; done < steps; done++) {
      if (!(which === "undo" ? await t.undo() : await t.redo())) break;
    }
    const comp = ops.getComposition(t.timeline(), t.compositionId());
    const count = comp ? comp.tracks.reduce((n, tr) => n + tr.clips.length, 0) : 0;
    return { timeline: tl, message: done ? `${which === "undo" ? "Undid" : "Redid"} ${done} step${done === 1 ? "" : "s"}; the composition has ${count} clips now.` : `There is nothing to ${which}.` };
  });
  return { text };
}

let batchSeq = 0;

async function runBatch(actions: unknown[], ctx: VideoCallContext): Promise<VideoToolResult> {
  if (!actions.length) throw new VideoToolError("Pass the actions to run: [{tool, input}].");
  if (actions.length > MAX_BATCH) throw new VideoToolError(`A batch runs at most ${MAX_BATCH} actions.`);
  const txn = `agent-batch-${++batchSeq}-${newId("t")}`;
  const parts: string[] = [];
  let image: VideoToolResult["image"];
  let thumbnail: string | undefined;
  for (let i = 0; i < actions.length; i++) {
    const step = (actions[i] ?? {}) as { tool?: unknown; input?: unknown };
    const def = videoToolFor(String(step.tool ?? "")) ?? VIDEO_TOOLS.find((d) => d.name === step.tool);
    const left = actions.length - i - 1;
    const rest = left ? ` The other ${left} action${left === 1 ? " wasn't" : "s weren't"} run. What ran before stays; one undo takes it all back.` : "";
    if (!def || def.name === "batch") throw new VideoToolError([...parts, `${i + 1}. ${String(step.tool)}: there is no such video tool.${rest}`].join("\n\n"));
    try {
      const out = await def.run((step.input ?? {}) as Json, { ...ctx, txn });
      parts.push(`${i + 1}. ${def.name}: ${out.text}`);
      if (out.image) image = out.image;
      if (out.thumbnail) thumbnail = out.thumbnail;
    } catch (e) {
      throw new VideoToolError([...parts, `${i + 1}. ${def.name} failed: ${errText(e)}${rest}`].join("\n\n"), { cause: e });
    }
  }
  return { text: clip(parts.join("\n\n")), image, thumbnail };
}

/** Name of a video tool for the built-in models: "add_clip" → "VideoAddClip". */
export function builtinVideoToolName(name: string): string {
  return "Video" + name.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

const BY_NAME = new Map<string, VideoToolDef>();
for (const def of VIDEO_TOOLS) {
  BY_NAME.set(builtinVideoToolName(def.name), def);
  BY_NAME.set(`mcp__${VIDEO_MCP_SERVER}__${def.name}`, def);
}

/** The video tool behind a tool name, as either kind of agent calls it. */
export function videoToolFor(toolName: string): VideoToolDef | undefined {
  return BY_NAME.get(toolName);
}

/** A call that only reads: a tool marked so, or a batch of only such tools. */
export function videoCallReadOnly(def: VideoToolDef, input: unknown): boolean {
  if (def.name !== "batch") return def.readOnly;
  const actions = (input as { actions?: unknown } | null)?.actions;
  return Array.isArray(actions) && actions.length > 0 && actions.every((a) => {
    const name = String((a as { tool?: unknown } | null)?.tool ?? "");
    const step = videoToolFor(name) ?? VIDEO_TOOLS.find((d) => d.name === name);
    return !!step && step.name !== "batch" && step.readOnly;
  });
}

/** The built-in names plan mode blocks: everything that changes the project. */
export function videoEditToolNames(): string[] {
  return VIDEO_TOOLS.filter((d) => !d.readOnly).map((d) => builtinVideoToolName(d.name));
}

/** What the chat shows for a video tool call: "add_clip · text". */
export function describeVideoCall(def: VideoToolDef, input: Record<string, unknown>): string {
  const count = (v: unknown, many: string) => (Array.isArray(v) ? (v.length === 1 ? String(v[0]) : `${v.length} ${many}`) : undefined);
  const inner = input.clip as { type?: unknown; text?: unknown } | undefined;
  const what =
    input.project ?? input.name ?? input.clip_id ?? count(input.clip_ids, "clips") ?? (inner?.text ?? inner?.type) ?? input.file ?? input.track_id ?? input.query ?? input.path ??
    input.timecode ?? input.frame ?? input.action ?? (Array.isArray(input.actions) ? `${input.actions.length} actions` : undefined) ?? count(input.paths, "files") ?? input.format ?? "";
  const detail = String(what).replace(/\s+/g, " ").slice(0, 80);
  return detail ? `${def.name} · ${detail}` : def.name;
}

/** Added to the system prompt of an agent with its own CLI, as the sessions' note is. */
export const CLI_VIDEO_PROMPT = `# Videos
You run inside Nyxs, which has its own video editor in its Video view, and you drive it with the mcp__${VIDEO_MCP_SERVER}__ tools. When the user asks to make, edit, cut, caption or render a video, or to open one in the editor, use them: they act on the live editor, where the user watches each change and can undo it. Start with mcp__${VIDEO_MCP_SERVER}__guide. ${VIDEO_RULES}`;
