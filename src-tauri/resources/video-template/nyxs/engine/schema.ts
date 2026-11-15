// Nyxs Video timeline schema (copy). Source of truth: src/lib/video/timelineSchema.ts in Nyxs.
// Everything below this header must stay byte-identical to it; a Nyxs test checks it.

export const TIMELINE_VERSION = 1;

export interface Timeline {
  version: 1;
  compositions: Composition[];
  /** Media the project knows about, referenced by clips through `assetId`. */
  assets: Asset[];
}

export interface Composition {
  /** Remotion composition id, [A-Za-z0-9-]. */
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** CSS color. */
  background: string;
  /** Index 0 = bottom layer, last = top layer. */
  tracks: Track[];
  markers: Marker[];
}

export interface Marker {
  id: string;
  frame: number;
  label: string;
  color?: string;
}

export type TrackKind = "video" | "audio" | "text" | "overlay";

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  hidden?: boolean;
  muted?: boolean;
  locked?: boolean;
  /** 0..2, audio/video tracks. */
  volume?: number;
  /** Sorted by `from`, never overlapping within a track. */
  clips: Clip[];
}

export interface Asset {
  id: string;
  kind: "video" | "image" | "audio" | "font";
  /** Path relative to the project's public/ folder, e.g. "media/intro.mov". */
  src: string;
  /** Display name. For fonts it is also the CSS font-family that TextStyle.fontFamily uses. */
  name: string;
  /** At the asset's own fps, for video/audio. */
  durationInFrames?: number;
  fps?: number;
  width?: number;
  height?: number;
}

interface ClipBase {
  id: string;
  /** Start frame on the composition. */
  from: number;
  durationInFrames: number;
  name?: string;
  transform?: Transform;
  opacity?: Animatable<number>;
  /** Transition INTO this clip from the previous clip on the same track. */
  transitionIn?: Transition;
  effects?: Effect[];
}

export type Clip = VideoClip | ImageClip | AudioClip | TextClip | ShapeClip | SceneClip | CaptionsClip;
export type ClipType = Clip["type"];

export interface VideoClip extends ClipBase {
  type: "video";
  assetId: string;
  /** Frames (at the composition fps) skipped at the start of the asset. */
  trimStart: number;
  /** 0.25..4 */
  playbackRate?: number;
  volume?: Animatable<number>;
  fit?: "cover" | "contain" | "fill";
}

export interface ImageClip extends ClipBase {
  type: "image";
  assetId: string;
  fit?: "cover" | "contain" | "fill";
  /** Scale and offset (px) at the clip start and end, interpolated with ease-in-out. */
  kenBurns?: { fromScale: number; toScale: number; fromX: number; toX: number; fromY: number; toY: number };
}

export interface AudioClip extends ClipBase {
  type: "audio";
  assetId: string;
  /** Frames (at the composition fps) skipped at the start of the asset. */
  trimStart: number;
  volume?: Animatable<number>;
  /** Frames. */
  fadeIn?: number;
  /** Frames. */
  fadeOut?: number;
}

export interface TextClip extends ClipBase {
  type: "text";
  text: string;
  style: TextStyle;
  animation?: { in?: TextAnimation; out?: TextAnimation };
}

export interface ShapeClip extends ClipBase {
  type: "shape";
  shape: "rect" | "circle" | "line";
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  width: number;
  height: number;
}

/** A custom React component from the project's scenes/<file>.tsx (or a built-in scene), exported by name. */
export interface SceneClip extends ClipBase {
  type: "scene";
  /** File name inside scenes/, with or without the .tsx extension. */
  file: string;
  exportName: string;
  props?: Record<string, unknown>;
}

export interface CaptionsClip extends ClipBase {
  type: "captions";
  /** Times relative to the clip start. */
  captions: Caption[];
  style: TextStyle;
  mode: "line" | "word-highlight" | "karaoke";
  highlightColor?: string;
}

export interface Caption {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs?: number;
  confidence?: number;
}

export interface TextStyle {
  /** A font asset's name, a Google Fonts family, or any CSS font stack. */
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: "left" | "center" | "right";
  lineHeight?: number;
  /** px */
  letterSpacing?: number;
  background?: string;
  padding?: number;
  radius?: number;
  /** CSS text-shadow. */
  shadow?: string;
  /** Text outline color (2px, scaled with fontSize). */
  stroke?: string;
  maxWidth?: number;
}

