import { useCallback, useEffect, useState } from "react";
import { Zap, Plus, Trash2, Play, Power, Clock, Loader2, Pencil, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import { workspaceName } from "@/lib/workspace";
import {
  loadRoutines,
  onRoutineDraft,
  peekRoutineDraft,
  takeRoutineDraft,
  saveRoutines,
  computeNextRun,
  isValidCron,
  newId,
  type RoutinesData,
  type ScheduledTask,
} from "@/lib/scheduledTasks";

const NEVER = "—";

function formatNextRun(ms: number | null | undefined): string {
  if (!ms) return NEVER;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return NEVER;
  }
}

export function RoutinesPanel({ onRun }: { onRun?: (task: ScheduledTask) => void }) {
  const L = useTranslations().routinesPanel;
  const [data, setData] = useState<RoutinesData>({ teams: [], tasks: [] });
  const [loading, setLoading] = useState(true);
  // A task asked for from a session's menu opens the form filled in.
  const [adding, setAdding] = useState(() => !!peekRoutineDraft());
  // The routine the form is editing; none when it creates a new one.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState(() => peekRoutineDraft()?.name ?? "");
  const [prompt, setPrompt] = useState(() => peekRoutineDraft()?.prompt ?? "");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [workspace, setWorkspace] = useState<string | undefined>(() => peekRoutineDraft()?.workspace);

  useEffect(() => {
    // The draft read above is used up; one asked for while the panel is open fills it now.
    takeRoutineDraft();
    return onRoutineDraft(() => {
      const d = takeRoutineDraft();
      if (!d) return;
      setName(d.name);
      setPrompt(d.prompt);
      setWorkspace(d.workspace);
      setEditingId(null);
      setAdding(true);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void loadRoutines().then((d) => {
      if (alive) {
        setData(d);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const persist = useCallback(async (next: RoutinesData) => {
    setData(next);
    await saveRoutines(next);
  }, []);

  const cronOk = isValidCron(cron);
  const canSave = name.trim().length > 0 && prompt.trim().length > 0 && cronOk;

  const resetForm = () => {
    setName("");
    setPrompt("");
    setCron("0 9 * * 1-5");
    setWorkspace(undefined);
    setAdding(false);
    setEditingId(null);
  };

  /** Opens the form with the routine's data; saving replaces it. */
  const startEdit = (task: ScheduledTask) => {
    setName(task.name);
    setPrompt(task.prompt);
    setCron(task.cron);
    setWorkspace(task.workspace);
    setEditingId(task.id);
    setAdding(true);
  };

  const saveTask = async () => {
    if (!canSave) return;
    if (editingId) {
      await persist({
        ...data,
        tasks: data.tasks.map((t) => {
          if (t.id !== editingId) return t;
          const edited = { ...t, name: name.trim(), prompt: prompt.trim(), cron: cron.trim(), workspace };
          return { ...edited, nextRunAt: edited.enabled ? (computeNextRun(edited) ?? undefined) : undefined };
        }),
      });
      resetForm();
      return;
    }
    const task: ScheduledTask = {
      id: newId("task"),
      name: name.trim(),
      prompt: prompt.trim(),
      cron: cron.trim(),
      enabled: true,
      createdAt: Date.now(),
      workspace,
    };
    task.nextRunAt = computeNextRun(task) ?? undefined;
    await persist({ ...data, tasks: [task, ...data.tasks] });
    resetForm();
  };

  const toggleTask = async (id: string) => {
    await persist({
      ...data,
      tasks: data.tasks.map((t) => {
        if (t.id !== id) return t;
        const enabled = !t.enabled;
        return { ...t, enabled, nextRunAt: enabled ? (computeNextRun(t) ?? undefined) : undefined };
      }),
    });
  };

  const deleteTask = async (id: string) => {
    await persist({ ...data, tasks: data.tasks.filter((t) => t.id !== id) });
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-text-400" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar">
      <div className="max-w-2xl mx-auto px-6 py-8">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="flex items-center gap-2.5">
            <Zap className="w-5 h-5 text-accent" />
            <div>
              <h2 className="text-lg font-semibold text-text-100">{L.title}</h2>
              <p className="text-[13px] text-text-400">{L.subtitle}</p>
            </div>
          </div>
          {!adding && (
            <button
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-0 hover:bg-accent-hover transition-colors shrink-0"
            >
              <Plus className="w-3.5 h-3.5" /> {L.add}
            </button>
          )}
        </div>

        {adding && (
          <div className="rounded-[8px] border border-bg-300 bg-bg-100 p-4 mb-6 flex flex-col gap-3">
            {workspace && (
              <div className="flex items-center gap-1.5 text-[12px] text-text-400">
                <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                <span className="text-text-300">{L.project}:</span>
                <span className="min-w-0 truncate text-text-200">{workspaceName(workspace)}</span>
              </div>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-text-300">{L.name}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={L.namePlaceholder}
                className="bg-bg-200 border border-bg-300 rounded-md px-2.5 py-1.5 text-[13px] text-text-100 outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-text-300">{L.prompt}</span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={L.promptPlaceholder}
                rows={3}
                className="bg-bg-200 border border-bg-300 rounded-md px-2.5 py-1.5 text-[13px] text-text-100 outline-none focus:border-accent resize-y"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-text-300">{L.schedule}</span>
              <input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                spellCheck={false}
                className={cn(
                  "bg-bg-200 border rounded-md px-2.5 py-1.5 text-[13px] font-mono text-text-100 outline-none",
                  cron && !cronOk ? "border-red-400 focus:border-red-400" : "border-bg-300 focus:border-accent",
                )}
              />
              <span className={cn("text-[11.5px]", cron && !cronOk ? "text-red-400" : "text-text-500")}>
                {cron && !cronOk ? L.cronInvalid : L.cronHelp}
              </span>
            </label>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button onClick={resetForm} className="px-3 py-1.5 rounded-md text-xs text-text-300 hover:bg-bg-200 transition-colors">
                {L.cancel}
              </button>
              <button
                onClick={() => void saveTask()}
                disabled={!canSave}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-0 hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                {L.save}
              </button>
            </div>
          </div>
        )}

        {data.tasks.length === 0 && !adding ? (
          <div className="flex flex-col items-center justify-center text-center py-20">
            <Clock className="w-7 h-7 text-text-500 mb-2" />
            <p className="text-sm text-text-300">{L.empty}</p>
            <p className="text-xs text-text-500 mt-1">{L.emptyDesc}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {data.tasks.map((task) => (
              <div
                key={task.id}
                className={cn(
                  "rounded-[8px] border border-bg-300 bg-bg-100 p-3.5",
                  !task.enabled && "opacity-60",
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-text-100">{task.name}</span>
                      <code className="shrink-0 px-1.5 py-0.5 rounded bg-bg-200 border border-bg-300 text-[11px] font-mono text-accent">
                        {task.cron}
                      </code>
                    </div>
                    <p className="mt-1 text-[12.5px] text-text-400 line-clamp-2 break-words">{task.prompt}</p>
                    <p className="mt-1 text-[11.5px] text-text-500">
                      {task.enabled ? `${L.nextRun}: ${formatNextRun(task.nextRunAt)}` : L.disabled}
                      {task.workspace && ` · ${workspaceName(task.workspace)}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => onRun?.(task)}
                      data-tooltip={L.runNow}
                      className="p-1.5 rounded-md text-text-400 hover:text-accent hover:bg-bg-200 transition-colors"
                    >
                      <Play className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => startEdit(task)}
                      data-tooltip={L.edit}
                      className="p-1.5 rounded-md text-text-400 hover:text-text-200 hover:bg-bg-200 transition-colors"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => void toggleTask(task.id)}
                      data-tooltip={task.enabled ? L.disable : L.enable}
                      className={cn(
                        "p-1.5 rounded-md hover:bg-bg-200 transition-colors",
                        task.enabled ? "text-accent" : "text-text-500 hover:text-text-300",
                      )}
                    >
                      <Power className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => void deleteTask(task.id)}
                      data-tooltip={L.delete}
                      className="p-1.5 rounded-md text-text-400 hover:text-red-400 hover:bg-bg-200 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default RoutinesPanel;
