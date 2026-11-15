import { useCallback, useEffect, useRef, useState } from "react";
import { accountKey } from "@/lib/accountScope";
import { clampToRange, fitSizes, keyedSize, sideColumns, splitRange, type EditorBox, type SplitSizes, type VideoSplit } from "./layoutBounds";

const LAYOUT_KEY = "nyxs.video.layout";

/** Saved sizes of the editor's areas in px; the player takes what is left. */
export interface VideoLayout extends SplitSizes {
  binOpen: boolean;
  inspectorOpen: boolean;
}

export const DEFAULT_VIDEO_LAYOUT: VideoLayout = { bin: 220, inspector: 280, timeline: 240, binOpen: true, inspectorOpen: true };

function load(): VideoLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(accountKey(LAYOUT_KEY)) ?? "null") as Partial<VideoLayout> | null;
    if (!saved) return DEFAULT_VIDEO_LAYOUT;
    const num = (kind: VideoSplit) => (typeof saved[kind] === "number" && Number.isFinite(saved[kind]) ? saved[kind] : DEFAULT_VIDEO_LAYOUT[kind]);
    return {
      bin: num("bin"),
      inspector: num("inspector"),
      timeline: num("timeline"),
      binOpen: saved.binOpen !== false,
      inspectorOpen: saved.inspectorOpen !== false,
    };
  } catch {
    return DEFAULT_VIDEO_LAYOUT;
  }
}

function persist(l: VideoLayout) {
  try { localStorage.setItem(accountKey(LAYOUT_KEY), JSON.stringify(l)); } catch { /* storage unavailable */ }
}

const fitted = (l: VideoLayout, box: EditorBox) => {
  const sides = sideColumns(l.binOpen, l.inspectorOpen, box);
  return { sides, sizes: fitSizes(l, box, sides) };
};

/** The editor's splitters: the media bin's and inspector's widths and the timeline's height,
 *  saved per account like the views panel's own layout. What is shown is fitted to `box`, so a
 *  smaller window squeezes the areas and a bigger one gives the saved sizes back. */
export function useVideoLayout(box: EditorBox) {
  const [layout, setLayout] = useState<VideoLayout>(load);
  const [dragging, setDragging] = useState<VideoSplit | null>(null);
  const layoutRef = useRef(layout);
  const boxRef = useRef(box);
  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useEffect(() => { boxRef.current = box; }, [box]);

  useEffect(() => {
    if (!dragging) return;
    document.body.style.userSelect = "none";
    return () => { document.body.style.userSelect = ""; };
  }, [dragging]);

  const rangeNow = (kind: VideoSplit) => {
    const { sides, sizes } = fitted(layoutRef.current, boxRef.current);
    return { range: splitRange(kind, boxRef.current, sizes, sides), now: sizes[kind] };
  };

  const reset = useCallback((kind: VideoSplit) => {
    const next = { ...layoutRef.current, [kind]: DEFAULT_VIDEO_LAYOUT[kind] };
    setLayout(next);
    persist(next);
  }, []);

  /** Mouse down on a splitter: the bin grows to the right, the inspector to the left, the
   *  timeline upwards. The second press of a double-click resets it: the drag shield raised by
   *  the first press means no dblclick event ever reaches the splitter, and the shield has to
   *  go up at once, or the first move over the player's iframe is lost to the iframe. */
  const startDrag = useCallback((kind: VideoSplit) => (e: React.MouseEvent) => {
    e.preventDefault();
    if (e.detail >= 2) {
      reset(kind);
      return;
    }
    const start = kind === "timeline" ? e.clientY : e.clientX;
    const { now: base } = rangeNow(kind);
    const sign = kind === "bin" ? 1 : -1;
    let latest = layoutRef.current;
    setDragging(kind);
    const move = (ev: MouseEvent) => {
      const pos = kind === "timeline" ? ev.clientY : ev.clientX;
      latest = { ...latest, [kind]: clampToRange(base + sign * (pos - start), rangeNow(kind).range) };
      layoutRef.current = latest;
      setLayout(latest);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      setDragging(null);
      persist(latest);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }, [reset]);

  /** Arrows, Home and End on a focused splitter. */
  const onSplitKey = useCallback((kind: VideoSplit) => (e: React.KeyboardEvent) => {
    const { range, now } = rangeNow(kind);
    const size = keyedSize(kind, e.key, e.shiftKey, now, range);
    if (size === null) return;
    // These keys also move the playhead when the focus is elsewhere in the editor.
    e.preventDefault();
    e.stopPropagation();
    const next = { ...layoutRef.current, [kind]: size };
    layoutRef.current = next;
    setLayout(next);
    persist(next);
  }, []);

  const toggle = useCallback((which: "binOpen" | "inspectorOpen") => {
    const next = { ...layoutRef.current, [which]: !layoutRef.current[which] };
    setLayout(next);
    persist(next);
  }, []);

  const { sides, sizes } = fitted(layout, box);
  return { layout, sizes, sides, range: (kind: VideoSplit) => splitRange(kind, box, sizes, sides), dragging, startDrag, onSplitKey, reset, toggle };
}
