/**
 * The edits the agent's video tools make, as pure functions over the document: each checks what
 * `timelineOps` would silently refuse (an unknown id, a locked track, an overlap) and says so in
 * words the model can act on, then runs the op and tells what changed.
 */
import type { Clip, Composition, Effect, Keyframe, Marker, Timeline, Track, TrackKind, Transition } from "./timelineSchema";
import { clipEnd, EFFECT_KINDS, newId, TRACK_KINDS, TRANSITION_KINDS, validateTimeline } from "./timelineSchema";
import * as ops from "./timelineOps";

/** A refusal the model can read and act on; nothing was changed. */
export class VideoToolError extends Error {}

export interface EditResult {
  timeline: Timeline;
  message: string;
  /** The clips this edit touched, which the timeline highlights. */
  clipIds?: string[];
  /** Becomes the selection, like the same action done by hand. */
  select?: string[];
}

type Json = Record<string, unknown>;

const MAX_LISTED = 40;

function list(items: string[], none = "none"): string {
  if (items.length === 0) return none;
  const shown = items.slice(0, MAX_LISTED).join(", ");
  return items.length > MAX_LISTED ? `${shown}… (${items.length - MAX_LISTED} more: use find)` : shown;
}

const range = (c: { from: number; durationInFrames: number }) => `${c.from}–${clipEnd(c)}`;

export function requireComp(tl: Timeline, compId: string): Composition {
  const comp = ops.getComposition(tl, compId);
  if (!comp) throw new VideoToolError(`No composition "${compId}". Compositions: ${list(tl.compositions.map((c) => c.id))}.`);
  return comp;
}

export function requireClip(comp: Composition, clipId: unknown): ops.ClipLocation {
  const id = String(clipId ?? "");
  const loc = ops.locateClip(comp, id);
  if (loc) return loc;
  const ids = comp.tracks.flatMap((t) => t.clips.map((c) => `${c.id} (${c.type}, ${range(c)})`));
  throw new VideoToolError(`No clip "${id}" in composition "${comp.id}". Valid clips: ${list(ids)}.`);
}

export function requireTrack(comp: Composition, trackId: unknown): Track {
  const id = String(trackId ?? "");
  const track = comp.tracks.find((t) => t.id === id);
  if (track) return track;
  throw new VideoToolError(`No track "${id}" in composition "${comp.id}". Valid tracks: ${list(comp.tracks.map((t) => `${t.id} (${t.kind}, "${t.name}")`))}.`);
}

function requireMarker(comp: Composition, markerId: unknown): Marker {
  const id = String(markerId ?? "");
  const marker = comp.markers.find((m) => m.id === id);
  if (marker) return marker;
  throw new VideoToolError(`No marker "${id}". Valid markers: ${list(comp.markers.map((m) => `${m.id} (frame ${m.frame})`))}.`);
}

function requireUnlocked(track: Track): void {
  if (track.locked) throw new VideoToolError(`Track "${track.name}" (${track.id}) is locked. Unlock it first with track {action: "set", track_id: "${track.id}", locked: false}, if the user wants it edited.`);
}

function requireWhole(value: unknown, name: string, min = 0): number {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n)) throw new VideoToolError(`${name} must be a number of frames, got ${JSON.stringify(value)}.`);
  const whole = Math.round(n);
  if (whole < min) throw new VideoToolError(`${name} must be at least ${min}, got ${whole}.`);
  return whole;
}

function clipIdsOf(input: unknown): string[] {
  const ids = Array.isArray(input) ? input.map(String) : typeof input === "string" && input ? [input] : [];
  if (ids.length === 0) throw new VideoToolError("Pass the clips in clip_ids.");
  return ids;
}

/** The clip already on `track` that `from..from+duration` would land on, leaving out `ignore`. */
function collision(track: Track, from: number, duration: number, ignore: ReadonlySet<string> = new Set()): Clip | undefined {
  return track.clips.find((c) => !ignore.has(c.id) && from < clipEnd(c) && c.from < from + duration);
}

function overlapError(what: string, track: Track, from: number, duration: number, other: Clip, ignore?: ReadonlySet<string>): VideoToolError {
  const free = ops.findFreeSlot(track, from, duration, ignore);
  return new VideoToolError(
    `${what} at frames ${from}–${from + duration} would overlap "${other.id}" (${other.type}, ${range(other)}) on track "${track.name}" (${track.id}). ` +
      `The next free frame there is ${free}; or use another track, or trim "${other.id}" first.`,
  );
}

function grew(before: Composition, after: Timeline): string {
  const now = ops.getComposition(after, before.id);
  return now && now.durationInFrames !== before.durationInFrames ? ` The composition is now ${now.durationInFrames} frames.` : "";
}

/** A legible default for a new text clip, so `{type: "text", text}` is all it takes. */
function defaultTextStyle(comp: Pick<Composition, "width" | "height">): Json {
  return { fontFamily: "Inter", fontSize: Math.round(Math.min(comp.width, comp.height) * 0.09), fontWeight: 700, color: "#FFFFFF", align: "center" };
}

const CLIP_DEFAULTS: Record<string, (comp: Composition) => Json> = {
  text: (comp) => ({ text: "", style: defaultTextStyle(comp) }),
  captions: (comp) => ({ captions: [], mode: "line", style: defaultTextStyle(comp) }),
  shape: (comp) => ({ shape: "rect", fill: "#FFFFFF", width: Math.round(comp.width / 4), height: Math.round(comp.height / 4) }),
  video: () => ({ trimStart: 0 }),
  audio: () => ({ trimStart: 0 }),
};

