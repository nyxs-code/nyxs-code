import { useVideoAgentClips } from "@/lib/video/videoControl";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  AlertTriangle,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Crop,
  Gauge,
  Flag,
  Magnet,
  Maximize2,
  Pencil,
  Plus,
  Scissors,
  SlidersHorizontal,
  Snowflake,
  Trash2,
  ZoomIn,
  Unlink,
  ZoomOut,
} from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { invoke } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { Asset, Clip, TrackKind } from "@/lib/video/timelineSchema";
import { TRACK_KINDS, newId } from "@/lib/video/timelineSchema";
import * as ops from "@/lib/video/timelineOps";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  getPlayhead,
  getTimelineState,
  subscribePlayhead,
  takeZoomRestored,
  timelineActions,
  useComposition,
  usePlayhead,
  useSelection,
  useTimeline,
  useTimelineStore,
} from "@/lib/video/timelineStore";
import { TRACK_SIZES } from "@/lib/video/trackHeights";
import { HEADER_WIDTH, RULER_HEIGHT, TAIL_PX, fitZoom, layoutRows, rowAt, visibleClips } from "./geometry";
import { TimelineClip } from "./TimelineClip";
import { TimelineRuler } from "./TimelineRuler";
import { TrackHeader } from "./TrackHeader";
import { ContextMenu, ShortcutsPopover, type MenuItem } from "./TimelineMenus";
import { useTimelineInteractions, type MarqueeRect } from "./interactions";
import { VIDEO_ASSET_MIME, VIDEO_CLIP_MIME, hasTimelineDragData } from "./dnd";
import type { MediaProject } from "./mediaCache";
import { formatTimecode } from "../timecode";

/** Rendering window granularity: the visible range snaps to this many px (plus a margin), so
 *  scrolling re-renders the clips only every so often. */
const VIEW_QUANTUM = 256;

type MenuState =
  | { kind: "clip"; x: number; y: number; clipId: string }
  | { kind: "lane"; x: number; y: number; frame: number }
  | { kind: "track"; x: number; y: number; trackId: string }
  | { kind: "marker"; x: number; y: number; markerId: string }
  | { kind: "addTrack"; x: number; y: number };

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  return !!node && (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable);
}

export interface TimelineProps {
  className?: string;
}

/**
 * The multi-track timeline editor. Reads and edits the store in `timelineStore.ts`; the panel
 * opens the project (`openTimeline`) and mounts this in its bottom area.
 */
