/**
 * The video editor's state: the open project's timeline document, selection, playhead, zoom and
 * in/out range, with undo/redo and saving to timeline.json.
 *
 * A module-level store (one Video editor is on screen at a time) read through
 * `useSyncExternalStore`. The playhead lives in its own tiny store so that playback, which moves
 * it every animation frame, only re-renders what draws the playhead, never the clips.
 *
 * Every edit goes through an op from `timelineOps.ts`. Saves are debounced (300 ms). When
 * timeline.json changes on disk and differs from what we wrote (the agent edited it), the new
 * document is loaded as an undoable step and the selection is kept where its ids still exist.
 */
import { useMemo, useSyncExternalStore } from "react";
import { invoke } from "@/lib/ipc";
import { subscribeFsChange } from "@/lib/fsWatch";
import type { Asset, Clip, Composition, Timeline, TrackKind, Transition } from "./timelineSchema";
import { validateTimeline } from "./timelineSchema";
import * as ops from "./timelineOps";
import { DEFAULT_TRACK_VIEW, clampTrackHeight, sanitizeTrackView, type TrackSize } from "./trackHeights";

export interface TimelineSelection {
  clipIds: string[];
  trackId: string | null;
  markerId: string | null;
}

export interface TimelineEditorState {
  project: { workspace: string; slug: string } | null;
  status: "idle" | "loading" | "ready" | "error";
  /** Why the project could not be loaded. */
  error: string | null;
  /** timeline.json was changed outside the editor into something invalid; we keep ours. */
  externalError: string | null;
  saveError: string | null;
  timeline: Timeline | null;
  compositionId: string | null;
  selection: TimelineSelection;
  /** Pixels per frame. */
  zoom: number;
  inPoint: number | null;
  outPoint: number | null;
  snapping: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasClipboard: boolean;
  /** The loaded file had unsorted or overlapping clips; they were fixed (and the fix saved). */
  repaired: boolean;
  /** S/M/L height of tracks not resized by hand. View state, saved per project. */
  trackSize: TrackSize;
  /** Heights set by hand, by track id. View state, saved per project. */
  trackHeights: Record<string, number>;
}

/** Reading and writing timeline.json and watching it; replaced in tests. */
export interface TimelineIo {
  read(workspace: string, slug: string): Promise<string>;
  write(workspace: string, slug: string, json: string): Promise<void>;
  watch(workspace: string, onChange: () => void): () => void;
}

const defaultIo: TimelineIo = {
  read: (workspace, slug) => invoke<string>("video_read_timeline", { workspace, slug }),
  write: (workspace, slug, json) => invoke<void>("video_write_timeline", { workspace, slug, json }),
  watch: (workspace, onChange) => subscribeFsChange(workspace, onChange),
};

let io: TimelineIo = defaultIo;

/** Test hook: swaps the file access. Pass nothing to restore the real one. */
export function setTimelineIo(next?: TimelineIo): void {
  io = next ?? defaultIo;
}

export const SAVE_DEBOUNCE_MS = 300;
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 40;
const HISTORY_LIMIT = 200;
/** Edits with the same coalesce key this close together are one undo step (typing a value). */
const COALESCE_MS = 1000;

const EMPTY_SELECTION: TimelineSelection = { clipIds: [], trackId: null, markerId: null };

const INITIAL: TimelineEditorState = {
  project: null,
  status: "idle",
  error: null,
  externalError: null,
  saveError: null,
  timeline: null,
  compositionId: null,
  selection: EMPTY_SELECTION,
  zoom: 4,
  inPoint: null,
  outPoint: null,
  snapping: true,
  canUndo: false,
  canRedo: false,
  hasClipboard: false,
  repaired: false,
  ...DEFAULT_TRACK_VIEW,
};

let state: TimelineEditorState = INITIAL;
const listeners = new Set<() => void>();

let past: Timeline[] = [];
let future: Timeline[] = [];
let lastCoalesce: { key: string; at: number } | null = null;
let gesture: { base: Timeline } | null = null;
let pendingExternal: Timeline | null = null;
let clipboard: ops.TimelineClipboard | null = null;
/** A saved zoom was just restored: the timeline must not fit the composition over it. */
let zoomRestored = false;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Our recent writes: an fs-change that reads back one of these is our own echo. */
let recentWrites: string[] = [];
let unwatch: (() => void) | null = null;
/** Bumped on open/close so late async results of a previous project are dropped. */
let generation = 0;