/** A clip from what the model gave, filled in like the panel's presets. */
export function clipFromInput(tl: Timeline, comp: Composition, raw: Json, playhead: number): Clip {
  const type = String(raw.type ?? "");
  if (!["video", "image", "audio", "text", "shape", "scene", "captions"].includes(type)) {
    throw new VideoToolError(`clip.type must be one of video, image, audio, text, shape, scene, captions, got ${JSON.stringify(raw.type)}.`);
  }
  const id = typeof raw.id === "string" && raw.id ? raw.id : newId("clip");
  if (comp.tracks.some((t) => t.clips.some((c) => c.id === id))) throw new VideoToolError(`There is already a clip "${id}": leave id out, or use another one.`);
  const from = raw.from === undefined ? playhead : requireWhole(raw.from, "clip.from");
  if (type === "video" || type === "image" || type === "audio") {
    const assetId = String(raw.assetId ?? "");
    const asset = tl.assets.find((a) => a.id === assetId);
    if (!asset) {
      throw new VideoToolError(
        `clip.assetId "${assetId}" isn't in the project. Assets: ${list(tl.assets.map((a) => `${a.id} (${a.kind}, ${a.name})`))}. Import a file with import_media.`,
      );
    }
    const fromAsset = ops.clipFromAsset(asset, comp, from) as (Clip & { trimStart?: number }) | null;
    if (!fromAsset && asset.kind !== type && !(type === "audio" && asset.kind === "video")) {
      throw new VideoToolError(`Asset "${assetId}" is a ${asset.kind}, which a ${type} clip can't play.`);
    }
    const base: Json = fromAsset && fromAsset.type === type ? { ...fromAsset } : { ...CLIP_DEFAULTS[type]?.(comp), from, durationInFrames: Math.max(1, ops.assetFramesInComp(asset, comp.fps) | 0) || comp.fps * 3 };
    return { ...base, ...raw, type, id, from, assetId, durationInFrames: Math.max(1, Math.round(Number(raw.durationInFrames ?? base.durationInFrames))) } as unknown as Clip;
  }
  const defaults = CLIP_DEFAULTS[type]?.(comp) ?? {};
  const style = raw.style && typeof raw.style === "object" ? { ...(defaults.style as Json | undefined), ...(raw.style as Json) } : defaults.style;
  const durationInFrames = raw.durationInFrames === undefined ? Math.max(1, Math.round(comp.fps * 3)) : requireWhole(raw.durationInFrames, "clip.durationInFrames", 1);
  return { ...defaults, ...raw, ...(style ? { style } : {}), type, id, from, durationInFrames } as unknown as Clip;
}

export function addClip(tl: Timeline, compId: string, input: { clip?: unknown; track_id?: unknown; new_track_name?: unknown }, playhead: number): EditResult {
  const comp = requireComp(tl, compId);
  if (!input.clip || typeof input.clip !== "object") throw new VideoToolError("Pass the clip: {type, from, durationInFrames, ...}, as in the video skill's schema.");
  const clip = clipFromInput(tl, comp, input.clip as Json, playhead);
  const trackId = input.track_id === undefined ? null : String(input.track_id);
  if (trackId) {
    const track = requireTrack(comp, trackId);
    requireUnlocked(track);
    if (!ops.trackAccepts(track.kind, clip.type)) {
      const fitting = comp.tracks.filter((t) => ops.trackAccepts(t.kind, clip.type)).map((t) => `${t.id} ("${t.name}")`);
      throw new VideoToolError(`A ${clip.type} clip can't go on ${track.kind} track "${track.name}". Tracks that take it: ${list(fitting)}; or leave track_id out to get a new one.`);
    }
    const other = collision(track, clip.from, clip.durationInFrames);
    if (other) throw overlapError(`Clip "${clip.id}"`, track, clip.from, clip.durationInFrames, other);
  }
  const placed = ops.placeClip(tl, compId, clip, trackId, typeof input.new_track_name === "string" ? input.new_track_name : undefined);
  if (!placed.clipId) throw new VideoToolError(`Clip "${clip.id}" couldn't be placed: there is no track for it.`);
  const after = ops.getComposition(placed.timeline, compId);
  const track = after?.tracks.find((t) => t.id === placed.trackId);
  const newTrack = comp.tracks.every((t) => t.id !== placed.trackId);
  return {
    timeline: placed.timeline,
    clipIds: [clip.id],
    select: [clip.id],
    message: `Added ${clip.type} clip "${clip.id}" at frames ${clip.from}–${clip.from + clip.durationInFrames} on ${newTrack ? "new " : ""}track "${track?.name}" (${placed.trackId}).${grew(comp, placed.timeline)}`,
  };
}

/** `patch` over `base`: objects merge a level down, and null removes a value. */
function mergeClip(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (["style", "transform", "animation", "transitionIn", "kenBurns"].includes(key) && value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object") {
      const merged: Json = { ...(out[key] as Json), ...(value as Json) };
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
      out[key] = merged;
    } else out[key] = value;
  }
  return out;
}

