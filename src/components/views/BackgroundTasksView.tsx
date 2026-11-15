import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@/lib/ipc";
import { Boxes, ChevronDown, ChevronRight, Loader2, Maximize2, Minimize2, Square, Trash, X } from "lucide-react";
import { useTranslations, type Translations } from "@/lib/i18n";
import { stripAnsi } from "@/lib/ansi";
import { WorkflowCounts, WorkflowProgress } from "@/components/WorkflowProgress";
import { getWorkflowStore, resetWorkflow } from "@/lib/workflowSession";
import { stopAllAgents, useWorkflowProgress, type WorkflowStore } from "@/lib/orchestratorStore";
import type { ActivityEntry } from "@/lib/agentActivity";
import { AgentActivityLog } from "@/components/AgentActivityLog";
import { stopClaudeCodeTask } from "@/lib/claudeCode";
import {
  clearFinishedClaudeCodeTasks,
  getClaudeCodeTasks,
  markClaudeCodeTaskStopped,
  subscribeClaudeCodeTasks,
  type ClaudeCodeTask,
} from "@/lib/claudeCodeTasks";
import { type BackgroundFocus, focusMatches, useBackgroundFocus } from "./bgFocus";
import { finishedOpenFor, rememberFinishedOpen } from "./bgPrefs";
import { type BgShell, formatTaskDuration, inWorkspace, shellTitle, killShell, useBgShells, shellStatus } from "./bgShells";

interface TaskRow {
  key: string;
  id: string;
  title: string;
  command: string;
  running: boolean;
  problem: string | null;
  startedAt: number;
  endedAt: number | null;
  output: string | null;
  outputFile: string | null;
  onStop: (() => void) | null;
  /** What the stop button says: some CLIs can only stop a sub-agent by stopping the whole reply. */
  stopLabel: string;
  /** A sub-agent's steps, shown in place of a command. */
  activity: ActivityEntry[] | null;
}

function claudeRow(task: ClaudeCodeTask, t: Translations["views"]): TaskRow {
  const problem = task.status === "failed" ? t.failed : task.status === "killed" || task.status === "stopped" ? t.stopped : null;
  const running = task.status === "running";
  return {
    key: `cc-${task.id}`,
    id: task.id,
    title: task.title,
    command: task.command,
    running,
    problem,
    startedAt: task.startedAt,
    endedAt: task.endedAt ?? null,
    output: null,
    outputFile: task.outputFile ?? null,
    onStop: running
      ? () => void (task.stop ? task.stop() : stopClaudeCodeTask(task.runId, task.id)).then((ok) => ok && markClaudeCodeTaskStopped(task.id))
      : null,
    stopLabel: task.stopsTurn ? t.stopWholeTurn : t.stop,
    activity: task.activity ?? (task.toolUseId && isAgentTask(task) ? [] : null),
  };
}

/** Claude Code's sub-agents, as opposed to its background commands. */
function isAgentTask(task: ClaudeCodeTask): boolean {
  return /agent|^task$/i.test(task.tool);
}

function shellRow(shell: BgShell, t: Translations["views"]): TaskRow {
  const st = shellStatus(shell, t);
  return {
    key: shell.id,
    id: shell.id,
    title: shellTitle(shell),
    command: shell.command,
    running: st.running,
    problem: st.running || (shell.status !== "killed" && (shell.code ?? 0) === 0) ? null : st.label,
    startedAt: shell.startedAt ?? 0,
    endedAt: shell.endedAt ?? null,
    output: shell.output,
    outputFile: null,
    onStop: st.running ? () => killShell(shell.id) : null,
    stopLabel: t.stop,
    activity: null,
  };
}

function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function useFileOutput(path: string | null, open: boolean, running: boolean): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !path) return;
    let alive = true;
    const load = () =>
      invoke<string | null>("claude_code_task_output", { path })
        .then((out) => alive && setText(out ?? ""))
        .catch(() => alive && setText(""));
    void load();
    const id = running ? setInterval(load, 2000) : null;
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
  }, [path, open, running]);
  return text;
}

