import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelMessage } from "ai";
import type { ChatTurn } from "@/lib/ai";
import type { ModelInfo } from "@/lib/models";

type Json = Record<string, unknown>;
type ProcessEvent = { kind: "stdout"; line: string } | { kind: "stderr"; line: string } | { kind: "exit"; code: number | null };

const fake = vi.hoisted(() => ({
  starts: [] as Json[],
  sent: [] as Json[],
  stdin: [] as string[],
  registered: [] as Json[],
  killed: [] as string[],
  channels: new Map<string, { onmessage: (e: ProcessEvent) => void }>(),
  current: "",
  /** The kept-alive runs Rust would list after a reload. */
  alive: [] as string[],
  attached: [] as string[],
  /** Answers each JSON-RPC request the client sends to the fake Grok agent. */
  onRpc: (_msg: Json) => {},
}));

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return {
    Channel,
    invoke: async (cmd: string, args: Json) => {
      if (cmd === "agent_cli_start") {
        const request = args.request as Json;
        fake.starts.push(request);
        fake.channels.set(request.runId as string, args.onEvent as { onmessage: (e: ProcessEvent) => void });
        fake.current = request.runId as string;
        return "C:/work";
      }
      if (cmd === "agent_cli_send") {
        // Antigravity's prompt goes to its stdin as plain text.
        let msg: Json;
        try {
          msg = JSON.parse(args.line as string) as Json;
        } catch {
          fake.stdin.push(args.line as string);
          return undefined;
        }
        fake.sent.push(msg);
        queueMicrotask(() => fake.onRpc(msg));
        return undefined;
      }
      if (cmd === "agent_cli_register_mcp") {
        fake.registered.push(args);
        return undefined;
      }
      if (cmd === "agent_cli_kill") {
        fake.killed.push(args.runId as string);
        return true;
      }
      if (cmd === "agent_cli_attach") {
        fake.attached.push(args.runId as string);
        fake.channels.set(args.runId as string, args.onEvent as { onmessage: (e: ProcessEvent) => void });
        fake.current = args.runId as string;
        return undefined;
      }
      if (cmd === "agent_cli_runs") return fake.alive;
      if (cmd === "mcp_bridge_start") return { port: 47823, token: "abc" };
      // The user's own rules in agy's settings.json.
      if (cmd === "agent_cli_antigravity_permissions") return { allow: ["mcp(probe/*)", "mcp(nyxs-chat/*)"], deny: ["run_command(rm)"] };
      if (cmd === "agent_cli_models") return args.cli === "grok" ? "Available models:\n  * grok-4.7 (default)\n  - grok-code-fast-1\n" : "";
      return undefined;
    },
  };
});

const { retryWaitMs, streamGrokCli } = await import("@/lib/grokCli");
const { endAcpChat, resetAcpProcesses, sweepAcpRuns, forgetAcpForReload } = await import("@/lib/acpProcesses");
const { streamCursorCli } = await import("@/lib/cursorCli");
const { streamCodexCli } = await import("@/lib/codexCli");
const { streamDeepseekCli } = await import("@/lib/deepseekCli");
const { streamAntigravityCli } = await import("@/lib/antigravityCli");
const { resetSessionHeadsForTest } = await import("@/lib/claudeCodeHeads");
const { parseDevinCatalog, streamDevinCli } = await import("@/lib/devinCli");
const { parseModelList, parseAntigravityUsage, parseGrokUsage, fetchAgentCliModels, agentCliEffortLevels, cliEffortFor, AgentCliAuthError } = await import(
  "@/lib/agentCli"
);

const emit = (obj: Json, runId = fake.current) => fake.channels.get(runId)!.onmessage({ kind: "stdout", line: JSON.stringify(obj) });
const stderr = (line: string, runId = fake.current) => fake.channels.get(runId)!.onmessage({ kind: "stderr", line });
const exit = (code: number | null, runId = fake.current) => fake.channels.get(runId)!.onmessage({ kind: "exit", code });
const reply = (id: unknown, result: Json) => emit({ jsonrpc: "2.0", id, result });
const update = (u: Json) => emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: u } });

const grokModel: ModelInfo = { id: "grok-cli:default", apiModel: "default", name: "Grok", description: "", provider: "grok-cli" };
const agyModel: ModelInfo = { id: "antigravity-cli:default", apiModel: "default", name: "Antigravity", description: "", provider: "antigravity-cli" };
const userTurn = (content: string): ChatTurn => ({ role: "user", content });

