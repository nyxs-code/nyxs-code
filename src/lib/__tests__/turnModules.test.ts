import { describe, it, expect, vi } from "vitest";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import type { Compacted } from "@/lib/turnContext";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const { deferTools } = await import("@/lib/turnTools");
const { guardWithPreToolUse } = await import("@/lib/turnHooks");
const { buildTurnInjections } = await import("@/lib/turnInjections");
const { TurnContext, createCompactor, dropOldest } = await import("@/lib/turnContext");
const { getContinuationMessage } = await import("@/lib/compact");
const { compactionBudget } = await import("@/lib/contextBudget");
const { collectExtraAgents, createSubagentRunner, projectPath } = await import("@/lib/turnSubagents");
const { newToolSession } = await import("@/lib/fileStateCache");
type TurnHooks = import("@/lib/turnHooks").TurnHooks;

const opts = { toolCallId: "c", messages: [] };
const plain = (description: string) =>
  tool({ description, inputSchema: z.object({ q: z.string().optional() }), execute: async () => `${description} ran` });
const openai = { id: "openai:gpt-4.1", provider: "openai", apiModel: "gpt-4.1" } as const;
const sonnet = { id: "anthropic:claude-sonnet-4-5", provider: "anthropic", apiModel: "claude-sonnet-4-5" } as const;

describe("deferTools", () => {
  it("keeps deferred tools inactive until ToolSearch activates them", async () => {
    const tools: ToolSet = { Read: plain("read files"), GitDiff: plain("show a diff"), GitLog: plain("git history") };
    const d = deferTools(tools, [], openai as never, new Set());
    expect(d.deferActive).toBe(true);
    expect([...d.activeToolNames].sort()).toEqual(["Read", "ToolSearch"]);
    const reply = await tools.ToolSearch.execute!({ query: "select:GitDiff" }, opts);
    expect(reply).toContain("Activated 1 tool(s)");
    expect(d.activeToolNames.has("GitDiff")).toBe(true);
    expect(d.activeToolNames.has("GitLog")).toBe(false);
  });

  it("never defers the web tools the system prompt names", () => {
    const tools: ToolSet = { Read: plain("read"), WebSearch: plain("search"), WebFetch: plain("fetch"), GitLog: plain("git history") };
    const d = deferTools(tools, [], openai as never, new Set());
    expect([...d.deferredNames]).toEqual(["GitLog"]);
  });

  it("keeps tools activated in earlier turns active", () => {
    const tools: ToolSet = { Read: plain("read"), GitLog: plain("git history") };
    const d = deferTools(tools, [], openai as never, new Set(["GitLog"]));
    expect(d.activeToolNames.has("GitLog")).toBe(true);
  });

  it("uses Anthropic's native tool search when the model supports it", () => {
    const tools: ToolSet = { Read: plain("read"), GitLog: plain("git history") };
    const d = deferTools(tools, [], sonnet as never, new Set());
    expect(d.deferActive).toBe(false);
    expect((tools.GitLog as { providerOptions?: { anthropic?: { deferLoading?: boolean } } }).providerOptions?.anthropic?.deferLoading).toBe(true);
    expect(tools.ToolSearch).toBeDefined();
  });

  it("defers MCP tools only past the threshold", () => {
    const few: ToolSet = { mcp__s__a: plain("a"), mcp__s__b: plain("b") };
    expect(deferTools(few, Object.keys(few), openai as never, new Set()).deferredNames.size).toBe(0);
    const many: ToolSet = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`mcp__s__t${i}`, plain(`t${i}`)]));
    expect(deferTools(many, Object.keys(many), openai as never, new Set()).deferredNames.size).toBe(9);
  });

  it("sends every MCP tool up front in preloaded mode but still defers local tools", () => {
    const tools: ToolSet = {
      GitLog: plain("git history"),
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`mcp__s__t${i}`, plain(`t${i}`)])),
    };
    const mcp = Object.keys(tools).filter((n) => n.startsWith("mcp__"));
    const d = deferTools(tools, mcp, openai as never, new Set(), "preloaded");
    expect([...d.deferredNames]).toEqual(["GitLog"]);
    expect(mcp.every((n) => d.activeToolNames.has(n))).toBe(true);
  });
});

