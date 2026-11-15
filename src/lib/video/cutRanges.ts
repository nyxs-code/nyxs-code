import type { Caption, CaptionsClip, Clip, Composition, Timeline } from "./timelineSchema";
import { clipEnd, contentEnd, getComposition, splitAt } from "./timelineOps";

/** Cuts for footage editing ("remove silences", "cut by transcript"): ranges of composition
 *  frames taken out of every unlocked track at once, with everything after them moved left, so
 *  picture, sound, captions and markers stay in sync. */

export type FrameRange = [number, number];

/** Sorted, merged, whole-frame ranges with `end > start`. */
export function normalizeRanges(ranges: FrameRange[]): FrameRange[] {
  const sorted = ranges
    .map(([s, e]) => [Math.max(0, Math.round(s)), Math.round(e)] as FrameRange)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out: FrameRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

function cutOne(tl: Timeline, compId: string, [start, end]: FrameRange): Timeline {
  let next = splitAt(tl, compId, end).timeline;
  next = splitAt(next, compId, start).timeline;
  const len = end - start;
  return {
    ...next,
    compositions: next.compositions.map((comp) => {
      if (comp.id !== compId) return comp;
      const tracks = comp.tracks.map((t) => {
        if (t.locked) return t;
        const clips = t.clips
          .filter((c) => !(c.from >= start && clipEnd(c) <= end))
          .map((c) => (c.from >= end ? { ...c, from: c.from - len } : c));
        return { ...t, clips };
      });
      const markers = comp.markers
        .filter((m) => m.frame < start || m.frame >= end)
        .map((m) => (m.frame >= end ? { ...m, frame: m.frame - len } : m));
      const removed = Math.max(0, Math.min(end, comp.durationInFrames) - start);
      const shrunk: Composition = { ...comp, tracks, markers };
      return { ...shrunk, durationInFrames: Math.max(1, contentEnd(shrunk), comp.durationInFrames - removed) };
    }),
  };
}

/** `timeline` with `ranges` (composition frames) removed. Locked tracks are left as they are. */
export function cutRanges(tl: Timeline, compId: string, ranges: FrameRange[]): { timeline: Timeline; removedFrames: number } {
  if (!getComposition(tl, compId)) return { timeline: tl, removedFrames: 0 };
  const list = normalizeRanges(ranges);
  let timeline = tl;
  // From the last range back, so the earlier ranges' frames don't move under us.
  for (let i = list.length - 1; i >= 0; i--) timeline = cutOne(timeline, compId, list[i]);
  return { timeline, removedFrames: list.reduce((n, [s, e]) => n + (e - s), 0) };
}

/**
 * Silences found in an asset (frames at the asset's fps) as composition-frame ranges of one
 * clip that plays it, minus `paddingFrames` kept on each side so speech isn't clipped.
 */
export function silencesInClip(
  clip: Extract<Clip, { type: "video" | "audio" }>,
  compFps: number,
  assetFps: number,
  silences: FrameRange[],
  paddingFrames: number,
): FrameRange[] {
  const rate = clip.type === "video" ? clip.playbackRate ?? 1 : 1;
  const toComp = (assetFrame: number) => clip.from + ((assetFrame * compFps) / assetFps - clip.trimStart) / rate;
  const out: FrameRange[] = [];
  for (const [a, b] of silences) {
    const cs = toComp(a);
    const ce = toComp(b);
    // Silence that reaches the clip's edge needs no padding on that side.
    const start = cs <= clip.from ? clip.from : cs + paddingFrames;
    const end = ce >= clipEnd(clip) ? clipEnd(clip) : ce - paddingFrames;
    if (end - start >= 1) out.push([Math.ceil(start), Math.floor(end)]);
  }
  return normalizeRanges(out);
}

const norm = (w: string) =>
  w
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}']/gu, "");

/** Common filler words, matched as whole tokens. */
export const FILLER_WORDS = ["um", "uh", "uhm", "erm", "er", "ah", "hmm", "mm", "eh", "este", "ehm", "mmm"];

/**
 * The ms ranges (relative to the captions clip) of every occurrence of each phrase in the
 * captions, matched word by word ignoring case, accents and punctuation.
 */
export function phraseRanges(captions: Caption[], phrases: string[], { firstOnly = false } = {}): { phrase: string; startMs: number; endMs: number }[] {
  const words = captions.map((c) => norm(c.text));
  const out: { phrase: string; startMs: number; endMs: number }[] = [];
  for (const phrase of phrases) {
    const target = phrase.split(/\s+/).map(norm).filter(Boolean);
    if (target.length === 0) continue;
    for (let i = 0; i + target.length <= words.length; i++) {
      if (!target.every((t, k) => words[i + k] === t)) continue;
      out.push({ phrase, startMs: captions[i].startMs, endMs: captions[i + target.length - 1].endMs });
      if (firstOnly) break;
      i += target.length - 1;
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Composition-frame ranges of ms ranges inside a captions clip, widened by `paddingMs`. */
export function captionRangesToFrames(clip: CaptionsClip, fps: number, ranges: { startMs: number; endMs: number }[], paddingMs = 0): FrameRange[] {
  return normalizeRanges(
    ranges.map(({ startMs, endMs }) => [
      Math.max(clip.from, clip.from + Math.floor(((startMs - paddingMs) * fps) / 1000)),
      Math.min(clipEnd(clip), clip.from + Math.ceil(((endMs + paddingMs) * fps) / 1000)),
    ]),
  );
}