// The page's sessionStorage, which outlives a reload (node has none).
const storage = new Map<string, string>();
vi.stubGlobal("sessionStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

beforeEach(() => {
  fake.starts.length = 0;
  fake.sent.length = 0;
  fake.stdin.length = 0;
  fake.registered.length = 0;
  fake.killed.length = 0;
  fake.alive.length = 0;
  fake.attached.length = 0;
  fake.channels.clear();
  fake.onRpc = () => {};
  resetAcpProcesses();
  resetSessionHeadsForTest();
  storage.clear();
});

describe("parseModelList", () => {
  const ids = (text: string) => parseModelList(text).map((m) => m.id);

  it("reads Antigravity's listing: slug, a tab, its display name", () => {
    // As `agy models` 1.4.7 prints it.
    const listing = "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";
    expect(parseModelList(listing)).toEqual([
      { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
      { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ]);
  });

  it("reads Cursor's listing: slug, a dash, its display name", () => {
    // As `cursor-agent models` (2026.10.22) prints it.
    const listing = "Available models\n\nauto - Auto (default)\ngpt-5.3-codex-high - Codex 5.3 High\ncomposer-2.5 - Composer 2.5\n";
    expect(parseModelList(listing)).toEqual([
      { id: "auto", name: "Auto" },
      { id: "gpt-5.3-codex-high", name: "Codex 5.3 High" },
      { id: "composer-2.5", name: "Composer 2.5" },
    ]);
  });

  it("reads model slugs from a listing, past bullets and headings", () => {
    expect(ids("Available models:\n  * grok-4.7 (default)\n  - grok-code-fast-1\n")).toEqual(["grok-4.7", "grok-code-fast-1"]);
    expect(ids("│ gemini-3-pro │ Gemini 3 Pro │\n│ gemini-3-flash │ Flash │")).toEqual(["gemini-3-pro", "gemini-3-flash"]);
    // Without a session Antigravity lists nothing.
    expect(ids("")).toEqual([]);
  });

  it("reads a JSON listing", () => {
    expect(ids('[{"id":"grok-4.7"},{"id":"grok-mini-2"}]')).toEqual(["grok-4.7", "grok-mini-2"]);
    expect(ids('{"models":["gemini-3-pro"]}')).toEqual(["gemini-3-pro"]);
  });

  it("reads Grok's models from its agent, with their context window and reasoning levels", async () => {
    // As Grok 1.0.70 reports them on initialize.
    fake.onRpc = (msg) => {
      if (msg.method !== "initialize") return;
      reply(msg.id, {
        protocolVersion: 1,
        _meta: {
          modelState: {
            currentModelId: "grok-4.7",
            availableModels: [
              {
                modelId: "grok-4.7",
                name: "Grok 4.7",
                _meta: {
                  totalContextTokens: 256000,
                  supportsReasoningEffort: true,
                  reasoningEfforts: [{ value: "xhigh" }, { value: "high", default: true }, { value: "medium" }, { value: "low" }],
                },
              },
            ],
          },
        },
      });
    };
    const [model] = await fetchAgentCliModels("grok");
    expect(model).toMatchObject({ id: "grok-cli:grok-4.7", name: "Grok 4.7", contextWindow: 256000 });
    expect(agentCliEffortLevels(model)).toEqual(["low", "medium", "high", "extra"]);
    // Max isn't one of its levels: the turn runs at the closest below.
    expect(cliEffortFor(model, "max")).toBe("xhigh");
  });

  it("gives Antigravity's per-level and Claude models no effort, and its plain Gemini low to high", () => {
    const agy = (apiModel: string) => ({ id: `antigravity-cli:${apiModel}`, provider: "antigravity-cli", apiModel }) as never;
    for (const fixed of ["gemini-3.8-flash-high", "gemini-3.8-flash-low", "gpt-oss-120b-medium", "claude-sonnet-4-6", "claude-opus-4-6-thinking"]) {
      expect(agentCliEffortLevels(agy(fixed))).toBeNull();
      expect(cliEffortFor(agy(fixed), "low")).toBeNull();
    }
    expect(agentCliEffortLevels(agy("default"))).toEqual(["low", "medium", "high"]);
    expect(cliEffortFor(agy("gemini-3.8-flash"), "max")).toBe("high");
  });

  it("falls back to `grok models`, and to a stand-in only when nothing is listed", async () => {
    fake.onRpc = (msg) => {
      if (msg.method === "initialize") reply(msg.id, { protocolVersion: 1 });
    };
    const models = await fetchAgentCliModels("grok");
    expect(models.map((m) => m.apiModel)).toEqual(["grok-4.7", "grok-code-fast-1"]);
    expect(models.every((m) => m.provider === "grok-cli")).toBe(true);
    // Antigravity without a session prints nothing (the fake answers nothing for it).
    expect((await fetchAgentCliModels("antigravity")).map((m) => m.apiModel)).toEqual(["default"]);
  });
});

describe("parseAntigravityUsage", () => {
  it("reads each model group's weekly limit as percent used", () => {
    // As `agy -p /usage --output-format json` (1.4.7) answers.
    const answer = JSON.stringify({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            { name: "Gemini Models", buckets: [{ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.8905143737792969, reset_time: "2026-10-28T15:25:00Z" }] },
            { name: "Claude and GPT models", buckets: [{ id: "3p-weekly", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-31T22:28:21Z" }] },
          ],
        },
      },
    });
    expect(parseAntigravityUsage(answer)).toEqual({
      subscription: null,
      limits: [
        { kind: "model", model: "Gemini Models", utilization: 11, resetsAt: "2026-10-28T15:25:00Z" },
        { kind: "model", model: "Claude and GPT models", utilization: 0, resetsAt: "2026-10-31T22:28:21Z" },
      ],
    });
    expect(parseAntigravityUsage("not json")).toBeNull();
  });
});

describe("parseGrokUsage", () => {
  const period = { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-22T00:00:00+00:00", end: "2026-10-29T00:00:00+00:00" };

  it("reads the Grok Build share of the billing period", () => {
    const answer = JSON.stringify({
      config: { currentPeriod: period, creditUsagePercent: 40, productUsage: [{ product: "GrokChat", usagePercent: 30 }, { product: "GrokBuild", usagePercent: 12.6 }] },
    });
    expect(parseGrokUsage(answer)).toEqual({ subscription: null, limits: [{ kind: "weekly", utilization: 13, resetsAt: period.end }] });
  });

  it("falls back to the blended share, and to nothing when the account reports none", () => {
    const monthly = { ...period, type: "USAGE_PERIOD_TYPE_MONTHLY" };
    expect(parseGrokUsage(JSON.stringify({ config: { currentPeriod: monthly, creditUsagePercent: 55 } }))?.limits).toEqual([
      { kind: "period", utilization: 55, resetsAt: period.end },
    ]);
    // As a free account's billing answers: a period, no share.
    expect(parseGrokUsage(JSON.stringify({ config: { currentPeriod: period, billingPeriodEnd: period.end } }))).toBeNull();
    expect(parseGrokUsage("not json")).toBeNull();
  });
});

describe("Grok CLI over ACP", () => {
  /** A Grok agent that answers the handshake and runs `onPrompt` for the prompt. */
  const agent = (onPrompt: (id: unknown, params: Json) => void, opts: { loadSession?: boolean; authFails?: boolean } = {}) => {
    fake.onRpc = (msg) => {
      if (msg.method === "initialize") {
        reply(msg.id, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: !!opts.loadSession, promptCapabilities: { image: true } },
          authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }],
        });
      } else if (msg.method === "authenticate") {
        if (opts.authFails) emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Authentication required" } });
        else reply(msg.id, {});
      } else if (msg.method === "session/new") {
        reply(msg.id, { sessionId: "s1", modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }] } });
      } else if (msg.method === "session/load") {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old reply, replayed" } });
        reply(msg.id, { modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }] } });
      } else if (msg.method === "session/set_mode") {
        reply(msg.id, {});
      } else if (msg.method === "session/prompt") {
        onPrompt(msg.id, msg.params as Json);
      }
    };
  };

  it("streams the reply, asks the chat's permission rules before a tool, and keeps the session", async () => {
    const gate = vi.fn(async () => true);
    const chunks: string[] = [];
    const saved: ModelMessage[] = [];
    const tools: Json[] = [];
    agent((id) => {
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Running " } });
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "npm test", kind: "execute", status: "pending", rawInput: { command: "npm test" } });
      emit({
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: {
          sessionId: "s1",
          toolCall: { toolCallId: "t1", title: "npm test", kind: "execute", rawInput: { command: "npm test" } },
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      setTimeout(() => {
        update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tests." } });
        reply(id, { stopReason: "end_turn" });
      }, 10);
    });

    const full = await streamGrokCli({
      model: grokModel,
      history: [userTurn("run the tests")],
      workspace: "C:/work",
      planMode: false,
      effort: "medium",
      gate,
      onChunk: (t) => chunks.push(t),
      onTool: (_id, d) => tools.push(d as unknown as Json),
      onMessages: (m) => saved.push(...m),
    });

    expect(fake.starts[0]).toMatchObject({ cli: "grok", args: ["agent", "--reasoning-effort", "medium", "stdio"], cwd: "C:/work" });
    // Grok answers "Invalid params" to an initialize without a client version.
    expect((fake.sent.find((m) => m.method === "initialize")?.params as Json).clientInfo).toMatchObject({ version: expect.any(String) });
    expect(fake.sent.find((m) => m.method === "authenticate")?.params).toMatchObject({ methodId: "cached_token" });
    expect(fake.sent.find((m) => m.method === "session/new")?.params).toMatchObject({ cwd: "C:/work" });
    expect(gate).toHaveBeenCalledWith("Bash", expect.objectContaining({ command: "npm test" }));
    expect(fake.sent.find((m) => m.id === 99)).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "yes" } } });
    expect(full).toContain("⟦REASONING⟧");
    expect(full).toContain("⟦TOOL⟧t1⟦SEP⟧Bash");
    expect(full).toContain("⟦TOOLEND⟧t1⟦SEP⟧ok");
    expect(chunks.join("")).toContain("Running ");
    expect(chunks.join("")).toContain("tests.");
    expect(saved[0]).toMatchObject({ providerOptions: { grokCli: { sessionId: "s1" } } });
    expect(fake.killed).toContain(fake.starts[0].runId);
  });

  it("rejects a tool the user denies", async () => {
    agent((id) => {
      emit({
        jsonrpc: "2.0",
        id: 7,
        method: "session/request_permission",
        params: {
          sessionId: "s1",
          toolCall: { toolCallId: "t2", title: "Edit a.ts", kind: "edit", locations: [{ path: "C:/work/a.ts" }] },
          options: [
            { optionId: "yes", kind: "allow_once" },
            { optionId: "no", kind: "reject_once" },
          ],
        },
      });
      setTimeout(() => reply(id, { stopReason: "end_turn" }), 10);
    });
    const gate = vi.fn(async () => false);
    await streamGrokCli({ model: grokModel, history: [userTurn("edit")], planMode: false, effort: "medium", gate, onChunk: () => {} });
    expect(gate).toHaveBeenCalledWith("Edit", expect.objectContaining({ file_path: "C:/work/a.ts" }));
    expect(fake.sent.find((m) => m.id === 7)).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "no" } } });
  });

  it("reloads the chat's session on the next turn without replaying its history", async () => {
    const chunks: string[] = [];
    agent((id) => {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new reply" } });
      reply(id, { stopReason: "end_turn" });
    }, { loadSession: true });
    const earlier: ChatTurn = {
      role: "assistant",
      content: "old reply",
      messages: [{ role: "assistant", content: [{ type: "text", text: "old reply" }], providerOptions: { grokCli: { sessionId: "s1" } } }],
    };
    await streamGrokCli({
      model: grokModel,
      history: [userTurn("first"), earlier, userTurn("second")],
      planMode: true,
      effort: "medium",
      onChunk: (t) => chunks.push(t),
    });
    expect(fake.sent.find((m) => m.method === "session/load")?.params).toMatchObject({ sessionId: "s1" });
    expect(fake.sent.some((m) => m.method === "session/new")).toBe(false);
    expect(fake.sent.find((m) => m.method === "session/set_mode")?.params).toMatchObject({ modeId: "plan" });
    expect(chunks.join("")).toBe("new reply");
    const prompt = fake.sent.find((m) => m.method === "session/prompt")?.params as Json;
    expect(JSON.stringify(prompt.prompt)).not.toContain("earlier_conversation");
  });

  it("shows Grok's retries as waiting, until the turn goes on", async () => {
    // As Grok 1.x sends them on the free plan (`_x.ai/session/update`).
    const xai = (u: Json) => emit({ jsonrpc: "2.0", method: "_x.ai/session/update", params: { sessionId: "s1", update: { sessionUpdate: "retry_state", ...u } } });
    const retries: unknown[] = [];
    agent((id) => {
      xai({ type: "retrying", attempt: 1, max_retries: 15, reason: "API error (status 429 Too Many Requests): You are sending requests too quickly.", error_type: "rate_limited" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } });
      xai({ type: "retrying", attempt: 2, max_retries: 15, reason: "API error (status 503): overloaded, retry after 30s", error_type: "server_error" });
      xai({ type: "exhausted", attempts: 3, reason: "gave up", is_rate_limited: false });
      reply(id, { stopReason: "end_turn" });
    });
    await streamGrokCli({ model: grokModel, history: [userTurn("hi")], planMode: false, effort: "medium", onChunk: () => {}, onRetrying: (r) => retries.push(r) });
    expect(retries).toEqual([{ rateLimited: true }, null, { rateLimited: false, waitMs: 30_000 }, null]);
  });

  it("keeps a sub-agent's session out of the reply", async () => {
    const child = (u: Json) => emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "c1", update: u } });
    agent((id) => {
      emit({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId: "s1", update: { sessionUpdate: "subagent_spawned", subagent_id: "c1", child_session_id: "c1", description: "Look around" } } });
      child({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child text" } });
      child({ sessionUpdate: "tool_call", toolCallId: "ct1", title: "ls", kind: "execute", status: "pending", rawInput: { command: "ls" } });
      emit({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId: "s1", update: { sessionUpdate: "subagent_finished", subagent_id: "c1", child_session_id: "c1", status: "completed" } } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Parent done." } });
      reply(id, { stopReason: "end_turn" });
    });
    const full = await streamGrokCli({ model: grokModel, history: [userTurn("go")], planMode: false, effort: "medium", onChunk: () => {} });
    expect(full).toBe("Parent done.");
  });

  it("reads how long Grok waits before its next try, when it says", () => {
    expect(retryWaitMs({ retry_after_secs: 12 })).toBe(12_000);
    expect(retryWaitMs({ reason: "Rate limit reached. Please try again in 2 minutes." })).toBe(120_000);
    expect(retryWaitMs({ reason: "retry after 1500ms" })).toBe(1500);
    expect(retryWaitMs({ reason: "Usage resets over a rolling 24-hour window" })).toBeUndefined();
  });

  describe("Nyxs' guide, which a session keeps from its start", () => {
    // `at`: the turn the session's head is at, so only the guide decides.
    const earlierWith = (guide?: string, at?: unknown): ChatTurn => ({
      role: "assistant",
      content: "old reply",
      messages: [{ role: "assistant", content: [{ type: "text", text: "old reply" }], providerOptions: { grokCli: { sessionId: "s1", ...(guide ? { guide } : {}), ...(typeof at === "string" ? { at } : {}) } } }],
    });
    const turnWith = async (earlier: ChatTurn) => {
      const saved: ModelMessage[] = [];
      agent((id) => reply(id, { stopReason: "end_turn" }), { loadSession: true });
      await streamGrokCli({ model: grokModel, history: [userTurn("first"), earlier, userTurn("second")], planMode: false, effort: "medium", onChunk: () => {}, onMessages: (m) => saved.push(...m) });
      const opts = (saved[0] as { providerOptions: Record<string, Json> }).providerOptions.grokCli;
      return { methods: fake.sent.map((m) => m.method), opts, prompt: JSON.stringify((fake.sent.find((m) => m.method === "session/prompt")?.params as Json).prompt) };
    };

    it("starts a new session, given the chat so far, when the guide changed since the session began", async () => {
      const { methods, opts, prompt } = await turnWith(earlierWith("an-older-guide"));
      expect(methods).not.toContain("session/load");
      const created = fake.sent.find((m) => m.method === "session/new")!.params as Json;
      expect(JSON.stringify(created._meta)).toContain("Visuals in the chat");
      expect(prompt).toContain("earlier_conversation");
      expect(prompt).toContain("old reply");
      // The new session records the guide it got.
      expect(opts.guide).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
      expect(opts.guide).not.toBe("an-older-guide");
    });

    it("continues the session when its guide is the same, and keeps an older session's as it is", async () => {
      const first = await turnWith(earlierWith("an-older-guide"));
      fake.sent.length = 0;
      const same = await turnWith(earlierWith(first.opts.guide as string, first.opts.at));
      expect(same.methods).toContain("session/load");
      expect(same.methods).not.toContain("session/new");
      expect(same.opts.guide).toBe(first.opts.guide);
      fake.sent.length = 0;
      // From before guides were recorded: nothing to compare, so it isn't thrown away.
      const legacy = await turnWith(earlierWith(undefined, same.opts.at));
      expect(legacy.methods).toContain("session/load");
      expect(legacy.opts.guide).toBeUndefined();
    });
  });

  describe("its process, kept for the chat's next turn", () => {
    /** One turn in `chat` after `history`; returns the history with the reply that carries
     *  the session, as the chat keeps it. */
    const turn = async (chat: string, history: ChatTurn[], text: string, over: Partial<Parameters<typeof streamGrokCli>[0]> = {}) => {
      const saved: ModelMessage[] = [];
      await streamGrokCli({ model: grokModel, history: [...history, userTurn(text)], planMode: false, effort: "medium", chatKey: chat, onChunk: () => {}, onMessages: (m) => saved.push(...m), ...over });
      return [...history, userTurn(text), { role: "assistant", content: "ok", messages: saved } as ChatTurn];
    };
    const methods = () => fake.sent.map((m) => m.method);
    const answering = () => agent((id) => reply(id, { stopReason: "end_turn" }), { loadSession: true });

    it("prompts the same process and session again, without starting or reloading it", async () => {
      answering();
      const first = await turn("chat-k", [], "one");
      expect(methods()).toEqual(["initialize", "authenticate", "session/new", "session/prompt"]);
      fake.sent.length = 0;
      await turn("chat-k", first, "two");
      expect(fake.starts).toHaveLength(1);
      expect(methods()).toEqual(["session/prompt"]);
      expect(fake.killed).toEqual([]);
    });

    it("leaves plan mode again on the next turn that isn't planning", async () => {
      answering();
      const first = await turn("chat-p", [], "plan it", { planMode: true });
      fake.sent.length = 0;
      await turn("chat-p", first, "do it");
      expect(fake.sent.filter((m) => m.method === "session/set_mode").map((m) => (m.params as Json).modeId)).toEqual(["default"]);
    });

    it("starts another process when the chat's settings changed, and stops the old one", async () => {
      answering();
      const first = await turn("chat-m", [], "one");
      const old = fake.current;
      await turn("chat-m", first, "two", { model: { ...grokModel, apiModel: "grok-4.7" } });
      expect(fake.starts).toHaveLength(2);
      expect(fake.killed).toEqual([old]);
    });

    it("stops a process whose turn failed", async () => {
      agent((id) => emit({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom" } }), { loadSession: true });
      await expect(turn("chat-f", [], "one")).rejects.toThrow("boom");
      expect(fake.killed).toEqual([fake.current]);
    });

    it("closes on /clear or delete: a parked one now, a busy one when its turn ends", async () => {
      answering();
      await turn("chat-c", [], "one");
      endAcpChat("chat-c");
      expect(fake.killed).toEqual([fake.current]);
      // Cleared while the turn runs: the process goes once it's over.
      fake.killed.length = 0;
      fake.sent.length = 0;
      let finish: () => void = () => undefined;
      agent((id) => {
        finish = () => reply(id, { stopReason: "end_turn" });
      }, { loadSession: true });
      const running = turn("chat-c", [], "two");
      await vi.waitFor(() => expect(methods()).toContain("session/prompt"));
      endAcpChat("chat-c");
      expect(fake.killed).toEqual([]);
      finish();
      await running;
      expect(fake.killed).toEqual([fake.current]);
    });

    it("is picked up again after a reload of the page, and one cut mid-turn is stopped", async () => {
      answering();
      const first = await turn("chat-r", [], "one");
      const kept = fake.current;
      fake.alive.push(kept, "grok-cut-mid-turn");
      forgetAcpForReload();
      await sweepAcpRuns();
      expect(fake.killed).toEqual(["grok-cut-mid-turn"]);
      fake.sent.length = 0;
      await turn("chat-r", first, "two");
      expect(fake.attached).toEqual([kept]);
      expect(fake.starts).toHaveLength(1);
      expect(methods()).toEqual(["session/prompt"]);
    });
  });

  it("says when the CLI isn't signed in", async () => {
    agent(() => {}, { authFails: true });
    await expect(
      streamGrokCli({ model: grokModel, history: [userTurn("hi")], planMode: false, effort: "medium", onChunk: () => {} }),
    ).rejects.toBeInstanceOf(AgentCliAuthError);
  });

  it("starts a session with Nyxs' guide as its rules and serves its questions and plan review", async () => {
    const { handleChatMcp } = await import("@/lib/chatMcp");
    const gate = vi.fn(async () => true);
    const askUser = vi.fn(async () => [{ question: "Which DB?", answer: "Postgres" }]);
    const plans: string[] = [];
    let listed: Json = {};
    let asked: Json = {};
    fake.onRpc = (msg) => {
      if (msg.method === "initialize") {
        reply(msg.id, { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] });
      } else if (msg.method === "session/new") {
        reply(msg.id, { sessionId: "s1", modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }] } });
      } else if (msg.method === "session/set_mode") {
        reply(msg.id, {});
      } else if (msg.method === "session/prompt") {
        void (async () => {
          // Grok asks before an MCP tool; Nyxs' own chat tools need no prompt of the user's.
          emit({
            jsonrpc: "2.0",
            id: 41,
            method: "session/request_permission",
            params: {
              sessionId: "s1",
              toolCall: { toolCallId: "t9", kind: "other", rawInput: { variant: "UseTool", tool_name: "nyxs-chat__ask_user_question", tool_input: {} } },
              options: [
                { optionId: "yes", kind: "allow_once" },
                { optionId: "no", kind: "reject_once" },
              ],
            },
          });
          // The calls come in over the bridge, with the chat in their address.
          listed = (await handleChatMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "chat-g")).result as Json;
          asked = await handleChatMcp(
            { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_user_question", arguments: { questions: [{ question: "Which DB?", header: "DB", options: ["Postgres", "SQLite"] }] } } },
            "chat-g",
          );
          await handleChatMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "exit_plan_mode", arguments: { plan: "1. Migrate" } } }, "chat-g");
          reply(msg.id, { stopReason: "end_turn" });
        })();
      }
    };

    const full = await streamGrokCli({
      model: grokModel,
      history: [userTurn("plan the migration")],
      workspace: "C:/work",
      chatKey: "chat-g",
      planMode: true,
      effort: "medium",
      gate,
      askUser,
      onPlan: (p) => plans.push(p),
      onChunk: () => {},
    });

    const created = fake.sent.find((m) => m.method === "session/new")?.params as Json;
    const rules = String((created._meta as Json).rules);
    expect(rules).toContain("# Visuals in the chat");
    // Grok calls an MCP tool as `server__tool`.
    expect(rules).toContain("`nyxs-browser__navigate`");
    expect(rules).toContain("`nyxs-chat__ask_user_question`");
    expect((created.mcpServers as Json[]).find((s) => s.name === "nyxs-chat")).toMatchObject({ type: "http", url: "http://127.0.0.1:47823/mcp/nyxs-chat/chat-g" });
    expect(fake.sent.find((m) => m.id === 41)).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "yes" } } });
    expect(gate).not.toHaveBeenCalled();
    expect((listed.tools as Json[]).map((t) => t.name)).toEqual(["ask_user_question", "exit_plan_mode"]);
    expect(askUser).toHaveBeenCalledWith([expect.objectContaining({ question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] })]);
    expect(JSON.stringify(asked)).toContain("A: Postgres");
    expect(plans).toEqual(["1. Migrate"]);
    expect(full).toContain("⟦PLAN⟧");
  });

  it("doesn't send the guide again when it reloads the session", async () => {
    agent((id) => reply(id, { stopReason: "end_turn" }), { loadSession: true });
    const earlier: ChatTurn = {
      role: "assistant",
      content: "x",
      messages: [{ role: "assistant", content: [{ type: "text", text: "x" }], providerOptions: { grokCli: { sessionId: "s1" } } }],
    };
    await streamGrokCli({ model: grokModel, history: [userTurn("a"), earlier, userTurn("b")], planMode: false, effort: "medium", onChunk: () => {} });
    expect(fake.sent.find((m) => m.method === "session/load")?.params).not.toHaveProperty("_meta");
  });
});

