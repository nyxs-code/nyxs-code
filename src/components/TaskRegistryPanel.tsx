import { motion } from "motion/react";
import { Loader2, CheckCircle2, XCircle, CircleSlash, Clock, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import { useTaskRegistry, isTerminal, type TaskRegistry, type BackgroundTask } from "@/lib/taskRegistry";

function StatusIcon({ status }: { status: BackgroundTask["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="w-3.5 h-3.5 shrink-0 text-accent animate-spin" />;
    case "done":
      return <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-green-400" />;
    case "failed":
      return <XCircle className="w-3.5 h-3.5 shrink-0 text-red-400" />;
    case "stopped":
      return <CircleSlash className="w-3.5 h-3.5 shrink-0 text-text-400" />;
    default:
      return <Clock className="w-3.5 h-3.5 shrink-0 text-text-400" />;
  }
}

function TaskRow({ task, onStop }: { task: BackgroundTask; onStop: (id: string) => void }) {
  const t = useTranslations().taskRegistry;
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
      className="flex items-center gap-2 text-[13px] py-1"
    >
      <StatusIcon status={task.status} />
      <span className={cn("truncate flex-1", task.status === "failed" ? "text-red-300" : "text-text-200")}>
        {task.label}
      </span>
      {task.tokens > 0 && (
        <span className="text-[10px] text-text-400 tabular-nums shrink-0">{task.tokens} tok</span>
      )}
      {!isTerminal(task.status) && (
        <button
          onClick={() => onStop(task.id)}
          className="shrink-0 text-text-400 hover:text-red-400 transition-colors"
          data-tooltip={t.stop}
          aria-label={t.stopTask}
        >
          <Square className="w-3 h-3" />
        </button>
      )}
    </motion.li>
  );
}

export function TaskRegistryPanel({ registry }: { registry: TaskRegistry }) {
  const t = useTranslations().taskRegistry;
  const state = useTaskRegistry(registry);
  const active = state.tasks.filter((task) => !isTerminal(task.status)).length;

  if (state.tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-400 gap-2">
        <Clock className="w-6 h-6 opacity-50" />
        <span className="text-sm">{t.noBackgroundTasks}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3 overflow-y-auto">
      <div className="flex items-center justify-between text-[12px] text-text-300">
        <span className="font-semibold uppercase tracking-wider text-text-200">{t.tasks}</span>
        <span className="tabular-nums">
          {state.tasks.length}
          {active > 0 && <span className="text-accent"> · {active} {t.active}</span>}
        </span>
      </div>
      <ul className="flex flex-col">
        {state.tasks.map((task) => (
          <TaskRow key={task.id} task={task} onStop={registry.stop} />
        ))}
      </ul>
    </div>
  );
}
