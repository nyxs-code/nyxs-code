/**
 * Every edit of the video timeline as a pure function over the `Timeline` document.
 *
 * Ops never mutate their input and return the SAME reference when nothing changed, so the store
 * can skip history entries and saves for no-op edits. Composition-scoped ops take the
 * composition id; after any change the composition is normalized: clips sorted by `from` and the
 * duration extended to cover the last clip (it never shrinks on its own).
 *
 * Invariant kept by every op: clips never overlap within a track. Clips on locked tracks are not
 * moved, trimmed, split or deleted.
 */
import type {
  Animatable,
  AudioClip,
  Asset,
  Clip,
  ClipType,
  Composition,
  Keyframe,
  Marker,
  Timeline,
  Track,
  TrackKind,
  Transition,
} from "./timelineSchema";
import { clipEnd, defaultTransform, newId, resolveAnimatable } from "./timelineSchema";

export { clipEnd };

/** Which clip types each track kind holds. Overlay tracks take anything visual. */
const TRACK_ACCEPTS: Record<TrackKind, readonly ClipType[]> = {
  video: ["video", "image", "scene", "shape"],
  audio: ["audio"],
  text: ["text", "captions"],
  overlay: ["video", "image", "scene", "shape", "text", "captions"],
};

export function trackAccepts(kind: TrackKind, type: ClipType): boolean {
  return TRACK_ACCEPTS[kind].includes(type);
}

/** The track kind a new track gets when a clip of this type needs one. */
export function trackKindForClip(type: ClipType): TrackKind {
  switch (type) {
    case "audio":
      return "audio";
    case "text":
    case "captions":
      return "text";
    case "shape":
      return "overlay";
    default:
      return "video";
  }
}

export function getComposition(tl: Timeline, compId: string): Composition | undefined {
  return tl.compositions.find((c) => c.id === compId);
}

export interface ClipLocation {
  trackIndex: number;
  clipIndex: number;
  track: Track;
  clip: Clip;
}

export function locateClip(comp: Composition, clipId: string): ClipLocation | null {
  for (let trackIndex = 0; trackIndex < comp.tracks.length; trackIndex++) {
    const track = comp.tracks[trackIndex];
    const clipIndex = track.clips.findIndex((c) => c.id === clipId);
    if (clipIndex >= 0) return { trackIndex, clipIndex, track, clip: track.clips[clipIndex] };
  }
  return null;
}

