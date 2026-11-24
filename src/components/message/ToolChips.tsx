import { useState, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Wrench, TriangleAlert, ChevronRight, CircleStop, Clock, Copy, Check, ListTodo } from "lucide-react";
import { cn } from "@/lib/utils";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { langFromPath } from "@/lib/highlight";
import { useTranslations } from "@/lib/i18n";
import type { ToolDetail } from "@/lib/agentTools";
import type { ToolEnd } from "./parse";
import { DiffView } from "@/components/DiffView";
import { EditDiffCard, LineCounts } from "./EditGroup";
import { MemoryStopNote } from "./MemoryStopNote";
import { BackgroundMoveNote } from "./BackgroundMoveNote";
import { useMovedState } from "./useMovedState";
import {
  TOOL_ICONS,
  PATH_TOOLS,
  FILE_EDIT_TOOLS,
  TOOL_VERBS,
  MIN_RUNNING_MS,
  basename,
  fmtBytes,
  fmtElapsed,
  compactCommand,
  toolTone,
} from "./toolFormat";

export function ToolChip({
  name,
  detail,
  end,
  streaming,
  info,
  awaitingPermission = false,
}: {
  name: string;
  detail: string;
  end: ToolEnd | undefined;
  streaming: boolean;
  info: ToolDetail | undefined;
  awaitingPermission?: boolean;
}) {
  const Icon = TOOL_ICONS[name] ?? Wrench;
  const toolVerbs = useTranslations().toolVerbs;
  const tUi = useTranslations().chatUi;
  const tMsg = useTranslations().message;
  const [present, past] = toolVerbs[name] ?? TOOL_VERBS[name] ?? [name, name];

  const [startedLive] = useState(streaming);
  const [startedAt] = useState(() => Date.now());
  const [done, setDone] = useState(!streaming);
  const [open, setOpen] = useState(false);
  if (startedLive && !streaming && !done) setDone(true);

  useEffect(() => {
    if (!startedLive || !streaming) return;
    if (end) {
      const remaining = Math.max(0, MIN_RUNNING_MS - (Date.now() - startedAt));
      const t = setTimeout(() => setDone(true), remaining);
      return () => clearTimeout(t);
    }
  }, [end, streaming, startedLive, startedAt]);

  const pending = awaitingPermission && !done && !end;
  const running = !done && !pending;
  const failed = done && end?.status === "err";
  const memoryStop = done ? info?.memoryStop : undefined;
  // Cut off by a stop (the user's, or Nyxs's for its memory): neither done nor failed, so it
  // gets a neutral look of its own.
  const stopped = done && (end?.status === "stopped" || !!memoryStop);
  // Moved to the background: it goes on there, so it reads neither as done nor as stopped.
  const moved = done && !memoryStop ? info?.background : undefined;
  const movedState = useMovedState(moved?.shellId, moved?.limitMs);

  const streamingNow = running && !!info?.streaming;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!streamingNow) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [streamingNow]);

  const diff = info?.diff;
  const diagnostics = !pending ? info?.diagnostics : undefined;
  const diagTool = info?.diagnosticsTool;
  const output = !pending && done ? info?.output : undefined;
  const errorText = failed && end?.status === "err" ? end.message : undefined;
  const expandable = !pending && ((!!diff && diff.length > 0) || !!diagnostics || !!output || !!errorText);
  const hasCounts = !pending && !failed && !stopped && (info?.added !== undefined || info?.removed !== undefined);

  const shown = PATH_TOOLS.has(name) ? basename(detail) : name === "Bash" ? compactCommand(detail) : detail;

  // A failed call keeps its tool's own icon: many commands end with a non-zero code without
  // anything going wrong (grep with no match, git diff with changes), and a warning sign there
  // read as "the agent broke something". The row's text still says how it ended.
  const Lead = pending ? Clock : stopped ? CircleStop : moved ? ListTodo : Icon;
  const leadTone = pending ? "text-yellow-500/80" : stopped || moved ? "text-text-400" : running ? "text-accent" : toolTone(name);

  const row = (
    <>
      <span className="relative w-3.5 h-3.5 shrink-0">
        <Lead
          className={cn(
            "absolute inset-0 w-3.5 h-3.5 transition-opacity",
            leadTone,
            expandable && (open ? "opacity-0" : "group-hover/chip:opacity-0"),
          )}
        />
        {expandable && (
          <ChevronRight
            className={cn(
              "absolute inset-0 w-3.5 h-3.5 text-text-300 transition-all",
              open ? "opacity-100 rotate-90" : "opacity-0 group-hover/chip:opacity-100",
            )}
          />
        )}
      </span>
      {pending ? (
        <span className="text-[12.5px] font-medium text-yellow-600 dark:text-yellow-300/90 shrink-0">{present}…</span>
      ) : running ? (
        <TextShimmer className="text-[12.5px] font-medium whitespace-nowrap shrink-0">{`${present}…`}</TextShimmer>
      ) : (
        <span className="text-[12.5px] font-medium text-text-300 shrink-0">{failed || stopped || moved ? name : past}</span>
      )}
      {stopped && <span className="text-[11.5px] text-text-400 shrink-0">· {tMsg.toolStopped}</span>}
      {movedState && <span className="text-[11.5px] text-text-400 shrink-0">· {movedState}</span>}
      {detail && (
        <code className="text-[11.5px] font-mono text-text-400 truncate min-w-0">
          {shown}
        </code>
      )}
      {streamingNow && (
        <span className="shrink-0 text-[11px] font-mono text-text-500 tabular-nums">
          {fmtBytes(info!.streamBytes ?? 0)} · {info!.streamLines ?? 0} ln · {fmtElapsed(now - (info!.streamStart ?? startedAt))}
        </span>
      )}
      {running && info?.progress && <span className="shrink-0 text-[11px] text-text-500 tabular-nums truncate max-w-[45%]">{info.progress}</span>}
      {hasCounts && <LineCounts added={info!.added} removed={info!.removed} />}
      {diagnostics && (
        <span
          className="flex items-center gap-1 shrink-0 text-[11px] font-medium text-warning"
          data-tooltip={diagTool ? `Diagnósticos de ${diagTool}` : "Diagnósticos"}
        >
          <TriangleAlert className="w-3 h-3" />
          {diagTool ?? "diagnostics"}
        </span>
      )}
      {errorText && <span className="text-[11.5px] text-text-400 truncate min-w-0">· {errorText}</span>}
    </>
  );

  const thumbnail = done && !failed && info?.thumbnail ? <ToolThumbnail path={info.thumbnail} stamp={info.endedAt} /> : null;

  const memoryNote = memoryStop ? (
    <MemoryStopNote usedGb={memoryStop.usedGb} installedGb={memoryStop.installedGb} />
  ) : moved ? (
    <BackgroundMoveNote shellId={moved.shellId} title={detail} />
  ) : null;

  if (!expandable) {
    return (
      <div className="py-0.5 min-w-0">
        <div className="flex items-center gap-2 min-w-0">{row}</div>
        {thumbnail}
        {memoryNote}
      </div>
    );
  }

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
      {thumbnail}
      {memoryNote}
      {open && errorText && (
        <p className="mt-1 ml-[7px] pl-3 border-l border-bg-300 text-[11.5px] text-text-400 break-words">{errorText}</p>
      )}
      {open && diff && diff.length > 0 && (FILE_EDIT_TOOLS.has(name) && detail
        ? <EditDiffCard path={detail} diff={diff} />
        : <DiffView diff={diff} lang={langFromPath(detail)} />)}
      {open && output && <ToolOutput output={output} truncated={!!info?.outputTruncated} label={tUi.output} truncatedNote={tUi.outputTruncated} />}
      {open && diagnostics && (
        <div className="mt-1.5 rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning">
            <TriangleAlert className="w-3 h-3" />
            {diagTool ? `${diagTool} diagnostics` : "Diagnostics"}
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-200">
            {diagnostics}
          </pre>
        </div>
      )}
    </div>
  );
}