export type TextAnimationKind =
  | "fade"
  | "slide-up"
  | "slide-down"
  | "slide-left"
  | "slide-right"
  | "scale"
  | "blur"
  | "typewriter"
  | "words";

export type TextAnimation = { kind: TextAnimationKind; durationInFrames: number };

/** Position in px from the composition's top-left, of the clip's center; scale 1 = natural size. */
export interface Transform {
  x: Animatable<number>;
  y: Animatable<number>;
  scale: Animatable<number>;
  /** Degrees. */
  rotation: Animatable<number>;
  /** Which point of the clip (x, y) places, and the pivot for scale and rotation. */
  anchor?: "center" | "top-left";
}

/** A fixed value, or keyframes with frames RELATIVE to the clip start. */
export type Animatable<T> = T | { keyframes: Keyframe<T>[] };

/** `easing` shapes the segment that LEAVES this keyframe (towards the next one). Default linear. */
export interface Keyframe<T> {
  frame: number;
  value: T;
  easing?: Easing;
}

export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "spring";

export type TransitionKind = "fade" | "slide" | "wipe" | "flip" | "clock-wipe" | "iris" | "none";

/**
 * Plays over the first `durationInFrames` of the clip. If the previous clip on the track ends
 * exactly where this one starts, it keeps rendering underneath as the exiting side; otherwise
 * the clip transitions in from transparent.
 */
export interface Transition {
  kind: TransitionKind;
  durationInFrames: number;
  direction?: "from-left" | "from-right" | "from-top" | "from-bottom";
}

/**
 * Amounts: blur in px; brightness/contrast/saturate as multipliers (1 = unchanged);
 * grayscale/sepia/invert 0..1; vignette 0..1; chroma-key tolerance 0..1.
 */
export type Effect =
  | { kind: "blur"; amount: Animatable<number> }
  | { kind: "brightness" | "contrast" | "saturate"; amount: Animatable<number> }
  | { kind: "grayscale" | "sepia" | "invert"; amount: Animatable<number> }
  | { kind: "hue-rotate"; degrees: Animatable<number> }
  | { kind: "drop-shadow"; x: number; y: number; blur: number; color: string }
  | { kind: "chroma-key"; color: string; tolerance: number }
  | { kind: "vignette"; amount: number };

export type EffectKind = Effect["kind"];

export const CLIP_TYPES: readonly ClipType[] = ["video", "image", "audio", "text", "shape", "scene", "captions"];
export const TRACK_KINDS: readonly TrackKind[] = ["video", "audio", "text", "overlay"];
export const EASINGS: readonly Easing[] = ["linear", "ease-in", "ease-out", "ease-in-out", "spring"];
export const TRANSITION_KINDS: readonly TransitionKind[] = ["fade", "slide", "wipe", "flip", "clock-wipe", "iris", "none"];
export const TEXT_ANIMATION_KINDS: readonly TextAnimationKind[] = [
  "fade",
  "slide-up",
  "slide-down",
  "slide-left",
  "slide-right",
  "scale",
  "blur",
  "typewriter",
  "words",
];
export const EFFECT_KINDS: readonly EffectKind[] = [
  "blur",
  "brightness",
  "contrast",
  "saturate",
  "grayscale",
  "sepia",
  "invert",
  "hue-rotate",
  "drop-shadow",
  "chroma-key",
  "vignette",
];

/** True when the value is keyframed rather than a fixed value. */
export function isKeyframed<T>(value: Animatable<T>): value is { keyframes: Keyframe<T>[] } {
  return typeof value === "object" && value !== null && Array.isArray((value as { keyframes?: unknown }).keyframes);
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const sample = (a1: number, a2: number, t: number) => {
    const u = 1 - t;
    return 3 * u * u * t * a1 + 3 * u * t * t * a2 + t * t * t;
  };
  const slope = (a1: number, a2: number, t: number) => {
    const u = 1 - t;
    return 3 * u * u * a1 + 6 * u * t * (a2 - a1) + 3 * t * t * (1 - a2);
  };
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sample(x1, x2, t) - x;
      if (Math.abs(err) < 1e-6) return sample(y1, y2, t);
      const d = slope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    // Newton did not converge (flat slope): bisect.
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sample(x1, x2, t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sample(y1, y2, t);
  };
}

const EASE_IN = cubicBezier(0.42, 0, 1, 1);
const EASE_OUT = cubicBezier(0, 0, 0.58, 1);
const EASE_IN_OUT = cubicBezier(0.42, 0, 0.58, 1);

