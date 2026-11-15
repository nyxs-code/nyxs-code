import { useMemo, useState } from "react";
import { fileLines } from "./load";
import type { DiffFile, Row } from "./parse";

// ── Rendering helpers ──────────────────────────────────────────────────────

export type Segment =
  | { kind: "rows"; rows: Row[]; key: string }
  | { kind: "gap"; key: string; newFrom: number; oldFrom: number; count: number | null };

/** Hunks with the unchanged stretches between them as foldable gaps (count known), plus a
 *  trailing "show more" (count unknown until the file is read). */
export function segmentsOf(file: DiffFile): Segment[] {
  const segs: Segment[] = [];
  let newEnd = 0;
  let oldEnd = 0;
  file.hunks.forEach((h, i) => {
    const newFirst = h.newCount === 0 ? h.newStart + 1 : h.newStart;
    const gap = newFirst - 1 - newEnd;
    if (gap > 0) segs.push({ kind: "gap", key: `g${i}`, newFrom: newEnd + 1, oldFrom: oldEnd + 1, count: gap });
    segs.push({ kind: "rows", rows: h.rows, key: `h${i}` });
    newEnd = h.newCount === 0 ? h.newStart : h.newStart + h.newCount - 1;
    oldEnd = h.oldCount === 0 ? h.oldStart : h.oldStart + h.oldCount - 1;
  });
  const whole = file.hunks.length === 1 && (file.hunks[0].oldCount === 0 || file.hunks[0].newCount === 0);
  if (file.hunks.length && !whole) segs.push({ kind: "gap", key: "tail", newFrom: newEnd + 1, oldFrom: oldEnd + 1, count: null });
  return segs;
}

/** Unfolds gaps on click, reading the file once for the hidden lines. */
export function useExpansion(file: DiffFile, workspace: string) {
  const [lines, setLines] = useState<string[] | null | undefined>(undefined);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const segments = useMemo(() => segmentsOf(file), [file]);
  const expand = (key: string) => {
    setOpen((s) => new Set(s).add(key));
    if (lines === undefined) void fileLines(workspace, file.path).then(setLines);
  };
  const view: Segment[] = [];
  for (const seg of segments) {
    if (seg.kind !== "gap") { view.push(seg); continue; }
    if (lines) {
      const text = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
      const count = seg.count ?? Math.max(0, text.length - seg.newFrom + 1);
      if (count === 0) continue;
      if (open.has(seg.key)) {
        view.push({
          kind: "rows",
          key: seg.key,
          rows: text.slice(seg.newFrom - 1, seg.newFrom - 1 + count).map((t, i) => ({ type: "context", text: t, newLn: seg.newFrom + i, oldLn: seg.oldFrom + i })),
        });
        continue;
      }
      view.push({ ...seg, count });
    } else view.push(seg);
  }
  return { view, expand };
}
