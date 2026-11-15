import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHANGELOG } from "@/lib/changelog";
import { cardComment, cardFromNotes, cardProblems, sanitizeCard, type UpdateCardSpec } from "@/lib/updateCard";
import { SAMPLE_CARD } from "@/lib/updateCardSample";
import { parseNotes } from "@/lib/updateNotes";

const en = (s: string) => ({ "en-US": s });

describe("update card", () => {
  it("the changelog's cards and the sample are ready to ship", () => {
    expect(cardProblems(SAMPLE_CARD)).toEqual([]);
    for (const entry of CHANGELOG) {
      if (entry.card) expect(cardProblems(entry.card), entry.version).toEqual([]);
    }
  });

  it("draws what an older card format can't: unknown kinds and poses fall back", () => {
    const card = sanitizeCard({
      v: 1,
      slides: [
        { title: en("A"), desc: en("B"), scene: { kind: "hologram", frames: 3 } },
        { title: en("C"), desc: en("D"), scene: { kind: "mascot", steps: [{ pose: "dance" }] } },
        { title: en("no description"), scene: { kind: "icon", icon: "bot" } },
      ],
    });
    expect(card?.slides).toHaveLength(2);
    expect(card?.slides[0].scene).toEqual({ kind: "icon", icon: "sparkles" });
    expect(card?.slides[1].scene).toEqual({ kind: "mascot", steps: [{ pose: "rest" }] });
  });

  it("reports what the app would change, a missing language and a long text", () => {
    const card: UpdateCardSpec = { v: 1, slides: [{ title: en("x".repeat(40)), desc: en("ok"), scene: { kind: "icon", icon: "bot" } }] };
    const problems = cardProblems(card);
    expect(problems.some((p) => p.includes("missing es-ES"))).toBe(true);
    expect(problems.some((p) => p.includes("over 34"))).toBe(true);
    expect(cardProblems({ ...card, slides: [{ ...card.slides[0], scene: { kind: "icon", icon: "rocket" as never } }] })[0]).toMatch(/drop or replace/);
  });

  it("travels in the notes as a comment, even with -- in a text", () => {
    const card: UpdateCardSpec = { v: 1, slides: [{ title: en("--flag and -->"), desc: en("d"), scene: { kind: "terminal", lines: [{ kind: "cmd", text: "nyxs --help" }] } }] };
    const notes = `## What's New\n- Something\n\n${cardComment(card)}`;
    expect(notes.slice(notes.indexOf("<!--") + 4, notes.lastIndexOf("-->"))).not.toContain("--");
    expect(cardFromNotes(notes)).toEqual(card);
    expect(parseNotes(notes).highlights).toEqual([{ title: "Something", desc: "" }]);
    expect(cardFromNotes("## What's New\n- no card")).toBeNull();
    expect(cardFromNotes("<!-- nyxs-card {broken -->")).toBeNull();
  });

  it("scripts/release-notes.mjs appends the entry's card", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nyxs-notes-"));
    const file = path.join(dir, "changelog.ts");
    writeFileSync(
      file,
      `export const CHANGELOG: ChangelogEntry[] = [\n  ${JSON.stringify({ version: "9.9.9", date: "x", added: ["New thing"], card: SAMPLE_CARD })},\n];\n`,
    );
    const notes = execFileSync(process.execPath, ["scripts/release-notes.mjs", "9.9.9"], { env: { ...process.env, NYXS_CHANGELOG: file }, encoding: "utf8" });
    expect(notes.startsWith("## What's New\n- New thing")).toBe(true);
    expect(cardFromNotes(notes)).toEqual(SAMPLE_CARD);
  });
});
