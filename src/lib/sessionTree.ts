/** Sessions an agent started (CreateSession) are listed under the session that started them, as
 *  in Claude Code Desktop. */

export interface TreeRow<T> {
  item: T;
  /** 0 for a top-level session, 1 for one nested under it, and so on. */
  depth: number;
  /** How many sessions sit under this one, at any depth. */
  descendants: number;
  /** The last of its parent's sessions: the line joining them ends at this row. */
  last: boolean;
}

/** Orders `items` so each session follows its parent, children in their own order, as long as
 *  the parent is in the same list; otherwise a session stays where it is, at the top level.
 *  Sessions under a parent in `folded` are left out. */
export function nestSessions<T extends { id: string; parentId?: string }>(items: T[], folded: ReadonlySet<string> = new Set()): TreeRow<T>[] {
  const present = new Set(items.map((s) => s.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const s of items) {
    const parent = s.parentId && s.parentId !== s.id && present.has(s.parentId) ? s.parentId : null;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), s]);
    else roots.push(s);
  }
  const count = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    return (children.get(id) ?? []).reduce((n, c) => n + 1 + count(c.id, seen), 0);
  };
  const out: TreeRow<T>[] = [];
  const placed = new Set<string>();
  const walk = (s: T, depth: number, last: boolean) => {
    if (placed.has(s.id)) return;
    placed.add(s.id);
    out.push({ item: s, depth, descendants: count(s.id, new Set()), last });
    if (folded.has(s.id)) return;
    const kids = (children.get(s.id) ?? []).filter((c) => !placed.has(c.id));
    kids.forEach((c, i) => walk(c, depth + 1, i === kids.length - 1));
  };
  for (const r of roots) walk(r, 0, true);
  // A loop of parents (a → b → a) has no root: list what is left at the top level.
  for (const s of items) if (!placed.has(s.id) && !isUnderFolded(s, items, folded)) walk(s, 0, true);
  return out;
}

function isUnderFolded<T extends { id: string; parentId?: string }>(s: T, items: T[], folded: ReadonlySet<string>): boolean {
  return !!s.parentId && folded.has(s.parentId) && items.some((p) => p.id === s.parentId);
}

/** What deleting the Recents row `id` removes: a saved session (active or archived, as Recents
 *  lists both) with how many sessions sit under it, or else an unsaved chat. */
export function deleteTargetOf(
  id: string,
  saved: { id: string; title: string; parentId?: string }[],
  chats: { id: string; title: string }[],
): { id: string; title: string; isSession: boolean; nested: number } {
  const session = saved.find((s) => s.id === id);
  if (session) return { id, title: session.title, isSession: true, nested: descendantsOf(id, saved).length };
  return { id, title: chats.find((c) => c.id === id)?.title ?? "", isSession: false, nested: 0 };
}

/** The sessions under `id`, at any depth. */
export function descendantsOf<T extends { id: string; parentId?: string }>(id: string, items: T[]): T[] {
  const out: T[] = [];
  const seen = new Set([id]);
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const s of items) {
      if (s.parentId && frontier.includes(s.parentId) && !seen.has(s.id)) {
        seen.add(s.id);
        out.push(s);
        next.push(s.id);
      }
    }
    frontier = next;
  }
  return out;
}
