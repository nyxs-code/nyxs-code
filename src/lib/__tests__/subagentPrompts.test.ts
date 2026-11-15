import { describe, expect, it } from "vitest";
import { buildSubagentSystemPrompt, MAX_SUBAGENT_INSTRUCTIONS_CHARS } from "@/lib/subagentPrompts";

describe("buildSubagentSystemPrompt", () => {
  it("adds the project's instructions, the date and the user's language when the parent has them", () => {
    const s = buildSubagentSystemPrompt("/ws", false, 50, { projectInstructions: "Use tabs.", date: "2026-11-10", language: "Portuguese" });
    expect(s).toContain("# Project instructions");
    expect(s).toContain("Use tabs.");
    expect(s).toContain("Today's date is 2026-11-10");
    expect(s).toContain("The user writes in Portuguese");
  });

  it("cuts instructions past the cap and says so", () => {
    const long = "rule ".repeat(MAX_SUBAGENT_INSTRUCTIONS_CHARS);
    const s = buildSubagentSystemPrompt("/ws", true, 50, { projectInstructions: long });
    expect(s.length).toBeLessThan(MAX_SUBAGENT_INSTRUCTIONS_CHARS + 6_000);
    expect(s).toContain("cut short");
  });

  it("leaves the sections out when there is nothing to say", () => {
    const s = buildSubagentSystemPrompt("/ws", false, 50, { projectInstructions: "  ", language: null });
    expect(s).not.toContain("# Project instructions");
    expect(s).not.toContain("The user writes in");
    expect(s).toContain("Respond in the user's language.");
  });
});
