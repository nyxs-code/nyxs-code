import { diffWordsWithSpace } from "diff";
import type { Token } from "@/lib/highlight";
import type { DiffLine } from "@/lib/toolDetail";

/** Half-open character ranges `[start, end)` within a line. */
export type Ranges = [number, number][];

/** Character ranges that changed between a removed line and the added line paired with it. */
export function wordRanges(oldText: string, newText: string): { del: Ranges; add: Ranges } {
  const del: Ranges = [];
  const add: Ranges = [];
  let o = 0;
  let n = 0;
  for (const part of diffWordsWithSpace(oldText, newText)) {
    const len = part.value.length;
    if (part.removed) { del.push([o, o + len]); o += len; }
    else if (part.added) { add.push([n, n + len]); n += len; }
    else { o += len; n += len; }
  }
  return { del, add };
}

/** Pairs each run of removed lines with the run of added lines right after it, line by line:
 *  `[delIndex, addIndex]` into `diff`. The extra lines of the longer run stay unpaired. */
export function pairLines(diff: DiffLine[]): [number, number][] {
  const pairs: [number, number][] = [];
  let i = 0;
  while (i < diff.length) {
    if (diff[i].type !== "del") { i++; continue; }
    let j = i;
    while (j < diff.length && diff[j].type === "del") j++;
    let k = j;
    while (k < diff.length && diff[k].type === "add") k++;
    for (let p = 0; p < Math.min(j - i, k - j); p++) pairs.push([i + p, j + p]);
    i = k;
  }
  return pairs;
}

const nonSpace = (s: string) => s.replace(/\s+/g, "").length;

/** Below this share of unchanged characters (over both lines) a pair reads as a rewrite: marking
 *  it would cover most of both lines, which says less than the line colors alone. */
export const MIN_SHARED = 0.4;

/** The words that changed in a modified line, or null when there is nothing worth marking: the
 *  lines are equal or too different. Whitespace doesn't count towards how alike they are. */
export function wordMarks(oldText: string, newText: string): { del: Ranges; add: Ranges } | null {
  const total = nonSpace(oldText) + nonSpace(newText);
  if (!total) return null;
  const { del, add } = wordRanges(oldText, newText);
  if (!del.length && !add.length) return null;
  const shared = del.reduce((n, [a, b]) => n - nonSpace(oldText.slice(a, b)), nonSpace(oldText));
  if ((2 * shared) / total < MIN_SHARED) return null;
  return { del, add };
}

/** The word marks of every modified line in a diff, by the line's index. */
export function diffWordMarks(diff: DiffLine[]): Map<number, Ranges> {
  const marks = new Map<number, Ranges>();
  for (const [d, a] of pairLines(diff)) {
    const m = wordMarks(diff[d].text, diff[a].text);
    if (!m) continue;
    marks.set(d, m.del);
    marks.set(a, m.add);
  }
  return marks;
}

/** Cuts highlighted tokens where marks start and end, so a mark can sit on part of a token. */
export function splitTokens(tokens: Token[], marks: Ranges): (Token & { marked: boolean })[] {
  const out: (Token & { marked: boolean })[] = [];
  let pos = 0;
  for (const t of tokens) {
    const start = pos;
    const end = pos + t.text.length;
    pos = end;
    const cuts = new Set([start, end]);
    for (const [a, b] of marks) {
      if (a > start && a < end) cuts.add(a);
      if (b > start && b < end) cuts.add(b);
    }
    const points = [...cuts].sort((x, y) => x - y);
    for (let p = 0; p < points.length - 1; p++) {
      const a = points[p];
      const b = points[p + 1];
      out.push({ text: t.text.slice(a - start, b - start), cls: t.cls, marked: marks.some(([m0, m1]) => a >= m0 && b <= m1) });
    }
  }
  return out;
}

/** Unchanged lines kept on each side of a change when the rest of the run folds. */
export const FOLD_CONTEXT = 3;
/** Fewer hidden lines than this aren't worth a row that has to be opened. */
export const MIN_FOLDED = 4;

/** A stretch of `diff` from `start` to `end` (exclusive), shown or folded into one row. */
export type DiffSegment = { kind: "lines" | "fold"; start: number; end: number };

/** Splits a diff into shown stretches and folded runs of unchanged lines. A run keeps
 *  `FOLD_CONTEXT` lines next to each change; at the edges of the diff or a hunk there is no
 *  change to keep context for. A diff without changes doesn't fold. */
export function foldDiff(diff: DiffLine[], context = FOLD_CONTEXT, minFolded = MIN_FOLDED): DiffSegment[] {
  const isChange = (l: DiffLine | undefined) => l?.type === "add" || l?.type === "del";
  const folds: [number, number][] = [];
  if (diff.some(isChange)) {
    let i = 0;
    while (i < diff.length) {
      if (diff[i].type !== "context") { i++; continue; }
      let j = i;
      while (j < diff.length && diff[j].type === "context") j++;
      const from = isChange(diff[i - 1]) ? i + context : i;
      const to = isChange(diff[j]) ? j - context : j;
      if (to - from >= minFolded) folds.push([from, to]);
      i = j;
    }
  }
  const out: DiffSegment[] = [];
  let at = 0;
  for (const [from, to] of folds) {
    if (from > at) out.push({ kind: "lines", start: at, end: from });
    out.push({ kind: "fold", start: from, end: to });
    at = to;
  }
  if (at < diff.length) out.push({ kind: "lines", start: at, end: diff.length });
  return out;
}
