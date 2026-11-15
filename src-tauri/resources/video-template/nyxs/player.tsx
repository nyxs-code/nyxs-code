// The Nyxs in-app player: mounts @remotion/player with the engine composition and talks to Nyxs
// over postMessage (protocol in Nyxs: src/lib/video/playerProtocol.ts). Bundled and served by
// nyxs/serve.mjs; not part of `remotion render`.

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Player } from "@remotion/player";
import type { PlayerRef } from "@remotion/player";
import { VERSION } from "remotion";
import {
  CLIP_ID_ATTR,
  ROOT_ATTR,
  TimelineComposition,
  clipEnd,
  effectiveTransform,
  resolveTransform,
  validateTimeline,
} from "./engine";
import type { Clip, Composition, ResolvedTransform, Timeline, Track, Transform } from "./engine";
import type { CollectedComposition } from "./remotionShim";

// Startup phases, readable with performance.getEntriesByType("mark") when timing a player open.
performance.mark("nyxs:bundle-evaluated");

const SOURCE = "nyxs-video";
// Remotion's default pool of 5 shared <audio> tags only helps with browser autoplay rules, which
// the app's webview doesn't apply, and it throws as soon as more audio mounts at once: audio clips
// premount a second early, so sounds close together pass 5 with only a couple playing.
const SHARED_AUDIO_TAGS = 0;
// Built by serve.mjs from the project's own Remotion entry (see remotionShim.tsx). Loaded by URL
// so a broken project entry never breaks the timeline player.
const PROJECT_BUNDLE = "/__nyxs/bundle/project.js";

type ToPlayerMessage =
  | { type: "load"; timeline: Timeline; compositionId: string }
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  | { type: "seek"; frame: number }
  | { type: "setLoop"; loop: boolean }
  | { type: "setPlaybackRate"; rate: number }
  | { type: "setVolume"; volume: number }
  | { type: "setMuted"; muted: boolean }
  | { type: "setOverlay"; safeAreas: boolean; grid: boolean; selectedClipId: string | null }
  | { type: "setZoom"; zoom: "fit" | number }
  | { type: "loadProjectComposition"; compositionId: string; inputProps?: Record<string, unknown> };

/** A composition registered by the project's own Root (adopted Remotion projects). */
type ProjectCompositionInfo = {
  id: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  durationInFrames: number | null;
  /** Null when not JSON-serializable or larger than 50 KB. */
  defaultProps: Record<string, unknown> | null;
  hasCalculateMetadata: boolean;
  still: boolean;
  folder: string | null;
};

type FromPlayerMessage =
  | { type: "ready"; remotionVersion: string }
  | { type: "frame"; frame: number; playing: boolean }
  | { type: "ended" }
  | { type: "error"; message: string; stack?: string }
  | { type: "clipClicked"; clipId: string }
  | { type: "transformDrag"; clipId: string; transform: Transform }
  | { type: "bundleRebuilt" }
  | { type: "keydown"; key: string; code: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }
  | { type: "projectCompositions"; entry: string | null; compositions: ProjectCompositionInfo[]; error?: string };

type Boot = {
  buildError: string | null;
  rebuilt: boolean;
  saved: Partial<SavedState> | null;
  onBuildError: ((message: string) => void) | null;
  beforeReload: (() => void) | null;
  persist: (state: Partial<SavedState> | null, rebuilt: boolean) => void;
  post: (msg: Record<string, unknown>) => void;
};

declare global {
  interface Window {
    __nyxsBoot?: Boot;
    /** Debug/test hook: send a protocol message as if it came from Nyxs. */
    nyxsPlayer?: { send: (msg: ToPlayerMessage) => void };
  }
}

const boot: Boot = window.__nyxsBoot ?? {
  buildError: null,
  rebuilt: false,
  saved: null,
  onBuildError: null,
  beforeReload: null,
  persist: () => undefined,
  post: (msg) => {
    if (window.parent !== window) window.parent.postMessage({ ...msg, source: SOURCE }, "*");
  },
};

function post(msg: FromPlayerMessage) {
  boot.post({ ...msg });
}

type Overlay = { safeAreas: boolean; grid: boolean; selectedClipId: string | null };

type SavedState = {
  timeline: Timeline | null;
  compositionId: string | null;
  frame: number;
  playing: boolean;
  loop: boolean;
  rate: number;
  volume: number;
  muted: boolean;
  overlay: Overlay;
  zoom: "fit" | number;
  project: { compositionId: string; inputProps?: Record<string, unknown> } | null;
};

