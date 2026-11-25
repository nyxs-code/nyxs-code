import { invoke } from "@/lib/ipc";
import { isRemotePath } from "@/lib/remote";
import { sessionInUse, sessionsWithBackgroundWork } from "@/lib/sessionsInUse";
import { listSessionsByState, type SessionSummary } from "@/lib/sessionStorage";
import { loadRecentWorkspaces } from "@/lib/workspace";
import { removeSessionWorktree } from "@/lib/worktree";

/** What Rust measured of a worktree (`session_worktrees_measure`). */
export interface WorktreeUsage {
  path: string;
  exists: boolean;
  bytes: number;
  /** null when git couldn't say. */
  uncommitted: number | null;
}

/** A session's worktree that the cleanup in Settings can remove. */
export interface CleanupItem {
  sessionId: string;
  title: string;
  workspace: string;
  path: string;
  branch?: string;
  /** When the session was last used: its last message or change. */
  lastUsed: number;
  bytes: number;
  uncommitted: number | null;
}

export interface SessionWorktrees {
  items: CleanupItem[];
  /** Worktrees of sessions open or working now, left out of the list. */
  inUse: number;
}

/** The worktrees sessions left on this computer (remote projects' are on their machine), one per
 *  folder, with their size and uncommitted changes; those of sessions in use are only counted. */
export async function readSessionWorktrees(workspaces: (string | null)[] = loadRecentWorkspaces()): Promise<SessionWorktrees> {
  const { active, archived } = await listSessionsByState(workspaces);
  const byPath = new Map<string, SessionSummary>();
  for (const s of [...active, ...archived]) {
    const path = s.worktree?.path;
    if (!path || !s.workspace || isRemotePath(s.workspace) || isRemotePath(path)) continue;
    const seen = byPath.get(path);
    if (!seen || seen.modifiedAt < s.modifiedAt) byPath.set(path, s);
  }
  if (byPath.size === 0) return { items: [], inUse: 0 };
  const [usage, busy] = await Promise.all([
    invoke<WorktreeUsage[]>("session_worktrees_measure", { paths: [...byPath.keys()] }),
    sessionsWithBackgroundWork(),
  ]);
  const items: CleanupItem[] = [];
  let inUse = 0;
  for (const u of usage) {
    const s = byPath.get(u.path);
    if (!s || !u.exists) continue;
    if (sessionInUse(s.id) || busy.has(s.id)) {
      inUse++;
      continue;
    }
    items.push({
      sessionId: s.id,
      title: s.title,
      workspace: s.workspace!,
      path: u.path,
      branch: s.worktree?.branch,
      lastUsed: s.modifiedAt,
      bytes: u.bytes,
      uncommitted: u.uncommitted,
    });
  }
  items.sort((a, b) => a.lastUsed - b.lastUsed);
  return { items, inUse };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since a time (0 for today). */
export function daysSince(at: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - at) / DAY_MS));
}

/** The items unused for at least `days` days (all of them with 0). */
export function unusedFor(items: CleanupItem[], days: number, now = Date.now()): CleanupItem[] {
  return days <= 0 ? items : items.filter((i) => daysSince(i.lastUsed, now) >= days);
}

/** A size for people: "820 MB", "4,1 GB" in Spanish. */
export function formatBytes(bytes: number, lang: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const n = new Intl.NumberFormat(lang, { maximumFractionDigits: u >= 3 && v < 100 ? 1 : 0 }).format(v);
  return `${n} ${units[u]}`;
}

/** Removes the worktrees one after another (their branches stay), skipping a session that got
 *  opened or started working meanwhile. */
export async function removeWorktrees(
  items: CleanupItem[],
  onProgress?: (done: number) => void,
  remove: (workspace: string, path: string) => Promise<void> = (ws, p) => removeSessionWorktree(ws, p, true),
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  let done = 0;
  for (const item of items) {
    if (sessionInUse(item.sessionId)) failed.push(item.sessionId);
    else {
      try {
        await remove(item.workspace, item.path);
        removed.push(item.sessionId);
      } catch {
        failed.push(item.sessionId);
      }
    }
    onProgress?.(++done);
  }
  return { removed, failed };
}
