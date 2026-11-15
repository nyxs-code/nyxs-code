import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronLeft, Clapperboard, Download, Loader2, PanelLeft, PanelRight, Redo2, Square, Undo2, X, Wrench } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { checkExternalChange, closeTimeline, getTimelineState, openTimeline, SHOW_CLIP_PROPERTIES_EVENT, timelineActions, usePlayhead, useTimelineStore } from "@/lib/video/timelineStore";
import { readTimeline, writeTimeline, type VideoProjectInfo } from "@/lib/video/videoApi";
import { registerEditorShell, stopVideoAgent, useVideoAgentActivity } from "@/lib/video/videoControl";
import { Button } from "@/components/ui/button";
import { Inspector } from "./inspector/Inspector";
import { Select } from "./inspector/fields";
import { MediaBin } from "./MediaBin";
import { useNewMedia } from "./useNewMedia";
import { repairTimelineJson } from "./timelineRepair";
import { ProjectMenu } from "./ProjectMenu";
import { thumbnailUrl } from "./media";
import { RenameInput, type ThumbUpdates } from "./ProjectPicker";
import type { ProjectActions } from "./useProjectActions";
import { IconBtn, PlayerPane } from "./PlayerPane";
import { RenderDialog } from "./render/RenderDialog";
import { RenderQueue } from "./render/RenderQueue";
import { isRenderActive, useRenderJobs } from "./render/renderJobs";
import { Timeline } from "./timeline/Timeline";
import { usePlayer } from "./usePlayer";
import { NARROW_BIN, NARROW_INSPECTOR, type EditorBox, type VideoSplit } from "./layoutBounds";
import { useVideoLayout } from "./useVideoLayout";
import { loadResume, trackResume } from "./projectResume";

export interface EditorStart {
  compositionId?: string;
  frame?: number;
}

interface Props {
  workspace: string;
  project: VideoProjectInfo;
  start: EditorStart | null;
  onBack: () => void;
  /** The view's own buttons (maximize, close), at the right of the top bar. */
  viewButtons: ReactNode;
  /** Rename, duplicate, delete… shared with the picker (VideoView owns them and the dialog). */
  projectActions: ProjectActions;
  /** False while the view is mounted but out of sight. */
  visible: boolean;
  /** A newer thumbnail than the project's, if one arrived. */
  thumbUpdate?: ThumbUpdates[string];
  /** The chat whose panel it is in. */
  chatId?: string;
}