describe("sessionSettingsFor", () => {
  it("keeps the values a session started with", async () => {
    const { sessionSettingsFor } = await import("@/lib/sessionSettings");
    expect(sessionSettingsFor("pin-test", { outputStyle: "concise", toolAccessMode: "preloaded" })).toEqual({
      outputStyle: "concise",
      toolAccessMode: "preloaded",
    });
    expect(sessionSettingsFor("pin-test", { outputStyle: "learning" }).outputStyle).toBe("concise");
    expect(sessionSettingsFor(undefined, { outputStyle: "learning" }).toolAccessMode).toBe("onDemand");
  });
});

describe("guardWithPreToolUse", () => {
  it("stops a call a hook blocks and runs the rest", async () => {
    const ran: string[] = [];
    const tools: ToolSet = {
      Bash: tool({ description: "bash", inputSchema: z.object({ command: z.string() }), execute: async () => (ran.push("Bash"), "done") }),
      Read: tool({ description: "read", inputSchema: z.object({ file_path: z.string() }), execute: async () => (ran.push("Read"), "content") }),
    };
    const hooks: TurnHooks = {
      has: (e) => e === "PreToolUse",
      fire: vi.fn(async (input) =>
        input.tool_name === "Bash" ? { context: [], blocking: ["rm is not allowed"], blocked: true } : { context: [], blocking: [], blocked: false },
      ),
    };
    guardWithPreToolUse(tools, hooks, "ws");
    expect(await tools.Bash.execute!({ command: "rm -rf x" }, opts)).toContain("rm is not allowed");
    expect(await tools.Read.execute!({ file_path: "a" }, opts)).toBe("content");
    expect(ran).toEqual(["Read"]);
  });

  it("leaves tools untouched without PreToolUse hooks", () => {
    const read = plain("read");
    const tools: ToolSet = { Read: read };
    guardWithPreToolUse(tools, { has: () => false, fire: vi.fn() }, "ws");
    expect(tools.Read).toBe(read);
  });
});

describe("buildTurnInjections", () => {
  const silentHooks = (context: string[] = []): TurnHooks => ({ has: () => true, fire: vi.fn(async () => ({ context, blocking: [], blocked: false })) });

  it("adds session-start context, new reminders and git state on the first turn", async () => {
    const hooks = silentHooks(["hook says hi"]);
    const out = await buildTurnInjections({
      history: [{ role: "user", content: "do the task" }],
      hooks,
      workspace: "ws",
      modelId: "m",
      promptState: { reminders: new Map(), activatedTools: new Set() },
      reminders: [{ id: "plan-mode", content: "plan mode is on" }],
      gitContext: "On branch main\n",
    });
    const text = JSON.stringify(out);
    expect(text).toContain("[Session start context]");
    expect(text).toContain("plan mode is on");
    expect(text).toContain("On branch main");
    expect((hooks.fire as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].hook_event_name)).toEqual(["SessionStart", "UserPromptSubmit"]);
  });

  it("repeats nothing that earlier turns already sent", async () => {
    const hooks = silentHooks();
    const out = await buildTurnInjections({
      history: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
      hooks,
      workspace: "ws",
      modelId: "m",
      promptState: { reminders: new Map([["plan-mode", "plan mode is on"]]), lastGit: "On branch main", activatedTools: new Set() },
      reminders: [{ id: "plan-mode", content: "plan mode is on" }],
      gitContext: "On branch main\n",
    });
    expect(JSON.stringify(out)).not.toMatch(/plan mode is on|On branch main|Session start/);
    expect((hooks.fire as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].hook_event_name)).toEqual(["UserPromptSubmit"]);
  });
});

