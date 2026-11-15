import { useMemo } from "react";
import { wordRanges, type Ranges } from "@/lib/diffLayout";
import type { DiffFile, Row } from "./parse";

export type { Ranges };

/** Pairs each removed line with the added line in the same position of the next block. */
export function pairChanges(rows: Row[]): Map<Row, Ranges> {
  const ranges = new Map<Row, Ranges>();
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type !== "del") { i++; continue; }
    let j = i;
    while (j < rows.length && rows[j].type === "del") j++;
    let k = j;
    while (k < rows.length && rows[k].type === "add") k++;
    const pairs = Math.min(j - i, k - j);
    for (let p = 0; p < pairs; p++) {
      const r = wordRanges(rows[i + p].text, rows[j + p].text);
      // A line rewritten end to end is clearer without word marks.
      if (r.del.length + r.add.length > 0 && r.del.length < 12) {
        ranges.set(rows[i + p], r.del);
        ranges.set(rows[j + p], r.add);
      }
    }
    i = k;
  }
  return ranges;
}

export function useWordMarks(file: DiffFile, on: boolean): Map<Row, Ranges> {
  return useMemo(() => (on ? pairChanges(file.hunks.flatMap((h) => h.rows)) : new Map<Row, Ranges>()), [file, on]);
}