export function updateClip(tl: Timeline, compId: string, input: { clip_id?: unknown; patch?: unknown }): EditResult {
  const comp = requireComp(tl, compId);
  const loc = requireClip(comp, input.clip_id);
  requireUnlocked(loc.track);
  if (!input.patch || typeof input.patch !== "object" || Array.isArray(input.patch)) throw new VideoToolError("Pass the fields to change in patch, e.g. {text: \"New title\", style: {color: \"#FF0\"}}.");
  const patch = input.patch as Json;
  for (const key of ["id", "type"]) if (key in patch) throw new VideoToolError(`A clip's ${key} can't change: add a new clip and delete this one.`);
  const next = mergeClip(loc.clip as unknown as Json, patch) as unknown as Clip;
  const from = requireWhole(next.from, "from");
  const duration = requireWhole(next.durationInFrames, "durationInFrames", 1);
  const other = collision(loc.track, from, duration, new Set([loc.clip.id]));
  if (other) throw overlapError(`Clip "${loc.clip.id}"`, loc.track, from, duration, other, new Set([loc.clip.id]));
  // A field set to null goes: `updateClip` drops what comes as undefined.
  const removed = Object.keys(patch).filter((k) => patch[k] === null);
  const timeline = ops.updateClip(tl, compId, loc.clip.id, { ...next, ...Object.fromEntries(removed.map((k) => [k, undefined])), from, durationInFrames: duration } as Partial<Clip>);
  return {
    timeline,
    clipIds: [loc.clip.id],
    message: timeline === tl ? `Nothing changed on "${loc.clip.id}".` : `Updated ${Object.keys(patch).join(", ")} of "${loc.clip.id}" (now ${loc.clip.type}, ${from}–${from + duration}).${grew(comp, timeline)}`,
  };
}

export function moveClips(tl: Timeline, compId: string, input: { clip_ids?: unknown; frame?: unknown; delta?: unknown; track_id?: unknown }): EditResult {
  const comp = requireComp(tl, compId);
  const ids = clipIdsOf(input.clip_ids);
  const locs = ids.map((id) => requireClip(comp, id));
  for (const l of locs) requireUnlocked(l.track);
  const first = Math.min(...locs.map((l) => l.clip.from));
  const delta = input.frame !== undefined ? requireWhole(input.frame, "frame") - first : input.delta !== undefined ? Math.round(Number(input.delta)) : 0;
  if (!Number.isFinite(delta)) throw new VideoToolError("delta must be a number of frames.");
  if (first + delta < 0) throw new VideoToolError(`That would start the clips at frame ${first + delta}, before the composition. The earliest is at ${first}, so delta can't go under ${-first}.`);
  const moving = new Set(ids);
  let trackDelta = 0;
  let target: Track | null = null;
  if (input.track_id !== undefined) {
    target = requireTrack(comp, input.track_id);
    requireUnlocked(target);
    const sources = new Set(locs.map((l) => l.trackIndex));
    if (sources.size > 1) throw new VideoToolError("Those clips are on different tracks: move them to a new track one track at a time.");
    trackDelta = comp.tracks.indexOf(target) - locs[0].trackIndex;
    for (const l of locs) {
      if (!ops.trackAccepts(target.kind, l.clip.type)) throw new VideoToolError(`A ${l.clip.type} clip can't go on ${target.kind} track "${target.name}".`);
    }
  }
  for (const l of locs) {
    const track = target ?? l.track;
    const from = l.clip.from + delta;
    const other = collision(track, from, l.clip.durationInFrames, moving);
    if (other) throw overlapError(`Clip "${l.clip.id}"`, track, from, l.clip.durationInFrames, other, moving);
  }
  if (delta === 0 && trackDelta === 0) return { timeline: tl, clipIds: ids, message: "Nothing to move: pass frame, delta or track_id." };
  const timeline = ops.moveClips(tl, compId, ids, delta, trackDelta);
  const where = locs.map((l) => `"${l.clip.id}" → ${l.clip.from + delta}–${clipEnd(l.clip) + delta}`).join(", ");
  return { timeline, clipIds: ids, message: `Moved ${where}${target ? ` on track "${target.name}"` : ""}.${grew(comp, timeline)}` };
}

export function trimClip(tl: Timeline, compId: string, input: { clip_id?: unknown; edge?: unknown; frame?: unknown }): EditResult {
  const comp = requireComp(tl, compId);
  const loc = requireClip(comp, input.clip_id);
  requireUnlocked(loc.track);
  const edge = input.edge;
  if (edge !== "start" && edge !== "end") throw new VideoToolError(`edge must be "start" or "end", got ${JSON.stringify(edge)}.`);
  const frame = requireWhole(input.frame, "frame");
  const { min, max } = ops.trimBounds(tl, comp, loc, edge);
  if (frame < min || frame > max) {
    throw new VideoToolError(`The ${edge} of "${loc.clip.id}" (${range(loc.clip)}) can only go between frames ${min} and ${max}: its neighbours, its media and a length of at least 1 frame set the limit.`);
  }
  const timeline = ops.trimClip(tl, compId, loc.clip.id, edge, frame);
  const after = ops.getComposition(timeline, compId) ? ops.locateClip(ops.getComposition(timeline, compId)!, loc.clip.id)?.clip : undefined;
  return { timeline, clipIds: [loc.clip.id], message: timeline === tl ? `The ${edge} of "${loc.clip.id}" is already at ${frame}.` : `Trimmed "${loc.clip.id}" to ${after ? range(after) : "?"}.` };
}

