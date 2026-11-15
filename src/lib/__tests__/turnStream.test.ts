import { describe, it, expect, vi } from "vitest";
import { streamText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const { compactToolError, newTurnStreamState, processTurnStream } = await import("@/lib/turnStream");
type Sinks = Parameters<typeof processTurnStream>[2];

type Chunk = Record<string, unknown>;
const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

function stepsModel(steps: Chunk[][]) {
  let i = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: (steps[i++] ?? []) as never, chunkDelayInMs: 0 }) }),
  });
}

function sinks(overrides: Partial<Sinks> = {}) {
  const out = { text: "", reasoning: "", tools: [] as Array<{ id: string; detail: Record<string, unknown> }>, events: [] as unknown[], usage: [] as number[] };
  const s: Sinks = {
    emit: (t) => {
      out.text += t;
    },
    emitReasoning: (t) => {
      out.reasoning += t;
    },
    endReasoningPhase: () => undefined,
    mark: () => undefined,
    passthroughReasoning: false,
    showDiagInUi: false,
    onTool: (id, detail) => out.tools.push({ id, detail: detail as unknown as Record<string, unknown> }),
    onUsage: (n) => out.usage.push(n),
    emitEvent: (e) => out.events.push(e),
    ...overrides,
  };
  return { s, out };
}