function useFocusedOpen(focus: BackgroundFocus | null, focused: boolean, initial: boolean) {
  const [state, setState] = useState<{ nonce: number | null; open: boolean }>({ nonce: null, open: initial });
  const open = focused && focus && state.nonce !== focus.nonce ? true : state.open;
  const setOpen = (next: (o: boolean) => boolean) => setState({ nonce: focus?.nonce ?? null, open: next(open) });
  return [open, setOpen] as const;
}

function TaskRowItem({ row, now, focus }: { row: TaskRow; now: number; focus: BackgroundFocus | null }) {
  const t = useTranslations().views;
  const focused = focusMatches(focus, row.id, row.title);
  const [open, setOpen] = useFocusedOpen(focus, focused, false);
  const ref = useRef<HTMLDivElement>(null);
  const focusNonce = focused ? focus.nonce : null;
  useEffect(() => {
    if (focusNonce === null || !ref.current) return;
    ref.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    ref.current.firstElementChild?.animate([{ backgroundColor: "var(--bg-200)" }, { backgroundColor: "transparent" }], {
      duration: 1600,
      easing: "ease-out",
    });
  }, [focusNonce]);
  const fileOutput = useFileOutput(row.outputFile, open, row.running);
  const raw = row.outputFile ? fileOutput : row.output;
  const output = raw === null ? null : stripAnsi(raw);
  const duration = row.startedAt ? formatTaskDuration((row.endedAt ?? now) - row.startedAt) : "";
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div ref={ref}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen((o) => !o))}
        className="group flex items-center gap-2 rounded-md px-2.5 py-1.5 cursor-pointer hover:bg-bg-200 transition-colors"
      >
        {row.running && <Loader2 className="w-3 h-3 text-accent animate-spin shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-[13px] text-text-100">{row.title}</span>
        {row.problem && <span className="shrink-0 text-[12px] text-red-400">{row.problem}</span>}
        {row.onStop && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              row.onStop?.();
            }}
            data-tooltip={row.stopLabel}
            aria-label={row.stopLabel}
            className="shrink-0 p-0.5 rounded text-text-400 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
          >
            <Square className="w-3 h-3" fill="currentColor" />
          </button>
        )}
        <span className="shrink-0 text-[12px] tabular-nums text-text-400">{duration}</span>
        <Chevron className="w-3.5 h-3.5 shrink-0 text-text-400" />
      </div>
      {open && (
        <div className="px-2.5 pt-1 pb-2.5 flex flex-col gap-2">
          {row.activity ? (
            <AgentActivityLog activity={row.activity} running={row.running} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-accent">
              <span className="text-text-400">$ </span>
              {row.command}
            </pre>
          )}
          {(!row.activity || (output?.trim() && !row.running)) && (
            <pre className="max-h-64 overflow-auto custom-scrollbar rounded-md bg-bg-200 px-3 py-2 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-text-300">
              {output === null ? "…" : output.trimEnd() || (row.running ? "…" : t.noOutput)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function TaskGroup({
  label,
  rows,
  now,
  focus,
  initialOpen = true,
  onToggle,
}: {
  label: string;
  rows: TaskRow[];
  now: number;
  focus: BackgroundFocus | null;
  initialOpen?: boolean;
  onToggle?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useFocusedOpen(focus, rows.some((r) => focusMatches(focus, r.id, r.title)), initialOpen);
  const setOpen = (next: (o: boolean) => boolean) => {
    setOpenState(next);
    onToggle?.(next(open));
  };
  if (rows.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] text-text-400 hover:text-text-200 transition-colors"
      >
        <span className="font-medium">{label}</span>
        <span className="tabular-nums">{rows.length}</span>
        <Chevron className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="flex flex-col">
          {rows.map((r) => (
            <TaskRowItem key={r.key} row={r} now={now} focus={focus} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowGroup({ store }: { store: WorkflowStore }) {
  const t = useTranslations().workflowProgress;
  const state = useWorkflowProgress(store);
  const [open, setOpen] = useState(true);
  if (state.agents.length === 0 && state.logs.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  const canStop = state.agents.some((a) => a.status === "running" && a.stoppable);
  return (
    <div>
      <div className="flex items-center pr-2.5">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] text-text-400 hover:text-text-200 transition-colors"
        >
          <span className="font-medium">{t.workflow}</span>
          <WorkflowCounts store={store} />
          <Chevron className="w-3.5 h-3.5" />
        </button>
        {canStop && (
          <button
            onClick={() => stopAllAgents(store)}
            className="flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[12px] text-text-400 hover:text-red-400 hover:bg-bg-200 transition-colors"
          >
            <Square className="w-2.5 h-2.5" fill="currentColor" />
            {t.stopAll}
          </button>
        )}
      </div>
      {open && <WorkflowProgress store={store} embedded />}
    </div>
  );
}

export function BackgroundTasksView({
  sessionId = "draft",
  workspace,
  onClose,
  onToggleMaximize,
  maximized = false,
}: {
  sessionId?: string;
  /** Only this project's tasks are shown: mixing every project's was confusing. */
  workspace?: string | null;
  onClose?: () => void;
  onToggleMaximize?: () => void;
  maximized?: boolean;
}) {
  const t = useTranslations().views;
  const { list, setShells } = useBgShells(workspace);
  const allClaudeTasks = useSyncExternalStore(subscribeClaudeCodeTasks, getClaudeCodeTasks);
  const claudeTasks = allClaudeTasks.filter((c) => inWorkspace(c, workspace));
  const rows = [...claudeTasks.map((c) => claudeRow(c, t)), ...list.map((s) => shellRow(s, t))].sort(
    (a, b) => b.startedAt - a.startedAt,
  );
  const running = rows.filter((r) => r.running);
  const finished = rows.filter((r) => !r.running);
  const now = useTicker(running.length > 0);
  const focus = useBackgroundFocus();
  const workflowStore = getWorkflowStore(sessionId);
  const workflow = useWorkflowProgress(workflowStore);
  const hasWorkflow = workflow.agents.length > 0 || workflow.logs.length > 0;
  const workflowFinished = hasWorkflow && workflow.running === 0;

  const clearFinished = () => {
    if (workflowFinished) resetWorkflow(sessionId);
    clearFinishedClaudeCodeTasks(claudeTasks.map((c) => c.id));
    invoke<BgShell[]>("agent_bg_clear", { ids: list.map((s) => s.id) })
      .then((remaining) => setShells(Object.fromEntries(remaining.map((s) => [s.id, s]))))
      .catch(() => {});
  };

  const iconBtn = "p-1.5 rounded-md text-text-400 hover:text-text-100 hover:bg-bg-200 transition-colors disabled:opacity-40 disabled:pointer-events-none";

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-3 py-2">
        <span className="flex-1 truncate text-[13px] font-medium text-text-100">{t.backgroundTasks}</span>
        <button onClick={clearFinished} disabled={finished.length === 0 && !workflowFinished} aria-label={t.clearFinished} data-tooltip={t.clearFinished} className={iconBtn}>
          <Trash className="w-4 h-4" strokeWidth={1.75} />
        </button>
        {onToggleMaximize && (
          <button onClick={onToggleMaximize} aria-label={maximized ? t.showChat : t.diffExpandPanel} data-tooltip={maximized ? t.showChat : t.diffExpandPanel} className={iconBtn}>
            {maximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        )}
        {onClose && (
          <button onClick={onClose} aria-label={t.close} data-tooltip={t.close} className={iconBtn}>
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      {rows.length === 0 && !hasWorkflow ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center px-6">
          <Boxes className="w-7 h-7 text-text-500 mb-2" />
          <p className="text-sm text-text-300">{t.noBackgroundTasks}</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-1.5 pb-3 flex flex-col gap-2">
          <WorkflowGroup store={workflowStore} />
          <TaskGroup label={t.running} rows={running} now={now} focus={focus} />
          <TaskGroup
            key={sessionId}
            label={t.finished}
            rows={finished}
            now={now}
            focus={focus}
            initialOpen={finishedOpenFor(sessionId)}
            onToggle={(open) => rememberFinishedOpen(sessionId, open)}
          />
        </div>
      )}
    </div>
  );
}
