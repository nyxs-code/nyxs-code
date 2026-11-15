import { describe, it, expect, vi } from "vitest";
import type { ModelMessage, ToolSet } from "ai";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const {
  buildSystemPromptCacheBlocks,
  formatSystemReminder,
  reminderUpdates,
} = await import("@/lib/systemPrompt");
const { scanInjectedState, gitSnapshotMessage, supportsNativeToolSearch, stripNativeToolSearch, stripProviderExecutedParts } =
  await import("@/lib/promptPrefix");
const { planToolResultPruning, applyToolResultPruning, estimateMessageTokens, MC_PRUNE_MARKER, MC_CLEARED_MESSAGE } =
  await import("@/lib/microcompact");
const { compactionBudget, chooseCompactionCut } = await import("@/lib/contextBudget");
const { buildTools, sortToolSet, planModeBlockMessage } = await import("@/lib/agentTools");
const { checkPermission } = await import("@/lib/permissions");
const { compactRegistry, setRegistryIndex, lookupRegistryModel, registryVision } = await import("@/lib/modelRegistry");
const { supportsImages } = await import("@/lib/models");
const { priceForModel, costFromPrice } = await import("@/lib/pricing");
const { inertTools, withPromptCacheKey, serializeModelMessages, pickHelperModel } = await import("@/lib/ai");

const opts = { toolCallId: "c1", messages: [] };
type Exec = (input: unknown, o: typeof opts) => Promise<unknown>;
const run = (tools: ToolSet, name: string, input: unknown) => (tools[name].execute as unknown as Exec)(input, opts);

const toolCall = (id: string, toolName: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName, input: { file_path: `${id}.ts` } }],
});
const toolResult = (id: string, toolName: string, value: string): ModelMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value } }],
});

describe("system prompt keeps volatile sections out of the cached prefix", () => {
  const base = { workspace: "E:\\ws", date: "2026-10-19" };

  it("returns the same blocks whether plan mode is on or off", () => {
    const off = buildSystemPromptCacheBlocks(base);
    const on = buildSystemPromptCacheBlocks({ ...base, planMode: true, outputStylePrompt: "Be brief." });
    expect(on.blocks).toEqual(off.blocks);
    expect(on.reminders.map((r) => r.id)).toEqual(["output-style", "plan-mode"]);
  });

  it("only emits reminders for sections that changed", () => {
    const on = buildSystemPromptCacheBlocks({ ...base, planMode: true }).reminders;
    expect(reminderUpdates(new Map(), on).map((r) => r.id)).toEqual(["plan-mode"]);
    const seen = new Map(on.map((r) => [r.id, r.content]));
    expect(reminderUpdates(seen, on)).toEqual([]);
    const off = reminderUpdates(seen, []);
    expect(off).toHaveLength(1);
    expect(off[0].content).toMatch(/no longer active/);
    expect(reminderUpdates(new Map([["plan-mode", off[0].content]]), [])).toEqual([]);
  });

  it("reads back reminders, git snapshots and activated tools from history", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "user", content: formatSystemReminder("plan-mode", "PLAN") },
      gitSnapshotMessage("branch main\n M a.ts"),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "ToolSearch",
            output: { type: "text", value: "Activated 2 tool(s) — now callable for the rest of this turn:\n\n- WebFetch: fetch\n- GitDiff: diff" },
          },
        ],
      },
    ];
    const state = scanInjectedState(history);
    expect(state.reminders.get("plan-mode")).toBe("PLAN");
    expect(state.lastGit).toBe("branch main\n M a.ts");
    expect([...state.activatedTools].sort()).toEqual(["GitDiff", "WebFetch"]);
  });
});

describe("native tool search", () => {
  it("is only offered to recent Claude models on the Anthropic API", () => {
    expect(supportsNativeToolSearch("anthropic", "claude-opus-4-5-20251101")).toBe(true);
    expect(supportsNativeToolSearch("anthropic", "claude-sonnet-5-5")).toBe(true);
    expect(supportsNativeToolSearch("anthropic", "claude-sonnet-4-20250514")).toBe(false);
    expect(supportsNativeToolSearch("anthropic", "claude-haiku-4-5")).toBe(false);
    expect(supportsNativeToolSearch("minimax-anthropic", "claude-opus-4-5")).toBe(false);
  });

  it("can strip deferral from a request body for the fallback", () => {
    const body = { tools: [{ name: "Read" }, { name: "WebFetch", defer_loading: true }, { type: "tool_search_tool_bm25_20251119", name: "ToolSearch" }] };
    expect(stripNativeToolSearch(body)?.tools).toEqual([{ name: "Read" }, { name: "WebFetch" }]);
  });

  it("drops provider-executed parts for other providers", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool-call", toolCallId: "s", toolName: "ToolSearch", input: {}, providerExecuted: true },
        ],
      },
    ];
    const out = stripProviderExecutedParts(msgs);
    expect((out[0].content as unknown[]).length).toBe(1);
  });
});