describe("processTurnStream", () => {
  it("reports the context going down as well as up, as after a mid-turn compaction", async () => {
    const read = tool({ description: "read", inputSchema: z.object({ file_path: z.string() }), execute: async () => "x" });
    const call = (id: string) => ({ type: "tool-call", toolCallId: id, toolName: "Read", input: JSON.stringify({ file_path: "a.ts" }) });
    const model = stepsModel([
      [call("c1"), { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage(900, 5) }],
      [{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(300, 5) }],
    ]);
    const result = streamText({ model, prompt: "go", tools: { Read: read }, stopWhen: stepCountIs(5) });
    const onContext = vi.fn();
    const { s } = sinks({ onContext });
    await processTurnStream(result.fullStream, newTurnStreamState(), s);
    expect(onContext.mock.calls.map((c) => c[0])).toEqual([900, 300]);
  });

  it("marks a tool call and its result and accounts usage per step", async () => {
    const read = tool({
      description: "read",
      inputSchema: z.object({ file_path: z.string() }),
      execute: async ({ file_path }) => `contents of ${file_path}`,
    });
    const model = stepsModel([
      [
        { type: "tool-call", toolCallId: "c1", toolName: "Read", input: JSON.stringify({ file_path: "a.ts" }) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage(100, 10) },
      ],
      [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "<think>check it</think>Done." },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(150, 5) },
      ],
    ]);
    const result = streamText({ model, prompt: "go", tools: { Read: read }, stopWhen: stepCountIs(5) });
    const state = newTurnStreamState();
    const { s, out } = sinks();
    const afterToolResult = vi.fn(async () => undefined);
    await processTurnStream(result.fullStream, state, { ...s, afterToolResult });

    expect(out.text).toContain("⟦TOOL⟧c1⟦SEP⟧");
    expect(out.text).toContain("⟦TOOLEND⟧c1⟦SEP⟧ok⟦/TOOLEND⟧");
    expect(out.text.endsWith("Done.")).toBe(true);
    expect(out.reasoning).toBe("check it");
    expect(state.stepCount).toBe(2);
    expect(state.outputTokens).toBe(15);
    expect(state.totalInputTokens).toBe(250);
    expect(state.contextUsed).toBe(150);
    expect(state.lastStepInput).toBe(150);
    expect(state.finishReason).toBe("stop");
    expect(state.toolCalls.get("c1")?.name).toBe("Read");
    expect(afterToolResult).toHaveBeenCalledOnce();
    expect(out.events).toContainEqual({ type: "tool.executed", tool: "Read", ok: true });
    expect(state.toolDetails.get("c1")?.endedAt).toBeTypeOf("number");
  });

  it("places a streamed Write as soon as its path is known and reports progress", async () => {
    const body = JSON.stringify({ file_path: "src/big.ts", content: "x".repeat(5000) });
    const model = stepsModel([
      [
        { type: "tool-input-start", id: "w1", toolName: "Write" },
        { type: "tool-input-delta", id: "w1", delta: body.slice(0, 40) },
        { type: "tool-input-delta", id: "w1", delta: body.slice(40, 3000) },
        { type: "tool-input-delta", id: "w1", delta: body.slice(3000) },
        { type: "tool-input-end", id: "w1" },
        { type: "tool-call", toolCallId: "w1", toolName: "Write", input: body },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage(10, 1300) },
      ],
    ]);
    const write = tool({ description: "w", inputSchema: z.object({ file_path: z.string(), content: z.string() }) });
    const result = streamText({ model, prompt: "go", tools: { Write: write } });
    const state = newTurnStreamState();
    const { s, out } = sinks();
    await processTurnStream(result.fullStream, state, s);

    expect(out.text.match(/⟦TOOL⟧w1⟦SEP⟧/g)).toHaveLength(1);
    expect(out.text).toContain("src/big.ts⟦/TOOL⟧");
    const progress = out.tools.filter((t) => t.id === "w1" && t.detail.streaming);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[0].detail.detail).toBe("src/big.ts");
  });

  it("reports a failing tool with a compact error and no raw markers", async () => {
    const boom = tool({
      description: "b",
      inputSchema: z.object({ reason: z.string().optional() }),
      execute: async (): Promise<string> => {
        throw new Error(`bad ⟦TOOL⟧ ${"y".repeat(1000)}`);
      },
    });
    const model = stepsModel([
      [
        { type: "tool-call", toolCallId: "e1", toolName: "Boom", input: "{}" },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage(5, 1) },
      ],
      [{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(5, 1) }],
    ]);
    const result = streamText({ model, prompt: "go", tools: { Boom: boom }, stopWhen: stepCountIs(3) });
    const state = newTurnStreamState();
    const { s, out } = sinks();
    await processTurnStream(result.fullStream, state, s);

    const end = /⟦TOOLEND⟧e1⟦SEP⟧err⟦SEP⟧([\s\S]*?)⟦\/TOOLEND⟧/.exec(out.text);
    expect(end).not.toBeNull();
    expect(end![1]).not.toMatch(/[⟦⟧]/);
    expect(end![1]).toContain("caracteres omitidos");
    expect(out.events).toContainEqual({ type: "tool.executed", tool: "Boom", ok: false });
  });

  it("emits TodoWrite once as a marker and hands the todos over", async () => {
    const todo = tool({ description: "t", inputSchema: z.object({ todos: z.array(z.object({ content: z.string() })) }), execute: async () => "ok" });
    const call = (id: string) => ({ type: "tool-call", toolCallId: id, toolName: "TodoWrite", input: JSON.stringify({ todos: [{ content: id }] }) });
    const model = stepsModel([
      [call("t1"), { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage(1, 1) }],
      [call("t2"), { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage(1, 1) }],
      [{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(1, 1) }],
    ]);
    const result = streamText({ model, prompt: "go", tools: { TodoWrite: todo }, stopWhen: stepCountIs(5) });
    const state = newTurnStreamState();
    const onTodos = vi.fn();
    const { s, out } = sinks({ onTodos });
    await processTurnStream(result.fullStream, state, s);
    expect(out.text.match(/⟦TODO⟧/g)).toHaveLength(1);
    expect(onTodos).toHaveBeenCalledTimes(2);
  });

  describe("a step that runs out of output tokens", () => {
    const length = { type: "finish", finishReason: { unified: "length", raw: "max_tokens" }, usage: usage(10, 32_768) };
    const run = async (chunks: Chunk[]) => {
      const state = newTurnStreamState();
      await processTurnStream(streamText({ model: stepsModel([chunks]), prompt: "go" }).fullStream, state, sinks().s);
      return state;
    };

    it("is seen as only thinking when it showed no text and called no tool", async () => {
      const state = await run([
        { type: "reasoning-start", id: "r" },
        { type: "reasoning-delta", id: "r", delta: "I should read the config, then" },
        { type: "reasoning-end", id: "r" },
        length,
      ]);
      expect(state.finishReason).toBe("length");
      expect(state.lastStepActed).toBe(false);
      expect(state.lastStepReasoning).toBe("I should read the config, then");
    });

    it("counts thinking inside <think> tags as thinking, not as a reply", async () => {
      const state = await run([
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "<think>first the config, then" },
        { type: "text-end", id: "t" },
        length,
      ]);
      expect(state.lastStepActed).toBe(false);
      expect(state.lastStepReasoning).toBe("first the config, then");
    });

    it("is seen as acting when it wrote some of the reply", async () => {
      const state = await run([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Here is the plan: first" }, { type: "text-end", id: "t" }, length]);
      expect(state.finishReason).toBe("length");
      expect(state.lastStepActed).toBe(true);
    });

    it("is seen as acting when it was cut while writing a tool call", async () => {
      const state = await run([
        { type: "tool-input-start", id: "w1", toolName: "Write" },
        { type: "tool-input-delta", id: "w1", delta: '{"file_path":"a.ts","content":"const' },
        length,
      ]);
      expect(state.lastStepActed).toBe(true);
    });
  });

  it("rethrows stream errors", async () => {
    const model = stepsModel([[{ type: "error", error: new Error("overloaded") }]]);
    const result = streamText({ model, prompt: "go" });
    const { s } = sinks();
    await expect(processTurnStream(result.fullStream, newTurnStreamState(), s)).rejects.toThrow("overloaded");
  });

  it("lets each step open with <think>, and keeps a later one in the answer", async () => {
    const read = tool({ description: "read", inputSchema: z.object({ file_path: z.string() }), execute: async () => "x" });
    const say = (t: string) => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: t }, { type: "text-end", id: "t" }];
    const model = stepsModel([
      [...say("<think>first</think>Reading it."), { type: "tool-call", toolCallId: "c1", toolName: "Read", input: JSON.stringify({ file_path: "a.ts" }) }, { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage(10, 5) }],
      [...say("<think>second</think>Wrap it in <think> tags."), { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(10, 5) }],
    ]);
    const result = streamText({ model, prompt: "go", tools: { Read: read }, stopWhen: stepCountIs(5) });
    const { s, out } = sinks();
    await processTurnStream(result.fullStream, newTurnStreamState(), s);
    expect(out.reasoning).toBe("firstsecond");
    expect(out.text).toContain("Reading it.");
    expect(out.text).toContain("Wrap it in <think> tags.");
  });

  it("ends an aborted stream with an abort error instead of returning", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [{ type: "text-start", id: "t" }, ...Array.from({ length: 20 }, (_, i) => ({ type: "text-delta", id: "t", delta: `w${i} ` }))] as never,
          chunkDelayInMs: 5,
        }),
      }),
    });
    const result = streamText({ model, prompt: "go", abortSignal: controller.signal });
    const { s, out } = sinks({
      emit: (t) => {
        out.text += t;
        if (out.text.includes("w2")) controller.abort();
      },
    });
    await expect(processTurnStream(result.fullStream, newTurnStreamState(), s)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("compactToolError", () => {
  it("summarizes schema failures without dumping the input", () => {
    const raw = `Invalid input for tool Edit: Type validation failed: Value: ${"{".repeat(3000)}. Error message: file_path is required`;
    const out = compactToolError(raw);
    expect(out).toContain("file_path is required");
    expect(out).toContain("KB omitida");
    expect(out.length).toBeLessThan(200);
  });
});
