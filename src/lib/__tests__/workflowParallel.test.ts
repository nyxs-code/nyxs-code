import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const { buildWorkflowTool, MAX_WORKFLOW_ITEMS } = await import("@/lib/workflowTool");
const { createSubagentRunner } = await import("@/lib/turnSubagents");
const { newToolSession } = await import("@/lib/fileStateCache");
const { SUBAGENT_REPORT_PROMPT } = await import("@/lib/turnSupport");

const toolOpts = { toolCallId: "c", messages: [] };
type Exec = (input: unknown, o: typeof toolOpts) => Promise<string>;

function workflow(maxAgents: number) {
  let active = 0;
  let peak = 0;
  const seen: string[] = [];
  const runAgent = async (prompt: string) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    const item = prompt.split("Focus on this item:\n")[1];
    seen.push(item);
    return `report for ${item}`;
  };
  const t = buildWorkflowTool({ modelId: "m", settings: {} as never, workspace: null }, maxAgents, undefined, runAgent);
  return { exec: (input: unknown) => (t.execute as unknown as Exec)(input, toolOpts), seen, peak: () => peak };
}

describe("Workflow parallel", () => {
  it("runs every item, never more than maxAgents at once", async () => {
    const wf = workflow(4);
    const items = ["d1", "d2", "d3", "d4", "d5", "d6", "d7"];
    const out = await wf.exec({ mode: "parallel", task: "score it", items });
    expect(wf.seen.sort()).toEqual(items);
    expect(wf.peak()).toBeLessThanOrEqual(4);
    expect(out).toContain("7/7 agents succeeded");
    expect(out).toContain("report for d7");
    expect(out).not.toContain("NOT run");
  });

  it("says which items it skipped past the per-workflow cap", async () => {
    const wf = workflow(8);
    const items = Array.from({ length: MAX_WORKFLOW_ITEMS + 2 }, (_, i) => `item-${i}`);
    const out = await wf.exec({ mode: "parallel", task: "t", items });
    expect(wf.seen).toHaveLength(MAX_WORKFLOW_ITEMS);
    expect(out).toContain(`${MAX_WORKFLOW_ITEMS}/${MAX_WORKFLOW_ITEMS + 2} agents succeeded`);
    expect(out).toContain(`2 item(s) were NOT run`);
    expect(out).toContain(`item-${MAX_WORKFLOW_ITEMS + 1}`);
  });
});

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };

function toolHappyModel() {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (o: { prompt: unknown }) => {
      const sent = JSON.stringify(o.prompt);
      prompts.push(sent);
      const n = prompts.length;
      const chunks = sent.includes("You've used all your steps")
        ? [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "FINAL REPORT: score 72/100" },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ]
        : [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: `Voy a revisar más ${n}. ` },
            { type: "text-end", id: "t" },
            { type: "tool-call", toolCallId: `c${n}`, toolName: "Glob", input: JSON.stringify({ pattern: "*.ts" }) },
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
          ];
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  });
  return { model, prompts };
}

function runner(model: MockLanguageModelV3, maxSteps: number) {
  return createSubagentRunner({
    isTauri: false,
    workspace: "ws",
    model: { id: "openai:gpt-4.1", provider: "openai", apiModel: "gpt-4.1" } as never,
    languageModel: model,
    settings: {} as never,
    buildModel: () => model,
    mainSystem: "parent",
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
    maxSteps,
    isolateSubagents: false,
  });
}

describe("sub-agent step limit", () => {
  it("asks for a final report when every step was spent on tools", async () => {
    const { model, prompts } = toolHappyModel();
    const report = await runner(model, 3)({ description: "review", prompt: "score the harness", subagentType: "Explore", reflect: false });
    expect(report).toBe("FINAL REPORT: score 72/100");
    expect(prompts).toHaveLength(4);
    expect(prompts[3]).toContain(SUBAGENT_REPORT_PROMPT.slice(0, 40));
    expect(prompts[3]).toContain("score the harness");
  });

  it("returns the last step's answer, not the narration before tool calls", async () => {
    let n = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        n++;
        const chunks =
          n === 1
            ? [
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "Let me look around." },
                { type: "text-end", id: "t" },
                { type: "tool-call", toolCallId: "c1", toolName: "Glob", input: JSON.stringify({ pattern: "*" }) },
                { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
              ]
            : [
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "Here is the report." },
                { type: "text-end", id: "t" },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
              ];
        return { stream: simulateReadableStream({ chunks: chunks as never }) };
      },
    });
    const report = await runner(model, 10)({ description: "review", prompt: "p", subagentType: "Explore", reflect: false });
    expect(report).toBe("Here is the report.");
    expect(n).toBe(2);
  });
});

