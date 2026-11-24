import { useState } from "react";
import { ChevronDown, Clock, Plus, X } from "lucide-react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SettingSelect } from "@/components/settings/SettingSelect";
import { Dropdown, MenuItem, MenuLabel, MenuSeparator } from "@/components/customize/ui";
import type { Model } from "@/components/ui/chat-input/types";
import { PERMISSION_MODES, type PermissionMode } from "@/lib/configSchema";
import { isValidCron } from "@/lib/scheduledTasks";
import { DEFAULT_TRIGGER, fromCron, toCron, weekdayNames, type Frequency, type Trigger } from "@/lib/scheduleTriggers";
import { loadRecentWorkspaces, workspaceName } from "@/lib/workspace";
import { getLanguage, useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** What the form edits; the panel turns it into a task. */
export interface TaskFields {
  name: string;
  prompt: string;
  crons: string[];
  workspace?: string;
  model?: string;
  permissionMode?: PermissionMode;
  template?: string;
}

const MODE_KEY = {
  ask: "modeAsk",
  acceptEdits: "modeAcceptEdits",
  plan: "modePlan",
  auto: "modeAuto",
  skip: "modeSkip",
} as const;

const pad = (n: number) => String(n).padStart(2, "0");

function TriggerRow({
  trigger,
  onChange,
  onRemove,
  onAdd,
}: {
  trigger: Trigger;
  onChange: (t: Trigger) => void;
  onRemove?: () => void;
  onAdd?: () => void;
}) {
  const t = useTranslations().scheduled;
  const set = (patch: Partial<Trigger>) => onChange({ ...trigger, ...patch });
  const freqs: { id: Frequency; label: string }[] = [
    { id: "hourly", label: t.freqHourly },
    { id: "daily", label: t.freqDaily },
    { id: "weekdays", label: t.freqWeekdays },
    { id: "weekly", label: t.freqWeekly },
    { id: "monthly", label: t.freqMonthly },
    { id: "custom", label: t.freqCustom },
  ];
  const days = weekdayNames(getLanguage());
  // Monday first, as calendars in most of the app's languages start the week.
  const weekOrder = [1, 2, 3, 4, 5, 6, 0];
  const cronBad = trigger.frequency === "custom" && !isValidCron(trigger.cron);

  return (
    <div className="flex items-start gap-2">
      <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
        <span className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-bg-200 text-[13px] text-text-100">
          <Clock className="w-3.5 h-3.5" />
          {t.triggerSchedule}
        </span>
        <SettingSelect<Frequency>
          pill
          align="left"
          ariaLabel={t.trigger}
          value={trigger.frequency}
          options={freqs}
          onChange={(frequency) =>
            set(frequency === "custom" ? { frequency, cron: toCron(trigger) } : { frequency })
          }
        />
        {trigger.frequency === "weekly" && (
          <SettingSelect<string>
            pill
            align="left"
            ariaLabel={t.freqWeekly}
            value={String(trigger.weekday)}
            options={weekOrder.map((d) => ({ id: String(d), label: days[d] }))}
            onChange={(v) => set({ weekday: Number(v) })}
          />
        )}
        {trigger.frequency === "monthly" && (
          <SettingSelect<string>
            pill
            align="left"
            ariaLabel={t.freqMonthly}
            value={String(trigger.monthDay)}
            options={Array.from({ length: 31 }, (_, i) => ({ id: String(i + 1), label: t.dayOfMonth.replace("{n}", String(i + 1)) }))}
            onChange={(v) => set({ monthDay: Number(v) })}
          />
        )}
        {trigger.frequency === "hourly" && (
          <SettingSelect<string>
            pill
            align="left"
            ariaLabel={t.freqHourly}
            value={String(trigger.minute)}
            options={Array.from({ length: 12 }, (_, i) => ({ id: String(i * 5), label: t.atMinute.replace("{n}", pad(i * 5)) }))
              .concat(trigger.minute % 5 ? [{ id: String(trigger.minute), label: t.atMinute.replace("{n}", pad(trigger.minute)) }] : [])}
            onChange={(v) => set({ minute: Number(v) })}
          />
        )}
        {trigger.frequency !== "hourly" && trigger.frequency !== "custom" && (
          <input
            type="time"
            aria-label={t.trigger}
            value={`${pad(trigger.hour)}:${pad(trigger.minute)}`}
            onChange={(e) => {
              const [h, m] = e.target.value.split(":").map(Number);
              if (Number.isFinite(h) && Number.isFinite(m)) set({ hour: h, minute: m });
            }}
            className="h-8 w-[132px] px-3 rounded-md bg-bg-200 text-[13px] text-text-100 outline-none focus:ring-1 focus:ring-accent"
          />
        )}
        {trigger.frequency === "custom" && (
          <input
            value={trigger.cron}
            onChange={(e) => set({ cron: e.target.value })}
            spellCheck={false}
            placeholder="0 9 * * 1-5"
            aria-invalid={cronBad}
            className={cn(
              "h-8 w-40 px-3 rounded-md bg-bg-200 text-[13px] font-mono text-text-100 outline-none border",
              cronBad ? "border-red-400" : "border-transparent focus:border-accent",
            )}
          />
        )}
        {cronBad && <span className="basis-full text-[12px] text-red-400">{t.cronInvalid}</span>}
      </div>
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          aria-label={t.addTrigger}
          className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center text-text-200 hover:bg-bg-200 hover:text-text-100"
        >
          <Plus className="w-4 h-4" />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t.removeTrigger}
          className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center text-text-400 hover:bg-bg-200 hover:text-text-100"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

/** Claude's "New scheduled task": name, instructions with their mode and model, when it runs
 *  and in which folder. */
export function ScheduledTaskDialog({
  initial,
  editing,
  models,
  defaultModel,
  onSave,
  onClose,
}: {
  initial: Partial<TaskFields>;
  editing: boolean;
  models: Model[];
  defaultModel?: string;
  onSave: (fields: TaskFields) => void | Promise<void>;
  onClose: () => void;
}) {
  const tr = useTranslations();
  const t = tr.scheduled;
  const [name, setName] = useState(initial.name ?? "");
  const [prompt, setPrompt] = useState(initial.prompt ?? "");
  const [triggers, setTriggers] = useState<Trigger[]>(() =>
    initial.crons?.length ? initial.crons.map(fromCron) : [{ ...DEFAULT_TRIGGER }],
  );
  const [workspace, setWorkspace] = useState<string | undefined>(initial.workspace);
  const [model, setModel] = useState<string | undefined>(initial.model);
  const [mode, setMode] = useState<PermissionMode | undefined>(initial.permissionMode);
  const [saving, setSaving] = useState(false);

  const crons = triggers.map(toCron);
  const valid = name.trim() !== "" && prompt.trim() !== "" && crons.every(isValidCron);
  const modelName = models.find((m) => m.id === (model ?? defaultModel))?.name ?? models[0]?.name ?? "";
  const modeLabel = mode ? tr.chatInput[MODE_KEY[mode]] : t.modeDefault;

  const recent = loadRecentWorkspaces();
  const folders = [...new Set([...(workspace ? [workspace] : []), ...recent])];

  const pickFolder = async () => {
    if (!isTauri) return;
    const picked = await openFolderDialog({ directory: true, multiple: false, title: t.chooseFolder });
    if (typeof picked === "string") setWorkspace(picked);
  };

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        prompt: prompt.trim(),
        crons,
        workspace,
        model,
        permissionMode: mode,
        template: initial.template,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="max-w-[620px] h-[min(740px,100%)] overflow-hidden">
      <DialogHeader className="px-5 pt-4 pb-2">
        <DialogTitle className="text-[16px] font-medium">{editing ? t.dialogEdit : t.dialogNew}</DialogTitle>
      </DialogHeader>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 pb-4">
        <label className="block text-[14px] font-medium text-text-100 mb-1.5" htmlFor="sched-name">
          {t.name}
        </label>
        <input
          id="sched-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.namePlaceholder}
          className="w-full h-9 px-3 rounded-[8px] bg-bg-200 border border-transparent text-[14px] text-text-100 placeholder:text-text-400 outline-none focus:border-accent"
        />

        <label className="block text-[14px] font-medium text-text-100 mt-5 mb-1.5" htmlFor="sched-prompt">
          {t.instructions}
        </label>
        <div className="rounded-[8px] border border-bg-300 overflow-visible focus-within:border-accent">
          <textarea
            id="sched-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t.instructionsPlaceholder}
            rows={6}
            className="block w-full px-3 py-2.5 bg-transparent text-[14px] text-text-100 placeholder:text-text-400 outline-none resize-none"
          />
          <div className="flex justify-end px-2 py-1.5 border-t border-bg-300 bg-bg-200/50 rounded-b-[8px]">
            <Dropdown
              className="min-w-[240px]"
              trigger={(open, toggle) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-expanded={open}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[13px] hover:bg-bg-200"
                >
                  <span className="text-text-100">{modeLabel}</span>
                  <span className="text-text-400">· {modelName}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-text-400" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuLabel>{t.mode}</MenuLabel>
                  <MenuItem label={t.modeDefault} checked={!mode} onClick={() => { setMode(undefined); close(); }} />
                  {PERMISSION_MODES.map((m) => (
                    <MenuItem
                      key={m}
                      label={tr.chatInput[MODE_KEY[m]]}
                      checked={mode === m}
                      onClick={() => { setMode(m); close(); }}
                    />
                  ))}
                  <MenuSeparator />
                  <MenuLabel>{t.model}</MenuLabel>
                  {models.map((m) => (
                    <MenuItem
                      key={m.id}
                      label={m.name}
                      checked={(model ?? defaultModel) === m.id}
                      onClick={() => { setModel(m.id); close(); }}
                    />
                  ))}
                </>
              )}
            </Dropdown>
          </div>
        </div>

        <div className="flex items-start gap-4 mt-6">
          <span className="w-20 shrink-0 h-8 flex items-center text-[14px] font-medium text-text-100">{t.trigger}</span>
          <div className="flex-1 min-w-0 space-y-2">
            {triggers.map((trig, i) => (
              <TriggerRow
                key={i}
                trigger={trig}
                onChange={(next) => setTriggers((ts) => ts.map((x, j) => (j === i ? next : x)))}
                onAdd={i === 0 ? () => setTriggers((ts) => [...ts, { ...DEFAULT_TRIGGER }]) : undefined}
                onRemove={i > 0 ? () => setTriggers((ts) => ts.filter((_, j) => j !== i)) : undefined}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 mt-8 pb-3 border-b border-bg-300">
          <p className="text-[14px] font-medium text-text-100" data-tooltip={t.folderHint}>{t.folder}</p>
          <Dropdown
            className="min-w-[240px] max-w-[320px]"
            trigger={(open, toggle) => (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                className="inline-flex items-center gap-1.5 h-8 max-w-[240px] px-3 rounded-md bg-bg-200 text-[13px] text-text-100 hover:bg-bg-300"
              >
                <span className="truncate">{workspace ? workspaceName(workspace) : t.noFolder}</span>
                <ChevronDown className="w-3.5 h-3.5 shrink-0 text-text-400" />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem label={t.noFolder} checked={!workspace} onClick={() => { setWorkspace(undefined); close(); }} />
                {folders.map((f) => (
                  <MenuItem key={f} label={workspaceName(f)} checked={workspace === f} onClick={() => { setWorkspace(f); close(); }} />
                ))}
                {isTauri && (
                  <>
                    <MenuSeparator />
                    <MenuItem label={t.chooseFolder} onClick={() => { close(); void pickFolder(); }} />
                  </>
                )}
              </>
            )}
          </Dropdown>
        </div>
      </div>

      <div className="flex justify-end gap-2 px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          className="h-8 px-3 rounded-md bg-bg-200 text-[14px] text-text-100 hover:bg-bg-300"
        >
          {t.cancel}
        </button>
        <button
          type="button"
          disabled={!valid || saving}
          onClick={() => void save()}
          className="h-8 px-3 rounded-md bg-text-100 text-bg-0 text-[14px] font-medium hover:opacity-90 disabled:opacity-40"
        >
          {editing ? t.save : t.create}
        </button>
      </div>
    </Dialog>
  );
}