describe("Cursor CLI over ACP", () => {
  const cursorModel: ModelInfo = { id: "cursor-cli:auto", apiModel: "auto", name: "Auto", description: "", provider: "cursor-cli" };

  /** A Cursor agent: answers the handshake and runs `onPrompt` for the prompt. */
  const cursorAgent = (onPrompt: (id: unknown) => void) => {
    fake.onRpc = (msg) => {
      if (msg.method === "initialize") reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "cursor_login" }] });
      else if (msg.method === "authenticate") reply(msg.id, {});
      else if (msg.method === "session/new") reply(msg.id, { sessionId: "c1" });
      else if (msg.method === "session/cancel") emit({ jsonrpc: "2.0", id: 500, result: { stopReason: "cancelled" } });
      else if (msg.method === "session/prompt") onPrompt(msg.id);
    };
  };

  it("runs `cursor-agent [--model] acp`, signs in with its login and asks Nyxs' questions", async () => {
    const askUser = vi.fn(async () => [{ question: "Which mode?", answer: "Plan" }]);
    const todos: unknown[] = [];
    cursorAgent((id) => {
      emit({ jsonrpc: "2.0", method: "cursor/update_todos", params: { todos: [{ id: "1", content: "Read the code", status: "in_progress" }], merge: true } });
      emit({
        jsonrpc: "2.0",
        id: 41,
        method: "cursor/ask_question",
        params: { toolCallId: "q", title: "Need input", questions: [{ id: "q1", prompt: "Which mode?", options: [{ id: "agent", label: "Agent" }, { id: "plan", label: "Plan" }] }] },
      });
      setTimeout(() => {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
        reply(id, { stopReason: "end_turn" });
      }, 10);
    });
    const full = await streamCursorCli({ model: cursorModel, history: [userTurn("hi")], planMode: false, effort: "medium", askUser, onTodos: (t) => todos.push(t), onChunk: () => {} });
    expect(fake.starts[0]).toMatchObject({ cli: "cursor", args: ["--model", "auto", "acp"] });
    expect(fake.sent.find((m) => m.method === "authenticate")?.params).toMatchObject({ methodId: "cursor_login" });
    expect(askUser).toHaveBeenCalledWith([expect.objectContaining({ question: "Which mode?", options: [{ label: "Agent" }, { label: "Plan" }] })]);
    expect(fake.sent.find((m) => m.id === 41)).toMatchObject({
      result: { outcome: { outcome: "answered", answers: [{ questionId: "q1", selectedOptionIds: ["plan"] }] } },
    });
    expect(todos[0]).toEqual([{ content: "Read the code", status: "in_progress" }]);
    expect(full).toContain("ok");
  });

  it("shows a plan handed over for approval and ends the turn there, as Nyxs' plan mode does", async () => {
    const plans: string[] = [];
    cursorAgent((id) => {
      emit({ jsonrpc: "2.0", id: 42, method: "cursor/create_plan", params: { toolCallId: "p", plan: "1. Do it", todos: [] } });
      fake.onRpc = (msg) => {
        if (msg.method === "session/cancel") reply(id, { stopReason: "cancelled" });
      };
    });
    const full = await streamCursorCli({ model: cursorModel, history: [userTurn("plan it")], planMode: true, effort: "medium", onPlan: (p) => plans.push(p), onChunk: () => {} });
    expect(plans).toEqual(["1. Do it"]);
    expect(full).toContain("⟦PLAN⟧");
    expect(fake.sent.some((m) => m.method === "session/cancel")).toBe(true);
  });

  it("picks an option whose label has a comma, and sends what was typed besides as text", async () => {
    const askUser = vi.fn(async () => [{ question: "Deploy?", answer: "Yes, now, but to staging" }]);
    cursorAgent((id) => {
      emit({
        jsonrpc: "2.0",
        id: 45,
        method: "cursor/ask_question",
        params: { toolCallId: "q", title: "Deploy", questions: [{ id: "q1", prompt: "Deploy?", allowMultiple: true, options: [{ id: "now", label: "Yes, now" }, { id: "later", label: "Later" }] }] },
      });
      setTimeout(() => reply(id, { stopReason: "end_turn" }), 10);
    });
    await streamCursorCli({ model: cursorModel, history: [userTurn("deploy")], planMode: false, effort: "medium", askUser, onChunk: () => {} });
    expect(fake.sent.find((m) => m.id === 45)).toMatchObject({
      result: { outcome: { outcome: "answered", answers: [{ questionId: "q1", selectedOptionIds: ["now"], text: "but to staging" }] } },
    });
  });

  it("ends the turn with the plan when Cursor exits instead of answering the cancelled prompt", async () => {
    const plans: string[] = [];
    const saved: ModelMessage[] = [];
    cursorAgent(() => {
      emit({ jsonrpc: "2.0", id: 44, method: "cursor/create_plan", params: { toolCallId: "p", plan: "1. Do it", todos: [] } });
      fake.onRpc = (msg) => {
        if (msg.method === "session/cancel") setTimeout(() => exit(1), 5);
      };
    });
    const full = await streamCursorCli({
      model: cursorModel,
      history: [userTurn("plan it")],
      planMode: true,
      effort: "medium",
      onPlan: (p) => plans.push(p),
      onMessages: (m) => saved.push(...m),
      onChunk: () => {},
    });
    expect(plans).toEqual(["1. Do it"]);
    expect(full).toContain("⟦PLAN⟧");
    // The session is kept, so the next message can say whether to go ahead.
    expect(saved[0]).toMatchObject({ providerOptions: { cursorCli: { sessionId: "c1" } } });
  });

  it("takes the todo list when Cursor sends it as a request, and answers it", async () => {
    const todos: unknown[] = [];
    cursorAgent((id) => {
      emit({ jsonrpc: "2.0", id: 43, method: "cursor/update_todos", params: { todos: [{ id: "1", content: "Write the test", status: "completed" }], merge: false } });
      setTimeout(() => reply(id, { stopReason: "end_turn" }), 10);
    });
    await streamCursorCli({ model: cursorModel, history: [userTurn("go")], planMode: false, effort: "medium", onTodos: (t) => todos.push(t), onChunk: () => {} });
    expect(todos).toEqual([[{ content: "Write the test", status: "completed" }]]);
    expect(fake.sent.find((m) => m.id === 43)).toMatchObject({ result: {} });
    expect(fake.sent.find((m) => m.id === 43)).not.toHaveProperty("error");
  });
});