function emit(): void {
  for (const l of [...listeners]) l();
}

function setState(patch: Partial<TimelineEditorState>): void {
  state = { ...state, ...patch };
  emit();
}

export function getTimelineState(): TimelineEditorState {
  return state;
}

export function subscribeTimeline(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads a slice of the editor state. The selector must return a stored value or a primitive
 *  (not a new object each call), or the component re-renders forever. */
export function useTimelineStore<T>(selector: (s: TimelineEditorState) => T): T {
  return useSyncExternalStore(subscribeTimeline, () => selector(state), () => selector(INITIAL));
}

export function useTimeline(): Timeline | null {
  return useTimelineStore((s) => s.timeline);
}

/** The composition being edited. */
export function useComposition(): Composition | null {
  const timeline = useTimelineStore((s) => s.timeline);
  const compId = useTimelineStore((s) => s.compositionId);
  return useMemo(() => (timeline && compId ? ops.getComposition(timeline, compId) ?? null : null), [timeline, compId]);
}

export function useSelection(): TimelineSelection {
  return useTimelineStore((s) => s.selection);
}

// Playhead: its own store, see the header comment.

/** "user": scrub, keys, clicks — the panel should seek the player. "player": the player reported
 *  its frame while playing — don't seek it back. */
export type PlayheadSource = "user" | "player";

let playhead = 0;
const playheadListeners = new Set<(frame: number, source: PlayheadSource) => void>();

export function getPlayhead(): number {
  return playhead;
}

export function setPlayhead(frame: number, source: PlayheadSource = "user"): void {
  const comp = currentComposition();
  const max = comp ? Math.max(0, comp.durationInFrames - 1) : Number.MAX_SAFE_INTEGER;
  const next = Math.max(0, Math.min(max, Math.round(frame)));
  if (next === playhead) return;
  playhead = next;
  for (const l of [...playheadListeners]) l(next, source);
}

/** Calls `listener(frame, source)` on every playhead move. */
export function subscribePlayhead(listener: (frame: number, source: PlayheadSource) => void): () => void {
  playheadListeners.add(listener);
  return () => playheadListeners.delete(listener);
}

const subscribePlayheadPlain = (cb: () => void) => subscribePlayhead(() => cb());

export function usePlayhead(): number {
  return useSyncExternalStore(subscribePlayheadPlain, getPlayhead, () => 0);
}

// Document changes.

function currentComposition(): Composition | null {
  const { timeline, compositionId } = state;
  return timeline && compositionId ? ops.getComposition(timeline, compositionId) ?? null : null;
}

function pruneSelection(timeline: Timeline, compositionId: string | null, sel: TimelineSelection): TimelineSelection {
  const comp = compositionId ? ops.getComposition(timeline, compositionId) : undefined;
  if (!comp) return EMPTY_SELECTION;
  const clipIds = sel.clipIds.filter((id) => !!ops.locateClip(comp, id));
  const trackId = sel.trackId && comp.tracks.some((t) => t.id === sel.trackId) ? sel.trackId : null;
  const markerId = sel.markerId && comp.markers.some((m) => m.id === sel.markerId) ? sel.markerId : null;
  if (clipIds.length === sel.clipIds.length && trackId === sel.trackId && markerId === sel.markerId) return sel;
  return { clipIds, trackId, markerId };
}

function historyFlags(): Pick<TimelineEditorState, "canUndo" | "canRedo"> {
  return { canUndo: past.length > 0, canRedo: future.length > 0 };
}

function setDocument(timeline: Timeline, extra: Partial<TimelineEditorState> = {}): void {
  const compositionId =
    state.compositionId && timeline.compositions.some((c) => c.id === state.compositionId)
      ? state.compositionId
      : timeline.compositions[0]?.id ?? null;
  const selection = pruneSelection(timeline, compositionId, extra.selection ?? state.selection);
  setState({ ...extra, timeline, compositionId, selection, ...historyFlags() });
}

function pushPast(tl: Timeline): void {
  past.push(tl);
  if (past.length > HISTORY_LIMIT) past = past.slice(past.length - HISTORY_LIMIT);
  future = [];
}

/**
 * Makes `next` the document as one undo step. Edits passing the same `coalesce` key within a
 * second merge into one step (typing in a field). During a gesture the document follows `next`
 * without history; `endGesture` records the whole gesture as one step.
 */
export function commit(proposed: Timeline, opts: { coalesce?: string; sticky?: boolean; selection?: TimelineSelection } = {}): boolean {
  // Edits from outside timelineOps (panel, captions) can't leave a broken track behind.
  const next = ops.repairTimeline(proposed);
  const cur = state.timeline;
  if (!cur || next === cur) {
    if (opts.selection) setState({ selection: opts.selection });
    return false;
  }
  if (!gesture) {
    const now = Date.now();
    // `sticky` (the agent's batch) merges at any distance; anything in between ends the step, so
    // an undo in the middle of a batch never takes the user's own edit with it.
    const merge = !!opts.coalesce && lastCoalesce?.key === opts.coalesce && (!!opts.sticky || now - lastCoalesce.at < COALESCE_MS);
    if (!merge) pushPast(cur);
    else future = [];
    lastCoalesce = opts.coalesce ? { key: opts.coalesce, at: now } : null;
  }
  setDocument(next, opts.selection ? { selection: opts.selection } : {});
  scheduleSave();
  return true;
}

/** Runs an op against the current document and composition and commits its result. */
export function apply(fn: (tl: Timeline, compId: string) => Timeline, opts?: { coalesce?: string; selection?: TimelineSelection }): boolean {
  const { timeline, compositionId } = state;
  if (!timeline || !compositionId) return false;
  return commit(fn(timeline, compositionId), opts);
}

// Gestures (drags): the document is recomputed from the state at the start of the drag on every
// pointer move, and the whole drag is a single undo step.

export function beginGesture(): void {
  if (!state.timeline || gesture) return;
  gesture = { base: state.timeline };
}

export function updateGesture(fn: (base: Timeline, compId: string) => Timeline): void {
  if (!gesture || !state.compositionId) return;
  const next = ops.repairTimeline(fn(gesture.base, state.compositionId));
  if (next === state.timeline) return;
  setDocument(next);
  scheduleSave();
}

export function endGesture(): void {
  if (!gesture) return;
  const { base } = gesture;
  gesture = null;
  if (state.timeline && state.timeline !== base) {
    pushPast(base);
    lastCoalesce = null;
    setState(historyFlags());
  }
  if (pendingExternal) {
    const ext = pendingExternal;
    pendingExternal = null;
    applyExternal(ext);
  }
}

export function cancelGesture(): void {
  if (!gesture) return;
  const { base } = gesture;
  gesture = null;
  if (state.timeline !== base) {
    setDocument(base);
    scheduleSave();
  }
}

export function isGestureActive(): boolean {
  return gesture !== null;
}

/** Puts undo steps made before the document reached this store (the agent's edits while the
 *  project was out of sight) under the ones it already has. */
export function seedHistory(steps: Timeline[]): void {
  if (steps.length === 0) return;
  past = [...steps, ...past].slice(-HISTORY_LIMIT);
  setState(historyFlags());
}

/** Whether the document has edits timeline.json doesn't have yet. */
export function hasUnsavedEdits(): boolean {
  if (!state.project || !state.timeline) return false;
  return saveTimer !== null || recentWrites[recentWrites.length - 1] !== serializeTimeline(state.timeline);
}

export function undo(): void {
  if (gesture || past.length === 0 || !state.timeline) return;
  future.push(state.timeline);
  const prev = past.pop()!;
  lastCoalesce = null;
  setDocument(prev);
  scheduleSave();
}

export function redo(): void {
  if (gesture || future.length === 0 || !state.timeline) return;
  past.push(state.timeline);
  const next = future.pop()!;
  lastCoalesce = null;
  setDocument(next);
  scheduleSave();
}

// Saving and reloading.

export function serializeTimeline(tl: Timeline): string {
  return `${JSON.stringify(tl, null, 2)}\n`;
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, SAVE_DEBOUNCE_MS);
}

