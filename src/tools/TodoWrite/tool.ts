import { tool } from "ai";
import { z } from "zod";

export function createTodoWriteTool() {
  return tool({
    description: `Maintain a structured task list for the current work, so the user can track progress.

When to use:
- Use for multi-step tasks (3+ steps). Write the full list up front, then update statuses as you go.
- Mark exactly one task as "in_progress" while you work on it; mark it "completed" as soon as it's done.
- Re-send the entire list every time you update it (this replaces the previous list).

Each todo has: content (imperative, e.g. "Add pricing section"), status ("pending" | "in_progress" | "completed"), and optionally activeForm (present continuous, e.g. "Adding pricing section").`,
    inputSchema: z.object({
      todos: z
        .array(
          z.object({
            content: z.string().describe("The task description (imperative form)."),
            status: z.enum(["pending", "in_progress", "completed"]),
            activeForm: z.string().optional().describe("Present-continuous label shown while in progress."),
          }),
        )
        .describe("The full, current task list."),
    }),
    execute: async ({ todos }) => `Task list updated (${todos.length} item(s)).`,
  });
}
