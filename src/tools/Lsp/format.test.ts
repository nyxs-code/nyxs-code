import { describe, it, expect } from "vitest";
import { formatLspResult, uriToDisplayPath } from "./format";

const WS = "E:\\repo";

describe("uriToDisplayPath", () => {
  it("shows workspace files relative to the root, ignoring drive-letter case", () => {
    expect(uriToDisplayPath("file:///e%3A/repo/src/a%20b.ts", WS)).toBe("src/a b.ts");
    expect(uriToDisplayPath("file:///C:/lib/x.d.ts", WS)).toBe("C:/lib/x.d.ts");
  });
});

describe("formatLspResult", () => {
  it("lists definitions and references as path:line:col", () => {
    const loc = { uri: "file:///E:/repo/src/a.ts", range: { start: { line: 9, character: 2 }, end: { line: 9, character: 5 } } };
    expect(formatLspResult("references", [loc, loc], WS)).toBe("2 reference(s):\nsrc/a.ts:10:3\nsrc/a.ts:10:3");
    const link = { targetUri: "file:///E:/repo/b.ts", targetRange: loc.range, targetSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
    expect(formatLspResult("definition", [link], WS)).toBe("1 definition(s):\nb.ts:1:1");
  });

  it("renders hover markdown and marked strings", () => {
    expect(formatLspResult("hover", { contents: { kind: "markdown", value: "**fn** a()" } }, WS)).toBe("**fn** a()");
    expect(formatLspResult("hover", { contents: [{ language: "ts", value: "const a: number" }, "doc"] }, WS)).toBe(
      "```ts\nconst a: number\n```\n\ndoc",
    );
  });

  it("indents document symbols", () => {
    const r = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 1 } });
    const out = formatLspResult(
      "symbols",
      [{ name: "App", kind: 5, range: r(3), selectionRange: r(3), children: [{ name: "render", kind: 6, range: r(7), selectionRange: r(7) }] }],
      WS,
    );
    expect(out).toBe("App (class) line 4\n  render (method) line 8");
  });

  it("returns null for shapes it doesn't know so the caller can fall back to JSON", () => {
    expect(formatLspResult("references", [{ weird: true }], WS)).toBeNull();
    expect(formatLspResult("hover", { contents: 42 }, WS)).toBeNull();
  });
});
