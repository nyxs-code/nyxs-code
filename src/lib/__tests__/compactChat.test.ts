import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage } from "@/components/Message";
import type { Chat } from "@/lib/chatStore";
import type { Settings } from "@/lib/settings";

const fake = vi.hoisted(() => ({
  summarized: [] as Array<Array<{ role: string; content: string }>>,
  summary: "Resumen de la conversación",
  claudeSession: undefined as string | undefined,
  claudeCompacted: [] as string[],
}));

vi.mock("@/lib/ai", () => ({
  summarizeConversation: async (_model: string, _settings: unknown, turns: Array<{ role: string; content: string }>) => {
    fake.summarized.push(turns);
    return fake.summary;
  },
}));
vi.mock("@/lib/claudeCode", () => ({
  claudeCodeSessionOf: () => fake.claudeSession,
  compactClaudeCodeSession: async (_o: unknown, sessionId: string) => {
    fake.claudeCompacted.push(sessionId);
    return { totalTokens: 1234 };
  },
}));
vi.mock("@/lib/models", () => ({
  getModel: (id: string) => ({ id, provider: id.startsWith("claude-code") ? "claude-code" : "openai" }),
}));
vi.mock("@/lib/systemPrompt", () => ({ clearSystemPromptCache: () => {} }));

import { compactChat } from "@/lib/compactChat";

const msg = (i: number): ChatMessage => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: `mensaje ${i}`, createdAt: i });
const chatWith = (n: number, extra: Partial<Chat> = {}): Chat => ({
  id: "c1",
  title: "t",
  messages: Array.from({ length: n }, (_, i) => msg(i)),
  ...extra,
});
const run = (chat: Chat, modelId = "openai:gpt") => {
  const onStart = vi.fn();
  const result = compactChat({ chat, modelId, settings: {} as Settings, workspace: null, planMode: false, effort: "high", onStart });
  return { result, onStart };
};

beforeEach(() => {
  fake.summarized = [];
  fake.summary = "Resumen de la conversación";
  fake.claudeSession = undefined;
  fake.claudeCompacted = [];
});

describe("compactChat", () => {
  it("says there is too little to compact without starting", async () => {
    const { result, onStart } = run(chatWith(2));
    expect(await result).toBe("tooShort");
    expect(onStart).not.toHaveBeenCalled();
  });

  it("summarizes all but the latest messages and keeps those verbatim", async () => {
    const { result, onStart } = run(chatWith(10, { contextTokens: 5000 }));
    const patch = await result;
    expect(onStart).toHaveBeenCalledOnce();
    expect(patch).toMatchObject({ summary: "Resumen de la conversación", compactedUpTo: 4 });
    expect(fake.summarized[0].map((t) => t.content)).toEqual(["mensaje 0", "mensaje 1", "mensaje 2", "mensaje 3"]);
    expect(patch !== "tooShort" && patch.contextTokens).toBeGreaterThan(0);
  });

  it("folds the previous summary in and leaves the context size alone when it is unknown", async () => {
    const patch = await run(chatWith(12, { summary: "Antes", compactedUpTo: 4 })).result;
    expect(fake.summarized[0][0].content).toContain("Antes");
    expect(patch).toMatchObject({ compactedUpTo: 6 });
    expect(patch !== "tooShort" && "contextTokens" in patch).toBe(false);
  });

  it("fails on an empty summary so the chat stays as it was", async () => {
    fake.summary = "  ";
    await expect(run(chatWith(10)).result).rejects.toThrow();
  });

  it("asks Claude Code to compact its own session", async () => {
    fake.claudeSession = "sess-1";
    const patch = await run(chatWith(2), "claude-code:opus").result;
    expect(fake.claudeCompacted).toEqual(["sess-1"]);
    expect(patch).toEqual({ contextTokens: 1234 });
  });
});
