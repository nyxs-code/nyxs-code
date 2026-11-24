import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpDown, ChevronDown, Clock, ListFilter, Loader2, MessageCircle, MoreHorizontal, Plus, Search, Settings, Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getLanguage, useTranslations, type Translations } from "@/lib/i18n";
import { useConfirm } from "@/lib/useConfirm";
import { workspaceName } from "@/lib/workspace";
import type { PermissionMode } from "@/lib/configSchema";
import type { Model } from "@/components/ui/chat-input/types";
import {
  loadRoutines,
  onRoutineDraft,
  peekRoutineDraft,
  takeRoutineDraft,
  saveRoutines,
  computeNextRun,
  taskCrons,
  newId,
  type RoutinesData,
  type ScheduledTask,
} from "@/lib/scheduledTasks";
import { describeTrigger, fromCron } from "@/lib/scheduleTriggers";
import { Dropdown, MenuItem, MenuSeparator, PillTabs, SearchBox } from "@/components/customize/ui";
import { ScheduledTaskDialog, type TaskFields } from "@/components/scheduled/ScheduledTaskDialog";
import { StopwatchArt, WavyDivider } from "@/components/scheduled/StopwatchArt";
import { TEMPLATES, taskIcon, type TaskTemplate } from "@/components/scheduled/templates";

type S = Translations["scheduled"];
type Tab = "yours" | "templates";
type Filter = "all" | "active" | "paused";
type Sort = "next" | "name" | "created";

/** "Weekdays at 7:18", one per schedule of the task. */
function describeCron(cron: string, t: S): string {
  return describeTrigger(
    fromCron(cron),
    {
      hourly: t.descHourly,
      daily: t.descDaily,
      weekdays: t.descWeekdays,
      weekly: t.descWeekly,
      monthly: t.descMonthly,
      custom: t.descCustom,
    },
    t.weekdaysEvery.split(","),
  );
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(getLanguage(), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function IconTile({ icon: Icon, hoverPlus }: { icon: TaskTemplate["icon"]; hoverPlus?: boolean }) {
  return (
    <span className="relative w-9 h-9 shrink-0 rounded-[8px] bg-bg-200 flex items-center justify-center text-text-300">
      <Icon className={cn("w-4 h-4", hoverPlus && "group-hover:opacity-0")} strokeWidth={1.75} />
      {hoverPlus && <Plus className="absolute w-4 h-4 opacity-0 group-hover:opacity-100 text-text-200" strokeWidth={1.75} />}
    </span>
  );
}

function ScheduleLine({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 mt-1.5 text-[13px] text-text-400">
      <Clock className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  );
}

function TemplateGrid({ onUse }: { onUse: (tpl: TaskTemplate) => void }) {
  const t = useTranslations().scheduled;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
      {TEMPLATES.map((tpl) => (
        <button
          key={tpl.id}
          type="button"
          onClick={() => onUse(tpl)}
          className="group flex items-start gap-3.5 p-2 rounded-[8px] text-left hover:bg-bg-200/60 transition-colors"
        >
          <IconTile icon={tpl.icon} hoverPlus />
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] text-text-100">{t[tpl.name]}</span>
            <span className="block text-[13px] text-text-300 leading-snug mt-0.5">{t[tpl.desc]}</span>
            <ScheduleLine>{describeCron(tpl.cron, t)}</ScheduleLine>
          </span>
        </button>
      ))}
    </div>
  );
}

type DialogState = { editingId: string | null; initial: Partial<TaskFields> } | null;

