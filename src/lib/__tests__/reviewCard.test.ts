import { describe, expect, it } from "vitest";
import { describeFinding, parseReviewReport } from "@/lib/reviewCard";

describe("parseReviewReport", () => {
  it("reads the findings, sorted high first, normalizing what the model writes loosely", () => {
    const r = parseReviewReport(JSON.stringify({
      verdict: "Fix these first",
      findings: [
        { severity: "low", file: "./src/b.ts", title: "Unused import" },
        { severity: "medium", file: "src\\a.ts", line: 12.7, title: "Missing await", detail: "The save races.", fix: "Await it." },
        { severity: "HIGH", file: "src/c.ts", line: 3, title: "Crash on null" },
        { severity: "weird", file: "src/d.ts", title: "Odd severity" },
        { severity: "high", title: "No file" },
      ],
    }));
    expect(r?.verdict).toBe("Fix these first");
    expect(r?.findings.map((f) => [f.severity, f.file, f.line])).toEqual([
      ["high", "src/c.ts", 3],
      ["med", "src/a.ts", 12],
      ["med", "src/d.ts", undefined],
      ["low", "src/b.ts", undefined],
    ]);
  });

  it("returns null for a block still streaming in, and an empty list for a clean review", () => {
    expect(parseReviewReport('{"verdict": "Safe to', )).toBeNull();
    expect(parseReviewReport('{"verdict": "Safe to commit", "findings": []}')).toEqual({ verdict: "Safe to commit", findings: [] });
  });

  it("describes a finding for a fix request", () => {
    const [f] = parseReviewReport(JSON.stringify({ verdict: "", findings: [{ severity: "high", file: "a.ts", line: 4, title: "Bug", detail: "Why.", fix: "Do X." }] }))!.findings;
    expect(describeFinding(f, "Fix:")).toBe("`a.ts:4` — Bug\nWhy.\nFix: Do X.");
  });
});