describe("Codex CLI through its app-server", () => {
  const codexModel: ModelInfo = { id: "codex-cli:gpt-6.1-sol", apiModel: "gpt-6.1-sol", name: "GPT-6.1-Sol", description: "", provider: "codex-cli", effortLevels: ["low", "medium", "high", "xhigh"] };
  // Codex's app-server leaves out the "jsonrpc" field.
  const answer = (id: unknown, result: Json) => emit({ id, result });
  const note = (method: string, params: Json) => emit({ method, params: { threadId: "th1", turnId: "tu1", ...params } });

  const appServer = (opts: { account?: Json | null; onTurn: (id: unknown) => void }) => {
    fake.onRpc = (msg) => {
      if (msg.method === "initialize") answer(msg.id, { userAgent: "codex" });
      else if (msg.method === "account/read") answer(msg.id, { account: opts.account === undefined ? { type: "chatgpt", email: "a@b.c", planType: "plus" } : opts.account, requiresOpenaiAuth: true });
      else if (msg.method === "thread/start") answer(msg.id, { thread: { id: "th1" } });
      else if (msg.method === "thread/resume") answer(msg.id, { thread: { id: String((msg.params as Json).threadId) } });
      else if (msg.method === "turn/start") {
        answer(msg.id, { turn: { id: "tu1", status: "inProgress", items: [] } });
        opts.onTurn(msg.id);
      }
    };
  };

  it("streams the reply, asks the chat's permission rules before a command, and keeps the thread", async () => {
    const gate = vi.fn(async () => true);
    const saved: ModelMessage[] = [];
    appServer({
      onTurn: () => {
        note("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "thinking", summaryIndex: 0 });
        note("item/started", { item: { id: "c1", type: "commandExecution", command: "npm test", cwd: "C:/work", status: "inProgress", commandActions: [] } });
        emit({ id: 70, method: "item/commandExecution/requestApproval", params: { itemId: "c1", threadId: "th1", turnId: "tu1", command: "npm test" } });
        setTimeout(() => {
          note("item/completed", { item: { id: "c1", type: "commandExecution", command: "npm test", status: "completed", exitCode: 0, aggregatedOutput: "ok", commandActions: [] } });
          note("item/agentMessage/delta", { itemId: "m1", delta: "Tests pass." });
          note("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 900, cachedInputTokens: 600, outputTokens: 40, reasoningOutputTokens: 0, totalTokens: 940 }, total: {} } });
          note("turn/completed", { turn: { id: "tu1", status: "completed", items: [] } });
        }, 10);
      },
    });
    const full = await streamCodexCli({ model: codexModel, history: [userTurn("run the tests")], workspace: "C:/work", planMode: false, permissionMode: "auto", effort: "max", gate, onChunk: () => {}, onMessages: (m) => saved.push(...m) });
    expect(fake.starts[0]).toMatchObject({ cli: "codex", args: ["app-server"] });
    // No "jsonrpc" on the wire, and the initialized notification after initialize.
    expect(fake.sent.every((m) => !("jsonrpc" in m))).toBe(true);
    expect(fake.sent.map((m) => m.method).slice(0, 3)).toEqual(["initialize", "initialized", "account/read"]);
    expect(fake.sent.find((m) => m.method === "thread/start")?.params).toMatchObject({ cwd: "C:/work", model: "gpt-6.1-sol", approvalPolicy: "on-request", sandbox: "workspace-write" });
    // Max isn't one of the model's levels: the closest below.
    expect(fake.sent.find((m) => m.method === "turn/start")?.params).toMatchObject({ threadId: "th1", effort: "xhigh" });
    expect(gate).toHaveBeenCalledWith("Bash", expect.objectContaining({ command: "npm test" }));
    expect(fake.sent.find((m) => m.id === 70)).toMatchObject({ result: { decision: "accept" } });
    expect(full).toContain("⟦TOOL⟧c1⟦SEP⟧Bash");
    expect(full).toContain("⟦TOOLEND⟧c1⟦SEP⟧ok");
    expect(full).toContain("Tests pass.");
    expect(saved[0]).toMatchObject({ providerOptions: { codexCli: { sessionId: "th1" } } });
  });

  it("resumes the chat's thread and answers Codex's questions with Nyxs' own", async () => {
    const askUser = vi.fn(async () => [{ question: "Which DB?", answer: "Postgres" }]);
    appServer({
      onTurn: () => {
        emit({ id: 71, method: "item/tool/requestUserInput", params: { itemId: "q", threadId: "th9", turnId: "tu1", isBlocking: true, questions: [{ id: "db", header: "Database", question: "Which DB?", options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }] }] } });
        setTimeout(() => note("turn/completed", { turn: { id: "tu1", status: "completed", items: [] } }), 10);
      },
    });
    const earlier: ChatTurn = {
      role: "assistant",
      content: "x",
      messages: [{ role: "assistant", content: [{ type: "text", text: "x" }], providerOptions: { codexCli: { sessionId: "th9" } } }],
    };
    await streamCodexCli({ model: codexModel, history: [userTurn("a"), earlier, userTurn("b")], planMode: false, effort: "medium", askUser, onChunk: () => {} });
    expect(fake.sent.find((m) => m.method === "thread/resume")?.params).toMatchObject({ threadId: "th9" });
    expect(fake.sent.some((m) => m.method === "thread/start")).toBe(false);
    expect(fake.sent.find((m) => m.id === 71)).toMatchObject({ result: { answers: { db: { answers: ["Postgres"] } } } });
  });

  it("answers with an option whose label has a comma as that one option", async () => {
    const askUser = vi.fn(async () => [{ question: "Go on?", answer: "Yes, continue" }]);
    appServer({
      onTurn: () => {
        emit({ id: 72, method: "item/tool/requestUserInput", params: { itemId: "q", threadId: "th1", turnId: "tu1", isBlocking: true, questions: [{ id: "go", header: "Go", question: "Go on?", options: [{ label: "Yes, continue", description: "" }, { label: "No", description: "" }] }] } });
        setTimeout(() => note("turn/completed", { turn: { id: "tu1", status: "completed", items: [] } }), 10);
      },
    });
    await streamCodexCli({ model: codexModel, history: [userTurn("go")], planMode: false, effort: "medium", askUser, onChunk: () => {} });
    expect(fake.sent.find((m) => m.id === 72)).toMatchObject({ result: { answers: { go: { answers: ["Yes, continue"] } } } });
  });

  it("counts the usage of every model call in the turn, not just the last one", async () => {
    const usage = (last: Json, total: Json) => note("thread/tokenUsage/updated", { tokenUsage: { last, total } });
    appServer({
      onTurn: () => {
        // The thread had used 5000 in, 3000 cached, 500 out before this turn; the turn makes two calls.
        usage({ inputTokens: 900, cachedInputTokens: 600, outputTokens: 40 }, { inputTokens: 5900, cachedInputTokens: 3600, outputTokens: 540 });
        usage({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 60 }, { inputTokens: 6900, cachedInputTokens: 4400, outputTokens: 600 });
        setTimeout(() => note("turn/completed", { turn: { id: "tu1", status: "completed", items: [] } }), 10);
      },
    });
    const onUsage = vi.fn();
    const onCacheStats = vi.fn();
    const onContext = vi.fn();
    await streamCodexCli({ model: codexModel, history: [userTurn("go")], planMode: false, effort: "medium", onUsage, onCacheStats, onContext, onChunk: () => {} });
    expect(onUsage).toHaveBeenCalledWith(100);
    expect(onCacheStats).toHaveBeenCalledWith({ readTokens: 1400, creationTokens: 0, inputTokens: 1900, outputTokens: 100 });
    // The context is what the last call sent.
    expect(onContext).toHaveBeenLastCalledWith(1000);
  });

  it("says when Codex isn't signed in", async () => {
    appServer({ account: null, onTurn: () => {} });
    await expect(streamCodexCli({ model: codexModel, history: [userTurn("hi")], planMode: false, effort: "medium", onChunk: () => {} })).rejects.toBeInstanceOf(AgentCliAuthError);
  });

  it("keeps a sub-agent's thread out of the reply, and its turn's end from ending the turn", async () => {
    const spawn = { id: "sp1", type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: "th1", prompt: "Count the files", agentsStates: {} };
    appServer({
      onTurn: () => {
        note("item/started", { item: { ...spawn, status: "inProgress", receiverThreadIds: [] } });
        note("item/completed", { item: { ...spawn, status: "completed", receiverThreadIds: ["th2"], agentsStates: { th2: { status: "running", message: null } } } });
        // `turn/completed` names no turnId, only the thread.
        emit({ method: "turn/started", params: { threadId: "th2", turn: { id: "tu2", status: "inProgress", items: [] } } });
        emit({ method: "item/agentMessage/delta", params: { threadId: "th2", turnId: "tu2", itemId: "m2", delta: "child says 3" } });
        emit({ method: "turn/completed", params: { threadId: "th2", turn: { id: "tu2", status: "completed", items: [] } } });
        setTimeout(() => {
          note("item/agentMessage/delta", { itemId: "m1", delta: "There are 3." });
          note("turn/completed", { turn: { id: "tu1", status: "completed", items: [] } });
        }, 10);
      },
    });
    const full = await streamCodexCli({ model: codexModel, history: [userTurn("count")], planMode: false, effort: "medium", onChunk: () => {} });
    expect(full).toContain("There are 3.");
    expect(full).not.toContain("child says");
    expect(full).toContain("⟦TOOL⟧sp1⟦SEP⟧");
  });
});

