import { describe, it, expect, vi } from "vitest";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const { runAgentTurn } = await import("@/lib/agentTurn");
const { DOOM_LOOP_THRESHOLD } = await import("@/lib/doomLoop");

type Chunk = Record<string, unknown>;
type Prompt = Array<{ role: string; content: unknown }>;

const MODEL_ID = "anthropic:claude-sonnet-4-5";
const settings = {
  anthropic: {
    apiKey: "test-key",
    models: [{ id: MODEL_ID, provider: "anthropic", apiModel: "claude-sonnet-4-5", name: "Sonnet" }],
  },
} as never;

const usage = (input: number, output = 5) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});
const finish = (reason: string, input = 100) => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage: usage(input) });
const text = (t: string): Chunk[] => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: t }, { type: "text-end", id: "t" }];
const call = (id: string, toolName: string, input: unknown): Chunk => ({ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) });

function scripted(next: (prompt: Prompt, n: number) => Chunk[], delayMs = 0) {
  const prompts: Prompt[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options: { prompt: unknown }) => {
      const prompt = JSON.parse(JSON.stringify(options.prompt)) as Prompt;
      prompts.push(prompt);
      return { stream: simulateReadableStream({ chunks: next(prompt, prompts.length) as never, chunkDelayInMs: delayMs }) };
    },
  });
  return { model, prompts };
}

const lastUserText = (prompt: Prompt) => JSON.stringify(prompt.filter((m) => m.role === "user").at(-1) ?? "");

async function run(
  model: MockLanguageModelV3,
  extraTools: ToolSet,
  over: Partial<Parameters<typeof runAgentTurn>[0]> = {},
  deps: { maxSteps?: number } = {},
) {
  const saved: ModelMessage[][] = [];
  let out = "";
  const result = await runAgentTurn(
    {
      modelId: MODEL_ID,
      history: [{ role: "user", content: "do the task" }],
      settings,
      onChunk: (c) => {
        out += c;
      },
      onMessages: (m) => saved.push(m),
      sessionKey: "turn-test",
      ...over,
    },
    { isTauri: false, buildModel: () => model, extraTools, ...deps },
  );
  return { result, saved, out };
}

