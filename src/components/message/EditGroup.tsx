import { useMemo, useState } from "react";
import { Check, ChevronRight, Copy, Pencil, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { langFromPath } from "@/lib/highlight";
import { currentWorkspace, openPathRef, parsePathRef } from "@/lib/filePaths";
import { useTranslations } from "@/lib/i18n";
import type { DiffLine, ToolDetail } from "@/lib/agentTools";
import { DiffView } from "@/components/DiffView";
import { toolCompleted, type ToolEnd } from "./parse";
import { basename, toolTone } from "./toolFormat";

/** +N / -N as small tinted pills. */
export function LineCounts({ added, removed }: { added?: number; removed?: number }) {
  if (!added && !removed) return null;
  return (
    <span className="inline-flex shrink-0 overflow-hidden rounded text-[11px] font-mono tabular-nums">
      <span className="pl-1.5 pr-1 bg-[color:var(--code-addBg)] text-success">+{added ?? 0}</span>
      <span className="pl-1 pr-1.5 bg-[color:var(--code-delBg)] text-danger">−{removed ?? 0}</span>
    </span>
  );
}

/** An edit's diff under a header with the file's full path (a link that opens it) and a copy button. */
export function EditDiffCard({ path, diff }: { path: string; diff: DiffLine[] }) {
  const t = useTranslations().message;
  const [copied, setCopied] = useState(false);
  // parsePathRef rejects spaces (it guesses at inline code); an absolute tool path is a path anyway.
  const ref = useMemo(
    () => parsePathRef(path, currentWorkspace())
      ?? (/^([A-Za-z]:[\\/]|\/)/.test(path) ? { raw: path, abs: path, rel: path, name: basename(path) } : null),
    [path],
  );
  const copy = () => {
    void navigator.clipboard.writeText(path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };
  return (
    <div className="group/card mt-1 mb-2 overflow-hidden rounded-lg border border-bg-300 bg-bg-0 animate-fade-in">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-bg-300/70">
        {ref ? (
          <span className="min-w-0 flex-1 truncate">
            <button
              type="button"
              onClick={() => openPathRef(ref, "file")}
              className="max-w-full truncate text-left font-mono text-[11.5px] text-text-300 underline decoration-text-500/50 underline-offset-2 hover:text-text-100 hover:decoration-text-300 transition-colors"
            >
              {path}
            </button>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-300">{path}</span>
        )}
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? t.copied : t.copyPath}
          data-tooltip={copied ? t.copied : t.copyPath}
          className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded-md text-text-400 hover:text-text-100 hover:bg-bg-200 opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 transition-[opacity,color,background-color]"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
      <DiffView diff={diff} lang={langFromPath(path)} embedded className="max-h-80" />
    </div>
  );
}

/** Several edits in a row to the same file, shown as one row with the summed line counts
 *  and, when opened, every change's diff one after the other. */
export function EditGroupChip({
  items,
  endMap,
  streaming,
  toolData,
}: {
  items: { id: string; name: string; detail: string }[];
  endMap: Map<string, ToolEnd>;
  streaming: boolean;
  toolData: Record<string, ToolDetail>;
}) {
  const toolVerbs = useTranslations().toolVerbs;
  const t = useTranslations().message;
  const [open, setOpen] = useState(false);
  const last = items[items.length - 1];
  const path = last.detail;
  const verbs = toolVerbs[items.some((i) => i.name !== "Write") ? "Edit" : "Write"] ?? ["Editing", "Edited"];
  const running = streaming && items.some((i) => !endMap.has(i.id));
  const failed = items.some((i) => endMap.get(i.id)?.status === "err");

  let added = 0;
  let removed = 0;
  const diff: DiffLine[] = [];
  for (const it of items) {
    const info = toolData[it.id];
    if (!info || !toolCompleted(endMap.get(it.id))) continue;
    added += info.added ?? 0;
    removed += info.removed ?? 0;
    if (info.diff?.length) {
      // Each change keeps its own hunk header, so the stitched diff reads as separate spots.
      if (diff.length && info.diff[0]?.type !== "hunk") diff.push({ type: "hunk", text: "⋯" });
      diff.push(...info.diff);
    }
  }
  const expandable = !running && diff.length > 0;
  const Lead = failed ? TriangleAlert : Pencil;
  const leadTone = failed ? "text-amber-500/70" : running ? "text-accent" : toolTone(last.name);

  const row = (
    <>
      <span className="relative w-3.5 h-3.5 shrink-0">
        <Lead className={cn("absolute inset-0 w-3.5 h-3.5 transition-opacity", leadTone, expandable && (open ? "opacity-0" : "group-hover/chip:opacity-0"))} />
        {expandable && (
          <ChevronRight
            className={cn(
              "absolute inset-0 w-3.5 h-3.5 text-text-300 transition-all",
              open ? "opacity-100 rotate-90" : "opacity-0 group-hover/chip:opacity-100",
            )}
          />
        )}
      </span>
      {running ? (
        <TextShimmer className="text-[12.5px] font-medium whitespace-nowrap shrink-0">{`${verbs[0]}…`}</TextShimmer>
      ) : (
        <span className="text-[12.5px] font-medium text-text-300 shrink-0">{verbs[1]}</span>
      )}
      <code className="text-[11.5px] font-mono text-text-400 truncate min-w-0">
        {basename(path)}
      </code>
      {!running && <LineCounts added={added} removed={removed} />}
      <span className="shrink-0 text-[11px] text-text-500">{t.editsCount.replace("{n}", String(items.length))}</span>
    </>
  );

  if (!expandable) return <div className="flex items-center gap-2 py-0.5 min-w-0">{row}</div>;
  return (
    <div className="py-0.5 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group/chip w-full flex items-center gap-2 text-left rounded-md -mx-1 px-1 py-px hover:bg-bg-200/70 transition-colors min-w-0"
      >
        {row}
      </button>
      {open && <EditDiffCard path={path} diff={diff} />}
    </div>
  );
}
