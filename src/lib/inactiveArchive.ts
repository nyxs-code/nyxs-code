import { autoArchivedIds, rememberAutoArchived } from "@/lib/prArchive";
import { setSessionArchived, type SessionSummary } from "@/lib/sessionStorage";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The choices of Settings › Nyxs Code › Archive inactive sessions, as Claude's (0: never). */
export const INACTIVE_DAY_OPTIONS = [0, 1, 2, 7, 14, 30] as const;

/** `sessions.archiveInactiveDays` from the settings: a whole number of days, 0 when off. */
export function inactiveDaysOf(settings: unknown): number {
  const v = (settings as { sessions?: { archiveInactiveDays?: unknown } })?.sessions?.archiveInactiveDays;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export interface InactiveArchiveOptions {
  days: number;
  now?: number;
  /** Open or working now: never archived. */
  inUse?: (id: string) => boolean;
  /** With a command still running in the background: never archived. */
  busy?: Set<string>;
  archive?: (workspace: string, id: string, at: number) => Promise<void>;
}

/** The sessions with no activity for `days` days, archived (like Claude's "Archive inactive
 *  sessions"). A session the user brought back after that stays back until it's used again. A
 *  worktree with uncommitted changes stays on disk: archived sessions' worktrees only go after
 *  30 days (useSessionWorktrees). */
export async function archiveInactiveSessions(
  sessions: SessionSummary[],
  opts: InactiveArchiveOptions,
): Promise<Array<{ id: string; workspace: string }>> {
  if (opts.days <= 0) return [];
  const now = opts.now ?? Date.now();
  const before = now - opts.days * DAY_MS;
  const earlier = autoArchivedIds();
  const archive = opts.archive ?? ((ws, id, at) => setSessionArchived(ws, id, true, at));
  const out: Array<{ id: string; workspace: string }> = [];
  for (const s of sessions) {
    if (!s.workspace || s.archived || s.modifiedAt > before) continue;
    if (opts.inUse?.(s.id) || opts.busy?.has(s.id)) continue;
    const at = earlier[s.id];
    if (at !== undefined && at >= s.modifiedAt) continue;
    try {
      await archive(s.workspace, s.id, now);
      rememberAutoArchived(s.id, now);
      out.push({ id: s.id, workspace: s.workspace });
    } catch {
      // Tried again on the next check.
    }
  }
  return out;
}
