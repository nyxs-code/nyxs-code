import { invoke } from "@/lib/ipc";
import type { ActivityEntry } from "./agentActivity";
import { nyxsTool } from "./agentCli";
import { finishCliSubagent, setCliSubagentActivity, startCliSubagent, stopClaudeCodeTasksOfRun } from "./claudeCodeTasks";
import { describeToolCall } from "./toolDetail";

type Json = Record<string, unknown>;

const POLL_MS = 1500;

/** A tool argument as agy writes it in a transcript: JSON-encoded (`"\"OK\""`). */
function argValue(v: unknown): unknown {
  if (typeof v !== "string" || !/^["{[]/.test(v)) return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

/**
 * A sub-agent's activity from its transcript (agy 1.4.12, one step per line): the model's
 * `PLANNER_RESPONSE`s carry its text and the tools it calls. A call counts as done once a later
 * step is written (its result is a step of its own). `idle`: the last step is an answer that
 * calls nothing, which is how a sub-agent ends.
 */
export function transcriptActivity(text: string): { activity: ActivityEntry[]; idle: boolean } {
  const steps: Json[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      steps.push(JSON.parse(line) as Json);
    } catch {
      // The first line of a tail read may be cut.
    }
  }
  const activity: ActivityEntry[] = [];
  steps.forEach((step, i) => {
    if (step.type !== "PLANNER_RESPONSE") return;
    if (typeof step.content === "string" && step.content.trim()) activity.push({ kind: "text", text: step.content.trim() });
    const calls = (Array.isArray(step.tool_calls) ? step.tool_calls : []) as Json[];
    calls.forEach((call, j) => {
      const raw = (call.args && typeof call.args === "object" ? call.args : {}) as Json;
      const args = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, argValue(v)]));
      const tool = nyxsTool("", String(call.name ?? ""), args);
      const label = describeToolCall(tool.name, tool.input);
      activity.push({
        kind: "tool",
        callId: `${String(step.step_index ?? i)}-${j}`,
        name: label.name,
        detail: label.detail,
        status: i < steps.length - 1 ? "ok" : "running",
      });
    });
  });
  const last = steps[steps.length - 1];
  const idle =
    !!last && last.type === "PLANNER_RESPONSE" && last.status === "DONE" && !(Array.isArray(last.tool_calls) && last.tool_calls.length);
  return { activity, idle };
}

/** `file:///C:/Users/…/transcript.jsonl` as a path the app can read. */
export function transcriptPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  const path = decodeURIComponent(uri.slice("file://".length));
  // `/C:/Users/…` on Windows.
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

export interface AntigravitySubagentsOptions {
  runId: string;
  /** agy can't stop one sub-agent: stopping it stops the whole reply. */
  stopTurn: () => boolean;
  /** Reads a transcript's end (the `claude_code_task_output` command); null when it can't. */
  read?: (path: string) => Promise<string | null>;
}

/**
 * Antigravity CLI's sub-agents (`invoke_subagent`), followed in the background-tasks panel. Its
 * stream only says one started (a `subagent` step naming the child's conversation and the
 * transcript it writes); what the child does is read from that transcript while it runs.
 */
export function createAntigravitySubagents(o: AntigravitySubagentsOptions) {
  const read = o.read ?? ((path: string) => invoke<string | null>("claude_code_task_output", { path }).catch(() => null));
  const children = new Map<string, { taskId: string; path: string; running: boolean }>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const poll = async () => {
    await Promise.all(
      [...children.values()]
        .filter((c) => c.running && c.path)
        .map(async (child) => {
          const text = await read(child.path);
          if (text === null || !child.running) return;
          const { activity, idle } = transcriptActivity(text);
          setCliSubagentActivity(child.taskId, activity);
          if (idle) {
            child.running = false;
            finishCliSubagent(child.taskId, "completed");
          }
        }),
    );
    if (![...children.values()].some((c) => c.running) && timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    /** A `step_update` of the run: its `subagent` steps start a task each. */
    step(step: Json) {
      if (step.step_type !== "subagent") return;
      const info = (step.subagent_info ?? {}) as Json;
      for (const sub of (Array.isArray(info.subagents) ? info.subagents : []) as Json[]) {
        const id = String(sub.conversation_id ?? "");
        if (!id || children.has(id)) continue;
        const prompt = String(sub.initial_prompt ?? "").trim();
        const child = { taskId: `agy-${id}`, path: typeof sub.log_uri === "string" ? transcriptPath(sub.log_uri) : "", running: true };
        children.set(id, child);
        startCliSubagent(child.taskId, {
          runId: o.runId,
          title: String(sub.role ?? "").trim() || prompt.split(/\r?\n/)[0].slice(0, 120) || "Antigravity",
          command: prompt,
          stopsTurn: true,
          stop: async () => o.stopTurn(),
        });
      }
      if (!timer && children.size) timer = setInterval(() => void poll(), POLL_MS);
    },

    /** The run ended. agy waits for its sub-agents, so after a run that finished they're done
     *  (once their transcript is read one last time); after one that was stopped, they stopped. */
    async end(finished: boolean) {
      if (timer) clearInterval(timer);
      timer = null;
      if (finished) {
        await poll();
        for (const child of children.values()) {
          if (child.running) finishCliSubagent(child.taskId, "completed");
          child.running = false;
        }
      }
      stopClaudeCodeTasksOfRun(o.runId);
    },
  };
}