/** The frame a VideoStill / VideoRender call produced. Stills reuse their file name per frame,
 *  so `stamp` keeps an old row from showing a newer render of the same frame from cache. */
function ToolThumbnail({ path, stamp }: { path: string; stamp?: number }) {
  const t = useTranslations().videoAgent;
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  let src: string;
  try {
    src = `${convertFileSrc(path)}${stamp ? `?v=${stamp}` : ""}`;
  } catch {
    return null;
  }
  return (
    <img
      src={src}
      alt={t.frameThumbnailAlt}
      loading="lazy"
      onError={() => setBroken(true)}
      className="mt-1.5 ml-[21px] block max-h-40 max-w-[280px] rounded-md border border-bg-300 bg-bg-200 object-contain"
    />
  );
}

/** A command's output, unboxed like the chat's code blocks: indented under its row on a thin
 *  rail, with a copy icon right after its longest line. Long lines wrap; a long output stays in a
 *  scrolling window so it can't take over the chat. */
function ToolOutput({ output, truncated, label, truncatedNote }: { output: string; truncated: boolean; label: string; truncatedNote: string }) {
  const tx = useTranslations().messageExtra;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="mt-1.5 ml-[7px] pl-3 border-l border-bg-300">
      <div className="relative w-fit max-w-full pr-9">
        <pre
          tabIndex={0}
          aria-label={label}
          className="max-h-72 overflow-y-auto custom-scrollbar font-mono text-[12px] leading-[20px] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[4px] focus-visible:outline-2 focus-visible:outline-accent"
          style={{ color: "var(--code-plain)" }}
        >
          {output}
        </pre>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? tx.copied : tx.copy}
          data-tooltip={copied ? tx.copied : tx.copy}
          className="absolute top-0 right-1 p-1 rounded-md text-text-400 hover:text-text-100 hover:bg-bg-200 transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
      {truncated && <p className="mt-1 text-[11px] italic text-text-400">{truncatedNote}</p>}
    </div>
  );
}