describe("TurnContext", () => {
  const sys: ModelMessage[] = [{ role: "system", content: "system prompt" }];
  const history: ModelMessage[] = [
    { role: "user", content: "old question" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "do the task" },
  ];
  const make = (compact = vi.fn(async () => "<summary>earlier work</summary>")) => {
    const compacted: Compacted[] = [];
    const ctx = new TurnContext({
      budget: compactionBudget(200_000, 8_000),
      overheadTokens: 1_000,
      systemMessages: sys,
      historyTurns: 3,
      compact,
      onReshaped: vi.fn(),
      onCompacted: (c) => compacted.push(c),
    });
    return { ctx, compact, compacted };
  };

  it("leaves a history that fits untouched", async () => {
    const { ctx, compact } = make();
    const fitted = await ctx.fitHistory(history, [0, 1, 2]);
    expect(fitted).toEqual({ messages: history, reshaped: false });
    expect(compact).not.toHaveBeenCalled();
  });

  it("after an overflow, summarizes what precedes the anchor and keeps the rest", async () => {
    const { ctx, compact, compacted } = make();
    ctx.setAnchor(2);
    expect(await ctx.forceRelief(history)).toBe(true);
    expect(compact).toHaveBeenCalledWith(history.slice(0, 2));
    // Turned down as too long: it was at least the window, and the summary freed part of it.
    expect(compacted).toEqual([{ summary: "<summary>earlier work</summary>", turns: 2, beforeTokens: 200_000, afterTokens: expect.any(Number) }]);
    expect(compacted[0].afterTokens!).toBeLessThan(200_000);
    const step: ModelMessage = { role: "assistant", content: "working on it" };
    const shaped = ctx.shape([...sys, ...history, step]);
    expect(shaped[0]).toBe(sys[0]);
    expect(JSON.stringify(shaped[1])).toContain("earlier work");
    expect(shaped.slice(2)).toEqual([history[2], step]);
  });

  it("can't compact mid-turn without an earlier message to summarize", async () => {
    const { ctx, compact } = make();
    ctx.setAnchor(0);
    expect(await ctx.forceRelief(history.slice(2))).toBe(false);
    expect(compact).not.toHaveBeenCalled();
  });

  describe("a turn that alone no longer fits", () => {
    const request: ModelMessage = { role: "user", content: "do the task" };
    // One step: the model's text and tool call, then the tool's result.
    const stepOf = (n: number, words = 10): ModelMessage[] => [
      { role: "assistant", content: [{ type: "text", text: `step ${n} ${"word ".repeat(words)}` }, { type: "tool-call", toolCallId: `c${n}`, toolName: "Read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: `c${n}`, toolName: "Read", output: { type: "text", value: `result ${n}` } }] },
    ];
    const steps = (from: number, to: number, words?: number) => Array.from({ length: to - from + 1 }, (_, i) => stepOf(from + i, words)).flat();
    const turn = (compact = vi.fn(async (_p: ModelMessage[], _prompt?: string) => "<summary>steps so far</summary>")) => {
      const compacted = vi.fn();
      const ctx = new TurnContext({
        budget: compactionBudget(20_000, 1_000),
        overheadTokens: 500,
        systemMessages: sys,
        historyTurns: 1,
        compact,
        onReshaped: vi.fn(),
        onCompacted: compacted,
      });
      ctx.setAnchor(-1);
      ctx.setTurnStart(1);
      return { ctx, compact, compacted };
    };

    it("summarizes its first steps and keeps the request and the latest steps verbatim", async () => {
      const { ctx, compact, compacted } = turn();
      const msgs = [...sys, request, ...steps(1, 6, 1_500)];
      await ctx.relieveStepPressure(msgs, 19_000);
      expect(compact).toHaveBeenCalledTimes(1);
      const [prefix, prompt] = compact.mock.calls[0];
      expect(prompt).toContain("CURRENT turn");
      expect(prefix[0]).toBe(request);
      // Cut right before one of the model's messages, so no tool result loses its call.
      const kept = ctx.shape(msgs);
      expect(kept.slice(0, 2)).toEqual([sys[0], request]);
      expect(JSON.stringify(kept[2])).toContain("steps so far");
      expect(kept[3].role).toBe("assistant");
      expect(prefix.length + 1).toBe(msgs.indexOf(kept[3]));
      expect(kept.at(-1)).toBe(msgs.at(-1));
      expect(compacted).not.toHaveBeenCalled();
      // Later steps are added after the summary, which stays where it is.
      const more = [...msgs, ...stepOf(7)];
      expect(ctx.shape(more).slice(0, kept.length)).toEqual(kept);
    });

    it("folds the earlier summary into the next one when the turn overflows again", async () => {
      const compact = vi.fn(async (_p: ModelMessage[], _prompt?: string) => `<summary>summary ${compact.mock.calls.length}</summary>`);
      const { ctx } = turn(compact);
      const first = [...sys, request, ...steps(1, 6, 1_500)];
      await ctx.relieveStepPressure(first, 19_000);
      const second = [...first, ...steps(7, 12, 1_500)];
      await ctx.relieveStepPressure(second, 19_000);
      expect(compact).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(compact.mock.calls[1][0])).toContain("summary 1");
      const shaped = ctx.shape(second);
      expect(shaped.slice(0, 2)).toEqual([sys[0], request]);
      expect(JSON.stringify(shaped[2])).toContain("summary 2");
      expect(JSON.stringify(shaped)).not.toContain("summary 1");
    });

    it("drops the cut when a later pass's messages differ from the ones it summarized", async () => {
      const { ctx } = turn();
      const msgs = [...sys, request, ...steps(1, 6, 1_500)];
      await ctx.relieveStepPressure(msgs, 19_000);
      const other = [...sys, request, ...steps(20, 26)];
      expect(ctx.shape(other)).toEqual(other);
    });

    it("cuts it after the provider rejects the request, when there's no history to summarize", async () => {
      const { ctx, compact } = turn();
      expect(await ctx.forceRelief([request, ...steps(1, 4)])).toBe(true);
      expect(compact.mock.calls[0][1]).toContain("CURRENT turn");
    });

    it("leaves a turn with a single step as it is", async () => {
      const { ctx, compact } = turn();
      const msgs = [...sys, request, ...stepOf(1, 9_000)];
      await ctx.relieveStepPressure(msgs, 19_000);
      expect(compact).not.toHaveBeenCalled();
      expect(ctx.shape(msgs)).toEqual(msgs);
    });

    it("still summarizes after pruning when the provider counts more tokens than the estimate", async () => {
      const compact = vi.fn(async (_p: ModelMessage[], _prompt?: string) => "<summary>steps so far</summary>");
      const ctx = new TurnContext({
        budget: compactionBudget(200_000, 8_000),
        overheadTokens: 500,
        systemMessages: sys,
        historyTurns: 1,
        compact,
        onReshaped: vi.fn(),
      });
      ctx.setAnchor(-1);
      ctx.setTurnStart(1);
      const bigStep = (n: number): ModelMessage[] => [
        { role: "assistant", content: [{ type: "text", text: "word ".repeat(3_600) }, { type: "tool-call", toolCallId: `c${n}`, toolName: "Read", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: `c${n}`, toolName: "Read", output: { type: "text", value: "x".repeat(48_000) } }] },
      ];
      // About 100k estimated tokens, but the tokenizer saw 190k. Pruning old results takes the
      // estimate well under the trigger; the real size stays over it.
      const msgs = [...sys, request, ...[1, 2, 3, 4, 5, 6].flatMap(bigStep)];
      await ctx.relieveStepPressure(msgs, 190_000);
      expect(compact).toHaveBeenCalledTimes(1);
    });
  });
});

describe("createCompactor", () => {
  const sys: ModelMessage[] = [{ role: "system", content: "system prompt" }];
  const finish = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } };
  // Rejects any prompt over `limit` characters, the way a provider rejects one past its window.
  const modelWithLimit = (limit: number, sizes: number[]) =>
    new MockLanguageModelV3({
      doStream: async (o: { prompt: unknown }) => {
        const size = JSON.stringify(o.prompt).length;
        sizes.push(size);
        if (size > limit) {
          throw new Error(`This model's maximum context length is 1000000 tokens. However, your prompt contains at least 1000001 input tokens.`);
        }
        return {
          stream: simulateReadableStream({
            chunks: [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "<summary>the newer part</summary>" }, { type: "text-end", id: "t" }, finish] as never,
          }),
        };
      },
    });
  const turns = (n: number): ModelMessage[] =>
    Array.from({ length: n }, (_, i): ModelMessage[] => [
      { role: "user", content: `question ${i} ${"word ".repeat(400)}` },
      { role: "assistant", content: `answer ${i} ${"word ".repeat(400)}` },
    ]).flat();

  it("drops the oldest messages and tries again when the summary request is itself too long", async () => {
    const sizes: number[] = [];
    const compact = createCompactor({ model: modelWithLimit(12_000, sizes), systemMessages: sys, isAnthropic: false, callOptions: { maxRetries: 0 } });
    const summary = await compact(turns(6));
    expect(summary).toContain("the newer part");
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.at(-1)).toBeLessThanOrEqual(12_000);
  });

  it("fails rather than returning an empty summary when nothing more can go", async () => {
    const compact = createCompactor({ model: modelWithLimit(10, []), systemMessages: sys, isAnthropic: false, callOptions: { maxRetries: 0 } });
    await expect(compact(turns(1))).rejects.toThrow(/maximum context length/);
  });
});