export function splitClips(tl: Timeline, compId: string, input: { clip_ids?: unknown }, frame: number): EditResult {
  const comp = requireComp(tl, compId);
  const ids = input.clip_ids === undefined ? [] : clipIdsOf(input.clip_ids);
  for (const id of ids) {
    const loc = requireClip(comp, id);
    requireUnlocked(loc.track);
    if (frame <= loc.clip.from || frame >= clipEnd(loc.clip)) throw new VideoToolError(`Frame ${frame} isn't inside "${id}" (${range(loc.clip)}), so it can't be split there.`);
  }
  const r = ops.splitAt(tl, compId, frame, ids.length ? ids : undefined);
  if (r.newIds.length === 0) {
    const under = comp.tracks.flatMap((t) => t.clips.filter((c) => c.from < frame && frame < clipEnd(c)).map((c) => `${c.id}${t.locked ? " (locked)" : ""}`));
    throw new VideoToolError(under.length ? `Nothing could be split at frame ${frame}: the clips there are all locked (${list(under)}).` : `No clip is under frame ${frame}, so nothing was split.`);
  }
  return { timeline: r.timeline, clipIds: [...ids, ...r.newIds], message: `Split at frame ${frame}. New right-hand clips: ${r.newIds.join(", ")}.` };
}

export function duplicateClips(tl: Timeline, compId: string, input: { clip_ids?: unknown }): EditResult {
  const comp = requireComp(tl, compId);
  const ids = clipIdsOf(input.clip_ids);
  for (const id of ids) requireUnlocked(requireClip(comp, id).track);
  const r = ops.duplicateClips(tl, compId, ids);
  const after = ops.getComposition(r.timeline, compId)!;
  const where = r.ids.map((id) => `${id} at ${range(ops.locateClip(after, id)!.clip)}`).join(", ");
  return { timeline: r.timeline, clipIds: r.ids, select: r.ids, message: `Duplicated: ${where}.${grew(comp, r.timeline)}` };
}

export function deleteClips(tl: Timeline, compId: string, input: { clip_ids?: unknown; ripple?: unknown }): EditResult {
  const comp = requireComp(tl, compId);
  const ids = clipIdsOf(input.clip_ids);
  for (const id of ids) requireUnlocked(requireClip(comp, id).track);
  const ripple = input.ripple === true;
  const timeline = ripple ? ops.rippleDelete(tl, compId, ids) : ops.removeClips(tl, compId, ids);
  return { timeline, message: `Deleted ${ids.join(", ")}${ripple ? " and closed the gaps (ripple)" : ""}.` };
}

export function editTrack(tl: Timeline, compId: string, input: Json): EditResult {
  const comp = requireComp(tl, compId);
  const action = String(input.action ?? "");
  if (action === "add") {
    const kind = String(input.kind ?? "") as TrackKind;
    if (!TRACK_KINDS.includes(kind)) throw new VideoToolError(`kind must be one of ${TRACK_KINDS.join(", ")}, got ${JSON.stringify(input.kind)}.`);
    const r = ops.addTrack(tl, compId, kind, { name: typeof input.name === "string" ? input.name : undefined, index: typeof input.index === "number" ? input.index : undefined });
    return { timeline: r.timeline, message: `Added ${kind} track ${r.trackId}.` };
  }
  const track = requireTrack(comp, input.track_id);
  switch (action) {
    case "remove":
      requireUnlocked(track);
      return { timeline: ops.removeTrack(tl, compId, track.id), message: `Removed track "${track.name}" and its ${track.clips.length} clips.` };
    case "rename":
      if (typeof input.name !== "string" || !input.name.trim()) throw new VideoToolError("Pass the track's new name.");
      return { timeline: ops.renameTrack(tl, compId, track.id, input.name), message: `Renamed track ${track.id} to "${input.name}".` };
    case "move": {
      const index = requireWhole(input.index, "index");
      if (index >= comp.tracks.length) throw new VideoToolError(`index must be under ${comp.tracks.length} (0 is the bottom layer).`);
      return { timeline: ops.moveTrack(tl, compId, track.id, index), message: `Moved track "${track.name}" to layer ${index} (0 is the bottom).` };
    }
    case "set": {
      const patch: ops.TrackFlags = {};
      for (const key of ["hidden", "muted", "locked"] as const) if (typeof input[key] === "boolean") patch[key] = input[key];
      if (typeof input.volume === "number") {
        if (input.volume < 0 || input.volume > 2) throw new VideoToolError(`volume must be between 0 and 2, got ${input.volume}.`);
        patch.volume = input.volume;
      }
      if (Object.keys(patch).length === 0) return { timeline: tl, message: "Nothing to set: pass hidden, muted, locked or volume." };
      return { timeline: ops.setTrackProps(tl, compId, track.id, patch), message: `Track "${track.name}": ${Object.entries(patch).map(([k, v]) => `${k} ${String(v)}`).join(", ")}.` };
    }
    default:
      throw new VideoToolError(`action must be add, remove, rename, move or set, got ${JSON.stringify(input.action)}.`);
  }
}

export function editMarker(tl: Timeline, compId: string, input: Json, playhead: number): EditResult {
  const comp = requireComp(tl, compId);
  const action = String(input.action ?? "add");
  const frame = input.frame === undefined ? undefined : requireWhole(input.frame, "frame");
  const color = typeof input.color === "string" ? input.color : undefined;
  const label = typeof input.label === "string" ? input.label : undefined;
  if (action === "add") {
    const r = ops.addMarker(tl, compId, frame ?? playhead, label, color);
    return { timeline: r.timeline, message: `Added marker ${r.markerId} at frame ${frame ?? playhead}.` };
  }
  const marker = requireMarker(comp, input.marker_id);
  if (action === "remove") return { timeline: ops.removeMarker(tl, compId, marker.id), message: `Removed marker ${marker.id}.` };
  if (action === "update") {
    const patch = { ...(frame !== undefined ? { frame } : {}), ...(label !== undefined ? { label } : {}), ...(color !== undefined ? { color } : {}) };
    return { timeline: ops.updateMarker(tl, compId, marker.id, patch), message: `Updated marker ${marker.id}.` };
  }
  throw new VideoToolError(`action must be add, update or remove, got ${JSON.stringify(input.action)}.`);
}

