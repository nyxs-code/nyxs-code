import type { Composition, Track } from "@/lib/video/timelineSchema";
import { DEFAULT_TRACK_VIEW, resolveTrackHeight, type TrackHeightView } from "@/lib/video/trackHeights";

/** Width of the track header column. */
export const HEADER_WIDTH = 176;
export const RULER_HEIGHT = 28;
/** Empty space after the composition end so clips can be dragged past it. */
export const TAIL_PX = 240;
/** Pointer travel before a press turns into a drag. */
export const DRAG_THRESHOLD_PX = 3;
/** How close (in px) an edge must come to a snap target to stick. */
export const SNAP_PX = 8;
/** Width of the grab zone at each end of a clip for trimming. */
export const TRIM_HANDLE_PX = 6;

export interface TrackRow {
  track: Track;
  /** Index in `composition.tracks` (0 = bottom layer). */
  index: number;
  top: number;
  height: number;
}

/** Rows top to bottom: the top layer (last track) is drawn first, like other editors. */
export function layoutRows(comp: Composition, view: TrackHeightView = DEFAULT_TRACK_VIEW): { rows: TrackRow[]; height: number } {
  const rows: TrackRow[] = [];
  let top = 0;
  for (let index = comp.tracks.length - 1; index >= 0; index--) {
    const track = comp.tracks[index];
    const height = resolveTrackHeight(track, view);
    rows.push({ track, index, top, height });
    top += height;
  }
  return { rows, height: top };
}

/** The row under a y offset (relative to the first row), clamped to the first/last row. */
export function rowAt(rows: TrackRow[], y: number): TrackRow | null {
  if (rows.length === 0) return null;
  if (y < 0) return rows[0];
  for (const r of rows) if (y < r.top + r.height) return r;
  return rows[rows.length - 1];
}

/** Nice ruler steps in frames, given fps: frames, then seconds, then minutes. */
function stepCandidates(fps: number): number[] {
  const f = Math.max(1, Math.round(fps));
  const frameSteps = [1, 2, 5, 10].filter((s) => s < f);
  if (f >= 24) frameSteps.push(Math.round(f / 2));
  const secs = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * f);
  return [...new Set([...frameSteps, ...secs])].sort((a, b) => a - b);
}

/** Major tick step (frames) so labels sit at least `minPx` apart, and how many minor ticks
 *  divide it. */
export function rulerStep(zoom: number, fps: number, minPx = 90): { major: number; minor: number } {
  const steps = stepCandidates(fps);
  const major = steps.find((s) => s * zoom >= minPx) ?? steps[steps.length - 1];
  let minor = 1;
  for (const n of [10, 5, 4, 2]) {
    const sub = major / n;
    if (Number.isInteger(sub) && sub * zoom >= 8) {
      minor = n;
      break;
    }
  }
  return { major, minor };
}

/** Ruler label for a frame: `0:05`, `1:02:05`, or `0:05:12` (with frames) when the step is under
 *  a second. */
export function rulerLabel(frame: number, fps: number, withFrames: boolean): string {
  const f = Math.max(1, Math.round(fps));
  const totalSecs = Math.floor(frame / f);
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  const base = h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
  return withFrames ? `${base}:${two(frame % f)}` : base;
}

/** Zoom that fits `frames` in `widthPx`. */
export function fitZoom(frames: number, widthPx: number): number {
  return Math.max(0.0001, (widthPx - 24) / Math.max(1, frames));
}

/** Clips of a sorted track that overlap [fromFrame, toFrame). */
export function visibleClips<T extends { from: number; durationInFrames: number }>(clips: T[], fromFrame: number, toFrame: number): T[] {
  // Clips don't overlap, so their ends are sorted too: binary search the first one ending after
  // `fromFrame`.
  let lo = 0;
  let hi = clips.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clips[mid].from + clips[mid].durationInFrames <= fromFrame) lo = mid + 1;
    else hi = mid;
  }
  const out: T[] = [];
  for (let i = lo; i < clips.length && clips[i].from < toFrame; i++) out.push(clips[i]);
  return out;
}
