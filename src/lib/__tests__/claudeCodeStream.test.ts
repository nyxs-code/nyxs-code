import { describe, it, expect, vi, beforeEach } from "vitest";

const proc = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[] }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), Channel: class {} }));
vi.mock("@/lib/claudeCodeProcesses", () => ({
  INBOX_SETTLE_MS: 20_000,
  sendTo: async (_p: unknown, msg: Record<string, unknown>) => {
    proc.sent.push(msg);
  },
}));

const stream = await import("@/lib/claudeCodeStream");
const { handleMessage, newTurnState, onControlRequest } = stream;
type StreamTurn = import("@/lib/claudeCodeStream").StreamTurn;
type ClaudeCodeTurn = import("@/lib/claudeCodeStream").ClaudeCodeTurn;

/** A turn wired to plain recorders instead of the chat. */
function turn(extra: Partial<ClaudeCodeTurn> = {}, opts: { promptEchoed?: boolean } = {}) {
  const chunks: string[] = [];
  const tools: { id: string; detail: Record<string, unknown> }[] = [];
  const reasoning: [string, string][] = [];
  const finished = { n: 0 };
  const t = {
    model: { id: "claude-code:opus", apiModel: "opus" },
    history: [],
    planMode: false,
    effort: "medium",
    onChunk: (text: string) => chunks.push(text),
    onTool: (id: string, detail: Record<string, unknown>) => tools.push({ id, detail }),
    onReasoning: (id: string, delta: string) => reasoning.push([id, delta]),
    ...extra,
  } as unknown as ClaudeCodeTurn;
  const c: StreamTurn = {
    t,
    proc: { runId: "run-1", exited: false, expectsWake: false } as StreamTurn["proc"],
    workspace: "C:/p",
    s: newTurnState("sess-1", opts.promptEchoed ?? false),
    finish: () => { finished.n++; },
  };
  return { c, chunks, tools, reasoning, finished };
}

const delta = (d: Record<string, unknown>) => ({ type: "stream_event", event: { type: "content_block_delta", delta: d } });

beforeEach(() => {
  proc.sent = [];
});

describe("stream events", () => {
  it("sends text deltas to the chat and keeps them as the reply", async () => {
    const { c, chunks } = turn();
    await handleMessage(c, delta({ type: "text_delta", text: "Hola" }));
    await handleMessage(c, delta({ type: "text_delta", text: " mundo" }));
    await handleMessage(c, { type: "stream_event", event: { type: "message_stop" } });
    expect(chunks).toEqual(["Hola", " mundo"]);
    expect(c.s.full).toBe("Hola mundo");
    expect(c.s.assistantText).toBe("Hola mundo\n\n");
  });

  it("opens one reasoning block per thinking phase", async () => {
    const { c, chunks, reasoning } = turn();
    await handleMessage(c, delta({ type: "thinking_delta", thinking: "Pienso" }));
    await handleMessage(c, delta({ type: "thinking_delta", thinking: " más" }));
    await handleMessage(c, { type: "stream_event", event: { type: "content_block_stop" } });
    await handleMessage(c, delta({ type: "thinking_delta", thinking: "Otra fase" }));
    expect(chunks).toEqual(["\n\n⟦REASONING⟧r1⟦/REASONING⟧\n\n", "\n\n⟦REASONING⟧r2⟦/REASONING⟧\n\n"]);
    expect(reasoning).toEqual([["r1", "Pienso"], ["r1", " más"], ["r2", "Otra fase"]]);
    // Thinking isn't part of the reply the chat saves.
    expect(c.s.assistantText).toBe("");
  });

  it("reports context and output tokens", async () => {
    const context: number[] = [];
    const usage: number[] = [];
    const { c } = turn({ onContext: (n) => context.push(n), onUsage: (n) => usage.push(n) });
    await handleMessage(c, { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90 } } } });
    await handleMessage(c, { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 7 } } });
    await handleMessage(c, { type: "stream_event", event: { type: "message_stop" } });
    await handleMessage(c, { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 3 } } });
    expect(context).toEqual([100]);
    expect(usage).toEqual([7, 10]);
    expect(c.s.outputTokens).toBe(7);
  });
});

