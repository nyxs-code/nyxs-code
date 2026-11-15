import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ cmd: string; args: Record<string, unknown> }>);
vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return cmd === "plan_write" ? "/data/projects/ws/plans/chat-1.md" : null;
  }),
}));

const { createWritePlanTool } = await import("@/tools/WritePlan/tool");

describe("WritePlan", () => {
  it("keeps the plan in the project's data folder, per session, not as plan.md in the project", async () => {
    const tool = createWritePlanTool({ workspace: "/ws", sessionKey: "chat-1" } as never);
    const out = await tool.execute!({ plan: "1. Do it" }, { toolCallId: "p", messages: [] });
    expect(calls).toEqual([{ cmd: "plan_write", args: { workspace: "/ws", session: "chat-1", content: "1. Do it" } }]);
    expect(String(out)).toContain("Plan view");
    expect(String(out)).not.toContain("plan.md");
  });
});
