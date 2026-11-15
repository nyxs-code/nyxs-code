import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import { TextShimmer } from "@/components/ui/text-shimmer";
import type { ToolDetail } from "@/lib/agentTools";
import type { ToolEnd } from "./parse";
import { ToolChip } from "./ToolChips";
import { EditGroupChip, LineCounts } from "./EditGroup";
import { FILE_EDIT_TOOLS } from "./toolFormat";
import { traceSummary } from "./traceSummary";
import { focusBackgroundTask } from "@/components/views/bgFocus";
import { elapsedLabel, reasoningSeconds, runSeconds, type ReasoningTimes, type WorkItem } from "./liveFormat";
import { useTranscriptView } from "@/lib/transcriptView";

/** Open or closed by the transcript view, until the user opens or closes it by hand; switching
 *  the view (Ctrl+O) applies to every block again. */
function useViewOpen(byView: boolean): [boolean, () => void] {
  const view = useTranscriptView();
  const [own, setOwn] = useState<boolean | null>(null);
  const [seen, setSeen] = useState(view);
  if (seen !== view) {
    setSeen(view);
    setOwn(null);
  }
  const open = own ?? byView;
  return [open, () => setOwn(!open)];
}

export function ReasoningSummary({
  text,
  seconds,
  active = false,
}: {
  text: string;
  seconds: number | null;
  active?: boolean;
}) {
  const tMsg = useTranslations().message;
  const view = useTranscriptView();
  const [open, toggle] = useViewOpen(view !== "normal");
  if (!text.trim()) return null;
  const label = active
    ? tMsg.reasoningActive
    : seconds !== null
      ? tMsg.thoughtFor.replace("{s}", String(seconds))
      : tMsg.reasoning;
  return (
    <div className="max-w-full py-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[12px] font-medium text-text-400 hover:text-text-200 transition-colors"
      >
        <ChevronRight className={cn("w-3.5 h-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        {active ? <TextShimmer className="text-[12px] font-medium">{label}</TextShimmer> : label}
      </button>
      {open && (
        <div className="mt-1 ml-1.5 pl-2.5 border-l border-bg-300">
          <ReasoningWindow text={text} label={tMsg.reasoning} live={active} />
        </div>
      )}
    </div>
  );
}

/** How close to the end (px) counts as "at the bottom" in the short reasoning window. */
const LIVE_NEAR_BOTTOM_PX = 8;

/** The reasoning in an eight-line window, so a long chain of thought never pushes the reply down
 *  the screen. While the model thinks (`live`) it follows the newest line the way the chat does:
 *  scrolling up stops it, back at the bottom it follows again, and its own scrolling doesn't count
 *  as the user's. Opened after the fact it starts at the top, to be read from the beginning. The
 *  top fades once there is text above. */
function ReasoningWindow({ text, label, live }: { text: string; label: string; live: boolean }) {
  const viewRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const programmatic = useRef(false);

  const wasLive = useRef(live);

  useEffect(() => {
    const view = viewRef.current;
    const content = contentRef.current;
    if (!view || !content) return;
    const stick = () => {
      if (!following.current || view.scrollHeight - view.scrollTop - view.clientHeight < 1) return;
      programmatic.current = true;
      view.scrollTop = view.scrollHeight;
    };
    if (!live) {
      // The last chunk lands in the same render that ends the run: show it if we were following.
      if (wasLive.current) stick();
      wasLive.current = false;
      return;
    }
    wasLive.current = true;
    stick();
    const observer = new ResizeObserver(stick);
    observer.observe(content);
    return () => observer.disconnect();
  }, [live]);

  const onScroll = () => {
    const view = viewRef.current;
    if (!view) return;
    view.toggleAttribute("data-scrolled", view.scrollTop > 1);
    if (programmatic.current) {
      programmatic.current = false;
      lastTop.current = view.scrollTop;
      return;
    }
    const scrolledUp = view.scrollTop < lastTop.current - 1;
    lastTop.current = view.scrollTop;
    if (scrolledUp) following.current = false;
    else if (view.scrollHeight - view.scrollTop - view.clientHeight < LIVE_NEAR_BOTTOM_PX) following.current = true;
  };

  return (
    <div
      ref={viewRef}
      onScroll={onScroll}
      tabIndex={0}
      aria-label={label}
      className="reasoning-live max-h-[160px] overflow-y-auto overscroll-contain rounded-[4px] focus-visible:outline-2 focus-visible:outline-accent"
    >
      <div ref={contentRef} className="text-[12.5px] text-text-400 whitespace-pre-wrap break-words leading-[20px] animate-fade-in">
        {text}
      </div>
    </div>
  );
}

export type TraceNotice = { id?: string; title: string; status: string; code: number | null };

function NoticeRow({ notice, onOpen }: { notice: TraceNotice; onOpen?: () => void }) {
  const t = useTranslations().message;
  const label =
    notice.status === "killed"
      ? t.bgStopped
      : notice.code != null && notice.code !== 0
        ? t.bgFailed.replace("{code}", String(notice.code))
        : t.bgCompleted;
  return (
    <div className="flex items-baseline gap-2 py-0.5 min-w-0 text-[12.5px]">
      <span className="shrink-0 text-text-400">{label}</span>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 truncate text-left text-text-200 decoration-text-400 underline-offset-2 hover:underline"
      >
        {notice.title}
      </button>
    </div>
  );
}

export function WorkTrace({
  items,
  endMap,
  streaming,
  toolData,
  awaitingPermission,
  reasoningData,
  reasoningTimes,
  notices = [],
  onOpenView,
}: {
  items: WorkItem[];
  endMap: Map<string, ToolEnd>;
  streaming: boolean;
  toolData: Record<string, ToolDetail>;
  awaitingPermission: boolean;
  reasoningData: Record<string, string>;
  reasoningTimes: ReasoningTimes;
  notices?: TraceNotice[];
  onOpenView?: (view: string) => void;
}) {
  const tMsg = useTranslations().message;
  const view = useTranscriptView();
  const [open, toggle] = useViewOpen(view === "verbose");
  const visible = items.filter((it) => it.kind === "tool" || (reasoningData[it.id] ?? "").trim());
  if (visible.length === 0 && notices.length === 0) return null;
  // The thinking view shows the reasoning above the folded steps, so it reads without opening them.
  const thoughts = view === "thinking" ? visible.filter((it) => it.kind !== "tool") : [];
  const folded = thoughts.length ? visible.filter((it) => it.kind === "tool") : visible;

  // Consecutive edits to the same file read as one change: merge them into a single row.
  type ToolItem = Extract<WorkItem, { kind: "tool" }>;
  const rows: (WorkItem | { kind: "edits"; id: string; items: ToolItem[] })[] = [];
  for (const it of folded) {
    const prev = rows[rows.length - 1];
    const prevPath =
      prev?.kind === "edits" ? prev.items[0].detail : prev?.kind === "tool" && FILE_EDIT_TOOLS.has(prev.name) ? prev.detail : null;
    if (it.kind === "tool" && FILE_EDIT_TOOLS.has(it.name) && it.detail && prevPath === it.detail) {
      if (prev.kind === "edits") prev.items.push(it);
      else rows[rows.length - 1] = { kind: "edits", id: prev.id, items: [prev as ToolItem, it] };
      continue;
    }
    rows.push(it);
  }

  const running = streaming && visible.some((it) => (it.kind === "tool" ? !endMap.has(it.id) : it.active));
  const seconds = runSeconds(visible, toolData, reasoningTimes);
  const count = String(visible.length + notices.length);
  const timeLabel =
    seconds !== null ? tMsg.workedFor.replace("{t}", elapsedLabel(seconds * 1000)) : tMsg.workedSteps.replace("{n}", count);
  const tools = visible.filter((it): it is Extract<WorkItem, { kind: "tool" }> => it.kind === "tool");
  const summary = running ? null : traceSummary(tools, toolData, endMap, tMsg, notices.length);
  const label = running ? tMsg.stepsCount.replace("{n}", count) : timeLabel;

  const thoughtRows = thoughts.map((it) => (
    <ReasoningSummary
      key={it.id}
      text={reasoningData[it.id] ?? ""}
      seconds={reasoningSeconds(reasoningTimes[it.id])}
      active={it.active}
    />
  ));
  if (folded.length === 0 && notices.length === 0) return <div className="my-1.5 flex flex-col gap-0.5">{thoughtRows}</div>;

  return (
    <div className="my-1.5 flex flex-col gap-0.5">
      {thoughtRows}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        data-tooltip={summary?.phrases.length ? timeLabel : undefined}
        className="self-start inline-flex items-center gap-1.5 py-0.5 rounded-md -mx-1 px-1 text-text-400 hover:text-text-200 transition-colors min-w-0 max-w-full"
      >
        {summary?.phrases.length ? (
          <span className="text-[12.5px] font-medium truncate min-w-0">
            {summary.phrases.map((parts, i) => (
              <span key={i}>
                {i > 0 && ", "}
                {parts.map((p, j) => (
                  <span key={j}>{p.text}</span>
                ))}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-[12.5px] font-medium">{label}</span>
        )}
        {summary && <LineCounts added={summary.added} removed={summary.removed} />}
        <ChevronRight className={cn("w-3 h-3 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="ml-[7px] flex flex-col animate-fade-in">
          {notices.map((n, i) => (
            <div key={`notice-${i}`} className="work-tree-row min-w-0">
              <NoticeRow
                notice={n}
                onOpen={() => {
                  if (n.id) focusBackgroundTask(n.id, n.title);
                  onOpenView?.("background");
                }}
              />
            </div>
          ))}
          {rows.map((it) => (
            <div key={it.id} className="work-tree-row min-w-0">
              {it.kind === "edits" ? (
                <EditGroupChip items={it.items} endMap={endMap} streaming={streaming} toolData={toolData} />
              ) : it.kind === "tool" ? (
                <ToolChip
                  name={it.name}
                  detail={it.detail}
                  end={endMap.get(it.id)}
                  streaming={streaming}
                  info={toolData[it.id]}
                  awaitingPermission={awaitingPermission}
                />
              ) : (
                <ReasoningSummary
                  text={reasoningData[it.id] ?? ""}
                  seconds={reasoningSeconds(reasoningTimes[it.id])}
                  active={it.active}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
