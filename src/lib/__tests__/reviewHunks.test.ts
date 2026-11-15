import { describe, expect, it } from "vitest";
import { acceptHunk, computeHunks, diffStats, rejectHunk, splitLines } from "@/lib/review/hunks";

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join("");

function replaceLine(text: string, index: number, value: string): string {
  const all = splitLines(text);
  all[index] = value;
  return all.join("");
}

describe("splitLines", () => {
  it("keeps line terminators so joining is lossless", () => {
    for (const text of ["", "a", "a\n", "a\r\nb", "a\n\nb\n", "\n"]) {
      expect(splitLines(text).join("")).toBe(text);
    }
    expect(splitLines("a\r\nb")).toEqual(["a\r\n", "b"]);
  });
});

describe("computeHunks", () => {
  it("returns nothing for identical texts", () => {
    expect(computeHunks("same\n", "same\n")).toEqual([]);
  });

  it("splits distant changes into separate hunks with context", () => {
    const base = lines(30);
    const current = replaceLine(replaceLine(base, 2, "changed A\n"), 25, "changed B\n");
    const hunks = computeHunks(base, current);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 2, oldEnd: 3, newStart: 2, newEnd: 3, added: 1, removed: 1 });
    expect(hunks[0].lines.map((l) => l.type)).toEqual(["context", "context", "del", "add", "context", "context", "context"]);
    expect(hunks[0].lines.find((l) => l.type === "add")).toMatchObject({ text: "changed A", ln: 3 });
    expect(hunks[1]).toMatchObject({ oldStart: 25, newStart: 25 });
  });

  it("merges changes that are close together", () => {
    const base = lines(20);
    const current = replaceLine(replaceLine(base, 5, "x\n"), 10, "y\n");
    const hunks = computeHunks(base, current);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 5, oldEnd: 11, newStart: 5, newEnd: 11, added: 2, removed: 2 });
  });

  it("handles pure insertions and deletions", () => {
    const base = "a\nb\nc\n";
    const inserted = computeHunks(base, "a\nb\nnew\nc\n");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 3, added: 1, removed: 0 });
    const deleted = computeHunks(base, "a\nc\n");
    expect(deleted[0]).toMatchObject({ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 1, added: 0, removed: 1 });
  });

  it("treats a created file as one added hunk", () => {
    const hunks = computeHunks("", "one\ntwo\n");
    expect(hunks).toHaveLength(1);
    expect(diffStats(hunks)).toEqual({ added: 2, removed: 0 });
  });

  it("strips CRLF terminators for display only", () => {
    const hunks = computeHunks("a\r\nb\r\n", "a\r\nB\r\n");
    expect(hunks[0].lines.map((l) => l.text)).toEqual(["a", "b", "B"]);
  });
});

describe("accept / reject", () => {
  const base = lines(30);
  const current = replaceLine(replaceLine(base, 2, "changed A\n"), 25, "changed B\n");

  it("rejecting a hunk reverts only that region of the file", () => {
    const [first, second] = computeHunks(base, current);
    const afterReject = rejectHunk(base, current, first);
    expect(afterReject).toBe(replaceLine(base, 25, "changed B\n"));
    const remaining = computeHunks(base, afterReject);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].lines).toEqual(second.lines);
  });

  it("accepting a hunk folds it into the base", () => {
    const [first] = computeHunks(base, current);
    const newBase = acceptHunk(base, current, first);
    expect(newBase).toBe(replaceLine(base, 2, "changed A\n"));
    const remaining = computeHunks(newBase, current);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].oldStart).toBe(25);
  });

  it("accepting or rejecting every hunk converges", () => {
    let b = base;
    let c = current;
    for (const h of computeHunks(b, c).reverse()) c = rejectHunk(b, c, h);
    expect(c).toBe(base);
    b = base;
    c = current;
    for (const h of computeHunks(b, c).reverse()) b = acceptHunk(b, c, h);
    expect(b).toBe(current);
  });

  it("round-trips insertions, deletions and missing trailing newlines", () => {
    const cases: Array<[string, string]> = [
      ["a\nb\nc\n", "a\nb\nnew\nc\n"],
      ["a\nb\nc\n", "a\nc\n"],
      ["a\nb", "a\nb\nc\n"],
      ["", "x\ny"],
      ["x\ny\n", ""],
      ["a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\nd\r\n"],
    ];
    for (const [b, c] of cases) {
      const hunks = computeHunks(b, c);
      expect(hunks.length).toBeGreaterThan(0);
      let rejected = c;
      for (const h of [...hunks].reverse()) rejected = rejectHunk(b, rejected, h);
      expect(rejected).toBe(b);
      let accepted = b;
      for (const h of [...hunks].reverse()) accepted = acceptHunk(accepted, c, h);
      expect(accepted).toBe(c);
    }
  });
});
