import { useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import { openSession, useSessionDirectory } from "@/lib/sessionDirectory";
import { findThread, findThreadByTitle, useProjectDirectory, type ThreadEntry } from "@/lib/projects/projectDirectory";
import { GROUP_DOT } from "@/lib/projects/threadStatus";
import { projectHost } from "@/lib/projects/projectHost";
import type { ThreadStatus } from "@/lib/projects/types";
import type { ToolDetail } from "@/lib/toolDetail";
import { repliesLabel, useThreadLine } from "@/lib/projects/threadLabels";
import { MarkdownText } from "./markdown";

/** A thread the coordinator opened (StartThread), as in the approved design: its dot, title and
 *  state, and "N respuestas" under it. A click opens the thread. */
export function ThreadCard({ coordinatorId, title }: { coordinatorId?: string; title: string }) {
  const t = useTranslations().projects;
  useProjectDirectory();
  const thread = findThreadByTitle(coordinatorId, title);
  const line = useThreadLine();
  return (
    <div className="my-2 max-w-md">
      <button
        type="button"
        disabled={!thread}
        onClick={() => thread && openSession(thread.id)}
        aria-label={`${t.openThread}: ${thread?.title || title}`}
        className="flex w-full items-center gap-2.5 rounded-[8px] border border-bg-300 bg-bg-100 px-3 py-2.5 text-left transition-colors enabled:hover:bg-bg-200 disabled:opacity-60"
      >
        <span className={cn("h-2 w-2 shrink-0 rounded-full", thread ? GROUP_DOT[thread.group] : "bg-text-500")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-text-100">{thread?.title || title}</span>
          {thread && <span className="block truncate text-[12px] text-text-400">{line(thread)}</span>}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-text-400" />
      </button>
      {thread && thread.replies > 0 && (
        <button type="button" onClick={() => openSession(thread.id)} className="mt-1 ml-3 text-[12px] text-text-400 hover:text-text-200">
          {repliesLabel(t, thread.replies)}
        </button>
      )}
    </div>
  );
}

const REPORT_GROUP: Record<ThreadStatus, ThreadEntry["group"]> = {
  working: "working",
  needs_input: "waiting",
  review: "review",
  resolved: "resolved",
  idle: "resolved",
  failed: "failed",
};

/** A thread's report in the project conversation: the thread's card with the report under it,
 *  folded when long. */
export function ThreadReportCard({ from, report }: { from: { id: string; title: string }; report: { status: ThreadStatus; text: string } }) {
  const t = useTranslations().projects;
  useProjectDirectory();
  const thread = findThread(from.id);
  const live = useSessionDirectory().find((e) => e.id === from.id);
  const [open, setOpen] = useState(false);
  const line = useThreadLine();
  const group = REPORT_GROUP[report.status];
  const long = report.text.length > 280 || report.text.split("\n").length > 4;
  return (
    <div className="px-4 py-2">
      <div className="mx-auto max-w-3xl">
        <div className="max-w-md rounded-[8px] border border-bg-300 bg-bg-100">
          <button
            type="button"
            disabled={!live}
            onClick={() => openSession(from.id)}
            aria-label={`${t.openThread}: ${thread?.title || from.title}`}
            className="flex w-full items-center gap-2.5 rounded-t-[8px] px-3 py-2.5 text-left transition-colors enabled:hover:bg-bg-200"
          >
            <span className={cn("h-2 w-2 shrink-0 rounded-full", GROUP_DOT[group])} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-text-100">{thread?.title || from.title}</span>
              <span className="block truncate text-[12px] text-text-400">{line({ group, status: report.status, branch: thread?.branch })}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-text-400" />
          </button>
          <div className="border-t border-bg-300 px-3 py-2 text-[13px] text-text-200">
            <div className={cn("break-words", long && !open && "max-h-24 overflow-hidden")}>
              <MarkdownText text={report.text} />
            </div>
            {long && (
              <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-1 text-[12px] text-text-400 hover:text-text-200">
                {open ? t.showLess : t.showMore}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The coordinator's AskDecision: the question and its 2 to 4 options. A click answers it in the
 *  conversation; then the card keeps the choice. */
export function DecisionCard({ chatId, messageId, toolId, decision, disabled }: { chatId?: string; messageId: string; toolId: string; decision: NonNullable<ToolDetail["decision"]>; disabled?: boolean }) {
  const t = useTranslations().projects;
  const working = useSessionDirectory().find((e) => e.id === chatId)?.working ?? false;
  const chosen = decision.chosen;
  const blocked = !!chosen || disabled || working || !chatId;
  return (
    <div className="my-2 max-w-md rounded-[8px] border border-bg-300 bg-bg-100 p-3">
      <p className="text-[13px] font-medium text-text-100">{decision.question}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        {decision.options.map((o) => {
          const picked = chosen === o.label;
          return (
            <button
              key={o.label}
              type="button"
              disabled={blocked}
              onClick={() => chatId && projectHost()?.answerDecision(chatId, messageId, toolId, o.label, decision.question)}
              className={cn(
                "flex w-full items-start gap-2 rounded-[6px] border px-2.5 py-1.5 text-left transition-colors",
                picked ? "border-accent bg-accent/10" : "border-bg-300 enabled:hover:bg-bg-200",
                chosen && !picked && "opacity-50",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[13px] text-text-100">
                  {o.label}
                  {decision.recommended === o.label && <span className="rounded-[4px] bg-bg-200 px-1 text-[11px] text-text-300">{t.recommended}</span>}
                </span>
                {o.consequence && <span className="block text-[12px] text-text-400">{o.consequence}</span>}
              </span>
              {picked && <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