export function Timeline({ className }: TimelineProps) {
  const agentClips = useVideoAgentClips();
  const t = useTranslations().videoTimeline;
  const timeline = useTimeline();
  const comp = useComposition();
  const selection = useSelection();
  const project = useTimelineStore((s) => s.project);
  const status = useTimelineStore((s) => s.status);
  const loadError = useTimelineStore((s) => s.error);
  const externalError = useTimelineStore((s) => s.externalError);
  const saveError = useTimelineStore((s) => s.saveError);
  const zoom = useTimelineStore((s) => s.zoom);
  const snapping = useTimelineStore((s) => s.snapping);
  const inPoint = useTimelineStore((s) => s.inPoint);
  const outPoint = useTimelineStore((s) => s.outPoint);
  const hasClipboard = useTimelineStore((s) => s.hasClipboard);
  const compositionId = useTimelineStore((s) => s.compositionId);
  const trackSize = useTimelineStore((s) => s.trackSize);
  const trackHeights = useTimelineStore((s) => s.trackHeights);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, right: 2048, width: 0, height: 0 });
  const [guide, setGuide] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editingTrack, setEditingTrack] = useState<string | null>(null);
  const [editingMarker, setEditingMarker] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const zoomAnchor = useRef<{ frame: number; offset: number } | null>(null);

  const focus = useCallback(() => rootRef.current?.focus({ preventScroll: true }), []);
  const act = useTimelineInteractions({ lanes: lanesRef, scroller: scrollerRef, setGuide, setMarquee, focus });

  const mediaProject = useMemo<MediaProject | null>(() => (project ? { workspace: project.workspace, slug: project.slug } : null), [project]);
  const assets = useMemo(() => new Map((timeline?.assets ?? []).map((a) => [a.id, a])), [timeline?.assets]);
  const selected = useMemo(() => new Set(selection.clipIds), [selection.clipIds]);
  const layout = useMemo(() => (comp ? layoutRows(comp, { trackSize, trackHeights }) : { rows: [], height: 0 }), [comp, trackSize, trackHeights]);
  // Clips that start right where the previous clip of their track ends: a transition can join them.
  const joined = useMemo(() => {
    const out = new Set<string>();
    for (const tr of comp?.tracks ?? []) {
      for (let i = 1; i < tr.clips.length; i++) if (ops.clipEnd(tr.clips[i - 1]) === tr.clips[i].from) out.add(tr.clips[i].id);
    }
    return out;
  }, [comp]);

  const duration = comp?.durationInFrames ?? 0;
  const fps = comp?.fps ?? 30;
  const laneWidth = Math.max(duration * zoom + TAIL_PX, view.width);
  const lanesHeight = Math.max(layout.height + 48, view.height - RULER_HEIGHT);

  // Visible window in lane px, quantized.
  const updateView = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const width = el.clientWidth - HEADER_WIDTH;
    const left = Math.max(0, Math.floor(el.scrollLeft / VIEW_QUANTUM) * VIEW_QUANTUM - VIEW_QUANTUM);
    const right = Math.ceil((el.scrollLeft + width) / VIEW_QUANTUM) * VIEW_QUANTUM + VIEW_QUANTUM;
    setView((v) => (v.left === left && v.right === right && v.width === width && v.height === el.clientHeight ? v : { left, right, width, height: el.clientHeight }));
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateView);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(updateView);
    ro.observe(el);
    updateView();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [updateView, status]);

  const fit = useCallback(() => {
    const el = scrollerRef.current;
    const c = getTimelineState();
    const comp = c.timeline && c.compositionId ? ops.getComposition(c.timeline, c.compositionId) : undefined;
    if (!el || !comp) return;
    timelineActions.setZoom(fitZoom(comp.durationInFrames, el.clientWidth - HEADER_WIDTH));
    el.scrollLeft = 0;
  }, []);

  // Fit the whole composition when a project or composition opens.
  useEffect(() => {
    if (status !== "ready" || !compositionId) return;
    const id = requestAnimationFrame(() => {
      // A project reopens at the zoom it was left at; everything else opens fitted.
      if (!takeZoomRestored()) fit();
    });
    return () => cancelAnimationFrame(id);
  }, [status, compositionId, project, fit]);

  // Keep the frame under the pointer in place while Ctrl+wheel zooms.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const el = scrollerRef.current;
    if (!anchor || !el) return;
    zoomAnchor.current = null;
    el.scrollLeft = Math.max(0, anchor.frame * zoom - anchor.offset);
  }, [zoom]);

  const zoomAround = useCallback((nextZoom: number, clientX?: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
    const r = el.getBoundingClientRect();
    const offset = clientX === undefined ? (el.clientWidth - HEADER_WIDTH) / 2 : clientX - r.left - HEADER_WIDTH;
    const frame = (el.scrollLeft + offset) / getTimelineState().zoom;
    zoomAnchor.current = { frame, offset };
    timelineActions.setZoom(z);
  }, []);

  // Ctrl+wheel zoom needs a non-passive listener to stop the page from zooming.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomAround(getTimelineState().zoom * Math.exp(-e.deltaY * 0.0015), e.clientX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAround, status]);

  // Follow the playhead while the player plays: page to it when it leaves the view.
  useEffect(
    () =>
      subscribePlayhead((frame, source) => {
        const el = scrollerRef.current;
        if (source !== "player" || !el) return;
        const x = frame * getTimelineState().zoom;
        const width = el.clientWidth - HEADER_WIDTH;
        if (x < el.scrollLeft || x > el.scrollLeft + width - 16) el.scrollLeft = Math.max(0, x - 32);
      }),
    [],
  );

  const kindName = useCallback((kind: TrackKind) => t.kinds[kind], [t]);
  const newTrackName = useCallback(
    (kind: TrackKind) => {
      const c = getTimelineState();
      const comp = c.timeline && c.compositionId ? ops.getComposition(c.timeline, c.compositionId) : undefined;
      const n = (comp?.tracks.filter((tr) => tr.kind === kind).length ?? 0) + 1;
      return `${kindName(kind)} ${n}`;
    },
    [kindName],
  );

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (isTypingTarget(e.target) || !comp) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    let handled = true;
    if (mod && key === "z") {
      if (e.shiftKey) timelineActions.redo();
      else timelineActions.undo();
    } else if (mod && key === "y") timelineActions.redo();
    else if (mod && key === "c") timelineActions.copy();
    else if (mod && key === "x") timelineActions.cut();
    else if (mod && key === "v") timelineActions.paste();
    else if (mod && key === "d") timelineActions.duplicateSelected();
    else if (mod && key === "a") timelineActions.selectAll();
    else if (mod) handled = false;
    else if (key === "s") timelineActions.splitAtPlayhead();
    else if (e.key === "Delete" || e.key === "Backspace") timelineActions.deleteSelected(e.shiftKey);
    else if (key === "m") timelineActions.toggleMarkerAtPlayhead();
    else if (key === "i") timelineActions.markIn();
    else if (key === "o") timelineActions.markOut();
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const step = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1);
      if (selection.clipIds.length) timelineActions.nudge(step);
      else timelineActions.setPlayhead(getPlayhead() + step);
    } else if (e.key === "Escape") timelineActions.clearSelection();
    else if (e.key === "?") setShortcutsOpen((o) => !o);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const openClipMenu = useCallback((e: ReactMouseEvent, clipId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!getTimelineState().selection.clipIds.includes(clipId)) timelineActions.select([clipId]);
    setMenu({ kind: "clip", x: e.clientX, y: e.clientY, clipId });
  }, []);
  const openTrackMenu = useCallback((e: ReactMouseEvent, trackId: string) => {
    e.preventDefault();
    timelineActions.selectTrack(trackId);
    setMenu({ kind: "track", x: e.clientX, y: e.clientY, trackId });
  }, []);
  const openMarkerMenu = useCallback((e: ReactMouseEvent, markerId: string) => {
    e.preventDefault();
    e.stopPropagation();
    timelineActions.selectMarker(markerId);
    setMenu({ kind: "marker", x: e.clientX, y: e.clientY, markerId });
  }, []);

  const defaultTransition = useCallback((clipId: string) => {
    const c = getTimelineState();
    const comp = c.timeline && c.compositionId ? ops.getComposition(c.timeline, c.compositionId) : undefined;
    timelineActions.setTransition(clipId, { kind: "fade", durationInFrames: Math.round((comp?.fps ?? 30) / 2) });
  }, []);
  const removeTransition = useCallback((clipId: string) => timelineActions.setTransition(clipId, null), []);
  const deleteKeyframe = useCallback((clipId: string, frame: number) => timelineActions.removeKeyframes(clipId, frame), []);
  const toggleTrackFlag = useCallback((trackId: string, flag: "hidden" | "muted" | "locked") => {
    const c = getTimelineState();
    const comp = c.timeline && c.compositionId ? ops.getComposition(c.timeline, c.compositionId) : undefined;
    const track = comp?.tracks.find((tr) => tr.id === trackId);
    if (track) timelineActions.setTrackProps(trackId, { [flag]: !track[flag] });
  }, []);
  const setTrackVolume = useCallback((trackId: string, volume: number) => timelineActions.setTrackProps(trackId, { volume }, `volume:${trackId}`), []);
  const renameTrack = useCallback((trackId: string, name: string) => {
    timelineActions.renameTrack(trackId, name);
    setEditingTrack(null);
  }, []);
  const resetTrackHeight = useCallback((trackId: string) => timelineActions.setTrackHeight(trackId, null), []);
  const renameMarker = useCallback((markerId: string, label: string) => {
    timelineActions.updateMarker(markerId, { label });
    setEditingMarker(null);
  }, []);

  const onDragOver = (e: ReactDragEvent) => {
    if (!hasTimelineDragData(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const row = rowAt(layout.rows, act.lanePoint(e).y);
    const id = row && act.lanePoint(e).y < layout.height ? row.track.id : null;
    if (id !== dropRow) setDropRow(id);
  };
  const onDrop = (e: ReactDragEvent) => {
    if (!hasTimelineDragData(e.dataTransfer) || !timeline) return;
    e.preventDefault();
    setDropRow(null);
    focus();
    const p = act.lanePoint(e);
    const frame = Math.max(0, Math.round(p.x / zoom));
    const row = p.y < layout.height ? rowAt(layout.rows, p.y) : null;
    const trackId = row?.track.id ?? null;
    try {
      const assetData = e.dataTransfer.getData(VIDEO_ASSET_MIME);
      if (assetData) {
        const { assetId } = JSON.parse(assetData) as { assetId: string };
        const asset = timeline.assets.find((a) => a.id === assetId);
        const kind: TrackKind = asset?.kind === "audio" ? "audio" : "video";
        timelineActions.placeAsset(assetId, trackId, frame, newTrackName(kind));
        return;
      }
      const clipData = e.dataTransfer.getData(VIDEO_CLIP_MIME);
      if (clipData) {
        const clip = JSON.parse(clipData) as Clip;
        const placed = { ...clip, id: newId("clip"), from: frame } as Clip;
        timelineActions.placeClip(placed, trackId, newTrackName(ops.trackKindForClip(clip.type)));
      }
    } catch {
      // A malformed payload from another drag source: ignore it.
    }
  };

  /** Renders the composition at the playhead, imports it as a still and holds it for 2 s. */
  const freezeAtPlayhead = async (clipId: string) => {
    const s = getTimelineState();
    if (!s.project || !s.compositionId) return;
    const frame = getPlayhead();
    const { workspace, slug } = s.project;
    try {
      const path = await invoke<string>("video_still", { workspace, slug, compositionId: s.compositionId, frame });
      const [still] = await invoke<Asset[]>("video_import_media", { workspace, slug, paths: [path] });
      if (still) timelineActions.freezeFrame(clipId, frame, still, Math.round(fps * 2));
      setActionError(null);
    } catch (e) {
      setActionError(t.freezeFailed.replace("{error}", e instanceof Error ? e.message : String(e)));
    }
  };

  const menuItems = (m: MenuState): (MenuItem | null)[] => {
    const c = comp;
    if (!c) return [];
    switch (m.kind) {
      case "clip": {
        const loc = ops.locateClip(c, m.clipId);
        const locked = !!loc?.track.locked;
        const ph = getPlayhead();
        const canSplit = selection.clipIds.some((id) => {
          const clip = ops.locateClip(c, id)?.clip;
          return !!clip && clip.from < ph && ops.clipEnd(clip) > ph;
        });
        const prev = ops.adjacentPrev(c, m.clipId);
        const clip = loc?.clip;
        const footage: (MenuItem | null)[] =
          clip?.type === "video"
            ? [
                {
                  label: t.detachAudio,
                  icon: Unlink,
                  disabled: locked || (clip.playbackRate ?? 1) !== 1 || clip.volume === 0,
                  onSelect: () => timelineActions.detachAudio(m.clipId, newTrackName("audio")),
                },
                {
                  label: t.freezeFrame,
                  icon: Snowflake,
                  disabled: locked || ph < clip.from || ph >= ops.clipEnd(clip),
                  onSelect: () => void freezeAtPlayhead(m.clipId),
                },
                {
                  label: t.speed,
                  icon: Gauge,
                  disabled: locked,
                  onSelect: () => {},
                  chips: [0.5, 1, 1.5, 2].map((rate) => ({
                    label: `${rate}×`,
                    active: (clip.playbackRate ?? 1) === rate,
                    onSelect: () => timelineActions.setClipSpeed(m.clipId, rate),
                  })),
                },
                null,
              ]
            : [];
        return [
          { label: t.splitAtPlayhead, icon: Scissors, kbd: "S", disabled: !canSplit || locked, onSelect: () => timelineActions.splitAtPlayhead() },
          { label: t.duplicate, icon: CopyPlus, kbd: "Ctrl+D", disabled: locked, onSelect: () => timelineActions.duplicateSelected() },
          { label: t.copy, icon: Copy, kbd: "Ctrl+C", onSelect: () => timelineActions.copy() },
          { label: t.trimToInOut, icon: Crop, disabled: locked || (inPoint === null && outPoint === null), onSelect: () => timelineActions.trimToInOut() },
          null,
          ...footage,
          loc?.clip.transitionIn
            ? { label: t.removeTransition, disabled: locked, onSelect: () => removeTransition(m.clipId) }
            : { label: t.addTransition, disabled: locked || !prev, onSelect: () => defaultTransition(m.clipId) },
          { label: t.properties, icon: SlidersHorizontal, onSelect: () => timelineActions.showProperties(m.clipId) },
          null,
          { label: t.delete, icon: Trash2, kbd: "Del", danger: true, disabled: locked, onSelect: () => timelineActions.deleteSelected(false) },
          { label: t.rippleDelete, kbd: "Shift+Del", danger: true, disabled: locked, onSelect: () => timelineActions.deleteSelected(true) },
        ];
      }
      case "lane":
        return [
          {
            label: t.pasteHere,
            icon: ClipboardPaste,
            kbd: "Ctrl+V",
            disabled: !hasClipboard,
            onSelect: () => {
              timelineActions.setPlayhead(m.frame);
              timelineActions.paste();
            },
          },
          {
            label: t.addMarker,
            icon: Flag,
            onSelect: () => timelineActions.apply((tl, cid) => ops.addMarker(tl, cid, m.frame).timeline),
          },
        ];
      case "track":
        return [
          { label: t.renameTrack, icon: Pencil, onSelect: () => setEditingTrack(m.trackId) },
          ...TRACK_KINDS.map((kind) => ({
            label: t.addTrackAbove.replace("{kind}", kindName(kind)),
            icon: Plus,
            onSelect: () => {
              const index = c.tracks.findIndex((tr) => tr.id === m.trackId) + 1;
              timelineActions.addTrack(kind, newTrackName(kind), index);
            },
          })),
          null,
          { label: t.deleteTrack, icon: Trash2, danger: true, onSelect: () => timelineActions.removeTrack(m.trackId) },
        ];
      case "marker":
        return [
          { label: t.renameMarker, icon: Pencil, onSelect: () => setEditingMarker(m.markerId) },
          { label: t.deleteMarker, icon: Trash2, danger: true, onSelect: () => timelineActions.removeMarker(m.markerId) },
        ];
      case "addTrack":
        return TRACK_KINDS.map((kind) => ({
          label: kindName(kind),
          icon: Plus,
          onSelect: () => timelineActions.addTrack(kind, newTrackName(kind)),
        }));
    }
  };

  if (status !== "ready" || !comp) {
    return (
      <div className={cn("flex h-full items-center justify-center bg-bg-0 text-[12px] text-text-400", className)}>
        {status === "error" ? (
          <span className="flex max-w-[480px] items-start gap-2 whitespace-pre-wrap text-danger">
            <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
            {t.loadError.replace("{error}", loadError ?? "")}
          </span>
        ) : status === "loading" ? (
          t.loading
        ) : (
          t.noProject
        )}
      </div>
    );
  }

  const inShade = inPoint !== null || outPoint !== null;
  const zoomSlider = (Math.log(zoom) - Math.log(MIN_ZOOM)) / (Math.log(MAX_ZOOM) - Math.log(MIN_ZOOM));

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={t.label}
      className={cn("flex h-full min-h-0 flex-col bg-bg-0 outline-none", className)}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-bg-300 bg-bg-100 px-2">
        <ToolbarButton
          label={t.addTrack}
          icon={Plus}
          text={t.addTrack}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ kind: "addTrack", x: r.left, y: r.bottom + 4 });
          }}
        />
        <span className="mx-1 h-4 w-px bg-bg-300" />
        <ToolbarButton label={t.splitAtPlayhead} kbd="S" icon={Scissors} onClick={() => timelineActions.splitAtPlayhead()} />
        <ToolbarButton
          label={t.delete}
          kbd="Del"
          icon={Trash2}
          disabled={selection.clipIds.length === 0}
          onClick={() => timelineActions.deleteSelected(false)}
        />
        <ToolbarButton label={t.addMarker} kbd="M" icon={Flag} onClick={() => timelineActions.toggleMarkerAtPlayhead()} />
        {actionError && !externalError && !saveError && (
          <span className="ml-2 flex min-w-0 items-center gap-1.5 truncate text-[11.5px] text-danger" data-tooltip={actionError}>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{actionError}</span>
          </span>
        )}
        {(externalError || saveError) && (
          <span
            className="ml-2 flex min-w-0 items-center gap-1.5 truncate text-[11.5px] text-warning"
            data-tooltip={externalError ?? saveError ?? undefined}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{externalError ? t.externalError : t.saveError}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <div role="group" aria-label={t.trackHeight} className="flex items-center gap-0.5">
            {TRACK_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                aria-label={t.trackSizes[size]}
                aria-pressed={trackSize === size}
                data-tooltip={t.trackSizes[size]}
                onClick={() => timelineActions.setTrackSize(size)}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-[6px] text-[11px] font-medium uppercase hover:bg-bg-200",
                  trackSize === size ? "bg-accent/12 text-accent hover:bg-accent/18" : "text-text-300 hover:text-text-100",
                )}
              >
                {size}
              </button>
            ))}
          </div>
          <span className="mx-1 h-4 w-px bg-bg-300" />
          <ToolbarButton label={t.snapping} icon={Magnet} active={snapping} onClick={() => timelineActions.setSnapping(!snapping)} />
          <span className="mx-1 h-4 w-px bg-bg-300" />
          <ToolbarButton label={t.zoomOut} icon={ZoomOut} onClick={() => zoomAround(zoom / 1.5)} />
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={zoomSlider}
            aria-label={t.zoom}
            onChange={(e) => zoomAround(Math.exp(Math.log(MIN_ZOOM) + Number(e.target.value) * (Math.log(MAX_ZOOM) - Math.log(MIN_ZOOM))))}
            className="h-1 w-24 cursor-pointer accent-[var(--accent)]"
          />
          <ToolbarButton label={t.zoomIn} icon={ZoomIn} onClick={() => zoomAround(zoom * 1.5)} />
          <ToolbarButton label={t.zoomFit} icon={Maximize2} onClick={fit} />
          <ShortcutsPopover t={t} open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        </div>
      </div>

      <div ref={scrollerRef} className="relative min-h-0 flex-1 overflow-auto [scrollbar-width:thin]">
        <div className="relative" style={{ width: HEADER_WIDTH + laneWidth, minHeight: RULER_HEIGHT + lanesHeight }}>
          <div className="sticky top-0 z-30 flex" style={{ height: RULER_HEIGHT }}>
            <div className="sticky left-0 z-10 flex shrink-0 items-center border-b border-r border-bg-300 bg-bg-100 px-2" style={{ width: HEADER_WIDTH }}>
              <PlayheadTimecode fps={fps} />
            </div>
            <TimelineRuler
              width={laneWidth}
              zoom={zoom}
              fps={fps}
              durationInFrames={duration}
              viewLeft={view.left}
              viewRight={view.right}
              markers={comp.markers}
              selectedMarkerId={selection.markerId}
              editingMarkerId={editingMarker}
              inPoint={inPoint}
              outPoint={outPoint}
              markerLabel={t.marker}
              onScrubStart={act.rulerPointerDown}
              onMarkerPointerDown={act.markerPointerDown}
              onMarkerContextMenu={openMarkerMenu}
              onMarkerEdit={setEditingMarker}
              onMarkerRename={renameMarker}
            />
          </div>

          <div className="flex">
            <div className="sticky left-0 z-20 shrink-0 bg-bg-100" style={{ width: HEADER_WIDTH, minHeight: lanesHeight }}>
              {layout.rows.map((row) => (
                <TrackHeader
                  key={row.track.id}
                  track={row.track}
                  height={row.height}
                  selected={selection.trackId === row.track.id}
                  editing={editingTrack === row.track.id}
                  t={t}
                  onSelect={timelineActions.selectTrack}
                  onEdit={setEditingTrack}
                  onRename={renameTrack}
                  onToggle={toggleTrackFlag}
                  onVolume={setTrackVolume}
                  onReorderStart={act.trackReorderStart}
                  onResizeStart={act.trackResizeStart}
                  onResetHeight={resetTrackHeight}
                  onContextMenu={openTrackMenu}
                />
              ))}
              {layout.rows.length === 0 && (
                <div className="flex flex-col gap-1 p-2">
                  {TRACK_KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => timelineActions.addTrack(kind, newTrackName(kind))}
                      className="flex items-center gap-2 rounded-[6px] px-2 py-1 text-left text-[12px] text-text-300 hover:bg-bg-200 hover:text-text-100"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {kindName(kind)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div
              ref={lanesRef}
              className="relative"
              style={{ width: laneWidth, height: lanesHeight }}
              onPointerDown={act.lanePointerDown}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ kind: "lane", x: e.clientX, y: e.clientY, frame: Math.round(act.frameAt(e)) });
              }}
              onDragOver={onDragOver}
              onDragLeave={() => setDropRow(null)}
              onDrop={onDrop}
            >
              <div className="pointer-events-none absolute inset-y-0 right-0 bg-bg-200/50" style={{ left: duration * zoom }} />
              {layout.rows.map((row) => {
                const fromFrame = view.left / zoom;
                const toFrame = view.right / zoom;
                return (
                  <div
                    key={row.track.id}
                    className={cn(
                      "absolute inset-x-0 border-b border-bg-300/70",
                      row.track.locked && "bg-[repeating-linear-gradient(135deg,transparent_0_6px,color-mix(in_srgb,var(--bg-300)_45%,transparent)_6px_7px)]",
                      dropRow === row.track.id && "bg-accent/10",
                    )}
                    style={{ top: row.top, height: row.height }}
                  >
                    {visibleClips(row.track.clips, fromFrame, toFrame).map((clip) => {
                      const isSel = selected.has(clip.id);
                      return (
                        <TimelineClip
                          key={clip.id}
                          agentTouched={agentClips.includes(clip.id)}
                          clip={clip}
                          asset={"assetId" in clip ? assets.get(clip.assetId) : undefined}
                          project={mediaProject}
                          fps={fps}
                          zoom={zoom}
                          height={row.height}
                          selected={isSel}
                          locked={!!row.track.locked}
                          dimmed={!!row.track.hidden || (!!row.track.muted && row.track.kind === "audio")}
                          showKeyframes={isSel && selection.clipIds.length === 1}
                          canTransition={joined.has(clip.id)}
                          viewLeft={view.left}
                          viewRight={view.right}
                          typeLabel={t.clipTypes[clip.type]}
                          addTransitionLabel={t.addTransition}
                          transitionLabel={t.transition}
                          keyframeLabel={t.keyframe}
                          onPointerDown={act.clipPointerDown}
                          onContextMenu={openClipMenu}
                          onKeyframePointerDown={act.keyframePointerDown}
                          onKeyframeDelete={deleteKeyframe}
                          onTransitionPointerDown={act.transitionPointerDown}
                          onAddTransition={defaultTransition}
                          onRemoveTransition={removeTransition}
                        />
                      );
                    })}
                  </div>
                );
              })}

              {inShade && (
                <>
                  {inPoint !== null && inPoint > 0 && (
                    <div className="pointer-events-none absolute inset-y-0 left-0 z-10 bg-black/15 dark:bg-black/30" style={{ width: inPoint * zoom }} />
                  )}
                  {outPoint !== null && (
                    <div className="pointer-events-none absolute inset-y-0 right-0 z-10 bg-black/15 dark:bg-black/30" style={{ left: outPoint * zoom }} />
                  )}
                </>
              )}
              {guide !== null && (
                <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-accent" style={{ left: guide * zoom }} />
              )}
              {marquee && (
                <div
                  className="pointer-events-none absolute z-20 rounded-[2px] border border-accent bg-accent/10"
                  style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
                />
              )}
              <PlayheadLine zoom={zoom} />
              {layout.rows.length === 0 && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-text-400">{t.empty}</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />}
    </div>
  );
}

function ToolbarButton({
  label,
  icon: Icon,
  text,
  kbd,
  active,
  disabled,
  onClick,
}: {
  label: string;
  icon: typeof Plus;
  text?: string;
  kbd?: string;
  active?: boolean;
  disabled?: boolean;
  onClick(e: ReactMouseEvent<HTMLButtonElement>): void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      aria-keyshortcuts={kbd}
      data-tooltip={text ? undefined : label}
      data-tooltip-kbd={text ? undefined : kbd}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-[6px] px-1.5 text-[12px] hover:bg-bg-200 disabled:pointer-events-none disabled:opacity-40",
        active ? "bg-accent/12 text-accent hover:bg-accent/18" : "text-text-300 hover:text-text-100",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {text && <span>{text}</span>}
    </button>
  );
}

/** Playhead line over the lanes; the only part of the lanes that re-renders during playback. */
function PlayheadLine({ zoom }: { zoom: number }) {
  const frame = usePlayhead();
  return <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-danger" style={{ left: frame * zoom }} />;
}

function PlayheadTimecode({ fps }: { fps: number }) {
  const frame = usePlayhead();
  return <span className="font-mono text-[12px] tabular-nums text-text-200">{formatTimecode(frame, fps)}</span>;
}