describe("tool use and results", () => {
  it("places a tool call, then closes it with its result", async () => {
    const { c, chunks, tools } = turn();
    await handleMessage(c, {
      type: "assistant",
      uuid: "u-1",
      message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
    });
    expect(chunks[0]).toMatch(/^\n\n⟦TOOL⟧t1⟦SEP⟧/);
    expect(c.s.servedModel).toBe("claude-opus-5-5");
    expect(c.s.lastEntry).toBe("u-1");
    expect(tools[0].id).toBe("t1");

    await handleMessage(c, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt\nb.txt" }] } });
    expect(chunks.at(-1)).toBe("⟦TOOLEND⟧t1⟦SEP⟧ok⟦/TOOLEND⟧");
    expect(tools.at(-1)?.detail.endedAt).toBeTypeOf("number");
  });

  it("marks a failed tool and ignores results of tools it never placed", async () => {
    const { c, chunks } = turn();
    await handleMessage(c, { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "C:/p/x.ts" } }] } });
    await handleMessage(c, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "File does not exist." }] } });
    await handleMessage(c, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "unknown", content: "x" }] } });
    expect(chunks.at(-1)).toMatch(/^⟦TOOLEND⟧t1⟦SEP⟧err⟦SEP⟧File does not exist/);
    expect(chunks.filter((x) => x.includes("unknown"))).toEqual([]);
  });

  it("shows TodoWrite once as a list and flags background work", async () => {
    const todos: unknown[] = [];
    const { c, chunks } = turn({ onTodos: (list) => todos.push(list) });
    const todo = { type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "a", status: "pending" }] } };
    await handleMessage(c, { type: "assistant", message: { content: [{ ...todo, id: "t1" }, { ...todo, id: "t2" }] } });
    await handleMessage(c, { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "npm run dev", run_in_background: true } }] } });
    expect(chunks.filter((x) => x.includes("⟦TODO⟧"))).toHaveLength(1);
    expect(todos).toHaveLength(2);
    expect(c.proc.expectsWake).toBe(true);
  });
});

describe("permission requests", () => {
  const ask = (name: string, input: Record<string, unknown> = {}) => ({
    type: "control_request",
    request_id: "req-1",
    request: { subtype: "can_use_tool", tool_name: name, input, tool_use_id: "tu-1" },
  });

  it("asks the chat's gate and answers with its decision", async () => {
    const gate = vi.fn(async () => false);
    const { c } = turn({ gate });
    await onControlRequest(c, ask("Bash", { command: "rm -rf build" }));
    expect(gate).toHaveBeenCalledWith("Bash", { command: "rm -rf build" });
    expect(proc.sent[0]).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: "req-1", response: { behavior: "deny", message: "The user denied this action.", toolUseID: "tu-1" } },
    });
  });

  it("allows with the input as it came, and reports the file an edit touches", async () => {
    const edited: string[] = [];
    const { c } = turn({ gate: async () => true, onFileEdit: async (p: string) => { edited.push(p); } });
    await onControlRequest(c, ask("Edit", { file_path: "C:/p/a.ts", old_string: "a", new_string: "b" }));
    expect((proc.sent[0].response as Record<string, unknown>).response).toMatchObject({ behavior: "allow", toolUseID: "tu-1" });
    expect(edited).toEqual(["C:/p/a.ts"]);
  });

  it("answers the user's question with their choices, and denies when dismissed", async () => {
    const { c } = turn({ askUser: async () => [{ question: "¿Qué base?", answer: "Postgres" }] });
    await onControlRequest(c, ask("AskUserQuestion", { questions: [{ question: "¿Qué base?" }] }));
    expect((proc.sent[0].response as Record<string, unknown>).response).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "¿Qué base?": "Postgres" } },
    });
    const dismissed = turn({ askUser: async () => null });
    await onControlRequest(dismissed.c, ask("AskUserQuestion", { questions: [] }));
    expect((proc.sent[1].response as Record<string, unknown>).response).toMatchObject({ behavior: "deny" });
  });

  it("shows the plan once and stops Claude Code there", async () => {
    const plans: string[] = [];
    const { c, chunks } = turn({ onPlan: (p) => plans.push(p) });
    await onControlRequest(c, ask("ExitPlanMode", { plan: "1. Hacer X" }));
    await onControlRequest(c, ask("ExitPlanMode", { plan: "1. Hacer X" }));
    expect(plans).toEqual(["1. Hacer X", "1. Hacer X"]);
    expect(chunks.filter((x) => x.includes("⟦PLAN⟧"))).toHaveLength(1);
    expect((proc.sent[0].response as Record<string, unknown>).response).toMatchObject({ behavior: "deny" });
  });

  it("turns down other control requests, and sends nothing once the process is gone", async () => {
    const { c } = turn({ gate: async () => true });
    await onControlRequest(c, { type: "control_request", request_id: "req-2", request: { subtype: "hook_callback" } });
    expect(proc.sent[0]).toEqual({
      type: "control_response",
      response: { subtype: "error", request_id: "req-2", error: "Unsupported request: hook_callback" },
    });
    c.proc.exited = true;
    await onControlRequest(c, ask("Bash"));
    expect(proc.sent).toHaveLength(1);
  });
});

