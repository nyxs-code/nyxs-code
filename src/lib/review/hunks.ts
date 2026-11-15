import { diffLines } from "diff";
import type { DiffLine } from "@/lib/agentTools";

export interface ReviewHunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  added: number;
  removed: number;
  lines: DiffLine[];
}

interface Op {
  type: "add" | "del" | "context";
  oldIdx: number;
  newIdx: number;
  text: string;
}

export const REVIEW_CONTEXT_LINES = 3;

export function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

function stripEol(line: string): string {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  if (line.endsWith("\n")) return line.slice(0, -1);
  return line;
}

function toOps(base: string, current: string): Op[] {
  const ops: Op[] = [];
  let o = 0;
  let n = 0;
  for (const change of diffLines(base, current)) {
    for (const text of splitLines(change.value)) {
      if (change.added) ops.push({ type: "add", oldIdx: o, newIdx: n++, text });
      else if (change.removed) ops.push({ type: "del", oldIdx: o++, newIdx: n, text });
      else ops.push({ type: "context", oldIdx: o++, newIdx: n++, text });
    }
  }
  return ops;
}

function toDiffLine(op: Op): DiffLine {
  if (op.type === "del") return { type: "del", text: stripEol(op.text), ln: op.oldIdx + 1 };
  return { type: op.type, text: stripEol(op.text), ln: op.newIdx + 1 };
}

export function computeHunks(base: string, current: string, context = REVIEW_CONTEXT_LINES): ReviewHunk[] {
  if (base === current) return [];
  const ops = toOps(base, current);
  const hunks: ReviewHunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === "context") {
      i++;
      continue;
    }
    const first = i;
    let last = i;
    let j = i + 1;
    while (j < ops.length) {
      if (ops[j].type !== "context") {
        last = j++;
        continue;
      }
      let k = j;
      while (k < ops.length && ops[k].type === "context") k++;
      if (k < ops.length && k - j <= context * 2) {
        j = k;
        continue;
      }
      break;
    }
    const span = ops.slice(first, last + 1);
    const added = span.filter((op) => op.type === "add").length;
    const removed = span.filter((op) => op.type === "del").length;
    const shared = span.length - added - removed;
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length, last + 1 + context);
    hunks.push({
      oldStart: ops[first].oldIdx,
      oldEnd: ops[first].oldIdx + removed + shared,
      newStart: ops[first].newIdx,
      newEnd: ops[first].newIdx + added + shared,
      added,
      removed,
      lines: ops.slice(from, to).map(toDiffLine),
    });
    i = last + 1;
  }
  return hunks;
}

export function hunkKey(hunk: ReviewHunk): string {
  const body = hunk.lines.map((l) => `${l.type[0]}${l.text}`).join("\n");
  return `${hunk.oldStart}:${hunk.oldEnd}:${hunk.newStart}:${hunk.newEnd}\n${body}`;
}

export function acceptHunk(base: string, current: string, hunk: ReviewHunk): string {
  const b = splitLines(base);
  const c = splitLines(current);
  return [...b.slice(0, hunk.oldStart), ...c.slice(hunk.newStart, hunk.newEnd), ...b.slice(hunk.oldEnd)].join("");
}

export function rejectHunk(base: string, current: string, hunk: ReviewHunk): string {
  const b = splitLines(base);
  const c = splitLines(current);
  return [...c.slice(0, hunk.newStart), ...b.slice(hunk.oldStart, hunk.oldEnd), ...c.slice(hunk.newEnd)].join("");
}

export function diffStats(hunks: ReviewHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    added += h.added;
    removed += h.removed;
  }
  return { added, removed };
}