/** Last frame covered by any clip (0 for an empty composition). */
export function contentEnd(comp: Composition): number {
  let end = 0;
  for (const t of comp.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

function isSorted(clips: Clip[]): boolean {
  for (let i = 1; i < clips.length; i++) if (clips[i - 1].from > clips[i].from) return false;
  return true;
}

/** Keyframes before the clip start are folded into one at frame 0 with the value the animation
 *  had there (the schema wants frames >= 0); the picture is unchanged. */
function clampKeyframes(clip: Clip): Clip {
  const paths = keyframedPaths(clip).filter((p) => (getAnimatable(clip, p) as { keyframes: Keyframe<number>[] }).keyframes.some((k) => k.frame < 0));
  if (paths.length === 0) return clip;
  let next = clip;
  for (const p of paths) {
    const a = getAnimatable(next, p) as { keyframes: Keyframe<number>[] };
    const atZero = resolveAnimatable(a, 0);
    const kept = a.keyframes.filter((k) => k.frame > 0);
    const first = [...a.keyframes].reverse().find((k) => k.frame <= 0);
    const keyframes = [{ ...first, frame: 0, value: atZero }, ...kept].sort((x, y) => x.frame - y.frame);
    // `setAnimatable` only needs the composition for missing transforms, which can't happen here.
    next = setAnimatable(next, p, { keyframes }, { width: 0, height: 0 } as Composition);
  }
  return next;
}

/** Per-clip invariants every op must leave: transition no longer than the clip, keyframe
 *  frames >= 0. Returns the same clip when it was fine. */
function normalizeClip(clip: Clip): Clip {
  return clampKeyframes(capTransition(clip));
}

function finalizeComp(comp: Composition): Composition {
  let tracks = comp.tracks;
  if (tracks.some((t) => !isSorted(t.clips))) {
    tracks = tracks.map((t) => (isSorted(t.clips) ? t : { ...t, clips: [...t.clips].sort((a, b) => a.from - b.from) }));
  }
  tracks = tracks.map((t) => {
    const clips = t.clips.map(normalizeClip);
    return clips.every((c, i) => c === t.clips[i]) ? t : { ...t, clips };
  });
  if (tracks.every((t, i) => t === comp.tracks[i])) tracks = comp.tracks;
  const end = contentEnd({ ...comp, tracks });
  const durationInFrames = Math.max(comp.durationInFrames, end, 1);
  if (tracks === comp.tracks && durationInFrames === comp.durationInFrames) return comp;
  return { ...comp, tracks, durationInFrames };
}

/** Applies `fn` to one composition; `null` or the same object means "no change". */
function withComp(tl: Timeline, compId: string, fn: (comp: Composition) => Composition | null): Timeline {
  const i = tl.compositions.findIndex((c) => c.id === compId);
  if (i < 0) return tl;
  const prev = tl.compositions[i];
  const next = fn(prev);
  if (!next || next === prev) return tl;
  const compositions = tl.compositions.slice();
  compositions[i] = finalizeComp(next);
  return { ...tl, compositions };
}

function replaceTrack(comp: Composition, index: number, track: Track): Composition {
  const tracks = comp.tracks.slice();
  tracks[index] = track;
  return { ...comp, tracks };
}

function replaceClip(comp: Composition, loc: ClipLocation, clip: Clip): Composition {
  const clips = loc.track.clips.slice();
  clips[loc.clipIndex] = clip;
  return replaceTrack(comp, loc.trackIndex, { ...loc.track, clips });
}

/** Does [from, from+dur) fit on the track without touching other clips (except `ignore`)? */
export function fitsInTrack(track: Track, from: number, dur: number, ignore?: ReadonlySet<string>): boolean {
  if (from < 0 || dur < 1) return false;
  const end = from + dur;
  return !track.clips.some((c) => !ignore?.has(c.id) && c.from < end && clipEnd(c) > from);
}

/** First start at or after `from` where a clip of `dur` frames fits on the track. */
export function findFreeSlot(track: Track, from: number, dur: number, ignore?: ReadonlySet<string>): number {
  let start = Math.max(0, Math.round(from));
  for (const c of track.clips) {
    if (ignore?.has(c.id)) continue;
    if (clipEnd(c) <= start) continue;
    if (c.from >= start + dur) break;
    start = clipEnd(c);
  }
  return start;
}

export function hasKeyframes<T>(a: Animatable<T> | undefined): a is { keyframes: Keyframe<T>[] } {
  return typeof a === "object" && a !== null && Array.isArray((a as { keyframes?: unknown }).keyframes);
}

function mapAnimatable(a: Animatable<number> | undefined, fn: (frame: number) => number): Animatable<number> | undefined {
  if (!hasKeyframes(a)) return a;
  return { keyframes: a.keyframes.map((k) => ({ ...k, frame: fn(k.frame) })) };
}

/** Rewrites the frame of every keyframe of the clip (all animatable properties). */
export function mapClipKeyframes(clip: Clip, fn: (frame: number) => number): Clip {
  let next: Clip = clip;
  if (clip.transform) {
    const t = clip.transform;
    next = {
      ...next,
      transform: {
        ...t,
        x: mapAnimatable(t.x, fn)!,
        y: mapAnimatable(t.y, fn)!,
        scale: mapAnimatable(t.scale, fn)!,
        rotation: mapAnimatable(t.rotation, fn)!,
      },
    };
  }
  if (clip.opacity !== undefined) next = { ...next, opacity: mapAnimatable(clip.opacity, fn) };
  if ((next.type === "video" || next.type === "audio") && next.volume !== undefined) {
    next = { ...next, volume: mapAnimatable(next.volume, fn) };
  }
  if (clip.effects) {
    next = {
      ...next,
      effects: clip.effects.map((e) => {
        if ("amount" in e && typeof e.amount !== "number") return { ...e, amount: mapAnimatable(e.amount, fn)! };
        if ("degrees" in e) return { ...e, degrees: mapAnimatable(e.degrees, fn)! };
        return e;
      }) as typeof clip.effects,
    };
  }
  return next;
}

/** Moves every keyframe of the clip by `delta` frames (clip-relative), e.g. after a start trim. */
export function shiftClipKeyframes(clip: Clip, delta: number): Clip {
  return delta === 0 ? clip : mapClipKeyframes(clip, (f) => f + delta);
}

/** Moves captions (timed relative to the clip start) earlier by `ms` and drops the ones that end
 *  before the clip now starts. */
function shiftCaptions(clip: Clip, ms: number): Clip {
  if (clip.type !== "captions" || ms === 0) return clip;
  const captions = clip.captions
    .filter((c) => c.endMs - ms > 0)
    .map((c) => ({
      ...c,
      startMs: Math.max(0, c.startMs - ms),
      endMs: c.endMs - ms,
      ...(c.timestampMs !== undefined ? { timestampMs: Math.max(0, c.timestampMs - ms) } : {}),
    }));
  return { ...clip, captions };
}

/** How many composition frames of the asset exist (Infinity when unknown or not timed). */
export function assetFramesInComp(asset: Asset | undefined, compFps: number): number {
  if (!asset?.durationInFrames) return Infinity;
  const fps = asset.fps && asset.fps > 0 ? asset.fps : compFps;
  return Math.floor((asset.durationInFrames * compFps) / fps);
}

/** A new clip for an asset dropped on the timeline. Images and unknown durations get 3 s. */
export function clipFromAsset(asset: Asset, comp: Composition, from: number): Clip | null {
  const frames = assetFramesInComp(asset, comp.fps);
  const duration = Number.isFinite(frames) && frames > 0 ? frames : Math.round(comp.fps * 3);
  const base = { id: newId("clip"), from: Math.max(0, Math.round(from)), durationInFrames: duration, name: asset.name };
  switch (asset.kind) {
    case "video":
      return { ...base, type: "video", assetId: asset.id, trimStart: 0 };
    case "image":
      return { ...base, type: "image", assetId: asset.id };
    case "audio":
      return { ...base, type: "audio", assetId: asset.id, trimStart: 0 };
    default:
      return null;
  }
}

/** Adds `clip` to the track at the first free slot at or after `clip.from`. */
export function addClip(tl: Timeline, compId: string, trackId: string, clip: Clip): { timeline: Timeline; clipId: string | null } {
  let placedId: string | null = null;
  const timeline = withComp(tl, compId, (comp) => {
    const ti = comp.tracks.findIndex((t) => t.id === trackId);
    const track = comp.tracks[ti];
    if (!track || track.locked || !trackAccepts(track.kind, clip.type)) return null;
    const dur = Math.max(1, Math.round(clip.durationInFrames));
    const from = findFreeSlot(track, clip.from, dur);
    placedId = clip.id;
    return replaceTrack(comp, ti, { ...track, clips: [...track.clips, { ...clip, from, durationInFrames: dur }] });
  });
  return { timeline, clipId: placedId };
}

/**
 * Puts a clip where the user dropped it: on `preferredTrackId` when it takes this clip type
 * (shifted right if the spot is busy), else on another compatible track where it fits at that
 * frame, else on a new track added on top.
 */
export function placeClip(
  tl: Timeline,
  compId: string,
  clip: Clip,
  preferredTrackId: string | null,
  newTrackName?: string,
): { timeline: Timeline; clipId: string | null; trackId: string | null } {
  const comp = getComposition(tl, compId);
  if (!comp) return { timeline: tl, clipId: null, trackId: null };
  const preferred = comp.tracks.find((t) => t.id === preferredTrackId);
  if (preferred && !preferred.locked && trackAccepts(preferred.kind, clip.type)) {
    const r = addClip(tl, compId, preferred.id, clip);
    return { ...r, trackId: preferred.id };
  }
  const fitting = [...comp.tracks]
    .reverse()
    .find((t) => !t.locked && trackAccepts(t.kind, clip.type) && fitsInTrack(t, clip.from, clip.durationInFrames));
  if (fitting) {
    const r = addClip(tl, compId, fitting.id, clip);
    return { ...r, trackId: fitting.id };
  }
  const added = addTrack(tl, compId, trackKindForClip(clip.type), { name: newTrackName });
  const r = addClip(added.timeline, compId, added.trackId!, clip);
  return { ...r, trackId: added.trackId };
}

function movableIds(comp: Composition, ids: Iterable<string>): Set<string> {
  const wanted = new Set(ids);
  const out = new Set<string>();
  for (const t of comp.tracks) {
    if (t.locked) continue;
    for (const c of t.clips) if (wanted.has(c.id)) out.add(c.id);
  }
  return out;
}

export function removeClips(tl: Timeline, compId: string, ids: Iterable<string>): Timeline {
  return withComp(tl, compId, (comp) => {
    const gone = movableIds(comp, ids);
    if (gone.size === 0) return null;
    return {
      ...comp,
      tracks: comp.tracks.map((t) => (t.clips.some((c) => gone.has(c.id)) ? { ...t, clips: t.clips.filter((c) => !gone.has(c.id)) } : t)),
    };
  });
}

/** Removes the clips and closes the gaps they leave: later clips on the same track move left. */
export function rippleDelete(tl: Timeline, compId: string, ids: Iterable<string>): Timeline {
  return withComp(tl, compId, (comp) => {
    const gone = movableIds(comp, ids);
    if (gone.size === 0) return null;
    return {
      ...comp,
      tracks: comp.tracks.map((t) => {
        const removed = t.clips.filter((c) => gone.has(c.id));
        if (removed.length === 0) return t;
        const clips = t.clips
          .filter((c) => !gone.has(c.id))
          .map((c) => {
            const shift = removed.reduce((sum, r) => (clipEnd(r) <= c.from ? sum + r.durationInFrames : sum), 0);
            return shift ? { ...c, from: c.from - shift } : c;
          });
        return { ...t, clips };
      }),
    };
  });
}

/**
 * The closest valid move to the requested one, for a group of clips moving together by `delta`
 * frames and `trackDelta` track indexes (index 0 = bottom). A track change into a missing,
 * locked or incompatible track is dropped (trackDelta 0). The frame delta stops at neighbours or
 * jumps over them to the nearest gap, whichever is closer, and never goes below frame 0.
 */
export function constrainMove(
  comp: Composition,
  clipIds: Iterable<string>,
  delta: number,
  trackDelta = 0,
): { delta: number; trackDelta: number } {
  const ids = movableIds(comp, clipIds);
  if (ids.size === 0) return { delta: 0, trackDelta: 0 };
  const moving: ClipLocation[] = [];
  comp.tracks.forEach((track, trackIndex) =>
    track.clips.forEach((clip, clipIndex) => {
      if (ids.has(clip.id)) moving.push({ track, trackIndex, clip, clipIndex });
    }),
  );
  const trackOk = (td: number) =>
    moving.every((m) => {
      const target = comp.tracks[m.trackIndex + td];
      return !!target && !target.locked && trackAccepts(target.kind, m.clip.type);
    });
  const td = trackDelta !== 0 && trackOk(trackDelta) ? trackDelta : 0;

  const lower = 0 - Math.min(...moving.map((m) => m.clip.from));
  // Open intervals of forbidden deltas: (lo, hi).
  const forbidden: [number, number][] = [];
  for (const m of moving) {
    const target = comp.tracks[m.trackIndex + td];
    for (const o of target.clips) {
      if (ids.has(o.id)) continue;
      forbidden.push([o.from - clipEnd(m.clip), clipEnd(o) - m.clip.from]);
    }
  }
  forbidden.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const iv of forbidden) {
    const last = merged[merged.length - 1];
    if (last && iv[0] < last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  const inside = (d: number) => merged.some(([lo, hi]) => lo < d && d < hi);
  const want = Math.max(Math.round(delta), lower);
  if (!inside(want)) return { delta: want, trackDelta: td };
  const iv = merged.find(([lo, hi]) => lo < want && want < hi)!;
  const candidates = [iv[0], iv[1]].filter((d) => d >= lower && !inside(d));
  if (candidates.length === 0) return { delta: 0, trackDelta: 0 };
  candidates.sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
  return { delta: candidates[0], trackDelta: td };
}

/** Moves the clips by `delta` frames and `trackDelta` tracks, constrained (see `constrainMove`). */
export function moveClips(tl: Timeline, compId: string, clipIds: Iterable<string>, delta: number, trackDelta = 0): Timeline {
  return withComp(tl, compId, (comp) => {
    const ids = movableIds(comp, clipIds);
    const c = constrainMove(comp, ids, delta, trackDelta);
    if (c.delta === 0 && c.trackDelta === 0) return null;
    const tracks = comp.tracks.map((t) => ({ ...t, clips: t.clips.filter((x) => !ids.has(x.id)) }));
    comp.tracks.forEach((t, i) => {
      for (const clip of t.clips) {
        if (!ids.has(clip.id)) continue;
        tracks[i + c.trackDelta].clips.push({ ...clip, from: clip.from + c.delta });
      }
    });
    return { ...comp, tracks: tracks.map((t, i) => (sameClips(t.clips, comp.tracks[i].clips) ? comp.tracks[i] : t)) };
  });
}

function sameClips(a: Clip[], b: Clip[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/** Moves clips by whole frames (arrow keys). Same as `moveClips` without a track change. */
export function nudgeClips(tl: Timeline, compId: string, clipIds: Iterable<string>, frames: number): Timeline {
  return moveClips(tl, compId, clipIds, frames, 0);
}

function playbackRate(clip: Clip): number {
  return clip.type === "video" ? clip.playbackRate ?? 1 : 1;
}

/** Bounds of an edge trim: neighbours on the track, at least 1 frame long, and for video/audio
 *  never before the start of the media or past its end. */
export function trimBounds(tl: Timeline, comp: Composition, loc: ClipLocation, edge: "start" | "end"): { min: number; max: number } {
  const { clip, track, clipIndex } = loc;
  const prev = track.clips[clipIndex - 1];
  const next = track.clips[clipIndex + 1];
  const end = clipEnd(clip);
  const rate = playbackRate(clip);
  const media = clip.type === "video" || clip.type === "audio";
  const asset = media ? tl.assets.find((a) => a.id === (clip as { assetId: string }).assetId) : undefined;
  if (edge === "start") {
    let min = prev ? clipEnd(prev) : 0;
    if (media) min = Math.max(min, Math.ceil(clip.from - (clip as { trimStart: number }).trimStart / rate));
    return { min, max: end - 1 };
  }
  let max = next ? next.from : Infinity;
  if (media) {
    const total = assetFramesInComp(asset, comp.fps);
    if (Number.isFinite(total)) {
      max = Math.min(max, clip.from + Math.floor((total - (clip as { trimStart: number }).trimStart) / rate));
    }
  }
  return { min: clip.from + 1, max: Math.max(max, clip.from + 1) };
}

/** Moves one edge of a clip to `frame`, clamped to `trimBounds`. Trimming the start keeps the
 *  content in place: media `trimStart`, keyframes and captions move with it. */
export function trimClip(tl: Timeline, compId: string, clipId: string, edge: "start" | "end", frame: number): Timeline {
  return withComp(tl, compId, (comp) => {
    const loc = locateClip(comp, clipId);
    if (!loc || loc.track.locked) return null;
    const { min, max } = trimBounds(tl, comp, loc, edge);
    const target = Math.min(max, Math.max(min, Math.round(frame)));
    const clip = loc.clip;
    if (edge === "end") {
      const durationInFrames = target - clip.from;
      if (durationInFrames === clip.durationInFrames) return null;
      return replaceClip(comp, loc, capTransition({ ...clip, durationInFrames }));
    }
    const delta = target - clip.from;
    if (delta === 0) return null;
    let next: Clip = { ...clip, from: target, durationInFrames: clip.durationInFrames - delta };
    if (next.type === "video" || next.type === "audio") {
      next = { ...next, trimStart: Math.max(0, Math.round(next.trimStart + delta * playbackRate(clip))) };
    }
    next = shiftClipKeyframes(next, -delta);
    next = shiftCaptions(next, (delta * 1000) / comp.fps);
    return replaceClip(comp, loc, capTransition(next));
  });
}

function capTransition(clip: Clip): Clip {
  if (!clip.transitionIn || clip.transitionIn.durationInFrames <= clip.durationInFrames) return clip;
  return { ...clip, transitionIn: { ...clip.transitionIn, durationInFrames: clip.durationInFrames } };
}

/** The two halves of `clip` cut at absolute `frame` (strictly inside the clip), or null. */
export function splitClipParts(clip: Clip, frame: number, fps: number, rightId = newId("clip")): [Clip, Clip] | null {
  const at = Math.round(frame);
  if (at <= clip.from || at >= clipEnd(clip)) return null;
  const offset = at - clip.from;
  let left: Clip = { ...clip, durationInFrames: offset };
  let right: Clip = { ...clip, id: rightId, from: at, durationInFrames: clip.durationInFrames - offset };
  delete right.transitionIn;
  if (right.type === "video" || right.type === "audio") {
    right = { ...right, trimStart: Math.round(right.trimStart + offset * playbackRate(clip)) };
  }
  if (left.type === "audio" && right.type === "audio") {
    left = { ...left, fadeOut: undefined };
    right = { ...right, fadeIn: undefined };
  }
  if (left.type === "text" && right.type === "text" && clip.type === "text" && clip.animation) {
    left = { ...left, animation: clip.animation.in ? { in: clip.animation.in } : undefined };
    right = { ...right, animation: clip.animation.out ? { out: clip.animation.out } : undefined };
  }
  if (left.type === "captions") {
    const cutMs = (offset * 1000) / fps;
    left = { ...left, captions: left.captions.filter((c) => c.startMs < cutMs).map((c) => ({ ...c, endMs: Math.min(c.endMs, cutMs) })) };
  }
  right = shiftCaptions(shiftClipKeyframes(right, -offset), (offset * 1000) / fps);
  return [capTransition(stripUndefined(left)), stripUndefined(right)];
}

function stripUndefined<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as T;
}

export function splitClip(tl: Timeline, compId: string, clipId: string, frame: number): { timeline: Timeline; newClipId: string | null } {
  let newClipId: string | null = null;
  const timeline = withComp(tl, compId, (comp) => {
    const loc = locateClip(comp, clipId);
    if (!loc || loc.track.locked) return null;
    const parts = splitClipParts(loc.clip, frame, comp.fps);
    if (!parts) return null;
    newClipId = parts[1].id;
    const clips = loc.track.clips.slice();
    clips.splice(loc.clipIndex, 1, parts[0], parts[1]);
    return replaceTrack(comp, loc.trackIndex, { ...loc.track, clips });
  });
  return { timeline, newClipId };
}

/**
 * Splits at `frame` the given clips, or every clip under `frame` on unlocked tracks when
 * `clipIds` is empty. Returns the ids of the new right-hand halves.
 */
export function splitAt(tl: Timeline, compId: string, frame: number, clipIds?: Iterable<string>): { timeline: Timeline; newIds: string[] } {
  const comp = getComposition(tl, compId);
  if (!comp) return { timeline: tl, newIds: [] };
  let ids = clipIds ? [...clipIds] : [];
  if (ids.length === 0) {
    ids = comp.tracks.flatMap((t) => (t.locked ? [] : t.clips.filter((c) => c.from < frame && clipEnd(c) > frame).map((c) => c.id)));
  }
  const newIds: string[] = [];
  let timeline = tl;
  for (const id of ids) {
    const r = splitClip(timeline, compId, id, frame);
    timeline = r.timeline;
    if (r.newClipId) newIds.push(r.newClipId);
  }
  return { timeline, newIds };
}

function cloneClip(clip: Clip, from: number): Clip {
  return { ...structuredClone(clip), id: newId("clip"), from };
}

/** Copies each clip right after itself (or the next gap that fits) on its own track. */
export function duplicateClips(tl: Timeline, compId: string, ids: Iterable<string>): { timeline: Timeline; ids: string[] } {
  const out: string[] = [];
  const timeline = withComp(tl, compId, (comp) => {
    const wanted = movableIds(comp, ids);
    if (wanted.size === 0) return null;
    const tracks = comp.tracks.map((t) => {
      const sources = t.clips.filter((c) => wanted.has(c.id));
      if (sources.length === 0) return t;
      let track = t;
      for (const src of sources) {
        const from = findFreeSlot(track, clipEnd(src), src.durationInFrames);
        const copy = cloneClip(src, from);
        out.push(copy.id);
        track = { ...track, clips: [...track.clips, copy].sort((a, b) => a.from - b.from) };
      }
      return track;
    });
    return { ...comp, tracks };
  });
  return { timeline, ids: out };
}

export interface ClipboardEntry {
  /** The clip with `from` relative to the first copied clip. */
  clip: Clip;
  trackId: string;
  trackKind: TrackKind;
}
export interface TimelineClipboard {
  entries: ClipboardEntry[];
}

export function copyClips(comp: Composition, ids: Iterable<string>): TimelineClipboard | null {
  const wanted = new Set(ids);
  const entries: ClipboardEntry[] = [];
  for (const t of comp.tracks) {
    for (const c of t.clips) {
      if (wanted.has(c.id)) entries.push({ clip: structuredClone(c), trackId: t.id, trackKind: t.kind });
    }
  }
  if (entries.length === 0) return null;
  const min = Math.min(...entries.map((e) => e.clip.from));
  return { entries: entries.map((e) => ({ ...e, clip: { ...e.clip, from: e.clip.from - min } })) };
}

/**
 * Pastes clipboard clips starting at `atFrame`, keeping their relative timing. Each goes to its
 * original track when it is in this composition, else to a track of the same kind, else to a new
 * one; a busy spot shifts the clip to the next gap.
 */
export function pasteClips(tl: Timeline, compId: string, clipboard: TimelineClipboard, atFrame: number): { timeline: Timeline; ids: string[] } {
  const ids: string[] = [];
  let timeline = tl;
  const createdForKind = new Map<string, string>();
  for (const entry of clipboard.entries) {
    const comp = getComposition(timeline, compId);
    if (!comp) break;
    const usable = (t: Track) => !t.locked && trackAccepts(t.kind, entry.clip.type);
    let track =
      comp.tracks.find((t) => t.id === entry.trackId && usable(t)) ??
      comp.tracks.find((t) => t.id === createdForKind.get(entry.trackKind)) ??
      comp.tracks.find((t) => t.kind === entry.trackKind && usable(t)) ??
      comp.tracks.find(usable);
    if (!track) {
      const added = addTrack(timeline, compId, entry.trackKind);
      timeline = added.timeline;
      createdForKind.set(entry.trackKind, added.trackId!);
      track = getComposition(timeline, compId)!.tracks.find((t) => t.id === added.trackId)!;
    }
    const clip = cloneClip(entry.clip, Math.max(0, Math.round(atFrame + entry.clip.from)));
    const r = addClip(timeline, compId, track.id, clip);
    timeline = r.timeline;
    if (r.clipId) ids.push(r.clipId);
  }
  return { timeline, ids };
}

/** Shallow-merges `patch` into a clip (never its id or type). Rejected (no change) when the new
 *  timing would overlap a neighbour or start before 0. */
export function updateClip(tl: Timeline, compId: string, clipId: string, patch: Partial<Clip>): Timeline {
  return withComp(tl, compId, (comp) => {
    const loc = locateClip(comp, clipId);
    if (!loc) return null;
    const { id: _id, type: _type, ...rest } = patch as Partial<Clip> & { id?: string; type?: string };
    const next = stripUndefined({ ...loc.clip, ...rest } as Clip);
    next.from = Math.round(next.from);
    next.durationInFrames = Math.max(1, Math.round(next.durationInFrames));
    if (!fitsInTrack(loc.track, next.from, next.durationInFrames, new Set([clipId]))) return null;
    return replaceClip(comp, loc, next);
  });
}

export function updateComposition(tl: Timeline, compId: string, patch: Partial<Omit<Composition, "id" | "tracks" | "markers">>): Timeline {
  return withComp(tl, compId, (comp) => {
    const next = { ...comp, ...patch };
    if (next.durationInFrames < contentEnd(comp)) next.durationInFrames = contentEnd(comp);
    return next;
  });
}

/** The clip right before this one on its track when they touch (a transition can join them). */
export function adjacentPrev(comp: Composition, clipId: string): Clip | null {
  const loc = locateClip(comp, clipId);
  if (!loc) return null;
  const prev = loc.track.clips[loc.clipIndex - 1];
  return prev && clipEnd(prev) === loc.clip.from ? prev : null;
}

/** Sets or clears the transition into a clip; its length is capped by both clips' durations. */
export function setTransitionIn(tl: Timeline, compId: string, clipId: string, transition: Transition | null): Timeline {
  return withComp(tl, compId, (comp) => {
    const loc = locateClip(comp, clipId);
    if (!loc || loc.track.locked) return null;
    if (!transition) {
      if (!loc.clip.transitionIn) return null;
      const next = { ...loc.clip };
      delete next.transitionIn;
      return replaceClip(comp, loc, next);
    }
    const prev = loc.track.clips[loc.clipIndex - 1];
    const cap = Math.min(loc.clip.durationInFrames, prev ? prev.durationInFrames : loc.clip.durationInFrames);
    const durationInFrames = Math.max(1, Math.min(cap, Math.round(transition.durationInFrames)));
    return replaceClip(comp, loc, { ...loc.clip, transitionIn: { ...transition, durationInFrames } });
  });
}

const DEFAULT_TRACK_NAMES: Record<TrackKind, string> = { video: "Video", audio: "Audio", text: "Text", overlay: "Overlay" };

/** Adds a track of `kind` at `index` (default: on top of the others of the timeline). */
export function addTrack(
  tl: Timeline,
  compId: string,
  kind: TrackKind,
  opts: { index?: number; name?: string } = {},
): { timeline: Timeline; trackId: string | null } {
  let trackId: string | null = null;
  const timeline = withComp(tl, compId, (comp) => {
    const n = comp.tracks.filter((t) => t.kind === kind).length + 1;
    const track: Track = { id: newId("track"), name: opts.name?.trim() || `${DEFAULT_TRACK_NAMES[kind]} ${n}`, kind, clips: [] };
    if (kind === "audio" || kind === "video") track.volume = 1;
    trackId = track.id;
    const tracks = comp.tracks.slice();
    const index = opts.index === undefined ? tracks.length : Math.max(0, Math.min(tracks.length, opts.index));
    tracks.splice(index, 0, track);
    return { ...comp, tracks };
  });
  return { timeline, trackId };
}

export function removeTrack(tl: Timeline, compId: string, trackId: string): Timeline {
  return withComp(tl, compId, (comp) => {
    if (!comp.tracks.some((t) => t.id === trackId)) return null;
    return { ...comp, tracks: comp.tracks.filter((t) => t.id !== trackId) };
  });
}

export function renameTrack(tl: Timeline, compId: string, trackId: string, name: string): Timeline {
  const clean = name.trim();
  if (!clean) return tl;
  return setTrackField(tl, compId, trackId, (t) => (t.name === clean ? t : { ...t, name: clean }));
}

/** Moves a track to `toIndex` in the stacking order (0 = bottom). */
export function moveTrack(tl: Timeline, compId: string, trackId: string, toIndex: number): Timeline {
  return withComp(tl, compId, (comp) => {
    const from = comp.tracks.findIndex((t) => t.id === trackId);
    if (from < 0) return null;
    const to = Math.max(0, Math.min(comp.tracks.length - 1, toIndex));
    if (to === from) return null;
    const tracks = comp.tracks.slice();
    const [t] = tracks.splice(from, 1);
    tracks.splice(to, 0, t);
    return { ...comp, tracks };
  });
}

export type TrackFlags = Partial<Pick<Track, "hidden" | "muted" | "locked" | "volume">>;

/** Sets hidden/muted/locked/volume. `false` flags are removed from the JSON to keep it short. */
export function setTrackProps(tl: Timeline, compId: string, trackId: string, patch: TrackFlags): Timeline {
  return setTrackField(tl, compId, trackId, (t) => {
    const next: Track = { ...t };
    for (const key of ["hidden", "muted", "locked"] as const) {
      if (patch[key] === undefined) continue;
      if (patch[key]) next[key] = true;
      else delete next[key];
    }
    if (patch.volume !== undefined) next.volume = Math.round(Math.max(0, Math.min(2, patch.volume)) * 100) / 100;
    const same = next.hidden === t.hidden && next.muted === t.muted && next.locked === t.locked && next.volume === t.volume;
    return same ? t : next;
  });
}

function setTrackField(tl: Timeline, compId: string, trackId: string, fn: (t: Track) => Track): Timeline {
  return withComp(tl, compId, (comp) => {
    const i = comp.tracks.findIndex((t) => t.id === trackId);
    if (i < 0) return null;
    const next = fn(comp.tracks[i]);
    return next === comp.tracks[i] ? null : replaceTrack(comp, i, next);
  });
}

/** Adds a marker at `frame`; when one is already there, returns its id and changes nothing. */
export function addMarker(tl: Timeline, compId: string, frame: number, label = "", color?: string): { timeline: Timeline; markerId: string | null } {
  let markerId: string | null = null;
  const at = Math.max(0, Math.round(frame));
  const timeline = withComp(tl, compId, (comp) => {
    const existing = comp.markers.find((m) => m.frame === at);
    if (existing) {
      markerId = existing.id;
      return null;
    }
    const marker: Marker = { id: newId("marker"), frame: at, label, ...(color ? { color } : {}) };
    markerId = marker.id;
    return { ...comp, markers: [...comp.markers, marker].sort((a, b) => a.frame - b.frame) };
  });
  return { timeline, markerId };
}

export function updateMarker(tl: Timeline, compId: string, markerId: string, patch: Partial<Omit<Marker, "id">>): Timeline {
  return withComp(tl, compId, (comp) => {
    const i = comp.markers.findIndex((m) => m.id === markerId);
    if (i < 0) return null;
    const next = { ...comp.markers[i], ...patch };
    next.frame = Math.max(0, Math.round(next.frame));
    const markers = comp.markers.slice();
    markers[i] = next;
    return { ...comp, markers: markers.sort((a, b) => a.frame - b.frame) };
  });
}

export function moveMarker(tl: Timeline, compId: string, markerId: string, frame: number): Timeline {
  return updateMarker(tl, compId, markerId, { frame });
}

export function removeMarker(tl: Timeline, compId: string, markerId: string): Timeline {
  return withComp(tl, compId, (comp) =>
    comp.markers.some((m) => m.id === markerId) ? { ...comp, markers: comp.markers.filter((m) => m.id !== markerId) } : null,
  );
}

export interface InOut {
  inPoint: number | null;
  outPoint: number | null;
}

/** Sets the in point; an out point at or before it is cleared. */
export function setInPoint(range: InOut, frame: number | null): InOut {
  if (frame === null) return { ...range, inPoint: null };
  const inPoint = Math.max(0, Math.round(frame));
  return { inPoint, outPoint: range.outPoint !== null && range.outPoint <= inPoint ? null : range.outPoint };
}

/** Sets the out point; an in point at or after it is cleared. */
export function setOutPoint(range: InOut, frame: number | null): InOut {
  if (frame === null) return { ...range, outPoint: null };
  const outPoint = Math.max(1, Math.round(frame));
  return { outPoint, inPoint: range.inPoint !== null && range.inPoint >= outPoint ? null : range.inPoint };
}

/** Frames clips snap to: frame 0, the playhead, every clip edge (except `exclude`), markers and
 *  the in/out points. Sorted and unique. */
export function snapTargets(
  comp: Composition,
  opts: { playhead?: number | null; exclude?: ReadonlySet<string>; inPoint?: number | null; outPoint?: number | null } = {},
): number[] {
  const set = new Set<number>([0]);
  if (opts.playhead != null) set.add(opts.playhead);
  if (opts.inPoint != null) set.add(opts.inPoint);
  if (opts.outPoint != null) set.add(opts.outPoint);
  for (const m of comp.markers) set.add(m.frame);
  for (const t of comp.tracks) {
    for (const c of t.clips) {
      if (opts.exclude?.has(c.id)) continue;
      set.add(c.from);
      set.add(clipEnd(c));
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * The smallest correction that puts one of `points` on one of `targets` (sorted), within
 * `threshold` frames, or null. `offset` is what to add to the moved points; `target` is where the
 * snap guide goes.
 */
export function computeSnap(points: number[], targets: number[], threshold: number): { offset: number; target: number } | null {
  let best: { offset: number; target: number } | null = null;
  for (const p of points) {
    // Binary search for the closest target.
    let lo = 0;
    let hi = targets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (targets[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    for (const i of [lo - 1, lo]) {
      const target = targets[i];
      if (target === undefined) continue;
      const offset = target - p;
      if (Math.abs(offset) <= threshold && (!best || Math.abs(offset) < Math.abs(best.offset))) best = { offset, target };
    }
  }
  return best;
}

/** Path of an animatable property of a clip, e.g. "transform.x", "opacity", "volume",
 *  "effects.0.amount", "effects.1.degrees". */
export type AnimPath = string;

export const TRANSFORM_PATHS: readonly AnimPath[] = ["transform.x", "transform.y", "transform.scale", "transform.rotation"];

export function getAnimatable(clip: Clip, path: AnimPath): Animatable<number> | undefined {
  const parts = path.split(".");
  if (parts[0] === "transform") {
    return clip.transform?.[parts[1] as "x" | "y" | "scale" | "rotation"];
  }
  if (parts[0] === "opacity") return clip.opacity;
  if (parts[0] === "volume") return clip.type === "video" || clip.type === "audio" ? clip.volume : undefined;
  if (parts[0] === "effects") {
    const effect = clip.effects?.[Number(parts[1])] as Record<string, unknown> | undefined;
    const v = effect?.[parts[2]];
    return v as Animatable<number> | undefined;
  }
  return undefined;
}

function defaultAnimValue(comp: Composition, path: AnimPath): number {
  switch (path) {
    case "transform.x":
      return comp.width / 2;
    case "transform.y":
      return comp.height / 2;
    case "transform.scale":
    case "opacity":
    case "volume":
      return 1;
    default:
      return 0;
  }
}

export function setAnimatable(clip: Clip, path: AnimPath, value: Animatable<number>, comp: Composition): Clip {
  const parts = path.split(".");
  if (parts[0] === "transform") {
    const t = clip.transform ?? defaultTransform(comp);
    return { ...clip, transform: { ...t, [parts[1]]: value } };
  }
  if (parts[0] === "opacity") return { ...clip, opacity: value };
  if (parts[0] === "volume") return clip.type === "video" || clip.type === "audio" ? { ...clip, volume: value } : clip;
  if (parts[0] === "effects" && clip.effects) {
    const i = Number(parts[1]);
    if (!clip.effects[i]) return clip;
    const effects = clip.effects.slice();
    effects[i] = { ...effects[i], [parts[2]]: value } as (typeof effects)[number];
    return { ...clip, effects };
  }
  return clip;
}

/** Every animatable path of the clip that currently has keyframes. */
export function keyframedPaths(clip: Clip): AnimPath[] {
  const paths: AnimPath[] = [];
  for (const p of TRANSFORM_PATHS) if (hasKeyframes(getAnimatable(clip, p))) paths.push(p);
  if (hasKeyframes(clip.opacity)) paths.push("opacity");
  if ((clip.type === "video" || clip.type === "audio") && hasKeyframes(clip.volume)) paths.push("volume");
  clip.effects?.forEach((e, i) => {
    if ("amount" in e && hasKeyframes(e.amount as Animatable<number>)) paths.push(`effects.${i}.amount`);
    if ("degrees" in e && hasKeyframes(e.degrees)) paths.push(`effects.${i}.degrees`);
  });
  return paths;
}

/** Keyframe frames (clip-relative) with the properties keyed there, sorted by frame. */
export function keyframeFrames(clip: Clip): { frame: number; paths: AnimPath[] }[] {
  const byFrame = new Map<number, AnimPath[]>();
  for (const p of keyframedPaths(clip)) {
    const a = getAnimatable(clip, p) as { keyframes: Keyframe<number>[] };
    for (const k of a.keyframes) {
      const list = byFrame.get(k.frame) ?? [];
      list.push(p);
      byFrame.set(k.frame, list);
    }
  }
  return [...byFrame.entries()].sort((a, b) => a[0] - b[0]).map(([frame, paths]) => ({ frame, paths }));
}

function withClip(tl: Timeline, compId: string, clipId: string, fn: (clip: Clip, comp: Composition) => Clip): Timeline {
  return withComp(tl, compId, (comp) => {
    const loc = locateClip(comp, clipId);
    if (!loc || loc.track.locked) return null;
    const next = fn(loc.clip, comp);
    return next === loc.clip ? null : replaceClip(comp, loc, next);
  });
}

/**
 * Adds (or updates) a keyframe of `path` at clip-relative `frame`. Without `value`, the property's
 * current value at that frame is used, so adding a keyframe never changes the picture. A fixed
 * value becomes a single keyframe.
 */
export function addKeyframe(tl: Timeline, compId: string, clipId: string, path: AnimPath, frame: number, value?: number): Timeline {
  return withClip(tl, compId, clipId, (clip, comp) => {
    const at = Math.round(frame);
    const current = getAnimatable(clip, path);
    const v = value ?? (current === undefined ? defaultAnimValue(comp, path) : resolveAnimatable(current, at));
    const keyframes: Keyframe<number>[] = hasKeyframes(current) ? current.keyframes.filter((k) => k.frame !== at) : [];
    const old = hasKeyframes(current) ? current.keyframes.find((k) => k.frame === at) : undefined;
    keyframes.push({ ...old, frame: at, value: v });
    keyframes.sort((a, b) => a.frame - b.frame);
    return setAnimatable(clip, path, { keyframes }, comp);
  });
}

/** Moves the keyframes at `fromFrame` (of `paths`, default all keyed paths) to `toFrame`,
 *  replacing any keyframe already there. */
export function moveKeyframes(tl: Timeline, compId: string, clipId: string, fromFrame: number, toFrame: number, paths?: AnimPath[]): Timeline {
  const to = Math.round(toFrame);
  if (to === fromFrame) return tl;
  return withClip(tl, compId, clipId, (clip, comp) => {
    let next = clip;
    for (const p of paths ?? keyframedPaths(clip)) {
      const a = getAnimatable(next, p);
      if (!hasKeyframes(a)) continue;
      const k = a.keyframes.find((x) => x.frame === fromFrame);
      if (!k) continue;
      const keyframes = a.keyframes.filter((x) => x.frame !== fromFrame && x.frame !== to);
      keyframes.push({ ...k, frame: to });
      keyframes.sort((x, y) => x.frame - y.frame);
      next = setAnimatable(next, p, { keyframes }, comp);
    }
    return next;
  });
}

/** Deletes the keyframes at `frame`. A property left with no keyframes keeps the deleted value
 *  as its fixed value. */
export function removeKeyframes(tl: Timeline, compId: string, clipId: string, frame: number, paths?: AnimPath[]): Timeline {
  return withClip(tl, compId, clipId, (clip, comp) => {
    let next = clip;
    for (const p of paths ?? keyframedPaths(clip)) {
      const a = getAnimatable(next, p);
      if (!hasKeyframes(a)) continue;
      const k = a.keyframes.find((x) => x.frame === frame);
      if (!k) continue;
      const keyframes = a.keyframes.filter((x) => x.frame !== frame);
      next = setAnimatable(next, p, keyframes.length ? { keyframes } : k.value, comp);
    }
    return next;
  });
}

/**
 * Media clips that play the same source frames at the same composition frames, e.g. a video and
 * the audio detached from it. Cuts and freeze frames treat them as one so they stay in sync.
 */
export function inSync(a: Clip, b: Clip): boolean {
  if ((a.type !== "video" && a.type !== "audio") || (b.type !== "video" && b.type !== "audio")) return false;
  if (a.assetId !== b.assetId) return false;
  const ra = playbackRate(a);
  const rb = playbackRate(b);
  return ra === rb && a.trimStart - a.from * ra === b.trimStart - b.from * rb;
}

/**
 * "Detach audio": adds an audio clip with the video clip's sound (same asset, timing, trim and
 * volume) on a free audio track (a new one at the bottom when none fits) and silences the video
 * clip. Refused for sped-up clips (audio clips have no playback rate) and for clips already
 * silenced.
 */
export function detachAudio(tl: Timeline, compId: string, clipId: string, newTrackName?: string): { timeline: Timeline; audioClipId: string | null } {
  const comp = getComposition(tl, compId);
  const loc = comp && locateClip(comp, clipId);
  if (!comp || !loc || loc.track.locked || loc.clip.type !== "video") return { timeline: tl, audioClipId: null };
  const v = loc.clip;
  if (playbackRate(v) !== 1 || v.volume === 0) return { timeline: tl, audioClipId: null };
  const audio: AudioClip = stripUndefined({
    id: newId("clip"),
    type: "audio" as const,
    assetId: v.assetId,
    from: v.from,
    durationInFrames: v.durationInFrames,
    trimStart: v.trimStart,
    name: v.name,
    volume: v.volume,
  });
  let timeline = withComp(tl, compId, (c) => replaceClip(c, loc, { ...v, volume: 0 }));
  const muted = getComposition(timeline, compId)!;
  let trackId = muted.tracks.find((t) => t.kind === "audio" && !t.locked && fitsInTrack(t, v.from, v.durationInFrames))?.id;
  if (!trackId) {
    const added = addTrack(timeline, compId, "audio", { name: newTrackName, index: 0 });
    timeline = added.timeline;
    trackId = added.trackId!;
  }
  const r = addClip(timeline, compId, trackId, audio);
  return { timeline: r.timeline, audioClipId: r.clipId };
}

/** What is left of `clip` after taking [s, e) out of the timeline: the part before `s` (keeps the
 *  id) and the part after `e` moved left to `s`. Uses the split logic, so trims, keyframes,
 *  captions and text animations stay aligned with the content. */
function cutOut(clip: Clip, s: number, e: number, fps: number): Clip[] {
  const out: Clip[] = [];
  let tail: Clip | null = clip;
  if (clip.from < s) {
    const parts = splitClipParts(clip, s, fps)!;
    out.push(parts[0]);
    tail = parts[1];
  }
  if (clipEnd(tail) <= e) return out;
  if (tail.from < e) tail = splitClipParts(tail, e, fps, tail.id)![1];
  out.push({ ...tail, from: tail.from - (e - s) });
  return out;
}

/** Shortens a clip that runs into the next one (after a ripple moved things around). */
function resolveOverlaps(clips: Clip[]): Clip[] {
  const sorted = [...clips].sort((a, b) => a.from - b.from);
  const out: Clip[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && clipEnd(prev) > c.from) {
      const dur = c.from - prev.from;
      if (dur < 1) out.pop();
      else out[out.length - 1] = capTransition({ ...prev, durationInFrames: dur });
    }
    out.push(c);
  }
  return out;
}

function rippleCut(comp: Composition, s: number, e: number, target: Clip): Composition {
  const len = e - s;
  const tracks = comp.tracks.map((t) => {
    if (t.locked) return t;
    let changed = false;
    const clips: Clip[] = [];
    for (const c of t.clips) {
      if (clipEnd(c) <= s) {
        clips.push(c);
        continue;
      }
      changed = true;
      if (c.from >= e) {
        clips.push({ ...c, from: c.from - len });
      } else if (c.type === "audio" && !inSync(c, target)) {
        // A music bed keeps playing through the cut: it only loses the cut length at its end.
        if (c.from >= s) clips.push({ ...c, from: s });
        else clips.push(capTransition({ ...c, durationInFrames: c.durationInFrames - (Math.min(e, clipEnd(c)) - s) }));
      } else {
        clips.push(...cutOut(c, s, e, comp.fps));
      }
    }
    return changed ? { ...t, clips: resolveOverlaps(clips) } : t;
  });
  const markers = comp.markers.filter((m) => m.frame < s || m.frame >= e).map((m) => (m.frame >= e ? { ...m, frame: m.frame - len } : m));
  const removed = Math.max(0, Math.min(e, comp.durationInFrames) - s);
  return { ...comp, tracks, markers, durationInFrames: Math.max(1, comp.durationInFrames - removed) };
}

/**
 * Takes frame ranges (composition frames, clamped to the clip) out of a clip and closes the gaps
 * on every unlocked track, so what comes after stays in sync: the clip and anything in sync with
 * it (its detached audio) are cut, overlapping text, captions and other visuals are cut the same
 * way (captions keep their words aligned), and audio that isn't in sync (music) keeps playing
 * and just gets shorter. Used by "remove silences" and "cut by transcript".
 */
export function rippleDeleteRanges(tl: Timeline, compId: string, clipId: string, ranges: [number, number][]): { timeline: Timeline; removedFrames: number } {
  const comp = getComposition(tl, compId);
  const loc = comp && locateClip(comp, clipId);
  if (!comp || !loc || loc.track.locked) return { timeline: tl, removedFrames: 0 };
  const target = loc.clip;
  const list = ranges
    .map(([s, e]) => [Math.max(target.from, Math.round(s)), Math.min(clipEnd(target), Math.round(e))] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])
    .reduce<[number, number][]>((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else acc.push([r[0], r[1]]);
      return acc;
    }, []);
  if (list.length === 0) return { timeline: tl, removedFrames: 0 };
  const timeline = withComp(tl, compId, (c) => {
    let next = c;
    // Last range first, so earlier ranges' frames don't move under us.
    for (let i = list.length - 1; i >= 0; i--) next = rippleCut(next, list[i][0], list[i][1], target);
    return next;
  });
  return { timeline, removedFrames: list.reduce((n, [s, e]) => n + e - s, 0) };
}

/** "Trim to selection": each clip keeps only its part inside [inPoint, outPoint); clips fully
 *  outside are removed. Nothing else moves. */
export function trimClipsToRange(tl: Timeline, compId: string, clipIds: Iterable<string>, inPoint: number, outPoint: number): Timeline {
  if (outPoint <= inPoint) return tl;
  let timeline = tl;
  const outside: string[] = [];
  for (const id of clipIds) {
    const comp = getComposition(timeline, compId);
    const loc = comp && locateClip(comp, id);
    if (!loc || loc.track.locked) continue;
    if (clipEnd(loc.clip) <= inPoint || loc.clip.from >= outPoint) {
      outside.push(id);
      continue;
    }
    if (loc.clip.from < inPoint) timeline = trimClip(timeline, compId, id, "start", inPoint);
    if (clipEnd(loc.clip) > outPoint) timeline = trimClip(timeline, compId, id, "end", outPoint);
  }
  return outside.length ? removeClips(timeline, compId, outside) : timeline;
}

/** Keeps only [inPoint, outPoint) of the whole composition: everything is trimmed to it, moved to
 *  start at frame 0, and the composition becomes exactly that long. Locked tracks stay as they are. */
export function trimCompositionToRange(tl: Timeline, compId: string, inPoint: number, outPoint: number): Timeline {
  const comp = getComposition(tl, compId);
  const a = Math.max(0, Math.round(inPoint));
  const b = Math.round(outPoint);
  if (!comp || b <= a) return tl;
  const ids = comp.tracks.flatMap((t) => (t.locked ? [] : t.clips.map((c) => c.id)));
  const trimmed = trimClipsToRange(tl, compId, ids, a, b);
  return withComp(trimmed, compId, (c) => ({
    ...c,
    tracks: c.tracks.map((t) => (t.locked || a === 0 ? t : { ...t, clips: t.clips.map((x) => ({ ...x, from: x.from - a })) })),
    markers: c.markers.filter((m) => m.frame >= a && m.frame < b).map((m) => ({ ...m, frame: m.frame - a })),
    durationInFrames: Math.max(b - a, contentEnd(c) - a, 1),
  }));
}

function resolvedNumber(a: Animatable<number> | undefined, frameInClip: number): number | undefined {
  return a === undefined ? undefined : resolveAnimatable(a, frameInClip);
}

/**
 * Freeze frame: holds the video clip's picture at `frame` for `holdFrames`. The clip (and what is
 * in sync with it) is split there, everything after `frame` on unlocked tracks moves right by
 * the hold, and an image clip of `still` (a render of that frame; added to the assets if new)
 * fills the gap with the clip's transform, opacity, fit and effects as they are at that frame.
 * Text and music already playing at `frame` keep playing over the hold.
 */
export function freezeFrame(
  tl: Timeline,
  compId: string,
  clipId: string,
  frame: number,
  still: Asset,
  holdFrames: number,
): { timeline: Timeline; holdClipId: string | null } {
  const comp = getComposition(tl, compId);
  const loc = comp && locateClip(comp, clipId);
  const at = Math.round(frame);
  const hold = Math.max(1, Math.round(holdFrames));
  if (!comp || !loc || loc.track.locked || loc.clip.type !== "video" || at < loc.clip.from || at >= clipEnd(loc.clip)) {
    return { timeline: tl, holdClipId: null };
  }
  const target = loc.clip;
  const rel = at - target.from;
  const t = target.transform;
  const image: Clip = stripUndefined({
    id: newId("clip"),
    type: "image" as const,
    assetId: still.id,
    from: at,
    durationInFrames: hold,
    name: still.name,
    fit: target.fit,
    opacity: resolvedNumber(target.opacity, rel),
    transform: t && {
      ...t,
      x: resolveAnimatable(t.x, rel),
      y: resolveAnimatable(t.y, rel),
      scale: resolveAnimatable(t.scale, rel),
      rotation: resolveAnimatable(t.rotation, rel),
    },
    effects: target.effects?.map((e) => {
      if ("amount" in e && typeof e.amount !== "number") return { ...e, amount: resolveAnimatable(e.amount, rel) };
      if ("degrees" in e) return { ...e, degrees: resolveAnimatable(e.degrees, rel) };
      return e;
    }) as Clip["effects"],
  });
  const withAsset = tl.assets.some((a) => a.id === still.id) ? tl : { ...tl, assets: [...tl.assets, still] };
  const timeline = withComp(withAsset, compId, (c) => {
    const tracks = c.tracks.map((tr) => {
      if (tr.locked) return tr;
      const clips: Clip[] = [];
      for (const x of tr.clips) {
        if (x.from >= at) clips.push({ ...x, from: x.from + hold });
        else if (clipEnd(x) > at && (x.id === target.id || inSync(x, target))) {
          const parts = splitClipParts(x, at, c.fps);
          if (parts) clips.push(parts[0], { ...parts[1], from: parts[1].from + hold });
          else clips.push(x);
        } else clips.push(x);
      }
      if (tr.id === loc.track.id) clips.push(image);
      return { ...tr, clips };
    });
    const markers = c.markers.map((m) => (m.frame >= at ? { ...m, frame: m.frame + hold } : m));
    return { ...c, tracks, markers, durationInFrames: c.durationInFrames + hold };
  });
  return { timeline, holdClipId: image.id };
}

/**
 * Changes a video clip's speed (0.25..4). The clip keeps the same source content, so its
 * duration changes (capped by the media length); later clips on its track move to follow it and
 * keyframes are rescaled. Audio detached from it does not follow (audio clips have no rate).
 */
export function setClipSpeed(tl: Timeline, compId: string, clipId: string, rate: number): Timeline {
  return withComp(tl, compId, (comp) => {
    const loc = locateClip(comp, clipId);
    if (!loc || loc.track.locked || loc.clip.type !== "video") return null;
    const clip = loc.clip;
    const old = playbackRate(clip);
    const next = Math.round(Math.max(0.25, Math.min(4, rate)) * 100) / 100;
    if (next === old) return null;
    const asset = tl.assets.find((a) => a.id === clip.assetId);
    const total = assetFramesInComp(asset, comp.fps);
    let duration = Math.max(1, Math.round((clip.durationInFrames * old) / next));
    if (Number.isFinite(total)) duration = Math.max(1, Math.min(duration, Math.floor((total - clip.trimStart) / next)));
    const delta = duration - clip.durationInFrames;
    const scale = old / next;
    const sped = capTransition({ ...mapClipKeyframes(clip, (f) => Math.round(f * scale)), playbackRate: next, durationInFrames: duration } as Clip);
    const end = clipEnd(clip);
    const clips = loc.track.clips.map((c) => (c.id === clipId ? sped : c.from >= end ? { ...c, from: c.from + delta } : c));
    if (next === 1) delete (sped as { playbackRate?: number }).playbackRate;
    return replaceTrack(comp, loc.trackIndex, { ...loc.track, clips });
  });
}

/** Problems `repairTimeline` looks for: unsorted tracks and overlapping clips. */
export function timelineProblems(tl: Timeline): string[] {
  const out: string[] = [];
  for (const comp of tl.compositions) {
    for (const t of comp.tracks) {
      for (let i = 1; i < t.clips.length; i++) {
        const prev = t.clips[i - 1];
        const c = t.clips[i];
        if (c.from < prev.from) out.push(`${comp.id}/${t.id}: "${c.id}" starts before "${prev.id}"`);
        else if (c.from < clipEnd(prev)) out.push(`${comp.id}/${t.id}: "${c.id}" overlaps "${prev.id}"`);
      }
    }
  }
  return out;
}

/**
 * Makes every track sorted and overlap-free without losing anything: clips are sorted by
 * `from`, and a clip that overlaps an earlier one moves, at the same frame, to another track of
 * the same kind where it fits, or to a new track of that kind added right above. Returns the
 * same reference when nothing was wrong.
 */
export function repairTimeline(tl: Timeline): Timeline {
  if (timelineProblems(tl).length === 0) return tl;
  const compositions = tl.compositions.map((comp) => {
    const tracks: Track[] = comp.tracks.map((t) => ({ ...t, clips: [...t.clips].sort((a, b) => a.from - b.from || a.id.localeCompare(b.id)) }));
    const evicted: { clip: Clip; from: number }[] = [];
    for (let i = 0; i < tracks.length; i++) {
      const kept: Clip[] = [];
      for (const c of tracks[i].clips) {
        const prev = kept[kept.length - 1];
        if (prev && c.from < clipEnd(prev)) evicted.push({ clip: c, from: i });
        else kept.push(c);
      }
      tracks[i] = { ...tracks[i], clips: kept };
    }
    for (const { clip, from } of evicted) {
      const kind = comp.tracks[from].kind;
      const origin = tracks.find((t) => t.id === comp.tracks[from].id)!;
      let target = tracks.find((t) => t !== origin && t.kind === kind && fitsInTrack(t, clip.from, clip.durationInFrames));
      if (!target) {
        const n = tracks.filter((t) => t.kind === kind).length + 1;
        target = { id: newId("track"), name: `${DEFAULT_TRACK_NAMES[kind]} ${n}`, kind, clips: [] };
        tracks.splice(tracks.indexOf(origin) + 1, 0, target);
      }
      target.clips = [...target.clips, clip].sort((a, b) => a.from - b.from);
    }
    return finalizeComp({ ...comp, tracks });
  });
  return { ...tl, compositions };
}