function rememberWrite(json: string): void {
  recentWrites = [...recentWrites.filter((w) => w !== json), json].slice(-5);
}

/** Writes the document now if it changed since the last write (also called on close). */
export async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const { project, timeline } = state;
  if (!project || !timeline) return;
  const json = serializeTimeline(timeline);
  if (recentWrites[recentWrites.length - 1] === json) return;
  rememberWrite(json);
  const gen = generation;
  try {
    await io.write(project.workspace, project.slug, json);
    if (gen === generation && state.saveError) setState({ saveError: null });
  } catch (e) {
    if (gen === generation) setState({ saveError: String(e) });
  }
}

function applyExternal(next: Timeline): void {
  if (!state.timeline) return;
  if (saveTimer) {
    // The agent's version wins over an edit made in the last 300 ms.
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pushPast(state.timeline);
  lastCoalesce = null;
  rememberWrite(serializeTimeline(next));
  setDocument(next, { externalError: null });
}

/** Re-reads timeline.json and loads it when someone else changed it. */
export async function checkExternalChange(): Promise<void> {
  const { project } = state;
  if (!project || !state.timeline) return;
  const gen = generation;
  let text: string;
  try {
    text = await io.read(project.workspace, project.slug);
  } catch {
    return;
  }
  if (gen !== generation || !state.timeline) return;
  if (recentWrites.includes(text)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    setState({ externalError: String(e) });
    return;
  }
  const result = validateOrRepair(parsed);
  if (!result.ok) {
    setState({ externalError: result.errors.slice(0, 5).join("\n") });
    return;
  }
  const normalized = serializeTimeline(result.timeline);
  rememberWrite(text);
  if (normalized === serializeTimeline(state.timeline)) {
    rememberWrite(normalized);
    if (state.externalError) setState({ externalError: null });
    return;
  }
  if (gesture) {
    pendingExternal = result.timeline;
    return;
  }
  applyExternal(result.timeline);
}

/** Validates a parsed timeline.json; one that only fails on clip order or overlaps is repaired
 *  (see `repairTimeline`) instead of rejected. */
function validateOrRepair(parsed: unknown): { ok: true; timeline: Timeline; repaired: boolean } | { ok: false; errors: string[] } {
  const first = validateTimeline(parsed);
  if (first.ok) return { ...first, repaired: false };
  const looksLikeTimeline =
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as Timeline).compositions) &&
    (parsed as Timeline).compositions.every((c) => Array.isArray(c?.tracks) && c.tracks.every((t) => Array.isArray(t?.clips)));
  if (!looksLikeTimeline) return first;
  try {
    const second = validateTimeline(ops.repairTimeline(parsed as Timeline));
    return second.ok ? { ...second, repaired: true } : first;
  } catch {
    return first;
  }
}

