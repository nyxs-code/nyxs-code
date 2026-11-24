import { homeDir } from "@tauri-apps/api/path";
import { readJsonFile, writeJsonFile } from "@/lib/safeJsonFile";
import { parseCron, cronMatches, nextRun } from "./cron";
import type { PermissionMode } from "./configSchema";

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
  /** The project folder the task runs in; the open one when unset. */
  workspace?: string;
  /** More schedules besides `cron` (the form's "+" next to the trigger): it runs on any of them. */
  extraCrons?: string[];
  /** The model the run uses; the app's selected one when unset or no longer available. */
  model?: string;
  /** The permission mode of the run; the app's current one when unset. */
  permissionMode?: PermissionMode;
  /** The template it was made from, for its icon. */
  template?: string;
}

/** Every schedule a task runs on. */
export function taskCrons(task: Pick<ScheduledTask, "cron" | "extraCrons">): string[] {
  return [task.cron, ...(task.extraCrons ?? [])].filter((c) => c.trim());
}

/** A task to fill the Routines form with (from a session's menu in the sidebar). */
export interface RoutineDraft {
  name: string;
  prompt: string;
  workspace?: string;
}

const DRAFT_EVENT = "nyxs:routine-draft";
let draft: RoutineDraft | null = null;

/** Opens the Routines form with this task filled in, now if the panel is open or when it opens. */
export function startRoutineDraft(d: RoutineDraft): void {
  draft = d;
  window.dispatchEvent(new Event(DRAFT_EVENT));
}

/** The draft waiting for the form, left in place (a render may read it twice). */
export const peekRoutineDraft = (): RoutineDraft | null => draft;

/** The draft waiting for the form, once. */
export function takeRoutineDraft(): RoutineDraft | null {
  const d = draft;
  draft = null;
  return d;
}

/** Calls `fn` whenever a draft arrives while the panel is open. */
export function onRoutineDraft(fn: () => void): () => void {
  window.addEventListener(DRAFT_EVENT, fn);
  return () => window.removeEventListener(DRAFT_EVENT, fn);
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
    const matches = taskCrons(t).some((c) => {
      const spec = parseCron(c);
      return !!spec && cronMatches(spec, now);
    });
    if (!matches) return false;
    if (t.lastRunAt && Math.floor(t.lastRunAt / 60_000) === thisMinute) return false;
    return true;
  });
}

/** The soonest of the task's schedules. */
export function computeNextRun(task: Pick<ScheduledTask, "cron" | "extraCrons">, after: Date = new Date()): number | null {
  let best: number | null = null;
  for (const c of taskCrons(task)) {
    const spec = parseCron(c);
    const d = spec ? nextRun(spec, after) : null;
    if (d && (best === null || d.getTime() < best)) best = d.getTime();
  }
  return best;
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}
