import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  X,
  ScrollText,
  Terminal as TerminalIcon,
  Folder,
  Play,
  Boxes,
  GitBranch,
  Bot,
  Maximize2,
  Minimize2,
  Shapes,
  Clapperboard,
  MessageCircleQuestion,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { accountKey } from "@/lib/accountScope";
import { loadReloadState, saveReloadState } from "@/lib/reloadState";
import type { PickedElement } from "@/components/ui/claude-style-chat-input";
import { useTranslations, type Translations } from "@/lib/i18n";
import { DiffPanel, type DiffFocus } from "@/components/DiffPanel";
import { TaskRegistryPanel } from "@/components/TaskRegistryPanel";
import { getTaskRegistry } from "@/lib/taskRegistrySingleton";
import { BackgroundTasksView } from "./views/BackgroundTasksView";
import { TerminalView } from "./views/TerminalView";
import { PlanView } from "./views/PlanView";
import { FilesView } from "./views/FilesView";
import { PreviewView } from "./views/PreviewView";
import { VideoView } from "./video/VideoView";
import { setPanelVisual, usePanelVisual } from "@/lib/visualPanel";
import { closeViewGuarded } from "@/lib/viewCloseGuard";
import { VisualCanvas } from "./views/VisualCanvas";

export type ViewId = "preview" | "terminal" | "files" | "background" | "diff" | "plan" | "fleet" | "visual" | "video" | "sidechat";

const VIEWS: { id: ViewId; icon: typeof ScrollText }[] = [
  { id: "preview", icon: Play },
  { id: "terminal", icon: TerminalIcon },
  { id: "files", icon: Folder },
  { id: "background", icon: Boxes },
  { id: "diff", icon: GitBranch },
  { id: "plan", icon: ScrollText },
  { id: "fleet", icon: Bot },
  { id: "visual", icon: Shapes },
  { id: "video", icon: Clapperboard },
  { id: "sidechat", icon: MessageCircleQuestion },
];

const VIEW_LABEL_KEY: Partial<Record<ViewId, keyof Translations["views"]>> = {
  preview: "preview",
  terminal: "terminal",
  files: "files",
  background: "backgroundTasks",
  diff: "diff",
  plan: "plan",
  fleet: "agentsView",
};

function viewMeta(id: ViewId) {
  return VIEWS.find((v) => v.id === id) ?? VIEWS[0];
}

function viewLabel(t: Translations["views"], id: ViewId): string {
  const key = VIEW_LABEL_KEY[id];
  return key ? t[key] : id;
}

const WIDTH_KEY = "nyxs.viewsWidth";
const LAYOUT_KEY = "nyxs.viewsLayout";

// Narrow enough to give the panel most of the window, wide enough to keep the composer usable.
const MIN_CHAT = 380;

const MIN_PANEL = 600;
/** Two columns of views need more room than one. */
const MIN_PANEL_TWO_COLUMNS = 760;
const MIN_PANE_WIDTH = 260;
const MIN_PANE_HEIGHT = 120;
const VIDEO_KEEP_MS = 10 * 60_000;
const GAP = 8;

/** Where the splitters sit, as fractions: between the two columns, and between the two views
 *  of each column. */
interface Layout {
  col: number;
  rows: [number, number];
}

const DEFAULT_LAYOUT: Layout = { col: 0.5, rows: [0.5, 0.5] };

function loadLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(accountKey(LAYOUT_KEY)) ?? "null") as Partial<Layout> | null;
    const frac = (v: unknown, d: number) => (typeof v === "number" && v > 0 && v < 1 ? v : d);
    return {
      col: frac(saved?.col, 0.5),
      rows: [frac(saved?.rows?.[0], 0.5), frac(saved?.rows?.[1], 0.5)],
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** One view fills the panel; two stack; a third opens a second column; a fourth splits it. */
function paneRects(n: number, layout: Layout): Rect[] {
  const twoColumns = n > 2;
  return Array.from({ length: n }, (_, i) => {
    const c = i < 2 ? 0 : 1;
    const row = c === 0 ? i : i - 2;
    const rowsInColumn = c === 0 ? Math.min(n, 2) : n - 2;
    return {
      x0: c === 0 ? 0 : layout.col,
      x1: !twoColumns || c === 1 ? 1 : layout.col,
      y0: row === 0 ? 0 : layout.rows[c],
      y1: rowsInColumn === 1 || row === 1 ? 1 : layout.rows[c],
    };
  });
}

/** A fraction of the panel as CSS, leaving half the gap on each inner edge. */
function span(from: number, to: number): { start: string; size: string } {
  const lead = from > 0 ? GAP / 2 : 0;
  const trail = to < 1 ? GAP / 2 : 0;
  return {
    start: `calc(${from * 100}% + ${lead}px)`,
    size: `calc(${(to - from) * 100}% - ${lead + trail}px)`,
  };
}

function rectStyle(r: Rect): CSSProperties {
  const x = span(r.x0, r.x1);
  const y = span(r.y0, r.y1);
  return { left: x.start, width: x.size, top: y.start, height: y.size };
}

export interface PreviewSlot {
  slot: string;
  workspace: string | null;
  previewFile: string;
}

interface ViewsPanelProps {
  open: boolean;
  /** The views on screen, in the order they were opened (at most four). */
  views: ViewId[];
  onCloseView: (view: ViewId) => void;
  plan: string;
  workspace: string | null;
  previews: PreviewSlot[];
  activePreviewSlot?: string;
  diffNonce?: number;
  /** A file the changes view should open at (a reply's "files edited" row was clicked). */
  diffFocus?: DiffFocus | null;
  onRequestDevServer?: () => void;
  onAddServer?: () => void;

  onPickElement?: (element: PickedElement) => void;
  onAttachImage?: (file: File) => void;
  chatId?: string;
  /** The panel was maximized over the chat, or brought back beside it. */
  onMaximizedChange?: (maximized: boolean) => void;
  /** The session's side chat, drawn with the pane's maximize button. */
  sideChat?: (pane: { onToggleMaximize: () => void; maximized: boolean }) => ReactNode;
}

type Drag = "panel" | "col" | 0 | 1;

const OFF = { on: false, solo: null as ViewId | null };

export function ViewsPanel({ open, views, onCloseView, plan, workspace, previews, activePreviewSlot, diffNonce, diffFocus, onRequestDevServer, onAddServer, onPickElement, onAttachImage, chatId, onMaximizedChange, sideChat }: ViewsPanelProps) {
  const tViews = useTranslations().views;
  const panelVisual = usePanelVisual();
  const asideRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => Number(localStorage.getItem(accountKey(WIDTH_KEY))) || MIN_PANEL);
  const [layout, setLayout] = useState<Layout>(loadLayout);

  // Maximized, the panel takes the chat's place too (the chat stays mounted, just hidden). From
  // a view's own button only that view shows; from the panel's edge, all of them.
  const [maxState, setMaxState] = useState(OFF);
  const shown = open ? views : [];
  const maximized = open && maxState.on && (maxState.solo === null || shown.includes(maxState.solo));
  if (maxState.on && !maximized) setMaxState(OFF);
  const panes = maximized && maxState.solo ? [maxState.solo] : shown;
  const twoColumns = panes.length > 2;
  const minPanel = twoColumns ? MIN_PANEL_TWO_COLUMNS : MIN_PANEL;
  const minPanelRef = useRef(minPanel);
  useEffect(() => { minPanelRef.current = minPanel; }, [minPanel]);

  // Once opened, a project's terminal stays mounted (just hidden) so its shells — and a dev
  // server running in one — survive closing the view or moving to a session in another
  // project: each project keeps its own terminal, and only the current project's is shown.
  // They also survive a reload of the app's page.
  const [terminalWorkspaces, setTerminalWorkspaces] = useState<string[]>(
    () => loadReloadState<string[]>("terminalWorkspaces") ?? [],
  );
  const wsKey = workspace ?? "";
  const showTerminal = panes.includes("terminal");
  const showPreview = panes.includes("preview");
  if (showTerminal && !terminalWorkspaces.includes(wsKey)) setTerminalWorkspaces([...terminalWorkspaces, wsKey]);
  useEffect(() => saveReloadState("terminalWorkspaces", terminalWorkspaces.length ? terminalWorkspaces : null), [terminalWorkspaces]);
  const terminalStarted = terminalWorkspaces.length > 0;

  // Once opened, the Video view stays mounted (just hidden) so coming back doesn't restart its
  // player, on the folder it was last shown for: it has one document open at a time, and
  // another project's chat without the view shouldn't replace it. After a while out of sight
  // it goes, and its server with it.
  const showVideo = panes.includes("video");
  const [videoKept, setVideoKept] = useState<{ workspace: string | null } | null>(null);
  if (showVideo && videoKept?.workspace !== workspace) setVideoKept({ workspace });
  const hasKeptVideo = videoKept !== null;
  useEffect(() => {
    if (showVideo || !hasKeptVideo) return;
    const id = setTimeout(() => setVideoKept(null), VIDEO_KEEP_MS);
    return () => clearTimeout(id);
  }, [showVideo, hasKeptVideo]);

  const maxPanelWidth = () => {
    const chatLeft = asideRef.current?.previousElementSibling?.getBoundingClientRect().left ?? 0;
    return Math.max(minPanelRef.current, window.innerWidth - chatLeft - MIN_CHAT);
  };

  const pinnedRef = useRef(false);
  const maximizedRef = useRef(false);
  /** The panel's edge is being dragged: its width lives on the element until the drag ends. */
  const panelDragRef = useRef(false);
  useEffect(() => {
    maximizedRef.current = maximized;
    onMaximizedChange?.(maximized);
  }, [maximized, onMaximizedChange]);

  useEffect(() => {
    if (!open) return;
    const adjust = () => {
      // The hidden chat measures zero; its width is fitted again once it's back.
      if (maximizedRef.current || panelDragRef.current) return;
      // Minimized, the window shrinks the app's page to nothing (the window itself never gets
      // this narrow). Fitting the panel to that pinned it to the edge, so once the window was
      // back it stretched over the chat.
      if (window.innerWidth < MIN_CHAT || document.hidden) return;
      const max = maxPanelWidth();
      setWidth((w) => {
        const next = pinnedRef.current ? max : Math.min(w, max);
        // A window too narrow for the panel beside the chat leaves it at its minimum, which is
        // also its maximum there: that says nothing of the user pinning it to the edge, and
        // pinning it then stretched it over the chat once the window was wide again.
        if (max > minPanelRef.current) pinnedRef.current = next >= max - 1;
        return next;
      });
    };
    adjust();
    window.addEventListener("resize", adjust);

    const chatEl = asideRef.current?.previousElementSibling;
    const ro = chatEl ? new ResizeObserver(adjust) : null;
    if (chatEl && ro) ro.observe(chatEl);
    return () => {
      window.removeEventListener("resize", adjust);
      ro?.disconnect();
    };
  }, [open]);

  // A native webview follows its box only when the box changes size; moving between places of
  // the same size needs a nudge.
  const arrangement = panes.join(",");
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(id);
  }, [arrangement]);

  // Leaving the maximized panel, the panel takes its width back first and the chat shows again
  // a render later (App hides it from onMaximizedChange), moving the panel without resizing it:
  // the page stayed over the chat. The chat's own box changes then, so it gives the nudge.
  useEffect(() => {
    const chatEl = asideRef.current?.previousElementSibling;
    if (!open || !chatEl) return;
    // Dragging the panel's edge the page's box changes size by itself, and a resize for the whole
    // app on every frame of the drag only costs smoothness.
    const ro = new ResizeObserver(() => { if (!panelDragRef.current) window.dispatchEvent(new Event("resize")); });
    ro.observe(chatEl);
    return () => ro.disconnect();
  }, [open]);

  const [drag, setDrag] = useState<Drag | null>(null);
  useEffect(() => {
    if (drag === null) return;
    document.body.style.userSelect = "none";
    return () => { document.body.style.userSelect = ""; };
  }, [drag]);

  const persistWidth = (w: number) => {
    try { localStorage.setItem(accountKey(WIDTH_KEY), String(w)); } catch { /* storage unavailable */ }
  };
  const persistLayout = (l: Layout) => {
    try { localStorage.setItem(accountKey(LAYOUT_KEY), JSON.stringify(l)); } catch { /* storage unavailable */ }
  };

  const track = (kind: Drag, onMove: (ev: MouseEvent) => void, onDone: () => void) => {
    setDrag(kind);
    const up = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", up);
      setDrag(null);
      onDone();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", up);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    let latest = Math.max(width, minPanel);
    const max = maxPanelWidth();
    panelDragRef.current = true;
    track(
      "panel",
      (ev) => {
        latest = Math.min(max, Math.max(minPanel, window.innerWidth - ev.clientX));
        // Straight on the element: a state change here renders every open view on every frame.
        if (asideRef.current) asideRef.current.style.width = `${latest}px`;
      },
      () => {
        panelDragRef.current = false;
        pinnedRef.current = latest >= max - 1;
        setWidth(latest);
        persistWidth(latest);
        requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
      },
    );
  };

  const startSplit = (kind: "col" | 0 | 1) => (e: React.MouseEvent) => {
    e.preventDefault();
    const box = gridRef.current?.getBoundingClientRect();
    if (!box) return;
    let latest = layout;
    track(
      kind,
      (ev) => {
        const clamp = (v: number, minPx: number, total: number) => {
          const m = Math.min(0.5, minPx / total);
          return Math.min(1 - m, Math.max(m, v));
        };
        latest =
          kind === "col"
            ? { ...latest, col: clamp((ev.clientX - box.left) / box.width, MIN_PANE_WIDTH, box.width) }
            : {
                ...latest,
                rows: kind === 0
                  ? [clamp((ev.clientY - box.top) / box.height, MIN_PANE_HEIGHT, box.height), latest.rows[1]]
                  : [latest.rows[0], clamp((ev.clientY - box.top) / box.height, MIN_PANE_HEIGHT, box.height)],
              };
        setLayout(latest);
      },
      () => persistLayout(latest),
    );
  };

  const resetSplit = (kind: "col" | 0 | 1) => {
    const next: Layout =
      kind === "col" ? { ...layout, col: 0.5 } : { ...layout, rows: kind === 0 ? [0.5, layout.rows[1]] : [layout.rows[0], 0.5] };
    setLayout(next);
    persistLayout(next);
  };

  const togglePanelMaximize = () => setMaxState(maximized ? OFF : { on: true, solo: null });
  const paneMaximized = (v: ViewId) => maximized && (maxState.solo === v || panes.length === 1);
  const paneMaximize = (v: ViewId) => () => setMaxState(paneMaximized(v) ? OFF : { on: true, solo: v });

  if (!open && !terminalStarted && previews.length === 0 && !videoKept) return null;

  const rects = paneRects(panes.length, layout);
  const place = (v: ViewId): CSSProperties | null => {
    const i = panes.indexOf(v);
    return i < 0 ? null : rectStyle(rects[i]);
  };
  const paneClass = (v: ViewId) =>
    cn(
      "absolute flex flex-col overflow-hidden rounded-[8px] border border-bg-300 bg-bg-100 shadow-sm",
      v === "terminal" && "dark:bg-[#1a1a18]",
    );

  /** Views without a header of their own get the panel's: name, maximize, close. */
  const withHeader = (v: ViewId, body: ReactNode) => {
    const meta = viewMeta(v);
    const isMax = paneMaximized(v);
    return (
      <>
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2 text-[13px] font-medium text-text-100">
            <meta.icon className="w-4 h-4 text-text-300" />
            <span className="truncate">{viewLabel(tViews, v)}</span>
          </div>
          <div className="flex items-center gap-0.5">
            <button onClick={paneMaximize(v)} aria-label={isMax ? tViews.showChat : tViews.diffExpandPanel} className="p-1.5 rounded-[6px] text-text-400 hover:text-text-200 hover:bg-bg-200">
              {isMax ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button onClick={() => closeViewGuarded(v, () => onCloseView(v))} aria-label={tViews.close} className="p-1.5 rounded-[6px] text-text-400 hover:text-text-200 hover:bg-bg-200">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0">{body}</div>
      </>
    );
  };

  const content = (v: ViewId): ReactNode => {
    switch (v) {
      case "files":
        return withHeader(v, <FilesView workspace={workspace} />);
      case "background":
        return <BackgroundTasksView sessionId={chatId} workspace={workspace} onClose={() => onCloseView(v)} onToggleMaximize={paneMaximize(v)} maximized={paneMaximized(v)} />;
      case "diff":
        return <DiffPanel workspace={workspace} refreshKey={diffNonce ?? 0} focus={diffFocus} onClose={() => onCloseView(v)} onToggleMaximize={paneMaximize(v)} maximized={paneMaximized(v)} />;
      case "fleet":
        return withHeader(v, <TaskRegistryPanel registry={getTaskRegistry()} />);
      case "plan":
        return withHeader(v, <PlanView plan={plan} />);
      case "sidechat":
        return sideChat?.({ onToggleMaximize: paneMaximize(v), maximized: paneMaximized(v) }) ?? null;
      case "visual":
        return panelVisual ? (
          <VisualCanvas
            visual={panelVisual}
            active={!showPreview}
            onClose={() => setPanelVisual(null)}
            onToggleMaximize={paneMaximize(v)}
            maximized={paneMaximized(v)}
            onPickElement={onPickElement}
            onAttachImage={onAttachImage}
          />
        ) : null;
      default:
        return null;
    }
  };

  const splitter = (kind: "col" | 0 | 1, style: CSSProperties) => (
    <div
      key={`split-${kind}`}
      onMouseDown={startSplit(kind)}
      onDoubleClick={() => resetSplit(kind)}
      className={cn("group absolute z-10 flex items-center justify-center", kind === "col" ? "cursor-col-resize" : "cursor-row-resize")}
      style={style}
    >
      <span className={cn("rounded-full bg-accent/60 opacity-0 transition-opacity group-hover:opacity-100", kind === "col" ? "h-10 w-0.5" : "h-0.5 w-10", drag === kind && "opacity-100")} />
    </div>
  );

  const splitters: ReactNode[] = [];
  if (twoColumns) {
    splitters.push(splitter("col", { left: `calc(${layout.col * 100}% - ${GAP / 2}px)`, width: GAP, top: 0, bottom: 0 }));
  }
  ([0, 1] as const).forEach((c) => {
    const rowsInColumn = c === 0 ? Math.min(panes.length, 2) : panes.length - 2;
    if (rowsInColumn < 2) return;
    const x = span(c === 0 ? 0 : layout.col, !twoColumns || c === 1 ? 1 : layout.col);
    splitters.push(splitter(c, { left: x.start, width: x.size, top: `calc(${layout.rows[c] * 100}% - ${GAP / 2}px)`, height: GAP }));
  });

  return (
    <aside
      ref={asideRef}
      className={cn(
        "relative h-[calc(100%-1rem)] my-2 mr-2 flex flex-col",
        maximized ? "flex-1 min-w-0 ml-2" : "shrink-0",
        !open && "hidden",
      )}
      style={maximized ? undefined : { width: Math.max(width, minPanel) }}
    >
      {!maximized && (
        <div data-panel-resize onMouseDown={startResize} onDoubleClick={togglePanelMaximize} className="absolute left-0 top-0 h-full w-1.5 cursor-col-resize z-20" />
      )}
      {drag !== null && (
        <div data-drag-shield className={cn("fixed inset-0 z-[60]", drag === "panel" || drag === "col" ? "cursor-col-resize" : "cursor-row-resize")} />
      )}
      <div ref={gridRef} className="relative flex-1 min-h-0">
        {terminalWorkspaces.map((ws) => {
          const style = showTerminal && ws === wsKey ? place("terminal") : null;
          return (
            <div key={`terminal:${ws}`} className={style ? paneClass("terminal") : "hidden"} style={style ?? undefined}>
              <TerminalView
                workspace={ws || null}
                onClose={() => onCloseView("terminal")}
                visible={!!style}
                onToggleMaximize={paneMaximize("terminal")}
                maximized={paneMaximized("terminal")}
              />
            </div>
          );
        })}
        {previews.map((p) => {
          const style = showPreview && p.slot === activePreviewSlot ? place("preview") : null;
          return (
            <div key={`preview:${p.slot}`} className={style ? paneClass("preview") : "hidden"} style={style ?? undefined}>
              <PreviewView
                persistKey={p.slot}
                workspace={p.workspace}
                requestedFile={p.previewFile}
                onRequestDevServer={onRequestDevServer}
                onAddServer={onAddServer}
                onClose={() => onCloseView("preview")}
                onToggleMaximize={paneMaximize("preview")}
                maximized={paneMaximized("preview")}
                onPickElement={onPickElement}
                onAttachImage={onAttachImage}
                visible={!!style}
              />
            </div>
          );
        })}
        {videoKept && (
          <div key="video" className={showVideo ? paneClass("video") : "hidden"} style={place("video") ?? undefined}>
            <VideoView workspace={videoKept.workspace} chatId={chatId} onClose={() => onCloseView("video")} onToggleMaximize={paneMaximize("video")} maximized={paneMaximized("video")} visible={showVideo} />
          </div>
        )}
        {panes
          .filter((v) => v !== "terminal" && v !== "preview" && v !== "video")
          .map((v) => (
            <div key={v} className={paneClass(v)} style={place(v) ?? undefined}>
              {content(v)}
            </div>
          ))}
        {splitters}
      </div>
    </aside>
  );
}

export default ViewsPanel;
