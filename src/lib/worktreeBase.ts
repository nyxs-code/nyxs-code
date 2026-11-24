import { useSyncExternalStore } from "react";

/**
 * The branch a new session's worktree starts from, picked per folder in the composer while
 * Worktree is on. Unset, the worktree starts from what the folder has checked out. It lasts
 * while the app runs, like the composer's other choices for the next session.
 */
const bases = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

const key = (folder: string) => folder.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

export function worktreeBaseOf(folder: string | null | undefined): string | undefined {
  return folder ? bases.get(key(folder)) : undefined;
}

export function setWorktreeBase(folder: string, branch: string | undefined): void {
  if (branch) bases.set(key(folder), branch);
  else bases.delete(key(folder));
  version++;
  for (const l of listeners) l();
}

export function useWorktreeBase(folder: string | null | undefined): string | undefined {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return worktreeBaseOf(folder);
}