describe("dropOldest", () => {
  const continuation = getContinuationMessage("<summary>earlier</summary>");
  const big = "word ".repeat(400);

  it("keeps the summary at the head and cuts before a user message", () => {
    const prefix: ModelMessage[] = [
      { role: "user", content: continuation },
      { role: "user", content: `q1 ${big}` },
      { role: "assistant", content: `a1 ${big}` },
      { role: "user", content: `q2 ${big}` },
      { role: "assistant", content: `a2 ${big}` },
      { role: "user", content: `q3 ${big}` },
    ];
    const out = dropOldest(prefix)!;
    expect(out[0]).toBe(prefix[0]);
    expect(out.length).toBeLessThan(prefix.length);
    expect(out.at(-1)).toBe(prefix.at(-1));
  });

  it("never cuts between a tool call and its result", () => {
    const step = (n: number): ModelMessage[] => [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${n}`, toolName: "Read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: `c${n}`, toolName: "Read", output: { type: "text", value: big } }] },
    ];
    const prefix: ModelMessage[] = [{ role: "user", content: "do it" }, ...step(1), ...step(2), ...step(3)];
    const out = dropOldest(prefix)!;
    expect(out[0].role).toBe("user");
    expect(out[1].role).toBe("assistant");
  });

  it("has nothing to drop from a single message", () => {
    expect(dropOldest([{ role: "user", content: big }])).toBeNull();
  });
});

describe("collectExtraAgents", () => {
  it("prefers an agent file over a plugin agent with the same name", () => {
    const agents = collectExtraAgents(
      [{ name: "reviewer", whenToUse: "file", body: "from file", source: "project" }] as never,
      { agents: [{ name: "reviewer", description: "plugin", content: "from plugin" }, { name: "tester", description: "runs tests", content: "test" }] } as never,
    );
    expect(agents.map((a) => [a.type, a.systemPrompt])).toEqual([
      ["reviewer", "from file"],
      ["tester", "test"],
    ]);
  });
});

describe("patchFiles", () => {
  it("reads the changed paths off the diff headers, spaces and accents included", async () => {
    const { patchFiles } = await import("@/lib/worktree");
    const patch = [
      "diff --git a/docs/CO.md b/docs/CO.md",
      "index 1111111..2222222 100644",
      "--- a/docs/CO.md",
      "+++ b/docs/CO.md",
      "diff --git a/scripts/a b.py b/scripts/a b.py",
      "diff --git a/ñ.md b/ñ.md",
      'diff --git "a/con espacio.md" "b/con espacio.md"',
    ].join("\n");
    expect(patchFiles(patch)).toEqual(["docs/CO.md", "scripts/a b.py", "ñ.md", "con espacio.md"]);
  });
});

describe("withWorktree", () => {
  const PATCH = "diff --git a/a.txt b/a.txt\nindex 1111111..2222222 100644\n";

  /** Fakes the worktree commands; `check` decides whether a patch would go in. */
  async function fakeWorktreeCommands(check: (patch: string) => Promise<void>) {
    const { invoke } = await import("@tauri-apps/api/core");
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { id?: string; patch?: string }) => {
      if (cmd === "worktree_create") return `C:/wt/${args?.id}`;
      if (cmd === "worktree_export_patch") return PATCH.replace("a.txt b/a.txt", `a.txt b/a.txt\n# ${args?.id}`);
      const tag = args?.patch?.match(/# (\S+)/)?.[1] ?? "";
      if (cmd === "worktree_check_patch") {
        calls.push(`check ${tag}`);
        await check(args!.patch!);
      }
      if (cmd === "worktree_apply_patch") calls.push(`apply ${tag}`);
      return null;
    }) as never);
    return { calls, restore: () => vi.mocked(invoke).mockImplementation(async () => null) };
  }

  it("records nothing and reports the reason when the patch won't go in", async () => {
    const { withWorktree } = await import("@/lib/worktree");
    const fake = await fakeWorktreeCommands(async () => {
      throw new Error("a.txt: el proyecto cambió en esas mismas líneas");
    });
    const recorded: string[][] = [];
    let failure = "";
    const out = await withWorktree("C:/ws", "sub-x-1", async () => "informe", {
      beforeApply: (files) => void recorded.push(files),
      onApplyError: (e) => (failure = String(e)),
    });
    fake.restore();
    expect(out).toBe("informe");
    expect(recorded).toEqual([]);
    expect(failure).toContain("a.txt");
    expect(fake.calls).not.toContain("apply sub-x-1");
  });

  it("merges parallel agents one at a time, each check right before its own apply", async () => {
    const { withWorktree } = await import("@/lib/worktree");
    let release!: () => void;
    const slowFirstCheck = new Promise<void>((r) => (release = r));
    const fake = await fakeWorktreeCommands((patch) => (patch.includes("# sub-x-1") ? slowFirstCheck : Promise.resolve()));
    const recorded: string[][] = [];
    const run = (id: string) => withWorktree("C:/ws", id, async () => id, { beforeApply: (files) => void recorded.push(files) });
    const both = Promise.all([run("sub-x-1"), run("sub-x-2")]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await both).toEqual(["sub-x-1", "sub-x-2"]);
    fake.restore();
    expect(fake.calls).toEqual(["check sub-x-1", "apply sub-x-1", "check sub-x-2", "apply sub-x-2"]);
    expect(recorded).toEqual([["a.txt"], ["a.txt"]]);
  });
});

