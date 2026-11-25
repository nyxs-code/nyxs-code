import { describe, expect, it, vi } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import type { Chat } from "@/lib/chatStore";
import type { AssistantTurn } from "@/lib/assistantTurn";

vi.mock("@/lib/models", () => ({
  getModel: (id: string) => (id === "m" ? { id: "m", provider: "deepseek" } : id === "cli" ? { id: "cli", provider: "codex" } : undefined),
  PROVIDERS: {},
}));
const asked = vi.hoisted(() => [] as { modelId: string; prompt: string; effort?: string }[]);
vi.mock("@/lib/ai", () => ({
  askModelOnce: async (modelId: string, _s: unknown, prompt: string, opts?: { effort?: string }) => {
    asked.push({ modelId, prompt, effort: opts?.effort });
    return '{"met": false, "reason": "2 tests fail"}';
  },
}));
vi.mock("@/lib/settings", () => ({ hasKey: () => true }));

const { goalTurnEnded, judgeGoal, setPendingGoal, takePendingGoal } = await import("@/lib/goalMode");
const { MAX_GOAL_TURNS, newGoal, goalKickoff } = await import("@/lib/goal");

function setup(chat: Partial<Chat>, verdict: { met: boolean; reason: string } | null, opts: { queued?: boolean } = {}) {
  let chats: Chat[] = [{ id: "c", title: "t", messages: [], model: "m", workspace: "D:/p", ...chat }];
  const setChats: Dispatch<SetStateAction<Chat[]>> = (next) => {
    chats = typeof next === "function" ? next(chats) : next;
  };
  const turns: AssistantTurn[] = [];
  const env = {
    settings: {} as never,
    effectiveModel: "m",
    workspace: "D:/p",
    liveChat: (id: string) => chats.find((c) => c.id === id),
    setChats,
    turnRunning: () => false,
    queued: () => opts.queued ?? false,
    buildChatHistory: async () => ({ history: [], compaction: { upTo: 0, hadSummary: false } }),
    streamTurn: async (t: AssistantTurn) => {
      turns.push(t);
    },
    judge: vi.fn(async () => verdict),
  };
  return { env, turns, chat: () => chats[0] };
}

describe("the goal loop", () => {
  it("gives the agent another turn while the goal isn't met, with a notice saying why", async () => {
    const { env, turns, chat } = setup({ goal: newGoal("payment tests pass") }, { met: false, reason: "2 refund tests fail" });
    await goalTurnEnded("c", "done", env);
    expect(chat().goal).toMatchObject({ status: "active", turns: 1, lastReason: "2 refund tests fail" });
    const notice = chat().messages.at(-1)!;
    expect(notice.notice).toMatchObject({ kind: "goal", goal: { state: "notMet", turns: 1, reason: "2 refund tests fail" } });
    expect(turns).toHaveLength(1);
    expect(turns[0].history.at(-1)?.content).toContain("2 refund tests fail");
    expect(turns[0].snapshotId).toBe(notice.id);
  });

  it("stops and says so once the goal is met", async () => {
    const { env, turns, chat } = setup({ goal: { ...newGoal("build passes"), turns: 3 } }, { met: true, reason: "the build succeeded" });
    await goalTurnEnded("c", "done", env);
    expect(chat().goal).toMatchObject({ status: "met", turns: 4 });
    expect(chat().messages.at(-1)).toMatchObject({ content: "", notice: { kind: "goal", goal: { state: "met", turns: 4 } } });
    expect(turns).toHaveLength(0);
  });

  it("pauses on a stop or an error without checking", async () => {
    const { env, chat } = setup({ goal: newGoal("x") }, { met: false, reason: "r" });
    await goalTurnEnded("c", "stopped", env);
    expect(chat().goal).toMatchObject({ status: "paused", pausedBy: "user", turns: 0 });
    expect(env.judge).not.toHaveBeenCalled();
  });

  it("picks a paused goal up again after the user's next turn", async () => {
    const { env, turns, chat } = setup({ goal: { ...newGoal("x"), status: "paused", pausedBy: "user", turns: 2 } }, { met: false, reason: "r" });
    await goalTurnEnded("c", "done", env);
    expect(chat().goal).toMatchObject({ status: "active", turns: 3 });
    expect(turns).toHaveLength(1);
  });

  it("stops at the turn limit and waits for the user", async () => {
    const { env, turns, chat } = setup({ goal: { ...newGoal("x"), turns: MAX_GOAL_TURNS - 1 } }, { met: false, reason: "still failing" });
    await goalTurnEnded("c", "done", env);
    expect(chat().goal).toMatchObject({ status: "paused", pausedBy: "limit", turns: MAX_GOAL_TURNS });
    expect(chat().messages.at(-1)?.notice?.goal?.state).toBe("limit");
    expect(turns).toHaveLength(0);
  });

  it("lets a queued message go first, and pauses when the goal can't be checked", async () => {
    const queued = setup({ goal: newGoal("x") }, { met: false, reason: "r" }, { queued: true });
    await goalTurnEnded("c", "done", queued.env);
    expect(queued.turns).toHaveLength(0);
    expect(queued.chat().goal?.turns).toBe(1);

    const unchecked = setup({ goal: newGoal("x") }, null);
    await goalTurnEnded("c", "done", unchecked.env);
    expect(unchecked.chat().goal).toMatchObject({ status: "paused", pausedBy: "unchecked" });
  });

  it("asks the chat's own model at low effort, an agent CLI's too", async () => {
    const verdict = await judgeGoal("tests pass", [{ id: "1", role: "user", content: "/goal tests pass", createdAt: 0 }], "cli", {} as never);
    expect(verdict).toEqual({ met: false, reason: "2 tests fail" });
    expect(asked.at(-1)?.modelId).toBe("cli");
    expect(asked.at(-1)?.effort).toBe("low");
    expect(asked.at(-1)?.prompt).toContain("<goal>tests pass</goal>");
  });

  it("hands a new session started by /goal its goal", () => {
    const message = setPendingGoal("ship it");
    expect(message).toBe(goalKickoff("ship it"));
    expect(takePendingGoal("something else")).toBeUndefined();
    setPendingGoal("ship it");
    expect(takePendingGoal(message)).toMatchObject({ text: "ship it", status: "active", turns: 0 });
    expect(takePendingGoal(message)).toBeUndefined();
  });
});
