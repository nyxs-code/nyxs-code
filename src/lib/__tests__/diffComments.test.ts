// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { VISUAL_PROMPT_EVENT } from "@/lib/visualBridge";
import { addDiffComment, diffComments, formatDiffReview, removeDiffComment, sendDiffReview, updateDiffComment } from "@/lib/diffComments";

const labels = { intro: "Comments on the changes:", removedLine: "(removed line)" };

describe("diff comments", () => {
  it("formats every comment with its file, line and code, in file and line order", () => {
    const text = formatDiffReview(
      [
        { id: "2", path: "src/b.ts", side: "new", line: 3, code: "  return x;", text: "Return early instead." },
        { id: "1", path: "src/a.ts", side: "old", line: 10, code: "legacy()", text: "Why remove this?" },
        { id: "3", path: "src/b.ts", side: "new", line: 1, code: "", text: "Rename the file." },
      ],
      labels,
    );
    expect(text).toBe(
      "Comments on the changes:\n\n" +
        "`src/a.ts:10` (removed line)\n> legacy()\nWhy remove this?\n\n" +
        "`src/b.ts:1`\nRename the file.\n\n" +
        "`src/b.ts:3`\n> return x;\nReturn early instead.",
    );
  });

  it("keeps comments per project, edits and removes them, and sends them all at once", () => {
    addDiffComment("D:\\p", { path: "a.ts", side: "new", line: 1, code: "x", text: "one" });
    addDiffComment("D:\\p", { path: "a.ts", side: "new", line: 2, code: "y", text: "two" });
    addDiffComment("D:\\q", { path: "b.ts", side: "new", line: 1, code: "z", text: "other project" });
    const [first, second] = diffComments("D:\\p");
    updateDiffComment("D:\\p", first.id, "one, edited");
    removeDiffComment("D:\\p", second.id);
    expect(diffComments("D:\\p").map((c) => c.text)).toEqual(["one, edited"]);

    const sent: string[] = [];
    const on = (e: Event) => sent.push((e as CustomEvent<string>).detail);
    window.addEventListener(VISUAL_PROMPT_EVENT, on);
    expect(sendDiffReview("D:\\p", labels)).toBe(true);
    expect(sendDiffReview("D:\\p", labels)).toBe(false);
    window.removeEventListener(VISUAL_PROMPT_EVENT, on);
    expect(sent).toEqual(["Comments on the changes:\n\n`a.ts:1`\n> x\none, edited"]);
    expect(diffComments("D:\\p")).toEqual([]);
    expect(diffComments("D:\\q")).toHaveLength(1);
  });
});
