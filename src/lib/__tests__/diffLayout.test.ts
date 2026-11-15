import { describe, it, expect } from "vitest";
import type { DiffLine } from "@/lib/toolDetail";
import { diffWordMarks, foldDiff, pairLines, splitTokens, wordMarks } from "@/lib/diffLayout";

const ctx = (text: string): DiffLine => ({ type: "context", text });
const add = (text: string): DiffLine => ({ type: "add", text });
const del = (text: string): DiffLine => ({ type: "del", text });
const hunk: DiffLine = { type: "hunk", text: "⋯" };
const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ctx(`line ${from + i}`));

describe("pairLines", () => {
  it("pairs removed and added lines position by position", () => {
    expect(pairLines([ctx("a"), del("b"), del("c"), add("B"), add("C"), ctx("d")])).toEqual([[1, 3], [2, 4]]);
  });

  it("leaves the extra lines of the longer run unpaired", () => {
    expect(pairLines([del("a"), add("A"), add("new")])).toEqual([[0, 1]]);
    expect(pairLines([del("a"), del("gone"), add("A")])).toEqual([[0, 2]]);
  });

  it("doesn't pair a removal with additions after unchanged lines or a hunk", () => {
    expect(pairLines([del("a"), ctx("b"), add("c")])).toEqual([]);
    expect(pairLines([del("a"), hunk, add("c")])).toEqual([]);
    expect(pairLines([add("a"), del("b")])).toEqual([]);
  });
});

describe("wordMarks", () => {
  it("marks only the words that changed", () => {
    const oldText = "const foo = bar(1, 2);";
    const newText = "const foo = baz(1, 3);";
    const m = wordMarks(oldText, newText)!;
    expect(m.del.map(([a, b]) => oldText.slice(a, b))).toEqual(["bar", "2"]);
    expect(m.add.map(([a, b]) => newText.slice(a, b))).toEqual(["baz", "3"]);
  });

  it("still marks a line where a good part changed", () => {
    const oldText = "const total = price * quantity + shipping;";
    const newText = "const total = price * qty + shippingCost(order);";
    const m = wordMarks(oldText, newText)!;
    expect(m.del.map(([a, b]) => oldText.slice(a, b))).toEqual(["quantity", "shipping"]);
  });

  it("marks an insertion on the added line only", () => {
    const m = wordMarks("return x;", "return await x;")!;
    expect(m.del).toEqual([]);
    expect(m.add.length).toBeGreaterThan(0);
  });

  it("marks nothing when the lines are too different", () => {
    expect(wordMarks("import { a } from 'b';", "export default function render() {}")).toBeNull();
  });

  it("marks nothing for equal or blank lines", () => {
    expect(wordMarks("same", "same")).toBeNull();
    expect(wordMarks("", "  ")).toBeNull();
  });

  it("marks a change of indentation", () => {
    const m = wordMarks("foo();", "  foo();")!;
    expect(m.add).toEqual([[0, 2]]);
  });
});

describe("diffWordMarks", () => {
  it("indexes the marks by line, for both lines of a pair", () => {
    const marks = diffWordMarks([ctx("a"), del("let x = 1;"), add("let x = 2;"), add("extra()")]);
    expect([...marks.keys()].sort()).toEqual([1, 2]);
    expect(marks.get(1)).toEqual([[8, 9]]);
    expect(marks.get(2)).toEqual([[8, 9]]);
  });
});

describe("splitTokens", () => {
  it("cuts tokens at the edges of a mark", () => {
    const parts = splitTokens([{ text: "foobar", cls: "k" }, { text: "();", cls: "p" }], [[3, 7]]);
    expect(parts).toEqual([
      { text: "foo", cls: "k", marked: false },
      { text: "bar", cls: "k", marked: true },
      { text: "(", cls: "p", marked: true },
      { text: ");", cls: "p", marked: false },
    ]);
  });

  it("keeps the tokens as they are without marks", () => {
    expect(splitTokens([{ text: "a", cls: "x" }], [])).toEqual([{ text: "a", cls: "x", marked: false }]);
  });
});

describe("foldDiff", () => {
  const fold = (diff: DiffLine[]) => foldDiff(diff).filter((s) => s.kind === "fold");

  it("folds a long run between two changes, keeping 3 lines on each side", () => {
    const diff = [del("a"), ...many(12), add("b")];
    expect(foldDiff(diff)).toEqual([
      { kind: "lines", start: 0, end: 4 },
      { kind: "fold", start: 4, end: 10 },
      { kind: "lines", start: 10, end: 14 },
    ]);
  });

  it("keeps context only next to a change at the edges of the diff", () => {
    expect(fold([...many(10), add("x"), ...many(10)])).toEqual([
      { kind: "fold", start: 0, end: 7 },
      { kind: "fold", start: 14, end: 21 },
    ]);
  });

  it("treats a hunk marker as an edge", () => {
    expect(fold([add("x"), ...many(10), hunk, add("y")])).toEqual([{ kind: "fold", start: 4, end: 11 }]);
  });

  it("doesn't fold short runs", () => {
    expect(fold([del("a"), ...many(9), add("b")])).toEqual([]);
    expect(fold([...many(6), add("x")])).toEqual([]);
  });

  it("doesn't fold a diff without changes", () => {
    expect(foldDiff(many(20))).toEqual([{ kind: "lines", start: 0, end: 20 }]);
  });

  it("covers every line exactly once, so the numbering stays put", () => {
    const diff = [...many(9), del("a"), add("b"), ...many(15, 9), add("c"), ...many(8, 24)];
    const segs = foldDiff(diff);
    expect(segs[0].start).toBe(0);
    expect(segs.at(-1)!.end).toBe(diff.length);
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBe(segs[i - 1].end);
  });
});
