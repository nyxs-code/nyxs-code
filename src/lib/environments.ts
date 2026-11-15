import { useSyncExternalStore } from "react";
import { accountKey } from "@/lib/accountScope";
import { getCurrentUserId } from "@/lib/auth";
import { deleteSecret, getSecret, setSecret } from "@/lib/secureStore";
import { setSessionWorktreeOn } from "@/lib/sessionWorktree";

/** A saved environment, like Claude Code Desktop's: where new sessions start (a folder, with or
 *  without their own worktree) and variables only those sessions get. The variables live in the
 *  OS keychain, encrypted, like provider keys; the rest in the app's storage. */
export interface SavedEnvironment {
  id: string;
  name: string;
  folder: string;
  worktree: boolean;
}

const KEY = "nyxs.environments.v1";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const read = (): SavedEnvironment[] => {
  try {
    const v = JSON.parse(localStorage.getItem(accountKey(KEY)) || "[]") as SavedEnvironment[];
    return Array.isArray(v) ? v.filter((e) => e && typeof e.id === "string" && typeof e.folder === "string") : [];
  } catch {
    return [];
  }
};
let cache: SavedEnvironment[] | null = null;
export const savedEnvironments = (): SavedEnvironment[] => (cache ??= read());

const write = (list: SavedEnvironment[]) => {
  cache = list;
  try {
    localStorage.setItem(accountKey(KEY), JSON.stringify(list));
  } catch {
    // Kept for this run.
  }
  emit();
};

const secretAccount = (id: string) => {
  const user = getCurrentUserId();
  return user ? `env:${user}:${id}` : `env:${id}`;
};

/** `KEY=value` lines, as Desktop takes them: blank lines and `#` comments are skipped, quotes
 *  around a value are dropped, and a line that isn't a valid variable is reported. */
export function parseEnvText(text: string): { vars: Record<string, string>; bad: number[] } {
  const vars: Record<string, string> = {};
  const bad: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      bad.push(i + 1);
      return;
    }
    vars[m[1]] = m[2].replace(/^(["'])([\s\S]*)\1$/, "$2");
  });
  return { vars, bad };
}

export async function environmentVariablesText(id: string): Promise<string> {
  return (await getSecret(secretAccount(id))) ?? "";
}

export async function saveEnvironment(env: Omit<SavedEnvironment, "id"> & { id?: string }, variables: string): Promise<SavedEnvironment> {
  const id = env.id ?? Math.random().toString(36).slice(2, 10);
  const next: SavedEnvironment = { id, name: env.name.trim() || env.folder, folder: env.folder, worktree: env.worktree };
  const list = savedEnvironments();
  write(list.some((e) => e.id === id) ? list.map((e) => (e.id === id ? next : e)) : [...list, next]);
  await setSecret(secretAccount(id), variables);
  varsCache.delete(id);
  return next;
}

export async function deleteEnvironment(id: string): Promise<void> {
  write(savedEnvironments().filter((e) => e.id !== id));
  if (pending === id) setPendingEnvironment(null);
  await deleteSecret(secretAccount(id));
  varsCache.delete(id);
}

export const useSavedEnvironments = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    savedEnvironments,
  );

/** The environment the next new session starts from, picked in the composer. */
let pending: string | null = null;
export const pendingEnvironment = () => pending;
export function setPendingEnvironment(id: string | null): void {
  pending = id;
  emit();
}
export const usePendingEnvironment = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );

/** Starting from an environment: its folder opens, the composer's Worktree switch takes its
 *  setting, and the next new session records it. */
export function applyEnvironment(env: SavedEnvironment, selectFolder: (path: string) => void): void {
  selectFolder(env.folder);
  setSessionWorktreeOn(env.worktree);
  setPendingEnvironment(env.id);
}

/** Which environment each session started from (sessions keep it, see Chat.environmentId). */
const sessionEnv = new Map<string, string>();
export function setSessionEnvironments(chats: { id: string; environmentId?: string }[]): void {
  for (const c of chats) if (c.environmentId) sessionEnv.set(c.id, c.environmentId);
}

/** A session that just started: known before its first turn, which runs before the chats update. */
export function registerSessionEnvironment(chatId: string, environmentId: string): void {
  sessionEnv.set(chatId, environmentId);
}

const varsCache = new Map<string, Record<string, string>>();

/** The variables a session's turns run with: its environment's, or none. Only sessions started
 *  from an environment get them, and dev servers never do (as in Desktop). */
export async function envForSession(sessionKey: string | undefined): Promise<Record<string, string> | undefined> {
  const id = sessionKey ? sessionEnv.get(sessionKey) : undefined;
  if (!id) return undefined;
  let vars = varsCache.get(id);
  if (!vars) {
    vars = parseEnvText(await environmentVariablesText(id)).vars;
    varsCache.set(id, vars);
  }
  return Object.keys(vars).length ? vars : undefined;
}
