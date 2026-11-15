import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SetStateAction } from "react";
import type { ChatMessage } from "@/components/Message";
import type { Chat } from "@/lib/chatStore";
import type { TurnInbox } from "@/lib/turnInbox";
import type { Settings } from "@/lib/settings";

type StreamOptions = Record<string, unknown> & {
  onChunk: (d: string) => void;
  onFileEdit?: (p: string) => Promise<void>;
  onCacheStats: (s: unknown) => void;
  inbox: TurnInbox;
  signal: AbortSignal;
};

const fake = vi.hoisted(() => ({
  /** What the fake model does during the turn. */
  run: async (_o: StreamOptions): Promise<void> => {},
  notified: [] as string[],
  running: {} as Record<string, { modelId: string; thinking: boolean }>,
}));

vi.mock("@/lib/ai", () => {
  class MissingKeyError extends Error {}
  return {
    MissingKeyError,
    streamChat: async (o: StreamOptions) => {
      await fake.run(o);
      return "";
    },
  };
});
vi.mock("@/lib/notify", () => ({
  notifyTurnDone: async () => { fake.notified.push("done"); },
  notifyTurnError: async (body: string) => { fake.notified.push(`error: ${body}`); },
}));
vi.mock("@/lib/telemetry", () => ({ reportUsage: async () => {} }));
vi.mock("@/lib/prArchive", () => ({
  linkOpenedPrs: async () => {},
  createPrCallTracker: () => ({ onTool: () => {}, flush: () => {} }),
  createMergeCallTracker: () => ({ onTool: () => {}, flush: () => {} }),
  fetchMergedPr: async () => null,
}));
vi.mock("@/lib/review/store", () => ({ reviewStore: { track: async () => {}, refresh: async () => {} } }));
vi.mock("@/lib/fileHistory", () => ({
  fileHistoryMakeSnapshot: async () => {},
  fileHistoryRecordShellChange: () => {},
  fileHistoryTrackEdit: async () => {},
}));
vi.mock("@/lib/models", () => ({ getModel: (id: string) => ({ id, provider: "openai" }) }));
vi.mock("@/lib/systemPrompt", () => ({ clearSystemPromptCache: () => {} }));
vi.mock("@/lib/interruptedTurns", () => ({
  rememberApiTurn: (chatId: string, modelId: string, thinking: boolean) => { fake.running[chatId] = { modelId, thinking }; },
  forgetApiTurn: (chatId: string) => { delete fake.running[chatId]; },
}));

import { missingKeyMessage, runAssistantTurn, type TurnEnv } from "@/lib/assistantTurn";

function setup() {
  let chats: Chat[] = [{ id: "c1", title: "t", messages: [{ id: "u1", role: "user", content: "hola", createdAt: 0 }] }];
  const setChats = (action: SetStateAction<Chat[]>) => {
    chats = typeof action === "function" ? action(chats) : action;
  };
  const streaming = new Set<string>();
  const env: TurnEnv = {
    settings: {} as Settings,
    permissionMode: () => "ask",
    effort: () => "high",
    setChats,
    patchMessage: (chatId, msgId, fn) =>
      setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)) } : c))),
    liveChat: (id) => chats.find((c) => c.id === id),
    abortControllers: new Map(),
    turnsDone: new Map(),
    startStreaming: (id) => streaming.add(id),
    stopStreaming: (id) => streaming.delete(id),
    patchTurnSide: vi.fn(),
    setCompacting: vi.fn(),
    bumpRecent: vi.fn(),
    gate: async () => true,
    askUser: async () => null,
    clearPreapproval: vi.fn(),
    cancelPrompts: vi.fn(),
    fileHistory: () => () => {},
    queue: {
      inboxFor: () => ({ take: () => [], consumed: () => {}, onArrive: () => () => {}, onHurry: () => () => {} }),
      drainDelivering: () => [],
      pause: vi.fn(),
    },
    queuedAsMessages: (items) => items.map((i): ChatMessage => ({ id: i.id, role: "user", content: `cola ${i.id}`, createdAt: 0 })),
    showPreview: vi.fn(),
    filesChanged: vi.fn(),
    backgroundShell: vi.fn(),
    turnEnded: vi.fn(),
    reindexRag: vi.fn(),
    openProviderSettings: vi.fn(),
  };
  const turn = { chatId: "c1", modelId: "openai:gpt", history: [], thinking: false, workspace: "/ws" };
  return { env, turn, streaming, messages: () => chats[0].messages, chat: () => chats[0] };
}

beforeEach(() => {
  fake.run = async () => {};
  fake.notified = [];
  fake.running = {};
});