// Underdamped spring (damping ratio 0.6, ~10% overshoot) stretched so it settles at t = 1,
// whatever the segment length. Remotion's spring() depends on fps; this one only on progress,
// so the same keyframes look the same at any frame rate.
const SPRING_ZETA = 0.6;
const SPRING_DECAY = 6.5;
const SPRING_OMEGA_D = (SPRING_DECAY / SPRING_ZETA) * Math.sqrt(1 - SPRING_ZETA * SPRING_ZETA);

function springProgress(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const envelope = Math.exp(-SPRING_DECAY * t);
  return 1 - envelope * (Math.cos(SPRING_OMEGA_D * t) + (SPRING_DECAY / SPRING_OMEGA_D) * Math.sin(SPRING_OMEGA_D * t));
}

/** Maps linear progress 0..1 through an easing. Spring may overshoot above 1 before settling. */
export function applyEasing(easing: Easing | undefined, t: number): number {
  const p = Math.min(1, Math.max(0, t));
  switch (easing) {
    case "ease-in":
      return EASE_IN(p);
    case "ease-out":
      return EASE_OUT(p);
    case "ease-in-out":
      return EASE_IN_OUT(p);
    case "spring":
      return springProgress(p);
    default:
      return p;
  }
}

/**
 * Value of an Animatable at a frame relative to the clip start. Holds the first/last keyframe
 * outside their range. Numbers interpolate; other types hold the previous keyframe's value.
 */
export function resolveAnimatable<T>(value: Animatable<T>, frameInClip: number): T {
  if (!isKeyframed(value)) return value;
  const frames = [...value.keyframes].sort((a, b) => a.frame - b.frame);
  if (frames.length === 0) {
    throw new Error("resolveAnimatable: keyframes must not be empty");
  }
  if (frameInClip <= frames[0].frame) return frames[0].value;
  const last = frames[frames.length - 1];
  if (frameInClip >= last.frame) return last.value;
  let i = 0;
  while (i < frames.length - 2 && frameInClip >= frames[i + 1].frame) i++;
  const a = frames[i];
  const b = frames[i + 1];
  if (typeof a.value !== "number" || typeof b.value !== "number") return a.value;
  const span = b.frame - a.frame;
  const p = span <= 0 ? 1 : applyEasing(a.easing, (frameInClip - a.frame) / span);
  return (a.value + (b.value - a.value) * p) as T;
}

export interface ResolvedTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  anchor: "center" | "top-left";
}

/** Clip transform at a frame relative to the clip start; no transform = centered, natural size. */
export function resolveTransform(
  transform: Transform | undefined,
  frameInClip: number,
  composition: Pick<Composition, "width" | "height">,
): ResolvedTransform {
  if (!transform) {
    return { x: composition.width / 2, y: composition.height / 2, scale: 1, rotation: 0, anchor: "center" };
  }
  return {
    x: resolveAnimatable(transform.x, frameInClip),
    y: resolveAnimatable(transform.y, frameInClip),
    scale: resolveAnimatable(transform.scale, frameInClip),
    rotation: resolveAnimatable(transform.rotation, frameInClip),
    anchor: transform.anchor ?? "center",
  };
}

/** Default transform for a new clip: centered in the composition. */
export function defaultTransform(composition: Pick<Composition, "width" | "height">): Transform {
  return { x: composition.width / 2, y: composition.height / 2, scale: 1, rotation: 0, anchor: "center" };
}

/** First frame after the clip (exclusive end). */
export function clipEnd(clip: Pick<ClipBase, "from" | "durationInFrames">): number {
  return clip.from + clip.durationInFrames;
}

/** Scene file name without extension, as imported from scenes/. */
export function sceneModuleName(file: string): string {
  return file.replace(/\.(tsx|ts|jsx|js)$/i, "");
}

