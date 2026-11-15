import type { AcpSubagents } from "./acpAgent";
import { cliSubagentActivity, finishCliSubagent, startCliSubagent, type ClaudeCodeTaskStatus } from "./claudeCodeTasks";
import { describeToolCall } from "./toolDetail";

type Json = Record<string, unknown>;

export interface GrokSubagentsOptions {
  runId: string;
  /** `_x.ai/subagent/cancel`, which stops one sub-agent and lets the turn go on. */
  cancel: (subagentId: string) => Promise<Json>;
  /** A tool call as the Nyxs tool it amounts to (`toolOf` in acpAgent.ts). */
  toolOf: (call: Json) => { name: string; input: Json };
}

function statusOf(status: unknown): ClaudeCodeTaskStatus {
  const s = String(status ?? "").toLowerCase();
  if (s === "completed") return "completed";
  if (/cancel|kill|stop/.test(s)) return "killed";
  return "failed";
}

/**
 * Grok CLI's sub-agents (`spawn_subagent`, seen in 1.0.70). It announces them on
 * `_x.ai/session_notification`: `subagent_spawned` and `subagent_finished` name the child's
 * session, and the child streams the usual `session/update`s under that `sessionId` on the same
 * connection.
 */
export function createGrokSubagents(o: GrokSubagentsOptions): AcpSubagents {
  /** By the child's session id. */
  const children = new Map<string, { taskId: string; running: boolean }>();
  return {
    notification(method, params) {
      if (method !== "_x.ai/session_notification") return false;
      const u = (params.update ?? {}) as Json;
      const id = String(u.child_session_id ?? u.subagent_id ?? "");
      if (!id) return false;
      if (u.sessionUpdate === "subagent_spawned") {
        if (children.has(id)) return true;
        const subagentId = String(u.subagent_id ?? id);
        const child = { taskId: `grok-${id}`, running: true };
        children.set(id, child);
        const description = String(u.description ?? "").trim();
        startCliSubagent(child.taskId, {
          runId: o.runId,
          title: description || String(u.subagent_type ?? "Grok"),
          command: description,
          stop: async () => {
            // 1.0.70 answers `{ result: { cancelled, outcome } }`, one level deeper than its other methods.
            const answer = await o.cancel(subagentId);
            const res = (answer.result && typeof answer.result === "object" ? answer.result : answer) as Json;
            const outcome = String(((res.outcome ?? {}) as Json).kind ?? "");
            return res.cancelled === true || outcome === "cancelled" || outcome === "already_finished";
          },
        });
        return true;
      }
      if (u.sessionUpdate === "subagent_finished") {
        const child = children.get(id);
        if (child) {
          child.running = false;
          finishCliSubagent(child.taskId, statusOf(u.status));
        }
        return true;
      }
      // `subagent_progress` counts turns and tokens; the activity comes from the child's updates.
      return u.sessionUpdate === "subagent_progress";
    },

    childUpdate(sessionId, update) {
      const child = children.get(sessionId);
      if (!child) return;
      const content = (update.content ?? {}) as Json;
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          if (content.type === "text" && typeof content.text === "string") cliSubagentActivity(child.taskId, { kind: "text", delta: content.text });
          break;
        case "tool_call": {
          const tool = o.toolOf(update);
          const label = describeToolCall(tool.name, tool.input);
          cliSubagentActivity(child.taskId, { kind: "tool-call", callId: String(update.toolCallId ?? ""), name: label.name, detail: label.detail });
          if (update.status === "completed" || update.status === "failed") {
            cliSubagentActivity(child.taskId, { kind: "tool-result", callId: String(update.toolCallId ?? ""), ok: update.status === "completed" });
          }
          break;
        }
        case "tool_call_update":
          if (update.status === "completed" || update.status === "failed") {
            cliSubagentActivity(child.taskId, { kind: "tool-result", callId: String(update.toolCallId ?? ""), ok: update.status === "completed" });
          }
          break;
      }
    },

    end() {
      for (const child of children.values()) {
        if (child.running) finishCliSubagent(child.taskId, "stopped");
        child.running = false;
      }
    },
  };
}
