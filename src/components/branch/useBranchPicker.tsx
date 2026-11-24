import { useCallback, useEffect, useState, type ReactNode, type RefObject } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n";
import { remoteHostOf } from "@/lib/remote";
import { workspaceName } from "@/lib/workspace";
import { subscribeGitChange } from "@/lib/fsWatch";
import { setSessionWorktreeOn, useSessionWorktreeOn } from "@/lib/sessionWorktree";
import { setWorktreeBase, useWorktreeBase } from "@/lib/worktreeBase";
import { sessionWorkingIn, sessionsUsing } from "@/lib/folderSessions";
import { readFolderBranches, switchFolderBranch, type DirtyAction, type FolderBranches, type SwitchRefusal } from "@/lib/gitBranches";
import { cn } from "@/lib/utils";
import { DirtyTreeDialog } from "./DirtyTreeDialog";
import { branchName, fill } from "./branchText";

interface Refused {
  /** Uncommitted changes open the dialog instead; left after it, they are "in the way". */
  reason: Exclude<SwitchRefusal, "uncommitted_changes">;
  branch: string;
  /** What was done to the uncommitted changes before the switch that then failed. */
  after?: DirtyAction;
}

/** Refusals the user gets past by starting the session in a worktree instead. */
const WORKTREE_WAY = new Set<SwitchRefusal>([
  "detached_head",
  "operation_in_progress",
  "branch_elsewhere",
  "session_working",
  "untracked_in_the_way",
  "changes_in_the_way",
]);

export interface BranchPicker {
  /** The folder's branches; null while unknown, or when it isn't a local git repository. */
  data: FolderBranches | null;
  current: string | null;
  /** What the row shows: the base the worktree starts from, or the folder's branch. */
  selected: string | null;
  worktreeOn: boolean;
  /** The branch a switch is under way to. */
  busy: string | null;
  pick: (branch: string) => void;
  reread: () => void;
  /** The notice of a switch that didn't happen and the dialog for uncommitted changes, drawn by
   *  the folder chip so they outlive its menu. */
  overlays: ReactNode;
}

/**
 * The branch of the new session's folder, as Claude Code Desktop keeps it in the folder menu.
 * With Worktree off, picking a branch switches the folder to it now, and refuses (saying why
 * and offering Worktree) when that could lose or tangle work; with Worktree on, it is the
 * branch the session's worktree starts from.
 */
export function useBranchPicker(workspace: string | null | undefined, containerRef: RefObject<HTMLElement | null>): BranchPicker {
  const t = useTranslations().branchPicker;
  const worktreeOn = useSessionWorktreeOn();
  const base = useWorktreeBase(workspace);
  const [info, setInfo] = useState<{ ws: string; data: FolderBranches | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refused | null>(null);
  const [dirty, setDirty] = useState<{ from: string; to: string } | null>(null);
  const local = !!workspace && !remoteHostOf(workspace);

  const reread = useCallback(() => {
    if (!workspace || !local) return;
    void readFolderBranches(workspace)
      .catch(() => null)
      .then((data) => setInfo({ ws: workspace, data }));
  }, [workspace, local]);

  useEffect(() => { reread(); }, [reread]);

  const data = info && info.ws === workspace ? info.data : null;
  const isRepo = !!data;
  // A checkout made anywhere (a terminal, the agent) shows here too. Only for a repository: the
  // watcher has nothing to say about other folders.
  useEffect(() => {
    if (!workspace || !local || !isRepo) return;
    return subscribeGitChange(workspace, reread);
  }, [workspace, local, isRepo, reread]);

  // Another folder: what was said about the last one no longer applies.
  const [shownFor, setShownFor] = useState(workspace);
  if (shownFor !== workspace) {
    setShownFor(workspace);
    setRefused(null);
    setDirty(null);
  }

  useEffect(() => {
    if (!refused) return;
    const close = (e: MouseEvent) => { if (!containerRef.current?.contains(e.target as Node)) setRefused(null); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [refused, containerRef]);

  const current = data?.current ?? null;
  // A base branch deleted since it was picked: the worktree starts from HEAD again.
  const liveBase = base && data?.branches.includes(base) ? base : undefined;
  const selected = worktreeOn ? liveBase ?? current : current;

  const switchTo = async (ws: string, branch: string, after?: DirtyAction) => {
    setBusy(branch);
    setRefused(null);
    const res = await switchFolderBranch(ws, branch, { sessionWorking: sessionWorkingIn(ws) }).catch(() => ({ ok: false as const, reason: "failed" as const }));
    setBusy(null);
    reread();
    if (res.ok) return;
    if (res.reason === "uncommitted_changes" && !after && current) setDirty({ from: current, to: branch });
    // Changes still there after they were handled once are in the way.
    else setRefused({ reason: res.reason === "uncommitted_changes" ? "changes_in_the_way" : res.reason, branch, after });
  };

  const pick = (branch: string) => {
    if (!workspace) return;
    if (worktreeOn) {
      setWorktreeBase(workspace, branch === current ? undefined : branch);
      return;
    }
    if (branch !== current && !busy) void switchTo(workspace, branch);
  };

  let overlays: ReactNode = null;
  if (workspace && (refused || dirty)) {
    const folder = workspaceName(workspace);
    const values = (branch: string) => ({ folder: <bdi className="font-medium text-text-100">{folder}</bdi>, branch: branchName(branch) });
    const afterText = refused?.after ? { stash: t.afterStash, commit: t.afterCommit, discard: t.afterDiscard }[refused.after] : null;
    const step = refused ? (WORKTREE_WAY.has(refused.reason) ? "worktree" : refused.reason === "failed" ? "retry" : null) : null;
    overlays = (
      <>
        {refused && (
          <div role="alert" className="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-[8px] border border-bg-300 bg-bg-100 p-3 shadow-2xl">
            <div className="flex items-start gap-2">
              <AlertTriangle className={cn("mt-0.5 h-4 w-4 shrink-0", refused.reason === "failed" ? "text-danger" : "text-warning")} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-text-100">{t.refused}</p>
                <p className="mt-1 text-[12.5px] leading-snug text-text-300">
                  {fill(t[refused.reason], values(refused.branch))}
                  {afterText && <> {fill(afterText, values(refused.branch))}</>}
                </p>
                {step && (
                  <Button
                    className="mt-2"
                    onClick={() => {
                      const { branch: target, after } = refused;
                      setRefused(null);
                      if (step === "retry") void switchTo(workspace, target, after);
                      else {
                        // Like Claude's "Turn on Worktree": the session starts from that branch instead.
                        setSessionWorktreeOn(true);
                        setWorktreeBase(workspace, target === current ? undefined : target);
                      }
                    }}
                  >
                    {step === "retry" ? t.tryAgain : t.turnOnWorktree}
                  </Button>
                )}
              </div>
              <button type="button" onClick={() => setRefused(null)} aria-label={t.dismiss} className="shrink-0 rounded-[4px] p-0.5 text-text-400 hover:bg-bg-200 hover:text-text-100">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
        {dirty && (
          <DirtyTreeDialog
            cwd={workspace}
            folder={folder}
            from={dirty.from}
            to={dirty.to}
            otherSessions={sessionsUsing(workspace)}
            onCancel={() => setDirty(null)}
            onResolved={(action) => {
              const target = dirty.to;
              setDirty(null);
              void switchTo(workspace, target, action);
            }}
          />
        )}
      </>
    );
  }

  return { data, current, selected, worktreeOn, busy, pick, reread, overlays };
}