describe("sub-agent edits", () => {
  it("tells the sub-agent how many steps it has and to write before it runs out", async () => {
    const { buildSubagentSystemPrompt } = await import("@/lib/subagentPrompts");
    const s = buildSubagentSystemPrompt("C:\\ws", false, 200);
    expect(s).toContain("at most 200 steps");
    expect(s).toContain("Batch independent tool calls");
    expect(s).toContain("make the edits as soon as you have enough context");
  });

  it("keeps the read-only prompt free of write instructions", async () => {
    const { buildSubagentSystemPrompt } = await import("@/lib/subagentPrompts");
    const s = buildSubagentSystemPrompt("C:\\ws", true, 50);
    expect(s).toContain("at most 50 steps");
    expect(s).not.toContain("make the edits as soon as you have enough context");
  });

  it("reports the line counts of a file the sub-agent wrote", async () => {
    let n = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        n++;
        const chunks =
          n === 1
            ? [
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "Escribo el archivo." },
                { type: "text-end", id: "t" },
                { type: "tool-call", toolCallId: "w1", toolName: "Write", input: JSON.stringify({ file_path: "CO.md", content: "uno\ndos\ntres" }) },
                { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
              ]
            : [
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "listo" },
                { type: "text-end", id: "t" },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
              ];
        return { stream: simulateReadableStream({ chunks: chunks as never }) };
      },
    });
    const edits: { path: string; added: number; removed: number }[] = [];
    const run = createSubagentRunner({
      isTauri: false,
      workspace: "C:\\ws",
      model: { id: "openai:gpt-4.1", provider: "openai", apiModel: "gpt-4.1" } as never,
      languageModel: model,
      settings: {} as never,
      buildModel: () => model,
      mainSystem: "parent",
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
      maxSteps: 3,
      isolateSubagents: false,
      onSubagentEdit: (e) => edits.push(e),
    });
    const report = await run({ description: "write", prompt: "escribe CO.md", subagentType: "general-purpose", reflect: false });
    expect(report).toBe("listo");
    expect(edits).toEqual([{ path: "C:\\ws\\CO.md", added: 3, removed: 0 }]);
  });
});

describe("sub-agent activity and stop", () => {
  function lookThenWait() {
    let n = 0;
    return new MockLanguageModelV3({
      doStream: async (o: { abortSignal?: AbortSignal }) => {
        n++;
        if (n > 1) {
          // Waits to be stopped. The stop can come before this call: on Linux the SDK starts the
          // next step with the signal already aborted, and a real fetch fails at once then.
          await new Promise((_, reject) => {
            const stop = () => reject(new DOMException("aborted", "AbortError"));
            if (o.abortSignal?.aborted) stop();
            else o.abortSignal?.addEventListener("abort", stop);
          });
        }
        const chunks = [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Let me look around." },
          { type: "text-end", id: "t" },
          { type: "tool-call", toolCallId: "c1", toolName: "Glob", input: JSON.stringify({ pattern: "*.ts" }) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
        ];
        return { stream: simulateReadableStream({ chunks: chunks as never }) };
      },
    });
  }

  it("reports its text and tool calls, and stops alone with what it had", async () => {
    const { getWorkflowStore } = await import("@/lib/workflowSession");
    const { STOPPED_NOTE } = await import("@/lib/orchestrator");
    const store = getWorkflowStore();
    store.reset();
    const seen: string[] = [];
    const turn = new AbortController();
    const run = runner(lookThenWait(), 5)({
      description: "look",
      prompt: "look around",
      subagentType: "Explore",
      onActivity: (a) => {
        seen.push(a.kind);
        if (a.kind === "tool-result") {
          const agent = store.getSnapshot().agents.find((x) => x.status === "running");
          if (agent) store.stopAgent(agent.id);
        }
      },
      signal: turn.signal,
    });
    const report = await run;
    expect(report).toBe(`Let me look around.\n\n${STOPPED_NOTE}`);
    expect(seen).toEqual(expect.arrayContaining(["text", "tool-call", "tool-result"]));
    const agent = store.getSnapshot().agents.at(-1)!;
    expect(agent.status).toBe("stopped");
    expect(agent.activity[0]).toEqual({ kind: "text", text: "Let me look around." });
    expect(agent.activity[1]).toMatchObject({ kind: "tool", name: "Glob", detail: "*.ts" });
    expect(turn.signal.aborted).toBe(false);
  });
});