export function RoutinesPanel({
  onRun,
  onStartChat,
  models = [],
  defaultModel,
}: {
  onRun?: (task: ScheduledTask) => void;
  /** Opens a new chat that starts with this message ("Create with Nyxs"). */
  onStartChat?: (title: string, prompt: string) => void;
  models?: Model[];
  defaultModel?: string;
}) {
  const t = useTranslations().scheduled;
  const [data, setData] = useState<RoutinesData>({ teams: [], tasks: [] });
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("yours");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("next");
  const [confirm, confirmElement] = useConfirm();
  // A task asked for from a session's menu opens the form filled in.
  const [dialog, setDialog] = useState<DialogState>(() => {
    const d = peekRoutineDraft();
    return d ? { editingId: null, initial: { name: d.name, prompt: d.prompt, workspace: d.workspace } } : null;
  });

  useEffect(() => {
    // The draft read above is used up; one asked for while the panel is open fills it now.
    takeRoutineDraft();
    return onRoutineDraft(() => {
      const d = takeRoutineDraft();
      if (d) setDialog({ editingId: null, initial: { name: d.name, prompt: d.prompt, workspace: d.workspace } });
    });
  }, []);

  const reload = useCallback(async () => {
    const d = await loadRoutines();
    setData(d);
    setLoading(false);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(reload);
    // The scheduler stamps runs and "Create with Nyxs" writes the file from a chat: read it again
    // when the user comes back to the window.
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const persist = useCallback(async (next: RoutinesData) => {
    setData(next);
    await saveRoutines(next);
  }, []);

  const saveFields = async (f: TaskFields) => {
    const [cron, ...extra] = f.crons;
    const fields = {
      name: f.name,
      prompt: f.prompt,
      cron,
      extraCrons: extra.length ? extra : undefined,
      workspace: f.workspace,
      model: f.model,
      permissionMode: f.permissionMode as PermissionMode | undefined,
      template: f.template,
    };
    if (dialog?.editingId) {
      await persist({
        ...data,
        tasks: data.tasks.map((task) => {
          if (task.id !== dialog.editingId) return task;
          const edited = { ...task, ...fields };
          return { ...edited, nextRunAt: edited.enabled ? (computeNextRun(edited) ?? undefined) : undefined };
        }),
      });
    } else {
      const task: ScheduledTask = { id: newId("task"), enabled: true, createdAt: Date.now(), ...fields };
      task.nextRunAt = computeNextRun(task) ?? undefined;
      await persist({ ...data, tasks: [task, ...data.tasks] });
      setTab("yours");
    }
    setDialog(null);
  };

  const toggleTask = async (id: string) => {
    await persist({
      ...data,
      tasks: data.tasks.map((task) => {
        if (task.id !== id) return task;
        const enabled = !task.enabled;
        return { ...task, enabled, nextRunAt: enabled ? (computeNextRun(task) ?? undefined) : undefined };
      }),
    });
  };

  const deleteTask = async (task: ScheduledTask) => {
    const ok = await confirm({
      title: t.deleteConfirm.replace("{name}", task.name),
      message: t.deleteConfirmBody,
      confirmLabel: t.delete,
      cancelLabel: t.cancel,
      danger: true,
    });
    if (ok) await persist({ ...data, tasks: data.tasks.filter((x) => x.id !== task.id) });
  };

  const openNew = (initial: Partial<TaskFields> = {}) => setDialog({ editingId: null, initial });
  const applyTemplate = (tpl: TaskTemplate) =>
    openNew({ name: t[tpl.name], prompt: t[tpl.prompt], crons: [tpl.cron], template: tpl.id });
  const editTask = (task: ScheduledTask) =>
    setDialog({
      editingId: task.id,
      initial: {
        name: task.name,
        prompt: task.prompt,
        crons: taskCrons(task),
        workspace: task.workspace,
        model: task.model,
        permissionMode: task.permissionMode,
        template: task.template,
      },
    });

  const q = query.trim().toLowerCase();
  const tasks = data.tasks
    .filter((x) => !q || `${x.name} ${x.prompt}`.toLowerCase().includes(q))
    .filter((x) => (filter === "active" ? x.enabled : filter === "paused" ? !x.enabled : true))
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "created"
          ? b.createdAt - a.createdAt
          : (a.enabled ? (a.nextRunAt ?? Infinity) : Infinity) - (b.enabled ? (b.nextRunAt ?? Infinity) : Infinity),
    );
  const hasTasks = data.tasks.length > 0;

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar">
      <div className="max-w-[960px] mx-auto px-8 pt-14 pb-16">
        <h1 className="text-[28px] font-serif text-text-100 mb-6">{t.title}</h1>

        <div className="flex items-center gap-2 mb-8">
          <PillTabs
            value={tab}
            onChange={setTab}
            items={[
              { id: "yours", label: t.yours },
              { id: "templates", label: t.templates },
            ]}
          />
          <div className="ml-auto flex items-center gap-1">
            {tab === "yours" && hasTasks && (
              <>
                {searchOpen ? (
                  <SearchBox value={query} onChange={setQuery} placeholder={t.searchPlaceholder} autoFocus className="w-56 mr-1" />
                ) : (
                  <button
                    type="button"
                    aria-label={t.search}
                    onClick={() => setSearchOpen(true)}
                    className="w-8 h-8 rounded-md flex items-center justify-center text-text-200 hover:bg-bg-200 hover:text-text-100"
                  >
                    <Search className="w-4 h-4" />
                  </button>
                )}
                <Dropdown
                  trigger={(open, toggle) => (
                    <button
                      type="button"
                      aria-label={t.filter}
                      aria-expanded={open}
                      onClick={toggle}
                      className={cn(
                        "w-8 h-8 rounded-md flex items-center justify-center text-text-200 hover:bg-bg-200 hover:text-text-100",
                        (open || filter !== "all") && "bg-bg-200 text-text-100",
                      )}
                    >
                      <ListFilter className="w-4 h-4" />
                    </button>
                  )}
                >
                  {(close) =>
                    ([
                      ["all", t.filterAll],
                      ["active", t.filterActive],
                      ["paused", t.filterPaused],
                    ] as [Filter, string][]).map(([id, label]) => (
                      <MenuItem key={id} label={label} checked={filter === id} onClick={() => { setFilter(id); close(); }} />
                    ))
                  }
                </Dropdown>
                <Dropdown
                  trigger={(open, toggle) => (
                    <button
                      type="button"
                      aria-label={t.sort}
                      aria-expanded={open}
                      onClick={toggle}
                      className={cn(
                        "w-8 h-8 rounded-md flex items-center justify-center text-text-200 hover:bg-bg-200 hover:text-text-100",
                        open && "bg-bg-200 text-text-100",
                      )}
                    >
                      <ArrowUpDown className="w-4 h-4" />
                    </button>
                  )}
                >
                  {(close) =>
                    ([
                      ["next", t.sortNext],
                      ["name", t.sortName],
                      ["created", t.sortCreated],
                    ] as [Sort, string][]).map(([id, label]) => (
                      <MenuItem key={id} label={label} checked={sort === id} onClick={() => { setSort(id); close(); }} />
                    ))
                  }
                </Dropdown>
              </>
            )}
            <Dropdown
              className="min-w-[220px]"
              trigger={(open, toggle) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-expanded={open}
                  className="ml-1 inline-flex items-center gap-1.5 h-8 pl-3 pr-2.5 rounded-md bg-text-100 text-bg-0 text-[14px] font-medium hover:opacity-90"
                >
                  {t.newTask}
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              )}
            >
              {(close) => (
                <>
                  {onStartChat && (
                    <MenuItem
                      icon={<MessageCircle className="w-4 h-4" />}
                      label={t.createWithNyxs}
                      onClick={() => { close(); onStartChat(t.createTitle, t.createPrompt); }}
                    />
                  )}
                  <MenuItem icon={<Settings className="w-4 h-4" />} label={t.setUpManually} onClick={() => { close(); openNew(); }} />
                </>
              )}
            </Dropdown>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="w-5 h-5 animate-spin text-text-400" />
          </div>
        ) : tab === "templates" ? (
          <TemplateGrid onUse={applyTemplate} />
        ) : !hasTasks ? (
          <>
            <div className="flex flex-col items-center text-center pt-6">
              <StopwatchArt className="w-[76px] h-[84px] text-text-100" />
              <p className="text-[14px] text-text-300 mt-6">{t.empty}</p>
              <button
                type="button"
                onClick={() => openNew()}
                className="mt-3 h-8 px-3 rounded-md bg-bg-200 text-[14px] text-text-100 hover:bg-bg-300"
              >
                {t.setUpManually}
              </button>
            </div>
            <WavyDivider className="text-bg-300 my-14" />
            <TemplateGrid onUse={applyTemplate} />
          </>
        ) : tasks.length === 0 ? (
          <p className="py-10 text-center text-[14px] text-text-400">{t.noMatches}</p>
        ) : (
          <div>
            {tasks.map((task) => {
              const Icon = taskIcon(task.template);
              const schedule = taskCrons(task).map((c) => describeCron(c, t)).join(" · ");
              return (
                <div
                  key={task.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => editTask(task)}
                  onKeyDown={(e) => { if (e.key === "Enter") editTask(task); }}
                  className="group flex items-start gap-3.5 px-2 py-3.5 border-b border-bg-300 cursor-pointer hover:bg-bg-200/40 outline-none focus-visible:bg-bg-200/40"
                >
                  <span className={cn(!task.enabled && "opacity-50")}>
                    <IconTile icon={Icon} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={cn("text-[14px] truncate", task.enabled ? "text-text-100" : "text-text-300")}>{task.name}</span>
                      {!task.enabled && (
                        <span className="shrink-0 h-[18px] px-1.5 inline-flex items-center rounded-[5px] bg-bg-200 text-[11px] text-text-400">
                          {t.paused}
                        </span>
                      )}
                      {task.workspace && (
                        <span className="shrink-0 text-[12px] text-text-400 truncate">· {workspaceName(task.workspace)}</span>
                      )}
                    </span>
                    <span className="block text-[13px] text-text-300 leading-snug mt-0.5 line-clamp-2">{task.prompt}</span>
                    <ScheduleLine>
                      {schedule}
                      {task.enabled && task.nextRunAt && (
                        <span className="text-text-500"> · {t.nextRun.replace("{when}", formatWhen(task.nextRunAt))}</span>
                      )}
                    </ScheduleLine>
                  </span>
                  <span onClick={(e) => e.stopPropagation()}>
                    <Dropdown
                      trigger={(open, toggle) => (
                        <button
                          type="button"
                          onClick={toggle}
                          aria-label={t.moreOptions}
                          className={cn(
                            "w-8 h-8 rounded-md flex items-center justify-center text-text-400 hover:bg-bg-200 hover:text-text-100",
                            open && "bg-bg-200 text-text-100",
                          )}
                        >
                          <MoreHorizontal className="w-4 h-4" />
                        </button>
                      )}
                    >
                      {(close) => (
                        <>
                          <MenuItem label={t.runNow} onClick={() => { close(); onRun?.(task); }} />
                          <MenuItem label={t.edit} onClick={() => { close(); editTask(task); }} />
                          <MenuItem label={task.enabled ? t.pause : t.resume} onClick={() => { close(); void toggleTask(task.id); }} />
                          <MenuSeparator />
                          <MenuItem danger icon={<Trash2 className="w-4 h-4" />} label={t.delete} onClick={() => { close(); void deleteTask(task); }} />
                        </>
                      )}
                    </Dropdown>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {dialog && (
        <ScheduledTaskDialog
          initial={dialog.initial}
          editing={!!dialog.editingId}
          models={models}
          defaultModel={defaultModel}
          onSave={saveFields}
          onClose={() => setDialog(null)}
        />
      )}
      {confirmElement}
    </div>
  );
}

export default RoutinesPanel;