/** True once after a saved zoom was restored (the first fit of a project skips itself). */
export function takeZoomRestored(): boolean {
  const restored = zoomRestored;
  zoomRestored = false;
  return restored;
}

function resetHistory(): void {
  zoomRestored = false;
  past = [];
  future = [];
  lastCoalesce = null;
  gesture = null;
  pendingExternal = null;
  recentWrites = [];
}

/** Loads a project's timeline.json into the editor and starts following outside changes. */
export async function openTimeline(workspace: string, slug: string, opts: { compositionId?: string } = {}): Promise<void> {
  if (state.project?.workspace === workspace && state.project.slug === slug && state.status !== "error") {
    if (opts.compositionId) setComposition(opts.compositionId);
    return;
  }
  await closeTimeline();
  const gen = ++generation;
  setState({ ...INITIAL, zoom: state.zoom, snapping: state.snapping, hasClipboard: state.hasClipboard, project: { workspace, slug }, status: "loading" });
  let text: string;
  try {
    text = await io.read(workspace, slug);
  } catch (e) {
    if (gen === generation) setState({ status: "error", error: String(e) });
    return;
  }
  if (gen !== generation) return;
  let result;
  try {
    result = validateOrRepair(JSON.parse(text));
  } catch (e) {
    setState({ status: "error", error: String(e) });
    return;
  }
  if (!result.ok) {
    setState({ status: "error", error: result.errors.slice(0, 5).join("\n") });
    return;
  }
  rememberWrite(text);
  const timeline = result.timeline;
  const compositionId =
    opts.compositionId && timeline.compositions.some((c) => c.id === opts.compositionId)
      ? opts.compositionId
      : timeline.compositions[0]?.id ?? null;
  playhead = 0;
  setState({ status: "ready", timeline, compositionId, selection: EMPTY_SELECTION, repaired: result.repaired, ...historyFlags() });
  // A file formatted differently (an agent's script) is not an edit: closing must leave it as is.
  if (result.repaired) scheduleSave();
  else rememberWrite(serializeTimeline(timeline));
  for (const l of [...playheadListeners]) l(0, "user");
  unwatch = io.watch(workspace, () => void checkExternalChange());
}