function validKeyPath(clip: Clip, path: string): void {
  const known = [...ops.TRANSFORM_PATHS, "opacity", ...(clip.type === "video" || clip.type === "audio" ? ["volume"] : [])];
  (clip.effects ?? []).forEach((e, i) => {
    for (const field of ["amount", "degrees"]) if (field in e) known.push(`effects.${i}.${field}`);
  });
  if (!known.includes(path)) throw new VideoToolError(`"${path}" can't be keyframed on this ${clip.type} clip. Paths: ${known.join(", ")}.`);
}

export function editKeyframe(tl: Timeline, compId: string, input: Json, playhead: number): EditResult {
  const comp = requireComp(tl, compId);
  const loc = requireClip(comp, input.clip_id);
  requireUnlocked(loc.track);
  const id = loc.clip.id;
  const action = String(input.action ?? "add");
  const paths = typeof input.path === "string" ? [input.path] : undefined;
  if (paths) validKeyPath(loc.clip, paths[0]);
  const frame = input.frame === undefined ? playhead - loc.clip.from : requireWhole(input.frame, "frame");
  if (frame < 0 || frame >= loc.clip.durationInFrames) throw new VideoToolError(`Keyframe frames are relative to the clip's start: "${id}" takes 0 to ${loc.clip.durationInFrames - 1}, got ${frame}.`);
  const atFrame = (a: unknown) => ops.hasKeyframes(a as never) && (a as { keyframes: Keyframe<number>[] }).keyframes.some((k) => k.frame === frame);
  if (action === "add") {
    if (!paths) throw new VideoToolError("Pass the path to animate, e.g. \"transform.x\" or \"opacity\".");
    const value = input.value === undefined ? undefined : Number(input.value);
    let timeline = ops.addKeyframe(tl, compId, id, paths[0], frame, value);
    if (typeof input.easing === "string") {
      const after = ops.locateClip(ops.getComposition(timeline, compId)!, id)!.clip;
      const a = ops.getAnimatable(after, paths[0]) as { keyframes: Keyframe<number>[] };
      const keyframes = a.keyframes.map((k) => (k.frame === frame ? { ...k, easing: input.easing as Keyframe<number>["easing"] } : k));
      const eased = ops.setAnimatable(after, paths[0], { keyframes }, ops.getComposition(timeline, compId)!);
      timeline = ops.updateClip(timeline, compId, id, eased);
    }
    return { timeline, clipIds: [id], message: `Keyframe on "${id}" ${paths[0]} at clip frame ${frame}${value !== undefined ? ` = ${value}` : ""}.` };
  }
  const keyed = paths ?? ops.keyframedPaths(loc.clip);
  if (!keyed.some((p) => atFrame(ops.getAnimatable(loc.clip, p)))) {
    const frames = ops.keyframeFrames(loc.clip).map((k) => `${k.frame} (${k.paths.join(", ")})`);
    throw new VideoToolError(`"${id}" has no keyframe at clip frame ${frame}${paths ? ` for ${paths[0]}` : ""}. It has: ${list(frames)}.`);
  }
  if (action === "remove") return { timeline: ops.removeKeyframes(tl, compId, id, frame, paths), clipIds: [id], message: `Removed the keyframes of "${id}" at clip frame ${frame}.` };
  if (action === "move") {
    const to = requireWhole(input.to_frame, "to_frame");
    if (to >= loc.clip.durationInFrames) throw new VideoToolError(`to_frame must be under ${loc.clip.durationInFrames}.`);
    return { timeline: ops.moveKeyframes(tl, compId, id, frame, to, paths), clipIds: [id], message: `Moved the keyframes of "${id}" from clip frame ${frame} to ${to}.` };
  }
  throw new VideoToolError(`action must be add, move or remove, got ${JSON.stringify(input.action)}.`);
}

export function setTransition(tl: Timeline, compId: string, input: Json): EditResult {
  const comp = requireComp(tl, compId);
  const loc = requireClip(comp, input.clip_id);
  requireUnlocked(loc.track);
  const kind = String(input.kind ?? "");
  if (!TRANSITION_KINDS.includes(kind as Transition["kind"])) throw new VideoToolError(`kind must be one of ${TRANSITION_KINDS.join(", ")}, got ${JSON.stringify(input.kind)}.`);
  if (kind === "none") {
    const timeline = ops.setTransitionIn(tl, compId, loc.clip.id, null);
    return { timeline, clipIds: [loc.clip.id], message: `Removed the transition into "${loc.clip.id}".` };
  }
  const durationInFrames = input.durationInFrames === undefined ? Math.round(comp.fps / 2) : requireWhole(input.durationInFrames, "durationInFrames", 1);
  const direction = typeof input.direction === "string" ? (input.direction as Transition["direction"]) : undefined;
  const timeline = ops.setTransitionIn(tl, compId, loc.clip.id, { kind: kind as Transition["kind"], durationInFrames, ...(direction ? { direction } : {}) });
  const after = ops.locateClip(ops.getComposition(timeline, compId)!, loc.clip.id)!.clip.transitionIn;
  const prev = ops.adjacentPrev(comp, loc.clip.id);
  return {
    timeline,
    clipIds: [loc.clip.id],
    message: `Transition into "${loc.clip.id}": ${kind}, ${after?.durationInFrames ?? durationInFrames} frames${after && after.durationInFrames !== durationInFrames ? " (capped by the clips' length)" : ""}, ${prev ? `blending with "${prev.id}"` : "from transparent, since no clip ends right where it starts"}.`,
  };
}

