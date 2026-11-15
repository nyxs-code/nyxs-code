import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// Lines the CLIs really sent (2026-10-31), with paths and accounts taken out:
// Codex 0.164.0, Grok 1.0.70, Antigravity 1.4.12, Claude Code 2.1.316.
type Json = Record<string, unknown>;
const fixture = (name: string): Json[] =>
  readFileSync(new URL(`./fixtures/cli-subagents/${name}`, import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Json);

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null, Channel: class {} }));

const { clearFinishedClaudeCodeTasks, getClaudeCodeTasks, observeClaudeCodeMessage, stopClaudeCodeTasksOfRun } = await import("@/lib/claudeCodeTasks");
const { createCodexSubagents } = await import("@/lib/codexSubagents");
const { createGrokSubagents } = await import("@/lib/grokSubagents");
const { createAntigravitySubagents, transcriptActivity, transcriptPath } = await import("@/lib/antigravitySubagents");

const task = (id: string) => getClaudeCodeTasks().find((t) => t.id === id);

beforeEach(() => {
  for (const runId of ["codex-run", "grok-run", "agy-run", "cc-run"]) stopClaudeCodeTasksOfRun(runId);
  clearFinishedClaudeCodeTasks();
});

describe("Codex sub-agents", () => {
  const toolOf = (item: Json) => (item.type === "commandExecution" ? { name: "Bash", input: { command: String(item.command ?? "") } } : null);
  /** What codexCli.ts does with each notification: another thread's go to the sub-agents. */
  const feed = (subs: ReturnType<typeof createCodexSubagents>, lines: Json[]) => {
    const parent = String(((lines.find((l) => l.method === "item/started")?.params ?? {}) as Json).threadId);
    for (const line of lines) {
      const method = String(line.method);
      const params = (line.params ?? {}) as Json;
      if (method === "item/started" || method === "item/completed") subs.collabItem((params.item ?? {}) as Json, method === "item/completed");
      if (params.threadId !== parent) subs.childNotification(method, params);
    }
  };

  it("follows a spawned agent's thread from its spawnAgent call to its turn's end", () => {
    const subs = createCodexSubagents({ runId: "codex-run", toolOf, interrupt: vi.fn() });
    feed(subs, fixture("codex-spawn.jsonl"));
    const child = getClaudeCodeTasks().find((t) => t.id.startsWith("codex-"))!;
    expect(child).toMatchObject({ runId: "codex-run", tool: "Agent", title: "Reply with the single word OK.", status: "completed" });
    expect(child.activity).toEqual([{ kind: "text", text: "OK\n\n" }]);
  });

  it("stops one agent with turn/interrupt on its own turn", async () => {
    const interrupt = vi.fn(async () => ({}));
    const subs = createCodexSubagents({ runId: "codex-run", toolOf, interrupt });
    const lines = fixture("codex-interrupt.jsonl");
    const end = lines.findIndex((l) => l.method === "turn/completed" && ((l.params as Json).turn as Json).status === "interrupted");
    feed(subs, lines.slice(0, end));
    const child = getClaudeCodeTasks().find((t) => t.id.startsWith("codex-"))!;
    expect(child.status).toBe("running");
    expect(await child.stop!()).toBe(true);
    const childThread = child.id.slice("codex-".length);
    const childTurn = ((lines.find((l) => l.method === "turn/started" && (l.params as Json).threadId === childThread)!.params as Json).turn as Json).id;
    expect(interrupt).toHaveBeenCalledWith(childThread, childTurn);
    feed(subs, lines.slice(end));
    expect(task(child.id)!.status).toBe("killed");
  });

  it("ends with the run whatever still runs", () => {
    const subs = createCodexSubagents({ runId: "codex-run", toolOf, interrupt: vi.fn() });
    const lines = fixture("codex-spawn.jsonl");
    feed(subs, lines.filter((l) => l.method === "item/completed" && ((l.params as Json).item as Json).tool === "spawnAgent"));
    subs.end();
    expect(getClaudeCodeTasks().find((t) => t.id.startsWith("codex-"))!.status).toBe("stopped");
  });
});