/** Random id like "clip-k3j9x2ab". The alphabet keeps it valid as a Remotion composition id. */
export function newId(prefix: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(10);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${prefix}-${out}`;
}

export interface EmptyTimelineOptions {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  name?: string;
  compositionId?: string;
  background?: string;
}

/** A valid timeline with one composition and empty video, text and audio tracks. */
export function emptyTimeline(opts: EmptyTimelineOptions): Timeline {
  return {
    version: 1,
    compositions: [
      {
        id: opts.compositionId ?? "Main",
        name: opts.name ?? "Main",
        width: opts.width,
        height: opts.height,
        fps: opts.fps,
        durationInFrames: opts.durationInFrames,
        background: opts.background ?? "#000000",
        tracks: [
          { id: newId("track"), name: "Video 1", kind: "video", clips: [] },
          { id: newId("track"), name: "Text 1", kind: "text", clips: [] },
          { id: newId("track"), name: "Audio 1", kind: "audio", clips: [] },
        ],
        markers: [],
      },
    ],
    assets: [],
  };
}

export type ValidationResult = { ok: true; timeline: Timeline } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  if (v === undefined) return "nothing";
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  } catch {
    return String(v);
  }
}

/** Collects errors with a JSON path, e.g. `compositions[0].tracks[1].clips[2].from`. */
class Checker {
  errors: string[] = [];

  fail(path: string, msg: string) {
    this.errors.push(`${path}: ${msg}`);
  }

  object(v: unknown, path: string): v is Obj {
    if (isObj(v)) return true;
    this.fail(path, `expected an object, got ${show(v)}`);
    return false;
  }

  array(v: unknown, path: string): v is unknown[] {
    if (Array.isArray(v)) return true;
    this.fail(path, `expected an array, got ${show(v)}`);
    return false;
  }

  string(v: unknown, path: string, opts: { optional?: boolean; nonEmpty?: boolean } = {}): boolean {
    if (v === undefined && opts.optional) return true;
    if (typeof v !== "string") {
      this.fail(path, `expected a string, got ${show(v)}`);
      return false;
    }
    if (opts.nonEmpty !== false && v.trim() === "") {
      this.fail(path, "must not be empty");
      return false;
    }
    return true;
  }

  bool(v: unknown, path: string) {
    if (v !== undefined && typeof v !== "boolean") this.fail(path, `expected true or false, got ${show(v)}`);
  }

  number(
    v: unknown,
    path: string,
    opts: { optional?: boolean; int?: boolean; min?: number; max?: number; exclusiveMin?: boolean } = {},
  ): boolean {
    if (v === undefined && opts.optional) return true;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.fail(path, `expected a ${opts.int ? "whole number" : "number"}, got ${show(v)}`);
      return false;
    }
    if (opts.int && !Number.isInteger(v)) {
      this.fail(path, `expected a whole number of frames/pixels, got ${v}`);
      return false;
    }
    if (opts.min !== undefined && (opts.exclusiveMin ? v <= opts.min : v < opts.min)) {
      this.fail(path, `must be ${opts.exclusiveMin ? ">" : ">="} ${opts.min}, got ${v}`);
      return false;
    }
    if (opts.max !== undefined && v > opts.max) {
      this.fail(path, `must be <= ${opts.max}, got ${v}`);
      return false;
    }
    return true;
  }

  oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string, optional = false): v is T {
    if (v === undefined && optional) return false;
    if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return true;
    this.fail(path, `expected one of ${allowed.map((a) => `"${a}"`).join(", ")}, got ${show(v)}`);
    return false;
  }

  animatable(v: unknown, path: string, opts: { optional?: boolean; min?: number; max?: number } = {}) {
    if (v === undefined && opts.optional) return;
    if (isObj(v) && "keyframes" in v) {
      const kfs = v.keyframes;
      if (!this.array(kfs, `${path}.keyframes`)) return;
      if (kfs.length === 0) {
        this.fail(`${path}.keyframes`, "needs at least one keyframe (or use a plain number)");
        return;
      }
      let prev = -1;
      kfs.forEach((kf, i) => {
        const p = `${path}.keyframes[${i}]`;
        if (!this.object(kf, p)) return;
        if (this.number(kf.frame, `${p}.frame`, { int: true, min: 0 })) {
          const f = kf.frame as number;
          if (f <= prev) this.fail(`${p}.frame`, `keyframes must be in increasing frame order without duplicates (${f} after ${prev})`);
          prev = f;
        }
        this.number(kf.value, `${p}.value`, { min: opts.min, max: opts.max });
        if (kf.easing !== undefined) this.oneOf(kf.easing, EASINGS, `${p}.easing`);
      });
      return;
    }
    if (typeof v === "number") {
      this.number(v, path, { min: opts.min, max: opts.max });
      return;
    }
    this.fail(path, `expected a number or { keyframes: [...] }, got ${show(v)}`);
  }
}

const COMPOSITION_ID_RE = /^[A-Za-z0-9-]+$/;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function checkTextStyle(c: Checker, s: unknown, path: string) {
  if (!c.object(s, path)) return;
  c.string(s.fontFamily, `${path}.fontFamily`);
  c.number(s.fontSize, `${path}.fontSize`, { min: 0, exclusiveMin: true });
  c.number(s.fontWeight, `${path}.fontWeight`, { min: 1, max: 1000 });
  c.string(s.color, `${path}.color`);
  c.oneOf(s.align, ["left", "center", "right"] as const, `${path}.align`);
  c.number(s.lineHeight, `${path}.lineHeight`, { optional: true, min: 0, exclusiveMin: true });
  c.number(s.letterSpacing, `${path}.letterSpacing`, { optional: true });
  c.string(s.background, `${path}.background`, { optional: true });
  c.number(s.padding, `${path}.padding`, { optional: true, min: 0 });
  c.number(s.radius, `${path}.radius`, { optional: true, min: 0 });
  c.string(s.shadow, `${path}.shadow`, { optional: true });
  c.string(s.stroke, `${path}.stroke`, { optional: true });
  c.number(s.maxWidth, `${path}.maxWidth`, { optional: true, min: 0, exclusiveMin: true });
}

function checkTextAnimation(c: Checker, a: unknown, path: string, clipDuration: number) {
  if (a === undefined) return;
  if (!c.object(a, path)) return;
  c.oneOf(a.kind, TEXT_ANIMATION_KINDS, `${path}.kind`);
  if (c.number(a.durationInFrames, `${path}.durationInFrames`, { int: true, min: 1 }) && Number.isInteger(clipDuration)) {
    if ((a.durationInFrames as number) > clipDuration) {
      c.fail(`${path}.durationInFrames`, `${a.durationInFrames} is longer than the clip (${clipDuration} frames)`);
    }
  }
}

function checkEffect(c: Checker, e: unknown, path: string) {
  if (!c.object(e, path)) return;
  if (!c.oneOf(e.kind, EFFECT_KINDS, `${path}.kind`)) return;
  switch (e.kind) {
    case "blur":
      c.animatable(e.amount, `${path}.amount`, { min: 0 });
      break;
    case "brightness":
    case "contrast":
    case "saturate":
      c.animatable(e.amount, `${path}.amount`, { min: 0 });
      break;
    case "grayscale":
    case "sepia":
    case "invert":
      c.animatable(e.amount, `${path}.amount`, { min: 0, max: 1 });
      break;
    case "hue-rotate":
      c.animatable(e.degrees, `${path}.degrees`);
      break;
    case "drop-shadow":
      c.number(e.x, `${path}.x`);
      c.number(e.y, `${path}.y`);
      c.number(e.blur, `${path}.blur`, { min: 0 });
      c.string(e.color, `${path}.color`);
      break;
    case "chroma-key":
      c.string(e.color, `${path}.color`);
      c.number(e.tolerance, `${path}.tolerance`, { min: 0, max: 1 });
      break;
    case "vignette":
      c.number(e.amount, `${path}.amount`, { min: 0, max: 1 });
      break;
  }
}

function checkClip(
  c: Checker,
  clip: Obj,
  path: string,
  track: Obj,
  assets: Map<string, Obj>,
  compFps: number,
) {
  c.string(clip.id, `${path}.id`);
  if (!c.oneOf(clip.type, CLIP_TYPES, `${path}.type`)) return;
  c.number(clip.from, `${path}.from`, { int: true, min: 0 });
  const durOk = c.number(clip.durationInFrames, `${path}.durationInFrames`, { int: true, min: 1 });
  const duration = durOk ? (clip.durationInFrames as number) : NaN;
  c.string(clip.name, `${path}.name`, { optional: true, nonEmpty: false });
  if (clip.transform !== undefined && c.object(clip.transform, `${path}.transform`)) {
    const t = clip.transform;
    c.animatable(t.x, `${path}.transform.x`);
    c.animatable(t.y, `${path}.transform.y`);
    c.animatable(t.scale, `${path}.transform.scale`, { min: 0 });
    c.animatable(t.rotation, `${path}.transform.rotation`);
    if (t.anchor !== undefined) c.oneOf(t.anchor, ["center", "top-left"] as const, `${path}.transform.anchor`);
  }
  c.animatable(clip.opacity, `${path}.opacity`, { optional: true, min: 0, max: 1 });
  if (clip.transitionIn !== undefined && c.object(clip.transitionIn, `${path}.transitionIn`)) {
    const tr = clip.transitionIn;
    c.oneOf(tr.kind, TRANSITION_KINDS, `${path}.transitionIn.kind`);
    if (c.number(tr.durationInFrames, `${path}.transitionIn.durationInFrames`, { int: true, min: 0 }) && durOk) {
      if ((tr.durationInFrames as number) > duration) {
        c.fail(`${path}.transitionIn.durationInFrames`, `${tr.durationInFrames} is longer than the clip (${duration} frames)`);
      }
    }
    if (tr.direction !== undefined) {
      c.oneOf(tr.direction, ["from-left", "from-right", "from-top", "from-bottom"] as const, `${path}.transitionIn.direction`);
    }
  }
  if (clip.effects !== undefined && c.array(clip.effects, `${path}.effects`)) {
    clip.effects.forEach((e, i) => checkEffect(c, e, `${path}.effects[${i}]`));
  }

  const kind = track.kind;
  if (clip.type === "audio" && kind !== "audio") {
    c.fail(`${path}.type`, `audio clips go on an audio track, this track is "${String(kind)}"`);
  }
  if (clip.type !== "audio" && kind === "audio") {
    c.fail(`${path}.type`, `audio tracks only hold audio clips, got a "${String(clip.type)}" clip`);
  }

  const checkAsset = (expected: "video" | "image" | "audio"): Obj | undefined => {
    if (!c.string(clip.assetId, `${path}.assetId`)) return undefined;
    const asset = assets.get(clip.assetId as string);
    if (!asset) {
      c.fail(`${path}.assetId`, `no asset with id "${String(clip.assetId)}" in timeline.assets`);
      return undefined;
    }
    // Video assets are fine on audio clips (their soundtrack).
    const ok = asset.kind === expected || (expected === "audio" && asset.kind === "video");
    if (!ok) c.fail(`${path}.assetId`, `asset "${String(clip.assetId)}" is a ${String(asset.kind)}, expected ${expected}`);
    return asset;
  };

  const checkTrim = (asset: Obj | undefined, rate: number) => {
    if (!c.number(clip.trimStart, `${path}.trimStart`, { int: true, min: 0 })) return;
    if (!asset || !durOk || typeof asset.durationInFrames !== "number") return;
    const assetFps = typeof asset.fps === "number" && asset.fps > 0 ? asset.fps : compFps;
    const needed = (((clip.trimStart as number) + duration * rate) * assetFps) / compFps;
    const available = asset.durationInFrames as number;
    if (needed > available + 1) {
      c.fail(
        `${path}.durationInFrames`,
        `clip needs ${Math.ceil(needed)} frames of "${String(asset.name ?? asset.id)}" (trimStart ${String(clip.trimStart)} + ${duration} frames at ${rate}x) but the asset has ${available}`,
      );
    }
  };

  switch (clip.type) {
    case "video": {
      const asset = checkAsset("video");
      const rateOk = c.number(clip.playbackRate, `${path}.playbackRate`, { optional: true, min: 0.25, max: 4 });
      checkTrim(asset, rateOk && typeof clip.playbackRate === "number" ? clip.playbackRate : 1);
      c.animatable(clip.volume, `${path}.volume`, { optional: true, min: 0, max: 2 });
      if (clip.fit !== undefined) c.oneOf(clip.fit, ["cover", "contain", "fill"] as const, `${path}.fit`);
      break;
    }
    case "image": {
      checkAsset("image");
      if (clip.fit !== undefined) c.oneOf(clip.fit, ["cover", "contain", "fill"] as const, `${path}.fit`);
      if (clip.kenBurns !== undefined && c.object(clip.kenBurns, `${path}.kenBurns`)) {
        const kb = clip.kenBurns;
        c.number(kb.fromScale, `${path}.kenBurns.fromScale`, { min: 0, exclusiveMin: true });
        c.number(kb.toScale, `${path}.kenBurns.toScale`, { min: 0, exclusiveMin: true });
        for (const k of ["fromX", "toX", "fromY", "toY"]) c.number(kb[k], `${path}.kenBurns.${k}`);
      }
      break;
    }
    case "audio": {
      const asset = checkAsset("audio");
      checkTrim(asset, 1);
      c.animatable(clip.volume, `${path}.volume`, { optional: true, min: 0, max: 2 });
      c.number(clip.fadeIn, `${path}.fadeIn`, { optional: true, int: true, min: 0 });
      c.number(clip.fadeOut, `${path}.fadeOut`, { optional: true, int: true, min: 0 });
      const fades = (typeof clip.fadeIn === "number" ? clip.fadeIn : 0) + (typeof clip.fadeOut === "number" ? clip.fadeOut : 0);
      if (durOk && fades > duration) c.fail(`${path}`, `fadeIn + fadeOut (${fades}) are longer than the clip (${duration} frames)`);
      break;
    }
    case "text": {
      c.string(clip.text, `${path}.text`, { nonEmpty: false });
      checkTextStyle(c, clip.style, `${path}.style`);
      if (clip.animation !== undefined && c.object(clip.animation, `${path}.animation`)) {
        checkTextAnimation(c, clip.animation.in, `${path}.animation.in`, duration);
        checkTextAnimation(c, clip.animation.out, `${path}.animation.out`, duration);
      }
      break;
    }
    case "shape": {
      c.oneOf(clip.shape, ["rect", "circle", "line"] as const, `${path}.shape`);
      c.string(clip.fill, `${path}.fill`);
      c.string(clip.stroke, `${path}.stroke`, { optional: true });
      c.number(clip.strokeWidth, `${path}.strokeWidth`, { optional: true, min: 0 });
      c.number(clip.radius, `${path}.radius`, { optional: true, min: 0 });
      c.number(clip.width, `${path}.width`, { min: 0, exclusiveMin: true });
      c.number(clip.height, `${path}.height`, { min: 0 });
      break;
    }
    case "scene": {
      if (c.string(clip.file, `${path}.file`)) {
        const f = clip.file as string;
        if (f.includes("..") || /^[\\/]/.test(f) || /^[A-Za-z]:/.test(f) || f.includes("\\")) {
          c.fail(`${path}.file`, `must be a file name inside scenes/ (like "TitleCard.tsx"), got ${show(f)}`);
        }
      }
      if (c.string(clip.exportName, `${path}.exportName`) && !IDENTIFIER_RE.test(clip.exportName as string)) {
        c.fail(`${path}.exportName`, `must be a JavaScript export name, got ${show(clip.exportName)}`);
      }
      if (clip.props !== undefined && !isObj(clip.props)) c.fail(`${path}.props`, `expected an object, got ${show(clip.props)}`);
      break;
    }
    case "captions": {
      if (c.array(clip.captions, `${path}.captions`)) {
        clip.captions.forEach((cap, i) => {
          const p = `${path}.captions[${i}]`;
          if (!c.object(cap, p)) return;
          c.string(cap.text, `${p}.text`, { nonEmpty: false });
          const okS = c.number(cap.startMs, `${p}.startMs`, { min: 0 });
          const okE = c.number(cap.endMs, `${p}.endMs`, { min: 0 });
          if (okS && okE && (cap.endMs as number) < (cap.startMs as number)) {
            c.fail(p, `endMs (${String(cap.endMs)}) is before startMs (${String(cap.startMs)})`);
          }
          c.number(cap.timestampMs, `${p}.timestampMs`, { optional: true, min: 0 });
          c.number(cap.confidence, `${p}.confidence`, { optional: true, min: 0, max: 1 });
        });
      }
      checkTextStyle(c, clip.style, `${path}.style`);
      c.oneOf(clip.mode, ["line", "word-highlight", "karaoke"] as const, `${path}.mode`);
      c.string(clip.highlightColor, `${path}.highlightColor`, { optional: true });
      break;
    }
  }
}

/**
 * Checks a parsed timeline.json. Errors carry the JSON path and say what was expected, e.g.
 * `compositions[0].tracks[1].clips[2] (id "clip-a1"): overlaps clip "clip-b2" (frames 30-90)`.
 */
export function validateTimeline(json: unknown): ValidationResult {
  const c = new Checker();
  if (!c.object(json, "timeline")) return { ok: false, errors: c.errors };
  if (json.version !== TIMELINE_VERSION) c.fail("version", `expected ${TIMELINE_VERSION}, got ${show(json.version)}`);

  const assets = new Map<string, Obj>();
  if (c.array(json.assets, "assets")) {
    json.assets.forEach((a, i) => {
      const p = `assets[${i}]`;
      if (!c.object(a, p)) return;
      if (c.string(a.id, `${p}.id`)) {
        if (assets.has(a.id as string)) c.fail(`${p}.id`, `duplicate asset id "${String(a.id)}"`);
        else assets.set(a.id as string, a);
      }
      c.oneOf(a.kind, ["video", "image", "audio", "font"] as const, `${p}.kind`);
      if (c.string(a.src, `${p}.src`)) {
        const src = a.src as string;
        if (!/^https?:\/\//.test(src) && (src.includes("..") || /^[\\/]/.test(src) || /^[A-Za-z]:/.test(src))) {
          c.fail(`${p}.src`, `must be a path relative to public/ (like "media/intro.mp4") or an http(s) URL, got ${show(src)}`);
        }
      }
      c.string(a.name, `${p}.name`);
      c.number(a.durationInFrames, `${p}.durationInFrames`, { optional: true, min: 0 });
      c.number(a.fps, `${p}.fps`, { optional: true, min: 0, exclusiveMin: true });
      c.number(a.width, `${p}.width`, { optional: true, min: 0 });
      c.number(a.height, `${p}.height`, { optional: true, min: 0 });
    });
  }

  const compIds = new Set<string>();
  const clipIds = new Map<string, string>();
  if (c.array(json.compositions, "compositions")) {
    if (json.compositions.length === 0) c.fail("compositions", "needs at least one composition");
    json.compositions.forEach((comp, ci) => {
      const cp = `compositions[${ci}]`;
      if (!c.object(comp, cp)) return;
      if (c.string(comp.id, `${cp}.id`)) {
        const id = comp.id as string;
        if (!COMPOSITION_ID_RE.test(id)) c.fail(`${cp}.id`, `may only contain letters, digits and "-", got ${show(id)}`);
        if (compIds.has(id)) c.fail(`${cp}.id`, `duplicate composition id "${id}"`);
        compIds.add(id);
      }
      c.string(comp.name, `${cp}.name`);
      c.number(comp.width, `${cp}.width`, { int: true, min: 1 });
      c.number(comp.height, `${cp}.height`, { int: true, min: 1 });
      const fpsOk = c.number(comp.fps, `${cp}.fps`, { min: 1, max: 240 });
      const compFps = fpsOk ? (comp.fps as number) : 30;
      c.number(comp.durationInFrames, `${cp}.durationInFrames`, { int: true, min: 1 });
      c.string(comp.background, `${cp}.background`);

      if (c.array(comp.markers, `${cp}.markers`)) {
        comp.markers.forEach((m, mi) => {
          const mp = `${cp}.markers[${mi}]`;
          if (!c.object(m, mp)) return;
          c.string(m.id, `${mp}.id`);
          c.number(m.frame, `${mp}.frame`, { int: true, min: 0 });
          c.string(m.label, `${mp}.label`, { nonEmpty: false });
          c.string(m.color, `${mp}.color`, { optional: true });
        });
      }

      const trackIds = new Set<string>();
      if (!c.array(comp.tracks, `${cp}.tracks`)) return;
      comp.tracks.forEach((track, ti) => {
        const tp = `${cp}.tracks[${ti}]`;
        if (!c.object(track, tp)) return;
        if (c.string(track.id, `${tp}.id`)) {
          if (trackIds.has(track.id as string)) c.fail(`${tp}.id`, `duplicate track id "${String(track.id)}"`);
          trackIds.add(track.id as string);
        }
        c.string(track.name, `${tp}.name`, { nonEmpty: false });
        c.oneOf(track.kind, TRACK_KINDS, `${tp}.kind`);
        c.bool(track.hidden, `${tp}.hidden`);
        c.bool(track.muted, `${tp}.muted`);
        c.bool(track.locked, `${tp}.locked`);
        c.number(track.volume, `${tp}.volume`, { optional: true, min: 0, max: 2 });
        if (!c.array(track.clips, `${tp}.clips`)) return;
        let prev: Obj | null = null;
        track.clips.forEach((clip, ki) => {
          const kp0 = `${tp}.clips[${ki}]`;
          if (!c.object(clip, kp0)) return;
          const kp = typeof clip.id === "string" ? `${kp0} (id "${clip.id}")` : kp0;
          if (typeof clip.id === "string") {
            const seen = clipIds.get(clip.id);
            if (seen) c.fail(kp, `duplicate clip id, also used at ${seen}`);
            else clipIds.set(clip.id, kp0);
          }
          checkClip(c, clip, kp, track, assets, compFps);
          if (prev && typeof prev.from === "number" && typeof clip.from === "number" && typeof prev.durationInFrames === "number") {
            const prevEnd = prev.from + prev.durationInFrames;
            if (clip.from < prev.from) {
              c.fail(kp, `clips must be sorted by "from": starts at ${clip.from}, before the previous clip (${prev.from})`);
            } else if (clip.from < prevEnd) {
              c.fail(kp, `overlaps clip "${String(prev.id)}" (frames ${prev.from}-${prevEnd}); this clip starts at ${clip.from}`);
            }
          }
          prev = clip;
        });
      });
    });
  }

  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return { ok: true, timeline: json as unknown as Timeline };
}
