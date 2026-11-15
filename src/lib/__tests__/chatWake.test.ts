import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SetStateAction } from "react";
import type { ChatMessage } from "@/components/Message";
import type { FinishedShell } from "@/lib/backgroundWake";
import type { Chat } from "@/lib/chatStore";
import type { Settings } from "@/lib/settings";

const fake = vi.hoisted(() => ({ interrupted: {} as Record<string, { modelId: string; thinking: boolean; auto: boolean }>, hasKey: true }));

vi.mock("@/lib/models", () => ({
  getModel: (id: string) => (id.startsWith("cc:") ? { id, provider: "claude-code" } : id.startsWith("x:") ? undefined : { id, provider: "openai" }),
}));
vi.mock("@/lib/settings", () => ({ hasKey: () => fake.hasKey }));
vi.mock("@/lib/assistantTurn", () => ({ RESUME_AFTER_RELOAD_PROMPT: "resume" }));
vi.mock("@/lib/interruptedTurns", () => ({
  takeInterruptedApiTurns: async () => {
    const t = fake.interrupted;
    fake.interrupted = {};
    return t;
  },
}));
vi.mock("@/lib/claudeCode", () => ({
  claudeCodeSessionOf: (rms: unknown[][]) => (rms.flat().includes("sess-1") ? "sess-1" : undefined),
}));

import { continueCutTurn, resumeInterruptedTurns, wakeChatForShells, wakeClaudeCodeChat, type WakeEnv } from "@/lib/chatWake";

const reply = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: "r", role: "assistant", content: "a medias", createdAt: 0, ...over });

function setup(chatList: Chat[], over: Partial<WakeEnv> = {}) {
  let chats = chatList;
  const setChats = (action: SetStateAction<Chat[]>) => {
    chats = typeof action === "function" ? action(chats) : action;
  };
  const env: WakeEnv = {
    settings: {} as Settings,
    effectiveModel: "openai:gpt",
    workspace: "/ws",
    liveChats: () => chats,
    turnRunning: () => false,
    streaming: () => false,
    ensureHydrated: async () => {},
    setChats,
    buildChatHistory: vi.fn(async () => ({ history: [], compaction: { upTo: 0, hadSummary: false } })),
    streamTurn: vi.fn(async () => {}),
    ...over,
  };
  return { env, chats: () => chats };
}

const shell: FinishedShell = { id: "sh1", title: "npm test", command: "npm test", status: "exited", code: 0, tail: "ok" };

beforeEach(() => {
  fake.interrupted = {};
  fake.hasKey = true;
});

describe("wakeChatForShells", () => {
  it("adds a background notice and runs a turn in the chat's own folder", async () => {
    const { env, chats } = setup([{ id: "a", title: "A", workspace: "/ws", worktree: { path: "/wt/a", branch: "b" }, messages: [] }]);
    await wakeChatForShells("a", [shell], env);
    const notice = chats()[0].messages[0];
    expect(notice.notice).toEqual({ kind: "background", items: [{ id: "sh1", title: "npm test", status: "exited", code: 0 }] });
    expect(env.streamTurn).toHaveBeenCalledWith(expect.objectContaining({ chatId: "a", workspace: "/wt/a", sessionWorkspace: "/ws", snapshotId: notice.id }));
  });

  it("leaves a running chat, a Claude Code chat and one without a key alone", async () => {
    const running = setup([{ id: "a", title: "A", messages: [] }], { turnRunning: () => true });
    await wakeChatForShells("a", [shell], running.env);
    const claude = setup([{ id: "a", title: "A", model: "cc:sonnet", messages: [] }]);
    await wakeChatForShells("a", [shell], claude.env);
    fake.hasKey = false;
    const noKey = setup([{ id: "a", title: "A", messages: [] }]);
    await wakeChatForShells("a", [shell], noKey.env);
    for (const s of [running, claude, noKey]) {
      expect(s.env.streamTurn).not.toHaveBeenCalled();
      expect(s.chats()[0].messages).toEqual([]);
    }
  });
});

describe("wakeClaudeCodeChat", () => {
  it("joins the turn in the chat that owns the session, dropping the cut reply after a reload", async () => {
    const { env, chats } = setup([
      { id: "other", title: "O", model: "cc:sonnet", messages: [] },
      { id: "owner", title: "W", model: "cc:sonnet", messages: [reply({ responseMessages: ["sess-1"] as never, streaming: true })] },
    ]);
    expect(wakeClaudeCodeChat("sess-1", { resumed: true }, env)).toBe(true);
    await vi.waitFor(() => expect(env.streamTurn).toHaveBeenCalled());
    expect(env.streamTurn).toHaveBeenCalledWith(expect.objectContaining({ chatId: "owner", modelId: "cc:sonnet", attachSession: "sess-1", history: [] }));
    expect(chats()[1].messages).toEqual([]);
  });

  it("prefers the chat named by the turn, and says no when it is busy or not Claude Code", () => {
    const named = setup([{ id: "k", title: "K", model: "cc:sonnet", messages: [] }]);
    expect(wakeClaudeCodeChat("sess-9", { chatKey: "k", resumed: false }, named.env)).toBe(true);
    const busy = setup([{ id: "k", title: "K", model: "cc:sonnet", messages: [] }], { streaming: () => true });
    expect(wakeClaudeCodeChat("sess-9", { chatKey: "k", resumed: false }, busy.env)).toBe(false);
    const api = setup([{ id: "k", title: "K", model: "openai:gpt", messages: [] }]);
    expect(wakeClaudeCodeChat("sess-9", { chatKey: "k", resumed: false }, api.env)).toBe(false);
    expect(wakeClaudeCodeChat("sess-9", { resumed: false }, setup([]).env)).toBe(false);
  });
});