describe("projectPath", () => {
  it("maps a path in an isolated sub-agent's worktree to the project, with either separator", () => {
    expect(projectPath("src/a.ts", "C:\\wt\\sub-1", "C:\\proj")).toBe("C:\\proj\\src\\a.ts");
    expect(projectPath("C:\\wt\\sub-1\\src\\a.ts", "C:\\wt\\sub-1", "C:\\proj")).toBe("C:\\proj\\src\\a.ts");
    expect(projectPath("src/a.ts", "/home/u/.nyxs/wt/sub-1", "/home/u/proj")).toBe("/home/u/proj/src/a.ts");
    expect(projectPath("/home/u/.nyxs/wt/sub-1/src/a.ts", "/home/u/.nyxs/wt/sub-1/", "/home/u/proj")).toBe("/home/u/proj/src/a.ts");
  });

  it("leaves a path outside the worktree as it came", () => {
    expect(projectPath("/home/u/other/a.ts", "/home/u/.nyxs/wt/sub-1", "/home/u/proj")).toBe("/home/u/other/a.ts");
    expect(projectPath("/home/u/.nyxs/wt/sub-10/a.ts", "/home/u/.nyxs/wt/sub-1", "/home/u/proj")).toBe("/home/u/.nyxs/wt/sub-10/a.ts");
  });
});

