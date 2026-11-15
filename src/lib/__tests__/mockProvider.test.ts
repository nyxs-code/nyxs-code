import { describe, it, expect } from "vitest";
import { streamText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { estimateCostUsd } from "@/lib/pricing";

type Chunk = Record<string, unknown>;

// The LanguageModelV3 shape: the finish reason as { unified, raw } and usage broken down. The
// SDK reads `unified` to decide whether to run the tools and loop, so the old plain strings
// stopped the multi-step tests after the first step.
const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});
const reason = (r: string) => ({ unified: r, raw: r });

const finish = (input = 10, output = 5) => ({ type: "finish", finishReason: reason("stop"), usage: usage(input, output) });
const toolCallsFinish = (input: number, output: number) => ({ type: "finish", finishReason: reason("tool-calls"), usage: usage(input, output) });

function scriptedModel(chunks: Chunk[]) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: chunks as never, chunkDelayInMs: 0 }),
    }),
  });
}

describe("parity: text streaming", () => {
  it("streams assistant text deltas to completion", async () => {
    const model = scriptedModel([
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "Hello " },
      { type: "text-delta", id: "0", delta: "world" },
      { type: "text-end", id: "0" },
      finish(),
    ]);
    const res = streamText({ model, prompt: "hi" });
    let text = "";
    for await (const d of res.textStream) text += d;
    expect(text).toBe("Hello world");
  });
});

describe("parity: tool call roundtrip", () => {
  it("invokes a tool, feeds the result back, and finishes (multi-step)", async () => {
    let toolRan = 0;
    const weather = tool({
      description: "get weather",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        toolRan++;
        return `sunny in ${city}`;
      },
    });

    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        step++;
        const chunks: Chunk[] =
          step === 1
            ? [
                { type: "tool-call", toolCallId: "c1", toolName: "weather", input: JSON.stringify({ city: "Paris" }) },
                toolCallsFinish(8, 4),
              ]
            : [
                { type: "text-start", id: "1" },
                { type: "text-delta", id: "1", delta: "It is sunny in Paris." },
                { type: "text-end", id: "1" },
                finish(20, 6),
              ];
        return { stream: simulateReadableStream({ chunks: chunks as never, chunkDelayInMs: 0 }) };
      },
    });

    const res = streamText({ model, tools: { weather }, stopWhen: stepCountIs(5), prompt: "weather in Paris?" });
    let text = "";
    for await (const d of res.textStream) text += d;

    expect(toolRan).toBe(1);
    expect(text).toContain("sunny in Paris");
    expect(step).toBe(2);
  });
});

describe("parity: multi-step stop condition", () => {
  it("keeps looping on tool-calls until stopWhen halts it", async () => {
    const ping = tool({
      description: "ping",
      inputSchema: z.object({}),
      execute: async () => "pong",
    });
    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        step++;
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: 0,
            chunks: [
              { type: "tool-call", toolCallId: `c${step}`, toolName: "ping", input: "{}" },
              toolCallsFinish(1, 1),
            ] as never,
          }),
        };
      },
    });
    const res = streamText({ model, tools: { ping }, stopWhen: stepCountIs(3), prompt: "loop" });
    for await (const _ of res.textStream) void _;
    expect(step).toBe(3);
  });
});

describe("parity: turn cost", () => {
  it("prices the usage record a turn reports", () => {
    const turnUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCostUsd("claude-sonnet-4-6", turnUsage)).toBeCloseTo(18);
    expect(estimateCostUsd("gpt-4o-mini", turnUsage)).toBeCloseTo(0.75);
  });
});
