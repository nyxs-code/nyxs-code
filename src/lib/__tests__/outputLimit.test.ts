import { describe, it, expect, vi } from "vitest";
import type { ModelMessage } from "ai";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const { buildOutputLimitRetryPrompt, withoutThoughtOnlyTail, OUTPUT_LIMIT_REASONING_TAIL } = await import("@/lib/turnSupport");

describe("buildOutputLimitRetryPrompt", () => {
  it("asks to act and carries only the end of a long reasoning", () => {
    const reasoning = `START ${"x".repeat(OUTPUT_LIMIT_REASONING_TAIL)} END`;
    const prompt = buildOutputLimitRetryPrompt(reasoning);
    expect(prompt).toContain("act now");
    expect(prompt).toContain("END\n</previous_reasoning>");
    expect(prompt).not.toContain("START");
  });

  it("leaves the reasoning block out when nothing was thought", () => {
    expect(buildOutputLimitRetryPrompt("  ")).not.toContain("previous_reasoning");
  });
});

describe("withoutThoughtOnlyTail", () => {
  const user: ModelMessage = { role: "user", content: "go" };
  const tool: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "Read", output: { type: "text", value: "x" } }] };

  it("drops a last assistant message with only reasoning or blank text", () => {
    const thought: ModelMessage = { role: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: " " }] };
    expect(withoutThoughtOnlyTail([user, tool, thought])).toEqual([user, tool]);
    expect(withoutThoughtOnlyTail([user, { role: "assistant", content: "" }])).toEqual([user]);
  });

  it("keeps a last step that wrote text or called a tool", () => {
    const wrote: ModelMessage = { role: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "Partial" }] };
    const called: ModelMessage = { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "Read", input: {} }] };
    expect(withoutThoughtOnlyTail([user, wrote])).toHaveLength(2);
    expect(withoutThoughtOnlyTail([user, called])).toHaveLength(2);
    expect(withoutThoughtOnlyTail([user, tool])).toHaveLength(2);
  });
});