export function editEffect(tl: Timeline, compId: string, input: Json): EditResult {
  const comp = requireComp(tl, compId);
  const loc = requireClip(comp, input.clip_id);
  requireUnlocked(loc.track);
  const effects = loc.clip.effects ?? [];
  const action = String(input.action ?? "add");
  const at = (): number => {
    const i = requireWhole(input.index, "index");
    if (i >= effects.length) throw new VideoToolError(`"${loc.clip.id}" has ${effects.length} effects (${list(effects.map((e, n) => `${n}: ${e.kind}`))}), so there is no index ${i}.`);
    return i;
  };
  let next: Effect[];
  if (action === "remove") {
    const i = at();
    next = effects.filter((_, n) => n !== i);
  } else {
    const effect = input.effect as Effect | undefined;
    if (!effect || typeof effect !== "object") throw new VideoToolError(`Pass the effect, e.g. {kind: "blur", amount: 4}. Kinds: ${EFFECT_KINDS.join(", ")}.`);
    if (action === "add") next = [...effects, effect];
    else if (action === "update") {
      const i = at();
      next = effects.map((e, n) => (n === i ? ({ ...e, ...effect } as Effect) : e));
    } else throw new VideoToolError(`action must be add, update or remove, got ${JSON.stringify(input.action)}.`);
  }
  const timeline = ops.updateClip(tl, compId, loc.clip.id, { effects: next } as Partial<Clip>);
  return { timeline, clipIds: [loc.clip.id], message: `Effects of "${loc.clip.id}": ${list(next.map((e) => e.kind))}.` };
}

export function updateComposition(tl: Timeline, compId: string, input: Json): EditResult {
  const comp = requireComp(tl, compId);
  const patch: Partial<Composition> = {};
  if (typeof input.name === "string") patch.name = input.name;
  if (typeof input.background === "string") patch.background = input.background;
  if (input.width !== undefined) patch.width = requireWhole(input.width, "width", 1);
  if (input.height !== undefined) patch.height = requireWhole(input.height, "height", 1);
  if (input.fps !== undefined) patch.fps = Number(input.fps);
  if (input.durationInFrames !== undefined) patch.durationInFrames = requireWhole(input.durationInFrames, "durationInFrames", 1);
  if (Object.keys(patch).length === 0) return { timeline: tl, message: "Nothing to change: pass name, width, height, fps, durationInFrames or background." };
  const end = ops.contentEnd(comp);
  if (patch.durationInFrames !== undefined && patch.durationInFrames < end) {
    throw new VideoToolError(`The last clip ends at frame ${end}, so durationInFrames can't be ${patch.durationInFrames}. Trim or delete what is past it first.`);
  }
  return { timeline: ops.updateComposition(tl, compId, patch), message: `Composition "${comp.id}": ${Object.entries(patch).map(([k, v]) => `${k} ${String(v)}`).join(", ")}.` };
}

export function setSpeed(tl: Timeline, compId: string, input: Json): EditResult {
  const comp = requireComp(tl, compId);
  const loc = requireClip(comp, input.clip_id);
  requireUnlocked(loc.track);
  if (loc.clip.type !== "video") throw new VideoToolError(`Only video clips have a speed; "${loc.clip.id}" is ${loc.clip.type}.`);
  const rate = Number(input.rate);
  if (!(rate >= 0.25 && rate <= 4)) throw new VideoToolError(`rate must be between 0.25 and 4, got ${JSON.stringify(input.rate)}.`);
  const timeline = ops.setClipSpeed(tl, compId, loc.clip.id, rate);
  const after = ops.locateClip(ops.getComposition(timeline, compId)!, loc.clip.id)!.clip;
  return { timeline, clipIds: [loc.clip.id], message: `"${loc.clip.id}" plays at ${rate}×, now ${range(after)}; later clips on its track moved to follow.` };
}

export function detachAudio(tl: Timeline, compId: string, input: Json): EditResult {
  const comp = requireComp(tl, compId);
  const loc = requireClip(comp, input.clip_id);
  requireUnlocked(loc.track);
  if (loc.clip.type !== "video") throw new VideoToolError(`Only a video clip has sound to detach; "${loc.clip.id}" is ${loc.clip.type}.`);
  const r = ops.detachAudio(tl, compId, loc.clip.id, typeof input.new_track_name === "string" ? input.new_track_name : undefined);
  if (!r.audioClipId) throw new VideoToolError(`The audio of "${loc.clip.id}" can't be detached: it is sped up (set_speed 1 first) or already silent.`);
  return { timeline: r.timeline, clipIds: [loc.clip.id, r.audioClipId], select: [r.audioClipId], message: `Detached the audio of "${loc.clip.id}" into clip ${r.audioClipId}; the video clip is now silent.` };
}

/** Why a document can't be saved, or null. Every edit passes through this. */
export function timelineError(next: Timeline): string | null {
  const r = validateTimeline(next);
  return r.ok ? null : `The edit wasn't applied, because the result breaks the timeline:\n${r.errors.slice(0, 12).join("\n")}`;
}

