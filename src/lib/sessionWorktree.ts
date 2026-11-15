import { useSyncExternalStore } from "react";
import { accountKey } from "@/lib/accountScope";

/** The composer's Worktree switch: whether the next new session works in its own git
 *  worktree. Off by default, like Claude Code Desktop, and kept as last set. */
const KEY = "nyxs.sessionWorktree.v1";
const listeners = new Set<() => void>();

const read = () => {
  try {
    return localStorage.getItem(accountKey(KEY)) === "1";
  } catch {
    return false;
  }
};
let on: boolean | null = null;

export function sessionWorktreeOn(): boolean {
  on ??= read();
  return on;
}

export function setSessionWorktreeOn(value: boolean): void {
  on = value;
  try {
    localStorage.setItem(accountKey(KEY), value ? "1" : "0");
  } catch {
    // Kept for this run.
  }
  listeners.forEach((l) => l());
}

export function useSessionWorktreeOn(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    sessionWorktreeOn,
  );
}
