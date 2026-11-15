import { useEffect, useRef } from "react";
import { CheckCircle2, CircleSlash, ExternalLink, FolderOpen, Loader2, X, XCircle } from "lucide-react";
import { invoke } from "@/lib/ipc";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { openOutput } from "@/lib/video/videoApi";
import { formatEta } from "../timecode";
import { cancelRender, clearFinished, isRenderActive, useRenderJobs, type RenderJob } from "./renderJobs";

/** The renders popover under the top bar's Renders button. */
export function RenderQueue({ workspace, slug, onClose, anchorRef }: { workspace: string; slug: string; onClose: () => void; anchorRef: React.RefObject<HTMLElement | null> }) {
  const t = useTranslations().videoPanel;
  const jobs = useRenderJobs().filter((j) => j.workspace === workspace && j.slug === slug);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!boxRef.current?.contains(target) && !anchorRef.current?.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorRef]);

  const finished = jobs.some((j) => !isRenderActive(j));

  return (
    <div ref={boxRef} role="dialog" aria-label={t.renderQueue} data-webview-hole className="absolute right-0 top-full z-40 mt-1 w-80 rounded-[8px] border border-bg-300 bg-bg-100 shadow-lg">
      <div className="flex h-9 items-center justify-between border-b border-bg-300/70 pl-3 pr-1.5">
        <span className="text-[12.5px] font-medium text-text-100">{t.renderQueue}</span>
        {finished && (
          <button type="button" onClick={clearFinished} className="h-6 rounded-[6px] px-1.5 text-[11.5px] text-text-300 hover:bg-bg-200 hover:text-text-100">
            {t.clearFinished}
          </button>
        )}
      </div>
      <div className="max-h-80 overflow-y-auto p-1 custom-scrollbar">
        {jobs.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-text-400">{t.noRenders}</p>
        ) : (
          jobs.map((j) => <JobRow key={j.id} job={j} />)
        )}
      </div>
    </div>
  );
}

function encoderLabel(encoder: string, t: { encoderGpu: string; encoderCpu: string }): string {
  if (encoder.endsWith("_nvenc")) return t.encoderGpu.replace("{name}", "NVENC");
  if (encoder.endsWith("_videotoolbox")) return t.encoderGpu.replace("{name}", "VideoToolbox");
  return t.encoderCpu;
}

function JobRow({ job }: { job: RenderJob }) {
  const t = useTranslations().videoPanel;
  const active = isRenderActive(job);
  const pct = Math.round(job.progress * 100);
  const btn = "flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] text-text-300 hover:bg-bg-200 hover:text-text-100";
  const StatusIcon = job.stage === "done" ? CheckCircle2 : job.stage === "error" ? XCircle : job.stage === "cancelled" ? CircleSlash : Loader2;

  return (
    <div className="rounded-[6px] px-2 py-2 hover:bg-bg-200/40">
      <div className="flex items-center gap-2">
        <StatusIcon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            active && "animate-spin text-text-400",
            job.stage === "done" && "text-emerald-500",
            job.stage === "error" && "text-red-500",
            job.stage === "cancelled" && "text-text-400",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] text-text-100">{job.outputName}</div>
          <div className="truncate text-[11px] text-text-400">{job.label}{job.encoder && ` · ${encoderLabel(job.encoder, t)}`}</div>
        </div>
        {active && (
          <button type="button" onClick={() => void cancelRender(job.id).catch(() => {})} className={btn}>
            <X className="h-3.5 w-3.5" />
            {t.cancelRender}
          </button>
        )}
      </div>
      {active && (
        <>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-bg-300">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] tabular-nums text-text-400">
            <span>
              {t.stages[job.stage]} · {pct}%
              {job.totalFrames > 0 && ` · ${t.framesOf.replace("{a}", String(job.renderedFrames)).replace("{b}", String(job.totalFrames))}`}
            </span>
            {job.etaSecs !== undefined && <span>{t.eta.replace("{eta}", formatEta(job.etaSecs))}</span>}
          </div>
        </>
      )}
      {job.stage === "error" && job.error && (
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-[11.5px] leading-snug text-red-600 dark:text-red-400">{job.error}</p>
      )}
      {job.stage === "done" && job.outputPath && (
        <div className="mt-1 flex items-center gap-1">
          <button type="button" className={btn} onClick={() => void invoke("agent_open_path", { path: job.outputPath }).catch(() => {})}>
            <ExternalLink className="h-3.5 w-3.5" />
            {t.open}
          </button>
          <button type="button" className={btn} onClick={() => void openOutput(job.outputPath!).catch(() => {})}>
            <FolderOpen className="h-3.5 w-3.5" />
            {t.showInFolder}
          </button>
        </div>
      )}
    </div>
  );
}
