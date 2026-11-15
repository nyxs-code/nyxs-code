import { describe, it, expect } from "vitest";
import { ansiRuns, stripAnsi } from "@/lib/ansi";

describe("stripAnsi", () => {
  it("removes the color codes Vite prints", () => {
    const vite = "  \x1b[32m\x1b[1mVITE\x1b[22m v8.2.2\x1b[39m  \x1b[2mready in \x1b[0m\x1b[1m900\x1b[22m\x1b[2m\x1b[0m ms\x1b[22m";
    expect(stripAnsi(vite)).toBe("  VITE v8.2.2  ready in 900 ms");
    expect(stripAnsi("\x1b[36mhttp://localhost:\x1b[1m5174\x1b[22m/\x1b[39m")).toBe("http://localhost:5174/");
  });

  it("removes hyperlinks and cursor moves but keeps the text", () => {
    expect(stripAnsi("\x1b]8;;https://x.dev\x07link\x1b]8;;\x07")).toBe("link");
    expect(stripAnsi("a\x1b[2Kb\x1b[1Ac")).toBe("abc");
  });

  it("leaves plain text alone", () => {
    expect(stripAnsi("ñandú [32m] ok")).toBe("ñandú [32m] ok");
  });
});

describe("ansiRuns", () => {
  it("keeps colors and bold as styled runs", () => {
    expect(ansiRuns(" \x1b[32m✓\x1b[39m ok \x1b[1m\x1b[32m59 passed\x1b[39m\x1b[22m (59)")).toEqual([
      { text: " " },
      { text: "✓", color: "green" },
      { text: " ok " },
      { text: "59 passed", bold: true, color: "green" },
      { text: " (59)" },
    ]);
  });

  it("resets on 0, maps bright and black/white to the theme-safe palette", () => {
    expect(ansiRuns("\x1b[91ma\x1b[0mb\x1b[30mc\x1b[97md")).toEqual([
      { text: "a", color: "red" },
      { text: "b" },
      { text: "cd", color: "gray" },
    ]);
  });

  it("skips 256-color arguments and drops non-color escapes", () => {
    expect(ansiRuns("\x1b[38;5;196;1mx\x1b[2Ky")).toEqual([{ text: "xy", bold: true }]);
    expect(ansiRuns("\x1b[38;2;1;2;3mz")).toEqual([{ text: "z" }]);
  });

  it("keeps only the last redraw of a \\r progress line", () => {
    expect(ansiRuns("10%\r50%\r100%\r\ndone")).toEqual([{ text: "100%\ndone" }]);
  });
});