describe("runAgentTurn", () => {
  it("stops at the step limit and closes with inert tools", async () => {
    let runs = 0;
    const echo = tool({ description: "echo", inputSchema: z.object({ n: z.number() }), execute: async ({ n }) => `echo ${n}` });
    const { model, prompts } = scripted((prompt, n) =>
      lastUserText(prompt).includes("step limit") ? [...text("Summary of the work."), finish("stop")] : [call(`c${n}`, "Echo", { n }), finish("tool-calls")],
    );
    const counted = { Echo: { ...echo, execute: async (i: { n: number }) => { runs++; return echo.execute!(i, { toolCallId: "", messages: [] }); } } } as unknown as ToolSet;
    const { out } = await run(model, counted, {}, { maxSteps: 3 });
    expect(runs).toBe(3);
    expect(prompts).toHaveLength(4);
    expect(lastUserText(prompts[3])).toContain("step limit");
    expect(out).toContain("Summary of the work.");
  });

  it("keeps the step-limit summary in what the model sees next turn", async () => {
    const echo = tool({ description: "echo", inputSchema: z.object({ n: z.number() }), execute: async ({ n }) => `echo ${n}` });
    const { model } = scripted((prompt, n) =>
      lastUserText(prompt).includes("step limit") ? [...text("Summary of the work."), finish("stop")] : [call(`c${n}`, "Echo", { n }), finish("tool-calls")],
    );
    const { saved } = await run(model, { Echo: echo }, {}, { maxSteps: 2 });
    const last = saved.at(-1)!;
    expect(last.at(-1)).toEqual({ role: "assistant", content: "Summary of the work." });
    expect(JSON.stringify(last)).not.toContain("step limit");
  });

  it("relieves the context right after a step near the window, even when the stream reads behind", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    // Reading the file for the edit card holds the stream's reader back while the SDK goes on.
    vi.mocked(invoke).mockImplementation((async () => {
      await new Promise((r) => setTimeout(r, 30));
      return null;
    }) as never);
    try {
      const edit = tool({ description: "edit", inputSchema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() }), execute: async () => "edited" });
      const big = "lorem ipsum ".repeat(20_000);
      const asked: number[] = [];
      const { model } = scripted((prompt, n) => {
        if (lastUserText(prompt).includes("create a detailed summary")) {
          asked.push(n);
          return [...text("<summary>Earlier: lorem.</summary>"), finish("stop", 10)];
        }
        if (n === 1) return [call("e1", "Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }), finish("tool-calls", 190_000)];
        return [...text("Finished."), finish("stop", 20_000)];
      });
      await run(model, { Edit: edit }, {
        workspace: "/ws",
        history: [
          { role: "user", content: `old question ${big}` },
          { role: "assistant", content: `old answer ${big}` },
          { role: "user", content: "do the task" },
        ],
      });
      // Before the second step, not after it.
      expect(asked).toEqual([2]);
    } finally {
      vi.mocked(invoke).mockImplementation((async () => null) as never);
    }
  });

  it("blocks the third identical call and keeps the turn going", async () => {
    let runs = 0;
    const grep = tool({ description: "grep", inputSchema: z.object({ pattern: z.string() }), execute: async () => { runs++; return "no matches"; } });
    const { model, prompts } = scripted((_p, n) => (n <= DOOM_LOOP_THRESHOLD ? [call(`g${n}`, "Grep", { pattern: "foo" }), finish("tool-calls")] : [...text("Giving up on foo."), finish("stop")]));
    const { out } = await run(model, { Grep: grep });
    expect(runs).toBe(DOOM_LOOP_THRESHOLD - 1);
    const lastTool = JSON.stringify(prompts[DOOM_LOOP_THRESHOLD].filter((m) => m.role === "tool").at(-1));
    expect(lastTool).toContain("same input");
    expect(out).toContain("Giving up on foo.");
  });

  describe("in ask mode, the third identical call asks the user", () => {
    const loop = () => {
      let runs = 0;
      const grep = tool({ description: "grep", inputSchema: z.object({ pattern: z.string() }), execute: async () => { runs++; return "no matches"; } });
      const scriptedModel = scripted((_p, n) => (n <= DOOM_LOOP_THRESHOLD ? [call(`g${n}`, "Grep", { pattern: "foo" }), finish("tool-calls")] : [...text("Done."), finish("stop")]));
      return { grep, ...scriptedModel, runs: () => runs };
    };
    const lastToolResult = (prompts: Prompt[]) => JSON.stringify(prompts[DOOM_LOOP_THRESHOLD].filter((m) => m.role === "tool").at(-1));

    it("runs it when the user continues", async () => {
      const { grep, model, prompts, runs } = loop();
      const askUser = vi.fn(async (qs: { question: string }[]) => [{ question: qs[0].question, answer: "Continue" }]);
      await run(model, { Grep: grep }, { permissionMode: "ask", askUser });
      expect(askUser).toHaveBeenCalledTimes(1);
      expect(askUser.mock.calls[0][0]).toEqual([
        expect.objectContaining({
          question: expect.stringContaining(`Grep ${DOOM_LOOP_THRESHOLD} times in a row`),
          options: [{ label: "Continue" }, { label: "Stop" }],
        }),
      ]);
      expect(runs()).toBe(DOOM_LOOP_THRESHOLD);
      expect(lastToolResult(prompts)).toContain("no matches");
    });

    it("doesn't run it when the user stops, and passes on what they typed", async () => {
      const { grep, model, prompts, runs } = loop();
      const askUser = vi.fn(async (qs: { question: string }[]) => [{ question: qs[0].question, answer: "search for bar instead" }]);
      await run(model, { Grep: grep }, { permissionMode: "ask", askUser });
      expect(runs()).toBe(DOOM_LOOP_THRESHOLD - 1);
      expect(lastToolResult(prompts)).toContain("chose to stop");
      expect(lastToolResult(prompts)).toContain("search for bar instead");
    });

    it("treats a dismissed question as stop", async () => {
      const { grep, model, prompts, runs } = loop();
      await run(model, { Grep: grep }, { permissionMode: "ask", askUser: async () => null });
      expect(runs()).toBe(DOOM_LOOP_THRESHOLD - 1);
      expect(lastToolResult(prompts)).toContain("chose to stop");
    });

    it("keeps warning the model in other modes", async () => {
      const { grep, model, prompts, runs } = loop();
      const askUser = vi.fn(async () => null);
      await run(model, { Grep: grep }, { permissionMode: "acceptEdits", askUser });
      expect(askUser).not.toHaveBeenCalled();
      expect(runs()).toBe(DOOM_LOOP_THRESHOLD - 1);
      expect(lastToolResult(prompts)).toContain("same input");
    });
  });

  it("compacts mid-turn without orphaning tool results and keeps recent work", async () => {
    const read = tool({ description: "read", inputSchema: z.object({ file_path: z.string() }), execute: async () => "     1\tconst x = 1;\n" });
    const big = "lorem ipsum ".repeat(20_000);
    const compacted: Array<{ summary: string; turns: number; beforeTokens?: number; afterTokens?: number }> = [];
    const { model, prompts } = scripted((prompt, n) => {
      if (lastUserText(prompt).includes("create a detailed summary")) return [...text("<summary>Earlier: user asked about lorem.</summary>"), finish("stop", 10)];
      if (n === 1) return [call("r1", "Read", { file_path: "a.ts" }), finish("tool-calls", 190_000)];
      return [...text("Finished."), finish("stop", 20_000)];
    });
    await run(model, { Read: read }, {
      history: [
        { role: "user", content: `old question ${big}` },
        { role: "assistant", content: `old answer ${big}` },
        { role: "user", content: "do the task" },
      ],
      onCompacted: (c) => compacted.push(c),
    });
    expect(compacted).toEqual([
      { summary: expect.stringContaining("Earlier: user asked about lorem."), turns: 2, beforeTokens: expect.any(Number), afterTokens: expect.any(Number) },
    ]);
    expect(compacted[0].afterTokens!).toBeLessThan(compacted[0].beforeTokens!);
    const after = prompts.at(-1)!;
    const body = JSON.stringify(after);
    expect(body).not.toContain("old question");
    expect(body).toContain("continued from a previous conversation");
    expect(body).toContain("do the task");
    const callIds = new Set<string>();
    for (const m of after) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content as Array<{ type: string; toolCallId?: string }>) {
        if (part.type === "tool-call") callIds.add(part.toolCallId!);
        if (part.type === "tool-result") expect(callIds.has(part.toolCallId!)).toBe(true);
      }
    }
    expect(callIds.has("r1")).toBe(true);
  });

  it("summarizes the turn's first steps when the turn alone no longer fits", async () => {
    const read = tool({ description: "read", inputSchema: z.object({ file_path: z.string() }), execute: async () => "     1\tconst x = 1;\n" });
    // The provider reports a request near the window that pruning can't shrink (the steps' own
    // text): only a summary of the early steps frees room.
    const big = (tag: string) => `${tag} lorem ipsum`;
    const summaries: Prompt[] = [];
    const compacted = vi.fn();
    let step = 0;
    const { model, prompts } = scripted((prompt) => {
      if (lastUserText(prompt).includes("work you have done in the CURRENT turn")) {
        summaries.push(prompt);
        return [...text("<analysis>x</analysis><summary>Read a.ts; FIRST-STEP done.</summary>"), finish("stop", 10)];
      }
      step++;
      if (step === 1) return [...text(big("FIRST-STEP")), call("r1", "Read", { file_path: "a.ts" }), finish("tool-calls", 150_000)];
      if (step === 2) return [...text(big("SECOND-STEP")), call("r2", "Read", { file_path: "b.ts" }), finish("tool-calls", 190_000)];
      return [...text("Finished."), finish("stop", 60_000)];
    });
    const { out } = await run(model, { Read: read }, { onCompacted: compacted });
    // The summary request shares the turn's prefix (the cache) and stops before the steps kept.
    expect(summaries).toHaveLength(1);
    const asked = JSON.stringify(summaries[0]);
    expect(asked).toContain("do the task");
    expect(asked).toContain("FIRST-STEP");
    expect(asked).not.toContain("SECOND-STEP");
    // The next step sees the request, the summary and the latest step verbatim, and no orphan.
    const after = prompts.at(-1)!;
    const body = JSON.stringify(after);
    expect(body).toContain("do the task");
    expect(body).toContain("earlier steps of this turn ran out of context");
    expect(body).toContain("FIRST-STEP done.");
    expect(body).toContain("SECOND-STEP lorem");
    expect(body).not.toContain("FIRST-STEP lorem");
    const callIds = new Set<string>();
    for (const m of after) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content as Array<{ type: string; toolCallId?: string }>) {
        if (part.type === "tool-call") callIds.add(part.toolCallId!);
        if (part.type === "tool-result") expect(callIds.has(part.toolCallId!)).toBe(true);
      }
    }
    expect([...callIds]).toEqual(["r2"]);
    // A summary of this turn's steps isn't a summary of the chat's history.
    expect(compacted).not.toHaveBeenCalled();
    expect(out).toContain("Finished.");
  });

  it("saves finished steps and the partial reply when the user stops the turn", async () => {
    const controller = new AbortController();
    const read = tool({ description: "read", inputSchema: z.object({ file_path: z.string() }), execute: async () => "x".repeat(50) });
    const { model } = scripted(
      (_p, n) =>
        n === 1
          ? [call("r1", "Read", { file_path: "a.ts" }), finish("tool-calls")]
          : [{ type: "text-start", id: "t" }, ...Array.from({ length: 40 }, (_, i) => ({ type: "text-delta", id: "t", delta: `word${i} ` })), { type: "text-end", id: "t" }, finish("stop")],
      5,
    );
    let seen = 0;
    const saved: ModelMessage[][] = [];
    await runAgentTurn(
      {
        modelId: MODEL_ID,
        history: [{ role: "user", content: "do the task" }],
        settings,
        signal: controller.signal,
        onChunk: (c) => {
          if (c.includes("word") && ++seen === 3) controller.abort();
        },
        onMessages: (m) => saved.push(m),
      },
      { isTauri: false, buildModel: () => model, extraTools: { Read: read } },
    ).catch(() => undefined);
    // Saved after the first step, then again when stopped: the last save is what the chat keeps.
    expect(saved).toHaveLength(2);
    const messages = saved.at(-1)!;
    const dump = JSON.stringify(messages);
    expect(dump).toContain("r1");
    expect(dump).toMatch(/word0 .*\[The user interrupted this reply here\.\]/);
    const last = messages.at(-1) as { role: string };
    expect(last.role).toBe("assistant");
  });

  it("ends a stopped turn as aborted and saves each finished step once", async () => {
    const controller = new AbortController();
    const read = tool({ description: "read", inputSchema: z.object({ file_path: z.string() }), execute: async () => "const x = 1;" });
    const { model } = scripted(
      (_p, n) =>
        n === 1
          ? [call("r1", "Read", { file_path: "a.ts" }), finish("tool-calls")]
          : [{ type: "text-start", id: "t" }, ...Array.from({ length: 40 }, (_, i) => ({ type: "text-delta", id: "t", delta: `word${i} ` })), { type: "text-end", id: "t" }, finish("stop")],
      5,
    );
    let seen = 0;
    const saved: ModelMessage[][] = [];
    const outcome = await runAgentTurn(
      {
        modelId: MODEL_ID,
        history: [{ role: "user", content: "do the task" }],
        settings,
        signal: controller.signal,
        onChunk: (c) => {
          if (c.includes("word") && ++seen === 3) controller.abort();
        },
        onMessages: (m) => saved.push(m),
      },
      { isTauri: false, buildModel: () => model, extraTools: { Read: read } },
    ).then(
      () => "returned",
      () => "threw",
    );
    const parts = saved.at(-1)!.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; toolCallId?: string }>) : []));
    expect(parts.filter((p) => p.type === "tool-call" && p.toolCallId === "r1")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "tool-result" && p.toolCallId === "r1")).toHaveLength(1);
    expect(outcome).toBe("threw");
  });

  it("saves each finished step as it ends, and on a failure keeps them with the error for the model", async () => {
    const read = tool({ description: "read", inputSchema: z.object({ file_path: z.string() }), execute: async () => "const x = 1;" });
    const { model } = scripted((_p, n) =>
      n === 1
        ? [call("r1", "Read", { file_path: "a.ts" }), finish("tool-calls")]
        : [...text("Half an answer"), { type: "error", error: new Error("invalid_request_error: the model refused") }],
    );
    const saved: ModelMessage[][] = [];
    let savedBeforeFailure = 0;
    const outcome = await runAgentTurn(
      {
        modelId: MODEL_ID,
        history: [{ role: "user", content: "do the task" }],
        settings,
        onChunk: (c) => {
          if (c.includes("Half")) savedBeforeFailure = saved.length;
        },
        onMessages: (m) => saved.push(m),
      },
      { isTauri: false, buildModel: () => model, extraTools: { Read: read } },
    ).then(
      () => "returned",
      (e: Error) => e.message,
    );
    expect(outcome).toContain("the model refused");
    // The first step was kept as soon as it finished, before the second one failed.
    expect(savedBeforeFailure).toBeGreaterThan(0);
    const last = saved.at(-1)!;
    const parts = last.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; toolCallId?: string }>) : []));
    expect(parts.filter((p) => p.type === "tool-call" && p.toolCallId === "r1")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "tool-result" && p.toolCallId === "r1")).toHaveLength(1);
    const note = last.at(-1) as { role: string; content: string };
    expect(note.role).toBe("assistant");
    expect(note.content).toContain("Half an answer");
    expect(note.content).toContain("the model refused");
  });

  it("hands a fork the steps this turn already took, without the step that calls it", async () => {
    const read = tool({ description: "read", inputSchema: z.object({ file_path: z.string() }), execute: async () => "FILE-CONTENTS" });
    const { model, prompts } = scripted((prompt, n) => {
      if (lastUserText(prompt).includes("check the other file")) return [...text("Fork report."), finish("stop")];
      if (n === 1) return [call("r1", "Read", { file_path: "a.ts" }), finish("tool-calls")];
      if (n === 2) return [call("f1", "Agent", { description: "fork", prompt: "check the other file", fork: true }), finish("tool-calls")];
      return [...text("Done."), finish("stop")];
    });
    // With a folder and Tauri, so the turn has the Agent tool (Tauri's calls answer null here).
    await run(model, { Read: read }, { workspace: "/ws" }, { isTauri: true } as never);
    const forkPrompt = prompts.find((p) => lastUserText(p).includes("check the other file"));
    expect(forkPrompt).toBeDefined();
    const body = JSON.stringify(forkPrompt);
    expect(body).toContain("do the task");
    expect(body).toContain("FILE-CONTENTS");
    expect(body).not.toContain('"f1"');
  });

  describe("when the model runs out of output tokens", () => {
    const thought = (t: string): Chunk[] => [{ type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: t }, { type: "reasoning-end", id: "r" }];
    const asksToAct = (p: Prompt) => lastUserText(p).includes("ran out of output tokens while you were still thinking");

    it("warns and doesn't retry a reply it was writing", async () => {
      const { model, prompts } = scripted(() => [...text("The answer starts like"), finish("length")]);
      const onOutputLimit = vi.fn();
      await run(model, {}, { onOutputLimit });
      expect(prompts).toHaveLength(1);
      expect(onOutputLimit).toHaveBeenCalledOnce();
      expect(onOutputLimit).toHaveBeenCalledWith({ cut: true, retried: false });
    });

    it("runs a step that only thought again once, asking it to act, from what it thought", async () => {
      const { model, prompts } = scripted((p) => (asksToAct(p) ? [...text("Done."), finish("stop")] : [...thought("Plan: edit a.ts and"), finish("length")]));
      const onOutputLimit = vi.fn();
      const { out, saved } = await run(model, {}, { onOutputLimit });
      expect(prompts).toHaveLength(2);
      expect(asksToAct(prompts[1])).toBe(true);
      expect(lastUserText(prompts[1])).toContain("Plan: edit a.ts and");
      expect(out).toContain("Done.");
      expect(onOutputLimit).toHaveBeenCalledOnce();
      expect(onOutputLimit).toHaveBeenCalledWith({ cut: false, retried: true });
      // The history keeps the reply, not the cut thinking nor the instruction to act.
      const kept = JSON.stringify(saved.at(-1));
      expect(kept).toContain("Done.");
      expect(kept).not.toContain("ran out of output tokens");
    });

    it("keeps the steps before the cut one and retries only that one", async () => {
      const read = tool({ description: "read", inputSchema: z.object({ file_path: z.string() }), execute: async () => "const x = 1;" });
      const { model, prompts } = scripted((p, n) => {
        if (asksToAct(p)) return [...text("Read it."), finish("stop")];
        return n === 1 ? [call("r1", "Read", { file_path: "a.ts" }), finish("tool-calls")] : [...thought("Now"), finish("length")];
      });
      const { saved } = await run(model, { Read: read });
      expect(prompts).toHaveLength(3);
      expect(JSON.stringify(prompts[2])).toContain("r1");
      const kept = JSON.stringify(saved.at(-1));
      expect(kept).toContain("r1");
      expect(kept).toContain("Read it.");
    });

    it("never retries more than once", async () => {
      const { model, prompts } = scripted(() => [...thought("Still thinking"), finish("length")]);
      const onOutputLimit = vi.fn();
      await run(model, {}, { onOutputLimit });
      expect(prompts).toHaveLength(2);
      expect(onOutputLimit).toHaveBeenCalledOnce();
      expect(onOutputLimit).toHaveBeenCalledWith({ cut: true, retried: true });
    });

    it("names the limit generation.maxOutputTokens sets for OpenAI-compatible providers", async () => {
      const compatId = "deepinfra:some-model";
      const compatSettings = { deepinfra: { apiKey: "k", models: [{ id: compatId, provider: "deepinfra", apiModel: "some-model", name: "Some" }] } } as never;
      const { model } = scripted(() => [...text("Partial"), finish("length")]);
      const onOutputLimit = vi.fn();
      await run(model, {}, { modelId: compatId, settings: compatSettings, onOutputLimit });
      expect(onOutputLimit).toHaveBeenCalledOnce();
      expect(onOutputLimit).toHaveBeenCalledWith({ cut: true, retried: false, limit: 32_768 });
    });

    it("says nothing when the reply finished", async () => {
      const { model } = scripted(() => [...text("All done."), finish("stop")]);
      const onOutputLimit = vi.fn();
      await run(model, {}, { onOutputLimit });
      expect(onOutputLimit).not.toHaveBeenCalled();
    });
  });

  it("runs the auto-fix pass only when the turn ends with checker errors pending", async () => {
    const diag = '<diagnostics tool="tsc">\nheader\n\nsrc/a.ts(1,1): error TS2322: bad type\n</diagnostics>';
    let fixed = false;
    const edit = tool({
      description: "edit",
      inputSchema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() }),
      execute: async () => (fixed ? "OK" : `OK\n\n${diag}`),
    });
    const { model, prompts } = scripted((prompt, n) => {
      if (lastUserText(prompt).includes("unresolved checker errors")) {
        fixed = true;
        return n % 2 === 0 ? [call(`e${n}`, "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "c" }), finish("tool-calls")] : [...text("Fixed."), finish("stop")];
      }
      return n === 1 ? [call("e1", "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }), finish("tool-calls")] : [...text("Done."), finish("stop")];
    });
    await run(model, { Edit: edit });
    const fixPrompts = prompts.filter((p) => lastUserText(p).includes("unresolved checker errors"));
    expect(fixPrompts.length).toBeGreaterThanOrEqual(1);
    expect(lastUserText(fixPrompts[0])).toContain("TS2322");

    const clean = scripted((_p, n) => (n === 1 ? [call("e1", "Edit", { file_path: "src/b.ts", old_string: "a", new_string: "b" }), finish("tool-calls")] : [...text("Done."), finish("stop")]));
    const plainEdit = tool({ description: "edit", inputSchema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() }), execute: async () => "OK" });
    await run(clean.model, { Edit: plainEdit });
    expect(clean.prompts.some((p) => lastUserText(p).includes("unresolved checker errors"))).toBe(false);
  });
});
