import { describe, it, expect, vi } from "vitest";
import type { Chat } from "@/lib/chatStore";
import type { Settings } from "@/lib/settings";
import type { WakeEnv } from "@/lib/chatWake";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/lib/assistantTurn", () => ({ RESUME_AFTER_RELOAD_PROMPT: "resume" }));
vi.mock("@/lib/interruptedTurns", () => ({ takeInterruptedApiTurns: async () => ({}) }));
vi.mock("@/lib/claudeCode", () => ({ claudeCodeSessionOf: () => undefined }));

const { getModel, getActiveModels, PROVIDERS, PROVIDER_ORDER } = await import("@/lib/models");
const { wakeChatForShells } = await import("@/lib/chatWake");

const gpt5 = { id: "openai:gpt-5", apiModel: "gpt-5", name: "GPT-5", description: "", provider: "openai" as const };
// A stored config from before Nyxs 2.0 was removed still carries its entry.
const settings = {
  openai: { apiKey: "sk-test", models: [gpt5], enabled: [gpt5.id] },
  nyxs2: { apiKey: "", baseUrl: "https://api.nyxs.dev/api/v2" },
} as unknown as Settings;

describe("a chat on a model that no longer exists (Nyxs 2.0)", () => {
  it("doesn't resolve the old model, like any model that's gone", () => {
    expect(getModel("nyxs2:nyxs-2", settings)).toBeUndefined();
    expect(getModel("gone:some-model", settings)).toBeUndefined();
    expect(getActiveModels(settings).map((m) => m.id)).toEqual(["openai:gpt-5"]);
    expect(Object.keys(PROVIDERS)).not.toContain("nyxs2");
    expect(PROVIDER_ORDER).not.toContain("nyxs2");
  });

  it("runs the chat's next turn on the default model", async () => {
    const chats: Chat[] = [{ id: "old", title: "Viejo", model: "nyxs2:nyxs-2", messages: [] }];
    const streamTurn = vi.fn(async () => {});
    const env: WakeEnv = {
      settings,
      effectiveModel: "openai:gpt-5",
      workspace: null,
      liveChats: () => chats,
      turnRunning: () => false,
      streaming: () => false,
      ensureHydrated: async () => {},
      setChats: () => {},
      buildChatHistory: async () => ({ history: [], compaction: { upTo: 0, hadSummary: false } }),
      streamTurn,
    };
    await wakeChatForShells("old", [{ id: "sh1", title: "npm test", command: "npm test", status: "exited", code: 0, tail: "ok" }], env);
    expect(streamTurn).toHaveBeenCalledWith(expect.objectContaining({ chatId: "old", modelId: "openai:gpt-5" }));
  });
});
