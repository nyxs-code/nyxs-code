import { describe, expect, it } from "vitest";
import { indentLines, indentUnit, insideWorkspace, isViewOnlyConfig } from "@/lib/fileEditing";

describe("file editing", () => {
  it("keeps project configuration view-only", () => {
    expect(isViewOnlyConfig("D:\\p\\.mcp.json")).toBe(true);
    expect(isViewOnlyConfig("D:/p/.claude/settings.json")).toBe(true);
    expect(isViewOnlyConfig("D:/p/.claude/settings.local.json")).toBe(true);
    expect(isViewOnlyConfig("D:/p/.nyxs/settings.json")).toBe(true);
    expect(isViewOnlyConfig("D:/p/.claude/launch.json")).toBe(false);
    expect(isViewOnlyConfig("D:/p/src/settings.json")).toBe(false);
  });

  it("edits only inside the project", () => {
    expect(insideWorkspace("D:\\p\\src\\a.ts", "D:\\p")).toBe(true);
    expect(insideWorkspace("d:/p/a.ts", "D:\\p\\")).toBe(true);
    expect(insideWorkspace("D:\\pp\\a.ts", "D:\\p")).toBe(false);
    expect(insideWorkspace("D:\\p\\a.ts", null)).toBe(false);
  });

  it("guesses the file's indentation", () => {
    expect(indentUnit("a\n\tb\n\t\tc")).toBe("\t");
    expect(indentUnit("a\n  b\n    c\n  d")).toBe("  ");
    expect(indentUnit("a\n    b\n        c")).toBe("    ");
    expect(indentUnit("no indents")).toBe("  ");
  });

  it("indents and outdents the selected lines", () => {
    const text = "a\nb\nc";
    expect(indentLines(text, 0, 3, "  ", false)).toEqual({ text: "  a\n  b\nc", start: 2, end: 7 });
    expect(indentLines("  a\n  b\nc", 2, 7, "  ", true)).toEqual({ text: "a\nb\nc", start: 0, end: 3 });
    expect(indentLines("\tx", 1, 1, "\t", true).text).toBe("x");
  });
});