describe("DeepSeek Harness over ACP", () => {
  const route = '["deepseek-official","deepseek-v4-pro"]';
  const dsModel: ModelInfo = { id: `deepseek-cli:${route}`, apiModel: route, name: "DeepSeek-V4-Pro", description: "", provider: "deepseek-cli" };
  const configOptions = [
    {
      id: "model",
      category: "model",
      type: "select",
      currentValue: '["deepseek-official","deepseek-v4-flash"]',
      options: [{ group: "deepseek-official", name: "DeepSeek", options: [{ value: '["deepseek-official","deepseek-v4-flash"]', name: "deepseek-v4-flash" }, { value: route, name: "DeepSeek-V4-Pro" }] }],
    },
    { id: "reasoning_effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "off" }, { value: "low" }, { value: "high" }, { value: "max" }] },
  ];

  it("runs `dsh acp` on the key Nyxs hands it, picks the model and level, and resumes the session", async () => {
    fake.onRpc = (msg) => {
      // As DeepSeek Harness 0.2.1 answers: no sign-in, resume without replay, HTTP MCP.
      if (msg.method === "initialize") reply(msg.id, { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { resume: {} } }, authMethods: [] });
      else if (msg.method === "session/resume") reply(msg.id, { configOptions });
      else if (msg.method === "session/set_config_option") reply(msg.id, {});
      else if (msg.method === "session/prompt") {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
        reply(msg.id, { stopReason: "end_turn" });
      }
    };
    const earlier: ChatTurn = {
      role: "assistant",
      content: "x",
      messages: [{ role: "assistant", content: [{ type: "text", text: "x" }], providerOptions: { deepseekCli: { sessionId: "d1" } } }],
    };
    const full = await streamDeepseekCli({
      model: dsModel,
      history: [userTurn("a"), earlier, userTurn("b")],
      planMode: false,
      effort: "extra",
      env: { DEEPSEEK_API_KEY: "sk-test" },
      onChunk: () => {},
    });
    expect(fake.starts[0]).toMatchObject({ cli: "deepseek", args: ["acp"], env: { DEEPSEEK_API_KEY: "sk-test" } });
    expect(fake.sent.some((m) => m.method === "authenticate")).toBe(false);
    expect(fake.sent.find((m) => m.method === "session/resume")?.params).toMatchObject({ sessionId: "d1" });
    const sets = fake.sent.filter((m) => m.method === "session/set_config_option").map((m) => m.params);
    // Extra isn't one of its levels: the closest below, High, is already set.
    expect(sets).toEqual([{ sessionId: "d1", configId: "model", value: route }]);
    expect(full).toContain("ok");
  });

  it("fails the turn rather than run another model when the session doesn't offer the chat's", async () => {
    const gone: ModelInfo = { ...dsModel, apiModel: '["deepseek-official","deepseek-v3"]', name: "DeepSeek-V3" };
    fake.onRpc = (msg) => {
      if (msg.method === "initialize") reply(msg.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
      else if (msg.method === "session/new") reply(msg.id, { sessionId: "d3", configOptions });
      else if (msg.method === "session/set_config_option") reply(msg.id, {});
      else if (msg.method === "session/prompt") reply(msg.id, { stopReason: "end_turn" });
    };
    await expect(streamDeepseekCli({ model: gone, history: [userTurn("hi")], planMode: false, effort: "high", onChunk: () => {} })).rejects.toThrow(
      /DeepSeek-V3/,
    );
    expect(fake.sent.some((m) => m.method === "session/prompt")).toBe(false);
  });

  it("fails the turn when the session refuses to switch to the chat's model", async () => {
    fake.onRpc = (msg) => {
      if (msg.method === "initialize") reply(msg.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
      else if (msg.method === "session/new") reply(msg.id, { sessionId: "d4", configOptions });
      else if (msg.method === "session/set_config_option") emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "model unavailable on this plan" } });
      else if (msg.method === "session/prompt") reply(msg.id, { stopReason: "end_turn" });
    };
    await expect(streamDeepseekCli({ model: dsModel, history: [userTurn("hi")], planMode: false, effort: "high", onChunk: () => {} })).rejects.toThrow(
      /DeepSeek-V4-Pro/,
    );
    expect(fake.sent.some((m) => m.method === "session/prompt")).toBe(false);
  });

  it("names a missing or wrong key as the problem", async () => {
    fake.onRpc = (msg) => {
      if (msg.method === "initialize") reply(msg.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
      else if (msg.method === "session/new") reply(msg.id, { sessionId: "d2" });
      else if (msg.method === "session/prompt") {
        emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: 'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"' } });
      }
    };
    await expect(streamDeepseekCli({ model: dsModel, history: [userTurn("hi")], planMode: false, effort: "high", onChunk: () => {} })).rejects.toBeInstanceOf(AgentCliAuthError);
  });
});

