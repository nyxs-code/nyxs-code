import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { summarizeTasks } from "@/lib/taskRegistry";
import { getTaskRegistry } from "@/lib/taskRegistrySingleton";
import { resolveSubagentType, buildAgentToolDescription } from "@/tools/Agent/types";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";

export function addAgentTools(tools: ToolSet, ctx: ToolContext): void {
  const { gate, runSubagent, subagentModels, extraAgents } = ctx;
  if (!runSubagent) return;
  tools.Agent = tool({
    description: buildAgentToolDescription(subagentModels, extraAgents),
    inputSchema: z.object({
      description: z.string().describe("A short (3-5 word) description of the task."),
      prompt: z.string().describe("The task for the agent to perform."),
      subagent_type: z
        .string()
        .optional()
        .describe("The type of specialized agent to use for this task (defaults to general-purpose). Ignored when fork is true."),
      model: z
        .string()
        .optional()
        .describe("Optional model id to run this agent with. Omit to inherit the current model."),
      fork: z
        .boolean()
        .optional()
        .describe("Fork yourself: the agent inherits this conversation's full context and gets the complete toolset."),
    }),
    execute: async ({ description, prompt, subagent_type, model, fork }) => {
      try {
        return await runSubagent({
          description,
          prompt,
          subagentType: resolveSubagentType(subagent_type, extraAgents).type,
          model,
          fork,
        });
      } catch (e) {
        return `Sub-agent failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const registry = getTaskRegistry();
  tools.TaskCreate = tool({
    description: `Launch a sub-agent that runs IN THE BACKGROUND and return its task id immediately (don't wait for it).

When to use:
- For independent, longer-running work you want to run while you continue (e.g. "investigate X" in parallel with your main task).
- Returns a task id. Use TaskList to see all tasks, TaskOutput <id> to read a task's result/status, and TaskStop <id> to cancel one.
- Prefer the regular Agent tool when you need the result right now (it waits and returns the report).`,
    inputSchema: z.object({
      description: z.string().describe("A short (3-5 word) label for the task."),
      prompt: z.string().describe("The task for the background sub-agent to perform."),
      subagent_type: z.string().optional().describe("The specialized agent type (defaults to general-purpose)."),
    }),
    execute: async ({ description, prompt, subagent_type }) => {
      const id = `task_${crypto.randomUUID().slice(0, 8)}`;
      const controller = new AbortController();
      registry.create(id, description, controller);
      registry.start(id);
      void runSubagent({
        description,
        prompt,
        subagentType: resolveSubagentType(subagent_type, extraAgents).type,
        signal: controller.signal,
      })
        .then((report) => {
          registry.appendOutput(id, report);
          registry.finish(id, "done");
        })
        .catch((e) => {
          registry.finish(id, "failed", e instanceof Error ? e.message : String(e));
        });
      return `Started background task ${id} ("${description}"). Use TaskOutput with this id to read its result, TaskList to see all tasks, or TaskStop to cancel it.`;
    },
  });

  tools.TaskList = tool({
    description: "Lists all background tasks (from TaskCreate) with their status, id and label.",
    inputSchema: z.object({}),
    execute: async () => summarizeTasks(registry.getSnapshot()),
  });

  tools.TaskOutput = tool({
    description: "Returns a background task's current status and captured output (its final report once done).",
    inputSchema: z.object({
      task_id: z.string().describe("The task id returned by TaskCreate."),
    }),
    execute: async ({ task_id }) => {
      const t = registry.get(task_id);
      if (!t) return `Unknown task "${task_id}". Use TaskList to see the current tasks.`;
      const body = t.output.trim() || "(no output yet)";
      const err = t.error ? `\n[error] ${t.error}` : "";
      return `[${t.status}] ${t.label}\n\n${body}${err}`;
    },
  });

  tools.TaskStop = tool({
    description: "Cancels a running background task by id (aborts its sub-agent). No-op if it already finished.",
    inputSchema: z.object({
      task_id: z.string().describe("The task id to stop."),
    }),
    execute: async ({ task_id }) => {
      const denied = await checkGate(gate, "TaskStop", { task_id });
      if (denied) return denied;
      return registry.stop(task_id)
        ? `Stopped task ${task_id}.`
        : `Task "${task_id}" not found or already finished.`;
    },
  });
}
