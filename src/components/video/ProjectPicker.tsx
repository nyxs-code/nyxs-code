import { useRef, useState } from "react";
import { AlertTriangle, Clapperboard, FileVideo, FolderCode, Loader2, Plus, RefreshCw, MoreHorizontal, X } from "lucide-react";
import { getLanguage, useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { VideoProjectInfo } from "@/lib/video/videoApi";
import { Button } from "@/components/ui/button";
import { hasOsFiles, thumbnailUrl } from "./media";
import { ProjectActionsMenu } from "./ProjectActionsMenu";
import type { ProjectActions } from "./useProjectActions";
import { formatDuration } from "./timecode";

/** A project being created or opened from media: npm install takes a while. */
export interface PendingProject {
  name: string;
  line: string | null;
  error: string | null;
}

interface Props {
  projects: VideoProjectInfo[] | null;
  loading: boolean;
  error: string | null;
  pending: PendingProject | null;
  onOpen: (p: VideoProjectInfo) => void;
  onInstall: (p: VideoProjectInfo) => void;
  installing: string | null;
  onNew: () => void;
  onOpenVideoFile: () => void;
  onOpenRemotion: () => void;
  onRefresh: () => void;
  onDropFiles: (files: File[]) => void;
  onDismissPending: () => void;
  actions: ProjectActions;
  /** Thumbnails that arrived after the list did, by slug. */
  thumbs: ThumbUpdates;
}

/** What `onThumbnailReady` delivered. The file keeps its path when it is re-rendered, so
 *  `version` is what makes the WebView load the new image. */
export type ThumbUpdates = Record<string, { path: string; version: number }>;

export function ProjectPicker({ projects, loading, error, pending, onOpen, onInstall, installing, onNew, onOpenVideoFile, onOpenRemotion, onRefresh, onDropFiles, onDismissPending, actions, thumbs }: Props) {
  const t = useTranslations().videoPanel;
  const [dropping, setDropping] = useState(false);
  const list = projects ?? [];

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={(e) => {
        if (!hasOsFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        if (!hasOsFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        onDropFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="flex shrink-0 items-center gap-2 px-4 pb-3 pt-1">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-medium text-text-100">{t.projects}</h3>
          <p className="truncate text-[11.5px] text-text-400">{t.projectsHint}</p>
        </div>
        <Button variant="ghost" icon onClick={onRefresh} aria-label={t.refresh} data-tooltip={t.refresh}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
        <Button variant="primary" onClick={onNew}>
          <Plus className="h-3.5 w-3.5" />
          {t.newVideo}
        </Button>
      </div>

      <div className="flex shrink-0 gap-2 px-4 pb-3">
        <Button variant="secondary" className="flex-1" onClick={onOpenVideoFile}>
          <FileVideo className="h-3.5 w-3.5" />
          {t.openVideoFile}
        </Button>
        <Button variant="secondary" className="flex-1" onClick={onOpenRemotion}>
          <FolderCode className="h-3.5 w-3.5" />
          {t.openRemotion}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 custom-scrollbar">
        {pending && (
          <div className={cn("mb-2 rounded-[8px] border px-3 py-2.5", pending.error ? "border-red-500/40" : "border-bg-300")}>
            <div className="flex items-center gap-2">
              {pending.error ? <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" /> : <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />}
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-100">{t.creating.replace("{name}", pending.name)}</span>
              {pending.error && (
                <Button variant="ghost" className="h-6 px-1.5 text-[11.5px]" onClick={onDismissPending}>{t.dismiss}</Button>
              )}
            </div>
            {pending.error && <p className="mt-1 whitespace-pre-wrap break-words text-[11.5px] leading-snug text-red-600 dark:text-red-400">{pending.error}</p>}
          </div>
        )}
        {error && <p className="mb-2 rounded-[6px] bg-red-500/10 px-2.5 py-2 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
        {actions.error && (
          <p className="mb-2 flex items-start gap-2 rounded-[6px] bg-red-500/10 px-2.5 py-2 text-[12px] text-red-600 dark:text-red-400">
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{actions.error}</span>
            <button type="button" onClick={actions.clearError} aria-label={t.dismiss} className="shrink-0 rounded-[4px] p-0.5 hover:bg-red-500/10">
              <X className="h-3.5 w-3.5" />
            </button>
          </p>
        )}
        {projects !== null && list.length === 0 && !pending ? (
          <div className="flex flex-col items-center gap-2 rounded-[8px] border border-dashed border-bg-300 px-6 py-10 text-center">
            <Clapperboard className="h-6 w-6 text-text-400" />
            <p className="text-[13px] font-medium text-text-200">{t.noProjects}</p>
            <p className="max-w-xs text-[12px] leading-relaxed text-text-400">{t.noProjectsHint}</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
            {list.map((p) => (
              <ProjectCard key={p.slug} project={p} showSlug={list.some((o) => o !== p && o.name === p.name)} onOpen={() => onOpen(p)} onInstall={() => onInstall(p)} installing={installing === p.slug} actions={actions} thumbUpdate={thumbs[p.slug]} />
            ))}
          </div>
        )}
      </div>

      {dropping && (
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-[8px] border-2 border-dashed border-accent/60 bg-accent/5">
          <span className="text-[13px] text-text-200">{t.dropToEdit}</span>
        </div>
      )}
    </div>
  );
}

/** `showSlug`: another project has the same name, so the folder tells them apart. */
function ProjectCard({ project, showSlug, onOpen, onInstall, installing, actions, thumbUpdate }: { project: VideoProjectInfo; showSlug: boolean; onOpen: () => void; onInstall: () => void; installing: boolean; actions: ProjectActions; thumbUpdate?: ThumbUpdates[string] }) {
  const t = useTranslations().videoPanel;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const main = project.compositions[0];
  const n = project.compositions.length;
  const thumb = thumbnailUrl(thumbUpdate?.path ?? project.thumbnail, thumbUpdate?.version);
  const ratio = main ? `${main.width} / ${main.height}` : "16 / 9";
  const renaming = actions.renaming === project.slug;
  const busy = actions.busy === project.slug;
  // Light projects run on the shared engine; adopted Remotion and old-format projects use their
  // own node_modules, which may need installing.
  const notInstalled = project.kind !== "nyxs" && project.installed === false;
  const openMenuAtButton = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenuAt({ x: r.right - 240, y: r.bottom + 4 });
  };
  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
      className={cn("group relative overflow-hidden rounded-[8px] border bg-bg-0 transition-colors", menuAt ? "border-text-400" : "border-bg-300 hover:border-text-400", busy && "opacity-60")}
    >
      <button type="button" onClick={onOpen} disabled={busy || renaming} className="block w-full text-left">
        <div className="flex h-28 items-center justify-center bg-bg-200/60 p-2">
          <div className="relative h-full max-w-full overflow-hidden rounded bg-bg-300/60" style={{ aspectRatio: ratio }}>
            {thumb ? (
              <img src={thumb} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <Clapperboard className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 text-text-400" />
            )}
          </div>
        </div>
        <div className="px-2.5 py-2">
          <div className="flex h-5 items-center gap-1.5 pr-6">
            {!renaming && (
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-100">
                {project.name}
                {showSlug && <span className="ml-1 font-mono text-[11px] font-normal text-text-400">{project.slug}</span>}
              </span>
            )}
            {!renaming && project.kind === "remotion" && <span className="shrink-0 rounded-[4px] bg-bg-200 px-1 text-[10.5px] text-text-300">{t.remotionBadge}</span>}
            {!renaming && project.kind === "legacy" && <span className="shrink-0 rounded-[4px] bg-amber-500/15 px-1 text-[10.5px] text-amber-700 dark:text-amber-300">{t.legacyBadge}</span>}
          </div>
          <div className="mt-0.5 truncate text-[11px] tabular-nums text-text-400">
            {main ? `${main.width}×${main.height} · ${main.fps} fps · ${formatDuration(main.durationInFrames, main.fps)}` : ""}
            {n > 1 ? ` · ${t.compositionsCount.replace("{n}", String(n))}` : ""}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-text-400">{t.updated.replace("{when}", relativeTime(project.updatedAt))}</div>
        </div>
      </button>
      {renaming && (
        <RenameInput
          initial={project.name}
          label={t.renameProject}
          onCommit={(name) => actions.rename(project, name)}
          onCancel={actions.cancelRename}
          className="absolute left-2 right-2 top-[120px]"
        />
      )}
      <button
        type="button"
        aria-label={t.projectMenu}
        aria-haspopup="menu"
        aria-expanded={!!menuAt}
        data-tooltip={menuAt ? undefined : t.projectMenu}
        onClick={(e) => (menuAt ? setMenuAt(null) : openMenuAtButton(e.currentTarget))}
        className={cn(
          "absolute right-1.5 top-[118px] flex h-6 w-6 items-center justify-center rounded-[6px] text-text-300 transition-opacity hover:bg-bg-200 hover:text-text-100 focus-visible:opacity-100",
          menuAt ? "bg-bg-200 opacity-100" : "opacity-0 group-hover:opacity-100",
          renaming && "hidden",
        )}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
      </button>
      {menuAt && <ProjectActionsMenu project={project} actions={actions} at={menuAt} onClose={() => setMenuAt(null)} />}
      {notInstalled && (
        <div className="flex items-center gap-1.5 border-t border-bg-300/70 px-2.5 py-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-text-300">{t.notInstalled}</span>
          <Button variant="secondary" className="h-6 px-2 text-[11.5px]" onClick={onInstall} disabled={installing}>
            {installing && <Loader2 className="h-3 w-3 animate-spin" />}
            {t.installNow}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The name field that replaces a project's name while renaming: Enter saves, Escape cancels. */
export function RenameInput({ initial, label, onCommit, onCancel, className }: { initial: string; label: string; onCommit: (name: string) => void; onCancel: () => void; className?: string }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) onCommit(value);
    else onCancel();
  };
  return (
    <input
      autoFocus
      value={value}
      aria-label={label}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      className={cn("h-6 rounded-[6px] border border-accent/70 bg-bg-0 px-1.5 text-[12.5px] font-medium text-text-100 outline-none", className)}
    />
  );
}

function relativeTime(ms: number): string {
  if (!ms) return "—";
  const lang = getLanguage();
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const diff = (ms - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return new Date(ms).toLocaleDateString(lang);
}
