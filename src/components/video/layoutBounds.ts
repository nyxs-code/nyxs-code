/** How far the editor's splitters can go. Pure, so the window can shrink without losing what
 *  the user chose: the saved sizes stay as they are and only what is shown gets fitted. */

/** The timeline's toolbar (36) + ruler (28) + one video track (60) + a scrollbar. */
export const TIMELINE_MIN = 136;
const TOP_BAR = 44;
const TRANSPORT = 40;
/** The canvas never gets smaller than this by moving a splitter. */
const CANVAS_MIN = 120;
const PLAYER_MIN_WIDTH = 240;
const BIN_RANGE: [number, number] = [160, 420];
const INSPECTOR_RANGE: [number, number] = [220, 480];

/** Below these widths of the editor the side columns fold away (without changing the saved
 *  layout), so the player keeps a usable size in a narrow panel. */
export const NARROW_BIN = 760;
export const NARROW_INSPECTOR = 560;

export type VideoSplit = "bin" | "inspector" | "timeline";

export interface EditorBox {
  width: number;
  height: number;
}

export interface SplitSizes {
  bin: number;
  inspector: number;
  timeline: number;
}

export interface SideColumns {
  showBin: boolean;
  showInspector: boolean;
}

export function sideColumns(binOpen: boolean, inspectorOpen: boolean, box: EditorBox): SideColumns {
  return { showBin: binOpen && box.width >= NARROW_BIN, showInspector: inspectorOpen && box.width >= NARROW_INSPECTOR };
}

const within = (v: number, [min, max]: [number, number]) => Math.round(Math.min(max, Math.max(min, v)));

/** The range of one splitter now; a side column also leaves room for the other and the player. */
export function splitRange(kind: VideoSplit, box: EditorBox, sizes: SplitSizes, sides: SideColumns): [number, number] {
  if (kind === "timeline") return [TIMELINE_MIN, Math.max(TIMELINE_MIN, box.height - TOP_BAR - TRANSPORT - CANVAS_MIN)];
  const [min, max] = kind === "bin" ? BIN_RANGE : INSPECTOR_RANGE;
  const other = kind === "bin" ? (sides.showInspector ? sizes.inspector : 0) : sides.showBin ? sizes.bin : 0;
  return [min, Math.max(min, Math.min(max, box.width - other - PLAYER_MIN_WIDTH))];
}

/** What to show for the saved sizes in this box. */
export function fitSizes(saved: SplitSizes, box: EditorBox, sides: SideColumns): SplitSizes {
  const timeline = within(saved.timeline, splitRange("timeline", box, saved, sides));
  // The bin gives way first when the window is too narrow for both.
  const inspector = within(saved.inspector, splitRange("inspector", box, { ...saved, bin: BIN_RANGE[0] }, sides));
  const bin = within(saved.bin, splitRange("bin", box, { ...saved, inspector }, sides));
  return { bin, inspector, timeline };
}

/** The size a key on a focused splitter asks for: the arrow towards growing adds, Shift is
 *  bigger steps, Home and End go to the ends of the range. Null for any other key. */
export function keyedSize(kind: VideoSplit, key: string, shift: boolean, now: number, [min, max]: [number, number]): number | null {
  const grow = kind === "timeline" ? "ArrowUp" : kind === "bin" ? "ArrowRight" : "ArrowLeft";
  const shrink = kind === "timeline" ? "ArrowDown" : kind === "bin" ? "ArrowLeft" : "ArrowRight";
  const step = shift ? 50 : 10;
  if (key === grow) return within(now + step, [min, max]);
  if (key === shrink) return within(now - step, [min, max]);
  if (key === "Home") return min;
  if (key === "End") return max;
  return null;
}

export { within as clampToRange };