describe("status messages", () => {
  it("follows compaction and retries, reporting only changes", async () => {
    const compacting: boolean[] = [];
    const retrying: unknown[] = [];
    const { c } = turn({ onCompacting: (on) => compacting.push(on), onRetrying: (r) => retrying.push(r) });
    await handleMessage(c, { type: "system", subtype: "status", status: "compacting" });
    await handleMessage(c, { type: "system", subtype: "status", status: "compacting" });
    await handleMessage(c, { type: "system", subtype: "compact_boundary" });
    await handleMessage(c, { type: "system", subtype: "api_retry", error_status: 429 });
    await handleMessage(c, delta({ type: "text_delta", text: "ya" }));
    await handleMessage(c, delta({ type: "text_delta", text: "!" }));
    expect(compacting).toEqual([true, false]);
    expect(retrying).toEqual([{ rateLimited: true }, null]);
  });

  it("reports the end of a compaction with the context before it, when it comes", async () => {
    const boundaries: unknown[] = [];
    const { c } = turn({ onCompactBoundary: (b) => boundaries.push(b) });
    await handleMessage(c, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 167_000 } });
    await handleMessage(c, { type: "system", subtype: "compact_boundary" });
    expect(boundaries).toEqual([{ preTokens: 167_000 }, {}]);
  });

  it("leaves rate_limit_event alone: the process reads it before any turn sees it", async () => {
    const { c, chunks, finished } = turn();
    const before = structuredClone({ ...c.s, placed: [], tracked: [] });
    await handleMessage(c, { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.9 } });
    expect({ ...c.s, placed: [], tracked: [] }).toEqual(before);
    expect(chunks).toEqual([]);
    expect(finished.n).toBe(0);
  });

  it("takes the session id from init", async () => {
    const { c } = turn();
    await handleMessage(c, { type: "system", subtype: "init", session_id: "sess-2" });
    expect(c.s.sessionId).toBe("sess-2");
  });

  it("hands over the code changes Claude Code says the session published", async () => {
    const published: unknown[] = [];
    const { c, chunks } = turn({ onPrPublished: (p) => published.push(p) });
    await handleMessage(c, {
      type: "system",
      subtype: "code_change_published",
      provider: "github",
      url: "https://github.com/acme/app/pull/456",
      repo: "acme/app",
      identifier: "456",
      action: "created",
      branch: "feat/x",
      session_id: "sess-1",
    });
    await handleMessage(c, { type: "system", subtype: "code_change_published", provider: "github" });
    expect(published).toEqual([
      { url: "https://github.com/acme/app/pull/456", repo: "acme/app", identifier: "456", action: "created", branch: "feat/x" },
    ]);
    expect(chunks).toEqual([]);
  });
});