describe("Devin over ACP", () => {
  // As `devin models list --format json` (3000.11) prints a family.
  const catalog = JSON.stringify({
    families: [
      {
        family_uid: "swe-2",
        family_label: "SWE-2",
        variants: [
          { model_uid: "swe-2-medium", label: "SWE-2 Medium" },
          { model_uid: "swe-2-high-fast", label: "SWE-2 High Fast" },
          { model_uid: "swe-2-1m-high", label: "SWE-2 High 1M" },
        ],
      },
    ],
  });

  it("lists one model per group of variants, with the levels they come in", () => {
    const models = parseDevinCatalog(`warning: update available\n${catalog}`);
    expect(models.map((m) => [m.id, m.name, m.apiModel, m.aliases, m.effortLevels])).toEqual([
      ["devin-cli:swe-2", "SWE-2", "swe-2-medium", ["swe-2-high-fast"], ["medium", "high"]],
      ["devin-cli:swe-2-1m", "SWE-2 1M", "swe-2-1m-high", [], ["high"]],
    ]);
    expect(parseDevinCatalog("not json")).toEqual([]);
  });

  it("never opens its browser sign-in, waits for the model the session offers, then sets the level", async () => {
    const [model] = parseDevinCatalog(catalog);
    fake.onRpc = (msg) => {
      // Its only auth method is a browser sign-in; the session starts on the bundled catalog.
      if (msg.method === "initialize") reply(msg.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "devin-browser" }] });
      else if (msg.method === "session/new") {
        reply(msg.id, { sessionId: "v1", configOptions: [{ id: "model", category: "model", currentValue: "adaptive", options: [{ value: "adaptive" }] }] });
        // The account's catalog arrives a moment later, offering the group under another member's id.
        setTimeout(() => update({ sessionUpdate: "config_option_update", configOptions: [{ id: "model", category: "model", currentValue: "adaptive", options: [{ value: "adaptive" }, { value: "swe-2-high-fast" }] }] }), 20);
      } else if (msg.method === "session/set_config_option") {
        const params = msg.params as Json;
        reply(msg.id, params.configId === "model" ? { configOptions: [{ id: "thought_level", category: "thought_level", currentValue: "medium", options: [{ value: "medium" }, { value: "high" }] }] } : {});
      } else if (msg.method === "session/prompt") {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
        reply(msg.id, { stopReason: "end_turn" });
      }
    };
    const full = await streamDevinCli({ model, history: [userTurn("hi")], planMode: false, effort: "max", onChunk: () => {} });
    expect(fake.starts[0]).toMatchObject({ cli: "devin", args: ["acp"] });
    expect(fake.sent.some((m) => m.method === "authenticate")).toBe(false);
    const sets = fake.sent.filter((m) => m.method === "session/set_config_option").map((m) => m.params);
    expect(sets).toEqual([
      { sessionId: "v1", configId: "model", value: "swe-2-high-fast" },
      // Max isn't one of its levels: the closest below.
      { sessionId: "v1", configId: "thought_level", value: "high" },
    ]);
    expect(full).toContain("done");
  });
});

