import { homeDir } from "@tauri-apps/api/path";
import { readJsonFile, writeJsonFile } from "@/lib/safeJsonFile";
import { parseCron, cronMatches, nextRun } from "./cron";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type TeamRole = "architect" | "executor" | "reviewer" | (string & {});

export interface TeamMember {
  role: TeamRole;
  model?: string;
}

export interface Team {
  id: string;
  name: string;
  members: TeamMember[];
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  teamId?: string;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
}

export interface RoutinesData {
  teams: Team[];
  tasks: ScheduledTask[];
}

const EMPTY: RoutinesData = { teams: [], tasks: [] };

let idCounter = 0;
export function newId(prefix = "id"): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `${prefix}_${g.crypto.randomUUID().slice(0, 8)}`;
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

async function routinesPath(): Promise<string> {
  const home = await homeDir();
  if (!home) throw new Error("Could not resolve home directory.");
  return `${home.replace(/[\\/]+$/, "")}/.nyxs/routines.json`;
}

export async function loadRoutines(): Promise<RoutinesData> {
  if (!isTauri) return { ...EMPTY };
  const read = await readJsonFile<Partial<RoutinesData> | null>(await routinesPath(), { backup: true });
  if (read.status !== "ok" || !read.value) return { ...EMPTY };
  return {
    teams: Array.isArray(read.value.teams) ? read.value.teams : [],
    tasks: Array.isArray(read.value.tasks) ? read.value.tasks : [],
  };
}

/** Throws `UnreadableFileError`, leaving the file alone, when routines.json couldn't be read. */
export async function saveRoutines(data: RoutinesData): Promise<void> {
  if (!isTauri) return;
  await writeJsonFile(await routinesPath(), data);
}

export function dueTasks(tasks: ScheduledTask[], now: Date): ScheduledTask[] {
  const thisMinute = Math.floor(now.getTime() / 60_000);
  return tasks.filter((t) => {
    if (!t.enabled) return false;
    const spec = parseCron(t.cron);
    if (!spec || !cronMatches(spec, now)) return false;
    if (t.lastRunAt && Math.floor(t.lastRunAt / 60_000) === thisMinute) return false;
    return true;
  });
}

export function computeNextRun(task: ScheduledTask, after: Date = new Date()): number | null {
  const spec = parseCron(task.cron);
  if (!spec) return null;
  const d = nextRun(spec, after);
  return d ? d.getTime() : null;
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}
