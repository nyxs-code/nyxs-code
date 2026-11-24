import { useSyncExternalStore } from "react";

/**
 * Commands the agent runs are stopped when one of their processes uses far more memory than the
 * computer has (src-tauri/src/agent/shell/memory_guard.rs), unless the user allowed more for the
 * session from the note under the stopped command, as in Claude Code Desktop. It lasts while
 * the app runs.
 */

/** What Rust reports about a stop: the memory of the largest process and the computer's, in GB. */
export interface MemoryStop {
  used_gb: number;
  installed_gb: number;
}

const lifted = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

export function memoryLimitLifted(sessionId: string | undefined): boolean {
  return !!sessionId && lifted.has(sessionId);
}

export function liftMemoryLimit(sessionId: string): void {
  if (lifted.has(sessionId)) return;
  lifted.add(sessionId);
  version++;
  for (const l of listeners) l();
}

export function useMemoryLimitLifted(sessionId: string | undefined): boolean {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return memoryLimitLifted(sessionId);
}

/** The line a stopped command's result starts its note with; the chip finds the stop by it. */
const MARK = /\[stopped for memory: (\d+) GB used on this (\d+) GB computer\]/;

export function memoryStopLine(stop: MemoryStop): string {
  return `[stopped for memory: ${stop.used_gb} GB used on this ${stop.installed_gb} GB computer]`;
}

/** What the agent is told, as Claude Code Desktop tells it, so it doesn't run the same thing again. */
export function memoryStopNote(stop: MemoryStop): string {
  return (
    `${memoryStopLine(stop)}\n` +
    `Nyxs stopped this command because it was using ${stop.used_gb} GB of memory on this ${stop.installed_gb} GB computer. ` +
    `It did not finish, so any output from it may be partial. Don't run it again as it was: use a narrower or lighter command, ` +
    `and tell the user briefly what happened. If it needs that much memory, say so: the user can allow it for this session ` +
    `from the app's note about the stop.`
  );
}

/** The stop a tool's result reports, for the note under its chip. */
export function memoryStopIn(text: string): { usedGb: number; installedGb: number } | undefined {
  const m = MARK.exec(text);
  return m ? { usedGb: Number(m[1]), installedGb: Number(m[2]) } : undefined;
}