describe("tool result pruning", () => {
  const big = "x".repeat(40_000);
  const history: ModelMessage[] = [];
  for (let i = 0; i < 12; i++) history.push(toolCall(`r${i}`, "Read"), toolResult(`r${i}`, "Read", big));

  it("does nothing below pressure", () => {
    const plan = planToolResultPruning(history, { usedTokens: 50_000, contextWindow: 200_000 });
    expect(plan.added).toBe(0);
  });

  it("trims the oldest big results first and protects the newest ones", () => {
    const used = estimateMessageTokens(history);
    const plan = planToolResultPruning(history, { usedTokens: used, contextWindow: 200_000 });
    expect(plan.added).toBeGreaterThan(0);
    expect(plan.prune.r0).toBeDefined();
    expect(plan.prune.r11).toBeUndefined();
    const pruned = applyToolResultPruning(history, plan.prune);
    const first = (pruned[1].content as { output: { value: string } }[])[0].output.value;
    expect(first.includes(MC_PRUNE_MARKER) || first === MC_CLEARED_MESSAGE).toBe(true);
    expect(estimateMessageTokens(pruned)).toBeLessThan(used);
  });

  it("is deterministic, so the same map gives byte-identical history", () => {
    const used = estimateMessageTokens(history);
    const { prune } = planToolResultPruning(history, { usedTokens: used, contextWindow: 200_000 });
    expect(JSON.stringify(applyToolResultPruning(history, prune))).toBe(JSON.stringify(applyToolResultPruning(history, prune)));
  });

  it("refuses to prune when it would free too little", () => {
    const small = [toolCall("a", "Read"), toolResult("a", "Read", "y".repeat(2000))];
    const plan = planToolResultPruning(small, { usedTokens: 190_000, contextWindow: 200_000 });
    expect(plan.added).toBe(0);
  });
});

describe("compaction budget", () => {
  it("triggers at 80% for a 200k window and keeps a bounded tail", () => {
    const b = compactionBudget(200_000, 32_000);
    expect(b.trigger).toBe(160_000);
    expect(b.keep).toBe(30_000);
  });

  it("keeps whole recent turns within budget and never cuts the newest one", () => {
    expect(chooseCompactionCut([50_000, 50_000, 10_000, 5_000, 2_000], 20_000)).toBe(2);
    expect(chooseCompactionCut([50_000, 60_000], 20_000)).toBe(1);
    expect(chooseCompactionCut([1_000], 20_000)).toBe(0);
  });
});

describe("stable tool catalog", () => {
  it("keeps write tools declared in plan mode and blocks them on use", async () => {
    const normal = buildTools({ workspace: "E:\\ws" });
    const plan = buildTools({ workspace: "E:\\ws", planMode: true });
    expect(Object.keys(plan)).toEqual(Object.keys(normal));
    expect(await run(plan, "Write", { file_path: "a.ts", content: "x" })).toBe(planModeBlockMessage("Write"));
    expect(String(await run(plan, "Bash", { command: "npm install" }))).toMatch(/read-only commands/);
  });

  it("orders tools by name", () => {
    expect(Object.keys(sortToolSet({ b: {}, a: {}, c: {} } as unknown as ToolSet))).toEqual(["a", "b", "c"]);
    const names = Object.keys(buildTools({ workspace: "E:\\ws" }));
    expect(names).toEqual([...names].sort());
  });

  it("lets read-only Bash through in plan mode", () => {
    expect(checkPermission("Bash", { command: "git status" }, "plan", [])).toBe("allow");
    expect(checkPermission("Bash", { command: "rm -rf dist" }, "plan", [])).not.toBe("allow");
  });

  it("can make a tool set inert without changing its schema", () => {
    const tools = buildTools({ workspace: "E:\\ws" });
    const inert = inertTools(tools);
    expect(Object.keys(inert)).toEqual(Object.keys(tools));
    expect(inert.Read.execute).toBeUndefined();
    expect(inert.Read.description).toBe(tools.Read.description);
  });
});

