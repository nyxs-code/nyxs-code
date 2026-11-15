import { useState } from "react";
import { motion } from "motion/react";
import { Loader2, CheckCircle2, XCircle, ListTree, ChevronDown, ChevronRight, CircleSlash, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import { useWorkflowProgress, groupByPhase, type WorkflowStore, type AgentNode } from "@/lib/orchestratorStore";
import { AgentActivityLog } from "@/components/AgentActivityLog";

function StatusIcon({ status }: { status: AgentNode["status"] }) {
  if (status === "ok") return <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-green-400" />;
  if (status === "error") return <XCircle className="w-3.5 h-3.5 shrink-0 text-red-400" />;
  if (status === "stopped") return <CircleSlash className="w-3.5 h-3.5 shrink-0 text-text-400" />;
  return <Loader2 className="w-3.5 h-3.5 shrink-0 text-accent animate-spin" />;
}

function AgentRow({ a, onStop }: { a: AgentNode; onStop: () => void }) {
  const t = useTranslations().workflowProgress;
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  const toggle = () => setOpen((o) => !o);
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}
        className="group flex items-center gap-2 rounded-[6px] text-[13px] py-0.5 -mx-1 px-1 cursor-pointer hover:bg-bg-200 transition-colors"
      >
        <StatusIcon status={a.status} />
        <span className={cn("min-w-0 truncate", a.status === "error" ? "text-red-300" : "text-text-200")}>{a.label}</span>
        {a.retries > 0 && (
          <span className="text-[10px] text-yellow-400/80 tabular-nums shrink-0" data-tooltip="schema retries">
            ↻{a.retries}
          </span>
        )}
        <span className="ml-auto" />
        {a.status === "running" && a.stoppable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStop();
            }}
            data-tooltip={t.stop}
            aria-label={t.stop}
            className="shrink-0 p-0.5 rounded-[6px] text-text-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-400 transition-opacity"
          >
            <Square className="w-3 h-3" fill="currentColor" />
          </button>
        )}
        {a.status !== "running" && (a.tokensIn != null || a.tokensOut != null) && (
          <span
            className="text-[10px] text-text-400 tabular-nums shrink-0"
            data-tooltip={`${a.tokensIn ?? 0} input · ${a.tokensOut ?? 0} output tokens`}
          >
            ↑{formatTokens(a.tokensIn ?? 0)} ↓{formatTokens(a.tokensOut ?? 0)}
          </span>
        )}
        {a.status !== "running" && a.ms != null && (
          <span className="text-[10px] text-text-400 tabular-nums shrink-0">{formatMs(a.ms)}</span>
        )}
        <Chevron className="w-3.5 h-3.5 shrink-0 text-text-400" />
      </div>
      {open && (
        <div className="pt-1 pb-2">
          <AgentActivityLog activity={a.activity} running={a.status === "running"} />
        </div>
      )}
    </motion.li>
  );
}

/** "3/5 · 2 active · 1 failed" for the workflow in `store`. */
export function WorkflowCounts({ store }: { store: WorkflowStore }) {
  const t = useTranslations().workflowProgress;
  const state = useWorkflowProgress(store);
  return (
    <span className="tabular-nums">
      {state.completed + state.failed + state.stopped}/{state.agents.length}
      {state.running > 0 && <span className="text-accent"> · {state.running} {t.active}</span>}
      {state.failed > 0 && <span className="text-red-400"> · {state.failed} {t.failed}</span>}
      {state.stopped > 0 && <span> · {state.stopped} {t.stopped}</span>}
    </span>
  );
}
function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** `embedded` renders just the progress, for a section inside another view: no empty state,
 *  no title row and no scrolling of its own. */
export function WorkflowProgress({ store, embedded = false }: { store: WorkflowStore; embedded?: boolean }) {
  const t = useTranslations().workflowProgress;
  const state = useWorkflowProgress(store);
  const groups = groupByPhase(state);
  const total = state.agents.length;

  if (total === 0 && state.logs.length === 0) {
    if (embedded) return null;
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-400 gap-2">
        <ListTree className="w-6 h-6 opacity-50" />
        <span className="text-sm">{t.noWorkflow}</span>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", embedded ? "px-2.5 py-1.5" : "p-3 overflow-y-auto")}>
      {!embedded && (
        <div className="flex items-center justify-between text-[12px] text-text-300">
          <span className="font-semibold uppercase tracking-wider text-text-200">{t.workflow}</span>
          <WorkflowCounts store={store} />
        </div>
      )}

      {groups.map((g, gi) => (
        <div key={g.phase || `__${gi}`}>
          {g.phase && (
            <div className="text-[11px] font-medium text-text-400 uppercase tracking-wide mb-1">{g.phase}</div>
          )}
          <ul className={cn("flex flex-col", g.phase && "border-l border-bg-300 pl-3 ml-1")}>
            {g.agents.map((a) => (
              <AgentRow key={a.id} a={a} onStop={() => store.stopAgent(a.id)} />
            ))}
          </ul>
        </div>
      ))}

      {state.logs.length > 0 && (
        <div className="mt-1 border-t border-bg-300 pt-2 flex flex-col gap-0.5">
          {state.logs.slice(-5).map((l, i) => (
            <div key={i} className="text-[11px] text-text-400 truncate">
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