describe("results and errors", () => {
  it("ends the turn with its result", async () => {
    const { c, finished } = turn();
    await handleMessage(c, { type: "result", subtype: "success", result: "Listo", session_id: "sess-3" });
    expect(finished.n).toBe(1);
    expect(c.s.result?.result).toBe("Listo");
    expect(c.s.sessionId).toBe("sess-3");
  });

  it("keeps an API error reported as a synthetic message, without showing it as text", async () => {
    const { c, chunks } = turn();
    await handleMessage(c, {
      type: "assistant",
      error: "authentication_failed",
      message: { model: "<synthetic>", content: [{ type: "text", text: "Invalid API key · Please run /login" }] },
    });
    await handleMessage(c, { type: "result", is_error: true, subtype: "success", result: "Invalid API key" });
    expect(c.s.apiError).toBe("authentication_failed");
    expect(c.s.apiErrorText).toBe("Invalid API key · Please run /login");
    expect(c.s.result?.is_error).toBe(true);
    expect(chunks).toEqual([]);
  });

  it("waits for queued messages before ending, then gives up after a quiet spell", async () => {
    vi.useFakeTimers();
    try {
      const consumed: unknown[] = [];
      const { c, finished } = turn({
        inbox: { take: () => [{ text: "y otra cosa", images: [] }], consumed: (items: unknown[]) => consumed.push(...items) } as unknown as ClaudeCodeTurn["inbox"],
      }, { promptEchoed: true });
      stream.deliverInbox(c);
      expect(c.s.inflight).toHaveLength(1);
      await handleMessage(c, { type: "result", subtype: "success", result: "Hecho" });
      expect(finished.n).toBe(0);
      expect(c.s.awaitingInbox).toBe(true);
      vi.advanceTimersByTime(20_000);
      expect(finished.n).toBe(1);
      expect(consumed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches a replayed queued message by its text", async () => {
    const consumed: unknown[] = [];
    const item = { text: "y otra cosa", images: [] };
    const { c } = turn({
      inbox: { take: () => [item], consumed: (items: unknown[]) => consumed.push(...items) } as unknown as ClaudeCodeTurn["inbox"],
    });
    stream.deliverInbox(c);
    // The turn's own prompt comes back first and doesn't count as the queued one.
    await handleMessage(c, { type: "user", isReplay: true, message: { content: [{ type: "text", text: "el prompt" }] } });
    expect(consumed).toEqual([]);
    await handleMessage(c, { type: "user", isReplay: true, message: { content: [{ type: "text", text: c.s.inflight[0].sent }] } });
    expect(consumed).toEqual([item]);
    expect(c.s.inflight).toEqual([]);
  });
});

describe("sub-agent messages", () => {
  it("stay out of the chat, but report the files they edit", async () => {
    const edits: unknown[] = [];
    const { c, chunks, tools } = turn({ onSubagentEdit: (e) => edits.push(e) });
    await handleMessage(c, {
      type: "assistant",
      parent_tool_use_id: "task-1",
      message: { content: [{ type: "text", text: "Busco…" }, { type: "tool_use", id: "s1", name: "Edit", input: {} }] },
    });
    await handleMessage(c, {
      type: "user",
      parent_tool_use_id: "task-1",
      message: { content: [{ type: "tool_result", tool_use_id: "s1", content: "ok" }] },
      tool_use_result: {
        filePath: "C:/p/a.ts",
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-a", "+b", "+c"] }],
      },
    });
    expect(chunks).toEqual([]);
    expect(tools).toEqual([]);
    expect(edits).toEqual([{ path: "C:/p/a.ts", added: 2, removed: 1 }]);
  });
});