describe("resumeInterruptedTurns", () => {
  it("settles the cut reply, adds a resume notice and carries on with the saved model", async () => {
    fake.interrupted = { a: { modelId: "openai:gpt", thinking: true, auto: true }, gone: { modelId: "openai:gpt", thinking: false, auto: true } };
    const { env, chats } = setup([{ id: "a", title: "A", workspace: "/ws", messages: [reply({ streaming: true }), reply({ id: "empty", content: "", streaming: true })] }]);
    await resumeInterruptedTurns(env);
    const msgs = chats()[0].messages;
    expect(msgs.map((m) => [m.id, m.streaming ?? false])).toEqual([["r", false], [msgs[1].id, false]]);
    expect(msgs[1]).toMatchObject({ role: "user", content: "resume", notice: { kind: "resume", items: [] } });
    expect(env.streamTurn).toHaveBeenCalledTimes(1);
    expect(env.streamTurn).toHaveBeenCalledWith(expect.objectContaining({ chatId: "a", modelId: "openai:gpt", thinking: true, snapshotId: msgs[1].id }));
  });

  it("leaves a chat with a turn running alone, and marks one whose model can't run here as cut", async () => {
    fake.interrupted = { a: { modelId: "openai:gpt", thinking: false, auto: true }, b: { modelId: "cc:sonnet", thinking: false, auto: true } };
    const { env, chats } = setup(
      [{ id: "a", title: "A", messages: [reply()] }, { id: "b", title: "B", messages: [reply()] }],
      { turnRunning: (id) => id === "a" },
    );
    await resumeInterruptedTurns(env);
    expect(env.streamTurn).not.toHaveBeenCalled();
    expect(chats()[0].messages[0].cutOff).toBeUndefined();
    expect(chats()[1].messages[0].cutOff).toEqual({ modelId: "cc:sonnet", thinking: false });
  });

  it("marks the reply of a turn it shouldn't carry on by itself, adding one if none was saved", async () => {
    fake.interrupted = { a: { modelId: "openai:gpt", thinking: true, auto: false }, b: { modelId: "openai:gpt", thinking: false, auto: false } };
    const { env, chats } = setup([
      { id: "a", title: "A", messages: [reply({ streaming: true })] },
      { id: "b", title: "B", messages: [{ id: "u", role: "user", content: "hola", createdAt: 0 }] },
    ]);
    await resumeInterruptedTurns(env);
    expect(env.streamTurn).not.toHaveBeenCalled();
    expect(chats()[0].messages).toEqual([reply({ streaming: false, cutOff: { modelId: "openai:gpt", thinking: true } })]);
    expect(chats()[1].messages[1]).toMatchObject({ role: "assistant", content: "", cutOff: { modelId: "openai:gpt", thinking: false } });
  });
});

describe("continueCutTurn", () => {
  const cutChat = (): Chat => ({ id: "a", title: "A", messages: [reply({ cutOff: { modelId: "openai:mini", thinking: true } })] });

  it("clears the mark and carries on with the model the reply ran on", async () => {
    const { env, chats } = setup([cutChat()]);
    await continueCutTurn("a", env);
    const msgs = chats()[0].messages;
    expect(msgs[0].cutOff).toBeUndefined();
    expect(msgs[1]).toMatchObject({ role: "user", notice: { kind: "resume" } });
    expect(env.streamTurn).toHaveBeenCalledWith(expect.objectContaining({ chatId: "a", modelId: "openai:mini", thinking: true }));
  });

  it("starts one turn for two quick clicks, and none while the chat is busy or has nothing cut", async () => {
    const { env } = setup([cutChat(), { id: "b", title: "B", messages: [reply()] }]);
    await Promise.all([continueCutTurn("a", env), continueCutTurn("a", env)]);
    expect(env.streamTurn).toHaveBeenCalledTimes(1);
    await continueCutTurn("b", env);
    const busy = setup([cutChat()], { turnRunning: () => true });
    await continueCutTurn("a", busy.env);
    expect(env.streamTurn).toHaveBeenCalledTimes(1);
    expect(busy.env.streamTurn).not.toHaveBeenCalled();
  });

  it("falls back to the chat's model when the one it ran on is gone", async () => {
    const { env } = setup([{ ...cutChat(), messages: [reply({ cutOff: { modelId: "x:gone", thinking: false } })] }]);
    await continueCutTurn("a", env);
    expect(env.streamTurn).toHaveBeenCalledWith(expect.objectContaining({ modelId: "openai:gpt" }));
  });
});
