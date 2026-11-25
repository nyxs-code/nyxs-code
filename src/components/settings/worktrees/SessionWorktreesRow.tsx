import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { getLanguage, useTranslations } from "@/lib/i18n";
import { formatBytes, readSessionWorktrees, unusedFor, type SessionWorktrees } from "@/lib/worktreeCleanup";
import { WorktreeCleanupDialog } from "./WorktreeCleanupDialog";

/** Unused this long counts as unused in the row's summary, as in Claude's. */
const SUMMARY_DAYS = 14;

/** Settings › Nyxs Code › Session worktrees: how many worktrees sessions left and how much they
 *  take, and the way into removing the unused ones. */
export function SessionWorktreesRow() {
  const cs = useTranslations().codeSettings;
  const lang = getLanguage();
  const [data, setData] = useState<SessionWorktrees | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  const read = useCallback(() => {
    readSessionWorktrees().then(
      (d) => {
        setData(d);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, []);
  useEffect(() => read(), [read]);

  let desc: string;
  if (failed) desc = cs.worktreesError;
  else if (!data) desc = cs.worktreesMeasuring;
  else if (data.items.length + data.inUse === 0) desc = cs.worktreesNone;
  else {
    const count = data.items.length + data.inUse;
    const total = formatBytes(data.items.reduce((n, i) => n + i.bytes, 0), lang);
    desc = (count === 1 ? cs.worktreesSummaryOne : cs.worktreesSummaryMany).replace("{count}", String(count)).replace("{size}", total);
    const unused = unusedFor(data.items, SUMMARY_DAYS);
    if (unused.length) {
      const size = formatBytes(unused.reduce((n, i) => n + i.bytes, 0), lang);
      desc += ` ${cs.worktreesUnused.replace("{days}", String(SUMMARY_DAYS)).replace("{count}", String(unused.length)).replace("{size}", size)}`;
    }
  }

  return (
    <div className="flex items-center justify-between gap-6 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-100">{cs.worktreesTitle}</p>
        <p className="mt-0.5 text-[12px] text-text-400">{desc}</p>
      </div>
      <Button
        disabled={!data || data.items.length === 0}
        onClick={() => {
          setOpen(true);
          read();
        }}
      >
        {cs.worktreesClean}
      </Button>
      <WorktreeCleanupDialog open={open} onClose={() => setOpen(false)} data={data} failed={failed} onRemoved={read} />
    </div>
  );
}
