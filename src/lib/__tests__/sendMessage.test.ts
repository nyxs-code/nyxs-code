import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SetStateAction } from "react";
import type { SendPayload } from "@/components/ui/claude-style-chat-input";
import type { Chat } from "@/lib/chatStore";
import type { Settings } from "@/lib/settings";

const fake = vi.hoisted(() => ({ worktreeOn: false, hasKey: true }));

vi.mock("@/lib/models", () => ({ getModel: (id: string) => (id.startsWith("x:") ? undefined : { id, provider: "openai" }) }));
vi.mock("@/lib/settings", () => ({ hasKey: () => fake.hasKey }));
vi.mock("@/lib/outgoingMessage", () => ({
  outgoingMessage: async (p: SendPayload, shown?: string) => ({
    userMessage: { id: "u-new", role: "user", content: shown ?? p.message, createdAt: 0 },
    modelText: p.message,
    modelImages: [],
    titleText: p.message,
  }),
}));
vi.mock("@/lib/sessionStorage", () => ({ saveSession: async () => {}, renameSession: async () => {} }));
vi.mock("@/lib/titles", () => ({ clampTitle: (s: string) => s, generateChatTitle: async () => "" }));
vi.mock("@/lib/sessionWorktree", () => ({ sessionWorktreeOn: () => fake.worktreeOn }));
vi.mock("@/lib/environments", () => ({
  pendingEnvironment: () => null,
  savedEnvironments: () => [],
  registerSessionEnvironment: () => {},
}));

import { sendMessage, type SendEnv } from "@/lib/sendMessage";

const payload = (message: string, model = "openai:gpt"): SendPayload => ({ message, files: [], pastedContent: [], model, isThinkingEnabled: false });

function setup(over: Partial<SendEnv> = {}) {
  let chats: Chat[] = [
    { id: "a", title: "A", workspace: "/ws", messages: [] },
    { id: "b", title: "B", workspace: "/ws", messages: [] },
  ];
  const setChats = (action: SetStateAction<Chat[]>) => {
    chats = typeof action === "function" ? action(chats) : action;
  };
  const env: SendEnv = {
    activeId: "a",
    workspace: "/ws",
    settings: {} as Settings,
    chats,
    effectiveModel: "openai:gpt",
    permissionMode: () => "ask",
    fileCommands: () => [],
    runBuiltin: vi.fn(async () => {}),
    resend: vi.fn(async () => {}),
    askForWorkspace: vi.fn(async () => null),
    refillInput: vi.fn(),
    openProviderSettings: vi.fn(),
    startSessionWorktree: vi.fn(async () => undefined),
    buildChatHistory: vi.fn(async () => ({ history: [{ role: "user" as const, content: "antes" }], compaction: { upTo: 0, hadSummary: false } })),
    workDirOfChat: () => "/ws",
    setChats,
    openNewChat: vi.fn((chat: Chat) => setChats((prev) => [chat, ...prev])),
    refreshSessions: vi.fn(),
    streamTurn: vi.fn(async () => {}),
    ...over,
  };
  return { env, chats: () => chats };
}

beforeEach(() => {
  fake.worktreeOn = false;
  fake.hasKey = true;
});