describe("runAssistantTurn", () => {
  it("streams the reply into the chat and cleans up when it ends", async () => {
    const { env, turn, streaming, messages } = setup();
    let seenWhileRunning = false;
    fake.run = async (o) => {
      seenWhileRunning = streaming.has("c1") && env.abortControllers.has("c1") && env.turnsDone.has("c1");
      // The turn is remembered while it runs, in case the app is cut.
      expect(fake.running).toEqual({ c1: { modelId: "openai:gpt", thinking: false } });
      o.onChunk("Hola, ");
      o.onChunk("¿qué tal?");
    };
    await runAssistantTurn(turn, env);

    expect(seenWhileRunning).toBe(true);
    const reply = messages()[1];
    expect(reply).toMatchObject({ role: "assistant", content: "Hola, ¿qué tal?", streaming: false });
    expect(streaming.has("c1")).toBe(false);
    expect(env.abortControllers.has("c1")).toBe(false);
    expect(env.turnsDone.has("c1")).toBe(false);
    expect(env.cancelPrompts).toHaveBeenCalledWith("c1");
    expect(env.reindexRag).not.toHaveBeenCalled();
    expect(fake.notified).toEqual(["done"]);
  });

  it("shows a failure in the reply and pauses the chat's queue", async () => {
    const { env, turn, messages } = setup();
    fake.run = async () => { throw new Error("sin conexión"); };
    await runAssistantTurn(turn, env);
    expect(messages()[1]).toMatchObject({ content: "⚠️ Error: sin conexión", streaming: false });
    expect(env.queue.pause).toHaveBeenCalledWith("c1");
    expect(fake.notified).toEqual(["error: ⚠️ Error: sin conexión"]);
  });

  it("shows a failure after what the reply had already written", async () => {
    const { env, turn, messages } = setup();
    fake.run = async (o) => {
      o.onChunk("Leí el archivo y");
      throw new Error("sin conexión");
    };
    await runAssistantTurn(turn, env);
    expect(messages()[1]).toMatchObject({ content: "Leí el archivo y\n\n⚠️ Error: sin conexión", streaming: false });
  });

  it("shows a tool left running by a failure as stopped, as a stop does", async () => {
    const { env, turn, messages } = setup();
    fake.run = async (o) => {
      o.onChunk("Voy a leerlo ⟦TOOL⟧t1⟦SEP⟧Read⟦SEP⟧src/a.ts⟦/TOOL⟧");
      throw new Error("sin conexión");
    };
    await runAssistantTurn(turn, env);
    const content = messages()[1].content;
    expect(content).toContain("⟦TOOLEND⟧t1⟦SEP⟧stop⟦/TOOLEND⟧");
    expect(content.endsWith("⚠️ Error: sin conexión")).toBe(true);
  });

  it("marks a stopped reply and doesn't notify", async () => {
    const { env, turn, messages } = setup();
    fake.run = async (o) => {
      o.onChunk("a medias");
      env.abortControllers.get("c1")!.abort();
      throw new Error("aborted");
    };
    await runAssistantTurn(turn, env);
    expect(messages()[1].content).toBe("a medias\n\n_⏹ Interrumpido por el usuario._");
    expect(fake.notified).toEqual([]);
    // A turn the user stopped is never carried on when the app starts again.
    expect(fake.running).toEqual({});
  });

  it("marks a stopped reply even when the provider returns instead of throwing", async () => {
    const { env, turn, messages } = setup();
    fake.run = async (o) => {
      o.onChunk("⟦TOOL⟧t1⟦SEP⟧Read⟦SEP⟧a.ts⟦/TOOL⟧");
      env.abortControllers.get("c1")!.abort();
    };
    await runAssistantTurn(turn, env);
    expect(messages()[1]).toMatchObject({ content: expect.stringContaining("_⏹ Interrumpido por el usuario._"), streaming: false });
    // The open tool card is closed, as on any other stop.
    expect(messages()[1].content).toContain("⟦TOOLEND⟧t1");
    expect(fake.notified).toEqual([]);
  });

  it("starts a new reply after queued messages reach the model", async () => {
    const { env, turn, messages } = setup();
    fake.run = async (o) => {
      o.onChunk("primera parte");
      o.inbox.consumed([{ id: "q1", text: "otra cosa" }]);
      o.onChunk("segunda parte");
    };
    await runAssistantTurn(turn, env);
    expect(messages().map((m) => [m.role, m.content])).toEqual([
      ["user", "hola"],
      ["assistant", "primera parte"],
      ["user", "cola q1"],
      ["assistant", "segunda parte"],
    ]);
    expect(messages().every((m) => !m.streaming)).toBe(true);
  });

  it("lists the files the turn edited and re-indexes the folder", async () => {
    const { env, turn, messages } = setup();
    fake.run = async (o) => {
      await o.onFileEdit?.("/ws/a.ts");
      await o.onFileEdit?.("/ws/b.ts");
    };
    await runAssistantTurn(turn, env);
    expect(messages()[1].changedFiles).toEqual(["/ws/a.ts", "/ws/b.ts"]);
    expect(env.reindexRag).toHaveBeenCalledWith("/ws");
    expect(fake.running).toEqual({});
  });

  it("reports compaction for its own chat: summaries apart, Claude Code's on the turn side", async () => {
    const { env, turn } = setup();
    fake.run = async (o) => {
      const onCompacting = o.onCompacting as (active: boolean, native?: boolean) => void;
      onCompacting(true);
      onCompacting(false);
      onCompacting(true, true);
    };
    await runAssistantTurn(turn, env);
    expect(vi.mocked(env.setCompacting).mock.calls).toEqual([["c1", true], ["c1", false]]);
    expect(env.patchTurnSide).toHaveBeenCalledWith("c1", { compacting: true });
  });

  it("leaves a divider before the reply when Nyxs compacts mid-turn", async () => {
    const { env, turn, chat } = setup();
    fake.run = async (o) => {
      const onCompacting = o.onCompacting as (active: boolean) => void;
      const onCompacted = o.onCompacted as (c: { summary: string; turns: number; beforeTokens?: number; afterTokens?: number }) => void;
      onCompacting(true);
      onCompacting(false);
      onCompacted({ summary: "resumen", turns: 1, beforeTokens: 180_000, afterTokens: 40_000 });
      o.onChunk("sigo");
    };
    await runAssistantTurn(turn, env);
    expect(chat()).toMatchObject({ summary: "resumen", compactedUpTo: 1 });
    expect(chat().compactions).toEqual([{ afterId: "u1", ms: expect.any(Number), beforeTokens: 180_000, afterTokens: 40_000 }]);
  });

  it("leaves no divider when Nyxs' compaction fails or only trims the turn's own steps", async () => {
    const { env, turn, chat } = setup();
    fake.run = async (o) => {
      const onCompacting = o.onCompacting as (active: boolean) => void;
      onCompacting(true);
      onCompacting(false);
    };
    await runAssistantTurn(turn, env);
    expect(chat().compactions).toBeUndefined();
  });

  it("marks Claude Code's own compaction with its tokens before, and the next context as after", async () => {
    const { env, turn, chat } = setup();
    fake.run = async (o) => {
      const onCompacting = o.onCompacting as (active: boolean, native?: boolean) => void;
      const onNativeCompacted = o.onNativeCompacted as (c: { preTokens?: number }) => void;
      const onContext = o.onContext as (used: number) => void;
      onContext(150_000);
      onCompacting(true, true);
      onCompacting(false, true);
      onNativeCompacted({ preTokens: 160_000 });
      onContext(30_000);
      onContext(31_000);
    };
    await runAssistantTurn(turn, env);
    expect(chat().contextTokens).toBe(31_000);
    expect(chat().compactions).toEqual([{ afterId: "u1", ms: expect.any(Number), beforeTokens: 160_000, afterTokens: 30_000 }]);
  });

  it("falls back to the chat's last context when Claude Code doesn't say the size before", async () => {
    const { env, turn, chat } = setup();
    fake.run = async (o) => {
      (o.onContext as (used: number) => void)(150_000);
      (o.onNativeCompacted as (c: { preTokens?: number }) => void)({});
    };
    await runAssistantTurn(turn, env);
    expect(chat().compactions).toEqual([{ afterId: "u1", ms: 0, beforeTokens: 150_000, afterTokens: undefined }]);
  });
});

