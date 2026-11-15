import { isMergedPrLink } from "@/lib/prArchive";
import type { SessionSummary } from "@/lib/sessionStorage";
import type { SessionState } from "@/lib/sessionState";
import { workspaceName } from "@/lib/workspace";
import enUS from "@/locales/en-US";
import type { Translations } from "@/locales/types";

export type RecentsStatus = "active" | "archived" | "all";
export type RecentsActivity = "all" | "1d" | "3d" | "7d" | "30d";
export type RecentsSort = "recency" | "created" | "alphabetical";
export type RecentsGroupBy = "none" | "date" | "project" | "state" | "prStatus";

export interface RecentsFilter {
  status: RecentsStatus;
  project: string;
  activity: RecentsActivity;
  sort: RecentsSort;
  groupBy: RecentsGroupBy;
}

// Sessions are grouped under their project folder by default, so it's clear at a glance which
// project each one belongs to and where you're working.
export const DEFAULT_RECENTS_FILTER: RecentsFilter = {
  status: "active",
  project: "all",
  activity: "all",
  sort: "recency",
  groupBy: "project",
};

export function isRecentsFilterActive(f: RecentsFilter): boolean {
  return (
    f.status !== DEFAULT_RECENTS_FILTER.status ||
    f.project !== DEFAULT_RECENTS_FILTER.project ||
    f.activity !== DEFAULT_RECENTS_FILTER.activity ||
    f.sort !== DEFAULT_RECENTS_FILTER.sort ||
    f.groupBy !== DEFAULT_RECENTS_FILTER.groupBy
  );
}

const DAY = 24 * 60 * 60 * 1000;
function activityWindowMs(a: RecentsActivity): number {
  return a === "1d" ? DAY : a === "3d" ? 3 * DAY : a === "7d" ? 7 * DAY : a === "30d" ? 30 * DAY : Infinity;
}

export function recentsProjects(sessions: SessionSummary[]): string[] {
  const seen = new Set<string>();
  for (const s of sessions) if (s.workspace) seen.add(s.workspace);
  return [...seen].sort((a, b) => workspaceName(a).localeCompare(workspaceName(b)));
}

export interface RecentsGroup {
  key: string;
  label: string | null;
  items: SessionSummary[];
  /** The project folder, when grouped by project. */
  workspace?: string;
}

/** The group names, in the app's language. */
export type RecentsGroupLabels = Translations["recentsGroups"];

function groupOf(
  s: SessionSummary,
  by: RecentsGroupBy,
  now: number,
  labels: RecentsGroupLabels,
  states?: Record<string, SessionState>,
): { key: string; label: string; order: number } {
  if (by === "project") {
    return s.workspace
      ? { key: s.workspace, label: workspaceName(s.workspace), order: 0 }
      : { key: "__none__", label: labels.noFolder, order: 1 };
  }
  if (by === "date") {
    const age = now - s.modifiedAt;
    if (age < DAY) return { key: "today", label: labels.today, order: 0 };
    if (age < 2 * DAY) return { key: "yesterday", label: labels.yesterday, order: 1 };
    if (age < 7 * DAY) return { key: "7d", label: labels.previous7Days, order: 2 };
    if (age < 30 * DAY) return { key: "30d", label: labels.previous30Days, order: 3 };
    return { key: "older", label: labels.older, order: 4 };
  }
  if (by === "state") {
    const st = states?.[s.id];
    if (st === "blocked") return { key: "blocked", label: labels.blocked, order: 0 };
    if (st === "review") return { key: "review", label: labels.review, order: 1 };
    if (st === "completed") return { key: "completed", label: labels.done, order: 3 };
    return { key: "active", label: labels.active, order: 2 };
  }
  // An archived session is "merged / closed" only when it had a PR; archived by hand without
  // one, it has none.
  if (s.archived) {
    return s.prs?.length || s.prBranch
      ? { key: "merged", label: labels.mergedClosed, order: 1 }
      : { key: "nopr", label: labels.noPr, order: 2 };
  }
  if (s.prs?.length || (s.prBranch && s.prPushed && !isMergedPrLink(s.prBranch))) return { key: "open", label: labels.openPr, order: 0 };
  return { key: "nopr", label: labels.noPr, order: 2 };
}

/** `projects` are the folders the user works in: grouped by project, each one shows even before
 *  it has a session (unless other filters narrow the list down). */
export function buildRecentsGroups(
  active: SessionSummary[],
  archived: SessionSummary[],
  filter: RecentsFilter,
  now: number,
  states?: Record<string, SessionState>,
  projects: string[] = [],
  labels: RecentsGroupLabels = enUS.recentsGroups,
): RecentsGroup[] {
  let pool: SessionSummary[] =
    filter.status === "active" ? active : filter.status === "archived" ? archived : [...active, ...archived];

  if (filter.project !== "all") pool = pool.filter((s) => s.workspace === filter.project);

  const win = activityWindowMs(filter.activity);
  if (win !== Infinity) pool = pool.filter((s) => now - s.modifiedAt <= win);

  const sorted = [...pool].sort((a, b) => {
    switch (filter.sort) {
      case "alphabetical":
        return (a.title || "").localeCompare(b.title || "");
      case "created":
        return b.createdAt - a.createdAt;
      case "recency":
      default:
        return b.modifiedAt - a.modifiedAt;
    }
  });

  if (filter.groupBy === "none") {
    return [{ key: "all", label: null, items: sorted }];
  }

  if (filter.groupBy === "project") {
    const groups = new Map<string, RecentsGroup & { last: number }>();
    const add = (ws: string | undefined) => {
      const key = ws ?? "__none__";
      let g = groups.get(key);
      if (!g) {
        g = { key, label: ws ? workspaceName(ws) : labels.noFolder, items: [], workspace: ws, last: 0 };
        groups.set(key, g);
      }
      return g;
    };
    for (const s of sorted) {
      const g = add(s.workspace);
      g.items.push(s);
      g.last = Math.max(g.last, s.modifiedAt);
    }
    const narrowed = filter.status !== "active" || filter.project !== "all" || filter.activity !== "all";
    if (!narrowed) for (const ws of projects) add(ws);
    // Most recently used project first; folders without sessions at the end, by name.
    return [...groups.values()]
      .sort((a, b) => Number(!a.workspace) - Number(!b.workspace) || b.last - a.last || (a.label ?? "").localeCompare(b.label ?? ""))
      .map(({ last: _last, ...g }) => g);
  }

  const groups = new Map<string, RecentsGroup & { order: number }>();
  for (const s of sorted) {
    const g = groupOf(s, filter.groupBy, now, labels, states);
    if (!groups.has(g.key)) groups.set(g.key, { key: g.key, label: g.label, items: [], order: g.order });
    groups.get(g.key)!.items.push(s);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || (a.label ?? "").localeCompare(b.label ?? ""));
}
