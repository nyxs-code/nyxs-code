import { useLayoutEffect, useRef } from "react";
import { CheckCircle2, CircleStop, Loader2, XCircle } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import type { ActivityEntry } from "@/lib/agentActivity";

type ToolEntry = Extract<ActivityEntry, { kind: "tool" }>;

function ToolStatus({ status }: { status: ToolEntry["status"] }) {
  const t = useTranslations().workflowProgress;
  const icon = { role: "img", "aria-hidden": false } as const;
  if (status === "ok") return <CheckCircle2 {...icon} aria-label={t.toolDone} className="w-3 h-3 shrink-0 text-green-400" />;
  if (status === "error") return <XCircle {...icon} aria-label={t.toolFailed} className="w-3 h-3 shrink-0 text-red-400" />;
  // Cut off by a stop: it didn't fail, so it isn't red.
  if (status === "stopped") return <CircleStop {...icon} aria-label={t.toolStopped} className="w-3 h-3 shrink-0 text-text-400" />;
  return <Loader2 {...icon} aria-label={t.toolRunning} className="w-3 h-3 shrink-0 text-accent animate-spin" />;
}

/** A sub-agent's text and tool calls, following the newest while it runs unless scrolled up. */
export function AgentActivityLog({ activity, running }: { activity: ActivityEntry[]; running: boolean }) {
  const t = useTranslations().workflowProgress;
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [activity]);

  if (activity.length === 0) {
    return (
      <div className="rounded-[8px] bg-bg-200 px-3 py-2 text-[12px] text-text-400">
        {running ? <Loader2 className="w-3 h-3 text-accent animate-spin" /> : t.noActivity}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="max-h-72 overflow-auto custom-scrollbar rounded-[8px] bg-bg-200 px-3 py-2 flex flex-col gap-1.5"
    >
      {activity.map((a, i) =>
        a.kind === "text" ? (
          a.text.trim() && <p key={i} className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-text-200">
            {a.text.trim()}
          </p>
        ) : (
          <div key={`${a.callId}-${i}`} className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px]">
            <ToolStatus status={a.status} />
            <span className="shrink-0 text-text-100">{a.name}</span>
            {a.detail && <span className="min-w-0 truncate text-text-400">{a.detail}</span>}
          </div>
        ),
      )}
    </div>
  );
}
