import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const lm = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/modelClient", async (orig) => ({ ...(await orig<object>()), buildModel: () => lm.current }));

const { summarizeConversation } = await import("@/lib/ai");

type Chunk = Record<string, unknown>;
const MODEL_ID = "anthropic:claude-sonnet-4-5";
const settings = {
  anthropic: { apiKey: "k", models: [{ id: MODEL_ID, provider: "anthropic", apiModel: "claude-sonnet-4-5", name: "Sonnet" }] },
} as never;
const finish = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
const text = (t: string): Chunk[] => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: t }, { type: "text-end", id: "t" }, finish];

function scripted(next: (prompt: string, n: number) => Chunk[]) {
  const prompts: string[] = [];
  lm.current = new MockLanguageModelV3({
    doStream: async (options: { prompt: unknown }) => {
      const prompt = JSON.stringify(options.prompt);
      prompts.push(prompt);
      return { stream: simulateReadableStream({ chunks: next(prompt, prompts.length) as never, chunkDelayInMs: 0 }) };
    },
  });
  return prompts;
}

const turns = [
  { role: "user" as const, content: `OLDEST question ${"lorem ".repeat(2000)}` },
  { role: "assistant" as const, content: `old answer ${"ipsum ".repeat(2000)}` },
  { role: "user" as const, content: "middle question" },
  { role: "assistant" as const, content: "middle answer" },
  { role: "user" as const, content: "NEWEST question" },
];

describe("summarizeConversation with an API model", () => {
  it("throws the provider's error instead of returning an empty summary", async () => {
    scripted(() => [{ type: "error", error: new Error("Your credit balance is too low") }]);
    await expect(summarizeConversation(MODEL_ID, settings, turns)).rejects.toThrow("Your credit balance is too low");
  });

  it("drops the oldest turns and tries again when the request doesn't fit the window", async () => {
    const prompts = scripted((_p, n) =>
      n === 1 ? [{ type: "error", error: new Error("prompt is too long: 250000 tokens > 200000 maximum") }] : text("<summary>The newer work.</summary>"),
    );
    const summary = await summarizeConversation(MODEL_ID, settings, turns);
    expect(summary).toContain("The newer work.");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("OLDEST question");
    expect(prompts[1]).not.toContain("OLDEST question");
    expect(prompts[1]).toContain("NEWEST question");
  });
});