describe("model registry and cost", () => {
  it("reads limits and prices from models.dev data", () => {
    const data = compactRegistry({
      anthropic: { models: { "claude-sonnet-4-5": { limit: { context: 200000, output: 64000 }, cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
      xai: { models: { "grok-4": { limit: { context: 256000, output: 32000 }, cost: { input: 3, output: 15 } } } },
    });
    setRegistryIndex(data);
    expect(lookupRegistryModel("anthropic", "claude-sonnet-4-5-20250929")?.context).toBe(200000);
    expect(lookupRegistryModel("grok", "grok-4")?.context).toBe(256000);
    expect(lookupRegistryModel("openrouter", "x-ai/grok-4")?.context).toBe(256000);
    const price = priceForModel("anthropic", "claude-sonnet-4-5");
    expect(price?.cacheRead).toBe(0.3);
    const usd = costFromPrice(price!, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 });
    expect(usd).toBeCloseTo(0.3);
    setRegistryIndex(null);
  });

  it("knows which models take images from models.dev, across hosts", () => {
    setRegistryIndex(compactRegistry({
      deepseek: { models: { "deepseek-chat": { modalities: { input: ["text"] } } } },
      standardcompute: { models: {
        "deepseek/deepseek-v4.1-flash": { modalities: { input: ["text", "image"] } },
        "deepseek/deepseek-v4-flash": { modalities: { input: ["text"] } },
      } },
      "alibaba-token-plan": { models: { "kimi-k2.5": { modalities: { input: ["text", "image", "video"] } } } },
    }));
    const m = (provider: string, apiModel: string) => ({ id: `${provider}:${apiModel}`, provider, apiModel, name: apiModel, description: "" }) as never;
    expect(registryVision("custom", "deepseek-v4.1-flash")).toBe(true);
    expect(registryVision("openrouter", "deepseek/deepseek-v4.1-flash-1017")).toBe(true);
    expect(registryVision("custom", "deepseek-v4-flash")).toBe(false);
    expect(registryVision("deepseek", "deepseek-chat")).toBe(false);
    expect(registryVision("custom", "unknown-model")).toBeUndefined();
    expect(supportsImages(m("custom", "deepseek-v4.1-flash"))).toBe(true);
    expect(supportsImages(m("moonshot", "kimi-k2.5"))).toBe(true);
    expect(supportsImages(m("custom", "deepseek-v4-flash"))).toBe(false);
    // Not listed: the name patterns still decide.
    expect(supportsImages(m("custom", "qwen2.5-vl-72b"))).toBe(true);
    setRegistryIndex(null);
  });

  it("believes models.dev when it says a model takes no images, whatever its name suggests", () => {
    setRegistryIndex(compactRegistry({
      openai: { models: { "gpt-5-text-preview": { modalities: { input: ["text"] } } } },
      anthropic: { models: { "claude-text-only-1": { modalities: { input: ["text"] } } } },
    }));
    const m = (provider: string, apiModel: string) => ({ id: `${provider}:${apiModel}`, provider, apiModel, name: apiModel, description: "" }) as never;
    try {
      expect(supportsImages(m("openai", "gpt-5-text-preview"))).toBe(false);
      expect(supportsImages(m("anthropic", "claude-text-only-1"))).toBe(false);
      expect(supportsImages(m("openai", "gpt-5"))).toBe(true);
    } finally {
      setRegistryIndex(null);
    }
  });

  it("adds a per-session prompt cache key for OpenAI", () => {
    const model = { id: "openai:gpt-5", provider: "openai", apiModel: "gpt-5", name: "GPT-5" } as never;
    const out = withPromptCacheKey({ providerOptions: { openai: { reasoningEffort: "high" } } }, model, "chat-1");
    expect(out.providerOptions.openai).toEqual({ reasoningEffort: "high", promptCacheKey: "chat-1" });
    const other = { id: "groq:x", provider: "groq", apiModel: "x", name: "x" } as never;
    expect(withPromptCacheKey({}, other, "chat-1")).toEqual({});
  });
});

describe("helpers", () => {
  it("serializes tool calls and clips long results for summaries", () => {
    const text = serializeModelMessages([toolCall("a", "Read"), toolResult("a", "Read", "z".repeat(5000))]);
    expect(text).toContain("[Assistant tool call]: Read(");
    expect(text).toMatch(/\[Tool result Read\]: z+… \[3000 more chars\]/);
  });

  it("prefers a small model from the same provider for helper work", () => {
    const main = { id: "anthropic:claude-opus-4-5", provider: "anthropic", apiModel: "claude-opus-4-5", name: "Opus" } as never;
    expect(pickHelperModel(main, {} as never)).toBe(main);
  });
});
