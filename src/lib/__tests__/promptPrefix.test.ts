import { describe, it, expect, vi } from "vitest";
import type { ModelMessage } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const prompts: unknown[][] = [];
let reply = 0;
const model = new MockLanguageModelV3({
  doStream: async (options: { prompt: unknown[] }) => {
    prompts.push(JSON.parse(JSON.stringify(options.prompt)));
    reply++;
    return {
      stream: simulateReadableStream({
        chunkDelayInMs: 0,
        chunks: [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: `answer ${reply}` },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } },
        ] as never,
      }),
    };
  },
});

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => () => model,
  anthropic: { tools: { toolSearchBm25_20251119: () => ({ type: "provider", id: "anthropic.tool_search_bm25_20251119", args: {} }) } },
}));

const { streamChat } = await import("@/lib/ai");

const MODEL_ID = "anthropic:claude-sonnet-4-5";
const settings = {
  anthropic: {
    apiKey: "test-key",
    models: [{ id: MODEL_ID, provider: "anthropic", apiModel: "claude-sonnet-4-5", name: "Sonnet" }],
  },
} as never;

function stripCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheMarkers);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== "providerOptions") out[k] = stripCacheMarkers(v);
    return out;
  }
  return value;
}

async function turn(history: Array<{ role: "user" | "assistant"; content: string; messages?: ModelMessage[] }>, planMode: boolean) {
  let saved: ModelMessage[] = [];
  const text = await streamChat({
    modelId: MODEL_ID,
    history,
    settings,
    onChunk: () => undefined,
    onMessages: (m) => {
      saved = m;
    },
    planMode,
    sessionKey: "prefix-test",
  });
  return { text, saved };
}

describe("compaction reuses the cached prefix", () => {
  it("summarizes old turns with the same system prompt and keeps recent turns verbatim", async () => {
    prompts.length = 0;
    const big = "lorem ipsum ".repeat(60_000);
    const compacted: Array<{ summary: string; turns: number }> = [];
    await streamChat({
      modelId: MODEL_ID,
      history: [
        { role: "user", content: `old request ${big}` },
        { role: "assistant", content: `old answer ${big}` },
        { role: "user", content: "recent question" },
        { role: "assistant", content: "recent answer" },
        { role: "user", content: "new question" },
      ],
      settings,
      onChunk: () => undefined,
      onCompacted: (c) => compacted.push(c),
      sessionKey: "compact-test",
    });
    expect(compacted).toHaveLength(1);
    expect(compacted[0].turns).toBe(2);
    expect(prompts).toHaveLength(2);
    const [summaryCall, mainCall] = prompts.map((p) => stripCacheMarkers(p) as Array<{ role: string; content: unknown }>);
    const sys = (p: typeof summaryCall) => p.filter((m) => m.role === "system");
    expect(sys(summaryCall)).toEqual(sys(mainCall));
    expect(JSON.stringify(summaryCall.at(-1))).toContain("create a detailed summary");
    expect(JSON.stringify(summaryCall)).toContain("old request");
    const mainText = JSON.stringify(mainCall);
    expect(mainText).not.toContain("old request");
    expect(mainText).toContain("continued from a previous conversation");
    expect(mainText).toContain("recent question");
  });
});

describe("prompt prefix stays append-only across turns", () => {
  it("keeps every earlier message byte-identical and moves mode changes into history", async () => {
    prompts.length = 0;
    const first = await turn([{ role: "user", content: "Hola, revisa el proyecto por favor" }], false);
    const second = await turn(
      [
        { role: "user", content: "Hola, revisa el proyecto por favor" },
        { role: "assistant", content: first.text, messages: first.saved },
        { role: "user", content: "Ahora haz un plan para el siguiente paso" },
      ],
      true,
    );
    expect(prompts).toHaveLength(2);
    const [p1, p2] = prompts.map((p) => stripCacheMarkers(p) as unknown[]);

    const sys1 = p1.filter((m) => (m as { role: string }).role === "system");
    const sys2 = p2.filter((m) => (m as { role: string }).role === "system");
    expect(sys2).toEqual(sys1);

    expect(p2.slice(0, p1.length)).toEqual(p1);

    const tail = JSON.stringify(p2.slice(p1.length));
    expect(tail).toContain('system-reminder id=\\"plan-mode\\"');
    expect(JSON.stringify(p1)).not.toContain("plan-mode");
    expect(second.saved.some((m) => JSON.stringify(m).includes("plan-mode"))).toBe(true);
  });
});
