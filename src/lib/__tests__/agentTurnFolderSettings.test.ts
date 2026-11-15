import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const asked: (string | null | undefined)[] = [];
const mcpFolders: (string | null | undefined)[] = [];
vi.mock("@/lib/settingsRuntime", async (orig) => ({
  ...(await orig<typeof import("@/lib/settingsRuntime")>()),
  settingsFor: async (ws?: string | null) => {
    asked.push(ws);
    return { merged: {}, perSource: {} };
  },
}));
vi.mock("@/lib/mcp", async (orig) => ({
  ...(await orig<typeof import("@/lib/mcp")>()),
  loadMergedMcpServers: (ws?: string | null) => {
    mcpFolders.push(ws);
    return [];
  },
}));

const { runAgentTurn } = await import("@/lib/agentTurn");

const MODEL_ID = "anthropic:claude-sonnet-4-5";
const settings = {
  anthropic: { apiKey: "k", models: [{ id: MODEL_ID, provider: "anthropic", apiModel: "claude-sonnet-4-5", name: "Sonnet" }] },
} as never;

describe("a turn's settings", () => {
  it("come from the turn's own folder, MCP servers included", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
          ] as never,
        }),
      }),
    });
    await runAgentTurn(
      { modelId: MODEL_ID, history: [{ role: "user", content: "hi" }], settings, workspace: "/ws-a", sessionKey: "t1", onChunk: () => {}, onMessages: () => {} },
      { isTauri: true, buildModel: () => model } as never,
    );
    expect(asked).toContain("/ws-a");
    expect(mcpFolders).toEqual(["/ws-a"]);
  });
});