describe("Antigravity CLI in headless mode", () => {
  const started = async () => {
    await vi.waitFor(() => expect(fake.starts.length).toBeGreaterThan(0));
    return fake.starts[fake.starts.length - 1];
  };

  it("streams text and tool steps, and keeps the conversation", async () => {
    const saved: ModelMessage[] = [];
    const stats: Json[] = [];
    const run = streamAntigravityCli({
      model: agyModel,
      history: [userTurn("list the files")],
      workspace: "C:/work",
      chatKey: "chat-a",
      planMode: false,
      permissionMode: "auto",
      effort: "max",
      onChunk: () => {},
      onMessages: (m) => saved.push(...m),
      onCacheStats: (s) => stats.push(s as unknown as Json),
    });
    const start = await started();
    expect(start.args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--dangerously-skip-permissions"]));
    // Its default model stops at high ("has no max effort"): the closest level below is sent.
    expect(start.args).toEqual(expect.arrayContaining(["--effort", "high"]));
    // The prompt goes through stdin, not `-p`.
    expect(start.args).not.toContain("-p");
    await vi.waitFor(() => expect(fake.stdin).toHaveLength(1));
    expect(fake.stdin[0]).toContain("list the files");
    // A new conversation gets Nyxs' guide once: previews, and its browser rather than its own or the shell's.
    expect(fake.stdin[0]).toContain("<nyxs_instructions>");
    expect(fake.stdin[0]).toContain("# Visuals in the chat");
    expect(fake.stdin[0]).toContain("<nyxs_browser>");
    // Nyxs' servers are registered and allowed for this run only (the browser's calls then go
    // through the chat's permission mode, see browserTools.test.ts).
    expect(fake.registered.map((r) => r.name)).toEqual(expect.arrayContaining(["nyxs-browser", "nyxs-chat"]));
    // Their entries name no address (the config is global): the run's environment tells the
    // proxy agy starts which Nyxs and chat it belongs to.
    expect(fake.registered.every((r) => !("url" in r) && r.remove === false)).toBe(true);
    expect(start.env).toEqual({ NYXS_MCP_PORT: "47823", NYXS_MCP_TOKEN: "abc", NYXS_MCP_CHAT: "chat-a" });
    const args = start.args as string[];
    // `--settings` replaces the user's own `permissions`, so they go along too.
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({
      permissions: { allow: ["mcp(probe/*)", "mcp(nyxs-chat/*)", "mcp(nyxs-browser/*)", "mcp(nyxs-video/*)"], deny: ["run_command(rm)"] },
    });
    expect(start.args).not.toContain("--model");
    emit({ event: "init", conversation_id: "c1", init: { cwd: "C:/work" } });
    emit({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Here " } });
    emit({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "dir" } } } });
    emit({ event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "dir" }, output: "a.ts" } } });
    emit({ event: "step_update", step_update: { step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "they are." } });
    emit({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "Here they are.", usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 60 } } });
    exit(0);
    const full = await run;
    expect(full).toContain("Here ");
    expect(full).toContain("⟦TOOL⟧s2⟦SEP⟧Bash⟦SEP⟧dir");
    expect(full).toContain("⟦TOOLEND⟧s2⟦SEP⟧ok");
    expect(saved[0]).toMatchObject({ providerOptions: { antigravityCli: { sessionId: "c1" } } });
    expect(stats[0]).toMatchObject({ inputTokens: 100, outputTokens: 25, readTokens: 60 });
  });

  it("leaves a conversation that began with another guide for a new one with the chat so far", async () => {
    const earlier: ChatTurn = {
      role: "assistant",
      content: "x",
      messages: [{ role: "assistant", content: [{ type: "text", text: "x" }], providerOptions: { antigravityCli: { sessionId: "c9", guide: "an-older-guide" } } }],
    };
    const saved: ModelMessage[] = [];
    const run = streamAntigravityCli({ model: agyModel, history: [userTurn("a"), earlier, userTurn("b")], planMode: false, effort: "low", onChunk: () => {}, onMessages: (m) => saved.push(...m) });
    const start = await started();
    expect(start.args).not.toContain("--conversation");
    await vi.waitFor(() => expect(fake.stdin).toHaveLength(1));
    expect(fake.stdin[0]).toContain("<nyxs_instructions>");
    expect(fake.stdin[0]).toContain("earlier_conversation");
    emit({ event: "result", result: { conversation_id: "c10", status: "SUCCESS", response: "ok" } });
    exit(0);
    await run;
    const opts = (saved[0] as { providerOptions: Record<string, Json> }).providerOptions.antigravityCli;
    expect(opts).toMatchObject({ sessionId: "c10" });
    expect(opts.guide).not.toBe("an-older-guide");
  });

  it("closes a tool still running when the run breaks off as stopped, not failed", async () => {
    const chunks: string[] = [];
    const run = streamAntigravityCli({ model: agyModel, history: [userTurn("go")], planMode: false, permissionMode: "auto", effort: "low", onChunk: (c) => chunks.push(c) });
    await started();
    await vi.waitFor(() => expect(fake.stdin).toHaveLength(1));
    emit({ event: "step_update", step_update: { step_index: 4, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "npm test" } } } });
    emit({ event: "result", result: { status: "ERROR", error: { message: "quota" } } });
    exit(1);
    await expect(run).rejects.toThrow(/quota/);
    expect(chunks.join("")).toContain("⟦TOOLEND⟧s4⟦SEP⟧stop⟦/TOOLEND⟧");
    expect(chunks.join("")).not.toContain("⟦SEP⟧err");
  });

  it("continues the chat's conversation and runs plan mode as the CLI's own", async () => {
    const earlier: ChatTurn = {
      role: "assistant",
      content: "x",
      messages: [{ role: "assistant", content: [{ type: "text", text: "x" }], providerOptions: { antigravityCli: { sessionId: "c9" } } }],
    };
    const run = streamAntigravityCli({
      model: { ...agyModel, apiModel: "gemini-3-pro" },
      history: [userTurn("a"), earlier, userTurn("b")],
      planMode: true,
      effort: "low",
      onChunk: () => {},
    });
    const start = await started();
    expect(start.args).toEqual(expect.arrayContaining(["--conversation", "c9", "--mode", "plan", "--model", "gemini-3-pro"]));
    // The conversation already has the guide.
    await vi.waitFor(() => expect(fake.stdin).toHaveLength(1));
    expect(fake.stdin[0]).not.toContain("<nyxs_instructions>");
    expect(fake.stdin[0]).not.toContain("<nyxs_browser>");
    emit({ event: "result", result: { conversation_id: "c9", status: "SUCCESS", response: "ok" } });
    exit(0);
    await expect(run).resolves.toContain("ok");
  });

  it("sends a long message whole, without the command line's old 24k cut", async () => {
    const long = `${"x".repeat(30_000)} END`;
    const run = streamAntigravityCli({ model: agyModel, history: [userTurn(long)], planMode: false, effort: "medium", onChunk: () => {} });
    await started();
    await vi.waitFor(() => expect(fake.stdin).toHaveLength(1));
    expect(fake.stdin[0]).toContain(long);
    expect(fake.stdin[0]).not.toContain("recortado");
    emit({ event: "result", result: { conversation_id: "c2", status: "SUCCESS", response: "ok" } });
    exit(0);
    await run;
  });

  it("asks Nyxs' questions and shows the plan from its MCP calls, by the conversation they name", async () => {
    const { handleChatMcp } = await import("@/lib/chatMcp");
    const askUser = vi.fn(async () => [{ question: "Which DB?", answer: "SQLite" }]);
    const plans: string[] = [];
    const earlier: ChatTurn = {
      role: "assistant",
      content: "x",
      messages: [{ role: "assistant", content: [{ type: "text", text: "x" }], providerOptions: { antigravityCli: { sessionId: "c7" } } }],
    };
    const run = streamAntigravityCli({
      model: agyModel,
      history: [userTurn("a"), earlier, userTurn("plan it")],
      planMode: true,
      effort: "medium",
      askUser,
      onPlan: (p) => plans.push(p),
      onChunk: () => {},
    });
    await started();
    // Without the chat in its address (an `agy` started outside Nyxs), the conversation a call names tells the turn.
    const meta = { "antigravity.google/conversation_id": "c7" };
    const listed = (await handleChatMcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } })).result as Json;
    expect((listed.tools as Json[]).map((t) => t.name)).toEqual(["ask_user_question", "exit_plan_mode"]);
    const asked = await handleChatMcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { _meta: meta, name: "ask_user_question", arguments: { questions: [{ question: "Which DB?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }] }] } },
    });
    expect(askUser).toHaveBeenCalledWith([{ question: "Which DB?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }], multiSelect: false }]);
    expect(JSON.stringify(asked)).toContain("A: SQLite");
    await handleChatMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: meta, name: "exit_plan_mode", arguments: { plan: "1. Do X" } } });
    emit({ event: "result", result: { conversation_id: "c7", status: "SUCCESS", response: "Plan ready." } });
    exit(0);
    const full = await run;
    expect(plans).toEqual(["1. Do X"]);
    expect(full).toContain("⟦PLAN⟧");
    // Once the turn is over its tools are gone.
    const after = (await handleChatMcp({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: meta } })).result as Json;
    expect(after.tools).toEqual([]);
  });

  it("says when the CLI isn't signed in", async () => {
    const run = streamAntigravityCli({ model: agyModel, history: [userTurn("hi")], planMode: false, effort: "medium", onChunk: () => {} });
    await started();
    stderr("Error: authentication required. Run agy to sign in.");
    exit(1);
    await expect(run).rejects.toBeInstanceOf(AgentCliAuthError);
  });
});

