import { truncateMiddle } from "@/tools/limits";
import { normalizePath } from "@/tools/paths";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timed_out: boolean;
  cancelled?: boolean;
  stdout_log?: string;
  stderr_log?: string;
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
}

export const OMITTED_IN_RUST = "bytes de salida omitidos";

export function fullLogNote(name: string, text: string, kept: string, log: string | undefined): string {
  if (!log || (kept === text && !text.includes(OMITTED_IN_RUST))) return "";
  return `\n[full ${name} saved to ${log} — read it with Read (offset/limit) or search it with Grep (path)]`;
}

export function formatRunResult(res: RunResult, max: number): string {
  const flags = `${res.timed_out ? ", timeout" : ""}${res.cancelled ? ", cancelled" : ""}`;
  const parts: string[] = [`[exit code: ${res.code}${flags}]`];
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