describe("missingKeyMessage", () => {
  it("names the provider in the app's language, the custom one with its translated name", async () => {
    const { getLanguage, getTranslations } = await import("@/lib/i18n");
    const t = getTranslations(getLanguage());
    const err = (o: object) => Object.assign(new Error(), { providerName: "Custom provider", ...o }) as never;
    const missing = (name: string) => `${t.chatUi.missingApiKey.replace("{provider}", name)} ${t.chatUi.fixInSettings}`;
    expect(missingKeyMessage(err({ providerId: "custom" }))).toBe(missing(t.settings.customProviderName));
    expect(missingKeyMessage(err({ providerId: "openai", providerName: "OpenAI" }))).toBe(missing("OpenAI"));
    // A CLI that isn't signed in says why itself.
    expect(missingKeyMessage(err({ providerId: "claude-code", detail: "Claude Code: Not logged in" }))).toBe(`Claude Code: Not logged in ${t.chatUi.fixInSettings}`);
    // Every language has both texts, with the provider's place in the first.
    for (const code of ["es-ES", "en-US", "de-DE", "ja-JP"]) {
      expect(getTranslations(code).chatUi.missingApiKey).toContain("{provider}");
      expect(getTranslations(code).chatUi.fixInSettings).toBeTruthy();
    }
  });
});