describe("a chat that no longer ends where its CLI session does", () => {
  const reply = (messages: ModelMessage[]): ChatTurn => ({ role: "assistant", content: "ok", messages });
  const sentSince = (from: number) => fake.sent.slice(from);
  const promptOf = (msgs: Json[], method: string) => JSON.stringify(msgs.find((m) => m.method === method)?.params ?? {});

  describe("Codex", () => {
    const codexModel: ModelInfo = { id: "codex-cli:gpt-6.1-sol", apiModel: "gpt-6.1-sol", name: "GPT-6.1-Sol", description: "", provider: "codex-cli" };
    let threads = 0;
    const answer = (id: unknown, result: Json) => emit({ id, result });
    const appServer = (onTurn: (threadId: string) => void = () => undefined) => {
      fake.onRpc = (msg) => {
        const params = (msg.params ?? {}) as Json;
        if (msg.method === "initialize") answer(msg.id, { userAgent: "codex" });
        else if (msg.method === "account/read") answer(msg.id, { account: { type: "chatgpt" }, requiresOpenaiAuth: true });
        else if (msg.method === "thread/start") answer(msg.id, { thread: { id: `th-${++threads}` } });
        else if (msg.method === "thread/resume") answer(msg.id, { thread: { id: String(params.threadId) } });
        else if (msg.method === "turn/start") {
          answer(msg.id, { turn: { id: "tu", status: "inProgress", items: [] } });
          onTurn(String(params.threadId));
          emit({ method: "item/agentMessage/delta", params: { threadId: params.threadId, turnId: "tu", itemId: "m", delta: "ok" } });
          emit({ method: "turn/completed", params: { threadId: params.threadId, turnId: "tu", turn: { id: "tu", status: "completed", items: [] } } });
        }
      };
    };
    const turn = async (history: ChatTurn[], chatKey: string, signal?: AbortSignal) => {
      let saved: ModelMessage[] = [];
      await streamCodexCli({ model: codexModel, history, planMode: false, effort: "medium", chatKey, signal, onChunk: () => {}, onMessages: (m) => (saved = m) });
      return reply(saved);
    };

    it("goes on in the thread for a normal follow-up", async () => {
      appServer();
      const r1 = await turn([userTurn("uno")], "cx-follow");
      const from = fake.sent.length;
      await turn([userTurn("uno"), r1, userTurn("dos")], "cx-follow");
      expect(sentSince(from).some((m) => m.method === "thread/resume")).toBe(true);
      expect(sentSince(from).some((m) => m.method === "thread/start")).toBe(false);
    });

    it("starts a new thread with the chat so far after an edit, and for a forked chat", async () => {
      appServer();
      const r1 = await turn([userTurn("uno")], "cx-edit");
      await turn([userTurn("uno"), r1, userTurn("dos")], "cx-edit");

      let from = fake.sent.length;
      await turn([userTurn("uno"), r1, userTurn("dos, editado")], "cx-edit");
      expect(sentSince(from).some((m) => m.method === "thread/resume")).toBe(false);
      expect(promptOf(sentSince(from), "turn/start")).toContain("uno");

      from = fake.sent.length;
      await turn([userTurn("uno"), r1, userTurn("en la copia")], "cx-copy");
      expect(sentSince(from).some((m) => m.method === "thread/resume")).toBe(false);
    });

    it("doesn't carry a stopped message on in the thread", async () => {
      appServer();
      const r1 = await turn([userTurn("uno")], "cx-stop");
      const stop = new AbortController();
      appServer(() => stop.abort());
      await expect(turn([userTurn("uno"), r1, userTurn("dos")], "cx-stop", stop.signal)).rejects.toThrow(/abort/i);

      appServer();
      const from = fake.sent.length;
      await turn([userTurn("uno"), r1, userTurn("dos"), { role: "assistant", content: "a medias" }, userTurn("tres")], "cx-stop");
      expect(sentSince(from).some((m) => m.method === "thread/resume")).toBe(false);
      expect(promptOf(sentSince(from), "turn/start").match(/dos/g)).toHaveLength(1);
    });
  });

  it("starts a new ACP session with the chat so far after an edit (Grok)", async () => {
    let sessions = 0;
    fake.onRpc = (msg) => {
      if (msg.method === "initialize") reply1(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "cached_token" }] });
      else if (msg.method === "authenticate") reply1(msg.id, {});
      else if (msg.method === "session/new") reply1(msg.id, { sessionId: `g-${++sessions}` });
      else if (msg.method === "session/load") reply1(msg.id, {});
      else if (msg.method === "session/prompt") reply1(msg.id, { stopReason: "end_turn" });
    };
    const turn = async (history: ChatTurn[]) => {
      let saved: ModelMessage[] = [];
      await streamGrokCli({ model: grokModel, history, planMode: false, effort: "medium", onChunk: () => {}, onMessages: (m) => (saved = m) });
      return reply(saved);
    };
    const r1 = await turn([userTurn("uno")]);
    await turn([userTurn("uno"), r1, userTurn("dos")]);
    const from = fake.sent.length;
    await turn([userTurn("uno"), r1, userTurn("dos, editado")]);
    expect(sentSince(from).some((m) => m.method === "session/load")).toBe(false);
    expect(sentSince(from).some((m) => m.method === "session/new")).toBe(true);
    expect(promptOf(sentSince(from), "session/prompt")).toContain("uno");
  });

  it("leaves the Antigravity conversation after an edit", async () => {
    const run = async (history: ChatTurn[], conversation: string) => {
      let saved: ModelMessage[] = [];
      const before = fake.starts.length;
      const p = streamAntigravityCli({ model: agyModel, history, planMode: false, effort: "low", chatKey: "agy-edit", onChunk: () => {}, onMessages: (m) => (saved = m) });
      await vi.waitFor(() => expect(fake.starts.length).toBe(before + 1));
      const start = fake.starts[fake.starts.length - 1];
      await vi.waitFor(() => expect(fake.stdin.length).toBeGreaterThan(before));
      emit({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response: "ok" } });
      exit(0);
      await p;
      return { reply: reply(saved), args: start.args as string[] };
    };
    const first = await run([userTurn("uno")], "cv1");
    const second = await run([userTurn("uno"), first.reply, userTurn("dos")], "cv1");
    expect(second.args).toEqual(expect.arrayContaining(["--conversation", "cv1"]));
    const edited = await run([userTurn("uno"), first.reply, userTurn("dos, editado")], "cv2");
    expect(edited.args).not.toContain("--conversation");
  });
});

describe("a failure that only looks like a sign-in problem", () => {
  it("isn't read into the model's own words (Antigravity)", async () => {
    const run = streamAntigravityCli({ model: agyModel, history: [userTurn("despliega")], planMode: false, effort: "low", onChunk: () => {} });
    await vi.waitFor(() => expect(fake.stdin).toHaveLength(1));
    emit({ event: "result", result: { status: "ERROR", error: { message: "quota exceeded" }, response: "First, please log in to the Google Cloud console." } });
    exit(1);
    const err = await run.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(AgentCliAuthError);
    expect(String(err)).toMatch(/quota/);
  });

  it("isn't read into the CLI's logs while it still runs (ACP)", async () => {
    fake.onRpc = (msg) => {
      if (msg.method === "initialize") reply1(msg.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "cached_token" }] });
      else if (msg.method === "authenticate") reply1(msg.id, {});
      else if (msg.method === "session/new") reply1(msg.id, { sessionId: "s-log" });
      else if (msg.method === "session/prompt") {
        stderr("tool fetch: GET https://api.example.com/v1/items -> 401 Unauthorized");
        emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } });
      }
    };
    const err = await streamGrokCli({ model: grokModel, history: [userTurn("busca")], planMode: false, effort: "medium", onChunk: () => {} }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(AgentCliAuthError);
    expect(String(err)).toMatch(/Internal error/);
  });

  it("isn't read into the CLI's logs while it still runs (Codex)", async () => {
    const codexModel: ModelInfo = { id: "codex-cli:gpt-6.1-sol", apiModel: "gpt-6.1-sol", name: "GPT-6.1-Sol", description: "", provider: "codex-cli" };
    fake.onRpc = (msg) => {
      if (msg.method === "initialize") emit({ id: msg.id, result: { userAgent: "codex" } });
      else if (msg.method === "account/read") emit({ id: msg.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
      else if (msg.method === "thread/start") emit({ id: msg.id, result: { thread: { id: "th-log" } } });
      else if (msg.method === "turn/start") {
        stderr("npm ERR! code E401 Unauthorized - GET https://registry.npmjs.org/private-pkg");
        emit({ id: msg.id, error: { code: -32603, message: "Internal error" } });
      }
    };
    const err = await streamCodexCli({ model: codexModel, history: [userTurn("instala")], planMode: false, effort: "medium", onChunk: () => {} }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(AgentCliAuthError);
    expect(String(err)).toMatch(/Internal error/);
  });
});

/** A JSON-RPC answer with its "jsonrpc" field (ACP). */
function reply1(id: unknown, result: Json) {
  emit({ jsonrpc: "2.0", id, result });
}
