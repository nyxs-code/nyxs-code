import { appendActivity, settleActivity, type ActivityEntry, type ActivityEvent } from "./agentActivity";
import { describeToolCall } from "./toolDetail";

type Json = Record<string, unknown>;

export type ClaudeCodeTaskStatus = "running" | "completed" | "failed" | "killed" | "stopped";

export interface ClaudeCodeTask {
  id: string;
  runId: string;
  sessionId?: string;
  tool: string;
  title: string;
  command: string;
  outputFile?: string;
  status: ClaudeCodeTaskStatus;
  startedAt: number;
  endedAt?: number;
  /** The tool call that started it; a sub-agent's own messages carry it as `parent_tool_use_id`. */
  toolUseId?: string;
  /** A sub-agent's text and tool calls so far. */
  activity?: ActivityEntry[];
  /** How another CLI's sub-agent is stopped (Claude Code's go through its control request).
   *  Resolves whether it stopped. */
  stop?: () => Promise<boolean>;
  /** Stopping it stops the whole reply: the CLI can't stop one sub-agent alone. */
  stopsTurn?: boolean;
  /** The folder its CLI run works in, so the panel shows each project's tasks apart. */
  cwd?: string;
}

const tasks = new Map<string, ClaudeCodeTask>();
const runCwds = new Map<string, string>();
const pendingUses = new Map<string, { runId: string; tool: string; title: string; command: string }>();
const listeners = new Set<() => void>();
let snapshot: ClaudeCodeTask[] = [];

const BACKGROUND_ID_RE = /background with ID:\s*([A-Za-z0-9_-]+)/;
const OUTPUT_FILE_RE = /Output is being written to:\s*(\S+?)(?:\.\s|\s|$)/;
const NOTIFICATION_ID_RE = /<task-id>([^<]+)<\/task-id>/g;
const NOTIFICATION_STATUS_RE = /<status>([^<]+)<\/status>/;
const STOP_TOOLS = new Set(["KillShell", "KillBash", "TaskStop"]);

function emit(): void {
  snapshot = [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  for (const fn of listeners) fn();
}

export function subscribeClaudeCodeTasks(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getClaudeCodeTasks(): ClaudeCodeTask[] {
  return snapshot;
}

/** Drops finished tasks; with `ids`, only those. */
export function clearFinishedClaudeCodeTasks(ids?: string[]): void {
  for (const [id, t] of tasks) if (t.status !== "running" && (!ids || ids.includes(id))) tasks.delete(id);
  emit();
}

/** The folder a CLI run works in. Its tasks started before this learn it too. */
export function setRunCwd(runId: string, cwd: string | null | undefined): void {
  if (!cwd || runCwds.get(runId) === cwd) return;
  runCwds.set(runId, cwd);
  let changed = false;
  for (const t of tasks.values()) {
    if (t.runId === runId && !t.cwd) {
      t.cwd = cwd;
      changed = true;
    }
  }
  if (changed) emit();
}

export function runningClaudeCodeTasks(runId: string): number {
  let n = 0;
  for (const t of tasks.values()) if (t.runId === runId && t.status === "running") n++;
  return n;
}

export function stopClaudeCodeTasksOfRun(runId: string): void {
  let changed = false;
  for (const t of tasks.values()) {
    if (t.runId === runId && t.status === "running") {
      t.status = "stopped";
      t.endedAt = Date.now();
      if (t.activity) t.activity = settleActivity(t.activity);
      changed = true;
    }
  }
  if (changed) emit();
}

/** The CLI confirmed a stop the user asked for; its own notice may come later or not at all. */
export function markClaudeCodeTaskStopped(id: string): void {
  if (finishTask(id, "killed")) emit();
}

const TERMINAL = /complet|fail|error|kill|stop|cancel/i;

function startTask(id: string, fields: Omit<ClaudeCodeTask, "id" | "status" | "startedAt">): void {
  const prev = tasks.get(id);
  tasks.set(id, {
    ...fields,
    ...(prev ?? {}),
    id,
    title: prev?.title || fields.title,
    command: prev?.command || fields.command,
    outputFile: prev?.outputFile ?? fields.outputFile,
    cwd: prev?.cwd ?? fields.cwd ?? runCwds.get(fields.runId),
    status: prev?.status ?? "running",
    startedAt: prev?.startedAt ?? Date.now(),
  });
}

function finishTask(id: string, status: ClaudeCodeTaskStatus): boolean {
  const t = tasks.get(id);
  if (!t || t.status !== "running") return false;
  t.status = status;
  t.endedAt = Date.now();
  if (t.activity) t.activity = settleActivity(t.activity);
  return true;
}

/** A sub-agent another CLI announced (Codex's spawned threads, Antigravity's `invoke_subagent`),
 *  listed with Claude Code's. `runId` ties it to the CLI run, which ends it with the run. */
export function startCliSubagent(
  id: string,
  fields: { runId: string; title: string; command: string; stop?: () => Promise<boolean>; stopsTurn?: boolean },
): void {
  startTask(id, { tool: "Agent", activity: [], ...fields });
  emit();
}

/** What a CLI's sub-agent did, added to its activity. */
export function cliSubagentActivity(id: string, e: ActivityEvent): void {
  const t = tasks.get(id);
  if (!t || t.status !== "running") return;
  const next = appendActivity(t.activity ?? [], e);
  if (next === t.activity) return;
  t.activity = next;
  emit();
}

/** A CLI's sub-agent's activity as a whole, for CLIs that report it as a log read again. */
export function setCliSubagentActivity(id: string, activity: ActivityEntry[]): void {
  const t = tasks.get(id);
  if (!t || t.status !== "running" || JSON.stringify(t.activity) === JSON.stringify(activity)) return;
  t.activity = activity;
  emit();
}

export function finishCliSubagent(id: string, status: ClaudeCodeTaskStatus): void {
  if (finishTask(id, status)) emit();
}

/** A sub-agent's message (it names the tool call that started it) added to that task's activity. */
function recordSubagentMessage(runId: string, msg: Json): boolean {
  const parent = msg.parent_tool_use_id;
  if (typeof parent !== "string" || !parent) return false;
  let task: ClaudeCodeTask | undefined;
  for (const t of tasks.values()) if (t.runId === runId && t.toolUseId === parent) task = t;
  if (!task || task.status !== "running") return false;
  const content = ((msg.message ?? {}) as Json).content;
  if (!Array.isArray(content)) return false;
  let activity = task.activity ?? [];
  for (const part of content as Json[]) {
    if (msg.type === "assistant" && part.type === "text" && typeof part.text === "string") {
      activity = appendActivity(activity, { kind: "text", delta: `${part.text}\n\n` });
    } else if (msg.type === "assistant" && part.type === "tool_use") {
      const label = describeToolCall(String(part.name ?? ""), part.input);
      activity = appendActivity(activity, { kind: "tool-call", callId: String(part.id), name: label.name, detail: label.detail });
    } else if (msg.type === "user" && part.type === "tool_result") {
      activity = appendActivity(activity, { kind: "tool-result", callId: String(part.tool_use_id), ok: part.is_error !== true });
    }
  }
  if (activity === task.activity) return false;
  task.activity = activity;
  return true;
}

function statusFrom(raw: string | undefined): ClaudeCodeTaskStatus {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("kill") || s.includes("stop") || s.includes("cancel")) return "killed";
  if (s.includes("fail") || s.includes("error")) return "failed";
  return "completed";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      const part = c as Json;
      if (typeof part.text === "string") return part.text;
      if (part.type === "tool_result") return textOf(part.content);
      return "";
    })
    .join("\n");
}