describe("createSubagentRunner", () => {
  it("a fork continues from the parent's messages at the time of the call", async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (o: { prompt: unknown }) => {
        prompts.push(JSON.parse(JSON.stringify(o.prompt)));
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "fork report" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
            ] as never,
          }),
        };
      },
    });
    let parent: ModelMessage[] = [{ role: "user", content: "before" }];
    const run = createSubagentRunner({
      isTauri: false,
      workspace: "ws",
      model: sonnet as never,
      languageModel: model,
      settings: {} as never,
      buildModel: () => model,
      mainSystem: "parent system",
      getMessages: () => parent,
      extraAgents: [],
      toolSession: newToolSession(),
      tools: {
        planMode: false,
        confirmBeforeWrite: false,
        allowPdf: false,
        allowImages: false,
        nativeToolImages: true,
        pathScope: { id: "ws", extraRoots: [] },
        extract: async () => "",
      },
      compatMaxOutputTokens: 8_000,
      isolateSubagents: false,
    });
    parent = [...parent, { role: "assistant", content: "parent progress" }];
    const report = await run({ description: "fork", prompt: "check the tests", subagentType: "", fork: true, reflect: false });
    expect(report).toBe("fork report");
    const sent = JSON.stringify(prompts[0]);
    expect(sent).toContain("parent system");
    expect(sent).toContain("parent progress");
    expect(sent).toContain("check the tests");
  });

  it("gives a fresh sub-agent the project's instructions, the date and the user's language", async () => {
    const prompts: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (o: { prompt: unknown }) => {
        prompts.push(JSON.stringify(o.prompt));
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "done" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
            ] as never,
          }),
        };
      },
    });
    const run = createSubagentRunner({
      isTauri: false,
      workspace: "ws",
      model: sonnet as never,
      languageModel: model,
      settings: {} as never,
      buildModel: () => model,
      mainSystem: "parent system",
      getMessages: () => [],
      extraAgents: [],
      toolSession: newToolSession(),
      tools: {
        planMode: false,
        confirmBeforeWrite: false,
        allowPdf: false,
        allowImages: false,
        nativeToolImages: true,
        pathScope: { id: "ws", extraRoots: [] },
        extract: async () => "",
      },
      compatMaxOutputTokens: 8_000,
      isolateSubagents: false,
      parentContext: { projectInstructions: "Never add blank lines twice.", date: "2026-11-10", language: "Spanish" },
    });
    await run({ description: "edit", prompt: "fix the bug", subagentType: "general-purpose", reflect: false });
    expect(prompts[0]).toContain("Never add blank lines twice.");
    expect(prompts[0]).toContain("2026-11-10");
    expect(prompts[0]).toContain("Spanish");
  });

  it("prunes its old tool results once its requests near its window", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const numbered = Array.from({ length: 2_000 }, (_, i) => `${String(i + 1).padStart(6)}\tconst value${i} = "${"x".repeat(20)}";\n`).join("");
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "agent_read_file_range") return { text: numbered, startLine: 1, endLine: 2_000, totalLines: 2_000 };
      if (cmd === "agent_file_mtime") return 1;
      return null;
    }) as never);
    type Prompt = Array<{ role: string; content: unknown }>;
    const prompts: Prompt[] = [];
    const usage = (input: number) => ({ inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } });
    const model = new MockLanguageModelV3({
      doStream: async (o: { prompt: unknown }) => {
        const sent = JSON.stringify(o.prompt);
        prompts.push(JSON.parse(sent) as Prompt);
        const n = prompts.length;
        // The provider counts what it was sent, at about two characters a token, so its count
        // falls once old results are pruned.
        const next =
          n <= 6
            ? [{ type: "tool-call", toolCallId: `r${n}`, toolName: "Read", input: JSON.stringify({ file_path: `f${n}.ts` }) }, { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage(Math.round(sent.length / 2)) }]
            : [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "read them all" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(60_000) }];
        return { stream: simulateReadableStream({ chunks: next as never }) };
      },
    });
    try {
      const run = createSubagentRunner({
        isTauri: false,
        workspace: "ws",
        model: { ...sonnet, contextWindow: 200_000 } as never,
        languageModel: model,
        settings: {} as never,
        buildModel: () => model,
        mainSystem: "parent system",
        getMessages: () => [],
        extraAgents: [],
        toolSession: newToolSession(),
        tools: { planMode: false, confirmBeforeWrite: false, allowPdf: false, allowImages: false, nativeToolImages: true, pathScope: { id: "ws", extraRoots: [] }, extract: async () => "" },
        compatMaxOutputTokens: 8_000,
        isolateSubagents: false,
      });
      expect(await run({ description: "read", prompt: "read the six files", subagentType: "", reflect: false })).toBe("read them all");
      const results = (prompt: Prompt) =>
        prompt.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; output?: { value?: unknown } }>) : [])).filter((p) => p.type === "tool-result").map((p) => JSON.stringify(p.output));
      const last = results(prompts.at(-1)!);
      expect(last).toHaveLength(6);
      // The oldest reads were cut down; the latest one is still whole.
      expect(last[0].length).toBeLessThan(results(prompts[1])[0].length / 2);
      expect(last[5]).toBe(results(prompts[6])[5]);
    } finally {
      vi.mocked(invoke).mockImplementation((async () => null) as never);
    }
  });

  it("keeps a long run inside its own model's window, as the main agent does", async () => {
    type Prompt = Array<{ role: string; content: unknown }>;
    const prompts: Prompt[] = [];
    const summaries: Prompt[] = [];
    const usage = (input: number) => ({ inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } });
    const chunks = (t: string, finish: string, input: number, call?: string) => [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: t },
      { type: "text-end", id: "t" },
      ...(call ? [{ type: "tool-call", toolCallId: call, toolName: "Glob", input: JSON.stringify({ pattern: "*.ts" }) }] : []),
      { type: "finish", finishReason: { unified: finish, raw: finish }, usage: usage(input) },
    ];
    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async (o: { prompt: unknown }) => {
        const prompt = JSON.parse(JSON.stringify(o.prompt)) as Prompt;
        const asksSummary = JSON.stringify(prompt.filter((m) => m.role === "user").at(-1)).includes("CURRENT turn");
        if (asksSummary) summaries.push(prompt);
        else prompts.push(prompt);
        step += asksSummary ? 0 : 1;
        const next = asksSummary
          ? chunks("<summary>Globbed once; FIRST-STEP done.</summary>", "stop", 10)
          : step === 1
            ? chunks("FIRST-STEP looking", "tool-calls", 9_000, "g1")
            : step === 2
              ? chunks("SECOND-STEP looking", "tool-calls", 19_000, "g2")
              : chunks("sub report", "stop", 6_000);
        return { stream: simulateReadableStream({ chunks: next as never }) };
      },
    });
    // A small window of its own: 19k tokens of a 20k window is over its budget.
    const small = { ...sonnet, contextWindow: 20_000 };
    const run = createSubagentRunner({
      isTauri: false,
      workspace: "ws",
      model: small as never,
      languageModel: model,
      settings: {} as never,
      buildModel: () => model,
      mainSystem: "parent system",
      getMessages: () => [],
      extraAgents: [],
      toolSession: newToolSession(),
      tools: {
        planMode: false,
        confirmBeforeWrite: false,
        allowPdf: false,
        allowImages: false,
        nativeToolImages: true,
        pathScope: { id: "ws", extraRoots: [] },
        extract: async () => "",
      },
      compatMaxOutputTokens: 8_000,
      isolateSubagents: false,
    });
    const report = await run({ description: "search", prompt: "find the config files", subagentType: "", reflect: false });
    expect(report).toBe("sub report");
    expect(summaries).toHaveLength(1);
    expect(JSON.stringify(summaries[0])).toContain("FIRST-STEP looking");
    const last = JSON.stringify(prompts.at(-1));
    expect(last).toContain("find the config files");
    expect(last).toContain("FIRST-STEP done.");
    expect(last).toContain("SECOND-STEP looking");
    expect(last).not.toContain("FIRST-STEP looking");
  });
});