/** Which clips a bulk change is about. Every field given must match. */
export interface ClipSelector {
  ids?: string[];
  type?: string | string[];
  track_id?: string;
  /** Words in the clip's text, captions, name or file. */
  text?: string;
  /** Plays within these frames. */
  from?: number;
  to?: number;
  /** Has keyframes: on any field (true), or on this path ("transform.scale"). */
  animated?: boolean | string;
  /** Has this field set: "kenBurns", "effects", "transitionIn"… */
  has?: string;
}

function clipMatches(c: Clip, track: Track, w: ClipSelector): boolean {
  if (w.ids && !w.ids.includes(c.id)) return false;
  if (w.type !== undefined && !(Array.isArray(w.type) ? w.type : [w.type]).includes(c.type)) return false;
  if (w.track_id !== undefined && track.id !== w.track_id) return false;
  if (w.from !== undefined && clipEnd(c) <= w.from) return false;
  if (w.to !== undefined && c.from >= w.to) return false;
  if (w.has !== undefined && (c as unknown as Json)[w.has] === undefined) return false;
  if (w.animated !== undefined) {
    const keyed = ops.keyframedPaths(c);
    if (w.animated === true ? keyed.length === 0 : w.animated === false ? keyed.length > 0 : !keyed.includes(w.animated)) return false;
  }
  if (w.text) {
    const hay = [c.name, "text" in c ? c.text : "", "file" in c ? c.file : "", "captions" in c ? c.captions.map((x) => x.text).join("") : ""].join(" ").toLowerCase();
    if (!w.text.toLowerCase().split(/\s+/).filter(Boolean).every((word) => hay.includes(word))) return false;
  }
  return true;
}

const SELECTOR_KEYS = ["ids", "type", "track_id", "text", "from", "to", "animated", "has"];

/** The clips a selector picks. One named by id on a locked track is an error; others are skipped. */
function selectClips(comp: Composition, where: ClipSelector): { clips: Clip[]; skipped: string[] } {
  for (const key of Object.keys(where)) if (!SELECTOR_KEYS.includes(key)) throw new VideoToolError(`where.${key} isn't a selector. Selectors: ${SELECTOR_KEYS.join(", ")}.`);
  if (where.track_id !== undefined) requireTrack(comp, where.track_id);
  for (const id of where.ids ?? []) requireUnlocked(requireClip(comp, id).track);
  const clips: Clip[] = [];
  const skipped: string[] = [];
  for (const t of comp.tracks) {
    for (const c of t.clips) {
      if (!clipMatches(c, t, where)) continue;
      if (t.locked) skipped.push(c.id);
      else clips.push(c);
    }
  }
  return { clips, skipped };
}

/** A field back to its default. A transform's part keeps the others: "transform.scale" on a
 *  zoomed clip leaves its position alone. */
function unsetField(tl: Timeline, compId: string, clipId: string, path: string): Timeline {
  const comp = requireComp(tl, compId);
  const { clip } = requireClip(comp, clipId);
  if (path.startsWith("transform.")) {
    if (!clip.transform) return tl;
    const part = path.slice("transform.".length);
    const fallback = part === "x" ? comp.width / 2 : part === "y" ? comp.height / 2 : part === "scale" ? 1 : part === "rotation" ? 0 : undefined;
    if (fallback === undefined) throw new VideoToolError(`"${path}" isn't a part of a transform: use x, y, scale or rotation.`);
    return ops.updateClip(tl, compId, clipId, ops.setAnimatable(clip, path, fallback, comp));
  }
  const dot = path.indexOf(".");
  if (dot < 0) return updateClip(tl, compId, { clip_id: clipId, patch: { [path]: null } }).timeline;
  return updateClip(tl, compId, { clip_id: clipId, patch: { [path.slice(0, dot)]: { [path.slice(dot + 1)]: null } } }).timeline;
}

export interface ApplyInput {
  composition?: Json;
  tracks?: (Json & { clips?: Json[] })[];
  clips?: (Json & { track_id?: string })[];
  markers?: Json[];
  changes?: { where?: ClipSelector; set?: Json; unset?: string[]; delete?: boolean; ripple?: boolean; shift?: number }[];
}

/**
 * Many edits as one: tracks and clips to build, markers, and changes by selector. It all applies
 * or none of it does, so the model never has to work out how far a failed script got.
 */
