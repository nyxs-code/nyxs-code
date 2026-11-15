import { describe, it, expect, vi } from "vitest";
import { handleChatMcp, questionsOf, registerChatTurn } from "@/lib/chatMcp";

type Json = Record<string, unknown>;

const list = async (chat?: string) => (((await handleChatMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, chat)).result as Json).tools as Json[]).map((t) => t.name);
const call = (name: string, args: Json, chat?: string) => handleChatMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, chat);

describe("Nyxs' chat tools for CLIs", () => {
  it("takes options as objects or plain strings, and drops what can't be asked", () => {
    expect(questionsOf({ questions: [{ question: "Which?", header: "", options: ["A", { label: "B", description: "the other" }, { label: " " }] }] })).toEqual([
      { question: "Which?", header: "Question", options: [{ label: "A" }, { label: "B", description: "the other" }], multiSelect: false },
    ]);
    expect(questionsOf({ questions: [{ question: "", options: ["A"] }] })).toBeNull();
    expect(questionsOf({})).toBeNull();
  });

  it("offers each chat its own turn's tools, the plan only in plan mode", async () => {
    const askUser = vi.fn(async () => null);
    const a = registerChatTurn("chat-a", { askUser });
    const b = registerChatTurn("chat-b", { askUser, plan: () => undefined });
    try {
      expect(await list("chat-a")).toEqual(["ask_user_question"]);
      expect(await list("chat-b")).toEqual(["ask_user_question", "exit_plan_mode"]);
      expect(await list("chat-none")).toEqual([]);
      const refused = await call("exit_plan_mode", { plan: "1. X" }, "chat-a");
      expect(refused.result).toMatchObject({ isError: true });
      // A dismissed card says so instead of an answer.
      expect(JSON.stringify(await call("ask_user_question", { questions: [{ question: "Q?", header: "H", options: ["A", "B"] }] }, "chat-a"))).toContain("dismissed");
    } finally {
      a.release();
      b.release();
    }
    expect(await list("chat-b")).toEqual([]);
  });
});
