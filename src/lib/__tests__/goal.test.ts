import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/components/Message";
import { goalTranscript, isClearGoal, parseVerdict } from "@/lib/goal";

const msg = (role: "user" | "assistant", content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: content, role, content, createdAt: 0, ...extra });

describe("a goal check's answer", () => {
  it("is read from the JSON, even with thinking or text around it", () => {
    expect(parseVerdict('{"met": true, "reason": "48 tests pass"}')).toEqual({ met: true, reason: "48 tests pass" });
    expect(parseVerdict('<think>hmm {"met": true}</think>Sure: {"met": false, "reason": "2 tests   fail"}')).toEqual({ met: false, reason: "2 tests fail" });
    expect(parseVerdict("yes it's done")).toBeNull();
    expect(parseVerdict('{"met": "yes"}')).toBeNull();
  });

  it("is cleared by clear, off or the user's own word", () => {
    expect(isClearGoal("clear")).toBe(true);
    expect(isClearGoal(" Borrar ")).toBe(true);
    expect(isClearGoal("clear the cache before the build")).toBe(false);
  });
});

describe("what the check reads", () => {
  it("is the turns since the user last wrote, with the end of what the tools printed", () => {
    const out = "x".repeat(2000) + "Tests: 46 passed, 2 failed";
    const messages = [
      msg("user", "first task"),
      msg("assistant", "done with the first"),
      msg("user", "/goal all payment tests pass"),
      msg("assistant", "Running the tests", { toolData: { t1: { name: "Bash", detail: "npm test", output: out } } }),
      msg("user", "<goal-check>not yet</goal-check>", { notice: { kind: "goal", items: [] } }),
      msg("assistant", "Fixed the refunds"),
    ];
    const text = goalTranscript(messages);
    expect(text).not.toContain("first task");
    expect(text).toContain("[User]: /goal all payment tests pass");
    expect(text).toContain("[Bash: npm test]");
    expect(text).toContain("Tests: 46 passed, 2 failed");
    expect(text).not.toContain("x".repeat(900));
    expect(text).toContain("Fixed the refunds");
  });
});
