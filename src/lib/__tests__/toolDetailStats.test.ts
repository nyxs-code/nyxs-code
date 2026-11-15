import { describe, it, expect } from "vitest";
import { buildToolDetail } from "@/lib/agentTools";
import { diffFromStructuredPatch, diffStatsOf, editStatsOfResult } from "@/lib/toolDetail";

describe("edit line counts", () => {
  it("does not count the context lines the model quotes as changed", async () => {
    const d = await buildToolDetail("Edit", {
      file_path: "a.ts",
      old_string: "keep\nold 1\nold 2\nold 3\n",
      new_string: "keep\nnew 1\nnew 2\nnew 3\n",
    });
    expect({ added: d.added, removed: d.removed }).toEqual({ added: 3, removed: 3 });
  });

  it("counts a pure insertion as additions only", async () => {
    const d = await buildToolDetail("Edit", { file_path: "a.ts", old_string: "a\nb", new_string: "a\nx\ny\nb" });
    expect({ added: d.added, removed: d.removed }).toEqual({ added: 2, removed: 0 });
  });

  it("reads Claude Code's structuredPatch", () => {
    const diff = diffFromStructuredPatch([{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [" a", "-b", "+c", "+d", " e"] }]);
    expect(diff && diffStatsOf(diff)).toEqual({ added: 2, removed: 1 });
    expect(diff?.[2]).toEqual({ type: "add", text: "c", ln: 11 });
    // A context line below the change sits one line lower in the new file.
    expect(diff?.[4]).toEqual({ type: "context", text: "e", ln: 12, newLn: 13 });
  });

  it("reads a file edit's counts from Claude Code's tool_use_result", () => {
    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-a", "+b", "+c"] }];
    expect(editStatsOfResult({ filePath: "C:/ws/a.md", oldString: "a", newString: "b\nc", structuredPatch: patch })).toEqual({ path: "C:/ws/a.md", added: 2, removed: 1 });
    expect(editStatsOfResult({ type: "create", filePath: "C:/ws/new.py", content: "x = 1\ny = 2\n", structuredPatch: [] })).toEqual({ path: "C:/ws/new.py", added: 2, removed: 0 });
    expect(editStatsOfResult({ type: "update", filePath: "C:/ws/same.md", content: "s", structuredPatch: [] })).toEqual({ path: "C:/ws/same.md", added: 0, removed: 0 });
    expect(editStatsOfResult("Error: file not found")).toBeNull();
    expect(editStatsOfResult({ stdout: "ok" })).toBeNull();
  });

  it("ignores an empty structuredPatch", () => {
    expect(diffFromStructuredPatch([])).toBeNull();
    expect(diffFromStructuredPatch(undefined)).toBeNull();
  });
});
