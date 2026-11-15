import { ArchiveRestore, FolderGit2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isMergedPrLink } from "@/lib/prArchive";
import type { SessionSummary } from "@/lib/sessionStorage";
import { useTranslations } from "@/lib/i18n";

export function ArchivedSessionsModal({
  open,
  onClose,
  sessions,
  onOpen,
  onUnarchive,
}: {
  open: boolean;
  onClose: () => void;
  sessions: SessionSummary[];
  onOpen: (session: SessionSummary) => void;
  onUnarchive: (session: SessionSummary) => void;
}) {
  const t = useTranslations().archived;
  const folderName = (path?: string) =>
    path ? path.split(/[\\/]/).filter(Boolean).pop() ?? path : "";
  return (
    <Dialog open={open} onClose={onClose} className="max-w-2xl max-h-[80vh]">
      <DialogHeader className="px-5 pt-4 pb-3">
        <DialogTitle className="text-[16px]">{t.title}</DialogTitle>
      </DialogHeader>
      <div className="overflow-y-auto custom-scrollbar px-5 pb-5">
        {sessions.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-text-400">
            {t.emptyState}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {sessions.map((s) => (
              <li
                key={`${s.workspace}:${s.id}`}
                className="flex items-center gap-3 rounded-[6px] border border-bg-300 bg-bg-100 px-3 py-2 hover:bg-bg-200/60 transition-colors"
              >
                <button
                  type="button"
                  onClick={() => onOpen(s)}
                  className="min-w-0 flex-1 text-left"
                  data-tooltip={t.reopenTooltip}
                >
                  <div className="truncate text-[13px] font-medium text-text-100">
                    {s.title || s.id}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-text-500">
                    {s.workspace && (
                      <span className="inline-flex items-center gap-1 truncate">
                        <FolderGit2 className="h-3 w-3 shrink-0" />
                        {folderName(s.workspace)}
                      </span>
                    )}
                    {s.prBranch && !isMergedPrLink(s.prBranch) && (
                      <span className="truncate font-mono">{s.prBranch}</span>
                    )}
                  </div>
                </button>
                <Button onClick={() => onUnarchive(s)} className="text-[12px] text-text-200" data-tooltip={t.moveBackTooltip}>
                  <ArchiveRestore className="h-3.5 w-3.5" />
                  {t.unarchive}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