describe("Grok sub-agents", () => {
  const toolOf = (call: Json) => ({ name: String(call.title ?? "Tool"), input: (call.rawInput ?? {}) as Json });
  /** What acpAgent.ts does: another session's updates are the sub-agent's. */
  const feed = (subs: ReturnType<typeof createGrokSubagents>, lines: Json[], parent: string) => {
    for (const line of lines) {
      const params = (line.params ?? {}) as Json;
      if (line.method === "session/update" && params.sessionId !== parent) subs.childUpdate(String(params.sessionId), (params.update ?? {}) as Json);
      else if (typeof line.method === "string" && line.method !== "session/update") subs.notification(line.method, params);
    }
  };

  it("follows a sub-agent from subagent_spawned to subagent_finished, with its own text", () => {
    const subs = createGrokSubagents({ runId: "grok-run", toolOf, cancel: vi.fn() });
    const lines = fixture("grok-complete.jsonl");
    feed(subs, lines, String((lines[0].params as Json).sessionId));
    const child = getClaudeCodeTasks().find((t) => t.id.startsWith("grok-"))!;
    expect(child).toMatchObject({ title: "Reply OK only", status: "completed", activity: [{ kind: "text", text: "OK" }] });
  });

  it("stops one sub-agent with _x.ai/subagent/cancel, whose answer comes one level deeper", async () => {
    const lines = fixture("grok-cancel.jsonl");
    const request = lines.find((l) => l.method === "_x.ai/subagent/cancel")!;
    const answer = lines.find((l) => l.id === request.id && "result" in l)!.result as Json;
    const cancel = vi.fn(async () => answer);
    const subs = createGrokSubagents({ runId: "grok-run", toolOf, cancel });
    const parent = String((request.params as Json).sessionId);
    // The capture starts mid-run: the spawn it follows, as Grok announces it.
    const childId = String((request.params as Json).subagentId);
    subs.notification("_x.ai/session_notification", { sessionId: parent, update: { sessionUpdate: "subagent_spawned", subagent_id: childId, child_session_id: childId, description: "Sleep" } });
    feed(subs, lines.slice(0, lines.indexOf(request)), parent);
    const child = task(`grok-${childId}`)!;
    expect(child.activity).toMatchObject([{ kind: "tool", status: "running" }]);
    expect(await child.stop!()).toBe(true);
    expect(cancel).toHaveBeenCalledWith(childId);
    feed(subs, lines.slice(lines.indexOf(request)), parent);
    expect(task(child.id)!.status).toBe("killed");
  });

  it("leaves no sub-agent running once the turn ends", () => {
    const subs = createGrokSubagents({ runId: "grok-run", toolOf, cancel: vi.fn() });
    subs.notification("_x.ai/session_notification", { sessionId: "p", update: { sessionUpdate: "subagent_spawned", subagent_id: "c", child_session_id: "c", description: "x" } });
    subs.end();
    expect(task("grok-c")!.status).toBe("stopped");
  });
});

describe("Antigravity sub-agents", () => {
  const transcript = readFileSync(new URL("./fixtures/cli-subagents/agy-child-transcript.jsonl", import.meta.url), "utf8");

  it("reads what a sub-agent did from its transcript, and that it went idle", () => {
    const { activity, idle } = transcriptActivity(transcript);
    expect(activity).toEqual([
      { kind: "tool", callId: "1-0", name: "send_message", detail: expect.any(String), status: "ok" },
      { kind: "text", text: "OK" },
    ]);
    expect(idle).toBe(true);
    // Still calling a tool: running.
    const first = transcript.split(/\r?\n/).slice(0, 2).join("\n");
    expect(transcriptActivity(first)).toMatchObject({ idle: false, activity: [{ kind: "tool", status: "running" }] });
  });

  it("turns the step's log_uri into a path", () => {
    expect(transcriptPath("file:///C:/Users/USER/.gemini/antigravity-cli/brain/x/.system_generated/logs/transcript.jsonl")).toBe(
      "C:/Users/USER/.gemini/antigravity-cli/brain/x/.system_generated/logs/transcript.jsonl",
    );
    expect(transcriptPath("file:///home/u/.gemini/t.jsonl")).toBe("/home/u/.gemini/t.jsonl");
  });

  it("starts a task on the subagent step, and stopping it stops the whole reply", async () => {
    const stopTurn = vi.fn(() => true);
    const read = vi.fn(async () => transcript);
    const subs = createAntigravitySubagents({ runId: "agy-run", stopTurn, read });
    for (const line of fixture("agy-stream.jsonl")) if (line.event === "step_update") subs.step(line.step_update as Json);
    const child = getClaudeCodeTasks().find((t) => t.id.startsWith("agy-"))!;
    expect(child).toMatchObject({ title: "Responder", command: "Reply with the single word OK.", stopsTurn: true, status: "running" });
    expect(await child.stop!()).toBe(true);
    expect(stopTurn).toHaveBeenCalled();
    await subs.end(true);
    expect(read).toHaveBeenCalledWith(expect.stringMatching(/transcript\.jsonl$/));
    expect(task(child.id)).toMatchObject({ status: "completed", activity: [{ kind: "tool" }, { kind: "text", text: "OK" }] });
  });

  it("marks them stopped when the run was", async () => {
    const subs = createAntigravitySubagents({ runId: "agy-run", stopTurn: () => true, read: async () => null });
    for (const line of fixture("agy-stream.jsonl")) if (line.event === "step_update") subs.step(line.step_update as Json);
    await subs.end(false);
    expect(getClaudeCodeTasks().find((t) => t.id.startsWith("agy-"))!.status).toBe("stopped");
  });
});

describe("Claude Code sub-agents with --forward-subagent-text", () => {
  it("follows the forwarded messages of the task's sub-agent, and its end", () => {
    for (const line of fixture("claude-forwarded.jsonl")) observeClaudeCodeMessage("cc-run", "s", line);
    const child = getClaudeCodeTasks().find((t) => t.runId === "cc-run")!;
    expect(child).toMatchObject({ title: "Glob for txt files", status: "completed" });
    expect(child.activity).toEqual([
      { kind: "tool", callId: expect.any(String), name: expect.any(String), detail: expect.stringContaining("*.txt"), status: "ok" },
      { kind: "text", text: expect.stringContaining("a.txt") },
    ]);
  });
});
