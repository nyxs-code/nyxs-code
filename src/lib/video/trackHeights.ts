import type { TrackKind } from "./timelineSchema";

/** Track heights are view state of the editor, saved per project; never part of timeline.json. */
export type TrackSize = "s" | "m" | "l";

export const TRACK_SIZES: readonly TrackSize[] = ["s", "m", "l"];
export const MIN_TRACK_HEIGHT = 28;
export const MAX_TRACK_HEIGHT = 160;

const HEIGHTS: Record<TrackSize, Record<TrackKind, number>> = {
  s: { video: 36, audio: 32, text: 28, overlay: 28 },
  m: { video: 60, audio: 52, text: 40, overlay: 44 },
  l: { video: 96, audio: 84, text: 60, overlay: 68 },
};

/** The height of a track nobody resized by hand. */
export function defaultTrackHeight(kind: TrackKind, size: TrackSize): number {
  return HEIGHTS[size][kind];
}

export function clampTrackHeight(height: number): number {
  return Math.round(Math.max(MIN_TRACK_HEIGHT, Math.min(MAX_TRACK_HEIGHT, height)));
}

export interface TrackHeightView {
  trackSize: TrackSize;
  /** Heights set by hand, by track id. */
  trackHeights: Record<string, number>;
}

export const DEFAULT_TRACK_VIEW: TrackHeightView = { trackSize: "m", trackHeights: {} };

export function resolveTrackHeight(track: { id: string; kind: TrackKind }, view: TrackHeightView): number {
  return view.trackHeights[track.id] ?? defaultTrackHeight(track.kind, view.trackSize);
}

/** What saved view state can be trusted: it comes from storage, so nothing about it is assumed. */
export function sanitizeTrackView(saved: { trackSize?: unknown; trackHeights?: unknown }): TrackHeightView {
  const trackSize = TRACK_SIZES.includes(saved.trackSize as TrackSize) ? (saved.trackSize as TrackSize) : DEFAULT_TRACK_VIEW.trackSize;
  const trackHeights: Record<string, number> = {};
  if (typeof saved.trackHeights === "object" && saved.trackHeights !== null) {
    for (const [id, h] of Object.entries(saved.trackHeights)) {
      if (typeof h === "number" && Number.isFinite(h)) trackHeights[id] = clampTrackHeight(h);
    }
  }
  return { trackSize, trackHeights };
}
