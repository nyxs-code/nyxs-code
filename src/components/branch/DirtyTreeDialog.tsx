import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n";
import { clearWorkingTree, workingTreeStatus, type DirtyAction, type WorkingTreeStatus } from "@/lib/gitBranches";
import { cn } from "@/lib/utils";
import { branchName, fill } from "./branchText";

const ACTIONS: DirtyAction[] = ["stash", "commit", "discard"];

/**
 * Claude Code Desktop's dialog for a branch switch with uncommitted changes: they get stashed
 * (the default), committed as WIP on the branch being left, or discarded after a second
 * confirmation. Once they are handled, `onResolved` switches.
 */
export function DirtyTreeDialog({
  cwd,
  folder,
  from,
  to,
  otherSessions,
  onResolved,
  onCancel,
}: {
  cwd: string;
  folder: string;
  from: string;
  to: string;
  /** Other sessions working in this repository's folder. */
  otherSessions: number;
  onResolved: (action: DirtyAction) => void;
  onCancel: () => void;
}) {
  const t = useTranslations().branchPicker;
  const cancelLabel = useTranslations().modals.cancel;
  const [status, setStatus] = useState<WorkingTreeStatus | null>(null);
  const [action, setAction] = useState<DirtyAction>("stash");
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void workingTreeStatus(cwd).then((s) => { if (alive) setStatus(s); }).catch(() => undefined);
    return () => { alive = false; };
  }, [cwd]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const labels: Record<DirtyAction, string> = { stash: t.stash, commit: t.commit, discard: t.discard };

  const run = async (a: DirtyAction) => {
    setBusy(true);
    setFailure(null);
    try {
      await clearWorkingTree(cwd, a, from, to);
      onResolved(a);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setConfirmDiscard(false);
    } finally {
      setBusy(false);
    }
  };

  const primary = () => {
    if (action === "discard") setConfirmDiscard(true);
    else void run(action);
  };

  const close = () => { if (!busy) onCancel(); };
  const values = { folder: <bdi className="font-medium">{folder}</bdi>, branch: branchName(from) };

  return (
    <Dialog open onClose={close} role="alertdialog" className="max-w-md" dismissible={!busy}>
      {confirmDiscard ? (
        <>
          <DialogHeader close={false}>
            <DialogTitle>{t.discardTitle}</DialogTitle>
          </DialogHeader>
          <p className="px-4 pb-2 text-[13px] text-text-300">{fill(t.discardBody, values)}</p>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmDiscard(false)} disabled={busy}>{t.back}</Button>
            <Button variant="danger" onClick={() => void run("discard")} disabled={busy}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t.discardConfirm}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <>
          <DialogHeader close={false}>
            <DialogTitle>{fill(t.dirtyTitle, { branch: branchName(from) })}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2 px-4 pb-2 text-[13px] text-text-300">
            <p>{fill(t.dirtyBody, { folder: values.folder, branch: branchName(to) })}</p>
            {otherSessions > 0 && <p>{otherSessions === 1 ? t.othersOne : t.othersMany.replace("{count}", String(otherSessions))}</p>}
            {status && status.files > 0 && (
              <p className="flex flex-wrap items-center gap-1.5">
                {status.files === 1 ? t.filesOne : t.filesMany.replace("{count}", String(status.files))}
                {(status.additions > 0 || status.deletions > 0) && (
                  <span className="tabular-nums">
                    <span className="text-green-600 dark:text-green-400">+{status.additions}</span>{" "}
                    <span className="text-red-500 dark:text-red-400">-{status.deletions}</span>
                  </span>
                )}
              </p>
            )}
            {failure && (
              <div role="alert" className="flex flex-col gap-1">
                <p className="text-danger">{t.stepFailed}</p>
                <button type="button" onClick={() => setShowDetails((s) => !s)} className="self-start text-[12px] text-text-400 hover:text-text-100">
                  {t.viewDetails}
                </button>
                {showDetails && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-[6px] bg-bg-200 p-2 font-mono text-[11.5px] text-text-300 select-text">{failure}</pre>}
              </div>
            )}
          </div>
          <DialogFooter className="justify-between">
            <Button variant="secondary" onClick={close} disabled={busy}>{cancelLabel}</Button>
            {/* A split button: the chosen way to handle the changes, and the others behind the arrow. */}
            <div ref={menuRef} className="relative flex">
              <Button variant="secondary" onClick={primary} disabled={busy} className="rounded-r-none border-r-0">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {labels[action]}
              </Button>
              <Button
                variant="secondary"
                icon
                onClick={() => setMenuOpen((o) => !o)}
                disabled={busy}
                aria-label={t.moreActions}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className="rounded-l-none"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
              {menuOpen && (
                <div data-mod-menu role="menu" className="absolute bottom-full right-0 z-10 mb-1 w-56 rounded-[8px] border border-bg-300 bg-bg-100 p-1 shadow-lg">
                  {ACTIONS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      role="menuitemradio"
                      aria-checked={a === action}
                      onClick={() => { setAction(a); setFailure(null); setMenuOpen(false); }}
                      className={cn("flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] hover:bg-bg-200", a === "discard" ? "text-danger" : "text-text-200")}
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{a === action && <Check className="h-4 w-4 text-accent" />}</span>
                      {labels[a]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
