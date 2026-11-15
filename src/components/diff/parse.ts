// ── Parsing ────────────────────────────────────────────────────────────────

export interface Row {
  type: "add" | "del" | "context";
  text: string;
  oldLn?: number;
  newLn?: number;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  rows: Row[];
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  hunks: Hunk[];
  binary?: boolean;
  /** Listed by `--numstat` but cut from the patch output, which is size-capped. */
  missing?: boolean;
}

/** Parses a normal `git diff` (3 lines of context). The unchanged lines between hunks are
 *  read from the file itself, only when someone unfolds them. */
export function parsePatch(raw: string): Map<string, Pick<DiffFile, "hunks" | "binary">> {
  const out = new Map<string, Pick<DiffFile, "hunks" | "binary">>();
  let cur: Pick<DiffFile, "hunks" | "binary"> | null = null;
  let hunk: Hunk | null = null;
  let oldLn = 0;
  let newLn = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = { hunks: [] };
      out.set(m ? m[2] : line.slice("diff --git ".length), cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (!hunk && line.startsWith("Binary files")) { cur.binary = true; continue; }
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      oldLn = m ? Number(m[1]) : 1;
      newLn = m ? Number(m[3]) : 1;
      hunk = {
        oldStart: oldLn,
        oldCount: m?.[2] !== undefined ? Number(m[2]) : 1,
        newStart: newLn,
        newCount: m?.[4] !== undefined ? Number(m[4]) : 1,
        rows: [],
      };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) hunk.rows.push({ type: "add", text: line.slice(1), newLn: newLn++ });
    else if (line.startsWith("-")) hunk.rows.push({ type: "del", text: line.slice(1), oldLn: oldLn++ });
    else if (line.startsWith(" ")) hunk.rows.push({ type: "context", text: line.slice(1), oldLn: oldLn++, newLn: newLn++ });
  }
  return out;
}

/** `git diff --numstat` lines: "added\tremoved\tpath" ("-" for binary). */
export function parseNumstat(raw: string): { path: string; added: number; removed: number; binary: boolean }[] {
  return raw
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 3)
    .map(([a, r, ...rest]) => {
      // Renames print "old => new"; the file to show is the new one.
      const path = rest.join("\t").replace(/^(.*)\{.* => (.*)\}(.*)$/, "$1$2$3").replace(/^.* => /, "");
      return { path, added: Number(a) || 0, removed: Number(r) || 0, binary: a === "-" };
    });
}

/** Folders before files at every level, then by name — the order the tree shows. */
export function comparePaths(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    const aDir = i < pa.length - 1;
    const bDir = i < pb.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return pa[i].localeCompare(pb[i], undefined, { sensitivity: "base" });
  }
  return pa.length - pb.length;
}
