import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Chat } from "@/lib/chatStore";
import type { SessionSummary } from "@/lib/sessionStorage";
import { allowWorkspaceAccess } from "@/lib/workspace";
import { createSessionWorktree, removeSessionWorktree } from "@/lib/worktree";

/** Like Claude Code Desktop, an archived session's worktree goes once it has been archived this long. */
const ARCHIVED_WORKTREE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Keeps sessions' worktrees in place: the open session's is made again on its branch if it was
 *  deleted (or Settings moved worktrees elsewhere), and the files panel may read it; archived
 *  sessions' worktrees are removed after 30 days. Their branches always stay. */
export function useSessionWorktrees({
  activeChat,
  workspace,
  archivedSessions,
  setChats,
}: {
  activeChat: Chat | null;
  workspace: string | null;
  archivedSessions: SessionSummary[];
  setChats: Dispatch<SetStateAction<Chat[]>>;
}) {
  const id = activeChat?.id;
  const root = activeChat?.workspace ?? workspace;
  const branch = activeChat?.worktree?.branch;
  const path = activeChat?.worktree?.path;
  useEffect(() => {
    if (!id || !root || !branch) return;
    let alive = true;
    void createSessionWorktree(root, id, branch)
      .then(async (wt) => {
        await allowWorkspaceAccess(wt.path);
        if (alive && wt.path !== path) {
          setChats((prev) => prev.map((c) => (c.id === id ? { ...c, worktree: { path: wt.path, branch } } : c)));
        }
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [id, root, branch, path, setChats]);

  const cleaned = useRef(new Set<string>());
  useEffect(() => {
    const now = Date.now();
    for (const s of archivedSessions) {
      const ws = s.workspace ?? workspace;
      const wt = s.worktree?.path;
      if (!ws || !wt || cleaned.current.has(wt) || !s.archivedAt || now - s.archivedAt < ARCHIVED_WORKTREE_TTL_MS) continue;
      cleaned.current.add(wt);
      void removeSessionWorktree(ws, wt, true).catch(() => undefined);
    }
  }, [archivedSessions, workspace]);
}
