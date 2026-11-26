import { describe, it, expect, vi, beforeEach } from "vitest";

type Json = Record<string, unknown>;
type ProcessEvent = { kind: "stdout"; line: string } | { kind: "stderr"; line: string } | { kind: "exit"; code: number | null };

const fake = vi.hoisted(() => ({
  sent: [] as Json[],
  closed: [] as string[],
  channels: new Map<string, { onmessage: (e: ProcessEvent) => void }>(),
  current: "",
  onUser: (_msg: Json) => {},
}));

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return {
    Channel,
    invoke: async (cmd: string, args: Json) => {
      if (cmd === "claude_code_start") {
        const request = args.request as Json;
        fake.channels.set(request.runId as string, args.onEvent as { onmessage: (e: ProcessEvent) => void });
        fake.current = request.runId as string;
        return undefined;
      }
      if (cmd === "claude_code_send") {
        const msg = JSON.parse(args.line as string) as Json;
        fake.sent.push(msg);
        if (msg.type === "user") queueMicrotask(() => fake.onUser(msg));
        return undefined;
      }
      if (cmd === "claude_code_close_input") {
        fake.closed.push(args.runId as string);
        return undefined;
      }
      return undefined;
    },
  };
});

// The built-in browser and prompt suggestions are on by default; the fake CLI never answers
// their initialize request.
vi.mock("@/lib/settingsRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settingsRuntime")>()),
  getMergedSnapshot: () => ({ allowPreview: false, allowMusic: false, allowVideoTools: false, promptSuggestions: false }),
  settingsFor: async () => ({ merged: { allowPreview: false, allowMusic: false, allowVideoTools: false, promptSuggestions: false }, perSource: {}, projectTrusted: true }),
}));

const { streamClaudeCode, onClaudeCodeWake, onClaudeCodeUnattendedPermission, CLAUDE_CODE_MODELS } = await import("@/lib/claudeCode");
const { getClaudeCodeTasks, observeClaudeCodeMessage, clearFinishedClaudeCodeTasks, runningClaudeCodeTasks, setRunCwd, stopClaudeCodeTasksOfRun } = await import(
  "@/lib/claudeCodeTasks"
);
const { procs } = await import("@/lib/claudeCodeProcesses");
const opus = CLAUDE_CODE_MODELS.find((m) => m.apiModel === "opus")!;

const out = (obj: Json) => fake.channels.get(fake.current)!.onmessage({ kind: "stdout", line: JSON.stringify(obj) });
const textDelta = (text: string) =>
  out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const toolUse = (id: string, name: string, input: Json) =>
  out({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", model: "claude-opus", content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id: string, content: string) =>
  out({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] } });
const result = (sessionId: string) =>
  out({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: "done", usage: { input_tokens: 1, output_tokens: 1 } });
const permission = (requestId: string, input: Json) =>
  out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "PowerShell", input, tool_use_id: `use-${requestId}` } });
const settle = () => new Promise((r) => setTimeout(r, 30));
const answerFor = (requestId: string) =>
  JSON.stringify(fake.sent.find((m) => m.type === "control_response" && JSON.stringify(m).includes(`"request_id":"${requestId}"`)));

async function startWatcherTurn(sessionId: string, taskId: string) {
  fake.onUser = () => {
    out({ type: "system", subtype: "init", session_id: sessionId, tools: [] });
    toolUse(`bg-${taskId}`, "PowerShell", { command: "do { Start-Sleep 30 } while ($true)", description: "Watch the release", run_in_background: true });
    out({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: `bg-${taskId}`, description: "Watch the release", task_type: "local_bash" });
    toolResult(`bg-${taskId}`, `Command running in background with ID: ${taskId}. Output is being written to: C:\\Temp\\claude\\${taskId}.output`);
    result(sessionId);
  };
  await streamClaudeCode({ model: opus, history: [{ role: "user", content: "start a watcher" }], workspace: "E:\\ws", planMode: false, effort: "high", onChunk: () => {} });
}

beforeEach(() => {
  fake.sent = [];
  fake.closed = [];
  clearFinishedClaudeCodeTasks();
});

