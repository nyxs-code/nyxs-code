import type { Translations } from "@/lib/i18n";
import { resolveAnimatable, type Animatable, type Keyframe } from "@/lib/video/timelineSchema";

/** True when the value is keyframed rather than fixed. */
export function isKeyframed<T>(v: Animatable<T> | undefined): v is { keyframes: Keyframe<T>[] } {
  return typeof v === "object" && v !== null && Array.isArray((v as { keyframes?: unknown }).keyframes);
}

/** The value shown in the inspector at `frameInClip`. */
export function valueAt(v: Animatable<number> | undefined, frameInClip: number, fallback: number): number {
  if (v === undefined) return fallback;
  const n = resolveAnimatable(v, frameInClip);
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** Whether there is a keyframe exactly at `frameInClip`. */
export function hasKeyAt<T>(v: Animatable<T> | undefined, frameInClip: number): boolean {
  return isKeyframed(v) && v.keyframes.some((k) => k.frame === frameInClip);
}

/** The ◆ button: adds a keyframe at the playhead holding the current value, or removes the one
 *  there. Removing the last keyframe turns the property back into a fixed value. */
export function toggleKeyAt(v: Animatable<number> | undefined, frameInClip: number, fallback: number): Animatable<number> {
  const current = valueAt(v, frameInClip, fallback);
  if (!isKeyframed(v)) {
    return { keyframes: [{ frame: frameInClip, value: current, easing: "ease-in-out" }] };
  }
  if (hasKeyAt(v, frameInClip)) {
    const rest = v.keyframes.filter((k) => k.frame !== frameInClip);
    return rest.length ? { keyframes: rest } : current;
  }
  return { keyframes: sortKeys([...v.keyframes, { frame: frameInClip, value: current, easing: "ease-in-out" }]) };
}

/** Editing a value: a fixed value is replaced; a keyframed one gets (or updates) the keyframe at
 *  the playhead, as in every editor with auto-key on keyframed properties. */
export function setValueAt(v: Animatable<number> | undefined, frameInClip: number, value: number): Animatable<number> {
  if (!isKeyframed(v)) return value;
  const existing = v.keyframes.find((k) => k.frame === frameInClip);
  if (existing) {
    return { keyframes: v.keyframes.map((k) => (k === existing ? { ...k, value } : k)) };
  }
  return { keyframes: sortKeys([...v.keyframes, { frame: frameInClip, value, easing: "ease-in-out" }]) };
}

/** The neighbouring keyframes, for the ‹ › jump buttons. */
export function adjacentKeys(v: Animatable<number> | undefined, frameInClip: number): { prev: number | null; next: number | null } {
  if (!isKeyframed(v)) return { prev: null, next: null };
  let prev: number | null = null;
  let next: number | null = null;
  for (const k of v.keyframes) {
    if (k.frame < frameInClip && (prev === null || k.frame > prev)) prev = k.frame;
    if (k.frame > frameInClip && (next === null || k.frame < next)) next = k.frame;
  }
  return { prev, next };
}

function sortKeys<T>(keys: Keyframe<T>[]): Keyframe<T>[] {
  return [...keys].sort((a, b) => a.frame - b.frame);
}

/** The labels of the ‹ ◆ › keyframe controls. */
export function keyLabels(t: Translations["videoPanel"]) {
  return { add: t.addKeyframe, remove: t.removeKeyframe, prev: t.prevKeyframe, next: t.nextKeyframe };
}