export function observeClaudeCodeMessage(runId: string, sessionId: string | undefined, msg: Json): void {
  let changed = recordSubagentMessage(runId, msg);
  const message = (msg.message ?? {}) as Json;
  const content = message.content;

  if (msg.type === "assistant" && Array.isArray(content)) {
    for (const part of content as Json[]) {
      if (part.type !== "tool_use") continue;
      const input = (part.input ?? {}) as Json;
      const name = String(part.name ?? "");
      if (input.run_in_background === true || name === "Monitor") {
        const command = String(input.command ?? input.description ?? name);
        const title = String(input.description ?? "").trim() || command.split(/\r?\n/)[0].slice(0, 120);
        pendingUses.set(String(part.id), { runId, tool: name, title, command });
      }
      if (STOP_TOOLS.has(name)) {
        const id = String(input.shell_id ?? input.task_id ?? input.bash_id ?? "");
        if (id && finishTask(id, "killed")) changed = true;
      }
    }
  }

  if (msg.type === "user" && Array.isArray(content)) {
    for (const part of content as Json[]) {
      if (part.type !== "tool_result") continue;
      const use = pendingUses.get(String(part.tool_use_id));
      if (!use) continue;
      pendingUses.delete(String(part.tool_use_id));
      const text = textOf(part.content);
      const id = BACKGROUND_ID_RE.exec(text)?.[1];
      if (!id || part.is_error === true) continue;
      const existing = tasks.get(id);
      if (existing) {
        existing.tool = use.tool;
        existing.title = use.title;
        existing.command = use.command;
        existing.outputFile = existing.outputFile ?? OUTPUT_FILE_RE.exec(text)?.[1];
      } else {
        startTask(id, { runId: use.runId, sessionId, tool: use.tool, title: use.title, command: use.command, outputFile: OUTPUT_FILE_RE.exec(text)?.[1] });
      }
      changed = true;
    }
  }

  if (msg.type === "system" && typeof msg.task_id === "string") {
    const id = msg.task_id;
    if (msg.subtype === "task_started") {
      const use = typeof msg.tool_use_id === "string" ? pendingUses.get(msg.tool_use_id) : undefined;
      const description = String(msg.description ?? "").trim();
      startTask(id, {
        runId,
        sessionId,
        tool: use?.tool ?? String(msg.task_type ?? "task"),
        title: description || use?.title || id,
        command: use?.command ?? description,
      });
      if (typeof msg.tool_use_id === "string" && msg.tool_use_id) tasks.get(id)!.toolUseId = msg.tool_use_id;
      changed = true;
    } else if (msg.subtype === "task_updated") {
      const status = (msg.patch as Json | undefined)?.status;
      if (typeof status === "string" && TERMINAL.test(status) && finishTask(id, statusFrom(status))) changed = true;
    } else if (msg.subtype === "task_notification") {
      const t = tasks.get(id);
      if (t && typeof msg.output_file === "string" && msg.output_file) t.outputFile = msg.output_file;
      if (finishTask(id, statusFrom(String(msg.status ?? "")))) changed = true;
    }
  } else {
    const text = msg.type === "user" ? textOf(content) : "";
    if (text.includes("<task-notification>")) {
      const status = statusFrom(NOTIFICATION_STATUS_RE.exec(text)?.[1]);
      for (const m of text.matchAll(NOTIFICATION_ID_RE)) if (finishTask(m[1].trim(), status)) changed = true;
    }
  }

  if (changed) emit();
}