describe("a turn Claude Code starts on its own", () => {
  it("is shown in its chat and its permission requests reach the gate", async () => {
    await startWatcherTurn("s-wake", "w1");
    const gate = vi.fn(async () => true);
    let shown = "";
    const stop = onClaudeCodeWake((sessionId) => {
      void streamClaudeCode({ model: opus, history: [], workspace: "E:\\ws", planMode: false, effort: "high", gate, onChunk: (t) => (shown += t), attachSession: sessionId });
      return true;
    });
    textDelta("Watcher finished. ");
    permission("p1", { command: "next", run_in_background: true });
    await settle();
    stop();
    expect(shown).toContain("Watcher finished.");
    expect(gate).toHaveBeenCalled();
    expect(answerFor("p1")).toContain('"behavior":"allow"');
  });

  it("follows the session's permission mode when the app can't show it", async () => {
    await startWatcherTurn("s-alone", "w2");
    const stopWake = onClaudeCodeWake(() => false);
    const resolver = vi.fn(async (_s: string, _t: string, input: Json) => input.command === "allowed");
    const stopResolver = onClaudeCodeUnattendedPermission(resolver);
    textDelta("On my own. ");
    permission("p2", { command: "allowed" });
    permission("p3", { command: "refused" });
    await settle();
    stopWake();
    stopResolver();
    expect(resolver).toHaveBeenCalledWith("s-alone", "PowerShell", { command: "allowed" });
    expect(answerFor("p2")).toContain('"behavior":"allow"');
    expect(answerFor("p3")).toContain('"behavior":"deny"');
  });
});

describe("a message sent while Claude Code runs a turn of its own", () => {
  it("stops at once when the user stops it, without being sent", async () => {
    const saved: Json[] = [];
    fake.onUser = () => {
      out({ type: "system", subtype: "init", session_id: "s-stop", tools: [] });
      result("s-stop");
    };
    await streamClaudeCode({
      model: opus,
      history: [{ role: "user", content: "hi" }],
      workspace: "E:\\ws",
      planMode: false,
      effort: "high",
      onChunk: () => {},
      onMessages: (m) => saved.push(...(m as unknown as Json[])),
    });
    // Claude Code starts a turn on its own; nobody takes it over.
    const stopWake = onClaudeCodeWake(() => false);
    textDelta("Working on my own. ");
    await settle();

    const stop = new AbortController();
    const sentBefore = fake.sent.length;
    const turn = streamClaudeCode({
      model: opus,
      history: [{ role: "user", content: "hi" }, { role: "assistant", content: "done", messages: saved as never }, { role: "user", content: "and now?" }],
      workspace: "E:\\ws",
      planMode: false,
      effort: "high",
      signal: stop.signal,
      onChunk: () => {},
    });
    await settle();
    stop.abort();
    const outcome = await Promise.race([turn.then(() => "finished", (e: Error) => e.name), new Promise((r) => setTimeout(() => r("still waiting"), 1000))]);
    stopWake();
    expect(outcome).toBe("AbortError");
    expect(fake.sent.slice(sentBefore).some((m) => m.type === "user")).toBe(false);
  });
});

describe("a process kept waiting for Claude Code to speak again", () => {
  const procOf = (sessionId: string) => [...procs.values()].find((p) => p.sessionId === sessionId)!;
  const followUp = async (sessionId: string, saved: Json[], onUser: () => void) => {
    fake.onUser = onUser;
    await streamClaudeCode({
      model: opus,
      history: [{ role: "user", content: "start" }, { role: "assistant", content: "ok", messages: saved as never }, { role: "user", content: "next" }],
      workspace: "E:\\ws",
      planMode: false,
      effort: "high",
      onChunk: () => {},
    });
    return procOf(sessionId);
  };

  it("stops waiting once the background work it left is done", async () => {
    const saved: Json[] = [];
    fake.onUser = () => {
      out({ type: "system", subtype: "init", session_id: "s-bg", tools: [] });
      toolUse("bg-w9", "PowerShell", { command: "npm run build", run_in_background: true });
      out({ type: "system", subtype: "task_started", task_id: "w9", tool_use_id: "bg-w9", description: "Build", task_type: "local_bash" });
      result("s-bg");
    };
    await streamClaudeCode({ model: opus, history: [{ role: "user", content: "start" }], workspace: "E:\\ws", planMode: false, effort: "high", onChunk: () => {}, onMessages: (m) => saved.push(...(m as unknown as Json[])) });
    expect(procOf("s-bg").expectsWake).toBe(true);

    out({ type: "system", subtype: "task_notification", task_id: "w9", status: "completed", output_file: "C:\\Temp\\w9.output" });
    await settle();
    const proc = await followUp("s-bg", saved, () => result("s-bg"));
    expect(proc.expectsWake).toBe(false);
  });

  it("keeps waiting for a wake-up it scheduled, which no task tracks", async () => {
    const saved: Json[] = [];
    fake.onUser = () => {
      out({ type: "system", subtype: "init", session_id: "s-sched", tools: [] });
      toolUse("sw1", "ScheduleWakeup", { delaySeconds: 600 });
      result("s-sched");
    };
    await streamClaudeCode({ model: opus, history: [{ role: "user", content: "start" }], workspace: "E:\\ws", planMode: false, effort: "high", onChunk: () => {}, onMessages: (m) => saved.push(...(m as unknown as Json[])) });
    const proc = await followUp("s-sched", saved, () => result("s-sched"));
    expect(proc.expectsWake).toBe(true);
  });
});