export function applyEdits(tl: Timeline, compId: string, input: ApplyInput, playhead: number): EditResult {
  let doc = tl;
  const notes: string[] = [];
  const touched: string[] = [];
  let unmatched = 0;
  const at = <T,>(where: string, run: () => T): T => {
    try {
      return run();
    } catch (e) {
      if (e instanceof VideoToolError) throw new VideoToolError(`${where}: ${e.message} Nothing was applied.`);
      throw e;
    }
  };
  const { durationInFrames: lastDuration, ...settings } = input.composition ?? {};
  if (Object.keys(settings).length) {
    doc = at("composition", () => updateComposition(doc, compId, settings).timeline);
    notes.push(`composition ${Object.keys(settings).join(", ")}`);
  }

  const runChange = (change: NonNullable<ApplyInput["changes"]>[number], i: number) => {
    at(`changes[${i}]`, () => {
      if (!change.where || Object.keys(change.where).length === 0) throw new VideoToolError("Say which clips in where, e.g. {type: \"video\"} or {animated: \"transform.scale\"}.");
      const comp = requireComp(doc, compId);
      const { clips, skipped } = selectClips(comp, change.where);
      if (clips.length === 0) {
        // Among other changes it is a cleanup with nothing to clean ("also any Ken Burns"); on
        // its own, or with ids named, it means the model has the wrong idea of the document.
        const types = [...new Set(comp.tracks.flatMap((t) => t.clips.map((c) => c.type)))].join(", ") || "none";
        const none = `No clips match ${JSON.stringify(change.where)}${skipped.length ? ` except on locked tracks (${skipped.length})` : ""}. The composition has ${comp.tracks.reduce((n, t) => n + t.clips.length, 0)} clips of types: ${types}.`;
        if ((input.changes?.length ?? 0) < 2) throw new VideoToolError(none);
        notes.push(none);
        unmatched++;
        return;
      }
      const ids = clips.map((c) => c.id);
      if (change.delete) doc = deleteClips(doc, compId, { clip_ids: ids, ripple: change.ripple === true }).timeline;
      else {
        for (const id of ids) {
          if (change.set) doc = updateClip(doc, compId, { clip_id: id, patch: change.set }).timeline;
          for (const field of change.unset ?? []) doc = unsetField(doc, compId, id, field);
        }
        if (typeof change.shift === "number" && change.shift !== 0) doc = moveClips(doc, compId, { clip_ids: ids, delta: change.shift }).timeline;
        touched.push(...ids);
      }
      const did = change.delete ? "deleted" : [change.set ? `set ${Object.keys(change.set).join(", ")}` : "", change.unset?.length ? `unset ${change.unset.join(", ")}` : "", change.shift ? `shifted ${change.shift}` : ""].filter(Boolean).join(", ") || "nothing to do";
      notes.push(`${did} on ${ids.length} clip${ids.length === 1 ? "" : "s"} (${list(ids)})${skipped.length ? `; skipped ${skipped.length} on locked tracks` : ""}`);
    });
  };
  // Deletions first, so one call can replace what is on a track with a new layout.
  (input.changes ?? []).forEach((change, i) => {
    if (change.delete) runChange(change, i);
  });

  (input.tracks ?? []).forEach((spec, i) => {
    const path = `tracks[${i}]`;
    const existing = typeof spec.id === "string" ? requireComp(doc, compId).tracks.find((t) => t.id === spec.id) : undefined;
    let trackId = existing?.id;
    at(path, () => {
      if (!existing) {
        const kind = String(spec.kind ?? "") as TrackKind;
        if (!TRACK_KINDS.includes(kind)) throw new VideoToolError(`kind must be one of ${TRACK_KINDS.join(", ")}, got ${JSON.stringify(spec.kind)}.`);
        const added = ops.addTrack(doc, compId, kind, { name: typeof spec.name === "string" ? spec.name : undefined, index: typeof spec.index === "number" ? spec.index : undefined });
        const wanted = typeof spec.id === "string" && spec.id ? spec.id : (added.trackId as string);
        trackId = wanted;
        doc = { ...added.timeline, compositions: added.timeline.compositions.map((c) => (c.id !== compId ? c : { ...c, tracks: c.tracks.map((t) => (t.id === added.trackId ? { ...t, id: wanted } : t)) })) };
      } else if (typeof spec.name === "string") doc = ops.renameTrack(doc, compId, existing.id, spec.name);
    });
    (spec.clips ?? []).forEach((raw, k) => {
      at(`${path}.clips[${k}]`, () => {
        const track = requireTrack(requireComp(doc, compId), trackId);
        // A clip with no `from` follows the one before it, so a sequence reads as a list.
        const from = raw.from === undefined ? (track.clips.length ? clipEnd(track.clips[track.clips.length - 1]) : 0) : raw.from;
        const r = addClip(doc, compId, { clip: { ...raw, from }, track_id: trackId }, playhead);
        doc = r.timeline;
        touched.push(...(r.clipIds ?? []));
      });
    });
    const flags: Json = { action: "set", track_id: trackId };
    for (const key of ["hidden", "muted", "locked", "volume"]) if (spec[key] !== undefined) flags[key] = spec[key];
    if (Object.keys(flags).length > 2) doc = at(path, () => editTrack(doc, compId, flags).timeline);
    notes.push(`track ${trackId}${spec.clips?.length ? ` with ${spec.clips.length} clips` : ""}`);
  });

  (input.clips ?? []).forEach((raw, i) => {
    at(`clips[${i}]`, () => {
      const { track_id, ...clip } = raw;
      const r = addClip(doc, compId, { clip, track_id }, playhead);
      doc = r.timeline;
      touched.push(...(r.clipIds ?? []));
    });
  });
  if (input.clips?.length) notes.push(`${input.clips.length} clips added`);

  (input.markers ?? []).forEach((m, i) => {
    doc = at(`markers[${i}]`, () => editMarker(doc, compId, { ...m, action: "add" }, playhead).timeline);
  });
  if (input.markers?.length) notes.push(`${input.markers.length} markers`);

  (input.changes ?? []).forEach((change, i) => {
    if (!change.delete) runChange(change, i);
  });

  if (input.changes?.length && unmatched === input.changes.length && doc === tl) throw new VideoToolError(`${notes.join(" ")} Nothing was applied.`);
  if (lastDuration !== undefined) {
    doc = at("composition", () => updateComposition(doc, compId, { durationInFrames: lastDuration }).timeline);
    notes.push(`composition durationInFrames ${String(lastDuration)}`);
  }
  if (notes.length === 0) throw new VideoToolError("Nothing to apply: pass composition, tracks, clips, markers or changes.");
  const now = requireComp(doc, compId);
  return {
    timeline: doc,
    clipIds: touched.slice(0, 200),
    message: `Applied as one undo step: ${notes.join("; ")}. The composition has ${now.tracks.reduce((n, t) => n + t.clips.length, 0)} clips and ${now.durationInFrames} frames.`,
  };
}
