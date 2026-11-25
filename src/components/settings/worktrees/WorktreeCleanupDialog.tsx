import { useState } from "react";
import { GitBranch } from "lucide-react";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SettingSelect } from "@/components/settings/SettingSelect";
import { getLanguage, useTranslations } from "@/lib/i18n";
import { workspaceName } from "@/lib/workspace";
import { daysSince, formatBytes, removeWorktrees, unusedFor, type CleanupItem, type SessionWorktrees } from "@/lib/worktreeCleanup";

const FILTERS = ["0", "7", "14", "30"] as const;
type Filter = (typeof FILTERS)[number];

interface Progress {
  done: number;
  total: number;
}

interface Result {
  removed: number;
  failed: number;
}

/** Settings › Nyxs Code › Session worktrees › Remove unused worktrees: the worktrees sessions
 *  left, oldest first, to remove (like Claude's). Those without uncommitted changes come
 *  checked; taking one with changes needs the user to say they understand they're lost. */
export function WorktreeCleanupDialog({
  open,
  onClose,
  data,
  failed,
  onRemoved,
}: {
  open: boolean;
  onClose: () => void;
  /** null while it's being read. */
  data: SessionWorktrees | null;
  failed: boolean;
  onRemoved: () => void;
}) {
  const t = useTranslations().worktreeCleanup;
  const lang = getLanguage();
  const [filter, setFilter] = useState<Filter>("7");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [understood, setUnderstood] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const days = Number(filter);
  const visible = data ? unusedFor(data.items, days) : [];
  const isPicked = (i: CleanupItem) => picked[i.sessionId] ?? i.uncommitted === 0;
  const chosen = visible.filter(isPicked);
  const lost = chosen.filter((i) => i.uncommitted !== 0).length;
  const size = formatBytes(chosen.reduce((n, i) => n + i.bytes, 0), lang);
  const busy = progress !== null && result === null;

  const remove = async () => {
    setProgress({ done: 0, total: chosen.length });
    const { removed, failed } = await removeWorktrees(chosen, (done) => setProgress({ done, total: chosen.length }));
    setResult({ removed: removed.length, failed: failed.length });
    setPicked({});
    setUnderstood(false);
    onRemoved();
  };

  const close = () => {
    if (busy) return;
    setProgress(null);
    setResult(null);
    onClose();
  };

  const ago = (at: number) => {
    const d = daysSince(at);
    return d === 0 ? t.today : d === 1 ? t.dayAgo : t.daysAgo.replace("{days}", String(d));
  };
  const changes = (i: CleanupItem) =>
    i.uncommitted === null
      ? t.uncommittedUnknown
      : i.uncommitted === 1
        ? t.uncommittedOne
        : t.uncommittedMany.replace("{count}", String(i.uncommitted));

  let summary = "";
  if (chosen.length > 0) {
    summary = (chosen.length === 1 ? t.selectedOne : t.selectedMany).replace("{count}", String(chosen.length)).replace("{size}", size);
  }

  return (
    <Dialog open={open} onClose={close} stacked className="max-w-[640px]" dismissible={!busy}>
      <DialogHeader>
        <DialogTitle>{t.title}</DialogTitle>
      </DialogHeader>
      <p className="px-4 text-[13px] text-text-300">{t.intro}</p>

      {result ? (
        <div className="px-4 pt-4 text-[13px] text-text-200" role="status">
          {result.removed > 0 && <p>{(result.removed === 1 ? t.removedOne : t.removedMany).replace("{count}", String(result.removed))}</p>}
          {result.failed > 0 && <p className="mt-1 text-warning">{t.failed.replace("{count}", String(result.failed))}</p>}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
            <span className="text-[12px] text-text-400">{t.lastUsed}</span>
            <SettingSelect<Filter>
              value={filter}
              ariaLabel={t.lastUsed}
              onChange={setFilter}
              options={FILTERS.map((f) => ({ id: f, label: f === "0" ? t.any : t.daysPlus.replace("{days}", f) }))}
            />
          </div>
          <div className="mx-4 max-h-[46vh] overflow-y-auto rounded-[6px] border border-bg-300 custom-scrollbar">
            {!data && !failed && <p className="px-3 py-3 text-[13px] text-text-400">{t.checking}</p>}
            {failed && <p className="px-3 py-3 text-[13px] text-warning">{t.error}</p>}
            {data && visible.length === 0 && (
              <p className="px-3 py-3 text-[13px] text-text-400">{days > 0 ? t.emptyDays.replace("{days}", String(days)) : t.emptyAny}</p>
            )}
            {visible.map((i) => (
              <label key={i.path} className="flex cursor-pointer items-center gap-3 border-b border-bg-200 px-3 py-2 last:border-b-0 hover:bg-bg-200/50">
                <input
                  type="checkbox"
                  checked={isPicked(i)}
                  disabled={busy}
                  aria-label={t.selectFor.replace("{name}", i.title)}
                  onChange={(e) => setPicked((p) => ({ ...p, [i.sessionId]: e.target.checked }))}
                  className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-text-100">{i.title}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-text-400">
                    <GitBranch className="h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {[i.branch, workspaceName(i.workspace)].filter(Boolean).join(" · ")}
                      {i.uncommitted !== 0 && <span className="text-warning"> · {changes(i)}</span>}
                    </span>
                  </span>
                </span>
                <span className="shrink-0 text-right text-[12px] tabular-nums text-text-300">{formatBytes(i.bytes, lang)}</span>
                <span className="w-24 shrink-0 text-right text-[12px] text-text-400">{ago(i.lastUsed)}</span>
              </label>
            ))}
          </div>
          {data && data.inUse > 0 && <p className="px-4 pt-2 text-[12px] text-text-400">{t.inUseNote.replace("{count}", String(data.inUse))}</p>}
          <p className="px-4 pt-2 text-[12px] text-text-400">{t.ignoredNote}</p>
          {lost > 0 && (
            <label className="flex items-center gap-2 px-4 pt-2.5 text-[12px] text-text-200">
              <input
                type="checkbox"
                checked={understood}
                disabled={busy}
                onChange={(e) => setUnderstood(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              {t.confirmLoss}
            </label>
          )}
        </>
      )}

      <DialogFooter className="justify-between">
        <p className="min-w-0 text-[12px] text-text-300" role={busy ? "status" : undefined}>
          {busy
            ? t.removing.replace("{done}", String(progress!.done)).replace("{total}", String(progress!.total))
            : !result && summary && (
                <>
                  {summary}{" "}
                  {lost === 0 ? t.keepsAll : <span className="text-warning">{lost === chosen.length ? t.lossAll : t.lossSome.replace("{lost}", String(lost))}</span>}
                </>
              )}
        </p>
        <div className="flex shrink-0 gap-2">
          {result ? (
            <Button onClick={close}>{t.close}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close} disabled={busy}>{t.cancel}</Button>
              <Button variant="danger" disabled={busy || chosen.length === 0 || (lost > 0 && !understood)} onClick={() => void remove()}>
                {(chosen.length === 1 ? t.removeOne : t.removeMany).replace("{count}", String(chosen.length))}
              </Button>
            </>
          )}
        </div>
      </DialogFooter>
    </Dialog>
  );
}
