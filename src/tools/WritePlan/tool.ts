import { invoke } from "@/lib/ipc";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/tools/context";

export function createWritePlanTool(ctx: ToolContext) {
  const { workspace, sessionKey } = ctx;
  return tool({
    description: `Record the implementation plan as markdown. In plan mode, use THIS to present your plan instead of writing it in the chat. The plan is shown in the Plan view and kept with the session, never as a file in the project. Send the full plan each time (it replaces the previous one).`,
    inputSchema: z.object({
      plan: z.string().describe("The full plan in markdown."),
    }),
    execute: async ({ plan }) => {
      // The Plan view and "Apply plan" take the plan from this call's input; the copy on disk is
      // the app's state, kept in the project's data folder rather than in the project.
      await invoke<string>("plan_write", { workspace, session: sessionKey ?? "default", content: plan });
      return "Plan saved and shown in the Plan view.";
    },
  });
}
