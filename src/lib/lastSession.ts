/** One key per folder, whatever slashes it was written with; letter case only counts off Windows. */
function folderKey(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p;
}

/** The session "Continue last session" opens: the latest of the open folder. Recents also hold
 *  other projects' sessions, and one of those can't be opened from this folder. */
export function lastSessionOf<T extends { workspace?: string | null; modifiedAt: number }>(sessions: T[], workspace: string): T | undefined {
  const here = folderKey(workspace);
  let last: T | undefined;
  for (const s of sessions) {
    if (s.workspace && folderKey(s.workspace) !== here) continue;
    if (!last || s.modifiedAt > last.modifiedAt) last = s;
  }
  return last;
}
