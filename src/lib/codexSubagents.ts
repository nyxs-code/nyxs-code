import { cliSubagentActivity, finishCliSubagent, startCliSubagent, stopClaudeCodeTasksOfRun, type ClaudeCodeTaskStatus } from "./claudeCodeTasks";
import { describeToolCall } from "./toolDetail";

type Json = Record<string, unknown>;

/** Codex's sub-agents (its `multi_agent` feature, on by default in 0.164.0), followed into the
 *  background-tasks panel. A `spawnAgent` call (a `collabAgentToolCall` item) names each new
 *  agent's thread in `receiverThreadIds` once it completes; that thread then sends the usual
 *  `turn/*` and `item/*` notifications under its own `threadId`, and stops alone with
 *  `turn/interrupt` on its own turn. */
export interface CodexSubagentsOptions {
  /** The app-server run: its sub-agents end with it. */
  runId: string;
  /** A Codex item as the tool it amounts to (`toolOfItem` in codexCli.ts). */
  toolOf: (item: Json) => { name: string; input: Json } | null;
  /** `turn/interrupt` on the sub-agent's own turn. */
  interrupt: (threadId: string, turnId: string) => Promise<unknown>;
}

interface Child {
  taskId: string;
  turnId: string;
  streamed: Set<string>;
}

/** How Codex reports an agent in `agentsStates`, as the panel's status. Null while it runs. */
function statusOfAgent(status: unknown): ClaudeCodeTaskStatus | null {
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
    case "notFound":
      return "failed";
    case "interrupted":
    case "shutdown":
      return "killed";
    default:
      return null;
  }
}

export function createCodexSubagents(o: CodexSubagentsOptions) {
  const children = new Map<string, Child>();

  const finish = (threadId: string, status: ClaudeCodeTaskStatus) => {
    const child = children.get(threadId);
    if (child) finishCliSubagent(child.taskId, status);
  };

  return {
    /** A `collabAgentToolCall` item, from the main thread or a sub-agent's (they can spawn too). */
    collabItem(item: Json, completed: boolean) {
      if (item.type !== "collabAgentToolCall") return;
      const states = (item.agentsStates ?? {}) as Record<string, Json>;
      if (completed && item.tool === "spawnAgent" && item.status === "completed") {
        const prompt = String(item.prompt ?? "").trim();
        for (const id of (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) as unknown[]) {
          if (typeof id !== "string" || !id || children.has(id)) continue;
          const child: Child = { taskId: `codex-${id}`, turnId: "", streamed: new Set() };
          children.set(id, child);
          startCliSubagent(child.taskId, {
            runId: o.runId,
            title: prompt.split(/\r?\n/)[0].slice(0, 120) || "Codex",
            command: prompt,
            stop: async () => {
              if (!child.turnId) return false;
              await o.interrupt(id, child.turnId);
              return true;
            },
          });
        }
      }
      for (const [id, state] of Object.entries(states)) {
        const status = statusOfAgent(state?.status);
        if (status) finish(id, status);
      }
    },

    /** A notification of another thread than the turn's own. True when it was a sub-agent's. */
    childNotification(method: string, params: Json): boolean {
      const threadId = typeof params.threadId === "string" ? params.threadId : "";
      const child = children.get(threadId);
      if (!child) return false;
      const item = (params.item ?? {}) as Json;
      switch (method) {
        case "turn/started":
          child.turnId = String(((params.turn ?? {}) as Json).id ?? "");
          break;
        case "item/agentMessage/delta":
          child.streamed.add(String(params.itemId));
          cliSubagentActivity(child.taskId, { kind: "text", delta: String(params.delta ?? "") });
          break;
        case "item/started": {
          const tool = o.toolOf(item);
          if (tool) {
            const label = describeToolCall(tool.name, tool.input);
            cliSubagentActivity(child.taskId, { kind: "tool-call", callId: String(item.id), name: label.name, detail: label.detail });
          }
          break;
        }
        case "item/completed":
          if (item.type === "agentMessage" && typeof item.text === "string") {
            // A message apart from the next one, streamed or not.
            const text = child.streamed.has(String(item.id)) ? "" : item.text;
            cliSubagentActivity(child.taskId, { kind: "text", delta: `${text}\n\n` });
          } else if (o.toolOf(item)) {
            const ok = item.status !== "failed" && item.status !== "declined" && (item.exitCode == null || item.exitCode === 0);
            cliSubagentActivity(child.taskId, { kind: "tool-result", callId: String(item.id), ok });
          }
          break;
        case "turn/completed": {
          const status = String(((params.turn ?? {}) as Json).status ?? "");
          finish(threadId, status === "interrupted" ? "killed" : status === "failed" ? "failed" : "completed");
          break;
        }
      }
      return true;
    },

    /** The run is over: whatever still runs went with the app-server. */
    end() {
      stopClaudeCodeTasksOfRun(o.runId);
    },
  };
}