export function VideoEditor({ workspace, project, start, onBack, viewButtons, projectActions, visible, thumbUpdate, chatId }: Props) {
  const t = useTranslations().videoPanel;
  const slug = project.slug;
  const [box, setBox] = useState<EditorBox>({ width: 1200, height: 900 });
  const { layout, sizes, sides, range, dragging, startDrag, onSplitKey, toggle } = useVideoLayout(box);
  const { width } = box;
  const rootRef = useRef<HTMLDivElement>(null);
  const [renderOpen, setRenderOpen] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);

  /** "Repair": sorts clips and moves overlapping ones to new tracks in timeline.json (on disk),
   *  then opens it again ("open") or takes it as the outside change it was ("external"). */
  const repair = async (mode: "open" | "external") => {
    setRepairing(true);
    setRepairError(null);
    try {
      const r = repairTimelineJson(await readTimeline(workspace, slug));
      if (!r.ok) {
        setRepairError(t.repairFailed.replace("{error}", r.errors.slice(0, 4).join("\n")));
        return;
      }
      await writeTimeline(workspace, slug, r.json);
      if (mode === "open") await openTimeline(workspace, slug);
      else await checkExternalChange();
    } catch (e) {
      setRepairError(t.repairFailed.replace("{error}", e instanceof Error ? e.message : String(e)));
    } finally {
      setRepairing(false);
    }
  };
  const [queueOpen, setQueueOpen] = useState(false);
  const queueBtnRef = useRef<HTMLButtonElement>(null);

  const status = useTimelineStore((s) => s.status);
  const loadError = useTimelineStore((s) => s.error);
  const externalError = useTimelineStore((s) => s.externalError);
  const saveError = useTimelineStore((s) => s.saveError);
  const timeline = useTimelineStore((s) => s.timeline);
  const compositionId = useTimelineStore((s) => s.compositionId);
  const canUndo = useTimelineStore((s) => s.canUndo);
  const canRedo = useTimelineStore((s) => s.canRedo);
  const inPoint = useTimelineStore((s) => s.inPoint);
  const outPoint = useTimelineStore((s) => s.outPoint);
  const playhead = usePlayhead();
  const comp = timeline?.compositions.find((c) => c.id === compositionId) ?? null;
  const activeRenders = useRenderJobs().filter((j) => j.workspace === workspace && j.slug === slug && isRenderActive(j)).length;

  useNewMedia(workspace, slug, status === "ready");
  const player = usePlayer(workspace, slug, projectActions.serverEpoch, visible);
  // The poster shows the project's main composition; another one would flash the wrong picture.
  const poster = compositionId === project.compositions[0]?.id ? thumbnailUrl(thumbUpdate?.path ?? project.thumbnail, thumbUpdate?.version) : null;

  // Out of sight, another project's file watcher may have replaced ours: catch up on return.
  useEffect(() => {
    if (visible && getTimelineState().status === "ready") void checkExternalChange();
  }, [visible]);
  const { actions } = player;

  // Open the document once per project, where it was left (composition, playhead, zoom) unless
  // the agent's VideoOpen asked for a place; then keep remembering where it is.
  const startRef = useRef(start);
  useEffect(() => {
    let alive = true;
    let stopResume: (() => void) | null = null;
    const saved = loadResume(workspace, slug);
    const at = startRef.current;
    void openTimeline(workspace, slug, { compositionId: at?.compositionId ?? saved?.compositionId }).then(() => {
      if (!alive) return;
      const frame = at?.frame ?? (at?.compositionId ? undefined : saved?.frame);
      if (frame !== undefined) timelineActions.setPlayhead(frame);
      if (saved) timelineActions.restoreView(saved);
      stopResume = trackResume(workspace, slug);
    });
    return () => {
      alive = false;
      stopResume?.();
      void closeTimeline();
    };
  }, [workspace, slug]);
  useEffect(() => {
    startRef.current = start;
    if (!start || getTimelineState().status !== "ready") return;
    if (start.compositionId) timelineActions.setComposition(start.compositionId);
    if (start.frame !== undefined) timelineActions.setPlayhead(start.frame);
  }, [start]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      // Hidden (display: none) measures zero: the layout stays as it was for when it returns.
      if (e.contentRect.width > 0) setBox({ width: e.contentRect.width, height: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // "Properties" in the timeline's clip menu brings the inspector back if it was folded away.
  useEffect(() => {
    const show = () => {
      if (!layout.inspectorOpen) toggle("inspectorOpen");
    };
    window.addEventListener(SHOW_CLIP_PROPERTIES_EVENT, show);
    return () => window.removeEventListener(SHOW_CLIP_PROPERTIES_EVENT, show);
  }, [layout.inspectorOpen, toggle]);

  const { showBin, showInspector } = sides;

  // What the agent's video tools need of this editor; a ref, as it changes on every render.
  const shellRef = useRef({ visible, chatId, showBin, showInspector, toggle });
  useEffect(() => { shellRef.current = { visible, chatId, showBin, showInspector, toggle }; });
  useEffect(
    () =>
      registerEditorShell({
        workspace,
        slug,
        get chat() { return shellRef.current.chatId; },
        visible: () => shellRef.current.visible && (rootRef.current?.getClientRects().length ?? 0) > 0,
        root: () => rootRef.current,
        panels: () => ({ bin: shellRef.current.showBin, inspector: shellRef.current.showInspector }),
        togglePanel: (panel) => shellRef.current.toggle(panel === "bin" ? "binOpen" : "inspectorOpen"),
        timelineWidth: () => rootRef.current?.clientWidth ?? 0,
      }),
    [workspace, slug],
  );
  const agent = useVideoAgentActivity(workspace, slug);

  /** Transport keys work anywhere in the editor except while typing; the timeline handles its
   *  own keys first and marks them handled. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea, select, [contenteditable='true']")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    let handled = true;
    if (mod && (k === "z" || k === "Z")) {
      if (e.shiftKey) timelineActions.redo();
      else timelineActions.undo();
    } else if (mod && (k === "y" || k === "Y")) timelineActions.redo();
    else if (mod) handled = false;
    else if (k === " ") actions.toggle();
    else if (k === "ArrowLeft") actions.step(e.shiftKey ? -10 : -1);
    else if (k === "ArrowRight") actions.step(e.shiftKey ? 10 : 1);
    else if (k === "Home") actions.toStart();
    else if (k === "End") actions.toEnd();
    else if (k === "j" || k === "J") actions.shuttle(-1);
    else if (k === "k" || k === "K") actions.stopShuttle();
    else if (k === "l" || k === "L") actions.shuttle(1);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  /** A 1 px line that takes no room, with a grip always visible and a 10 px grab area over its
   *  neighbours. Above the player's iframe, which would swallow the mouse otherwise. */
  const splitter = (kind: VideoSplit) => {
    const row = kind === "timeline";
    const active = dragging === kind;
    const [min, max] = range(kind);
    const label = kind === "timeline" ? t.resizeTimeline : kind === "bin" ? t.resizeMedia : t.resizeInspector;
    return (
      <div
        role="separator"
        tabIndex={0}
        aria-orientation={row ? "horizontal" : "vertical"}
        aria-label={label}
        aria-valuenow={sizes[kind]}
        aria-valuemin={min}
        aria-valuemax={max}
        data-tooltip={dragging ? undefined : t.resizeHint}
        onMouseDown={startDrag(kind)}
        onKeyDown={onSplitKey(kind)}
        className={cn(
          "group relative z-20 shrink-0 outline-none transition-colors hover:bg-accent/70 focus-visible:bg-accent",
          row ? "h-px w-full cursor-row-resize" : "w-px self-stretch cursor-col-resize",
          active ? "bg-accent" : "bg-bg-300",
        )}
      >
        <span aria-hidden className={cn("absolute", row ? "inset-x-0 -top-[5px] h-[11px]" : "inset-y-0 -left-[5px] w-[11px]")} />
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-sm transition-colors group-hover:bg-accent group-focus-visible:bg-accent",
            row ? "h-1 w-8" : "h-8 w-1",
            active ? "bg-accent" : "bg-text-400/70",
          )}
        />
      </div>
    );
  };

  const compOptions = (timeline?.compositions ?? []).map((c) => ({ value: c.id, label: c.name || c.id }));

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className="flex h-full min-h-0 flex-col outline-none">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-bg-300/70 pl-1.5 pr-1.5">
        <IconBtn label={t.backToProjects} onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
        </IconBtn>
        <Clapperboard className="ml-0.5 h-4 w-4 shrink-0 text-text-300" />
        {projectActions.renaming === slug ? (
          <RenameInput initial={project.name} label={t.renameProject} onCommit={(name) => projectActions.rename(project, name)} onCancel={projectActions.cancelRename} className="w-[180px]" />
        ) : (
          <span onDoubleClick={project.kind === "remotion" ? undefined : () => projectActions.startRename(slug)} className="min-w-0 max-w-[180px] truncate text-[13px] font-medium text-text-100">{project.name}</span>
        )}
        <ProjectMenu workspace={workspace} project={project} actions={projectActions} onError={setMenuError} />
        {compOptions.length > 1 && (
          <Select
            aria-label={t.composition}
            className="ml-1 max-w-[160px] flex-none"
            value={compositionId ?? ""}
            options={compOptions}
            onChange={(id) => timelineActions.setComposition(id)}
          />
        )}
        {comp && (
          <span className="ml-1 hidden shrink-0 rounded-[4px] bg-bg-200 px-1.5 py-0.5 text-[11px] tabular-nums text-text-300 sm:inline">
            {t.sizeFps.replace("{w}", String(comp.width)).replace("{h}", String(comp.height)).replace("{fps}", String(comp.fps))}
          </span>
        )}
        {saveError && (
          <span data-tooltip={saveError} className="ml-1 flex shrink-0 items-center text-amber-500">
            <AlertTriangle className="h-3.5 w-3.5" aria-label={saveError} />
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {agent && (
            <span role="status" className="mr-1 flex shrink-0 items-center gap-1 rounded-[6px] bg-accent/10 py-0.5 pl-1.5 pr-0.5 text-[11.5px] text-text-200">
              <Loader2 className="h-3 w-3 animate-spin text-accent" />
              <span>{t.agentEditing}</span>
              <button type="button" onClick={() => stopVideoAgent(agent.chat)} aria-label={t.agentStop} data-tooltip={t.agentStop} className="flex h-5 w-5 items-center justify-center rounded-[4px] text-text-300 hover:bg-bg-200 hover:text-text-100">
                <Square className="h-2.5 w-2.5 fill-current" />
              </button>
            </span>
          )}
          <IconBtn label={t.undo} kbd="Ctrl+Z" onClick={timelineActions.undo} disabled={!canUndo}>
            <Undo2 className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn label={t.redo} kbd="Ctrl+Shift+Z" onClick={timelineActions.redo} disabled={!canRedo}>
            <Redo2 className="h-3.5 w-3.5" />
          </IconBtn>
          <span className="mx-1 h-4 w-px bg-bg-300" />
          <IconBtn label={t.toggleMedia} active={showBin} onClick={() => toggle("binOpen")} disabled={width < NARROW_BIN}>
            <PanelLeft className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn label={t.toggleInspector} active={showInspector} onClick={() => toggle("inspectorOpen")} disabled={width < NARROW_INSPECTOR}>
            <PanelRight className="h-3.5 w-3.5" />
          </IconBtn>
          <div className="relative">
            <button
              ref={queueBtnRef}
              type="button"
              onClick={() => setQueueOpen((o) => !o)}
              aria-label={t.renders}
              aria-expanded={queueOpen}
              data-tooltip={queueOpen ? undefined : t.renders}
              className={cn(
                "relative flex h-7 w-7 items-center justify-center rounded-[6px] transition-colors",
                queueOpen ? "bg-bg-200 text-text-100" : "text-text-300 hover:bg-bg-200 hover:text-text-100",
              )}
            >
              {activeRenders > 0 ? <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" /> : <Download className="h-3.5 w-3.5" />}
              {activeRenders > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9.5px] font-semibold text-bg-0">
                  {activeRenders}
                </span>
              )}
            </button>
            {queueOpen && <RenderQueue workspace={workspace} slug={slug} onClose={() => setQueueOpen(false)} anchorRef={queueBtnRef} />}
          </div>
          <Button variant="primary" className="ml-1 h-7" onClick={() => setRenderOpen(true)} disabled={!comp}>
            {t.render}
          </Button>
          <span className="mx-1 h-4 w-px bg-bg-300" />
          {viewButtons}
        </div>
      </div>

      {status === "error" || (status !== "ready" && !timeline) ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          {status === "error" ? (
            <>
              <AlertTriangle className="h-5 w-5 text-red-500" />
              <p className="text-[13px] font-medium text-text-100">{t.timelineInvalid}</p>
              <pre className="max-h-48 max-w-lg overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-bg-200/60 px-2.5 py-2 text-left font-mono text-[11.5px] leading-snug text-text-200 custom-scrollbar">{loadError}</pre>
              {repairError && <p className="max-w-md whitespace-pre-wrap text-[12px] text-red-600 dark:text-red-400">{repairError}</p>}
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => void repair("open")} disabled={repairing}>
                  {repairing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
                  {t.repair}
                </Button>
                <Button variant="secondary" onClick={() => void openTimeline(workspace, slug)}>{t.retry}</Button>
              </div>
              <p className="max-w-md text-[11.5px] text-text-400">{t.repairHint}</p>
            </>
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-text-400" />
          )}
        </div>
      ) : (
        <>
          {menuError && (
            <div className="flex shrink-0 items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-3 py-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[11.5px] leading-snug text-text-200">{menuError}</p>
              <button type="button" onClick={() => setMenuError(null)} aria-label={t.dismiss} className="rounded-[6px] p-0.5 text-text-400 hover:bg-bg-200 hover:text-text-100">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {externalError && (
            <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <p className="text-[11.5px] font-medium text-text-100">{t.timelineInvalidExternal}</p>
                <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-text-300">{externalError}</p>
                {repairError && <p className="whitespace-pre-wrap text-[11.5px] text-red-600 dark:text-red-400">{repairError}</p>}
              </div>
              <Button variant="secondary" className="h-6 px-2 text-[11.5px]" onClick={() => void repair("external")} disabled={repairing}>
                {repairing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                {t.repair}
              </Button>
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            {showBin && (
              <>
                <aside className="min-w-0 shrink-0 overflow-hidden" style={{ width: sizes.bin }}>
                  <MediaBin workspace={workspace} slug={slug} />
                </aside>
                {splitter("bin")}
              </>
            )}
            <main className="min-w-0 flex-1 overflow-hidden">
              <PlayerPane iframeRef={player.iframeRef} state={player.state} actions={actions} poster={poster} />
            </main>
            {showInspector && (
              <>
                {splitter("inspector")}
                <aside className="min-w-0 shrink-0 overflow-hidden" style={{ width: sizes.inspector }}>
                  <div className="flex h-9 items-center px-3 text-[12px] font-medium text-text-200">{t.inspector}</div>
                  <div className="h-[calc(100%-2.25rem)]">
                    <Inspector workspace={workspace} slug={slug} />
                  </div>
                </aside>
              </>
            )}
          </div>
          {splitter("timeline")}
          <div className="min-h-0 shrink-0 overflow-hidden" style={{ height: sizes.timeline }}>
            <Timeline />
          </div>
        </>
      )}

      {dragging && (
        // Over the player's iframe the mouse would be lost mid-drag.
        <div data-drag-shield className={cn("fixed inset-0 z-[60]", dragging === "timeline" ? "cursor-row-resize" : "cursor-col-resize")} />
      )}

      {comp && (
        <RenderDialog
          open={renderOpen}
          onClose={() => setRenderOpen(false)}
          workspace={workspace}
          slug={slug}
          comp={comp}
          playhead={playhead}
          inPoint={inPoint}
          outPoint={outPoint}
          onStarted={() => setQueueOpen(true)}
        />
      )}
    </div>
  );
}

