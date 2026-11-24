import { truncateMiddle } from "@/tools/limits";
import { normalizePath } from "@/tools/paths";
import { memoryStopNote, type MemoryStop } from "@/lib/commandMemory";
import { movedLine, type Moved } from "@/lib/commandBackground";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timed_out: boolean;
  cancelled?: boolean;
  stdout_log?: string;
  stderr_log?: string;
  /** Stopped because one of its processes used far more memory than the computer has. */
  memory_stop?: MemoryStop;
  /** Still running, moved to the background (by the user or its time limit). */
  background?: Moved;
}

/** A command that moved to the background: what it printed so far and where it goes on. */
export function formatMovedResult(res: RunResult, moved: Moved, timeoutMs: number, max: number): string {
  const how = moved.by_timeout ? `It reached its time limit of ${Math.round(timeoutMs / 1000)} s` : "The user moved it";
  const head =
    `${movedLine(moved, timeoutMs)}\n` +
    `${how}, so it was moved to the background instead of being stopped: it keeps running as shell ${moved.shell_id}. ` +
    `Use BashOutput with this ID to read what it prints from now on, or KillShell to stop it; you'll be told when it ends. ` +
    `Go on with something else meanwhile.\nOutput so far:`;
  const body = [res.stdout.trimEnd(), res.stderr.trim() ? `[stderr]\n${res.stderr.trimEnd()}` : ""].filter(Boolean).join("\n");
  return `${head}\n${body ? truncateMiddle(body, max - head.length) : "(none yet)"}`;
}

export const commandLogRoots = new Set<string>();

export function rememberCommandLogs(res: RunResult): void {
  for (const log of [res.stdout_log, res.stderr_log]) {
    const dir = log?.replace(/[\\/][^\\/]*$/, "");
    if (dir) commandLogRoots.add(normalizePath(dir));
  }
}

export interface BgShell {
  id: string;
  command: string;
  description: string;
  output: string;
  status: string;
  code: number | null;
}

export interface BgOutputResult {
  output: string;
  nextOffset: number;
  status: string;
  code: number | null;
  memoryStop?: MemoryStop;
}

export const OMITTED_IN_RUST = "bytes de salida omitidos";

export function fullLogNote(name: string, text: string, kept: string, log: string | undefined): string {
  if (!log || (kept === text && !text.includes(OMITTED_IN_RUST))) return "";
  return `\n[full ${name} saved to ${log} — read it with Read (offset/limit) or search it with Grep (path)]`;
}

export function formatRunResult(res: RunResult, max: number): string {
  const flags = `${res.timed_out ? ", timeout" : ""}${res.cancelled ? ", cancelled" : ""}${res.memory_stop ? ", stopped for memory" : ""}`;
  const parts: string[] = [`[exit code: ${res.code}${flags}]`];
  if (res.memory_stop) parts.push(memoryStopNote(res.memory_stop));
  const stdout = res.stdout.trimEnd();
  const stderr = res.stderr.trimEnd();
  const budget = max - parts[0].length - 400;
  const errBudget = stdout ? Math.max(Math.floor(budget / 3), budget - stdout.length) : budget;
  const outBudget = budget - Math.min(stderr.length, errBudget);
  if (stdout.trim()) {
    const kept = truncateMiddle(stdout, outBudget);
    parts.push(kept + fullLogNote("stdout", stdout, kept, res.stdout_log));
  }
  if (stderr.trim()) {
    const kept = truncateMiddle(stderr, errBudget);
    parts.push(`[stderr]\n${kept}${fullLogNote("stderr", stderr, kept, res.stderr_log)}`);
  }
  return parts.join("\n");
}
