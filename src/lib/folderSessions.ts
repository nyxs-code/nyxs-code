import { useEffect, useSyncExternalStore } from "react";

/**
 * Which folders other sessions are in, for the composer's branch picker: a session working in
 * the folder makes it refuse to switch branches, and the dialog for uncommitted changes says how
 * many sessions use the repository. App publishes it; the picker reads it.
 */
interface FolderSessionsSnapshot {
  /** Folders where a session has a reply running. */
  working: ReadonlySet<string>;
  /** Sessions (not archived) per folder they work in without a worktree. */
  using: ReadonlyMap<string, number>;
}

let snapshot: FolderSessionsSnapshot = { working: new Set(), using: new Map() };
const listeners = new Set<() => void>();

const key = (folder: string) => folder.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

export function sessionWorkingIn(folder: string): boolean {
  return snapshot.working.has(key(folder));
}

export function sessionsUsing(folder: string): number {
  return snapshot.using.get(key(folder)) ?? 0;
}

export function useFolderSessions(): FolderSessionsSnapshot {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

interface SessionLike {
  id: string;
  workspace?: string | null;
  worktree?: { path: string } | null;
}

/** Called once from App: keeps the snapshot in step with the sessions and the running replies. */
export function usePublishFolderSessions(
  chats: readonly SessionLike[],
  sessions: readonly SessionLike[],
  busyIds: ReadonlySet<string>,
  workspace: string | null,
): void {
  useEffect(() => {
    const working = new Set<string>();
    for (const id of busyIds) {
      const chat = chats.find((c) => c.id === id);
      const folder = chat?.worktree?.path ?? chat?.workspace ?? workspace;
      if (folder) working.add(key(folder));
    }
    const using = new Map<string, number>();
    const seen = new Set<string>();
    for (const s of [...chats, ...sessions]) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const folder = s.worktree ? null : s.workspace ?? workspace;
      if (folder) using.set(key(folder), (using.get(key(folder)) ?? 0) + 1);
    }
    snapshot = { working, using };
    for (const l of listeners) l();
  }, [chats, sessions, busyIds, workspace]);
}