describe("sendMessage", () => {
  it("frees the thumbnails of what it sends once the turn starts", async () => {
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const { env } = setup();
    const file = { id: "f1", file: new File(["x"], "a.png", { type: "image/png" }), type: "image/png", preview: "blob:sent-1", uploadStatus: "complete" };
    await sendMessage({ ...payload("mira"), files: [file] as never }, undefined, env, "a");
    expect(env.streamTurn).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:sent-1");
  });

  it("sends with the model now in use when the one asked for is gone (Apply plan in an old chat)", async () => {
    const { env } = setup();
    await sendMessage(payload("Apply the plan", "x:retired"), undefined, env, "a");
    expect(env.streamTurn).toHaveBeenCalledWith(expect.objectContaining({ chatId: "a", modelId: "openai:gpt" }));
  });

  it("runs a built-in command against the chat that sent it, not the open one", async () => {
    const { env } = setup();
    await sendMessage(payload("/compact"), undefined, env, "b");
    expect(env.runBuiltin).toHaveBeenCalledWith("compact", "", "b");
    await sendMessage(payload("/status"), undefined, env);
    expect(env.runBuiltin).toHaveBeenLastCalledWith("status", "", "a");
    expect(env.streamTurn).not.toHaveBeenCalled();
  });

  it("expands a prompt command and sends it to the same chat, showing what was typed", async () => {
    const { env } = setup();
    await sendMessage(payload("/commit solo los tests"), undefined, env, "b");
    expect(env.resend).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("solo los tests") }), "/commit solo los tests", "b");
  });

  it("adds the message to the chat it names and starts its turn there", async () => {
    const { env, chats } = setup();
    await sendMessage(payload("hola"), undefined, env, "b");
    expect(chats().find((c) => c.id === "b")!.messages.map((m) => m.content)).toEqual(["hola"]);
    expect(chats().find((c) => c.id === "a")!.messages).toEqual([]);
    expect(env.streamTurn).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "b", history: [{ role: "user", content: "antes" }, { role: "user", content: "hola", images: [] }], snapshotId: "u-new" }),
    );
  });

  it("starts a new chat when none is open", async () => {
    const { env } = setup({ activeId: null });
    await sendMessage(payload("nuevo"), undefined, env);
    const chat = vi.mocked(env.openNewChat).mock.calls[0][0];
    expect(chat).toMatchObject({ title: "nuevo", workspace: "/ws", model: "openai:gpt", permissionMode: "ask" });
    expect(env.streamTurn).toHaveBeenCalledWith(expect.objectContaining({ chatId: chat.id, workspace: "/ws" }));
  });

  it("gives the message back when the user drops the worktree or opens no folder", async () => {
    fake.worktreeOn = true;
    const gaveUp = setup({ activeId: null, startSessionWorktree: vi.fn(async () => null) });
    await sendMessage(payload("con worktree"), undefined, gaveUp.env);
    expect(gaveUp.env.refillInput).toHaveBeenCalledWith(expect.objectContaining({ message: "con worktree" }));
    expect(gaveUp.env.openNewChat).not.toHaveBeenCalled();

    const noFolder = setup({ workspace: null });
    await sendMessage(payload("sin carpeta"), undefined, noFolder.env);
    expect(noFolder.env.askForWorkspace).toHaveBeenCalled();
    expect(noFolder.env.refillInput).toHaveBeenCalledWith(expect.objectContaining({ message: "sin carpeta" }));
  });

  it("sends again once a folder is opened, to the chat open by then", async () => {
    const { env } = setup({ workspace: null, askForWorkspace: vi.fn(async () => "/otro") });
    await sendMessage(payload("hola"), undefined, env, "b");
    expect(env.resend).toHaveBeenCalledWith(payload("hola"), undefined);
  });

  it("opens the provider settings when the model has no key, and skips unknown models", async () => {
    fake.hasKey = false;
    const noKey = setup();
    await sendMessage(payload("hola"), undefined, noKey.env);
    expect(noKey.env.openProviderSettings).toHaveBeenCalled();
    expect(noKey.env.streamTurn).not.toHaveBeenCalled();
    // What wasn't sent goes back to the chat box, attachments and all.
    expect(noKey.env.refillInput).toHaveBeenCalledWith(payload("hola"));

    fake.hasKey = true;
    // Nothing to send with: neither the model asked for nor the one in use is on offer.
    const unknown = setup({ effectiveModel: "x:also-gone" });
    await sendMessage(payload("hola", "x:gone"), undefined, unknown.env);
    expect(unknown.env.streamTurn).not.toHaveBeenCalled();
  });
});