/** Saves pending edits and forgets the project. */
export async function closeTimeline(): Promise<void> {
  if (unwatch) {
    unwatch();
    unwatch = null;
  }
  if (state.project) await flushSave();
  generation++;
  resetHistory();
  setState({ ...INITIAL, zoom: state.zoom, snapping: state.snapping, hasClipboard: state.hasClipboard });
}

export function setComposition(compositionId: string): void {
  if (!state.timeline?.compositions.some((c) => c.id === compositionId) || compositionId === state.compositionId) return;
  setState({ compositionId, selection: EMPTY_SELECTION, inPoint: null, outPoint: null });
  setPlayhead(0);
}

// Actions the timeline UI, the inspector and the panel call.

function selectedIds(): string[] {
  return state.selection.clipIds;
}

function selectClips(clipIds: string[]): TimelineSelection {
  return { clipIds, trackId: null, markerId: null };
}

export const SHOW_CLIP_PROPERTIES_EVENT = "nyxs:video-clip-properties";

export const timelineActions = {
  undo,
  redo,
  apply,
  commit,
  beginGesture,
  updateGesture,
  endGesture,
  cancelGesture,
  setPlayhead,
  setComposition,

  /** `replace` (plain click), `add` (Shift), `toggle` (Ctrl). */
  select(clipIds: string[], mode: "replace" | "add" | "toggle" = "replace"): void {
    let next: string[];
    if (mode === "replace") next = clipIds;
    else if (mode === "add") next = [...new Set([...state.selection.clipIds, ...clipIds])];
    else {
      const cur = new Set(state.selection.clipIds);
      for (const id of clipIds) {
        if (cur.has(id)) cur.delete(id);
        else cur.add(id);
      }
      next = [...cur];
    }
    const same = next.length === state.selection.clipIds.length && next.every((id, i) => id === state.selection.clipIds[i]);
    if (same && !state.selection.trackId && !state.selection.markerId) return;
    setState({ selection: selectClips(next) });
  },
  selectAll(): void {
    const comp = currentComposition();
    if (comp) setState({ selection: selectClips(comp.tracks.flatMap((t) => t.clips.map((c) => c.id))) });
  },
  clearSelection(): void {
    if (state.selection !== EMPTY_SELECTION) setState({ selection: EMPTY_SELECTION });
  },
  selectTrack(trackId: string | null): void {
    setState({ selection: { clipIds: [], trackId, markerId: null } });
  },
  selectMarker(markerId: string | null): void {
    setState({ selection: { clipIds: [], trackId: null, markerId } });
  },

  /** Puts back what `projectResume` saved for this project. */
  restoreView(saved: { zoom?: number; trackSize?: unknown; trackHeights?: unknown }): void {
    if (saved.zoom) {
      zoomRestored = true;
      timelineActions.setZoom(saved.zoom);
    }
    setState(sanitizeTrackView(saved));
  },
  /** Global S/M/L: every track takes that size, so heights set by hand are dropped. */
  setTrackSize(trackSize: TrackSize): void {
    setState({ trackSize, trackHeights: {} });
  },
  /** Height of one track by hand; `null` goes back to the S/M/L size. */
  setTrackHeight(trackId: string, height: number | null): void {
    const { [trackId]: current, ...others } = state.trackHeights;
    if (height === null) {
      if (current !== undefined) setState({ trackHeights: others });
      return;
    }
    const next = clampTrackHeight(height);
    if (next !== current) setState({ trackHeights: { ...others, [trackId]: next } });
  },
  setZoom(zoom: number): void {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    if (z !== state.zoom) setState({ zoom: z });
  },
  setSnapping(snapping: boolean): void {
    setState({ snapping });
  },

  /** Adds a clip for a media-bin asset where it was dropped. */
  placeAsset(assetId: string, trackId: string | null, frame: number, newTrackName?: string): string | null {
    const tl = state.timeline;
    const comp = currentComposition();
    const asset = tl?.assets.find((a) => a.id === assetId);
    if (!tl || !comp || !asset) return null;
    const clip = ops.clipFromAsset(asset, comp, frame);
    return clip ? timelineActions.placeClip(clip, trackId, newTrackName) : null;
  },
  /** Adds a ready-made clip (text preset, shape…) on the track, or a compatible one. */
  placeClip(clip: Clip, trackId: string | null, newTrackName?: string): string | null {
    let placed: string | null = null;
    apply((tl, compId) => {
      const r = ops.placeClip(tl, compId, clip, trackId, newTrackName);
      placed = r.clipId;
      return r.timeline;
    });
    if (placed) setState({ selection: selectClips([placed]) });
    return placed;
  },

  deleteSelected(ripple = false): void {
    const ids = selectedIds();
    const comp = currentComposition();
    if (ids.length) {
      apply((tl, c) => (ripple ? ops.rippleDelete(tl, c, ids) : ops.removeClips(tl, c, ids)));
    } else if (state.selection.markerId && comp) {
      const markerId = state.selection.markerId;
      apply((tl, c) => ops.removeMarker(tl, c, markerId));
    }
  },
  /** Splits the selected clips at the playhead, or everything under it when none is selected. */
  splitAtPlayhead(): void {
    const ids = selectedIds();
    apply((tl, c) => ops.splitAt(tl, c, playhead, ids).timeline);
  },
  duplicateSelected(): void {
    let ids: string[] = [];
    apply((tl, c) => {
      const r = ops.duplicateClips(tl, c, selectedIds());
      ids = r.ids;
      return r.timeline;
    });
    if (ids.length) setState({ selection: selectClips(ids) });
  },
  copy(): boolean {
    const comp = currentComposition();
    const copied = comp ? ops.copyClips(comp, selectedIds()) : null;
    if (!copied) return false;
    clipboard = copied;
    setState({ hasClipboard: true });
    return true;
  },
  cut(): void {
    if (timelineActions.copy()) timelineActions.deleteSelected();
  },
  /** Pastes at the playhead. */
  paste(): void {
    const board = clipboard;
    if (!board) return;
    let ids: string[] = [];
    apply((tl, c) => {
      const r = ops.pasteClips(tl, c, board, playhead);
      ids = r.ids;
      return r.timeline;
    });
    if (ids.length) setState({ selection: selectClips(ids) });
  },
  nudge(frames: number): void {
    const ids = selectedIds();
    if (ids.length) apply((tl, c) => ops.nudgeClips(tl, c, ids, frames), { coalesce: "nudge" });
  },
  updateClip(clipId: string, patch: Partial<Clip>, coalesce?: string): boolean {
    return apply((tl, c) => ops.updateClip(tl, c, clipId, patch), { coalesce });
  },
  updateComposition(patch: Partial<Omit<Composition, "id" | "tracks" | "markers">>, coalesce?: string): boolean {
    return apply((tl, c) => ops.updateComposition(tl, c, patch), { coalesce });
  },
  setTransition(clipId: string, transition: Transition | null, coalesce?: string): void {
    apply((tl, c) => ops.setTransitionIn(tl, c, clipId, transition), { coalesce });
  },

  addTrack(kind: TrackKind, name?: string, index?: number): string | null {
    let id: string | null = null;
    apply((tl, c) => {
      const r = ops.addTrack(tl, c, kind, { name, index });
      id = r.trackId;
      return r.timeline;
    });
    return id;
  },
  removeTrack(trackId: string): void {
    apply((tl, c) => ops.removeTrack(tl, c, trackId));
  },
  renameTrack(trackId: string, name: string): void {
    apply((tl, c) => ops.renameTrack(tl, c, trackId, name));
  },
  moveTrack(trackId: string, toIndex: number): void {
    apply((tl, c) => ops.moveTrack(tl, c, trackId, toIndex));
  },
  setTrackProps(trackId: string, patch: ops.TrackFlags, coalesce?: string): void {
    apply((tl, c) => ops.setTrackProps(tl, c, trackId, patch), { coalesce });
  },

  /** M: adds a marker at the playhead, or removes the one already there. */
  toggleMarkerAtPlayhead(): void {
    const comp = currentComposition();
    if (!comp) return;
    const existing = comp.markers.find((m) => m.frame === playhead);
    if (existing) apply((tl, c) => ops.removeMarker(tl, c, existing.id));
    else apply((tl, c) => ops.addMarker(tl, c, playhead).timeline);
  },
  updateMarker(markerId: string, patch: { frame?: number; label?: string; color?: string }): void {
    apply((tl, c) => ops.updateMarker(tl, c, markerId, patch));
  },
  removeMarker(markerId: string): void {
    apply((tl, c) => ops.removeMarker(tl, c, markerId));
  },

  /** I / O at the playhead; the same key again on the same frame clears it. */
  markIn(frame: number = playhead): void {
    setState(ops.setInPoint(state, state.inPoint === frame ? null : frame));
  },
  markOut(frame: number = playhead): void {
    setState(ops.setOutPoint(state, state.outPoint === frame ? null : frame));
  },
  setInOut(inPoint: number | null, outPoint: number | null): void {
    setState({ inPoint, outPoint });
  },

  addKeyframe(clipId: string, path: ops.AnimPath, frameInClip?: number, value?: number): void {
    const comp = currentComposition();
    const loc = comp ? ops.locateClip(comp, clipId) : null;
    if (!loc) return;
    const at = frameInClip ?? playhead - loc.clip.from;
    apply((tl, c) => ops.addKeyframe(tl, c, clipId, path, at, value));
  },
  removeKeyframes(clipId: string, frameInClip: number, paths?: ops.AnimPath[]): void {
    apply((tl, c) => ops.removeKeyframes(tl, c, clipId, frameInClip, paths));
  },

  /** Moves a video clip's sound to an audio clip in sync with it; selects the new audio clip. */
  detachAudio(clipId: string, newTrackName?: string): string | null {
    let audioId: string | null = null;
    apply((tl, c) => {
      const r = ops.detachAudio(tl, c, clipId, newTrackName);
      audioId = r.audioClipId;
      return r.timeline;
    });
    if (audioId) setState({ selection: selectClips([audioId]) });
    return audioId;
  },
  /** Cuts frame ranges out of a clip and closes the gaps (remove silences, cut by transcript). */
  rippleDeleteRanges(clipId: string, ranges: [number, number][]): number {
    let removed = 0;
    apply((tl, c) => {
      const r = ops.rippleDeleteRanges(tl, c, clipId, ranges);
      removed = r.removedFrames;
      return r.timeline;
    });
    return removed;
  },
  /** Trims the selected clips to the in/out range, or the whole composition when none is selected. */
  trimToInOut(): void {
    const comp = currentComposition();
    if (!comp || (state.inPoint === null && state.outPoint === null)) return;
    const a = state.inPoint ?? 0;
    const b = state.outPoint ?? comp.durationInFrames;
    const ids = selectedIds();
    if (ids.length) apply((tl, c) => ops.trimClipsToRange(tl, c, ids, a, b));
    else {
      if (apply((tl, c) => ops.trimCompositionToRange(tl, c, a, b))) setState({ inPoint: null, outPoint: null });
      setPlayhead(playhead - a);
    }
  },
  /** Holds `frame` of a video clip for `holdFrames`, showing `still` (a render of that frame). */
  freezeFrame(clipId: string, frame: number, still: Asset, holdFrames: number): string | null {
    let holdId: string | null = null;
    apply((tl, c) => {
      const r = ops.freezeFrame(tl, c, clipId, frame, still, holdFrames);
      holdId = r.holdClipId;
      return r.timeline;
    });
    if (holdId) setState({ selection: selectClips([holdId]) });
    return holdId;
  },
  setClipSpeed(clipId: string, rate: number, coalesce?: string): void {
    apply((tl, c) => ops.setClipSpeed(tl, c, clipId, rate), { coalesce });
  },

  /** Sorts tracks and moves overlapping clips to free tracks (one undo step). */
  repair(): boolean {
    const ok = apply((tl) => ops.repairTimeline(tl));
    if (state.repaired) setState({ repaired: false });
    return ok;
  },

  /** Selects the clip and asks the panel to show its properties in the inspector. */
  showProperties(clipId: string): void {
    setState({ selection: selectClips([clipId]) });
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SHOW_CLIP_PROPERTIES_EVENT, { detail: { clipId } }));
  },
};

/** Test hook: back to a blank store. */
export function resetTimelineStoreForTests(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (unwatch) unwatch();
  unwatch = null;
  generation++;
  resetHistory();
  clipboard = null;
  playhead = 0;
  state = INITIAL;
  emit();
}
