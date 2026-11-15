import { useMemo, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import * as ops from "@/lib/video/timelineOps";
import {
  beginGesture,
  cancelGesture,
  endGesture,
  getPlayhead,
  getTimelineState,
  timelineActions,
  updateGesture,
} from "@/lib/video/timelineStore";
import type { Composition } from "@/lib/video/timelineSchema";
import { resolveTrackHeight } from "@/lib/video/trackHeights";
import { DRAG_THRESHOLD_PX, HEADER_WIDTH, SNAP_PX, layoutRows, rowAt } from "./geometry";

export interface MarqueeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DragSpec {
  /** Pixels before it counts as a drag (default DRAG_THRESHOLD_PX). */
  threshold?: number;
  /** Started from the header column, which sits at the left edge: don't scroll sideways. */
  fromHeader?: boolean;
  start?(): void;
  move(ev: PointerEvent): void;
  end?(): void;
  cancel?(): void;
  /** Released without dragging. */
  click?(ev: PointerEvent): void;
}

interface Options {
  /** The lanes area: lane coordinates are relative to its top-left (frame 0, first row). */
  lanes: RefObject<HTMLDivElement | null>;
  scroller: RefObject<HTMLDivElement | null>;
  setGuide(frame: number | null): void;
  setMarquee(rect: MarqueeRect | null): void;
  focus(): void;
}

function currentComp(): Composition | null {
  const s = getTimelineState();
  return s.timeline && s.compositionId ? ops.getComposition(s.timeline, s.compositionId) ?? null : null;
}

/**
 * Pointer handlers of the timeline: moving and trimming clips with snapping, marquee selection,
 * scrubbing, and dragging markers, keyframes, transition lengths and tracks. They read the store
 * directly (never stale props) and are stable, so memoized clips don't re-render for them.
 * Every drag is a store gesture: one undo step, cancelled with Escape.
 */
export function useTimelineInteractions({ lanes, scroller, setGuide, setMarquee, focus }: Options) {
  return useMemo(() => {
    const lanePoint = (ev: { clientX: number; clientY: number }) => {
      const r = lanes.current?.getBoundingClientRect();
      return r ? { x: ev.clientX - r.left, y: ev.clientY - r.top } : { x: 0, y: 0 };
    };
    const frameAt = (ev: { clientX: number }) => Math.max(0, lanePoint({ clientX: ev.clientX, clientY: 0 }).x / getTimelineState().zoom);

    // Scrolls when a drag reaches the edge of the visible area.
    const autoScroll = (ev: PointerEvent, verticalOnly = false) => {
      const el = scroller.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const edge = 36;
      let left = 0;
      let top = 0;
      if (verticalOnly) left = 0;
      else if (ev.clientX > r.right - edge) left = Math.min(24, ev.clientX - (r.right - edge));
      else if (ev.clientX < r.left + HEADER_WIDTH + edge) left = -Math.min(24, r.left + HEADER_WIDTH + edge - ev.clientX);
      if (ev.clientY > r.bottom - edge) top = 10;
      else if (ev.clientY < r.top + edge) top = -10;
      if (left || top) el.scrollBy({ left, top });
    };

    const run = (e: ReactPointerEvent, spec: DragSpec) => {
      const x0 = e.clientX;
      const y0 = e.clientY;
      const threshold = spec.threshold ?? DRAG_THRESHOLD_PX;
      let started = false;
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
      };
      const onMove = (ev: PointerEvent) => {
        if (!started) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < threshold) return;
          started = true;
          spec.start?.();
        }
        autoScroll(ev, spec.fromHeader);
        spec.move(ev);
      };
      const onUp = (ev: PointerEvent) => {
        cleanup();
        if (started) spec.end?.();
        else spec.click?.(ev);
      };
      const onCancel = () => {
        cleanup();
        if (started) (spec.cancel ?? spec.end)?.();
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        onCancel();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    };

    const snapFor = (comp: Composition, exclude: ReadonlySet<string>) => {
      const s = getTimelineState();
      return ops.snapTargets(comp, { playhead: getPlayhead(), exclude, inPoint: s.inPoint, outPoint: s.outPoint });
    };
    const snapping = (ev: PointerEvent) => getTimelineState().snapping && !ev.altKey;

    function clipPointerDown(e: ReactPointerEvent, clipId: string, part: "body" | "start" | "end") {
      if (e.button !== 0) return;
      e.stopPropagation();
      focus();
      const s = getTimelineState();
      const comp = currentComp();
      const loc = comp && ops.locateClip(comp, clipId);
      if (!comp || !loc) return;
      const toggle = e.ctrlKey || e.metaKey;
      const additive = e.shiftKey;
      const wasSelected = s.selection.clipIds.includes(clipId);
      const wasMulti = s.selection.clipIds.length > 1;
      if (part === "body") {
        if (toggle) {
          timelineActions.select([clipId], "toggle");
          if (wasSelected) return;
        } else if (additive) timelineActions.select([clipId], "add");
        else if (!wasSelected) timelineActions.select([clipId]);
      } else if (!wasSelected || wasMulti) {
        timelineActions.select([clipId]);
      }
      if (loc.track.locked) return;
      const zoom = s.zoom;
      const p0 = lanePoint(e);

      if (part !== "body") {
        const edgeFrame = part === "start" ? loc.clip.from : ops.clipEnd(loc.clip);
        const targets = snapFor(comp, new Set([clipId]));
        run(e, {
          start: beginGesture,
          move(ev) {
            let frame = edgeFrame + (lanePoint(ev).x - p0.x) / zoom;
            let guide: number | null = null;
            if (snapping(ev)) {
              const snap = ops.computeSnap([frame], targets, SNAP_PX / zoom);
              if (snap) {
                frame += snap.offset;
                guide = snap.target;
              }
            }
            const target = Math.round(frame);
            updateGesture((base, c) => ops.trimClip(base, c, clipId, part, target));
            const now = currentComp();
            const after = now && ops.locateClip(now, clipId)?.clip;
            const landed = after ? (part === "start" ? after.from : ops.clipEnd(after)) : null;
            setGuide(guide !== null && landed === guide ? guide : null);
          },
          end() {
            endGesture();
            setGuide(null);
          },
          cancel() {
            cancelGesture();
            setGuide(null);
          },
        });
        return;
      }

      const ids = getTimelineState().selection.clipIds;
      const { rows } = layoutRows(comp, getTimelineState());
      const row0 = rowAt(rows, p0.y);
      const moving = ids.map((id) => ops.locateClip(comp, id)?.clip).filter((c): c is NonNullable<typeof c> => !!c);
      const targets = snapFor(comp, new Set(ids));
      run(e, {
        start: beginGesture,
        move(ev) {
          const p = lanePoint(ev);
          let dx = (p.x - p0.x) / zoom;
          const row = rowAt(rows, p.y);
          const trackDelta = row && row0 ? row.index - row0.index : 0;
          let guide: number | null = null;
          if (snapping(ev)) {
            const points = moving.flatMap((c) => [c.from + dx, ops.clipEnd(c) + dx]);
            const snap = ops.computeSnap(points, targets, SNAP_PX / zoom);
            if (snap) {
              dx += snap.offset;
              guide = snap.target;
            }
          }
          const delta = Math.round(dx);
          const allowed = ops.constrainMove(comp, ids, delta, trackDelta);
          updateGesture((base, c) => ops.moveClips(base, c, ids, delta, trackDelta));
          setGuide(guide !== null && allowed.delta === delta ? guide : null);
        },
        end() {
          endGesture();
          setGuide(null);
        },
        cancel() {
          cancelGesture();
          setGuide(null);
        },
        click() {
          // A plain click on a clip of a multi-selection selects just that clip.
          if (!toggle && !additive && wasSelected && wasMulti) timelineActions.select([clipId]);
        },
      });
    }

    function lanePointerDown(e: ReactPointerEvent) {
      if (e.button !== 0) return;
      focus();
      const comp = currentComp();
      if (!comp) return;
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const baseSel = additive ? getTimelineState().selection.clipIds : [];
      const { rows } = layoutRows(comp, getTimelineState());
      const p0 = lanePoint(e);
      run(e, {
        move(ev) {
          const p = lanePoint(ev);
          const rect = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
          setMarquee(rect);
          const zoom = getTimelineState().zoom;
          const f0 = rect.x / zoom;
          const f1 = (rect.x + rect.w) / zoom;
          const ids = rows
            .filter((r) => r.top < rect.y + rect.h && r.top + r.height > rect.y)
            .flatMap((r) => r.track.clips.filter((c) => c.from < f1 && ops.clipEnd(c) > f0).map((c) => c.id));
          timelineActions.select([...new Set([...baseSel, ...ids])]);
        },
        end: () => setMarquee(null),
        click() {
          if (!additive) timelineActions.clearSelection();
        },
      });
    }

    function rulerPointerDown(e: ReactPointerEvent) {
      if (e.button !== 0) return;
      focus();
      timelineActions.setPlayhead(frameAt(e));
      run(e, { threshold: 0, move: (ev) => timelineActions.setPlayhead(frameAt(ev)) });
    }

    function markerPointerDown(e: ReactPointerEvent, markerId: string) {
      if (e.button !== 0) return;
      focus();
      const comp = currentComp();
      const marker = comp?.markers.find((m) => m.id === markerId);
      if (!comp || !marker) return;
      timelineActions.selectMarker(markerId);
      const zoom = getTimelineState().zoom;
      const p0 = lanePoint(e);
      const targets = snapFor(comp, new Set()).filter((f) => f !== marker.frame);
      run(e, {
        start: beginGesture,
        move(ev) {
          let frame = marker.frame + (lanePoint(ev).x - p0.x) / zoom;
          let guide: number | null = null;
          if (snapping(ev)) {
            const snap = ops.computeSnap([frame], targets, SNAP_PX / zoom);
            if (snap) {
              frame += snap.offset;
              guide = snap.target;
            }
          }
          const to = Math.round(frame);
          updateGesture((base, c) => ops.moveMarker(base, c, markerId, to));
          setGuide(guide);
        },
        end() {
          endGesture();
          setGuide(null);
        },
        cancel() {
          cancelGesture();
          setGuide(null);
        },
        click: () => timelineActions.setPlayhead(marker.frame),
      });
    }

    function keyframePointerDown(e: ReactPointerEvent, clipId: string, frame: number) {
      if (e.button !== 0) return;
      focus();
      const comp = currentComp();
      const clip = comp && ops.locateClip(comp, clipId)?.clip;
      if (!clip) return;
      const zoom = getTimelineState().zoom;
      const p0 = lanePoint(e);
      run(e, {
        start: beginGesture,
        move(ev) {
          const to = Math.max(0, Math.min(clip.durationInFrames, Math.round(frame + (lanePoint(ev).x - p0.x) / zoom)));
          updateGesture((base, c) => ops.moveKeyframes(base, c, clipId, frame, to));
        },
        end: endGesture,
        cancel: cancelGesture,
        click: () => timelineActions.setPlayhead(clip.from + frame),
      });
    }

    function transitionPointerDown(e: ReactPointerEvent, clipId: string) {
      if (e.button !== 0) return;
      focus();
      const comp = currentComp();
      const transition = comp && ops.locateClip(comp, clipId)?.clip.transitionIn;
      if (!transition) return;
      const zoom = getTimelineState().zoom;
      const p0 = lanePoint(e);
      run(e, {
        threshold: 1,
        start: beginGesture,
        move(ev) {
          const durationInFrames = Math.max(1, Math.round(transition.durationInFrames + (lanePoint(ev).x - p0.x) / zoom));
          updateGesture((base, c) => ops.setTransitionIn(base, c, clipId, { ...transition, durationInFrames }));
        },
        end: endGesture,
        cancel: cancelGesture,
      });
    }

    function trackReorderStart(e: ReactPointerEvent, trackId: string) {
      if (e.button !== 0) return;
      focus();
      const comp = currentComp();
      if (!comp) return;
      const { rows } = layoutRows(comp, getTimelineState());
      run(e, {
        fromHeader: true,
        start: beginGesture,
        move(ev) {
          const row = rowAt(rows, lanePoint(ev).y);
          if (row) updateGesture((base, c) => ops.moveTrack(base, c, trackId, row.index));
        },
        end: endGesture,
        cancel: cancelGesture,
      });
    }

    /** Drag a track header's bottom edge. Heights are view state, so no undo step; Escape restores. */
    function trackResizeStart(e: ReactPointerEvent, trackId: string) {
      if (e.button !== 0) return;
      focus();
      const s = getTimelineState();
      const track = currentComp()?.tracks.find((t) => t.id === trackId);
      if (!track) return;
      const before = s.trackHeights[trackId] ?? null;
      const h0 = resolveTrackHeight(track, s);
      const y0 = lanePoint(e).y;
      run(e, {
        fromHeader: true,
        move: (ev) => timelineActions.setTrackHeight(trackId, h0 + lanePoint(ev).y - y0),
        cancel: () => timelineActions.setTrackHeight(trackId, before),
      });
    }

    return {
      trackResizeStart,
      lanePoint,
      frameAt,
      clipPointerDown,
      lanePointerDown,
      rulerPointerDown,
      markerPointerDown,
      keyframePointerDown,
      transitionPointerDown,
      trackReorderStart,
    };
  }, [lanes, scroller, setGuide, setMarquee, focus]);
}