// The page has an opaque origin (sandboxed iframe), where web storage throws; the boot script
// carries this state across reloads in window.name.
function readSavedState(): Partial<SavedState> {
  return boot.saved ?? {};
}

type ProjectModule = { collectCompositions: (() => CollectedComposition[]) | null; entry: string | null };

/** Everything the <Player> needs to show one of the project's own compositions. */
type ProjectView = {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  props: Record<string, unknown>;
  component?: React.ComponentType<Record<string, unknown>>;
  lazyComponent?: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>;
};

function jsonSafe(value: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const text = JSON.stringify(value);
    return text.length <= 50_000 ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function describeComposition(c: CollectedComposition): ProjectCompositionInfo {
  return {
    id: c.id,
    width: c.width ?? null,
    height: c.height ?? null,
    fps: c.fps ?? null,
    durationInFrames: c.durationInFrames ?? null,
    defaultProps: jsonSafe(c.defaultProps),
    hasCalculateMetadata: typeof c.calculateMetadata === "function",
    still: c.still,
    folder: c.folder,
  };
}

/** Applies calculateMetadata (if any) the way Remotion does, then checks the result is playable. */
async function resolveProjectView(c: CollectedComposition, inputProps: Record<string, unknown> | undefined): Promise<ProjectView> {
  let props: Record<string, unknown> = { ...c.defaultProps, ...(inputProps ?? {}) };
  let { width, height, fps, durationInFrames } = c;
  if (c.calculateMetadata) {
    const meta = (await c.calculateMetadata({
      defaultProps: c.defaultProps,
      props,
      abortSignal: new AbortController().signal,
      compositionId: c.id,
      isRendering: false,
    })) as Partial<{ width: number; height: number; fps: number; durationInFrames: number; props: Record<string, unknown> }> | null;
    if (meta) {
      width = meta.width ?? width;
      height = meta.height ?? height;
      fps = meta.fps ?? fps;
      durationInFrames = meta.durationInFrames ?? durationInFrames;
      if (meta.props) props = meta.props;
    }
  }
  const values = { width, height, fps, durationInFrames };
  const missing = (Object.keys(values) as (keyof typeof values)[]).filter((k) => {
    const v = values[k];
    return typeof v !== "number" || !(v > 0);
  });
  if (missing.length > 0) {
    throw new Error(`Composition "${c.id}" has no ${missing.join(", ")} (set it on <Composition> or return it from calculateMetadata).`);
  }
  if (!c.component && !c.lazyComponent) throw new Error(`Composition "${c.id}" has no component.`);
  return {
    id: c.id,
    width: width as number,
    height: height as number,
    fps: fps as number,
    durationInFrames: durationInFrames as number,
    props,
    component: c.component,
    lazyComponent: c.lazyComponent,
  };
}

/** Current frame, outside React state so playback does not re-render the whole page. */
const frameStore = (() => {
  let frame = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => frame,
    set: (f: number) => {
      if (f === frame) return;
      frame = f;
      listeners.forEach((l) => l());
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
})();

function errorText(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}

function findClip(composition: Composition, clipId: string): { clip: Clip; track: Track } | null {
  for (const track of composition.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

function withTransform(timeline: Timeline, compositionId: string, clipId: string, t: ResolvedTransform): Timeline {
  return {
    ...timeline,
    compositions: timeline.compositions.map((c) =>
      c.id !== compositionId
        ? c
        : {
            ...c,
            tracks: c.tracks.map((tr) => ({
              ...tr,
              clips: tr.clips.map((cl) => (cl.id === clipId ? ({ ...cl, transform: toTransform(t) } as Clip) : cl)),
            })),
          },
    ),
  };
}

function round(v: number, digits: number) {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

function toTransform(t: ResolvedTransform): Transform {
  return { x: round(t.x, 2), y: round(t.y, 2), scale: round(t.scale, 4), rotation: round(t.rotation, 2), anchor: t.anchor };
}

type Rect = { left: number; top: number; width: number; height: number };

/**
 * Screen rect of the composition: the engine's root element when there is one, otherwise the
 * Player container with the composition fitted inside it (project compositions).
 */
function useRootRect(container: () => HTMLElement | null, width: number, height: number): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    let raf = 0;
    let last = "";
    const measure = (): Rect | null => {
      const el = document.querySelector(`[${ROOT_ATTR}]`);
      if (el) return el.getBoundingClientRect();
      const box = container()?.getBoundingClientRect();
      if (!box || width <= 0 || height <= 0) return null;
      const k = Math.min(box.width / width, box.height / height);
      return { left: box.left + (box.width - width * k) / 2, top: box.top + (box.height - height * k) / 2, width: width * k, height: height * k };
    };
    const tick = () => {
      const r = measure();
      const next = r ? `${r.left},${r.top},${r.width},${r.height}` : "";
      if (next !== last) {
        last = next;
        setRect(r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [container, width, height]);
  return rect;
}

type Pt = { x: number; y: number };

/** Corners (screen px) of a clip box, plus its pivot, for the selection overlay. */
function boxGeometry(t: ResolvedTransform, w: number, h: number, rect: Rect, comp: Composition) {
  const k = rect.width / comp.width;
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const local: Pt[] =
    t.anchor === "center"
      ? [
          { x: -w / 2, y: -h / 2 },
          { x: w / 2, y: -h / 2 },
          { x: w / 2, y: h / 2 },
          { x: -w / 2, y: h / 2 },
        ]
      : [
          { x: 0, y: 0 },
          { x: w, y: 0 },
          { x: w, y: h },
          { x: 0, y: h },
        ];
  const toScreen = (p: Pt): Pt => {
    const sx = p.x * t.scale;
    const sy = p.y * t.scale;
    const cx = t.x + sx * cos - sy * sin;
    const cy = t.y + sx * sin + sy * cos;
    return { x: rect.left + cx * k, y: rect.top + cy * k };
  };
  const corners = local.map(toScreen);
  const pivot = { x: rect.left + t.x * k, y: rect.top + t.y * k };
  // Rotation handle: 28px above the middle of the top edge, along the box's up direction.
  const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
  const rotHandle = { x: topMid.x + 28 * sin, y: topMid.y - 28 * cos };
  return { corners, pivot, topMid, rotHandle, k };
}

const MEDIA_TAGS = new Set(["IMG", "VIDEO", "CANVAS", "IFRAME"]);

function paintsSomething(el: Element): boolean {
  if (MEDIA_TAGS.has(el.tagName) || el instanceof SVGElement) return true;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  if (style.backgroundImage !== "none") return true;
  if (!/rgba\(.*,\s*0\)$|transparent/.test(style.backgroundColor)) return true;
  if (parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderLeftWidth) > 0) return true;
  return Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
}

type DragMode ={ kind: "move" } | { kind: "scale" } | { kind: "rotate" };

type DragState = {
  clipId: string;
  mode: DragMode;
  start: Pt;
  t0: ResolvedTransform;
  pivot: Pt;
  k: number;
  started: boolean;
};

const SelectionOverlay: React.FC<{
  composition: Composition;
  timeline: Timeline;
  overlay: Overlay;
  rect: Rect | null;
  override: { clipId: string; t: ResolvedTransform } | null;
  onDrag: (clipId: string, t: ResolvedTransform, done: boolean) => void;
}> = ({ composition, overlay, rect, override, onDrag }) => {
  const frame = useSyncExternalStore(frameStore.subscribe, frameStore.get);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef(0);
  const pendingRef = useRef<{ clipId: string; t: ResolvedTransform } | null>(null);

  const selected = overlay.selectedClipId ? findClip(composition, overlay.selectedClipId) : null;
  let geometry: ReturnType<typeof boxGeometry> | null = null;
  let selectedT: ResolvedTransform | null = null;
  if (selected && rect && selected.clip.type !== "audio" && frame >= selected.clip.from && frame < clipEnd(selected.clip)) {
    const el = document.querySelector<HTMLElement>(`[${CLIP_ID_ATTR}="${CSS.escape(selected.clip.id)}"]`);
    if (el) {
      selectedT =
        override && override.clipId === selected.clip.id
          ? override.t
          : resolveTransform(effectiveTransform(selected.clip, composition), frame - selected.clip.from, composition);
      geometry = boxGeometry(selectedT, el.offsetWidth, el.offsetHeight, rect, composition);
    }
  }

  const hitClip = (x: number, y: number): { clip: Clip; track: Track } | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      // Full-frame scenes and wrappers are mostly transparent: only what actually paints at
      // the point counts, so a lower third does not swallow clicks meant for the clip below.
      if (!paintsSomething(el)) continue;
      const box = el.closest(`[${CLIP_ID_ATTR}]`);
      const id = box?.getAttribute(CLIP_ID_ATTR);
      if (!id) continue;
      const found = findClip(composition, id);
      if (found && !found.track.locked) return found;
    }
    return null;
  };

  const startDrag = (e: React.PointerEvent, clip: Clip, mode: DragMode, t0: ResolvedTransform) => {
    if (!rect) return;
    const k = rect.width / composition.width;
    dragRef.current = {
      clipId: clip.id,
      mode,
      start: { x: e.clientX, y: e.clientY },
      t0,
      pivot: { x: rect.left + t0.x * k, y: rect.top + t0.y * k },
      k,
      started: mode.kind !== "move",
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const hit = hitClip(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.clip.id !== overlay.selectedClipId) post({ type: "clipClicked", clipId: hit.clip.id });
    if (hit.clip.type === "audio") return;
    const t0 =
      override && override.clipId === hit.clip.id
        ? override.t
        : resolveTransform(effectiveTransform(hit.clip, composition), frameStore.get() - hit.clip.from, composition);
    startDrag(e, hit.clip, { kind: "move" }, t0);
  };

  const flush = useCallback(() => {
    rafRef.current = 0;
    const p = pendingRef.current;
    if (p) onDrag(p.clipId, p.t, false);
  }, [onDrag]);

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.start.x;
    const dy = e.clientY - d.start.y;
    if (!d.started) {
      if (Math.hypot(dx, dy) < 3) return;
      d.started = true;
    }
    let t: ResolvedTransform = d.t0;
    if (d.mode.kind === "move") {
      let mx = dx;
      let my = dy;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) my = 0;
        else mx = 0;
      }
      let x = d.t0.x + mx / d.k;
      let y = d.t0.y + my / d.k;
      // Snap the anchor to the composition's center lines within 6 screen px.
      if (!e.altKey) {
        if (Math.abs(x - composition.width / 2) * d.k < 6) x = composition.width / 2;
        if (Math.abs(y - composition.height / 2) * d.k < 6) y = composition.height / 2;
      }
      t = { ...d.t0, x, y };
    } else if (d.mode.kind === "scale") {
      const d0 = Math.hypot(d.start.x - d.pivot.x, d.start.y - d.pivot.y);
      const d1 = Math.hypot(e.clientX - d.pivot.x, e.clientY - d.pivot.y);
      let scale = d0 > 0 ? (d.t0.scale * d1) / d0 : d.t0.scale;
      if (e.shiftKey) scale = Math.round(scale * 20) / 20;
      t = { ...d.t0, scale: Math.max(0.01, scale) };
    } else {
      const a0 = Math.atan2(d.start.y - d.pivot.y, d.start.x - d.pivot.x);
      const a1 = Math.atan2(e.clientY - d.pivot.y, e.clientX - d.pivot.x);
      let rotation = d.t0.rotation + ((a1 - a0) * 180) / Math.PI;
      if (e.shiftKey) rotation = Math.round(rotation / 15) * 15;
      t = { ...d.t0, rotation };
    }
    pendingRef.current = { clipId: d.clipId, t };
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flush);
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    const p = pendingRef.current;
    pendingRef.current = null;
    if (d?.started && p) onDrag(p.clipId, p.t, true);
  };

  const handle = (mode: DragMode) => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0 || !selected || !selectedT) return;
    startDrag(e, selected.clip, mode, selectedT);
  };

  const accent = "#7C9CFF";
  const layer: React.CSSProperties = { position: "fixed", inset: 0, width: "100%", height: "100%", overflow: "visible" };
  return (
    <svg
      style={{ ...layer, touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {rect && overlay.grid ? (
        <g stroke="rgba(255,255,255,0.35)" strokeWidth={1} pointerEvents="none">
          {[1, 2].map((i) => (
            <line key={`v${i}`} x1={rect.left + (rect.width * i) / 3} y1={rect.top} x2={rect.left + (rect.width * i) / 3} y2={rect.top + rect.height} />
          ))}
          {[1, 2].map((i) => (
            <line key={`h${i}`} x1={rect.left} y1={rect.top + (rect.height * i) / 3} x2={rect.left + rect.width} y2={rect.top + (rect.height * i) / 3} />
          ))}
          <line x1={rect.left + rect.width / 2 - 10} y1={rect.top + rect.height / 2} x2={rect.left + rect.width / 2 + 10} y2={rect.top + rect.height / 2} />
          <line x1={rect.left + rect.width / 2} y1={rect.top + rect.height / 2 - 10} x2={rect.left + rect.width / 2} y2={rect.top + rect.height / 2 + 10} />
        </g>
      ) : null}
      {rect && overlay.safeAreas ? (
        <g fill="none" strokeWidth={1} pointerEvents="none" strokeDasharray="6 4">
          {/* Action safe (90%) and title safe (80%). */}
          <rect x={rect.left + rect.width * 0.05} y={rect.top + rect.height * 0.05} width={rect.width * 0.9} height={rect.height * 0.9} stroke="rgba(255,214,10,0.7)" />
          <rect x={rect.left + rect.width * 0.1} y={rect.top + rect.height * 0.1} width={rect.width * 0.8} height={rect.height * 0.8} stroke="rgba(124,156,255,0.8)" />
        </g>
      ) : null}
      {geometry ? (
        <g>
          <polygon
            points={geometry.corners.map((c) => `${c.x},${c.y}`).join(" ")}
            fill="transparent"
            stroke={accent}
            strokeWidth={1.5}
            style={{ cursor: "move" }}
          />
          <line x1={geometry.topMid.x} y1={geometry.topMid.y} x2={geometry.rotHandle.x} y2={geometry.rotHandle.y} stroke={accent} strokeWidth={1.5} pointerEvents="none" />
          <circle
            cx={geometry.rotHandle.x}
            cy={geometry.rotHandle.y}
            r={6}
            fill="#fff"
            stroke={accent}
            strokeWidth={1.5}
            style={{ cursor: "grab" }}
            onPointerDown={handle({ kind: "rotate" })}
          />
          {geometry.corners.map((c, i) => (
            <rect
              key={i}
              x={c.x - 5}
              y={c.y - 5}
              width={10}
              height={10}
              fill="#fff"
              stroke={accent}
              strokeWidth={1.5}
              style={{ cursor: i % 2 === 0 ? "nwse-resize" : "nesw-resize" }}
              onPointerDown={handle({ kind: "scale" })}
            />
          ))}
        </g>
      ) : null}
    </svg>
  );
};

const ErrorPanel: React.FC<{ title: string; message: string }> = ({ title, message }) => (
  <div
    style={{
      position: "fixed",
      inset: 0,
      padding: 20,
      overflow: "auto",
      background: "rgba(20, 8, 10, 0.94)",
      color: "#e8e8ec",
      zIndex: 10,
    }}
  >
    <div style={{ fontSize: 14, fontWeight: 600, color: "#ff8a8a", marginBottom: 10 }}>{title}</div>
    <pre style={{ margin: 0, whiteSpace: "pre-wrap", font: "12px/1.5 ui-monospace, Consolas, monospace" }}>{message}</pre>
  </div>
);

const App: React.FC = () => {
  const saved = useMemo(readSavedState, []);
  const [timeline, setTimeline] = useState<Timeline | null>(saved.timeline ?? null);
  const [compositionId, setCompositionId] = useState<string | null>(saved.compositionId ?? null);
  const [loop, setLoop] = useState(saved.loop ?? false);
  const [rate, setRate] = useState(saved.rate ?? 1);
  const [overlay, setOverlay] = useState<Overlay>(saved.overlay ?? { safeAreas: false, grid: false, selectedClipId: null });
  const [zoom, setZoom] = useState<"fit" | number>(saved.zoom ?? "fit");
  const [buildError, setBuildError] = useState<string | null>(boot.buildError);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const runtimeErrorRef = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playerKey, setPlayerKey] = useState(0);
  const [override, setOverride] = useState<{ clipId: string; t: ResolvedTransform } | null>(null);
  const playerRef = useRef<PlayerRef | null>(null);
  // The Player's handle can arrive after the first commit; state makes the event effect re-run.
  const [playerHandle, setPlayerHandle] = useState<PlayerRef | null>(null);
  const setPlayerRef = useCallback((p: PlayerRef | null) => {
    playerRef.current = p;
    setPlayerHandle(p);
  }, []);
  const audioRef = useRef({ volume: saved.volume ?? 1, muted: saved.muted ?? false });
  const projectRef = useRef<CollectedComposition[]>([]);
  const [projectRequest, setProjectRequest] = useState<SavedState["project"]>(saved.project ?? null);
  const [projectView, setProjectView] = useState<ProjectView | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectReady, setProjectReady] = useState(false);
  const loadedFromParent = useRef(false);
  const draggingRef = useRef(false);
  const overrideTimer = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);

  const stateRef = useRef<SavedState | null>(null);
  stateRef.current = {
    timeline,
    compositionId,
    frame: frameStore.get(),
    playing: false,
    loop,
    rate,
    volume: audioRef.current.volume,
    muted: audioRef.current.muted,
    overlay,
    zoom,
    project: projectRequest,
  };

  // Keep everything across the reload that follows a rebuild (scenes or the project's code).
  useEffect(() => {
    const save = (rebuilt: boolean) => {
      const s = stateRef.current;
      boot.persist(s ? { ...s, frame: frameStore.get(), playing: playerRef.current?.isPlaying() ?? false } : null, rebuilt);
    };
    const onPageHide = () => save(false);
    boot.beforeReload = () => save(true);
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  useEffect(() => {
    boot.onBuildError = (message) => {
      setBuildError(message);
      post({ type: "error", message: `Build failed:\n${message}` });
    };
    return () => {
      boot.onBuildError = null;
    };
  }, []);

  const applyTimeline = useCallback((next: unknown, compId: string | null) => {
    const result = validateTimeline(next);
    if (!result.ok) {
      const message = `timeline.json is invalid:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
      setLoadError(message);
      post({ type: "error", message });
      return;
    }
    const id = compId ?? result.timeline.compositions[0]?.id ?? null;
    if (!id || !result.timeline.compositions.some((c) => c.id === id)) {
      const message = `Composition "${String(id)}" is not in the timeline (it has ${result.timeline.compositions.map((c) => `"${c.id}"`).join(", ")}).`;
      setLoadError(message);
      post({ type: "error", message });
      return;
    }
    setLoadError(null);
    setTimeline(result.timeline);
    setCompositionId(id);
    if (runtimeErrorRef.current) {
      // Remount the player so its error boundary lets the new timeline render.
      runtimeErrorRef.current = false;
      setRuntimeError(null);
      setPlayerKey((k) => k + 1);
    }
    if (!draggingRef.current) setOverride(null);
  }, []);

  // Standalone (opened directly, or before Nyxs sends `load`): show the project's timeline.json.
  useEffect(() => {
    if (saved.timeline) return;
    fetch("/__nyxs/timeline.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json: unknown) => {
        if (!loadedFromParent.current) applyTimeline(json, null);
      })
      .catch((err: unknown) => {
        if (!loadedFromParent.current) setLoadError(`Could not read timeline.json: ${errorText(err).message}`);
      });
  }, [applyTimeline, saved.timeline]);

  const handleMessage = useCallback(
    (msg: ToPlayerMessage) => {
      const player = playerRef.current;
      switch (msg.type) {
        case "load":
          loadedFromParent.current = true;
          setProjectRequest(null);
          applyTimeline(msg.timeline, msg.compositionId);
          break;
        case "loadProjectComposition":
          if (typeof msg.compositionId === "string") {
            setProjectRequest({ compositionId: msg.compositionId, inputProps: msg.inputProps });
          }
          break;
        case "play":
          player?.play();
          break;
        case "pause":
          player?.pause();
          break;
        case "toggle":
          player?.toggle();
          break;
        case "seek":
          if (Number.isFinite(msg.frame)) player?.seekTo(Math.max(0, Math.round(msg.frame)));
          break;
        case "setLoop":
          setLoop(!!msg.loop);
          break;
        case "setPlaybackRate":
          if (Number.isFinite(msg.rate) && msg.rate !== 0) setRate(Math.max(-4, Math.min(4, msg.rate)));
          break;
        case "setVolume":
          if (Number.isFinite(msg.volume)) {
            audioRef.current.volume = Math.max(0, Math.min(1, msg.volume));
            player?.setVolume(audioRef.current.volume);
          }
          break;
        case "setMuted":
          audioRef.current.muted = !!msg.muted;
          if (msg.muted) player?.mute();
          else player?.unmute();
          break;
        case "setOverlay":
          setOverlay({ safeAreas: !!msg.safeAreas, grid: !!msg.grid, selectedClipId: msg.selectedClipId ?? null });
          break;
        case "setZoom":
          if (msg.zoom === "fit" || (typeof msg.zoom === "number" && msg.zoom > 0)) setZoom(msg.zoom);
          break;
      }
    },
    [applyTimeline],
  );

  useEffect(() => {
    const listener = (e: MessageEvent) => {
      // Only the embedding window may drive the player.
      if (e.source !== window.parent || window.parent === window) return;
      const data = e.data as { source?: unknown; type?: unknown } | null;
      if (!data || data.source !== SOURCE || typeof data.type !== "string") return;
      handleMessage(data as ToPlayerMessage);
    };
    window.addEventListener("message", listener);
    window.nyxsPlayer = { send: handleMessage };
    return () => window.removeEventListener("message", listener);
  }, [handleMessage]);

  // Player events → Nyxs. Re-attached when the Player remounts.
  useEffect(() => {
    const player = playerHandle;
    if (!player) return;
    player.setVolume(audioRef.current.volume);
    if (audioRef.current.muted) player.mute();
    let raf = 0;
    const sendFrame = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const p = playerRef.current;
        if (!p) return;
        const frame = p.getCurrentFrame();
        frameStore.set(frame);
        post({ type: "frame", frame, playing: p.isPlaying() });
      });
    };
    const onEnded = () => {
      post({ type: "ended" });
      sendFrame();
    };
    const onError = (e: { detail: { error: Error } }) => {
      const { message, stack } = errorText(e.detail.error);
      runtimeErrorRef.current = true;
      setRuntimeError(stack ?? message);
      post({ type: "error", message, stack });
    };
    player.addEventListener("frameupdate", sendFrame);
    player.addEventListener("play", sendFrame);
    player.addEventListener("pause", sendFrame);
    player.addEventListener("seeked", sendFrame);
    player.addEventListener("ended", onEnded);
    player.addEventListener("error", onError);
    sendFrame();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      player.removeEventListener("frameupdate", sendFrame);
      player.removeEventListener("play", sendFrame);
      player.removeEventListener("pause", sendFrame);
      player.removeEventListener("seeked", sendFrame);
      player.removeEventListener("ended", onEnded);
      player.removeEventListener("error", onError);
    };
  }, [playerHandle]);

  // The project's own compositions (its Root, through remotionShim). Sent once after `ready`.
  useEffect(() => {
    let cancelled = false;
    const url: string = PROJECT_BUNDLE;
    (import(/* @vite-ignore */ url) as Promise<ProjectModule>)
      .then((mod) => {
        if (cancelled) return;
        if (!mod.collectCompositions) {
          post({ type: "projectCompositions", entry: null, compositions: [] });
          return;
        }
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.crossOrigin = "anonymous";
        link.href = "/__nyxs/bundle/project.css";
        document.head.appendChild(link);
        const comps = mod.collectCompositions();
        projectRef.current = comps;
        post({ type: "projectCompositions", entry: mod.entry, compositions: comps.map(describeComposition) });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        post({ type: "projectCompositions", entry: null, compositions: [], error: errorText(err).message });
      })
      .finally(() => {
        if (!cancelled) setProjectReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectReady) return;
    if (!projectRequest) {
      setProjectView(null);
      setProjectError(null);
      return;
    }
    const comp = projectRef.current.find((c) => c.id === projectRequest.compositionId);
    if (!comp) {
      const ids = projectRef.current.map((c) => `"${c.id}"`).join(", ");
      const message = `The project has no composition "${projectRequest.compositionId}" (it has ${ids || "none"}).`;
      setProjectView(null);
      setProjectError(message);
      post({ type: "error", message });
      return;
    }
    let cancelled = false;
    resolveProjectView(comp, projectRequest.inputProps)
      .then((view) => {
        if (cancelled) return;
        setProjectError(null);
        setProjectView(view);
        runtimeErrorRef.current = false;
        setRuntimeError(null);
        setPlayerKey((k) => k + 1);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const { message, stack } = errorText(err);
        setProjectError(stack ?? message);
        post({ type: "error", message, stack });
      });
    return () => {
      cancelled = true;
    };
  }, [projectReady, projectRequest]);

  // ready (+ bundleRebuilt after a hot reload), once.
  useEffect(() => {
    performance.mark("nyxs:react-mounted");
    post({ type: "ready", remotionVersion: VERSION });
    if (boot.rebuilt) post({ type: "bundleRebuilt" });
    const onWindowError = (e: ErrorEvent) => post({ type: "error", ...errorText(e.error ?? e.message) });
    const onRejection = (e: PromiseRejectionEvent) => post({ type: "error", ...errorText(e.reason) });
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Restore playback after a hot reload.
  useEffect(() => {
    if (!saved.playing || !playerHandle) return;
    const id = window.setTimeout(() => playerRef.current?.play(), 50);
    return () => window.clearTimeout(id);
  }, [playerHandle, saved.playing]);

  // Forward shortcuts: while the iframe has focus, Nyxs would not see them otherwise.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") e.preventDefault();
      post({
        type: "keydown",
        key: e.key,
        code: e.code,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onDrag = useCallback(
    (clipId: string, t: ResolvedTransform, done: boolean) => {
      draggingRef.current = !done;
      setOverride({ clipId, t });
      post({ type: "transformDrag", clipId, transform: toTransform(t) });
      window.clearTimeout(overrideTimer.current);
      if (done) {
        // Keep showing the dragged position until Nyxs answers with a `load`; drop it if it never does.
        overrideTimer.current = window.setTimeout(() => setOverride(null), 1500);
      }
    },
    [],
  );

  const timelineComposition = timeline && compositionId ? (timeline.compositions.find((c) => c.id === compositionId) ?? null) : null;
  const showingProject = !!projectRequest;
  // Project compositions get a track-less stand-in, so the overlay draws guides but selects nothing.
  const composition: Composition | null = showingProject
    ? projectView
      ? {
          id: projectView.id,
          name: projectView.id,
          width: projectView.width,
          height: projectView.height,
          fps: projectView.fps,
          durationInFrames: projectView.durationInFrames,
          background: "",
          tracks: [],
          markers: [],
        }
      : null
    : timelineComposition;
  const getContainer = useCallback(() => playerRef.current?.getContainerNode() ?? null, []);
  const rect = useRootRect(getContainer, composition?.width ?? 0, composition?.height ?? 0);
  const effective = useMemo(
    () => (timeline && compositionId && override ? withTransform(timeline, compositionId, override.clipId, override.t) : timeline),
    [timeline, compositionId, override],
  );
  const inputProps = useMemo(
    () => (effective && compositionId ? { compositionId, timeline: effective } : null),
    [effective, compositionId],
  );

  const fit = zoom === "fit";
  const playerStyle: React.CSSProperties = fit
    ? { width: "100%", height: "100%" }
    : { width: (composition?.width ?? 0) * zoom, height: (composition?.height ?? 0) * zoom, flex: "none", margin: "auto" };

  const errorView = buildError
    ? { title: "Build error", message: buildError }
    : showingProject && projectError
      ? { title: "Project composition error", message: projectError }
      : !showingProject && loadError
        ? { title: "Timeline error", message: loadError }
        : runtimeError
        ? { title: "Runtime error", message: runtimeError }
        : null;

  return (
    <>
      <div
        ref={stageRef}
        style={{ position: "fixed", inset: 0, display: "flex", overflow: fit ? "hidden" : "auto", padding: fit ? 0 : 24, boxSizing: "border-box" }}
      >
        {showingProject && projectView ? (
          <Player
            key={`project-${playerKey}`}
            ref={setPlayerRef}
            {...(projectView.lazyComponent ? { lazyComponent: projectView.lazyComponent } : { component: projectView.component! })}
            inputProps={projectView.props}
            durationInFrames={projectView.durationInFrames}
            compositionWidth={projectView.width}
            compositionHeight={projectView.height}
            fps={projectView.fps}
            loop={loop}
            playbackRate={rate}
            controls={false}
            clickToPlay={false}
            doubleClickToFullscreen={false}
            spaceKeyToPlayOrPause={false}
            initialFrame={Math.min(saved.frame ?? 0, projectView.durationInFrames - 1)}
            initiallyMuted={audioRef.current.muted}
            errorFallback={() => null}
            numberOfSharedAudioTags={SHARED_AUDIO_TAGS}
            acknowledgeRemotionLicense
            style={playerStyle}
          />
        ) : !showingProject && composition && inputProps ? (
          <Player
            key={playerKey}
            ref={setPlayerRef}
            component={TimelineComposition}
            inputProps={inputProps}
            durationInFrames={composition.durationInFrames}
            compositionWidth={composition.width}
            compositionHeight={composition.height}
            fps={composition.fps}
            loop={loop}
            playbackRate={rate}
            controls={false}
            clickToPlay={false}
            doubleClickToFullscreen={false}
            spaceKeyToPlayOrPause={false}
            initialFrame={Math.min(saved.frame ?? 0, composition.durationInFrames - 1)}
            initiallyMuted={audioRef.current.muted}
            errorFallback={() => null}
            numberOfSharedAudioTags={SHARED_AUDIO_TAGS}
            acknowledgeRemotionLicense
            style={playerStyle}
          />
        ) : null}
      </div>
      {composition && timeline ? (
        <div
          style={{ position: "fixed", inset: 0 }}
          onWheel={(e) => stageRef.current?.scrollBy(e.deltaX, e.deltaY)}
        >
          <SelectionOverlay
            composition={composition}
            timeline={timeline}
            overlay={overlay}
            rect={rect}
            override={override}
            onDrag={onDrag}
          />
        </div>
      ) : null}
      {errorView ? <ErrorPanel title={errorView.title} message={errorView.message} /> : null}
    </>
  );
};

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
