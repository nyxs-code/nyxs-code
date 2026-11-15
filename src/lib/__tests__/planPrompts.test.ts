import { describe, expect, it } from "vitest";
import { applyPlanPrompt } from "@/lib/prompts/appActions";
import { buildSystemPromptCacheBlocks } from "@/lib/systemPrompt";

describe("the plan in the prompts", () => {
  it("sends the chat's plan with Apply plan, the chat still showing the short label", () => {
    const [message, shown] = applyPlanPrompt("1. Add the button\n2. Wire it");
    expect(message).toContain("1. Add the button\n2. Wire it");
    expect(message).not.toContain("plan.md");
    expect(shown).toBe("Apply plan");
  });

  it("points at the plan in the conversation when the chat kept none", () => {
    const [message] = applyPlanPrompt(undefined);
    expect(message).not.toContain("plan.md");
    expect(message).toMatch(/plan mode/);
  });

  it("doesn't tell the model in plan mode that its plan is saved to plan.md", () => {
    // Plan mode is a volatile section: it may go with the blocks or the reminders.
    const prompt = JSON.stringify(buildSystemPromptCacheBlocks({ workspace: "/ws", planMode: true }));
    expect(prompt).toContain("WritePlan");
    expect(prompt).not.toContain("plan.md");
  });
});
