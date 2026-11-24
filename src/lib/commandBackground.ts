import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@/lib/ipc";
import { listen } from "@tauri-apps/api/event";

/**
 * Moving the agent's running commands to the background, as Claude Code Desktop does: the reply's
 * "Run in background" action and Ctrl+B move the commands a session has running now
 * (`agent_run_to_background`), and a command that reaches its time limit moves there by itself
 * instead of being stopped. A moved command goes on as a background shell; its result says so.
 */

const running = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const l of listeners) l();
}

/** A Bash command of `sessionId` that can move started (`runId`), or ended or moved (`done`). */
export function noteMovableCommand(sessionId: string | undefined, runId: string, done = false): void {
  if (!sessionId) return;
  const set = running.get(sessionId) ?? new Set<string>();
  if (done) set.delete(runId);
  else set.add(runId);
  if (set.size) running.set(sessionId, set);
  else running.delete(sessionId);
  changed();
}

export function hasMovableCommand(sessionId: string | undefined): boolean {
  return !!sessionId && (running.get(sessionId)?.size ?? 0) > 0;
}

export function useHasMovableCommand(sessionId: string | undefined): boolean {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return hasMovableCommand(sessionId);
}

/** Moves every command `sessionId` has running now to the background. False when there was none. */
export function moveCommandsToBackground(sessionId: string | undefined): boolean {
  const ids = sessionId ? [...(running.get(sessionId) ?? [])] : [];
  for (const runId of ids) void invoke("agent_run_to_background", { runId }).catch(() => undefined);
  return ids.length > 0;
}

/** What Rust says about a command that moved. */
export interface Moved {
  shell_id: string;
  by_timeout: boolean;
}

const MARK = /\[moved to the background: (\S+), (by the user|after its time limit of (\d+) ms)\]/;

/** The first line of a moved command's result; the chip finds the move by it. */
export function movedLine(moved: Moved, timeoutMs: number): string {
  return `[moved to the background: ${moved.shell_id}, ${moved.by_timeout ? `after its time limit of ${timeoutMs} ms` : "by the user"}]`;
}

export function movedIn(text: string): { shellId: string; limitMs?: number } | undefined {
  const m = MARK.exec(text);
  if (!m) return undefined;
  return m[3] ? { shellId: m[1], limitMs: Number(m[3]) } : { shellId: m[1] };
}

/** How a moved command's shell ended, live: running until its exit event (or the list) says. */
const shellStatus = new Map<string, string>();
let watching = false;

function watchShells() {
  if (watching) return;
  watching = true;
  void listen<{ id: string; status: string; code: number | null }>("bg-shell-exit", (e) => {
    shellStatus.set(e.payload.id, e.payload.status === "killed" ? "killed" : e.payload.code === 0 ? "done" : "failed");
    changed();
  }).catch(() => undefined);
}

export function useShellEnd(shellId: string | undefined): "running" | "done" | "failed" | "killed" {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  useEffect(() => {
    if (!shellId) return;
    watchShells();
    if (shellStatus.has(shellId)) return;
    // Ended before this chip was on screen (a session opened later): the list says how.
    void invoke<{ id: string; status: string; code: number | null }[]>("agent_bg_list")
      .then((list) => {
        const sh = list.find((s) => s.id === shellId);
        if (sh && sh.status !== "running" && !shellStatus.has(shellId)) {
          shellStatus.set(shellId, sh.status === "killed" ? "killed" : sh.code === 0 ? "done" : "failed");
          changed();
        }
      })
      .catch(() => undefined);
  }, [shellId]);
  return ((shellId && shellStatus.get(shellId)) as "done" | "failed" | "killed" | undefined) ?? "running";
}