describe("Claude Code background tasks", () => {
  it("are listed while they run and marked done when Claude Code reports it", async () => {
    await startWatcherTurn("s-tasks", "w3");
    const task = getClaudeCodeTasks().find((t) => t.id === "w3")!;
    expect(task).toMatchObject({ status: "running", title: "Watch the release", tool: "PowerShell", sessionId: "s-tasks" });
    expect(task.outputFile).toBe("C:\\Temp\\claude\\w3.output");
    expect(runningClaudeCodeTasks(task.runId)).toBe(1);

    out({ type: "system", subtype: "task_notification", task_id: "w3", status: "completed", output_file: "C:\\Temp\\claude\\w3.output" });
    await settle();
    expect(getClaudeCodeTasks().find((t) => t.id === "w3")?.status).toBe("completed");
    expect(runningClaudeCodeTasks(task.runId)).toBe(0);
  });

  it("are marked stopped when the Claude Code process ends", async () => {
    await startWatcherTurn("s-exit", "w4");
    fake.channels.get(fake.current)!.onmessage({ kind: "exit", code: 0 });
    await settle();
    expect(getClaudeCodeTasks().find((t) => t.id === "w4")?.status).toBe("stopped");
  });

  it("also understand the task notification text and stop tools", () => {
    observeClaudeCodeMessage("run-x", "s-x", { type: "system", subtype: "task_started", task_id: "t1", description: "Build" });
    observeClaudeCodeMessage("run-x", "s-x", { type: "system", subtype: "task_started", task_id: "t2", description: "Tests" });
    observeClaudeCodeMessage("run-x", "s-x", {
      type: "user",
      message: { role: "user", content: "<task-notification>\n<task-id>t1</task-id>\n<status>failed</status>\n</task-notification>" },
    });
    observeClaudeCodeMessage("run-x", "s-x", {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "k", name: "KillShell", input: { shell_id: "t2" } }] },
    });
    const byId = Object.fromEntries(getClaudeCodeTasks().map((t) => [t.id, t.status]));
    expect(byId).toMatchObject({ t1: "failed", t2: "killed" });
  });

  it("carry their run's folder, and clearing one project's leaves the others", () => {
    observeClaudeCodeMessage("run-p1", "s-p1", { type: "system", subtype: "task_started", task_id: "p1", description: "A" });
    setRunCwd("run-p1", "D:\\proj-a");
    setRunCwd("run-p2", "D:\\proj-b");
    observeClaudeCodeMessage("run-p2", "s-p2", { type: "system", subtype: "task_started", task_id: "p2", description: "B" });
    const cwdOf = (id: string) => getClaudeCodeTasks().find((t) => t.id === id)?.cwd;
    expect(cwdOf("p1")).toBe("D:\\proj-a");
    expect(cwdOf("p2")).toBe("D:\\proj-b");
    stopClaudeCodeTasksOfRun("run-p1");
    stopClaudeCodeTasksOfRun("run-p2");
    clearFinishedClaudeCodeTasks(["p1"]);
    expect(cwdOf("p1")).toBeUndefined();
    expect(cwdOf("p2")).toBe("D:\\proj-b");
  });

  it("keep their Claude Code process alive past the idle limit", async () => {
    vi.useFakeTimers();
    try {
      await startWatcherTurn("s-alive", "w5");
      const runId = fake.current;
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
      expect(fake.closed).not.toContain(runId);
      out({ type: "system", subtype: "task_notification", task_id: "w5", status: "completed" });
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
      expect(fake.closed).toContain(runId);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Claude Code sub-agent activity", () => {
  it("follows the messages of the sub-agent a task started", () => {
    clearFinishedClaudeCodeTasks();
    observeClaudeCodeMessage("run-a", "s-a", { type: "system", subtype: "task_started", task_id: "ta", tool_use_id: "tu1", description: "Explore", task_type: "local_agent" });
    observeClaudeCodeMessage("run-a", "s-a", {
      type: "assistant",
      parent_tool_use_id: "tu1",
      message: { content: [{ type: "text", text: "Busco." }, { type: "tool_use", id: "x1", name: "Grep", input: { pattern: "foo" } }] },
    });
    observeClaudeCodeMessage("run-a", "s-a", {
      type: "user",
      parent_tool_use_id: "tu1",
      message: { content: [{ type: "tool_result", tool_use_id: "x1", content: "ok" }] },
    });
    const task = getClaudeCodeTasks().find((t) => t.id === "ta")!;
    expect(task.toolUseId).toBe("tu1");
    expect(task.activity).toEqual([
      { kind: "text", text: "Busco.\n\n" },
      { kind: "tool", callId: "x1", name: "Grep", detail: "foo", status: "ok" },
    ]);
  });
});
